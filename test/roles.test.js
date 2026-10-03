// PKG-M6: role-specific pages and navigation. Server-side slice: the new admin-only staff roster endpoint that backs
// the Administration nav section's Staff Roster screen. (Ward/clinician order visibility, which the Dashboard/New
// request/Orders pages for those roles depend on, is already covered by flow.test.js's ward-isolation test; the nav/
// page split itself lives in web/src/App.jsx and is exercised by hand against a seeded server -- see the package notes.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from '../server/roster.js';

process.env.RIS_DB = ':memory:'; process.env.RIS_DEMO_WEAK_PASSWORDS = '1';
const PW = 'Test#Passw0rd!';
let server, base; const tok = {};

const call = async (who, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok[who] ? { Authorization: 'Bearer ' + tok[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
};
const expectErr = (r, code, status) => { assert.equal(r.body.error, code, JSON.stringify(r.body)); if (status) assert.equal(r.status, status); };

before(async () => {
  const { createServer } = await import('../server/app.js'); const { seedDemo } = await import('../server/seed.js');
  seedDemo(PW);
  server = createServer(); await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  for (const u of ['admin', 'auditor', 'reception1', 'dr_mirant', 'nurse_hdu', 'tech_hardik', 'dr_preety']) {
    const r = await call(null, 'POST', '/api/auth/login', { username: CODE[u], password: PW }); assert.equal(r.status, 200, u); tok[u] = r.body.token;
  }
});
after(() => server.close());

test('staff roster: admin-only, lists every account, never a password field', async () => {
  for (const who of ['auditor', 'reception1', 'dr_mirant', 'nurse_hdu', 'tech_hardik', 'dr_preety']) expectErr(await call(who, 'GET', '/api/staff/roster'), 'FORBIDDEN', 403);
  expectErr(await call(null, 'GET', '/api/staff/roster'), 'UNAUTHENTICATED', 401);

  const r = await call('admin', 'GET', '/api/staff/roster');
  assert.equal(r.status, 200);
  // seedDemo (no --no-traffic) creates only the roster's `base: true` accounts.
  assert.equal(r.body.length, 8, 'every base demo account should be listed');
  assert.ok(r.body.some((u) => u.username === CODE.dr_preety && u.role === 'radiologist' && u.full_name.includes('Preety')));
  const nurse = r.body.find((u) => u.username === CODE.nurse_hdu);
  assert.equal(nurse.ward, 'HDU');
  for (const u of r.body) {
    assert.ok(Object.prototype.hasOwnProperty.call(u, 'active'));
    assert.equal(u.password_hash, undefined); assert.equal(u.password_salt, undefined);
  }
});
