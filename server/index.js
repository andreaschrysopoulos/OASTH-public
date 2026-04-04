/**
 * OASTH Telematics API proxy + optional static SPA (production).
 * Uses Node fetch + PHPSESSID from webGetLangs — no Playwright at runtime.
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

/** Set `OASTH_LEGACY_ROUTE_POLE_MAP=1` to build short→pole from every route’s `webGetStops` instead of `getStopsB`. */
const USE_LEGACY_ROUTE_POLE_MAP =
  process.env.OASTH_LEGACY_ROUTE_POLE_MAP === '1' ||
  String(process.env.OASTH_LEGACY_ROUTE_POLE_MAP).toLowerCase() === 'true';

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

/* ── Routes ────────────────────────────────────────────── */

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

let cachedStops = null;
let cachedLines = null;

app.post('/api/all-stops', async (req, res) => {
  try {
    let data;
    let status = 200;
    if (cachedStops) {
      data = cachedStops;
    } else {
      const token = getToken();
      const result = await oasthPost('getAllStops', { 'x-csrf-token': token });
      status = result.status;
      if (result.data && Array.isArray(result.data)) {
        cachedStops = result.data;
      }
      data = result.data;
    }
    const payload = enrichAllStopsWithPoleIds(data);
    res.status(status).json(payload);
  } catch (e) {
    sendError(res, e);
  }
});

/** Public line list (LineCode, LineID, LineDescr, …) — same as telematics `webGetLines`. */
app.post('/api/all-lines', async (req, res) => {
  try {
    if (cachedLines) return res.json(cachedLines);

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
    const p1 = encodeURIComponent(req.params.lineCode);
    const result = await oasthPost(`getRoutesForLine&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/routes-for-stop/:stopCode', async (req, res) => {
  try {
    const p1 = encodeURIComponent(req.params.stopCode);
    const result = await oasthPost(`webRoutesForStop&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/stops/:routeCode', async (req, res) => {
  try {
    const p1 = encodeURIComponent(req.params.routeCode);
    const result = await oasthPost(`webGetStops&p1=${p1}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

app.post('/api/bus-locations/:routeCode', async (req, res) => {
  try {
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
    const result = await oasthPost(`getStopBySIP&sip=${encodeURIComponent(sip)}`);
    res.status(result.status).json(result.data);
  } catch (e) {
    sendError(res, e);
  }
});

/** Route metadata + `stops` array (same rows as webGetStops) in one call. */
app.post('/api/route-details-stops/:routeCode', async (req, res) => {
  try {
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
  ensureSession()
    .then(() => {
      const build = USE_LEGACY_ROUTE_POLE_MAP
        ? buildStopPoleMap()
        : buildStopPoleMapFromGetStopsB();
      return build.catch((e) =>
        console.error('Stop pole map build failed:', e.message)
      );
    })
    .catch((e) => console.error('Session warm-up failed:', e.message));
});
