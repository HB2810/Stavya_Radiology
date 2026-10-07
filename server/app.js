import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { getSession, listStaffRoster, login, logout, requireRole } from './auth.js';
import * as access from './access.js';
import { HttpError, forbidden, likeEsc, requireObject } from './util.js';
import { verifyAudit, listAudit, anchorAudit, listAnchors } from './audit.js';
import { config } from './config.js';
import { runIdempotent, validKey } from './idempotency.js';
import { listExams, suggestExams } from './catalog.js';
import { radiologyLoad } from './load.js';
import * as orders from './orders.js';
import * as reports from './reports.js';
import * as critical from './critical.js';
import * as messages from './messages.js';
import * as patients from './patients.js';
import * as notif from './notifications.js';
import { summary } from './analytics.js';
import { forgotPassword, resetPassword } from './auth.js';
import { OCCUPATIONS } from './reference-data.js';
import * as otp from './otp.js';
import * as reg from './registration.js';
import * as bill from './billing.js';
import * as clin from './clinical.js';
import * as masters from './masters.js';
import * as discounts from './discounts.js';
import * as traffic from './traffic.js';
import * as cases from './cases.js';
import * as integrations from './integrations.js';
import { syncStamp } from './sync.js';
import { db } from './db.js';

const WEB_DIR = config.webDir;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

async function readJson(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, 'TOO_LARGE', 'Request too large'); chunks.push(c); }
  if (!chunks.length) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BAD_JSON', 'Body must be valid JSON'); }
  return requireObject(body); // null, an array or a scalar would make handlers fail with a TypeError (500)
}
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
};

// [method, regex, handler(ctx)] ; ctx = { user, body, params, query, token }
// auth: sign-in required. idem: the route honours Idempotency-Key (the handler must be synchronous). upload: may carry images or audio (larger body limit).
const routes = [];
const route = (method, pattern, fn, { auth = true, idem = true, upload = false } = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn, auth, idem, upload });

route('POST', '/api/auth/login', ({ body, ip }) => login(body.username, body.password, ip), { auth: false, idem: false });
route('GET', '/api/auth/me', ({ user }) => ({ user }));
route('POST', '/api/auth/logout', ({ user, token }) => (logout(token, user), { ok: true }));
route('GET', '/api/health', () => ({ status: 'OK', audit: verifyAudit().valid }), { auth: false });
route('GET', '/api/sync', () => syncStamp());

route('GET', '/api/catalog/exams', () => listExams());
route('GET', '/api/catalog/suggest', ({ query }) => suggestExams(query.indication));
// PKG-M5: live per-modality load, for OPD/IPD before they send a patient. Any authenticated role; informational, never blocks an order.
route('GET', '/api/radiology/load', () => radiologyLoad());
route('GET', '/api/staff', () => patients.listStaff());
// PKG-M6: admin-only read-only roster (Administration nav), no password data.
route('GET', '/api/staff/roster', ({ user }) => listStaffRoster(user));
route('GET', '/api/clinicians', () => patients.listClinicians());
// Admin-only: which modules each role / user may see (hidden when denied — never shown as blocked).
route('GET', '/api/access', ({ user }) => access.getAccessMatrix(user));
route('POST', '/api/access/roles/:role', ({ user, params, body }) => access.setRoleModules(params.role, body.modules, user));
route('POST', '/api/access/users/:id', ({ user, params, body }) => access.setUserModules(params.id, body.overrides, user));

