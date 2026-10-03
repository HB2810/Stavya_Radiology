import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from '../server/roster.js';

process.env.RIS_DB = ':memory:'; process.env.RIS_DEV_OTP = '1'; process.env.RIS_DEMO_WEAK_PASSWORDS = '1';
const PW = 'Test#Passw0rd!';
let server, base, db; const tok = {}; const S = {};
const today = new Date().toISOString().slice(0, 10);

const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const expectErr = (r, code, status) => { assert.equal(r.body.error, code, JSON.stringify(r.body)); if (status) assert.equal(r.status, status); };

before(async () => {
  const { createServer } = await import('../server/app.js'); const { seedDemo } = await import('../server/seed.js'); ({ db } = await import('../server/db.js'));
  seedDemo(PW); server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['dr_preety', 'tech_hardik', 'reception1', 'dr_mirant', 'admin']) { const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200); tok[u] = r.body.token; }
});
after(() => server.close());

test('new patients need a server-verified OTP; codes are single use; identifiers are validated', async () => {
  const { validAadhaar } = await import('../server/registration.js');
  const patient = { firstName: 'Nisha', lastName: 'Shah', dob: '1990-05-04', gender: 'F', phone: '9811111111', address: '12 Ring Road, Ahmedabad', occupation: 'Job', allergy: 'None recorded' };
  expectErr(await call('reception1', 'POST', '/api/registration/patients', patient), 'VERIFICATION_REQUIRED');
  const sent = await call('reception1', 'POST', '/api/registration/otp/send', { channel: 'phone', target: '9811111111' });
  assert.equal(sent.status, 200); assert.match(sent.body.devCode, /^\d{6}$/);
  expectErr(await call('reception1', 'POST', '/api/registration/otp/send', { channel: 'phone', target: '9811111111' }), 'OTP_TOO_SOON', 429);
  expectErr(await call('reception1', 'POST', '/api/registration/otp/verify', { challengeId: sent.body.challengeId, code: sent.body.devCode === '000000' ? '111111' : '000000' }), 'OTP_INVALID');
  // verifying against the wrong number must not work
  expectErr(await call('reception1', 'POST', '/api/registration/patients', { ...patient, phone: '9822222222', verificationId: sent.body.challengeId }), 'VERIFICATION_REQUIRED');
  assert.equal((await call('reception1', 'POST', '/api/registration/otp/verify', { challengeId: sent.body.challengeId, code: sent.body.devCode })).status, 200);
  expectErr(await call('reception1', 'POST', '/api/registration/patients', { ...patient, phone: '12345' , verificationId: sent.body.challengeId }), 'PHONE_INVALID');
  expectErr(await call('reception1', 'POST', '/api/registration/patients', { ...patient, aadhaar: '123456789012', verificationId: sent.body.challengeId }), 'AADHAAR_INVALID');
  expectErr(await call('reception1', 'POST', '/api/registration/patients', { ...patient, occupation: 'Police Man', verificationId: sent.body.challengeId }), 'OCCUPATION_ID_REQUIRED');
  let aad = ''; for (let d = 0; d < 10; d++) if (validAadhaar(`23456789012${d}`)) aad = `23456789012${d}`;
  const ok = await call('reception1', 'POST', '/api/registration/patients', { ...patient, aadhaar: aad, verificationId: sent.body.challengeId, proofs: [{ proofType: 'pan', number: 'ABCDE1234F' }] });
  assert.equal(ok.status, 200); assert.match(ok.body.mrn, /^SSH-\d+$/); assert.equal(ok.body.phone_verified, 1); assert.equal(ok.body.aadhaar_last4, aad.slice(-4)); assert.equal(ok.body.aadhaar_hash, undefined);
  S.patient = ok.body;
  expectErr(await call('reception1', 'POST', '/api/registration/patients', { ...patient, phone: '9833333333', verificationId: sent.body.challengeId }), 'VERIFICATION_REQUIRED'); // consumed
  const byPhone = await call('reception1', 'POST', '/api/registration/lookup', { phone: '9811111111' }); assert.equal(byPhone.body.length, 1); assert.match(byPhone.body[0].phone, /\*\*\*/);
  assert.equal((await call('reception1', 'POST', '/api/registration/lookup', { aadhaar: aad })).body[0].id, S.patient.id);
  assert.equal((await call('dr_mirant', 'POST', '/api/registration/lookup', { phone: '9811111111' })).status, 403);
  assert.equal((await call('reception1', 'GET', '/api/registration/capabilities')).body.aadhaarOtpVerification, false);
});

