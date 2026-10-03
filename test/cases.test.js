// Reception picks CATEGORIES; technician picks SERVICES.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from '../server/roster.js';

process.env.RIS_DB = ':memory:'; process.env.RIS_DEMO_WEAK_PASSWORDS = '1';
const PW = 'Test#Passw0rd!';
let server, base, db; const tok = {}; const S = {};

const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};

before(async () => {
  const { createServer } = await import('../server/app.js'); const { seedDemo } = await import('../server/seed.js'); ({ db } = await import('../server/db.js'));
  seedDemo(PW); server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['reception1', 'tech_hardik', 'admin']) {
    const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200); tok[u] = r.body.token;
  }
  S.kavita = db.prepare("SELECT id FROM patients WHERE mrn='SSH-1002'").get().id;
  S.kavEnc = db.prepare("SELECT id FROM encounters WHERE patient_id = ? AND type = 'OPD'").get(S.kavita).id;
});
after(() => server.close());

test('reception opens a multi-category case without choosing services', async () => {
  const r = await call('reception1', 'POST', '/api/cases', {
    patientId: S.kavita, encounterId: S.kavEnc, channelCode: 'OPD_FRONTDESK',
    clinicalIndication: 'Low back and knee pain — CT and MRI needed',
    modalities: ['CT', 'MRI']
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.case_no);
  assert.equal(r.body.modalities.length, 2);
  assert.ok(r.body.modalities.every((m) => m.status === 'AWAITING_PROTOCOL'));
  assert.ok(r.body.modalities.every((m) => m.token_no));
  assert.equal(r.body.orders.length, 0);
  S.caseId = r.body.id;
  S.ctMod = r.body.modalities.find((m) => m.modality === 'CT').id;
  S.mriMod = r.body.modalities.find((m) => m.modality === 'MRI').id;
});

test('technician selects concrete CT services; amounts appear; MRI still awaiting', async () => {
  const svc = await call('tech_hardik', 'GET', '/api/cases/modalities/CT/services');
  assert.equal(svc.status, 200);
  assert.ok(svc.body.length >= 1);
  const codes = svc.body.filter((e) => e.price != null).slice(0, 2).map((e) => e.code);
  assert.ok(codes.length >= 1);

  const r = await call('tech_hardik', 'POST', `/api/case-modalities/${S.ctMod}/protocol`, {
    services: codes.map((examCode) => ({ examCode })),
    confirmDuplicate: true
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.orders.length, codes.length);
  assert.ok(r.body.amount > 0);
  const ct = r.body.modalities.find((m) => m.id === S.ctMod);
  assert.equal(ct.status, 'PROTOCOLLED');
  const mri = r.body.modalities.find((m) => m.id === S.mriMod);
  assert.equal(mri.status, 'AWAITING_PROTOCOL');
});

test('reception cannot protocol services; awaiting list shows MRI', async () => {
  assert.equal((await call('reception1', 'POST', `/api/case-modalities/${S.mriMod}/protocol`, { services: ['MRI-LS'] })).status, 403);
  const list = await call('tech_hardik', 'GET', '/api/cases?awaiting=1');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((c) => c.id === S.caseId && c.modalities.some((m) => m.modality === 'MRI' && m.status === 'AWAITING_PROTOCOL')));
});
