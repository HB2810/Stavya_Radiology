import { createContext, useContext, useEffect, useState } from 'react';
import { ICONS } from './icons.js';
import { api } from './api.js';

/* ---------- basics ---------- */
export function Icon({ name, size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} />;
}
export const go = (hash) => { location.hash = hash; };
export const initials = (name = '') => name.replace(/^(Dr\.?|Mr\.?|Ms\.?)\s+/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export const fmt = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const ageOf = (dob) => (dob ? Math.floor((Date.now() - Date.parse(dob)) / 31557600000) : '');
export const isToday = (iso) => iso && new Date(iso).toDateString() === new Date().toDateString();

export const STATUS_LABEL = {
  REQUESTED: 'Requested', ACKNOWLEDGED: 'Acknowledged', SCHEDULED: 'In queue', ARRIVED: 'Arrived', NO_SHOW: 'No show',
  PREPARED: 'Prepared', IN_PROGRESS: 'Scan in', COMPLETED: 'Scan out', REPORT_DRAFTED: 'Report draft', REPORTED: 'Finalised', DISPATCHED: 'Dispatched', COLLECTED: 'Collected', CANCELLED: 'Terminated',
  AWAITING_PROTOCOL: 'Awaiting services'
};
const STATUS_TONE = { REQUESTED: 'warning', ACKNOWLEDGED: 'info', SCHEDULED: 'info', ARRIVED: 'violet', PREPARED: 'violet', NO_SHOW: 'danger', IN_PROGRESS: 'violet', COMPLETED: 'warning', REPORT_DRAFTED: 'warning', REPORTED: 'success', DISPATCHED: 'success', COLLECTED: 'success', CANCELLED: 'neutral', AWAITING_PROTOCOL: 'warning' };
const PRIORITY_TONE = { STAT: 'danger', URGENT: 'warning', ROUTINE: 'neutral' };
export const FLOW = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'ARRIVED', 'PREPARED', 'IN_PROGRESS', 'COMPLETED', 'REPORT_DRAFTED', 'REPORTED', 'DISPATCHED', 'COLLECTED'];
export const RADIOLOGY = ['radiologist', 'technologist', 'reception'];
export const OPEN = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW', 'ARRIVED', 'PREPARED', 'IN_PROGRESS', 'COMPLETED', 'REPORT_DRAFTED'];
export const FINAL = ['REPORTED', 'DISPATCHED', 'COLLECTED'];
export const inr = (n) => `₹ ${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
// The three traffic sources radiology gets scans from, plus OT: OPD and IPD orders come through a visit/admission,
// EXTERNAL is a patient who came straight to the radiology desk to use the equipment, no OPD/IPD visit at all.
export const ENCOUNTER_LABEL = { OPD: 'OPD', IPD: 'IPD', OT: 'OT', EXTERNAL: 'Outside / Walk-in' };

export const StatusBadge = ({ status }) => <span className={`status-badge ${STATUS_TONE[status] || 'neutral'}`}><span className="dot" />{STATUS_LABEL[status] || status}</span>;
export const PriorityBadge = ({ priority }) => <span className={`status-badge ${PRIORITY_TONE[priority] || 'neutral'}`}>{priority}</span>;
export const Badge = ({ tone = 'neutral', children }) => <span className={`status-badge ${tone}`}>{children}</span>;
export const CountChip = ({ n, tone = 'neutral' }) => <span className={`count-chip ${tone}`}>{n}</span>;

/* ---------- layout primitives ---------- */
export function PageHeader({ title, subtitle, actions }) {
  return <header className="page-header"><div className="page-header-copy"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}
export function Card({ title, icon, subtitle, count, tone, actions, tools, flush, foot, className = '', children }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-head-copy">
            <h2>{icon && <Icon name={icon} size={15} />}{title}{count != null && <CountChip n={count} tone={tone} />}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="card-head-actions">{actions}</div>}
        </div>
      )}
      {tools && <div className="card-tools">{tools}</div>}
      <div className={`card-body${flush ? ' flush' : ''}`}>{children}</div>
      {foot && <div className="card-foot">{foot}</div>}
    </section>
  );
}
export const Empty = ({ title = 'Nothing here', detail }) => <div className="empty-state"><Icon name="inbox" size={24} /><strong>{title}</strong>{detail && <p>{detail}</p>}</div>;
export const BackLink = ({ to, children }) => <button className="back-link" onClick={() => go(to)}><Icon name="back" size={13} /> {children}</button>;
export const Notice = ({ tone = 'amber', children }) => <div className={`notice ${tone}`}><Icon name="critical" size={14} /><span>{children}</span></div>;
export const FormError = ({ error }) => (error ? <div className="form-error" role="alert">{error.message || String(error)}</div> : null);

export function KpiStrip({ items }) {
  return <div className="kpi-strip">{items.map((k) => (
    <button key={k.label} className="kpi" onClick={() => (k.onClick ? k.onClick() : k.to && go(k.to))}>
      <span className={`kpi-icon ${k.tone}`}><Icon name={k.icon} size={17} /></span>
      <span className="kpi-copy"><span className="kpi-num">{k.value}</span><span className="kpi-lbl">{k.label}</span></span>
    </button>))}</div>;
}
export function Bars({ items, tone = 'blue', link }) {
  if (!items.length) return <p className="note">Nothing to plot yet.</p>;
  const max = Math.max(1, ...items.map((i) => i.n));
  return <div className="bars">{items.map((i) => {
    const El = link ? 'button' : 'div';
    return <El key={i.label} className="bar-row" type={link ? 'button' : undefined} onClick={link ? () => go(link(i)) : undefined}>
      <span className="bar-lab">{i.label}</span><span className="bar-track"><span className={`bar-fill ${tone}`} style={{ width: `${Math.max(8, Math.round((i.n / max) * 100))}%` }} /></span><span className="bar-n">{i.n}</span></El>;
  })}</div>;
}
export function Stepper({ status }) {
  const reached = FLOW.indexOf(status);
  return <div className="stepper">{FLOW.map((s, i) => <span key={s} className={`step ${i < reached ? 'done' : i === reached ? 'current' : ''}`}>{i < reached && <Icon name="check" size={11} />}{STATUS_LABEL[s]}</span>)}</div>;
}

// Same anatomy as SSIE's IPD patient banner: identity, UHID/admission, consultant, location, allergy, status.
export function PatientBanner({ o, status }) {
  const ipd = o.encounter_type === 'IPD';
  const allergic = o.allergy && o.allergy !== 'None recorded';
  return (
    <div className="patient-block"><div className="patient-strip">
      <div><span>Patient</span><strong>{o.patient_name || o.name}</strong><em>{ageOf(o.dob)}y · {o.sex} · DOB {fmtDate(o.dob)}</em></div>
      <div><span>UHID / {ipd ? 'Admission' : 'Visit'}</span><strong>{o.mrn}</strong><em>{o.encounter_ref}</em></div>
      <div><span>Consultant</span><strong>{o.consultant_name || '—'}</strong><em>{ENCOUNTER_LABEL[o.encounter_type] || o.encounter_type}{o.diagnosis ? ` · ${o.diagnosis}` : ''}</em></div>
      <div><span>Ward / Room / Bed</span><strong>{ipd ? `${o.ward || '—'} · ${o.room || '—'}` : 'Outpatient'}</strong><em>{ipd ? `Bed ${o.bed || '—'}` : 'No bed'}</em></div>
      <div><span>Allergy</span><strong className={allergic ? 'allergy' : ''}>{o.allergy}</strong></div>
      <div><span>Status</span>{status ? <StatusBadge status={status} /> : <strong>—</strong>}</div>
    </div></div>
  );
}

/* ---------- modal + toast ---------- */
export function Modal({ title, icon, onClose, children, foot, wide }) {
  useEffect(() => { const f = (e) => e.key === 'Escape' && onClose(); addEventListener('keydown', f); return () => removeEventListener('keydown', f); }, [onClose]);
  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal-shell${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{icon && <Icon name={icon} size={16} />}{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}
const toasts = new EventTarget();
export const toast = (message, error = false) => toasts.dispatchEvent(new CustomEvent('t', { detail: { message, error, id: Math.random() } }));
export function ToastHost() {
  const [list, setList] = useState([]);
  useEffect(() => {
    const on = (e) => { setList((l) => [...l, e.detail]); setTimeout(() => setList((l) => l.filter((x) => x.id !== e.detail.id)), 3800); };
    toasts.addEventListener('t', on); return () => toasts.removeEventListener('t', on);
  }, []);
  return <div className="toast-wrap">{list.map((t) => <div key={t.id} className={`toast${t.error ? ' err' : ''}`}><Icon name={t.error ? 'critical' : 'check'} size={15} /><span>{t.message}</span></div>)}</div>;
}

/* ---------- data helpers ---------- */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => live && setState({ loading: false, data, error: null }), (error) => live && setState({ loading: false, data: null, error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
export function useAction() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(null);
  const run = async (fn) => { setBusy(true); setError(null); try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setBusy(false); } };
  return { busy, error, run, setError };
}

// PKG-M5: live radiology load, so OPD/IPD can see traffic before sending a patient (not a page -- a strip of chips).
const LOAD_TONE = { Quiet: 'success', Busy: 'warning', 'Very busy': 'danger' };
const LOAD_MODALITY_LABEL = { MRI: 'MRI', CT: 'CT', XR: 'X-ray', DEXA: 'DEXA', USG: 'USG', OPEN_MRI: 'Open MRI' };
export function RadiologyLoadStrip() {
  const { data } = useLoad(() => api.get('/radiology/load'));
  if (!data) return null;
  return (
    <div className="chips">{data.map((m) => (
      <span key={m.modality} className={`status-badge ${LOAD_TONE[m.label] || 'neutral'}`}
        title={`${m.queued} queued, ${m.inProgress} on the table${m.overdue ? `, ${m.overdue} overdue` : ''}`}>
        <span className="dot" />{LOAD_MODALITY_LABEL[m.modality] || m.modality} · {m.label}
      </span>
    ))}</div>
  );
}

// Shared list of orders and open critical cases for the shell, dashboard, day board and queues.
export const DataContext = createContext({ orders: [], critical: [], reload: () => {}, loading: true });
export const useData = () => useContext(DataContext);

/* ---------- date tabs (Day / Week / Month / Custom), as in the agency lists ---------- */
export const dateQuery = (d) => (d.type === 'all' ? '' : d.type === 'custom' ? `&date_type=custom&start_date=${d.start}&end_date=${d.end}` : `&date_type=${d.type}&date=${d.date}`);
export const todayISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const defaultDates = () => ({ type: 'day', date: todayISO(), start: todayISO(), end: todayISO() });
export function DateTabs({ value, onChange }) {
  const t = (type, label) => <button key={type} className={`chip ${value.type === type ? 'on' : ''}`} onClick={() => onChange({ ...value, type })}>{label}</button>;
  return (
    <span className="row-gap">
      {[t('day', 'Day'), t('week', 'Week'), t('month', 'Month'), t('custom', 'Custom'), t('all', 'All')]}
      {value.type === 'custom' ? <><input type="date" className="inline-input" style={{ width: 140 }} value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} /><input type="date" className="inline-input" style={{ width: 140 }} value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} /></>
        : value.type !== 'all' && <input type="date" className="inline-input" style={{ width: 140 }} value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} />}
    </span>
  );
}

/* ---------- export: CSV (opens in Excel) and print-to-PDF ---------- */
export function exportCsv(rows, columns, name) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`; // neutralise spreadsheet formulas
  const csv = [columns.map((c) => q(c[0])).join(','), ...rows.map((r) => columns.map((c) => q(c[1](r))).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.csv` }); a.click(); URL.revokeObjectURL(url);
}
export function printRows(rows, columns, title) {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const w = window.open(); if (!w) return toast('Allow pop-ups to print', true);
  w.document.write(`<!doctype html><title>${esc(title)}</title><style>body{font:12px system-ui;margin:16px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left}th{background:#f1f5f9}</style><h2>${esc(title)}</h2><table><tr>${columns.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(c[1](r))}</td>`).join('')}</tr>`).join('')}</table><script>print()</script>`);
  w.document.close();
}
export const ExportButtons = ({ rows, columns, name }) => (
  <span className="row-gap"><button className="btn btn-light btn-sm" disabled={!rows.length} onClick={() => exportCsv(rows, columns, name)}>Export Excel (CSV)</button><button className="btn btn-light btn-sm" disabled={!rows.length} onClick={() => printRows(rows, columns, name)}>Print / PDF</button></span>
);
