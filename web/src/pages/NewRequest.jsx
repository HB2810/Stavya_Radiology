import { useEffect, useRef, useState } from 'react';
import { api, newKey } from '../api.js';
import { Card, FormError, Icon, PageHeader, PatientBanner, Notice, RadiologyLoadStrip, go, toast, useAction, useLoad } from '../ui.jsx';

export default function NewRequest({ user }) {
  const [q, setQ] = useState(''); const [results, setResults] = useState([]); const [patient, setPatient] = useState(null); const [overview, setOverview] = useState(null);
  const [enc, setEnc] = useState(''); const [indication, setIndication] = useState(''); const [exam, setExam] = useState(''); const [priority, setPriority] = useState('ROUTINE');
  const [suggest, setSuggest] = useState([]); const [dup, setDup] = useState(''); const exams = useLoad(() => api.get('/catalog/exams')); const a = useAction(); const key = useRef(newKey()); // one key per request form: a repeated submit returns the first result
  useEffect(() => { if (q.trim().length < 2) return setResults([]); const t = setTimeout(() => api.get('/patients?q=' + encodeURIComponent(q.trim())).then(setResults).catch(() => {}), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (indication.trim().length < 6) return setSuggest([]); const t = setTimeout(() => api.get('/catalog/suggest?indication=' + encodeURIComponent(indication)).then(setSuggest).catch(() => {}), 350); return () => clearTimeout(t); }, [indication]);
  const pick = async (p) => { setPatient(p); setResults([]); setQ(''); const o = await api.get('/patients/' + p.id); setOverview(o); setEnc(o.encounters.find((e) => e.status === 'ACTIVE')?.id || ''); };
  const active = overview?.encounters.filter((e) => e.status === 'ACTIVE') || []; const encounter = active.find((e) => e.id === enc);
  const chosen = exams.data?.find((e) => e.code === exam);
  const send = (confirmDuplicate = false) => a.run(async () => {
    try { const r = await api.post('/orders', { patientId: patient.id, encounterId: enc, examCode: exam, priority, clinicalIndication: indication, confirmDuplicate }, { key: key.current }); key.current = newKey(); toast('Request sent to radiology'); go(`/order/${r.order.id}`); }
    catch (e) { if (e.code === 'POSSIBLE_DUPLICATE') setDup(e.message); else throw e; }
  });
  return (
    <>
      <PageHeader title="New radiology request" subtitle="The clinical question decides how the study is protocolled." />
      <RadiologyLoadStrip />
      {patient && overview &&<PatientBanner o={{ ...patient, patient_name: patient.name, encounter_type: encounter?.type, encounter_ref: encounter?.ref_no, ward: encounter?.ward, room: encounter?.room, bed: encounter?.bed, diagnosis: encounter?.diagnosis, consultant_name: encounter?.doctor_name }} />}
      <div className="grid-2">
        <Card title="1. Patient and encounter" icon="patients" actions={patient && <button className="btn btn-light btn-sm" onClick={() => { setPatient(null); setOverview(null); setEnc(''); }}>Change</button>}>
          {!patient ? (<>
            <label className="search-box" style={{ maxWidth: 'none' }}><Icon name="search" size={14} /><input autoFocus placeholder="Search by name, UHID or phone" value={q} onChange={(e) => setQ(e.target.value)} /></label>
            <div className="pick-list">{results.map((p) => <button key={p.id} className="pick" onClick={() => pick(p)}><strong>{p.name}</strong><span>{p.mrn} · {p.dob} · {p.sex}</span></button>)}</div></>
          ) : (<div className="form-grid">
            <label className="wide"><span>Encounter</span><select value={enc} onChange={(e) => setEnc(e.target.value)}>{active.map((e) => <option key={e.id} value={e.id}>{e.type} {e.ref_no}{e.ward ? ` · ${e.ward} bed ${e.bed || '—'}` : ''}</option>)}</select></label>
            {!active.length && <div className="wide"><Notice tone="red">No active encounter. Ask reception to register the OPD visit or admission.</Notice></div>}
            {overview.orders.length > 0 && <p className="note wide">Recent imaging: {overview.orders.slice(0, 3).map((o) => `${o.exam_name} (${o.status.toLowerCase().replace('_', ' ')})`).join('; ')}</p>}
            {patient.allergy !== 'None recorded' && <div className="wide"><Notice tone="red">Allergy: {patient.allergy}</Notice></div>}</div>)}
        </Card>
        <Card title="2. Clinical question and study" icon="orders" foot={`Report target: ${priority === 'STAT' ? '1 hour' : priority === 'URGENT' ? '4 hours' : '24 hours'}. STAT alerts radiology immediately.`}>
          <div className="form-grid">
            <label className="wide"><span>Clinical indication</span><textarea rows={3} value={indication} onChange={(e) => setIndication(e.target.value)} placeholder="e.g. Bilateral leg weakness, urinary retention" /></label>
            {suggest.length > 0 && <div className="wide chips">Suggested: {suggest.map((s) => <button key={s.code} className={`chip ${exam === s.code ? 'on' : ''}`} title={`matched: ${s.matched.join(', ')}`} onClick={() => setExam(s.code)}>{s.name}</button>)}</div>}
            <label className="wide"><span>Study</span><select value={exam} onChange={(e) => setExam(e.target.value)}><option value="">Select…</option>{exams.data?.map((e) => <option key={e.code} value={e.code} disabled={e.price == null}>{e.modality} · {e.name}{e.price == null ? ' (no price set)' : ''}</option>)}</select></label>
            {chosen?.prep && <div className="wide"><Notice>Patient preparation: {chosen.prep}</Notice></div>}
            {chosen && chosen.price == null && <div className="wide"><Notice tone="red">No price is set for this service yet; ask an administrator to set it before it can be ordered.</Notice></div>}
            <div className="wide"><span className="chart-title">Priority</span><div className="seg">{['ROUTINE', 'URGENT', 'STAT'].map((p) => <button key={p} className={priority === p ? `on ${p}` : ''} onClick={() => setPriority(p)}>{p}</button>)}</div></div>
          </div>
        </Card>
      </div>
      {dup && <div className="confirm-line"><Icon name="critical" size={14} /><span>{dup}</span><span className="row-gap"><button className="btn btn-light btn-sm" onClick={() => setDup('')}>Cancel</button><button className="btn btn-primary btn-sm" onClick={() => { setDup(''); send(true); }}>Order anyway</button></span></div>}
      <FormError error={a.error} />
      <div className="row-gap" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={a.busy || !patient || !enc || !exam || chosen?.price == null || indication.trim().length < 5} onClick={() => send(false)}>{a.busy ? 'Sending…' : 'Send to radiology'}</button></div>
    </>
  );
}
