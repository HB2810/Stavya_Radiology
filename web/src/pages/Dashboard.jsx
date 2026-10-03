import { useState } from 'react';
import { Bars, Card, CountChip, ENCOUNTER_LABEL, Icon, KpiStrip, PageHeader, PatientBanner, RADIOLOGY, RadiologyLoadStrip, initials, go, isToday, useData, Empty } from '../ui.jsx';
import { FilterTools, QueueTable, RowActions, applyFilter, emptyFilter, nextAction } from '../queue.jsx';

const OPEN = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW', 'ARRIVED', 'PREPARED', 'IN_PROGRESS', 'COMPLETED', 'REPORT_DRAFTED'];
const tally = (rows, key) => Object.entries(rows.reduce((m, o) => ((m[o[key]] = (m[o[key]] || 0) + 1), m), {})).map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);

export default function Dashboard({ user }) {
  const { orders, critical, loading } = useData(); const [f, setF] = useState(emptyFilter);
  const staff = RADIOLOGY.includes(user.role);
  const open = orders.filter((o) => OPEN.includes(o.status));
  const has = (...s) => open.filter((o) => s.includes(o.status));
  const crit = critical.filter((c) => ['OPEN', 'ESCALATED'].includes(c.state));
  const kpis = [
    { label: 'Patients in flow', value: new Set(open.map((o) => o.patient_id)).size, tone: 'slate', icon: 'patients', to: '/patients' },
    { label: 'Waiting on radiology', value: has('REQUESTED', 'ACKNOWLEDGED').length, tone: 'amber', icon: 'orders', to: '/orders?f=pending' },
    { label: 'On the table', value: has('IN_PROGRESS').length, tone: 'violet', icon: 'play', to: '/orders?f=inprogress' },
    { label: 'Awaiting report', value: has('COMPLETED', 'REPORT_DRAFTED').length, tone: 'amber', icon: 'report', to: user.role === 'radiologist' ? '/reporting' : '/orders?f=reporting' },
    { label: 'Open critical', value: crit.length, tone: 'red', icon: 'critical', to: '/critical' },
    { label: "Today's studies", value: orders.filter((o) => isToday(o.scheduled_at) || isToday(o.created_at)).length, tone: 'blue', icon: 'clock', to: '/orders?f=today' }
  ];
  const critIds = new Set(crit.map((c) => c.order_id));
  const rec = open.find((o) => nextAction(o, user, critIds.has(o.id)).key !== 'open') || open[0];
  const act = rec && nextAction(rec, user, critIds.has(rec.id));
  const queue = applyFilter(open, f);
  const alerts = [
    ...crit.map((c) => ({ tone: 'red', icon: 'critical', title: `Critical: ${c.patient_name}`, detail: `${c.summary} — ${c.state.toLowerCase()}`, to: '/critical' })),
    ...open.filter((o) => o.overdue).slice(0, 6).map((o) => ({ tone: 'red', icon: 'clock', title: `Overdue: ${o.patient_name}`, detail: `${o.exam_name} · ${o.priority}, ${Math.abs(o.minutes_to_due)} min past report target`, to: `/order/${o.id}` })),
    ...open.filter((o) => o.priority === 'STAT' && !o.overdue).slice(0, 4).map((o) => ({ tone: 'amber', icon: 'play', title: `STAT: ${o.patient_name}`, detail: `${o.exam_name} · ${o.status.toLowerCase().replace('_', ' ')}`, to: `/order/${o.id}` }))
  ];
  return (
    <>
      <PageHeader title={staff ? 'Radiology command centre' : 'Your patients in radiology'} subtitle={staff ? undefined : 'Every imaging request, report and critical finding for the patients you look after.'}
        actions={['clinician', 'nurse', 'reception', 'radiologist'].includes(user.role) && <button className="btn btn-primary" onClick={() => go('/new')}><Icon name="plus" size={14} /> New request</button>} />
      {['clinician', 'nurse'].includes(user.role) && <RadiologyLoadStrip />}
      <KpiStrip items={kpis} />
      {rec && (
        <article className="smart-card"><div className="smart-row">
          <button className="avatar lg" onClick={() => go(`/patient/${rec.patient_id}`)}>{initials(rec.patient_name)}</button>
          <div className="smart-copy"><h2>Next: {rec.patient_name}</h2>
            <p>{rec.mrn} · {rec.exam_name} · {rec.priority} · {ENCOUNTER_LABEL[rec.encounter_type] || rec.encounter_type}{rec.ward ? ` ${rec.ward}` : ''}</p>
            <p className="smart-why">{rec.overdue ? `Report target missed by ${Math.abs(rec.minutes_to_due)} min.` : rec.clinical_indication}</p></div>
          <div className="smart-acts"><RowActions o={rec} user={user} primaryOnly /><button className="btn btn-light" onClick={() => go(`/order/${rec.id}`)}>Open workspace</button></div>
        </div></article>)}
      <div className="dash-grid">
        <div className="dash-main">
          <Card title="Patients in the work queue" icon="worklist" count={queue.length} tone="neutral" flush
            tools={<FilterTools f={f} set={setF} staff={staff} modalities={[...new Set(orders.map((o) => o.modality))].sort()} />}
            foot="Finalised studies are hidden here. Use the search in the header to jump to any patient.">
            {loading ? <Empty title="Loading…" /> : <QueueTable rows={queue} user={user} compact emptyTitle="No open studies match this filter" emptyDetail="Clear the filters to see everything in flow." />}
          </Card>
        </div>
        <aside className="dash-side">
          <Card title="Live mix" icon="scan" subtitle="Open studies right now.">
            <p className="chart-title">By modality</p><Bars items={tally(open, 'modality')} link={() => '/orders'} />
            <p className="chart-title">By encounter</p><Bars items={tally(open.map((o) => ({ e: ENCOUNTER_LABEL[o.encounter_type] || o.encounter_type })), 'e')} tone="violet" />
          </Card>
          <Card title="What still needs a person" icon="critical" count={alerts.length} tone={alerts.length ? 'red' : 'green'}>
            {alerts.length ? <div className="alert-list">{alerts.slice(0, 12).map((a, i) => (
              <button key={i} className={`alert-card ${a.tone}`} onClick={() => go(a.to)}><span className="alert-icon"><Icon name={a.icon} size={14} /></span><span className="alert-body"><strong>{a.title}</strong><small>{a.detail}</small></span></button>))}</div>
              : <div className="empty-state"><Icon name="check" size={24} /><strong>Nothing outstanding</strong><p>No critical result, overdue report or STAT study is waiting.</p></div>}
          </Card>
        </aside>
      </div>
    </>
  );
}
