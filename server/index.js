/**
 * OSETH telematics API proxy + optional static SPA (production).
 * Legacy OASTH telematics calls are disabled by default and require OASTH_LEGACY_FALLBACK=1.
 */
import express from 'express';
import cors    from 'cors';
import crypto  from 'crypto';
import fs      from 'fs';
import path    from 'path';
import zlib    from 'zlib';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dedupeStopArrivals } from '../src/shared/arrivals/dedupe.js';
import { enrichStopArrivals } from '../src/shared/arrivals/enrichment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const app = express();
app.use(express.json());

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3001;
const BASE = 'https://telematics.oasth.gr';
const OLD_OASTH_GET_STOPS_B = 'https://old.oasth.gr/el/api/getStopsB/?a=1';
const OSETH_BASE = process.env.OSETH_BASE || 'https://oseth.com.gr';
const OSETH_LANGUAGE =
  String(process.env.OSETH_LANGUAGE || 'el').toLowerCase() === 'en' ? 'en' : 'el';
const OSETH_ROUTE_PAGE_SIZE = Number(process.env.OSETH_ROUTE_PAGE_SIZE) || 500;
const OSETH_STOP_PAGE_SIZE = Number(process.env.OSETH_STOP_PAGE_SIZE) || 1000;
const SESSION_REFRESH_MS = 50 * 60 * 1000;
const OASTH_FETCH_TIMEOUT_MS = Number(process.env.OASTH_FETCH_TIMEOUT_MS) || 8_000;
const OASTH_FETCH_RETRIES = Math.max(
  0,
  Number.isFinite(Number(process.env.OASTH_FETCH_RETRIES))
    ? Number(process.env.OASTH_FETCH_RETRIES)
    : 2
);
const OASTH_FETCH_RETRY_BASE_MS =
  Number(process.env.OASTH_FETCH_RETRY_BASE_MS) || 250;

function envFlag(name) {
  return process.env[name] === '1' || String(process.env[name]).toLowerCase() === 'true';
}

const USE_LEGACY_OASTH_FALLBACK = envFlag('OASTH_LEGACY_FALLBACK');

/** Requires `OASTH_LEGACY_FALLBACK=1`; then set `OASTH_LEGACY_ROUTE_POLE_MAP=1` to crawl every route’s `webGetStops`. */
const USE_LEGACY_ROUTE_POLE_MAP =
  USE_LEGACY_OASTH_FALLBACK && envFlag('OASTH_LEGACY_ROUTE_POLE_MAP');
const USE_LEGACY_GET_STOPS_B_POLE_MAP =
  USE_LEGACY_OASTH_FALLBACK && envFlag('OASTH_LEGACY_GET_STOPS_B_POLE_MAP');

const gunzip = promisify(zlib.gunzip);

const PAGE_PASSWORD = String(process.env.PAGE_PASSWORD ?? '').trim();
const PAGE_COOKIE_NAME = 'oasth_page_auth';
const PAGE_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Derived signing key for signed session cookie (stateless; same password ⇒ same key across instances). */
let pageSessionKey = null;
if (PAGE_PASSWORD) {
  pageSessionKey = crypto.createHash('sha256').update(`oasth.page\v1\0${PAGE_PASSWORD}`).digest();
}

function signPageSessionCookie() {
  const payload = JSON.stringify({ exp: Date.now() + PAGE_SESSION_MS });
  const sig = crypto.createHmac('sha256', pageSessionKey).update(payload).digest('base64url');
  const pl = Buffer.from(payload, 'utf8').toString('base64url');
  return `${pl}.${sig}`;
}

function verifyPageSessionCookie(raw) {
  if (!pageSessionKey || !raw || typeof raw !== 'string') return false;
  const dot = raw.indexOf('.');
  if (dot <= 0) return false;
  const plB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let payload;
  try {
    payload = Buffer.from(plB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const expected = crypto.createHmac('sha256', pageSessionKey).update(payload).digest('base64url');
  try {
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return false;
    }
  } catch {
    return false;
  }
  let exp;
  try {
    exp = JSON.parse(payload).exp;
  } catch {
    return false;
  }
  return typeof exp === 'number' && Date.now() < exp;
}

function readPageAuthCookie(req) {
  const h = req.headers.cookie;
  if (!h) return '';
  const parts = h.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx === -1) continue;
    const name = p.slice(0, idx).trim();
    if (name === PAGE_COOKIE_NAME) {
      return decodeURIComponent(p.slice(idx + 1).trim());
    }
  }
  return '';
}

function isPageAuthed(req) {
  if (!PAGE_PASSWORD) return true;
  return verifyPageSessionCookie(readPageAuthCookie(req));
}

