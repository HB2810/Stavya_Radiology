// Future integrations: PACS/viewer auto-report, WhatsApp delivery, anaesthesia module.
// Today these queue outbound messages in integration_outbox; a worker/provider can send later.
import { db } from './db.js';
import { audit } from './audit.js';
import { requireRole } from './auth.js';
import { bad, bestEffort, now, optionalText, uid } from './util.js';
import { notify, usersWithRoles } from './notifications.js';

const KEYS = ['whatsapp_reports', 'whatsapp_alerts', 'pacs_auto_report', 'anesthesia_module', 'sedation_notify'];

export function listIntegrations(user) {
  requireRole(user, ['admin', 'auditor', 'radiologist', 'reception']);
  return db.prepare('SELECT key, enabled, config_json, updated_at FROM integration_settings ORDER BY key').all()
    .map((r) => ({ ...r, enabled: !!r.enabled, config: JSON.parse(r.config_json || '{}') }));
}

export function getIntegration(key) {
  const row = db.prepare('SELECT * FROM integration_settings WHERE key = ?').get(key);
  if (!row) return { key, enabled: false, config: {} };
  return { key: row.key, enabled: !!row.enabled, config: JSON.parse(row.config_json || '{}') };
}

export function updateIntegration(key, body, user) {
  requireRole(user, ['admin']);
  if (!KEYS.includes(key)) throw bad('UNKNOWN_INTEGRATION', `Unknown integration ${key}`);
  const cur = getIntegration(key);
  const enabled = body.enabled == null ? cur.enabled : !!body.enabled;
  const config = body.config && typeof body.config === 'object' ? { ...cur.config, ...body.config } : cur.config;
  db.prepare('UPDATE integration_settings SET enabled = ?, config_json = ?, updated_at = ? WHERE key = ?')
    .run(enabled ? 1 : 0, JSON.stringify(config), now(), key);
  audit({ action: 'INTEGRATION_UPDATED', actor: user, resource: key, details: { enabled } });
  return getIntegration(key);
}

/** Queue an outbound message (WhatsApp / anaesthesia / PACS). Never throws to callers. */
export function queueOutbound({ channel, destination = null, template, payload = {}, orderId = null, patientId = null }) {
  return bestEffort(`outbox ${template}`, () => {
    const id = uid('out');
    db.prepare(`INSERT INTO integration_outbox (id, channel, destination, template, payload_json, status, related_order_id, related_patient_id, created_at)
      VALUES (?,?,?,?,?,'QUEUED',?,?,?)`)
      .run(id, channel, destination, template, JSON.stringify(payload), orderId, patientId, now());
    return id;
  });
}

export function listOutbox(user, { status = 'QUEUED', limit = 50 } = {}) {
  requireRole(user, ['admin', 'auditor']);
  return db.prepare('SELECT * FROM integration_outbox WHERE status = ? ORDER BY created_at DESC LIMIT ?')
    .all(status, Math.min(Number(limit) || 50, 200));
}

/**
 * When sedation is required: in-app notify + optional WhatsApp + optional anaesthesia module push.
 */
export function onSedationRequired(order, patient, { medicineUsed, notes, actor } = {}) {
  const text = `Sedation required for ${patient?.name || 'patient'} · ${order.accession} (${order.exam_name || order.exam_code}). Inform anaesthetist.`;
  notify(usersWithRoles(['radiologist', 'technologist', 'admin']), { orderId: order.id, kind: 'SEDATION', text });

  const sedation = getIntegration('sedation_notify');
  const whatsapp = getIntegration('whatsapp_alerts');
  const anesthesia = getIntegration('anesthesia_module');

  if (sedation.enabled || whatsapp.enabled) {
    queueOutbound({
      channel: 'whatsapp',
      destination: optionalText(patient?.phone, 20) || null,
      template: 'sedation_alert',
      payload: { accession: order.accession, patient: patient?.name, medicineUsed, notes, toRole: 'anaesthetist' },
      orderId: order.id,
      patientId: patient?.id
    });
  }
  if (anesthesia.enabled) {
    queueOutbound({
      channel: 'anesthesia_module',
      destination: anesthesia.config?.endpoint || null,
      template: 'sedation_request',
      payload: {
        orderId: order.id,
        accession: order.accession,
        patientId: patient?.id,
        mrn: patient?.mrn,
        exam: order.exam_code,
        medicineUsed,
        notes,
        requestedBy: actor?.fullName
      },
      orderId: order.id,
      patientId: patient?.id
    });
  }
}

/**
 * After a report is signed: optional auto-pipeline from PACS later; WhatsApp to patient when enabled.
 */
export function onReportSigned(order, patient, report) {
  const pacs = getIntegration('pacs_auto_report');
  const wa = getIntegration('whatsapp_reports');

  if (pacs.enabled) {
    queueOutbound({
      channel: 'pacs',
      destination: pacs.config?.endpoint || null,
      template: 'study_report_ready',
      payload: { orderId: order.id, accession: order.accession, reportId: report?.id, studyUid: pacs.config?.studyUidField || null },
      orderId: order.id,
      patientId: patient?.id
    });
  }
  if (wa.enabled) {
    const phone = optionalText(patient?.phone, 20);
    queueOutbound({
      channel: 'whatsapp',
      destination: phone || null,
      template: 'patient_report',
      payload: {
        accession: order.accession,
        patient: patient?.name,
        exam: order.exam_name || order.exam_code,
        reportId: report?.id,
        // Future: attach PDF / viewer deep-link once PACS connected
        viewerUrl: null,
        pdfUrl: null
      },
      orderId: order.id,
      patientId: patient?.id
    });
    if (phone) {
      notify(usersWithRoles(['reception', 'admin']), {
        orderId: order.id,
        kind: 'WHATSAPP_QUEUED',
        text: `Report for ${patient.name} queued to WhatsApp ${phone}`
      });
    }
  }
}

/** Stub: when PACS/viewer marks study complete, RIS can auto-open a draft report. */
export function onPacsStudyComplete(body, user) {
  requireRole(user, ['admin', 'radiologist', 'technologist']);
  const pacs = getIntegration('pacs_auto_report');
  if (!pacs.enabled) return { queued: false, reason: 'pacs_auto_report_disabled' };
  const id = queueOutbound({
    channel: 'pacs',
    template: 'auto_draft_report',
    payload: body,
    orderId: body.orderId || null,
    patientId: body.patientId || null
  });
  audit({ action: 'PACS_STUDY_COMPLETE_HOOK', actor: user, resource: body.accession || body.orderId, details: body });
  return { queued: true, outboxId: id };
}
