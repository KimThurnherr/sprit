'use strict';
// sprit - Tankbuch: Betankungen erfassen, Verbrauch und Kosten auswerten.
// Web-App (PWA) mit Google-Login und MCP-Schnittstelle. Keine externen Abhängigkeiten:
// node:http, node:sqlite, node:crypto. Fremdwährungen werden zum Tageskurs (EZB via frankfurter) in CHF umgerechnet.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const calc = require('./lib/calc');

// ---------- Konfiguration ----------
const env = process.env;
const PORT = +(env.PORT || 8080);
const PUBLIC_URL = (env.PUBLIC_URL || 'http://localhost:8080').replace(/\/$/, '');
const DATA_DIR = env.DATA_DIR || path.join(__dirname, 'data');
const TZ = env.TZ || 'Europe/Zurich';
const BASE_CURRENCY = 'CHF';
const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const DEV_LOGIN = env.DEV_LOGIN === '1'; // nur lokal zum Testen
const FX_ENABLED = env.FX_ENABLED !== '0';
const SECURE_COOKIE = PUBLIC_URL.startsWith('https://');
// ALLOWED_USERS="alex:alex@example.com"
const USERS = Object.fromEntries((env.ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(s => s.includes(':')).map(s => {
  const i = s.indexOf(':'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim().toLowerCase()];
}));
const USER_NAMES = Object.fromEntries((env.USER_NAMES || '').split(',').filter(s => s.includes(':')).map(s => s.split(':').map(x => x.trim())).map(([k, v]) => [k.toLowerCase(), v]));
const isUser = (u) => Object.prototype.hasOwnProperty.call(USERS, u);
const nameOf = (u) => USER_NAMES[u] || u;
// MCP_TOKENS="alex:<token>" - ein Token pro Benutzer, mindestens 32 Zeichen
const MCP_TOKENS = (env.MCP_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf(':'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]; }).filter(([u, t]) => isUser(u) && t.length >= 32);
if (!Object.keys(USERS).length) console.warn('WARNUNG: ALLOWED_USERS ist leer, niemand kann sich anmelden.');

const FUELS = { diesel: 'Diesel', benzin95: 'Benzin 95', benzin98: 'Benzin 98', e85: 'E85', lpg: 'LPG', cng: 'CNG', strom: 'Strom (kWh)' };
const CURRENCIES = ['CHF', 'EUR', 'USD', 'GBP', 'CZK', 'PLN', 'HUF', 'DKK', 'SEK', 'NOK', 'HRK', 'RON', 'BGN', 'TRY'];

// ---------- Datenbank ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'sprit.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS vehicles (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, plate TEXT, fuel TEXT NOT NULL DEFAULT 'diesel',
  tank_l REAL, note TEXT, archived INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS vehicles_owner ON vehicles(owner, archived, sort);