// ---- Channel / machine / queue masters (Stavya traffic framework) ----
route('GET', '/api/masters/channels', ({ query }) => traffic.listChannels({ activeOnly: query.all !== '1' }));
route('POST', '/api/masters/channels/:code', ({ user, params, body }) => traffic.updateChannel(params.code, body, user));
route('GET', '/api/masters/machines', ({ query }) => traffic.listMachines({ activeOnly: query.all !== '1', modality: query.modality }));
route('POST', '/api/masters/machines/:id', ({ user, params, body }) => traffic.updateMachine(params.id, body, user));
route('GET', '/api/masters/queue-rules', () => traffic.getQueueRules());
route('POST', '/api/masters/queue-rules', ({ user, body }) => traffic.updateQueueRules(body, user));
route('GET', '/api/masters/traffic-options', () => traffic.getTrafficOptions());
route('POST', '/api/masters/traffic-options', ({ user, body }) => traffic.updateTrafficOptions(body, user));
route('GET', '/api/integrations', ({ user }) => integrations.listIntegrations(user));
route('POST', '/api/integrations/:key', ({ user, params, body }) => integrations.updateIntegration(params.key, body, user));
route('GET', '/api/integrations/outbox', ({ user, query }) => integrations.listOutbox(user, query));
route('POST', '/api/integrations/pacs/study-complete', ({ user, body }) => integrations.onPacsStudyComplete(body, user));
route('GET', '/api/reception/board', ({ user, query }) => traffic.receptionBoard(user, query));
route('POST', '/api/orders/:id/payment', ({ user, params, body }) => traffic.markOrderPayment(params.id, body, user));
route('POST', '/api/orders/:id/hold', ({ user, params, body }) => traffic.holdOrder(params.id, body, user));
route('POST', '/api/orders/:id/hold/clear', ({ user, params }) => traffic.clearHold(params.id, user));
route('POST', '/api/orders/:id/requeue', ({ user, params }) => traffic.requeueOrder(params.id, user));

// ---- Cases: reception picks CATEGORIES; technician picks SERVICES ----
route('GET', '/api/cases/categories', () => cases.listCategories());
route('GET', '/api/cases', ({ user, query }) => cases.listCases(user, query));
route('POST', '/api/cases', ({ user, body }) => cases.createCase(body, user));
route('GET', '/api/cases/:id', ({ user, params }) => cases.getCase(params.id, user));
route('GET', '/api/cases/modalities/:modality/services', ({ params }) => cases.servicesForModality(params.modality));
route('POST', '/api/case-modalities/:id/protocol', ({ user, params, body }) => cases.protocolModality(params.id, body, user));
route('POST', '/api/case-modalities/:id/call', ({ user, params }) => cases.callForAssist(params.id, user));
route('POST', '/api/case-modalities/:id/assist-transfer', ({ user, params, body }) => cases.assistTransfer(params.id, body, user));
route('POST', '/api/case-modalities/:id/cancel', ({ user, params, body }) => cases.cancelCaseModality(params.id, body, user));

route('GET', '/api/patients', ({ user, query }) => patients.searchPatients(query.q, user));
route('POST', '/api/patients', ({ user, body }) => patients.createPatient(body, user));
route('GET', '/api/patients/:id', ({ user, params }) => patients.patientOverview(params.id, user));
route('POST', '/api/patients/:id/encounters', ({ user, params, body }) => patients.createEncounter(params.id, body, user));
route('POST', '/api/encounters/:id/transfer', ({ user, params, body }) => patients.transferEncounter(params.id, body, user));
route('POST', '/api/encounters/:id/close', ({ user, params, body }) => patients.closeEncounter(params.id, body, user));

route('GET', '/api/orders', ({ user, query }) => orders.listOrders(user, query));
route('POST', '/api/orders', ({ user, body }) => orders.createOrder(body, user));
route('GET', '/api/orders/:id', ({ user, params }) => ({
  ...orders.orderDetail(params.id, user), messages: messages.listMessages(params.id, user),
  critical: critical.criticalForOrder(params.id), ...reports.reportsForOrder(params.id, user)
}));
route('POST', '/api/orders/:id/transition', ({ user, params, body }) => orders.transition(params.id, body, user));
route('POST', '/api/orders/:id/assign', ({ user, params, body }) => orders.assign(params.id, body, user));
route('POST', '/api/orders/:id/safety', ({ user, params, body }) => orders.recordSafety(params.id, body, user));
route('GET', '/api/orders/:id/messages', ({ user, params }) => messages.listMessages(params.id, user));
route('POST', '/api/orders/:id/messages', ({ user, params, body }) => messages.postMessage(params.id, body, user));
route('POST', '/api/orders/:id/report', ({ user, params, body }) => reports.saveDraft(params.id, body, user));
route('POST', '/api/orders/:id/addendum', ({ user, params, body }) => reports.addAddendum(params.id, body, user));
route('GET', '/api/orders/:id/print', ({ user, params }) => ({ __html: reports.printableReport(params.id, user) }));
route('POST', '/api/reports/:id/sign', ({ user, params, body }) => reports.signReport(params.id, body, user));

