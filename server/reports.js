import { createHash } from 'node:crypto';
import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, conflict, notFound, now, optionalText, requireText, tx, uid } from './util.js';
import { FINAL_STATUSES, getOrderForUser } from './orders.js';
import { getExam, templatesFor } from './catalog.js';
import { CRITICAL_PATTERNS } from './reference-data.js';
import { createCriticalCase } from './critical.js';
import { notify } from './notifications.js';

export function detectCritical(text) {
  return CRITICAL_PATTERNS.filter(([, re]) => re.test(text || '')).map(([name]) => name);
}

// Signature payloads are versioned. sig_version 1 (every report signed before PKG-01) covers the clinical text, author and chain link.
// sig_version 2 additionally covers the signer, the addendum reason and the critical declaration, summary and no-critical reason, so none of
// them can change in the database without breaking verification. Old rows keep verifying with their own version's payload.
export const SIG_VERSION = 2;
export function signatureFor(report, order, prevHash) {
  const payload = {
    accession: order.accession, patient: order.patient_id, version: report.version, kind: report.kind,
    technique: report.technique, findings: report.findings, impression: report.impression, recommendation: report.recommendation,
    author: report.author_id, signedAt: report.signed_at, prev: prevHash || null
  };
  if ((report.sig_version || 1) >= 2) Object.assign(payload, {
    addendumReason: report.addendum_reason ?? null, criticalDeclared: report.critical_declared ?? null,
    criticalSummary: report.critical_summary ?? null, criticalNoReason: report.critical_no_reason ?? null
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function verifyReportChain(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const rows = db.prepare("SELECT * FROM reports WHERE order_id = ? AND status = 'FINAL' ORDER BY version").all(orderId);
  let prev = null;
  for (const r of rows) {
    if (signatureFor(r, order, prev) !== r.signature_hash) return { valid: false, brokenAtVersion: r.version };
    prev = r.signature_hash;
  }
  return { valid: true, versions: rows.length };
}

export function reportsForOrder(orderId, user) {
  const order = getOrderForUser(orderId, user);
  const all = db.prepare('SELECT * FROM reports WHERE order_id = ? ORDER BY version').all(orderId);
  const radiology = ['radiologist', 'technologist', 'admin', 'auditor'].includes(user.role);
  const visible = radiology ? all : all.filter((r) => r.status === 'FINAL');
  return { reports: visible, templates: radiology ? templatesFor(getExam(order.exam_code)) : [], integrity: verifyReportChain(orderId) };
}

export function saveDraft(orderId, body, user) {
  requireRole(user, ['radiologist']);
  const order = getOrderForUser(orderId, user);
  if (!['COMPLETED', 'REPORT_DRAFTED'].includes(order.status)) throw conflict('NOT_READY_TO_REPORT', `Order is ${order.status}; exam must be completed first`);
  const fields = { technique: optionalText(body.technique, 4000), findings: optionalText(body.findings, 20000), impression: optionalText(body.impression, 8000), recommendation: optionalText(body.recommendation, 4000) };
  const t = now();
  const saved = tx(db, () => {
    let draft = db.prepare("SELECT * FROM reports WHERE order_id = ? AND status = 'DRAFT' AND kind = 'REPORT'").get(orderId);
    if (draft) {
      if (body.expectedRevision !== draft.revision) throw conflict('STALE_REPORT_REVISION', 'Report was changed elsewhere, reload it');
      db.prepare('UPDATE reports SET technique=?, findings=?, impression=?, recommendation=?, revision = revision + 1, updated_at=?, author_id=?, author_name=? WHERE id=?')
        .run(fields.technique, fields.findings, fields.impression, fields.recommendation, t, user.id, user.fullName, draft.id);
    } else {
      const id = uid('rep');
      db.prepare(`INSERT INTO reports (id, order_id, version, kind, status, technique, findings, impression, recommendation, author_id, author_name, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, orderId, 1, 'REPORT', 'DRAFT', fields.technique, fields.findings, fields.impression, fields.recommendation, user.id, user.fullName, t, t);
      db.prepare("UPDATE orders SET status = 'REPORT_DRAFTED', radiologist_id = COALESCE(radiologist_id, ?), revision = revision + 1, updated_at = ? WHERE id = ?").run(user.id, t, orderId);
      db.prepare('INSERT INTO order_events (id, order_id, from_status, to_status, actor_id, actor_name, note, at) VALUES (?,?,?,?,?,?,?,?)').run(uid('evt'), orderId, order.status, 'REPORT_DRAFTED', user.id, user.fullName, '', t);
      draft = { id };
    }
    audit({ action: 'REPORT_DRAFT_SAVED', actor: user, patientId: order.patient_id, resource: order.accession });
    return db.prepare('SELECT * FROM reports WHERE id = ?').get(draft.id);
  });
  return { report: saved, criticalSuggestions: detectCritical(`${fields.findings}\n${fields.impression}`) };
}

export function signReport(reportId, body, user) {
  requireRole(user, ['radiologist']);
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!r) throw notFound('Report');
  const order = getOrderForUser(r.order_id, user);
  if (r.status !== 'DRAFT') throw conflict('IMMUTABLE_FINAL_REPORT', 'This report is already signed; add an addendum instead');
  if (body.expectedRevision !== r.revision) throw conflict('STALE_REPORT_REVISION', 'Report was changed elsewhere, reload it');
  requireText(r.findings, 'Findings'); requireText(r.impression, 'Impression');
  const hits = detectCritical(`${r.findings}\n${r.impression}`);
  const declared = body.criticalDeclared; // 'YES' | 'NO'
  if (declared != null && !['YES', 'NO'].includes(declared)) throw bad('CRITICAL_DECLARATION_INVALID', 'criticalDeclared must be YES or NO');
  if (hits.length && !['YES', 'NO'].includes(declared)) {
    const e = conflict('CRITICAL_DECLARATION_REQUIRED', `Report mentions possible critical findings (${hits.join(', ')}). Declare whether this is a critical result.`);
    e.hits = hits; throw e;
  }
  const noReason = declared === 'NO' && hits.length ? requireText(body.criticalNoReason, 'Reason for not treating as critical', 500) : null;
  const summary = declared === 'YES' ? requireText(body.criticalSummary, 'Critical summary', 1000) : null;
  const t = now();
  let caseId = null;
  tx(db, () => {
    // The signer (not the last draft editor) is the author of the signed version and is covered by the signature.
    const signed = { ...r, signed_at: t, version: 1, author_id: user.id, critical_declared: declared || 'NO', critical_summary: summary, critical_no_reason: noReason, addendum_reason: null, sig_version: SIG_VERSION };
    const hash = signatureFor(signed, order, null);
    const u = db.prepare("UPDATE reports SET status='FINAL', signed_at=?, signature_hash=?, critical_declared=?, critical_summary=?, critical_no_reason=?, sig_version=?, revision=revision+1, updated_at=?, author_id=?, author_name=? WHERE id=? AND status='DRAFT' AND revision=?")
      .run(t, hash, declared || 'NO', summary, noReason, SIG_VERSION, t, user.id, user.fullName, reportId, r.revision);
    if (u.changes !== 1) throw conflict('STALE_REPORT_REVISION', 'Report was changed elsewhere, reload it');
    db.prepare("UPDATE orders SET status='REPORTED', reported_at=?, radiologist_id=?, revision=revision+1, updated_at=? WHERE id=?").run(t, user.id, t, order.id);
    db.prepare('INSERT INTO order_events (id, order_id, from_status, to_status, actor_id, actor_name, note, at) VALUES (?,?,?,?,?,?,?,?)').run(uid('evt'), order.id, order.status, 'REPORTED', user.id, user.fullName, 'Report signed', t);
    if (declared === 'YES') caseId = createCriticalCase(order, r, summary, body.receiverId, user);
    audit({ action: 'REPORT_SIGNED', actor: user, patientId: order.patient_id, resource: order.accession, details: { critical: declared === 'YES', hits } });
  });
  notify([order.requested_by, order.encounter_doctor_id].filter((i) => i !== user.id), { orderId: order.id, kind: 'REPORT_FINAL', text: `Report ready: ${order.exam_name} for ${order.patient_name}` });
  return { report: db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId), criticalCaseId: caseId };
}

export function addAddendum(orderId, body, user) {
  requireRole(user, ['radiologist']);
  const order = getOrderForUser(orderId, user);
  if (!FINAL_STATUSES.includes(order.status)) throw conflict('NO_FINAL_REPORT', 'Addenda can only be added to a signed report');
  const reason = requireText(body.reason, 'Addendum reason', 1000);
  const text = requireText(body.findings, 'Addendum text', 8000);
  const prev = db.prepare("SELECT * FROM reports WHERE order_id = ? AND status = 'FINAL' ORDER BY version DESC LIMIT 1").get(orderId);
  const t = now(); const id = uid('rep');
  const row = { version: prev.version + 1, kind: 'ADDENDUM', technique: '', findings: text, impression: optionalText(body.impression, 4000), recommendation: '', author_id: user.id, signed_at: t,
    addendum_reason: reason, critical_declared: 'NO', critical_summary: null, critical_no_reason: null, sig_version: SIG_VERSION };
  const hash = signatureFor(row, order, prev.signature_hash);
  tx(db, () => {
    db.prepare(`INSERT INTO reports (id, order_id, version, kind, status, technique, findings, impression, recommendation, author_id, author_name, created_at, updated_at, signed_at, signature_hash, addendum_reason, critical_declared, sig_version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, orderId, row.version, 'ADDENDUM', 'FINAL', '', text, row.impression, '', user.id, user.fullName, t, t, t, hash, reason, 'NO', SIG_VERSION);
    audit({ action: 'REPORT_ADDENDUM', actor: user, patientId: order.patient_id, resource: order.accession, details: { reason } });
  });
  notify([order.requested_by, order.encounter_doctor_id].filter((i) => i !== user.id), { orderId, kind: 'REPORT_ADDENDUM', text: `Addendum added to ${order.exam_name} report for ${order.patient_name}: ${reason}` });
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function printableReport(orderId, user) {
  const order = getOrderForUser(orderId, user);
  const finals = db.prepare("SELECT * FROM reports WHERE order_id = ? AND status = 'FINAL' ORDER BY version").all(orderId);
  if (!finals.length) throw notFound('Signed report');
  audit({ action: 'REPORT_PRINTED', actor: user, patientId: order.patient_id, resource: order.accession });
  const block = (r) => `<section><h3>${r.kind === 'ADDENDUM' ? 'Addendum v' + r.version + ' — ' + esc(r.addendum_reason) : 'Report'}</h3>
    ${r.technique ? `<h4>Technique</h4><pre>${esc(r.technique)}</pre>` : ''}<h4>Findings</h4><pre>${esc(r.findings)}</pre>
    ${r.impression ? `<h4>Impression</h4><pre>${esc(r.impression)}</pre>` : ''}${r.recommendation ? `<h4>Recommendation</h4><pre>${esc(r.recommendation)}</pre>` : ''}
    <p class="sig">Electronically signed by ${esc(r.author_name)} on ${esc(r.signed_at)}<br>Signature ${esc(r.signature_hash.slice(0, 16))}…</p></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(order.accession)}</title><style>
    body{font:14px/1.5 system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;color:#111}pre{white-space:pre-wrap;font:inherit;margin:.2rem 0 1rem}
    h1{margin:0}table{width:100%;border-collapse:collapse;margin:1rem 0}td{padding:.25rem .5rem;border:1px solid #ccc}.sig{color:#555;font-size:12px;border-top:1px solid #ccc;padding-top:.5rem}</style></head><body>
    <h1>Stavya Spine Hospital — Radiology Report</h1><table><tr><td>Patient</td><td>${esc(order.patient_name)} (${esc(order.mrn)})</td><td>Accession</td><td>${esc(order.accession)}</td></tr>
    <tr><td>DOB / Sex</td><td>${esc(order.dob)} / ${esc(order.sex)}</td><td>Exam</td><td>${esc(order.exam_name)}</td></tr>
    <tr><td>Requested by</td><td>${esc(order.requested_by_name)}${order.requested_by_designation ? ', ' + esc(order.requested_by_designation) : ''} (${esc(order.encounter_type)} ${esc(order.encounter_ref)})</td><td>Indication</td><td>${esc(order.clinical_indication)}</td></tr></table>
    ${finals.map(block).join('')}</body></html>`;
}
