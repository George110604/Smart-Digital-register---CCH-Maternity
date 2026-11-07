'use strict';
/* Smart Digital Register - front end (vanilla JS, no build step).
 * Offline-first: observations are saved to IndexedDB when the server is unreachable,
 * decision-support alerts are computed locally with the same rules.js used by the server,
 * and the queue is synchronised automatically when the connection returns. */

const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { token: localStorage.getItem('token'), user: JSON.parse(localStorage.getItem('user') || 'null'), tab: 'dashboard' };

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- IndexedDB (offline queue + patient cache) ----------
const idb = {
  db: null,
  open() {
    return new Promise((resolve, reject) => {
      if (this.db) return resolve(this.db);
      const r = indexedDB.open('ward-register', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('queue', { keyPath: 'client_id' });
        r.result.createObjectStore('patients', { keyPath: 'id' });
      };
      r.onsuccess = () => { this.db = r.result; resolve(this.db); };
      r.onerror = () => reject(r.error);
    });
  },
  async tx(store, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode); const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    });
  },
  put(store, v) { return this.tx(store, 'readwrite', (s) => s.put(v)); },
  del(store, k) { return this.tx(store, 'readwrite', (s) => s.delete(k)); },
  all(store) { return this.tx(store, 'readonly', (s) => s.getAll()); },
  clear(store) { return this.tx(store, 'readwrite', (s) => s.clear()); },
};

