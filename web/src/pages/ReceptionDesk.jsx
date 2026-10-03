import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, Card, Empty, FormError, Icon, Notice, PageHeader, PriorityBadge, StatusBadge, fmt, go, inr, initials, toast, useAction } from '../ui.jsx';
import { ArrivalModal, requeue } from '../queue.jsx';

const PAY_TONE = { UNPAID: 'danger', PAID_OPD: 'success', PAID_RADIOLOGY: 'success', IPD_CREDIT: 'info', WAIVED: 'neutral', NOT_REQUIRED: 'neutral' };
const PAY_LABEL = { UNPAID: 'Unpaid', PAID_OPD: 'Paid · OPD', PAID_RADIOLOGY: 'Paid · Rad', IPD_CREDIT: 'IPD credit', WAIVED: 'Waived', NOT_REQUIRED: 'No pay' };

const CHANNEL_HINT = {
  OPD_CONSULTANT: { blurb: 'Consultant sent for scan — report back to OPD', pay: 'Pay at OPD' },
  OPD_FRONTDESK: { blurb: 'Front desk / follow-up report', pay: 'Pay at counter' },
  IPD: { blurb: 'Ward / ICU bed patient', pay: 'IPD bill' },
  ER: { blurb: 'Emergency — jumps the queue', pay: 'No pay gate' },
  WALKIN: { blurb: 'Outside Rx / walk-in', pay: 'Pay at counter' }
};

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
  const seen = useRef(loadSeen());
  const a = useAction();

  const load = async () => {
    try {
      const q = new URLSearchParams({ open: '1' });
      if (f.channel) q.set('channel', f.channel);
      const [board, ch, caseList] = await Promise.all([
        api.get('/reception/board?' + q),
        api.get('/masters/channels'),
        api.get('/cases?open=1')
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
  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t); }, [f.channel]);

  const markPaid = (row) => a.run(async () => {
    const ref = prompt(`Payment reference for ${row.exam_name} · ${inr(row.final_amount)}`);
    if (!ref) return;
    await api.post(`/orders/${row.id}/payment`, { paymentStatus: 'PAID_RADIOLOGY', paymentRef: ref });
    toast('Payment recorded at counter'); load();
  });
  const markOpdPaid = (row) => a.run(async () => {
    const ref = prompt('OPD receipt / bill number');
    if (!ref) return;
    await api.post(`/orders/${row.id}/payment`, { paymentStatus: 'PAID_OPD', paymentRef: ref });
    toast('Marked paid at OPD'); load();
  });
  const hold = (row) => a.run(async () => {
    const reason = prompt('Hold reason');
    if (!reason) return;
    await api.post(`/orders/${row.id}/hold`, { reason });
    toast('On hold'); load();
  });
  const clearHold = (row) => a.run(async () => { await api.post(`/orders/${row.id}/hold/clear`); toast('Hold cleared'); load(); });
  const backInQueue = (row) => a.run(async () => { await requeue(row); load(); });

  const textMatch = (r) => !f.q || `${r.patient_name} ${r.mrn} ${r.token_no || ''} ${r.exam_name} ${r.channel_code || ''} ${r.case_no || ''}`.toLowerCase().includes(f.q.toLowerCase());
  const awaitingProtocol = cases.flatMap((c) => (c.modalities || []).filter((m) => m.status === 'AWAITING_PROTOCOL').map((m) => ({ case: c, mod: m })));
  // Category-only cases have tokens/ETA but no orders yet — keep them on the desk until tech protocols.
  const protocolRows = awaitingProtocol.map(({ case: c, mod: m }) => ({
    id: m.id,
    kind: 'protocol',
    token_no: m.token_no,
    machine_code: m.machine_code,
    modality: m.modality,
    patient_id: c.patient_id,
    patient_name: c.patient_name,
    mrn: c.mrn,
    ward: c.ward,
    exam_name: `${m.modality === 'XR' ? 'X-ray' : m.modality} · awaiting services`,
    channel_code: c.channel_code,
    channel_name: c.channel_name,
    case_no: c.case_no,
    clinical_indication: c.clinical_indication,
    final_amount: null,
    discount_amount: 0,
    payment_status: c.payment_status || 'UNPAID',
    payment_place: c.payment_place,
    payment_ref: c.payment_ref,
    status: 'AWAITING_PROTOCOL',
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
    report_handover: c.report_handover
  })).filter(textMatch);
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
    : 'Today’s patients';

  const boardSubtitle = f.lane === 'pay'
    ? 'Collect before scan or at the end — service and amount shown. Tokens stay automatic.'
    : 'Category-only rows wait for technician services. Tokens and ETA are automatic — no booking times.';

  return (
    <>
      <PageHeader
        title="Reception desk"
        subtitle="Start a patient, then work the board. Categories only — tech picks services."
        actions={<div className="row-gap">
          <button className="btn btn-primary" onClick={() => go('/entry')}><Icon name="plus" size={14} /> New entry</button>
          <button className="btn btn-light" onClick={() => go('/register')}>New UHID</button>
        </div>}
      />

      <section className="channel-launch" aria-label="Where did this patient come from?">
        <header className="channel-launch-head">
          <h2>Patient at the counter — where from?</h2>
          <p>Pick the path. Payment and report handover follow the channel.</p>
        </header>
        <div className="channel-tiles">
          {(channels.length ? channels : Object.keys(CHANNEL_HINT).map((code) => ({ code, name: code }))).map((c) => {
            const hint = CHANNEL_HINT[c.code] || { blurb: c.notes || c.name, pay: c.payment_place };
            const n = boardAll.filter((r) => r.channel_code === c.code && !['REPORTED', 'DISPATCHED', 'COLLECTED', 'CANCELLED'].includes(r.status)).length;
            return (
              <button key={c.code} type="button" className={`channel-tile ${c.code === 'ER' ? 'urgent' : ''}`} onClick={() => go(`/entry?channel=${encodeURIComponent(c.code)}`)}>
                <span className="channel-tile-kicker">{hint.pay || c.payment_place}</span>
                <strong>{c.name}</strong>
                <span>{hint.blurb}</span>
                {n > 0 && <em>{n} in flow</em>}
              </button>
            );
          })}
        </div>
      </section>

      <div className="desk-focus" role="toolbar" aria-label="Board filters">
        {[
          ['all', 'All', base.length, null],
          ['waiting', 'Waiting', waiting.length, null],
          ['new', 'New', newCount, newCount ? 'hot' : null],
          ['pay', 'Pay at counter', payAtCounter.length, payAtCounter.length ? 'pay' : null],
          ['room', 'At modality', inRoom.length, null],
          ['report', 'Report', reporting.length, null]
        ].map(([id, label, n, tone]) => (
          <button key={id} type="button" className={`desk-focus-btn ${f.lane === id ? 'on' : ''} ${tone || ''}`} onClick={() => setLane(id)}>
            <strong>{n}</strong>
            <span>{label}</span>
          </button>
        ))}
      </div>

      {awaitingProtocol.length > 0 && (
        <Notice tone="amber">
          {awaitingProtocol.length} categor{awaitingProtocol.length === 1 ? 'y' : 'ies'} on the board awaiting technician services — amounts appear after protocol.
          {user.role !== 'reception' && <>{' '}<button type="button" className="linkish" onClick={() => go('/protocol')}>Open protocol</button></>}
        </Notice>
      )}

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
        subtitle={boardSubtitle}
        tools={<>
          <label className="search-box"><Icon name="search" size={14} /><input placeholder="Token, name, UHID" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></label>
          <select className={f.channel ? 'on' : ''} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            <option value="">All channels</option>
            {channels.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </>}
      >
        <FormError error={a.error} />
        {loading ? <Empty title="Loading…" /> : !laneRows.length ? (
          <Empty title="Nothing in this view" detail="Change the filter above or take a new entry." />
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
                    <span><strong>{r.patient_name}</strong><span>{r.mrn}{r.ward ? ` · ${r.ward}` : ''}{r.consultant_name ? ` · ${r.consultant_name}` : ''}{r.case_no ? ` · ${r.case_no}` : ''}</span></span>
                  </button>
                </td>
                <td>
                  <strong>{r.exam_name}</strong>
                  <span className="table-sub">{r.channel_name || r.channel_code}{r.side && r.side !== 'NA' ? ` · ${r.side}` : ''}
                    {r.registration_no ? ` · ${r.registration_no}` : ''}{r.clinical_indication ? ` · ${r.clinical_indication}` : ''}</span>
                </td>
                <td className="mono n">
                  {r.kind === 'protocol' ? <Badge tone="neutral">After protocol</Badge>
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
                    {r.payment_status === 'UNPAID' && r.payment_place === 'OPD' && <button onClick={() => markOpdPaid(r)}>OPD receipt</button>}
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

      {arrival && <ArrivalModal order={{ ...arrival, patient_name: arrival.patient_name, mrn: arrival.mrn, dob: arrival.dob || '—', allergy: arrival.allergy || 'None recorded' }} onClose={() => { setArrival(null); load(); }} />}
    </>
  );
}
