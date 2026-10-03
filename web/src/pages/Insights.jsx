import { useState } from 'react';
import { api } from '../api.js';
import { Bars, Card, ENCOUNTER_LABEL, FormError, KpiStrip, PageHeader, useLoad } from '../ui.jsx';

const hm = (m) => (m == null ? '—' : m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`);
const items = (o) => Object.entries(o || {}).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);

export default function Insights() {
  const [days, setDays] = useState(30);
  const { data: s, error } = useLoad(() => api.get('/analytics/summary?days=' + days), [days]);
  if (error) return <FormError error={error} />;
  if (!s) return <div className="empty-state">Loading…</div>;
  return (
    <>
      <PageHeader title="Insights" subtitle="Turnaround, backlog and critical-result performance for the department." actions={<select className="inline-input" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(Number(e.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>} />
      <KpiStrip items={[
        { label: 'Orders', value: s.total, tone: 'blue', icon: 'orders' }, { label: 'Active backlog', value: s.backlog, tone: 'amber', icon: 'clock' },
        { label: 'Overdue', value: s.overdue, tone: s.overdue ? 'red' : 'green', icon: 'critical' }, { label: 'Reports on time', value: s.slaMet == null ? '—' : `${s.slaMet}%`, tone: 'green', icon: 'check' },
        { label: 'Request → report', value: hm(s.medianMinutes.requestToReport), tone: 'violet', icon: 'report' }, { label: 'Critical → told', value: hm(s.critical.medianMinutesToCommunicate), tone: 'red', icon: 'phone' }]} />
      <Card title="Daily traffic" icon="orders" subtitle="New scan requests per day by where they came from." foot="Each bar is one day.">
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 150 }}>
          {s.perDay.map((d) => { const max = Math.max(1, ...s.perDay.map((x) => x.n)); const h = (v) => `${(v / max) * 130}px`;
            return <div key={d.date} title={`${d.date}: OPD ${d.OPD}, IPD ${d.IPD}, OT ${d.OT}, Outside ${d.EXTERNAL}`} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 2 }}>
              <small style={{ fontSize: 10, fontWeight: 700 }}>{d.n}</small>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column-reverse', borderRadius: 4, overflow: 'hidden' }}><span style={{ height: h(d.OPD), background: 'var(--blue)' }} /><span style={{ height: h(d.IPD), background: 'var(--violet)' }} /><span style={{ height: h(d.OT), background: 'var(--warning)' }} /><span style={{ height: h(d.EXTERNAL), background: 'var(--success)' }} /></div>
              <small style={{ fontSize: 9.5, color: 'var(--muted)' }}>{d.date.slice(8)}</small></div>; })}
        </div>
        <div className="row-gap" style={{ marginTop: 8, fontSize: 11 }}><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--blue)', borderRadius: 2 }} /> OPD</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--violet)', borderRadius: 2 }} /> IPD</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--warning)', borderRadius: 2 }} /> OT</span><span><i style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--success)', borderRadius: 2 }} /> Outside / Walk-in</span></div>
      </Card>
      <div className="grid-2">
        <Card title="By encounter" icon="patients"><Bars items={items(s.bySource).map((i) => ({ ...i, label: ENCOUNTER_LABEL[i.label] || i.label }))} /></Card><Card title="By priority" icon="critical"><Bars items={items(s.byPriority)} tone="amber" /></Card>
        <Card title="By modality" icon="scan"><Bars items={items(s.byModality)} /></Card><Card title="By status" icon="worklist"><Bars items={items(s.byStatus)} tone="violet" /></Card>
      </div>
    </>
  );
}
