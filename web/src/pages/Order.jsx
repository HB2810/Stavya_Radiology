import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { BackLink, Badge, Card, Empty, ENCOUNTER_LABEL, FINAL, FormError, Icon, Modal, Notice, PageHeader, PatientBanner, PriorityBadge, RADIOLOGY, StatusBadge, Stepper, fmt, go, toast, useAction, useData, useLoad } from '../ui.jsx';
import { ArrivalModal, nextAction, requeue, useMove } from '../queue.jsx';
import { MedicalConsentTab, PastHistoryTab, ScanConsentTab, WordsTab } from './Intake.jsx';

const TABS = [['overview', 'Overview'], ['words', "Patient's words"], ['consent', 'Consent'], ['history', 'Past history'], ['scanconsent', 'Patient consent'], ['report', 'Report'], ['conversation', 'Conversation'], ['timeline', 'Timeline']];
const INTAKE = ['words', 'consent', 'history', 'scanconsent'];

export default function Order({ id, user, tab = 'overview' }) {
  const { data, error, reload } = useLoad(() => api.get('/orders/' + id), [id]);
  const { reload: reloadAll } = useData();
  const refresh = () => { reload(); reloadAll(); };
  if (error) return <><BackLink to="/orders">Imaging orders</BackLink><Card title="Study not found" icon="orders"><Empty title="That study could not be opened" detail={error.message} /></Card></>;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { order, events, safety, reports, templates, critical, messages, integrity } = data;
  const openCritical = critical.some((c) => ['OPEN', 'ESCALATED'].includes(c.state));
  const showIntake = ['technologist', 'radiologist', 'reception', 'admin', 'auditor'].includes(user.role);
  const tabs = TABS.filter(([k]) => showIntake || !INTAKE.includes(k));
  return (
    <>
      <BackLink to="/orders">Imaging orders</BackLink>
      <PatientBanner o={order} status={order.status} />
      <PageHeader title={order.exam_name} subtitle={`${order.accession} · requested by ${order.requested_by_name}${order.requested_by_designation ? ', ' + order.requested_by_designation : ''} · ${fmt(order.created_at)}`}
        actions={<><PriorityBadge priority={order.priority} />{order.overdue && <Badge tone="danger">Overdue</Badge>}<button className="btn btn-light" onClick={() => go(`/summary/${order.encounter_id}`)}><Icon name="report" size={14} /> Visit summary</button><button className="btn btn-light" onClick={() => go(`/patient/${order.patient_id}`)}><Icon name="patients" size={14} /> Patient chart</button></>} />
      {critical.length > 0 && <Card title="Critical result" icon="critical" tone="red" count={critical.length} className="critical-card">{critical.map((c) => <CriticalCase key={c.id} c={c} user={user} reload={refresh} />)}</Card>}
      <section className="card record-card">
        <nav className="record-tabs">{tabs.map(([k, l]) => <button key={k} className={k === tab ? 'active' : ''} onClick={() => go(`/order/${id}/${k}`)}>{l}{k === 'conversation' && messages.length > 0 ? ` (${messages.length})` : ''}</button>)}</nav>
        <div className="record-body">
          {tab === 'overview' && <Overview order={order} events={events} safety={safety} user={user} reload={refresh} openCritical={openCritical} />}
          {tab === 'words' && <WordsTab order={order} user={user} />}
          {tab === 'consent' && <MedicalConsentTab order={order} user={user} />}
          {tab === 'history' && <PastHistoryTab order={order} user={user} />}
          {tab === 'scanconsent' && <ScanConsentTab order={order} user={user} reload={refresh} />}
          {tab === 'report' && <Report order={order} reports={reports} templates={templates} integrity={integrity} user={user} reload={refresh} />}
          {tab === 'conversation' && <Thread orderId={order.id} messages={messages} user={user} reload={refresh} />}
          {tab === 'timeline' && <Timeline events={events} />}
        </div>
      </section>
    </>
  );
}

