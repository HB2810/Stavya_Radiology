import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, forbidden, likeEsc, notFound, now, nowMs, oneOf, optionalText, requireText, uid, dateRange, tx } from './util.js';
import { config } from './config.js';
import { OCCUPATIONS } from './reference-data.js';
import { consumeVerified, deliveryConfigured, normaliseEmail, normalisePhone } from './otp.js';
import { EQUIPMENT_KEYS, FINAL_STATUSES, OPEN_STATUSES, createOrder, listOrders, transition, getOrderForUser } from './orders.js';
import { createPendingApproval, resolveDiscount, supersedePendingApprovals } from './discounts.js';
import { notify, usersWithRoles } from './notifications.js';
import { createHash } from 'node:crypto';

const STAFF = ['reception', 'admin'];
const requireOtp = () => config.requirePatientOtp;

/* ---- Aadhaar number checksum (Verhoeff). We validate and store only a salted hash + last 4 digits, never the number. ---- */
const D = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const P = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function validAadhaar(n) {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0; [...n].reverse().forEach((ch, i) => { c = D[c][P[i % 8][Number(ch)]]; });
  return c === 0;
}
const aadhaarHash = (n) => createHash('sha256').update(`ris-aadhaar:${n}`).digest('hex');

export const capabilities = () => ({ otpDelivery: deliveryConfigured(), otpRequiredForNewPatients: requireOtp(), aadhaarLookup: true, aadhaarOtpVerification: false,
  note: 'Aadhaar OTP verification needs a licensed UIDAI provider and is not configured; Aadhaar can be used to find an existing patient.' });

const mask = (p) => ({ id: p.id, mrn: p.mrn, name: p.name, dob: p.dob, sex: p.sex, phone: p.phone ? `${p.phone.slice(0, 2)}******${p.phone.slice(-2)}` : '', email: p.email || '', allergy: p.allergy });

export function lookupPatients(body, user) {
  requireRole(user, [...STAFF, 'radiologist', 'technologist']);
  let rows = [];
  if (body.phone) rows = db.prepare('SELECT * FROM patients WHERE phone = ?').all(normalisePhone(body.phone));
  else if (body.email) rows = db.prepare('SELECT * FROM patients WHERE lower(email) = ?').all(normaliseEmail(body.email));
  else if (body.uhid) rows = db.prepare('SELECT * FROM patients WHERE mrn = ?').all(requireText(body.uhid, 'UHID', 40));
  else if (body.aadhaar) {
    const n = String(body.aadhaar).replace(/\s/g, '');
    if (!validAadhaar(n)) throw bad('AADHAAR_INVALID', 'That is not a valid Aadhaar number');
    rows = db.prepare('SELECT * FROM patients WHERE aadhaar_hash = ?').all(aadhaarHash(n));
  } else throw bad('LOOKUP_KEY_REQUIRED', 'Give a phone, email, UHID or Aadhaar number');
  audit({ action: 'PATIENT_LOOKUP', actor: user, details: { found: rows.length, by: Object.keys(body).find((k) => body[k]) } });
  return rows.map(mask);
}

export function getPatientFull(id, user) {
  requireRole(user, [...STAFF, 'radiologist', 'technologist']);
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!p) throw notFound('Patient');
  const documents = db.prepare('SELECT id, proof_type, number, created_at, front_data IS NOT NULL has_front, back_data IS NOT NULL has_back FROM patient_documents WHERE patient_id = ? AND superseded_at IS NULL').all(id);
  const { aadhaar_hash, ...rest } = p;
  return { ...rest, documents };
}

const IMG = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
function image(v, field) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !IMG.test(v)) throw bad('IMAGE_INVALID', `${field} must be a PNG, JPEG or WebP image`);
  if (v.length * 0.75 > 1_500_000) throw bad('IMAGE_TOO_LARGE', `${field} must be under 1.5 MB`);
  return v;
}

