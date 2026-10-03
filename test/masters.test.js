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
const expectErr = (r, code, status) => { assert.equal(r.body.error, code, JSON.stringify(r.body)); if (status) assert.equal(r.status, status); };

before(async () => {
  const { createServer } = await import('../server/app.js'); const { seedDemo } = await import('../server/seed.js'); ({ db } = await import('../server/db.js'));
  const seeded = seedDemo(PW);
  assert.equal(seeded.skipped, false);
  server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['admin', 'reception1', 'dr_mirant']) { const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token; }
  ids.ramesh = db.prepare("SELECT id FROM patients WHERE mrn='SSH-1001'").get().id;
  ids.ramEnc = db.prepare('SELECT id FROM encounters WHERE patient_id=?').get(ids.ramesh).id;
});
after(() => server.close());

test('importer: upserts the real hospital tariff into exam_catalog and the discount schemes, idempotently', async () => {
  const { importMasterData } = await import('../server/import-master.js');
  const before1 = db.prepare("SELECT COUNT(*) c FROM exam_catalog WHERE source = 'HOSPITAL_SHEET'").get().c;
  assert.equal(before1, 188); // every row in the hospital's charge sheet import
  // A known, individually-priced item: spot check against the real sheet, never a fabricated number.
  const lumbar = db.prepare("SELECT * FROM exam_catalog WHERE modality = 'MRI' AND sub_group = 'MRI SPINE' AND name = 'LUMBAR SPINE'").get();
  assert.equal(lumbar.price, 6200); assert.equal(lumbar.online_price, 6000); assert.equal(lumbar.source, 'HOSPITAL_SHEET'); assert.equal(lumbar.active, 1);
  // An item the sheet only gives a generic tariff tier for (priceTierHint) is priced from that tier, not left null.
  const angio = db.prepare("SELECT * FROM exam_catalog WHERE modality = 'CT' AND name = 'ABDOMINAL ANGIO'").get();
  assert.equal(angio.price, 10000); assert.match(angio.price_note, /ANGIO tier/i);
  // An item with genuinely no rate in the sheet stays unpriced (never guessed), but still active for the admin to fill in.
  const unpriced = db.prepare("SELECT * FROM exam_catalog WHERE modality = 'DEXA' AND name = 'SPINE'").get();
  assert.equal(unpriced.price, null); assert.equal(unpriced.active, 1); assert.ok(unpriced.price_note);
  // Modalities the sheet has no coverage for at all keep their old (hand-written) placeholder price, just flagged.
  const noSheet = db.prepare("SELECT * FROM exam_catalog WHERE code = 'USG-ABD'").get();
  assert.equal(noSheet.source, 'PLACEHOLDER'); assert.equal(noSheet.price, 1200); assert.match(noSheet.price_note, /placeholder/i);
  // The hand-written items that DO have modality coverage in the sheet are untouched (still their own hand-picked price).
  const handWritten = db.prepare("SELECT * FROM exam_catalog WHERE code = 'MRI-LS'").get();
  assert.equal(handWritten.source, 'SEED'); assert.equal(handWritten.price, 6500);
  const schemes = db.prepare('SELECT * FROM discount_schemes ORDER BY id').all();
  assert.deepEqual(schemes.map((s) => s.id), ['DISTANT_RELATIVE', 'NEAREST_RELATIVE', 'STAFF']);
  const staff = schemes.find((s) => s.id === 'STAFF');
  assert.equal(staff.value, 100); assert.equal(staff.requires_reason, 1); assert.equal(staff.requires_approval, 1);
  // Re-running is a no-op count-wise (upsert, not insert): same 188 sheet rows, no duplicates.
  importMasterData();
  assert.equal(db.prepare("SELECT COUNT(*) c FROM exam_catalog WHERE source = 'HOSPITAL_SHEET'").get().c, 188);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM exam_catalog').get().c, db.prepare('SELECT COUNT(DISTINCT code) c FROM exam_catalog').get().c);
});

test('admin service CRUD is blocked for non-admin roles; deactivated services disappear from clinician-facing listings but stay in the admin list', async () => {
  expectErr(await call('reception1', 'GET', '/api/masters/services'), 'FORBIDDEN', 403);
  expectErr(await call('dr_mirant', 'POST', '/api/masters/services/MRI-LS/deactivate'), 'FORBIDDEN', 403);

  const before1 = await call('reception1', 'GET', '/api/catalog/exams');
  assert.ok(before1.body.some((e) => e.code === 'MRI-LS'));

  const deact = await call('admin', 'POST', '/api/masters/services/MRI-LS/deactivate');
  assert.equal(deact.status, 200); assert.equal(deact.body.active, 0);

  const after1 = await call('reception1', 'GET', '/api/catalog/exams');
  assert.ok(!after1.body.some((e) => e.code === 'MRI-LS'), 'deactivated service must not appear in the clinician-facing list');

  const adminList = await call('admin', 'GET', '/api/masters/services?active=0');
  assert.ok(adminList.body.some((e) => e.code === 'MRI-LS'), 'deactivated service must still be visible to the admin masters screen');

  // Ordering a deactivated service is refused outright.
  expectErr(await call('dr_mirant', 'POST', '/api/orders', { patientId: ids.ramesh, encounterId: ids.ramEnc, examCode: 'MRI-LS', clinicalIndication: 'test order against a deactivated service' }), 'EXAM_INACTIVE', 400);

  const react = await call('admin', 'POST', '/api/masters/services/MRI-LS/activate');
  assert.equal(react.status, 200); assert.equal(react.body.active, 1);
  assert.ok((await call('reception1', 'GET', '/api/catalog/exams')).body.some((e) => e.code === 'MRI-LS'));
});

