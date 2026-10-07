import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../server/auth.js';
import { createCase, callForAssist, assistTransfer, protocolModality, listCases } from '../server/cases.js';
import { db } from '../server/db.js';
import { ensureRosterUsers } from '../server/ensure-roster.js';

const pw = process.env.RIS_DEMO_PASSWORD || 'StavyaDemo2026';

before(() => {
  ensureRosterUsers(pw);
});

function user(code) {
  return login(code, pw).user;
}

test('assistant then technician: waiting → consent → transfer → sub-services → mid-add', async () => {
  const rec = user('301');
  const assist = user('108');
  const tech = user('102');

  const patient = db.prepare('SELECT id FROM patients LIMIT 1').get();
  assert.ok(patient, 'need a seeded patient');

  const created = createCase({
    patientId: patient.id,
    channelCode: 'WALKIN',
    clinicalIndication: 'Low back pain — assistant/tech lane test',
    modalities: ['MRI'],
    priority: 'ROUTINE'
  }, rec);

  const cmod = created.modalities.find((m) => m.modality === 'MRI');
  assert.equal(cmod.status, 'WAITING');

  // Tech cannot protocol before assistant transfer
  assert.throws(() => protocolModality(cmod.id, { services: [{ examCode: 'MRI-LUMBAR-SPINE', side: 'NA' }], confirmDuplicate: true }, tech), /ASSISTANT_FIRST|assistant/i);

  callForAssist(cmod.id, assist);
  const afterCall = listCases(assist, { assist: '1', open: '1' }).find((c) => c.id === created.id);
  const called = afterCall.modalities.find((m) => m.id === cmod.id);
  assert.equal(called.status, 'AT_ASSISTANT');

  assistTransfer(cmod.id, {
    idVerified: true,
    consentOk: true,
    allergyChecked: true,
    prepDone: true,
    pregnancyAsked: true,
    notes: 'Claustrophobic — open conversation'
  }, assist);

  const ready = listCases(tech, { awaiting: '1', open: '1' }).find((c) => c.id === created.id);
  assert.ok(ready);
  assert.equal(ready.modalities.find((m) => m.id === cmod.id).status, 'AWAITING_PROTOCOL');

  // Pick any active MRI with price
  const exam = db.prepare("SELECT code FROM exam_catalog WHERE modality = 'MRI' AND active = 1 AND price IS NOT NULL LIMIT 1").get();
  assert.ok(exam);
  const proto = protocolModality(cmod.id, { services: [{ examCode: exam.code, side: 'NA' }], confirmDuplicate: true }, tech);
  assert.ok(proto.orders.length >= 1);
  assert.equal(proto.modalities.find((m) => m.id === cmod.id).status, 'PROTOCOLLED');

  const exam2 = db.prepare("SELECT code FROM exam_catalog WHERE modality = 'MRI' AND active = 1 AND price IS NOT NULL AND code != ? LIMIT 1").get(exam.code);
  if (exam2) {
    const added = protocolModality(cmod.id, { services: [{ examCode: exam2.code, side: 'NA' }], confirmDuplicate: true, add: true }, tech);
    assert.ok(added.orders.length >= 2);
  }
});

test('assistant users 108 and 109 exist', () => {
  assert.equal(user('108').role, 'assistant');
  assert.equal(user('109').role, 'assistant');
  assert.equal(user('102').role, 'technologist');
});