export function savePatient(body, user) {
  requireRole(user, STAFF);
  const first = requireText(body.firstName, 'First name', 60); const last = requireText(body.lastName, 'Last name', 60); const middle = optionalText(body.middleName, 60);
  const dob = requireText(body.dob, 'Date of birth', 10);
  if (Number.isNaN(Date.parse(dob)) || Date.parse(dob) > Date.now() || dob < '1900-01-01') throw bad('DOB_INVALID', 'Enter a valid date of birth');
  const sex = oneOf(body.gender, ['M', 'F', 'O'], 'gender'); const phone = normalisePhone(body.phone);
  const email = body.email ? normaliseEmail(body.email) : null; const address = requireText(body.address, 'Address', 400);
  const occupation = body.occupation ? oneOf(body.occupation, OCCUPATIONS, 'occupation') : null;
  const zip = optionalText(body.zipcode, 10); if (zip && !/^\d{5,6}$/.test(zip)) throw bad('ZIP_INVALID', 'Pincode must be 5 or 6 digits');
  let aHash = null; let aLast = null;
  if (body.aadhaar) { const n = String(body.aadhaar).replace(/\s/g, ''); if (!validAadhaar(n)) throw bad('AADHAAR_INVALID', 'That is not a valid Aadhaar number'); aHash = aadhaarHash(n); aLast = n.slice(-4); }
  const proofs = Array.isArray(body.proofs) ? body.proofs : [];
  const occFront = image(body.occupationIdFront, 'ID front'); const occBack = image(body.occupationIdBack, 'ID back');
  if (occupation === 'Police Man' && !(occFront && occBack)) throw bad('OCCUPATION_ID_REQUIRED', 'Police personnel must upload the front and back of their department ID');
  const name = [first, middle, last].filter(Boolean).join(' ');
  const cols = { first_name: first, middle_name: middle || null, last_name: last, name, dob, sex, phone, email, address, country: optionalText(body.country, 60) || 'India', state: optionalText(body.state, 60) || null,
    city: optionalText(body.city, 60) || null, zipcode: zip || null, occupation, designation: optionalText(body.designation, 60) || null, reference: optionalText(body.reference, 100) || null, allergy: optionalText(body.allergy, 200) || 'None recorded' };
  let id = body.patientId || null; let created = false; let verifiedPhone; let verifiedEmail;
  tx(db, () => {
    // Consuming the one-time code is part of the same transaction: if saving fails, the code is not used up.
    verifiedPhone = body.verificationId && consumeVerified({ challengeId: body.verificationId, purpose: 'REGISTER', channel: 'phone', target: phone });
    verifiedEmail = body.verificationId && email && !verifiedPhone && consumeVerified({ challengeId: body.verificationId, purpose: 'REGISTER', channel: 'email', target: email });
    if (id) {
      if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(id)) throw notFound('Patient');
      const sets = Object.keys(cols).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE patients SET ${sets}${aHash ? ', aadhaar_hash = ?, aadhaar_last4 = ?' : ''}${verifiedPhone ? ', phone_verified = 1' : ''}${verifiedEmail ? ', email_verified = 1' : ''} WHERE id = ?`)
        .run(...Object.values(cols), ...(aHash ? [aHash, aLast] : []), id);
    } else {
      if (requireOtp() && !verifiedPhone && !verifiedEmail) throw bad('VERIFICATION_REQUIRED', 'Verify the patient\'s phone or email with a one-time code before registering a new patient');
      id = uid('pat'); created = true;
      let n = db.prepare('SELECT COUNT(*) c FROM patients').get().c + 1001; let mrn = `SSH-${n}`;
      while (db.prepare('SELECT 1 FROM patients WHERE mrn = ?').get(mrn)) mrn = `SSH-${++n}`;
      const names = Object.keys(cols);
      db.prepare(`INSERT INTO patients (id, mrn, ${names.join(', ')}, aadhaar_hash, aadhaar_last4, phone_verified, email_verified, created_at) VALUES (?,?,${names.map(() => '?').join(',')},?,?,?,?,?)`)
        .run(id, mrn, ...Object.values(cols), aHash, aLast, verifiedPhone ? 1 : 0, verifiedEmail ? 1 : 0, now());
    }
    const putDoc = (type, number, front, back) => {
      // An earlier copy of the same proof is kept (superseded), never deleted.
      db.prepare('UPDATE patient_documents SET superseded_at = ? WHERE patient_id = ? AND proof_type = ? AND superseded_at IS NULL').run(now(), id, type);
      db.prepare('INSERT INTO patient_documents (id, patient_id, proof_type, number, front_data, back_data, created_at) VALUES (?,?,?,?,?,?,?)').run(uid('doc'), id, type, number, front, back, now());
    };
    for (const pr of proofs) {
      const t = db.prepare('SELECT * FROM proof_types WHERE id = ?').get(String(pr.proofType || ''));
      if (!t) throw bad('PROOF_INVALID', 'Unknown identity proof type');
      const number = requireText(pr.number, `${t.name} number`, 40);
      const front = image(pr.front, `${t.name} front`); const back = image(pr.back, `${t.name} back`);
      if (['front', 'both'].includes(t.document_side) && pr.requireImages && !front) throw bad('IMAGE_REQUIRED', `${t.name}: front image required`);
      putDoc(t.id, number, front, back);
    }
    if (occFront || occBack) putDoc('occupation-id', occupation, occFront, occBack);
    audit({ action: created ? 'PATIENT_REGISTERED' : 'PATIENT_UPDATED', actor: user, patientId: id, details: { verified: Boolean(verifiedPhone || verifiedEmail) } });
  });
  return getPatientFull(id, user);
}

/* ---- Registration (a billable visit with one or more scans) ---- */
export function summarize(regId) {
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId);
  if (!reg) throw notFound('Registration');
  const lines = db.prepare("SELECT * FROM orders WHERE registration_id = ? AND status != 'CANCELLED'").all(regId);
  const sum = (k) => Math.round(lines.reduce((a, l) => a + l[k], 0) * 100) / 100;
  const pay = db.prepare('SELECT status, amount, discount FROM payments WHERE registration_id = ?').all(regId);
  const received = pay.filter((p) => p.status === 'RECEIVED').reduce((a, p) => a + p.amount, 0);
  const payDiscount = pay.filter((p) => p.status !== 'BOUNCED').reduce((a, p) => a + p.discount, 0);
  const inProcess = pay.filter((p) => p.status === 'IN_PROCESS').reduce((a, p) => a + p.amount, 0);
  const refundsPaid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE registration_id = ? AND status = 'PAID'").get(regId).s;
  const refundsOpen = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE registration_id = ? AND status IN ('PENDING','APPROVED')").get(regId).s;
  const finalTotal = sum('final_amount'); const netPaid = Math.round((received - refundsPaid) * 100) / 100;
  const pending = Math.round((finalTotal - netPaid - payDiscount) * 100) / 100;
  const status = finalTotal - payDiscount <= 0.005 || pending <= 0.005 ? 'paid' : netPaid > 0 ? 'partial' : 'pending';
  return { ...reg, base_total: sum('base_price'), discount_total: sum('discount_amount'), final_total: finalTotal, paid_amount: netPaid, pay_discount: payDiscount,
    pending_amount: Math.max(0, pending), credit_amount: Math.max(0, -pending), cheque_in_process: inProcess, available_to_collect: Math.max(0, pending - inProcess),
    refund_open: refundsOpen, refundable: Math.max(0, Math.round((netPaid - refundsOpen) * 100) / 100), payment_status: status, line_count: lines.length };
}

const reg_no = () => { const y = new Date(nowMs()).getFullYear(); return `REG-${y}-${String(db.prepare('SELECT COUNT(*) c FROM registrations WHERE reg_no LIKE ?').get(`REG-${y}-%`).c + 1).padStart(6, '0')}`; };

export function createRegistration(body, user) {
  requireRole(user, STAFF);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(String(body.patientId || ''));
  if (!patient) throw notFound('Patient');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw bad('ITEMS_REQUIRED', 'Select at least one scan');
  if (items.length > 12) throw bad('TOO_MANY_ITEMS', 'At most 12 scans per registration');
  if (items.some((it) => it === null || typeof it !== 'object' || Array.isArray(it))) throw bad('ITEMS_INVALID', 'Each scan must be an object with an examCode');
  const id = uid('reg'); const t = now(); const encId = uid('enc');
  // One transaction for the encounter, registration, every scan order and the audit entries: if any scan is refused
  // (for example a possible duplicate), nothing is left behind.
  tx(db, () => {
    // These patients never had an OPD visit or IPD admission: they walked in to use the facility directly, so the
    // encounter is tagged 'EXTERNAL' (not 'OPD') -- it is the third traffic source alongside OPD and IPD orders.
    const ref = `EXT-RAD-${new Date(nowMs()).getFullYear()}-${String(db.prepare("SELECT COUNT(*) c FROM encounters WHERE ref_no LIKE 'EXT-RAD-%'").get().c + 1).padStart(5, '0')}`;
    const no = reg_no();
    db.prepare("INSERT INTO encounters (id, patient_id, type, ref_no, diagnosis, created_at) VALUES (?,?,?,?,?,?)").run(encId, patient.id, 'EXTERNAL', ref, optionalText(body.diagnosis, 300) || null, t);
    db.prepare('INSERT INTO registrations (id, reg_no, patient_id, encounter_id, referring_doctor, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, no, patient.id, encId, optionalText(body.referringDoctor, 120) || null, user.id, t, t);
    for (const it of items) {
      createOrder({ patientId: patient.id, encounterId: encId, examCode: it.examCode, priority: it.priority || body.priority || 'ROUTINE', side: it.side,
        clinicalIndication: optionalText(it.indication, 500) || optionalText(body.indication, 500) || 'Walk-in registration', noCharge: Boolean(it.noCharge),
        schemeId: it.schemeId, discountPct: it.discountPct, waiverReason: it.waiverReason, confirmDuplicate: body.confirmDuplicate === true }, user, { skipRoleCheck: true, registrationId: id });
    }
    audit({ action: 'REGISTRATION_CREATED', actor: user, patientId: patient.id, resource: no, details: { scans: items.length } });
    return no;
  });
  return getRegistration(id, user);
}

export function getRegistration(id, user) {
  requireRole(user, [...STAFF, 'radiologist']);
  const s = summarize(id);
  const patient = db.prepare('SELECT id, mrn, name, dob, sex, phone, email, address, allergy FROM patients WHERE id = ?').get(s.patient_id);
  const lines = listOrders(user, { registrationId: id });
  const payments = db.prepare('SELECT * FROM payments WHERE registration_id = ? ORDER BY at').all(id).map((p) => ({ ...p, details: JSON.parse(p.details_json) }));
  const refunds = db.prepare('SELECT * FROM refunds WHERE registration_id = ? ORDER BY requested_at').all(id);
  return { registration: s, patient, lines, payments, refunds };
}

export function listRegistrations(user, q = {}) {
  requireRole(user, [...STAFF, 'radiologist']);
  const where = ['1=1']; const args = [];
  const range = dateRange(q.date_type || q.start_date ? q : { date_type: 'day' });
  if (range) { where.push('r.created_at >= ? AND r.created_at < ?'); args.push(range[0], range[1]); }
  if (q.q) {
    const like = `%${likeEsc(q.q)}%`; const f = q.field || 'all'; const E = "ESCAPE '\\'";
    if (f === 'patient_name') { where.push(`p.name LIKE ? ${E}`); args.push(like); }
    else if (f === 'doctor_name') { where.push(`r.referring_doctor LIKE ? ${E}`); args.push(like); }
    else { where.push(`(p.name LIKE ? ${E} OR p.mrn LIKE ? ${E} OR r.reg_no LIKE ? ${E} OR p.phone LIKE ? ${E})`); args.push(like, like, like, like); }
  }
  if (q.equipment && q.equipment !== 'all') { where.push('EXISTS (SELECT 1 FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.registration_id = r.id AND x.modality = ?)'); args.push(EQUIPMENT_KEYS[q.equipment] || '\u0000'); }
  const rows = db.prepare(`SELECT r.id FROM registrations r JOIN patients p ON p.id = r.patient_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 1000`).all(...args);
  let out = rows.map(({ id }) => {
    const s = summarize(id); const p = db.prepare('SELECT id, mrn, name, phone FROM patients WHERE id = ?').get(s.patient_id);
    const lines = db.prepare("SELECT o.exam_code, o.status, o.clinical_indication, x.name exam_name, x.modality FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.registration_id = ? AND o.status != 'CANCELLED'").all(id);
    return { ...s, patient: p, exams: lines.map((l) => l.exam_name), suggestions: [...new Set(lines.map((l) => l.clinical_indication))], statuses: [...new Set(lines.map((l) => l.status))] };
  });
  if (q.payment_status) out = out.filter((r) => r.payment_status === q.payment_status);
  return out;
}

export function updateInvoice(regId, body, user) {
  requireRole(user, STAFF);
  const reg = summarize(regId);
  if (reg.status !== 'ACTIVE') throw conflict('REGISTRATION_CLOSED', 'This registration is cancelled');
  const pendingNotices = []; // discount approvals created in this call; admins are notified after the tx commits
  tx(db, () => {
    const t = now();
    if (body.reportNo !== undefined || body.reportDate !== undefined || body.deliveryAt !== undefined) {
      if (body.deliveryAt && Number.isNaN(Date.parse(body.deliveryAt))) throw bad('DATE_INVALID', 'Delivery date is not valid');
      db.prepare('UPDATE registrations SET report_no = COALESCE(?, report_no), report_date = COALESCE(?, report_date), delivery_at = COALESCE(?, delivery_at), updated_at = ? WHERE id = ?')
        .run(body.reportNo ?? null, body.reportDate ?? null, body.deliveryAt ?? null, t, regId);
    }
    for (const u of (Array.isArray(body.update) ? body.update : [])) {
      const o = db.prepare('SELECT o.*, x.name exam_name FROM orders o JOIN exam_catalog x ON x.code = o.exam_code WHERE o.id = ? AND o.registration_id = ?').get(u.orderId, regId);
      if (!o || o.status === 'CANCELLED') throw notFound('Invoice line');
      const { pct, schemeId, waiver, requiresApproval } = resolveDiscount(u, user, o);
      const amt = Math.round(o.base_price * pct) / 100;
      db.prepare('UPDATE orders SET discount_pct = ?, discount_amount = ?, final_amount = ?, no_charge = ?, waiver_reason = ?, discount_scheme_id = ?, updated_at = ? WHERE id = ?')
        .run(pct, amt, o.base_price - amt, u.noCharge ? 1 : 0, waiver, schemeId, t, o.id);
      // The line's discount just changed (even if the new value needs no approval): any earlier PENDING request
      // for this order no longer reflects it and must not be decided against the order's new state.
      supersedePendingApprovals(o.id, user);
      if (requiresApproval) { createPendingApproval({ orderId: o.id, registrationId: regId, schemeId, pct, waiver }, user); pendingNotices.push({ id: o.id, exam: o.exam_name, pct, waiver }); }
      audit({ action: 'INVOICE_DISCOUNT_CHANGED', actor: user, patientId: o.patient_id, resource: reg.reg_no, details: { order: o.accession, from: o.discount_pct, to: pct, scheme: schemeId, waiver } });
    }
    for (const r of (Array.isArray(body.remove) ? body.remove : [])) {
      const o = db.prepare('SELECT * FROM orders WHERE id = ? AND registration_id = ?').get(r.orderId, regId);
      if (!o) throw notFound('Invoice line');
      if (!['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW'].includes(o.status)) throw conflict('LINE_STARTED', 'This scan has already started and cannot be removed');
      transition(o.id, { to: 'CANCELLED', note: requireText(r.reason, 'Reason for removing the scan', 300) }, user);
    }
    for (const a of (Array.isArray(body.add) ? body.add : [])) {
      const enc = db.prepare('SELECT encounter_id FROM registrations WHERE id = ?').get(regId).encounter_id;
      createOrder({ patientId: reg.patient_id, encounterId: enc, examCode: a.examCode, side: a.side, priority: a.priority || 'ROUTINE', clinicalIndication: optionalText(a.indication, 500) || 'Walk-in registration',
        noCharge: Boolean(a.noCharge), schemeId: a.schemeId, discountPct: a.discountPct, waiverReason: a.waiverReason, confirmDuplicate: true }, user, { skipRoleCheck: true, registrationId: regId });
    }
    audit({ action: 'INVOICE_UPDATED', actor: user, resource: reg.reg_no });
  });
  for (const n of pendingNotices) notify(usersWithRoles(['admin']), { orderId: n.id, kind: 'DISCOUNT_APPROVAL', text: `Discount of ${n.pct}% on ${n.exam} needs approval${n.waiver ? ': ' + n.waiver : ''}` });
  return getRegistration(regId, user);
}

export function cancelRegistration(regId, body, user) {
  requireRole(user, STAFF);
  const s = summarize(regId);
  const reason = requireText(body.reason, 'Reason', 300);
  if (s.status !== 'ACTIVE') throw conflict('REGISTRATION_CLOSED', 'Already cancelled');
  const lines = db.prepare("SELECT * FROM orders WHERE registration_id = ? AND status != 'CANCELLED'").all(regId);
  if (lines.some((l) => !['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'NO_SHOW'].includes(l.status))) throw conflict('LINE_STARTED', 'A scan has already started; cancel individual scans instead');
  if (s.paid_amount > 0) throw conflict('REFUND_FIRST', 'Payments were taken. Refund them before cancelling the registration.');
  tx(db, () => {
    for (const l of lines) transition(l.id, { to: 'CANCELLED', note: reason }, user);
    db.prepare("UPDATE registrations SET status = 'CANCELLED', updated_at = ? WHERE id = ?").run(now(), regId);
    audit({ action: 'REGISTRATION_CANCELLED', actor: user, resource: s.reg_no, details: { reason } });
  });
  return getRegistration(regId, user);
}

/* ---- Dashboard tiles + journey breakdown (agency dashboard / technician page) ---- */
const KEYS = Object.entries(EQUIPMENT_KEYS);
const STAGES = { arrived: ['ARRIVED'], prepared: ['PREPARED'], scan_in: ['IN_PROGRESS'], scan_out: ['COMPLETED'], report_finalization: ['REPORT_DRAFTED', 'REPORTED'], dispatched: ['DISPATCHED'], received: ['COLLECTED'] };
export function dashboardSummary(user, q = {}) {
  const rows = listOrders(user, { ...q, equipment: undefined }).filter((o) => o.status !== 'CANCELLED');
  const counts = { total_radiology_order: rows.length };
  for (const [key, modality] of KEYS) counts[`total_${key}`] = rows.filter((o) => o.modality === modality).length;
  const scoped = q.equipment && q.equipment !== 'all' ? rows.filter((o) => o.modality === EQUIPMENT_KEYS[q.equipment]) : rows;
  const breakdown = Object.fromEntries(Object.entries(STAGES).map(([k, st]) => [k, scoped.filter((o) => st.includes(o.status)).length]));
  return { ...counts, breakdown };
}
