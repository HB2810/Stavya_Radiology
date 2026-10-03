// PKG-M4: three traffic sources (OPD / IPD / EXTERNAL) and IPD ordering designations (Fellow / Surgeon / Medical Officer).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE, STAFF } from '../server/roster.js';

process.env.RIS_DB = ':memory:'; process.env.RIS_DEMO_WEAK_PASSWORDS = '1';
const PW = 'Test#Passw0rd!';
let server, base, db; const tok = {}; const S = {};

const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

before(async () => {
  const { createServer } = await import('../server/app.js'); const { seedDemo } = await import('../server/seed.js'); const { createUser } = await import('../server/auth.js'); ({ db } = await import('../server/db.js'));
  seedDemo(PW);
  // dr_fellow / dr_mo are demo-traffic-only roster entries (not part of the minimal seed); create them directly
  // here so this suite does not need to run the whole two-week traffic generator just to sign in as them.
  for (const alias of ['dr_fellow', 'dr_mo']) { const s = STAFF[alias]; createUser({ username: s.code, password: PW, fullName: s.name, role: s.role, designation: s.designation }); }
  server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['dr_preety', 'reception1', 'dr_mirant', 'admin', 'dr_fellow', 'dr_mo']) {
    const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token;
  }
  S.ramesh = db.prepare("SELECT id FROM patients WHERE mrn='SSH-1001'").get().id;
  S.ramEnc = db.prepare("SELECT id FROM encounters WHERE patient_id = ? AND type = 'IPD'").get(S.ramesh).id;
  S.kavita = db.prepare("SELECT id FROM patients WHERE mrn='SSH-1002'").get().id;
  S.kavEnc = db.prepare("SELECT id FROM encounters WHERE patient_id = ? AND type = 'OPD'").get(S.kavita).id;
});
after(() => server.close());

test('roster: Fellow and Medical Officer are real clinician accounts, distinct from the named consultants', async () => {
  const fellow = await call('dr_fellow', 'GET', '/api/auth/me');
  assert.equal(fellow.body.user.designation, 'Fellow'); assert.equal(fellow.body.user.role, 'clinician');
  const mo = await call('dr_mo', 'GET', '/api/auth/me');
  assert.equal(mo.body.user.designation, 'Medical Officer'); assert.equal(mo.body.user.role, 'clinician');
  // Designation is display/audit only: a Fellow has exactly the same permissions as any other clinician.
  assert.equal((await call('dr_fellow', 'GET', '/api/registrations')).status, 403);
});

test('a walk-in registration creates an EXTERNAL encounter (not OPD), and the scan order carries the same source', async () => {
  const r = await call('reception1', 'POST', '/api/registrations', { patientId: S.kavita, items: [{ examCode: 'XR-LS-AP-LAT' }] });
  assert.equal(r.status, 200);
  const enc = db.prepare('SELECT type, ref_no FROM encounters WHERE id = ?').get(r.body.registration.encounter_id);
  assert.equal(enc.type, 'EXTERNAL'); assert.match(enc.ref_no, /^EXT-RAD-/);
  assert.equal(r.body.lines[0].source, 'EXTERNAL'); assert.equal(r.body.lines[0].encounter_type, 'EXTERNAL');
  S.walkinOrderId = r.body.lines[0].id;
});

