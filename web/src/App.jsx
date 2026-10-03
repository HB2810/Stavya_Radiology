import { useCallback, useEffect, useState } from 'react';
import { api, hasToken, setToken } from './api.js';
import { DataContext, Icon, RADIOLOGY, ToastHost, initials, useData } from './ui.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { Patients, PatientChart } from './pages/Patients.jsx';
import DayBoard from './pages/DayBoard.jsx';
import { Orders, Worklist, Reporting } from './pages/Queues.jsx';
import Order from './pages/Order.jsx';
import NewRequest from './pages/NewRequest.jsx';
import Critical from './pages/Critical.jsx';
import Insights from './pages/Insights.jsx';
import Audit from './pages/Audit.jsx';
import Notifications from './pages/Notifications.jsx';
import Register from './pages/Register.jsx';
import Registrations from './pages/Registrations.jsx';
import RegistrationDetail from './pages/RegistrationDetail.jsx';
import Summary from './pages/Summary.jsx';
import AdminServices from './pages/AdminServices.jsx';
import AdminDiscounts from './pages/AdminDiscounts.jsx';
import AdminRoster from './pages/AdminRoster.jsx';
import ReceptionDesk from './pages/ReceptionDesk.jsx';
import ChannelEntry from './pages/ChannelEntry.jsx';
import AdminChannels from './pages/AdminChannels.jsx';
import Protocol from './pages/Protocol.jsx';

const ALL = null; const WARD = ['clinician', 'nurse'];
const NAV = [
  { view: 'desk', label: 'Reception desk', icon: 'dashboard', roles: ['reception', 'admin'], group: 'People' },
  { view: 'dashboard', label: 'Command centre', icon: 'dashboard', roles: ALL, group: 'People' },
  { view: 'patients', label: 'Patients', icon: 'patients', roles: ALL, group: 'People' },
  { view: 'command', label: 'Day board', icon: 'command', roles: [...RADIOLOGY, 'admin', 'auditor'], group: 'People' },
  { view: 'entry', label: 'New entry', icon: 'plus', roles: ['reception', 'admin', 'radiologist'], group: 'Work' },
  { view: 'register', label: 'Register patient', icon: 'user', roles: ['reception', 'admin'], group: 'Work' },
  { view: 'registrations', label: 'Registrations', icon: 'orders', roles: ['reception', 'admin'], group: 'Work' },
  { view: 'new', label: 'New request', icon: 'plus', roles: [...WARD, 'radiologist'], group: 'Work' },
  { view: 'protocol', label: 'Protocol services', icon: 'scan', roles: ['technologist', 'radiologist', 'reception'], group: 'Work' },
  { view: 'orders', label: 'Imaging orders', icon: 'orders', roles: ALL, group: 'Work' },
  { view: 'worklist', label: 'Technician', icon: 'worklist', roles: ['technologist', 'reception'], group: 'Work' },
  { view: 'reporting', label: 'Reporting', icon: 'report', roles: ['radiologist'], group: 'Work' },
  { view: 'critical', label: 'Critical findings', icon: 'critical', roles: ALL, group: 'Safety' },
  { view: 'insights', label: 'Insights', icon: 'scan', roles: ['radiologist', 'reception', 'admin', 'auditor'], group: 'Safety' },
  // Auditor keeps Activity/Audit under Safety (their only read-only lens on the department); admin gets the same page
  // listed in Administration instead, alongside the other masters/oversight screens that role owns.
  { view: 'audit', label: 'Activity / Audit', icon: 'audit', roles: ['auditor'], group: 'Safety' },
  { view: 'admin-channels', label: 'Channels & traffic', icon: 'command', roles: ['admin'], group: 'Administration' },
  { view: 'admin-services', label: 'Service catalog', icon: 'settings', roles: ['admin'], group: 'Administration' },
  { view: 'admin-discounts', label: 'Discount schemes', icon: 'percent', roles: ['admin'], group: 'Administration' },
  { view: 'audit', label: 'Activity / Audit', icon: 'audit', roles: ['admin'], group: 'Administration' },
  { view: 'admin-roster', label: 'Staff roster', icon: 'user', roles: ['admin'], group: 'Administration' }
];
const SCOPE = (u) => (RADIOLOGY.includes(u.role) ? ['Whole department', 'Every OPD, IPD, OT and walk-in request'] : u.role === 'clinician' ? ['Your patients', 'Requests you made or patients under your care'] : u.role === 'nurse' ? [`Ward ${u.ward || ''}`, 'Requests for your ward'] : ['Read-only oversight', 'Whole department, no clinical actions']);

