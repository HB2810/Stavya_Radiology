// Scheme-based discounts: resolves a discount (scheme or a one-off custom %) for an order line, and the
// admin approval queue for discounts that need sign-off before they are trusted (mirrors billing.js's refund
// request -> admin-approval -> done pattern).
import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, forbidden, notFound, now, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { notify } from './notifications.js';

// Resolves what body.schemeId / body.noCharge / body.discountPct mean, for both a new order and an invoice-line
// edit (existing is the order row being edited, used to fall back to its current discount when a field is omitted).
// Returns { pct, schemeId, waiver, requiresApproval }. Throws the same errors createOrder/updateInvoice always threw
// (DISCOUNT_INVALID, the reception/admin-only check, the 50%+ reason requirement) plus DISCOUNT_SCHEME_INVALID.
export function resolveDiscount(body, user, existing = null) {
  let schemeId = null; let pct; let schemeRequiresReason = false; let schemeRequiresApproval = false;
  if (body.noCharge) {
    pct = 100;
  } else if (body.schemeId) {
    const scheme = db.prepare('SELECT * FROM discount_schemes WHERE id = ? AND active = 1').get(String(body.schemeId));
    if (!scheme) throw bad('DISCOUNT_SCHEME_INVALID', 'Unknown or inactive discount scheme');
    schemeId = scheme.id; pct = scheme.value; schemeRequiresReason = Boolean(scheme.requires_reason); schemeRequiresApproval = Boolean(scheme.requires_approval);
  } else {
    pct = body.discountPct !== undefined ? Number(body.discountPct) : Number(existing?.discount_pct || 0);
  }
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw bad('DISCOUNT_INVALID', 'Discount must be between 0 and 100');
  let waiver = null;
  if (pct > 0) {
    if (!['reception', 'admin'].includes(user.role)) throw forbidden('Only reception or admin can apply a discount');
    if (pct >= 50 || schemeRequiresReason) waiver = requireText(body.waiverReason ?? existing?.waiver_reason, 'Reason for this discount', 300);
  }
  const requiresApproval = pct > 0 && (schemeRequiresApproval || pct >= 50);
  return { pct, schemeId, waiver, requiresApproval };
}

// Invalidates any PENDING discount_approvals row still open for this order: its discount has since changed again
// (re-edited to a different scheme/%, or the line was cancelled/removed) or a fresh request supersedes it, so the
// old row no longer describes what the order actually charges. Without this, deciding a stale PENDING row in
// decideDiscountApproval's REJECTED branch would force-reset an order that has since moved on (see that function).
// Caller is already inside a tx (order/invoice/transition write); SUPERSEDED rows are kept for the audit trail,
// never deleted, and are excluded from the live queue because listDiscountApprovals/decideDiscountApproval only
// ever act on status = 'PENDING'.
export function supersedePendingApprovals(orderId, user) {
  db.prepare(`UPDATE discount_approvals SET status = 'SUPERSEDED', decided_by = ?, decided_by_name = ?, decided_at = ?,
    note = 'Superseded: the order changed before this request was decided' WHERE order_id = ? AND status = 'PENDING'`)
    .run(user?.id || null, user?.fullName || null, now(), orderId);
}

// Inserts a PENDING discount_approvals row for an order line. Caller is already inside a tx (order/invoice write);
// this only writes the row -- notifying admins is a post-commit, best-effort side effect left to the caller, same
// as billing.js's requestRefund calls notify() after its tx commits. Any earlier PENDING row for the same order is
// superseded first, so at most one live approval request ever exists per order.
export function createPendingApproval({ orderId, registrationId = null, schemeId, pct, waiver }, user) {
  supersedePendingApprovals(orderId, user);
  const id = uid('dapp');
  db.prepare(`INSERT INTO discount_approvals (id, registration_id, order_id, scheme_id, pct, reason, requested_by, requested_by_name, requested_at, status)
    VALUES (?,?,?,?,?,?,?,?,?, 'PENDING')`).run(id, registrationId, orderId, schemeId, pct, waiver || null, user.id, user.fullName, now());
  return id;
}

/* ---- Admin approval queue ---- */
export function listDiscountApprovals(query, user) {
  requireRole(user, ['admin']);
  const status = query.status ? oneOf(String(query.status), ['PENDING', 'APPROVED', 'REJECTED'], 'status') : null;
  const where = []; const args = [];
  if (status) { where.push('da.status = ?'); args.push(status); }
  return db.prepare(`SELECT da.*, s.label scheme_label, o.accession order_accession, o.status order_status, o.base_price order_base_price,
      o.final_amount order_final_amount, x.name exam_name, p.name patient_name, p.mrn, rg.reg_no
    FROM discount_approvals da LEFT JOIN discount_schemes s ON s.id = da.scheme_id LEFT JOIN orders o ON o.id = da.order_id
    LEFT JOIN exam_catalog x ON x.code = o.exam_code LEFT JOIN patients p ON p.id = o.patient_id LEFT JOIN registrations rg ON rg.id = da.registration_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY (da.status = 'PENDING') DESC, da.requested_at DESC LIMIT 500`).all(...args);
}

export function decideDiscountApproval(id, body, user) {
  requireRole(user, ['admin']);
  const a = db.prepare('SELECT * FROM discount_approvals WHERE id = ?').get(id);
  if (!a) throw notFound('Discount approval');
  if (a.status !== 'PENDING') throw conflict('INVALID_STATE', `Discount approval is already ${a.status}`);
  // Segregation of duties, same rule as billing.js's requestRefund/decideRefund: the admin who requested a discount
  // (reception or admin can both apply one) must not also be the one who signs off on it.
  if (a.requested_by === user.id) throw forbidden('You cannot approve a discount you requested');
  const decision = oneOf(body.decision, ['APPROVED', 'REJECTED'], 'decision');
  const note = decision === 'REJECTED' ? requireText(body.note, 'Reason', 300) : optionalText(body.note, 300);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(a.order_id);
  tx(db, () => {
    const r = db.prepare("UPDATE discount_approvals SET status = ?, decided_by = ?, decided_by_name = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'PENDING'")
      .run(decision, user.id, user.fullName, now(), note || null, id);
    if (r.changes !== 1) throw conflict('INVALID_STATE', 'Discount approval was already decided');
    if (decision === 'REJECTED' && order) {
      // Revert the line to full price -- the discount this approval covered never gets to count as approved.
      db.prepare("UPDATE orders SET discount_pct = 0, discount_amount = 0, final_amount = base_price, no_charge = 0, waiver_reason = NULL, discount_scheme_id = NULL, updated_at = ? WHERE id = ?")
        .run(now(), order.id);
    }
    audit({ action: `DISCOUNT_${decision}`, actor: user, patientId: order?.patient_id, resource: order?.accession || a.id, details: { scheme: a.scheme_id, pct: a.pct, note } });
  });
  const updatedOrder = order ? db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id) : null;
  notify([a.requested_by], { orderId: a.order_id, kind: 'DISCOUNT_DECISION',
    text: `Discount of ${a.pct}% on ${order?.accession || 'an order'} was ${decision.toLowerCase()}${decision === 'REJECTED' ? ', reverted to full price' : ''}: ${note || ''}`.trim() });
  return { approval: { ...a, status: decision, decided_by: user.id, decided_by_name: user.fullName, note }, order: updatedOrder };
}
