// Demo traffic: two weeks of radiology requests from OPD, IPD, OT and walk-in registration, ending with a busy "live" window.
// Everything is played through the real domain functions in time order using a simulated clock, so the audit chain, notifications,
// prices, payments and reports are consistent. All people and results are invented. Deterministic apart from the current time.
import { db } from './db.js';
import { createUser } from './auth.js';
import { CODE, STAFF } from './roster.js';
import { nowMs, setClock, uid } from './util.js';
import * as O from './orders.js';
import * as R from './reports.js';
import * as C from './critical.js';
import * as M from './messages.js';
import * as K from './clinical.js';
import * as G from './registration.js';
import * as B from './billing.js';
import * as D from './discounts.js';

const DAY = 86400_000; const H = 3600_000; const MIN = 60_000;
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rand = rng(20260930);
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const between = (a, b) => a + rand() * (b - a);

const FIRST_M = ['Ramesh', 'Suresh', 'Mahesh', 'Kiran', 'Nilesh', 'Hitesh', 'Jayesh', 'Dipak', 'Rajesh', 'Bhavin', 'Mukesh', 'Harsh', 'Pratik', 'Vijay', 'Anil', 'Sanjay', 'Manoj', 'Dhaval'];
const FIRST_F = ['Kavita', 'Meena', 'Priya', 'Nisha', 'Hetal', 'Bhavna', 'Jyoti', 'Asha', 'Rekha', 'Sunita', 'Pooja', 'Komal', 'Dipti', 'Varsha', 'Ritu', 'Falguni', 'Heena', 'Anjali'];
const SURNAMES = ['Patel', 'Shah', 'Desai', 'Mehta', 'Joshi', 'Parmar', 'Trivedi', 'Solanki', 'Vyas', 'Chauhan', 'Thakkar', 'Modi', 'Bhatt', 'Pandya', 'Rana', 'Amin', 'Kotak', 'Gandhi', 'Raval', 'Sheth'];
const ALLERGIES = ['Iodinated contrast (rash)', 'Penicillin', 'Sulfa drugs', 'NSAIDs (gastritis)', 'Latex'];
const WARDS = { HDU: { rooms: ['R1', 'R2', 'R3'], nurse: 'nurse_hdu' }, ICU: { rooms: ['I1', 'I2'], nurse: 'nurse_icu' }, 'Ward A': { rooms: ['101', '102', '103', '104'], nurse: 'nurse_wardA' }, 'Ward B': { rooms: ['201', '202', '203'], nurse: 'nurse_wardB' }, Private: { rooms: ['P1', 'P2', 'P3'], nurse: 'nurse_private' } };
const DIAG = ['Lumbar canal stenosis, post-operative day 2', 'L4-5 disc prolapse with foot drop', 'Cervical myelopathy, post-operative day 1', 'Post-traumatic L1 burst fracture', 'Spondylodiscitis L3-4', 'Scoliosis correction, post-operative day 3',
  'Osteoporotic vertebral fracture', 'Cauda equina syndrome', 'Lumbar fusion, post-operative day 4', 'Cervical disc prolapse C5-6', 'Post-operative wound review', 'Spinal metastasis, pain control'];
const OPD_DIAG = ['Chronic low back pain', 'Cervical radiculopathy', 'Knee osteoarthritis', 'Sciatica', 'Suspected disc prolapse', 'Osteoporosis screening', 'Scoliosis follow-up', 'Post-operative review', 'Neck pain with arm numbness'];
const EXT_DOCTORS = ['Dr R. Bhatt', 'Dr S. Naik', 'Dr K. Trivedi', 'Dr M. Iyer', 'Dr P. Sharma', 'Dr A. Kulkarni', 'Dr H. Vora'];
const BANKS = [['HDFC Bank', 'HDFC0001234'], ['State Bank of India', 'SBIN0004321'], ['ICICI Bank', 'ICIC0000123'], ['Bank of Baroda', 'BARB0AHMEDA']];

