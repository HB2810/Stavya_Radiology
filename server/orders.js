import { db } from './db.js';
import { audit } from './audit.js';
import { RADIOLOGY_STAFF, WARD_ROLES, requireRole } from './auth.js';
import { bad, conflict, dateRange, forbidden, likeEsc, notFound, now, nowMs, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { config } from './config.js';
import { getExam } from './catalog.js';
import { notify, usersWithRoles } from './notifications.js';
import { createPendingApproval, resolveDiscount, supersedePendingApprovals } from './discounts.js';
import { applyTraffic, getChannel, resolveChannelForEncounter } from './traffic.js';

export const PRIORITIES = ['ROUTINE', 'URGENT', 'STAT'];
const PRIORITY_WEIGHT = { STAT: 3, URGENT: 2, ROUTINE: 1 };
// Dashboard tile keys (from the agency dashboard) -> catalog modality
export const EQUIPMENT_KEYS = { dexa: 'DEXA', mri: 'MRI', open_mri: 'OPEN_MRI', xray: 'XR', sonography: 'USG', ct_scan: 'CT' };

// status -> next status -> permission group
const FLOW = {
  REQUESTED: { ACKNOWLEDGED: 'triage', CANCELLED: 'cancel' },
  ACKNOWLEDGED: { SCHEDULED: 'triage', CANCELLED: 'cancel' },
  SCHEDULED: { SCHEDULED: 'triage', ARRIVED: 'triage', NO_SHOW: 'triage', CANCELLED: 'cancel' },
  NO_SHOW: { SCHEDULED: 'triage', CANCELLED: 'cancel' },
  ARRIVED: { PREPARED: 'acquire', CANCELLED: 'cancel' },
  PREPARED: { IN_PROGRESS: 'acquire', CANCELLED: 'cancel' },
  IN_PROGRESS: { COMPLETED: 'acquire' },
  COMPLETED: {}, REPORT_DRAFTED: {}, REPORTED: { DISPATCHED: 'handover' }, DISPATCHED: { COLLECTED: 'handover' }, COLLECTED: {}, CANCELLED: {}
};
const GROUPS = { triage: RADIOLOGY_STAFF, acquire: ['technologist', 'radiologist'], handover: ['reception', 'radiologist'] };
export const OPEN_STATUSES = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW', 'ARRIVED', 'PREPARED', 'IN_PROGRESS', 'COMPLETED', 'REPORT_DRAFTED'];
// A signed report exists in all of these; the last two record hand-over of the report to the patient.
export const FINAL_STATUSES = ['REPORTED', 'DISPATCHED', 'COLLECTED'];

const isRadiology = (u) => RADIOLOGY_STAFF.includes(u.role);
const canSeeAll = (u) => isRadiology(u) || u.role === 'admin' || u.role === 'auditor';

// SQL fragment limiting orders a ward user may see: their own requests, their patients, their ward.
export function visibility(user) {
  if (canSeeAll(user)) return { sql: '1=1', args: [] };
  if (user.role === 'clinician') return { sql: '(o.requested_by = ? OR e.doctor_id = ?)', args: [user.id, user.id] };
  return { sql: '(o.requested_by = ? OR (e.ward IS NOT NULL AND e.ward = ?))', args: [user.id, user.ward || '\u0000'] };
}

const accession = () => {
  const y = new Date(nowMs()).getFullYear();
  const n = db.prepare("SELECT COUNT(*) c FROM orders WHERE accession LIKE ?").get(`RAD-${y}-%`).c + 1;
  return `RAD-${y}-${String(n).padStart(6, '0')}`;
};

function baseRow(id) {
  return db.prepare(`SELECT o.*, p.name patient_name, p.mrn, p.dob, p.sex, p.allergy, x.name exam_name, x.modality, x.body_part,
      x.uses_contrast, x.ionising, x.mri, e.type encounter_type, e.ref_no encounter_ref, e.ward, e.room, e.bed, e.diagnosis, e.doctor_id encounter_doctor_id,
      du.full_name consultant_name, ru.full_name requested_by_name, ru.designation requested_by_designation, rg.reg_no registration_no, rg.referring_doctor,
      EXISTS (SELECT 1 FROM discount_approvals da WHERE da.order_id = o.id AND da.status = 'PENDING') discount_pending
    FROM orders o JOIN patients p ON p.id = o.patient_id JOIN encounters e ON e.id = o.encounter_id
    JOIN exam_catalog x ON x.code = o.exam_code JOIN users ru ON ru.id = o.requested_by
    LEFT JOIN users du ON du.id = e.doctor_id LEFT JOIN registrations rg ON rg.id = o.registration_id WHERE o.id = ?`).get(id);
}
function withTiming(o) {
  const dueMs = Date.parse(o.due_at);
  const open = OPEN_STATUSES.includes(o.status);
  return { ...o, overdue: open && dueMs < Date.now(), minutes_to_due: open ? Math.round((dueMs - Date.now()) / 60000) : null };
}

export function getOrderForUser(id, user) {
  const o = baseRow(id);
  if (!o) throw notFound('Order');
  const v = visibility(user);
  const ok = db.prepare(`SELECT 1 FROM orders o JOIN encounters e ON e.id = o.encounter_id WHERE o.id = ? AND ${v.sql}`).get(id, ...v.args);
  if (!ok) throw forbidden('You do not have access to this order');
  return withTiming(o);
}

export function listOrders(user, q = {}) {
  const v = visibility(user);
  const where = [v.sql]; const args = [...v.args];
  const add = (cond, val) => { where.push(cond); args.push(val); };
  if (q.status) { const s = String(q.status).split(','); where.push(`o.status IN (${s.map(() => '?').join(',')})`); args.push(...s); }
  if (q.open === '1') where.push(`o.status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`);
  if (q.source) add('o.source = ?', q.source);
  if (q.priority) add('o.priority = ?', q.priority);
  if (q.modality) add('x.modality = ?', q.modality);
  if (q.patientId) add('o.patient_id = ?', q.patientId);
  if (q.registrationId) add('o.registration_id = ?', q.registrationId);
  if (q.equipment && q.equipment !== 'all') add('x.modality = ?', EQUIPMENT_KEYS[q.equipment] || '\u0000');
  const range = dateRange(q);
  if (range) { where.push('o.created_at >= ? AND o.created_at < ?'); args.push(range[0], range[1]); }
  if (q.mine === '1') { where.push('(o.radiologist_id = ? OR o.technologist_id = ? OR o.requested_by = ?)'); args.push(user.id, user.id, user.id); }
  if (q.q) { where.push("(p.name LIKE ? ESCAPE '\\' OR p.mrn LIKE ? ESCAPE '\\' OR o.accession LIKE ? ESCAPE '\\')"); const like = `%${likeEsc(q.q)}%`; args.push(like, like, like); }
  const rows = db.prepare(`SELECT o.id FROM orders o JOIN patients p ON p.id = o.patient_id JOIN encounters e ON e.id = o.encounter_id
      JOIN exam_catalog x ON x.code = o.exam_code WHERE ${where.join(' AND ')} LIMIT 500`).all(...args);
  const out = rows.map((r) => withTiming(baseRow(r.id)));
  // Smart worklist order: overdue first, then priority, then earliest due.
  out.sort((a, b) => (b.overdue - a.overdue) || (PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority]) || a.due_at.localeCompare(b.due_at));
  return out;
}

