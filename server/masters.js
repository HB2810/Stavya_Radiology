// Admin masters: the service catalog (exam_catalog, "service" = exam/test, "service type" = modality/sub-group) and
// discount schemes. Every write is admin-only and audited (HARD RULE: every state change is audited).
import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, notFound, now, oneOf, optionalText, requireText, tx } from './util.js';
import { makeExamCode } from './catalog.js';

const ADMIN = ['admin'];
// Same rounding convention as billing.js's money(): round to paisa, reject negative/non-finite. null means "no price set".
function priceOrNull(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v) * 100) / 100;
  if (!Number.isFinite(n) || n < 0) throw bad('AMOUNT_INVALID', `${field} is not a valid amount`);
  return n;
}

/* ---- Services (exam_catalog) ---- */
export function listServices(query, user) {
  requireRole(user, ADMIN);
  const where = []; const args = [];
  if (query.modality) { where.push('modality = ?'); args.push(String(query.modality).toUpperCase()); }
  if (query.subGroup) { where.push('sub_group = ?'); args.push(query.subGroup); }
  if (query.active === '1' || query.active === '0') { where.push('active = ?'); args.push(Number(query.active)); }
  const sql = `SELECT * FROM exam_catalog ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY modality, sub_group, name`;
  return db.prepare(sql).all(...args);
}

function readServiceFields(body, { requireName = false } = {}) {
  const out = {};
  if (requireName || body.name !== undefined) out.name = requireText(body.name, 'Name', 200);
  if (body.subGroup !== undefined) out.sub_group = optionalText(body.subGroup, 100) || null;
  if (body.bodyPart !== undefined) out.body_part = requireText(body.bodyPart, 'Body part', 100);
  if (body.price !== undefined) out.price = priceOrNull(body.price, 'Price (cash)');
  if (body.onlinePrice !== undefined) out.online_price = priceOrNull(body.onlinePrice, 'Online price');
  if (body.priceNote !== undefined) out.price_note = optionalText(body.priceNote, 500) || null;
  if (body.estMinutes !== undefined) { const n = Number(body.estMinutes); if (!Number.isInteger(n) || n <= 0 || n > 600) throw bad('FIELD_INVALID', 'Estimated minutes must be a whole number between 1 and 600'); out.est_minutes = n; }
  if (body.prep !== undefined) out.prep = optionalText(body.prep, 500);
  if (body.keywords !== undefined) out.keywords = optionalText(body.keywords, 500);
  if (body.usesContrast !== undefined) out.uses_contrast = body.usesContrast ? 1 : 0;
  if (body.ionising !== undefined) out.ionising = body.ionising ? 1 : 0;
  if (body.mri !== undefined) out.mri = body.mri ? 1 : 0;
  return out;
}

export function createService(body, user) {
  requireRole(user, ADMIN);
  const modality = requireText(body.modality, 'Modality', 20).toUpperCase();
  const fields = readServiceFields(body, { requireName: true });
  let code = optionalText(body.code, 60).toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9-]*$/.test(code)) throw bad('CODE_INVALID', 'Code may contain only letters, digits and hyphens');
  if (code && db.prepare('SELECT 1 FROM exam_catalog WHERE code = ?').get(code)) throw conflict('CODE_IN_USE', 'That service code is already used');
  if (!code) code = makeExamCode(modality, fields.name, new Set(db.prepare('SELECT code FROM exam_catalog').all().map((r) => r.code)));
  const t = now();
  const row = {
    code, name: fields.name, modality, body_part: fields.body_part || fields.sub_group || 'GENERAL', est_minutes: fields.est_minutes ?? 15,
    prep: fields.prep ?? '', uses_contrast: fields.uses_contrast ?? 0, ionising: fields.ionising ?? 0, mri: fields.mri ?? 0, keywords: fields.keywords ?? '',
    price: fields.price ?? null, sub_group: fields.sub_group ?? null, online_price: fields.online_price ?? null, source: 'ADMIN', active: 1,
    price_note: fields.price_note ?? null, updated_at: t, updated_by: user.id
  };
  tx(db, () => {
    db.prepare(`INSERT INTO exam_catalog (code, name, modality, body_part, est_minutes, prep, uses_contrast, ionising, mri, keywords, price, sub_group, online_price, source, active, price_note, updated_at, updated_by)
      VALUES (@code,@name,@modality,@body_part,@est_minutes,@prep,@uses_contrast,@ionising,@mri,@keywords,@price,@sub_group,@online_price,@source,@active,@price_note,@updated_at,@updated_by)`).run(row);
    audit({ action: 'SERVICE_CREATED', actor: user, resource: code, details: { modality, name: row.name, price: row.price } });
  });
  return db.prepare('SELECT * FROM exam_catalog WHERE code = ?').get(code);
}

