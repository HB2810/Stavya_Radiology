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
  seedDemo(PW); server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['reception1', 'admin', 'dr_mirant']) { const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token; }
  ids.patient = db.prepare("SELECT id FROM patients WHERE mrn = 'SSH-1001'").get().id;
});
after(() => server.close());

test('scheme-based discount: STAFF (100%, requires reason + approval) holds the full amount pending, then approving clears it', async () => {
  expectErr(await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, items: [{ examCode: 'XR-KNEE', schemeId: 'STAFF' }] }), 'FIELD_REQUIRED'); // STAFF requires a written reason
  const r = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, items: [{ examCode: 'XR-KNEE', schemeId: 'STAFF', waiverReason: 'Staff member, verified ID card' }] });
  assert.equal(r.status, 200);
  const line = r.body.lines[0];
  assert.equal(line.discount_pct, 100); assert.equal(line.discount_scheme_id, 'STAFF'); assert.equal(line.final_amount, 0); // applied immediately, billing not blocked
  assert.equal(line.discount_pending, 1); // but flagged pending approval
  assert.equal(r.body.registration.final_total, 0);

  const pending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  assert.equal(pending.status, 200);
  const approval = pending.body.find((a) => a.order_id === line.id);
  assert.ok(approval, 'a PENDING discount_approvals row must exist for the STAFF-discounted line');
  assert.equal(approval.scheme_id, 'STAFF'); assert.equal(approval.pct, 100); assert.equal(approval.reason, 'Staff member, verified ID card');

  expectErr(await call('reception1', 'GET', '/api/discount-approvals'), 'FORBIDDEN', 403);
  expectErr(await call('reception1', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'APPROVED' }), 'FORBIDDEN', 403);

  const approved = await call('admin', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'APPROVED', note: 'ID verified against HR roster' });
  assert.equal(approved.status, 200); assert.equal(approved.body.approval.status, 'APPROVED'); assert.equal(approved.body.order.final_amount, 0); // unchanged by approval, it was already applied

  expectErr(await call('admin', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'APPROVED', note: 'again' }), 'INVALID_STATE', 409);
  const reg2 = await call('reception1', 'GET', `/api/registrations/${r.body.registration.id}`);
  assert.equal(reg2.body.lines.find((l) => l.id === line.id).discount_pending, 0);
});

test('rejecting a pending discount reverts the line to full price and notifies the person who applied it', async () => {
  const r = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'MRI-LS', schemeId: 'STAFF', waiverReason: 'Cousin of a technologist, pending verification' }] });
  const line = r.body.lines[0]; assert.equal(line.final_amount, 0);
  const pending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  const approval = pending.body.find((a) => a.order_id === line.id);

  expectErr(await call('admin', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'REJECTED' }), 'FIELD_REQUIRED'); // rejection needs a reason
  const rejected = await call('admin', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'REJECTED', note: 'Not on the staff roster' });
  assert.equal(rejected.status, 200); assert.equal(rejected.body.approval.status, 'REJECTED');
  assert.equal(rejected.body.order.discount_pct, 0); assert.equal(rejected.body.order.discount_amount, 0);
  assert.equal(rejected.body.order.final_amount, rejected.body.order.base_price); assert.equal(rejected.body.order.discount_scheme_id, null);

  const reg2 = await call('reception1', 'GET', `/api/registrations/${r.body.registration.id}`);
  const line2 = reg2.body.lines.find((l) => l.id === line.id);
  assert.equal(line2.final_amount, line2.base_price); assert.equal(line2.discount_pending, 0);
  assert.equal(reg2.body.registration.final_total, line2.base_price); // the registration total reflects the reverted full price

  const notifs = await call('reception1', 'GET', '/api/notifications');
  assert.ok(notifs.body.some((n) => n.kind === 'DISCOUNT_DECISION' && /rejected/.test(n.text)), 'the person who applied the discount must be notified of the rejection');
});

test('a low-value scheme (NEAREST_RELATIVE, 25%, no approval configured) applies immediately with no pending approval', async () => {
  const r = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'XR-KNEE', schemeId: 'NEAREST_RELATIVE', waiverReason: 'Patient is the registered next of kin' }] });
  assert.equal(r.status, 200); const line = r.body.lines[0];
  assert.equal(line.discount_pct, 25); assert.equal(line.discount_pending, 0);
  const pending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  assert.ok(!pending.body.some((a) => a.order_id === line.id));
});

test('an unknown or inactive scheme is refused; custom % of 50+ (no scheme) still needs a reason and still goes to approval', async () => {
  expectErr(await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, items: [{ examCode: 'XR-KNEE', schemeId: 'NOPE' }] }), 'DISCOUNT_SCHEME_INVALID');
  expectErr(await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'XR-KNEE', discountPct: 60 }] }), 'FIELD_REQUIRED');
  const r = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'XR-KNEE', discountPct: 60, waiverReason: 'Manager approved, verbal' }] });
  assert.equal(r.status, 200); const line = r.body.lines[0];
  assert.equal(line.discount_scheme_id, null); assert.equal(line.discount_pct, 60); assert.equal(line.discount_pending, 1);
  const pending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  const approval = pending.body.find((a) => a.order_id === line.id);
  assert.ok(approval); assert.equal(approval.scheme_id, null);
});

test('invoice editor (updateInvoice): switching an existing line to a scheme creates an approval; non-admin cannot decide', async () => {
  const reg = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'MRI-LS' }] });
  const line = reg.body.lines[0]; assert.equal(line.discount_pending, 0);
  expectErr(await call('reception1', 'POST', `/api/registrations/${reg.body.registration.id}/invoice`, { update: [{ orderId: line.id, schemeId: 'STAFF' }] }), 'FIELD_REQUIRED');
  const upd = await call('reception1', 'POST', `/api/registrations/${reg.body.registration.id}/invoice`, { update: [{ orderId: line.id, schemeId: 'STAFF', waiverReason: 'Family member of radiologist' }] });
  assert.equal(upd.status, 200);
  const updLine = upd.body.lines.find((l) => l.id === line.id);
  assert.equal(updLine.discount_scheme_id, 'STAFF'); assert.equal(updLine.final_amount, 0); assert.equal(updLine.discount_pending, 1);
  const pending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  const approval = pending.body.find((a) => a.order_id === line.id); assert.ok(approval);
  expectErr(await call('dr_mirant', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'APPROVED' }), 'FORBIDDEN', 403);
});
