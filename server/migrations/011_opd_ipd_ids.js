// Migration 11: OPD / IPD visit IDs on patients (replaces UHID in the reception workflow).
export default {
  id: 11,
  name: 'opd_ipd_ids',
  up(db) {
    const cols = db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name);
    if (!cols.includes('opd_id')) db.exec('ALTER TABLE patients ADD COLUMN opd_id TEXT');
    if (!cols.includes('ipd_id')) db.exec('ALTER TABLE patients ADD COLUMN ipd_id TEXT');
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS patients_opd_id_uq ON patients(opd_id) WHERE opd_id IS NOT NULL AND opd_id != '';
      CREATE UNIQUE INDEX IF NOT EXISTS patients_ipd_id_uq ON patients(ipd_id) WHERE ipd_id IS NOT NULL AND ipd_id != '';
    `);
  },
  down(db) {
    db.exec('DROP INDEX IF EXISTS patients_opd_id_uq; DROP INDEX IF EXISTS patients_ipd_id_uq;');
  }
};
