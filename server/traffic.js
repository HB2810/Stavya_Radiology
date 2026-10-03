// Token / automatic traffic engine. Channel and machine masters drive behaviour; the core FLOW
// in orders.js stays intact — we auto-advance REQUESTED → ACKNOWLEDGED → SCHEDULED with a token + ETA.
import { db } from './db.js';
import { bad, conflict, now, nowMs, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { requireRole } from './auth.js';
import { audit } from './audit.js';
import { getExam } from './catalog.js';

const PAYMENT_STATUSES = ['UNPAID', 'PAID_OPD', 'PAID_RADIOLOGY', 'IPD_CREDIT', 'WAIVED', 'NOT_REQUIRED'];
const OPEN_QUEUE = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'ARRIVED', 'PREPARED', 'IN_PROGRESS'];

export function listChannels({ activeOnly = true } = {}) {
  return db.prepare(`SELECT * FROM channels ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, name`).all();
}
export function getChannel(code) {
  return db.prepare('SELECT * FROM channels WHERE code = ?').get(String(code || ''));
}
export function listMachines({ activeOnly = true, modality } = {}) {
  const where = []; const args = [];
  if (activeOnly) where.push('active = 1');
  if (modality) { where.push('modality = ?'); args.push(modality); }
  return db.prepare(`SELECT * FROM machines ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order, name`).all(...args);
}
export function getQueueRules() {
  const row = db.prepare('SELECT * FROM queue_rules WHERE id = ?').get('qr_default');
  if (!row) return { priorityOrder: [], noShowMinutes: 30, holdReasons: [] };
  return { ...row, priorityOrder: JSON.parse(row.priority_order_json), holdReasons: JSON.parse(row.hold_reasons_json) };
}

export function updateChannel(code, body, user) {
  requireRole(user, ['admin']);
  const ch = getChannel(code);
  if (!ch) throw bad('UNKNOWN_CHANNEL', 'Unknown channel');
  const name = body.name != null ? requireText(body.name, 'Name', 80) : ch.name;
  const paymentPlace = body.paymentPlace != null ? oneOf(body.paymentPlace, ['OPD', 'RADIOLOGY', 'IPD_CREDIT', 'NONE'], 'paymentPlace') : ch.payment_place;
  const reportHandover = body.reportHandover != null ? oneOf(body.reportHandover, ['CONSULTANT', 'PATIENT', 'WARD'], 'reportHandover') : ch.report_handover;
  const defaultPriority = body.defaultPriority != null ? oneOf(body.defaultPriority, ['ROUTINE', 'URGENT', 'STAT'], 'defaultPriority') : ch.default_priority;
  const paymentGate = body.paymentGate == null ? ch.payment_gate : (body.paymentGate ? 1 : 0);
  const allowStat = body.allowStatReception == null ? ch.allow_stat_reception : (body.allowStatReception ? 1 : 0);
  const autoQueue = body.autoQueue == null ? ch.auto_queue : (body.autoQueue ? 1 : 0);
  const quickEntry = body.quickEntry == null ? ch.quick_entry : (body.quickEntry ? 1 : 0);
  const tokenPrefix = body.tokenPrefix != null ? requireText(body.tokenPrefix, 'Token prefix', 6) : ch.token_prefix;
  const sortOrder = body.sortOrder != null ? Number(body.sortOrder) : ch.sort_order;
  const notes = body.notes != null ? optionalText(body.notes, 500) || '' : ch.notes;
  const active = body.active == null ? ch.active : (body.active ? 1 : 0);
  db.prepare(`UPDATE channels SET name=?, payment_place=?, payment_gate=?, report_handover=?, default_priority=?, allow_stat_reception=?, auto_queue=?, quick_entry=?, token_prefix=?, sort_order=?, active=?, notes=? WHERE code=?`)
    .run(name, paymentPlace, paymentGate, reportHandover, defaultPriority, allowStat, autoQueue, quickEntry, tokenPrefix, sortOrder, active, notes, code);
  audit({ action: 'CHANNEL_UPDATED', actor: user, resource: code, details: { paymentPlace, paymentGate, autoQueue } });
  return getChannel(code);
}