function logEvent(order, from, to, user, note = '') {
  db.prepare('INSERT INTO order_events (id, order_id, from_status, to_status, actor_id, actor_name, note, at) VALUES (?,?,?,?,?,?,?,?)')
    .run(uid('evt'), order.id, from, to, user.id, user.fullName, note, now());
}

// expectedRevision is optional on the API (the web app always sends it); RIS_REQUIRE_REVISION=1 makes it mandatory.
function checkRevision(body, order) {
  const rev = body.expectedRevision;
  if (rev == null) { if (config.requireRevision) throw bad('REVISION_REQUIRED', 'expectedRevision is required'); return; }
  if (!Number.isInteger(rev)) throw bad('EXPECTED_REVISION_INVALID', 'expectedRevision must be a whole number');
  if (rev !== order.revision) throw conflict('STALE_REVISION', 'Order changed, reload and retry');
}

export function createOrder(body, user, opts = {}) {
  if (!opts.skipRoleCheck) requireRole(user, ['clinician', 'nurse', 'reception', 'radiologist']);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(String(body.patientId || ''));
  if (!patient) throw notFound('Patient');
  const enc = db.prepare('SELECT * FROM encounters WHERE id = ? AND patient_id = ?').get(String(body.encounterId || ''), patient.id);
  if (!enc) throw bad('ENCOUNTER_MISMATCH', 'Encounter does not belong to this patient');
  if (enc.status !== 'ACTIVE') throw conflict('ENCOUNTER_CLOSED', 'This encounter is not active');
  const exam = getExam(body.examCode);
  if (!exam) throw bad('UNKNOWN_EXAM', 'Unknown exam code');
  if (!exam.active) throw bad('EXAM_INACTIVE', 'This service is not currently offered');
  // exam.price is NULL when the hospital's sheet gave no rate yet (migrations/003_service_master.js) -- it must
  // never be coerced to 0 below, which would silently bill the order as free. Block ordering until an admin sets
  // a real price on the service catalog (PKG-M2 masters screen).
  if (exam.price == null) throw bad('EXAM_PRICE_NOT_SET', 'This service has no price set yet; ask an administrator to set its price in the service catalog before it can be ordered');
  const priority = oneOf(body.priority || 'ROUTINE', PRIORITIES, 'priority');
  const indication = requireText(body.clinicalIndication, 'Clinical indication', 2000);
  if (indication.length < 5) throw bad('INDICATION_TOO_SHORT', 'Please give a meaningful clinical indication');
  if (priority === 'STAT' && !WARD_ROLES.includes(user.role) && user.role !== 'radiologist') {
    throw forbidden('STAT orders must come from a clinician, nurse or radiologist');
  }

  const cutoff = new Date(nowMs() - config.duplicateWindowDays * 86400_000).toISOString();
  // externalOrderId: the sending system's own id for this order (e.g. the hospital system). A resend of the same id never creates a second order.
  const externalId = body.externalOrderId == null || body.externalOrderId === '' ? null : requireText(body.externalOrderId, 'externalOrderId', 80);
  if (externalId && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(externalId)) throw bad('EXTERNAL_ORDER_ID_INVALID', 'externalOrderId may contain letters, digits and . _ : / -');
  const side = optionalText(body.side, 20) || null;
  const { pct, schemeId, waiver, requiresApproval } = resolveDiscount(body, user);
  const base = Number(exam.price); const discountAmount = Math.round(base * pct) / 100; // exam.price is never null here: blocked above
  if (externalId) {
    const seen = db.prepare('SELECT id, patient_id, exam_code, side FROM orders WHERE external_order_id = ?').get(externalId);
    if (seen) {
      if (seen.patient_id !== patient.id || seen.exam_code !== exam.code || (seen.side || '') !== (side || '')) throw conflict('EXTERNAL_ORDER_ID_CONFLICT', 'That externalOrderId was already used for a different order');
      return { order: withTiming(baseRow(seen.id)), duplicateOverridden: false, replayed: true };
    }
  }
  const duplicate = db.prepare(`SELECT id, accession, status, created_at FROM orders WHERE patient_id = ? AND exam_code = ? AND COALESCE(side,'') = ?
    AND status != 'CANCELLED' AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(patient.id, exam.code, side || '', cutoff);
  if (duplicate && body.confirmDuplicate !== true) {
    throw conflict('POSSIBLE_DUPLICATE', `Same exam already ordered (${duplicate.accession}, ${duplicate.status}). Resend with confirmDuplicate to proceed.`);
  }

  const id = uid('ord'); const t = now();
  const due = new Date(nowMs() + config.slaHours[priority] * 3600_000).toISOString();
  // Designation (Fellow / Surgeon / Medical Officer / Consultant / ...) travels with the request everywhere it is
  // shown later, so the note and audit details capture it now -- it is display/audit only, never a permission tier.
  // The sentence form (used in the radiology notification) only reads naturally for the ward/OPD clinician who
  // actually holds a clinical designation; reception and radiology staff keep their plain name there.
  const requesterLabel = WARD_ROLES.includes(user.role) && user.designation ? `${user.designation} ${user.fullName}` : user.fullName;
  const channel = resolveChannelForEncounter(enc.type, body.channelCode || null);
  const privileged = body.privileged === true || channel?.code === 'ER' || priority === 'STAT';
  const order = tx(db, () => {
    db.prepare(`INSERT INTO orders (id, accession, patient_id, encounter_id, source, exam_code, priority, clinical_indication, requested_by,
      status, due_at, created_at, updated_at, registration_id, side, base_price, discount_pct, discount_amount, final_amount, no_charge, waiver_reason, external_order_id, discount_scheme_id, channel_code, privileged)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, accession(), patient.id, enc.id, enc.type, exam.code, priority, indication, user.id, 'REQUESTED', due, t, t,
        opts.registrationId || null, side, base, pct, discountAmount, base - discountAmount, body.noCharge ? 1 : 0, waiver, externalId, schemeId, channel?.code || null, privileged ? 1 : 0);
    logEvent({ id }, null, 'REQUESTED', user, `${enc.type} request${WARD_ROLES.includes(user.role) && user.designation ? ' · ' + user.designation : ''}`);
    if (requiresApproval) createPendingApproval({ orderId: id, registrationId: opts.registrationId || null, schemeId, pct, waiver }, user);
    const row = baseRow(id);
    audit({ action: 'ORDER_CREATED', actor: user, patientId: patient.id, resource: row.accession, details: { exam: exam.code, priority, source: enc.type, requestedByDesignation: user.designation || null, discountPct: pct, scheme: schemeId, waiver, channel: channel?.code || null, ...(externalId ? { externalOrderId: externalId } : {}) } });
    return row;
  });
  // Optional token + auto ACK→SCHEDULED (respects admin traffic switches + channel.auto_queue).
  if (channel && !opts.skipTraffic) {
    try { applyTraffic(id, { channel, user, skipAuto: opts.skipAuto === true }); } catch (e) { console.warn('[traffic]', e.message); }
  }
  const fresh = withTiming(baseRow(id));
  notify(usersWithRoles(['radiologist', 'technologist', 'reception']), {
    orderId: id, kind: priority === 'STAT' ? 'STAT_ORDER' : 'NEW_ORDER',
    text: `${requesterLabel} requested ${priority} ${exam.name} for ${patient.name} (${enc.type}${enc.ward ? ' ' + enc.ward : ''})`
  });
  if (requiresApproval) notify(usersWithRoles(['admin']), { orderId: id, kind: 'DISCOUNT_APPROVAL', text: `Discount of ${pct}% on ${exam.name} for ${patient.name} needs approval${waiver ? ': ' + waiver : ''}` });
  return { order: fresh, duplicateOverridden: Boolean(duplicate) };
}

