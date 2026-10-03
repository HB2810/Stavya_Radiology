import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, forbidden, notFound, now, nowMs, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { summarize } from './registration.js';
import { notify, usersWithRoles } from './notifications.js';
import { config } from './config.js';

const STAFF = ['reception', 'admin'];
const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1]; const COINS = [10, 5, 2, 1];
const money = (v, field) => { const n = Math.round(Number(v) * 100) / 100; if (!Number.isFinite(n) || n < 0) throw bad('AMOUNT_INVALID', `${field} is not a valid amount`); return n; };
const receiptNo = () => { const y = new Date(nowMs()).getFullYear(); return `RCT-${y}-${String(db.prepare('SELECT COUNT(*) c FROM payments WHERE receipt_no LIKE ?').get(`RCT-${y}-%`).c + 1).padStart(6, '0')}`; };

function tally(map, allowed, field) {
  let total = 0; const clean = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (!allowed.includes(Number(k))) throw bad('DENOMINATION_INVALID', `${field}: ${k} is not a valid denomination`);
    const n = Number(v); if (!Number.isInteger(n) || n < 0 || n > 10000) throw bad('DENOMINATION_INVALID', `${field}: count for ${k} is not valid`);
    if (n) { clean[k] = n; total += n * Number(k); }
  }
  return { clean, total };
}

