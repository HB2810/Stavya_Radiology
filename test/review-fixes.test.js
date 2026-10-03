// Regression tests for three review findings:
//  1. A catalog item with no hospital price yet (price IS NULL) must never be orderable -- it was silently
//     coerced to 0 and billed as free (server/orders.js createOrder).
//  2. An admin must not be able to decide a discount approval they themselves requested (server/discounts.js
//     decideDiscountApproval), mirroring the refund segregation-of-duties rule in billing.js.
//  3. A stale, superseded discount-approval request must not be decidable and must never be able to clobber a
//     later, unrelated discount change on the same order (server/discounts.js createPendingApproval /
//     supersedePendingApprovals, plus orders.js transition on CANCELLED).
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
  const { createUser } = await import('../server/auth.js');
  seedDemo(PW);
  createUser({ username: 'ADMIN2', password: PW, fullName: 'Second Admin', role: 'admin' }); // a second admin, so the segregation-of-duties fix can be exercised by a genuinely different approver
  server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['reception1', 'admin', 'dr_mirant']) { const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token; }
  { const r = await call(null, 'POST', '/api/auth/login', { username: 'ADMIN2', password: PW }); assert.equal(r.status, 200); tok.admin2 = r.body.token; }
  ids.patient = db.prepare("SELECT id FROM patients WHERE mrn = 'SSH-1001'").get().id;
  ids.enc = db.prepare('SELECT id FROM encounters WHERE patient_id = ?').get(ids.patient).id;
  // A real, deterministic unpriced item from the hospital's own sheet (spot-checked in test/masters.test.js too).
  const unpriced = db.prepare("SELECT code FROM exam_catalog WHERE modality = 'DEXA' AND name = 'SPINE' AND active = 1").get();
  assert.ok(unpriced, 'fixture assumption: DEXA SPINE must still be an unpriced, active, imported item');
  ids.unpricedExam = unpriced.code;
});
after(() => server.close());

test('finding 1: an exam with no hospital price yet cannot be ordered through any creation path, and never silently bills as free', async () => {
  const row = db.prepare('SELECT price FROM exam_catalog WHERE code = ?').get(ids.unpricedExam);
  assert.equal(row.price, null);

  // Path A: reception registration wizard (walk-in / EXTERNAL).
  expectErr(await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, items: [{ examCode: ids.unpricedExam }] }), 'EXAM_PRICE_NOT_SET', 400);

  // Path B: a clinician's direct OPD/IPD/OT request.
  expectErr(await call('dr_mirant', 'POST', '/api/orders', { patientId: ids.patient, encounterId: ids.enc, examCode: ids.unpricedExam, clinicalIndication: 'Back pain, assessing bone density' }), 'EXAM_PRICE_NOT_SET', 400);

  // Path C: adding a line to an existing invoice.
  const reg = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'XR-KNEE' }] });
  assert.equal(reg.status, 200);
  expectErr(await call('reception1', 'POST', `/api/registrations/${reg.body.registration.id}/invoice`, { add: [{ examCode: ids.unpricedExam }] }), 'EXAM_PRICE_NOT_SET', 400);

  // No order was ever created for the unpriced exam (so nothing was billed at 0).
  const stray = db.prepare('SELECT COUNT(*) c FROM orders WHERE exam_code = ?').get(ids.unpricedExam).c;
  assert.equal(stray, 0);
});

test('finding 2: an admin cannot decide a discount approval they themselves requested', async () => {
  // The admin role is allowed to apply a discount directly (same STAFF list as reception in resolveDiscount).
  const r = await call('admin', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'XR-KNEE', schemeId: 'STAFF', waiverReason: 'Admin is hospital staff' }] });
  assert.equal(r.status, 200);
  const line = r.body.lines[0]; assert.equal(line.discount_pending, 1);
  const pending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  const approval = pending.body.find((a) => a.order_id === line.id);
  assert.ok(approval); assert.equal(approval.requested_by, db.prepare('SELECT id FROM users WHERE username = ?').get(CODE.admin).id);

  // The same admin who requested it cannot approve it, nor reject it -- segregation of duties.
  expectErr(await call('admin', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'APPROVED' }), 'FORBIDDEN', 403);
  expectErr(await call('admin', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'REJECTED', note: 'self-decision attempt' }), 'FORBIDDEN', 403);

  // It is still genuinely pending (neither decision above took effect).
  const stillPending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  assert.ok(stillPending.body.some((a) => a.id === approval.id));

  // A different admin can decide it legitimately.
  const approved = await call('admin2', 'POST', `/api/discount-approvals/${approval.id}/decision`, { decision: 'APPROVED', note: 'Verified by a different admin' });
  assert.equal(approved.status, 200); assert.equal(approved.body.approval.status, 'APPROVED');
});