export function updateService(code, body, user) {
  requireRole(user, ADMIN);
  const existing = db.prepare('SELECT * FROM exam_catalog WHERE code = ?').get(code);
  if (!existing) throw notFound('Service');
  // Modality is locked on edit (a service that changes modality is really a different service; create a new one instead).
  if (body.modality !== undefined && String(body.modality).toUpperCase() !== existing.modality) throw bad('MODALITY_LOCKED', 'Modality cannot be changed once a service exists; deactivate it and create a new service instead');
  const fields = readServiceFields(body);
  if (!Object.keys(fields).length) throw bad('NOTHING_TO_UPDATE', 'No editable field was given');
  const t = now();
  tx(db, () => {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE exam_catalog SET ${sets}, updated_at = ?, updated_by = ? WHERE code = ?`).run(...Object.values(fields), t, user.id, code);
    audit({ action: 'SERVICE_UPDATED', actor: user, resource: code, details: fields });
  });
  return db.prepare('SELECT * FROM exam_catalog WHERE code = ?').get(code);
}

function setServiceActive(code, active, user) {
  requireRole(user, ADMIN);
  const existing = db.prepare('SELECT * FROM exam_catalog WHERE code = ?').get(code);
  if (!existing) throw notFound('Service');
  const t = now();
  tx(db, () => {
    db.prepare('UPDATE exam_catalog SET active = ?, updated_at = ?, updated_by = ? WHERE code = ?').run(active ? 1 : 0, t, user.id, code);
    audit({ action: active ? 'SERVICE_ACTIVATED' : 'SERVICE_DEACTIVATED', actor: user, resource: code });
  });
  return db.prepare('SELECT * FROM exam_catalog WHERE code = ?').get(code);
}
export const activateService = (code, user) => setServiceActive(code, true, user);
export const deactivateService = (code, user) => setServiceActive(code, false, user);

/* ---- Discount schemes ---- */
const KINDS = ['PERCENT'];
// Read access is wider than write: reception picks a scheme at registration/invoice time, so they can list schemes
// too, but only the active ones -- an inactive scheme is an admin masters-screen concern, never offered at the counter.
export function listDiscountSchemes(query, user) {
  requireRole(user, [...ADMIN, 'reception']);
  const admin = user.role === 'admin';
  const where = []; const args = [];
  if (!admin) { where.push('active = 1'); }
  else if (query.active === '1' || query.active === '0') { where.push('active = ?'); args.push(Number(query.active)); }
  return db.prepare(`SELECT * FROM discount_schemes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY label`).all(...args);
}

export function createDiscountScheme(body, user) {
  requireRole(user, ADMIN);
  const id = requireText(body.code || body.id, 'Code', 40).toUpperCase().replace(/\s+/g, '_');
  if (!/^[A-Z0-9_]+$/.test(id)) throw bad('CODE_INVALID', 'Code may contain only letters, digits and underscores');
  if (db.prepare('SELECT 1 FROM discount_schemes WHERE id = ?').get(id)) throw conflict('CODE_IN_USE', 'That discount code is already used');
  const label = requireText(body.label, 'Label', 100);
  const kind = oneOf(body.kind || 'PERCENT', KINDS, 'kind');
  const value = Number(body.value);
  if (!Number.isFinite(value) || value <= 0 || value > 100) throw bad('VALUE_INVALID', 'Value must be a percentage between 0 and 100');
  const requiresReason = Boolean(body.requiresReason) || value >= 50; // matches the existing 50%+ waiver-reason rule (orders.js/registration.js)
  const requiresApproval = Boolean(body.requiresApproval);
  const t = now();
  tx(db, () => {
    db.prepare('INSERT INTO discount_schemes (id, label, kind, value, requires_reason, requires_approval, active, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,1,?,?,?,?)')
      .run(id, label, kind, value, requiresReason ? 1 : 0, requiresApproval ? 1 : 0, t, user.id, t, user.id);
    audit({ action: 'DISCOUNT_SCHEME_CREATED', actor: user, resource: id, details: { label, kind, value, requiresReason, requiresApproval } });
  });
  return db.prepare('SELECT * FROM discount_schemes WHERE id = ?').get(id);
}

export function updateDiscountScheme(id, body, user) {
  requireRole(user, ADMIN);
  const existing = db.prepare('SELECT * FROM discount_schemes WHERE id = ?').get(id);
  if (!existing) throw notFound('Discount scheme');
  const fields = {};
  if (body.label !== undefined) fields.label = requireText(body.label, 'Label', 100);
  if (body.kind !== undefined) fields.kind = oneOf(body.kind, KINDS, 'kind');
  let value = existing.value;
  if (body.value !== undefined) { value = Number(body.value); if (!Number.isFinite(value) || value <= 0 || value > 100) throw bad('VALUE_INVALID', 'Value must be a percentage between 0 and 100'); fields.value = value; }
  if (body.requiresReason !== undefined) fields.requires_reason = body.requiresReason ? 1 : 0;
  else if (body.value !== undefined && value >= 50) fields.requires_reason = 1; // a discount of 50%+ always requires a reason
  if (body.requiresApproval !== undefined) fields.requires_approval = body.requiresApproval ? 1 : 0;
  if (!Object.keys(fields).length) throw bad('NOTHING_TO_UPDATE', 'No editable field was given');
  const t = now();
  tx(db, () => {
    const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE discount_schemes SET ${sets}, updated_at = ?, updated_by = ? WHERE id = ?`).run(...Object.values(fields), t, user.id, id);
    audit({ action: 'DISCOUNT_SCHEME_UPDATED', actor: user, resource: id, details: fields });
  });
  return db.prepare('SELECT * FROM discount_schemes WHERE id = ?').get(id);
}

function setSchemeActive(id, active, user) {
  requireRole(user, ADMIN);
  const existing = db.prepare('SELECT * FROM discount_schemes WHERE id = ?').get(id);
  if (!existing) throw notFound('Discount scheme');
  const t = now();
  tx(db, () => {
    db.prepare('UPDATE discount_schemes SET active = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(active ? 1 : 0, t, user.id, id);
    audit({ action: active ? 'DISCOUNT_SCHEME_ACTIVATED' : 'DISCOUNT_SCHEME_DEACTIVATED', actor: user, resource: id });
  });
  return db.prepare('SELECT * FROM discount_schemes WHERE id = ?').get(id);
}
export const activateDiscountScheme = (id, user) => setSchemeActive(id, true, user);
export const deactivateDiscountScheme = (id, user) => setSchemeActive(id, false, user);
