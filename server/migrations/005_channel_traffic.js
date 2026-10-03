// Migration 5: Stavya channel masters, machines, queue rules, and per-order traffic fields.
// Framework is fixed; channel/machine/queue behaviour is data-driven so the hospital can change
// process variables without rewriting the order state machine.
export default {
  id: 5,
  name: 'channel traffic masters, machines, queue rules, order token fields',
  up(db) {
    db.exec(`
CREATE TABLE channels (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  encounter_type TEXT NOT NULL,
  payment_place TEXT NOT NULL,
  payment_gate INTEGER NOT NULL DEFAULT 0,
  report_handover TEXT NOT NULL DEFAULT 'PATIENT',
  default_priority TEXT NOT NULL DEFAULT 'ROUTINE',
  allow_stat_reception INTEGER NOT NULL DEFAULT 0,
  auto_queue INTEGER NOT NULL DEFAULT 1,
  quick_entry INTEGER NOT NULL DEFAULT 0,
  token_prefix TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 100,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  modality TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  open_time TEXT NOT NULL DEFAULT '08:00',
  close_time TEXT NOT NULL DEFAULT '20:00',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100
);

CREATE TABLE queue_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority_order_json TEXT NOT NULL,
  no_show_minutes INTEGER NOT NULL DEFAULT 30,
  hold_reasons_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE orders ADD COLUMN channel_code TEXT REFERENCES channels(code);
ALTER TABLE orders ADD COLUMN machine_id TEXT REFERENCES machines(id);
ALTER TABLE orders ADD COLUMN token_no TEXT;
ALTER TABLE orders ADD COLUMN eta_at TEXT;
ALTER TABLE orders ADD COLUMN payment_place TEXT;
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'UNPAID';
ALTER TABLE orders ADD COLUMN payment_ref TEXT;
ALTER TABLE orders ADD COLUMN hold_reason TEXT;
ALTER TABLE orders ADD COLUMN report_handover TEXT;

CREATE INDEX IF NOT EXISTS orders_channel ON orders(channel_code);
CREATE INDEX IF NOT EXISTS orders_token ON orders(token_no) WHERE token_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_machine ON orders(machine_id) WHERE machine_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_payment ON orders(payment_status);
`);

    const channels = [
      ['OPD_CONSULTANT', 'OPD · Consultant diagnostic', 'OPD', 'OPD', 0, 'CONSULTANT', 'ROUTINE', 0, 1, 0, 'OC', 10, 'Consultant sends for scan; patient returns to consultant with report. Payment at OPD.'],
      ['OPD_FRONTDESK', 'OPD · Front desk / follow-up report', 'OPD', 'RADIOLOGY', 1, 'PATIENT', 'ROUTINE', 0, 1, 0, 'OF', 20, 'Front desk sends for report or follow-up collection. Payment at radiology.'],
      ['IPD', 'IPD / ward / ICU', 'IPD', 'IPD_CREDIT', 0, 'WARD', 'URGENT', 1, 1, 0, 'IP', 30, 'Bed patients. Charged to IPD bill; no cash at radiology.'],
      ['ER', 'Emergency / casualty', 'OPD', 'NONE', 0, 'WARD', 'STAT', 1, 1, 1, 'ER', 5, 'Quick entry. STAT allowed at reception. No payment gate.'],
      ['WALKIN', 'Walk-in / outside referral', 'EXTERNAL', 'RADIOLOGY', 1, 'PATIENT', 'ROUTINE', 0, 1, 0, 'WK', 40, 'Outside prescription. Pay at radiology before scan.']
    ];
    const insCh = db.prepare(`INSERT INTO channels (code, name, encounter_type, payment_place, payment_gate, report_handover, default_priority, allow_stat_reception, auto_queue, quick_entry, token_prefix, sort_order, active, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`);
    for (const row of channels) insCh.run(...row);

    const machines = [
      ['mch_mri1', 'MRI-1', 'MRI scanner 1', 'MRI', 'M', '08:00', '20:00', 10],
      ['mch_omri1', 'OPENMRI-1', 'Open MRI 1', 'OPEN_MRI', 'OM', '08:00', '20:00', 20],
      ['mch_ct1', 'CT-1', 'CT scanner 1', 'CT', 'C', '08:00', '20:00', 30],
      ['mch_xr1', 'XR-1', 'X-ray room 1', 'XR', 'X', '08:00', '21:00', 40],
      ['mch_usg1', 'USG-1', 'Sonography 1', 'USG', 'U', '08:00', '20:00', 50],
      ['mch_dexa1', 'DEXA-1', 'DEXA 1', 'DEXA', 'D', '08:00', '18:00', 60]
    ];
    const insM = db.prepare(`INSERT INTO machines (id, code, name, modality, token_prefix, open_time, close_time, active, sort_order) VALUES (?,?,?,?,?,?,?,1,?)`);
    for (const row of machines) insM.run(...row);

    db.prepare(`INSERT INTO queue_rules (id, name, priority_order_json, no_show_minutes, hold_reasons_json, updated_at)
      VALUES (?,?,?,?,?,?)`).run(
      'qr_default',
      'Default Stavya queue',
      JSON.stringify(['ER', 'IPD', 'OPD_CONSULTANT', 'OPD_FRONTDESK', 'WALKIN']),
      30,
      JSON.stringify(['Waiting for payment', 'Fasting / prep incomplete', 'Awaiting eGFR / labs', 'Consent pending', 'Machine down', 'Patient refused', 'Need relative', 'Other']),
      new Date().toISOString()
    );
  },
  down(db) {
    db.exec(`
DROP INDEX IF EXISTS orders_payment; DROP INDEX IF EXISTS orders_machine; DROP INDEX IF EXISTS orders_token; DROP INDEX IF EXISTS orders_channel;
ALTER TABLE orders DROP COLUMN report_handover;
ALTER TABLE orders DROP COLUMN hold_reason;
ALTER TABLE orders DROP COLUMN payment_ref;
ALTER TABLE orders DROP COLUMN payment_status;
ALTER TABLE orders DROP COLUMN payment_place;
ALTER TABLE orders DROP COLUMN eta_at;
ALTER TABLE orders DROP COLUMN token_no;
ALTER TABLE orders DROP COLUMN machine_id;
ALTER TABLE orders DROP COLUMN channel_code;
DROP TABLE IF EXISTS queue_rules;
DROP TABLE IF EXISTS machines;
DROP TABLE IF EXISTS channels;
`);
  }
};