CREATE TABLE IF NOT EXISTS fillups (id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL, odometer REAL NOT NULL, liters REAL NOT NULL, price_per_l REAL, total REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'CHF',
  fx_rate REAL, fx_date TEXT, fx_source TEXT, total_chf REAL, full INTEGER NOT NULL DEFAULT 1, missed INTEGER NOT NULL DEFAULT 0,
  station TEXT, country TEXT, note TEXT, created_by TEXT, created_at TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS fillups_vehicle ON fillups(vehicle_id, odometer, date);
CREATE TABLE IF NOT EXISTS fx (currency TEXT NOT NULL, date TEXT NOT NULL, rate REAL NOT NULL, rate_date TEXT, fetched_at TEXT, PRIMARY KEY (currency, date));
`);
const q = (sql) => db.prepare(sql);
const meta = {
  get: (k, d) => { const r = q('SELECT v FROM meta WHERE k=?').get(k); return r ? r.v : d; },
  set: (k, v) => q('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)),
};
let SESSION_SECRET = env.SESSION_SECRET || meta.get('session_secret');
if (!SESSION_SECRET) { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); meta.set('session_secret', SESSION_SECRET); }
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(s, 'base64url');

// ---------- Zeit und Validierung ----------
function today() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
class OpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new OpError(status, msg); };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const num = (v) => { if (v === '' || v == null) return null; const n = typeof v === 'string' ? Number(v.replace(/'/g, '').replace(',', '.')) : Number(v); return Number.isFinite(n) ? n : NaN; };
const bool = (v, d) => v === undefined || v === null || v === '' ? d : (v === true || v === 1 || v === '1' || v === 'true');
const r2 = (n) => n == null ? null : Math.round(n * 100) / 100;
const r3 = (n) => n == null ? null : Math.round(n * 1000) / 1000;

// ---------- Wechselkurse (EZB-Referenzkurse über frankfurter.dev, Wochenende/Feiertag = letzter Kurs davor) ----------
async function fetchRate(currency, date) {
  if (currency === BASE_CURRENCY) return { rate: 1, rate_date: date, source: 'base' };
  const cached = q('SELECT rate, rate_date FROM fx WHERE currency=? AND date=?').get(currency, date);
  if (cached) return { rate: cached.rate, rate_date: cached.rate_date, source: 'ecb' };
  if (!FX_ENABLED) return null;
  const urls = [`https://api.frankfurter.dev/v1/${date}?base=${currency}&symbols=${BASE_CURRENCY}`, `https://api.frankfurter.app/${date}?from=${currency}&to=${BASE_CURRENCY}`];
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'sprit' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const rate = j?.rates?.[BASE_CURRENCY];
      if (typeof rate === 'number' && rate > 0) {
        q('INSERT INTO fx(currency,date,rate,rate_date,fetched_at) VALUES(?,?,?,?,?) ON CONFLICT(currency,date) DO UPDATE SET rate=excluded.rate, rate_date=excluded.rate_date, fetched_at=excluded.fetched_at')
          .run(currency, date, rate, j.date || date, new Date().toISOString());
        return { rate, rate_date: j.date || date, source: 'ecb' };
      }
    } catch (e) { console.warn('Kursabfrage fehlgeschlagen', currency, date, e.message); }
  }
  return null;
}
// Fehlende CHF-Beträge nachholen (z.B. wenn der Kursdienst beim Erfassen nicht erreichbar war)
async function fillMissingRates() {
  for (const f of q("SELECT id, date, currency, total FROM fillups WHERE total_chf IS NULL").all()) {
    if (f.date > today()) continue;
    const fx = await fetchRate(f.currency, f.date);
    if (fx) q('UPDATE fillups SET fx_rate=?, fx_date=?, fx_source=?, total_chf=? WHERE id=? AND total_chf IS NULL').run(fx.rate, fx.rate_date, fx.source, r2(f.total * fx.rate), f.id);
  }
}

