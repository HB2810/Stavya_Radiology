import { Badge, Card, CountChip, ENCOUNTER_LABEL, PageHeader, PriorityBadge, StatusBadge, go, useData } from '../ui.jsx';
import { RowActions } from '../queue.jsx';

export default function DayBoard({ user }) {
  const { orders, critical } = useData();
  const by = (...s) => orders.filter((o) => s.includes(o.status));
  const cols = [
    ['Waiting', by('REQUESTED', 'ACKNOWLEDGED')], ['Scheduled', by('SCHEDULED', 'ARRIVED', 'PREPARED', 'NO_SHOW')], ['In room', by('IN_PROGRESS')],
    ['Reporting', by('COMPLETED', 'REPORT_DRAFTED')], ['Closed loop', by('REPORTED', 'DISPATCHED', 'COLLECTED').slice(0, 12)]
  ];
  return (
    <>
      <PageHeader title="Day board" />
      <div className="kanban">{cols.map(([title, rows]) => (
        <section className="kanban-col" key={title}>
          <header><h3>{title}</h3><CountChip n={rows.length} tone={rows.length ? 'neutral' : 'green'} /></header>
          <div className="kanban-list">{rows.map((o) => (
            <article className="kanban-card" key={o.id}>
              <button className="patient-link" onClick={() => go(`/patient/${o.patient_id}`)}><strong>{o.patient_name}</strong><span>{o.mrn} · {ENCOUNTER_LABEL[o.encounter_type] || o.encounter_type}{o.ward ? ` ${o.ward}` : ''}</span></button>
              <p>{o.exam_name}</p>
              <div className="cell-flags"><PriorityBadge priority={o.priority} /><StatusBadge status={o.status} />{critical.some((c) => c.order_id === o.id && c.state !== 'ACKNOWLEDGED') && <Badge tone="danger">Critical</Badge>}</div>
              <RowActions o={o} user={user} primaryOnly />
            </article>))}{!rows.length && <p className="note">Clear</p>}</div>
        </section>))}</div>
    </>
  );
}
