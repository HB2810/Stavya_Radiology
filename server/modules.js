import { db } from './db.js';

/** Detail routes that stay reachable when a parent work area is allowed. */
export const DETAIL_VIEWS = ['order', 'patient', 'notifications', 'registration', 'summary'];

export function listModules() {
  return db.prepare('SELECT code, label, group_name AS groupName, icon, sort_order AS sortOrder FROM app_modules ORDER BY sort_order, code').all();
}

export function roleDefaults(role) {
  try {
    return db.prepare('SELECT module_code AS code FROM role_module_access WHERE role = ? ORDER BY module_code').all(role).map((r) => r.code);
  } catch {
    return []; // pre-migration / empty DB
  }
}

export function userOverrides(userId) {
  try {
    return db.prepare('SELECT module_code AS code, allowed FROM user_module_access WHERE user_id = ?').all(userId);
  } catch {
    return [];
  }
}

/** Effective module codes: role grants, then per-user allow/deny overrides. Admin always keeps admin-access. */
export function modulesForUser(user) {
  if (!user) return [];
  const set = new Set(roleDefaults(user.role));
  for (const o of userOverrides(user.id)) {
    if (o.allowed) set.add(o.code);
    else set.delete(o.code);
  }
  if (user.role === 'admin') set.add('admin-access');
  return [...set];
}

export function enrichUser(user) {
  if (!user) return null;
  return { ...user, modules: modulesForUser(user) };
}
