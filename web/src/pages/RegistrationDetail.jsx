import { useRef, useState } from 'react';
import { api, newKey } from '../api.js';
import { BackLink, Badge, Card, Empty, FormError, Icon, Modal, Notice, PageHeader, PatientBanner, StatusBadge, fmt, go, inr, toast, todayISO, useAction, useLoad } from '../ui.jsx';

const NOTES = [500, 200, 100, 50, 20, 10, 5, 2, 1]; const COINS = [10, 5, 2, 1];
const PAY_TONE = { paid: 'success', partial: 'warning', pending: 'danger' };
const sum = (m) => Object.entries(m).reduce((s, [k, v]) => s + Number(k) * (Number(v) || 0), 0);

// A line's discount choice: a discount_schemes id | 'nocharge' | '__custom' (free % fallback) | '' (none).
function discountFor(e, schemes) {
  if (e.choice === 'nocharge') return { pct: 100, schemeId: null, reasonRequired: true };
  if (e.choice === '__custom') return { pct: Number(e.customPct) || 0, schemeId: null, reasonRequired: (Number(e.customPct) || 0) >= 50 };
  const scheme = schemes.find((s) => s.id === e.choice);
  if (scheme) return { pct: scheme.value, schemeId: scheme.id, reasonRequired: Boolean(scheme.requires_reason) };
  return { pct: 0, schemeId: null, reasonRequired: false };
}
const startEdit = (l) => ({ choice: l.discount_scheme_id || (l.no_charge ? 'nocharge' : l.discount_pct > 0 ? '__custom' : ''), customPct: l.discount_pct || 0, reason: l.waiver_reason || '' });