test('registration prices scans, applies discounts with waiver rules, and totals are computed on the server', async () => {
  const noReason = await call('reception1', 'POST', '/api/registrations', { patientId: S.patient.id, referringDoctor: 'Dr Mehta', items: [{ examCode: 'XR-KNEE', side: 'Left', noCharge: true }] });
  expectErr(noReason, 'FIELD_REQUIRED');
  const r = await call('reception1', 'POST', '/api/registrations', { patientId: S.patient.id, referringDoctor: 'Dr Mehta', items: [
    { examCode: 'MRI-LS', discountPct: 10, indication: 'Low back pain, radiculopathy' }, { examCode: 'XR-KNEE', side: 'Left', noCharge: true, waiverReason: 'Staff family member' }] });
  assert.equal(r.status, 200); S.reg = r.body.registration; S.lines = r.body.lines;
  assert.equal(S.reg.base_total, 7000); assert.equal(S.reg.discount_total, 650 + 500); assert.equal(S.reg.final_total, 5850); assert.equal(S.reg.payment_status, 'pending'); assert.match(S.reg.reg_no, /^REG-\d{4}-\d{6}$/);
  assert.equal((await call('dr_mirant', 'POST', '/api/registrations', { patientId: S.patient.id, items: [{ examCode: 'MRI-LS' }] })).status, 403);
  // duplicate scan for the same side is blocked; other side allowed
  expectErr(await call('reception1', 'POST', '/api/registrations', { patientId: S.patient.id, items: [{ examCode: 'XR-KNEE', side: 'Left' }] }), 'POSSIBLE_DUPLICATE');
  const list = await call('reception1', 'GET', '/api/registrations?date_type=day&equipment=mri'); assert.equal(list.body.length, 1); assert.deepEqual(list.body[0].exams.length, 2);
  const tiles = await call('reception1', 'GET', '/api/dashboard/summary?date_type=day'); assert.equal(tiles.body.total_mri, 1); assert.equal(tiles.body.total_xray, 1); assert.equal(tiles.body.total_radiology_order, 2);
});

test('payments: cash denominations and change, partial payment, cheque in process, online reference reuse', async () => {
  const pay = (b) => call('reception1', 'POST', `/api/registrations/${S.reg.id}/payments`, b);
  expectErr(await pay({ method: 'CASH', amount: 1000, notes: { 500: 1 } }), 'INSUFFICIENT_CASH');
  expectErr(await pay({ method: 'CASH', amount: 1000, notes: { 500: 3 } }), 'CHANGE_MISMATCH'); // 1500 collected, 500 must be returned
  expectErr(await pay({ method: 'CASH', amount: 1000, notes: { 300: 1 } }), 'DENOMINATION_INVALID');
  const cash = await pay({ method: 'CASH', amount: 1000, notes: { 500: 3 }, returnNotes: { 200: 2, 100: 1 } });
  assert.equal(cash.status, 200); assert.equal(cash.body.summary.payment_status, 'partial'); assert.equal(cash.body.summary.pending_amount, 4850); S.cash = cash.body;
  expectErr(await pay({ method: 'CASH', amount: 99999, notes: { 500: 1 } }), 'AMOUNT_TOO_HIGH');
  expectErr(await pay({ method: 'CASH', amount: 100, discount: 50, notes: { 100: 1 } }), 'FIELD_REQUIRED'); // discount needs a reason
  expectErr(await pay({ method: 'CHEQUE', amount: 2000, chequeNumber: '123456', bank: 'HDFC', accountHolder: 'Nisha Shah', ifsc: 'BAD', chequeDate: today, depositDate: today }), 'IFSC_INVALID');
  const chq = await pay({ method: 'CHEQUE', amount: 2000, chequeNumber: '123456', bank: 'HDFC Bank', accountHolder: 'Nisha Shah', ifsc: 'HDFC0001234', chequeDate: today, depositDate: today });
  assert.equal(chq.body.status, 'IN_PROCESS'); assert.equal(chq.body.summary.paid_amount, 1000); assert.equal(chq.body.summary.cheque_in_process, 2000); assert.equal(chq.body.summary.available_to_collect, 2850);
  const online = await pay({ method: 'ONLINE', amount: 1000, gateway: 'UPI', reference: 'UPI-778899' }); assert.equal(online.status, 200);
  expectErr(await pay({ method: 'ONLINE', amount: 100, gateway: 'UPI', reference: 'UPI-778899' }), 'REFERENCE_USED');
  const bounced = await call('reception1', 'POST', `/api/payments/${chq.body.paymentId}/cheque`, { decision: 'BOUNCED' }); expectErr(bounced, 'FIELD_REQUIRED');
  const cleared = await call('reception1', 'POST', `/api/payments/${chq.body.paymentId}/cheque`, { decision: 'CLEARED' });
  assert.equal(cleared.body.summary.paid_amount, 4000); assert.equal(cleared.body.summary.pending_amount, 1850);
  const last = await pay({ method: 'CASH', amount: 1800, discount: 50, discountReason: 'Rounded off by manager', notes: { 500: 4 }, returnNotes: { 200: 1 } });
  assert.equal(last.body.summary.payment_status, 'paid'); assert.equal(last.body.summary.pending_amount, 0);
  expectErr(await pay({ method: 'CASH', amount: 100, notes: { 100: 1 } }), 'PAYMENT_COMPLETE');
  const receipt = await call('reception1', 'GET', `/api/payments/${S.cash.paymentId}/receipt`); assert.match(receipt.body, /RCT-\d{4}-000001/); assert.match(receipt.body, /Cash collected/);
  const inv = await call('reception1', 'GET', `/api/registrations/${S.reg.id}/invoice-print`); assert.match(inv.body, /MRI Lumbosacral/); assert.match(inv.body, /Balance due/);
});

