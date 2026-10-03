// Safe retry for POST requests. A client sends `Idempotency-Key: <unique string>` and may repeat the request after a timeout or lost response:
// the original response is returned and nothing is created twice. The same key with a different request is refused (409).
// The handler and the stored response commit in ONE transaction, so there is no state in which the work was done but the key was not recorded.
// Failed requests store nothing (the transaction rolls back), so a corrected request can reuse the key.
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError, bad, conflict, now, nowMs, tx } from './util.js';

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
export function validKey(key) {
  if (!KEY.test(key)) throw bad('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8 to 128 characters: letters, digits and . _ : -');
  return key;
}

const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const fingerprint = (method, path, body) => createHash('sha256').update(`${method} ${path}\n${stable(body)}`).digest('hex');

/** Runs the synchronous `handler` once per (user, key). Returns { status, body, replay }. */
export function runIdempotent({ userId, key, method, path, body }, handler) {
  const hash = fingerprint(method, path, body);
  return tx(db, () => {
    db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(nowMs() - config.idempotencyTtlHours * 3600_000).toISOString());
    const seen = db.prepare('SELECT * FROM idempotency_keys WHERE user_id = ? AND key = ?').get(userId, key);
    if (seen) {
      if (seen.request_hash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      return { status: seen.status, body: JSON.parse(seen.response_json), replay: true };
    }
    const out = handler();
    if (out && typeof out.then === 'function') throw new HttpError(500, 'INTERNAL', 'Idempotency needs a synchronous handler');
    const json = JSON.stringify(out ?? null);
    db.prepare('INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, status, response_json, created_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(userId, key, method, path, hash, 200, json, now(), now());
    return { status: 200, body: JSON.parse(json), replay: false };
  });
}
