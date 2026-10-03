// Migration 6: reception creates a case with modality CATEGORIES only (CT / MRI / XR…).
// Technician / tech assistant selects the concrete catalog SERVICES inside each category.
export default {
  id: 6,
  name: 'radiology cases: reception categories, technician services',
  up(db) {
    db.exec(`
CREATE TABLE rad_cases (
  id TEXT PRIMARY KEY,
  case_no TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  encounter_id TEXT NOT NULL REFERENCES encounters(id),
  channel_code TEXT REFERENCES channels(code),
  clinical_indication TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'ROUTINE',
  payment_place TEXT,
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
  payment_ref TEXT,
  report_handover TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX rad_cases_patient ON rad_cases(patient_id);
CREATE INDEX rad_cases_status ON rad_cases(status);
CREATE INDEX rad_cases_created ON rad_cases(created_at);

CREATE TABLE rad_case_modalities (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES rad_cases(id),
  modality TEXT NOT NULL,
  token_no TEXT,
  machine_id TEXT REFERENCES machines(id),
  eta_at TEXT,
  status TEXT NOT NULL DEFAULT 'AWAITING_PROTOCOL',
  hold_reason TEXT,
  protocolled_by TEXT,
  protocolled_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(case_id, modality)
);
CREATE INDEX rad_case_mod_status ON rad_case_modalities(status);
CREATE INDEX rad_case_mod_case ON rad_case_modalities(case_id);

ALTER TABLE orders ADD COLUMN case_id TEXT REFERENCES rad_cases(id);
ALTER TABLE orders ADD COLUMN case_modality_id TEXT REFERENCES rad_case_modalities(id);
CREATE INDEX IF NOT EXISTS orders_case ON orders(case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_case_mod ON orders(case_modality_id) WHERE case_modality_id IS NOT NULL;
`);
  },
  down(db) {
    db.exec(`
DROP INDEX IF EXISTS orders_case_mod; DROP INDEX IF EXISTS orders_case;
ALTER TABLE orders DROP COLUMN case_modality_id;
ALTER TABLE orders DROP COLUMN case_id;
DROP INDEX IF EXISTS rad_case_mod_case; DROP INDEX IF EXISTS rad_case_mod_status;
DROP TABLE IF EXISTS rad_case_modalities;
DROP INDEX IF EXISTS rad_cases_created; DROP INDEX IF EXISTS rad_cases_status; DROP INDEX IF EXISTS rad_cases_patient;
DROP TABLE IF EXISTS rad_cases;
`);
  }
};