function pageAuthPathsOk(req) {
  const p = String(req.path || '').replace(/\/+$/, '') || '/';
  if (p === '/health') return true;
  if (p === '/api/auth/page-status' || p === '/api/auth/page-login' || p === '/api/auth/page-logout') {
    return true;
  }
  return false;
}

if (isProd) {
  app.set('trust proxy', 1);
}

function pagePasswordMatches(given) {
  const g = crypto.createHash('sha256').update(String(given ?? ''), 'utf8').digest();
  const e = crypto.createHash('sha256').update(PAGE_PASSWORD, 'utf8').digest();
  return crypto.timingSafeEqual(g, e);
}

function corsOptions() {
  const raw = process.env.CORS_ORIGIN;
  if (raw) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return { origin: list.length === 1 ? list[0] : list };
  }
  if (isProd) return { origin: false };
  return { origin: true };
}
app.use(cors(corsOptions()));

app.get('/api/auth/page-status', (req, res) => {
  if (!PAGE_PASSWORD) {
    return res.json({ enabled: false, authenticated: true });
  }
  res.json({ enabled: true, authenticated: isPageAuthed(req) });
});

app.post('/api/auth/page-login', (req, res) => {
  if (!PAGE_PASSWORD) {
    return res.status(400).json({ error: 'Page password not configured' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const pw = body.password;
  if (!pagePasswordMatches(pw)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = signPageSessionCookie();
  res.cookie(PAGE_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: PAGE_SESSION_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/auth/page-logout', (_req, res) => {
  res.clearCookie(PAGE_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (!PAGE_PASSWORD || pageAuthPathsOk(req) || isPageAuthed(req)) return next();
  if (req.path.startsWith('/api')) {
    return res.status(401).json({ error: 'Page password required', code: 'PAGE_AUTH_REQUIRED' });
  }
  // Let the SPA render its login gate for non-API requests.
  return next();
});

/* ── Token generation ──────────────────────────────────── */
function getToken() {
  const n = new Date();
  const d = String(n.getFullYear()) +
            String(n.getMonth() + 1).padStart(2, '0') +
            String(n.getDate()).padStart(2, '0');
  const phrase = 'o@sthW38T3l3m@t!c$$-1' + d;
  return crypto.createHash('sha256').update(phrase).digest('hex');
}

/* ── PHP session (PHPSESSID from webGetLangs) ─────────── */
let _sessionCookie = '';
let _sessionExpiresAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const code = String(err.code ?? err.cause?.code ?? '').trim();
  if (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return true;
  }
  const msg = String(err.message ?? '').toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('timed out') ||
    msg.includes('socket hang up') ||
    msg.includes('network')
  );
}

async function oasthFetch(url, options = {}, label = 'OASTH fetch') {
  let lastErr = null;
  for (let attempt = 0; attempt <= OASTH_FETCH_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), OASTH_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        ...options,
        signal: ctrl.signal,
      });
      clearTimeout(timeout);

      if ((res.status === 429 || res.status >= 500) && attempt < OASTH_FETCH_RETRIES) {
        if (!isProd) {
          console.warn(
            `↻ ${label} retry ${attempt + 1}/${OASTH_FETCH_RETRIES} after HTTP ${res.status}`
          );
        }
        await sleep(OASTH_FETCH_RETRY_BASE_MS * (attempt + 1));
        continue;
      }

      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      if (!isRetryableFetchError(err) || attempt >= OASTH_FETCH_RETRIES) {
        throw err;
      }
      if (!isProd) {
        const reason = err.cause?.code || err.code || err.name || 'unknown';
        console.warn(
          `↻ ${label} retry ${attempt + 1}/${OASTH_FETCH_RETRIES} after ${reason}`
        );
      }
      await sleep(OASTH_FETCH_RETRY_BASE_MS * (attempt + 1));
    }
  }
  throw lastErr ?? new Error(`${label} failed`);
}

async function ensureSession() {
  if (_sessionCookie && Date.now() < _sessionExpiresAt) return;

  const res = await oasthFetch(`${BASE}/api/?act=webGetLangs`, {
    method: 'POST',
    headers: { Referer: BASE + '/' },
  }, 'webGetLangs');
  const sc = res.headers.getSetCookie?.() ?? [];
  for (const line of sc) {
    const m = line.match(/PHPSESSID=([^;]+)/);
    if (m) {
      _sessionCookie = 'PHPSESSID=' + m[1];
      _sessionExpiresAt = Date.now() + SESSION_REFRESH_MS;
      if (!isProd) console.log('✅ Session established via webGetLangs');
      return;
    }
  }
  throw new Error('Failed to obtain PHPSESSID from webGetLangs');
}

