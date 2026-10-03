// Seed data. Usage: RIS_DEMO_PASSWORD='...' npm run seed   (password must be 10+ characters)
// Default = guided samples (server/guided-data.js). Flags: --traffic (bulk random demo traffic), --empty (staff + 3 patients only).
import { db } from './db.js';
import { seedCatalog } from './catalog.js';
import { createUser } from './auth.js';
import { now, uid } from './util.js';
import { seedTraffic } from './demo-data.js';
import { seedGuided } from './guided-data.js';
import { CODE, STAFF } from './roster.js';
import { config } from './config.js';
import { importMasterData } from './import-master.js';

export function seedDemo(password) {
  seedCatalog();
  importMasterData(); // real hospital tariff + discount schemes (idempotent, safe to run on every seed)
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c) return { skipped: true };
  let phoneSeq = 9800000100;
  for (const s of Object.values(STAFF)) if (s.base) createUser({ username: s.code, password, fullName: s.name, role: s.role, designation: s.designation, ward: s.ward || null, phone: String(++phoneSeq) });
  const idOf = (code) => db.prepare('SELECT id FROM users WHERE username = ?').get(code).id;
  const rad = idOf(CODE.dr_preety); const doc = idOf(CODE.dr_mirant);
  const p = (mrn, name, dob, sex, phone, allergy = 'None recorded') => { const id = uid('pat'); db.prepare('INSERT INTO patients (id, mrn, name, dob, sex, phone, allergy, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, mrn, name, dob, sex, phone, allergy, now()); return id; };
  const e = (patient, type, ref, ward, room, bed, doctor, diagnosis) => { const id = uid('enc'); db.prepare('INSERT INTO encounters (id, patient_id, type, ref_no, ward, room, bed, diagnosis, doctor_id, admitted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, patient, type, ref, ward, room, bed, diagnosis, doctor, type === 'IPD' ? now() : null, now()); return id; };
  const p1 = p('SSH-1001', 'Ramesh Desai', '1962-04-11', 'M', '9800000001', 'Iodinated contrast (rash)'); e(p1, 'IPD', 'IPD-2026-0142', 'HDU', 'R2', 'B4', doc, 'Lumbar canal stenosis, post-operative day 2');
  const p2 = p('SSH-1002', 'Kavita Parmar', '1984-09-02', 'F', '9800000002'); e(p2, 'OPD', 'OPD-2026-8841', null, null, null, doc, 'Chronic low back pain');
  const p3 = p('SSH-1003', 'Suresh Trivedi', '1975-01-25', 'M', '9800000003'); e(p3, 'OPD', 'OPD-2026-8850', null, null, null, doc, 'Cervical radiculopathy');
  return { skipped: false, radiologist: rad };
}

if (process.argv[1]?.endsWith('seed.js')) {
  const pw = process.env.RIS_DEMO_PASSWORD;
  if (!pw || (pw.length < 10 && !config.demoWeakPasswords)) { console.error('Set RIS_DEMO_PASSWORD (10+ characters) before seeding.'); process.exit(1); }
  const base = seedDemo(pw);
  if (base.skipped) { console.log('Database already has users; nothing seeded.'); process.exit(0); }
  // Default: the guided samples (one ready case per situation, per role). --traffic = two weeks of bulk random demo traffic
  // instead. --empty = staff accounts and three patients only.
  if (process.argv.includes('--empty') || process.argv.includes('--no-traffic')) console.log('Base data created (staff and 3 patients, no samples).');
  else if (process.argv.includes('--traffic')) { const r = seedTraffic(pw); console.log('Demo traffic created:', JSON.stringify(r, null, 1)); }
  else { const r = seedGuided(pw); console.log(`Guided samples created: ${r.samples} samples, ${r.orders} scans, ${r.patients} patients, ${r.registrations} registrations.\n`); for (const g of r.guide) console.log(`${String(g.n).padStart(2)}. [${g.who}] ${g.sample}\n    ${g.action}`); console.log(''); }
  console.log('Sign in with the employee code (placeholders, see server/roster.js):', Object.entries(CODE).map(([k, c]) => `${c} ${STAFF[k].name}`).join('; '));
}
