import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole, ROLES } from './auth.js';
import { bad, forbidden, tx } from './util.js';
import { enrichUser, listModules, modulesForUser, roleDefaults, userOverrides } from './modules.js';

export { DETAIL_VIEWS, enrichUser, listModules, modulesForUser, roleDefaults, userOverrides } from './modules.js';

export function getAccessMatrix(actor) {
  requireRole(actor, ['admin']);
  const modules = listModules();
  const roles = {};
  for (const role of ROLES) roles[role] = roleDefaults(role);
  const users = db.prepare(`SELECT id, username, full_name AS fullName, role, active FROM users ORDER BY role, full_name`).all()
    .map((u) => ({
      ...u,
      active: !!u.active,
      overrides: userOverrides(u.id),
      modules: modulesForUser(u)
    }));
  return { modules, roles, users };
}

export function setRoleModules(role, moduleCodes, actor) {
  requireRole(actor, ['admin']);
  if (!ROLES.includes(role)) throw bad('ROLE_INVALID', 'Unknown role');
  if (role === 'admin' && !moduleCodes.includes('admin-access')) {
    moduleCodes = [...moduleCodes, 'admin-access'];
  }
  const known = new Set(listModules().map((m) => m.code));
  const codes = [...new Set((Array.isArray(moduleCodes) ? moduleCodes : []).filter((c) => known.has(c)))];
  tx(db, () => {
    db.prepare('DELETE FROM role_module_access WHERE role = ?').run(role);
    const ins = db.prepare('INSERT INTO role_module_access (role, module_code) VALUES (?,?)');
    for (const c of codes) ins.run(role, c);
    audit({ action: 'ROLE_MODULES_SET', actor, details: { role, modules: codes } });
  });
  return { role, modules: roleDefaults(role) };
}

export function setUserModules(userId, overrides, actor) {
  requireRole(actor, ['admin']);
  const u = db.prepare('SELECT id, role, full_name FROM users WHERE id = ?').get(userId);
  if (!u) throw bad('USER_NOT_FOUND', 'Staff member not found');
  const known = new Set(listModules().map((m) => m.code));
  const list = Array.isArray(overrides) ? overrides : [];
  const cleaned = [];
  for (const o of list) {
    const code = String(o.code || o.module_code || '');
    if (!known.has(code)) continue;
    const allowed = o.allowed === true || o.allowed === 1 ? 1 : 0;
    cleaned.push({ code, allowed });
  }
  if (u.role === 'admin') {
    const denyAccess = cleaned.find((c) => c.code === 'admin-access' && !c.allowed);
    if (denyAccess) throw forbidden('Cannot revoke Module access from an admin account');
  }
  tx(db, () => {
    db.prepare('DELETE FROM user_module_access WHERE user_id = ?').run(userId);
    const ins = db.prepare('INSERT INTO user_module_access (user_id, module_code, allowed) VALUES (?,?,?)');
    for (const o of cleaned) ins.run(userId, o.code, o.allowed);
    audit({ action: 'USER_MODULES_SET', actor, resource: u.full_name, details: { userId, overrides: cleaned } });
  });
  return { userId, overrides: userOverrides(userId), modules: modulesForUser({ id: userId, role: u.role }) };
}
