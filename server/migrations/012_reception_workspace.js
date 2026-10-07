// Reception uses one operational desk instead of overlapping clinical dashboards.
// Preserve individual grants: hospital administrators can still enable extra modules.
export default {
  id: 12,
  name: 'focused reception workspace',
  up(db) {
    db.prepare(`DELETE FROM role_module_access WHERE role = 'reception'
      AND module_code IN ('dashboard', 'command', 'protocol', 'worklist', 'critical', 'insights')`).run();
  }
};
