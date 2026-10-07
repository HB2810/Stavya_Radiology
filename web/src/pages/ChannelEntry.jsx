import { useEffect, useRef, useState } from 'react';
import Register from './Register.jsx';
import { api, newKey } from '../api.js';
import { Badge, Card, FormError, Icon, Notice, PageHeader, PatientBanner, go, toast, useAction, useLoad, visitId } from '../ui.jsx';

const MODALITY_LABEL = { DEXA: 'DEXA', MRI: 'MRI', OPEN_MRI: 'Open MRI', XR: 'X-Ray', USG: 'Sonography', CT: 'CT Scan' };

/** Visit paths for New entry. HIS channel wiring comes later — for now reception picks the visit type. */
const VISITS = [
  { code: 'OPD', channel: 'OPD_FRONTDESK', label: 'OPD', hint: 'Enter the OPD ID from the OPD module', needsVisitId: 'opd' },
  { code: 'IPD', channel: 'IPD', label: 'IPD', hint: 'Enter the IPD ID from the ward / IPD module', needsVisitId: 'ipd' },
  { code: 'WALKIN', channel: 'WALKIN', label: 'Walk-in', hint: 'Outside referral — search by name or phone, or register first', needsVisitId: null },
  { code: 'ER', channel: 'ER', label: 'Emergency', hint: 'Casualty / STAT — search by name or phone', needsVisitId: null }
];

