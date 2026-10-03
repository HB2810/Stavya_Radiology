import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from '../server/roster.js';

process.env.RIS_DB = ':memory:';
const PW = 'Test#Passw0rd!';
let server, base; const tok = {};
let ids = {};

const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

before(async () => {
  const { createServer } = await import('../server/app.js');
  const { seedDemo } = await import('../server/seed.js');
  const { db } = await import('../server/db.js');
  seedDemo(PW);
  server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['dr_preety', 'tech_hardik', 'reception1', 'dr_mirant', 'dr_bharat', 'nurse_hdu', 'auditor', 'admin']) {
    const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token;
  }
  ids.ramesh = db.prepare("SELECT id FROM patients WHERE mrn='SSH-1001'").get().id;
  ids.ramEnc = db.prepare('SELECT id FROM encounters WHERE patient_id=?').get(ids.ramesh).id;
  ids.kavita = db.prepare("SELECT id FROM patients WHERE mrn='SSH-1002'").get().id;
  ids.kavEnc = db.prepare('SELECT id FROM encounters WHERE patient_id=?').get(ids.kavita).id;
});
after(() => server.close());

test('auth: wrong password rejected, unauthenticated blocked', async () => {
  assert.equal((await call(null, 'POST', '/api/auth/login', { username: CODE.dr_preety, password: 'nope' })).status, 401);
  assert.equal((await call(null, 'GET', '/api/orders')).status, 401);
});

test('smart suggestion maps indication to exams', async () => {
  const r = await call('dr_mirant', 'GET', '/api/catalog/suggest?indication=' + encodeURIComponent('leg weakness with cauda equina suspicion'));
  assert.equal(r.body[0].code, 'MRI-LS');
});

test('IPD doctor orders a STAT MRI; duplicates are caught; ward isolation holds', async () => {
  const r = await call('dr_mirant', 'POST', '/api/orders', { patientId: ids.ramesh, encounterId: ids.ramEnc, examCode: 'MRI-LS', priority: 'STAT', clinicalIndication: 'Sudden bilateral leg weakness, urinary retention' });
  assert.equal(r.status, 200); assert.equal(r.body.order.source, 'IPD'); assert.equal(r.body.order.status, 'REQUESTED');
  ids.order = r.body.order.id;
  const dup = await call('dr_mirant', 'POST', '/api/orders', { patientId: ids.ramesh, encounterId: ids.ramEnc, examCode: 'MRI-LS', priority: 'ROUTINE', clinicalIndication: 'Repeat request' });
  assert.equal(dup.status, 409); assert.equal(dup.body.error, 'POSSIBLE_DUPLICATE');
  // Another clinician who is not the requester/treating doctor cannot see it
  assert.equal((await call('dr_bharat', 'GET', '/api/orders/' + ids.order)).status, 403);
  // Ward nurse (HDU) can
  assert.equal((await call('nurse_hdu', 'GET', '/api/orders/' + ids.order)).status, 200);
  // Radiology staff were notified
  const n = await call('dr_preety', 'GET', '/api/notifications?unread=1');
  assert.ok(n.body.some((x) => x.kind === 'STAT_ORDER'));
});

test('worklist puts STAT first and clinicians cannot run acquisition steps', async () => {
  await call('dr_mirant', 'POST', '/api/orders', { patientId: ids.kavita, encounterId: ids.kavEnc, examCode: 'XR-LS-AP-LAT', clinicalIndication: 'Low back pain 3 weeks' });
  const list = await call('reception1', 'GET', '/api/orders?open=1');
  assert.equal(list.body[0].priority, 'STAT');
  const bad = await call('dr_mirant', 'POST', `/api/orders/${ids.order}/transition`, { to: 'ACKNOWLEDGED' });
  assert.equal(bad.status, 403);
});

