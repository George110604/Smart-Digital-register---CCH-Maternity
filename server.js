'use strict';
/**
 * Smart Digital Register with Clinical Decision Support - backend
 * Zero npm dependencies: uses Node's built-in http, crypto and node:sqlite modules.
 * Requires Node.js 22.13 or newer.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const cors = require('cors');
const Rules = require('./public/rules.js');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'register.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
// Websites allowed to call the API from another address (e.g. a GitHub Pages copy of the frontend).
// Set ALLOWED_ORIGINS on the host as a comma-separated list to change it. Origins only: no path, no trailing slash.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://george110604.github.io,http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map((x) => x.trim()).filter(Boolean);
const corsMiddleware = cors({
  origin: ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','doctor','midwife','records')),
  salt TEXT NOT NULL, hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY, folder_no TEXT UNIQUE NOT NULL, name TEXT NOT NULL, age INTEGER,
  gravida INTEGER, parity INTEGER, gestation_weeks INTEGER, edd TEXT, phone TEXT, address TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY, client_id TEXT UNIQUE NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  stage TEXT NOT NULL CHECK (stage IN ('antenatal','labour','postnatal','newborn')),
  bp_sys REAL, bp_dia REAL, pulse REAL, temp REAL, resp REAL, fhr REAL, blood_loss REAL,
  nb_weight REAL, nb_rr REAL, nb_temp REAL, notes TEXT,
  observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL,
  recorded_by INTEGER REFERENCES users(id), entry_mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, observation_id INTEGER NOT NULL REFERENCES observations(id),
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  rule_id TEXT NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL, action TEXT NOT NULL,
  created_at TEXT NOT NULL, ack_by INTEGER REFERENCES users(id), ack_at TEXT,
  ack_status TEXT, ack_reason TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY, user_id INTEGER, action TEXT NOT NULL, detail TEXT, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sus (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  answers TEXT NOT NULL, score REAL NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_patient ON observations(patient_id);
CREATE INDEX IF NOT EXISTS idx_alert_open ON alerts(ack_at);
`);

// ---------- helpers ----------
const now = () => new Date().toISOString();
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function createUser(username, name, role, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (username,name,role,salt,hash) VALUES (?,?,?,?,?)')
    .run(username, name, role, salt, hashPw(password, salt));
}
function audit(userId, action, detail) {
  db.prepare('INSERT INTO audit (user_id,action,detail,at) VALUES (?,?,?,?)').run(userId ?? null, action, detail ?? null, now());
}
// Seed demo users on first run. CHANGE THESE PASSWORDS before any real use.
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  createUser('admin', 'System Administrator', 'admin', 'admin123');
  createUser('midwife1', 'Demo Midwife', 'midwife', 'midwife123');
  createUser('doctor1', 'Demo Doctor', 'doctor', 'doctor123');
  createUser('records1', 'Demo Records Clerk', 'records', 'records123');
  console.log('Seeded demo users (admin/admin123, midwife1/midwife123, doctor1/doctor123, records1/records123).');
}

const failedLogins = new Map(); // ip -> {count, first}
function tooManyAttempts(ip) {
  const r = failedLogins.get(ip);
  if (!r) return false;
  if (Date.now() - r.first > 10 * 60 * 1000) { failedLogins.delete(ip); return false; }
  return r.count >= 5;
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1e6) { reject(new HttpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const row = db.prepare(`SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id
                          WHERE s.token=? AND s.expires>? AND u.active=1`).get(token, Date.now());
  return row || null;
}
function need(user, ...roles) {
  if (!user) throw new HttpError(401, 'Please log in');
  if (roles.length && !roles.includes(user.role)) throw new HttpError(403, 'Your role is not allowed to do this');
}

// ---------- validation ----------
const LIMITS = {
  bp_sys: [50, 300], bp_dia: [30, 200], pulse: [20, 250], temp: [30, 43], resp: [5, 80],
  fhr: [60, 220], blood_loss: [0, 5000], nb_weight: [0.3, 6.5], nb_rr: [10, 120], nb_temp: [30, 42],
};
function cleanObservation(b) {
  const stages = ['antenatal', 'labour', 'postnatal', 'newborn'];
  if (!stages.includes(b.stage)) throw new HttpError(400, 'Invalid stage');
  if (!b.client_id || typeof b.client_id !== 'string' || b.client_id.length > 80) throw new HttpError(400, 'Missing client_id');
  const o = { stage: b.stage, client_id: b.client_id, patient_id: Number(b.patient_id), notes: String(b.notes || '').slice(0, 1000) };
  if (!Number.isInteger(o.patient_id)) throw new HttpError(400, 'Invalid patient');
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const raw = b[k];
    if (raw === null || raw === undefined || raw === '') { o[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < lo || v > hi) throw new HttpError(400, `${k} must be between ${lo} and ${hi}`);
    o[k] = v;
  }
  if (o.bp_sys !== null && o.bp_dia !== null && o.bp_dia >= o.bp_sys) throw new HttpError(400, 'Diastolic must be lower than systolic');
  const t = Date.parse(b.observed_at);
  const nowMs = Date.now();
  o.observed_at = Number.isFinite(t) && t <= nowMs + 5 * 60 * 1000 ? new Date(t).toISOString() : new Date(nowMs).toISOString();
  return o;
}

// ---------- API routes ----------
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x';

  if (route === 'POST /api/login') {
    if (tooManyAttempts(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in 10 minutes.');
    const { username, password } = await readBody(req);
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(username || ''));
    let ok = false;
    if (u) {
      const a = Buffer.from(hashPw(String(password || ''), u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!ok) {
      const r = failedLogins.get(ip) || { count: 0, first: Date.now() };
      r.count += 1; failedLogins.set(ip, r);
      audit(null, 'login_failed', String(username || '').slice(0, 50));
      throw new HttpError(401, 'Wrong username or password');
    }
    failedLogins.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)').run(token, u.id, Date.now() + 12 * 3600 * 1000);
    audit(u.id, 'login');
    return send(res, 200, { token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
  }

  const user = authUser(req);
  let m0;

  if (route === 'POST /api/logout') {
    need(user);
    db.prepare('DELETE FROM sessions WHERE token=?').run(req.headers.authorization.slice(7));
    audit(user.id, 'logout');
    return send(res, 200, { ok: true });
  }
  if (route === 'GET /api/me') { need(user); return send(res, 200, { user }); }

  if (route === 'POST /api/password') {
    need(user);
    const { current, next } = await readBody(req);
    if (!next || String(next).length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (hashPw(String(current || ''), u.salt) !== u.hash) throw new HttpError(403, 'Current password is wrong');
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(String(next), salt), user.id);
    audit(user.id, 'password_changed');
    return send(res, 200, { ok: true });
  }

  // ----- users (admin) -----
  if (route === 'GET /api/users') {
    need(user, 'admin');
    return send(res, 200, db.prepare('SELECT id,username,name,role,active FROM users ORDER BY id').all());
  }
  if (route === 'POST /api/users') {
    need(user, 'admin');
    const b = await readBody(req);
    if (!/^[a-z0-9._-]{3,30}$/i.test(b.username || '')) throw new HttpError(400, 'Username: 3-30 letters, numbers, . _ -');
    if (!['admin', 'doctor', 'midwife', 'records'].includes(b.role)) throw new HttpError(400, 'Invalid role');
    if (!b.name || !b.password || String(b.password).length < 8) throw new HttpError(400, 'Name and a password of 8+ characters are required');
    try { createUser(b.username, String(b.name).slice(0, 80), b.role, String(b.password)); }
    catch { throw new HttpError(409, 'Username already exists'); }
    audit(user.id, 'user_created', b.username);
    return send(res, 201, { ok: true });
  }

  m0 = url.pathname.match(/^\/api\/users\/(\d+)\/active$/);
  if (m0 && req.method === 'POST') {
    need(user, 'admin');
    const { active } = await readBody(req);
    if (typeof active !== 'boolean') throw new HttpError(400, 'active must be true or false');
    const id = Number(m0[1]);
    const target = db.prepare('SELECT id,username,role,active FROM users WHERE id=?').get(id);
    if (!target) throw new HttpError(404, 'User not found');
    if (!active) {
      if (id === user.id) throw new HttpError(400, 'You cannot deactivate your own account');
      if (target.role === 'admin' && target.active) {
        const otherAdmins = db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND active=1 AND id<>?").get(id).n;
        if (otherAdmins === 0) throw new HttpError(400, 'At least one active admin must remain');
      }
    }
    db.prepare('UPDATE users SET active=? WHERE id=?').run(active ? 1 : 0, id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); // log them out immediately
    audit(user.id, active ? 'user_reactivated' : 'user_deactivated', target.username);
    return send(res, 200, { ok: true });
  }

  // ----- patients -----
  if (route === 'GET /api/patients') {
    need(user);
    const q = (url.searchParams.get('q') || '').trim();
    const rows = q
      ? db.prepare(`SELECT * FROM patients WHERE name LIKE ? OR folder_no LIKE ? ORDER BY id DESC LIMIT 100`).all(`%${q}%`, `%${q}%`)
      : db.prepare('SELECT * FROM patients ORDER BY id DESC LIMIT 200').all();
    return send(res, 200, rows);
  }
  if (route === 'POST /api/patients') {
    need(user, 'admin', 'doctor', 'midwife', 'records');
    const b = await readBody(req);
    const folder = String(b.folder_no || '').trim(), name = String(b.name || '').trim();
    if (!folder || !name) throw new HttpError(400, 'Folder number and name are required');
    const int = (v, lo, hi) => (v === '' || v === null || v === undefined ? null : (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : (() => { throw new HttpError(400, 'Number out of range'); })()));
    try {
      const r = db.prepare(`INSERT INTO patients (folder_no,name,age,gravida,parity,gestation_weeks,edd,phone,address,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(folder.slice(0, 40), name.slice(0, 100), int(b.age, 10, 60), int(b.gravida, 0, 25),
        int(b.parity, 0, 25), int(b.gestation_weeks, 4, 45), b.edd ? String(b.edd).slice(0, 10) : null,
        String(b.phone || '').slice(0, 30), String(b.address || '').slice(0, 200), user.id, now());
      audit(user.id, 'patient_created', folder);
      return send(res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(409, 'A patient with that folder number already exists');
    }
  }
  let m = url.pathname.match(/^\/api\/patients\/(\d+)$/);
  if (m && req.method === 'GET') {
    need(user);
    const p = db.prepare('SELECT * FROM patients WHERE id=?').get(Number(m[1]));
    if (!p) throw new HttpError(404, 'Patient not found');
    const observations = db.prepare('SELECT * FROM observations WHERE patient_id=? ORDER BY observed_at DESC LIMIT 100').all(p.id);
    const alerts = db.prepare('SELECT * FROM alerts WHERE patient_id=? ORDER BY created_at DESC LIMIT 100').all(p.id);
    audit(user.id, 'patient_viewed', p.folder_no);
    return send(res, 200, { patient: p, observations, alerts });
  }

  // ----- observations (idempotent by client_id so offline sync can safely retry) -----
  if (route === 'POST /api/observations') {
    need(user, 'admin', 'doctor', 'midwife', 'records');
    const b = await readBody(req);
    const o = cleanObservation(b);
    if (!db.prepare('SELECT id FROM patients WHERE id=?').get(o.patient_id)) throw new HttpError(404, 'Patient not found');
    const existing = db.prepare('SELECT id FROM observations WHERE client_id=?').get(o.client_id);
    if (existing) {
      const alerts = db.prepare('SELECT * FROM alerts WHERE observation_id=?').all(existing.id);
      return send(res, 200, { id: existing.id, duplicate: true, alerts });
    }
    const recorded = now();
    const mode = b.offline ? 'offline_sync' : 'online';
    const r = db.prepare(`INSERT INTO observations (client_id,patient_id,stage,bp_sys,bp_dia,pulse,temp,resp,fhr,blood_loss,nb_weight,nb_rr,nb_temp,notes,observed_at,recorded_at,recorded_by,entry_mode)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(o.client_id, o.patient_id, o.stage, o.bp_sys, o.bp_dia, o.pulse, o.temp, o.resp, o.fhr,
      o.blood_loss, o.nb_weight, o.nb_rr, o.nb_temp, o.notes, o.observed_at, recorded, user.id, mode);
    const obsId = Number(r.lastInsertRowid);
    const fired = Rules.evaluate(o);
    const ins = db.prepare('INSERT INTO alerts (observation_id,patient_id,rule_id,severity,message,action,created_at) VALUES (?,?,?,?,?,?,?)');
    for (const a of fired) ins.run(obsId, o.patient_id, a.rule_id, a.severity, a.message, a.action, recorded);
    audit(user.id, 'observation_saved', `obs ${obsId} (${mode}), ${fired.length} alert(s)`);
    const alerts = db.prepare('SELECT * FROM alerts WHERE observation_id=?').all(obsId);
    return send(res, 201, { id: obsId, alerts });
  }

  // ----- alerts -----
  if (route === 'GET /api/alerts') {
    need(user);
    const status = url.searchParams.get('status') || 'open';
    const where = status === 'open' ? 'a.ack_at IS NULL' : '1=1';
    const rows = db.prepare(`SELECT a.*, p.name AS patient_name, p.folder_no FROM alerts a JOIN patients p ON p.id=a.patient_id
      WHERE ${where} ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.created_at DESC LIMIT 200`).all();
    return send(res, 200, rows);
  }
  m = url.pathname.match(/^\/api\/alerts\/(\d+)\/ack$/);
  if (m && req.method === 'POST') {
    need(user, 'admin', 'doctor', 'midwife');
    const { status, reason } = await readBody(req);
    if (!['acknowledged', 'overridden'].includes(status)) throw new HttpError(400, 'Status must be acknowledged or overridden');
    if (status === 'overridden' && (!reason || String(reason).trim().length < 3)) throw new HttpError(400, 'A reason is required to override an alert');
    const r = db.prepare('UPDATE alerts SET ack_by=?, ack_at=?, ack_status=?, ack_reason=? WHERE id=? AND ack_at IS NULL')
      .run(user.id, now(), status, reason ? String(reason).slice(0, 300) : null, Number(m[1]));
    if (!r.changes) throw new HttpError(404, 'Alert not found or already handled');
    audit(user.id, 'alert_' + status, 'alert ' + m[1]);
    return send(res, 200, { ok: true });
  }

  // ----- dashboard statistics (evaluation indicators for Chapter 4) -----
  if (route === 'GET /api/stats') {
    need(user);
    const one = (sql, ...p) => db.prepare(sql).get(...p);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const obs = db.prepare('SELECT * FROM observations').all();
    const core = (o) => {
      const need = o.stage === 'newborn' ? ['nb_rr', 'nb_temp', 'nb_weight']
        : o.stage === 'labour' ? ['bp_sys', 'bp_dia', 'pulse', 'temp', 'fhr']
        : o.stage === 'antenatal' ? ['bp_sys', 'bp_dia', 'pulse', 'temp', 'fhr'] : ['bp_sys', 'bp_dia', 'pulse', 'temp'];
      return need.every((k) => o[k] !== null);
    };
    const complete = obs.filter(core).length;
    const acked = db.prepare('SELECT created_at, ack_at, ack_status FROM alerts WHERE ack_at IS NOT NULL').all();
    const mins = acked.map((a) => (Date.parse(a.ack_at) - Date.parse(a.created_at)) / 60000).sort((x, y) => x - y);
    const median = mins.length ? mins[Math.floor(mins.length / 2)] : null;
    const lag = obs.map((o) => (Date.parse(o.recorded_at) - Date.parse(o.observed_at)) / 60000);
    return send(res, 200, {
      patients: one('SELECT COUNT(*) n FROM patients').n,
      observations: obs.length,
      observations_today: one('SELECT COUNT(*) n FROM observations WHERE observed_at>=?', today.toISOString()).n,
      offline_synced: one("SELECT COUNT(*) n FROM observations WHERE entry_mode='offline_sync'").n,
      completeness_pct: obs.length ? Math.round((complete / obs.length) * 1000) / 10 : null,
      alerts_total: one('SELECT COUNT(*) n FROM alerts').n,
      alerts_open: one('SELECT COUNT(*) n FROM alerts WHERE ack_at IS NULL').n,
      alerts_critical_open: one("SELECT COUNT(*) n FROM alerts WHERE ack_at IS NULL AND severity='critical'").n,
      alerts_overridden: one("SELECT COUNT(*) n FROM alerts WHERE ack_status='overridden'").n,
      median_minutes_to_acknowledge: median === null ? null : Math.round(median * 10) / 10,
      mean_entry_delay_minutes: lag.length ? Math.round((lag.reduce((a, b) => a + b, 0) / lag.length) * 10) / 10 : null,
      rules_version: Rules.VERSION,
    });
  }

  // ----- SUS usability questionnaire -----
  if (route === 'POST /api/sus') {
    need(user);
    const { answers } = await readBody(req);
    if (!Array.isArray(answers) || answers.length !== 10 || !answers.every((a) => Number.isInteger(a) && a >= 1 && a <= 5)) throw new HttpError(400, 'Answer all 10 items with 1-5');
    const score = answers.reduce((s, a, i) => s + (i % 2 === 0 ? a - 1 : 5 - a), 0) * 2.5;
    db.prepare('INSERT INTO sus (user_id,answers,score,at) VALUES (?,?,?,?)').run(user.id, JSON.stringify(answers), score, now());
    audit(user.id, 'sus_submitted');
    return send(res, 201, { score });
  }
  if (route === 'GET /api/sus/summary') {
    need(user, 'admin');
    const r = db.prepare('SELECT COUNT(*) n, AVG(score) mean, MIN(score) min, MAX(score) max FROM sus').get();
    return send(res, 200, { responses: r.n, mean: r.mean === null ? null : Math.round(r.mean * 10) / 10, min: r.min, max: r.max, benchmark: 68 });
  }

  // ----- anonymised CSV exports for analysis in SPSS/SmartPLS -----
  m = url.pathname.match(/^\/api\/export\/(observations|alerts|sus|audit)\.csv$/);
  if (m && req.method === 'GET') {
    need(user, 'admin');
    const sql = {
      observations: 'SELECT id,patient_id,stage,bp_sys,bp_dia,pulse,temp,resp,fhr,blood_loss,nb_weight,nb_rr,nb_temp,observed_at,recorded_at,entry_mode FROM observations',
      alerts: 'SELECT id,observation_id,patient_id,rule_id,severity,created_at,ack_at,ack_status FROM alerts',
      sus: 'SELECT id,user_id,answers,score,at FROM sus',
      audit: 'SELECT id,user_id,action,at FROM audit',
    }[m[1]];
    const rows = db.prepare(sql).all();
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    audit(user.id, 'export', m[1]);
    return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${m[1]}.csv"` });
  }

  throw new HttpError(404, 'Not found');
}

// ---------- static files ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
      'Cache-Control': path.basename(file) === 'sw.js' ? 'no-cache' : 'no-cache' };
    res.writeHead(200, headers); res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      // CORS first; for browser pre-checks (OPTIONS) the middleware answers and stops here
      const passed = await new Promise((resolve) => {
        corsMiddleware(req, res, () => resolve(true));
        res.on('finish', () => resolve(false));
      });
      if (passed) await handleApi(req, res, url);
    } else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Smart Digital Register running at http://localhost:${PORT}`));
}
module.exports = { server, db };
