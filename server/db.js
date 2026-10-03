import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { migrate } from './migrations/index.js';

const file = config.dbFile;
if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);
// busy_timeout: wait for another writer instead of failing at once with SQLITE_BUSY.
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// The schema is owned by server/migrations/*. Opening the database brings it to the latest version (backing up an existing file first).
export const migration = migrate(db, { file, log: file === ':memory:' ? undefined : (m) => console.log(`[db] ${m}`) });
