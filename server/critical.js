import { db } from './db.js';
import { audit } from './audit.js';
import { WARD_ROLES, requireRole } from './auth.js';
import { bad, conflict, notFound, now, nowMs, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { config } from './config.js';
import { getOrderForUser } from './orders.js';
import { notify, usersWithRoles } from './notifications.js';

// Minutes allowed before an open critical result escalates: config.criticalMinutes (PROVISIONAL, RIS_CRITICAL_MINUTES).

export function createCriticalCase(order, report, summary, receiverId, user) {
  const id = uid('crt'); const t = now();
  const receiver = receiverId || order.requested_by;
  db.prepare('INSERT INTO critical_cases (id, order_id, report_id, summary, receiver_id, state, due_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, order.id, report?.id || null, requireText(summary, 'Critical summary', 1000), receiver, 'OPEN', new Date(nowMs() + config.criticalMinutes * 60_000).toISOString(), user.id, t);
  db.prepare('INSERT INTO critical_events (id, case_id, state, note, actor_id, actor_name, at) VALUES (?,?,?,?,?,?,?)').run(uid('cev'), id, 'OPEN', summary, user.id, user.fullName, t);
  audit({ action: 'CRITICAL_OPENED', actor: user, patientId: order.patient_id, resource: order.accession, details: { summary } });
  notify([receiver, order.encounter_doctor_id], { orderId: order.id, kind: 'CRITICAL', text: `CRITICAL result for ${order.patient_name}: ${summary}` });
  return id;
}

// Open cases past their deadline are escalated to radiology leadership (lazy sweep, called on read).
export function sweepCritical() {
  const late = db.prepare("SELECT c.*, o.accession, o.patient_id FROM critical_cases c JOIN orders o ON o.id = c.order_id WHERE c.state = 'OPEN' AND c.due_at < ?").all(now());
  for (const c of late) {
    tx(db, () => {
      db.prepare("UPDATE critical_cases SET state = 'ESCALATED' WHERE id = ?").run(c.id);
      db.prepare('INSERT INTO critical_events (id, case_id, state, note, actor_id, actor_name, at) VALUES (?,?,?,?,?,?,?)').run(uid('cev'), c.id, 'ESCALATED', `Not communicated within ${config.criticalMinutes} minutes`, 'system', 'System', now());
      audit({ action: 'CRITICAL_ESCALATED', actor: null, patientId: c.patient_id, resource: c.accession });
    });
    notify(usersWithRoles(['radiologist', 'admin']), { orderId: c.order_id, kind: 'CRITICAL_ESCALATED', text: `ESCALATED: critical result not communicated (${c.summary})` });
  }
}

export function listCritical(user, state) {
  sweepCritical();
  const rows = db.prepare(`SELECT c.*, o.accession, p.name patient_name, p.mrn, x.name exam_name, e.ward FROM critical_cases c
    JOIN orders o ON o.id = c.order_id JOIN patients p ON p.id = o.patient_id JOIN exam_catalog x ON x.code = o.exam_code
    JOIN encounters e ON e.id = o.encounter_id ${state ? 'WHERE c.state = ?' : ''} ORDER BY c.created_at DESC LIMIT 200`).all(...(state ? [state] : []));
  return rows.filter((r) => { try { getOrderForUser(r.order_id, user); return true; } catch { return false; } });
}

export function criticalForOrder(orderId) {
  const cases = db.prepare('SELECT * FROM critical_cases WHERE order_id = ? ORDER BY created_at').all(orderId);
  return cases.map((c) => ({ ...c, events: db.prepare('SELECT * FROM critical_events WHERE case_id = ? ORDER BY at, rowid').all(c.id) }));
}

const getCase = (id) => db.prepare('SELECT * FROM critical_cases WHERE id = ?').get(id) || (() => { throw notFound('Critical case'); })();

export function communicate(caseId, body, user) {
  requireRole(user, ['radiologist']);
  const c = getCase(caseId);
  if (!['OPEN', 'ESCALATED'].includes(c.state)) throw conflict('INVALID_STATE', `Case is already ${c.state}`);
  if (body.readBack !== true) throw bad('READ_BACK_REQUIRED', 'The receiver must read back the result');
  const receiverName = requireText(body.receiverName, 'receiverName', 200);
  const channel = oneOf(body.channel, ['PHONE', 'IN_PERSON', 'PAGER'], 'channel');
  const order = getOrderForUser(c.order_id, user);
  const note = optionalText(body.note, 1000);
  tx(db, () => {
    db.prepare("UPDATE critical_cases SET state = 'COMMUNICATED' WHERE id = ?").run(caseId);
    db.prepare('INSERT INTO critical_events (id, case_id, state, receiver_name, channel, read_back, note, actor_id, actor_name, at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(uid('cev'), caseId, 'COMMUNICATED', receiverName, channel, 1, note, user.id, user.fullName, now());
    audit({ action: 'CRITICAL_COMMUNICATED', actor: user, patientId: order.patient_id, resource: order.accession, details: { receiverName, channel } });
  });
  return criticalForOrder(c.order_id);
}

export function acknowledge(caseId, body, user) {
  requireRole(user, WARD_ROLES);
  const c = getCase(caseId);
  getOrderForUser(c.order_id, user); // must be able to see the order
  if (c.state === 'ACKNOWLEDGED') throw conflict('INVALID_STATE', 'Already acknowledged');
  const actionPlan = requireText(body.actionPlan, 'actionPlan', 1000);
  const order = getOrderForUser(c.order_id, user);
  tx(db, () => {
    db.prepare("UPDATE critical_cases SET state = 'ACKNOWLEDGED' WHERE id = ?").run(caseId);
    db.prepare('INSERT INTO critical_events (id, case_id, state, note, actor_id, actor_name, at) VALUES (?,?,?,?,?,?,?)')
      .run(uid('cev'), caseId, 'ACKNOWLEDGED', actionPlan, user.id, user.fullName, now());
    audit({ action: 'CRITICAL_ACKNOWLEDGED', actor: user, patientId: order.patient_id, resource: order.accession });
  });
  notify(usersWithRoles(['radiologist']), { orderId: c.order_id, kind: 'CRITICAL_ACK', text: `${user.fullName} acknowledged critical result for ${order.patient_name}` });
  return criticalForOrder(c.order_id);
}