export function recordPayment(regId, body, user) {
  requireRole(user, STAFF);
  const s = summarize(regId);
  if (s.status !== 'ACTIVE') throw conflict('REGISTRATION_CLOSED', 'This registration is cancelled');
  if (s.available_to_collect <= 0.005) throw conflict('PAYMENT_COMPLETE', s.cheque_in_process > 0 ? 'The balance is covered by a cheque in process' : 'Payment is complete');
  const method = oneOf(body.method, ['CASH', 'CHEQUE', 'ONLINE'], 'method');
  const amount = money(body.amount, 'Payment amount'); const discount = money(body.discount || 0, 'Discount');
  if (amount <= 0) throw bad('AMOUNT_INVALID', 'Payment amount must be more than zero');
  if (amount + discount > s.available_to_collect + 0.005) throw bad('AMOUNT_TOO_HIGH', `Amount plus discount exceeds the balance of ₹${s.available_to_collect}`);
  const discountReason = discount > 0 ? requireText(body.discountReason, 'Reason for the discount', 300) : null;
  let details = {}; let status = 'RECEIVED';
  if (method === 'CASH') {
    const notes = tally(body.notes, NOTES, 'Notes'); const coins = tally(body.coins, COINS, 'Coins'); const collected = notes.total + coins.total;
    if (collected + 0.005 < amount) throw bad('INSUFFICIENT_CASH', `Insufficient amount collected (₹${collected} of ₹${amount})`);
    const change = Math.round((collected - amount) * 100) / 100;
    let returned = { notes: {}, coins: {}, total: 0 };
    if (change > 0) {
      const rn = tally(body.returnNotes, NOTES, 'Change notes'); const rc = tally(body.returnCoins, COINS, 'Change coins');
      if (Math.abs(rn.total + rc.total - change) > 0.005) throw bad('CHANGE_MISMATCH', `Change to return is ₹${change}; the breakdown adds up to ₹${rn.total + rc.total}`);
      returned = { notes: rn.clean, coins: rc.clean, total: change };
    }
    details = { collectorName: optionalText(body.collectorName, 100) || user.fullName, remarks: optionalText(body.remarks, 300), notes: notes.clean, coins: coins.clean, collected, returned };
  } else if (method === 'CHEQUE') {
    const ifsc = String(body.ifsc || '').toUpperCase().trim();
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw bad('IFSC_INVALID', 'IFSC must look like HDFC0001234');
    const chequeDate = requireText(body.chequeDate, 'Cheque date', 10); const depositDate = requireText(body.depositDate, 'Deposit date', 10);
    if (Number.isNaN(Date.parse(chequeDate)) || Number.isNaN(Date.parse(depositDate))) throw bad('DATE_INVALID', 'Cheque or deposit date is not valid');
    if (!/^\d{6}$/.test(String(body.chequeNumber || ''))) throw bad('CHEQUE_NUMBER_INVALID', 'Cheque number must be 6 digits');
    details = { chequeNumber: String(body.chequeNumber), bank: requireText(body.bank, 'Bank', 100), accountHolder: requireText(body.accountHolder, 'Account holder', 100), ifsc, chequeDate, depositDate };
    status = 'IN_PROCESS';
  } else {
    const reference = requireText(body.reference, 'Payment reference', 100);
    if (db.prepare("SELECT 1 FROM payments WHERE method = 'ONLINE' AND json_extract(details_json, '$.reference') = ?").get(reference)) throw conflict('REFERENCE_USED', 'That payment reference was already recorded');
    // Recorded by staff from the gateway/UPI confirmation. No payment gateway is integrated.
    details = { gateway: oneOf(body.gateway || 'UPI', ['UPI', 'Card', 'NetBanking', 'Razorpay', 'Other'], 'gateway'), reference };
  }
  const id = uid('pay'); const t = now(); let receipt;
  tx(db, () => {
    receipt = receiptNo();
    db.prepare('INSERT INTO payments (id, registration_id, method, amount, discount, discount_reason, status, details_json, receipt_no, collected_by, collected_by_name, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, regId, method, amount, discount, discountReason, status, JSON.stringify(details), receipt, user.id, user.fullName, t);
    audit({ action: 'PAYMENT_RECORDED', actor: user, patientId: s.patient_id, resource: `${s.reg_no}/${receipt}`, details: { method, amount, discount, status } });
  });
  return { paymentId: id, receiptNo: receipt, status, summary: summarize(regId) };
}

export function processCheque(paymentId, body, user) {
  requireRole(user, STAFF);
  const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!p || p.method !== 'CHEQUE') throw notFound('Cheque payment');
  if (p.status !== 'IN_PROCESS') throw conflict('INVALID_STATE', `Cheque is already ${p.status}`);
  const decision = oneOf(body.decision, ['CLEARED', 'BOUNCED'], 'decision');
  const note = decision === 'BOUNCED' ? requireText(body.note, 'Reason', 300) : optionalText(body.note, 300);
  const s = tx(db, () => {
    db.prepare('UPDATE payments SET status = ?, processed_at = ?, processed_note = ? WHERE id = ?').run(decision === 'CLEARED' ? 'RECEIVED' : 'BOUNCED', now(), note, paymentId);
    const sum = summarize(p.registration_id);
    audit({ action: `CHEQUE_${decision}`, actor: user, patientId: sum.patient_id, resource: `${sum.reg_no}/${p.receipt_no}`, details: { note } });
    return sum;
  });
  return { summary: s };
}