route('GET', '/api/critical', ({ user, query }) => critical.listCritical(user, query.state));
route('POST', '/api/critical/:id/communicate', ({ user, params, body }) => critical.communicate(params.id, body, user));
route('POST', '/api/critical/:id/acknowledge', ({ user, params, body }) => critical.acknowledge(params.id, body, user));

route('GET', '/api/notifications', ({ user, query }) => notif.listNotifications(user.id, query.unread === '1'));
route('POST', '/api/notifications/read-all', ({ user }) => (notif.markAllRead(user.id), { ok: true }));
route('POST', '/api/notifications/:id/read', ({ user, params }) => (notif.markRead(user.id, params.id), { ok: true }));


// ---- Password reset ----
route('POST', '/api/auth/forgot', ({ body }) => forgotPassword(body.phone), { auth: false, idem: false });
route('POST', '/api/auth/reset', ({ body }) => resetPassword(body), { auth: false, idem: false });

// ---- Masters ----
route('GET', '/api/masters', () => ({ proofTypes: db.prepare('SELECT * FROM proof_types').all(), referrals: db.prepare('SELECT * FROM referrals').all(), designations: db.prepare('SELECT * FROM designations').all(),
  occupations: OCCUPATIONS, bodyParts: db.prepare('SELECT DISTINCT body_part FROM diseases ORDER BY body_part').all().map((r) => r.body_part), medicineGroups: db.prepare('SELECT DISTINCT group_name FROM medicines ORDER BY group_name').all().map((r) => r.group_name) }));
route('GET', '/api/masters/medicines', ({ query }) => db.prepare("SELECT id, name, group_name FROM medicines WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 15").all(`%${likeEsc(query.q || '')}%`));
route('GET', '/api/masters/diseases', ({ query }) => db.prepare('SELECT id, name FROM diseases WHERE body_part = ? ORDER BY name').all(query.bodyPart || ''));
route('GET', '/api/masters/surgery', ({ query }) => (query.parent ? db.prepare('SELECT id, name, level FROM surgery_tree WHERE parent_id = ? ORDER BY name').all(Number(query.parent)) : db.prepare('SELECT id, name, level FROM surgery_tree WHERE parent_id IS NULL ORDER BY name').all()));

// ---- Service and discount-scheme masters (admin only) ----
route('GET', '/api/masters/services', ({ user, query }) => masters.listServices(query, user));
route('POST', '/api/masters/services', ({ user, body }) => masters.createService(body, user));
route('POST', '/api/masters/services/:code', ({ user, params, body }) => masters.updateService(params.code, body, user));
route('POST', '/api/masters/services/:code/activate', ({ user, params }) => masters.activateService(params.code, user));
route('POST', '/api/masters/services/:code/deactivate', ({ user, params }) => masters.deactivateService(params.code, user));
route('GET', '/api/masters/discounts', ({ user, query }) => masters.listDiscountSchemes(query, user));
route('POST', '/api/masters/discounts', ({ user, body }) => masters.createDiscountScheme(body, user));
route('POST', '/api/masters/discounts/:id', ({ user, params, body }) => masters.updateDiscountScheme(params.id, body, user));
route('POST', '/api/masters/discounts/:id/activate', ({ user, params }) => masters.activateDiscountScheme(params.id, user));
route('POST', '/api/masters/discounts/:id/deactivate', ({ user, params }) => masters.deactivateDiscountScheme(params.id, user));

