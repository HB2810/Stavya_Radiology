import { db } from './db.js';
import { bestEffort, now, tx, uid } from './util.js';

// Notifications are advisory: a failure is logged and never fails (or rolls back) the action that triggered it.
export function notify(userIds, { orderId = null, kind, text }) {
  bestEffort(`notification ${kind}`, () => tx(db, () => {
    const ins = db.prepare('INSERT INTO notifications (id, user_id, order_id, kind, text, created_at) VALUES (?,?,?,?,?,?)');
    for (const id of new Set(userIds.filter(Boolean))) ins.run(uid('ntf'), id, orderId, kind, text, now());
  }));
}
export const usersWithRoles = (roles) => bestEffort('recipient lookup', () =>
  db.prepare(`SELECT id FROM users WHERE active = 1 AND role IN (${roles.map(() => '?').join(',')})`).all(...roles).map((r) => r.id)) || [];

export const listNotifications = (userId, unreadOnly = false) =>
  db.prepare(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC LIMIT 100`).all(userId);
export const markRead = (userId, id) =>
  db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?').run(now(), id, userId);
export const markAllRead = (userId) =>
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), userId);
