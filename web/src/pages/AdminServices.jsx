import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, Modal, PageHeader, inr, toast, useAction, useLoad } from '../ui.jsx';

const SOURCE_TONE = { HOSPITAL_SHEET: 'success', PLACEHOLDER: 'warning', ADMIN: 'info', SEED: 'neutral' };
const SOURCE_LABEL = { HOSPITAL_SHEET: 'Hospital sheet', PLACEHOLDER: 'Placeholder', ADMIN: 'Admin added', SEED: 'Seed' };

function ServiceModal({ service, modality, modalities, onClose, onSaved }) {
  const isNew = !service;
  const [f, setF] = useState({ modality: service?.modality || modality || '', name: service?.name || '', subGroup: service?.sub_group || '', price: service?.price ?? '', onlinePrice: service?.online_price ?? '', priceNote: service?.price_note || '' });
  const a = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => a.run(async () => {
    const body = { name: f.name, subGroup: f.subGroup, price: f.price === '' ? null : f.price, onlinePrice: f.onlinePrice === '' ? null : f.onlinePrice, priceNote: f.priceNote };
    const saved = isNew ? await api.post('/masters/services', { ...body, modality: f.modality }) : await api.post(`/masters/services/${service.code}`, body);
    toast(isNew ? 'Service added' : 'Service updated'); onSaved(saved); onClose();
  });
  return (
    <Modal title={isNew ? 'Add service' : service.name} icon="scan" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={a.busy} onClick={save}>Save</button></>}>
      <FormError error={a.error} />
      <div className="form-grid">
        {isNew && <label><span>Modality</span><input list="modality-options" value={f.modality} onChange={(e) => setF({ ...f, modality: e.target.value.toUpperCase() })} placeholder="MRI, CT, XR, DEXA…" /><datalist id="modality-options">{modalities?.map((m) => <option key={m} value={m} />)}</datalist></label>}
        <label className={isNew ? '' : 'wide'}><span>Name</span><input value={f.name} onChange={set('name')} /></label>
        <label><span>Sub group</span><input value={f.subGroup} onChange={set('subGroup')} /></label>
        <label><span>Cash price</span><input type="number" min="0" value={f.price} onChange={set('price')} placeholder="No rate set" /></label>
        <label><span>Online price</span><input type="number" min="0" value={f.onlinePrice} onChange={set('onlinePrice')} placeholder="No rate set" /></label>
        <label className="wide"><span>Note</span><input value={f.priceNote} onChange={set('priceNote')} /></label>
      </div>
    </Modal>
  );
}

export default function AdminServices() {
  const list = useLoad(() => api.get('/masters/services'));
  const [modality, setModality] = useState('');
  const [q, setQ] = useState('');
  const [modal, setModal] = useState(null); // null | 'new' | service row
  const a = useAction();

  const rows = list.data || [];
  const modalities = useMemo(() => [...new Set(rows.map((r) => r.modality))].sort(), [rows]);
  const filtered = rows.filter((r) => (!modality || r.modality === modality) && (!q || `${r.name} ${r.code} ${r.sub_group || ''}`.toLowerCase().includes(q.toLowerCase())));

  const toggleActive = (r) => a.run(async () => {
    await api.post(`/masters/services/${r.code}/${r.active ? 'deactivate' : 'activate'}`);
    list.reload();
  });

  let lastModality = null; let lastSubGroup = null;
  return (
    <>
      <PageHeader title="Service catalog" actions={<button className="btn btn-primary" onClick={() => setModal('new')}><Icon name="plus" size={14} /> Add service</button>} />
      <Card icon="scan" count={filtered.length} flush
        tools={<><select className={modality ? 'on' : ''} value={modality} onChange={(e) => setModality(e.target.value)}><option value="">All modalities</option>{modalities.map((m) => <option key={m} value={m}>{m}</option>)}</select>
          <label className="search-box"><Icon name="search" size={14} /><input placeholder="Search name or code" value={q} onChange={(e) => setQ(e.target.value)} /></label></>}>
        <FormError error={a.error} />
        {filtered.length ? <div className="table-scroll"><table className="clinical-table compact"><thead><tr><th>Service</th><th className="n">Cash</th><th className="n">Online</th><th>Source</th><th>Status</th><th className="col-action">Action</th></tr></thead>
          <tbody>{filtered.map((r) => {
            const rows2 = [];
            if (r.modality !== lastModality) { rows2.push(<tr className="table-group-row" key={`m-${r.modality}`}><td colSpan={6}>{r.modality}</td></tr>); lastModality = r.modality; lastSubGroup = null; }
            if ((r.sub_group || '') !== lastSubGroup) { rows2.push(<tr className="table-group-row sub" key={`s-${r.modality}-${r.sub_group}`}><td colSpan={6}>{r.sub_group || 'General'}</td></tr>); lastSubGroup = r.sub_group || ''; }
            rows2.push(<tr key={r.code}>
              <td><strong>{r.name}</strong><span className="table-sub">{r.code}</span></td>
              <td className="mono n">{r.price == null ? <Badge tone="danger">No price</Badge> : inr(r.price)}</td>
              <td className="mono n">{r.online_price == null ? '—' : inr(r.online_price)}</td>
              <td><Badge tone={SOURCE_TONE[r.source] || 'neutral'}>{SOURCE_LABEL[r.source] || r.source}</Badge></td>
              <td><Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Badge></td>
              <td className="col-action"><div className="row-actions"><button onClick={() => setModal(r)}>Edit</button><button className={r.active ? 'danger' : 'primary'} disabled={a.busy} onClick={() => toggleActive(r)}>{r.active ? 'Deactivate' : 'Activate'}</button></div></td>
            </tr>);
            return rows2;
          })}</tbody></table></div> : <Empty title={list.loading ? 'Loading…' : 'No services match'} />}
      </Card>
      {modal && <ServiceModal service={modal === 'new' ? null : modal} modality={modality} modalities={modalities} onClose={() => setModal(null)} onSaved={() => list.reload()} />}
    </>
  );
}
