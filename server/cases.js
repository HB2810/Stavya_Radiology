// Reception opens a case with modality CATEGORIES; technician selects catalog SERVICES per category.
import { db } from './db.js';
import { audit } from './audit.js';
import { RADIOLOGY_STAFF, requireRole } from './auth.js';
import { bad, conflict, likeEsc, notFound, now, nowMs, oneOf, optionalText, requireText, tx, uid } from './util.js';
import { createOrder } from './orders.js';
import { listExams } from './catalog.js';
import { getChannel, listMachines, nextToken, estimateEta, paymentStatusForChannel, pickMachine, resolveChannelForEncounter, getTrafficOptions } from './traffic.js';
import { notify, usersWithRoles } from './notifications.js';

export const CATEGORIES = ['MRI', 'CT', 'XR', 'DEXA', 'USG', 'OPEN_MRI'];
// WAITING → AT_ASSISTANT → AWAITING_PROTOCOL → PROTOCOLLED → IN_QUEUE → IN_PROGRESS → DONE
const MOD_STATUS = ['WAITING', 'AT_ASSISTANT', 'AWAITING_PROTOCOL', 'PROTOCOLLED', 'IN_QUEUE', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const ASSIST_OPEN = ['WAITING', 'AT_ASSISTANT'];
const TECH_ADD_OK = ['PROTOCOLLED', 'IN_QUEUE', 'IN_PROGRESS'];

const caseNo = () => {
  const y = new Date(nowMs()).getFullYear();
  const n = db.prepare("SELECT COUNT(*) c FROM rad_cases WHERE case_no LIKE ?").get(`CASE-${y}-%`).c + 1;
  return `CASE-${y}-${String(n).padStart(5, '0')}`;
};

function hydrate(caseId) {
  const c = db.prepare(`SELECT c.*, p.name patient_name, p.mrn, p.opd_id, p.ipd_id, p.dob, p.sex, p.allergy, p.phone,
    e.type encounter_type, e.ward, e.bed, e.ref_no encounter_ref, ch.name channel_name, u.full_name created_by_name
    FROM rad_cases c
    JOIN patients p ON p.id = c.patient_id
    JOIN encounters e ON e.id = c.encounter_id
    LEFT JOIN channels ch ON ch.code = c.channel_code
    LEFT JOIN users u ON u.id = c.created_by
    WHERE c.id = ?`).get(caseId);
  if (!c) return null;
  const modalities = db.prepare(`SELECT cm.*, m.code machine_code, m.name machine_name,
    (SELECT COUNT(*) FROM orders o WHERE o.case_modality_id = cm.id AND o.status != 'CANCELLED') service_count,
    (SELECT COALESCE(SUM(o.final_amount),0) FROM orders o WHERE o.case_modality_id = cm.id AND o.status != 'CANCELLED') amount
    FROM rad_case_modalities cm
    LEFT JOIN machines m ON m.id = cm.machine_id
    WHERE cm.case_id = ? ORDER BY cm.created_at`).all(caseId);
  const orders = db.prepare(`SELECT o.id, o.accession, o.exam_code, o.status, o.priority, o.final_amount, o.base_price, o.discount_amount,
    o.payment_status, o.token_no, o.case_modality_id, x.name exam_name, x.modality
    FROM orders o JOIN exam_catalog x ON x.code = o.exam_code
    WHERE o.case_id = ? AND o.status != 'CANCELLED' ORDER BY o.created_at`).all(caseId);
  const amount = orders.reduce((s, o) => s + Number(o.final_amount || 0), 0);
  const awaiting = modalities.filter((m) => m.status === 'AWAITING_PROTOCOL').length;
  const assistQueue = modalities.filter((m) => ASSIST_OPEN.includes(m.status)).length;
  const modalitiesOut = modalities.map((m) => {
    let checklist = {};
    try { checklist = JSON.parse(m.assist_checklist_json || '{}'); } catch { /* ignore */ }
    return { ...m, assist_checklist: checklist };
  });
  return { ...c, modalities: modalitiesOut, orders, amount, awaiting_protocol: awaiting, assist_queue: assistQueue, is_new: Date.now() - Date.parse(c.created_at) < 5 * 60_000 };
}

/** Reception: patient + channel + clinical note + one or more CATEGORIES (not services). */
export function createCase(body, user) {
  requireRole(user, ['reception', 'admin', 'radiologist']);
  const patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(String(body.patientId || ''));
  if (!patient) throw notFound('Patient');
  let enc = db.prepare('SELECT * FROM encounters WHERE id = ? AND patient_id = ?').get(String(body.encounterId || ''), patient.id);
  const channel = resolveChannelForEncounter(enc?.type || 'EXTERNAL', body.channelCode);
  if (!channel) throw bad('UNKNOWN_CHANNEL', 'Unknown channel');

  const modalities = [...new Set((Array.isArray(body.modalities) ? body.modalities : []).map((m) => String(m).toUpperCase()))];
  if (!modalities.length) throw bad('MODALITIES_REQUIRED', 'Select at least one category (CT, MRI, X-ray…)');
  for (const m of modalities) if (!CATEGORIES.includes(m)) throw bad('MODALITY_INVALID', `Unknown category ${m}`);

  const indication = requireText(body.clinicalIndication, 'Clinical indication', 2000);
  if (indication.length < 5) throw bad('INDICATION_TOO_SHORT', 'Please give a meaningful clinical indication');
  const priority = oneOf(body.priority || channel.default_priority || 'ROUTINE', ['ROUTINE', 'URGENT', 'STAT'], 'priority');
  if (priority === 'STAT' && user.role === 'reception' && !channel.allow_stat_reception) {
    throw bad('STAT_FORBIDDEN', 'STAT is not allowed on this channel for reception');
  }

  // Open encounter if reception did not pass one (same rules as channel entry).
  const id = uid('case'); const t = now();
  const pay = paymentStatusForChannel(channel, { paymentRef: body.paymentRef });

  const result = tx(db, () => {
    if (!enc) {
      const encId = uid('enc');
      const visitId = optionalText(body.visitId || body.opdId || body.ipdId || patient.opd_id || patient.ipd_id, 40);
      const ref = visitId
        || (channel.encounter_type === 'IPD' && patient.ipd_id)
        || (channel.encounter_type === 'OPD' && patient.opd_id)
        || `${channel.encounter_type}-${Date.now().toString(36).toUpperCase()}`;
      const ward = channel.encounter_type === 'IPD' ? requireText(body.ward, 'Ward', 60) : optionalText(body.ward, 60) || null;
      db.prepare('INSERT INTO encounters (id, patient_id, type, ref_no, ward, room, bed, diagnosis, doctor_id, admitted_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(encId, patient.id, channel.encounter_type, ref, ward, optionalText(body.room, 20) || null, optionalText(body.bed, 20) || null,
          optionalText(body.diagnosis, 300) || null, body.doctorId || null, channel.encounter_type === 'IPD' ? t : null, t);
      enc = db.prepare('SELECT * FROM encounters WHERE id = ?').get(encId);
      // Keep OPD/IPD IDs on the patient record when reception enters them with the case.
      if (channel.encounter_type === 'OPD' && visitId && !patient.opd_id) {
        db.prepare('UPDATE patients SET opd_id = ? WHERE id = ? AND (opd_id IS NULL OR opd_id = \'\')').run(visitId, patient.id);
      }
      if (channel.encounter_type === 'IPD' && visitId && !patient.ipd_id) {
        db.prepare('UPDATE patients SET ipd_id = ? WHERE id = ? AND (ipd_id IS NULL OR ipd_id = \'\')').run(visitId, patient.id);
      }
    } else if (enc.status !== 'ACTIVE') throw conflict('ENCOUNTER_CLOSED', 'This encounter is not active');

    const no = caseNo();
    db.prepare(`INSERT INTO rad_cases (id, case_no, patient_id, encounter_id, channel_code, clinical_indication, priority, payment_place, payment_status, payment_ref, report_handover, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?,?)`)
      .run(id, no, patient.id, enc.id, channel.code, indication, priority, channel.payment_place, pay.paymentStatus, pay.paymentRef, channel.report_handover, user.id, t, t);

    const traffic = getTrafficOptions();
    for (const modality of modalities) {
      const machine = pickMachine(modality);
      const token = traffic.tokenEnabled ? nextToken(machine, channel).token : null;
      const eta = (traffic.tokenEnabled || traffic.autoTrafficEnabled) && machine
        ? estimateEta(machine.id, 20, channel.code)
        : null;
      db.prepare(`INSERT INTO rad_case_modalities (id, case_id, modality, token_no, machine_id, eta_at, status, created_at)
        VALUES (?,?,?,?,?,?,'WAITING',?)`)
        .run(uid('cmod'), id, modality, token, machine?.id || null, eta, t);
    }
    audit({ action: 'CASE_CREATED', actor: user, patientId: patient.id, resource: no, details: { channel: channel.code, modalities, priority } });
    return no;
  });

  notify(usersWithRoles(['assistant', 'technologist', 'radiologist']), {
    kind: 'NEW_ORDER',
    text: `${user.fullName} opened ${result}: ${modalities.join('+')} for ${patient.name} — assistant: call from waiting`
  });
  return hydrate(id);
}

export function listCases(user, q = {}) {
  requireRole(user, [...RADIOLOGY_STAFF, 'admin', 'auditor']);
  const where = ['1=1']; const args = [];
  if (q.open === '1') where.push("c.status = 'OPEN'");
  if (q.awaiting === '1') where.push(`EXISTS (SELECT 1 FROM rad_case_modalities cm WHERE cm.case_id = c.id AND cm.status = 'AWAITING_PROTOCOL')`);
  if (q.assist === '1') where.push(`EXISTS (SELECT 1 FROM rad_case_modalities cm WHERE cm.case_id = c.id AND cm.status IN ('WAITING','AT_ASSISTANT'))`);
  if (q.channel) { where.push('c.channel_code = ?'); args.push(q.channel); }
  if (q.modality) { where.push('EXISTS (SELECT 1 FROM rad_case_modalities cm WHERE cm.case_id = c.id AND cm.modality = ?)'); args.push(q.modality); }
  if (q.q) {
    const like = `%${likeEsc(q.q)}%`;
    where.push(`(p.name LIKE ? ESCAPE '\\' OR p.mrn LIKE ? ESCAPE '\\' OR IFNULL(p.opd_id,'') LIKE ? ESCAPE '\\' OR IFNULL(p.ipd_id,'') LIKE ? ESCAPE '\\' OR c.case_no LIKE ? ESCAPE '\\')`);
    args.push(like, like, like, like, like);
  }
  where.push(`date(c.created_at) >= date('now', '-2 day')`);
  const ids = db.prepare(`SELECT c.id FROM rad_cases c JOIN patients p ON p.id = c.patient_id
    WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 300`).all(...args);
  return ids.map(({ id }) => hydrate(id));
}

export function getCase(id, user) {
  requireRole(user, [...RADIOLOGY_STAFF, 'admin', 'auditor', 'clinician', 'nurse']);
  const c = hydrate(id);
  if (!c) throw notFound('Case');
  return c;
}

/** Catalog services available inside one category (for the protocol screen). */
export function servicesForModality(modality) {
  const m = String(modality || '').toUpperCase();
  if (!CATEGORIES.includes(m)) throw bad('MODALITY_INVALID', 'Unknown category');
  return listExams().filter((e) => e.modality === m && e.price != null);
}

/**
 * Technician: pick concrete exam codes (sub-modalities) for a case modality.
 * First pass requires AWAITING_PROTOCOL (after assistant transfer).
 * Mid-diagnostic: body.add === true while PROTOCOLLED / IN_QUEUE / IN_PROGRESS.
 */
export function protocolModality(caseModalityId, body, user) {
  requireRole(user, ['technologist', 'radiologist', 'admin']);
  const cm = db.prepare('SELECT * FROM rad_case_modalities WHERE id = ?').get(caseModalityId);
  if (!cm) throw notFound('Case modality');
  if (cm.status === 'CANCELLED') throw conflict('CANCELLED', 'This category was cancelled');
  const adding = body.add === true || body.replace === true;
  if (cm.status === 'AWAITING_PROTOCOL') {
    // first protocol after assistant transfer
  } else if (adding && TECH_ADD_OK.includes(cm.status)) {
    // mid-diagnostic add / replace extras
  } else if (ASSIST_OPEN.includes(cm.status)) {
    throw conflict('ASSISTANT_FIRST', 'Assistant must collect consent and transfer the patient to the modality first');
  } else if (cm.status !== 'AWAITING_PROTOCOL' && !adding) {
    throw conflict('ALREADY_PROTOCOLLED', 'Services already selected. Send add:true to add more mid-diagnostic.');
  } else {
    throw conflict('INVALID_STATUS', `Cannot protocol from ${cm.status}`);
  }
  const c = db.prepare('SELECT * FROM rad_cases WHERE id = ?').get(cm.case_id);
  const items = Array.isArray(body.services) ? body.services : [];
  if (!items.length) throw bad('SERVICES_REQUIRED', 'Select at least one service in this category');
  if (items.length > 12) throw bad('TOO_MANY', 'At most 12 services per category');

  const created = [];
  tx(db, () => {
    for (const it of items) {
      const examCode = typeof it === 'string' ? it : it.examCode;
      const exam = db.prepare('SELECT * FROM exam_catalog WHERE code = ? AND active = 1').get(String(examCode || ''));
      if (!exam) throw bad('UNKNOWN_EXAM', `Unknown service ${examCode}`);
      if (exam.modality !== cm.modality) throw bad('MODALITY_MISMATCH', `${exam.name} is ${exam.modality}, not ${cm.modality}`);
      if (exam.price == null) throw bad('EXAM_PRICE_NOT_SET', `${exam.name} has no price set`);

      const r = createOrder({
        patientId: c.patient_id,
        encounterId: c.encounter_id,
        examCode: exam.code,
        priority: it.priority || c.priority,
        clinicalIndication: optionalText(it.indication, 500) || c.clinical_indication,
        side: it.side,
        channelCode: c.channel_code,
        confirmDuplicate: body.confirmDuplicate === true || it.confirmDuplicate === true,
        paymentRef: c.payment_ref
      }, user, { skipRoleCheck: true });

      db.prepare('UPDATE orders SET case_id = ?, case_modality_id = ?, payment_status = CASE WHEN ? != \'UNPAID\' THEN ? ELSE payment_status END, payment_place = COALESCE(?, payment_place), report_handover = COALESCE(?, report_handover), updated_at = ? WHERE id = ?')
        .run(c.id, cm.id, c.payment_status, c.payment_status, c.payment_place, c.report_handover, now(), r.order.id);
      created.push(r.order.id);
    }
    if (cm.status === 'AWAITING_PROTOCOL') {
      db.prepare(`UPDATE rad_case_modalities SET status = 'PROTOCOLLED', protocolled_by = ?, protocolled_at = ? WHERE id = ?`)
        .run(user.id, now(), caseModalityId);
    }
    db.prepare('UPDATE rad_cases SET updated_at = ? WHERE id = ?').run(now(), c.id);
    audit({ action: adding ? 'CASE_SERVICES_ADDED' : 'CASE_PROTOCOLLED', actor: user, patientId: c.patient_id, resource: c.case_no, details: { modality: cm.modality, services: created.length, midDiagnostic: adding && cm.status !== 'AWAITING_PROTOCOL' } });
  });

  notify(usersWithRoles(['reception']), {
    orderId: created[0],
    kind: 'STATUS',
    text: `${user.fullName} ${adding && cm.status !== 'AWAITING_PROTOCOL' ? 'added' : 'selected'} ${created.length} ${cm.modality} service(s) for case ${c.case_no} — amounts ready for counter payment`
  });
  return hydrate(c.id);
}

/** Assistant: call next / call token from waiting. */
export function callForAssist(caseModalityId, user) {
  requireRole(user, ['assistant', 'admin', 'radiologist']);
  const cm = db.prepare('SELECT * FROM rad_case_modalities WHERE id = ?').get(caseModalityId);
  if (!cm) throw notFound('Case modality');
  if (!ASSIST_OPEN.includes(cm.status) && cm.status !== 'WAITING') {
    if (cm.status === 'AT_ASSISTANT' && cm.called_by === user.id) return hydrate(cm.case_id);
    throw conflict('NOT_WAITING', `Cannot call from ${cm.status}`);
  }
  if (cm.status === 'WAITING' || cm.status === 'AT_ASSISTANT') {
    db.prepare(`UPDATE rad_case_modalities SET status = 'AT_ASSISTANT', called_by = ?, called_at = COALESCE(called_at, ?) WHERE id = ?`)
      .run(user.id, now(), caseModalityId);
    audit({ action: 'ASSIST_CALLED', actor: user, resource: caseModalityId, details: { token: cm.token_no } });
  }
  return hydrate(cm.case_id);
}

/**
 * Assistant: save consent / basics and transfer patient to the modality.
 * After this, technician selects sub-modality services.
 */
export function assistTransfer(caseModalityId, body, user) {
  requireRole(user, ['assistant', 'admin', 'radiologist']);
  const cm = db.prepare('SELECT * FROM rad_case_modalities WHERE id = ?').get(caseModalityId);
  if (!cm) throw notFound('Case modality');
  if (!ASSIST_OPEN.includes(cm.status)) throw conflict('WRONG_LANE', `Assistant work is closed for status ${cm.status}`);

  const idOk = body.idVerified === true;
  const consentOk = body.consentOk === true;
  const allergyOk = body.allergyChecked === true;
  const prepOk = body.prepDone === true;
  if (!idOk) throw bad('ID_REQUIRED', 'Confirm patient identity (OPD/IPD ID, name / DOB)');
  if (!consentOk) throw bad('CONSENT_REQUIRED', 'Record consent before transferring to the modality');
  if (!allergyOk) throw bad('ALLERGY_REQUIRED', 'Confirm allergy / contrast questions were asked');

  const notes = optionalText(body.notes, 1000) || '';
  const checklist = {
    pregnancyAsked: body.pregnancyAsked === true,
    implantAsked: body.implantAsked === true,
    fastingChecked: body.fastingChecked === true,
    valuablesRemoved: body.valuablesRemoved === true,
    escortOk: body.escortOk === true,
    language: optionalText(body.language, 40) || 'en'
  };

  const c = db.prepare('SELECT * FROM rad_cases WHERE id = ?').get(cm.case_id);
  tx(db, () => {
    db.prepare(`UPDATE rad_case_modalities SET
      status = 'AWAITING_PROTOCOL',
      called_by = COALESCE(called_by, ?),
      called_at = COALESCE(called_at, ?),
      transferred_by = ?, transferred_at = ?,
      assist_id_verified = 1, assist_consent_ok = 1, assist_allergy_checked = ?, assist_prep_done = ?,
      assist_notes = ?, assist_checklist_json = ?
      WHERE id = ?`)
      .run(user.id, now(), user.id, now(), allergyOk ? 1 : 0, prepOk ? 1 : 0, notes, JSON.stringify(checklist), caseModalityId);
    db.prepare('UPDATE rad_cases SET updated_at = ? WHERE id = ?').run(now(), c.id);
    audit({ action: 'ASSIST_TRANSFERRED', actor: user, patientId: c.patient_id, resource: c.case_no, details: { modality: cm.modality, token: cm.token_no } });
  });

  notify(usersWithRoles(['technologist', 'radiologist']), {
    kind: 'STATUS',
    text: `${user.fullName} transferred token ${cm.token_no || ''} (${cm.modality}) to modality — select sub-services`
  });
  return hydrate(c.id);
}

export function cancelCaseModality(caseModalityId, body, user) {
  requireRole(user, ['reception', 'technologist', 'assistant', 'radiologist', 'admin']);
  const cm = db.prepare('SELECT * FROM rad_case_modalities WHERE id = ?').get(caseModalityId);
  if (!cm) throw notFound('Case modality');
  const reason = requireText(body.reason, 'Reason', 300);
  const openOrders = db.prepare("SELECT COUNT(*) c FROM orders WHERE case_modality_id = ? AND status NOT IN ('CANCELLED','REQUESTED','ACKNOWLEDGED','SCHEDULED','NO_SHOW')").get(caseModalityId).c;
  if (openOrders) throw conflict('STARTED', 'A scan in this category has already started');
  tx(db, () => {
    for (const o of db.prepare("SELECT id FROM orders WHERE case_modality_id = ? AND status IN ('REQUESTED','ACKNOWLEDGED','SCHEDULED','NO_SHOW')").all(caseModalityId)) {
      db.prepare("UPDATE orders SET status = 'CANCELLED', cancel_reason = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(reason, now(), o.id);
    }
    db.prepare("UPDATE rad_case_modalities SET status = 'CANCELLED', hold_reason = ? WHERE id = ?").run(reason, caseModalityId);
    audit({ action: 'CASE_MODALITY_CANCELLED', actor: user, resource: caseModalityId, details: { reason } });
  });
  return hydrate(cm.case_id);
}

export function listCategories() {
  return CATEGORIES.map((modality) => {
    const machines = listMachines({ modality, activeOnly: true });
    const awaiting = db.prepare("SELECT COUNT(*) c FROM rad_case_modalities WHERE modality = ? AND status = 'AWAITING_PROTOCOL'").get(modality).c;
    const waitingAssist = db.prepare("SELECT COUNT(*) c FROM rad_case_modalities WHERE modality = ? AND status IN ('WAITING','AT_ASSISTANT')").get(modality).c;
    const services = db.prepare('SELECT COUNT(*) c FROM exam_catalog WHERE modality = ? AND active = 1 AND price IS NOT NULL').get(modality).c;
    return { modality, label: modality === 'XR' ? 'X-ray' : modality === 'OPEN_MRI' ? 'Open MRI' : modality === 'USG' ? 'Sonography' : modality, machines: machines.length, awaiting, waitingAssist, services };
  });
}

export { hydrate, MOD_STATUS, ASSIST_OPEN };
