// Migration 9: reserved ER/privileged capacity + future integration hooks (PACS / WhatsApp / anaesthesia).
export default {
  id: 9,
  name: 'reserved emergency slots and integration outbox',
  up(db) {
    db.exec(`
ALTER TABLE queue_rules ADD COLUMN reserved_emergency_slots INTEGER NOT NULL DEFAULT 8;
ALTER TABLE orders ADD COLUMN privileged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN needs_sedation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS integration_settings (
  key TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  destination TEXT,
  template TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  related_order_id TEXT,
  related_patient_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS integration_outbox_status ON integration_outbox(status, created_at);
`);

    const t = new Date().toISOString();
    const ins = db.prepare('INSERT OR IGNORE INTO integration_settings (key, enabled, config_json, updated_at) VALUES (?,?,?,?)');
    const defaults = [
      ['whatsapp_reports', 0, JSON.stringify({ provider: 'meta', note: 'Send signed radiology report link/PDF to patient WhatsApp' })],
      ['whatsapp_alerts', 0, JSON.stringify({ provider: 'meta', note: 'Operational alerts (sedation, critical) via WhatsApp' })],
      ['pacs_auto_report', 0, JSON.stringify({ note: 'When viewer/PACS connected: draft report from study metadata automatically' })],
      ['anesthesia_module', 0, JSON.stringify({ note: 'Push sedation requests to anaesthesia module when connected' })],
      ['sedation_notify', 0, JSON.stringify({ note: 'Notify anaesthetist on sedation required (in-app + WhatsApp when enabled)' })]
    ];
    for (const [k, en, cfg] of defaults) ins.run(k, en, cfg, t);
  },
  down() { /* keep columns / tables */ }
};