/* ── OASTH API helper ─────────────────────────────────── */
async function oasthPost(act, extraHeaders = {}, _retried = false) {
  await ensureSession();

  const res = await oasthFetch(`${BASE}/api/?act=${act}`, {
    method: 'POST',
    headers: { Referer: BASE + '/', Cookie: _sessionCookie, ...extraHeaders },
  }, `act=${act}`);
  const text = await res.text();

  if (res.status === 401 && !_retried) {
    _sessionCookie = '';
    return oasthPost(act, extraHeaders, true);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`OASTH non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, data };
}

function sendError(res, e) {
  const msg = isProd ? 'Internal server error' : e.message;
  res.status(500).json({ error: msg });
}

function osethOnlyError(label, err) {
  const detail = err?.message ? `: ${err.message}` : '';
  return new Error(`${label} unavailable from OSETH and legacy OASTH fallback is disabled${detail}`);
}

/** `webGetLines` is normally a JSON array; accept wrappers / object-maps. */
function coerceWebGetLinesRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.lines)) return raw.lines;
    if (Array.isArray(raw.data)) return raw.data;
    const vals = Object.values(raw);
    if (
      vals.length > 0 &&
      vals.every(
        (v) =>
          v &&
          typeof v === 'object' &&
          ('LineCode' in v ||
            'line_code' in v ||
            'LineDescr' in v ||
            'line_descr' in v)
      )
    ) {
      return vals;
    }
  }
  return [];
}

/** Internal route row → RouteCode string (same fields as the SPA). */
function routeCodeFromOasthRouteRow(r) {
  if (!r || typeof r !== 'object') return '';
  const v =
    r.RouteCode ??
    r.route_code ??
    r.ROUTE_CODE ??
    r.Route_Id ??
    r.route_id;
  return v != null && v !== '' ? String(v).trim() : '';
}

/**
 * `poleId` on `/api/all-stops`: telematics `getAllStops.id` (short) → printed pole number.
 * Default: `old.oasth.gr` gzip `getStopsB` (internal id + publicId per tuple).
 * Legacy: set `OASTH_LEGACY_ROUTE_POLE_MAP=1` to crawl all lines → `webGetStops` instead (kept, not removed).
 */
let stopPoleByShortCode = null;
let getStopsBPoleMapPromise = null;
let legacyStopPoleMapPromise = null;

/**
 * Parse getStopsB body: tuples `(internalId, "publicPoleId", ...)` — see teogramm/oasth RouteStopProcessor.createStops.
 */
function parseGetStopsBToMap(decompressedUtf8) {
  const map = new Map();
  const re = /\((\d+)\s*,\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(decompressedUtf8)) !== null) {
    const internal = m[1];
    const publicId = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    if (internal && publicId) map.set(internal, publicId);
  }
  return map;
}

async function buildStopPoleMapFromGetStopsB() {
  if (stopPoleByShortCode) return stopPoleByShortCode;
  if (!getStopsBPoleMapPromise) {
    getStopsBPoleMapPromise = (async () => {
      const res = await fetch(OLD_OASTH_GET_STOPS_B, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Encoding': 'gzip, deflate',
          Referer: 'https://old.oasth.gr/',
        },
      });
      if (!res.ok) {
        throw new Error(`getStopsB HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      let text;
      try {
        text = (await gunzip(buf)).toString('utf8');
      } catch {
        text = buf.toString('utf8');
      }
      const map = parseGetStopsBToMap(text);
      if (map.size < 100) {
        throw new Error(`getStopsB parse too small (${map.size} entries)`);
      }
      stopPoleByShortCode = map;
      console.log(`✅ Stop pole map (getStopsB): ${map.size} shortCode→pole entries`);
      return map;
    })();
  }
  return getStopsBPoleMapPromise;
}