// Exam mixes and clinical questions
const IPD_EXAMS = [['MRI-LS', 5], ['MRI-CS', 3], ['CT-LS', 3], ['CT-CS', 2], ['XR-LS-AP-LAT', 4], ['XR-CS-AP-LAT', 2], ['XR-CHEST', 4], ['USG-DOPPLER-LL', 2], ['CT-BRAIN', 1], ['MRI-WS', 1], ['XR-SCOLIO-FULL', 1]];
const OPD_EXAMS = [['XR-LS-AP-LAT', 5], ['MRI-LS', 5], ['MRI-CS', 3], ['XR-KNEE', 3], ['MRI-KNEE', 2], ['DEXA', 3], ['CT-LS', 1], ['XR-SCOLIO-FULL', 1], ['OMRI-LS', 1], ['XR-CS-AP-LAT', 2], ['USG-ABD', 1]];
const WALKIN_EXAMS = [['XR-LS-AP-LAT', 5], ['XR-KNEE', 4], ['MRI-LS', 4], ['MRI-CS', 2], ['MRI-KNEE', 2], ['DEXA', 3], ['CT-LS', 1], ['OMRI-LS', 1], ['XR-CHEST', 2], ['USG-ABD', 2], ['CT-BRAIN', 1]];
const INDICATION = {
  'MRI-LS': ['Low back pain with radiculopathy, ?disc prolapse', 'Left leg weakness and numbness for 3 weeks', 'Post-operative pain, ?recurrent disc', 'Neurogenic claudication, ?canal stenosis', 'Bilateral leg weakness, urinary retention, ?cauda equina'],
  'MRI-CS': ['Neck pain with arm numbness', 'Cervical myelopathy work-up, gait disturbance', 'Post-operative review, C5-6 fusion'],
  'MRI-KNEE': ['Knee pain and locking, ?meniscal tear', 'Twisting injury, ?ACL'], 'MRI-WS': ['Back pain with fever, ?spondylodiscitis', 'Known primary, ?spinal metastasis'],
  'CT-LS': ['Fall from height, ?fracture', 'Implant position check after fusion', 'Pre-operative planning'], 'CT-CS': ['Road traffic accident, neck pain, ?fracture', 'Post-operative fusion assessment'], 'CT-BRAIN': ['Head injury, drowsy', 'Sudden headache and vomiting'],
  'XR-LS-AP-LAT': ['Chronic low back pain, alignment', 'Post-operative check', 'Pre-operative standing films', 'Sciatica, ?spondylolisthesis'], 'XR-CS-AP-LAT': ['Neck pain, alignment', 'Post-operative check'], 'XR-KNEE': ['Knee pain, osteoarthritis', 'Fall on knee, ?fracture'],
  'XR-CHEST': ['Fever and cough post-operatively, ?chest infection', 'Pre-operative chest film', 'Breathlessness on day 3, ?effusion', 'Line position check'], 'XR-SCOLIO-FULL': ['Scoliosis, Cobb angle measurement', 'Post-correction standing film'],
  'USG-DOPPLER-LL': ['Calf swelling on post-operative day 3, ?DVT', 'Leg pain after surgery, rule out DVT'], 'USG-ABD': ['Abdominal pain after surgery', 'Lower abdominal discomfort'], DEXA: ['Osteoporosis screening', 'Long-term steroids, fracture risk', 'Post-menopausal bone density'], 'OMRI-LS': ['Claustrophobic patient, low back pain and sciatica']
};
const WORDS = ['Pain in the lower back going down my left leg since three weeks. Worse when I bend forward.', 'I cannot feel my toes properly and I trip while walking.', 'Neck pain that spreads to my right arm, with tingling in two fingers.', 'Knee hurts on stairs and gives way sometimes.',
  'I had surgery last week. Now there is a new pain and some swelling near the wound.', 'Pain is worse at night. I cannot sleep on my back.', 'I fell from a ladder yesterday and my back hurts when I move.', 'Sharp pain when I cough or sneeze, radiating to the buttock.'];

// Report content. Negative statements must not contain the critical phrases the system watches for.
const TECH = { XR: 'Standard views obtained.', MRI: 'Sagittal T1, T2, STIR and axial T2 sequences.', OPEN_MRI: 'Sagittal T1, T2 and axial T2 sequences on open MRI.', CT: 'Helical acquisition with multiplanar reformats.', USG: 'Real-time grey-scale and colour Doppler examination.', DEXA: 'DEXA of lumbar spine and proximal femur.' };
const NORMAL = {
  'MRI-LS': ['Lumbar lordosis maintained. Vertebral body heights and marrow signal are normal. Conus ends at L1. Mild L4-5 and L5-S1 disc desiccation. Facet joints are unremarkable.', 'Mild degenerative changes L4-5 and L5-S1 with no significant neural compromise.'],
  'MRI-CS': ['Cervical alignment preserved. Vertebral marrow signal normal. Spinal cord is normal in calibre and signal. Mild C5-6 disc bulge without canal compromise.', 'Mild C5-6 disc bulge. No significant stenosis.'],
  'MRI-KNEE': ['Menisci and cruciate ligaments are intact. Mild joint effusion. Articular cartilage shows early patellofemoral change.', 'Mild effusion and early patellofemoral chondral change.'], 'MRI-WS': ['Whole spine screening shows normal alignment and marrow signal. Mild multilevel disc desiccation.', 'No marrow-replacing lesion.'],
  'CT-LS': ['Alignment normal. No acute bony injury. Mild L4-5 facet arthropathy. Instrumentation, where present, is well positioned.', 'No acute bony abnormality.'], 'CT-CS': ['Alignment normal. No acute fracture. Mild uncovertebral osteophytes at C5-6.', 'No acute bony abnormality.'], 'CT-BRAIN': ['No acute infarct. Ventricles and sulci are normal for age. Midline structures are central.', 'No acute intracranial abnormality.'],
  'XR-LS-AP-LAT': ['Lumbar lordosis reduced. Mild disc space narrowing L4-5 and L5-S1 with marginal osteophytes. No listhesis. Vertebral heights maintained.', 'Degenerative changes of the lumbar spine.'], 'XR-CS-AP-LAT': ['Loss of cervical lordosis. Mild C5-6 disc space narrowing. No listhesis.', 'Mild cervical spondylosis.'],
  'XR-KNEE': ['Medial joint space narrowing with marginal osteophytes. No fracture. Small effusion.', 'Mild to moderate medial compartment osteoarthritis.'], 'XR-CHEST': ['Lungs are clear. Heart size normal. Costophrenic angles are sharp.', 'Normal chest radiograph.'],
  'XR-SCOLIO-FULL': ['Dextroscoliosis of the thoracolumbar spine, Cobb angle 24 degrees. Coronal balance maintained.', 'Mild thoracolumbar scoliosis, Cobb 24 degrees.'], 'USG-DOPPLER-LL': ['Deep veins of the lower limb are compressible with normal flow and phasicity.', 'No deep vein thrombosis.'],
  'USG-ABD': ['Liver is normal in size and echotexture. Gallbladder, pancreas and kidneys are unremarkable.', 'Normal abdominal ultrasound.'], DEXA: ['Lumbar spine T-score -2.1, femoral neck T-score -1.8.', 'Osteopenia, T-score -2.1 at lumbar spine.'], 'OMRI-LS': ['Lumbar alignment normal. Mild L4-5 disc desiccation with a small central bulge.', 'Small L4-5 disc bulge.']
};
const CRITICAL = {
  'MRI-LS': ['Large central L4-5 disc extrusion causing cauda equina compression. Thecal sac is severely narrowed.', 'Cauda equina compression from a large L4-5 extrusion.', 'Large L4-5 disc extrusion with cauda equina compression'],
  'MRI-CS': ['Severe C5-6 canal stenosis with cord compression and intramedullary T2 hyperintensity.', 'Severe C5-6 stenosis with cord compression.', 'Severe C5-6 stenosis with cord compression and cord signal change'],
  'MRI-WS': ['L3-4 spondylodiscitis with an anterior epidural abscess compressing the thecal sac.', 'L3-4 spondylodiscitis with epidural abscess.', 'L3-4 discitis with epidural abscess'],
  'CT-LS': ['Comminuted burst fracture of L1 with 40% retropulsion into the canal.', 'Unstable burst fracture of L1 with retropulsion.', 'Unstable L1 burst fracture with canal retropulsion'], 'CT-CS': ['Unstable burst fracture of C6 with retropulsed fragments.', 'Unstable burst fracture of C6.', 'Unstable C6 burst fracture'],
  'CT-BRAIN': ['Acute subdural haematoma over the right convexity with 6 mm midline shift.', 'Acute subdural haematoma with midline shift.', 'Acute right subdural haematoma with midline shift'], 'XR-CHEST': ['Right apical pneumothorax of about 30%. No mediastinal shift.', 'Right pneumothorax.', 'Right pneumothorax of about 30%']
};
const NEEDS_SAFETY = (e) => e.uses_contrast || e.ionising || e.mri;

