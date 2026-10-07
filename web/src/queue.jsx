import { useState } from 'react';
import { api } from './api.js';
import { Badge, Empty, ENCOUNTER_LABEL, Icon, Modal, PriorityBadge, RADIOLOGY, StatusBadge, fmt, go, toast, useAction, useData, visitId } from './ui.jsx';

/** The one action this person should take next on this order. No manual time booking — queue is automatic. */
export function nextAction(o, user, criticalOpen) {
  const staff = RADIOLOGY.includes(user.role); const acq = ['technologist', 'radiologist'].includes(user.role);
  if (staff && (o.status === 'REQUESTED' || o.status === 'ACKNOWLEDGED')) return { key: 'requeue', label: 'Issue token' };
  if (staff && o.status === 'NO_SHOW') return { key: 'requeue', label: 'Back in queue' };
  if (staff && o.status === 'SCHEDULED') return { key: 'arrival', label: 'Arrival' };
  if (acq && o.status === 'ARRIVED') return { key: 'consent', label: 'Consent' };
  if (acq && o.status === 'PREPARED') return { key: 'start', label: 'Start' };
  if (acq && o.status === 'IN_PROGRESS') return { key: 'complete', label: 'Complete' };
  if (user.role === 'radiologist' && ['COMPLETED', 'REPORT_DRAFTED'].includes(o.status)) return { key: 'report', label: o.status === 'REPORT_DRAFTED' ? 'Continue report' : 'Report' };
  if (['reception', 'radiologist'].includes(user.role) && o.status === 'REPORTED') {
    return { key: 'dispatch', label: o.report_handover === 'CONSULTANT' ? 'To consultant' : o.report_handover === 'WARD' ? 'To ward' : 'Dispatch' };
  }
  if (['reception', 'radiologist'].includes(user.role) && o.status === 'DISPATCHED') return { key: 'collect', label: 'Collected' };
  if (criticalOpen && ['radiologist', 'clinician', 'nurse'].includes(user.role)) return { key: 'critical', label: 'Critical', danger: true };
  return { key: 'open', label: 'Open' };
}

// Always sends the revision the screen was showing, so a move made from a stale screen is refused instead of overwriting someone else's change.
export function useMove() {
  const { reload } = useData();
  return async (order, to, extra = {}) => {
    try { await api.post(`/orders/${order.id}/transition`, { to, expectedRevision: order.revision, ...extra }); toast(`Order ${to.toLowerCase().replace('_', ' ')}`); reload(); return true; }
    catch (e) {
      if (e.code === 'STALE_REVISION') { toast('This order was changed by someone else. The list has been refreshed; check it and try again.', true); reload(); return false; }
      toast(e.message, true); if (e.code === 'SAFETY_CHECK_REQUIRED' || e.code === 'PAYMENT_REQUIRED') go(`/order/${order.id}`); return false;
    }
  };
}

export async function requeue(order) {
  const r = await api.post(`/orders/${order.id}/requeue`, {});
  toast(`Token ${r.token_no} · ETA ${fmt(r.eta_at)}`);
  return r;
}

// Two-identifier check before the patient goes in, as in the SSIE flow.
export function ArrivalModal({ order, onClose }) {
  const move = useMove(); const [ok, setOk] = useState(false); const a = useAction();
  return (
    <Modal title="Verify arrival" icon="user" onClose={onClose}
      foot={<><button className="btn btn-light" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!ok || a.busy} onClick={() => a.run(async () => { if (await move(order, 'ARRIVED', { note: 'Identity verified: OPD/IPD ID and date of birth' })) onClose(); })}>Patient has arrived</button></>}>
      <div className="confirm-line"><Icon name="critical" size={14} />Ask the patient to state their name and date of birth. Do not read them out.</div>
      {order.token_no && <p className="note" style={{ marginTop: 0 }}>Token <b>{order.token_no}</b>{order.eta_at ? ` · waiting estimate ${fmt(order.eta_at)}` : ''} (estimate only — queue moves with load)</p>}
      <dl className="defs"><div><dt>Name</dt><dd>{order.patient_name}</dd></div><div><dt>OPD / IPD ID</dt><dd>{order.mrn}</dd></div><div><dt>Date of birth</dt><dd>{order.dob}</dd></div><div><dt>Allergy</dt><dd className={order.allergy !== 'None recorded' ? 'allergy-text' : ''}>{order.allergy}</dd></div></dl>
      <label className="check-row"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /><span>OPD/IPD ID and date of birth match what the patient told me</span></label>
    </Modal>
  );
}