/** Legacy: all routes × webGetStops. Enable with OASTH_LEGACY_ROUTE_POLE_MAP=1. */
async function buildStopPoleMap() {
  if (stopPoleByShortCode) return stopPoleByShortCode;
  if (!legacyStopPoleMapPromise) {
    legacyStopPoleMapPromise = (async () => {
      const map = new Map();
      const linesRes = await oasthPost('webGetLines');
      const lines = coerceWebGetLinesRows(linesRes.data);
      const routeCodes = new Set();
      for (const line of lines) {
        const lc = line.LineCode ?? line.line_code;
        if (lc == null || String(lc).trim() === '') continue;
        try {
          const p1 = encodeURIComponent(String(lc).trim());
          const rf = await oasthPost(`getRoutesForLine&p1=${p1}`);
          const variants = Array.isArray(rf.data) ? rf.data : [];
          for (const v of variants) {
            const rc = routeCodeFromOasthRouteRow(v);
            if (rc) routeCodes.add(rc);
          }
        } catch {
          /* line list failed */
        }
      }
      const codes = [...routeCodes];
      const BATCH = 6;
      for (let i = 0; i < codes.length; i += BATCH) {
        const chunk = codes.slice(i, i + BATCH);
        await Promise.all(
          chunk.map(async (routeCode) => {
            try {
              const p1 = encodeURIComponent(routeCode);
              const r = await oasthPost(`webGetStops&p1=${p1}`);
              const rows = Array.isArray(r.data) ? r.data : [];
              for (const row of rows) {
                const sc = row.StopCode != null ? String(row.StopCode).trim() : '';
                const sid = row.StopID != null ? String(row.StopID).trim() : '';
                if (sc && sid) map.set(sc, sid);
              }
            } catch {
              /* route failed */
            }
          })
        );
      }
      stopPoleByShortCode = map;
      console.log(
        `✅ Stop pole map (legacy routes): ${map.size} shortCode→pole entries (${codes.length} routes)`
      );
      return map;
    })();
  }
  return legacyStopPoleMapPromise;
}

function enrichAllStopsWithPoleIds(data) {
  const map = stopPoleByShortCode;
  if (!map || !Array.isArray(data)) return data;
  return data.map((s) => {
    const short = s && s.id != null ? String(s.id).trim() : '';
    const pole = short ? map.get(short) : '';
    if (pole && pole !== short) return { ...s, poleId: pole };
    return s;
  });
}

/* ── OSETH API adapter (current public telematics site) ───────────────── */

const OSETH_ROUTE_CODE_SHAPE_SEP = '__shape_';

let osethRoutesCache = null;
let osethRoutesPromise = null;
let osethStopsCache = null;
let osethStopsPromise = null;

function osethHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    Referer: `${OSETH_BASE}/${OSETH_LANGUAGE}/search-bus-schedules`,
    'User-Agent': 'Mozilla/5.0 OASTH-public proxy',
  };
}

function compactLineKey(v) {
  return String(v ?? '')
    .trim()
    .toUpperCase()
    .replace(/^0+(?=\d)/, '');
}

function makeOsethRouteCode(routeId, shapeId) {
  const rid = String(routeId ?? '').trim();
  const sid = String(shapeId ?? '').trim();
  if (!rid || !sid) return rid;
  return `${rid}${OSETH_ROUTE_CODE_SHAPE_SEP}${sid}`;
}

function parseOsethRouteCode(routeCode) {
  const raw = String(routeCode ?? '').trim();
  const idx = raw.lastIndexOf(OSETH_ROUTE_CODE_SHAPE_SEP);
  if (idx <= 0) return null;
  const routeId = raw.slice(0, idx);
  const shapeId = raw.slice(idx + OSETH_ROUTE_CODE_SHAPE_SEP.length);
  if (!routeId || !shapeId) return null;
  return { routeId, shapeId };
}

function formatOsethDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function osethGet(resource, params = {}, label = 'OSETH fetch') {
  const clean = String(resource).replace(/^\/+/, '');
  const url = new URL(`/${OSETH_LANGUAGE}/telematics-api/${clean}`, OSETH_BASE);
  const mergedParams = { language: OSETH_LANGUAGE, ...params };
  for (const [k, v] of Object.entries(mergedParams)) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const res = await oasthFetch(
    url.toString(),
    { method: 'GET', headers: osethHeaders() },
    label
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OSETH non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || (json.status_code && Number(json.status_code) >= 400)) {
    const detail = json.error || json.message || text.slice(0, 200);
    throw new Error(`OSETH ${label} failed (${res.status}): ${detail}`);
  }
  return json.data ?? json;
}

async function fetchOsethRoutes() {
  if (osethRoutesCache) return osethRoutesCache;
  if (!osethRoutesPromise) {
    osethRoutesPromise = (async () => {
      const data = await osethGet(
        'route',
        { page: 1, size: OSETH_ROUTE_PAGE_SIZE },
        'routes'
      );
      const routes = Array.isArray(data.routes) ? data.routes : [];
      osethRoutesCache = routes;
      if (!isProd) console.log(`✅ OSETH routes: ${routes.length} rows`);
      return routes;
    })().finally(() => {
      osethRoutesPromise = null;
    });
  }
  return osethRoutesPromise;
}

