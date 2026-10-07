import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, PageHeader, PriorityBadge, StatusBadge, fmt, go, inr, initials, toast, useAction, visitId } from '../ui.jsx';
import { ArrivalModal, requeue } from '../queue.jsx';

const PAY_TONE = { UNPAID: 'danger', PAID_OPD: 'success', PAID_RADIOLOGY: 'success', IPD_CREDIT: 'info', WAIVED: 'neutral', NOT_REQUIRED: 'neutral' };
const PAY_LABEL = { UNPAID: 'Unpaid', PAID_OPD: 'Paid', PAID_RADIOLOGY: 'Paid · Rad', IPD_CREDIT: 'IPD credit', WAIVED: 'Waived', NOT_REQUIRED: 'No pay' };

const SEEN_KEY = 'ris.reception.seenOrders';
const loadSeen = () => { try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } };
const saveSeen = (set) => { try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...set].slice(-400))); } catch { /* ignore */ } };

export default function ReceptionDesk({ user }) {
  const [rows, setRows] = useState([]); const [channels, setChannels] = useState([]);
  const [cases, setCases] = useState([]);
  const [f, setF] = useState({ channel: '', q: '', lane: 'all' });
  const [loading, setLoading] = useState(true);
  const [arrival, setArrival] = useState(null);
  const [flash, setFlash] = useState(new Set());
  const [findQ, setFindQ] = useState('');
  const [findHits, setFindHits] = useState([]);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState('');
  const seen = useRef(loadSeen());
  const a = useAction();

  const load = async () => {
    try {
      const q = new URLSearchParams({ open: '1' });
      if (f.channel) q.set('channel', f.channel);
      const [board, ch, caseList] = await Promise.all([
        api.get('/reception/board?' + q),
        api.get('/masters/channels'),
        api.get('/cases?' + q)
      ]);
      const nextFlash = new Set();
      for (const r of board) {
        if (!seen.current.has(r.id)) {
          nextFlash.add(r.id);
          seen.current.add(r.id);
        }
      }
      for (const c of caseList) {
        if (!seen.current.has(c.id)) {
          nextFlash.add(c.id);
          seen.current.add(c.id);
        }
      }
      saveSeen(seen.current);
      if (nextFlash.size) {
        setFlash((prev) => new Set([...prev, ...nextFlash]));
        setTimeout(() => setFlash((prev) => {
          const n = new Set(prev);
          for (const id of nextFlash) n.delete(id);
          return n;
        }), 45000);
      }
      setRows(board); setChannels(ch); setCases(caseList);
    } catch (e) { toast(e.message, true); } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [f.channel]);
  useEffect(() => {
    let unsub = () => {};
    import('../sync.js').then((m) => { unsub = m.onSync(() => load()); });
    return () => unsub();
  }, [f.channel]);

  useEffect(() => {
    const q = findQ.trim();
    let active = true;
    setFindHits([]); setFindError('');
    if (q.length < 2) { setFinding(false); return; }
    setFinding(true);
    const t = setTimeout(async () => {
      try {
        const hits = await api.get('/patients?q=' + encodeURIComponent(q));
        if (active) setFindHits(hits);
      } catch (e) { if (active) setFindError(e.message); }
      finally { if (active) setFinding(false); }
    }, 220);
    return () => { active = false; clearTimeout(t); };
  }, [findQ]);

  const markPaid = (row) => a.run(async () => {
    const ref = prompt(`Payment reference for ${row.exam_name} · ${inr(row.final_amount)}`);
    if (!ref) return;
    await api.post(`/orders/${row.id}/payment`, { paymentStatus: 'PAID_RADIOLOGY', paymentRef: ref });
    toast('Payment recorded at counter'); load();
  });
  const hold = (row) => a.run(async () => {
    const reason = prompt('Hold reason');
    if (!reason) return;
    await api.post(`/orders/${row.id}/hold`, { reason });
    toast('On hold'); load();
  });
  const clearHold = (row) => a.run(async () => { await api.post(`/orders/${row.id}/hold/clear`); toast('Hold cleared'); load(); });
  const backInQueue = (row) => a.run(async () => { await requeue(row); load(); });

  const textMatch = (r) => !f.q || `${r.patient_name} ${r.mrn} ${r.opd_id || ''} ${r.ipd_id || ''} ${r.token_no || ''} ${r.exam_name} ${r.channel_code || ''} ${r.case_no || ''}`.toLowerCase().includes(f.q.toLowerCase());
  const caseLane = cases.flatMap((c) => (c.modalities || [])
    .filter((m) => ['WAITING', 'AT_ASSISTANT', 'AWAITING_PROTOCOL'].includes(m.status))
    .map((m) => ({ case: c, mod: m })));
  const protocolRows = caseLane.map(({ case: c, mod: m }) => {
    const label = m.status === 'WAITING' ? 'waiting · assistant'
      : m.status === 'AT_ASSISTANT' ? 'with assistant'
      : 'at modality · tech services';
    return {
      id: m.id,
      kind: 'protocol',
      token_no: m.token_no,
      machine_code: m.machine_code,
      modality: m.modality,
      patient_id: c.patient_id,
      patient_name: c.patient_name,
      mrn: c.mrn,
      opd_id: c.opd_id,
      ipd_id: c.ipd_id,
      ward: c.ward,
      exam_name: `${m.modality === 'XR' ? 'X-ray' : m.modality} · ${label}`,
      channel_code: c.channel_code,
      channel_name: c.channel_name,
      case_no: c.case_no,
      clinical_indication: c.clinical_indication,
      final_amount: null,
      discount_amount: 0,
      payment_status: c.payment_status || 'UNPAID',
      payment_place: c.payment_place,
      payment_ref: c.payment_ref,
      status: m.status,
      priority: c.priority,
      eta_at: m.eta_at,
      hold_reason: null,
      pay_at_counter: false,
      no_charge: false,
      is_new: !!(c.is_new || flash.has(c.id) || flash.has(m.id)),
      side: null,
      registration_id: null,
      registration_no: null,
      consultant_name: null,
      report_handover: c.report_handover,
      encounter_type: c.encounter_type,
      encounter_ref: c.encounter_ref
    };
  }).filter(textMatch);
  const base = rows.filter(textMatch);
  const boardAll = [...protocolRows, ...base];
  const waiting = [...protocolRows, ...base.filter((r) => ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW'].includes(r.status))];
  const inRoom = base.filter((r) => ['ARRIVED', 'PREPARED', 'IN_PROGRESS'].includes(r.status));
  const reporting = base.filter((r) => ['COMPLETED', 'REPORT_DRAFTED', 'REPORTED', 'DISPATCHED'].includes(r.status));
  const payAtCounter = base.filter((r) => r.pay_at_counter).sort((a, b) => (a.eta_at || '').localeCompare(b.eta_at || ''));
  const payTotal = payAtCounter.reduce((s, r) => s + Number(r.final_amount || 0), 0);
  const newOnes = boardAll.filter((r) => r.is_new || flash.has(r.id));
  const newCount = newOnes.length;

  const laneRows = f.lane === 'waiting' ? waiting
    : f.lane === 'room' ? inRoom
    : f.lane === 'report' ? reporting
    : f.lane === 'pay' ? payAtCounter
    : f.lane === 'new' ? newOnes
    : boardAll;

  const setLane = (lane) => setF({ ...f, lane });

  const boardTitle = f.lane === 'pay' ? 'Pay at counter'
    : f.lane === 'new' ? 'New arrivals'
    : f.lane === 'waiting' ? 'Waiting / in queue'
    : f.lane === 'room' ? 'At modality'
    : f.lane === 'report' ? 'Report / handover'
    : 'Today’s board';

  return (
    <div className="reception-workspace">
      <PageHeader
        title="Reception desk"
        subtitle="Find patients, manage arrivals, collect payments and hand over reports."

      />

      <section className="desk-hub" aria-label="Reception actions">
        <div className="desk-hub-grid">
          <button type="button" className="desk-hub-card primary" onClick={() => go('/entry')}>
            <Icon name="plus" size={18} />
            <strong>Add patient / visit</strong>
            <span>Find an existing patient or add a new one, then start the visit</span>
          </button>
          <button type="button" className="desk-hub-card" onClick={() => go('/registrations')}>
            <Icon name="orders" size={18} />
            <strong>Bills & payments</strong>
            <span>Open invoices, receipts, discounts and refunds</span>
          </button>
          <div className="desk-hub-card search">
            <strong><Icon name="search" size={14} /> Patient search</strong>
            <label className="search-box" style={{ maxWidth: 'none', marginTop: 8 }}>
              <Icon name="search" size={14} />
              <input
                aria-label="Find a patient"
                placeholder="Search by OPD ID, IPD ID, name or phone"
                value={findQ}
                onChange={(e) => setFindQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && findQ.trim()) go(`/patients?q=${encodeURIComponent(findQ.trim())}`); }}
              />
            </label>
            {findHits.length > 0 && (
              <div className="pick-list desk-hub-hits">
                {findHits.slice(0, 6).map((p) => (
                  <button key={p.id} type="button" className="pick" onClick={() => go(`/patient/${p.id}`)}>
                    <strong>{p.name}</strong>
                    <span>{visitId(p)} · {p.dob} · {p.sex}{p.phone ? ` · ${p.phone}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
            {finding && <p className="note" role="status">Searching patients…</p>}
            {findError && <FormError error={findError} />}
            {!finding && !findError && findQ.trim().length >= 2 && !findHits.length && <p className="note" style={{ marginBottom: 0 }}>No match. Use Add patient / visit to add a new patient, or try another ID.</p>}
          </div>
        </div>
      </section>

      <div className="desk-focus" role="toolbar" aria-label="Board filters">
        {[
          ['all', 'All', boardAll.length, null],
          ['waiting', 'Waiting', waiting.length, null],
          ['new', 'New', newCount, newCount ? 'hot' : null],
          ['pay', 'Pay at counter', payAtCounter.length, payAtCounter.length ? 'pay' : null],
          ['room', 'At modality', inRoom.length, null],
          ['report', 'Report', reporting.length, null]
        ].map(([id, label, n, tone]) => (
          <button key={id} type="button" aria-pressed={f.lane === id} className={`desk-focus-btn ${f.lane === id ? 'on' : ''} ${tone || ''}`} onClick={() => setLane(id)}>
            <strong>{n}</strong>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {payAtCounter.length > 0 && f.lane !== 'pay' && (
        <section className="desk-pay-banner" aria-label="Pay at counter">
          <div className="desk-pay-banner-head">
            <div>
              <strong>Pay at counter · {payAtCounter.length}</strong>
              <span>Total due {inr(payTotal)}</span>
            </div>
            <button type="button" className="btn btn-light btn-sm" onClick={() => setLane('pay')}>Show list</button>
          </div>
          <div className="desk-pay-strip">
            {payAtCounter.slice(0, 4).map((r) => (
              <article key={r.id} className={`desk-pay-chip ${flash.has(r.id) || r.is_new ? 'is-new' : ''}`}>
                <div>
                  <strong>{r.patient_name}</strong>
                  <span>{r.token_no || '—'} · {r.exam_name}</span>
                </div>
                <b className="mono">{inr(r.final_amount)}</b>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => markPaid(r)}>Collect</button>
              </article>
            ))}
          </div>
        </section>
      )}

      <Card
        title={boardTitle}
        icon={f.lane === 'pay' ? 'orders' : 'worklist'}
        count={laneRows.length}
        tone={f.lane === 'pay' ? 'red' : f.lane === 'new' ? 'blue' : 'neutral'}
        flush
        subtitle="Track each patient from arrival to report handover."
        tools={<>
          <label className="search-box"><Icon name="search" size={14} /><input placeholder="Token, name, OPD/IPD ID" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
          <select className={f.channel ? 'on' : ''} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="">All visit types</option>
            {channels.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </>}
      >
        <FormError error={a.error} />
        {loading ? <Empty title="Loading…" /> : !laneRows.length ? (
          <Empty title="Nothing in this view" detail="Use Add patient / visit to start." />
        ) : (
          <div className="table-scroll"><table className="clinical-table queue desk-table">
            <thead><tr>
              <th>Token</th><th>Patient</th><th>Service</th><th>Amount</th><th>Payment</th><th>Status</th><th className="col-action">Action</th>
            </tr></thead>
            <tbody>{laneRows.map((r) => (
              <tr key={r.id} className={`${r.hold_reason ? 'late-mark' : ''} ${flash.has(r.id) || r.is_new ? 'row-new' : ''} ${r.pay_at_counter ? 'row-pay' : ''} ${r.kind === 'protocol' ? 'row-protocol' : ''}`}>
                <td>
                  <strong className="mono token-num">{r.token_no || '—'}</strong>
                  <span className="table-sub">{r.machine_code || r.modality}</span>
                  {(flash.has(r.id) || r.is_new) && <Badge tone="info">New</Badge>}
                </td>
                <td>
                  <button className="patient-link" onClick={() => go(`/patient/${r.patient_id}`)}>
                    <span className="avatar xs">{initials(r.patient_name)}</span>
                    <span><strong>{r.patient_name}</strong><span>{visitId(r)}{r.ward ? ` · ${r.ward}` : ''}{r.consultant_name ? ` · ${r.consultant_name}` : ''}{r.case_no ? ` · ${r.case_no}` : ''}</span></span>
                  </button>
                </td>
                <td>
                  <strong>{r.exam_name}</strong>
                  <span className="table-sub">{r.channel_name || r.channel_code}{r.side && r.side !== 'NA' ? ` · ${r.side}` : ''}
                    {r.registration_no ? ` · ${r.registration_no}` : ''}{r.clinical_indication ? ` · ${r.clinical_indication}` : ''}</span>
                </td>
                <td className="mono n">
                  {r.kind === 'protocol' ? <Badge tone="neutral">{
                    r.status === 'WAITING' ? 'Assist next' : r.status === 'AT_ASSISTANT' ? 'With assist' : 'After tech'
                  }</Badge>
                    : r.no_charge ? <Badge tone="neutral">No charge</Badge> : <>
                    <strong>{inr(r.final_amount)}</strong>
                    {r.discount_amount > 0 && <span className="table-sub">−{inr(r.discount_amount)} disc.</span>}
                  </>}
                </td>
                <td>
                  <div className="cell-flags">
                    <Badge tone={PAY_TONE[r.payment_status] || 'neutral'}>{PAY_LABEL[r.payment_status] || r.payment_status}</Badge>
                    {r.pay_at_counter && <Badge tone="warning">At counter</Badge>}
                  </div>
                  {r.payment_ref && <span className="table-sub">{r.payment_ref}</span>}
                </td>
                <td>
                  <div className="cell-flags"><PriorityBadge priority={r.priority} /><StatusBadge status={r.status} />{r.hold_reason && <Badge tone="danger">Hold</Badge>}</div>
                  <span className="table-sub">{r.hold_reason || (r.eta_at ? `est. ${fmt(r.eta_at)}` : '')}</span>
                </td>
                <td className="col-action"><div className="row-actions">
                  {r.kind === 'protocol' ? (
                    <button onClick={() => go(`/patient/${r.patient_id}`)}>Patient</button>
                  ) : (<>
                    {r.status === 'SCHEDULED' && !r.hold_reason && <button className="primary" onClick={() => setArrival(r)}>Arrival</button>}
                    {r.status === 'NO_SHOW' && <button className="primary" disabled={a.busy} onClick={() => backInQueue(r)}>Back in queue</button>}
                    {r.pay_at_counter && <button className="primary" onClick={() => markPaid(r)}>Collect {inr(r.final_amount)}</button>}
                    {r.registration_id && r.pay_at_counter && <button onClick={() => go(`/registration/${r.registration_id}/pay`)}>Invoice</button>}
                    {['REPORTED', 'DISPATCHED'].includes(r.status) && <button className="primary" onClick={() => go(`/order/${r.id}`)}>{r.report_handover === 'CONSULTANT' ? 'To consultant' : 'Handover'}</button>}
                    {r.hold_reason ? <button onClick={() => clearHold(r)}>Clear hold</button> : <button onClick={() => hold(r)}>Hold</button>}
                    <button onClick={() => go(`/order/${r.id}`)}>Open</button>
                  </>)}
                </div></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>

      {arrival && <ArrivalModal order={{ ...arrival, patient_name: arrival.patient_name, mrn: visitId(arrival), dob: arrival.dob || '—', allergy: arrival.allergy || 'None recorded' }} onClose={() => { setArrival(null); load(); }} />}
    </div>
  );
}