export default function RegistrationDetail({ id, user, sub }) {
  const { data, error, reload } = useLoad(() => api.get('/registrations/' + id), [id]);
  const exams = useLoad(() => api.get('/catalog/exams'));
  const schemesList = useLoad(() => api.get('/masters/discounts'));
  const [modal, setModal] = useState(sub === 'pay' ? 'pay' : null); const a = useAction();
  const [edit, setEdit] = useState({});
  if (error) return <><BackLink to="/registrations">Registrations</BackLink><Card title="Registration" icon="orders"><Empty title="Could not open this registration" detail={error.message} /></Card></>;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { registration: r, patient, lines, payments, refunds } = data; const staff = ['reception', 'admin'].includes(user.role); const active = r.status === 'ACTIVE';
  const live = lines.filter((l) => l.status !== 'CANCELLED'); const schemes = schemesList.data || [];
  const save = (patch) => a.run(async () => { await api.post(`/registrations/${id}/invoice`, patch); toast('Invoice updated'); setEdit({}); reload(); });
  const print = async (path) => { const html = await api.html(path); const w = window.open(); if (w) { w.document.write(html); w.document.close(); } };
  // Registration is the walk-in / outside-patient desk: the encounter behind every registration is 'EXTERNAL'.
  const banner = { ...patient, patient_name: patient.name, encounter_type: 'EXTERNAL', encounter_ref: r.reg_no, consultant_name: r.referring_doctor, mrn: patient.mrn };
  const refundable = r.refundable; const openRefund = refunds.find((x) => x.status === 'PENDING' || x.status === 'APPROVED');
  return (
    <>
      <BackLink to="/registrations">Registrations</BackLink>
      <PatientBanner o={banner} />
      <PageHeader title={`Invoice ${r.reg_no}`} subtitle={`Created ${fmt(r.created_at)}${r.referring_doctor ? ` · referred by ${r.referring_doctor}` : ''}`}
        actions={<><Badge tone={PAY_TONE[r.payment_status]}>{r.payment_status}</Badge>{!active && <Badge tone="neutral">Cancelled</Badge>}<button className="btn btn-light" onClick={() => print(`/registrations/${id}/invoice-print`)}>Print invoice</button>
          {staff && active && r.available_to_collect > 0 && <button className="btn btn-primary" onClick={() => setModal('pay')}>Pay now</button>}</>} />
      {r.credit_amount > 0 && <Notice tone="red">The patient has paid {inr(r.credit_amount)} more than the current total. Request a refund for the difference.</Notice>}
      {r.cheque_in_process > 0 && <Notice>A cheque of {inr(r.cheque_in_process)} is in process. It counts as paid only after it clears.</Notice>}
      <Card title="Scans and charges" icon="scan" flush foot={`Total ${inr(r.base_total)} · discount ${inr(r.discount_total)} · payable ${inr(r.final_total)} · paid ${inr(r.paid_amount)} · pending ${inr(r.pending_amount)}. Amounts are calculated by the server.`}
        actions={staff && active && <AddScan exams={exams.data || []} onAdd={(x) => save({ add: [x] })} />}>
        <div className="table-scroll"><table className="clinical-table"><thead><tr><th>Modality</th><th>Test</th><th>Status</th><th className="n">Price</th><th className="n">Disc %</th><th className="n">Discount</th><th className="n">Total</th><th className="col-action">Action</th></tr></thead><tbody>
          {live.map((l) => { const e = edit[l.id]; const d = e && discountFor(e, schemes); return (
            <tr key={l.id}><td>{l.modality}</td><td><b>{l.exam_name}</b>{l.side ? ` (${l.side})` : ''}<span className="table-sub">{l.accession}</span></td><td><StatusBadge status={l.status} /></td>
              <td className="mono n">{inr(l.base_price)}</td>
              <td className="mono n">{e ? <select className="inline-input" style={{ width: 130 }} value={e.choice} onChange={(ev) => setEdit({ ...edit, [l.id]: { ...e, choice: ev.target.value, reason: '' } })}>
                  <option value="">No discount</option>{schemes.map((s) => <option key={s.id} value={s.id}>{s.label} ({s.value}%)</option>)}<option value="nocharge">No charge</option><option value="__custom">Custom %</option>
                </select> : `${l.discount_pct}%`}
                {e?.choice === '__custom' && <input className="inline-input" style={{ width: 60, marginLeft: 4 }} type="number" min="0" max="100" value={e.customPct} onChange={(ev) => setEdit({ ...edit, [l.id]: { ...e, customPct: ev.target.value } })} />}</td>
              <td className="mono n">{inr(l.discount_amount)}{l.waiver_reason && <span className="table-sub">{l.waiver_reason}</span>}{l.discount_pending ? <Badge tone="warning">Discount pending approval</Badge> : null}</td><td className="mono n">{inr(l.final_amount)}</td>
              <td className="col-action"><div className="row-actions">
                {staff && active && !e && <button onClick={() => setEdit({ ...edit, [l.id]: startEdit(l) })}>Discount</button>}
                {e && <><input className="inline-input" style={{ width: 150 }} placeholder={d?.reasonRequired ? 'Reason (required)' : 'Reason'} value={e.reason} onChange={(ev) => setEdit({ ...edit, [l.id]: { ...e, reason: ev.target.value } })} />
                  <button className="primary" disabled={d?.reasonRequired && !e.reason.trim()} onClick={() => save({ update: [{ orderId: l.id, noCharge: e.choice === 'nocharge', schemeId: d.schemeId || undefined, discountPct: e.choice === '__custom' ? d.pct : e.choice === '' ? 0 : undefined, waiverReason: e.reason || undefined }] })}>Save</button>
                  <button onClick={() => setEdit((x) => { const n = { ...x }; delete n[l.id]; return n; })}>Cancel</button></>}
                {staff && active && ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW'].includes(l.status) && !e && <button className="danger" onClick={() => setModal({ remove: l })}>Remove</button>}
                <button onClick={() => go(`/order/${l.id}`)}>Open</button></div></td></tr>); })}</tbody></table></div>
        <div style={{ padding: 14 }}><FormError error={a.error} /></div>
      </Card>
      <div className="grid-2">
        <Card title="Report details" icon="report" actions={staff && active && <SaveReport r={r} onSave={save} />}>
          <dl className="defs"><div><dt>Report no</dt><dd>{r.report_no || '—'}</dd></div><div><dt>Report date</dt><dd>{r.report_date || '—'}</dd></div><div><dt>Delivery</dt><dd>{r.delivery_at ? fmt(r.delivery_at) : '—'}</dd></div></dl>
        </Card>
        <Card title="Payments" icon="orders" count={payments.length} flush actions={staff && active && refundable > 0 && !openRefund && <button className="btn btn-light btn-sm" onClick={() => setModal('refund')}>Request refund</button>}>
          {payments.length ? <table className="clinical-table compact"><thead><tr><th>Receipt</th><th>Method</th><th>Status</th><th className="n">Amount</th><th /></tr></thead><tbody>{payments.map((p) => (
            <tr key={p.id}><td className="mono">{p.receipt_no}<span className="table-sub">{fmt(p.at)} · {p.collected_by_name}</span></td><td>{p.method}{p.method === 'CHEQUE' && <span className="table-sub">#{p.details.chequeNumber} {p.details.bank}</span>}{p.method === 'ONLINE' && <span className="table-sub">{p.details.gateway} {p.details.reference}</span>}</td>
              <td><Badge tone={p.status === 'RECEIVED' ? 'success' : p.status === 'BOUNCED' ? 'danger' : 'warning'}>{p.status.replace('_', ' ')}</Badge></td><td className="mono n">{inr(p.amount)}{p.discount > 0 && <span className="table-sub">− {inr(p.discount)} disc.</span>}</td>
              <td className="col-action"><div className="row-actions">{p.status === 'IN_PROCESS' && staff && <button className="primary" onClick={() => setModal({ cheque: p })}>Process cheque</button>}<button onClick={async () => { const html = await api.html(`/payments/${p.id}/receipt`); const w = window.open(); if (w) { w.document.write(html); w.document.close(); } }}>Receipt</button></div></td></tr>))}</tbody></table>
            : <Empty title="No payments yet" />}
        </Card>
      </div>
      {refunds.length > 0 && <Card title="Refunds" icon="critical" count={refunds.length} flush><table className="clinical-table compact"><thead><tr><th>Requested</th><th>Reason</th><th className="n">Amount</th><th>Status</th><th className="col-action">Action</th></tr></thead><tbody>{refunds.map((x) => (
        <tr key={x.id}><td>{fmt(x.requested_at)}<span className="table-sub">{x.requested_by_name}</span></td><td>{x.reason}{x.decided_note && <span className="table-sub">{x.decided_note}</span>}</td><td className="mono n">{inr(x.amount)}</td><td><Badge tone={x.status === 'PAID' ? 'success' : x.status === 'REJECTED' ? 'neutral' : 'warning'}>{x.status}</Badge></td>
          <td className="col-action"><div className="row-actions">{x.status === 'PENDING' && user.role === 'admin' && <><button className="primary" onClick={() => setModal({ decide: x, d: 'APPROVED' })}>Approve</button><button onClick={() => setModal({ decide: x, d: 'REJECTED' })}>Reject</button></>}{x.status === 'APPROVED' && staff && <button className="primary" onClick={() => setModal({ payout: x })}>Pay out</button>}</div></td></tr>))}</tbody></table></Card>}
      {staff && active && <div className="row-gap" style={{ justifyContent: 'flex-end' }}><button className="btn btn-light" onClick={() => setModal('cancel')}>Cancel registration</button></div>}

      {modal === 'pay' && <PaymentModal reg={r} patient={patient} user={user} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'refund' && <RefundModal reg={r} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'cancel' && <Simple title="Cancel registration" label="Reason" action="Cancel registration" danger onClose={() => setModal(null)} run={(reason) => api.post(`/registrations/${id}/cancel`, { reason })} onDone={() => { setModal(null); reload(); }} />}
      {modal?.remove && <Simple title={`Remove ${modal.remove.exam_name}`} label="Reason" action="Remove scan" danger onClose={() => setModal(null)} run={(reason) => api.post(`/registrations/${id}/invoice`, { remove: [{ orderId: modal.remove.id, reason }] })} onDone={() => { setModal(null); reload(); }} />}
      {modal?.decide && <Simple title={`${modal.d === 'APPROVED' ? 'Approve' : 'Reject'} refund of ${inr(modal.decide.amount)}`} label="Note" action={modal.d === 'APPROVED' ? 'Approve' : 'Reject'} onClose={() => setModal(null)} run={(note) => api.post(`/refunds/${modal.decide.id}/decision`, { decision: modal.d, note })} onDone={() => { setModal(null); reload(); }} />}
      {modal?.payout && <PayoutModal refund={modal.payout} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal?.cheque && <Simple title={`Cheque ${modal.cheque.details.chequeNumber}`} label="Note (required if bounced)" action="Mark cleared" extra="Mark bounced" onClose={() => setModal(null)} run={(note, alt) => api.post(`/payments/${modal.cheque.id}/cheque`, { decision: alt ? 'BOUNCED' : 'CLEARED', note })} onDone={() => { setModal(null); reload(); }} optional />}
    </>
  );
}

function SaveReport({ r, onSave }) {
  const [open, setOpen] = useState(false); const [f, setF] = useState({ reportNo: r.report_no || '', reportDate: r.report_date || todayISO(), deliveryAt: r.delivery_at ? r.delivery_at.slice(0, 16) : '' });
  if (!open) return <button className="btn btn-light btn-sm" onClick={() => setOpen(true)}>Edit</button>;
  return <Modal title="Report details" icon="report" onClose={() => setOpen(false)} foot={<><button className="btn btn-light" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={() => { onSave({ reportNo: f.reportNo, reportDate: f.reportDate, deliveryAt: f.deliveryAt ? new Date(f.deliveryAt).toISOString() : undefined }); setOpen(false); }}>Save</button></>}>
    <div className="form-grid"><label><span>Report no</span><input value={f.reportNo} onChange={(e) => setF({ ...f, reportNo: e.target.value })} /></label><label><span>Report date</span><input type="date" value={f.reportDate} onChange={(e) => setF({ ...f, reportDate: e.target.value })} /></label>
      <label className="wide"><span>Delivery date and time</span><input type="datetime-local" value={f.deliveryAt} onChange={(e) => setF({ ...f, deliveryAt: e.target.value })} /></label></div></Modal>;
}

function AddScan({ exams, onAdd }) {
  const [open, setOpen] = useState(false); const [code, setCode] = useState(''); const [side, setSide] = useState('NA');
  if (!open) return <button className="btn btn-light btn-sm" onClick={() => setOpen(true)}><Icon name="plus" size={13} /> Add scan</button>;
  return <Modal title="Add a scan" icon="scan" onClose={() => setOpen(false)} foot={<><button className="btn btn-light" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!code} onClick={() => { onAdd({ examCode: code, side: side === 'NA' ? undefined : side }); setOpen(false); }}>Add</button></>}>
    <div className="form-grid"><label className="wide"><span>Test</span><select value={code} onChange={(e) => setCode(e.target.value)}><option value="">Select…</option>{exams.map((e) => <option key={e.code} value={e.code} disabled={e.price == null}>{e.modality} · {e.name} · {e.price == null ? 'No price set' : inr(e.price)}</option>)}</select></label><label><span>Side</span><select value={side} onChange={(e) => setSide(e.target.value)}><option value="NA">n/a</option><option>Left</option><option>Right</option><option>Both</option></select></label></div></Modal>;
}

function Simple({ title, label, action, extra, danger, run, onClose, onDone, optional }) {
  const [v, setV] = useState(''); const a = useAction();
  const go2 = (alt) => a.run(async () => { await run(v, alt); onDone(); });
  return <Modal title={title} onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Close</button>{extra && <button className="btn btn-danger" disabled={a.busy || !v.trim()} onClick={() => go2(true)}>{extra}</button>}<button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={a.busy || (!optional && !v.trim())} onClick={() => go2(false)}>{action}</button></>}>
    <FormError error={a.error} /><div className="form-grid"><label className="wide"><span>{label}</span><textarea value={v} onChange={(e) => setV(e.target.value)} /></label></div></Modal>;
}

