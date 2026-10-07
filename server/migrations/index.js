// Versioned schema migrations. Each migration is a module { id, name, up(db), down?(db) }; ids are consecutive from 1.
// Applied versions are recorded in schema_version. Add a migration by creating NNN_name.js and appending it to MIGRATIONS (never edit an applied one).
import fs from 'node:fs';
import { tx } from '../util.js';
import m1 from './001_baseline.js';
import m2 from './002_foundation.js';
import m3 from './003_service_master.js';
import m4 from './004_discount_scheme_link.js';
import m5 from './005_channel_traffic.js';
import m6 from './006_rad_cases.js';
import m7 from './007_assistant_lane.js';
import m8 from './008_optional_traffic.js';
import m9 from './009_integrations_reserved.js';
import m10 from './010_module_access.js';
import m11 from './011_opd_ipd_ids.js';
import m12 from './012_reception_workspace.js';

export const MIGRATIONS = [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12];
export const LATEST = MIGRATIONS[MIGRATIONS.length - 1].id;

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
export function currentVersion(db) {
  return hasTable(db, 'schema_version') ? db.prepare('SELECT COALESCE(MAX(version), 0) v FROM schema_version').get().v : 0;
}

// Copies a database that already holds data before it is changed. VACUUM INTO gives a consistent copy even in WAL mode.
function backup(db, file, fromVersion) {
  const target = `${file}.pre-v${fromVersion + 1}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  fs.chmodSync(target, 0o600);
  return target;
}

/** Brings the schema to `target` (default: the latest). Returns { from, to, applied, backup }. Refuses a database newer than this build. */
export function migrate(db, { file = ':memory:', target = LATEST, makeBackup = true, log = () => {} } = {}) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const from = currentVersion(db);
  if (from > LATEST) throw new Error(`Database schema is version ${from} but this build only knows version ${LATEST}. Upgrade the software; do not run an older build on a newer database.`);
  const result = { from, to: from, applied: [], backup: null };
  if (target > from) {
    const pending = MIGRATIONS.filter((m) => m.id > from && m.id <= target);
    const populated = hasTable(db, 'users'); // a database from before versioning, or one created by an earlier migration
    if (pending.length && populated && makeBackup && file !== ':memory:') { result.backup = backup(db, file, from); log(`Backed up the database to ${result.backup}`); }
    for (const m of pending) {
      try {
        // rawSql: true opts a migration out of the runner's own BEGIN/COMMIT. SQLite can only toggle PRAGMA foreign_keys,
        // or drop/rename a table referenced by a foreign key, when there is no pending transaction -- such a migration
        // manages its own transaction (see 003_service_master.js for why that is needed).
        if (m.rawSql) { m.up(db); db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)').run(m.id, m.name, new Date().toISOString()); }
        else tx(db, () => { m.up(db); db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?,?,?)').run(m.id, m.name, new Date().toISOString()); });
      } catch (e) { throw new Error(`Migration ${m.id} (${m.name}) failed and was rolled back: ${e.message}`, { cause: e }); }
      result.applied.push(m.id); result.to = m.id; log(`Applied migration ${m.id}: ${m.name}`);
    }
  } else if (target < from) {
    if (target < 0) throw new Error('Invalid target version');
    for (const m of MIGRATIONS.filter((x) => x.id <= from && x.id > target).reverse()) {
      if (!m.down) throw new Error(`Migration ${m.id} (${m.name}) has no down step`);
      if (m.rawSql) { m.down(db); db.prepare('DELETE FROM schema_version WHERE version = ?').run(m.id); }
      else tx(db, () => { m.down(db); db.prepare('DELETE FROM schema_version WHERE version = ?').run(m.id); });
      result.applied.push(-m.id); result.to = m.id - 1; log(`Rolled back migration ${m.id}`);
    }
  }
  return result;
}
