import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, Empty, FormError, Icon, Notice, fmt, toast, todayISO, useAction, useLoad } from '../ui.jsx';
import { LANGS, consentText, useLang } from '../i18n.js';

const TECH = ['technologist', 'radiologist'];

/* ---------- Patient's words: text + audio recording (MediaRecorder) ---------- */
function Recorder({ onClips }) {
  const [state, setState] = useState('idle'); const [clips, setClips] = useState([]); const rec = useRef(null); const chunks = useRef([]); const stream = useRef(null);
  const push = (c) => { setClips(c); onClips(c); };
  const start = async () => {
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => window.MediaRecorder?.isTypeSupported(m));
      if (!mime) return toast('This browser cannot record audio', true);
      rec.current = new MediaRecorder(stream.current, { mimeType: mime }); chunks.current = [];
      rec.current.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.current.onstop = () => { stream.current.getTracks().forEach((t) => t.stop()); const blob = new Blob(chunks.current, { type: mime }); if (blob.size > 3_000_000) return toast('Recording is too long (max about 3 MB)', true);
        const r = new FileReader(); r.onload = () => push([...clips, { data: r.result, url: URL.createObjectURL(blob) }]); r.readAsDataURL(blob); setState('idle'); };
      rec.current.start(); setState('recording');
    } catch (e) { toast(e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser and try again.' : e.name === 'NotFoundError' ? 'No microphone was found.' : 'Could not start recording.', true); }
  };
  return (
    <div>
      <div className="row-gap">
        {state === 'idle' && <button className="btn btn-light btn-sm" onClick={start} disabled={clips.length >= 5}><Icon name="play" size={13} /> {clips.length ? 'Record again' : 'Start recording'}</button>}
        {state === 'recording' && <><Badge tone="danger">Recording…</Badge><button className="btn btn-light btn-sm" onClick={() => { rec.current.pause(); setState('paused'); }}>Pause</button><button className="btn btn-primary btn-sm" onClick={() => rec.current.stop()}>Stop</button></>}
        {state === 'paused' && <><Badge tone="warning">Paused</Badge><button className="btn btn-light btn-sm" onClick={() => { rec.current.resume(); setState('recording'); }}>Resume</button><button className="btn btn-primary btn-sm" onClick={() => rec.current.stop()}>Stop</button></>}
        <Badge tone={clips.length ? 'success' : 'neutral'}>{clips.length ? `${clips.length} recorded` : 'Not recorded'}</Badge>
      </div>
      {clips.map((c, i) => <div key={i} className="row-gap" style={{ marginTop: 6 }}><audio controls src={c.url} /><button className="btn btn-light btn-sm" onClick={() => push(clips.filter((_, j) => j !== i))}>Delete</button></div>)}
    </div>
  );
}
function AudioClip({ id }) {
  const [url, setUrl] = useState(null);
  useEffect(() => { let u; api.get('/audio/' + id).then((r) => fetch(r.data).then((x) => x.blob()).then((b) => { u = URL.createObjectURL(b); setUrl(u); })).catch(() => {}); return () => u && URL.revokeObjectURL(u); }, [id]);
  return url ? <audio controls src={url} /> : <small>Loading recording…</small>;
}
export function WordsTab({ order, user }) {
  const { data, reload } = useLoad(() => api.get(`/orders/${order.id}/words`), [order.id]);
  const timeline = useLoad(() => api.get(`/patients/${order.patient_id}/timeline?module=words`), [order.patient_id, data?.length]);
  const [text, setText] = useState(''); const [clips, setClips] = useState([]); const [key, setKey] = useState(0); const a = useAction(); const can = TECH.includes(user.role);
  const save = () => a.run(async () => { await api.post(`/orders/${order.id}/words`, { text, audio: clips.map((c) => ({ data: c.data })) }); setText(''); setClips([]); setKey(key + 1); toast("Patient's words saved"); reload(); });
  return (
    <>
      {can && <><label className="field-label"><span>Patient's words</span><textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write what the patient says, in their own words" /></label>
        <Recorder key={key} onClips={setClips} /><FormError error={a.error} /><div className="row-gap" style={{ justifyContent: 'flex-end', marginTop: 10 }}><button className="btn btn-primary" disabled={a.busy || (!text.trim() && !clips.length)} onClick={save}>Save patient's words</button></div></>}
      <p className="chart-title" style={{ marginTop: 18 }}>This visit</p>
      {data?.length ? data.map((w) => <div key={w.id} className="msg" style={{ maxWidth: '100%', marginBottom: 8 }}><small>{w.created_by_name} · {fmt(w.created_at)}</small>{w.text && <div>{w.text}</div>}{w.audio.map((au) => <AudioClip key={au.id} id={au.id} />)}
        {can && <button className="link-btn" onClick={() => a.run(async () => { await api.post(`/words/${w.id}/delete`); reload(); })}>Delete</button>}</div>) : <Empty title="Nothing recorded for this visit" />}
      {timeline.data?.length > 0 && <><p className="chart-title" style={{ marginTop: 18 }}>Patient words history (all visits)</p>
        <ul className="mini-list">{timeline.data.map((w) => <li key={w.id}><strong>{w.text || '(audio only)'}</strong><span>{fmt(w.created_at)} · {w.created_by_name}{w.recordings ? ` · ${w.recordings} recording(s)` : ''}</span></li>)}</ul></>}
    </>
  );
}

/* ---------- Medical consent (devices, history, allergies, pregnancy) ---------- */
const DEVICES = ['PaceMaker', 'ArtificialHeart', 'MetalImplants', 'DentalPlate', 'HearingAids']; const HISTORY = ['PastIllness', 'HistoryDM', 'Ht', 'Other'];
export function MedicalConsentTab({ order, user }) {
  const { data, reload } = useLoad(() => api.get(`/orders/${order.id}/medical-consent`), [order.id]); const [f, setF] = useState(null); const a = useAction(); const can = TECH.includes(user.role);
  useEffect(() => { if (data === undefined) return; const d = data || {}; setF({ medicalDevices: d.medicalDevices || [], medicalHistory: d.medicalHistory || [], allergiesHas: d.allergies?.has || false, allergiesDetails: d.allergies?.details || '', isPregnant: d.pregnancy?.is || false, monthsPregnant: d.pregnancy?.months || '', weight: d.weight ?? '', provisionalReport: d.provisionalReport || '' }); }, [data]);
  if (!f) return <Empty title="Loading…" />;
  const tog = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const Checks = ({ label, k, opts }) => <div><p className="chart-title">{label}</p>{opts.map((o) => <label className="check-row" key={o}><input type="checkbox" disabled={!can} checked={f[k].includes(o)} onChange={() => tog(k, o)} /><span>{o}</span></label>)}</div>;
  return (
    <>
      {data && <p className="note" style={{ marginTop: 0 }}>Last saved by {data.actor_name} · {fmt(data.created_at)}</p>}
      <div className="grid-2"><Checks label="Medical devices" k="medicalDevices" opts={DEVICES} /><Checks label="Medical history" k="medicalHistory" opts={HISTORY} /></div>
      <div className="form-grid" style={{ marginTop: 14 }}>
        <label><span>Weight (kg)</span><input type="number" disabled={!can} value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value })} /></label>
        <div><span className="chart-title">Allergies</span><div className="seg"><button disabled={!can} className={!f.allergiesHas ? 'on' : ''} onClick={() => setF({ ...f, allergiesHas: false })}>No</button><button disabled={!can} className={f.allergiesHas ? 'on' : ''} onClick={() => setF({ ...f, allergiesHas: true })}>Yes</button></div></div>
        {f.allergiesHas && <label className="wide"><span>Specify the allergy</span><input disabled={!can} value={f.allergiesDetails} onChange={(e) => setF({ ...f, allergiesDetails: e.target.value })} /></label>}
        <div><span className="chart-title">Pregnancy</span><div className="seg"><button disabled={!can} className={!f.isPregnant ? 'on' : ''} onClick={() => setF({ ...f, isPregnant: false })}>No</button><button disabled={!can} className={f.isPregnant ? 'on' : ''} onClick={() => setF({ ...f, isPregnant: true })}>Yes</button></div></div>
        {f.isPregnant && <label><span>Duration (months, 1–9)</span><input type="number" min="1" max="9" disabled={!can} value={f.monthsPregnant} onChange={(e) => setF({ ...f, monthsPregnant: e.target.value })} /></label>}
        <label className="wide"><span>Provisional report</span><textarea disabled={!can} value={f.provisionalReport} onChange={(e) => setF({ ...f, provisionalReport: e.target.value })} /></label></div>
      <FormError error={a.error} />
      {can && <div className="row-gap" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn btn-primary" disabled={a.busy} onClick={() => a.run(async () => { await api.post(`/orders/${order.id}/medical-consent`, { ...f, monthsPregnant: f.isPregnant ? Number(f.monthsPregnant) : undefined, weight: f.weight === '' ? undefined : Number(f.weight) }); toast('Consent saved'); reload(); })}>Save</button></div>}
    </>
  );
}