/* ---------- people ---------- */
let phoneSeq = 9800000200;
export function seedPeople(password) {
  for (const s of Object.values(STAFF)) if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(s.code)) createUser({ username: s.code, password, fullName: s.name, role: s.role, designation: s.designation, ward: s.ward || null, phone: String(++phoneSeq) });
}
const userRow = (u) => { const r = db.prepare('SELECT * FROM users WHERE username = ?').get(CODE[u]); return { id: r.id, username: r.username, fullName: r.full_name, role: r.role, ward: r.ward, designation: r.designation }; };
const U = {}; const getU = (u) => (U[u] ||= userRow(u));

function makePatient(sexHint) {
  const sex = sexHint || (chance(0.5) ? 'M' : 'F'); const first = pick(sex === 'M' ? FIRST_M : FIRST_F); const last = pick(SURNAMES); const age = Math.round(between(19, 84));
  const dob = new Date(nowMs() - (age * 365.25 + between(0, 300)) * DAY).toISOString().slice(0, 10); const id = uid('pat');
  let n = db.prepare('SELECT COUNT(*) c FROM patients').get().c + 1001; let mrn = `SSH-${n}`; while (db.prepare('SELECT 1 FROM patients WHERE mrn = ?').get(mrn)) mrn = `SSH-${++n}`;
  db.prepare(`INSERT INTO patients (id, mrn, name, dob, sex, phone, allergy, first_name, last_name, address, country, state, city, occupation, phone_verified, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`)
    .run(id, mrn, `${first} ${last}`, dob, sex, `9${Math.floor(between(700000000, 899999999))}`, chance(0.14) ? pick(ALLERGIES) : 'None recorded', first, last, `${Math.floor(between(1, 200))} ${pick(['Ring Road', 'SG Highway', 'CG Road', 'Navrangpura', 'Satellite', 'Maninagar', 'Bopal'])}, Ahmedabad`, 'India', 'Gujarat', 'Ahmedabad', pick(['Job', 'Business', 'Retired', 'House Wife', 'Student', 'Worker']), new Date(nowMs() - between(1, 400) * DAY).toISOString());
  return db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
}
function makeEncounter(patient, type, ref, ward, room, bed, doctor, diagnosis, admittedAt) {
  const id = uid('enc');
  db.prepare('INSERT INTO encounters (id, patient_id, type, ref_no, ward, room, bed, diagnosis, doctor_id, admitted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, patient.id, type, ref, ward, room, bed, diagnosis, doctor.id, admittedAt || null, admittedAt || new Date(nowMs()).toISOString());
  return db.prepare('SELECT * FROM encounters WHERE id = ?').get(id);
}
const weighted = (list) => { const total = list.reduce((s, [, w]) => s + w, 0); let r = rand() * total; for (const [v, w] of list) { r -= w; if (r <= 0) return v; } return list[0][0]; };
const CLIN = ['dr_mirant', 'dr_bharat', 'dr_ajay', 'dr_ravi'];
// IPD orders are often placed by a Fellow or Medical Officer covering the ward, not only by the admitting consultant.
const IPD_ORDERING_JUNIORS = ['dr_fellow', 'dr_mo'];
const catalog = () => Object.fromEntries(db.prepare('SELECT * FROM exam_catalog').all().map((e) => [e.code, e]));

/* ---------- the play list ---------- */
const steps = [];
const at = (t, fn, label) => steps.push({ t, fn, label });
const stageIndex = ['REQUESTED', 'ACKNOWLEDGED', 'SCHEDULED', 'ARRIVED', 'PREPARED', 'IN_PROGRESS', 'COMPLETED', 'DRAFT', 'REPORTED', 'DISPATCHED', 'COLLECTED'];
const receptionist = () => getU(chance(0.6) ? 'reception1' : 'reception2');
// Room and technologist pairing as in the SSIE module: MRI 1 Hardik, MRI 2 Mayur, CT Bijo, X-Ray Aditi and Tirth; Yashkumar covers DEXA and ultrasound.
const technologist = (exam) => getU({ MRI: chance(0.55) ? 'tech_hardik' : 'tech_mayur', OPEN_MRI: 'tech_hardik', CT: 'tech_bijo', XR: chance(0.5) ? 'tech_aditi' : 'tech_tirth', DEXA: 'tech_yashkumar', USG: 'tech_yashkumar' }[exam?.modality] || 'tech_hardik');
const radiologist = () => getU('dr_preety'); // Dr. Preety Ajay Krishnan heads the department and reports everything
const localDate = (ms) => new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(0, 10);
const noop = () => {};

/**
 * Plays one scan through the department. `getId` returns the order id once it exists. `o.stop` ends the story at a stage
 * (used for the backlog, and implicitly for anything whose next step would be in the future).
 */
function lifecycle(t0, getId, o) {
  let t = t0; const reach = (s) => stageIndex.indexOf(o.stop || 'COLLECTED') >= stageIndex.indexOf(s);
  const exam = o.exam; const P = o.priority; const ward = !!o.ipd;
  const gap = { ack: P === 'STAT' ? [2, 6] : P === 'URGENT' ? [5, 15] : [10, 45], sched: P === 'STAT' ? [3, 8] : [5, 25], slot: P === 'STAT' ? [10, 25] : P === 'URGENT' ? [30, 100] : ward ? [60, 300] : o.walkin ? [10, 40] : [90, 1500] };
  const orderFn = (fn) => () => { const id = getId(); if (id) fn(id); };
  // acknowledge
  t += between(...gap.ack) * MIN; if (!reach('ACKNOWLEDGED')) return; const rec = receptionist();
  at(t, orderFn((id) => O.transition(id, { to: 'ACKNOWLEDGED' }, rec)), 'ack');
  // schedule (walk-ins are booked for now)
  t += between(...gap.sched) * MIN; if (!reach('SCHEDULED')) return; let slot = t + between(...gap.slot) * MIN;
  at(t, orderFn((id) => O.transition(id, { to: 'SCHEDULED', scheduledAt: new Date(slot).toISOString() }, rec)), 'schedule');
  // occasional no-show, then rebooked or dropped
  if (!ward && !o.walkin && P === 'ROUTINE' && chance(0.07)) {
    at(slot + 40 * MIN, orderFn((id) => O.transition(id, { to: 'NO_SHOW', note: 'Patient did not attend' }, rec)), 'noshow');
    if (chance(0.3)) { at(slot + 3 * H, orderFn((id) => O.transition(id, { to: 'CANCELLED', note: 'Patient did not return, request closed' }, rec)), 'drop'); return; }
    const t2 = slot + 3 * H + between(10, 40) * MIN; const slot2 = t2 + between(20, 26) * H; at(t2, orderFn((id) => O.transition(id, { to: 'SCHEDULED', scheduledAt: new Date(slot2).toISOString(), note: 'Rebooked' }, rec)), 'rebook'); slot = slot2;
  }
  // arrival, consent, screening
  t = slot + between(-8, 12) * MIN; if (!reach('ARRIVED')) return;
  at(t, orderFn((id) => O.transition(id, { to: 'ARRIVED', note: ward ? 'Brought from ward' : 'Identity verified: UHID and date of birth' }, rec)), 'arrive');
  const tech = technologist(exam); const iso = () => localDate(nowMs());
  t += between(3, 12) * MIN; if (!reach('PREPARED')) return;
  const patientName = o.patient.name;
  if (chance(0.65)) at(t - 2 * MIN, orderFn((id) => K.saveWords(id, { text: pick(WORDS) }, tech)), 'words');
  if (chance(0.6)) at(t - MIN, orderFn((id) => K.saveMedicalConsent(id, { medicalDevices: chance(0.12) ? ['MetalImplants'] : [], medicalHistory: chance(0.3) ? [pick(['HistoryDM', 'Ht', 'PastIllness'])] : [], allergiesHas: o.patient.allergy !== 'None recorded', allergiesDetails: o.patient.allergy !== 'None recorded' ? o.patient.allergy : '',
    isPregnant: false, weight: Math.round(between(48, 96)), provisionalReport: '' }, tech)), 'medconsent');
  at(t, orderFn((id) => {
    const body = { contrast: exam.uses_contrast ? 'CONTRAST' : 'PLAIN', fullName: patientName, date: iso(), agree: true, language: chance(0.4) ? 'gu' : 'en' };
    if (exam.uses_contrast && exam.modality === 'CT') { body.routes = ['IV']; body.contrastTypes = ['Iodine Contrasting']; }
    if (exam.uses_contrast && ['MRI', 'OPEN_MRI'].includes(exam.modality)) { body.mlContrast = 15; body.egfr = 82; body.serumCreatinine = 0.9; }
    K.saveScanConsent(id, body, tech);
  }), 'consent');
  // safety screening (a few are blocked and cleared by the radiologist)
  if (NEEDS_SAFETY(exam)) {
    const blocked = exam.mri && chance(0.06);
    at(t + MIN, orderFn((id) => O.recordSafety(id, { pregnant: 'NA', contrastAllergy: exam.uses_contrast ? 'NO' : 'NA', mriImplant: exam.mri ? (blocked ? 'YES' : 'NO') : 'NA', egfr: exam.uses_contrast ? 84 : null }, tech)), 'safety');
    if (blocked) at(t + 4 * MIN, orderFn((id) => O.recordSafety(id, { pregnant: 'NA', contrastAllergy: 'NA', mriImplant: 'YES', overrideReason: 'MRI-conditional spinal implant, 1.5 T scan conditions verified' }, radiologist())), 'override');
    t += 6 * MIN;
  } else t += 2 * MIN;
  // scan
  t += between(2, 8) * MIN; if (!reach('IN_PROGRESS')) return;
  at(t, orderFn((id) => O.transition(id, { to: 'IN_PROGRESS' }, tech)), 'scan-in');
  t += (exam.est_minutes + between(2, 8)) * MIN; if (!reach('COMPLETED')) return;
  at(t, orderFn((id) => O.transition(id, { to: 'COMPLETED' }, tech)), 'scan-out');
  // report
  const rd = radiologist(); const slaH = { STAT: 1, URGENT: 4, ROUTINE: 24 }[P]; const late = P === 'ROUTINE' && chance(0.1);
  t += (P === 'STAT' ? between(8, 30) : P === 'URGENT' ? between(30, 140) : late ? between(1600, 2200) : between(40, 800)) * MIN * (slaH ? 1 : 1);
  if (!reach('DRAFT')) return;
  const crit = o.critical && CRITICAL[exam.code]; const n = NORMAL[exam.code] || ['No abnormality detected.', 'Normal study.'];
  const body = crit ? { technique: TECH[exam.modality], findings: crit[0], impression: crit[1] } : { technique: TECH[exam.modality], findings: n[0], impression: n[1], recommendation: chance(0.3) ? 'Clinical correlation and follow-up as needed.' : '' };
  at(t, orderFn((id) => R.saveDraft(id, body, rd)), 'draft');
  t += between(6, P === 'STAT' ? 12 : 40) * MIN; if (!reach('REPORTED')) return;
  at(t, orderFn((id) => {
    const rep = db.prepare("SELECT * FROM reports WHERE order_id = ? AND status = 'DRAFT'").get(id);
    const extra = crit ? { criticalDeclared: 'YES', criticalSummary: crit[2], receiverId: o.receiver?.id } : {};
    try { R.signReport(rep.id, { expectedRevision: rep.revision, ...extra }, rd); }
    catch (e) { if (e.code === 'CRITICAL_DECLARATION_REQUIRED') R.signReport(rep.id, { expectedRevision: rep.revision, criticalDeclared: 'NO', criticalNoReason: 'Negative statement, no critical finding' }, rd); else throw e; }
  }), 'sign');
  // critical result loop
  if (crit) {
    const told = t + between(6, o.leaveCritical === 'escalate' ? 200 : 25) * MIN;
    if (o.leaveCritical !== 'open' && o.leaveCritical !== 'escalate') {
      at(told, orderFn((id) => { const c = db.prepare("SELECT id FROM critical_cases WHERE order_id = ? AND state = 'OPEN'").get(id); if (c) C.communicate(c.id, { receiverName: o.receiver?.fullName || 'Ward staff', channel: pick(['PHONE', 'PHONE', 'IN_PERSON']), readBack: true }, rd); }), 'communicate');
      if (o.leaveCritical !== 'communicated') {
        const plans = ['Shifting to OT for urgent decompression', 'Neurosurgical review and steroids started', 'Immobilise, spine consult in progress', 'Antibiotics started, surgery planned', 'Chest drain being placed'];
        at(told + between(8, 45) * MIN, orderFn((id) => { const c = db.prepare("SELECT id FROM critical_cases WHERE order_id = ? AND state = 'COMMUNICATED'").get(id); if (c) C.acknowledge(c.id, { actionPlan: pick(plans) }, o.receiver); }), 'acknowledge');
      }
    }
  }
  if (chance(0.03) && !crit && reach('REPORTED')) at(t + between(60, 240) * MIN, orderFn((id) => R.addAddendum(id, { reason: 'Clarification', findings: 'Level clarified after review of the sagittal sequence: the described finding is at L4-5.' }, rd)), 'addendum');
  // hand-over of the report (OPD and walk-in patients collect it)
  if (!ward && !crit) {
    t += between(30, 300) * MIN; if (!reach('DISPATCHED')) return; at(t, orderFn((id) => O.transition(id, { to: 'DISPATCHED', note: 'Report handed over' }, rec)), 'dispatch');
    t += between(20, 1300) * MIN; if (!reach('COLLECTED') || chance(0.12)) return; at(t, orderFn((id) => O.transition(id, { to: 'COLLECTED', note: 'Collected by patient' }, rec)), 'collect');
  }
}

/* ---------- traffic generators ---------- */
const state = { ipd: [], patients: [], counters: { ipd: 0, opd: 0, walkin: 0, ot: 0 }, refundsPlanned: 0, chequesPlanned: 0, discountApprovalsPlanned: 0 };
function examFor(list, patient, used) {
  for (let i = 0; i < 8; i++) {
    const code = weighted(list); const e = CAT[code]; const key = `${patient.id}|${code}`;
    if (used.has(key)) continue; if (e.uses_contrast && /contrast/i.test(patient.allergy)) continue;
    used.add(key); return e;
  }
  return null;
}
const used = new Set(); let CAT = {};

function ipdOrder(t0, live) {
  const enc = pick(state.ipd); const patient = enc.patient; const exam = examFor(IPD_EXAMS, patient, used); if (!exam) return;
  const wardCfg = WARDS[enc.ward]; const byNurse = chance(0.3); const byJunior = !byNurse && chance(0.35);
  const requester = byNurse ? getU(wardCfg.nurse) : byJunior ? getU(pick(IPD_ORDERING_JUNIORS)) : enc.doctor;
  const P = chance(0.12) ? 'STAT' : chance(0.3) ? 'URGENT' : 'ROUTINE'; const ind = pick(INDICATION[exam.code] || ['Clinical review']);
  const crit = ['MRI-LS', 'MRI-CS', 'CT-LS', 'CT-CS', 'XR-CHEST', 'MRI-WS', 'CT-BRAIN'].includes(exam.code) && (P === 'STAT' ? chance(0.4) : chance(0.06));
  let id = null; state.counters.ipd++;
  at(t0, () => { try { id = O.createOrder({ patientId: patient.id, encounterId: enc.row.id, examCode: exam.code, priority: P, clinicalIndication: ind, confirmDuplicate: true }, requester).order.id; } catch (e) { /* skipped */ } }, 'ipd-request');
  const mode = crit && live ? pick(['open', 'communicated', 'escalate', 'ack']) : null;
  lifecycle(t0, () => id, { exam, priority: P, ipd: true, patient, critical: crit, receiver: enc.doctor, leaveCritical: mode === 'ack' ? undefined : mode });
  if (chance(0.16)) { // ward and radiology talk about the request
    at(t0 + between(4, 20) * MIN, () => id && M.postMessage(id, { body: pick(['Patient is in pain and needs this urgently. Can you slot it earlier?', 'Please confirm the patient is fasting for the study.', 'Family is asking for an estimated time.', 'Patient has a drain, please send porter with care.']) }, requester), 'msg-ward');
    at(t0 + between(22, 50) * MIN, () => id && M.postMessage(id, { body: pick(['Booked for the next free slot. We will call the ward when ready.', 'Yes, please keep nil by mouth for 4 hours.', 'Transport requested, expect us in 30 minutes.']) }, receptionist()), 'msg-rad');
  }
}
function opdOrder(t0) {
  const patient = state.patients.length > 25 && chance(0.4) ? pick(state.patients) : makePatient(); if (!state.patients.includes(patient)) state.patients.push(patient);
  const exam = examFor(OPD_EXAMS, patient, used); if (!exam) return; const doc = getU(pick(CLIN)); state.counters.opd++;
  const enc = makeEncounter(patient, 'OPD', `OPD-2026-${String(8000 + state.counters.opd).padStart(4, '0')}`, null, null, null, doc, pick(OPD_DIAG), new Date(t0).toISOString().replace(/.*/, '') || null);
  db.prepare('UPDATE encounters SET admitted_at = NULL WHERE id = ?').run(enc.id);
  const P = chance(0.12) ? 'URGENT' : 'ROUTINE'; let id = null;
  at(t0, () => { try { id = O.createOrder({ patientId: patient.id, encounterId: enc.id, examCode: exam.code, priority: P, clinicalIndication: pick(INDICATION[exam.code] || ['Clinical review']), confirmDuplicate: true }, doc).order.id; } catch (e) { /* skipped */ } }, 'opd-request');
  lifecycle(t0, () => id, { exam, priority: P, patient, critical: ['MRI-LS', 'MRI-CS'].includes(exam.code) && chance(0.03), receiver: doc, leaveCritical: undefined });
}
function otOrder(t0) {
  const patient = makePatient(); const doc = getU(pick(['dr_mirant', 'dr_ajay'])); const pre = chance(0.7); const exam = CAT[pre ? weighted([['MRI-LS', 3], ['CT-LS', 3], ['MRI-CS', 2], ['XR-SCOLIO-FULL', 2]]) : weighted([['XR-LS-AP-LAT', 4], ['CT-LS', 2], ['XR-CS-AP-LAT', 2]])]; state.counters.ot++;
  const enc = makeEncounter(patient, 'OT', `OT-2026-${String(300 + state.counters.ot).padStart(4, '0')}`, 'OT-1', null, null, doc, pre ? 'Pre-operative imaging, fusion planned' : 'Post-operative implant check', null); let id = null;
  at(t0, () => { try { id = O.createOrder({ patientId: patient.id, encounterId: enc.id, examCode: exam.code, priority: 'URGENT', clinicalIndication: pre ? 'Pre-operative planning' : 'Implant position check after surgery', confirmDuplicate: true }, doc).order.id; } catch (e) { /* skipped */ } }, 'ot-request');
  lifecycle(t0, () => id, { exam, priority: 'URGENT', patient, receiver: doc, critical: false });
}
const cashBreakdown = (amount) => {
  const notes = {}; let left = amount; for (const d of [500, 200, 100, 50, 20, 10]) { const n = Math.floor(left / d); if (n) { notes[d] = n; left -= n * d; } }
  const coins = {}; for (const d of [5, 2, 1]) { const n = Math.floor(left / d); if (n) { coins[d] = n; left -= n * d; } } return { notes, coins };
};
function walkin(t0, i, live, force = {}) {
  const patient = state.patients.length > 25 && chance(0.25) ? pick(state.patients) : makePatient(); if (!state.patients.includes(patient)) state.patients.push(patient);
  const rec = receptionist(); const nItems = chance(0.35) ? 2 : chance(0.08) ? 3 : 1; const items = []; state.counters.walkin++;
  // Discounts: mostly the real hospital schemes (DISTANT_RELATIVE 10%, NEAREST_RELATIVE 25%, STAFF 100% -- STAFF
  // needs admin approval, so this is what exercises that flow), plus a little of the custom-% and custom-no-charge
  // fallback (a one-off reception discretion, no scheme attached).
  for (let k = 0; k < nItems; k++) { const e = examFor(WALKIN_EXAMS, patient, used); if (!e) continue; const roll = rand(); const twoSides = ['XR-KNEE', 'MRI-KNEE'].includes(e.code);
    items.push({ examCode: e.code, side: twoSides ? pick(['Left', 'Right']) : undefined,
      ...(roll < 0.05 ? { schemeId: 'DISTANT_RELATIVE', waiverReason: 'Distant relative of the patient' }
        : roll < 0.09 ? { schemeId: 'NEAREST_RELATIVE', waiverReason: 'Immediate family member' }
        : roll < 0.13 ? { schemeId: 'STAFF', waiverReason: 'Hospital staff family member' }
        : roll < 0.17 ? { discountPct: 10 }
        : roll < 0.19 ? { noCharge: true, waiverReason: 'Charity case, approved by the reception lead' }
        : {}), _exam: e }); }
  if (!items.length) return; let reg = null; const ids = [];
  at(t0, () => { try { reg = G.createRegistration({ patientId: patient.id, referringDoctor: chance(0.7) ? pick(EXT_DOCTORS) : undefined, indication: pick(INDICATION[items[0].examCode] || ['Walk-in registration']), confirmDuplicate: true,
    items: items.map(({ _exam, ...rest }) => rest) }, rec); reg.lines.forEach((l) => ids.push(l.id)); } catch (e) { /* skipped */ } }, 'walkin-register');
  items.forEach((it, k) => lifecycle(t0 + k * 7 * MIN, () => ids[k], { exam: it._exam, priority: 'ROUTINE', walkin: true, patient, critical: false }));
  // A STAFF-scheme discount needs admin sign-off: decide a couple of them (one approved, one rejected) so the demo
  // shows both outcomes; the rest are left PENDING, same as the refund demo leaves some undecided for the admin persona.
  items.forEach((it, k) => { if (it.schemeId === 'STAFF' && state.discountApprovalsPlanned < 2) {
    const decision = ['APPROVED', 'REJECTED'][state.discountApprovalsPlanned++];
    at(t0 + between(90, 300) * MIN, () => { if (!ids[k]) return; try {
      const a = db.prepare("SELECT id FROM discount_approvals WHERE order_id = ? AND status = 'PENDING'").get(ids[k]);
      if (a) D.decideDiscountApproval(a.id, { decision, note: decision === 'APPROVED' ? 'Verified against the HR roster' : 'Could not confirm the staff relation' }, getU('admin'));
    } catch (e) { /* skipped */ } }, 'discount-decision');
  } });
  // payments
  const roll = force.cheque ? 0.85 : force.refund ? 0.3 : rand(); const tp = t0 + between(4, 15) * MIN; const pay = (body, t) => at(t, () => { if (!reg) return; try { B.recordPayment(reg.registration.id, body, rec); } catch (e) { /* skipped */ } }, 'payment');
  const due = () => B.recordPayment && G.summarize(reg.registration.id);
  if (roll < 0.62) at(tp, () => { if (!reg) return; const s = G.summarize(reg.registration.id); if (s.final_total <= 0) return; if (Number.isInteger(s.available_to_collect)) B.recordPayment(reg.registration.id, { method: 'CASH', amount: s.available_to_collect, ...cashBreakdown(s.available_to_collect) }, rec); else B.recordPayment(reg.registration.id, { method: 'ONLINE', amount: s.available_to_collect, gateway: 'UPI', reference: `UPI${Math.floor(between(1e9, 9e9))}` }, rec); }, 'pay-full');
  else if (roll < 0.78) { at(tp, () => { if (!reg) return; const s = G.summarize(reg.registration.id); const half = Math.floor(s.available_to_collect / 2 / 100) * 100; if (half >= 100) B.recordPayment(reg.registration.id, { method: 'CASH', amount: half, ...cashBreakdown(half) }, rec); }, 'pay-part');
    if (!live || chance(0.5)) at(tp + between(3, 30) * H, () => { if (!reg) return; const s = G.summarize(reg.registration.id); if (s.available_to_collect > 0 && Number.isInteger(s.available_to_collect)) B.recordPayment(reg.registration.id, { method: 'CASH', amount: s.available_to_collect, ...cashBreakdown(s.available_to_collect) }, rec); }, 'pay-balance'); }
  else if (roll < 0.9) { const [bank, ifsc] = pick(BANKS); at(tp, () => { if (!reg) return; const s = G.summarize(reg.registration.id); if (s.available_to_collect <= 0) return; B.recordPayment(reg.registration.id, { method: 'CHEQUE', amount: s.available_to_collect, chequeNumber: String(Math.floor(between(100000, 999999))), bank, accountHolder: patient.name, ifsc, chequeDate: localDate(nowMs()), depositDate: localDate(nowMs()) }, rec); }, 'pay-cheque');
    if ((!live && !force.cheque) || (live && !force.cheque && chance(0.4))) at(tp + between(20, 60) * H, () => { if (!reg) return; const p = db.prepare("SELECT id FROM payments WHERE registration_id = ? AND status = 'IN_PROCESS'").get(reg.registration.id); if (p) B.processCheque(p.id, { decision: 'CLEARED' }, rec); }, 'cheque-clear'); }
  else if (roll < 0.97) at(tp, () => { if (!reg) return; const s = G.summarize(reg.registration.id); if (s.available_to_collect > 0) B.recordPayment(reg.registration.id, { method: 'ONLINE', amount: s.available_to_collect, gateway: pick(['UPI', 'Card', 'NetBanking']), reference: `PAY${Math.floor(between(1e9, 9e9))}` }, rec); }, 'pay-online');
  // a few refunds at each stage of the approval flow
  if (force.refund || (roll < 0.62 && state.refundsPlanned < 2 && chance(0.12))) {
    const stage = force.refund || ['PAID', 'PAID'][state.refundsPlanned++]; const tr = tp + (force.refund ? between(30, 45) : between(60, 240)) * MIN; let rid = null;
    at(tr, () => { if (!reg) return; const s = G.summarize(reg.registration.id); if (s.refundable > 0) rid = B.requestRefund(reg.registration.id, { amount: Math.min(s.refundable, Math.max(100, Math.floor(s.refundable / 3 / 50) * 50)), reason: pick(['Patient declined the second scan', 'Scan not needed after doctor review', 'Charged twice at the counter']) }, rec).refundId; }, 'refund-request');
    if (stage !== 'PENDING') at(tr + between(30, 120) * MIN, () => rid && B.decideRefund(rid, { decision: 'APPROVED', note: 'Verified against the receipt' }, getU('admin')), 'refund-approve');
    if (stage === 'PAID') at(tr + between(150, 300) * MIN, () => rid && B.payRefund(rid, { via: 'CASH' }, rec), 'refund-pay');
  }
}

function liveCritical(t0, mode, code) {
  const enc = pick(state.ipd); const exam = CAT[code]; let id = null; state.counters.ipd++;
  at(t0, () => { try { id = O.createOrder({ patientId: enc.patient.id, encounterId: enc.row.id, examCode: code, priority: 'STAT', clinicalIndication: pick(INDICATION[code]), confirmDuplicate: true }, enc.doctor).order.id; } catch (e) { /* skipped */ } }, 'live-critical');
  lifecycle(t0, () => id, { exam, priority: 'STAT', ipd: true, patient: enc.patient, critical: true, receiver: enc.doctor, leaveCritical: mode });
}

export function seedTraffic(password) {
  seedPeople(password);
  if (db.prepare('SELECT COUNT(*) c FROM orders').get().c) return { skipped: true };
  const NOW = Date.now(); CAT = catalog(); const midnight = (d) => { const x = new Date(NOW - d * DAY); x.setHours(0, 0, 0, 0); return x.getTime(); };
  setClock(NOW - 15 * DAY); // people and admissions are created in the past
  // Active IPD admissions across wards
  const admissions = [['HDU', 4], ['ICU', 2], ['Ward A', 4], ['Ward B', 3], ['Private', 3]];
  for (const [ward, n] of admissions) for (let i = 0; i < n; i++) {
    const patient = makePatient(); const doc = getU(pick(CLIN)); const cfg = WARDS[ward]; const daysIn = Math.floor(between(1, 10));
    const row = makeEncounter(patient, 'IPD', `IPD-2026-${String(140 + state.ipd.length).padStart(4, '0')}`, ward, cfg.rooms[i % cfg.rooms.length], `B${(i % 6) + 1}`, doc, pick(DIAG), new Date(NOW - daysIn * DAY).toISOString());
    state.ipd.push({ row, patient, doctor: doc, ward });
  }
  for (let i = 0; i < 20; i++) state.patients.push(makePatient());
  setClock(null);
  // Plan: 13 past days (working hours, quieter at weekends) and a busy live window
  const plan = (windowStart, windowEnd, ipdN, opdN, walkN, otN, live) => {
    const span = windowEnd - windowStart; const when = () => windowStart + rand() * span;
    for (let i = 0; i < ipdN; i++) ipdOrder(windowStart + between(0, 1) * span * 1.0, live);
    for (let i = 0; i < opdN; i++) opdOrder(when());
    for (let i = 0; i < walkN; i++) walkin(when(), i, live);
    for (let i = 0; i < otN; i++) otOrder(when());
  };
  for (let d = 13; d >= 1; d--) {
    const dow = new Date(midnight(d)).getDay(); const f = dow === 0 ? 0.25 : dow === 6 ? 0.5 : 1; const n = (x) => Math.round(x * f + (rand() < 0.5 ? 0 : 1));
    plan(midnight(d) + 8 * H, midnight(d) + 17.5 * H, n(8), n(8), n(5), chance(0.5) ? 1 : 0, false);
  }
  plan(NOW - 9 * H, NOW - 8 * MIN, 6, 5, 3, 1, true);
  // Rush over the last two and a half hours, so patients are arriving, in the scanner and waiting for reports right now
  plan(NOW - 150 * MIN, NOW - 4 * MIN, 4, 3, 2, 0, true);
  // Deliberate live situations for the demo
  liveCritical(NOW - 130 * MIN, 'open', 'MRI-LS');          // told nobody yet
  liveCritical(NOW - 6 * H, 'escalate', 'CT-LS');            // not communicated in time -> escalated when read
  liveCritical(NOW - 190 * MIN, 'communicated', 'CT-CS');    // phoned, waiting for the ward to acknowledge
  walkin(NOW - 200 * MIN, 0, true, { refund: 'APPROVED' });
  walkin(NOW - 120 * MIN, 0, true, { refund: 'PENDING' });
  walkin(NOW - 105 * MIN, 0, true, { refund: 'PENDING' });
  walkin(NOW - 90 * MIN, 0, true, { cheque: true });
  walkin(NOW - 60 * MIN, 0, true, { cheque: true });
  // Backlog from yesterday that is now overdue (finished scans still waiting for a report)
  for (let i = 0; i < 3; i++) { const t0 = midnight(1) + (9 + i) * H; const enc = pick(state.ipd); const exam = examFor(IPD_EXAMS, enc.patient, used); if (!exam) continue; let id = null;
    at(t0, () => { try { id = O.createOrder({ patientId: enc.patient.id, encounterId: enc.row.id, examCode: exam.code, priority: 'ROUTINE', clinicalIndication: pick(INDICATION[exam.code] || ['Clinical review']), confirmDuplicate: true }, enc.doctor).order.id; } catch (e) { /* skipped */ } }, 'backlog');
    lifecycle(t0, () => id, { exam, priority: 'ROUTINE', ipd: true, patient: enc.patient, stop: i === 2 ? 'DRAFT' : 'COMPLETED', receiver: enc.doctor }); }
  // Play everything in time order, dropping steps that lie in the future
  steps.sort((a, b) => a.t - b.t); let ran = 0; let failed = 0; const errors = {};
  for (const s of steps) { if (s.t > NOW - MIN) continue; setClock(Math.round(s.t)); try { s.fn(); ran++; } catch (e) { failed++; const k = `${s.label}: ${e.code || e.message}`; errors[k] = (errors[k] || 0) + 1; } }
  setClock(null);
  // Older notifications are already read; only the last few hours stay unread
  db.prepare('UPDATE notifications SET read_at = created_at WHERE read_at IS NULL AND created_at < ?').run(new Date(NOW - 4 * H).toISOString());
  const c = (q) => db.prepare(q).get().c;
  return { skipped: false, steps: ran, failedSteps: failed, errors, orders: c('SELECT COUNT(*) c FROM orders'), patients: c('SELECT COUNT(*) c FROM patients'), registrations: c('SELECT COUNT(*) c FROM registrations'), payments: c('SELECT COUNT(*) c FROM payments'), refunds: c('SELECT COUNT(*) c FROM refunds'), reports: c("SELECT COUNT(*) c FROM reports WHERE status = 'FINAL'"), critical: c('SELECT COUNT(*) c FROM critical_cases') };
}