function Overview({ order, events, safety, user, reload, openCritical }) {
  const move = useMove(); const [modal, setModal] = useState(null); const a = useAction();
  const staff = RADIOLOGY.includes(user.role); const act = nextAction(order, user, false);
  const canCancel = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW', 'ARRIVED'].includes(order.status) && (order.requested_by === user.id || ['reception', 'radiologist'].includes(user.role));
  const needsSafety = (order.uses_contrast || order.ionising || order.mri) && ['technologist', 'radiologist'].includes(user.role) && ['SCHEDULED', 'ARRIVED', 'PREPARED', 'IN_PROGRESS'].includes(order.status);
  // The scan cannot start until a cleared safety screening is on record; say so instead of offering a Start that will be refused.
  const safetyPending = act.key === 'start' && (order.uses_contrast || order.ionising || order.mri) && !(safety && ['CLEARED', 'CLEARED_OVERRIDE'].includes(safety.status));
  const step = async (to) => { if (await move(order, to)) reload(); };
  const doPrimary = () => {
    if (act.key === 'requeue') return a.run(async () => { await requeue(order); reload(); });
    if (act.key === 'start') return step('IN_PROGRESS'); if (act.key === 'complete') return step('COMPLETED');
    if (act.key === 'consent') return go(`/order/${order.id}/scanconsent`); if (act.key === 'dispatch') return step('DISPATCHED'); if (act.key === 'collect') return step('COLLECTED');
    if (act.key === 'arrival') return setModal('arrival'); if (act.key === 'report') return go(`/order/${order.id}/report`);
  };
  const showPrimary = ['requeue', 'start', 'complete', 'arrival', 'report', 'consent', 'dispatch', 'collect'].includes(act.key);
  return (
    <>
      <div className="stepper-wrap">{order.status === 'CANCELLED' ? <Notice tone="red">Cancelled: {order.cancel_reason}</Notice> : <Stepper status={order.status} />}</div>
      <div className="order-card"><div className="order-card-head"><h3>Request</h3><StatusBadge status={order.status} /></div>
        <div className="order-card-body">
          <div className="field wide"><span>Clinical indication</span><strong>{order.clinical_indication}</strong></div>
          <div className="field"><span>Requested by</span><strong>{order.requested_by_name}{order.requested_by_designation ? `, ${order.requested_by_designation}` : ''}</strong></div>
          <div className="field"><span>Encounter</span><strong>{ENCOUNTER_LABEL[order.encounter_type] || order.encounter_type} {order.encounter_ref}</strong></div>
          <div className="field"><span>Report due</span><strong>{fmt(order.due_at)}</strong></div>
          {order.token_no && <div className="field"><span>Token</span><strong className="mono">{order.token_no}</strong></div>}
          {order.eta_at && <div className="field"><span>Queue estimate</span><strong>{fmt(order.eta_at)}</strong></div>}
          {order.channel_name && <div className="field"><span>Channel</span><strong>{order.channel_name}</strong></div>}
          <div className="field"><span>Modality</span><strong>{order.modality} · {order.body_part.replace('_', ' ').toLowerCase()}</strong></div>
        </div>
        {order.allergy !== 'None recorded' && <div className="order-card-notices"><Notice tone="red">Allergy on record: {order.allergy}</Notice></div>}
        <div className="order-card-foot">
          <span className="step-hint">{safetyPending ? (safety?.status === 'BLOCKED' ? 'Safety screening is blocked: the radiologist must override it below.' : 'Next: record the safety screening below, then Start.') : showPrimary ? `Next: ${act.label}` : openCritical ? 'A critical result is open.' : 'No action needed from you right now.'}</span>
          {showPrimary && <button className="btn btn-primary btn-sm" disabled={safetyPending || a.busy} onClick={doPrimary}>{act.label}</button>}
          {staff && order.status === 'SCHEDULED' && <button className="btn btn-light btn-sm" onClick={() => step('NO_SHOW')}>No show</button>}
          {canCancel && <button className="btn btn-light btn-sm" onClick={() => setModal('cancel')}>Cancel order</button>}
        </div>
      </div>
      <Journey order={order} events={events} />
      {needsSafety && <Safety order={order} safety={safety} user={user} reload={reload} />}
      {!needsSafety && safety && <div className="order-card"><div className="order-card-head"><h3>Safety screening</h3><Badge tone={safety.status === 'BLOCKED' ? 'danger' : 'success'}>{safety.status.replace('_', ' ')}</Badge></div>
        <div className="order-card-body"><div className="field wide"><span>Recorded by</span><strong>{safety.actor_name} · {fmt(safety.at)}</strong></div></div></div>}
      {modal === 'arrival' && <ArrivalModal order={order} onClose={() => { setModal(null); reload(); }} />}
      {modal === 'cancel' && <CancelModal order={order} onClose={() => { setModal(null); reload(); }} />}
    </>
  );
}