export function RowActions({ o, user, primaryOnly }) {
  const { critical, reload } = useData(); const move = useMove(); const [modal, setModal] = useState(null); const a = useAction();
  const open = critical.some((c) => c.order_id === o.id && ['OPEN', 'ESCALATED'].includes(c.state));
  const act = nextAction(o, user, open);
  const run = () => {
    if (act.key === 'requeue') return a.run(async () => { await requeue(o); reload(); });
    if (act.key === 'start') return move(o, 'IN_PROGRESS');
    if (act.key === 'consent') return go(`/order/${o.id}/scanconsent`);
    if (act.key === 'dispatch') return move(o, 'DISPATCHED', { note: 'Report handed over' });
    if (act.key === 'collect') return move(o, 'COLLECTED', { note: 'Collected by patient' });
    if (act.key === 'complete') return move(o, 'COMPLETED');
    if (act.key === 'arrival') return setModal('arrival');
    if (act.key === 'report') return go(`/order/${o.id}/report`);
    if (act.key === 'critical') return go('/critical');
    return go(`/order/${o.id}`);
  };
  return (
    <div className="row-actions" onClick={(e) => e.stopPropagation()}>
      <button className={act.danger ? 'danger' : act.key === 'open' ? '' : 'primary'} disabled={a.busy} onClick={run}>{act.label}</button>
      {!primaryOnly && act.key !== 'open' && <button onClick={() => go(`/order/${o.id}`)}>Open</button>}
      {modal === 'arrival' && <ArrivalModal order={o} onClose={() => setModal(null)} />}
    </div>
  );
}

export function PatientCell({ o }) {
  return <button className="patient-link" onClick={(e) => { e.stopPropagation(); go(`/patient/${o.patient_id}`); }}><strong>{o.patient_name}</strong><span>{visitId(o)} · {ENCOUNTER_LABEL[o.encounter_type] || o.encounter_type}{o.ward ? ` ${o.ward}` : ''}</span></button>;
}

export function QueueTable({ rows, user, compact, emptyTitle, emptyDetail }) {
  const { critical } = useData();
  if (!rows.length) return <Empty title={emptyTitle || 'No studies here'} detail={emptyDetail} />;
  return (
    <div className="table-scroll"><table className={`clinical-table queue${compact ? ' compact' : ''}`}>
      <thead><tr><th>Patient / ID</th><th>Study</th><th>Priority / status</th><th>Queue</th><th className="col-action">Action</th></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id} className={o.overdue ? 'late-mark' : ''}>
          <td><PatientCell o={o} /></td>
          <td><strong>{o.exam_name}</strong><span className="table-sub">{o.modality} · {o.requested_by_name}{o.token_no ? ` · ${o.token_no}` : ''}</span></td>
          <td><div className="cell-flags"><PriorityBadge priority={o.priority} /><StatusBadge status={o.status} />{critical.some((c) => c.order_id === o.id && ['OPEN', 'ESCALATED'].includes(c.state)) && <Badge tone="danger">Critical</Badge>}</div></td>
          <td>{o.token_no || o.eta_at ? <div className="cell-when">
            {o.token_no && <span className="mono">{o.token_no}</span>}
            {o.eta_at && ['SCHEDULED', 'ARRIVED', 'NO_SHOW'].includes(o.status)
              ? <span className="table-sub">est. {fmt(o.eta_at)}</span>
              : o.minutes_to_due == null ? null
              : o.overdue ? <span className="mono" style={{ color: 'var(--danger)' }}>{Math.abs(o.minutes_to_due)} min overdue</span>
              : <span className="table-sub">report due {fmt(o.due_at)}</span>}
          </div> : o.minutes_to_due == null ? <span className="muted-cell">—</span>
            : o.overdue ? <div className="cell-when"><span className="mono" style={{ color: 'var(--danger)' }}>{Math.abs(o.minutes_to_due)} min overdue</span></div>
            : <div className="cell-when"><span className="mono">{fmt(o.due_at)}</span><span className="table-sub">report due</span></div>}</td>
          <td className="col-action"><RowActions o={o} user={user} primaryOnly={compact} /></td>
        </tr>))}</tbody></table></div>
  );
}

export function FilterTools({ f, set, staff, modalities }) {
  return (
    <>
      <label className="search-box"><Icon name="search" size={14} /><input placeholder="Search patient, OPD/IPD ID or accession" value={f.q} onChange={(e) => set({ ...f, q: e.target.value })} /></label>
      <select className={f.priority ? 'on' : ''} value={f.priority} onChange={(e) => set({ ...f, priority: e.target.value })}><option value="">Priority</option><option>STAT</option><option>URGENT</option><option>ROUTINE</option></select>
      <select className={f.modality ? 'on' : ''} value={f.modality} onChange={(e) => set({ ...f, modality: e.target.value })}><option value="">Modality</option>{modalities.map((m) => <option key={m}>{m}</option>)}</select>
      {staff && <select className={f.source ? 'on' : ''} value={f.source} onChange={(e) => set({ ...f, source: e.target.value })}><option value="">Encounter</option><option value="OPD">OPD</option><option value="IPD">IPD</option><option value="OT">OT</option><option value="EXTERNAL">{ENCOUNTER_LABEL.EXTERNAL}</option></select>}
      {(f.q || f.priority || f.modality || f.source) && <button className="filter-reset" onClick={() => set({ q: '', priority: '', modality: '', source: '' })}>Clear</button>}
    </>
  );
}
export const emptyFilter = { q: '', priority: '', modality: '', source: '' };
export const applyFilter = (rows, f) => rows.filter((o) =>
  (!f.priority || o.priority === f.priority) && (!f.modality || o.modality === f.modality) && (!f.source || o.encounter_type === f.source) &&
  (!f.q || `${o.patient_name} ${o.mrn} ${o.accession}`.toLowerCase().includes(f.q.toLowerCase())));