test('admin can edit price/subGroup/note but not modality; create generates a stable code; codes cannot collide', async () => {
  const upd = await call('admin', 'POST', '/api/masters/services/MRI-LS', { price: 6800, subGroup: 'MRI SPINE', priceNote: 'Revised tariff' });
  assert.equal(upd.status, 200); assert.equal(upd.body.price, 6800); assert.equal(upd.body.sub_group, 'MRI SPINE');
  // An admin's price edit (the AdminServices masters UI) must be reflected immediately in the clinician-facing catalog -- no caching layer in between.
  const seenByClinicians = await call('reception1', 'GET', '/api/catalog/exams');
  assert.equal(seenByClinicians.body.find((e) => e.code === 'MRI-LS').price, 6800);
  expectErr(await call('admin', 'POST', '/api/masters/services/MRI-LS', { modality: 'CT' }), 'MODALITY_LOCKED', 400);
  expectErr(await call('reception1', 'POST', '/api/masters/services/MRI-LS', { price: 1 }), 'FORBIDDEN', 403);
  expectErr(await call('admin', 'POST', '/api/masters/services/NOPE', { price: 1 }), 'NOT_FOUND', 404);

  const created = await call('admin', 'POST', '/api/masters/services', { modality: 'XR', name: 'Test New Service', price: 500, onlinePrice: 480 });
  assert.equal(created.status, 200); assert.equal(created.body.code, 'XR-TEST-NEW-SERVICE'); assert.equal(created.body.source, 'ADMIN'); assert.equal(created.body.active, 1);
  expectErr(await call('admin', 'POST', '/api/masters/services', { modality: 'XR', code: 'MRI-LS', name: 'Dup' }), 'CODE_IN_USE', 409);
  expectErr(await call('admin', 'POST', '/api/masters/services', { name: 'No modality' }), 'FIELD_REQUIRED', 400);

  const list = await call('admin', 'GET', '/api/masters/services?modality=XR');
  assert.ok(list.body.some((e) => e.code === 'XR-TEST-NEW-SERVICE'));
});

test('discount scheme masters: CRUD, admin-only, 50%+ always requires a reason', async () => {
  // Reception can read (PKG-M3: they pick a scheme at registration/invoice time), but only the active ones, and cannot write.
  const recList = await call('reception1', 'GET', '/api/masters/discounts');
  assert.equal(recList.status, 200); assert.equal(recList.body.length, 3); assert.ok(recList.body.every((s) => s.active === 1));
  expectErr(await call('reception1', 'POST', '/api/masters/discounts', { code: 'X', label: 'x', value: 5 }), 'FORBIDDEN', 403);
  const list = await call('admin', 'GET', '/api/masters/discounts');
  assert.equal(list.status, 200); assert.equal(list.body.length, 3);

  const created = await call('admin', 'POST', '/api/masters/discounts', { code: 'CORPORATE', label: 'Corporate tie-up', value: 15 });
  assert.equal(created.status, 200); assert.equal(created.body.requires_reason, 0); assert.equal(created.body.active, 1);
  expectErr(await call('admin', 'POST', '/api/masters/discounts', { code: 'CORPORATE', label: 'dup', value: 5 }), 'CODE_IN_USE', 409);
  expectErr(await call('admin', 'POST', '/api/masters/discounts', { code: 'BAD', label: 'x', value: 150 }), 'VALUE_INVALID', 400);

  const bumped = await call('admin', 'POST', '/api/masters/discounts/CORPORATE', { value: 60 });
  assert.equal(bumped.status, 200); assert.equal(bumped.body.requires_reason, 1, '60% must force requires_reason on');

  const deact = await call('admin', 'POST', '/api/masters/discounts/CORPORATE/deactivate');
  assert.equal(deact.status, 200); assert.equal(deact.body.active, 0);
  assert.ok(!(await call('reception1', 'GET', '/api/masters/discounts')).body.some((s) => s.id === 'CORPORATE'), 'an inactive scheme must not be offered at the counter');
  const react = await call('admin', 'POST', '/api/masters/discounts/CORPORATE/activate');
  assert.equal(react.status, 200); assert.equal(react.body.active, 1);
  expectErr(await call('dr_mirant', 'POST', '/api/masters/discounts/CORPORATE/activate'), 'FORBIDDEN', 403);
  expectErr(await call('admin', 'POST', '/api/masters/discounts/NOPE', { value: 5 }), 'NOT_FOUND', 404);
});
