import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, likeEsc, notFound, now, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { listOrders } from './orders.js';

export function searchPatients(q, user) {
  const like = `%${likeEsc(String(q || '').trim())}%`;
  return db.prepare("SELECT * FROM patients WHERE name LIKE ? ESCAPE '\\' OR mrn LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' ORDER BY name LIMIT 30").all(like, like, like);
}

export function createPatient(body, user) {
  requireRole(user, ['reception', 'admin']);
  const mrn = requireText(body.mrn, 'MRN', 40);
  if (db.prepare('SELECT 1 FROM patients WHERE mrn = ?').get(mrn)) throw conflict('MRN_EXISTS', 'A patient with this MRN already exists');
  const dob = requireText(body.dob, 'DOB', 10);
  if (Number.isNaN(Date.parse(dob))) throw bad('DOB_INVALID', 'DOB must be a date');
  const id = uid('pat');
  const name = requireText(body.name, 'Name', 200); const sex = oneOf(body.sex, ['M', 'F', 'O'], 'sex');
  tx(db, () => {
    db.prepare('INSERT INTO patients (id, mrn, name, dob, sex, phone, allergy, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, mrn, name, dob, sex, optionalText(body.phone, 30), optionalText(body.allergy, 200) || 'None recorded', now());
    audit({ action: 'PATIENT_CREATED', actor: user, patientId: id, resource: mrn });
  });
  return db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
}

export function createEncounter(patientId, body, user) {
  requireRole(user, ['reception', 'admin', 'nurse']);
  if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(patientId)) throw notFound('Patient');
  const type = oneOf(body.type, ['OPD', 'IPD', 'OT', 'EXTERNAL'], 'type');
  const ward = type === 'IPD' ? requireText(body.ward, 'Ward', 60) : optionalText(body.ward, 60) || null;
  if (body.doctorId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'clinician'").get(body.doctorId)) throw bad('BAD_DOCTOR', 'doctorId must be a clinician');
  const id = uid('enc');
  const refNo = requireText(body.refNo, 'Reference no', 40);
  tx(db, () => {
    db.prepare('INSERT INTO encounters (id, patient_id, type, ref_no, ward, room, bed, diagnosis, doctor_id, admitted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, patientId, type, refNo, ward, optionalText(body.room, 20) || null, optionalText(body.bed, 20) || null, optionalText(body.diagnosis, 300) || null, body.doctorId || null, type === 'IPD' ? now() : null, now());
    audit({ action: 'ENCOUNTER_CREATED', actor: user, patientId, resource: id, details: { type, ward } });
  });
  return db.prepare('SELECT * FROM encounters WHERE id = ?').get(id);
}

export function patientOverview(id, user) {
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  if (!patient) throw notFound('Patient');
  audit({ action: 'PATIENT_VIEWED', actor: user, patientId: id });
  const encounters = db.prepare('SELECT e.*, u.full_name doctor_name FROM encounters e LEFT JOIN users u ON u.id = e.doctor_id WHERE patient_id = ? ORDER BY created_at DESC').all(id);
  return { patient, encounters, orders: listOrders(user, { patientId: id }) };
}

export function listClinicians() {
  return db.prepare("SELECT id, full_name, ward FROM users WHERE role IN ('clinician') AND active = 1 ORDER BY full_name").all();
}
export const listStaff = () => db.prepare("SELECT id, full_name, role FROM users WHERE role IN ('radiologist','technologist') AND active = 1 ORDER BY full_name").all();