async function fetchOsethStops() {
  if (osethStopsCache) return osethStopsCache;
  if (!osethStopsPromise) {
    osethStopsPromise = (async () => {
      const size = Math.max(1, Math.min(OSETH_STOP_PAGE_SIZE, 1000));
      const first = await osethGet('stop', { page: 1, size }, 'stops page 1');
      const firstStops = Array.isArray(first.stops) ? first.stops : [];
      const total = Number(first.total) || firstStops.length;
      const pages = Math.max(1, Math.ceil(total / size));
      const rest = [];
      for (let page = 2; page <= pages; page++) {
        rest.push(osethGet('stop', { page, size }, `stops page ${page}`));
      }
      const restData = await Promise.all(rest);
      const stops = [
        ...firstStops,
        ...restData.flatMap((p) => (Array.isArray(p.stops) ? p.stops : [])),
      ];
      osethStopsCache = stops;
      if (!isProd) console.log(`✅ OSETH stops: ${stops.length}/${total} rows`);
      return stops;
    })().finally(() => {
      osethStopsPromise = null;
    });
  }
  return osethStopsPromise;
}

function osethRouteToLineRow(route) {
  const id = String(route?.id ?? '').trim();
  const shortName = String(route?.shortName ?? '').trim();
  const longName = String(route?.longName ?? '').trim();
  return {
    LineCode: id,
    line_code: id,
    LineID: shortName,
    LineIDGR: shortName,
    line_id: shortName,
    LineDescr: longName,
    LineDescrEng: longName,
    routeColor: route?.color,
    __source: 'oseth',
  };
}

function osethStopToAllStopRow(stop) {
  const id = String(stop?.id ?? stop?.code ?? '').trim();
  const code = String(stop?.code ?? id).trim();
  return {
    id,
    poleId: code,
    descr: String(stop?.name ?? '').trim(),
    street: '',
    lat: String(stop?.latitude ?? ''),
    lng: String(stop?.longitude ?? ''),
    routes: Array.isArray(stop?.routes) ? stop.routes : [],
    __source: 'oseth',
  };
}

function osethHeadsignToRouteRow(route, headsign) {
  const lineCode = String(route?.id ?? headsign?.routeId ?? '').trim();
  const routeId = String(headsign?.routeId ?? lineCode).trim();
  const shapeId = String(headsign?.shapeId ?? '').trim();
  const shortName = String(route?.shortName ?? '').trim();
  const longName = String(route?.longName ?? '').trim();
  const descr = String(headsign?.headsign ?? longName).trim();
  return {
    LineCode: lineCode,
    line_code: lineCode,
    MasterLineCode: lineCode,
    LineID: shortName,
    LineIDGR: shortName,
    line_id: shortName,
    LineDescr: longName,
    LineDescrEng: longName,
    RouteCode: makeOsethRouteCode(routeId, shapeId),
    route_code: makeOsethRouteCode(routeId, shapeId),
    RouteDescr: descr,
    RouteDescrEng: descr,
    routeColor: route?.color,
    __source: 'oseth',
    __routeId: routeId,
    __shapeId: shapeId,
  };
}

function osethRouteToFallbackRouteRow(route) {
  const id = String(route?.id ?? '').trim();
  const shortName = String(route?.shortName ?? '').trim();
  const longName = String(route?.longName ?? '').trim();
  return {
    LineCode: id,
    line_code: id,
    MasterLineCode: id,
    LineID: shortName,
    LineIDGR: shortName,
    line_id: shortName,
    LineDescr: longName,
    LineDescrEng: longName,
    RouteCode: id,
    route_code: id,
    RouteDescr: longName,
    RouteDescrEng: longName,
    routeColor: route?.color,
    __source: 'oseth',
  };
}

async function osethRouteRowsForLine(lineKey) {
  const key = String(lineKey ?? '').trim();
  if (!key) return [];
  const compact = compactLineKey(key);
  const routes = await fetchOsethRoutes();
  const matches = routes.filter((route) => {
    const id = String(route?.id ?? '').trim();
    const shortName = String(route?.shortName ?? '').trim();
    return id === key || shortName === key || compactLineKey(shortName) === compact;
  });

  const rows = [];
  for (const route of matches) {
    const heads = Array.isArray(route.tripHeadsigns) ? route.tripHeadsigns : [];
    if (heads.length === 0) {
      rows.push(osethRouteToFallbackRouteRow(route));
      continue;
    }
    for (const h of heads) rows.push(osethHeadsignToRouteRow(route, h));
  }
  return rows;
}