export default function ChannelEntry({ user, query = {} }) {
  const cats = useLoad(() => api.get('/cases/categories'));
  const clinicians = useLoad(() => api.get('/clinicians'));
  const preset = VISITS.find((v) => v.channel === query.channel || v.code === query.visit)?.code || '';
  const [visit, setVisit] = useState(preset);
  const [registering, setRegistering] = useState(false);
  const [visitIdVal, setVisitIdVal] = useState('');
  const [q, setQ] = useState(''); const [results, setResults] = useState([]);
  const [patient, setPatient] = useState(null); const [overview, setOverview] = useState(null);
  const [enc, setEnc] = useState(''); const [indication, setIndication] = useState('');
  const [sel, setSel] = useState([]); const [priority, setPriority] = useState('ROUTINE');
  const [doctorId, setDoctorId] = useState(''); const [ward, setWard] = useState(''); const [bed, setBed] = useState('');
  const a = useAction(); const key = useRef(newKey());

  const v = VISITS.find((x) => x.code === visit) || null;
  const list = cats.data || [];
  const channel = v?.channel || '';

  useEffect(() => {
    if (query.channel) {
      const match = VISITS.find((x) => x.channel === query.channel || x.code === query.channel);
      if (match) setVisit(match.code);
    }
  }, [query.channel]);

  useEffect(() => {
    if (visit === 'ER') setPriority('STAT');
    else if (visit === 'IPD') setPriority('URGENT');
    else setPriority('ROUTINE');
  }, [visit]);

  useEffect(() => {
    if (v?.needsVisitId) return; // OPD/IPD use dedicated ID lookup
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => api.get('/patients?q=' + encodeURIComponent(q.trim())).then(setResults).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q, v?.needsVisitId]);

  const lookupByVisitId = () => a.run(async () => {
    const id = visitIdVal.trim();
    if (!id) throw new Error(v.needsVisitId === 'ipd' ? 'Enter the IPD ID' : 'Enter the OPD ID');
    const body = v.needsVisitId === 'ipd' ? { ipdId: id } : { opdId: id };
    const rows = await api.post('/registration/lookup', body);
    if (!rows.length) {
      setResults([]);
      toast(`No patient found. Choose Add new patient to continue.`, true);
      return;
    }
    if (rows.length === 1) await pick(rows[0]);
    else setResults(rows);
  });

  const pick = async (p) => {
    const full = await api.get('/patients/' + p.id);
    setPatient(full.patient || p);
    setOverview(full);
    setResults([]); setQ(''); setVisitIdVal('');
    const active = (full.encounters || []).filter((e) => e.status === 'ACTIVE');
    const type = v?.code === 'IPD' ? 'IPD' : v?.code === 'OPD' ? 'OPD' : 'EXTERNAL';
    const prefer = active.find((e) => e.type === type);
    setEnc(prefer?.id || '');
    setWard(prefer?.ward || ''); setBed(prefer?.bed || ''); setDoctorId(prefer?.doctor_id || '');
  };

  const toggle = (m) => setSel((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]));

  const send = () => a.run(async () => {
    const body = {
      patientId: patient.id,
      channelCode: channel,
      modalities: sel,
      clinicalIndication: indication.trim(),
      priority
    };
    if (enc) body.encounterId = enc;
    if (doctorId) body.doctorId = doctorId;
    if (v.code === 'IPD' && !enc) {
      body.ward = ward.trim();
      if (bed.trim()) body.bed = bed.trim();
    }
    const idForVisit = patient.opd_id || patient.ipd_id || visitIdVal.trim();
    if (v.needsVisitId === 'opd') body.opdId = patient.opd_id || visitIdVal.trim() || idForVisit;
    if (v.needsVisitId === 'ipd') body.ipdId = patient.ipd_id || visitIdVal.trim() || idForVisit;
    if (idForVisit) body.visitId = idForVisit;

    const r = await api.post('/cases', body, { key: key.current });
    key.current = newKey();
    const tokens = (r.modalities || []).map((m) => m.token_no).filter(Boolean);
    toast(`Case ${r.case_no} opened${tokens.length ? ` · token ${tokens.join(', ')}` : ''} — assistant queue`);
    go('/desk');
  });

  const encounterType = v?.code === 'IPD' ? 'IPD' : v?.code === 'OPD' ? 'OPD' : 'EXTERNAL';
  const active = overview?.encounters?.filter((e) => e.status === 'ACTIVE' && e.type === encounterType) || [];
  const priorities = visit === 'ER' || ['clinician', 'nurse', 'radiologist'].includes(user.role)
    ? ['ROUTINE', 'URGENT', 'STAT'] : ['ROUTINE', 'URGENT'];
  const ok = v && patient && sel.length > 0 && indication.trim().length >= 5
    && !(v?.code === 'IPD' && !enc && !ward.trim());

  return (
    <>
      <PageHeader
        title="Add patient / visit"
        subtitle="Choose the visit, find or add the patient, then select imaging categories."
        actions={<button className="btn btn-light" onClick={() => go('/desk')}>Back to desk</button>}
      />

      <ol className="stepper entry-steps" aria-label="Visit progress">{['Visit type', 'Patient', 'Imaging categories'].map((label, i) => <li key={label} className={`step ${i === (!v ? 0 : !patient ? 1 : 2) ? 'current' : i < (!v ? 0 : !patient ? 1 : 2) ? 'done' : ''}`}>{i + 1}. {label}</li>)}</ol>

      <Card title="1. Visit type" icon="command">
        <div className="seg" style={{ flexWrap: 'wrap' }}>
          {VISITS.map((x) => (
            <button key={x.code} type="button" className={visit === x.code ? 'on' : ''} onClick={() => { setRegistering(false); setVisit(x.code); setPatient(null); setOverview(null); setResults([]); setQ(''); setVisitIdVal(''); setEnc(''); }}>
              {x.label}
            </button>
          ))}
        </div>
        {v && <p className="note" style={{ marginBottom: 0 }}>{v.hint}</p>}
      </Card>

      {v && (
        <div className={patient ? 'grid-2' : 'entry-patient-step'}>
          <Card title="2. Patient" icon="patients" actions={patient && <button className="btn btn-light btn-sm" onClick={() => { setRegistering(false); setPatient(null); setOverview(null); setEnc(''); }}>Change</button>}>
            {!patient ? (registering ? <Register embedded onCancel={() => setRegistering(false)} onSaved={(p) => a.run(async () => { await pick(p); setRegistering(false); })} /> : <>
              {v.needsVisitId ? (
                <div className="form-grid">
                  <label className="wide"><span>{v.needsVisitId === 'ipd' ? 'IPD ID *' : 'OPD ID *'}</span>
                    <input autoFocus value={visitIdVal} onChange={(e) => setVisitIdVal(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && lookupByVisitId()}
                      placeholder={v.needsVisitId === 'ipd' ? 'e.g. IPD number from ward' : 'e.g. OPD number from OPD'} /></label>
                  <div className="wide row-gap" style={{ justifyContent: 'space-between' }}>
                    <button type="button" className="btn btn-light" onClick={() => setRegistering(true)}>Add new patient</button>
                    <button type="button" className="btn btn-primary" disabled={!visitIdVal.trim() || a.busy} onClick={lookupByVisitId}>{a.busy ? 'Looking…' : 'Find'}</button>
                  </div>
                </div>
              ) : (<>
                <label className="search-box" style={{ maxWidth: 'none' }}><Icon name="search" size={14} /><input autoFocus placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} /></label>
                <button className="btn btn-light" style={{ marginTop: 8 }} onClick={() => setRegistering(true)}>Add new patient</button>
              </>)}
              {results.length > 0 && (
                <div className="pick-list" style={{ marginTop: 10 }}>
                  {results.map((p) => <button key={p.id} type="button" className="pick" onClick={() => pick(p)}><strong>{p.name}</strong><span>{visitId(p)} · {p.dob} · {p.sex}</span></button>)}
                </div>
              )}
            </>) : (<>
              <PatientBanner o={{
                ...patient,
                patient_name: patient.name,
                encounter_type: active.find((e) => e.id === enc)?.type || (v.code === 'IPD' ? 'IPD' : v.code === 'OPD' ? 'OPD' : 'EXTERNAL'),
                ward, bed
              }} />
              <div className="form-grid">
                {active.length > 0 && (
                  <label className="wide"><span>Open visit</span>
                    <select value={enc} onChange={(e) => setEnc(e.target.value)}>
                      <option value="">Open new {v.code === 'WALKIN' || v.code === 'ER' ? 'visit' : v.code} on submit</option>
                      {active.map((e) => <option key={e.id} value={e.id}>{e.type} {e.ref_no}{e.ward ? ` · ${e.ward}` : ''}</option>)}
                    </select>
                  </label>
                )}
                {(v.code === 'OPD') && (
                  <label className="wide"><span>Consultant</span>
                    <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                      <option value="">Select…</option>
                      {(clinicians.data || []).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                    </select>
                  </label>
                )}
                {v.code === 'IPD' && !enc && (<>
                  <label><span>Ward *</span><input value={ward} onChange={(e) => setWard(e.target.value)} placeholder="e.g. HDU" /></label>
                  <label><span>Bed</span><input value={bed} onChange={(e) => setBed(e.target.value)} /></label>
                </>)}
              </div>
            </>)}
          </Card>

          {patient && <Card title="3. Imaging categories" icon="scan" subtitle="Main categories only — not individual exams">
            <div className="form-grid">
              <label className="wide"><span>Clinical indication *</span><textarea rows={3} value={indication} onChange={(e) => setIndication(e.target.value)} placeholder="Why this study? (min. 5 characters)" /></label>
              <div className="wide">
                <span className="chart-title">Categories *</span>
                {cats.loading ? <p className="note">Loading…</p> : (
                  <div className="chips" style={{ marginTop: 6 }}>
                    {list.map((c) => {
                      const code = c.modality;
                      const on = sel.includes(code);
                      return (
                        <button key={code} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => toggle(code)}>
                          {MODALITY_LABEL[code] || c.label || code}
                          {c.services != null && <Badge tone="neutral">{c.services}</Badge>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="wide"><span className="chart-title">Priority</span>
                <div className="seg">{priorities.map((p) => <button key={p} type="button" className={priority === p ? `on ${p}` : ''} onClick={() => setPriority(p)}>{p}</button>)}</div>
              </div>
            </div>
          </Card>}
        </div>
      )}

      <FormError error={a.error} />
      {v && patient && (
        <div className="row-gap" style={{ justifyContent: 'space-between' }}>
          <span className="mono">{sel.length ? sel.map((m) => MODALITY_LABEL[m] || m).join(', ') : 'Select categories'}</span>
          <button className="btn btn-primary" disabled={a.busy || !ok} onClick={send}>{a.busy ? 'Opening…' : 'Save visit & add to queue'}</button>
        </div>
      )}
    </>
  );
}
