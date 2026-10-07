// Migration 7: assistant lane before technician protocol.
// Reception → WAITING → assistant call/consent → transfer → AWAITING_PROTOCOL → tech sub-services.
export default {
  id: 7,
  name: 'assistant lane: waiting → consent → transfer → tech protocol',
  up(db) {
    db.exec(`
ALTER TABLE rad_case_modalities ADD COLUMN called_by TEXT;
ALTER TABLE rad_case_modalities ADD COLUMN called_at TEXT;
ALTER TABLE rad_case_modalities ADD COLUMN transferred_by TEXT;
ALTER TABLE rad_case_modalities ADD COLUMN transferred_at TEXT;
ALTER TABLE rad_case_modalities ADD COLUMN assist_id_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rad_case_modalities ADD COLUMN assist_consent_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rad_case_modalities ADD COLUMN assist_allergy_checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rad_case_modalities ADD COLUMN assist_prep_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rad_case_modalities ADD COLUMN assist_notes TEXT NOT NULL DEFAULT '';
ALTER TABLE rad_case_modalities ADD COLUMN assist_checklist_json TEXT NOT NULL DEFAULT '{}';
`);
    // Existing category rows sitting for tech protocol now start at the assistant waiting lane.
    db.prepare(`UPDATE rad_case_modalities SET status = 'WAITING' WHERE status = 'AWAITING_PROTOCOL'`).run();
  },
  down(db) {
    db.prepare(`UPDATE rad_case_modalities SET status = 'AWAITING_PROTOCOL' WHERE status IN ('WAITING','AT_ASSISTANT')`).run();
    // SQLite cannot DROP COLUMN on older paths reliably; leave assist columns in place on down.
  }
};