test('workflow enforces order, safety screening blocks MRI with implant until overridden by a radiologist', async () => {
  const t = (who, to, extra = {}) => call(who, 'POST', `/api/orders/${ids.order}/transition`, { to, ...extra });
  assert.equal((await t('reception1', 'ACKNOWLEDGED')).status, 200);
  assert.equal((await t('reception1', 'ARRIVED')).status, 409); // must be scheduled first
  assert.equal((await t('reception1', 'SCHEDULED')).status, 400); // needs a time
  assert.equal((await t('reception1', 'SCHEDULED', { scheduledAt: new Date().toISOString() })).status, 200);
  assert.equal((await t('reception1', 'ARRIVED')).status, 200);
  assert.equal((await t('tech_hardik', 'IN_PROGRESS')).body.error, 'INVALID_TRANSITION'); // consent and prepare first
  assert.equal((await t('tech_hardik', 'PREPARED')).body.error, 'CONSENT_REQUIRED');
  const cons = await call('tech_hardik', 'POST', `/api/orders/${ids.order}/scan-consent`, { contrast: 'PLAIN', fullName: 'Ramesh Desai', date: new Date().toISOString().slice(0, 10), agree: true, language: 'en' });
  assert.equal(cons.status, 200); assert.equal(cons.body.prepared, true);
  assert.equal((await t('tech_hardik', 'IN_PROGRESS')).body.error, 'SAFETY_CHECK_REQUIRED');
  const s = await call('tech_hardik', 'POST', `/api/orders/${ids.order}/safety`, { pregnant: 'NA', contrastAllergy: 'NA', mriImplant: 'YES' });
  assert.equal(s.body.status, 'BLOCKED');
  assert.equal((await t('tech_hardik', 'IN_PROGRESS')).status, 409);
  const techOverride = await call('tech_hardik', 'POST', `/api/orders/${ids.order}/safety`, { pregnant: 'NA', contrastAllergy: 'NA', mriImplant: 'YES', overrideReason: 'ok' });
  assert.equal(techOverride.status, 403);
  const ok = await call('dr_preety', 'POST', `/api/orders/${ids.order}/safety`, { pregnant: 'NA', contrastAllergy: 'NA', mriImplant: 'YES', overrideReason: 'MRI-conditional pedicle screws, 1.5T verified' });
  assert.equal(ok.body.status, 'CLEARED_OVERRIDE');
  assert.equal((await t('tech_hardik', 'IN_PROGRESS')).status, 200);
  assert.equal((await t('tech_hardik', 'COMPLETED')).status, 200);
});

test('reporting: clinician cannot see drafts; critical wording forces a declaration; sign creates critical case', async () => {
  const draft = await call('dr_preety', 'POST', `/api/orders/${ids.order}/report`, { technique: 'Sagittal T1/T2', findings: 'Large central L4-5 disc extrusion causing cauda equina compression.', impression: 'Cauda equina compression at L4-5.' });
  assert.equal(draft.status, 200); assert.ok(draft.body.criticalSuggestions.includes('cauda equina'));
  ids.report = draft.body.report.id;
  const seen = await call('dr_mirant', 'GET', '/api/orders/' + ids.order);
  assert.equal(seen.body.reports.length, 0); // draft hidden from clinician
  const noDecl = await call('dr_preety', 'POST', `/api/reports/${ids.report}/sign`, { expectedRevision: 1 });
  assert.equal(noDecl.body.error, 'CRITICAL_DECLARATION_REQUIRED');
  const stale = await call('dr_preety', 'POST', `/api/reports/${ids.report}/sign`, { expectedRevision: 9, criticalDeclared: 'YES' });
  assert.equal(stale.body.error, 'STALE_REPORT_REVISION');
  const signed = await call('dr_preety', 'POST', `/api/reports/${ids.report}/sign`, { expectedRevision: 1, criticalDeclared: 'YES', criticalSummary: 'Cauda equina compression L4-5, needs urgent surgical review' });
  assert.equal(signed.status, 200); assert.ok(signed.body.criticalCaseId); ids.crit = signed.body.criticalCaseId;
  const again = await call('dr_preety', 'POST', `/api/reports/${ids.report}/sign`, { expectedRevision: 2, criticalDeclared: 'YES' });
  assert.equal(again.body.error, 'IMMUTABLE_FINAL_REPORT');
  const after = await call('dr_mirant', 'GET', '/api/orders/' + ids.order);
  assert.equal(after.body.reports.length, 1); assert.equal(after.body.order.status, 'REPORTED'); assert.equal(after.body.integrity.valid, true);
});

