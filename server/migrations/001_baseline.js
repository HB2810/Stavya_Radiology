// Migration 1: the schema as it was before versioned migrations existed (tables, then the columns added later with ensureColumn).
// Every statement is idempotent, so on a database created by an older build this is a no-op and only records version 1.
function ensureColumn(db, table, column, ddl) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export default {
  id: 1,
  name: 'baseline',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
  full_name TEXT NOT NULL, role TEXT NOT NULL, ward TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY, mrn TEXT UNIQUE NOT NULL, name TEXT NOT NULL, dob TEXT NOT NULL, sex TEXT NOT NULL,
  phone TEXT, allergy TEXT NOT NULL DEFAULT 'None recorded', source_system TEXT NOT NULL DEFAULT 'LOCAL', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), type TEXT NOT NULL,
  ref_no TEXT NOT NULL, ward TEXT, room TEXT, bed TEXT, diagnosis TEXT, doctor_id TEXT REFERENCES users(id), admitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exam_catalog (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, modality TEXT NOT NULL, body_part TEXT NOT NULL,
  est_minutes INTEGER NOT NULL, prep TEXT NOT NULL DEFAULT '', uses_contrast INTEGER NOT NULL DEFAULT 0,
  ionising INTEGER NOT NULL DEFAULT 0, mri INTEGER NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, accession TEXT UNIQUE NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id),
  encounter_id TEXT NOT NULL REFERENCES encounters(id), source TEXT NOT NULL, exam_code TEXT NOT NULL REFERENCES exam_catalog(code),
  priority TEXT NOT NULL, clinical_indication TEXT NOT NULL, requested_by TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL, scheduled_at TEXT, technologist_id TEXT REFERENCES users(id), radiologist_id TEXT REFERENCES users(id),
  due_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, cancel_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, reported_at TEXT
);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS orders_patient ON orders(patient_id);
CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), from_status TEXT, to_status TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS safety_checks (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), pregnant TEXT NOT NULL, contrast_allergy TEXT NOT NULL,
  egfr REAL, mri_implant TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', flags_json TEXT NOT NULL,
  status TEXT NOT NULL, override_reason TEXT, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS report_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, modality TEXT NOT NULL, body_part TEXT NOT NULL,
  technique TEXT NOT NULL, findings TEXT NOT NULL, impression TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), version INTEGER NOT NULL, kind TEXT NOT NULL,
  status TEXT NOT NULL, technique TEXT NOT NULL DEFAULT '', findings TEXT NOT NULL DEFAULT '', impression TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT '', critical_declared TEXT, author_id TEXT NOT NULL, author_name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, signed_at TEXT, signature_hash TEXT,
  addendum_reason TEXT
);
CREATE INDEX IF NOT EXISTS reports_order ON reports(order_id);
CREATE TABLE IF NOT EXISTS critical_cases (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), report_id TEXT REFERENCES reports(id),
  summary TEXT NOT NULL, receiver_id TEXT REFERENCES users(id), state TEXT NOT NULL, due_at TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS critical_events (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES critical_cases(id), state TEXT NOT NULL, receiver_name TEXT,
  channel TEXT, read_back INTEGER, note TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), sender_id TEXT NOT NULL REFERENCES users(id),
  sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_order ON messages(order_id);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), order_id TEXT, kind TEXT NOT NULL,
  text TEXT NOT NULL, created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL, action TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL, patient_id TEXT, resource TEXT,
  outcome TEXT NOT NULL, details_json TEXT, prev_hash TEXT NOT NULL, event_hash TEXT NOT NULL
);
    `);

for (const [c, d] of Object.entries({
  first_name: 'TEXT', middle_name: 'TEXT', last_name: 'TEXT', email: 'TEXT', address: 'TEXT', country: 'TEXT', state: 'TEXT', city: 'TEXT',
  zipcode: 'TEXT', occupation: 'TEXT', designation: 'TEXT', reference: 'TEXT', aadhaar_hash: 'TEXT', aadhaar_last4: 'TEXT',
  phone_verified: 'INTEGER NOT NULL DEFAULT 0', email_verified: 'INTEGER NOT NULL DEFAULT 0'
})) ensureColumn(db, 'patients', c, d);
for (const [c, d] of Object.entries({
  registration_id: 'TEXT', side: 'TEXT', base_price: 'REAL NOT NULL DEFAULT 0', discount_pct: 'REAL NOT NULL DEFAULT 0',
  discount_amount: 'REAL NOT NULL DEFAULT 0', final_amount: 'REAL NOT NULL DEFAULT 0', no_charge: 'INTEGER NOT NULL DEFAULT 0', waiver_reason: 'TEXT'
})) ensureColumn(db, 'orders', c, d);
ensureColumn(db, 'exam_catalog', 'price', 'REAL NOT NULL DEFAULT 0');
ensureColumn(db, 'users', 'phone', 'TEXT');
ensureColumn(db, 'users', 'designation', 'TEXT');

db.exec(`
CREATE TABLE IF NOT EXISTS proof_types (id TEXT PRIMARY KEY, name TEXT NOT NULL, document_side TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS designations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS medicines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, group_name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diseases (id INTEGER PRIMARY KEY AUTOINCREMENT, body_part TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(body_part, name));
CREATE TABLE IF NOT EXISTS surgery_tree (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER, level INTEGER NOT NULL, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS patient_documents (
  id TEXT PRIMARY KEY, patient_id TEXT NOT NULL REFERENCES patients(id), proof_type TEXT NOT NULL, number TEXT,
  front_data TEXT, back_data TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY, purpose TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, code_hash TEXT NOT NULL, salt TEXT NOT NULL,
  expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, verified_at TEXT, consumed_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY, reg_no TEXT UNIQUE NOT NULL, patient_id TEXT NOT NULL REFERENCES patients(id), encounter_id TEXT NOT NULL REFERENCES encounters(id),
  referring_doctor TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', report_no TEXT, report_date TEXT, delivery_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, registration_id TEXT NOT NULL REFERENCES registrations(id), method TEXT NOT NULL, amount REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0, discount_reason TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}',
  receipt_no TEXT UNIQUE NOT NULL, collected_by TEXT NOT NULL, collected_by_name TEXT NOT NULL, at TEXT NOT NULL, processed_at TEXT, processed_note TEXT
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, registration_id TEXT NOT NULL REFERENCES registrations(id), amount REAL NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL, requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, requested_at TEXT NOT NULL,
  decided_by TEXT, decided_note TEXT, decided_at TEXT, paid_by TEXT, paid_via TEXT, paid_reference TEXT, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS patient_words (
  id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  text TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_word_audio (id TEXT PRIMARY KEY, words_id TEXT NOT NULL REFERENCES patient_words(id), mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS medical_consents (
  id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  data_json TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS past_history (
  id TEXT PRIMARY KEY, encounter_id TEXT NOT NULL REFERENCES encounters(id), patient_id TEXT NOT NULL REFERENCES patients(id),
  data_json TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_consents (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), data_json TEXT NOT NULL, full_name TEXT NOT NULL,
  signed_date TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en', actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_reg ON payments(registration_id);
CREATE INDEX IF NOT EXISTS orders_reg ON orders(registration_id);
`);
  }
};
