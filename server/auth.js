import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { audit } from './audit.js';
import { HttpError, bad, forbidden, now, tx, uid } from './util.js';
import { config } from './config.js';
import { normalisePhone, otpConfig, sendOtp, verifyOtp } from './otp.js';
import { enrichUser } from './modules.js';

export const ROLES = ['radiologist', 'technologist', 'assistant', 'reception', 'clinician', 'nurse', 'admin', 'auditor'];
export const RADIOLOGY_STAFF = ['radiologist', 'technologist', 'assistant', 'reception'];
export const WARD_ROLES = ['clinician', 'nurse'];
/** Assistant collects consent / basics; technologist runs modality + sub-services. */
export const TECH_LANE = ['technologist', 'assistant', 'radiologist'];

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: pbkdf2Sync(password, salt, 100000, 64, 'sha256').toString('hex') };
}
function verifyPassword(password, hash, salt) {
  const a = Buffer.from(hashPassword(password, salt).hash, 'hex');
  return timingSafeEqual(a, Buffer.from(hash, 'hex'));
}

export function createUser({ username, password, fullName, role, ward = null, phone = null, designation = null }) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role ${role}`);
  // RIS_DEMO_WEAK_PASSWORDS=1 allows short demo passwords on a local machine only; never set it in production.
  const weakOk = config.demoWeakPasswords;
  if (!password || (password.length < 10 && !weakOk)) throw new Error('Password must be at least 10 characters');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,30}$/.test(username)) throw new Error('Employee code must be 3-31 letters, digits, dot, dash or underscore');
  username = username.toUpperCase();
  const { hash, salt } = hashPassword(password);
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, username, password_hash, password_salt, full_name, role, ward, phone, designation, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, username, hash, salt, fullName, role, ward, phone, designation, now());
  return id;
}

const sessions = new Map();
const attempts = new Map(); // username -> { count, until }

export function login(username, password, ip = '') {
  username = String(username || '').trim().toUpperCase(); // employee codes are not case-sensitive
  const lock = attempts.get(username);
  if (lock && lock.until > Date.now()) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed attempts. Try again in a few minutes.');
  const row = db.prepare('SELECT * FROM users WHERE UPPER(username) = ? AND active = 1').get(username);
  if (!row || !verifyPassword(String(password || ''), row.password_hash, row.password_salt)) {
    const n = (lock?.count || 0) + 1;
    attempts.set(username, { count: n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
    audit({ action: 'LOGIN_FAILED', actor: { id: String(username), role: 'anonymous' }, outcome: 'DENIED', details: { ip } });
    throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid employee code or password');
  }
  attempts.delete(username);
  const token = 'ris_' + randomBytes(32).toString('hex');
  const base = { id: row.id, username: row.username, fullName: row.full_name, role: row.role, ward: row.ward, designation: row.designation, employeeCode: row.username };
  const user = enrichUser(base);
  sessions.set(token, { user: base, expires: Date.now() + config.sessionHours * 3600_000 });
  audit({ action: 'LOGIN', actor: base, details: { ip } });
  return { token, user };
}

export function getSession(token) {
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  // Re-resolve modules each request so admin permission changes apply without re-login.
  return enrichUser(s.user);
}
export function logout(token, user) {
  sessions.delete(token);
  audit({ action: 'LOGOUT', actor: user });
}
export function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw forbidden(`Role '${user.role}' cannot perform this action`);
}

// PKG-M6: read-only staff directory for the admin's Administration nav section. Never the password hash/salt.
export function listStaffRoster(user) {
  requireRole(user, ['admin']);
  return db.prepare('SELECT id, username, full_name, role, ward, designation, phone, active, created_at FROM users ORDER BY role, full_name').all();
}

// ---- Forgotten password: one-time code to the phone number on the account, then a new password ----
export async function forgotPassword(phone) {
  const p = normalisePhone(phone);
  const u = db.prepare('SELECT id FROM users WHERE phone = ? AND active = 1').get(p);
  if (!u) return { ok: true, challengeId: uid('otp') }; // same answer for unknown numbers, so accounts cannot be probed
  const r = await sendOtp({ purpose: 'RESET', channel: 'phone', target: p });
  return { ok: true, ...r };
}
export function resetPassword({ challengeId, code, newPassword }) {
  verifyOtp({ challengeId, code, purpose: 'RESET' });
  const weakOk = config.demoWeakPasswords;
  if (typeof newPassword !== 'string' || !newPassword || (newPassword.length < 10 && !weakOk)) throw bad('PASSWORD_TOO_SHORT', 'Password must be at least 10 characters');
  const ch = db.prepare('SELECT * FROM otp_challenges WHERE id = ? AND purpose = ?').get(challengeId, 'RESET');
  if (ch.consumed_at) throw bad('OTP_USED', 'This code was already used');
  const u = db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(ch.target);
  if (!u) throw bad('OTP_INVALID', 'That code is not valid');
  const { hash, salt } = hashPassword(newPassword);
  tx(db, () => {
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, u.id);
    db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').run(now(), ch.id);
    audit({ action: 'PASSWORD_RESET', actor: { id: u.id, fullName: u.full_name, role: u.role } });
  });
  for (const [t, sess] of sessions) if (sess.user.id === u.id) sessions.delete(t);
  attempts.delete(u.username);
  return { ok: true };
}
