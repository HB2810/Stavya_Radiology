import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
export const bad = (code, message) => new HttpError(400, code, message);
export const forbidden = (message = 'Your role is not allowed to do this') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Record') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, message) => new HttpError(409, code, message);

// Single source of time for writes. Real time by default; demo-data seeding sets a simulated clock to backdate history.
let fixedClock = null;
export const setClock = (ms) => { fixedClock = ms; };
export const nowMs = () => fixedClock ?? Date.now();
export const now = () => new Date(nowMs()).toISOString();
// Identifiers are a prefix plus a full RFC 4122 UUID. Rows written before this convention keep their older, shorter ids.
export const uid = (prefix) => `${prefix}_${randomUUID()}`;
// Escapes LIKE wildcards in user search text; use with ESCAPE '\\' in the query.
export const likeEsc = (s) => String(s ?? '').replace(/[\\%_]/g, (c) => '\\' + c);

export function requireText(value, field, max = 4000) {
  if (typeof value !== 'string' || !value.trim()) throw bad('FIELD_REQUIRED', `${field} is required`);
  if (value.length > max) throw bad('FIELD_TOO_LONG', `${field} is too long`);
  return value.trim();
}
export function optionalText(value, max = 4000) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) throw bad('FIELD_INVALID', 'Invalid text field');
  return value.trim();
}
export function oneOf(value, list, field) {
  if (!list.includes(value)) throw bad('FIELD_INVALID', `${field} must be one of ${list.join(', ')}`);
  return value;
}
// Transactions nest: the outermost call is BEGIN IMMEDIATE / COMMIT, inner calls are savepoints that roll back on their own.
// There is one connection and every callback is synchronous, so a plain counter tracks the depth.
let txDepth = 0;
export const inTx = () => txDepth > 0;
export function tx(db, fn) {
  if (txDepth > 0) {
    const sp = `sp${txDepth}`;
    db.exec(`SAVEPOINT ${sp}`); txDepth++;
    try { const out = fn(); db.exec(`RELEASE ${sp}`); return out; }
    catch (e) { db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`); throw e; }
    finally { txDepth--; }
  }
  db.exec('BEGIN IMMEDIATE'); txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* the transaction was already ended by SQLite */ }
    throw e;
  } finally { txDepth--; }
}

/** Runs a post-commit side effect (notification, analytics, ...). A failure is logged and never fails the caller's committed work. */
export function bestEffort(label, fn) {
  try { return fn(); } catch (e) { console.error(`[WARN] ${label} failed (the main action is unaffected):`, e); return undefined; }
}

/** A request body must be a JSON object, never null, an array or a scalar. */
export function requireObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad('BODY_NOT_OBJECT', 'The request body must be a JSON object');
  return v;
}

// Date filter used by the list screens: day | week (Mon-Sun) | month | custom (start_date, end_date), as in the agency app.
export function dateRange({ date_type: type, date, start_date: start, end_date: end } = {}) {
  const parse = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const base = parse(date) || new Date(new Date().setHours(0, 0, 0, 0));
  let a; let b;
  if (type === 'day') { a = base; b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1); }
  else if (type === 'week') { const dow = (base.getDay() + 6) % 7; a = new Date(base.getFullYear(), base.getMonth(), base.getDate() - dow); b = new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7); }
  else if (type === 'month') { a = new Date(base.getFullYear(), base.getMonth(), 1); b = new Date(base.getFullYear(), base.getMonth() + 1, 1); }
  else if (start || end) { a = parse(start) || new Date(0); const e = parse(end) || new Date(); b = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1); }
  else return null;
  return [a.toISOString(), b.toISOString()];
}
