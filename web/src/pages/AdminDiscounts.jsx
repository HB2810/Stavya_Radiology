import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, Modal, PageHeader, fmt, toast, useAction, useLoad } from '../ui.jsx';

function SchemeModal({ scheme, onClose, onSaved }) {
  const isNew = !scheme;
  const [f, setF] = useState({ code: scheme?.id || '', label: scheme?.label || '', value: scheme?.value ?? '', requiresReason: scheme ? Boolean(scheme.requires_reason) : false, requiresApproval: scheme ? Boolean(scheme.requires_approval) : false });
  const a = useAction();
  const save = () => a.run(async () => {
    const body = { label: f.label, value: f.value, requiresReason: f.requiresReason, requiresApproval: f.requiresApproval };
    const saved = isNew ? await api.post('/masters/discounts', { ...body, code: f.code }) : await api.post(`/masters/discounts/${scheme.id}`, body);
    toast(isNew ? 'Discount scheme added' : 'Discount scheme updated'); onSaved(saved); onClose();
  });
  return (
    <Modal title={isNew ? 'Add discount scheme' : scheme.label} icon="orders" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={a.busy} onClick={save}>Save</button></>}>
      <FormError error={a.error} />
      <div className="form-grid">
        {isNew && <label><span>Code</span><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></label>}
        <label className={isNew ? '' : 'wide'}><span>Label</span><input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
        <label><span>Value (%)</span><input type="number" min="0" max="100" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></label>
        <label className="check-row"><input type="checkbox" checked={f.requiresReason} onChange={(e) => setF({ ...f, requiresReason: e.target.checked })} /><span>Requires a written reason</span></label>
        <label className="check-row"><input type="checkbox" checked={f.requiresApproval} onChange={(e) => setF({ ...f, requiresApproval: e.target.checked })} /><span>Requires admin approval</span></label>
      </div>
    </Modal>
  );
}

function DecisionModal({ approval, decision, onClose, onDone }) {
  const [note, setNote] = useState(''); const a = useAction(); const required = decision === 'REJECTED';
  const run = () => a.run(async () => {
    await api.post(`/discount-approvals/${approval.id}/decision`, { decision, note: note || undefined });
    toast(decision === 'APPROVED' ? 'Discount approved' : 'Discount rejected; the line reverted to full price'); onDone();
  });
  return (
    <Modal title={`${decision === 'APPROVED' ? 'Approve' : 'Reject'} ${approval.pct}% discount`} icon="critical" onClose={onClose}
      foot={<><button className="btn btn-light" onClick={onClose}>Close</button><button className={`btn ${decision === 'REJECTED' ? 'btn-danger' : 'btn-primary'}`} disabled={a.busy || (required && !note.trim())} onClick={run}>{decision === 'APPROVED' ? 'Approve' : 'Reject'}</button></>}>
      <FormError error={a.error} />
      <div className="form-grid"><label className="wide"><span>{approval.order_accession}{approval.patient_name ? ` · ${approval.patient_name}` : ''}</span><input readOnly value={`${approval.scheme_label || 'Custom %'} · ${approval.reason || ''}`} /></label>
        <label className="wide"><span>Note{required ? ' (required)' : ''}</span><textarea value={note} onChange={(e) => setNote(e.target.value)} /></label></div>
    </Modal>
  );
}

function DiscountApprovals() {
  const list = useLoad(() => api.get('/discount-approvals'));
  const [decide, setDecide] = useState(null); // { approval, d }
  const rows = list.data || [];
  const pending = rows.filter((a) => a.status === 'PENDING').length;
  return (
    <Card title="Discount approvals" icon="critical" count={pending} tone={pending ? 'blue' : undefined} flush>
      {rows.length ? <div className="table-scroll"><table className="clinical-table compact"><thead><tr><th>Requested</th><th>Order</th><th>Scheme</th><th className="n">%</th><th>Reason</th><th>Status</th><th className="col-action">Action</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td>{fmt(r.requested_at)}<span className="table-sub">{r.requested_by_name}</span></td>
            <td>{r.order_accession || '—'}<span className="table-sub">{r.patient_name}{r.mrn ? ` (${r.mrn})` : ''}</span></td>
            <td>{r.scheme_label || 'Custom %'}</td><td className="mono n">{r.pct}%</td><td>{r.reason}{r.note && <span className="table-sub">{r.note}</span>}</td>
            <td><Badge tone={r.status === 'PENDING' ? 'warning' : r.status === 'APPROVED' ? 'success' : 'neutral'}>{r.status}</Badge></td>
            <td className="col-action">{r.status === 'PENDING' && <div className="row-actions"><button className="primary" onClick={() => setDecide({ approval: r, d: 'APPROVED' })}>Approve</button><button onClick={() => setDecide({ approval: r, d: 'REJECTED' })}>Reject</button></div>}</td>
          </tr>))}</tbody></table></div> : <Empty title={list.loading ? 'Loading…' : 'No discount approvals yet'} />}
      {decide && <DecisionModal approval={decide.approval} decision={decide.d} onClose={() => setDecide(null)} onDone={() => { setDecide(null); list.reload(); }} />}
    </Card>
  );
}

export default function AdminDiscounts() {
  const list = useLoad(() => api.get('/masters/discounts'));
  const [modal, setModal] = useState(null); // null | 'new' | scheme row
  const a = useAction();
  const rows = list.data || [];

  const toggleActive = (s) => a.run(async () => {
    await api.post(`/masters/discounts/${s.id}/${s.active ? 'deactivate' : 'activate'}`);
    list.reload();
  });

  return (
    <>
      <PageHeader title="Discount schemes" actions={<button className="btn btn-primary" onClick={() => setModal('new')}><Icon name="plus" size={14} /> Add scheme</button>} />
      <DiscountApprovals />
      <Card icon="orders" count={rows.length} flush>
        <FormError error={a.error} />
        {rows.length ? <div className="table-scroll"><table className="clinical-table compact"><thead><tr><th>Code</th><th>Label</th><th className="n">Value</th><th>Reason</th><th>Approval</th><th>Status</th><th className="col-action">Action</th></tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s.id}>
              <td className="mono">{s.id}</td><td>{s.label}</td><td className="mono n">{s.value}%</td>
              <td><Badge tone={s.requires_reason ? 'warning' : 'neutral'}>{s.requires_reason ? 'Required' : 'No'}</Badge></td>
              <td><Badge tone={s.requires_approval ? 'warning' : 'neutral'}>{s.requires_approval ? 'Required' : 'No'}</Badge></td>
              <td><Badge tone={s.active ? 'success' : 'neutral'}>{s.active ? 'Active' : 'Inactive'}</Badge></td>
              <td className="col-action"><div className="row-actions"><button onClick={() => setModal(s)}>Edit</button><button className={s.active ? 'danger' : 'primary'} disabled={a.busy} onClick={() => toggleActive(s)}>{s.active ? 'Deactivate' : 'Activate'}</button></div></td>
            </tr>))}</tbody></table></div> : <Empty title={list.loading ? 'Loading…' : 'No discount schemes yet'} />}
      </Card>
      {modal && <SchemeModal scheme={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => list.reload()} />}
    </>
  );
}