test('refunds need a second person to approve, cannot exceed what was paid, and appear on the balance', async () => {
  const rq = (b) => call('reception1', 'POST', `/api/registrations/${S.reg.id}/refunds`, b);
  expectErr(await rq({ amount: 999999, reason: 'x' }), 'REFUND_TOO_HIGH');
  const r = await rq({ amount: 500, reason: 'Patient declined the knee X-ray' }); assert.equal(r.status, 200); const id = r.body.refundId;
  assert.equal(r.body.summary.refundable, 5300); // 5800 paid, minus the 500 already requested
  expectErr(await call('reception1', 'POST', `/api/refunds/${id}/decision`, { decision: 'APPROVED', note: 'ok' }), 'FORBIDDEN', 403);
  expectErr(await call('admin', 'POST', `/api/refunds/${id}/pay`, { via: 'CASH' }), 'INVALID_STATE');
  assert.equal((await call('admin', 'POST', `/api/refunds/${id}/decision`, { decision: 'APPROVED', note: 'Verified' })).status, 200);
  const paid = await call('reception1', 'POST', `/api/refunds/${id}/pay`, { via: 'CASH' }); assert.equal(paid.status, 200);
  assert.equal(paid.body.summary.paid_amount, 5300); assert.equal(paid.body.summary.pending_amount, 500); assert.equal(paid.body.summary.payment_status, 'partial'); // the scan is still billable
  const reg = await call('reception1', 'GET', `/api/registrations/${S.reg.id}`); assert.equal(reg.body.refunds[0].status, 'PAID');
  expectErr(await call('reception1', 'POST', `/api/registrations/${S.reg.id}/cancel`, { reason: 'Changed mind' }), 'REFUND_FIRST');
});

