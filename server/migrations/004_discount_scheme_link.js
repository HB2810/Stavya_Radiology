// Migration 4 (PKG-M3): links an order to the discount scheme that priced it, and reshapes discount_approvals
// (created empty by 003, not yet written to by anything) so it can record a scheme OR a one-off custom percentage,
// the percentage actually applied, and the written reason -- what the approvals list/decision screen needs to show.
//
// orders.discount_scheme_id is a plain nullable column (ALTER TABLE ADD COLUMN), no rebuild needed.
// discount_approvals needs scheme_id to become nullable (a custom % has no scheme) and two new NOT NULL-ish columns
// (pct, reason) -- SQLite cannot relax a column or add a NOT NULL column with no default via plain ALTER TABLE, so
// that table is rebuilt (create the new shape, copy the data, drop, rename). Unlike 003's exam_catalog rebuild,
// nothing holds a foreign key INTO discount_approvals (it only holds foreign keys out, to orders/registrations/
// discount_schemes), so dropping and recreating it is safe inside the runner's own transaction -- no rawSql/PRAGMA
// dance required here.
export default {
  id: 4,
  name: 'discount scheme link on orders; discount_approvals carries pct/reason, scheme optional',
  up(db) {
    db.exec(`
ALTER TABLE orders ADD COLUMN discount_scheme_id TEXT REFERENCES discount_schemes(id);
CREATE INDEX IF NOT EXISTS orders_discount_scheme ON orders(discount_scheme_id) WHERE discount_scheme_id IS NOT NULL;

CREATE TABLE discount_approvals_new (
  id TEXT PRIMARY KEY, registration_id TEXT REFERENCES registrations(id), order_id TEXT REFERENCES orders(id),
  scheme_id TEXT REFERENCES discount_schemes(id), pct REAL NOT NULL DEFAULT 0, reason TEXT,
  requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', decided_by TEXT, decided_by_name TEXT, decided_at TEXT, note TEXT
);
INSERT INTO discount_approvals_new (id, registration_id, order_id, scheme_id, pct, requested_by, requested_by_name, requested_at, status, decided_by, decided_by_name, decided_at, note)
  SELECT da.id, da.registration_id, da.order_id, da.scheme_id, COALESCE(s.value, 0), da.requested_by, da.requested_by_name, da.requested_at, da.status, da.decided_by, da.decided_by_name, da.decided_at, da.note
  FROM discount_approvals da LEFT JOIN discount_schemes s ON s.id = da.scheme_id;
DROP TABLE discount_approvals;
ALTER TABLE discount_approvals_new RENAME TO discount_approvals;
CREATE INDEX IF NOT EXISTS discount_approvals_status ON discount_approvals(status);
CREATE INDEX IF NOT EXISTS discount_approvals_scheme ON discount_approvals(scheme_id);
CREATE INDEX IF NOT EXISTS discount_approvals_order ON discount_approvals(order_id);
    `);
  },
  // Development rollback. Any row with no scheme_id (a custom-% approval) loses its pct/reason detail.
  down(db) {
    db.exec(`
DROP INDEX IF EXISTS discount_approvals_order; DROP INDEX IF EXISTS discount_approvals_scheme; DROP INDEX IF EXISTS discount_approvals_status;
CREATE TABLE discount_approvals_old (
  id TEXT PRIMARY KEY, registration_id TEXT REFERENCES registrations(id), order_id TEXT REFERENCES orders(id),
  scheme_id TEXT NOT NULL REFERENCES discount_schemes(id), requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', decided_by TEXT, decided_by_name TEXT, decided_at TEXT, note TEXT
);
INSERT INTO discount_approvals_old (id, registration_id, order_id, scheme_id, requested_by, requested_by_name, requested_at, status, decided_by, decided_by_name, decided_at, note)
  SELECT id, registration_id, order_id, scheme_id, requested_by, requested_by_name, requested_at, status, decided_by, decided_by_name, decided_at, note FROM discount_approvals WHERE scheme_id IS NOT NULL;
DROP TABLE discount_approvals;
ALTER TABLE discount_approvals_old RENAME TO discount_approvals;
CREATE INDEX IF NOT EXISTS discount_approvals_status ON discount_approvals(status);
CREATE INDEX IF NOT EXISTS discount_approvals_scheme ON discount_approvals(scheme_id);
DROP INDEX IF EXISTS orders_discount_scheme;
ALTER TABLE orders DROP COLUMN discount_scheme_id;
    `);
  }
};