export function transition(orderId, body, user) {
  const order = getOrderForUser(orderId, user);
  const to = String(body.to || '');
  const group = FLOW[order.status]?.[to];
  if (!group) throw conflict('INVALID_TRANSITION', `Cannot move from ${order.status} to ${to}`);
  checkRevision(body, order);
  if (group === 'cancel') {
    if (!(isRadiology(user) && user.role !== 'technologist') && order.requested_by !== user.id) throw forbidden('Only the requester, reception or a radiologist can cancel');
  } else requireRole(user, GROUPS[group]);
  const note = optionalText(body.note, 1000);
  let scheduledAt = order.scheduled_at;
  if (to === 'CANCELLED' && !note) throw bad('REASON_REQUIRED', 'A reason is required to cancel');
  if (to === 'SCHEDULED') {
    if (!body.scheduledAt || Number.isNaN(Date.parse(body.scheduledAt))) throw bad('SCHEDULE_REQUIRED', 'A valid scheduledAt time is required');
    scheduledAt = new Date(body.scheduledAt).toISOString();
  }
  if (to === 'PREPARED' && !db.prepare('SELECT 1 FROM scan_consents WHERE order_id = ?').get(orderId)) throw conflict('CONSENT_REQUIRED', 'Record the patient consent form before marking the patient prepared');
  if (to === 'IN_PROGRESS') {
    if (order.uses_contrast || order.ionising || order.mri) {
      const s = latestSafety(order.id);
      if (!s || !['CLEARED', 'CLEARED_OVERRIDE'].includes(s.status)) throw conflict('SAFETY_CHECK_REQUIRED', 'Complete the safety screening before starting this exam');
    }
  }
  const t = now();
  tx(db, () => {
    const r = db.prepare(`UPDATE orders SET status = ?, scheduled_at = ?, cancel_reason = ?, technologist_id = COALESCE(?, technologist_id),
      completed_at = CASE WHEN ? = 'COMPLETED' THEN ? ELSE completed_at END, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`)
      .run(to, scheduledAt, to === 'CANCELLED' ? note : order.cancel_reason, to === 'IN_PROGRESS' && user.role === 'technologist' ? user.id : null, to, t, t, orderId, order.revision);
    if (r.changes !== 1) throw conflict('STALE_REVISION', 'Order changed, reload and retry');
    logEvent(order, order.status, to, user, note);
    // A cancelled line's discount no longer charges anything -- a still-PENDING approval for it must not be
    // decided later and reset a line that is already off the invoice (same reasoning as registration.js's invoice edits).
    if (to === 'CANCELLED') supersedePendingApprovals(order.id, user);
    audit({ action: 'ORDER_' + to, actor: user, patientId: order.patient_id, resource: order.accession, details: { from: order.status, note } });
  });
  const text = `${order.exam_name} for ${order.patient_name}: ${order.status} → ${to}${note ? ' (' + note + ')' : ''}`;
  notify([order.requested_by, order.encounter_doctor_id].filter((id) => id !== user.id), { orderId, kind: 'STATUS', text });
  if (to === 'COMPLETED') notify(usersWithRoles(['radiologist']), { orderId, kind: 'READY_TO_REPORT', text: `Ready to report: ${order.exam_name}, ${order.patient_name} (${order.priority})` });
  return getOrderForUser(orderId, user);
}

