import { useState } from 'react';
import { api } from '../api.js';
import { BackLink, Card, Empty, ENCOUNTER_LABEL, FormError, PageHeader, StatusBadge, fmt, go, inr, useLoad } from '../ui.jsx';

const MODULES = [['patientInfo', 'Patient information'], ['words', "Patient's words"], ['pastHistory', 'Past history'], ['consent', 'Consent screening'], ['orders', 'Radiology orders'], ['reports', 'Reports']];

export default function Summary({ id }) {
  const { data: s, error } = useLoad(() => api.get(`/visits/${id}/summary`), [id]);
  const [inc, setInc] = useState({ patientInfo: true, pastHistory: true, words: false, consent: false, orders: false, reports: false });
  if (error) return <><BackLink to="/orders">Imaging orders</BackLink><FormError error={error} /></>;
  if (!s) return <div className="empty-state">Loading…</div>;
  const print = async () => { const modules = MODULES.map(([k]) => k).filter((k) => inc[k]).join(','); const html = await api.html(`/visits/${id}/summary-print?modules=${modules}`); const w = window.open(); if (w) { w.document.write(html); w.document.close(); } };
  return (
    <>
      <BackLink to={`/patient/${s.patient.id}`}>Patient chart</BackLink>
      <PageHeader title="Visit summary" subtitle={`${s.patient.name} · ${s.encounter.ref_no}. Tick the sections to include, then print or save as PDF.`} actions={<button className="btn btn-primary" onClick={print}>Download PDF</button>} />
      <div className="grid-2 summary-layout">
        <Card title="Include in PDF" icon="report">{MODULES.map(([k, l]) => <label className="check-row" key={k}><input type="checkbox" checked={inc[k]} onChange={(e) => setInc({ ...inc, [k]: e.target.checked })} /><span>{l}</span></label>)}</Card>
        <div>
          <Card title="Patient information" icon="patients"><dl className="defs"><div><dt>Patient</dt><dd>{s.patient.name} · {s.patient.mrn}</dd></div><div><dt>Born</dt><dd>{s.patient.dob} · {s.patient.sex}</dd></div><div><dt>Visit</dt><dd>{s.encounter.ref_no} ({ENCOUNTER_LABEL[s.encounter.type] || s.encounter.type})</dd></div><div><dt>Allergy</dt><dd className={s.patient.allergy !== 'None recorded' ? 'allergy-text' : ''}>{s.patient.allergy}</dd></div></dl></Card>
          <Card title="Patient's words" icon="inbox">{s.words ? <><p style={{ margin: 0 }}>{s.words.text}</p><small className="table-sub">{s.words.created_by_name} · {fmt(s.words.created_at)}</small></> : <Empty title="Nothing recorded" />}</Card>
          <Card title="Past history" icon="timeline">{s.pastHistory ? <ul className="mini-list">{s.pastHistory.diseases.map((d) => <li key={d.disease}><strong>{d.disease}{d.year ? ` since ${d.year}` : ''}{d.condition ? ` · ${d.condition}` : ''}</strong>{d.medicines.length > 0 && <span>{d.medicines.join(', ')}</span>}</li>)}
            {s.pastHistory.surgeries.map((x, i) => <li key={i}><strong>Surgery: {x.other ? x.otherName : x.description}</strong><span>{x.year || ''} · {x.where}</span></li>)}</ul> : <Empty title="Not recorded" />}</Card>
          <Card title="Radiology orders" icon="orders" flush><table className="clinical-table compact"><thead><tr><th>Scan</th><th>Status</th><th className="n">Amount</th></tr></thead><tbody>{s.orders.map((o) => <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => go(`/order/${o.id}`)}><td><b>{o.exam_name}</b>{o.side ? ` (${o.side})` : ''}{o.report && <span className="table-sub">Impression: {o.report.impression}</span>}</td><td><StatusBadge status={o.status} /></td><td className="mono n">{inr(o.final_amount)}</td></tr>)}</tbody></table></Card>
        </div>
      </div>
    </>
  );
}
