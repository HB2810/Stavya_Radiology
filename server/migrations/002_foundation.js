// Migration 2 (PKG-01 foundation): idempotency keys, audit anchors, external order ids, signature versioning, soft delete,
// and database-level append-only / immutability triggers.
// Safe on a populated database: only new tables, new nullable or defaulted columns, new indexes and triggers. No existing row is rewritten.

// Append-only tables: any UPDATE or DELETE aborts. Also exported so a test can drop and restore a trigger.
export const IMMUTABLE_TABLES = ['audit_events', 'order_events', 'critical_events', 'audit_anchors'];
export const TRIGGERS_SQL = [
  ...IMMUTABLE_TABLES.flatMap((t) => [
    `CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`,
    `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`
  ]),
  // A report that has been signed (status FINAL) can never change or disappear; corrections are new addendum versions.
  "CREATE TRIGGER IF NOT EXISTS reports_final_no_update BEFORE UPDATE ON reports WHEN OLD.status = 'FINAL' BEGIN SELECT RAISE(ABORT, 'A signed report is immutable; add an addendum'); END;",
  "CREATE TRIGGER IF NOT EXISTS reports_final_no_delete BEFORE DELETE ON reports WHEN OLD.status = 'FINAL' BEGIN SELECT RAISE(ABORT, 'A signed report cannot be deleted'); END;"
];
const TRIGGER_NAMES = TRIGGERS_SQL.map((s) => /TRIGGER IF NOT EXISTS (\w+)/.exec(s)[1]);

export default {
  id: 2,
  name: 'foundation: idempotency, audit anchors, signature v2, soft delete, immutability triggers',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id TEXT NOT NULL, key TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, request_hash TEXT NOT NULL,
  status INTEGER, response_json TEXT, created_at TEXT NOT NULL, completed_at TEXT,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency_keys(created_at);
-- Records the audit chain head at a point in time (printed or exported off the server) so truncation of the newest rows is detectable.
CREATE TABLE IF NOT EXISTS audit_anchors (
  id TEXT PRIMARY KEY, audit_id INTEGER NOT NULL, event_hash TEXT NOT NULL, total INTEGER NOT NULL,
  created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, created_at TEXT NOT NULL
);
ALTER TABLE orders ADD COLUMN external_order_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_external_order_id ON orders(external_order_id) WHERE external_order_id IS NOT NULL;
-- sig_version 1 = the original signature payload (every row that exists today); 2 also covers the signer, addendum reason and critical declaration.
ALTER TABLE reports ADD COLUMN sig_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reports ADD COLUMN critical_summary TEXT;
ALTER TABLE reports ADD COLUMN critical_no_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS reports_order_version ON reports(order_id, version);
-- Soft delete: entries are hidden, never destroyed.
ALTER TABLE patient_words ADD COLUMN deleted_at TEXT;
ALTER TABLE patient_words ADD COLUMN deleted_by TEXT;
ALTER TABLE patient_documents ADD COLUMN superseded_at TEXT;
`);
    for (const sql of TRIGGERS_SQL) db.exec(sql);
  },
  // Development rollback. Reports signed with sig_version 2 would no longer verify after this, so do not roll back a database in clinical use.
  down(db) {
    for (const n of TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${n}`);
    db.exec(`
DROP INDEX IF EXISTS reports_order_version; DROP INDEX IF EXISTS orders_external_order_id; DROP INDEX IF EXISTS idempotency_created;
DROP TABLE IF EXISTS idempotency_keys; DROP TABLE IF EXISTS audit_anchors;
ALTER TABLE orders DROP COLUMN external_order_id;
ALTER TABLE reports DROP COLUMN sig_version; ALTER TABLE reports DROP COLUMN critical_summary; ALTER TABLE reports DROP COLUMN critical_no_reason;
ALTER TABLE patient_words DROP COLUMN deleted_at; ALTER TABLE patient_words DROP COLUMN deleted_by; ALTER TABLE patient_documents DROP COLUMN superseded_at;
`);
  }
};
