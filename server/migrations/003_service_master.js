// Migration 3 (PKG-M1): service master (richer, admin-editable exam_catalog) + discount-scheme masters.
//
// exam_catalog.price already existed (REAL NOT NULL DEFAULT 0). It becomes the CASH price going forward -- online_price
// (new) holds the online/digital rate -- and it must become NULLABLE: an item the hospital's charge sheet gives no rate
// for is price = NULL (never a fabricated 0, which would silently bill the item as free). SQLite cannot relax a NOT NULL
// constraint with a plain ALTER TABLE; it needs the table rebuilt (create the new shape, copy the data, drop, rename).
// orders.exam_code is a foreign key into exam_catalog(code), and SQLite refuses to drop a table that a foreign key still
// points to while enforcement is on -- and `PRAGMA foreign_keys` is a documented no-op while a transaction is open. So
// this migration is `rawSql: true` and manages its own PRAGMA + BEGIN/COMMIT instead of the runner's usual wrapper
// (see migrations/index.js).
export default {
  id: 3,
  name: 'service and discount-scheme masters',
  rawSql: true,
  up(db) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
CREATE TABLE exam_catalog_new (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, modality TEXT NOT NULL, body_part TEXT NOT NULL,
  est_minutes INTEGER NOT NULL, prep TEXT NOT NULL DEFAULT '', uses_contrast INTEGER NOT NULL DEFAULT 0,
  ionising INTEGER NOT NULL DEFAULT 0, mri INTEGER NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT '',
  price REAL, -- CASH price going forward; NULL = the hospital's sheet gave no rate yet (see price_note)
  sub_group TEXT, online_price REAL, source TEXT NOT NULL DEFAULT 'SEED', active INTEGER NOT NULL DEFAULT 1,
  price_note TEXT, updated_at TEXT, updated_by TEXT
);
INSERT INTO exam_catalog_new (code, name, modality, body_part, est_minutes, prep, uses_contrast, ionising, mri, keywords, price)
  SELECT code, name, modality, body_part, est_minutes, prep, uses_contrast, ionising, mri, keywords, price FROM exam_catalog;
DROP TABLE exam_catalog;
ALTER TABLE exam_catalog_new RENAME TO exam_catalog;

CREATE TABLE discount_schemes (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'PERCENT', value REAL NOT NULL,
  requires_reason INTEGER NOT NULL DEFAULT 0, requires_approval INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by TEXT, updated_at TEXT, updated_by TEXT
);
-- Mirrors the refunds request -> admin-approval pattern in billing.js. registration_id/order_id: whichever the
-- discount was applied to (a registration's invoice line, or a single order). Not yet wired into billing (a later
-- package consumes this); the table only needs to exist and be queryable for now.
CREATE TABLE discount_approvals (
  id TEXT PRIMARY KEY, registration_id TEXT REFERENCES registrations(id), order_id TEXT REFERENCES orders(id),
  scheme_id TEXT NOT NULL REFERENCES discount_schemes(id), requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', decided_by TEXT, decided_by_name TEXT, decided_at TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS discount_approvals_status ON discount_approvals(status);
CREATE INDEX IF NOT EXISTS discount_approvals_scheme ON discount_approvals(scheme_id);
      `);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  },
  // Development rollback. A price that was NULL becomes 0 (the old column's default) -- confirm real prices before relying on this on a database with real data.
  down(db) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
DROP INDEX IF EXISTS discount_approvals_scheme; DROP INDEX IF EXISTS discount_approvals_status;
DROP TABLE IF EXISTS discount_approvals; DROP TABLE IF EXISTS discount_schemes;
CREATE TABLE exam_catalog_old (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, modality TEXT NOT NULL, body_part TEXT NOT NULL,
  est_minutes INTEGER NOT NULL, prep TEXT NOT NULL DEFAULT '', uses_contrast INTEGER NOT NULL DEFAULT 0,
  ionising INTEGER NOT NULL DEFAULT 0, mri INTEGER NOT NULL DEFAULT 0, keywords TEXT NOT NULL DEFAULT '', price REAL NOT NULL DEFAULT 0
);
INSERT INTO exam_catalog_old SELECT code, name, modality, body_part, est_minutes, prep, uses_contrast, ionising, mri, keywords, COALESCE(price, 0) FROM exam_catalog;
DROP TABLE exam_catalog;
ALTER TABLE exam_catalog_old RENAME TO exam_catalog;
      `);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }
};