test('finding 3: re-editing a line\'s discount supersedes its earlier pending approval, so rejecting the stale request cannot clobber the later, unrelated discount', async () => {
  const reg = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'MRI-LS' }] });
  assert.equal(reg.status, 200); const line = reg.body.lines[0]; const regId = reg.body.registration.id;

  // An 80% custom discount needs approval; it is applied immediately and a PENDING approval A is opened.
  const first = await call('reception1', 'POST', `/api/registrations/${regId}/invoice`, { update: [{ orderId: line.id, discountPct: 80, waiverReason: 'Manager approved, verbal' }] });
  assert.equal(first.status, 200);
  const afterFirst = first.body.lines.find((l) => l.id === line.id);
  assert.equal(afterFirst.discount_pct, 80); assert.equal(afterFirst.discount_pending, 1);
  const pendingA = (await call('admin', 'GET', '/api/discount-approvals?status=PENDING')).body.find((a) => a.order_id === line.id);
  assert.ok(pendingA, 'approval A must be PENDING after the 80% discount');

  // The same line is legitimately revised down to 10%, which needs no approval.
  const second = await call('reception1', 'POST', `/api/registrations/${regId}/invoice`, { update: [{ orderId: line.id, discountPct: 10 }] });
  assert.equal(second.status, 200);
  const afterSecond = second.body.lines.find((l) => l.id === line.id);
  assert.equal(afterSecond.discount_pct, 10); assert.equal(afterSecond.discount_pending, 0); // no longer pending: 10% needs no approval
  assert.equal(afterSecond.final_amount, Math.round(afterSecond.base_price * 0.9 * 100) / 100);

  // Approval A is no longer live -- it must not show up as PENDING, and it cannot be decided.
  const pendingAfter = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  assert.ok(!pendingAfter.body.some((a) => a.id === pendingA.id), 'the stale 80% request must not still be PENDING');
  expectErr(await call('admin', 'POST', `/api/discount-approvals/${pendingA.id}/decision`, { decision: 'REJECTED', note: 'No longer the live request' }), 'INVALID_STATE', 409);

  // Crucially, the order was not reset by that rejected (stale) decision: the 10% discount survives intact.
  const regAfter = await call('reception1', 'GET', `/api/registrations/${regId}`);
  const lineAfter = regAfter.body.lines.find((l) => l.id === line.id);
  assert.equal(lineAfter.discount_pct, 10); assert.equal(lineAfter.final_amount, afterSecond.final_amount);
  assert.equal(regAfter.body.registration.final_total, lineAfter.final_amount);
});

test('finding 3b: cancelling a line supersedes its pending discount approval too', async () => {
  const reg = await call('reception1', 'POST', '/api/registrations', { patientId: ids.patient, confirmDuplicate: true, items: [{ examCode: 'MRI-KNEE', schemeId: 'STAFF', waiverReason: 'Staff member' }] });
  assert.equal(reg.status, 200); const line = reg.body.lines[0]; const regId = reg.body.registration.id;
  const pending = (await call('admin', 'GET', '/api/discount-approvals?status=PENDING')).body.find((a) => a.order_id === line.id);
  assert.ok(pending);

  const removed = await call('reception1', 'POST', `/api/registrations/${regId}/invoice`, { remove: [{ orderId: line.id, reason: 'Patient declined this scan' }] });
  assert.equal(removed.status, 200);

  const stillPending = await call('admin', 'GET', '/api/discount-approvals?status=PENDING');
  assert.ok(!stillPending.body.some((a) => a.id === pending.id), 'a cancelled line\'s pending approval must not remain decidable');
  expectErr(await call('admin', 'POST', `/api/discount-approvals/${pending.id}/decision`, { decision: 'APPROVED', note: 'too late' }), 'INVALID_STATE', 409);
});
