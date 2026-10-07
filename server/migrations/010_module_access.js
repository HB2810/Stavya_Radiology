/** Role + per-user module/feature access. Admin alone manages who sees which nav modules. */
export default {
  id: 10,
  name: 'module_access',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_modules (
        code TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        group_name TEXT NOT NULL,
        icon TEXT NOT NULL DEFAULT 'settings',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS role_module_access (
        role TEXT NOT NULL,
        module_code TEXT NOT NULL REFERENCES app_modules(code) ON DELETE CASCADE,
        PRIMARY KEY (role, module_code)
      );
      CREATE TABLE IF NOT EXISTS user_module_access (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        module_code TEXT NOT NULL REFERENCES app_modules(code) ON DELETE CASCADE,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        PRIMARY KEY (user_id, module_code)
      );
      CREATE INDEX IF NOT EXISTS idx_user_module_access_user ON user_module_access(user_id);
    `);

    const modules = [
      ['desk', 'Reception desk', 'People', 'dashboard', 10],
      ['assist', 'Assistant desk', 'People', 'patients', 20],
      ['dashboard', 'Command centre', 'People', 'dashboard', 30],
      ['patients', 'Patients', 'People', 'patients', 40],
      ['command', 'Day board', 'People', 'command', 50],
      ['entry', 'New entry', 'Work', 'plus', 60],
      ['register', 'Register patient', 'Work', 'user', 70],
      ['registrations', 'Registrations', 'Work', 'orders', 80],
      ['new', 'New request', 'Work', 'plus', 90],
      ['protocol', 'Protocol services', 'Work', 'scan', 100],
      ['orders', 'Imaging orders', 'Work', 'orders', 110],
      ['worklist', 'Technician', 'Work', 'worklist', 120],
      ['reporting', 'Reporting', 'Work', 'report', 130],
      ['critical', 'Critical findings', 'Safety', 'critical', 140],
      ['insights', 'Insights', 'Safety', 'scan', 150],
      ['audit', 'Activity / Audit', 'Safety', 'audit', 160],
      ['admin-channels', 'Channels & traffic', 'Administration', 'command', 170],
      ['admin-services', 'Service catalog', 'Administration', 'settings', 180],
      ['admin-discounts', 'Discount schemes', 'Administration', 'percent', 190],
      ['admin-roster', 'Staff roster', 'Administration', 'user', 200],
      ['admin-access', 'Module access', 'Administration', 'key', 210]
    ];
    const insMod = db.prepare('INSERT OR IGNORE INTO app_modules (code, label, group_name, icon, sort_order) VALUES (?,?,?,?,?)');
    for (const m of modules) insMod.run(...m);

    // Defaults match the previous hardcoded NAV roles. Admin gets every module.
    const byRole = {
      reception: ['desk', 'dashboard', 'patients', 'command', 'entry', 'register', 'registrations', 'protocol', 'orders', 'worklist', 'critical', 'insights'],
      assistant: ['assist', 'dashboard', 'patients', 'orders', 'critical'],
      technologist: ['dashboard', 'patients', 'command', 'protocol', 'orders', 'worklist', 'critical'],
      radiologist: ['assist', 'dashboard', 'patients', 'command', 'entry', 'new', 'protocol', 'orders', 'reporting', 'critical', 'insights'],
      clinician: ['dashboard', 'patients', 'new', 'orders', 'critical'],
      nurse: ['dashboard', 'patients', 'new', 'orders', 'critical'],
      auditor: ['dashboard', 'patients', 'command', 'orders', 'critical', 'insights', 'audit'],
      admin: modules.map((m) => m[0])
    };
    const insRole = db.prepare('INSERT OR IGNORE INTO role_module_access (role, module_code) VALUES (?,?)');
    for (const [role, codes] of Object.entries(byRole)) {
      for (const code of codes) insRole.run(role, code);
    }

    // OPD consultant channel: payment at radiology — remove “pay at OPD” path.
    db.prepare(`UPDATE channels SET payment_place = 'RADIOLOGY', payment_gate = 1,
      notes = 'Consultant diagnostic. Collect payment at radiology. Report returns to consultant.'
      WHERE code = 'OPD_CONSULTANT' AND payment_place = 'OPD'`).run();
  }
};