/* ---- Refunds: request -> admin approval -> paid out ---- */
export function requestRefund(regId, body, user) {
  requireRole(user, STAFF);
  const s = summarize(regId);
  const amount = money(body.amount, 'Refund amount'); const reason = requireText(body.reason, 'Reason', 300);
  if (amount <= 0) throw bad('AMOUNT_INVALID', 'Refund must be more than zero');
  if (amount > s.refundable + 0.005) throw bad('REFUND_TOO_HIGH', `At most ₹${s.refundable} can be refunded (paid, minus refunds already requested)`);
  const id = uid('rfd');
  tx(db, () => {
    db.prepare('INSERT INTO refunds (id, registration_id, amount, reason, status, requested_by, requested_by_name, requested_at) VALUES (?,?,?,?,?,?,?,?)').run(id, regId, amount, reason, 'PENDING', user.id, user.fullName, now());
    audit({ action: 'REFUND_REQUESTED', actor: user, patientId: s.patient_id, resource: s.reg_no, details: { amount, reason } });
  });
  notify(usersWithRoles(['admin']), { kind: 'REFUND_REQUEST', text: `Refund of ₹${amount} requested for ${s.reg_no}: ${reason}` });
  return { refundId: id, summary: summarize(regId) };
}
export function decideRefund(refundId, body, user) {
  requireRole(user, ['admin']);
  const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
  if (!r) throw notFound('Refund');
  if (r.status !== 'PENDING') throw conflict('INVALID_STATE', `Refund is already ${r.status}`);
  if (r.requested_by === user.id) throw forbidden('You cannot approve a refund you requested');
  const decision = oneOf(body.decision, ['APPROVED', 'REJECTED'], 'decision'); const note = requireText(body.note, 'Note', 300);
  const s = tx(db, () => {
    db.prepare('UPDATE refunds SET status = ?, decided_by = ?, decided_note = ?, decided_at = ? WHERE id = ? AND status = ?').run(decision, user.id, note, now(), refundId, 'PENDING');
    const sum = summarize(r.registration_id);
    audit({ action: `REFUND_${decision}`, actor: user, patientId: sum.patient_id, resource: sum.reg_no, details: { amount: r.amount, note } });
    return sum;
  });
  notify([r.requested_by], { kind: 'REFUND_DECISION', text: `Refund of ₹${r.amount} for ${s.reg_no} was ${decision.toLowerCase()}: ${note}` });
  return { summary: s };
}
export function payRefund(refundId, body, user) {
  requireRole(user, STAFF);
  const r = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
  if (!r) throw notFound('Refund');
  if (r.status !== 'APPROVED') throw conflict('INVALID_STATE', 'Only an approved refund can be paid out');
  const via = oneOf(body.via, ['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE'], 'via'); const reference = via === 'CASH' ? optionalText(body.reference, 100) : requireText(body.reference, 'Reference', 100);
  const s = tx(db, () => {
    db.prepare("UPDATE refunds SET status = 'PAID', paid_by = ?, paid_via = ?, paid_reference = ?, paid_at = ? WHERE id = ? AND status = 'APPROVED'").run(user.id, via, reference, now(), refundId);
    const sum = summarize(r.registration_id);
    audit({ action: 'REFUND_PAID', actor: user, patientId: sum.patient_id, resource: sum.reg_no, details: { amount: r.amount, via } });
    return sum;
  });
  return { summary: s };
}