// ---- Discount approvals (pending discounts awaiting admin sign-off) ----
route('GET', '/api/discount-approvals', ({ user, query }) => discounts.listDiscountApprovals(query, user));
route('POST', '/api/discount-approvals/:id/decision', ({ user, params, body }) => discounts.decideDiscountApproval(params.id, body, user));

// ---- Registration wizard ----
route('GET', '/api/registration/capabilities', ({ user }) => (requireRole(user, ['reception', 'admin']), reg.capabilities()));
route('POST', '/api/registration/otp/send', async ({ user, body }) => { requireRole(user, ['reception', 'admin']); return otp.sendOtp({ purpose: 'REGISTER', channel: body.channel, target: body.target }, user); }, { idem: false });
route('POST', '/api/registration/otp/verify', ({ user, body }) => { requireRole(user, ['reception', 'admin']); return otp.verifyOtp({ challengeId: body.challengeId, code: body.code, purpose: 'REGISTER' }); });
route('POST', '/api/registration/lookup', ({ user, body }) => reg.lookupPatients(body, user));
route('GET', '/api/registration/patients/:id', ({ user, params }) => reg.getPatientFull(params.id, user));
route('POST', '/api/registration/patients', ({ user, body }) => reg.savePatient(body, user), { upload: true });

// ---- Registrations, invoice, payments, refunds ----
route('GET', '/api/registrations', ({ user, query }) => reg.listRegistrations(user, query));
route('POST', '/api/registrations', ({ user, body }) => reg.createRegistration(body, user));
route('GET', '/api/registrations/:id', ({ user, params }) => reg.getRegistration(params.id, user));
route('POST', '/api/registrations/:id/invoice', ({ user, params, body }) => reg.updateInvoice(params.id, body, user));
route('POST', '/api/registrations/:id/cancel', ({ user, params, body }) => reg.cancelRegistration(params.id, body, user));
route('GET', '/api/registrations/:id/invoice-print', ({ user, params }) => ({ __html: bill.invoiceHtml(params.id, user) }));
route('POST', '/api/registrations/:id/payments', ({ user, params, body }) => bill.recordPayment(params.id, body, user));
route('POST', '/api/registrations/:id/refunds', ({ user, params, body }) => bill.requestRefund(params.id, body, user));
route('POST', '/api/payments/:id/cheque', ({ user, params, body }) => bill.processCheque(params.id, body, user));
route('GET', '/api/payments/:id/receipt', ({ user, params }) => ({ __html: bill.receiptHtml(params.id, user) }));
route('POST', '/api/refunds/:id/decision', ({ user, params, body }) => bill.decideRefund(params.id, body, user));
route('POST', '/api/refunds/:id/pay', ({ user, params, body }) => bill.payRefund(params.id, body, user));
route('GET', '/api/dashboard/summary', ({ user, query }) => reg.dashboardSummary(user, query));

