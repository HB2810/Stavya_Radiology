import { useState } from 'react';
import { api } from '../api.js';
import { BackLink, Badge, Card, Empty, ENCOUNTER_LABEL, FormError, Icon, Modal, PageHeader, PatientBanner, Stepper, StatusBadge, PriorityBadge, fmt, fmtDate, go, useAction, useLoad } from '../ui.jsx';
import { QueueTable } from '../queue.jsx';

export function Patients({ user, query }) {
  const [q, setQ] = useState(query.q || ''); const [adding, setAdding] = useState(false);
  const list = useLoad(() => (q.trim().length >= 2 ? api.get('/patients?q=' + encodeURIComponent(q.trim())) : Promise.resolve([])), [q]);
  return (
    <>
      <PageHeader title="Patients" actions={['reception', 'admin'].includes(user.role) && <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> Register patient</button>} />
      <Card title="Directory" icon="patients" count={list.data?.length} tools={<label className="search-box"><Icon name="search" size={14} /><input autoFocus placeholder="Name, UHID or phone" value={q} onChange={(e) => setQ(e.target.value)} /></label>} flush foot="Type at least two characters.">
        {list.data?.length ? <div className="table-scroll"><table className="clinical-table"><thead><tr><th>Patient / UHID</th><th>Date of birth</th><th>Sex</th><th>Phone</th><th>Allergy</th></tr></thead><tbody>
          {list.data.map((p) => <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => go(`/patient/${p.id}`)}><td><span className="patient-link"><strong>{p.name}</strong><span>{p.mrn}</span></span></td><td>{fmtDate(p.dob)}</td><td>{p.sex}</td><td>{p.phone}</td><td className={p.allergy !== 'None recorded' ? 'allergy-text' : ''}>{p.allergy}</td></tr>)}</tbody></table></div>
          : <Empty title={q.trim().length >= 2 ? 'No patients found' : 'Search to begin'} detail={q.trim().length >= 2 ? 'Check the spelling or UHID.' : 'Use the header search or type here.'} />}
      </Card>
      {adding && <NewPatient onClose={() => setAdding(false)} />}
    </>
  );
}

function NewPatient({ onClose }) {
  const [f, setF] = useState({ mrn: '', name: '', dob: '', sex: 'M', phone: '', allergy: '' }); const a = useAction(); const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Register patient" icon="user" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={a.busy} onClick={() => a.run(async () => { const p = await api.post('/patients', f); onClose(); go(`/patient/${p.id}`); })}>Create</button></>}>
      <FormError error={a.error} />
      <div className="form-grid"><label><span>UHID</span><input value={f.mrn} onChange={set('mrn')} /></label><label><span>Full name</span><input value={f.name} onChange={set('name')} /></label>
        <label><span>Date of birth</span><input type="date" value={f.dob} onChange={set('dob')} /></label><label><span>Sex</span><select value={f.sex} onChange={set('sex')}><option>M</option><option>F</option><option>O</option></select></label>
        <label><span>Phone</span><input value={f.phone} onChange={set('phone')} /></label><label><span>Allergy</span><input placeholder="None recorded" value={f.allergy} onChange={set('allergy')} /></label></div>
    </Modal>
  );
}

const TABS = [['journey', 'Journey'], ['studies', 'Studies'], ['safety', 'Safety'], ['reports', 'Reports']];

