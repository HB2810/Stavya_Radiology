import { api } from '../api.js';
import { Badge, Card, Empty, FormError, PageHeader, fmt, toast, useAction, useLoad } from '../ui.jsx';

export default function Audit({ user }) {
  const v = useLoad(() => api.get('/audit/verify')); const list = useLoad(() => api.get('/audit?limit=200')); const anchors = useLoad(() => api.get('/audit/anchors')); const a = useAction();
  const anchor = () => a.run(async () => { await api.post('/audit/anchors'); toast('Anchor recorded. Copy the hash and keep it outside this server.'); anchors.reload(); v.reload(); list.reload(); });
  return (
    <>
      <PageHeader title="Activity / Audit" subtitle="Every sign-in, order, report and result, chained so that tampering shows." actions={v.data && <Badge tone={v.data.valid ? 'success' : 'danger'}>{v.data.valid ? `Chain intact · ${v.data.total} events` : v.data.message}</Badge>} />
      <Card title="Anchors" icon="audit" count={anchors.data?.length} subtitle="The chain head at a point in time. Print or export the hash and store it away from this server: it is what proves no recent events were removed."
        actions={user?.role === 'admin' && <button className="btn btn-primary btn-sm" disabled={a.busy} onClick={anchor}>Record anchor now</button>}>
        <FormError error={a.error} />
        {anchors.data?.length ? <div className="table-scroll"><table className="clinical-table compact"><thead><tr><th>Recorded</th><th>By</th><th>Events</th><th>Chain head hash</th></tr></thead><tbody>
          {anchors.data.slice(0, 5).map((x) => <tr key={x.id}><td className="mono">{fmt(x.created_at)}</td><td>{x.created_by_name}</td><td className="mono">{x.total}</td><td className="mono">{x.event_hash}</td></tr>)}</tbody></table></div> : <Empty title="No anchors yet" detail="An administrator can record one after each day's work." />}
      </Card>
      <Card title="Recent events" icon="audit" count={list.data?.length} flush>
        {list.data?.length ? <div className="table-scroll"><table className="clinical-table"><thead><tr><th>Time</th><th>Action</th><th>Who</th><th>Resource</th><th>Outcome</th></tr></thead><tbody>
          {list.data.map((e) => <tr key={e.id}><td className="mono">{fmt(e.ts)}</td><td><strong>{e.action}</strong></td><td>{e.actor_name}<span className="table-sub">{e.actor_role}</span></td><td className="mono">{e.resource}</td><td>{e.outcome}</td></tr>)}</tbody></table></div> : <Empty title="No events" />}
      </Card>
    </>
  );
}