/* ---------- Past history ---------- */
const DISEASES = ['Diabetes', 'Blood Pressure', 'Cholesterol (Blood Thinner)', 'Thyroid', 'Acidity', 'Allergy', 'Surgery', 'M/H'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function Onset({ v, set }) {
  const years = Array.from({ length: 70 }, (_, i) => new Date().getFullYear() - i);
  return <span className="row-gap"><select className="inline-input" style={{ width: 90 }} value={v.year || ''} onChange={(e) => set({ ...v, year: e.target.value })}><option value="">Year</option>{years.map((y) => <option key={y}>{y}</option>)}</select>
    <select className="inline-input" style={{ width: 80 }} value={v.month || ''} onChange={(e) => set({ ...v, month: e.target.value })}><option value="">Month</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select>
    <select className="inline-input" style={{ width: 70 }} value={v.day || ''} onChange={(e) => set({ ...v, day: e.target.value })}><option value="">Day</option>{Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</select></span>;
}
function MedicinePick({ value, onChange, disabled }) {
  const [q, setQ] = useState(''); const [opts, setOpts] = useState([]);
  useEffect(() => { if (q.length < 2) return setOpts([]); const t = setTimeout(() => api.get('/masters/medicines?q=' + encodeURIComponent(q)).then(setOpts).catch(() => {}), 200); return () => clearTimeout(t); }, [q]);
  return <div><div className="row-gap">{value.map((m) => <span key={m} className="chip on" onClick={() => !disabled && onChange(value.filter((x) => x !== m))}>{m} ✕</span>)}</div>
    {!disabled && <input className="inline-input" placeholder="Search medicine…" value={q} onChange={(e) => setQ(e.target.value)} />}
    <div className="chips">{opts.filter((o) => !value.includes(o.name)).map((o) => <button key={o.id} className="chip" onClick={() => { onChange([...value, o.name]); setQ(''); setOpts([]); }}>{o.name}</button>)}</div></div>;
}
function SurgeryRow({ s, set, remove, disabled }) {
  const [levels, setLevels] = useState([]);
  useEffect(() => { (async () => { const out = []; let parent = null; for (let i = 0; i < 5; i++) { const rows = await api.get(`/masters/surgery${parent ? `?parent=${parent}` : ''}`); out.push(rows); parent = s.path[i]; if (!parent) break; } setLevels(out); })().catch(() => {}); }, [s.path.join()]);
  const names = ['Region', 'Level', 'Approach', 'Type', 'Add-on'];
  return (
    <tr><td><Onset v={s} set={(v) => set({ ...s, ...v })} /></td>
      <td><select className="inline-input" disabled={disabled} value={s.where} onChange={(e) => set({ ...s, where: e.target.value })}><option>Stavya</option><option>Elsewhere</option></select></td>
      <td>{s.other ? <input className="inline-input" placeholder="Surgery name" value={s.otherName || ''} onChange={(e) => set({ ...s, otherName: e.target.value })} /> : <span className="row-gap">{levels.map((rows, i) => <select key={i} className="inline-input" style={{ width: 120 }} disabled={disabled} value={s.path[i] || ''} onChange={(e) => set({ ...s, path: e.target.value ? [...s.path.slice(0, i), Number(e.target.value)] : s.path.slice(0, i) })}><option value="">{names[i]}</option>{rows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>)}</span>}
        <label className="check"><input type="checkbox" disabled={disabled} checked={s.other} onChange={(e) => set({ ...s, other: e.target.checked, path: [] })} /> Other</label></td>
      <td>{!disabled && <button className="btn btn-light btn-sm" onClick={remove}>Remove</button>}</td></tr>
  );
}
export function PastHistoryTab({ order, user }) {
  const { data, reload } = useLoad(() => api.get(`/orders/${order.id}/past-history`), [order.id]); const masters = useLoad(() => api.get('/masters'));
  const timeline = useLoad(() => api.get(`/patients/${order.patient_id}/timeline?module=pastHistory`), [order.patient_id, data?.created_at]);
  const can = TECH.includes(user.role); const a = useAction(); const [diseases, setDiseases] = useState({}); const [surgeries, setSurgeries] = useState([]); const [notes, setNotes] = useState(''); const [other, setOther] = useState({ bodyPart: '', disease: '' }); const [dOpts, setDOpts] = useState([]);
  useEffect(() => { if (data === undefined) return; const d = data || { diseases: [], surgeries: [] }; setDiseases(Object.fromEntries(d.diseases.map((x) => [x.disease, { ...x, medicines: x.medicines || [] }]))); setSurgeries((d.surgeries || []).map((s) => ({ ...s, path: s.path || [] }))); setNotes(data?.notes || ''); setOther(d.otherDisease || { bodyPart: '', disease: '' }); }, [data]);
  useEffect(() => { if (other.bodyPart) api.get('/masters/diseases?bodyPart=' + encodeURIComponent(other.bodyPart)).then(setDOpts).catch(() => {}); else setDOpts([]); }, [other.bodyPart]);
  const list = DISEASES.filter((d) => d !== 'M/H' || order.sex === 'F');
  const setD = (name, patch) => setDiseases((p) => ({ ...p, [name]: { ...p[name], ...patch } }));
  const save = () => a.run(async () => {
    await api.post(`/orders/${order.id}/past-history`, { diseases: Object.values(diseases).filter((d) => d.disease !== 'Surgery'), notes, otherDisease: other.disease ? other : undefined,
      surgeries: (diseases.Surgery ? surgeries : []).map((s) => ({ year: s.year, month: s.month, day: s.day, where: s.where, other: s.other, otherName: s.otherName, path: s.path })) });
    toast('Past history saved'); reload();
  });
  return (
    <>
      <p className="chart-title" style={{ marginTop: 0 }}>Diseases</p>
      {list.map((name) => { const d = diseases[name]; const on = Boolean(d); return (
        <div key={name} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
          <label className="check-row" style={{ border: 0, padding: 0 }}><input type="checkbox" disabled={!can} checked={on} onChange={(e) => setDiseases((p) => { const n = { ...p }; if (e.target.checked) n[name] = { disease: name, medicines: [], condition: 'controlled', mhOption: 'Regular' }; else delete n[name]; return n; })} /><span>{name}</span></label>
          {on && name !== 'Surgery' && <div className="form-grid" style={{ marginTop: 8 }}>
            <label><span>Since</span><Onset v={d} set={(v) => setD(name, v)} /></label>
            {['Diabetes', 'Blood Pressure'].includes(name) && <label><span>Condition</span><select disabled={!can} value={d.condition} onChange={(e) => setD(name, { condition: e.target.value })}><option value="controlled">Controlled</option><option value="uncontrolled">Uncontrolled</option></select></label>}
            {name === 'Allergy' && <label><span>Allergic to</span><select disabled={!can} value={d.allergyTo || ''} onChange={(e) => setD(name, { allergyTo: e.target.value })}><option value="">Select…</option>{masters.data?.medicineGroups.map((g) => <option key={g}>{g}</option>)}</select></label>}
            {name === 'M/H' && <label><span>Option</span><select disabled={!can} value={d.mhOption} onChange={(e) => setD(name, { mhOption: e.target.value })}>{['Perimenopausal', 'Postmenopausal', 'Regular'].map((o) => <option key={o}>{o}</option>)}</select></label>}
            {!['Allergy', 'M/H'].includes(name) && <div className="wide"><span className="chart-title">Medicine</span><MedicinePick value={d.medicines} disabled={!can} onChange={(m) => setD(name, { medicines: m })} /></div>}</div>}
          {on && name === 'Surgery' && <div className="table-scroll" style={{ marginTop: 8 }}><table className="clinical-table compact"><thead><tr><th>When</th><th>Where</th><th>Surgery</th><th /></tr></thead><tbody>
            {surgeries.map((s, i) => <SurgeryRow key={i} s={s} disabled={!can} set={(v) => setSurgeries(surgeries.map((x, j) => (j === i ? v : x)))} remove={() => setSurgeries(surgeries.filter((_, j) => j !== i))} />)}</tbody></table>
            {can && <button className="btn btn-light btn-sm" onClick={() => setSurgeries([...surgeries, { where: 'Elsewhere', other: false, path: [] }])}><Icon name="plus" size={12} /> Add surgery</button>}</div>}
        </div>); })}
      <p className="chart-title" style={{ marginTop: 16 }}>Other disease</p>
      <div className="form-grid"><label><span>Body part</span><select disabled={!can} value={other.bodyPart} onChange={(e) => setOther({ bodyPart: e.target.value, disease: '' })}><option value="">Select…</option>{masters.data?.bodyParts.map((b) => <option key={b}>{b}</option>)}</select></label>
        <label><span>Disease</span><select disabled={!can || !other.bodyPart} value={other.disease} onChange={(e) => setOther({ ...other, disease: e.target.value })}><option value="">Select…</option>{dOpts.map((o) => <option key={o.id}>{o.name}</option>)}</select></label>
        <label className="wide"><span>Notes</span><textarea disabled={!can} value={notes} onChange={(e) => setNotes(e.target.value)} /></label></div>
      <FormError error={a.error} />
      {can && <div className="row-gap" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn btn-primary" disabled={a.busy} onClick={save}>Save past history</button></div>}
      {timeline.data?.length > 0 && <><p className="chart-title" style={{ marginTop: 18 }}>Patient past history (all visits)</p><ul className="mini-list">{timeline.data.slice(0, 8).map((h, i) => <li key={i}><strong>{h.diseases.map((d) => `${d.disease}${d.year ? ` (${d.year})` : ''}`).join(', ') || 'No diseases'}{h.surgeries.length ? ` · ${h.surgeries.length} surgery` : ''}</strong><span>{fmt(h.created_at)} · {h.actor_name}</span></li>)}</ul></>}
    </>
  );
}

/* ---------- Patient consent form for the scan (modality-driven, bilingual) ---------- */
const ROUTES = ['Oral', 'Rectal', 'IV', 'NBM']; const CTYPES = ['Oral', 'EchoFR', 'Iodine Contrasting']; const PLAIN_ONLY = ['XR', 'USG', 'DEXA'];
export function ScanConsentTab({ order, user, reload }) {
  const { data, reload: rl } = useLoad(() => api.get(`/orders/${order.id}/scan-consent`), [order.id]); const [lang, setL] = useLang(); const can = TECH.includes(user.role); const a = useAction();
  const m = order.modality; const plainOnly = PLAIN_ONLY.includes(m); const ct = m === 'CT'; const mri = ['MRI', 'OPEN_MRI'].includes(m);
  const [f, setF] = useState({ contrast: order.uses_contrast ? 'CONTRAST' : 'PLAIN', routes: [], contrastTypes: [], contrastNotes: '', mlContrast: '', egfr: '', serumCreatinine: '', sedation: false, nbm: false, anaesthetistInformed: false, medicineUsed: '', fullName: order.patient_name, date: todayISO(), agree: false });
  const tog = (k, v) => setF({ ...f, [k]: f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v] });
  const text = consentText(lang, order.exam_name);
  const closed = ['COMPLETED', 'REPORT_DRAFTED', 'REPORTED', 'DISPATCHED', 'COLLECTED', 'CANCELLED'].includes(order.status);
  const save = () => a.run(async () => {
    const body = { contrast: f.contrast, fullName: f.fullName, date: f.date, agree: f.agree, language: lang === 'hi' ? 'en' : lang, routes: f.routes, contrastTypes: f.contrastTypes, contrastNotes: f.contrastNotes, mlContrast: f.mlContrast, egfr: f.egfr, serumCreatinine: f.serumCreatinine,
      sedation: f.sedation ? { required: true, nbm: f.nbm, anaesthetistInformed: f.anaesthetistInformed, medicineUsed: f.medicineUsed } : undefined };
    const r = await api.post(`/orders/${order.id}/scan-consent`, body); toast(r.prepared ? 'Consent saved. Status updated to Prepared.' : 'Consent saved'); rl(); reload();
  });
  return (
    <>
      {data && <div className="final-stamp"><Icon name="check" size={16} /> Consent recorded by {data.actor_name} · {fmt(data.created_at)} · signed by {data.full_name}</div>}
      {!can && !data && <Notice>The technologist records the patient's consent before the scan.</Notice>}
      <div className="order-card"><div className="order-card-head"><h3>1. Scan</h3></div><div className="order-card-body"><div className="field"><span>Scan</span><strong>{order.exam_name}</strong></div><div className="field"><span>Modality</span><strong>{m}</strong></div></div></div>
      <div className="order-card"><div className="order-card-head"><h3>2. Plain or contrast</h3></div><div style={{ padding: 14 }}>{plainOnly ? <Badge tone="neutral">Plain only</Badge> : <div className="seg" style={{ maxWidth: 260 }}>{['PLAIN', 'CONTRAST'].map((c) => <button key={c} disabled={!can || closed || (order.uses_contrast && c === 'PLAIN')} className={f.contrast === c ? 'on' : ''} onClick={() => setF({ ...f, contrast: c })}>{c === 'PLAIN' ? 'Plain' : 'Contrast'}</button>)}</div>}</div></div>
      {ct && f.contrast === 'CONTRAST' && <div className="order-card"><div className="order-card-head"><h3>3. CT contrast</h3></div><div style={{ padding: 14 }} className="grid-2">
        <div><p className="chart-title">Route</p>{ROUTES.map((o) => <label className="check-row" key={o}><input type="checkbox" disabled={!can} checked={f.routes.includes(o)} onChange={() => tog('routes', o)} /><span>{o}</span></label>)}</div>
        <div><p className="chart-title">Contrast type</p>{CTYPES.map((o) => <label className="check-row" key={o}><input type="checkbox" disabled={!can} checked={f.contrastTypes.includes(o)} onChange={() => tog('contrastTypes', o)} /><span>{o}</span></label>)}</div></div></div>}
      {mri && f.contrast === 'CONTRAST' && <div className="order-card"><div className="order-card-head"><h3>3. MRI contrast</h3></div><div className="form-grid" style={{ padding: 14 }}>
        <label><span>Contrast (ml)</span><input type="number" disabled={!can} value={f.mlContrast} onChange={(e) => setF({ ...f, mlContrast: e.target.value })} /></label><label><span>eGFR (1–150)</span><input type="number" min={1} max={150} step="any" disabled={!can} value={f.egfr} onChange={(e) => setF({ ...f, egfr: e.target.value })} placeholder="mL/min/1.73 m²" /></label>
        <label><span>Serum creatinine</span><input type="number" step="0.01" disabled={!can} value={f.serumCreatinine} onChange={(e) => setF({ ...f, serumCreatinine: e.target.value })} /></label></div></div>}
      {(ct || mri) && <div className="order-card"><div className="order-card-head"><h3>4. Sedation</h3></div><div style={{ padding: 14 }}><label className="check-row"><input type="checkbox" disabled={!can} checked={f.sedation} onChange={(e) => setF({ ...f, sedation: e.target.checked })} /><span>Sedation required</span></label>
        {f.sedation && <div className="form-grid"><label className="check-row"><input type="checkbox" checked={f.nbm} onChange={(e) => setF({ ...f, nbm: e.target.checked })} /><span>NBM (nil by mouth)</span></label><label className="check-row"><input type="checkbox" checked={f.anaesthetistInformed} onChange={(e) => setF({ ...f, anaesthetistInformed: e.target.checked })} /><span>Anaesthetist informed</span></label><label className="wide"><span>Medicine used</span><input value={f.medicineUsed} onChange={(e) => setF({ ...f, medicineUsed: e.target.value })} /></label></div>}</div></div>}
      <div className="order-card"><div className="order-card-head"><h3>Consent statement</h3><select className="inline-input" style={{ width: 'auto' }} value={lang} onChange={(e) => setL(e.target.value)}>{Object.entries(LANGS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div style={{ padding: 14 }}><p style={{ marginTop: 0 }}>{text.intro}</p><ul style={{ listStyle: 'none', paddingLeft: 12 }}>{text.points.map((p) => <li key={p}>✔ {p}</li>)}</ul>{lang === 'hi' && <p className="note">Hindi consent wording is not available; the English statement is shown and recorded.</p>}</div></div>
      <div className="order-card"><div className="order-card-head"><h3>Signature</h3></div><div className="form-grid" style={{ padding: 14 }}>
        <label><span>Full name (patient or guardian)</span><input disabled={!can || closed} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label><label><span>Date</span><input type="date" disabled={!can || closed} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
        <label className="check-row wide"><input type="checkbox" disabled={!can || closed} checked={f.agree} onChange={(e) => setF({ ...f, agree: e.target.checked })} /><span>I agree to the consent statement</span></label></div></div>
      <FormError error={a.error} />
      {can && !closed && <div className="row-gap" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={a.busy || !f.fullName.trim() || !f.agree} onClick={save}>Save consent</button></div>}
    </>
  );
}