export function updateMachine(id, body, user) {
  requireRole(user, ['admin']);
  const m = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
  if (!m) throw bad('UNKNOWN_MACHINE', 'Unknown machine');
  const name = body.name != null ? requireText(body.name, 'Name', 80) : m.name;
  const tokenPrefix = body.tokenPrefix != null ? requireText(body.tokenPrefix, 'Token prefix', 6) : m.token_prefix;
  const openTime = body.openTime != null ? requireText(body.openTime, 'Open time', 5) : m.open_time;
  const closeTime = body.closeTime != null ? requireText(body.closeTime, 'Close time', 5) : m.close_time;
  const active = body.active == null ? m.active : (body.active ? 1 : 0);
  db.prepare('UPDATE machines SET name=?, token_prefix=?, open_time=?, close_time=?, active=? WHERE id=?')
    .run(name, tokenPrefix, openTime, closeTime, active, id);
  audit({ action: 'MACHINE_UPDATED', actor: user, resource: m.code, details: { active } });
  return db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
}

export function updateQueueRules(body, user) {
  requireRole(user, ['admin']);
  const cur = getQueueRules();
  const priorityOrder = Array.isArray(body.priorityOrder) ? body.priorityOrder.map(String) : cur.priorityOrder;
  const noShowMinutes = body.noShowMinutes != null ? Number(body.noShowMinutes) : cur.noShowMinutes;
  if (!Number.isInteger(noShowMinutes) || noShowMinutes < 5 || noShowMinutes > 240) throw bad('FIELD_INVALID', 'No-show minutes must be 5–240');
  const holdReasons = Array.isArray(body.holdReasons) ? body.holdReasons.map(String) : cur.holdReasons;
  db.prepare('UPDATE queue_rules SET priority_order_json=?, no_show_minutes=?, hold_reasons_json=?, updated_at=? WHERE id=?')
    .run(JSON.stringify(priorityOrder), noShowMinutes, JSON.stringify(holdReasons), now(), 'qr_default');
  audit({ action: 'QUEUE_RULES_UPDATED', actor: user, resource: 'qr_default' });
  return getQueueRules();
}

/** Pick the least-loaded active machine for a modality. */
export function pickMachine(modality) {
  const machines = listMachines({ modality, activeOnly: true });
  if (!machines.length) return null;
  let best = null; let bestLoad = Infinity;
  for (const m of machines) {
    const load = db.prepare(`SELECT COUNT(*) c FROM orders WHERE machine_id = ? AND status IN (${OPEN_QUEUE.map(() => '?').join(',')})`).get(m.id, ...OPEN_QUEUE).c;
    if (load < bestLoad) { best = m; bestLoad = load; }
  }
  return best;
}

function dayKey(d = new Date(nowMs())) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Mint the next token for a machine (or channel prefix fallback). */
export function nextToken(machine, channel) {
  const prefix = (machine?.token_prefix || channel.token_prefix || 'T').toUpperCase();
  const key = `${prefix}-${dayKey()}`;
  const like = `${prefix}-%`;
  // Count today's tokens for this prefix (token_no shape: X-001, M-014).
  const n = db.prepare("SELECT COUNT(*) c FROM orders WHERE token_no LIKE ? AND date(created_at) = date(?)").get(like, new Date(nowMs()).toISOString()).c + 1;
  return { token: `${prefix}-${String(n).padStart(3, '0')}`, key };
}