function CancelModal({ order, onClose }) {
  const move = useMove(); const [why, setWhy] = useState('');
  return (
    <Modal title="Cancel order" icon="x" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Keep order</button><button className="btn btn-danger" disabled={!why.trim()} onClick={async () => { if (await move(order, 'CANCELLED', { note: why })) onClose(); }}>Cancel order</button></>}>
      <div className="form-grid"><label className="wide"><span>Reason (shared with the requester)</span><textarea value={why} onChange={(e) => setWhy(e.target.value)} /></label></div>
    </Modal>
  );
}

function Safety({ order, safety, user, reload }) {
  const [f, setF] = useState({ pregnant: order.sex === 'F' ? 'NO' : 'NA', contrastAllergy: order.uses_contrast ? 'NO' : 'NA', mriImplant: order.mri ? 'NO' : 'NA', egfr: '', notes: '', overrideReason: '' });
  const a = useAction(); const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="order-card"><div className="order-card-head"><h3>Safety screening</h3>{safety && <Badge tone={safety.status === 'BLOCKED' ? 'danger' : 'success'}>{safety.status.replace('_', ' ')}</Badge>}</div>
      {safety?.flags.length > 0 && <div className="order-card-notices" style={{ paddingTop: 12 }}>{safety.flags.map((x, i) => <Notice key={i} tone={x.level === 'BLOCK' ? 'red' : 'amber'}>{x.text}</Notice>)}{safety.override_reason && <Notice tone="amber">Radiologist override: {safety.override_reason}</Notice>}</div>}
      <div className="form-grid" style={{ padding: 14 }}>
        <label><span>Pregnant</span><select value={f.pregnant} onChange={set('pregnant')}><option>NA</option><option>NO</option><option>YES</option></select></label>
        {order.uses_contrast ? <><label><span>Contrast allergy</span><select value={f.contrastAllergy} onChange={set('contrastAllergy')}><option>NO</option><option>YES</option></select></label><label><span>eGFR (1–150)</span><input type="number" min={1} max={150} step="any" value={f.egfr} onChange={set('egfr')} placeholder="mL/min/1.73 m²" /></label></> : null}
        {order.mri ? <label><span>MRI implant / device</span><select value={f.mriImplant} onChange={set('mriImplant')}><option>NO</option><option>YES</option><option>UNKNOWN</option></select></label> : null}
        <label className="wide"><span>Notes</span><input value={f.notes} onChange={set('notes')} /></label>
        {user.role === 'radiologist' && <label className="wide"><span>Radiologist override (only when blocked)</span><input value={f.overrideReason} onChange={set('overrideReason')} placeholder="Reason for proceeding" /></label>}
        <div className="wide"><FormError error={a.error} /></div>
      </div>
      <div className="order-card-foot"><button className="btn btn-primary btn-sm" disabled={a.busy} onClick={() => a.run(async () => { await api.post(`/orders/${order.id}/safety`, { ...f, egfr: f.egfr === '' ? null : Number(f.egfr), overrideReason: f.overrideReason || undefined }); toast('Screening recorded'); reload(); })}>Record screening</button></div>
    </div>
  );
}

