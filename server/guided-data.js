// Guided samples: a small, curated data set with ONE case for every situation each role can meet, so the department can
// practise each action on a ready example. It replaces the bulk random traffic (demo-data.js) as the default seed.
// Every case is played through the real domain functions with a simulated clock, so the audit chain, notifications,
// prices and payments are genuine. All people and results are invented. The printed guide at the end of seeding (and
// GUIDE below) says which sample shows what.
import { db } from './db.js';
import { nowMs, setClock, uid } from './util.js';
import { seedPeople } from './demo-data.js';
import { CODE } from './roster.js';
import { getExam } from './catalog.js';
import * as O from './orders.js';
import * as R from './reports.js';
import * as C from './critical.js';
import * as M from './messages.js';
import * as K from './clinical.js';
import * as G from './registration.js';
import * as B from './billing.js';
import * as D from './discounts.js';

const MIN = 60_000; const H = 3_600_000;
const STAGES = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'ARRIVED', 'PREPARED', 'SAFETY', 'IN_PROGRESS', 'COMPLETED', 'DRAFT', 'REPORTED', 'DISPATCHED', 'COLLECTED'];
const localDate = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(0, 10);

const user = (alias) => { const r = db.prepare('SELECT * FROM users WHERE username = ?').get(CODE[alias]); return { id: r.id, username: r.username, fullName: r.full_name, role: r.role, ward: r.ward, designation: r.designation }; };

// The placeholder exams that shipped before the hospital's charge sheet was imported carry invented prices. Hide them so
// only the hospital tariff is offered, and give their hospital equivalents the body part, preparation note and search
// keywords the placeholders had (so report templates and exam suggestions keep working).
const EQUIVALENT = { 'MRI-LS': 'MRI-LUMBAR-SPINE', 'MRI-CS': 'MRI-CERVICAL-SPINE', 'MRI-KNEE': 'MRI-KNEE-SINGLE', 'XR-LS-AP-LAT': 'XR-LUMBAR-SPINE-AP-LAT',
  'XR-CS-AP-LAT': 'XR-CERVICAL-SPINE-AP-LAT', 'XR-CHEST': 'XR-CHEST-AP-PA', 'XR-KNEE': 'XR-SINGLE-KNEE-JOINT-AP-LAT', 'XR-SCOLIO-FULL': 'XR-WHOLE-SPINE-AP-LAT' };
function tidyCatalog() {
  for (const [seed, real] of Object.entries(EQUIVALENT)) {
    const s = getExam(seed); if (!s || !getExam(real)) continue;
    db.prepare('UPDATE exam_catalog SET body_part = ?, prep = ?, keywords = ?, est_minutes = ? WHERE code = ?').run(s.body_part, s.prep, s.keywords, s.est_minutes, real);
  }
  db.prepare("UPDATE exam_catalog SET active = 0, price_note = 'Placeholder from before the hospital charge sheet was imported; hidden' WHERE source = 'SEED'").run();
}

const FINDINGS = {
  MRI: ['Alignment is maintained. Vertebral body heights and marrow signal are normal. Mild disc desiccation at two levels with a small central bulge.', 'Mild degenerative disc change. No significant neural compromise.'],
  XR: ['Alignment is maintained. Vertebral heights are preserved. Mild disc space narrowing with marginal osteophytes.', 'Mild degenerative change.'],
  CT: ['Alignment is normal. No acute bony injury. Mild facet arthropathy.', 'No acute bony abnormality.'],
  USG: ['Deep veins are compressible with normal flow and phasicity.', 'No deep vein thrombosis.']
};
const CRITICAL = {
  cauda: ['Large central L4-5 disc extrusion causing cauda equina compression. The thecal sac is severely narrowed.', 'Cauda equina compression from a large L4-5 extrusion.', 'Large L4-5 disc extrusion with cauda equina compression'],
  cord: ['Severe C5-6 canal stenosis with cord compression and intramedullary T2 hyperintensity.', 'Severe C5-6 stenosis with cord compression.', 'Severe C5-6 stenosis with cord compression and cord signal change'],
  burst: ['Comminuted burst fracture of L1 with 40% retropulsion into the canal.', 'Unstable burst fracture of L1 with retropulsion.', 'Unstable L1 burst fracture with canal retropulsion'],
  pneumo: ['Right apical pneumothorax of about 30%. No mediastinal shift.', 'Right pneumothorax.', 'Right pneumothorax of about 30%']
};

