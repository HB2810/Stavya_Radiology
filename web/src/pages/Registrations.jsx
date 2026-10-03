import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, DateTabs, Empty, ExportButtons, Icon, KpiStrip, PageHeader, StatusBadge, dateQuery, defaultDates, fmt, go, inr, useLoad } from '../ui.jsx';

const PAY_TONE = { paid: 'success', partial: 'warning', pending: 'danger' };
const TILES = [['all', 'Total', 'total_radiology_order', 'orders', 'blue'], ['dexa', 'DEXA', 'total_dexa', 'scan', 'violet'], ['mri', 'MRI', 'total_mri', 'scan', 'blue'], ['open_mri', 'Open MRI', 'total_open_mri', 'scan', 'blue'],
  ['xray', 'X-Ray', 'total_xray', 'scan', 'amber'], ['sonography', 'Sonography', 'total_sonography', 'scan', 'green'], ['ct_scan', 'CT Scan', 'total_ct_scan', 'scan', 'slate']];

export function useTiles(dates, equipment, setEquipment) {
  const s = useLoad(() => api.get('/dashboard/summary?x=1' + dateQuery(dates) + (equipment !== 'all' ? `&equipment=${equipment}` : '')), [JSON.stringify(dates), equipment]);
  const strip = <KpiStrip items={TILES.map(([k, label, key, icon, tone]) => ({ label: `${label}${equipment === k ? ' ✓' : ''}`, value: s.data?.[key] ?? '—', tone, icon, to: null, onClick: () => setEquipment(equipment === k ? 'all' : k) }))} />;
  return { summary: s.data, strip };
}

export default function Registrations({ user }) {
  const [dates, setDates] = useState(defaultDates()); const [q, setQ] = useState(''); const [field, setField] = useState('all'); const [pay, setPay] = useState(''); const [equipment, setEquipment] = useState('all'); const [per, setPer] = useState(30); const [page, setPage] = useState(1);
  const { data, loading } = useLoad(() => api.get(`/registrations?x=1${dateQuery(dates)}&equipment=${equipment}&field=${field}&q=${encodeURIComponent(q)}${pay ? `&payment_status=${pay}` : ''}`), [JSON.stringify(dates), q, field, pay, equipment]);
  const { strip } = useTiles(dates, equipment, (e) => { setEquipment(e); setPage(1); });
  const rows = data || []; const pages = Math.max(1, Math.ceil(rows.length / per)); const shown = rows.slice((page - 1) * per, page * per);
  const cols = [['Reg no', (r) => r.reg_no], ['Date', (r) => r.created_at.slice(0, 10)], ['Patient', (r) => r.patient.name], ['UHID', (r) => r.patient.mrn], ['Phone', (r) => r.patient.phone], ['Doctor', (r) => r.referring_doctor],
    ['Scans', (r) => r.exams.join('; ')], ['Total', (r) => r.final_total], ['Paid', (r) => r.paid_amount], ['Pending', (r) => r.pending_amount], ['Payment', (r) => r.payment_status]];
  return (
    <>
      <PageHeader title="Registrations" subtitle="Every walk-in registration with its bill. Open one to take payment, edit the invoice or request a refund." actions={<button className="btn btn-primary" onClick={() => go('/register')}><Icon name="plus" size={14} /> Add new registration</button>} />
      {strip}
      <Card title="Registration list" icon="orders" count={rows.length} flush
        tools={<><DateTabs value={dates} onChange={(d) => { setDates(d); setPage(1); }} />
          <select value={field} onChange={(e) => setField(e.target.value)}><option value="all">All</option><option value="patient_name">Patient name</option><option value="doctor_name">Doctor name</option></select>
          <label className="search-box"><Icon name="search" size={14} /><input placeholder="Search" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></label>
          <select className={pay ? 'on' : ''} value={pay} onChange={(e) => setPay(e.target.value)}><option value="">Payment</option><option value="pending">Pending</option><option value="partial">Partial</option><option value="paid">Paid</option></select>
          <span style={{ marginLeft: 'auto' }}><ExportButtons rows={rows} columns={cols} name="RadiologyRegistrationData" /></span></>}
        foot={<span className="row-gap">Rows per page <select className="inline-input" style={{ width: 70 }} value={per} onChange={(e) => { setPer(Number(e.target.value)); setPage(1); }}>{[30, 50, 100].map((n) => <option key={n}>{n}</option>)}</select>
          <button className="btn btn-light btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button> Page {page} of {pages} <button className="btn btn-light btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></span>}>
        {shown.length ? <div className="table-scroll"><table className="clinical-table"><thead><tr><th>#</th><th>Radiology ID</th><th>Date</th><th>Patient</th><th>Phone</th><th>Doctor</th><th>Doctor suggestion</th><th className="n">Total</th><th className="n">Paid</th><th className="n">Pending</th><th>Payment</th><th className="col-action">Action</th></tr></thead>
          <tbody>{shown.map((r, i) => (
            <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => go(`/registration/${r.id}`)}>
              <td className="mono">{(page - 1) * per + i + 1}</td><td className="mono">{r.reg_no}{r.status === 'CANCELLED' && <Badge tone="neutral">Cancelled</Badge>}</td><td className="mono">{fmt(r.created_at)}</td>
              <td><span className="patient-link"><strong>{r.patient.name}</strong><span>{r.patient.mrn}</span></span></td><td className="mono">{r.patient.phone}</td><td>{r.referring_doctor || '—'}</td>
              <td>{r.suggestions.map((s) => <div key={s} className="table-sub">{s}</div>)}</td>
              <td className="mono n">{inr(r.final_total)}</td><td className="mono n">{inr(r.paid_amount)}</td><td className="mono n">{inr(r.pending_amount)}</td>
              <td><Badge tone={PAY_TONE[r.payment_status]}>{r.payment_status}</Badge>{r.cheque_in_process > 0 && <div className="table-sub">cheque in process</div>}</td>
              <td className="col-action" onClick={(e) => e.stopPropagation()}><div className="row-actions">{r.payment_status !== 'paid' && r.status === 'ACTIVE' && <button className="primary" onClick={() => go(`/registration/${r.id}/pay`)}>Pay now</button>}<button onClick={() => go(`/registration/${r.id}`)}>Invoice</button></div></td></tr>))}</tbody></table></div>
          : <Empty title={loading ? 'Loading…' : 'No registrations'} detail="Change the date range or clear the filters." />}
      </Card>
    </>
  );
}
