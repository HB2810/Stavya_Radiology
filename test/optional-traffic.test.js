import { test } from 'node:test';
import assert from 'node:assert/strict';
import { login } from '../server/auth.js';
import { createCase } from '../server/cases.js';
import { getTrafficOptions, updateTrafficOptions } from '../server/traffic.js';
import { db } from '../server/db.js';
import { ensureRosterUsers } from '../server/ensure-roster.js';

const pw = process.env.RIS_DEMO_PASSWORD || 'StavyaDemo2026';
ensureRosterUsers(pw);
const admin = () => login('901', pw).user;
const rec = () => login('301', pw).user;

test('traffic options master switch turns tokens and auto-queue off', () => {
  const a = admin();
  const before = getTrafficOptions();
  assert.equal(typeof before.tokenEnabled, 'boolean');

  updateTrafficOptions({ trafficSystemEnabled: false }, a);
  const off = getTrafficOptions();
  assert.equal(off.tokenEnabled, false);
  assert.equal(off.autoTrafficEnabled, false);
  assert.equal(off.trafficSystemEnabled, false);

  const patient = db.prepare('SELECT id FROM patients LIMIT 1').get();
  const c = createCase({
    patientId: patient.id,
    channelCode: 'WALKIN',
    clinicalIndication: 'Optional traffic off test case',
    modalities: ['XR'],
    priority: 'ROUTINE'
  }, rec());
  const mod = c.modalities.find((m) => m.modality === 'XR');
  assert.equal(mod.token_no, null);

  // restore on for other tests
  updateTrafficOptions({ trafficSystemEnabled: true }, a);
  const on = getTrafficOptions();
  assert.equal(on.tokenEnabled, true);
  assert.equal(on.autoTrafficEnabled, true);
});

test('token-only vs auto-only can be set separately', () => {
  const a = admin();
  updateTrafficOptions({ tokenEnabled: true, autoTrafficEnabled: false }, a);
  let o = getTrafficOptions();
  assert.equal(o.tokenEnabled, true);
  assert.equal(o.autoTrafficEnabled, false);

  updateTrafficOptions({ tokenEnabled: false, autoTrafficEnabled: true }, a);
  o = getTrafficOptions();
  assert.equal(o.tokenEnabled, false);
  assert.equal(o.autoTrafficEnabled, true);

  updateTrafficOptions({ trafficSystemEnabled: true }, a);
});