/** ETA = now + (people ahead on this machine × their est_minutes), priority-aware. */
export function estimateEta(machineId, examMinutes, channelCode) {
  const rules = getQueueRules();
  const ahead = db.prepare(`SELECT o.id, o.channel_code, o.priority, x.est_minutes
    FROM orders o JOIN exam_catalog x ON x.code = o.exam_code
    WHERE o.machine_id = ? AND o.status IN ('REQUESTED','ACKNOWLEDGED','SCHEDULED','ARRIVED','PREPARED','IN_PROGRESS')
    ORDER BY o.created_at`).all(machineId);
  const rank = (code) => { const i = rules.priorityOrder.indexOf(code); return i < 0 ? 99 : i; };
  const myRank = rank(channelCode);
  let wait = 0;
  for (const o of ahead) {
    if (rank(o.channel_code) < myRank) wait += o.est_minutes || 15;
    else if (rank(o.channel_code) === myRank && o.priority === 'STAT') wait += o.est_minutes || 15;
  }
  // Also count in-progress remaining as half of est for a soft estimate.
  wait += Math.round((examMinutes || 15) / 2);
  return new Date(nowMs() + wait * 60_000).toISOString();
}

export function paymentStatusForChannel(channel, { paidAtOpd = false, paymentRef = null } = {}) {
  if (channel.payment_place === 'NONE') return { paymentStatus: 'NOT_REQUIRED', paymentRef: null };
  if (channel.payment_place === 'IPD_CREDIT') return { paymentStatus: 'IPD_CREDIT', paymentRef: null };
  if (channel.payment_place === 'OPD') {
    return { paymentStatus: paidAtOpd || paymentRef ? 'PAID_OPD' : 'UNPAID', paymentRef: paymentRef || null };
  }
  // RADIOLOGY
  return { paymentStatus: 'UNPAID', paymentRef: null };
}

export function isPaymentCleared(order) {
  return ['PAID_OPD', 'PAID_RADIOLOGY', 'IPD_CREDIT', 'WAIVED', 'NOT_REQUIRED'].includes(order.payment_status);
}

export function assertPaymentForScan(order) {
  if (!order.channel_code) return;
  const ch = getChannel(order.channel_code);
  if (!ch || !ch.payment_gate) return;
  if (!isPaymentCleared(order)) throw conflict('PAYMENT_REQUIRED', 'Collect payment at radiology before this patient can be scanned');
}

/**
 * After an order row exists in REQUESTED, assign machine + token and optionally auto-advance
 * to SCHEDULED. Called inside or just after createOrder's transaction.
 */