test('the three traffic sources (OPD, IPD, EXTERNAL) are each independently filterable and countable in analytics', async () => {
  const ipd = await call('dr_mirant', 'POST', '/api/orders', { patientId: S.ramesh, encounterId: S.ramEnc, examCode: 'CT-LS', clinicalIndication: 'Post-op instrumentation check' });
  assert.equal(ipd.status, 200); assert.equal(ipd.body.order.source, 'IPD');
  const opd = await call('dr_mirant', 'POST', '/api/orders', { patientId: S.kavita, encounterId: S.kavEnc, examCode: 'XR-CS-AP-LAT', clinicalIndication: 'Neck pain with arm numbness' });
  assert.equal(opd.status, 200); assert.equal(opd.body.order.source, 'OPD');

  for (const [source, count] of [['EXTERNAL', 1], ['IPD', 1], ['OPD', 1]]) {
    const list = await call('reception1', 'GET', `/api/orders?source=${source}`);
    assert.equal(list.status, 200); assert.ok(list.body.length >= count, source); assert.ok(list.body.every((o) => o.source === source), source);
  }
  const a = await call('admin', 'GET', '/api/analytics/summary');
  assert.equal(a.status, 200);
  assert.ok(a.body.bySource.EXTERNAL >= 1); assert.ok(a.body.bySource.IPD >= 1); assert.ok(a.body.bySource.OPD >= 1);
  assert.ok(a.body.perDay.length > 0); assert.ok(a.body.perDay.every((d) => 'EXTERNAL' in d && 'OPD' in d && 'IPD' in d && 'OT' in d));
  assert.equal((await call('dr_mirant', 'GET', '/api/analytics/summary')).status, 403); // ward clinicians don't get department analytics
});

test('an IPD order placed by a Fellow surfaces the designation on the order, its timeline and the radiology notification', async () => {
  const r = await call('dr_fellow', 'POST', '/api/orders', { patientId: S.ramesh, encounterId: S.ramEnc, examCode: 'XR-CHEST', priority: 'STAT', clinicalIndication: 'Fever and cough post-operatively, ?chest infection' });
  assert.equal(r.status, 200); assert.equal(r.body.order.source, 'IPD'); assert.equal(r.body.order.requested_by_designation, 'Fellow');

  const detail = await call('dr_preety', 'GET', `/api/orders/${r.body.order.id}`);
  assert.equal(detail.body.order.requested_by_designation, 'Fellow');
  const reqEvent = detail.body.events.find((e) => e.to_status === 'REQUESTED');
  assert.match(reqEvent.note, /Fellow/); // this is a display/audit change, recorded at request time

  const n = await call('dr_preety', 'GET', '/api/notifications?unread=1');
  const notif = n.body.find((x) => x.order_id === r.body.order.id);
  assert.ok(notif, 'radiology was notified of the new order');
  assert.match(notif.text, /^Fellow Dr\. .+ requested STAT /);

  const audit = db.prepare("SELECT details_json FROM audit_events WHERE action = 'ORDER_CREATED' AND resource = ? ORDER BY id DESC LIMIT 1").get(r.body.order.accession);
  assert.equal(JSON.parse(audit.details_json).requestedByDesignation, 'Fellow');
});

test('a Medical Officer ordering for the same ward patient carries their own designation and the same clinician permissions as a named consultant', async () => {
  const r = await call('dr_mo', 'POST', '/api/orders', { patientId: S.ramesh, encounterId: S.ramEnc, examCode: 'USG-DOPPLER-LL', clinicalIndication: 'Calf swelling on post-operative day 3, ?DVT' });
  assert.equal(r.status, 200); assert.equal(r.body.order.requested_by_designation, 'Medical Officer');
  const n = await call('dr_preety', 'GET', '/api/notifications?unread=1');
  assert.ok(n.body.some((x) => x.order_id === r.body.order.id && /^Medical Officer Dr\. .+ requested /.test(x.text)));
  // Same clinician role as the named consultants -- a Medical Officer is not a separate permission tier.
  assert.equal((await call('dr_mo', 'POST', `/api/orders/${r.body.order.id}/transition`, { to: 'ACKNOWLEDGED' })).status, 403);
});

test('reception and other non-ward staff keep a plain name in the notification (no designation prefix)', async () => {
  const n = await call('dr_preety', 'GET', '/api/notifications?unread=1');
  const walkin = n.body.find((x) => x.order_id === S.walkinOrderId);
  assert.ok(walkin); assert.match(walkin.text, /^Reception 1 requested /);
});