export function assign(orderId, body, user) {
  requireRole(user, ['reception', 'radiologist']);
  const order = getOrderForUser(orderId, user);
  checkRevision(body, order);
  const check = (id, role) => {
    if (!id) return null;
    const u = db.prepare('SELECT id FROM users WHERE id = ? AND role = ? AND active = 1').get(id, role);
    if (!u) throw bad('BAD_ASSIGNEE', `Assignee must be an active ${role}`);
    return id;
  };
  const tech = check(body.technologistId, 'technologist'); const rad = check(body.radiologistId, 'radiologist');
  tx(db, () => {
    const r = db.prepare('UPDATE orders SET technologist_id = COALESCE(?, technologist_id), radiologist_id = COALESCE(?, radiologist_id), revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(tech, rad, now(), orderId, order.revision);
    if (r.changes !== 1) throw conflict('STALE_REVISION', 'Order changed, reload and retry');
    audit({ action: 'ORDER_ASSIGNED', actor: user, patientId: order.patient_id, resource: order.accession, details: { tech, rad } });
  });
  notify([tech, rad], { orderId, kind: 'ASSIGNED', text: `You were assigned ${order.exam_name} for ${order.patient_name}` });
  return getOrderForUser(orderId, user);
}

// ---- Safety screening ----
export const latestSafety = (orderId) => db.prepare('SELECT * FROM safety_checks WHERE order_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(orderId);

export function recordSafety(orderId, body, user) {
  requireRole(user, ['technologist', 'radiologist']);
  const order = getOrderForUser(orderId, user);
  const yn = (v, f) => oneOf(v, ['YES', 'NO', 'NA'], f);
  const pregnant = yn(body.pregnant, 'pregnant'); const allergy = yn(body.contrastAllergy, 'contrastAllergy');
  const implant = oneOf(body.mriImplant, ['YES', 'NO', 'NA', 'UNKNOWN'], 'mriImplant');
  const egfr = body.egfr == null || body.egfr === '' ? null : Number(body.egfr);
  // Entry range: reportable eGFR (mL/min/1.73 m²) per CKD-EPI / KDIGO lab practice used under JCI & NABH contrast protocols.
  if (egfr != null && (!Number.isFinite(egfr) || egfr < 1 || egfr > 150)) {
    throw bad('EGFR_INVALID', 'eGFR must be between 1 and 150 mL/min/1.73 m² (JCI/NABH lab reporting range)');
  }
  const flags = [];
  if (order.uses_contrast) {
    if (allergy === 'YES') flags.push({ level: 'BLOCK', text: 'Reported contrast allergy' });
    if (egfr == null) flags.push({ level: 'BLOCK', text: 'eGFR required for contrast (document before IV contrast)' });
    // No automatic BLOCK/WARN on eGFR value — radiologist applies ACR/NKF · ESUR · local JCI/NABH contrast protocol clinically.
  }
  if (order.ionising && pregnant === 'YES') flags.push({ level: 'BLOCK', text: 'Patient is pregnant and exam uses ionising radiation' });
  if (order.mri && (implant === 'YES' || implant === 'UNKNOWN')) flags.push({ level: 'BLOCK', text: implant === 'YES' ? 'MRI implant/device reported' : 'MRI implant status unknown' });
  const blocked = flags.some((f) => f.level === 'BLOCK');
  let status = blocked ? 'BLOCKED' : 'CLEARED'; let override = null;
  if (blocked && body.overrideReason) {
    if (user.role !== 'radiologist') throw forbidden('Only a radiologist can override a safety block');
    override = requireText(body.overrideReason, 'overrideReason', 1000); status = 'CLEARED_OVERRIDE';
  }
  const id = uid('sfc');
  tx(db, () => {
    db.prepare('INSERT INTO safety_checks (id, order_id, pregnant, contrast_allergy, egfr, mri_implant, notes, flags_json, status, override_reason, actor_id, actor_name, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, orderId, pregnant, allergy, egfr, implant, optionalText(body.notes, 1000), JSON.stringify(flags), status, override, user.id, user.fullName, now());
    audit({ action: 'SAFETY_CHECK_' + status, actor: user, patientId: order.patient_id, resource: order.accession, details: { flags, override } });
  });
  if (blocked && !override) notify(usersWithRoles(['radiologist']), { orderId, kind: 'SAFETY_BLOCK', text: `Safety block on ${order.exam_name} for ${order.patient_name}: ${flags.filter((f) => f.level === 'BLOCK').map((f) => f.text).join('; ')}` });
  return { id, status, flags };
}

export function orderDetail(orderId, user) {
  const order = getOrderForUser(orderId, user);
  const events = db.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY at, rowid').all(orderId);
  const safety = latestSafety(orderId);
  return { order, events, safety: safety ? { ...safety, flags: JSON.parse(safety.flags_json) } : null };
}