// ---------- API ----------
class NetError extends Error {}
async function api(path, { method = 'GET', body, raw } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method, headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new NetError('Cannot reach the server'); }
  if (res.status === 401 && state.token) { doLogout(true); throw new Error('Session expired. Please log in again.'); }
  if (raw) { if (!res.ok) throw new Error('Request failed'); return res; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

// ---------- connectivity + sync ----------
function netBadge() {
  const el = $('#netstate'); const on = navigator.onLine;
  idb.all('queue').then((q) => {
    el.textContent = (on ? 'Online' : 'Offline') + (q.length ? ` \u00b7 ${q.length} waiting` : '');
    el.className = 'pill' + (on ? '' : ' off');
  }).catch(() => {});
}
let syncing = false;
async function syncQueue(quiet) {
  if (syncing || !state.token) return;
  syncing = true;
  try {
    const q = await idb.all('queue');
    let ok = 0, failed = 0;
    for (const item of q) {
      try {
        await api('/api/observations', { method: 'POST', body: { ...item, offline: true } });
        await idb.del('queue', item.client_id); ok++;
      } catch (e) {
        if (e instanceof NetError) break; // still offline, try again later
        if (e.status === 400 || e.status === 404) { item.error = e.message; await idb.put('queue', item); failed++; }
        else break;
      }
    }
    if (ok && !quiet) toast(`${ok} offline record(s) synchronised`);
    if (failed) toast(`${failed} queued record(s) were rejected by the server. See Offline queue.`, 6000);
  } finally { syncing = false; netBadge(); }
}
window.addEventListener('online', () => { netBadge(); syncQueue(); });
window.addEventListener('offline', netBadge);
setInterval(() => { if (navigator.onLine) syncQueue(true); }, 30000);

// ---------- auth + shell ----------
const TABS = {
  dashboard: ['Dashboard', ['admin', 'doctor', 'midwife', 'records']],
  patients: ['Patients', ['admin', 'doctor', 'midwife', 'records']],
  observe: ['New observation', ['admin', 'doctor', 'midwife', 'records']],
  alerts: ['Alerts', ['admin', 'doctor', 'midwife', 'records']],
  queue: ['Offline queue', ['admin', 'doctor', 'midwife', 'records']],
  sus: ['Usability (SUS)', ['admin', 'doctor', 'midwife', 'records']],
  admin: ['Admin', ['admin']],
};
function renderShell() {
  $('#topbar').hidden = !state.user;
  if (!state.user) return;
  $('#who').textContent = `${state.user.name} (${state.user.role})`;
  $('#nav').innerHTML = Object.entries(TABS).filter(([, v]) => v[1].includes(state.user.role))
    .map(([k, v]) => `<button data-tab="${k}" class="${state.tab === k ? 'active' : ''}">${v[0]}</button>`).join('');
  netBadge();
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
$('#logout').addEventListener('click', () => doLogout());
function doLogout(expired) {
  if (state.token && !expired) api('/api/logout', { method: 'POST' }).catch(() => {});
  state.token = null; state.user = null; localStorage.removeItem('token'); localStorage.removeItem('user');
  renderShell(); renderLogin();
}
function renderLogin(msg) {
  view.innerHTML = `<div class="card login"><h2>Log in</h2>
    <form id="lf"><label>Username</label><input name="u" autocomplete="username" required>
    <label style="margin-top:8px">Password</label><input name="p" type="password" autocomplete="current-password" required>
    <p class="error" id="le">${esc(msg || '')}</p><button class="btn">Log in</button></form>
    <p class="muted">Login requires a connection. After you are logged in, observations can be captured offline.</p></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = await api('/api/login', { method: 'POST', body: { username: e.target.u.value, password: e.target.p.value } });
      state.token = d.token; state.user = d.user;
      localStorage.setItem('token', d.token); localStorage.setItem('user', JSON.stringify(d.user));
      renderShell(); go('dashboard'); syncQueue(true);
    } catch (err) { $('#le').textContent = err.message; }
  };
}
function go(tab) { state.tab = tab; renderShell(); (views[tab] || views.dashboard)(); }

// ---------- views ----------
const views = {};
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const val = (v, unit = '') => (v === null || v === undefined ? '' : v + unit);

views.dashboard = async function () {
  view.innerHTML = '<div class="card">Loading...</div>';
  try {
    const s = await api('/api/stats');
    const box = (n, l) => `<div class="stat"><b>${esc(n ?? '-')}</b><span>${l}</span></div>`;
    view.innerHTML = `<div class="card"><h2>Ward dashboard</h2><div class="stats">
      ${box(s.patients, 'Registered patients')}${box(s.observations_today, 'Observations today')}${box(s.observations, 'All observations')}
      ${box(s.alerts_open, 'Open alerts')}${box(s.alerts_critical_open, 'Open critical alerts')}
      ${box(s.completeness_pct === null ? '-' : s.completeness_pct + '%', 'Records with all core fields')}
      ${box(s.median_minutes_to_acknowledge === null ? '-' : s.median_minutes_to_acknowledge + ' min', 'Median time to acknowledge alerts')}
      ${box(s.alerts_overridden, 'Alerts overridden')}${box(s.offline_synced, 'Records captured offline')}
      ${box(s.mean_entry_delay_minutes === null ? '-' : s.mean_entry_delay_minutes + ' min', 'Mean delay: observation to saving')}
    </div><p class="muted">Rule base version ${esc(s.rules_version)}. These indicators support the evaluation in Chapter 4 (completeness, timeliness, alert burden).</p></div>`;
  } catch (e) { view.innerHTML = `<div class="card error">${esc(e.message)}${e instanceof NetError ? ' (offline: dashboard needs a connection)' : ''}</div>`; }
};

async function loadPatients(q = '') {
  try {
    const rows = await api('/api/patients' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!q) { await idb.clear('patients'); for (const p of rows) await idb.put('patients', p); }
    return rows;
  } catch (e) {
    if (!(e instanceof NetError)) throw e;
    const all = await idb.all('patients'); const ql = q.toLowerCase();
    return all.filter((p) => !ql || p.name.toLowerCase().includes(ql) || p.folder_no.toLowerCase().includes(ql));
  }
}

views.patients = async function () {
  view.innerHTML = `<div class="card"><h2>Patients</h2>
    <div class="row"><div style="flex:1"><label>Search by name or folder number</label><input id="q"></div></div>
    <div id="plist" style="margin-top:10px"></div></div>
    <div class="card"><h2>Register a new patient</h2><form id="pf"><div class="grid">
      <div><label>Folder number *</label><input name="folder_no" required></div>
      <div><label>Full name *</label><input name="name" required></div>
      <div><label>Age</label><input name="age" type="number" min="10" max="60"></div>
      <div><label>Gravida</label><input name="gravida" type="number" min="0" max="25"></div>
      <div><label>Parity</label><input name="parity" type="number" min="0" max="25"></div>
      <div><label>Gestation (weeks)</label><input name="gestation_weeks" type="number" min="4" max="45"></div>
      <div><label>Expected delivery date</label><input name="edd" type="date"></div>
      <div><label>Phone</label><input name="phone"></div>
      <div><label>Address</label><input name="address"></div></div>
      <p class="error" id="pe"></p><button class="btn">Save patient</button></form></div>
    <div id="detail"></div>`;
  const draw = async (q) => {
    const rows = await loadPatients(q);
    $('#plist').innerHTML = rows.length ? `<table><tr><th>Folder</th><th>Name</th><th>Age</th><th>Gestation</th><th></th></tr>
      ${rows.map((p) => `<tr><td>${esc(p.folder_no)}</td><td>${esc(p.name)}</td><td>${val(p.age)}</td><td>${val(p.gestation_weeks, ' wks')}</td>
      <td><button class="btn secondary" data-open="${p.id}">Open</button></td></tr>`).join('')}</table>` : '<p class="muted">No patients found.</p>';
  };
  draw('').catch((e) => { $('#plist').innerHTML = `<span class="error">${esc(e.message)}</span>`; });
  let t; $('#q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => draw(e.target.value.trim()), 250); };
  $('#plist').onclick = async (e) => {
    const b = e.target.closest('[data-open]'); if (!b) return;
    try {
      const d = await api('/api/patients/' + b.dataset.open);
      $('#detail').innerHTML = `<div class="card"><h2>${esc(d.patient.name)} <small class="muted">${esc(d.patient.folder_no)}</small></h2>
        <p class="muted">Age ${val(d.patient.age)} \u00b7 G${val(d.patient.gravida)}P${val(d.patient.parity)} \u00b7 ${val(d.patient.gestation_weeks, ' weeks')} \u00b7 EDD ${esc(d.patient.edd || '-')}</p>
        <h3>Observations</h3>${d.observations.length ? `<table><tr><th>When</th><th>Stage</th><th>BP</th><th>Pulse</th><th>Temp</th><th>FHR</th><th>Blood loss</th><th>Newborn</th></tr>
        ${d.observations.map((o) => `<tr><td>${fmt(o.observed_at)}</td><td>${esc(o.stage)}</td><td>${val(o.bp_sys)}${o.bp_sys !== null ? '/' + val(o.bp_dia) : ''}</td>
        <td>${val(o.pulse)}</td><td>${val(o.temp)}</td><td>${val(o.fhr)}</td><td>${val(o.blood_loss, ' ml')}</td>
        <td>${o.stage === 'newborn' ? `${val(o.nb_weight, ' kg')} RR ${val(o.nb_rr)} T ${val(o.nb_temp)}` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">None yet.</p>'}
        <h3>Alerts</h3>${d.alerts.map(alertHtml).join('') || '<p class="muted">None.</p>'}</div>`;
      $('#detail').scrollIntoView({ behavior: 'smooth' });
    } catch (err) { toast(err.message); }
  };
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try { await api('/api/patients', { method: 'POST', body }); e.target.reset(); $('#pe').textContent = ''; toast('Patient saved'); draw(''); }
    catch (err) { $('#pe').textContent = err instanceof NetError ? 'Registering new patients needs a connection.' : err.message; }
  };
};

function alertHtml(a, withActions) {
  return `<div class="alert ${esc(a.severity)}"><span class="sev">${esc(a.severity)}</span>
    ${a.patient_name ? ` \u00b7 <b>${esc(a.patient_name)}</b> (${esc(a.folder_no)})` : ''} \u00b7 ${esc(a.message)}
    <div>${esc(a.action)}</div>
    <div class="muted">${a.created_at ? fmt(a.created_at) : ''}${a.ack_at ? ` \u00b7 ${esc(a.ack_status)} ${fmt(a.ack_at)}${a.ack_reason ? ': ' + esc(a.ack_reason) : ''}` : ''}</div>
    ${withActions && !a.ack_at ? `<div class="actions"><button class="btn" data-ack="${a.id}">Acknowledge</button>
    <button class="btn secondary" data-override="${a.id}">Override with reason</button></div>` : ''}</div>`;
}

views.observe = async function () {
  const patients = await loadPatients('');
  const field = (name, label, step = 'any', min, max) => `<div class="f" data-f="${name}"><label>${label}</label><input name="${name}" type="number" step="${step}" ${min !== undefined ? `min="${min}"` : ''} ${max !== undefined ? `max="${max}"` : ''} inputmode="decimal"></div>`;
  view.innerHTML = `<div class="card"><h2>New observation</h2>
    <form id="of"><div class="grid">
      <div><label>Patient *</label><select name="patient_id" required><option value="">Select...</option>
        ${patients.map((p) => `<option value="${p.id}">${esc(p.folder_no)} - ${esc(p.name)}</option>`).join('')}</select></div>
      <div><label>Stage *</label><select name="stage"><option value="antenatal">Antenatal</option><option value="labour">Labour and delivery</option>
        <option value="postnatal">Postnatal</option><option value="newborn">Newborn</option></select></div>
      <div><label>Time observed</label><input name="observed_at" type="datetime-local"></div></div>
      <h3>Measurements</h3><div class="grid" id="fields">
      ${field('bp_sys', 'BP systolic (mmHg)', 1, 50, 300)}${field('bp_dia', 'BP diastolic (mmHg)', 1, 30, 200)}${field('pulse', 'Pulse (bpm)', 1, 20, 250)}
      ${field('temp', 'Temperature (\u00b0C)', 0.1, 30, 43)}${field('resp', 'Respiratory rate (/min)', 1, 5, 80)}${field('fhr', 'Fetal heart rate (bpm)', 1, 60, 220)}
      ${field('blood_loss', 'Estimated blood loss (ml)', 1, 0, 5000)}
      ${field('nb_weight', 'Newborn weight (kg)', 0.01, 0.3, 6.5)}${field('nb_rr', 'Newborn resp. rate (/min)', 1, 10, 120)}${field('nb_temp', 'Newborn temp (\u00b0C)', 0.1, 30, 42)}</div>
      <div style="margin-top:10px"><label>Notes</label><textarea name="notes" rows="2" maxlength="1000"></textarea></div>
      <p class="muted">During an emergency, treat the patient first. You may enter this record afterwards and set the time observed.</p>
      <p class="error" id="oe"></p><button class="btn">Save and check</button></form></div><div id="result"></div>`;
  const show = () => {
    const s = $('#of').stage.value;
    const maternal = ['antenatal', 'labour', 'postnatal'].includes(s);
    const map = { bp_sys: maternal, bp_dia: maternal, pulse: maternal, temp: maternal, resp: maternal,
      fhr: s === 'antenatal' || s === 'labour', blood_loss: s === 'labour' || s === 'postnatal',
      nb_weight: s === 'newborn', nb_rr: s === 'newborn', nb_temp: s === 'newborn' };
    document.querySelectorAll('#fields .f').forEach((el) => { el.style.display = map[el.dataset.f] ? '' : 'none'; if (!map[el.dataset.f]) el.querySelector('input').value = ''; });
  };
  $('#of').stage.onchange = show; show();
  $('#of').onsubmit = async (e) => {
    e.preventDefault(); $('#oe').textContent = '';
    const f = new FormData(e.target); const o = Object.fromEntries(f.entries());
    o.client_id = (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
    o.observed_at = o.observed_at ? new Date(o.observed_at).toISOString() : new Date().toISOString();
    o.patient_id = Number(o.patient_id);
    for (const k of ['bp_sys', 'bp_dia', 'pulse', 'temp', 'resp', 'fhr', 'blood_loss', 'nb_weight', 'nb_rr', 'nb_temp']) o[k] = o[k] === '' || o[k] === undefined ? null : Number(o[k]);
    if (o.bp_sys !== null && o.bp_dia !== null && o.bp_dia >= o.bp_sys) { $('#oe').textContent = 'Diastolic must be lower than systolic.'; return; }
    const local = Rules.evaluate(o); // immediate, works offline
    let saved = 'server', alerts = local;
    try {
      const r = await api('/api/observations', { method: 'POST', body: o });
      alerts = r.alerts;
    } catch (err) {
      if (err instanceof NetError) { await idb.put('queue', o); saved = 'queue'; netBadge(); }
      else { $('#oe').textContent = err.message; return; }
    }
    $('#result').innerHTML = `<div class="card"><h2>${saved === 'server' ? 'Saved' : 'Saved on this device (offline)'}</h2>
      ${saved === 'queue' ? '<p class="muted">It will upload automatically when the connection returns. Alerts below were computed on this device.</p>' : ''}
      ${alerts.length ? alerts.map((a) => alertHtml(a)).join('') : '<p>No decision-support alerts for these values.</p>'}</div>`;
    e.target.reset(); show();
    if (alerts.some((a) => a.severity === 'critical')) toast('CRITICAL alert: see below', 6000);
  };
};

views.alerts = async function () {
  view.innerHTML = '<div class="card"><h2>Open alerts</h2><div id="al">Loading...</div></div>';
  const draw = async () => {
    try {
      const rows = await api('/api/alerts?status=open');
      $('#al').innerHTML = rows.length ? rows.map((a) => alertHtml(a, ['admin', 'doctor', 'midwife'].includes(state.user.role))).join('') : '<p class="muted">No open alerts.</p>';
    } catch (e) { $('#al').innerHTML = `<span class="error">${esc(e.message)}</span>`; }
  };
  draw();
  $('#al').onclick = async (e) => {
    const a = e.target.closest('[data-ack]'), o = e.target.closest('[data-override]');
    try {
      if (a) { await api(`/api/alerts/${a.dataset.ack}/ack`, { method: 'POST', body: { status: 'acknowledged' } }); toast('Acknowledged'); draw(); }
      if (o) {
        const reason = prompt('Reason for overriding this alert (required):');
        if (!reason) return;
        await api(`/api/alerts/${o.dataset.override}/ack`, { method: 'POST', body: { status: 'overridden', reason } }); toast('Overridden and logged'); draw();
      }
    } catch (err) { toast(err.message); }
  };
};

views.queue = async function () {
  const q = await idb.all('queue');
  view.innerHTML = `<div class="card"><h2>Offline queue</h2>${q.length ? `<table><tr><th>Observed</th><th>Stage</th><th>Patient ID</th><th>Status</th></tr>
    ${q.map((o) => `<tr><td>${fmt(o.observed_at)}</td><td>${esc(o.stage)}</td><td>${o.patient_id}</td><td>${o.error ? `<span class="error">Rejected: ${esc(o.error)}</span> <button class="btn secondary" data-drop="${esc(o.client_id)}">Discard</button>` : 'Waiting to upload'}</td></tr>`).join('')}</table>
    <p><button class="btn" id="syncnow">Sync now</button></p>` : '<p class="muted">Nothing waiting. All records are uploaded.</p>'}</div>`;
  const b = $('#syncnow'); if (b) b.onclick = async () => { await syncQueue(); views.queue(); };
  view.onclick = async (e) => { const d = e.target.closest('[data-drop]'); if (d && confirm('Discard this record permanently?')) { await idb.del('queue', d.dataset.drop); views.queue(); } };
};

const SUS_ITEMS = [
  'I think that I would like to use this system frequently.', 'I found the system unnecessarily complex.', 'I thought the system was easy to use.',
  'I think that I would need the support of a technical person to be able to use this system.', 'I found the various functions in this system were well integrated.',
  'I thought there was too much inconsistency in this system.', 'I would imagine that most people would learn to use this system very quickly.',
  'I found the system very cumbersome to use.', 'I felt very confident using the system.', 'I needed to learn a lot of things before I could get going with this system.'];
views.sus = function () {
  view.innerHTML = `<div class="card"><h2>System Usability Scale</h2><p class="muted">1 = strongly disagree, 5 = strongly agree. Responses are stored per user for the evaluation.</p>
    <form id="sf"><ol class="sus">${SUS_ITEMS.map((t, i) => `<li>${esc(t)}<div class="scale">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="q${i}" value="${n}" required> ${n}</label>`).join('')}</div></li>`).join('')}</ol>
    <button class="btn">Submit</button> <span id="sr"></span></form></div>`;
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const answers = SUS_ITEMS.map((_, i) => Number(new FormData(e.target).get('q' + i)));
    try { const r = await api('/api/sus', { method: 'POST', body: { answers } }); $('#sr').textContent = `Thank you. Your SUS score: ${r.score} / 100`; e.target.reset(); }
    catch (err) { toast(err.message); }
  };
};

views.admin = async function () {
  view.innerHTML = `<div class="card"><h2>Admin</h2><h3>Evaluation data (anonymised CSV for SPSS / SmartPLS)</h3>
    <div class="row">${['observations', 'alerts', 'sus', 'audit'].map((n) => `<button class="btn secondary" data-exp="${n}">Download ${n}.csv</button>`).join('')}</div>
    <div id="susum" class="muted" style="margin-top:10px"></div>
    <h3>Create user</h3><form id="uf" class="grid"><div><label>Username</label><input name="username" required></div><div><label>Full name</label><input name="name" required></div>
      <div><label>Role</label><select name="role"><option>midwife</option><option>doctor</option><option>records</option><option>admin</option></select></div>
      <div><label>Password (8+ chars)</label><input name="password" type="password" minlength="8" required></div>
      <div style="align-self:end"><button class="btn">Create</button></div></form>
    <div id="ulist" style="margin-top:10px"></div>
    <h3>Change my password</h3><form id="cp" class="grid"><div><label>Current</label><input name="current" type="password" required></div>
      <div><label>New (8+ chars)</label><input name="next" type="password" minlength="8" required></div><div style="align-self:end"><button class="btn">Change</button></div></form></div>`;
  const users = async () => { try { const u = await api('/api/users'); $('#ulist').innerHTML = `<table><tr><th>User</th><th>Name</th><th>Role</th></tr>${u.map((x) => `<tr><td>${esc(x.username)}</td><td>${esc(x.name)}</td><td>${esc(x.role)}</td></tr>`).join('')}</table>`; } catch (e) { toast(e.message); } };
  users();
  api('/api/sus/summary').then((s) => { $('#susum').textContent = `SUS responses: ${s.responses}. Mean: ${s.mean ?? '-'} (benchmark ${s.benchmark}).`; }).catch(() => {});
  view.onclick = async (e) => {
    const b = e.target.closest('[data-exp]'); if (!b) return;
    try { const r = await api(`/api/export/${b.dataset.exp}.csv`, { raw: true }); const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = b.dataset.exp + '.csv'; a.click(); URL.revokeObjectURL(a.href); }
    catch (err) { toast(err.message); }
  };
  $('#uf').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) }); e.target.reset(); toast('User created'); users(); } catch (err) { toast(err.message); } };
  $('#cp').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target).entries()) }); e.target.reset(); toast('Password changed'); } catch (err) { toast(err.message); } };
};

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderShell();
if (state.token && state.user) { go('dashboard'); syncQueue(true); } else renderLogin();
