import { useState } from 'react';
import { api } from '../api.js';
import { Card, DateTabs, ExportButtons, Icon, KpiStrip, PageHeader, RADIOLOGY, STATUS_LABEL, dateQuery, defaultDates, fmt, go, isToday, useData, useLoad } from '../ui.jsx';
import { FilterTools, QueueTable, applyFilter, emptyFilter } from '../queue.jsx';
import { useTiles } from './Registrations.jsx';

const FILTERS = {
  pending: ['Waiting on radiology', (o) => ['REQUESTED', 'ACKNOWLEDGED'].includes(o.status)],
  inprogress: ['On the table', (o) => o.status === 'IN_PROGRESS'],
  reporting: ['Awaiting report', (o) => ['COMPLETED', 'REPORT_DRAFTED'].includes(o.status)],
  today: ["Today's studies", (o) => isToday(o.scheduled_at) || isToday(o.created_at)],
  finalised: ['Finalised', (o) => ['REPORTED', 'DISPATCHED', 'COLLECTED'].includes(o.status)],
  active: ['Open studies', (o) => !['REPORTED', 'DISPATCHED', 'COLLECTED', 'CANCELLED'].includes(o.status)],
  all: ['All studies', () => true]
};
const COLUMNS = [['Order', (o) => o.accession], ['Date', (o) => o.created_at.slice(0, 10)], ['Patient', (o) => o.patient_name], ['UHID', (o) => o.mrn], ['Doctor', (o) => o.referring_doctor || o.requested_by_name], ['Scan', (o) => o.exam_name + (o.side ? ` (${o.side})` : '')],
  ['Type', (o) => o.encounter_type], ['Priority', (o) => o.priority], ['Status', (o) => STATUS_LABEL[o.status]], ['Amount', (o) => o.final_amount]];

export function Orders({ user, filter }) {
  const { orders: ctx } = useData(); const ver = ctx.map((o) => o.id + o.status).join();
  const [dates, setDates] = useState({ ...defaultDates(), type: 'all' }); const [equipment, setEquipment] = useState('all'); const [f, setF] = useState(emptyFilter);
  const list = useLoad(() => api.get(`/orders?x=1${dateQuery(dates)}${equipment !== 'all' ? `&equipment=${equipment}` : ''}`), [JSON.stringify(dates), equipment, ver]);
  const { strip } = useTiles(dates, equipment, setEquipment);
  const staff = RADIOLOGY.includes(user.role); const key = FILTERS[filter] ? filter : 'all';
  const rows = applyFilter((list.data || []).filter(FILTERS[key][1]), f);
  return (
    <>
      <PageHeader title={staff ? 'Imaging orders' : 'Your imaging requests'} subtitle={staff ? 'Every scan from OPD, IPD and walk-in registration, with its priority and status. Click a modality to filter.' : 'Requests you made or that concern patients under your care.'}
        actions={['clinician', 'nurse', 'reception', 'radiologist'].includes(user.role) && <button className="btn btn-primary" onClick={() => go('/new')}><Icon name="plus" size={14} /> New request</button>} />
      {staff && strip}
      <Card title={FILTERS[key][0]} icon="orders" count={rows.length} flush
        tools={<><DateTabs value={dates} onChange={setDates} /><select className={key !== 'all' ? 'on' : ''} value={key} onChange={(e) => go(`/orders?f=${e.target.value}`)}>{Object.entries(FILTERS).map(([k, v]) => <option key={k} value={k}>{v[0]}</option>)}</select>
          <FilterTools f={f} set={setF} staff={staff} modalities={[...new Set((list.data || []).map((o) => o.modality))].sort()} /><span style={{ marginLeft: 'auto' }}><ExportButtons rows={rows} columns={COLUMNS} name="RadiologyData" /></span></>}
        foot="Sorted by urgency: overdue first, then STAT, URGENT and ROUTINE.">
        <QueueTable rows={rows} user={user} emptyTitle="No studies match" emptyDetail="Change the date range or filters." />
      </Card>
    </>
  );
}

const STAGES = [['Arrived', ['ARRIVED'], 'violet', 'user'], ['Prepared', ['PREPARED'], 'amber', 'check'], ['Scan in', ['IN_PROGRESS'], 'violet', 'play'], ['Scan out', ['COMPLETED'], 'blue', 'scan'],
  ['Report finalisation', ['REPORT_DRAFTED', 'REPORTED'], 'green', 'report'], ['Dispatched', ['DISPATCHED'], 'blue', 'arrow'], ['Received', ['COLLECTED'], 'green', 'inbox']];

export function Worklist({ user }) {
  const { orders } = useData(); const [equipment, setEquipment] = useState('all'); const [dates, setDates] = useState({ ...defaultDates(), type: 'all' }); const [f, setF] = useState(emptyFilter);
  const { strip } = useTiles(dates, equipment, setEquipment);
  const scoped = orders.filter((o) => o.status !== 'CANCELLED' && (equipment === 'all' || o.modality === { dexa: 'DEXA', mri: 'MRI', open_mri: 'OPEN_MRI', xray: 'XR', sonography: 'USG', ct_scan: 'CT' }[equipment]));
  const groups = [
    ['In progress now', 'play', 'violet', ['IN_PROGRESS']], ['Prepared, ready to scan', 'check', 'blue', ['PREPARED']], ['Arrived, consent needed', 'user', 'amber', ['ARRIVED']], ['Scheduled', 'calendar', 'amber', ['SCHEDULED']],
    ['Acknowledged, awaiting a slot', 'clock', 'neutral', ['ACKNOWLEDGED', 'NO_SHOW']], ['New requests to acknowledge', 'inbox', 'amber', ['REQUESTED']]
  ];
  return (
    <>
      <PageHeader title="Technician" subtitle="Work top to bottom. Record consent for every patient who arrives; that marks them Prepared." />
      {strip}
      <Card title="Status breakdown" icon="worklist" subtitle={equipment === 'all' ? 'All modalities' : 'Filtered by the selected modality'}>
        <KpiStrip items={STAGES.map(([label, st, tone, icon]) => ({ label, value: scoped.filter((o) => st.includes(o.status)).length, tone, icon }))} />
      </Card>
      <Card title="Search" icon="search" tools={<FilterTools f={f} set={setF} staff modalities={[...new Set(orders.map((o) => o.modality))].sort()} />} className="hide-body"><span /></Card>
      {groups.map(([title, icon, tone, st]) => { const rows = applyFilter(scoped.filter((o) => st.includes(o.status)), f); return <Card key={title} title={title} icon={icon} count={rows.length} tone={tone} flush><QueueTable rows={rows} user={user} compact emptyTitle="Nothing here" emptyDetail="This step is clear." /></Card>; })}
    </>
  );
}

export function Reporting({ user }) {
  const { orders } = useData();
  const todo = orders.filter((o) => ['COMPLETED', 'REPORT_DRAFTED'].includes(o.status));
  const done = orders.filter((o) => ['REPORTED', 'DISPATCHED', 'COLLECTED'].includes(o.status)).slice(0, 15);
  return (
    <>
      <PageHeader title="Reporting" subtitle="Studies whose scan is complete and need a signed report." />
      <Card title="To report" icon="report" count={todo.length} tone={todo.length ? 'amber' : 'green'} flush foot="STAT and overdue studies are listed first."><QueueTable rows={todo} user={user} emptyTitle="Reporting queue is clear" /></Card>
      <Card title="Recently finalised" icon="check" count={done.length} tone="green" flush><QueueTable rows={done} user={user} emptyTitle="Nothing finalised yet" /></Card>
    </>
  );
}