export const GUIDE = []; // { n, who, sample, action }

export function seedGuided(password) {
  seedPeople(password);
  if (db.prepare('SELECT COUNT(*) c FROM orders').get().c) return { skipped: true };
  const NOW = Date.now();
  tidyCatalog();

  const rec = user('reception1'); const tech = user('tech_hardik'); const techXr = user('tech_aditi'); const techCt = user('tech_bijo');
  const rad = user('dr_preety'); const admin = user('admin');
  const mirant = user('dr_mirant'); const bharat = user('dr_bharat'); const fellow = user('dr_fellow'); const mo = user('dr_mo'); const nurseHdu = user('nurse_hdu');
  const techFor = (exam) => ({ MRI: tech, OPEN_MRI: tech, CT: techCt, XR: techXr }[exam.modality] || tech);

  /* ---- people ---- */
  let mrnSeq = db.prepare('SELECT COUNT(*) c FROM patients').get().c + 1001; let phoneSeq = 9811000000;
  const patient = (name, dob, sex, allergy = 'None recorded') => {
    const id = uid('pat'); const [first, ...rest] = name.split(' ');
    db.prepare(`INSERT INTO patients (id, mrn, name, dob, sex, phone, allergy, first_name, last_name, address, country, state, city, occupation, phone_verified, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(id, `SSH-${mrnSeq++}`, name, dob, sex, String(++phoneSeq), allergy, first, rest.join(' '), 'Satellite, Ahmedabad', 'India', 'Gujarat', 'Ahmedabad', 'Job', new Date(NOW - 30 * 24 * H).toISOString());
    return db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  };
  let opdSeq = 9000; let ipdSeq = 200;
  const encounter = (p, type, doctor, diagnosis, ward = null, room = null, bed = null) => {
    const id = uid('enc'); const ref = type === 'OPD' ? `OPD-2026-${++opdSeq}` : type === 'IPD' ? `IPD-2026-0${++ipdSeq}` : `OT-2026-0${++ipdSeq}`;
    const admitted = type === 'IPD' ? new Date(NOW - 2 * 24 * H).toISOString() : null;
    db.prepare('INSERT INTO encounters (id, patient_id, type, ref_no, ward, room, bed, diagnosis, doctor_id, admitted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, p.id, type, ref, ward, room, bed, diagnosis, doctor.id, admitted, admitted || new Date(NOW - 3 * H).toISOString());
    return id;
  };

  /* ---- playing a case: steps are queued with a simulated time, then ALL cases are run in one time-ordered pass,
     so the audit trail and notifications read in true chronological order. A step never lands in the future. ---- */
  const steps = []; let t = NOW;
  const begin = (minutesAgo) => { t = NOW - minutesAgo * MIN; };
  const tick = (m = 3) => { t = Math.min(t + m * MIN, NOW - 1000); };
  const at = (fn) => steps.push({ t, i: steps.length, fn });

  function advance(ctx, upto, o = {}) {
    const reach = (s) => STAGES.indexOf(upto) >= STAGES.indexOf(s);
    const exam = getExam(ctx.exam); const tk = techFor(exam); const p = ctx.p;
    const step = (m, fn) => { tick(m); at(() => fn(ctx.id)); };
    if (!reach('ACKNOWLEDGED')) return; step(3, (id) => O.transition(id, { to: 'ACKNOWLEDGED' }, rec));
    if (!reach('SCHEDULED')) return; step(3, (id) => O.transition(id, { to: 'SCHEDULED', scheduledAt: new Date(o.slotAt ?? nowMs() + 6 * MIN).toISOString() }, rec));
    if (o.noShow) { step(40, (id) => O.transition(id, { to: 'NO_SHOW', note: 'Patient did not attend' }, rec)); return; }
    if (!reach('ARRIVED')) return; step(6, (id) => O.transition(id, { to: 'ARRIVED', note: 'Identity verified: UHID and date of birth' }, rec));
    if (!reach('PREPARED')) return;
    step(3, (id) => {
      K.saveWords(id, { text: o.words || 'Pain for three weeks, worse on bending forward.' }, tk);
      K.saveMedicalConsent(id, { medicalDevices: o.implant ? ['MetalImplants'] : [], medicalHistory: [], allergiesHas: p.allergy !== 'None recorded', allergiesDetails: p.allergy !== 'None recorded' ? p.allergy : '', isPregnant: false, weight: 68, provisionalReport: '' }, tk);
      K.saveScanConsent(id, { contrast: 'PLAIN', fullName: p.name, date: localDate(nowMs()), agree: true, language: o.gujarati ? 'gu' : 'en' }, tk);
    });
    if (!reach('SAFETY')) return;
    if (exam.uses_contrast || exam.ionising || exam.mri) step(3, (id) => O.recordSafety(id, { pregnant: 'NA', contrastAllergy: 'NA', mriImplant: exam.mri ? (o.implant ? 'YES' : 'NO') : 'NA', egfr: null }, tk));
    if (o.implant) return; // left blocked for the radiologist to override
    if (!reach('IN_PROGRESS')) return; step(3, (id) => O.transition(id, { to: 'IN_PROGRESS' }, tk));
    if (!reach('COMPLETED')) return; step(exam.est_minutes > 15 ? 6 : 4, (id) => O.transition(id, { to: 'COMPLETED' }, tk));
    if (!reach('DRAFT')) return;
    const crit = o.critical ? CRITICAL[o.critical] : null; const f = FINDINGS[exam.modality] || FINDINGS.XR;
    step(5, (id) => R.saveDraft(id, crit ? { technique: 'Standard protocol.', findings: crit[0], impression: crit[1] } : { technique: 'Standard protocol.', findings: f[0], impression: f[1] }, rad));
    if (!reach('REPORTED')) return;
    step(4, (id) => { const draft = db.prepare("SELECT * FROM reports WHERE order_id = ? AND status = 'DRAFT'").get(id);
      R.signReport(draft.id, { expectedRevision: draft.revision, ...(crit ? { criticalDeclared: 'YES', criticalSummary: crit[2], receiverId: o.receiver.id } : {}) }, rad); });
    if (crit) {
      const open = (id) => db.prepare("SELECT id FROM critical_cases WHERE order_id = ? AND state IN ('OPEN','COMMUNICATED')").get(id).id;
      if (o.loop === 'communicated' || o.loop === 'acknowledged') step(6, (id) => C.communicate(open(id), { receiverName: o.receiver.fullName, channel: 'PHONE', readBack: true }, rad));
      if (o.loop === 'acknowledged') step(8, (id) => C.acknowledge(open(id), { actionPlan: 'Chest drain placed, repeat film ordered' }, o.receiver));
      return;
    }
    if (o.addendum) step(10, (id) => R.addAddendum(id, { reason: 'Level clarification', findings: 'On review of the lateral view, the described change is at L4-5.' }, rad));
    if (!reach('DISPATCHED')) return; step(10, (id) => O.transition(id, { to: 'DISPATCHED', note: 'Report handed over' }, rec));
    if (!reach('COLLECTED')) return; step(15, (id) => O.transition(id, { to: 'COLLECTED', note: 'Collected by patient' }, rec));
  }

  const notes = []; // resolved after the run, when accession and registration numbers exist
  const note = (who, sample, action) => notes.push({ who, sample, action });
  const accession = (id) => db.prepare('SELECT accession FROM orders WHERE id = ?').get(id).accession;

  /** One requested scan (OPD or IPD), played up to a stage. */
  function request({ ago, p, enc, by, exam, priority = 'ROUTINE', indication, upto, opts, who, action }) {
    begin(ago); const ctx = { exam, p };
    at(() => { ctx.id = O.createOrder({ patientId: p.id, encounterId: enc, examCode: exam, priority, clinicalIndication: indication, confirmDuplicate: true }, by).order.id; });
    advance(ctx, upto, opts);
    if (who) note(who, () => `${accession(ctx.id)} · ${p.name} · ${getExam(exam).name}`, action);
    return ctx;
  }

  /* ================= OPD and IPD requests: one at every step ================= */
  const pA = patient('Kiran Mehta', '1978-03-12', 'M'); const eA = encounter(pA, 'OPD', mirant, 'Chronic low back pain');
  request({ ago: 12, p: pA, enc: eA, by: mirant, exam: 'XR-LUMBAR-SPINE-AP-LAT', indication: 'Chronic low back pain, alignment check', upto: 'REQUESTED', who: 'Reception', action: 'New request: press Acknowledge' });

  const pB = patient('Sunita Kotak', '1959-07-30', 'F'); const eB = encounter(pB, 'IPD', mirant, 'Lumbar fusion, post-operative day 2', 'HDU', 'R1', 'B2');
  const cB = request({ ago: 35, p: pB, enc: eB, by: nurseHdu, exam: 'XR-CHEST-AP-PA', priority: 'URGENT', indication: 'Fever and cough after surgery, chest infection?', upto: 'ACKNOWLEDGED', who: 'Reception', action: 'Acknowledged: press Schedule and book a slot. Has a ward-radiology message thread (Conversation tab)' });
  begin(20); at(() => M.postMessage(cB.id, { body: 'Patient has a drain in place. Please send a porter with care.' }, nurseHdu));
  tick(6); at(() => M.postMessage(cB.id, { body: 'Noted. Booking the next free slot; we will call the ward when ready.' }, rec));

  const pC = patient('Jayesh Joshi', '1988-11-05', 'M'); const eC = encounter(pC, 'OPD', mirant, 'Cervical radiculopathy');
  request({ ago: 50, p: pC, enc: eC, by: mirant, exam: 'MRI-CERVICAL-SPINE', indication: 'Neck pain with arm numbness', upto: 'SCHEDULED', opts: { slotAt: NOW + 45 * MIN }, who: 'Reception', action: 'Scheduled: press Arrival and confirm UHID and date of birth (or mark No show)' });

  const pD = patient('Hetal Gandhi', '1970-01-19', 'F'); const eD = encounter(pD, 'IPD', mirant, 'Post-traumatic back pain', 'Ward A', '101', 'B1');
  request({ ago: 55, p: pD, enc: eD, by: fellow, exam: 'CT-CT-FULL-STUDY', priority: 'URGENT', indication: 'Fall from height, fracture? (ordered by the Fellow)', upto: 'ARRIVED', who: 'Technologist', action: 'Patient arrived: open the Patient consent tab and record consent (this marks Prepared)' });

  const pE = patient('Nisha Amin', '1992-06-23', 'F'); const eE = encounter(pE, 'OPD', bharat, 'Sciatica');
  request({ ago: 70, p: pE, enc: eE, by: bharat, exam: 'MRI-LUMBAR-SPINE', indication: 'Low back pain with radiculopathy, disc prolapse?', upto: 'PREPARED', opts: { gujarati: true }, who: 'Technologist', action: 'Consent done (in Gujarati): record Safety screening, then press Start' });

  const pF = patient('Rajesh Gandhi', '1955-09-14', 'M'); const eF = encounter(pF, 'IPD', bharat, 'Lumbar canal stenosis, old implant', 'Private', 'P2', 'B1');
  request({ ago: 80, p: pF, enc: eF, by: mo, exam: 'MRI-LUMBAR-SPINE', indication: 'Neurogenic claudication (ordered by the Medical Officer)', upto: 'SAFETY', opts: { implant: true }, who: 'Radiologist', action: 'Safety BLOCKED (MRI implant): open the study, type an override reason and record screening. Then the technologist can start' });

  const pG = patient('Mahesh Bhatt', '1966-12-02', 'M'); const eG = encounter(pG, 'OPD', mirant, 'Knee osteoarthritis');
  request({ ago: 60, p: pG, enc: eG, by: mirant, exam: 'XR-SINGLE-KNEE-JOINT-AP-LAT', indication: 'Knee pain on stairs', upto: 'IN_PROGRESS', who: 'Technologist', action: 'Scan in progress: press Complete' });

  const pH = patient('Varsha Rana', '1981-04-08', 'F'); const eH = encounter(pH, 'IPD', bharat, 'Road traffic accident', 'ICU', 'I1', 'B1');
  request({ ago: 40, p: pH, enc: eH, by: bharat, exam: 'CT-CT-SCREENING', priority: 'STAT', indication: 'Road traffic accident, neck pain, fracture?', upto: 'COMPLETED', who: 'Radiologist', action: 'STAT scan complete: open Reporting, write from a template and sign' });

  const pI = patient('Bhavna Patel', '1974-08-27', 'F'); const eI = encounter(pI, 'OPD', mirant, 'Knee injury');
  request({ ago: 180, p: pI, enc: eI, by: mirant, exam: 'MRI-KNEE-SINGLE', indication: 'Twisting injury, meniscal tear?', upto: 'DRAFT', who: 'Radiologist', action: 'Report drafted: press Continue report, then sign' });

  const pJ = patient('Manoj Shah', '1963-02-15', 'M'); const eJ = encounter(pJ, 'OPD', mirant, 'Neck pain');
  request({ ago: 300, p: pJ, enc: eJ, by: mirant, exam: 'XR-CERVICAL-SPINE-AP-LAT', indication: 'Neck pain, alignment', upto: 'REPORTED', who: 'Reception / Doctor', action: 'Report signed: the doctor (201) reads it and can print it; reception presses Dispatch' });

  const pK = patient('Komal Vyas', '1990-10-10', 'F'); const eK = encounter(pK, 'OPD', bharat, 'Scoliosis follow-up');
  request({ ago: 400, p: pK, enc: eK, by: bharat, exam: 'XR-WHOLE-SPINE-AP-LAT', indication: 'Scoliosis, Cobb angle', upto: 'DISPATCHED', who: 'Reception', action: 'Report dispatched: press Collected when the patient takes it' });

  const pL = patient('Dipak Solanki', '1958-05-21', 'M'); const eL = encounter(pL, 'OPD', mirant, 'Low back pain');
  request({ ago: 500, p: pL, enc: eL, by: mirant, exam: 'XR-LUMBAR-SPINE-AP-LAT', indication: 'Low back pain, follow-up film', upto: 'COLLECTED', opts: { addendum: true }, who: 'Anyone', action: 'Finished journey with an addendum: open it to see the full Journey, Timeline and the locked report' });

  const pM = patient('Anil Trivedi', '1985-01-30', 'M'); const eM = encounter(pM, 'OPD', bharat, 'Shoulder pain');
  request({ ago: 240, p: pM, enc: eM, by: bharat, exam: 'MRI-SHOULDER', indication: 'Shoulder pain, rotator cuff?', upto: 'SCHEDULED', opts: { noShow: true }, who: 'Reception', action: 'No show: press Reschedule (or cancel with a reason)' });

  const pN = patient('Pooja Desai', '1995-03-03', 'F'); const eN = encounter(pN, 'OPD', mirant, 'Back pain');
  const cN = request({ ago: 200, p: pN, enc: eN, by: mirant, exam: 'MRI-LUMBAR-SPINE-SCREENING', indication: 'Back pain screening', upto: 'REQUESTED', who: 'Anyone', action: 'CANCELLED by the requesting doctor with a reason: shows how a cancellation is recorded' });
  tick(15); at(() => O.transition(cN.id, { to: 'CANCELLED', note: 'Requested in error; patient already had this scan last week' }, mirant));

  const pO = patient('Vijay Thakkar', '1949-06-11', 'M'); const eO = encounter(pO, 'IPD', mirant, 'Post-operative leg swelling', 'Ward B', '201', 'B3');
  request({ ago: 26 * 60, p: pO, enc: eO, by: mirant, exam: 'USG-DOPPLER-LL', indication: 'Calf swelling on post-operative day 3, DVT?', upto: 'COMPLETED', who: 'Radiologist', action: 'OVERDUE report (red, top of every list): report it. Shows how a missed target looks' });

  /* ================= critical results: one in each state ================= */
  const pP = patient('Ritu Pandya', '1968-09-09', 'F'); const eP = encounter(pP, 'IPD', mirant, 'Acute leg weakness', 'HDU', 'R2', 'B1');
  request({ ago: 45, p: pP, enc: eP, by: mirant, exam: 'MRI-LUMBAR-SPINE', priority: 'STAT', indication: 'Bilateral leg weakness, urinary retention, cauda equina?', upto: 'REPORTED', opts: { critical: 'cauda', receiver: mirant, loop: 'open' }, who: 'Radiologist', action: 'CRITICAL, nobody told yet: open Critical findings, record who you phoned and tick read-back' });

  const pQ = patient('Heena Solanki', '1977-12-25', 'F'); const eQ = encounter(pQ, 'IPD', mirant, 'Cervical myelopathy', 'Ward A', '102', 'B2');
  request({ ago: 150, p: pQ, enc: eQ, by: fellow, exam: 'MRI-CERVICAL-SPINE', priority: 'URGENT', indication: 'Gait disturbance, hand clumsiness', upto: 'REPORTED', opts: { critical: 'cord', receiver: mirant, loop: 'communicated' }, who: 'Doctor (201)', action: 'CRITICAL, already phoned to you: open Critical findings, type the action plan and Acknowledge' });

  const pR = patient('Suresh Modi', '1961-04-17', 'M'); const eR = encounter(pR, 'IPD', bharat, 'Fall at home', 'Ward B', '202', 'B1');
  request({ ago: 260, p: pR, enc: eR, by: bharat, exam: 'CT-CT-FULL-STUDY', priority: 'URGENT', indication: 'Fall from stairs, back pain', upto: 'REPORTED', opts: { critical: 'burst', receiver: bharat, loop: 'open' }, who: 'Radiologist', action: 'CRITICAL, ESCALATED: nobody was told within 60 minutes. Shows what escalation looks like; the call can still be recorded' });

  const pS = patient('Falguni Bhatt', '1983-08-01', 'F'); const eS = encounter(pS, 'IPD', mirant, 'Post-operative breathlessness', 'HDU', 'R3', 'B1');
  request({ ago: 320, p: pS, enc: eS, by: nurseHdu, exam: 'XR-CHEST-AP-PA', priority: 'STAT', indication: 'Sudden breathlessness after line insertion', upto: 'REPORTED', opts: { critical: 'pneumo', receiver: mirant, loop: 'acknowledged' }, who: 'Anyone', action: 'CRITICAL, closed loop: phoned and acknowledged with an action plan. The finished example' });

  /* ================= walk-in registrations and billing: one of each money situation ================= */
  const cash = (amount) => { const out = {}; let left = amount; for (const d of [500, 200, 100, 50, 20, 10]) { const k = Math.floor(left / d); if (k) { out[d] = k; left -= k * d; } } const coins = {}; for (const d of [5, 2, 1]) { const k = Math.floor(left / d); if (k) { coins[d] = k; left -= k * d; } } return { notes: out, coins }; };
  const due = (w) => G.summarize(w.id).available_to_collect;
  const payCash = (w) => at(() => { const a = due(w); B.recordPayment(w.id, { method: 'CASH', amount: a, ...cash(a) }, rec); });
  function walkin({ ago, name, dob, sex, doctor, indication, items, who, action }) {
    begin(ago); const w = { p: patient(name, dob, sex) };
    at(() => { const reg = G.createRegistration({ patientId: w.p.id, referringDoctor: doctor, indication, items, confirmDuplicate: true }, rec); w.id = reg.registration.id; w.no = reg.registration.reg_no; w.lines = reg.lines.map((l) => l.id); });
    tick(4);
    if (who) note(who, () => `${w.no} · ${name}`, action);
    return w;
  }

  walkin({ ago: 25, name: 'Harsh Chauhan', dob: '1991-02-14', sex: 'M', doctor: 'Dr R. Bhatt', indication: 'Knee pain after a fall', items: [{ examCode: 'XR-SINGLE-KNEE-JOINT-AP-LAT', side: 'Left' }],
    who: 'Reception', action: 'UNPAID bill: press Pay now and take cash (count the notes, see the change)' });

  const w2 = walkin({ ago: 90, name: 'Meena Raval', dob: '1969-11-11', sex: 'F', doctor: 'Dr S. Naik', indication: 'Low back pain', items: [{ examCode: 'MRI-LUMBAR-SPINE' }, { examCode: 'XR-LUMBAR-SPINE-AP-LAT' }],
    who: 'Reception', action: 'PARTLY PAID bill (two scans): collect the balance' });
  at(() => B.recordPayment(w2.id, { method: 'CASH', amount: 3000, ...cash(3000) }, rec));

  const w3 = walkin({ ago: 420, name: 'Pratik Amin', dob: '1987-07-07', sex: 'M', doctor: 'Dr K. Trivedi', indication: 'Neck pain', items: [{ examCode: 'XR-CERVICAL-SPINE-AP-LAT' }],
    who: 'Reception', action: 'FULLY PAID in cash (with change returned) and the scan is finished: print the receipt and the invoice' });
  at(() => B.recordPayment(w3.id, { method: 'CASH', amount: due(w3), notes: { 500: 3 }, returnNotes: { 200: 2 } }, rec));
  const c3 = { exam: 'XR-CERVICAL-SPINE-AP-LAT', p: w3.p }; at(() => { c3.id = w3.lines[0]; }); advance(c3, 'COLLECTED');

  const w4 = walkin({ ago: 75, name: 'Rekha Sheth', dob: '1964-05-19', sex: 'F', doctor: 'Dr M. Iyer', indication: 'Shoulder pain', items: [{ examCode: 'MRI-SHOULDER' }],
    who: 'Reception', action: 'CHEQUE in process: press Process cheque and mark it cleared (or bounced)' });
  at(() => B.recordPayment(w4.id, { method: 'CHEQUE', amount: due(w4), chequeNumber: '482913', bank: 'HDFC Bank', accountHolder: 'Rekha Sheth', ifsc: 'HDFC0001234', chequeDate: localDate(nowMs()), depositDate: localDate(nowMs()) }, rec));

  const w5 = walkin({ ago: 110, name: 'Dhaval Kotak', dob: '1980-09-28', sex: 'M', doctor: 'Dr P. Sharma', indication: 'Headache, screening', items: [{ examCode: 'MRI-BRAIN-SCREENING' }],
    who: 'Reception', action: 'Paid ONLINE (UPI reference recorded): shows an online payment' });
  at(() => B.recordPayment(w5.id, { method: 'ONLINE', amount: due(w5), gateway: 'UPI', reference: 'UPI4471902263' }, rec));

  walkin({ ago: 30, name: 'Jyoti Parmar', dob: '1993-12-12', sex: 'F', doctor: 'Dr A. Kulkarni', indication: 'Low back pain', items: [{ examCode: 'MRI-LUMBAR-SPINE', schemeId: 'STAFF', waiverReason: 'Hospital staff member, employee card checked' }],
    who: 'Admin (901)', action: 'STAFF 100% discount waiting: open Discount schemes and Approve or Reject it' });

  const w7 = walkin({ ago: 130, name: 'Mukesh Pandya', dob: '1972-03-25', sex: 'M', doctor: 'Dr H. Vora', indication: 'Neck pain', items: [{ examCode: 'MRI-CERVICAL-SPINE', schemeId: 'NEAREST_RELATIVE', waiverReason: 'Son of a hospital staff member' }],
    who: 'Reception', action: 'NEAREST RELATIVE 25% discount (no approval needed), paid: shows a discounted bill' });
  payCash(w7);

  const w8 = walkin({ ago: 200, name: 'Asha Gandhi', dob: '1957-01-06', sex: 'F', doctor: 'Dr R. Bhatt', indication: 'Back pain', items: [{ examCode: 'MRI-LUMBAR-SPINE', discountPct: 60, waiverReason: 'Charity case requested by the referring doctor' }],
    who: 'Admin (901)', action: 'CUSTOM 60% discount was REJECTED: the bill went back to full price. Shows a rejection' });
  tick(20); at(() => D.decideDiscountApproval(db.prepare("SELECT id FROM discount_approvals WHERE order_id = ? AND status = 'PENDING'").get(w8.lines[0]).id, { decision: 'REJECTED', note: 'No charity approval on file' }, admin));

  const w9 = walkin({ ago: 160, name: 'Sanjay Rana', dob: '1976-10-31', sex: 'M', doctor: 'Dr S. Naik', indication: 'Low back pain', items: [{ examCode: 'MRI-LUMBAR-SPINE' }, { examCode: 'XR-LUMBAR-SPINE-AP-LAT' }],
    who: 'Admin (901)', action: 'REFUND requested: open the registration and Approve or Reject the refund' });
  payCash(w9);
  tick(30); at(() => B.requestRefund(w9.id, { amount: 1100, reason: 'Patient declined the X-ray after the MRI' }, rec));

  const w10 = walkin({ ago: 220, name: 'Dipti Joshi', dob: '1989-04-22', sex: 'F', doctor: 'Dr M. Iyer', indication: 'Knee pain', items: [{ examCode: 'MRI-KNEE-SINGLE' }],
    who: 'Reception', action: 'REFUND approved: open the registration and press Pay out' });
  payCash(w10);
  tick(20); at(() => { w10.refund = B.requestRefund(w10.id, { amount: 1000, reason: 'Second scan cancelled by the referring doctor' }, rec).refundId; });
  tick(25); at(() => B.decideRefund(w10.refund, { decision: 'APPROVED', note: 'Verified against the receipt' }, admin));

  /* ---- run everything in time order ---- */
  steps.sort((x, y) => x.t - y.t || x.i - y.i);
  for (const s of steps) { setClock(Math.round(s.t)); s.fn(); }
  for (const x of notes) GUIDE.push({ n: GUIDE.length + 1, who: x.who, sample: x.sample(), action: x.action });

  setClock(null);
  C.sweepCritical(); // the un-communicated critical result older than the window becomes ESCALATED
  db.prepare('UPDATE notifications SET read_at = created_at WHERE read_at IS NULL AND created_at < ?').run(new Date(NOW - 3 * H).toISOString());
  const c = (q) => db.prepare(q).get().c;
  return { skipped: false, samples: GUIDE.length, orders: c('SELECT COUNT(*) c FROM orders'), patients: c('SELECT COUNT(*) c FROM patients'), registrations: c('SELECT COUNT(*) c FROM registrations'), guide: GUIDE };
}