test('scan consent is modality-driven and moves the patient to Prepared; intake forms validate', async () => {
  const oMri = S.lines.find((l) => l.exam_code === 'MRI-LS'); const oXr = S.lines.find((l) => l.exam_code === 'XR-KNEE');
  const step = (who, id, to, extra = {}) => call(who, 'POST', `/api/orders/${id}/transition`, { to, ...extra });
  for (const o of [oMri, oXr]) { await step('reception1', o.id, 'ACKNOWLEDGED'); await step('reception1', o.id, 'SCHEDULED', { scheduledAt: new Date().toISOString() }); await step('reception1', o.id, 'ARRIVED'); }
  const sc = (id, b) => call('tech_hardik', 'POST', `/api/orders/${id}/scan-consent`, { fullName: 'Nisha Shah', date: today, agree: true, language: 'gu', ...b });
  expectErr(await sc(oXr.id, { contrast: 'CONTRAST' }), 'PLAIN_ONLY');
  expectErr(await sc(oXr.id, { agree: false }), 'AGREE_REQUIRED');
  expectErr(await sc(oXr.id, { date: '2999-01-01' }), 'DATE_INVALID');
  const done = await sc(oXr.id, {}); assert.equal(done.body.prepared, true); assert.equal(done.body.consent.language, 'gu');
  assert.equal((await call('tech_hardik', 'GET', `/api/orders/${oXr.id}`)).body.order.status, 'PREPARED');
  assert.equal((await call('dr_mirant', 'POST', `/api/orders/${oXr.id}/scan-consent`, {})).status, 403);
  const mc = (b) => call('tech_hardik', 'POST', `/api/orders/${oMri.id}/medical-consent`, b);
  expectErr(await mc({ isPregnant: true, monthsPregnant: 12 }), 'PREGNANCY_MONTHS_INVALID');
  expectErr(await mc({ allergiesHas: true }), 'ALLERGY_DETAILS_REQUIRED');
  expectErr(await mc({ medicalDevices: ['Toaster'] }), 'FIELD_INVALID');
  const ok = await mc({ medicalDevices: ['MetalImplants'], medicalHistory: ['HistoryDM'], allergiesHas: true, allergiesDetails: 'Iodine', isPregnant: false, weight: 62, provisionalReport: 'L4-5 disc' });
  assert.deepEqual(ok.body.medicalDevices, ['MetalImplants']);
  const ph = (b) => call('tech_hardik', 'POST', `/api/orders/${oMri.id}/past-history`, b);
  const surg = (await call('tech_hardik', 'GET', '/api/masters/surgery')).body; const lumbar = surg.find((x) => x.name === 'Lumbar');
  const l2 = (await call('tech_hardik', 'GET', `/api/masters/surgery?parent=${lumbar.id}`)).body[0];
  expectErr(await ph({ surgeries: [{ path: [lumbar.id, 9999] }] }), 'SURGERY_INVALID');
  const men = await call('tech_hardik', 'POST', `/api/orders/${oXr.id}/past-history`, { diseases: [{ disease: 'M/H' }] }); assert.equal(men.status, 200); // patient is female
  const hist = await ph({ diseases: [{ disease: 'Diabetes', year: 2015, condition: 'controlled', medicines: ['Metformin'] }, { disease: 'M/H', mhOption: 'Regular' }], surgeries: [{ year: 2019, where: 'Elsewhere', path: [lumbar.id, l2.id] }], otherDisease: { bodyPart: 'Spine', disease: 'Scoliosis' }, notes: 'Hypertensive' });
  assert.equal(hist.status, 200); assert.equal(hist.body.diseases.length, 2);
  // words with a tiny audio clip
  const audio = 'data:audio/webm;base64,' + Buffer.from('fake-webm').toString('base64');
  expectErr(await call('tech_hardik', 'POST', `/api/orders/${oMri.id}/words`, { audio: [{ data: 'data:text/html;base64,AAAA' }] }), 'AUDIO_INVALID');
  const w = await call('tech_hardik', 'POST', `/api/orders/${oMri.id}/words`, { text: 'Pain going down my left leg for 3 weeks', audio: [{ data: audio }] });
  assert.equal(w.body[0].audio.length, 1); const clip = await call('tech_hardik', 'GET', `/api/audio/${w.body[0].audio[0].id}`); assert.equal(clip.body.mime, 'audio/webm');
  const tl = await call('tech_hardik', 'GET', `/api/patients/${S.patient.id}/timeline?module=words`); assert.equal(tl.body.length, 1); assert.equal(tl.body[0].recordings, 1);
  const enc = (await call('tech_hardik', 'GET', `/api/orders/${oMri.id}`)).body.order.encounter_id;
  const sum = await call('tech_hardik', 'GET', `/api/visits/${enc}/summary`); assert.equal(sum.body.orders.length, 2); assert.match(sum.body.words.text, /left leg/);
  const html = await call('tech_hardik', 'GET', `/api/visits/${enc}/summary-print?modules=patientInfo,words,pastHistory`); assert.match(html.body, /Pain going down/); assert.match(html.body, /Diabetes since 2015/); assert.doesNotMatch(html.body, /Radiology orders/);
});