// ---- Technician intake: words, consents, history, summary ----
route('GET', '/api/orders/:id/words', ({ user, params }) => clin.listWords(params.id, user));
route('POST', '/api/orders/:id/words', ({ user, params, body }) => clin.saveWords(params.id, body, user), { upload: true });
route('POST', '/api/words/:id/delete', ({ user, params }) => clin.deleteWords(params.id, user));
route('GET', '/api/audio/:id', ({ user, params }) => clin.getAudio(params.id, user));
route('GET', '/api/orders/:id/medical-consent', ({ user, params }) => clin.getMedicalConsent(params.id, user));
route('POST', '/api/orders/:id/medical-consent', ({ user, params, body }) => clin.saveMedicalConsent(params.id, body, user));
route('GET', '/api/orders/:id/past-history', ({ user, params }) => clin.getPastHistory(params.id, user));
route('POST', '/api/orders/:id/past-history', ({ user, params, body }) => clin.savePastHistory(params.id, body, user));
route('GET', '/api/orders/:id/scan-consent', ({ user, params }) => clin.getScanConsent(params.id, user));
route('POST', '/api/orders/:id/scan-consent', ({ user, params, body }) => clin.saveScanConsent(params.id, body, user));
route('GET', '/api/patients/:id/timeline', ({ user, params, query }) => clin.patientTimeline(params.id, query.module, user));
route('GET', '/api/visits/:id/summary', ({ user, params }) => clin.visitSummary(params.id, user));
route('GET', '/api/visits/:id/summary-print', ({ user, params, query }) => ({ __html: clin.summaryHtml(params.id, query.modules ? query.modules.split(',') : undefined, user) }));

route('GET', '/api/analytics/summary', ({ user, query }) => {
  requireRole(user, ['radiologist', 'reception', 'admin', 'auditor']);
  return summary(Math.min(Number(query.days) || 30, 365));
});
route('GET', '/api/audit', ({ user, query }) => { requireRole(user, ['admin', 'auditor']); return listAudit(Math.min(Number(query.limit) || 100, 500), Number(query.offset) || 0); });
route('GET', '/api/audit/verify', ({ user }) => { requireRole(user, ['admin', 'auditor']); return verifyAudit(); });
// Anchors record the audit chain head so that truncation is detectable; export or print the returned hash and keep it outside this server.
route('GET', '/api/audit/anchors', ({ user }) => { requireRole(user, ['admin', 'auditor']); return listAnchors(); });
route('POST', '/api/audit/anchors', ({ user }) => { requireRole(user, ['admin']); return anchorAudit(user); });

function serveStatic(res, pathname) {
  let file = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(WEB_DIR)) return send(res, 403, { error: 'FORBIDDEN' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) return send(res, 404, { error: 'NOT_FOUND', message: 'Web app not built. Run npm run build in web/.' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) return send(res, 404, { error: 'NOT_FOUND', message: 'No such endpoint' });
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const user = getSession(token);
      if (r.auth && !user) return send(res, 401, { error: 'UNAUTHENTICATED', message: 'Sign in required' });
      const body = req.method === 'GET' ? {} : await readJson(req, r.upload ? config.maxUploadBodyBytes : config.maxBodyBytes);
      const params = r.re.exec(url.pathname).groups || {};
      const ctx = { user, token, body, params, query: Object.fromEntries(url.searchParams), ip: req.socket.remoteAddress };
      const key = req.headers['idempotency-key'];
      let out;
      if (key !== undefined && req.method === 'POST' && r.idem && user) {
        const run = runIdempotent({ userId: user.id, key: validKey(String(key)), method: req.method, path: url.pathname, body }, () => r.fn(ctx));
        if (run.replay) return send(res, run.status, run.body, { 'Idempotent-Replay': 'true' });
        out = run.body;
      } else out = await r.fn(ctx);
      if (out && out.__html) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }); return res.end(out.__html); }
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, ...(e.hits ? { hits: e.hits } : {}) });
      // SQLite BUSY / LOCKED / FULL / IO: nothing was committed; tell the client to retry rather than report a bug.
      const code = (e?.errcode ?? 0) & 0xff;
      if (e?.code === 'ERR_SQLITE_ERROR' && [5, 6, 13, 10].includes(code)) {
        console.error(`[ERROR] ${req.method} ${url.pathname}: database unavailable (${e.errstr})`, e);
        return send(res, 503, { error: 'DATABASE_UNAVAILABLE', message: 'The database is busy or unavailable. Nothing was saved; try again shortly.' }, { 'Retry-After': '2' });
      }
      console.error(`[ERROR] ${req.method} ${url.pathname}:`, e);
      send(res, 500, { error: 'INTERNAL', message: 'Something went wrong' });
    }
  });
}
