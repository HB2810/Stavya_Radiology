import { useEffect, useRef, useState } from 'react';
import { api, newKey } from '../api.js';
import { Card, FormError, Icon, Notice, PageHeader, PatientBanner, go, toast, useAction, useLoad } from '../ui.jsx';

const COPY = {
  OPD_CONSULTANT: {
    title: 'OPD · Consultant diagnostic',
    steps: 'Consultant sent the patient for imaging. After the report, they go back to the consultant.',
    pay: 'Payment is taken at OPD — enter the OPD receipt if already paid.'
  },
  OPD_FRONTDESK: {
    title: 'OPD · Front desk / follow-up report',
    steps: 'Front desk sent them for a report, or they came for a follow-up report as told last visit.',
    pay: 'Collect payment at radiology before the scan starts.'
  },
  IPD: {
    title: 'IPD / ward / ICU',
    steps: 'Bed patient from the ward. Enter ward and bed. Charge goes on the IPD bill.',
    pay: 'No cash at radiology.'
  },
  ER: {
    title: 'Emergency',
    steps: 'Casualty / emergency — STAT allowed. Token jumps the live queue.',
    pay: 'No payment gate.'
  },
  WALKIN: {
    title: 'Walk-in / outside referral',
    steps: 'Outside doctor’s prescription. Register UHID if new, then issue a token.',
    pay: 'Collect payment at radiology before the scan starts.'
  }
};