function Report({ order, reports, templates, integrity, user, reload }) {
  const draft = reports.find((r) => r.status === 'DRAFT'); const finals = reports.filter((r) => r.status === 'FINAL');
  const canWrite = user.role === 'radiologist' && ['COMPLETED', 'REPORT_DRAFTED'].includes(order.status);
  const [f, setF] = useState({ technique: '', findings: '', impression: '', recommendation: '' }); const [hits, setHits] = useState([]); const [decl, setDecl] = useState(null); const [rev, setRev] = useState(1); const a = useAction();
  useEffect(() => { if (draft) { setF({ technique: draft.technique, findings: draft.findings, impression: draft.impression, recommendation: draft.recommendation }); setRev(draft.revision); } }, [draft?.id, draft?.revision]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => a.run(async () => { const r = await api.post(`/orders/${order.id}/report`, { ...f, expectedRevision: draft ? rev : undefined }); setRev(r.report.revision); setHits(r.criticalSuggestions); return r; });
  const sign = (extra = {}) => a.run(async () => {
    const saved = await save(); if (!saved) return;
    try { await api.post(`/reports/${saved.report.id}/sign`, { expectedRevision: saved.report.revision, ...extra }); toast('Report signed'); setDecl(null); reload(); }
    catch (e) { if (e.code === 'CRITICAL_DECLARATION_REQUIRED') setDecl({ hits: e.body.hits, summary: '', reason: '' }); else throw e; }
  });
  const print = async () => { const html = await api.html(`/orders/${order.id}/print`); const w = window.open(); if (w) { w.document.write(html); w.document.close(); } };
  return (
    <>
      {finals.length > 0 && <div className="final-stamp"><Icon name="check" size={16} /> Finalised and signed · {integrity.valid ? 'signature chain verified' : 'SIGNATURE CHAIN BROKEN'}<span style={{ marginLeft: 'auto' }}><button className="btn btn-light btn-sm" onClick={print}>Print / PDF</button></span></div>}
      {finals.map((r) => (
        <article className="order-card" key={r.id}><header className="order-card-head"><div><h3>{r.kind === 'ADDENDUM' ? `Addendum v${r.version}: ${r.addendum_reason}` : 'Report'}</h3><span className="table-sub">{r.author_name} · {fmt(r.signed_at)}</span></div></header>
          <div style={{ padding: 14 }}>{r.technique && <div className="read-group"><span className="read-label">Technique</span><div className="read-block">{r.technique}</div></div>}
            <div className="read-group"><span className="read-label">Findings</span><div className="read-block">{r.findings}</div></div>
            {r.impression && <div className="read-group"><span className="read-label">Impression</span><div className="read-block">{r.impression}</div></div>}
            {r.recommendation && <div className="read-group"><span className="read-label">Recommendation</span><div className="read-block">{r.recommendation}</div></div>}</div></article>))}
      {FINAL.includes(order.status) && user.role === 'radiologist' && <Addendum orderId={order.id} reload={reload} />}
      {canWrite && (<>
        <div className="form-grid" style={{ marginBottom: 14 }}><label className="wide"><span>Template</span><select defaultValue="" onChange={(e) => { const t = templates.find((x) => x.id === e.target.value); if (t) setF({ ...f, technique: t.technique, findings: t.findings, impression: t.impression }); }}><option value="">Start from a reviewed template…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label></div>
        {[['technique', 'Technique', 2], ['findings', 'Findings', 9], ['impression', 'Impression', 4], ['recommendation', 'Recommendation', 2]].map(([k, l, r]) => <label className="field-label" key={k}><span>{l}</span><textarea rows={r} style={{ minHeight: 0 }} value={f[k]} onChange={set(k)} /></label>)}
        {hits.length > 0 && <Notice>Possible critical wording: {hits.join(', ')}. You will be asked to declare whether this is a critical result.</Notice>}
        {decl && <div className="confirm-line" style={{ display: 'block' }}><b>Critical result check</b> — wording found: {decl.hits.join(', ')}
          <div className="form-grid" style={{ marginTop: 10 }}><label className="wide"><span>Summary to tell the clinician (if critical)</span><input value={decl.summary} onChange={(e) => setDecl({ ...decl, summary: e.target.value })} /></label>
            <label className="wide"><span>Reason (if NOT critical)</span><input value={decl.reason} onChange={(e) => setDecl({ ...decl, reason: e.target.value })} /></label></div>
          <div className="row-gap" style={{ marginTop: 10 }}><button className="btn btn-danger btn-sm" disabled={!decl.summary.trim()} onClick={() => sign({ criticalDeclared: 'YES', criticalSummary: decl.summary })}>Sign as CRITICAL</button><button className="btn btn-light btn-sm" disabled={!decl.reason.trim()} onClick={() => sign({ criticalDeclared: 'NO', criticalNoReason: decl.reason })}>Sign, not critical</button></div></div>}
        <FormError error={a.error} />
        <div className="report-foot"><span className="report-note">Signing locks the report. Later changes are addenda.</span><button className="btn btn-light" disabled={a.busy} onClick={async () => { if (await save()) { toast('Draft saved'); reload(); } }}>Save draft</button><button className="btn btn-primary" disabled={a.busy || !f.findings.trim() || !f.impression.trim()} onClick={() => sign()}>Sign report</button></div>
      </>)}
      {!finals.length && !canWrite && <Empty title="No signed report yet" detail={user.role === 'radiologist' ? 'The scan must be completed before reporting.' : 'You will be notified the moment it is finalised.'} />}
    </>
  );
}

function Addendum({ orderId, reload }) {
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(''); const [text, setText] = useState(''); const a = useAction();
  if (!open) return <button className="btn btn-light btn-sm" onClick={() => setOpen(true)}>Add addendum</button>;
  return <Modal title="Add addendum" icon="report" onClose={() => setOpen(false)} foot={<><button className="btn btn-light" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!reason.trim() || !text.trim() || a.busy} onClick={() => a.run(async () => { await api.post(`/orders/${orderId}/addendum`, { reason, findings: text }); toast('Addendum signed'); setOpen(false); reload(); })}>Sign addendum</button></>}>
    <FormError error={a.error} /><div className="form-grid"><label className="wide"><span>Reason</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label><label className="wide"><span>Addendum text</span><textarea value={text} onChange={(e) => setText(e.target.value)} /></label></div></Modal>;
}