test('journey continues after the report: dispatched, collected; invoice edits; forgot password flow', async () => {
  const oMri = S.lines.find((l) => l.exam_code === 'MRI-LS'); const t = (who, to, extra = {}) => call(who, 'POST', `/api/orders/${oMri.id}/transition`, { to, ...extra });
  await call('tech_hardik', 'POST', `/api/orders/${oMri.id}/scan-consent`, { fullName: 'Nisha Shah', date: today, agree: true, contrast: 'PLAIN' });
  await call('dr_preety', 'POST', `/api/orders/${oMri.id}/safety`, { pregnant: 'NO', contrastAllergy: 'NA', mriImplant: 'NO' });
  assert.equal((await t('tech_hardik', 'IN_PROGRESS')).status, 200); assert.equal((await t('tech_hardik', 'COMPLETED')).status, 200);
  const d = await call('dr_preety', 'POST', `/api/orders/${oMri.id}/report`, { findings: 'Mild L4-5 disc bulge.', impression: 'Mild L4-5 disc bulge.' });
  assert.equal((await call('dr_preety', 'POST', `/api/reports/${d.body.report.id}/sign`, { expectedRevision: 1 })).status, 200);
  assert.equal((await t('tech_hardik', 'DISPATCHED')).status, 403); // reception/radiologist hand over reports
  assert.equal((await t('reception1', 'DISPATCHED')).status, 200); assert.equal((await t('reception1', 'COLLECTED')).status, 200);
  assert.equal((await call('dr_preety', 'POST', `/api/orders/${oMri.id}/addendum`, { reason: 'Clarification', findings: 'No cord compression.' })).status, 200); // addenda still possible
  const inv = await call('reception1', 'POST', `/api/registrations/${S.reg.id}/invoice`, { reportNo: 'RPT-77', update: [{ orderId: oMri.id, discountPct: 60 }] }); expectErr(inv, 'FIELD_REQUIRED');
  const inv2 = await call('reception1', 'POST', `/api/registrations/${S.reg.id}/invoice`, { reportNo: 'RPT-77', update: [{ orderId: oMri.id, discountPct: 60, waiverReason: 'Charity case approved by trustee' }] });
  assert.equal(inv2.body.registration.report_no, 'RPT-77'); assert.equal(inv2.body.registration.final_total, 2600);
  assert.ok(inv2.body.registration.credit_amount > 0); // patient paid more than the new total: needs a refund

  // forgot password: OTP to the phone on the account; unknown numbers get the same answer
  const phone = db.prepare("SELECT phone FROM users WHERE username = ?").get(CODE.dr_mirant).phone;
  const unknown = await call(null, 'POST', '/api/auth/forgot', { phone: '9000000000' }); assert.equal(unknown.body.ok, true); assert.equal(unknown.body.devCode, undefined);
  const f = await call(null, 'POST', '/api/auth/forgot', { phone }); assert.match(f.body.devCode, /^\d{6}$/);
  expectErr(await call(null, 'POST', '/api/auth/reset', { challengeId: f.body.challengeId, code: f.body.devCode, newPassword: '' }), 'PASSWORD_TOO_SHORT');
  const wrong = await call(null, 'POST', '/api/auth/reset', { challengeId: unknown.body.challengeId, code: '123456', newPassword: 'A-new-Password-2026' }); assert.equal(wrong.status, 400);
  assert.equal((await call(null, 'POST', '/api/auth/reset', { challengeId: f.body.challengeId, code: f.body.devCode, newPassword: 'A-new-Password-2026' })).status, 200);
  assert.equal((await call('dr_mirant', 'GET', '/api/auth/me')).status, 401); // old session revoked
  assert.equal((await call(null, 'POST', '/api/auth/login', { username: CODE.dr_mirant, password: PW })).status, 401);
  assert.equal((await call(null, 'POST', '/api/auth/login', { username: CODE.dr_mirant.toLowerCase(), password: 'A-new-Password-2026' })).status, 200);
  assert.equal((await call(null, 'POST', '/api/auth/reset', { challengeId: f.body.challengeId, code: f.body.devCode, newPassword: 'Another-Password-2027' })).body.error, 'OTP_USED'); // single use
});
