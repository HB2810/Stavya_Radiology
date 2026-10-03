import { db } from './db.js';
import { audit } from './audit.js';
import { forbidden, now, requireText, tx, uid } from './util.js';
import { getOrderForUser } from './orders.js';
import { notify, usersWithRoles } from './notifications.js';
import { RADIOLOGY_STAFF } from './auth.js';

export function listMessages(orderId, user) {
  getOrderForUser(orderId, user);
  return db.prepare('SELECT * FROM messages WHERE order_id = ? ORDER BY created_at, rowid').all(orderId);
}

// Order-linked conversation between requesting ward/OPD clinicians and radiology staff.
export function postMessage(orderId, body, user) {
  if (user.role === 'auditor') throw forbidden('Auditors have read-only access');
  const order = getOrderForUser(orderId, user);
  const text = requireText(body.body, 'Message', 2000);
  const id = uid('msg');
  tx(db, () => {
    db.prepare('INSERT INTO messages (id, order_id, sender_id, sender_name, sender_role, body, created_at) VALUES (?,?,?,?,?,?,?)').run(id, orderId, user.id, user.fullName, user.role, text, now());
    audit({ action: 'MESSAGE_POSTED', actor: user, patientId: order.patient_id, resource: order.accession });
  });
  const toRadiology = !RADIOLOGY_STAFF.includes(user.role);
  const recipients = toRadiology ? [order.radiologist_id, order.technologist_id, ...(order.radiologist_id || order.technologist_id ? [] : usersWithRoles(['radiologist', 'reception']))] : [order.requested_by, order.encounter_doctor_id];
  notify(recipients.filter((r) => r && r !== user.id), { orderId, kind: 'MESSAGE', text: `${user.fullName} on ${order.patient_name}: ${text.slice(0, 120)}` });
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}