export function applyTraffic(orderId, { channel, user, skipAuto = false } = {}) {
  const order = db.prepare(`SELECT o.*, x.modality, x.est_minutes FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.id = ?`).get(orderId);
  if (!order) return null;
  const ch = channel || (order.channel_code ? getChannel(order.channel_code) : null);
  if (!ch) return null;

  const machine = order.machine_id ? db.prepare('SELECT * FROM machines WHERE id = ?').get(order.machine_id) : pickMachine(order.modality);
  const { token } = nextToken(machine, ch);
  const eta = machine ? estimateEta(machine.id, order.est_minutes, ch.code) : new Date(nowMs() + (order.est_minutes || 15) * 60_000).toISOString();

  db.prepare(`UPDATE orders SET machine_id = COALESCE(?, machine_id), token_no = ?, eta_at = ?, channel_code = COALESCE(channel_code, ?),
    payment_place = COALESCE(payment_place, ?), report_handover = COALESCE(report_handover, ?), updated_at = ? WHERE id = ?`)
    .run(machine?.id || null, token, eta, ch.code, ch.payment_place, ch.report_handover, now(), orderId);

  if (!skipAuto && ch.auto_queue && order.status === 'REQUESTED') {
    // Auto ACK + SCHEDULE without going through transition() permission groups — recorded as system traffic.
    const t = now();
    db.prepare(`UPDATE orders SET status = 'SCHEDULED', scheduled_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`)
      .run(eta, t, orderId);
    db.prepare('INSERT INTO order_events (id, order_id, from_status, to_status, actor_id, actor_name, note, at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid('evt'), orderId, 'REQUESTED', 'ACKNOWLEDGED', user.id, user.fullName, `Auto queue · channel ${ch.code}`, t);
    db.prepare('INSERT INTO order_events (id, order_id, from_status, to_status, actor_id, actor_name, note, at) VALUES (?,?,?,?,?,?,?,?)')
      .run(uid('evt'), orderId, 'ACKNOWLEDGED', 'SCHEDULED', user.id, user.fullName, `Token ${token} · ETA ${new Date(eta).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`, t);
    audit({ action: 'ORDER_AUTO_QUEUED', actor: user, patientId: order.patient_id, resource: order.accession, details: { token, machine: machine?.code, channel: ch.code, eta } });
  }
  return { token, eta, machineId: machine?.id || null };
}

export function markOrderPayment(orderId, body, user) {
  requireRole(user, ['reception', 'admin']);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('NOT_FOUND', 'Order not found');
  const status = oneOf(body.paymentStatus, PAYMENT_STATUSES, 'paymentStatus');
  const ref = optionalText(body.paymentRef, 80) || null;
  if (status === 'PAID_OPD' && !ref) throw bad('RECEIPT_REQUIRED', 'Enter the OPD receipt / bill reference');
  tx(db, () => {
    db.prepare('UPDATE orders SET payment_status = ?, payment_ref = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
      .run(status, ref, now(), orderId);
    audit({ action: 'ORDER_PAYMENT_MARKED', actor: user, patientId: order.patient_id, resource: order.accession, details: { status, ref } });
  });
  return db.prepare('SELECT id, accession, payment_status, payment_ref, payment_place, token_no, eta_at, channel_code FROM orders WHERE id = ?').get(orderId);
}

export function holdOrder(orderId, body, user) {
  requireRole(user, ['reception', 'technologist', 'radiologist', 'admin']);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('NOT_FOUND', 'Order not found');
  const reason = requireText(body.reason, 'Hold reason', 200);
  const rules = getQueueRules();
  if (rules.holdReasons.length && !rules.holdReasons.includes(reason) && reason !== 'Other') {
    // allow free text when "Other" patterns; still accept any reason for flexibility
  }
  db.prepare('UPDATE orders SET hold_reason = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(reason, now(), orderId);
  audit({ action: 'ORDER_HELD', actor: user, patientId: order.patient_id, resource: order.accession, details: { reason } });
  return db.prepare('SELECT id, hold_reason, token_no, status FROM orders WHERE id = ?').get(orderId);
}

export function clearHold(orderId, user) {
  requireRole(user, ['reception', 'technologist', 'radiologist', 'admin']);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) throw bad('NOT_FOUND', 'Order not found');
  db.prepare('UPDATE orders SET hold_reason = NULL, revision = revision + 1, updated_at = ? WHERE id = ?').run(now(), orderId);
  audit({ action: 'ORDER_HOLD_CLEARED', actor: user, patientId: order.patient_id, resource: order.accession });
  return db.prepare('SELECT id, hold_reason, token_no, status FROM orders WHERE id = ?').get(orderId);
}

/**
 * Put a patient back into the live token queue with a fresh ETA.
 * Never accepts a staff-picked clock time — load is dynamic.
 */
export function requeueOrder(orderId, user) {
  requireRole(user, ['reception', 'technologist', 'radiologist', 'admin']);
  const order = db.prepare(`SELECT o.*, x.modality, x.est_minutes, x.name exam_name FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.id = ?`).get(orderId);
  if (!order) throw bad('NOT_FOUND', 'Order not found');
  if (!['REQUESTED', 'ACKNOWLEDGED', 'NO_SHOW', 'SCHEDULED'].includes(order.status)) {
    throw conflict('INVALID_TRANSITION', `Cannot re-queue from ${order.status}`);
  }
  const ch = order.channel_code ? getChannel(order.channel_code) : resolveChannelForEncounter(order.source);
  if (!ch) throw bad('UNKNOWN_CHANNEL', 'Order has no channel');
  const from = order.status;
  tx(db, () => {
    // Clear hold and force a new token/ETA assignment.
    db.prepare('UPDATE orders SET hold_reason = NULL, status = ?, updated_at = ? WHERE id = ?').run('REQUESTED', now(), orderId);
    applyTraffic(orderId, { channel: ch, user });
    if (from !== 'REQUESTED') {
      // applyTraffic already logged REQUESTED→ACK→SCHEDULED when status was REQUESTED; if we came from NO_SHOW etc.,
      // applyTraffic saw REQUESTED after the update above, so events are correct.
    }
    audit({ action: 'ORDER_REQUEUED', actor: user, patientId: order.patient_id, resource: order.accession, details: { from, channel: ch.code } });
  });
  return db.prepare(`SELECT o.id, o.accession, o.status, o.token_no, o.eta_at, o.scheduled_at, o.revision, o.hold_reason,
    m.code machine_code FROM orders o LEFT JOIN machines m ON m.id = o.machine_id WHERE o.id = ?`).get(orderId);
}

/** Reception live table: today's open orders with token / channel / payment / ETA. */
export function receptionBoard(user, q = {}) {
  requireRole(user, ['reception', 'radiologist', 'technologist', 'admin', 'auditor']);
  const where = [`o.status NOT IN ('CANCELLED','COLLECTED')`, `date(o.created_at) >= date('now', '-1 day')`];
  const args = [];
  if (q.channel) { where.push('o.channel_code = ?'); args.push(q.channel); }
  if (q.modality) { where.push('x.modality = ?'); args.push(q.modality); }
  if (q.unpaid === '1') where.push("o.payment_status = 'UNPAID'");
  if (q.handover) { where.push('o.report_handover = ?'); args.push(q.handover); }
  if (q.open === '1') where.push(`o.status IN (${OPEN_QUEUE.map((s) => `'${s}'`).join(',')})`);
  const rows = db.prepare(`
    SELECT o.id, o.accession, o.status, o.priority, o.token_no, o.eta_at, o.scheduled_at, o.channel_code, o.payment_status, o.payment_place, o.payment_ref,
      o.report_handover, o.hold_reason, o.revision, o.created_at, o.updated_at, o.patient_id, o.exam_code, o.registration_id,
      o.base_price, o.discount_pct, o.discount_amount, o.final_amount, o.no_charge, o.side,
      p.name patient_name, p.mrn, p.dob, p.sex, p.allergy, p.phone, x.name exam_name, x.modality,
      e.type encounter_type, e.ward, e.bed, e.room, e.ref_no encounter_ref, e.doctor_id,
      du.full_name consultant_name, ch.name channel_name, m.code machine_code, m.name machine_name,
      rg.reg_no registration_no
    FROM orders o
    JOIN patients p ON p.id = o.patient_id
    JOIN exam_catalog x ON x.code = o.exam_code
    JOIN encounters e ON e.id = o.encounter_id
    LEFT JOIN users du ON du.id = e.doctor_id
    LEFT JOIN channels ch ON ch.code = o.channel_code
    LEFT JOIN machines m ON m.id = o.machine_id
    LEFT JOIN registrations rg ON rg.id = o.registration_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN o.hold_reason IS NOT NULL THEN 1 ELSE 0 END,
      CASE o.priority WHEN 'STAT' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END,
      COALESCE(o.eta_at, o.scheduled_at, o.created_at)
    LIMIT 500`).all(...args);
  const nowIso = Date.now();
  return rows.map((r) => ({
    ...r,
    is_new: nowIso - Date.parse(r.created_at) < 5 * 60_000, // first 5 minutes on the board
    pay_at_counter: r.payment_place === 'RADIOLOGY' && r.payment_status === 'UNPAID' && !r.no_charge
  }));
}

export function resolveChannelForEncounter(encounterType, explicitCode) {
  if (explicitCode) {
    const ch = getChannel(explicitCode);
    if (!ch || !ch.active) throw bad('UNKNOWN_CHANNEL', 'Unknown or inactive channel');
    return ch;
  }
  // Sensible defaults when caller does not name a channel.
  const map = { OPD: 'OPD_CONSULTANT', IPD: 'IPD', OT: 'IPD', EXTERNAL: 'WALKIN' };
  return getChannel(map[encounterType] || 'WALKIN');
}

export { PAYMENT_STATUSES, getExam };