export function PatientChart({ user, id, tab = 'journey' }) {
  const { data, error, reload } = useLoad(() => api.get('/patients/' + id), [id]);
  const details = useLoad(() => (data ? Promise.all(data.orders.map((o) => api.get('/orders/' + o.id))) : Promise.resolve([])), [data?.orders?.map((o) => o.id + o.status).join()]);
  const [enc, setEnc] = useState(false);
  if (error) return <Card title="Patient not found" icon="patients"><Empty title="That patient could not be opened" detail={error.message} /></Card>;
  if (!data) return <div className="empty-state">Loading…</div>;
  const { patient, encounters, orders } = data;
  const active = encounters.find((e) => e.status === 'ACTIVE') || encounters[0];
  const banner = { ...patient, patient_name: patient.name, encounter_type: active?.type, encounter_ref: active?.ref_no, ward: active?.ward, room: active?.room, bed: active?.bed, diagnosis: active?.diagnosis, consultant_name: active?.doctor_name };
  const dmap = Object.fromEntries((details.data || []).map((d) => [d.order.id, d]));
  const latest = orders.find((o) => o.status !== 'CANCELLED');
  return (
    <>
      <BackLink to="/patients">All patients</BackLink>
      <PatientBanner o={banner} status={latest?.status} />
      <section className="card record-card">
        <nav className="record-tabs">{TABS.map(([k, l]) => <button key={k} className={k === tab ? 'active' : ''} onClick={() => go(`/patient/${id}/${k}`)}>{l}</button>)}</nav>
        <div className="record-body">
          {tab === 'journey' && (orders.length ? <ol className="journey">{orders.map((o) => (
            <li className="journey-step" key={o.id}><div className="journey-rail" /><div className="journey-body">
              <header><strong>{o.exam_name}</strong><StatusBadge status={o.status} /><PriorityBadge priority={o.priority} /></header>
              <p>{o.clinical_indication}</p><div className="stepper-wrap"><Stepper status={o.status} /></div>
              <footer><span>{fmt(o.created_at)} · requested by {o.requested_by_name}</span><span className="row-end"><button className="btn btn-primary btn-sm" onClick={() => go(`/order/${o.id}`)}>Study workspace</button></span></footer></div></li>))}</ol>
            : <Empty title="No imaging yet" />)}
          {tab === 'studies' && <div style={{ margin: '-20px -16px' }}><QueueTable rows={orders} user={user} emptyTitle="No imaging yet" /></div>}
          {tab === 'safety' && (<>
            <dl className="defs"><div><dt>Allergy</dt><dd className={patient.allergy !== 'None recorded' ? 'allergy-text' : ''}>{patient.allergy}</dd></div><div><dt>Date of birth</dt><dd>{fmtDate(patient.dob)} (confirm with UHID at arrival)</dd></div>
              {encounters.map((e) => <div key={e.id}><dt>{ENCOUNTER_LABEL[e.type] || e.type}</dt><dd>{e.ref_no}{e.ward ? ` · ${e.ward} ${e.room || ''} bed ${e.bed || '—'}` : ''}{e.diagnosis ? ` · ${e.diagnosis}` : ''}</dd></div>)}</dl>
            {orders.map((o) => { const s = dmap[o.id]?.safety; return <section className="sub mt" key={o.id}><h3>{o.exam_name} — screening</h3>
              {s ? <p className="note">{s.status} · {s.actor_name}, {fmt(s.at)}{s.flags.map((x, i) => <span key={i}><br />{x.level}: {x.text}</span>)}</p> : <p className="note">{o.uses_contrast || o.ionising || o.mri ? 'Not yet screened.' : 'No screening needed for this exam.'}</p>}</section>; })}
          </>)}
          {tab === 'reports' && (() => { const rep = orders.filter((o) => dmap[o.id]?.reports.some((r) => r.status === 'FINAL')); return rep.length ? rep.map((o) => { const r = dmap[o.id].reports.filter((x) => x.status === 'FINAL'); return (
            <article className="order-card" key={o.id}><header className="order-card-head"><div><h3>{o.exam_name}</h3><span className="table-sub">{r[0].author_name} · {fmt(r[0].signed_at)}</span></div><StatusBadge status={o.status} /></header>
              <div className="order-card-body"><div className="field wide"><span>Impression</span><strong>{r[0].impression}</strong></div></div>
              <footer className="order-card-foot"><button className="btn btn-light btn-sm" onClick={() => go(`/order/${o.id}/report`)}>Open report</button></footer></article>); }) : <Empty title="No reports yet" />; })()}
        </div>
      </section>
      <Card title="Encounters" icon="orders" count={encounters.length} actions={['reception', 'admin', 'nurse'].includes(user.role) && <button className="btn btn-light btn-sm" onClick={() => setEnc(true)}>Add encounter</button>} flush>
        <div className="table-scroll"><table className="clinical-table"><thead><tr><th>Type</th><th>Reference</th><th>Location</th><th>Consultant</th><th>Status</th></tr></thead><tbody>
          {encounters.map((e) => <tr key={e.id}><td><Badge tone="info">{ENCOUNTER_LABEL[e.type] || e.type}</Badge></td><td className="mono">{e.ref_no}</td><td>{e.ward ? `${e.ward} · ${e.room || '—'} · Bed ${e.bed || '—'}` : 'Outpatient'}</td><td>{e.doctor_name || '—'}</td><td>{e.status}</td></tr>)}</tbody></table></div>
      </Card>
      {enc && <NewEncounter patientId={id} onClose={() => { setEnc(false); reload(); }} />}
    </>
  );
}

function NewEncounter({ patientId, onClose }) {
  const docs = useLoad(() => api.get('/clinicians')); const a = useAction();
  const [f, setF] = useState({ type: 'OPD', refNo: '', ward: '', room: '', bed: '', diagnosis: '', doctorId: '' }); const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add encounter" icon="orders" onClose={onClose} foot={<><button className="btn btn-light" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={a.busy} onClick={() => a.run(async () => { await api.post(`/patients/${patientId}/encounters`, { ...f, doctorId: f.doctorId || undefined }); onClose(); })}>Save</button></>}>
      <FormError error={a.error} />
      <div className="form-grid"><label><span>Type</span><select value={f.type} onChange={set('type')}><option value="OPD">OPD</option><option value="IPD">IPD</option><option value="OT">OT</option><option value="EXTERNAL">{ENCOUNTER_LABEL.EXTERNAL}</option></select></label><label><span>Visit / admission no</span><input value={f.refNo} onChange={set('refNo')} /></label>
        <label><span>Ward</span><input value={f.ward} onChange={set('ward')} /></label><label><span>Room</span><input value={f.room} onChange={set('room')} /></label><label><span>Bed</span><input value={f.bed} onChange={set('bed')} /></label>
        <label><span>Consultant</span><select value={f.doctorId} onChange={set('doctorId')}><option value="">—</option>{docs.data?.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</select></label>
        <label className="wide"><span>Diagnosis</span><input value={f.diagnosis} onChange={set('diagnosis')} /></label></div>
    </Modal>
  );
}