function parseHash() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [view = 'dashboard', id, tab] = path.split('/');
  return { view: view || 'dashboard', id, tab, query: Object.fromEntries(new URLSearchParams(query)) };
}
function useRoute() {
  const [r, setR] = useState(parseHash());
  useEffect(() => { const f = () => setR(parseHash()); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

export default function App() {
  const [user, setUser] = useState(null); const [checking, setChecking] = useState(hasToken());
  useEffect(() => {
    if (hasToken()) api.get('/auth/me').then((r) => setUser(r.user)).catch(() => setToken('')).finally(() => setChecking(false));
    const out = () => setUser(null); addEventListener('ris-logout', out); return () => removeEventListener('ris-logout', out);
  }, []);
  if (checking) return <div className="empty-state" style={{ minHeight: '100dvh', justifyContent: 'center' }}>Loading…</div>;
  return (<>{user ? <Shell user={user} onLogout={async () => { await api.post('/auth/logout').catch(() => {}); setToken(''); setUser(null); }} /> : <Login onLogin={(r) => { setToken(r.token); setUser(r.user); location.hash = r.user.role === 'reception' ? '#/desk' : '#/dashboard'; }} />}<ToastHost /></>);
}

function Shell({ user, onLogout }) {
  const route = useRoute();
  const [orders, setOrders] = useState([]); const [critical, setCritical] = useState([]); const [unread, setUnread] = useState(0); const [loading, setLoading] = useState(true);
  const [menu, setMenu] = useState(false);
  const reload = useCallback(async () => {
    try {
      const [o, c, n] = await Promise.all([api.get('/orders'), api.get('/critical'), api.get('/notifications?unread=1')]);
      setOrders(o); setCritical(c); setUnread(n.length);
    } catch { /* keep the last good data */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); const t = setInterval(reload, 20000); return () => clearInterval(t); }, [reload]);
  useEffect(() => setMenu(false), [route.view, route.id]);

  const open = orders.filter((o) => ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW', 'ARRIVED', 'PREPARED', 'IN_PROGRESS', 'COMPLETED', 'REPORT_DRAFTED'].includes(o.status));
  const count = (s) => open.filter((o) => s.includes(o.status)).length;
  const openCrit = critical.filter((c) => ['OPEN', 'ESCALATED'].includes(c.state)).length;
  const counts = { orders: count(['REQUESTED', 'ACKNOWLEDGED']), worklist: count(['SCHEDULED', 'ARRIVED', 'PREPARED', 'IN_PROGRESS']), reporting: count(['COMPLETED', 'REPORT_DRAFTED']), critical: openCrit };
  const tone = { critical: 'red', orders: 'amber', reporting: 'amber' };
  const allowed = NAV.filter((n) => !n.roles || n.roles.includes(user.role));
  const inNav = allowed.some((n) => n.view === route.view) || ['order', 'patient', 'notifications', 'registration', 'summary'].includes(route.view);
  // Reception lands on the live desk by default when hash is empty / dashboard.
  const view = !inNav ? (user.role === 'reception' ? 'desk' : 'dashboard') : (route.view === 'dashboard' && user.role === 'reception' ? 'desk' : route.view);
  const activeNav = { order: 'orders', patient: 'patients', registration: 'registrations', summary: 'orders' }[view] || view;
  const [scopeTitle, scopeNote] = SCOPE(user);

  let page;
  switch (view) {
    case 'desk': page = <ReceptionDesk user={user} />; break;
    case 'entry': page = <ChannelEntry user={user} query={route.query} />; break;
    case 'protocol': page = <Protocol user={user} />; break;
    case 'patients': page = <Patients user={user} query={route.query} />; break;
    case 'patient': page = <PatientChart user={user} id={route.id} tab={route.tab} />; break;
    case 'command': page = <DayBoard user={user} />; break;
    case 'new': page = <NewRequest user={user} />; break;
    case 'orders': page = <Orders user={user} filter={route.query.f} />; break;
    case 'worklist': page = <Worklist user={user} />; break;
    case 'reporting': page = <Reporting user={user} />; break;
    case 'order': page = <Order user={user} id={route.id} tab={route.tab} />; break;
    case 'register': page = <Register />; break;
    case 'registrations': page = <Registrations user={user} />; break;
    case 'registration': page = <RegistrationDetail id={route.id} user={user} sub={route.tab} />; break;
    case 'summary': page = <Summary id={route.id} />; break;
    case 'critical': page = <Critical user={user} />; break;
    case 'insights': page = <Insights />; break;
    case 'audit': page = <Audit user={user} />; break;
    case 'admin-channels': page = <AdminChannels />; break;
    case 'admin-services': page = <AdminServices />; break;
    case 'admin-discounts': page = <AdminDiscounts />; break;
    case 'admin-roster': page = <AdminRoster />; break;
    case 'notifications': page = <Notifications onChange={reload} />; break;
    default: page = <Dashboard user={user} />;
  }
  const onSearch = (e) => { if (e.key === 'Enter' && e.target.value.trim()) { location.hash = `#/patients?q=${encodeURIComponent(e.target.value.trim())}`; e.target.value = ''; } };

  return (
    <DataContext.Provider value={{ orders, critical, reload, loading }}>
      <aside className={`app-sidebar${menu ? ' open' : ''}`}>
        <div className="brand-block"><img src="/stavya_logo.png" alt="Stavya Spine Hospital" /><button className="icon-button sidebar-close" onClick={() => setMenu(false)} aria-label="Close navigation"><Icon name="x" size={18} /></button></div>
        <div className="sidebar-role"><span>Module</span><strong>Radiology</strong></div>
        <nav className="sidebar-nav" aria-label="Radiology">
          {['People', 'Work', 'Safety', 'Administration'].map((g) => {
            const items = allowed.filter((n) => n.group === g); if (!items.length) return null;
            return <div className="nav-section" key={g}><span className="nav-section-label">{g}</span>{items.map((n) => (
              <a key={n.view} href={`#/${n.view}`} className={activeNav === n.view ? 'active' : ''}><Icon name={n.icon} size={16} /><span>{n.label}</span>{counts[n.view] > 0 && <span className={`nav-count ${tone[n.view] || ''}`}>{counts[n.view]}</span>}</a>))}</div>;
          })}
        </nav>
        <div className="sidebar-scope"><span>Your scope</span><strong>{scopeTitle}</strong><em>{scopeNote}</em></div>
      </aside>
      {menu && <button className="sidebar-scrim" onClick={() => setMenu(false)} aria-label="Close navigation" />}
      <header className="app-header">
        <div className="header-left">
          <button className="icon-button menu-button" onClick={() => setMenu(true)} aria-label="Open navigation"><Icon name="dashboard" size={20} /></button>
          <span className="module-title"><Icon name="plus" size={14} /><span>Radiology</span></span>
          <label className="header-search"><Icon name="search" size={14} /><input type="search" placeholder="Find patient or UHID" autoComplete="off" onKeyDown={onSearch} /></label>
        </div>
        <div className="header-right">
          {openCrit > 0 && <button className="alert-chip" onClick={() => (location.hash = '#/critical')}><Icon name="critical" size={14} />{openCrit} critical</button>}
          <button className="icon-button bell-btn" onClick={() => (location.hash = '#/notifications')} aria-label="Notifications" title="Notifications"><Icon name="inbox" size={18} />{unread > 0 && <span className="nav-count">{unread}</span>}</button>
          <div className="profile-button" title={`Employee code ${user.employeeCode}`}><span className="avatar">{initials(user.fullName)}</span><span className="profile-copy"><strong>{user.fullName}</strong><small>{user.employeeCode} · {user.designation || user.role}</small></span></div>
          <button className="icon-button" onClick={onLogout} aria-label="Sign out" title="Sign out"><Icon name="key" size={18} /></button>
        </div>
      </header>
      <main className="main-content"><div className="page-shell">{page}</div></main>
    </DataContext.Provider>
  );
}
export { useData };