export function CriticalCase({ c, user, reload }) {
  const a = useAction(); const [f, setF] = useState({ receiverName: '', channel: 'PHONE', readBack: false, actionPlan: '' });
  const open = ['OPEN', 'ESCALATED'].includes(c.state);
  return (
    <div className="finding"><div className="finding-head"><h3>{c.summary}</h3><Badge tone={c.state === 'ACKNOWLEDGED' ? 'success' : c.state === 'ESCALATED' ? 'danger' : 'warning'}>{c.state}</Badge></div>
      <div className="finding-body"><div className="field"><span>Communicate by</span><strong>{fmt(c.due_at)}</strong></div>
        {(c.events || []).map((e) => <div className="field" key={e.id}><span>{e.state} · {fmt(e.at)}</span><strong>{e.actor_name}{e.receiver_name ? ` → ${e.receiver_name} (${e.channel}, read-back)` : ''}{e.note && e.state !== 'OPEN' ? ` — ${e.note}` : ''}</strong></div>)}</div>
      {(open && user.role === 'radiologist') || (c.state !== 'ACKNOWLEDGED' && ['clinician', 'nurse'].includes(user.role)) ? (
        <div className="finding-foot" style={{ display: 'block' }}>
          {open && user.role === 'radiologist' && <div className="form-grid"><label><span>Spoke to</span><input value={f.receiverName} onChange={(e) => setF({ ...f, receiverName: e.target.value })} /></label>
            <label><span>Channel</span><select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option>PHONE</option><option>IN_PERSON</option><option>PAGER</option></select></label>
            <label className="check-row wide"><input type="checkbox" checked={f.readBack} onChange={(e) => setF({ ...f, readBack: e.target.checked })} /><span>The receiver read the result back to me</span></label></div>}
          {c.state !== 'ACKNOWLEDGED' && ['clinician', 'nurse'].includes(user.role) && <div className="form-grid"><label className="wide"><span>Action plan</span><input value={f.actionPlan} onChange={(e) => setF({ ...f, actionPlan: e.target.value })} /></label></div>}
          <FormError error={a.error} />
          <div className="row-gap" style={{ marginTop: 10 }}>
            {open && user.role === 'radiologist' && <button className="btn btn-primary btn-sm" disabled={!f.receiverName.trim() || !f.readBack || a.busy} onClick={() => a.run(async () => { await api.post(`/critical/${c.id}/communicate`, f); toast('Communication recorded'); reload(); })}>Record communication</button>}
            {c.state !== 'ACKNOWLEDGED' && ['clinician', 'nurse'].includes(user.role) && <button className="btn btn-primary btn-sm" disabled={!f.actionPlan.trim() || a.busy} onClick={() => a.run(async () => { await api.post(`/critical/${c.id}/acknowledge`, { actionPlan: f.actionPlan }); toast('Result acknowledged'); reload(); })}>Acknowledge result</button>}</div>
        </div>) : null}
    </div>
  );
}