function osethRouteInfoToStopsPayload(info, routeCode) {
  const stops = Array.isArray(info?.stops) ? info.stops : [];
  const mappedStops = stops.map((stop, idx) => ({
    StopCode: String(stop?.id ?? stop?.code ?? '').trim(),
    StopID: String(stop?.code ?? stop?.id ?? '').trim(),
    StopDescr: String(stop?.name ?? '').trim(),
    StopDescrEng: String(stop?.name ?? '').trim(),
    StopLat: String(stop?.latitude ?? ''),
    StopLng: String(stop?.longitude ?? ''),
    RouteStopOrder: String(stop?.sequence ?? idx + 1),
    routeColor: info?.color,
    __routeCode: routeCode,
    __source: 'oseth',
  }));
  return {
    RouteCode: routeCode,
    route_code: routeCode,
    LineCode: String(info?.id ?? '').trim(),
    LineID: String(info?.shortName ?? '').trim(),
    LineDescr: String(info?.longName ?? '').trim(),
    RouteDescr: String(info?.headsign ?? info?.longName ?? '').trim(),
    shape: info?.shape,
    stops: mappedStops,
    vehicles: Array.isArray(info?.vehicles) ? info.vehicles : [],
    __source: 'oseth',
  };
}

async function fetchOsethRouteDetails(routeCode) {
  const parsed = parseOsethRouteCode(routeCode);
  if (!parsed) return null;
  const info = await osethGet(
    `route/${encodeURIComponent(parsed.routeId)}/info`,
    { shapeId: parsed.shapeId },
    `route ${parsed.routeId} ${parsed.shapeId}`
  );
  return osethRouteInfoToStopsPayload(info, routeCode);
}

function osethStopInfoTripToRouteRow(trip) {
  const route = trip?.route ?? {};
  const routeId = String(route.id ?? '').trim();
  const shapeId = String(trip?.shapeId ?? '').trim();
  const routeCode = makeOsethRouteCode(routeId, shapeId);
  const shortName = String(route.shortName ?? '').trim();
  const longName = String(route.longName ?? '').trim();
  const headsign = String(trip?.headsign ?? longName).trim();
  return {
    LineCode: routeId,
    line_code: routeId,
    MasterLineCode: routeId,
    LineID: shortName,
    LineIDGR: shortName,
    line_id: shortName,
    LineDescr: longName,
    LineDescrEng: longName,
    RouteCode: routeCode,
    route_code: routeCode,
    RouteDescr: headsign,
    RouteDescrEng: headsign,
    routeColor: route.color,
    __source: 'oseth',
    __shapeId: shapeId,
  };
}

