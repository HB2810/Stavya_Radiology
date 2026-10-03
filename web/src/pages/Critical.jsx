import { useState } from 'react';
import { api } from '../api.js';
import { Card, Empty, PageHeader, go, useData, useLoad } from '../ui.jsx';
import { CriticalCase } from './Order.jsx';

export default function Critical({ user }) {
  const { critical, reload } = useData(); const [state, setState] = useState('');
  const rows = critical.filter((c) => !state || c.state === state);
  const detail = useLoad(() => Promise.all(rows.map((c) => api.get('/orders/' + c.order_id).then((d) => [c.id, d.critical.find((x) => x.id === c.id)]))), [rows.map((c) => c.id + c.state).join()]);
  const byId = Object.fromEntries(detail.data || []);
  return (
    <>
      <PageHeader title="Critical findings" subtitle="Results that need a named person, a read-back and an action plan, with nothing closed silently." />
      <Card title="Cases" icon="critical" count={rows.length} tone={rows.some((c) => ['OPEN', 'ESCALATED'].includes(c.state)) ? 'red' : 'green'}
        tools={<select className={state ? 'on' : ''} value={state} onChange={(e) => setState(e.target.value)}><option value="">All states</option><option>OPEN</option><option>ESCALATED</option><option>COMMUNICATED</option><option>ACKNOWLEDGED</option></select>}>
        {rows.length ? rows.map((c) => (
          <div key={c.id} style={{ marginBottom: 14 }}>
            <button className="patient-link" onClick={() => go(`/order/${c.order_id}`)} style={{ marginBottom: 6 }}><strong>{c.patient_name}</strong><span>{c.mrn} · {c.exam_name} · {c.accession}{c.ward ? ` · ${c.ward}` : ''}</span></button>
            {byId[c.id] ? <CriticalCase c={byId[c.id]} user={user} reload={() => { reload(); detail.reload(); }} /> : <p className="note">Loading…</p>}
          </div>)) : <Empty title="No critical findings" />}
      </Card>
    </>
  );
}