function Thread({ orderId, messages, user, reload }) {
  const [text, setText] = useState(''); const a = useAction();
  const send = () => text.trim() && a.run(async () => { await api.post(`/orders/${orderId}/messages`, { body: text }); setText(''); reload(); });
  return (
    <>
      <div className="thread">{messages.length === 0 && <Empty title="No messages" detail="Ask a question about this study here so it stays with the record." />}
        {messages.map((m) => <div key={m.id} className={`msg ${m.sender_id === user.id ? 'mine' : ''}`}><small>{m.sender_name} · {m.sender_role} · {fmt(m.created_at)}</small><div>{m.body}</div></div>)}</div>
      {user.role !== 'auditor' && <><FormError error={a.error} /><div className="compose"><input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message to the ward or radiology" onKeyDown={(e) => e.key === 'Enter' && send()} /><button className="btn btn-primary" disabled={!text.trim() || a.busy} onClick={send}>Send</button></div></>}
    </>
  );
}

function Timeline({ events }) {
  const tone = (s) => (s === 'REPORTED' ? 'green' : s === 'CANCELLED' || s === 'NO_SHOW' ? 'red' : 'blue');
  return (
    <div className="timeline">{events.map((e, i) => (
      <div className="tl-row" key={e.id}>
        <div className="tl-time"><strong>{new Date(e.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</strong><span>{new Date(e.at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span></div>
        <div className="tl-rail"><span className={`tl-dot ${tone(e.to_status)}`}><Icon name="check" size={11} /></span>{i < events.length - 1 && <span className="tl-line" />}</div>
        <div className="tl-body"><strong>{({ REQUESTED: 'Requested', ACKNOWLEDGED: 'Acknowledged', SCHEDULED: 'Scheduled', ARRIVED: 'Patient arrived', IN_PROGRESS: 'Scan started', COMPLETED: 'Scan complete', REPORT_DRAFTED: 'Report drafted', REPORTED: 'Report finalised', NO_SHOW: 'No show', CANCELLED: 'Cancelled' })[e.to_status] || e.to_status}</strong><small>{e.actor_name}{e.note ? ` · ${e.note}` : ''}</small></div>
      </div>))}</div>
  );
}

// Per-step timestamps and turnaround time (agency "Show details" panel).
const JOURNEY = [['REQUESTED', 'Order placed'], ['ARRIVED', 'Arrived'], ['PREPARED', 'Prepared'], ['IN_PROGRESS', 'Scan in'], ['COMPLETED', 'Scan out'], ['REPORTED', 'Report finalised'], ['DISPATCHED', 'Report dispatched'], ['COLLECTED', 'Report collected']];
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 90 ? `${m} min` : m < 2880 ? `${(m / 60).toFixed(1)} h` : `${(m / 1440).toFixed(1)} days`; };
function Journey({ order, events }) {
  const at = (st) => events.find((e) => e.to_status === st)?.at;
  const last = [...JOURNEY].reverse().find(([st]) => at(st)); const started = Date.parse(order.created_at);
  const end = order.status === 'CANCELLED' ? Date.parse(events[events.length - 1].at) : last && ['REPORTED', 'DISPATCHED', 'COLLECTED'].includes(last[0]) ? Date.parse(at('REPORTED')) : Date.now();
  const done = ['REPORTED', 'DISPATCHED', 'COLLECTED', 'CANCELLED'].includes(order.status);
  return (
    <div className="order-card"><div className="order-card-head"><h3>Journey</h3>{order.status === 'CANCELLED' ? <Badge tone="neutral">Terminated</Badge> : <Badge tone={done ? 'success' : 'info'}>{done ? 'Turnaround' : 'Elapsed'} {dur(end - started)}</Badge>}</div>
      <div className="table-scroll"><table className="clinical-table compact"><tbody>{JOURNEY.map(([st, label]) => <tr key={st}><td style={{ width: 170 }}>{label}</td><td className="mono">{at(st) ? fmt(at(st)) : <span className="muted-cell">—</span>}</td></tr>)}
        {order.status === 'CANCELLED' && <tr><td>Terminated</td><td className="mono">{fmt(events[events.length - 1].at)} · {order.cancel_reason}</td></tr>}</tbody></table></div></div>
  );
}
