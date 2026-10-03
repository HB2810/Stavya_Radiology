import { api } from '../api.js';
import { Card, Empty, PageHeader, fmt, go, useLoad } from '../ui.jsx';

export default function Notifications({ onChange }) {
  const { data, reload } = useLoad(() => api.get('/notifications'));
  const open = async (n) => { await api.post(`/notifications/${n.id}/read`); onChange(); if (n.order_id) go(`/order/${n.order_id}`); else reload(); };
  return (
    <>
      <PageHeader title="Notifications" subtitle="New requests, status changes, reports and critical results that concern you." actions={<button className="btn btn-light" onClick={async () => { await api.post('/notifications/read-all'); onChange(); reload(); }}>Mark all read</button>} />
      <Card title="Inbox" icon="inbox" count={data?.filter((n) => !n.read_at).length} tone="blue" flush>
        {data?.length ? <div style={{ display: 'grid' }}>{data.map((n) => (
          <button key={n.id} className={`alert-card ${n.kind.startsWith('CRITICAL') ? 'red' : n.read_at ? '' : 'blue'}`} style={{ borderRadius: 0, border: 0, borderBottom: '1px solid var(--line)' }} onClick={() => open(n)}>
            <span className="alert-body"><strong style={{ fontWeight: n.read_at ? 600 : 800 }}>{n.text}</strong><small>{fmt(n.created_at)}</small></span></button>))}</div> : <Empty title="Nothing yet" />}
      </Card>
    </>
  );
}
