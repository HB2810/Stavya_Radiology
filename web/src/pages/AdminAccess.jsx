import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Notice, PageHeader, toast, useAction, useLoad } from '../ui.jsx';

const ROLE_LABEL = {
  radiologist: 'Radiologist', technologist: 'Technologist', assistant: 'Assistant',
  reception: 'Reception', clinician: 'Clinician', nurse: 'Nurse', admin: 'Admin', auditor: 'Auditor'
};

export default function AdminAccess() {
  const { data, loading, reload } = useLoad(() => api.get('/access'));
  const [tab, setTab] = useState('roles');
  const [role, setRole] = useState('reception');
  const [userId, setUserId] = useState('');
  const [picked, setPicked] = useState(new Set());
  const [dirty, setDirty] = useState(false);
  const a = useAction();

  const modules = data?.modules || [];
  const roles = data?.roles || {};
  const users = data?.users || [];
  const groups = useMemo(() => {
    const g = [];
    for (const m of modules) {
      let bucket = g.find((x) => x.name === m.groupName);
      if (!bucket) { bucket = { name: m.groupName, items: [] }; g.push(bucket); }
      bucket.items.push(m);
    }
    return g;
  }, [modules]);

  useEffect(() => {
    if (!data) return;
    if (tab === 'roles') {
      setPicked(new Set(roles[role] || []));
      setDirty(false);
    }
  }, [data, tab, role]);

  useEffect(() => {
    if (!data || tab !== 'users') return;
    const u = users.find((x) => x.id === userId) || users[0];
    if (!u) return;
    if (!userId) setUserId(u.id);
    // Effective view for editing: start from role grants, apply overrides visually as checked = currently allowed.
    setPicked(new Set(u.modules || []));
    setDirty(false);
  }, [data, tab, userId]);

  const toggle = (code) => {
    if (role === 'admin' && tab === 'roles' && code === 'admin-access') return;
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(code)) n.delete(code); else n.add(code);
      return n;
    });
    setDirty(true);
  };

  const saveRole = () => a.run(async () => {
    await api.post(`/access/roles/${role}`, { modules: [...picked] });
    toast(`Saved modules for ${ROLE_LABEL[role] || role}`);
    setDirty(false);
    reload();
  });

  const saveUser = () => a.run(async () => {
    const u = users.find((x) => x.id === userId);
    if (!u) return;
    const roleSet = new Set(roles[u.role] || []);
    const overrides = [];
    for (const m of modules) {
      const on = picked.has(m.code);
      const byRole = roleSet.has(m.code);
      if (on && !byRole) overrides.push({ code: m.code, allowed: true });
      if (!on && byRole) overrides.push({ code: m.code, allowed: false });
    }
    await api.post(`/access/users/${userId}`, { overrides });
    toast(`Saved access for ${u.fullName}`);
    setDirty(false);
    reload();
  });

  const selectedUser = users.find((x) => x.id === userId);

  return (
    <>
      <PageHeader
        title="Module access"
        subtitle="Admin decides which features each role and user can open. Denied modules are hidden — never shown as blocked."
      />
      <Notice>Changes apply on the next screen load / live sync. Detail pages (order, patient chart) stay available when the parent list is allowed.</Notice>

      <div className="desk-focus" role="tablist" style={{ marginBottom: 16 }}>
        <button type="button" className={`desk-focus-btn ${tab === 'roles' ? 'on' : ''}`} onClick={() => setTab('roles')}><strong>Roles</strong><span>Default for everyone in the role</span></button>
        <button type="button" className={`desk-focus-btn ${tab === 'users' ? 'on' : ''}`} onClick={() => setTab('users')}><strong>Users</strong><span>Override one person</span></button>
      </div>

      <Card
        title={tab === 'roles' ? 'Role modules' : 'User overrides'}
        icon="key"
        tools={tab === 'roles' ? (
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.keys(ROLE_LABEL).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        ) : (
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.fullName} · {u.username} ({ROLE_LABEL[u.role] || u.role})</option>)}
          </select>
        )}
      >
        <FormError error={a.error} />
        {loading && !data ? <Empty title="Loading…" /> : !modules.length ? <Empty title="No modules" /> : (
          <>
            {tab === 'users' && selectedUser && (
              <p className="note" style={{ marginTop: 0 }}>
                Base role: <Badge tone="info">{ROLE_LABEL[selectedUser.role] || selectedUser.role}</Badge>
                {' '}· Uncheck to hide for this person only · Check to grant something their role does not have.
              </p>
            )}
            {groups.map((g) => (
              <div key={g.name} style={{ marginBottom: 18 }}>
                <div className="chart-title" style={{ marginBottom: 8 }}>{g.name}</div>
                <div className="form-grid">
                  {g.items.map((m) => {
                    const locked = tab === 'roles' && role === 'admin' && m.code === 'admin-access';
                    const on = picked.has(m.code);
                    return (
                      <label key={m.code} className="check-row wide" style={{ opacity: locked ? 0.7 : 1 }}>
                        <input type="checkbox" checked={on} disabled={locked} onChange={() => toggle(m.code)} />
                        <span>{m.label}{locked ? ' (required for admin)' : ''}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="row-gap" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
              <button className="btn btn-primary" disabled={a.busy || !dirty}
                onClick={tab === 'roles' ? saveRole : saveUser}>
                {a.busy ? 'Saving…' : dirty ? 'Save access' : 'Saved'}
              </button>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