/* ---- Printable documents ---- */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inr = (n) => `₹ ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STYLE = `<style>body{font:13px/1.5 system-ui,sans-serif;max-width:820px;margin:1.5rem auto;padding:0 1rem;color:#0f172a}h1{margin:0;font-size:20px}table{width:100%;border-collapse:collapse;margin:.8rem 0}th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}th{background:#f1f5f9;font-size:11px;text-transform:uppercase}td.n,th.n{text-align:right}.meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin:.8rem 0}.tot td{font-weight:700}.small{color:#64748b;font-size:11px}@media print{button{display:none}}</style>`;
const HOSPITAL = () => ({ name: config.hospitalName, address: config.hospitalAddress });

export function invoiceHtml(regId, user) {
  requireRole(user, [...STAFF, 'radiologist']);
  const s = summarize(regId); const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(s.patient_id);
  const lines = db.prepare("SELECT o.*, x.name exam_name, x.modality FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.registration_id = ? AND o.status != 'CANCELLED' ORDER BY o.created_at").all(regId);
  const pays = db.prepare("SELECT * FROM payments WHERE registration_id = ? AND status != 'BOUNCED' ORDER BY at").all(regId);
  const h = HOSPITAL(); audit({ action: 'INVOICE_PRINTED', actor: user, patientId: p.id, resource: s.reg_no });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(s.reg_no)}</title>${STYLE}</head><body><h1>${esc(h.name)}</h1><div class="small">${esc(h.address)}</div><h2>Invoice ${esc(s.reg_no)}</h2>
  <div class="meta"><div><b>Patient</b> ${esc(p.name)} (${esc(p.mrn)})</div><div><b>Date</b> ${esc(s.created_at.slice(0, 10))}</div><div><b>Age / Sex</b> ${esc(p.dob)} / ${esc(p.sex)}</div><div><b>Report no</b> ${esc(s.report_no || '—')}</div>
  <div><b>Referred by</b> ${esc(s.referring_doctor || '—')}</div><div><b>Report delivery</b> ${esc(s.delivery_at ? s.delivery_at.replace('T', ' ').slice(0, 16) : '—')}</div></div>
  <table><tr><th>Modality</th><th>Test</th><th class="n">Price</th><th class="n">Disc %</th><th class="n">Discount</th><th class="n">Total</th></tr>${lines.map((l) => `<tr><td>${esc(l.modality)}</td><td>${esc(l.exam_name)}${l.side ? ` (${esc(l.side)})` : ''}</td><td class="n">${inr(l.base_price)}</td><td class="n">${l.discount_pct}</td><td class="n">${inr(l.discount_amount)}</td><td class="n">${inr(l.final_amount)}</td></tr>`).join('')}
  <tr class="tot"><td colspan="2">Total</td><td class="n">${inr(s.base_total)}</td><td></td><td class="n">${inr(s.discount_total)}</td><td class="n">${inr(s.final_total)}</td></tr></table>
  <table><tr><th>Receipt</th><th>Method</th><th>Status</th><th class="n">Amount</th></tr>${pays.map((x) => `<tr><td>${esc(x.receipt_no)}</td><td>${esc(x.method)}</td><td>${esc(x.status)}</td><td class="n">${inr(x.amount)}</td></tr>`).join('') || '<tr><td colspan="4">No payments yet</td></tr>'}
  <tr class="tot"><td colspan="3">Paid</td><td class="n">${inr(s.paid_amount)}</td></tr><tr class="tot"><td colspan="3">Balance due</td><td class="n">${inr(s.pending_amount)}</td></tr></table>
  <p class="small">Payment status: ${esc(s.payment_status)}. This is a computer-generated document.</p><button onclick="print()">Print / Save as PDF</button></body></html>`;
}

export function receiptHtml(paymentId, user) {
  requireRole(user, [...STAFF]);
  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!pay) throw notFound('Payment');
  const s = summarize(pay.registration_id); const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(s.patient_id); const h = HOSPITAL(); const d = JSON.parse(pay.details_json);
  audit({ action: 'RECEIPT_PRINTED', actor: user, patientId: p.id, resource: pay.receipt_no });
  const detail = pay.method === 'CHEQUE' ? `Cheque ${esc(d.chequeNumber)} · ${esc(d.bank)} · ${esc(d.ifsc)} · dated ${esc(d.chequeDate)}` : pay.method === 'ONLINE' ? `${esc(d.gateway)} ref ${esc(d.reference)}` : `Cash collected ${inr(d.collected)}${d.returned.total ? `, change returned ${inr(d.returned.total)}` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(pay.receipt_no)}</title>${STYLE}</head><body><h1>${esc(h.name)}</h1><div class="small">${esc(h.address)}</div><h2>Payment receipt ${esc(pay.receipt_no)}</h2>
  <div class="meta"><div><b>Patient</b> ${esc(p.name)} (${esc(p.mrn)})</div><div><b>Registration</b> ${esc(s.reg_no)}</div><div><b>Date</b> ${esc(pay.at.replace('T', ' ').slice(0, 16))}</div><div><b>Received by</b> ${esc(pay.collected_by_name)}</div></div>
  <table><tr><th>Method</th><th>Details</th><th>Status</th><th class="n">Amount</th></tr><tr><td>${esc(pay.method)}</td><td>${detail}</td><td>${esc(pay.status)}${pay.status === 'IN_PROCESS' ? ' (not yet cleared)' : ''}</td><td class="n">${inr(pay.amount)}</td></tr>
  ${pay.discount > 0 ? `<tr><td colspan="3">Discount allowed (${esc(pay.discount_reason)})</td><td class="n">${inr(pay.discount)}</td></tr>` : ''}</table>
  <p class="small">Balance after this payment: ${inr(s.pending_amount)}. This is a computer-generated receipt.</p><button onclick="print()">Print / Save as PDF</button></body></html>`;
}