test('critical result: needs read-back, ward acknowledges with an action plan', async () => {
  const noRb = await call('dr_preety', 'POST', `/api/critical/${ids.crit}/communicate`, { receiverName: 'Dr Dave', channel: 'PHONE' });
  assert.equal(noRb.body.error, 'READ_BACK_REQUIRED');
  assert.equal((await call('dr_preety', 'POST', `/api/critical/${ids.crit}/communicate`, { receiverName: 'Dr Dave', channel: 'PHONE', readBack: true })).status, 200);
  assert.equal((await call('dr_mirant', 'POST', `/api/critical/${ids.crit}/acknowledge`, {})).status, 400);
  assert.equal((await call('dr_mirant', 'POST', `/api/critical/${ids.crit}/acknowledge`, { actionPlan: 'Taking to OT tonight' })).status, 200);
  const list = await call('dr_preety', 'GET', '/api/critical?state=ACKNOWLEDGED');
  assert.equal(list.body.length, 1);
});

test('addendum chains the signature; printable report renders; messages notify radiology', async () => {
  const add = await call('dr_preety', 'POST', `/api/orders/${ids.order}/addendum`, { reason: 'Level correction', findings: 'Extrusion is at L4-5, not L3-4.' });
  assert.equal(add.status, 200); assert.equal(add.body.version, 2);
  const d = await call('dr_mirant', 'GET', '/api/orders/' + ids.order); assert.equal(d.body.integrity.versions, 2); assert.equal(d.body.integrity.valid, true);
  const html = await call('dr_mirant', 'GET', `/api/orders/${ids.order}/print`); assert.match(html.body, /Radiology Report/); assert.match(html.body, /Level correction/);
  const m = await call('dr_mirant', 'POST', `/api/orders/${ids.order}/messages`, { body: 'Please confirm level with sagittal image.' });
  assert.equal(m.status, 200);
  assert.equal((await call('auditor', 'POST', `/api/orders/${ids.order}/messages`, { body: 'x' })).status, 403);
  const n = await call('dr_preety', 'GET', '/api/notifications');
  assert.ok(n.body.some((x) => x.kind === 'MESSAGE'));
});

test('analytics and tamper-evident audit', async () => {
  const a = await call('admin', 'GET', '/api/analytics/summary');
  assert.equal(a.status, 200); assert.equal(a.body.bySource.IPD, 1); assert.ok(a.body.medianMinutes.requestToReport != null);
  assert.equal((await call('dr_mirant', 'GET', '/api/analytics/summary')).status, 403);
  const v = await call('auditor', 'GET', '/api/audit/verify'); assert.equal(v.body.valid, true);
  const { db } = await import('../server/db.js');
  // The database now refuses to edit the audit log (append-only trigger), so a forgery needs the trigger dropped first;
  // that is what an attacker with raw file access would do, and the hash chain must still expose the edit.
  assert.throws(() => db.prepare("UPDATE audit_events SET actor_name='Forged' WHERE id=2").run(), /append-only/);
  db.exec('DROP TRIGGER audit_events_no_update');
  db.prepare("UPDATE audit_events SET actor_name='Forged' WHERE id=2").run();
  assert.equal((await call('auditor', 'GET', '/api/audit/verify')).body.valid, false);
  const { TRIGGERS_SQL } = await import('../server/migrations/002_foundation.js');
  db.exec(TRIGGERS_SQL.find((x) => x.includes('audit_events_no_update')));
});
