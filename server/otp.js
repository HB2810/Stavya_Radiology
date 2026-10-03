// One-time codes for patient registration and password reset. Codes are hashed, expire, and are checked ON THE SERVER
// (the agency app compared the OTP in the browser, which exposed it to the client).
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';
import { audit } from './audit.js';
import { HttpError, bad, now, tx, uid } from './util.js';
import { config } from './config.js';

const TTL_MS = 10 * 60_000; const MAX_ATTEMPTS = 5; const RESEND_MS = 30_000; const VERIFIED_VALID_MS = 30 * 60_000;
const hashCode = (code, salt) => createHash('sha256').update(`${salt}:${code}`).digest('hex');

export const otpConfig = () => ({ dev: config.devOtp, webhook: Boolean(config.otpWebhook) });
export const deliveryConfigured = () => { const c = otpConfig(); return c.dev || c.webhook; };

export function normalisePhone(v) {
  const d = String(v || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d;
  if (!/^[6-9]\d{9}$/.test(ten)) throw bad('PHONE_INVALID', 'Enter a valid 10-digit mobile number');
  return ten;
}
export function normaliseEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) || e.length > 200) throw bad('EMAIL_INVALID', 'Enter a valid email address');
  return e;
}
const normalise = (channel, target) => (channel === 'phone' ? normalisePhone(target) : channel === 'email' ? normaliseEmail(target) : (() => { throw bad('CHANNEL_INVALID', 'Channel must be phone or email'); })());

async function deliver(channel, target, code) {
  const c = otpConfig();
  if (c.webhook) {
    const r = await fetch(config.otpWebhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, target, message: `Your Stavya verification code is ${code}. It expires in 10 minutes.` }) });
    if (!r.ok) throw new HttpError(502, 'OTP_DELIVERY_FAILED', 'Could not send the code. Try again.');
    return;
  }
  if (c.dev) { console.log(`[OTP dev] ${channel} ${target}: ${code}`); return; }
  throw new HttpError(503, 'OTP_DELIVERY_NOT_CONFIGURED', 'Code delivery is not configured. Set RIS_OTP_WEBHOOK (or RIS_DEV_OTP=1 for local demos).');
}

export async function sendOtp({ purpose, channel, target }, actor = null) {
  const t = normalise(channel, target);
  const recent = db.prepare('SELECT created_at FROM otp_challenges WHERE purpose = ? AND target = ? ORDER BY created_at DESC LIMIT 1').get(purpose, t);
  if (recent && Date.now() - Date.parse(recent.created_at) < RESEND_MS) throw new HttpError(429, 'OTP_TOO_SOON', 'Please wait 30 seconds before asking for another code');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0'); const salt = randomBytes(8).toString('hex'); const id = uid('otp');
  await deliver(channel, t, code); // deliver first: do not store a code that was never sent
  tx(db, () => {
    db.prepare('INSERT INTO otp_challenges (id, purpose, channel, target, code_hash, salt, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, purpose, channel, t, hashCode(code, salt), salt, new Date(Date.now() + TTL_MS).toISOString(), now());
    audit({ action: 'OTP_SENT', actor: actor || { id: 'anonymous', role: 'anonymous' }, resource: `${channel}:${t.slice(0, 2)}***${t.slice(-2)}`, details: { purpose } });
  });
  return { challengeId: id, expiresInSeconds: TTL_MS / 1000, ...(otpConfig().dev ? { devCode: code } : {}) };
}

export function verifyOtp({ challengeId, code, purpose }) {
  const row = db.prepare('SELECT * FROM otp_challenges WHERE id = ? AND purpose = ?').get(String(challengeId || ''), purpose);
  if (!row) throw bad('OTP_INVALID', 'That code is not valid');
  if (row.verified_at) return { verified: true };
  if (Date.parse(row.expires_at) < Date.now()) throw new HttpError(410, 'OTP_EXPIRED', 'The code has expired. Ask for a new one.');
  if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'OTP_LOCKED', 'Too many wrong attempts. Ask for a new code.');
  const ok = timingSafeEqual(Buffer.from(hashCode(String(code || ''), row.salt), 'hex'), Buffer.from(row.code_hash, 'hex'));
  if (!ok) { db.prepare('UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = ?').run(row.id); throw bad('OTP_INVALID', 'That code is not correct'); }
  db.prepare('UPDATE otp_challenges SET verified_at = ? WHERE id = ?').run(now(), row.id);
  return { verified: true, channel: row.channel };
}

// True when this challenge was verified recently for exactly this target; consumes it so it cannot be reused.
export function consumeVerified({ challengeId, purpose, channel, target }) {
  const row = db.prepare('SELECT * FROM otp_challenges WHERE id = ? AND purpose = ?').get(String(challengeId || ''), purpose);
  if (!row || !row.verified_at || row.consumed_at || row.channel !== channel) return false;
  if (row.target !== normalise(channel, target)) return false;
  if (Date.now() - Date.parse(row.verified_at) > VERIFIED_VALID_MS) return false;
  db.prepare('UPDATE otp_challenges SET consumed_at = ? WHERE id = ?').run(now(), row.id);
  return true;
}