// ---------- Fahrzeuge ----------
const vehicleRow = (r) => r && ({ id: r.id, name: r.name, plate: r.plate || '', fuel: r.fuel, fuel_label: FUELS[r.fuel] || r.fuel, tank_l: r.tank_l, note: r.note || '', archived: !!r.archived });
function getVehicle(user, id) {
  const r = q('SELECT * FROM vehicles WHERE id=? AND owner=?').get(Number(id), user);
  if (!r) fail(404, 'Fahrzeug nicht gefunden');
  return r;
}
function cleanVehicle(b, old = {}) {
  const o = {
    name: b.name !== undefined ? str(b.name, 80) : old.name,
    plate: b.plate !== undefined ? str(b.plate, 20).toUpperCase() : (old.plate || ''),
    fuel: b.fuel !== undefined ? str(b.fuel, 20).toLowerCase() : (old.fuel || 'diesel'),
    tank_l: b.tank_l !== undefined ? num(b.tank_l) : (old.tank_l ?? null),
    note: b.note !== undefined ? str(b.note, 500) : (old.note || ''),
    archived: b.archived !== undefined ? (bool(b.archived, false) ? 1 : 0) : (old.archived || 0),
  };
  if (!o.name) fail(400, 'Name fehlt');
  if (!FUELS[o.fuel]) fail(400, 'Ungültiger Treibstoff. Möglich: ' + Object.keys(FUELS).join(', '));
  if (o.tank_l !== null && (Number.isNaN(o.tank_l) || o.tank_l <= 0 || o.tank_l > 2000)) fail(400, 'Ungültiges Tankvolumen');
  return o;
}
const ops = {
  vehicleAdd(user, b) {
    const v = cleanVehicle(b), now = new Date().toISOString();
    const sort = (q('SELECT max(sort) AS m FROM vehicles WHERE owner=?').get(user).m ?? 0) + 1;
    const r = q('INSERT INTO vehicles(owner,name,plate,fuel,tank_l,note,archived,sort,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(user, v.name, v.plate, v.fuel, v.tank_l, v.note, v.archived, sort, now, now);
    return vehicleRow(q('SELECT * FROM vehicles WHERE id=?').get(Number(r.lastInsertRowid)));
  },
  vehicleUpdate(user, id, b) {
    const old = getVehicle(user, id), v = cleanVehicle(b, old);
    q('UPDATE vehicles SET name=?, plate=?, fuel=?, tank_l=?, note=?, archived=?, updated_at=? WHERE id=?').run(v.name, v.plate, v.fuel, v.tank_l, v.note, v.archived, new Date().toISOString(), old.id);
    return vehicleRow(q('SELECT * FROM vehicles WHERE id=?').get(old.id));
  },
  vehicleDelete(user, id) {
    const v = getVehicle(user, id);
    const n = q('SELECT count(*) AS n FROM fillups WHERE vehicle_id=?').get(v.id).n;
    q('DELETE FROM vehicles WHERE id=?').run(v.id);
    return { ok: true, deleted_fillups: n };
  },

  // ---------- Betankungen ----------
  async fillupSave(user, b, id = null) {
    const old = id != null ? q('SELECT f.* FROM fillups f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.id=? AND v.owner=?').get(Number(id), user) : null;
    if (id != null && !old) fail(404, 'Betankung nicht gefunden');
    const pick = (k) => (b[k] !== undefined ? b[k] : old?.[k]);
    const vehicle = getVehicle(user, pick('vehicle_id'));
    const date = pick('date') || today();
    if (!isDate(date)) fail(400, 'Ungültiges Datum (YYYY-MM-DD)');
    if (date > today()) fail(400, 'Datum liegt in der Zukunft');
    const odometer = num(pick('odometer')), liters = num(pick('liters'));
    if (odometer === null || Number.isNaN(odometer) || odometer < 0 || odometer > 5e6) fail(400, 'Ungültiger Kilometerstand');
    if (liters === null || Number.isNaN(liters) || liters <= 0 || liters > 2000) fail(400, 'Ungültige Menge');
    const currency = (str(pick('currency'), 3) || 'CHF').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'Ungültige Währung');
    // Preis: Literpreis und/oder Total. Wird nur eines geändert, das andere neu rechnen.
    let ppl = b.price_per_l !== undefined ? num(b.price_per_l) : null;
    let total = b.total !== undefined ? num(b.total) : null;
    if (Number.isNaN(ppl) || (ppl !== null && (ppl <= 0 || ppl > 1000))) fail(400, 'Ungültiger Literpreis');
    if (Number.isNaN(total) || (total !== null && (total <= 0 || total > 1e6))) fail(400, 'Ungültiger Betrag');
    if (ppl === null && total === null) { if (old) { ppl = b.liters !== undefined ? old.price_per_l : null; total = ppl ? null : old.total; } }
    if (ppl === null && total === null) fail(400, 'Literpreis oder Betrag fehlt');
    if (total === null) total = r2(ppl * liters);
    if (ppl === null) ppl = r3(total / liters);
    const full = bool(pick('full'), true) ? 1 : 0;
    const missed = bool(pick('missed'), false) ? 1 : 0;
    const station = b.station !== undefined ? str(b.station, 120) : (old?.station || '');
    const country = b.country !== undefined ? str(b.country, 2).toUpperCase() : (old?.country || '');
    const note = b.note !== undefined ? str(b.note, 500) : (old?.note || '');

    // CHF-Betrag: manuell (z.B. laut Kreditkartenabrechnung) oder automatisch zum Tageskurs
    let total_chf = null, fx_rate = null, fx_date = null, fx_source = null;
    const manual = b.total_chf !== undefined ? num(b.total_chf) : undefined;
    if (manual !== undefined && manual !== null) {
      if (Number.isNaN(manual) || manual <= 0 || manual > 1e6) fail(400, 'Ungültiger CHF-Betrag');
      total_chf = r2(manual); fx_rate = currency === BASE_CURRENCY ? 1 : Math.round(manual / total * 1e6) / 1e6; fx_date = date; fx_source = currency === BASE_CURRENCY ? 'base' : 'manual';
    } else if (old && manual === undefined && old.fx_source === 'manual' && old.currency === currency && old.total === total) {
      ({ total_chf, fx_rate, fx_date, fx_source } = old);
    } else {
      const fx = await fetchRate(currency, date);
      if (fx) { fx_rate = fx.rate; fx_date = fx.rate_date; fx_source = fx.source; total_chf = r2(total * fx.rate); }
    }
    const now = new Date().toISOString();
    const vals = [vehicle.id, date, odometer, liters, ppl, total, currency, fx_rate, fx_date, fx_source, total_chf, full, missed, station, country, note];
    let fid;
    if (old) { q('UPDATE fillups SET vehicle_id=?, date=?, odometer=?, liters=?, price_per_l=?, total=?, currency=?, fx_rate=?, fx_date=?, fx_source=?, total_chf=?, full=?, missed=?, station=?, country=?, note=?, updated_at=? WHERE id=?').run(...vals, now, old.id); fid = old.id; }
    else fid = Number(q('INSERT INTO fillups(vehicle_id,date,odometer,liters,price_per_l,total,currency,fx_rate,fx_date,fx_source,total_chf,full,missed,station,country,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals, user, now, now).lastInsertRowid);
    const view = vehicleView(user, vehicle.id).fillups.find(f => f.id === fid);
    const warnings = plausibility(vehicle.id, fid);
    if (!view.total_chf) warnings.push('Kein Wechselkurs verfügbar, CHF-Betrag wird später automatisch nachgetragen.');
    return { ...view, warnings };
  },
  fillupDelete(user, id) {
    const f = q('SELECT f.id FROM fillups f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.id=? AND v.owner=?').get(Number(id), user);
    if (!f) fail(404, 'Betankung nicht gefunden');
    q('DELETE FROM fillups WHERE id=?').run(f.id);
    return { ok: true };
  },
};

// Kilometerstand muss mit dem Datum steigen; Menge grösser als Tank ist verdächtig
function plausibility(vehicleId, fid) {
  const w = [];
  const f = q('SELECT * FROM fillups WHERE id=?').get(fid), v = q('SELECT * FROM vehicles WHERE id=?').get(vehicleId);
  const before = q('SELECT date, odometer FROM fillups WHERE vehicle_id=? AND id<>? AND date<? ORDER BY date DESC, odometer DESC LIMIT 1').get(vehicleId, fid, f.date);
  const after = q('SELECT date, odometer FROM fillups WHERE vehicle_id=? AND id<>? AND date>? ORDER BY date, odometer LIMIT 1').get(vehicleId, fid, f.date);
  if (before && before.odometer > f.odometer) w.push(`Kilometerstand ist tiefer als am ${before.date} (${before.odometer} km).`);
  if (after && after.odometer < f.odometer) w.push(`Kilometerstand ist höher als am ${after.date} (${after.odometer} km).`);
  if (q('SELECT 1 FROM fillups WHERE vehicle_id=? AND id<>? AND odometer=?').get(vehicleId, fid, f.odometer)) w.push('Es gibt bereits eine Betankung mit diesem Kilometerstand.');
  if (v.tank_l && f.liters > v.tank_l * 1.05) w.push(`Menge ist grösser als das Tankvolumen (${v.tank_l} l).`);
  return w;
}

// ---------- Auswertung ----------
const loadFillups = (vid) => q('SELECT * FROM fillups WHERE vehicle_id=? ORDER BY odometer, date, id').all(vid);
function vehicleView(user, id, opts = {}) {
  const v = getVehicle(user, id);
  const rows = loadFillups(v.id);
  const res = calc.analyze(rows);
  const stats = calc.summary(res, opts);
  return { vehicle: vehicleRow(v), stats, fillups: res.slice().reverse() };
}
function overview(user) {
  return q('SELECT * FROM vehicles WHERE owner=? ORDER BY archived, sort, id').all(user).map(v => {
    const res = calc.analyze(loadFillups(v.id));
    const s = calc.summary(res);
    return { ...vehicleRow(v), avg_l_100km: s.avg_l_100km, last_l_100km: s.last_l_100km, odometer: s.last_odometer, fillups: s.fillups, total_liters: s.total_liters, total_chf: s.total_chf, last_date: s.last_date };
  });
}

// ---------- Session ----------
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url'); }
function makeSession(user) { const v = b64u(JSON.stringify({ u: user, exp: Date.now() + 90 * 864e5 })); return v + '.' + sign(v); }
function parseCookies(req) { const o = {}; for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } return o; }
function readSession(req) {
  const c = parseCookies(req).sprit_session; if (!c) return null;
  const [v, s] = c.split('.'); if (!v || !s) return null;
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(fromB64u(v)); if (d.exp < Date.now() || !isUser(d.u)) return null; return d.u; } catch { return null; }
}
function cookie(name, val, maxAge) { return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`; }

// ---------- HTTP-Helfer ----------
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://accounts.google.com",
};
if (SECURE_COOKIE) SEC_HEADERS['Strict-Transport-Security'] = 'max-age=31536000';
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function redirect(res, loc, extra = {}) { res.writeHead(302, { Location: loc, ...SEC_HEADERS, ...extra }); res.end(); }
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}
const rl = new Map();
function rateLimited(key, limit, windowMs) { const now = Date.now(); const e = rl.get(key) || { n: 0, t: now }; if (now - e.t > windowMs) { e.n = 0; e.t = now; } e.n++; rl.set(key, e); return e.n > limit; }
setInterval(() => { const now = Date.now(); for (const [k, e] of rl) if (now - e.t > 36e5) rl.delete(k); }, 36e5).unref();

const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'no-cache', ...SEC_HEADERS });
    res.end(buf);
  });
}

// ---------- API für die Web-App ----------
async function api(req, res, user, route, url) {
  const m = req.method;
  const parts = route.split('/');
  if (m !== 'GET' && req.headers['content-type']?.split(';')[0] !== 'application/json') return send(res, 415, { error: 'JSON erwartet' });
  const body = m === 'POST' || m === 'PUT' ? await readBody(req) : {};
  if (route === 'me' && m === 'GET') return send(res, 200, { user, name: nameOf(user), fuels: FUELS, currencies: CURRENCIES, today: today(), mcp: MCP_TOKENS.some(([u]) => u === user) ? PUBLIC_URL + '/mcp' : null });
  if (route === 'vehicles' && m === 'GET') return send(res, 200, overview(user));
  if (route === 'vehicles' && m === 'POST') return send(res, 200, ops.vehicleAdd(user, body));
  if (parts[0] === 'vehicles' && parts[1] && !parts[2]) {
    if (m === 'GET') return send(res, 200, vehicleView(user, parts[1], { from: url.searchParams.get('from'), to: url.searchParams.get('to') }));
    if (m === 'PUT') return send(res, 200, ops.vehicleUpdate(user, parts[1], body));
    if (m === 'DELETE') return send(res, 200, ops.vehicleDelete(user, parts[1]));
  }
  if (route === 'fillups' && m === 'POST') return send(res, 200, await ops.fillupSave(user, body));
  if (parts[0] === 'fillups' && parts[1] && !parts[2]) {
    if (m === 'PUT') return send(res, 200, await ops.fillupSave(user, body, parts[1]));
    if (m === 'DELETE') return send(res, 200, ops.fillupDelete(user, parts[1]));
  }
  if (route === 'fx' && m === 'GET') {
    const c = str(url.searchParams.get('currency'), 3).toUpperCase(), d = url.searchParams.get('date') || today();
    if (!/^[A-Z]{3}$/.test(c) || !isDate(d)) return send(res, 400, { error: 'Ungültige Angaben' });
    return send(res, 200, (await fetchRate(c, d)) || { rate: null });
  }
  return send(res, 404, { error: 'Unbekannt' });
}

// ---------- MCP-Schnittstelle (Streamable HTTP, zustandslos, JSON-RPC 2.0) ----------
function mcpUser(req) {
  const h = String(req.headers.authorization || ''), m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const given = crypto.createHash('sha256').update(m[1].trim()).digest();
  let found = null;
  for (const [u, t] of MCP_TOKENS) { if (crypto.timingSafeEqual(given, crypto.createHash('sha256').update(t).digest())) found = u; }
  return found;
}
const P = (type, description, extra = {}) => ({ type, description, ...extra });
const FILLUP_PROPS = {
  vehicle_id: P('integer', 'ID des Fahrzeugs (siehe list_vehicles)'),
  date: P('string', 'Datum YYYY-MM-DD, Standard heute'),
  odometer: P('number', 'Kilometerstand (Gesamt-km laut Tacho, nicht Tageskilometer)'),
  liters: P('number', 'Getankte Menge in Litern (bei Strom kWh)'),
  price_per_l: P('number', 'Preis pro Liter in der Währung currency. Entweder price_per_l oder total angeben.'),
  total: P('number', 'Bezahlter Betrag in der Währung currency'),
  currency: P('string', 'Währung (ISO, z.B. CHF, EUR). Standard CHF. Fremdwährungen werden zum EZB-Kurs des Tankdatums in CHF umgerechnet.'),
  total_chf: P('number', 'Optional: tatsächlich belasteter CHF-Betrag (z.B. laut Kreditkartenabrechnung), ersetzt die automatische Umrechnung'),
  full: P('boolean', 'Vollgetankt (true, Standard) oder nur teilbetankt (false). Verbrauch wird nur zwischen zwei Volltankungen berechnet.'),
  missed: P('boolean', 'true, wenn vor dieser Betankung eine Betankung nicht erfasst wurde. Dann wird der Verbrauch ab hier neu gemessen.'),
  station: P('string', 'Tankstelle/Ort (optional)'),
  country: P('string', 'Land als ISO-Code, z.B. CH, DE, FR (optional)'),
  note: P('string', 'Notiz (optional)'),
};
const MCP_TOOLS = [
  { name: 'get_overview', description: 'Alle Fahrzeuge mit Durchschnittsverbrauch, letztem Verbrauch, Kilometerstand und Gesamtkosten. Zuerst aufrufen.', inputSchema: { type: 'object', properties: {} }, readOnly: true, run: (u) => ({ today: today(), base_currency: BASE_CURRENCY, vehicles: overview(u) }) },
  { name: 'add_vehicle', description: 'Neues Fahrzeug anlegen.', inputSchema: { type: 'object', properties: { name: P('string', 'Bezeichnung, z.B. Renault Master'), plate: P('string', 'Kontrollschild'), fuel: P('string', 'Treibstoff: ' + Object.keys(FUELS).join(', ')), tank_l: P('number', 'Tankvolumen in Litern (optional, für Plausibilitätsprüfung)'), note: P('string', 'Notiz') }, required: ['name', 'fuel'] }, run: (u, a) => ops.vehicleAdd(u, a) },
  { name: 'update_vehicle', description: 'Fahrzeug ändern (nur angegebene Felder) oder mit archived=true ausblenden.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID des Fahrzeugs'), name: P('string', 'Bezeichnung'), plate: P('string', 'Kontrollschild'), fuel: P('string', 'Treibstoff'), tank_l: P('number', 'Tankvolumen'), note: P('string', 'Notiz'), archived: P('boolean', 'Archiviert') }, required: ['id'] }, run: (u, a) => ops.vehicleUpdate(u, a.id, a) },
  { name: 'list_fillups', description: 'Betankungen eines Fahrzeugs, neueste zuerst, mit gefahrenen km seit der vorherigen Betankung und dem Verbrauch (l/100km) bei Volltankungen.', inputSchema: { type: 'object', properties: { vehicle_id: P('integer', 'ID des Fahrzeugs'), from: P('string', 'Ab Datum YYYY-MM-DD (optional)'), to: P('string', 'Bis Datum YYYY-MM-DD (optional)'), limit: P('integer', 'Anzahl, Standard 50') }, required: ['vehicle_id'] }, readOnly: true, run: (u, a) => {
      const v = vehicleView(u, a.vehicle_id);
      let list = v.fillups;
      if (isDate(a.from)) list = list.filter(f => f.date >= a.from);
      if (isDate(a.to)) list = list.filter(f => f.date <= a.to);
      const lim = Math.min(Math.max(+a.limit || 50, 1), 1000);
      return { vehicle: v.vehicle, fillups: list.slice(0, lim) };
    } },
  { name: 'add_fillup', description: 'Betankung erfassen. Liefert den berechneten Verbrauch und Warnungen (z.B. Kilometerstand nicht plausibel). Bei einem Tankbeleg (Foto) die Werte daraus übernehmen; Kilometerstand steht meist nicht drauf, dann nachfragen.', inputSchema: { type: 'object', properties: FILLUP_PROPS, required: ['vehicle_id', 'odometer', 'liters'] }, run: (u, a) => ops.fillupSave(u, a) },
  { name: 'update_fillup', description: 'Betankung korrigieren (nur angegebene Felder). Wird nur liters geändert, bleibt der Literpreis gleich und das Total wird neu gerechnet.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID der Betankung'), ...FILLUP_PROPS }, required: ['id'] }, run: (u, a) => ops.fillupSave(u, a, a.id) },
  { name: 'delete_fillup', description: 'Betankung löschen.', inputSchema: { type: 'object', properties: { id: P('integer', 'ID der Betankung') }, required: ['id'] }, destructive: true, run: (u, a) => ops.fillupDelete(u, a.id) },
  { name: 'get_stats', description: 'Auswertung eines Fahrzeugs: Durchschnittsverbrauch, bester/schlechtester Wert, Kosten pro km und pro 100 km, Durchschnittspreis pro Liter in CHF, gefahrene km, sowie Werte pro Monat und pro Jahr. Optional auf einen Zeitraum beschränkt.', inputSchema: { type: 'object', properties: { vehicle_id: P('integer', 'ID des Fahrzeugs'), from: P('string', 'Ab Datum YYYY-MM-DD (optional)'), to: P('string', 'Bis Datum YYYY-MM-DD (optional)') }, required: ['vehicle_id'] }, readOnly: true, run: (u, a) => { const v = vehicleView(u, a.vehicle_id, { from: a.from, to: a.to }); return { vehicle: v.vehicle, ...v.stats }; } },
];
const MCP_INSTRUCTIONS = 'sprit ist ein Tankbuch: Betankungen pro Fahrzeug mit Kilometerstand, Menge, Preis und Währung. Rufe zuerst get_overview auf. Der Verbrauch (l/100km) wird nur zwischen zwei Volltankungen berechnet: Teilbetankungen dazwischen werden zur Menge der nächsten Volltankung gezählt. Fremdwährungen werden automatisch zum EZB-Kurs des Tankdatums in CHF umgerechnet; ist der tatsächlich belastete CHF-Betrag bekannt, total_chf angeben. Datumsformat YYYY-MM-DD, Zeitzone ' + TZ + '. Fehlt eine Angabe (v.a. Kilometerstand oder ob vollgetankt), nachfragen statt raten.';
async function handleMcp(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Nur POST' }, undefined, { Allow: 'POST' });
  const user = mcpUser(req);
  if (!user) {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    rateLimited('mcpfail:' + ip, 1e9, 6e5);
    return send(res, 401, { error: 'unauthorized' }, undefined, { 'WWW-Authenticate': 'Bearer' });
  }
  if (rateLimited('mcp:' + user, 120, 6e4)) return send(res, 429, { error: 'Zu viele Anfragen' });
  let body; try { body = await readBody(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const handle = async (msg) => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const isNote = msg.id === undefined;
    const ok = result => isNote ? null : { jsonrpc: '2.0', id: msg.id, result };
    switch (msg.method) {
      case 'initialize': return ok({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sprit', title: 'Tankbuch', version: '1.0.0' }, instructions: MCP_INSTRUCTIONS });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false } })) });
      case 'tools/call': {
        const t = MCP_TOOLS.find(x => x.name === msg.params?.name);
        if (!t) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unbekanntes Werkzeug' } };
        try {
          const out = await t.run(user, msg.params?.arguments || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: Array.isArray(out) ? { items: out } : out });
        } catch (err) {
          if (!(err instanceof OpError)) console.error('MCP-Fehler', t.name, err);
          return ok({ content: [{ type: 'text', text: err instanceof OpError ? err.message : 'Interner Fehler' }], isError: true });
        }
      }
      default:
        if (msg.method.startsWith('notifications/')) return null;
        return isNote ? null : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } };
    }
  };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map(handle))).filter(Boolean);
    return out.length ? send(res, 200, out) : (res.writeHead(202, SEC_HEADERS), res.end());
  }
  const out = await handle(body);
  if (!out) { res.writeHead(202, SEC_HEADERS); return res.end(); }
  return send(res, 200, out);
}

// ---------- Google-Login ----------
const REDIRECT_URI = PUBLIC_URL + '/auth/callback';
function loginStart(res) {
  if (!GOOGLE_CLIENT_ID) return send(res, 500, 'Google-Login ist nicht konfiguriert.', 'text/plain; charset=utf-8');
  const st = crypto.randomBytes(16).toString('hex');
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code', scope: 'openid email', state: st, prompt: 'select_account' });
  redirect(res, u.toString(), { 'Set-Cookie': cookie('sprit_state', st, 600) });
}
async function loginCallback(req, res, url) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  if (rateLimited('login:' + ip, 30, 6e5)) return send(res, 429, 'Zu viele Versuche. Bitte später nochmals.', 'text/plain; charset=utf-8');
  const st = parseCookies(req).sprit_state, code = url.searchParams.get('code');
  if (!st || st !== url.searchParams.get('state') || !code) return redirect(res, '/?login=fehler');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code' }) });
  if (!r.ok) { console.error('Token-Fehler', r.status); return redirect(res, '/?login=fehler'); }
  const tok = await r.json();
  let claims; try { claims = JSON.parse(fromB64u(tok.id_token.split('.')[1])); } catch { return redirect(res, '/?login=fehler'); }
  // id_token kommt direkt von Google über TLS mit Client-Secret: Claims prüfen
  if (claims.aud !== GOOGLE_CLIENT_ID || !['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.exp * 1000 < Date.now() || !claims.email_verified) return redirect(res, '/?login=fehler');
  const email = String(claims.email).toLowerCase();
  const user = Object.keys(USERS).find(k => USERS[k] === email);
  if (!user) { console.warn('Login abgelehnt für', email); return redirect(res, '/?login=nicht-erlaubt', { 'Set-Cookie': cookie('sprit_state', '', 0) }); }
  res.setHeader('Set-Cookie', [cookie('sprit_session', makeSession(user), 90 * 86400), cookie('sprit_state', '', 0)]);
  redirect(res, '/');
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, PUBLIC_URL);
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/mcp') return await handleMcp(req, res);
    if (p === '/auth/login') return loginStart(res);
    if (p === '/auth/callback') return await loginCallback(req, res, url);
    if (p === '/auth/dev' && DEV_LOGIN) { const u = url.searchParams.get('u'); if (isUser(u)) return redirect(res, '/', { 'Set-Cookie': cookie('sprit_session', makeSession(u), 86400) }); }
    if (p === '/auth/logout' && req.method === 'POST') return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': cookie('sprit_session', '', 0) });
    if (p.startsWith('/api/')) {
      const user = readSession(req);
      if (!user) return send(res, 401, { error: 'Nicht angemeldet' });
      try { return await api(req, res, user, p.slice(5).replace(/\/$/, ''), url); }
      catch (e) { if (e instanceof OpError) return send(res, e.status, { error: e.message }); throw e; }
    }
    if (p === '/' || p === '/index.html') return serveStatic(res, 'index.html');
    return serveStatic(res, p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.message === 'too_large' ? 413 : e.message === 'bad_json' ? 400 : 500, { error: 'Fehler' });
  }
});
setInterval(() => fillMissingRates().catch(e => console.error('Kurse', e)), 36e5).unref();
if (require.main === module) server.listen(PORT, () => { console.log(`sprit läuft auf Port ${PORT} (${PUBLIC_URL})`); fillMissingRates().catch(() => {}); });

module.exports = { server, ops, db };
