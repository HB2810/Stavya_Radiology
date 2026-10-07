// Ensure every STAFF entry from roster.js exists as a user (for demo DBs that were seeded before new roles).
import { createUser, hashPassword } from './auth.js';
import { db } from './db.js';
import { STAFF } from './roster.js';
import { config } from './config.js';

export function ensureRosterUsers(password) {
  if (!password || (password.length < 10 && !config.demoWeakPasswords)) return { created: [], reset: 0 };
  const created = [];
  for (const s of Object.values(STAFF)) {
    const code = String(s.code).toUpperCase();
    const exists = db.prepare('SELECT id FROM users WHERE UPPER(username) = ?').get(code);
    if (exists) continue;
    try {
      createUser({
        username: s.code,
        password,
        fullName: s.name,
        role: s.role,
        designation: s.designation,
        ward: s.ward || null,
        phone: `98${String(s.code).padStart(8, '0')}`.slice(0, 10)
      });
      created.push(code);
    } catch (e) {
      console.warn(`[roster] could not create ${code}: ${e.message}`);
    }
  }
  // Temporary shared password for local/demo: reset every active account on boot when weak passwords are allowed.
  let reset = 0;
  if (config.demoWeakPasswords) {
    const { hash, salt } = hashPassword(password);
    reset = db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE active = 1').run(hash, salt).changes;
  }
  return { created, reset };
}
