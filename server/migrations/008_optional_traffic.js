// Migration 8: token + automated traffic as optional system features (admin can turn off).
export default {
  id: 8,
  name: 'optional token and automated traffic switches',
  up(db) {
    db.exec(`
ALTER TABLE queue_rules ADD COLUMN token_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE queue_rules ADD COLUMN auto_traffic_enabled INTEGER NOT NULL DEFAULT 1;
`);
  },
  down(db) {
    // Columns retained on SQLite down-path.
  }
};