async function osethRoutesForStop(stopCode) {
  const info = await osethGet(
    `stop/${encodeURIComponent(stopCode)}/info`,
    {},
    `stop ${stopCode} info`
  );
  const rows = [];
  const seen = new Set();
  for (const trip of Array.isArray(info.trips) ? info.trips : []) {
    const row = osethStopInfoTripToRouteRow(trip);
    const key = `${row.RouteCode}:${row.RouteDescr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  if (rows.length > 0) return rows;
  for (const route of Array.isArray(info.routes) ? info.routes : []) {
    const row = osethRouteToFallbackRouteRow(route);
    const key = row.RouteCode;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function osethVehicleToBusLocation(vehicle) {
  return {
    VEH_NO: String(vehicle?.id ?? ''),
    CS_LAT: String(vehicle?.latitude ?? ''),
    CS_LNG: String(vehicle?.longitude ?? ''),
    bearing: vehicle?.bearing,
    __source: 'oseth',
  };
}

function osethTripVehicleId(trip) {
  const v =
    trip?.vehicle?.id ??
    trip?.vehicle?.code ??
    trip?.vehicleId ??
    trip?.vehicleCode ??
    trip?.bus?.id;
  return v == null ? '' : String(v).trim();
}

function osethTripToArrival(trip) {
  const route = trip?.route ?? {};
  const routeId = String(route.id ?? '').trim();
  const shapeId = String(trip?.shapeId ?? '').trim();
  const routeCode = makeOsethRouteCode(routeId, shapeId);
  const mins = trip?.arrivalInMinutes ?? trip?.departureInMinutes;
  const lineId = String(route.shortName ?? '').trim();
  const descr = String(trip?.headsign ?? route.longName ?? '').trim();
  const vehicleId = osethTripVehicleId(trip);
  const isMonitored = trip?.monitored === true;
  const isLive = isMonitored;
  return {
    btime2: mins == null ? '' : String(Math.max(0, Number(mins) || 0)),
    route_code: routeCode,
    RouteCode: routeCode,
    resolved_route_code: routeCode,
    line_id: lineId,
    LineID: lineId,
    route_descr: descr,
    RouteDescr: descr,
    route_descr_eng: descr,
    RouteDescrEng: descr,
    veh_no: vehicleId || undefined,
    VehNo: vehicleId || undefined,
    is_live: isLive,
    realtime: isLive,
    monitored: isMonitored,
    __arrival_kind: isLive ? 'live' : 'scheduled',
    __arrival_live_reason: isMonitored ? 'monitored' : '',
    __vehicle_tracking: vehicleId ? 'present' : '',
    __source: 'oseth',
  };
}

async function osethArrivalsForStop(stopCode) {
  const data = await osethGet(
    `stop/${encodeURIComponent(stopCode)}/timetable`,
    { date: formatOsethDate() },
    `stop ${stopCode} timetable`
  );
  return (Array.isArray(data.trips) ? data.trips : []).map(osethTripToArrival);
}

/* ── Routes ────────────────────────────────────────────── */

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

let cachedStops = null;
let cachedLines = null;

app.post('/api/all-stops', async (req, res) => {
  try {
    if (cachedStops) {
      return res.json(cachedStops);
    }
    try {
      const stops = await fetchOsethStops();
      cachedStops = stops.map(osethStopToAllStopRow);
      return res.json(cachedStops);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH all-stops failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('all-stops', osethErr);
    }

    const token = getToken();
    const result = await oasthPost('getAllStops', { 'x-csrf-token': token });
    const data = result.data;
    if (data && Array.isArray(data)) cachedStops = enrichAllStopsWithPoleIds(data);
    const payload = enrichAllStopsWithPoleIds(data);
    res.status(result.status).json(payload);
  } catch (e) {
    sendError(res, e);
  }
});

/** Public line list (LineCode, LineID, LineDescr, …) — same as telematics `webGetLines`. */
app.post('/api/all-lines', async (req, res) => {
  try {
    if (cachedLines) return res.json(cachedLines);

    try {
      const routes = await fetchOsethRoutes();
      cachedLines = routes.map(osethRouteToLineRow);
      return res.json(cachedLines);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH all-lines failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('all-lines', osethErr);
    }

    const result = await oasthPost('webGetLines');
    const rows = coerceWebGetLinesRows(result.data);
    if (rows.length > 0) {
      cachedLines = rows;
    }
    res.status(result.status).json(rows);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/routes/:lineCode', async (req, res) => {
  try {
    try {
      const osethRows = await osethRouteRowsForLine(req.params.lineCode);
      if (osethRows.length > 0) return res.json(osethRows);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH routes failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('routes', osethErr);
    }
    if (!USE_LEGACY_OASTH_FALLBACK) return res.json([]);

    const p1 = encodeURIComponent(req.params.lineCode);
    const result = await oasthPost(`webGetRoutes&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

/** Same act as official telematics `getRoutesForLine` (line-details route dropdown). */
app.post('/api/routes-for-line/:lineCode', async (req, res) => {
  try {
    try {
      const osethRows = await osethRouteRowsForLine(req.params.lineCode);
      if (osethRows.length > 0) return res.json(osethRows);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH routes-for-line failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('routes-for-line', osethErr);
    }
    if (!USE_LEGACY_OASTH_FALLBACK) return res.json([]);

    const p1 = encodeURIComponent(req.params.lineCode);
    const result = await oasthPost(`getRoutesForLine&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/routes-for-stop/:stopCode', async (req, res) => {
  try {
    try {
      const rows = await osethRoutesForStop(req.params.stopCode);
      if (rows.length > 0) return res.json(rows);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH routes-for-stop failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('routes-for-stop', osethErr);
    }
    if (!USE_LEGACY_OASTH_FALLBACK) return res.json([]);

    const p1 = encodeURIComponent(req.params.stopCode);
    const result = await oasthPost(`webRoutesForStop&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/stops/:routeCode', async (req, res) => {
  try {
    try {
      const osethDetails = await fetchOsethRouteDetails(req.params.routeCode);
      if (osethDetails) return res.json(osethDetails.stops);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH stops failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('stops', osethErr);
    }
    if (!USE_LEGACY_OASTH_FALLBACK) return res.json([]);

    const p1 = encodeURIComponent(req.params.routeCode);
    const result = await oasthPost(`webGetStops&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/bus-locations/:routeCode', async (req, res) => {
  try {
    try {
      const osethDetails = await fetchOsethRouteDetails(req.params.routeCode);
      if (osethDetails) {
        return res.json(osethDetails.vehicles.map(osethVehicleToBusLocation));
      }
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH bus-locations failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('bus-locations', osethErr);
    }
    if (!USE_LEGACY_OASTH_FALLBACK) return res.json([]);

    const token = getToken();
    const p1 = encodeURIComponent(req.params.routeCode);
    const result = await oasthPost(`getBusLocation&p1=${p1}`, {
      'x-csrf-token': token,
    });
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/arrivals/:stopCode', async (req, res) => {
  try {
    try {
      const osethRows = await osethArrivalsForStop(req.params.stopCode);
      return res.json(dedupeStopArrivals(osethRows));
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH arrivals failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('arrivals', osethErr);
    }

    const token = getToken();
    const stopCode = req.params.stopCode;
    const p1 = encodeURIComponent(stopCode);
    const result = await oasthPost(`getStopArrivals&p1=${p1}`, {
      'x-csrf-token': token,
    });
    const rows = dedupeStopArrivals(result.data);
    const payload = Array.isArray(rows)
      ? await enrichStopArrivals(rows, stopCode, oasthPost)
      : rows;
    res.status(result.status).json(payload);
  } catch (e) {
    sendError(res, e);
  }
});

/** Resolve printed pole / SIP code → telematics stop id + coords (getStopBySIP). */
app.post('/api/stop-by-sip/:sip', async (req, res) => {
  try {
    const raw = String(req.params.sip ?? '').trim();
    if (!raw || raw.length > 24 || !/^[\d\s\-A-Za-z]+$/.test(raw)) {
      return res.status(400).json({ error: 'Invalid sip parameter' });
    }
    const sip = raw.replace(/\s+/g, '');
    try {
      const stop = await osethGet(
        `stop/${encodeURIComponent(sip)}/info`,
        {},
        `stop ${sip} info`
      );
      if (stop?.id != null) {
        return res.json({
          id: String(stop.id),
          code: String(stop.code ?? stop.id),
          titleel: String(stop.name ?? ''),
          titleen: String(stop.name ?? ''),
          descr: String(stop.name ?? ''),
          lat: String(stop.latitude ?? ''),
          lng: String(stop.longitude ?? ''),
          routes: Array.isArray(stop.routes) ? stop.routes : [],
          __source: 'oseth',
        });
      }
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH stop-by-sip failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) {
        return res.status(404).json({
          error: 'Stop not found in OSETH data',
          code: 'OSETH_STOP_NOT_FOUND',
        });
      }
    }
    if (!USE_LEGACY_OASTH_FALLBACK) {
      return res.status(404).json({
        error: 'Stop not found in OSETH data',
        code: 'OSETH_STOP_NOT_FOUND',
      });
    }

    const result = await oasthPost(`getStopBySIP&sip=${encodeURIComponent(sip)}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

/** Route metadata + `stops` array (same rows as webGetStops) in one call. */
app.post('/api/route-details-stops/:routeCode', async (req, res) => {
  try {
    try {
      const osethDetails = await fetchOsethRouteDetails(req.params.routeCode);
      if (osethDetails) return res.json(osethDetails);
    } catch (osethErr) {
      if (!isProd) console.warn('OSETH route-details-stops failed:', osethErr.message);
      if (!USE_LEGACY_OASTH_FALLBACK) throw osethOnlyError('route-details-stops', osethErr);
    }
    if (!USE_LEGACY_OASTH_FALLBACK) {
      return res.status(404).json({
        error: 'Route details not found in OSETH data',
        code: 'OSETH_ROUTE_NOT_FOUND',
      });
    }

    const p1 = encodeURIComponent(req.params.routeCode);
    const result = await oasthPost(`webGetRoutesDetailsAndStops&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

/* ── Static SPA (production build) ───────────────────── */
const distPath = path.join(projectRoot, 'dist');
if (isProd && fs.existsSync(distPath)) {
  app.use(express.static(distPath, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'), (err) => (err ? next(err) : undefined));
  });
} else if (isProd && !fs.existsSync(distPath)) {
  console.warn('⚠️ NODE_ENV=production but dist/ missing — run `npm run build` to serve the UI');
}

/* ── Start ─────────────────────────────────────────────── */
app.listen(PORT, () => {
  const mode = isProd ? 'production' : 'development';
  console.log(`OASTH proxy on http://localhost:${PORT} (${mode})`);
  fetchOsethRoutes().catch((e) =>
    console.error('OSETH route warm-up failed:', e.message)
  );
  if (USE_LEGACY_ROUTE_POLE_MAP || USE_LEGACY_GET_STOPS_B_POLE_MAP) {
    ensureSession()
      .then(() => {
        const build = USE_LEGACY_ROUTE_POLE_MAP
          ? buildStopPoleMap()
          : buildStopPoleMapFromGetStopsB();
        return build.catch((e) =>
          console.error('Legacy stop pole map build failed:', e.message)
        );
      })
      .catch((e) => console.error('Legacy session warm-up failed:', e.message));
  }
});
