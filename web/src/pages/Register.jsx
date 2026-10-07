import { useEffect, useRef, useState } from 'react';
import { api, newKey } from '../api.js';
import { Badge, Card, FormError, Icon, Notice, PageHeader, go, toast, useAction, useLoad, visitId } from '../ui.jsx';
import { LANGS, WIZARD_HINTS, useLang } from '../i18n.js';

const STEPS = ['Find patient', 'Verify OTP', 'Patient Details', 'Diagnosis Details'];
const MODALITY_LABEL = { DEXA: 'DEXA', MRI: 'MRI', OPEN_MRI: 'Open MRI', XR: 'X-Ray', USG: 'Sonography', CT: 'CT Scan' };
const readImage = (file) => new Promise((res, rej) => {
  if (!file) return res(null);
  if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) return rej(new Error('Use a PNG, JPEG or WebP image'));
  if (file.size > 1_100_000) return rej(new Error('Image must be under 1 MB'));
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('Could not read the image')); r.readAsDataURL(file);
});

export default function Register({ embedded = false, onSaved, onCancel }) {
  const [step, setStep] = useState(1); const [lang, setL] = useLang(); const [caps, setCaps] = useState(null);
  const [method, setMethod] = useState(embedded ? 'phone' : 'opd'); const [ident, setIdent] = useState(''); const [found, setFound] = useState(null);
  const [challenge, setChallenge] = useState(null); const [verification, setVerification] = useState(null);
  const [patient, setPatient] = useState(null); // saved patient
  const a = useAction();
  useEffect(() => { api.get('/registration/capabilities').then(setCaps).catch(() => {}); }, []);
  const hints = WIZARD_HINTS[lang][step - 1];
  const steps = embedded ? STEPS.slice(0, 3) : STEPS;

  return (
    <>
      {!embedded && <PageHeader title="Register patient" subtitle="Find by OPD / IPD ID, phone or email. Then choose imaging categories." actions={<button className="btn btn-light" onClick={() => go('/desk')}>Reception desk</button>} />}
      <ol className="stepper" style={{ marginBottom: 16, flexWrap: 'wrap' }}>{steps.map((s, i) => <li key={s} className={`step ${i + 1 < step ? 'done' : i + 1 === step ? 'current' : ''}`} style={{ listStyle: 'none' }}>{i + 1 < step && <Icon name="check" size={11} />}{i + 1}. {s}</li>)}</ol>
      {caps && !caps.otpDelivery && caps.otpRequiredForNewPatients && <Notice tone="red">Code delivery is not configured on this server, so new patients cannot be verified. Ask the administrator to set RIS_OTP_WEBHOOK.</Notice>}
      {embedded && <button className="btn btn-light btn-sm" style={{ marginBottom: 12 }} onClick={onCancel}>Back to patient search</button>}
      <div className={embedded ? 'registration-inline' : 'grid-2 register-layout'}>
        <div>
          {step === 1 && <Step1 {...{ method, setMethod, ident, setIdent, a, caps, found, setFound, onExisting: async (p) => { const full = await api.get('/registration/patients/' + p.id); if (embedded && onSaved) await onSaved(full); else { setPatient(full); setStep(3); } },
            onNew: async () => { const r = await api.post('/registration/otp/send', { channel: method, target: ident }); setChallenge(r); setStep(2); toast('Code sent'); }, onNoMatch: async () => { setFound([]); } }} />}
          {step === 2 && <Step2 {...{ challenge, method, ident, a, onVerified: (id) => { setVerification(id); setStep(3); }, resend: async () => { const r = await api.post('/registration/otp/send', { channel: method, target: ident }); setChallenge(r); toast('New code sent'); }, back: () => setStep(1) }} />}
          {step === 3 && <Step3 {...{ patient, method, ident, verification, onSaved: (p) => { setPatient(p); if (onSaved) onSaved(p); else setStep(4); }, back: () => setStep(1) }} />}
          {step === 4 && <Step4 patient={patient} />}
        </div>
        {!embedded && <Card title="Hints" icon="inbox" actions={<select className="inline-input" style={{ width: 'auto' }} value={lang} onChange={(e) => setL(e.target.value)}>{Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}>
          <ul className="mini-list">{hints.map((h) => <li key={h}><span style={{ color: 'var(--navy-2)' }}>{h}</span></li>)}</ul>
        </Card>}
      </div>
    </>
  );
}

function Step1({ method, setMethod, ident, setIdent, a, caps, found, setFound, onExisting, onNew }) {
  const visitLookup = method === 'opd' || method === 'ipd';
  const rules = {
    aadhaar: [/^\d{12}$/, 'Aadhaar must be exactly 12 digits'],
    email: [/^\S+@\S+\.\S+$/, 'Enter a valid email address'],
    phone: [/^\d{10}$/, 'Phone must be exactly 10 digits'],
    opd: [/^.{2,40}$/, 'Enter the OPD ID'],
    ipd: [/^.{2,40}$/, 'Enter the IPD ID']
  };
  const valid = rules[method][0].test(ident.trim());
  const key = { aadhaar: 'aadhaar', email: 'email', phone: 'phone', opd: 'opdId', ipd: 'ipdId' }[method];
  const next = () => a.run(async () => {
    const rows = await api.post('/registration/lookup', { [key]: ident.trim() });
    setFound(rows);
    if (!rows.length) {
      if (visitLookup || method === 'aadhaar') return;
      await onNew();
    }
  });
  return (
    <Card title="Find patient" icon="user" foot={caps && !caps.aadhaarOtpVerification ? 'OPD / IPD IDs find an existing patient. New patients are verified by phone or email code.' : null}>
      <div className="seg" style={{ marginBottom: 12, flexWrap: 'wrap' }}>{[['opd', 'OPD ID'], ['ipd', 'IPD ID'], ['phone', 'Phone'], ['email', 'Email'], ['aadhaar', 'Aadhaar']].map(([k, l]) => <button key={k} className={method === k ? 'on' : ''} onClick={() => { setMethod(k); setIdent(''); setFound(null); }}>{l}</button>)}</div>
      <div className="form-grid"><label className="wide"><span>{
        method === 'aadhaar' ? 'Aadhaar number (12 digits)'
          : method === 'email' ? 'Email address'
            : method === 'opd' ? 'OPD ID'
              : method === 'ipd' ? 'IPD ID'
                : 'Mobile number (10 digits)'
      }</span>
        <input autoFocus value={ident} inputMode={method === 'email' || visitLookup ? 'text' : 'numeric'}
          onChange={(e) => {
            const v = e.target.value;
            setIdent(method === 'email' || visitLookup ? v.slice(0, 40) : v.replace(/\D/g, '').slice(0, method === 'aadhaar' ? 12 : 10));
            setFound(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && valid && next()} /></label></div>
      {ident && !valid && <p className="note" style={{ color: 'var(--danger)' }}>{rules[method][1]}</p>}
      <FormError error={a.error} />
      {found && found.length > 0 && (<>
        <p className="chart-title" style={{ marginTop: 14 }}>Patients found</p>
        <div className="pick-list">{found.map((p) => <button key={p.id} className="pick" onClick={() => a.run(() => onExisting(p))}><strong>{p.name}</strong><span>{visitId(p)} · {p.dob} · {p.sex} · {p.phone}</span></button>)}</div>
        {!visitLookup && method !== 'aadhaar' && <p className="note">Not one of these? <button className="link-btn" disabled={a.busy} onClick={() => a.run(onNew)}>Register a new patient with this {method} (needs a code)</button></p>}</>)}
      {found && found.length === 0 && visitLookup && <Notice>No patient with this {method === 'ipd' ? 'IPD' : 'OPD'} ID. Use Phone or Email to register a new patient, then enter the OPD / IPD ID on the details step.</Notice>}
      {found && found.length === 0 && method === 'aadhaar' && <Notice>No patient has this Aadhaar. Use the phone or email tab to register a new patient.</Notice>}
      <div className="row-gap" style={{ justifyContent: 'flex-end', marginTop: 14 }}><button className="btn btn-primary" disabled={!valid || a.busy} onClick={next}>{a.busy ? 'Checking…' : 'Next'}</button></div>
    </Card>
  );
}

function Step2({ challenge, method, ident, a, onVerified, resend, back }) {
  const [code, setCode] = useState(''); const [wait, setWait] = useState(30); const input = useRef(null);
  useEffect(() => { setWait(30); const t = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000); return () => clearInterval(t); }, [challenge?.challengeId]);
  const verify = () => a.run(async () => { await api.post('/registration/otp/verify', { challengeId: challenge.challengeId, code }); onVerified(challenge.challengeId); });
  return (
    <Card title="Verify OTP" icon="key">
      <p className="note" style={{ marginTop: 0 }}>A 6-digit code was sent to {method === 'phone' ? `••••••${ident.slice(-4)}` : ident}. It expires in 10 minutes.</p>
      {challenge?.devCode && <Notice>Demo mode: the code is <b>{challenge.devCode}</b>. It is shown only because this server runs with RIS_DEV_OTP=1.</Notice>}
      {/* One real input (so paste, autofill and fast typing work) drawn as six boxes */}
      <div style={{ position: 'relative', width: 'fit-content', margin: '14px 0' }} onClick={() => input.current?.focus()}>
      <div className="row-gap otp-boxes">{[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="inline-input" style={{ width: 44, display: 'grid', placeItems: 'center', fontSize: 18, borderColor: code.length === i ? 'var(--blue)' : undefined }}>{code[i] || ''}</span>)}</div>
        <input ref={input} autoFocus aria-label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && verify()}
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', cursor: 'text' }} />
      </div>
      <FormError error={a.error} />
      <div className="row-gap" style={{ justifyContent: 'space-between' }}>
        <span className="row-gap"><button className="btn btn-light" onClick={back}>Previous</button><button className="btn btn-light" disabled={wait > 0 || a.busy} onClick={() => a.run(resend)}>{wait > 0 ? `Resend OTP in ${wait}s` : 'Resend OTP'}</button></span>
        <button className="btn btn-primary" disabled={code.length < 6 || a.busy} onClick={verify}>Verify</button></div>
    </Card>
  );
}

const OCC_POLICE = 'Police Man';
function Step3({ patient, method, ident, verification, onSaved, back }) {
  const masters = useLoad(() => api.get('/masters'));
  const init = patient ? {
    firstName: patient.first_name || patient.name.split(' ')[0], middleName: patient.middle_name || '', lastName: patient.last_name || patient.name.split(' ').slice(-1)[0],
    dob: patient.dob, gender: patient.sex, phone: patient.phone || '', email: patient.email || '', address: patient.address || '',
    country: patient.country || 'India', state: patient.state || '', city: patient.city || '', zipcode: patient.zipcode || '',
    occupation: patient.occupation || '', designation: patient.designation || '', reference: patient.reference || '',
    allergy: patient.allergy === 'None recorded' ? '' : patient.allergy || '',
    opdId: patient.opd_id || '', ipdId: patient.ipd_id || ''
  } : {
    firstName: '', middleName: '', lastName: '', dob: '', gender: 'M', phone: method === 'phone' ? ident : '', email: method === 'email' ? ident : '',
    address: '', country: 'India', state: 'Gujarat', city: 'Ahmedabad', zipcode: '', occupation: '', designation: '', reference: '', allergy: '',
    opdId: '', ipdId: ''
  };
  const [f, setF] = useState(init); const [proofs, setProofs] = useState({}); const [picked, setPicked] = useState([]); const [occ, setOcc] = useState({}); const [aadhaar, setAadhaar] = useState(''); const a = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const proofTypes = masters.data?.proofTypes || [];
  const togglePick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const setProof = (id, k, v) => setProofs((p) => ({ ...p, [id]: { ...p[id], [k]: v } }));
  const upload = (setter) => async (e) => { try { setter(await readImage(e.target.files[0])); } catch (err) { toast(err.message, true); e.target.value = ''; } };
  const save = () => a.run(async () => {
    const body = { ...f, patientId: patient?.id, verificationId: verification || undefined, aadhaar: aadhaar || undefined,
      proofs: picked.map((id) => ({ proofType: id, number: proofs[id]?.number || '', front: proofs[id]?.front, back: proofs[id]?.back })), occupationIdFront: occ.front, occupationIdBack: occ.back };
    onSaved(await api.post('/registration/patients', body)); toast('Patient saved');
  });
  const bad = !f.firstName.trim() || !f.lastName.trim() || !f.dob || !/^\d{10}$/.test(f.phone) || !f.address.trim();
  return (
    <>
      {patient && <Notice tone="amber">Existing patient {visitId(patient)}. Changes here update their record.</Notice>}
      <Card title="OPD / IPD ID" icon="key" subtitle="Use the IDs from OPD or IPD modules when the patient came from there.">
        <div className="form-grid">
          <label><span>OPD ID</span><input value={f.opdId} onChange={set('opdId')} placeholder="From OPD module" /></label>
          <label><span>IPD ID</span><input value={f.ipdId} onChange={set('ipdId')} placeholder="From IPD / ward module" /></label>
        </div>
      </Card>
      <Card title="Identity proof" icon="key" subtitle="Optional. Add the documents the patient shows.">
        <div className="chips" style={{ marginTop: 0 }}>{proofTypes.map((t) => <button key={t.id} className={`chip ${picked.includes(t.id) ? 'on' : ''}`} onClick={() => togglePick(t.id)}>{t.name}</button>)}</div>
        {picked.length > 0 && <div className="table-scroll"><table className="clinical-table compact"><thead><tr><th>Identity proof</th><th>Number</th><th>Front</th><th>Back</th></tr></thead><tbody>{picked.map((id) => { const t = proofTypes.find((x) => x.id === id); return (
          <tr key={id}><td>{t.name}</td><td><input className="inline-input" value={proofs[id]?.number || ''} onChange={(e) => setProof(id, 'number', e.target.value)} /></td>
            <td>{['front', 'both'].includes(t.document_side) ? <input type="file" accept="image/*" onChange={upload((v) => setProof(id, 'front', v))} /> : '—'}</td><td>{['back', 'both'].includes(t.document_side) ? <input type="file" accept="image/*" onChange={upload((v) => setProof(id, 'back', v))} /> : '—'}</td></tr>); })}</tbody></table></div>}
        <div className="form-grid" style={{ marginTop: 12 }}>
          <label><span>Aadhaar number (stored as a hash, last 4 digits shown)</span><input inputMode="numeric" value={aadhaar} onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12))} placeholder={patient?.aadhaar_last4 ? `On file: ••••••••${patient.aadhaar_last4}` : ''} /></label>
          <label><span>Referred by</span><select value={f.reference} onChange={set('reference')}><option value="">—</option>{masters.data?.referrals.map((r) => <option key={r.id}>{r.name}</option>)}</select></label></div>
      </Card>
      <Card title="Personal information" icon="patients"><div className="form-grid">
        <label><span>First name *</span><input value={f.firstName} onChange={set('firstName')} /></label><label><span>Middle name</span><input value={f.middleName} onChange={set('middleName')} /></label>
        <label><span>Last name *</span><input value={f.lastName} onChange={set('lastName')} /></label><label><span>Date of birth *</span><input type="date" max={new Date().toISOString().slice(0, 10)} value={f.dob} onChange={set('dob')} /></label>
        <label className="wide"><span>Gender *</span><div className="seg">{[['M', 'Male'], ['F', 'Female'], ['O', 'Other']].map(([k, l]) => <button key={k} className={f.gender === k ? 'on' : ''} onClick={() => setF({ ...f, gender: k })}>{l}</button>)}</div></label></div></Card>
      <Card title="Contact details" icon="phone"><div className="form-grid">
        <label><span>Mobile number * (10 digits)</span><input inputMode="numeric" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label><label><span>Email</span><input value={f.email} onChange={set('email')} /></label>
        <label className="wide"><span>Address *</span><textarea value={f.address} onChange={set('address')} /></label>
        <label><span>Country</span><input value={f.country} onChange={set('country')} /></label><label><span>State</span><input value={f.state} onChange={set('state')} /></label>
        <label><span>City</span><input value={f.city} onChange={set('city')} /></label><label><span>Pincode</span><input inputMode="numeric" value={f.zipcode} onChange={(e) => setF({ ...f, zipcode: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></label>
        <label className="wide"><span>Known allergy</span><input value={f.allergy} onChange={set('allergy')} placeholder="None recorded" /></label></div></Card>
      <Card title="Occupation" icon="user"><div className="form-grid">
        <label><span>Occupation</span><select value={f.occupation} onChange={set('occupation')}><option value="">—</option>{masters.data?.occupations.map((o) => <option key={o}>{o}</option>)}</select></label>
        <label><span>Designation</span><select value={f.designation} onChange={set('designation')}><option value="">—</option>{masters.data?.designations.map((d) => <option key={d.id}>{d.name}</option>)}</select></label>
        {f.occupation === OCC_POLICE && <><label><span>Department ID, front *</span><input type="file" accept="image/*" onChange={upload((v) => setOcc((o) => ({ ...o, front: v })))} /></label><label><span>Department ID, back *</span><input type="file" accept="image/*" onChange={upload((v) => setOcc((o) => ({ ...o, back: v })))} /></label></>}</div></Card>
      <FormError error={a.error} />
      <div className="row-gap" style={{ justifyContent: 'space-between' }}><button className="btn btn-light" onClick={back}>Previous</button><button className="btn btn-primary" disabled={bad || a.busy} onClick={save}>{a.busy ? 'Saving…' : 'Save patient'}</button></div>
    </>
  );
}

function Step4({ patient }) {
  const cats = useLoad(() => api.get('/cases/categories'));
  const [sel, setSel] = useState([]);
  const [ind, setInd] = useState('');
  const [priority, setPriority] = useState('ROUTINE');
  const a = useAction();
  const key = useRef(newKey());
  const list = cats.data || [];
  const toggle = (m) => setSel((s) => (s.includes(m) ? s.filter((x) => x !== m) : [...s, m]));
  const save = () => a.run(async () => {
    const r = await api.post('/cases', {
      patientId: patient.id,
      channelCode: 'WALKIN',
      modalities: sel,
      clinicalIndication: ind.trim(),
      priority
    }, { key: key.current });
    key.current = newKey();
    toast(`Case ${r.case_no} opened · assistant will call from waiting`);
    go('/desk');
  });
  const ok = sel.length > 0 && ind.trim().length >= 5;
  return (
    <>
      <Card title="Patient" icon="patients"><b>{patient.name}</b> <span className="mono">{visitId(patient)}</span> · {patient.phone}</Card>
      <Card title="Diagnosis details" icon="scan" subtitle="Select main imaging categories only. Assistant and technician choose the specific sub-services later.">
        {cats.loading ? <p className="note">Loading categories…</p> : (
          <div className="chips" style={{ marginTop: 0 }}>
            {list.map((c) => {
              const code = c.modality;
              const on = sel.includes(code);
              return (
                <button key={code} type="button" className={`chip ${on ? 'on' : ''}`} onClick={() => toggle(code)}>
                  {MODALITY_LABEL[code] || c.label || code}
                  {c.services != null && <Badge tone="neutral">{c.services} services</Badge>}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ marginTop: 12 }}><Notice>Do not pick individual scans here. MRI / CT / X-ray etc. go to the assistant queue; the technician protocols the exact exams at the modality.</Notice></div>
      </Card>
      <Card title="Clinical note" icon="orders">
        <div className="form-grid">
          <label className="wide"><span>Clinical indication *</span>
            <textarea rows={3} value={ind} onChange={(e) => setInd(e.target.value)} placeholder="Why is imaging needed? (min. 5 characters)" /></label>
          <div className="wide"><span className="chart-title">Priority</span>
            <div className="seg">{['ROUTINE', 'URGENT'].map((p) => <button key={p} type="button" className={priority === p ? 'on' : ''} onClick={() => setPriority(p)}>{p}</button>)}</div>
          </div>
        </div>
      </Card>
      <FormError error={a.error} />
      <div className="row-gap" style={{ justifyContent: 'space-between' }}>
        <span className="mono">{sel.length ? `${sel.length} categor${sel.length === 1 ? 'y' : 'ies'}: ${sel.map((m) => MODALITY_LABEL[m] || m).join(', ')}` : 'Select at least one category'}</span>
        <button className="btn btn-primary" disabled={!ok || a.busy} onClick={save}>{a.busy ? 'Opening…' : 'Open case → desk'}</button>
      </div>
    </>
  );
}
