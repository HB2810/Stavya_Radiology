import { db } from './db.js';
import { EXAMS, TEMPLATES, PRICES, PROOF_TYPES, REFERRALS, DESIGNATIONS, MEDICINES, DISEASES, SURGERY_TREE } from './reference-data.js';

export function seedCatalog() {
  // price is explicit (not left to the column default): exam_catalog.price is nullable now (an imported, unpriced
  // item is NULL, never a fabricated figure), so these hand-written placeholders must say 0 themselves.
  const ins = db.prepare('INSERT OR IGNORE INTO exam_catalog (code, name, modality, body_part, est_minutes, prep, uses_contrast, ionising, mri, keywords, price) VALUES (?,?,?,?,?,?,?,?,?,?,0)');
  for (const e of EXAMS) ins.run(...e);
  const t = db.prepare('INSERT OR IGNORE INTO report_templates VALUES (?,?,?,?,?,?,?)');
  for (const x of TEMPLATES) t.run(...x);
  const pr = db.prepare('UPDATE exam_catalog SET price = ? WHERE code = ? AND price = 0');
  for (const [code, price] of Object.entries(PRICES)) pr.run(price, code);
  for (const [id, n, side] of PROOF_TYPES) db.prepare('INSERT OR IGNORE INTO proof_types VALUES (?,?,?)').run(id, n, side);
  for (const [id, n] of REFERRALS) db.prepare('INSERT OR IGNORE INTO referrals VALUES (?,?)').run(id, n);
  DESIGNATIONS.forEach((n, i) => db.prepare('INSERT OR IGNORE INTO designations VALUES (?,?)').run(`d${i}`, n));
  for (const [n, g] of MEDICINES) db.prepare('INSERT OR IGNORE INTO medicines (name, group_name) VALUES (?,?)').run(n, g);
  for (const [bp, list] of Object.entries(DISEASES)) for (const n of list) db.prepare('INSERT OR IGNORE INTO diseases (body_part, name) VALUES (?,?)').run(bp, n);
  if (!db.prepare('SELECT 1 FROM surgery_tree LIMIT 1').get()) {
    const add = (parent, level, name) => Number(db.prepare('INSERT INTO surgery_tree (parent_id, level, name) VALUES (?,?,?)').run(parent, level, name).lastInsertRowid);
    for (const [region, levels] of Object.entries(SURGERY_TREE)) { const r = add(null, 1, region);
      for (const [lv, approaches] of Object.entries(levels)) { const l = add(r, 2, lv);
        for (const [ap, types] of Object.entries(approaches)) { const a = add(l, 3, ap);
          for (const [ty, addons] of Object.entries(types)) { const t2 = add(a, 4, ty); for (const ad of addons) add(t2, 5, ad); } } } }
  }
}

// Patient/clinician-facing by default (active services only); the admin masters screen asks for includeInactive.
export const listExams = ({ includeInactive = false } = {}) =>
  db.prepare(`SELECT * FROM exam_catalog ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY modality, name`).all();
// Plain lookup by code, active or not: an existing order's exam (report templates, invoice lines) must keep resolving
// even after the service is later deactivated. Use listExams()/an active check at the point an exam is newly chosen.
export const getExam = (code) => db.prepare('SELECT * FROM exam_catalog WHERE code = ?').get(code);

// Deterministic code generator shared by the master importer and the admin masters API, so a service gets the same
// code whether it was imported from the hospital's sheet or typed in by an admin. `existing` tracks codes already
// handed out in this run/request so two items whose slug collides still get distinct codes.
export function slugify(text) {
  return String(text).toUpperCase().trim().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
export function makeExamCode(modality, text, existing = new Set()) {
  const base = `${String(modality).toUpperCase().trim()}-${slugify(text)}`;
  let code = base || 'ITEM';
  for (let i = 2; existing.has(code); i++) code = `${base}-${i}`;
  existing.add(code);
  return code;
}

export function templatesFor(exam) {
  return db.prepare(`SELECT * FROM report_templates
    WHERE (modality = ? AND body_part = ?) OR (modality = ? AND body_part = 'ANY') OR modality = 'ANY'
    ORDER BY (modality = ? AND body_part = ?) DESC, name`).all(exam.modality, exam.body_part, exam.modality, exam.modality, exam.body_part);
}

// Rule-based exam suggestion from the clinical indication text (keyword overlap). Not a clinical decision tool.
export function suggestExams(indication) {
  const words = new Set(String(indication || '').toLowerCase().match(/[a-z]{3,}/g) || []);
  if (!words.size) return [];
  return listExams()
    .map((e) => {
      const hits = e.keywords.split(/\s+/).filter((k) => words.has(k));
      return { code: e.code, name: e.name, modality: e.modality, score: hits.length, matched: hits };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
