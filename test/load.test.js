// PKG-M5: GET /api/radiology/load -- live per-modality traffic for OPD/IPD before they send a patient.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from '../server/roster.js';

process.env.RIS_DB = ':memory:'; process.env.RIS_DEMO_WEAK_PASSWORDS = '1';
const PW = 'Test#Passw0rd!';
let server, base, db; const tok = {}; const ids = {};

const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

before(async () => {
  const { createServer } = await import('../server/app.js'); const { seedDemo } = await import('../server/seed.js'); ({ db } = await import('../server/db.js'));
  seedDemo(PW); server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['dr_mirant']) { const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token; }
  ids.patient = db.prepare("SELECT id FROM patients WHERE mrn = 'SSH-1001'").get().id;
  ids.enc = db.prepare("SELECT id FROM encounters WHERE patient_id = ? AND status = 'ACTIVE'").get(ids.patient).id;
});
after(() => server.close());

// Creates a genuine order through the API (REQUESTED), then fast-forwards its status/due_at directly -- a cheap stand-in
// for driving the full ARRIVED/PREPARED consent+safety chain, which this endpoint's counting logic does not care about.
const create = async (examCode) => {
  const r = await call('dr_mirant', 'POST', '/api/orders', { patientId: ids.patient, encounterId: ids.enc, examCode, priority: 'ROUTINE', clinicalIndication: 'Load widget test indication', confirmDuplicate: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.order.id;
};
const setStatus = (id, status) => db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
const setDue = (id, iso) => db.prepare('UPDATE orders SET due_at = ? WHERE id = ?').run(iso, id);
const past = () => new Date(Date.now() - 3600_000).toISOString();

test('any authenticated role (a clinician here) can reach the load endpoint; shape is the six modalities, no order list', async () => {
  assert.equal((await call(null, 'GET', '/api/radiology/load')).status, 401); // unauthenticated still blocked
  const r = await call('dr_mirant', 'GET', '/api/radiology/load');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((m) => m.modality), ['MRI', 'CT', 'XR', 'DEXA', 'USG', 'OPEN_MRI']);
  for (const m of r.body) {
    assert.ok(['Quiet', 'Busy', 'Very busy'].includes(m.label), m.label);
    assert.equal(m.total, m.queued + m.inProgress);
    assert.ok(Number.isInteger(m.queued) && Number.isInteger(m.inProgress) && Number.isInteger(m.overdue));
    assert.ok(m.overdue <= m.total);
  }
});

test('counts reflect real order state: queued, in-progress and overdue move independently per modality', async () => {
  const before = Object.fromEntries((await call('dr_mirant', 'GET', '/api/radiology/load')).body.map((m) => [m.modality, m]));

  await create('MRI-KNEE'); // stays REQUESTED: queued
  const ctAck = await create('CT-BRAIN'); setStatus(ctAck, 'ACKNOWLEDGED'); // queued
  const xrProg = await create('XR-CHEST'); setStatus(xrProg, 'IN_PROGRESS'); // on the table, not queued
  const dexaLate = await create('DEXA'); setStatus(dexaLate, 'SCHEDULED'); setDue(dexaLate, past()); // queued AND overdue
  const usgLate = await create('USG-ABD'); setStatus(usgLate, 'IN_PROGRESS'); setDue(usgLate, past()); // on the table AND overdue
  const omriGone = await create('OMRI-KNEE'); setStatus(omriGone, 'CANCELLED'); // must not be counted anywhere

  const after = Object.fromEntries((await call('dr_mirant', 'GET', '/api/radiology/load')).body.map((m) => [m.modality, m]));

  assert.equal(after.MRI.queued, before.MRI.queued + 1); assert.equal(after.MRI.inProgress, before.MRI.inProgress);
  assert.equal(after.CT.queued, before.CT.queued + 1); assert.equal(after.CT.overdue, before.CT.overdue);
  assert.equal(after.XR.inProgress, before.XR.inProgress + 1); assert.equal(after.XR.queued, before.XR.queued);
  assert.equal(after.DEXA.queued, before.DEXA.queued + 1); assert.equal(after.DEXA.overdue, before.DEXA.overdue + 1);
  assert.equal(after.USG.inProgress, before.USG.inProgress + 1); assert.equal(after.USG.overdue, before.USG.overdue + 1);
  assert.equal(after.OPEN_MRI.queued, before.OPEN_MRI.queued); assert.equal(after.OPEN_MRI.inProgress, before.OPEN_MRI.inProgress);
  for (const m of Object.keys(after)) assert.equal(after[m].total, after[m].queued + after[m].inProgress);
});

test('the load label follows config.js thresholds (default: Quiet < 3, Busy < 6, else Very busy)', async () => {
  const { config } = await import('../server/config.js');
  const { busyAt, veryBusyAt } = config.loadThresholds;
  for (let i = 0; i < veryBusyAt; i++) await create('XR-CHEST'); // pushes XR's queued count to at least veryBusyAt
  const xr = (await call('dr_mirant', 'GET', '/api/radiology/load')).body.find((m) => m.modality === 'XR');
  assert.ok(xr.total >= veryBusyAt, `expected XR total >= ${veryBusyAt}, got ${xr.total}`);
  assert.equal(xr.label, 'Very busy');
  assert.ok(busyAt < veryBusyAt);
});
