import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, forbidden, notFound, now, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { FINAL_STATUSES, getOrderForUser, transition } from './orders.js';
import { config } from './config.js';

const TECH = ['technologist', 'radiologist'];
const AUDIO = /^data:audio\/(webm|mp4|ogg|mpeg|wav)(;codecs=[\w.,-]+)?;base64,[A-Za-z0-9+/=]+$/;

/* ---------- Patient's words (text + audio) ---------- */
export function saveWords(orderId, body, user) {
  requireRole(user, TECH);
  const o = getOrderForUser(orderId, user);
  const text = optionalText(body.text, 5000); const audio = Array.isArray(body.audio) ? body.audio : [];
  if (!text && !audio.length) throw bad('WORDS_EMPTY', 'Write what the patient said or add a recording');
  if (audio.length > 5) throw bad('TOO_MANY_RECORDINGS', 'At most 5 recordings per entry');
  for (const a of audio) { if (!AUDIO.test(a?.data || '')) throw bad('AUDIO_INVALID', 'Recording must be webm, mp4, ogg, mp3 or wav audio'); if (a.data.length * 0.75 > 4_000_000) throw bad('AUDIO_TOO_LARGE', 'Each recording must be under 4 MB'); }
  const id = uid('wrd'); const t = now();
  tx(db, () => {
    db.prepare('INSERT INTO patient_words (id, encounter_id, patient_id, text, created_by, created_by_name, created_at) VALUES (?,?,?,?,?,?,?)').run(id, o.encounter_id, o.patient_id, text, user.id, user.fullName, t);
    for (const a of audio) db.prepare('INSERT INTO patient_word_audio (id, words_id, mime, data, created_at) VALUES (?,?,?,?,?)').run(uid('aud'), id, a.data.slice(5, a.data.indexOf(';')), a.data, t);
    audit({ action: 'PATIENT_WORDS_SAVED', actor: user, patientId: o.patient_id, resource: o.accession, details: { recordings: audio.length } });
  });
  return listWords(orderId, user);
}
export function listWords(orderId, user) {
  const o = getOrderForUser(orderId, user);
  return db.prepare('SELECT * FROM patient_words WHERE encounter_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(o.encounter_id)
    .map((w) => ({ ...w, audio: db.prepare('SELECT id, mime, created_at FROM patient_word_audio WHERE words_id = ?').all(w.id) }));
}
export function getAudio(audioId, user) {
  const a = db.prepare('SELECT a.*, w.encounter_id FROM patient_word_audio a JOIN patient_words w ON w.id = a.words_id WHERE a.id = ? AND w.deleted_at IS NULL').get(audioId);
  if (!a) throw notFound('Recording');
  const any = db.prepare('SELECT id FROM orders WHERE encounter_id = ?').all(a.encounter_id);
  for (const o of any) { try { getOrderForUser(o.id, user); audit({ action: 'PATIENT_AUDIO_PLAYED', actor: user, resource: audioId }); return { mime: a.mime, data: a.data }; } catch { /* try next */ } }
  throw forbidden('You do not have access to this recording');
}
export function deleteWords(wordsId, user) {
  requireRole(user, TECH);
  const w = db.prepare('SELECT * FROM patient_words WHERE id = ? AND deleted_at IS NULL').get(wordsId);
  if (!w) throw notFound('Entry');
  if (w.created_by !== user.id && user.role !== 'radiologist') throw forbidden('Only the author or a radiologist can delete this entry');
  // Soft delete: the entry and its recordings are hidden from every screen but kept in the database (clinical record retention).
  tx(db, () => {
    db.prepare('UPDATE patient_words SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(now(), user.id, wordsId);
    audit({ action: 'PATIENT_WORDS_DELETED', actor: user, patientId: w.patient_id, resource: wordsId });
  });
  return { ok: true };
}

/* ---------- Medical consent form (devices, history, allergies, pregnancy) ---------- */
export const DEVICES = ['PaceMaker', 'ArtificialHeart', 'MetalImplants', 'DentalPlate', 'HearingAids'];
export const HISTORY = ['PastIllness', 'HistoryDM', 'Ht', 'Other'];
export function saveMedicalConsent(orderId, body, user) {
  requireRole(user, TECH);
  const o = getOrderForUser(orderId, user);
  const pick = (v, allowed, f) => { const a = Array.isArray(v) ? v : []; for (const x of a) if (!allowed.includes(x)) throw bad('FIELD_INVALID', `${f}: ${x} is not an option`); return [...new Set(a)]; };
  const weight = body.weight === '' || body.weight == null ? null : Number(body.weight);
  if (weight != null && (!Number.isFinite(weight) || weight < 1 || weight > 400)) throw bad('WEIGHT_INVALID', 'Weight must be between 1 and 400 kg');
  const allergies = { has: body.allergiesHas === true, details: optionalText(body.allergiesDetails, 300) };
  if (allergies.has && !allergies.details) throw bad('ALLERGY_DETAILS_REQUIRED', 'Say what the patient is allergic to');
  const pregnancy = { is: body.isPregnant === true, months: body.isPregnant === true ? Number(body.monthsPregnant) : null };
  if (pregnancy.is && !(Number.isInteger(pregnancy.months) && pregnancy.months >= 1 && pregnancy.months <= 9)) throw bad('PREGNANCY_MONTHS_INVALID', 'Pregnancy duration must be 1 to 9 months');
  const data = { medicalDevices: pick(body.medicalDevices, DEVICES, 'Medical devices'), medicalHistory: pick(body.medicalHistory, HISTORY, 'Medical history'), allergies, pregnancy, weight, provisionalReport: optionalText(body.provisionalReport, 2000) };
  tx(db, () => {
    db.prepare('INSERT INTO medical_consents (id, encounter_id, patient_id, data_json, actor_id, actor_name, created_at) VALUES (?,?,?,?,?,?,?)').run(uid('mcf'), o.encounter_id, o.patient_id, JSON.stringify(data), user.id, user.fullName, now());
    if (allergies.has && allergies.details) db.prepare("UPDATE patients SET allergy = ? WHERE id = ? AND (allergy = 'None recorded' OR allergy = '')").run(allergies.details, o.patient_id);
    audit({ action: 'MEDICAL_CONSENT_SAVED', actor: user, patientId: o.patient_id, resource: o.accession, details: { devices: data.medicalDevices.length, pregnant: pregnancy.is } });
  });
  return getMedicalConsent(orderId, user);
}
export function getMedicalConsent(orderId, user) {
  const o = getOrderForUser(orderId, user);
  const r = db.prepare('SELECT * FROM medical_consents WHERE encounter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(o.encounter_id);
  return r ? { ...JSON.parse(r.data_json), actor_name: r.actor_name, created_at: r.created_at } : null;
}

/* ---------- Past history ---------- */
export const HISTORY_DISEASES = ['Diabetes', 'Blood Pressure', 'Cholesterol (Blood Thinner)', 'Thyroid', 'Acidity', 'Allergy', 'Surgery', 'M/H'];
const CONDITION = ['controlled', 'uncontrolled'];
const onset = (d) => ({ year: d.year ? Number(d.year) : null, month: d.month ? Number(d.month) : null, day: d.day ? Number(d.day) : null });
export function savePastHistory(orderId, body, user) {
  requireRole(user, TECH);
  const o = getOrderForUser(orderId, user);
  const diseases = (Array.isArray(body.diseases) ? body.diseases : []).map((d) => {
    const name = oneOf(d.disease, HISTORY_DISEASES, 'disease');
    if (name === 'M/H' && o.sex !== 'F') throw bad('MH_FEMALE_ONLY', 'M/H applies to female patients only');
    const on = onset(d);
    if (on.year && (on.year < 1900 || on.year > new Date().getFullYear())) throw bad('YEAR_INVALID', `${name}: year is not valid`);
    return { disease: name, ...on, condition: ['Diabetes', 'Blood Pressure'].includes(name) ? oneOf(d.condition || 'controlled', CONDITION, 'condition') : null,
      medicines: (Array.isArray(d.medicines) ? d.medicines : []).slice(0, 10).map((m) => optionalText(m, 80)).filter(Boolean),
      allergyTo: name === 'Allergy' ? optionalText(d.allergyTo, 80) : null, mhOption: name === 'M/H' ? oneOf(d.mhOption || 'Regular', ['Perimenopausal', 'Postmenopausal', 'Regular'], 'M/H option') : null };
  });
  const surgeries = (Array.isArray(body.surgeries) ? body.surgeries : []).slice(0, 20).map((s) => {
    const other = s.other === true;
    const path = (Array.isArray(s.path) ? s.path : []).slice(0, 5).map(Number);
    if (!other && path.length) { let parent = null; path.forEach((id, i) => { const row = db.prepare('SELECT * FROM surgery_tree WHERE id = ?').get(id); if (!row || row.level !== i + 1 || (row.parent_id ?? null) !== parent) throw bad('SURGERY_INVALID', 'Surgery selection is not valid'); parent = id; }); }
    return { ...onset(s), where: oneOf(s.where || 'Elsewhere', ['Stavya', 'Elsewhere'], 'where'), other, otherName: other ? requireText(s.otherName, 'Surgery name', 150) : null,
      path: other ? [] : path, description: other ? null : path.map((id) => db.prepare('SELECT name FROM surgery_tree WHERE id = ?').get(id).name).join(' › ') };
  });
  const other = body.otherDisease?.disease ? { bodyPart: requireText(body.otherDisease.bodyPart, 'Body part', 60), disease: requireText(body.otherDisease.disease, 'Disease', 100) } : null;
  const data = { diseases, surgeries, otherDisease: other };
  tx(db, () => {
    db.prepare('INSERT INTO past_history (id, encounter_id, patient_id, data_json, notes, actor_id, actor_name, created_at) VALUES (?,?,?,?,?,?,?,?)').run(uid('pht'), o.encounter_id, o.patient_id, JSON.stringify(data), optionalText(body.notes, 4000), user.id, user.fullName, now());
    audit({ action: 'PAST_HISTORY_SAVED', actor: user, patientId: o.patient_id, resource: o.accession, details: { diseases: diseases.length, surgeries: surgeries.length } });
  });
  return getPastHistory(orderId, user);
}
export function getPastHistory(orderId, user) {
  const o = getOrderForUser(orderId, user);
  const r = db.prepare('SELECT * FROM past_history WHERE encounter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(o.encounter_id);
  return r ? { ...JSON.parse(r.data_json), notes: r.notes, actor_name: r.actor_name, created_at: r.created_at } : null;
}
// Timeline across all visits ("Patient Words History", "Patient Past History" in the agency app)
export function patientTimeline(patientId, module, user) {
  requireRole(user, [...TECH, 'reception', 'admin']);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) throw notFound('Patient');
  audit({ action: 'PATIENT_TIMELINE_VIEWED', actor: user, patientId, details: { module } });
  if (module === 'words') return db.prepare('SELECT id, text, created_by_name, created_at, (SELECT COUNT(*) FROM patient_word_audio a WHERE a.words_id = patient_words.id) recordings FROM patient_words WHERE patient_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 100').all(patientId);
  if (module === 'pastHistory') return db.prepare('SELECT * FROM past_history WHERE patient_id = ? ORDER BY created_at DESC LIMIT 100').all(patientId).map((r) => ({ ...JSON.parse(r.data_json), notes: r.notes, actor_name: r.actor_name, created_at: r.created_at }));
  throw bad('MODULE_INVALID', 'module must be words or pastHistory');
}

/* ---------- Scan consent (modality-driven) ---------- */
const PLAIN_ONLY = ['XR', 'USG', 'DEXA'];
export const CONTRAST_ROUTES = ['Oral', 'Rectal', 'IV', 'NBM']; export const CONTRAST_TYPES = ['Oral', 'EchoFR', 'Iodine Contrasting'];
export function saveScanConsent(orderId, body, user) {
  requireRole(user, TECH);
  const o = getOrderForUser(orderId, user);
  if (['CANCELLED', 'REPORTED', 'DISPATCHED', 'COLLECTED', 'COMPLETED', 'REPORT_DRAFTED'].includes(o.status)) throw conflict('CONSENT_CLOSED', `Consent cannot be changed when the study is ${o.status}`);
  const contrast = oneOf(body.contrast || 'PLAIN', ['PLAIN', 'CONTRAST'], 'contrast');
  if (PLAIN_ONLY.includes(o.modality) && contrast !== 'PLAIN') throw bad('PLAIN_ONLY', `${o.modality} studies are plain only`);
  if (o.uses_contrast && contrast !== 'CONTRAST') throw bad('CONTRAST_REQUIRED', 'This study is ordered with contrast');
  const data = { contrast, sedation: null, ct: null, mri: null };
  const note = (v) => optionalText(v, 200);
  if (contrast === 'CONTRAST' && o.modality === 'CT') {
    const routes = (Array.isArray(body.routes) ? body.routes : []); const types = (Array.isArray(body.contrastTypes) ? body.contrastTypes : []);
    if (!routes.length || routes.some((r) => !CONTRAST_ROUTES.includes(r))) throw bad('ROUTE_REQUIRED', 'Choose the contrast route');
    if (!types.length || types.some((r) => !CONTRAST_TYPES.includes(r))) throw bad('CONTRAST_TYPE_REQUIRED', 'Choose the contrast type');
    data.ct = { routes, contrastTypes: types, notes: note(body.contrastNotes) };
  }
  if (contrast === 'CONTRAST' && ['MRI', 'OPEN_MRI'].includes(o.modality)) {
    const ml = Number(body.mlContrast); const egfr = Number(body.egfr); const cr = Number(body.serumCreatinine);
    if (!(ml > 0 && ml <= 100)) throw bad('CONTRAST_ML_INVALID', 'Enter the contrast volume in ml');
    // JCI/NABH-aligned reportable eGFR range (mL/min/1.73 m²); no auto clinical flag on the value.
    if (!Number.isFinite(egfr) || egfr < 1 || egfr > 150) {
      throw bad('EGFR_INVALID', 'eGFR must be between 1 and 150 mL/min/1.73 m² (JCI/NABH lab reporting range)');
    }
    if (!(cr > 0 && cr <= 20)) throw bad('CREATININE_INVALID', 'Enter the serum creatinine');
    data.mri = { mlContrast: ml, egfr, serumCreatinine: cr, notes: note(body.contrastNotes) };
  }
  if (['CT', 'MRI', 'OPEN_MRI'].includes(o.modality) && body.sedation?.required === true) {
    data.sedation = { required: true, nbm: body.sedation.nbm === true, anaesthetistInformed: body.sedation.anaesthetistInformed === true, medicineUsed: note(body.sedation.medicineUsed), notes: note(body.sedation.notes) };
  }
  const fullName = requireText(body.fullName, 'Full name', 120); const signedDate = requireText(body.date, 'Date', 10);
  if (Number.isNaN(Date.parse(signedDate)) || signedDate > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) throw bad('DATE_INVALID', 'Consent date must be today or earlier');
  if (body.agree !== true) throw bad('AGREE_REQUIRED', 'The patient (or guardian) must agree to the consent statement');
  const language = oneOf(body.language || 'en', ['en', 'hi', 'gu'], 'language');
  let prepared = false;
  // The consent and the move to PREPARED commit together: a consent is never recorded with the study left in the wrong state.
  tx(db, () => {
    db.prepare('INSERT INTO scan_consents (id, order_id, data_json, full_name, signed_date, language, actor_id, actor_name, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(uid('scn'), orderId, JSON.stringify(data), fullName, signedDate, language, user.id, user.fullName, now());
    if (data.sedation) db.prepare('UPDATE orders SET needs_sedation = 1, updated_at = ? WHERE id = ?').run(now(), orderId);
    audit({ action: 'SCAN_CONSENT_SAVED', actor: user, patientId: o.patient_id, resource: o.accession, details: { contrast, sedation: Boolean(data.sedation), language } });
    if (o.status === 'ARRIVED') { transition(orderId, { to: 'PREPARED', note: 'Patient consent recorded' }, user); prepared = true; }
  });
  if (data.sedation) {
    const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(o.patient_id);
    import('./integrations.js').then((m) => m.onSedationRequired(o, patient, {
      medicineUsed: data.sedation.medicineUsed,
      notes: data.sedation.notes,
      actor: user
    })).catch(() => {});
  }
  return { consent: getScanConsent(orderId, user), prepared };
}
export function getScanConsent(orderId, user) {
  getOrderForUser(orderId, user);
  const r = db.prepare('SELECT * FROM scan_consents WHERE order_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(orderId);
  return r ? { ...JSON.parse(r.data_json), full_name: r.full_name, signed_date: r.signed_date, language: r.language, actor_name: r.actor_name, created_at: r.created_at } : null;
}

/* ---------- Visit summary (OPD summary in the agency app) ---------- */
export const SUMMARY_MODULES = ['patientInfo', 'words', 'pastHistory', 'consent', 'orders', 'reports'];
function visitAccess(encounterId, user) {
  const orders = db.prepare('SELECT id FROM orders WHERE encounter_id = ?').all(encounterId);
  if (!orders.length) throw notFound('Visit');
  for (const o of orders) { try { return getOrderForUser(o.id, user); } catch { /* next */ } }
  throw forbidden('You do not have access to this visit');
}
export function visitSummary(encounterId, user) {
  const first = visitAccess(encounterId, user);
  const enc = db.prepare('SELECT e.*, u.full_name doctor_name FROM encounters e LEFT JOIN users u ON u.id = e.doctor_id WHERE e.id = ?').get(encounterId);
  const patient = db.prepare('SELECT id, mrn, name, dob, sex, phone, allergy FROM patients WHERE id = ?').get(first.patient_id);
  const orders = db.prepare(`SELECT o.id, o.accession, o.status, o.priority, o.side, o.final_amount, o.clinical_indication, x.name exam_name, x.modality FROM orders o JOIN exam_catalog x ON x.code = o.exam_code
    WHERE o.encounter_id = ? AND o.status != 'CANCELLED' ORDER BY o.created_at`).all(encounterId).map((o) => {
    const rep = FINAL_STATUSES.includes(o.status) ? db.prepare("SELECT impression, findings, author_name, signed_at FROM reports WHERE order_id = ? AND status = 'FINAL' AND kind = 'REPORT'").get(o.id) : null;
    return { ...o, report: rep };
  });
  const words = db.prepare('SELECT text, created_by_name, created_at FROM patient_words WHERE encounter_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get(encounterId) || null;
  return { patient, encounter: enc, words, pastHistory: getPastHistory(first.id, user), medicalConsent: getMedicalConsent(first.id, user), orders };
}
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function summaryHtml(encounterId, modules, user) {
  const inc = new Set((Array.isArray(modules) ? modules : SUMMARY_MODULES).filter((m) => SUMMARY_MODULES.includes(m)));
  const s = visitSummary(encounterId, user);
  audit({ action: 'VISIT_SUMMARY_PRINTED', actor: user, patientId: s.patient.id, resource: s.encounter.ref_no, details: { modules: [...inc] } });
  const sec = (t, body) => `<section><h3>${esc(t)}</h3>${body}</section>`;
  const parts = [];
  if (inc.has('patientInfo')) parts.push(sec('Patient information', `<p><b>${esc(s.patient.name)}</b> · ${esc(s.patient.mrn)} · ${esc(s.patient.dob)} · ${esc(s.patient.sex)}<br>Visit ${esc(s.encounter.ref_no)} (${esc(s.encounter.type)})${s.encounter.doctor_name ? ` · ${esc(s.encounter.doctor_name)}` : ''}<br>Allergy: ${esc(s.patient.allergy)}</p>`));
  if (inc.has('words') && s.words) parts.push(sec("Patient's words", `<p>${esc(s.words.text).replace(/\n/g, '<br>')}</p>`));
  if (inc.has('pastHistory') && s.pastHistory) parts.push(sec('Past history', `<ul>${s.pastHistory.diseases.map((d) => `<li>${esc(d.disease)}${d.year ? ` since ${esc(d.year)}` : ''}${d.condition ? ` (${esc(d.condition)})` : ''}${d.medicines.length ? ` — ${esc(d.medicines.join(', '))}` : ''}</li>`).join('')}${s.pastHistory.surgeries.map((x) => `<li>Surgery: ${esc(x.other ? x.otherName : x.description)}${x.year ? ` (${esc(x.year)})` : ''}, ${esc(x.where)}</li>`).join('')}</ul>${s.pastHistory.notes ? `<p>${esc(s.pastHistory.notes)}</p>` : ''}`));
  if (inc.has('consent') && s.medicalConsent) { const c = s.medicalConsent; parts.push(sec('Consent screening', `<p>Devices: ${esc(c.medicalDevices.join(', ') || 'none')}<br>History: ${esc(c.medicalHistory.join(', ') || 'none')}<br>Weight: ${esc(c.weight ?? '—')} kg<br>Allergies: ${c.allergies.has ? esc(c.allergies.details) : 'none'}<br>Pregnancy: ${c.pregnancy.is ? `${esc(c.pregnancy.months)} months` : 'no'}</p>`)); }
  if (inc.has('orders')) parts.push(sec('Radiology orders', `<table><tr><th>Scan</th><th>Status</th><th>Amount</th></tr>${s.orders.map((o) => `<tr><td>${esc(o.exam_name)}${o.side ? ` (${esc(o.side)})` : ''}</td><td>${esc(o.status)}</td><td>₹ ${esc(o.final_amount)}</td></tr>`).join('')}</table>`));
  if (inc.has('reports')) parts.push(sec('Reports', s.orders.filter((o) => o.report).map((o) => `<h4>${esc(o.exam_name)}</h4><p><b>Impression:</b> ${esc(o.report.impression).replace(/\n/g, '<br>')}<br><small>${esc(o.report.author_name)} · ${esc(o.report.signed_at)}</small></p>`).join('') || '<p>No signed reports yet.</p>'));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Visit summary</title><style>body{font:13px/1.5 system-ui,sans-serif;max-width:820px;margin:1.5rem auto;padding:0 1rem;color:#0f172a}h1{font-size:20px;margin:0}h3{border-bottom:1px solid #cbd5e1;padding-bottom:4px;margin-top:1.4rem}table{width:100%;border-collapse:collapse}th,td{border:1px solid #cbd5e1;padding:5px 8px;text-align:left}@media print{button{display:none}}</style></head><body><h1>${esc(config.hospitalName)}</h1><p>Visit summary</p>${parts.join('') || '<p>No sections selected.</p>'}<button onclick="print()">Print / Save as PDF</button></body></html>`;
}
