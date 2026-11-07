// Self-test: node test.js  (starts the server on a temporary database and checks the main behaviour)
process.env.DB_FILE = require('path').join(require('os').tmpdir(), 'register-test-' + Date.now() + '.db');
process.env.PORT = 3999;
const assert = require('node:assert/strict');
const { server } = require('./server.js');
const Rules = require('./public/rules.js');
const base = 'http://localhost:3999';
let token;
const call = async (p, method = 'GET', body, tk = token) => {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; } return { status: r.status, body: j };
};
(async () => {
  await new Promise((r) => server.listen(3999, r));
  // rules
  assert.equal(Rules.evaluate({ stage: 'labour', bp_sys: 170, bp_dia: 112 })[0].rule_id, 'HTN-SEVERE');
  assert.equal(Rules.evaluate({ stage: 'postnatal', blood_loss: 600 })[0].rule_id, 'PPH');
  assert.equal(Rules.evaluate({ stage: 'newborn', nb_rr: 64, nb_temp: 36.0, nb_weight: 2.1 }).length, 3);
  assert.equal(Rules.evaluate({ stage: 'antenatal', bp_sys: 118, bp_dia: 76, pulse: 80, temp: 36.8, fhr: 140 }).length, 0);
  // auth
  assert.equal((await call('/api/patients', 'GET', null, null)).status, 401);
  assert.equal((await call('/api/login', 'POST', { username: 'admin', password: 'bad' }, null)).status, 401);
  let r = await call('/api/login', 'POST', { username: 'midwife1', password: 'midwife123' }, null);
  assert.equal(r.status, 200); token = r.body.token;
  // patient
  r = await call('/api/patients', 'POST', { folder_no: 'T-001', name: 'Test Patient', age: 24, gestation_weeks: 38 });
  assert.equal(r.status, 201); const pid = r.body.id;
  assert.equal((await call('/api/patients', 'POST', { folder_no: 'T-001', name: 'Dup' })).status, 409);
  // observation + alert + idempotency
  const obs = { client_id: 'abc-1', patient_id: pid, stage: 'labour', bp_sys: 165, bp_dia: 112, pulse: 90, temp: 37, fhr: 100, observed_at: new Date(Date.now() - 600000).toISOString(), offline: true };
  r = await call('/api/observations', 'POST', obs);
  assert.equal(r.status, 201); assert.equal(r.body.alerts.length, 2);
  r = await call('/api/observations', 'POST', obs);
  assert.equal(r.status, 200); assert.equal(r.body.duplicate, true);
  assert.equal((await call('/api/observations', 'POST', { ...obs, client_id: 'abc-2', bp_sys: 900 })).status, 400);
  // alerts
  r = await call('/api/alerts'); assert.equal(r.body.length, 2);
  const id = r.body[0].id;
  assert.equal((await call(`/api/alerts/${id}/ack`, 'POST', { status: 'overridden' })).status, 400);
  assert.equal((await call(`/api/alerts/${id}/ack`, 'POST', { status: 'acknowledged' })).status, 200);
  // permissions
  assert.equal((await call('/api/export/observations.csv')).status, 403);
  r = await call('/api/login', 'POST', { username: 'admin', password: 'admin123' }, null);
  const csv = await call('/api/export/observations.csv', 'GET', null, r.body.token);
  assert.equal(csv.status, 200); assert.match(csv.body, /patient_id/);
  // stats + SUS
  r = await call('/api/stats'); assert.equal(r.body.observations, 1); assert.equal(r.body.offline_synced, 1);
  r = await call('/api/sus', 'POST', { answers: [5, 1, 5, 1, 5, 1, 5, 1, 5, 1] }); assert.equal(r.body.score, 100);
  // static + traversal
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/..%2fserver.js')).status === 200, false);
  console.log('ALL TESTS PASSED');
  server.close(); process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