export default function ChannelEntry({ user, query = {} }) {
  const channels = useLoad(() => api.get('/masters/channels'));
  const exams = useLoad(() => api.get('/catalog/exams'));
  const clinicians = useLoad(() => api.get('/clinicians'));
  const [channel, setChannel] = useState(query.channel || '');
  const [q, setQ] = useState(''); const [results, setResults] = useState([]);
  const [patient, setPatient] = useState(null); const [overview, setOverview] = useState(null);
  const [enc, setEnc] = useState(''); const [indication, setIndication] = useState('');
  const [exam, setExam] = useState(''); const [priority, setPriority] = useState('ROUTINE');
  const [paidAtOpd, setPaidAtOpd] = useState(false); const [paymentRef, setPaymentRef] = useState('');
  const [doctorId, setDoctorId] = useState(''); const [ward, setWard] = useState(''); const [bed, setBed] = useState('');
  const [dup, setDup] = useState(''); const a = useAction(); const key = useRef(newKey());

  const ch = channels.data?.find((c) => c.code === channel);
  const copy = COPY[channel] || { title: ch?.name || 'Entry', steps: ch?.notes || '', pay: '' };

  useEffect(() => { if (query.channel) setChannel(query.channel); }, [query.channel]);
  useEffect(() => { if (ch) setPriority(ch.default_priority || 'ROUTINE'); }, [channel, ch?.code]);
  useEffect(() => { if (q.trim().length < 2) return setResults([]); const t = setTimeout(() => api.get('/patients?q=' + encodeURIComponent(q.trim())).then(setResults).catch(() => {}), 250); return () => clearTimeout(t); }, [q]);

  const pick = async (p) => {
    setPatient(p); setResults([]); setQ('');
    const o = await api.get('/patients/' + p.id); setOverview(o);
    const active = o.encounters.filter((e) => e.status === 'ACTIVE');
    const prefer = ch?.encounter_type ? active.find((e) => e.type === ch.encounter_type) : active[0];
    setEnc(prefer?.id || '');
    if (prefer?.ward) setWard(prefer.ward);
    if (prefer?.bed) setBed(prefer.bed || '');
    if (prefer?.doctor_id) setDoctorId(prefer.doctor_id);
  };

  const ensureEncounter = async () => {
    if (enc) return enc;
    if (!patient || !ch) return '';
    const refNo = `${ch.encounter_type}-${Date.now().toString(36).toUpperCase()}`;
    const body = { type: ch.encounter_type, refNo };
    if (ch.encounter_type === 'IPD') {
      if (!ward.trim()) throw new Error('Ward is required for IPD');
      body.ward = ward.trim(); body.bed = bed.trim() || undefined;
    }
    if (doctorId) body.doctorId = doctorId;
    else if (ch.code === 'OPD_CONSULTANT' && clinicians.data?.[0]) body.doctorId = clinicians.data[0].id;
    const created = await api.post(`/patients/${patient.id}/encounters`, body);
    const o = await api.get('/patients/' + patient.id); setOverview(o); setEnc(created.id);
    return created.id;
  };

  const send = (confirmDuplicate = false) => a.run(async () => {
    const encounterId = enc || await ensureEncounter();
    if (!encounterId) throw new Error('Could not open an encounter for this patient');
    try {
      const body = {
        patientId: patient.id, encounterId, examCode: exam, priority, clinicalIndication: indication,
        channelCode: channel, confirmDuplicate, paidAtOpd, paymentRef: paymentRef || undefined
      };
      const r = await api.post('/orders', body, { key: key.current });
      key.current = newKey();
      toast(`Token ${r.order.token_no} issued · est. ${r.order.eta_at ? new Date(r.order.eta_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'}`);
      go('/desk');
    } catch (e) {
      if (e.code === 'POSSIBLE_DUPLICATE') setDup(e.message); else throw e;
    }
  });

  const active = overview?.encounters.filter((e) => e.status === 'ACTIVE') || [];
  const chosen = exams.data?.find((e) => e.code === exam);
  const priorities = ch?.allow_stat_reception || ['clinician', 'nurse', 'radiologist'].includes(user.role)
    ? ['ROUTINE', 'URGENT', 'STAT'] : ['ROUTINE', 'URGENT'];

  return (
    <>
      <PageHeader title={copy.title} subtitle={copy.steps}
        actions={<button className="btn btn-light" onClick={() => go('/desk')}>Back to desk</button>} />

      <Notice>No appointment slot. On save, the system issues a token and a waiting estimate from who is already in that machine’s queue. The estimate changes if ER / STAT / IPD jump ahead.</Notice>

      {!channel && (
        <Card title="1. How did this patient arrive?" icon="command">
          <div className="channel-tiles compact">
            {(channels.data || []).map((c) => (
              <button key={c.code} type="button" className={`channel-tile ${c.code === 'ER' ? 'urgent' : ''}`} onClick={() => setChannel(c.code)}>
                <strong>{c.name}</strong>
                <span>{(COPY[c.code] || {}).steps || c.notes}</span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {channel && (
        <>
          <div className="row-gap" style={{ marginBottom: 12 }}>
            <button className="btn btn-light btn-sm" onClick={() => setChannel('')}>Change channel</button>
            <span className="note" style={{ margin: 0 }}>{copy.pay}</span>
          </div>
          <div className="grid-2">
            <Card title="2. Patient" icon="patients" actions={patient && <button className="btn btn-light btn-sm" onClick={() => { setPatient(null); setOverview(null); setEnc(''); }}>Change</button>}>
              {!patient ? (<>
                <label className="search-box" style={{ maxWidth: 'none' }}><Icon name="search" size={14} /><input autoFocus placeholder="Search name, UHID or phone" value={q} onChange={(e) => setQ(e.target.value)} /></label>
                <div className="pick-list">{results.map((p) => <button key={p.id} className="pick" onClick={() => pick(p)}><strong>{p.name}</strong><span>{p.mrn} · {p.dob} · {p.sex}</span></button>)}</div>
                {(ch?.code === 'WALKIN' || ch?.quick_entry) && (
                  <button className="btn btn-light" onClick={() => go('/register')}>{ch.quick_entry ? 'Quick-register new patient' : 'New patient — walk-in register'}</button>
                )}
              </>) : (<>
                <PatientBanner o={{ ...patient, patient_name: patient.name, encounter_type: active.find((e) => e.id === enc)?.type || ch.encounter_type, ward, bed }} />
                <div className="form-grid">
                  {active.length > 0 && (
                    <label className="wide"><span>Open visit</span>
                      <select value={enc} onChange={(e) => setEnc(e.target.value)}>
                        <option value="">Open new {ch.encounter_type} on submit</option>
                        {active.map((e) => <option key={e.id} value={e.id}>{e.type} {e.ref_no}{e.ward ? ` · ${e.ward}` : ''}</option>)}
                      </select>
                    </label>
                  )}
                  {(ch.code === 'OPD_CONSULTANT' || ch.code === 'OPD_FRONTDESK') && (
                    <label className="wide"><span>Consultant</span>
                      <select value={doctorId} onChange={(e) => setDoctorId(e.target.value)}>
                        <option value="">Select…</option>
                        {(clinicians.data || []).map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                      </select>
                    </label>
                  )}
                  {ch.encounter_type === 'IPD' && !enc && (<>
                    <label><span>Ward</span><input value={ward} onChange={(e) => setWard(e.target.value)} placeholder="e.g. HDU" /></label>
                    <label><span>Bed</span><input value={bed} onChange={(e) => setBed(e.target.value)} /></label>
                  </>)}
                </div>
              </>)}
            </Card>

            <Card title="3. Study" icon="orders">
              <div className="form-grid">
                <label className="wide"><span>Clinical indication</span><textarea rows={3} value={indication} onChange={(e) => setIndication(e.target.value)} placeholder="Why this study?" /></label>
                <label className="wide"><span>Study</span>
                  <select value={exam} onChange={(e) => setExam(e.target.value)}>
                    <option value="">Select…</option>
                    {exams.data?.map((e) => <option key={e.code} value={e.code} disabled={e.price == null}>{e.modality} · {e.name}</option>)}
                  </select>
                </label>
                <div className="wide"><span className="chart-title">Priority</span>
                  <div className="seg">{priorities.map((p) => <button key={p} className={priority === p ? `on ${p}` : ''} onClick={() => setPriority(p)}>{p}</button>)}</div>
                </div>
                {ch.payment_place === 'OPD' && (
                  <div className="wide form-grid">
                    <label className="check-row wide"><input type="checkbox" checked={paidAtOpd} onChange={(e) => setPaidAtOpd(e.target.checked)} /><span>Already paid at OPD</span></label>
                    {paidAtOpd && <label className="wide"><span>OPD receipt / bill no.</span><input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} /></label>}
                  </div>
                )}
                {chosen?.prep && <Notice>Prep: {chosen.prep}</Notice>}
              </div>
            </Card>
          </div>
        </>
      )}

      {dup && <div className="confirm-line"><Icon name="critical" size={14} /><span>{dup}</span>
        <span className="row-gap"><button className="btn btn-light btn-sm" onClick={() => setDup('')}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={() => { setDup(''); send(true); }}>Order anyway</button></span></div>}
      <FormError error={a.error} />
      {channel && (
        <div className="row-gap" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-primary" disabled={a.busy || !patient || !exam || indication.trim().length < 5 || (paidAtOpd && !paymentRef.trim()) || (ch?.encounter_type === 'IPD' && !enc && !ward.trim())}
            onClick={() => send(false)}>{a.busy ? 'Issuing…' : 'Issue token → desk'}</button>
        </div>
      )}
    </>
  );
}