function RefundModal({ reg, onClose, onDone }) {
  const [amount, setAmount] = useState(''); const [reason, setReason] = useState(''); const a = useAction();
  return <Modal title="Request refund" icon="critical" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={a.busy || !(Number(amount) > 0) || !reason.trim()} onClick={() => a.run(async () => { await api.post(`/registrations/${reg.id}/refunds`, { amount: Number(amount), reason }); toast('Refund requested. An admin must approve it.'); onDone(); })}>Send for approval</button></>}>
    <FormError error={a.error} /><div className="form-grid"><label><span>Total paid (net)</span><input readOnly value={inr(reg.paid_amount)} /></label><label><span>Refund amount (max {inr(reg.refundable)})</span><input type="number" min="0" max={reg.refundable} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <label className="wide"><span>Reason</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} /></label></div></Modal>;
}
function PayoutModal({ refund, onClose, onDone }) {
  const [via, setVia] = useState('CASH'); const [ref, setRef] = useState(''); const a = useAction();
  return <Modal title={`Pay out ${inr(refund.amount)}`} icon="orders" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={a.busy || (via !== 'CASH' && !ref.trim())} onClick={() => a.run(async () => { await api.post(`/refunds/${refund.id}/pay`, { via, reference: ref }); toast('Refund paid'); onDone(); })}>Confirm paid</button></>}>
    <FormError error={a.error} /><div className="form-grid"><label><span>Paid by</span><select value={via} onChange={(e) => setVia(e.target.value)}>{['CASH', 'BANK_TRANSFER', 'UPI', 'CHEQUE'].map((v) => <option key={v}>{v}</option>)}</select></label><label><span>Reference{via === 'CASH' ? ' (optional)' : ''}</span><input value={ref} onChange={(e) => setRef(e.target.value)} /></label></div></Modal>;
}

/* ---- Pay now: Online / Cheque / Cash, with denomination counting and change return ---- */
function Counter({ label, values, setValues, denoms }) {
  return <div><p className="chart-title">{label}</p><div className="table-scroll"><table className="clinical-table compact"><tbody>{denoms.map((d) => (
    <tr key={d}><td>₹ {d}</td><td style={{ width: 90 }}><input className="inline-input" type="number" min="0" value={values[d] || ''} onChange={(e) => setValues({ ...values, [d]: e.target.value })} /></td><td className="mono n">{inr(d * (Number(values[d]) || 0))}</td></tr>))}</tbody></table></div></div>;
}
function PaymentModal({ reg, patient, user, onClose, onDone }) {
  const [tab, setTab] = useState('CASH'); const [amount, setAmount] = useState(String(reg.available_to_collect)); const [discount, setDiscount] = useState(''); const [dReason, setDReason] = useState(''); const a = useAction();
  const [notes, setNotes] = useState({}); const [coins, setCoins] = useState({}); const [rNotes, setRNotes] = useState({}); const [rCoins, setRCoins] = useState({}); const [remarks, setRemarks] = useState(''); const key = useRef(newKey()); // a repeated click or retry of the same payment is recorded once
  const [chq, setChq] = useState({ chequeNumber: '', bank: '', accountHolder: patient.name, ifsc: '', chequeDate: todayISO(), depositDate: todayISO() }); const [on, setOn] = useState({ gateway: 'UPI', reference: '' });
  const collected = sum(notes) + sum(coins); const change = Math.round((collected - Number(amount || 0)) * 100) / 100; const returned = sum(rNotes) + sum(rCoins);
  const cashOk = collected >= Number(amount) && (change <= 0 || Math.abs(returned - change) < 0.005);
  const submit = () => a.run(async () => {
    const base = { method: tab, amount: Number(amount), discount: Number(discount) || 0, discountReason: dReason || undefined };
    const body = tab === 'CASH' ? { ...base, notes, coins, returnNotes: rNotes, returnCoins: rCoins, remarks } : tab === 'CHEQUE' ? { ...base, ...chq } : { ...base, ...on };
    const r = await api.post(`/registrations/${reg.id}/payments`, body, { key: key.current }); key.current = newKey(); toast(`Payment recorded · ${r.receiptNo}`); onDone();
  });
  const set = (k) => (e) => setChq({ ...chq, [k]: e.target.value });
  return (
    <Modal title="Payment method" icon="orders" wide onClose={onClose} foot={<><span className="left-note">Pending {inr(reg.pending_amount)}</span><button className="btn btn-light" onClick={onClose}>Close</button><button className="btn btn-primary" disabled={a.busy || !(Number(amount) > 0) || (tab === 'CASH' && !cashOk)} onClick={submit}>{a.busy ? 'Saving…' : tab === 'CHEQUE' ? 'Save cheque' : 'Record payment'}</button></>}>
      <div className="sum-strip">{[['Total amount', reg.final_total], ['Paid amount', reg.paid_amount], ['Pending amount', reg.pending_amount]].map(([l, v]) => <div className="sum-cell" key={l}><b>{inr(v)}</b><span>{l}</span></div>)}</div>
      <div className="seg" style={{ margin: '12px 0' }}>{[['ONLINE', 'Online'], ['CHEQUE', 'Cheque'], ['CASH', 'Cash']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div className="form-grid"><label><span>Payment amount (max {inr(reg.available_to_collect)})</span><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label><span>Discount amount</span><input type="number" min="0" value={discount} onChange={(e) => setDiscount(e.target.value)} /></label>
        {Number(discount) > 0 && <label className="wide"><span>Reason for the discount</span><input value={dReason} onChange={(e) => setDReason(e.target.value)} /></label>}</div>
      {tab === 'ONLINE' && <div className="form-grid" style={{ marginTop: 12 }}><label><span>Mode</span><select value={on.gateway} onChange={(e) => setOn({ ...on, gateway: e.target.value })}>{['UPI', 'Card', 'NetBanking', 'Razorpay', 'Other'].map((g) => <option key={g}>{g}</option>)}</select></label>
        <label><span>Payment ID / reference</span><input value={on.reference} onChange={(e) => setOn({ ...on, reference: e.target.value })} /></label><div className="wide"><Notice>Enter the reference from the payment confirmation. No payment gateway is connected to this system.</Notice></div></div>}
      {tab === 'CHEQUE' && <div className="form-grid" style={{ marginTop: 12 }}><label><span>Cheque number (6 digits)</span><input value={chq.chequeNumber} onChange={(e) => setChq({ ...chq, chequeNumber: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></label><label><span>Bank</span><input value={chq.bank} onChange={set('bank')} /></label>
        <label><span>Account holder</span><input value={chq.accountHolder} onChange={set('accountHolder')} /></label><label><span>IFSC</span><input value={chq.ifsc} onChange={(e) => setChq({ ...chq, ifsc: e.target.value.toUpperCase() })} placeholder="HDFC0001234" /></label>
        <label><span>Cheque date</span><input type="date" value={chq.chequeDate} onChange={set('chequeDate')} /></label><label><span>Deposit date</span><input type="date" value={chq.depositDate} onChange={set('depositDate')} /></label>
        <div className="wide"><Notice>The cheque counts as paid only after you mark it cleared.</Notice></div></div>}
      {tab === 'CASH' && <div style={{ marginTop: 12 }}>
        <div className="grid-2"><Counter label="Notes" values={notes} setValues={setNotes} denoms={NOTES} /><Counter label="Coins" values={coins} setValues={setCoins} denoms={COINS} /></div>
        <div className="sum-strip" style={{ marginTop: 12 }}>{[['Collected', collected], ['Amount due', Number(amount) || 0], [change >= 0 ? 'Change to return' : 'Short by', Math.abs(change)]].map(([l, v]) => <div className="sum-cell" key={l}><b>{inr(v)}</b><span>{l}</span></div>)}</div>
        {change < 0 && <Notice tone="red">Insufficient amount collected.</Notice>}
        {change > 0 && <><Notice>Return {inr(change)} to the patient and count it out below. Returned so far {inr(returned)}, remaining {inr(Math.max(0, change - returned))}.</Notice><div className="grid-2" style={{ marginTop: 8 }}><Counter label="Return: notes" values={rNotes} setValues={setRNotes} denoms={NOTES} /><Counter label="Return: coins" values={rCoins} setValues={setRCoins} denoms={COINS} /></div></>}
        <div className="form-grid" style={{ marginTop: 12 }}><label className="wide"><span>Remarks</span><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label></div></div>}
      <FormError error={a.error} />
    </Modal>
  );
}
