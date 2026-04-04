import {
  memo,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react'
import MapGL, { Source, Layer } from 'react-map-gl/mapbox'
import {
  Navigation2,
  X,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  MapPin,
  Bus,
  ChevronDown,
  Trash2,
  Search,
  Map as MapIcon,
  Sun,
  Moon,
} from 'lucide-react'
import {
  canonNumish,
  dedupeStopArrivals,
} from '../shared/arrivals/dedupe.js'
import { resolveArrivalRouteCode } from '../shared/arrivals/enrichment.js'

/** Served from `public/oasth-live-arrow.png` so edits apply in dev (no copy step). */
const liveBusArrowUrl = `${import.meta.env.BASE_URL}oasth-live-arrow.png`

/* ── API Helpers ───────────────────────────────────────── */

/** OASTH `webGetLines` is usually a JSON array; coerce object-maps to an array. */
function coerceWebGetLinesArray(data) {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (typeof data === 'object') {
    if (Array.isArray(data.lines)) return data.lines
    if (Array.isArray(data.data)) return data.data
    const vals = Object.values(data)
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
      return vals
    }
  }
  return []
}

/** Trimmed string for stop identifiers (pole codes vs internal ids). */
function trimStopIdish(v) {
  if (v == null) return ''
  return String(v).trim()
}

/**
 * Passenger-facing stop number for signage. OASTH `webGetStops` uses StopCode ≈ getAllStops.id
 * (short key for arrivals) and StopID = printed pole number — opposite of common GTFS naming.
 * `poleId` is attached on `/api/all-stops` from getStopsB (or legacy route crawl if enabled).
 */
function passengerFacingStopId(row) {
  if (!row || typeof row !== 'object') return ''
  const pole = trimStopIdish(row.poleId)
  if (pole) return pole
  const fromRouteRow =
    row.StopDescr != null ||
    row.StopLat != null ||
    row.StopLng != null ||
    (row.StopCode != null && row.StopID != null)
  if (fromRouteRow || row.StopID != null || row.StopCode != null) {
    const sid = trimStopIdish(row.StopID ?? row.StopIDGR ?? row.stop_id)
    if (sid) return sid
    const sc = trimStopIdish(row.StopCode ?? row.stop_code)
    if (sc) return sc
  }
  return trimStopIdish(row.id)
}

async function fetchPageAuthStatus() {
  try {
    const res = await fetch('/api/auth/page-status', { credentials: 'include' })
    if (!res.ok) throw new Error('bad status')
    return await res.json()
  } catch {
    return { enabled: false, authenticated: true }
  }
}

async function apiPost(path) {
  const res = await fetch(path, { method: 'POST', credentials: 'include' })
  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      if (!res.ok) {
        throw new Error(
          `HTTP ${res.status}: ${text.slice(0, 180).replace(/\s+/g, ' ')}`
        )
      }
      throw new Error('Server returned invalid JSON (not an API response).')
    }
  }
  if (!res.ok) {
    const detail =
      data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    throw new Error(detail)
  }
  return data
}

async function apiPostWithTimeout(path, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return apiPost(path)
  return await Promise.race([
    apiPost(path),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ])
}

const ROUTE_STOPS_CACHE_TTL_MS = 20 * 60 * 1000
const ROUTE_STOPS_CACHE_MAX = 120
const BUS_LOC_CACHE_TTL_MS = 3_500
const routeStopsCache = new Map()
const routeStopsInFlight = new Map()
const busLocCache = new Map()
const busLocInFlight = new Map()

function pruneTimedCache(map, maxEntries) {
  if (map.size <= maxEntries) return
  const keys = [...map.keys()]
  const drop = map.size - maxEntries
  for (let i = 0; i < drop; i++) map.delete(keys[i])
}

/** Stops for one route — `webGetRoutesDetailsAndStops` (single telematics round-trip). */
async function fetchRouteStopsForMap(routeCode) {
  const key = String(routeCode ?? '').trim()
  if (!key) return []
  const now = Date.now()
  const cached = routeStopsCache.get(key)
  if (cached && cached.expiresAt > now) return cached.rows
  const inFlight = routeStopsInFlight.get(key)
  if (inFlight) return inFlight

  const p = apiPost(`/api/route-details-stops/${encodeURIComponent(key)}`)
    .then((data) => {
      const rows = Array.isArray(data?.stops) ? data.stops : []
      routeStopsCache.set(key, { rows, expiresAt: Date.now() + ROUTE_STOPS_CACHE_TTL_MS })
      pruneTimedCache(routeStopsCache, ROUTE_STOPS_CACHE_MAX)
      return rows
    })
    .finally(() => {
      routeStopsInFlight.delete(key)
    })

  routeStopsInFlight.set(key, p)
  return p
}

async function fetchBusLocationsForRoute(routeCode) {
  const key = String(routeCode ?? '').trim()
  if (!key) return []
  const now = Date.now()
  const cached = busLocCache.get(key)
  if (cached && cached.expiresAt > now) return cached.rows
  const inFlight = busLocInFlight.get(key)
  if (inFlight) return inFlight

  const p = apiPost(`/api/bus-locations/${encodeURIComponent(key)}`)
    .then((rows) => {
      const out = Array.isArray(rows) ? rows : []
      busLocCache.set(key, { rows: out, expiresAt: Date.now() + BUS_LOC_CACHE_TTL_MS })
      pruneTimedCache(busLocCache, 200)
      return out
    })
    .catch(() => [])
    .finally(() => {
      busLocInFlight.delete(key)
    })

  busLocInFlight.set(key, p)
  return p
}

function descrNorm(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

function arrivalRouteRaw(arrival) {
  const v =
    arrival?.route_code ??
    arrival?.RouteCode ??
    arrival?.ROUTE_CODE ??
    arrival?.routeCode
  if (v != null && v !== '') return String(v).trim()
  const lid = arrival?.line_id ?? arrival?.LineID
  if (lid != null && lid !== '') return String(lid).trim()
  return ''
}

/**
 * `getStopArrivals.route_code` is often an internal RouteCode, but can be a published line id.
 * Prefer rows that match line/direction metadata from enrichment.
 */
async function routeCodeIfHasStopsCandidates(codes) {
  const tried = new Set()
  for (const code of codes) {
    if (code == null || code === '') continue
    const key = String(code)
    if (tried.has(key)) continue
    tried.add(key)
    try {
      const rows = await fetchRouteStopsForMap(key)
      if (Array.isArray(rows) && rows.length > 0) return key
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Resolves the internal RouteCode used for route stop geometry (`/api/route-details-stops`).
 * When resolution used `routes-for-stop`, that array is returned so callers
 * avoid a duplicate request.
 */
async function resolveRouteCodeForMap(arrival, stopId) {
  const embedded = String(arrival?.resolved_route_code ?? '').trim()
  if (embedded) {
    const fromServer = await routeCodeIfHasStopsCandidates([embedded])
    if (fromServer) return { routeCode: fromServer }
  }

  const raw = arrivalRouteRaw(arrival)
  if (!raw) return null

  const rawCanon = canonNumish(raw)
  const candidates = [raw, rawCanon].filter((c, i, a) => c && a.indexOf(c) === i)

  const direct = await routeCodeIfHasStopsCandidates(candidates)
  if (direct) return { routeCode: direct }

  const lineId = String(arrival.line_id ?? arrival.LineID ?? '').trim()
  const lineCanon = lineId ? canonNumish(lineId) : ''
  const arrDescr = descrNorm(
    arrival.route_descr ?? arrival.RouteDescr ?? arrival.route_descr_eng ?? ''
  )

  try {
    const routes = await apiPostWithTimeout(
      `/api/routes-for-stop/${encodeURIComponent(stopId)}`,
      5_500
    )
    if (!Array.isArray(routes) || routes.length === 0) return null
    let best = null
    let bestScore = -1
    for (const r of routes) {
      let score = 0
      if (String(r.RouteCode ?? '') === raw) score += 8
      if (canonNumish(r.RouteCode) === rawCanon) score += 8
      const rid = String(r.LineID ?? '').trim()
      if (rid === raw) score += 7
      if (canonNumish(r.LineID) === rawCanon) score += 7
      if (lineId && rid === lineId) score += 9
      if (lineCanon && canonNumish(r.LineID) === lineCanon) score += 9
      if (lineCanon && canonNumish(r.LineCode) === lineCanon) score += 8
      if (lineCanon && canonNumish(r.MasterLineCode) === lineCanon) score += 4
      if (arrDescr && descrNorm(r.RouteDescr) === arrDescr) score += 5
      if (score > bestScore) {
        bestScore = score
        best = r
      }
    }
    if (bestScore > 0 && best) {
      return { routeCode: String(best.RouteCode), routesForStop: routes }
    }
  } catch {
    /* fall through */
  }

  const lineKeys = [lineId, raw, rawCanon].filter(Boolean)
  const seen = new Set()
  for (const lk of lineKeys) {
    if (seen.has(lk)) continue
    seen.add(lk)
    try {
      const lineRoutes = await apiPostWithTimeout(
        `/api/routes/${encodeURIComponent(lk)}`,
        5_500
      )
      if (!Array.isArray(lineRoutes) || lineRoutes.length === 0) continue
      if (arrDescr) {
        const match = lineRoutes.find((r) => descrNorm(r.RouteDescr) === arrDescr)
        if (match) return { routeCode: String(match.RouteCode) }
      }
      return { routeCode: String(lineRoutes[0].RouteCode) }
    } catch {
      /* next line key */
    }
  }

  return null
}

function sortByRouteStopOrder(rows) {
  return [...rows].sort((a, b) => {
    const oa = parseInt(a.RouteStopOrder, 10)
    const ob = parseInt(b.RouteStopOrder, 10)
    const na = Number.isNaN(oa) ? 0 : oa
    const nb = Number.isNaN(ob) ? 0 : ob
    return na - nb
  })
}

function stopsRowsToLineGeoJson(stopsRows) {
  if (!Array.isArray(stopsRows) || stopsRows.length === 0) return null
  const sorted = sortByRouteStopOrder(stopsRows)
  const coordinates = []
  for (const s of sorted) {
    const lat = parseFloat(s.StopLat ?? s.stop_lat)
    const lng = parseFloat(s.StopLng ?? s.stop_lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue
    coordinates.push([lng, lat])
  }
  if (coordinates.length === 1) {
    coordinates.push([coordinates[0][0], coordinates[0][1]])
  }
  if (coordinates.length < 2) return null
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
      },
    ],
  }
}

/**
 * Bounds for the tracked route: line vertices if there are at least two, else stop
 * coordinates, else live bus points. Uses min/max so we never rely on an empty
 * `LngLatBounds` + `extend` sequence (which can fail to produce a valid fit).
 */
function collectTrackedRoutePoints(trackedLineGeo, trackedRouteStopsRows, trackedBusGeo) {
  const lineCoords = trackedLineGeo?.features?.[0]?.geometry?.coordinates
  if (Array.isArray(lineCoords) && lineCoords.length >= 2) {
    const pts = []
    for (const c of lineCoords) {
      if (!Array.isArray(c) || c.length < 2) continue
      const lng = Number(c[0])
      const lat = Number(c[1])
      if (Number.isFinite(lng) && Number.isFinite(lat)) pts.push([lng, lat])
    }
    if (pts.length >= 2) return pts
  }
  if (Array.isArray(trackedRouteStopsRows) && trackedRouteStopsRows.length > 0) {
    const sorted = sortByRouteStopOrder(trackedRouteStopsRows)
    const pts = []
    for (const s of sorted) {
      const lat = parseFloat(s.StopLat ?? s.stop_lat)
      const lng = parseFloat(s.StopLng ?? s.stop_lng)
      if (!Number.isNaN(lat) && !Number.isNaN(lng)) pts.push([lng, lat])
    }
    if (pts.length >= 2) return pts
  }
  const busFeats = trackedBusGeo?.features
  if (Array.isArray(busFeats)) {
    const pts = []
    for (const f of busFeats) {
      const c = f?.geometry?.coordinates
      if (!c || c.length < 2) continue
      const lng = Number(c[0])
      const lat = Number(c[1])
      if (Number.isFinite(lng) && Number.isFinite(lat)) pts.push([lng, lat])
    }
    if (pts.length >= 1) return pts
  }
  return null
}

/** Points along the active line for highlighting and picking above other layers. */
function buildTrackedRouteStopsGeoJson(stopsRows, selectedStopId) {
  if (!Array.isArray(stopsRows) || stopsRows.length === 0) return null
  const sorted = sortByRouteStopOrder(stopsRows)
  const validStops = []
  for (const s of sorted) {
    const lat = parseFloat(s.StopLat ?? s.stop_lat)
    const lng = parseFloat(s.StopLng ?? s.stop_lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue
    const id = String(s.StopCode ?? s.StopID ?? '').trim()
    if (!id) continue
    validStops.push({ s, lat, lng, id })
  }
  const features = []
  const lastIdx = validStops.length - 1
  for (let idx = 0; idx < validStops.length; idx += 1) {
    const { s, lat, lng, id } = validStops[idx]
    const sel =
      selectedStopId != null && String(selectedStopId) === id ? 1 : 0
    const routeColor = String(s.routeColor ?? '').trim()
    const routeCode = String(s.__routeCode ?? '').trim()
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        id,
        selected: sel,
        isRouteStart: idx === 0 ? 1 : 0,
        isRouteEnd: idx === lastIdx ? 1 : 0,
        label: stopMapLabel(s),
        routeColor: routeColor || undefined,
        routeCode: routeCode || undefined,
      },
    })
  }
  return features.length
    ? { type: 'FeatureCollection', features }
    : null
}

/** Published line id / badge text for map labels; falls back to internal route code. */
function trackedBusLineDisplayLabel(lineBadge, routeCode) {
  const a = String(lineBadge ?? '').trim()
  if (a && a !== '—') return a
  const b = String(routeCode ?? '').trim()
  return b || ''
}

function busLocationsToGeoJson(rows, lineBadge, routeCode, routeMeta = null) {
  const lineLabel = trackedBusLineDisplayLabel(lineBadge, routeCode)
  const routeColor = String(routeMeta?.routeColor ?? '').trim()
  const routeKey = String(routeMeta?.routeCode ?? routeCode ?? '').trim()
  const features = []
  if (!Array.isArray(rows)) {
    return { type: 'FeatureCollection', features: [] }
  }
  for (const row of rows) {
    const lat = parseFloat(row.CS_LAT)
    const lng = parseFloat(row.CS_LNG)
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        veh: String(row.VEH_NO ?? ''),
        lineLabel,
        routeCode: routeKey || undefined,
        routeColor: routeColor || undefined,
      },
    })
  }
  return { type: 'FeatureCollection', features }
}

const EARTH_RADIUS_M = 6_371_000

function haversineMeters(lng1, lat1, lng2, lat2) {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δφ = ((lat2 - lat1) * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))
}

function geographicBearingDeg(lat1, lng1, lat2, lng2) {
  const φ1 = (lat1 * Math.PI) / 180
  const φ2 = (lat2 * Math.PI) / 180
  const Δλ = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  const θ = Math.atan2(y, x)
  return ((θ * 180) / Math.PI + 360) % 360
}

function distancesToVerticesAlongLine(coords) {
  const d = [0]
  let cum = 0
  for (let i = 0; i < coords.length - 1; i++) {
    cum += haversineMeters(
      coords[i][0],
      coords[i][1],
      coords[i + 1][0],
      coords[i + 1][1]
    )
    d.push(cum)
  }
  return d
}

function projectPointToPolylineArcMeters(lng, lat, coords) {
  let bestD2 = Infinity
  let bestArc = 0
  let cum = 0
  for (let i = 0; i < coords.length - 1; i++) {
    const ax = coords[i][0]
    const ay = coords[i][1]
    const bx = coords[i + 1][0]
    const by = coords[i + 1][1]
    const segM = haversineMeters(ax, ay, bx, by)
    const dx = bx - ax
    const dy = by - ay
    const L2 = dx * dx + dy * dy
    let t = L2 < 1e-20 ? 0 : ((lng - ax) * dx + (lat - ay) * dy) / L2
    t = Math.max(0, Math.min(1, t))
    const px = ax + t * dx
    const py = ay + t * dy
    const dLng = lng - px
    const dLat = lat - py
    const d2 = dLng * dLng + dLat * dLat
    if (d2 < bestD2) {
      bestD2 = d2
      bestArc = cum + t * segM
    }
    cum += segM
  }
  return { arcM: bestArc }
}

function nextStopVertexIndexAfterArc(arcM, distToVertex) {
  const epsM = 8
  for (let k = 1; k < distToVertex.length; k++) {
    if (distToVertex[k] > arcM + epsM) return k
  }
  return null
}

/** Linear interp along geodesic chord; good for short urban segments. */
function routeLineCoordsForArrows(lineGeo, stopsRows, routeCode = null) {
  const key = String(routeCode ?? '').trim()
  const lineFeatures = Array.isArray(lineGeo?.features) ? lineGeo.features : []
  let chosen = lineFeatures[0] ?? null
  if (key) {
    const match = lineFeatures.find((f) =>
      routeCodesMatch(String(f?.properties?.routeCode ?? '').trim(), key)
    )
    if (match) chosen = match
  }
  const g = chosen?.geometry
  if (g?.type === 'LineString' && g.coordinates?.length >= 2) return g.coordinates
  const rowsForRoute = key
    ? (Array.isArray(stopsRows) ? stopsRows : []).filter((r) =>
        routeCodesMatch(String(r.__routeCode ?? '').trim(), key)
      )
    : stopsRows
  const fallback = stopsRowsToLineGeoJson(rowsForRoute)
  const c = fallback?.features?.[0]?.geometry?.coordinates
  return c?.length >= 2 ? c : null
}

/** One GeoJSON feature per vehicle for the bus dot, plus a same-point arrow icon feature. */
function buildTrackedBusDisplayGeoJson(busFc, lineGeo, stopsRows) {
  if (!busFc?.features?.length) {
    return busFc ?? { type: 'FeatureCollection', features: [] }
  }

  const features = []
  for (const f of busFc.features) {
    if (f.geometry?.type !== 'Point') continue
    const [lng, lat] = f.geometry.coordinates
    const routeCode = String(f?.properties?.routeCode ?? '').trim()
    const coords = routeLineCoordsForArrows(lineGeo, stopsRows, routeCode)
    const distToVertex =
      coords && coords.length >= 2 ? distancesToVerticesAlongLine(coords) : null
    let bearing = 0
    if (coords && distToVertex) {
      const { arcM } = projectPointToPolylineArcMeters(lng, lat, coords)
      const k = nextStopVertexIndexAfterArc(arcM, distToVertex)
      if (k != null) {
        const tLng = coords[k][0]
        const tLat = coords[k][1]
        bearing = geographicBearingDeg(lat, lng, tLat, tLng)
      }
    }
    const baseProps = {
      ...f.properties,
      bearing,
    }
    features.push({
      ...f,
      properties: {
        ...baseProps,
        busKind: 'bus',
      },
    })
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lng, lat] },
      properties: {
        ...baseProps,
        busKind: 'arrow',
      },
    })
  }
  return { type: 'FeatureCollection', features }
}


async function fetchArrivals(stopCode) {
  const res = await fetch(`/api/arrivals/${encodeURIComponent(stopCode)}`, {
    method: 'POST',
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }
  if (!res.ok) {
    const detail =
      data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    throw new Error(detail)
  }
  return dedupeStopArrivals(Array.isArray(data) ? data : [])
}

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN

/** Built-in Mapbox GL styles for the in-app style switcher. */
const MAP_BASE_STYLE_PRESETS = {
  streets: 'mapbox://styles/mapbox/streets-v12',
  light: 'mapbox://styles/mapbox/light-v11',
  dark: 'mapbox://styles/mapbox/dark-v11',
}
const MAP_BASE_STYLE_ORDER = ['streets', 'light', 'dark']
const LS_MAP_BASE_STYLE = 'oasth:mapBaseStyle'

/** Greek UI strings for the active basemap mode. */
const MAP_BASE_STYLE_UI = {
  streets: {
    title: 'Λεπτομερής χάρτης (δρόμοι)',
    nextHint: 'Επόμενο: φωτεινός',
  },
  light: {
    title: 'Φωτεινός χάρτης',
    nextHint: 'Επόμενο: σκοτεινός',
  },
  dark: {
    title: 'Σκοτεινός χάρτης',
    nextHint: 'Επόμενο: λεπτομερής',
  },
}

function readMapBaseStyleKey() {
  try {
    const v = localStorage.getItem(LS_MAP_BASE_STYLE)
    if (v === 'streets' || v === 'light' || v === 'dark') return v
  } catch {
    /* ignore */
  }
  const env = String(import.meta.env.VITE_MAPBOX_STYLE ?? '').trim()
  if (env.includes('/dark')) return 'dark'
  if (env.includes('/light')) return 'light'
  if (env.includes('/streets')) return 'streets'
  return 'streets'
}

function writeMapBaseStyleKey(key) {
  try {
    localStorage.setItem(LS_MAP_BASE_STYLE, key)
  } catch {
    /* ignore */
  }
}

/**
 * Hide only POI symbol layers (shops, businesses, amenities on the basemap).
 * Cities, neighborhoods, countries, transit, water features, and road names stay visible.
 */
function shouldHideBasemapPoiLayer(layerId) {
  return /(^|[-_])poi([-_]|$)/i.test(layerId)
}

function hideMapBasemapPoiLayers(map) {
  const style = map.getStyle?.()
  if (!style?.layers) return
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue
    if (!shouldHideBasemapPoiLayer(layer.id)) continue
    try {
      map.setLayoutProperty(layer.id, 'visibility', 'none')
    } catch {
      /* layer may omit visibility */
    }
  }
}

/** Hide Mapbox transit stop symbols/labels so only our OASTH stops show (same area). */
function hideBasemapTransitStopLayer(map) {
  if (!map.getLayer?.('transit-label')) return
  try {
    map.setLayoutProperty('transit-label', 'visibility', 'none')
  } catch {
    /* ignore */
  }
}

/** Symbol layers we add — do not rewrite their `text-font`. */
function isOasthOwnedMapLayerId(layerId) {
  return (
    layerId.startsWith('stops-oasth-') ||
    layerId.startsWith('tracked-route') ||
    layerId.startsWith('tracked-bus-') ||
    layerId.startsWith('user-acc') ||
    layerId.startsWith('oasth-')
  )
}

function isPlainStringTextFontStack(v) {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')
}

/**
 * One step heavier (Mapbox glyph PostScript names). Skips italic stacks — composites often lack Italic Bold.
 */
function thickenBasemapFontName(name) {
  const n = String(name).trim()
  if (!n || /\bItalic\b/i.test(n)) return n
  if (/^Arial Unicode MS Regular$/i.test(n)) return 'Arial Unicode MS Bold'
  if (/^Arial Unicode MS Bold$/i.test(n)) return n
  const rules = [
    [/ Ultra ?Light$/i, ' Thin'],
    [/ Thin$/i, ' Light'],
    [/ Light$/i, ' Regular'],
    [/ Book$/i, ' Regular'],
    [/ Regular$/i, ' Medium'],
    [/ Roman$/i, ' Medium'],
    [/ Medium$/i, ' Semibold'],
    [/ Demi Bold$/i, ' Bold'],
    [/ Semibold$/i, ' Bold'],
    [/ Bold$/i, ' Heavy'],
    [/ Heavy$/i, ' Black'],
  ]
  for (const [re, rep] of rules) {
    if (re.test(n)) return n.replace(re, rep)
  }
  return n
}

/** Bump road / place / POI label weights on the basemap (vector style symbol layers only). */
function thickenBasemapSymbolTextFonts(map) {
  if (!map?.getStyle?.()?.layers) return
  for (const layer of map.getStyle().layers) {
    if (layer.type !== 'symbol') continue
    const id = layer.id
    if (isOasthOwnedMapLayerId(id)) continue
    let fonts
    try {
      fonts = map.getLayoutProperty(id, 'text-font')
    } catch {
      continue
    }
    if (!isPlainStringTextFontStack(fonts)) continue
    const next = fonts.map(thickenBasemapFontName)
    if (next.every((f, i) => f === fonts[i])) continue
    try {
      map.setLayoutProperty(id, 'text-font', next)
    } catch {
      /* stack not served for this style / glyph URL */
    }
  }
}

/**
 * First matching basemap label layer id — stop layers are inserted *before* this so stops
 * stay under neighborhoods, settlements, and other place labels.
 */
function findStopsBeforeBasemapLabelLayerId(style) {
  if (!style?.layers) return null
  const prefer = [
    'settlement-subdivision-label',
    'settlement-minor-label',
    'settlement-major-label',
    'place-neighbourhood',
    'place-suburb',
    'place-city-sm',
    'place-town',
    'place-village',
  ]
  const idSet = new Set(style.layers.map((l) => l.id))
  for (const id of prefer) {
    if (idSet.has(id)) return id
  }
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue
    const lid = layer.id
    if (/settlement[-_].*label/i.test(lid)) return lid
    if (/^place[-_]/i.test(lid) && /label/i.test(lid)) return lid
  }
  return null
}

/** Keep above label visibility threshold so picked stops show readable map labels. */
const STOP_FLY_ZOOM = 15
const STOP_FLY_DURATION_SEC = 1.2
const STOP_FLY_DURATION_MS = Math.round(STOP_FLY_DURATION_SEC * 1000)

/**
 * Fit map to tracked line / stops / live buses — same as the line HUD “show whole route” control.
 * @param {import('mapbox-gl').Map | null | undefined} map
 */
function fitMapToTrackedRouteSnapshot(
  map,
  trackedLineGeo,
  trackedRouteStopsRows,
  trackedBusGeo
) {
  if (!map) return
  const pts = collectTrackedRoutePoints(
    trackedLineGeo,
    trackedRouteStopsRows,
    trackedBusGeo
  )
  if (!pts || pts.length === 0) return

  let minLng = pts[0][0],
    maxLng = pts[0][0]
  let minLat = pts[0][1],
    maxLat = pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] < minLng) minLng = pts[i][0]
    if (pts[i][0] > maxLng) maxLng = pts[i][0]
    if (pts[i][1] < minLat) minLat = pts[i][1]
    if (pts[i][1] > maxLat) maxLat = pts[i][1]
  }

  map.stop()

  if (
    pts.length === 1 ||
    (Math.abs(maxLng - minLng) < 1e-10 && Math.abs(maxLat - minLat) < 1e-10)
  ) {
    map.easeTo({
      center: [minLng, minLat],
      zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM),
      duration: STOP_FLY_DURATION_MS,
      essential: true,
    })
    return
  }

  map.fitBounds(
    [
      [minLng, minLat],
      [maxLng, maxLat],
    ],
    {
      padding: { top: 72, bottom: 120, left: 40, right: 40 },
      maxZoom: 15,
      duration: STOP_FLY_DURATION_MS,
      essential: true,
      linear: true,
    }
  )
}

const STOPS_ICON_LAYER_ID = 'stops-oasth-icon'
const STOPS_LABEL_LAYER_ID = 'stops-oasth-label'
/**
 * Label placement runs in ascending sort-key order. Selected uses a negative key so it is
 * laid out first; its text box then suppresses overlapping non-selected names in the same layer.
 */
const STOPS_LABEL_SORT_SELECTED_FIRST = -1000
/** Icon layer only — selected bus sprite drawn above neighbors. */
const STOPS_SYMBOL_SORT_SELECTED = 1000
const STOPS_SYMBOL_SORT_FAVORITE = 100
/** Sprite icon id in Mapbox Streets (and most Mapbox core styles). */
const STOPS_MAP_ICON_IMAGE = 'bus'
/** Custom raster from `buildFavoriteStopMapIconImageData` (gold star). */
const STOPS_FAVORITE_MAP_ICON_ID = 'oasth-favorite-stop'

/** Lucide `star` icon path, 24×24 viewBox — same geometry as `<Star />` in favorite buttons. */
const LUCIDE_STAR_PATH_D =
  'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z'
const CENTERED_STAR_PATH_D =
  'M12 3.2 14.76 8.79 20.92 9.69 16.46 14.04 17.51 20.2 12 17.3 6.49 20.2 7.54 14.04 3.08 9.69 9.24 8.79Z'

function FavoriteIcon({
  size = 17,
  strokeWidth = 2.2,
  filled = false,
  className,
  ...props
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d={CENTERED_STAR_PATH_D}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function CloseIcon({ size = 16, strokeWidth = 2.2, className, ...props }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path
        d="M7 7 17 17M17 7 7 17"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * Raster for Mapbox `addImage` — flat circle + Lucide star (rounded tips) + white ring.
 * Colors align with `.stop-popup-favorite--active` / favorites tile.
 */
function buildFavoriteStopMapIconImageData() {
  const logical = 28
  const dpr = 2
  const size = logical * dpr
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return new ImageData(1, 1)
  }
  ctx.scale(dpr, dpr)
  const cx = logical / 2
  const cy = logical / 2
  const circleR = 11.75
  const favStar = '#f5c518'
  const favDiscOpaque = '#fff4e0'

  const traceCircle = () => {
    ctx.beginPath()
    ctx.arc(cx, cy, circleR, 0, Math.PI * 2)
  }

  traceCircle()
  ctx.fillStyle = favDiscOpaque
  ctx.fill()

  traceCircle()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = 2
  ctx.stroke()

  const starPath = new Path2D(LUCIDE_STAR_PATH_D)
  const lucideBox = 24
  /** ~57% of circle diameter — margin around star like the reference. */
  const starSpan = circleR * 2 * 0.57
  const starScale = starSpan / lucideBox
  /* `<Star size={17} strokeWidth={1.75} />` — stroke scales with rendered star size. */
  const strokePx = (1.75 * starSpan) / 17

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(starScale, starScale)
  ctx.translate(-lucideBox / 2, -lucideBox / 2)
  ctx.fillStyle = favStar
  ctx.fill(starPath)
  ctx.strokeStyle = favStar
  ctx.lineWidth = strokePx / starScale
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.stroke(starPath)
  ctx.restore()

  return ctx.getImageData(0, 0, size, size)
}

function tryInstallFavoriteStopMapIcon(map) {
  if (!map || typeof document === 'undefined') return false
  try {
    if (map.hasImage(STOPS_FAVORITE_MAP_ICON_ID)) {
      map.removeImage(STOPS_FAVORITE_MAP_ICON_ID)
    }
  } catch {
    /* not present */
  }
  try {
    map.addImage(
      STOPS_FAVORITE_MAP_ICON_ID,
      buildFavoriteStopMapIconImageData()
    )
    return true
  } catch (e) {
    console.error('[oasth] favorite stop map icon addImage failed', e)
    return false
  }
}
/**
 * Map stop names — Mapbox glyph stacks (not CSS). Mapbox hosts SF Pro–aligned faces; Arial Unicode
 * covers Greek where the primary stack lacks a glyph.
 */
const STOPS_MAP_LABEL_FONTS = ['SF Pro Text Semibold', 'Arial Unicode MS Bold']
/** On-route vertex labels. */
const ROUTE_PATH_STOP_LABEL_FONTS = ['SF Pro Text Heavy', 'Arial Unicode MS Bold']
/** Bus stop names only from this zoom upward (needs a closer zoom than markers). */
const STOPS_LABEL_MIN_ZOOM = 14.25
const STOPS_LABEL_MAX_LEN = 34
/** Ems — lower = wrap label text to shorter lines sooner (`text-max-width`). */
const STOPS_LABEL_TEXT_MAX_WIDTH = 7
const STOPS_LABEL_SIZE = 10
/** Sprite `bus` baseline (~24px) × this scale. */
const STOPS_ICON_SIZE = 0.78
/** Favorite star badge — smaller footprint than the bus sprite. */
const STOPS_ICON_SIZE_FAVORITE = 0.29
/** Ems — text sits under the icon (see `text-anchor: top`). Lower = tighter to the pin. */
const STOPS_LABEL_OFFSET_Y = 0.82
/** On-route stop labels used a smaller gap than the main layer; keep that ratio when tuning offset. */
const TRACKED_ROUTE_LABEL_OFFSET_Y = STOPS_LABEL_OFFSET_Y * (0.7 / 1.12)
const STOPS_LABEL_HALO_WIDTH = 1
const STOPS_LABEL_HALO_BLUR = 0.25
/** Selected stop: icon, text-size, and halo scale (not `text-offset` — offset is ems × font size already). */
const STOPS_SELECTION_SCALE = 1.52

function stopMapLabel(s) {
  const name = String(
    s.descr ??
      s.StopDescr ??
      s.StopDescrEng ??
      s.stop_descr ??
      s.StopName ??
      ''
  ).trim()
  const idStr = passengerFacingStopId(s)
  const raw = name || (idStr ? `${idStr}` : 'Στάση')
  if (raw.length <= STOPS_LABEL_MAX_LEN) return raw
  return `${raw.slice(0, Math.max(0, STOPS_LABEL_MAX_LEN - 1))}…`
}

/** How often the stop popup refetches arrivals while open. */
const STOP_ARRIVALS_POLL_MS = 5_000
/** Live bus markers while a line is selected — same cadence as stop arrivals. */
const TRACKED_BUS_LOCATIONS_POLL_MS = 5_000
/** Bottom inset for stop popup arrivals list (safe area; locate is bottom-left, not under this panel). */
const STOP_POPUP_BOTTOM_RESERVE_PX = 36
const MOBILE_BREAKPOINT_PX = 640
const MOBILE_SHEET_MINIMIZED_BROWSE_PX = 68
const MOBILE_SHEET_MINIMIZED_STOP_PX = 68
const MOBILE_SHEET_PEEK_RATIO = 0.45
const MOBILE_SHEET_FULL_TOP_GAP_PX = 12
const MOBILE_STOP_FLOATING_EDGE_GAP_PX = 16
const MOBILE_STOP_PEEK_MEASURE_BUFFER_PX = 10
const MOBILE_STOP_POPUP_LOADING_CONTENT_PX = 120
const MOBILE_STOP_PEEK_LOADING_CHROME_PX = 82
const MOBILE_STOP_PEEK_LOADING_PX =
  MOBILE_STOP_POPUP_LOADING_CONTENT_PX + MOBILE_STOP_PEEK_LOADING_CHROME_PX
const MOBILE_STOP_HEADER_DRAG_START_PX = 0.5
const MOBILE_STOP_HEADER_TAP_SLOP_PX = 6
const MOBILE_SHEET_VELOCITY_BIAS_PX_PER_MS = 0.45
const MOBILE_SHEET_SNAP_ORDER = ['minimized', 'peek', 'full']
const LS_SHOW_UNPLANNED_STOP_LINES = 'oasth:showUnplannedStopLines'
/** Live bus positions while a line is tracked from the stop popup. */
const LINE_TRACK_POLL_MS = 3_000

const EMPTY_GEOJSON_FC = { type: 'FeatureCollection', features: [] }
const TRACKED_ROUTE_LINE_CORE_ID = 'tracked-route-core'
/** Small vertex dots (same GeoJSON source as the line; painted above the polyline). */
const TRACKED_ROUTE_VERTICES_ID = 'tracked-route-vertices-layer'
const TRACKED_ROUTE_LABELS_ID = 'tracked-route-labels-layer'
/** Live vehicle: icon + line label as separate symbol layers (avoids combined placement glitches). */
const TRACKED_BUS_ICON_LAYER_ID = 'tracked-bus-icon'
const TRACKED_BUS_LINE_LABEL_LAYER_ID = 'tracked-bus-line-label'
const TRACKED_BUS_ARROW_LAYER_ID = 'tracked-bus-direction-arrow'
/** Inner dot for live vehicles on a tracked line. */
const TRACKED_BUS_DOT_RADIUS = 12
/** White border backdrop behind the live bus dot. */
const TRACKED_BUS_DOT_BORDER_RADIUS = 13
const TRACKED_BUS_LINE_TEXT_SIZE = 11
/** Live bus line badge on map — bold stack (Mapbox has no numeric font-weight). */
const TRACKED_BUS_LINE_LABEL_FONTS = [
  'SF Pro Text Heavy',
  'Arial Unicode MS Bold',
]
const TRACKED_BUS_LINE_LABEL_HALO_WIDTH = 1.7
const TRACKED_BUS_LINE_LABEL_HALO_BLUR = 0.12
const TRACKED_BUS_ARROW_ICON_ID = 'oasth-live-arrow'
const TRACKED_BUS_ARROW_ICON_SIZE = 0.275
const TRACKED_ROUTE_PRIMARY_COLOR = '#1e3a8a'
const TRACKED_ROUTE_VARIANT_COLORS = [
  TRACKED_ROUTE_PRIMARY_COLOR,
  '#34c759',
  '#ff9500',
  '#af52de',
  '#ff2d55',
  '#30b0c7',
]

function trackedRouteColorAt(index) {
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0) return TRACKED_ROUTE_VARIANT_COLORS[0]
  return TRACKED_ROUTE_VARIANT_COLORS[i % TRACKED_ROUTE_VARIANT_COLORS.length]
}

function trackedRouteCodesForMap(routeCode) {
  const current = String(routeCode ?? '').trim()
  if (!current) return []
  return [current]
}

const LS_FAVORITE_STOPS = 'oasth:favoriteStopIds'
const LS_RECENT_LINES = 'oasth:recentLines'
const LS_LEFT_SIDEBAR_PANEL = 'oasth:leftSidebarPanel'
const LS_SIDEBAR_SEARCH_RECENT = 'oasth:sidebarSearchRecent'
const SIDEBAR_SEARCH_RECENT_MAX = 4
const RECENT_LINES_MAX = 10

const LEFT_SIDEBAR_PANELS = new Set([
  'home',
  'favoriteStops',
  'allLines',
])

function isMobileViewportNow() {
  if (typeof window === 'undefined') return false
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
}

function readVisualViewportHeight() {
  if (typeof window === 'undefined') return 0
  const vvHeight = window.visualViewport?.height
  if (Number.isFinite(vvHeight) && vvHeight > 0) return Math.round(vvHeight)
  return Math.round(window.innerHeight)
}

function mobileSheetSnapHeights(
  mode,
  viewportHeight,
  stopPeekHeight = null,
  sheetBottomOffsetPx = MOBILE_STOP_FLOATING_EDGE_GAP_PX
) {
  const safeViewport = Math.max(320, Number(viewportHeight) || 0)
  const floatingGap = Math.max(
    MOBILE_STOP_FLOATING_EDGE_GAP_PX,
    Math.round(Number(sheetBottomOffsetPx) || 0)
  )
  const maxExpandedHeight = Math.max(
    MOBILE_SHEET_MINIMIZED_STOP_PX,
    safeViewport - MOBILE_SHEET_FULL_TOP_GAP_PX - floatingGap
  )
  const minimized =
    mode === 'stop'
      ? MOBILE_SHEET_MINIMIZED_STOP_PX
      : MOBILE_SHEET_MINIMIZED_BROWSE_PX
  const defaultPeek = Math.max(
    minimized,
    Math.min(
      maxExpandedHeight,
      Math.round(safeViewport * MOBILE_SHEET_PEEK_RATIO)
    )
  )
  const peek =
    mode === 'stop' && Number.isFinite(stopPeekHeight) && stopPeekHeight > 0
      ? Math.max(minimized, Math.min(defaultPeek, Math.round(stopPeekHeight)))
      : defaultPeek
  const full = Math.max(
    defaultPeek,
    maxExpandedHeight
  )
  return { minimized, peek, full }
}

function stopPopupMobilePeekContentHeight({
  arrivalsListEl,
  arrivalsScrollContentEl,
  arrivalsRegionEl,
}) {
  if (arrivalsListEl) return Math.ceil(arrivalsListEl.scrollHeight)
  if (arrivalsScrollContentEl) return Math.ceil(arrivalsScrollContentEl.scrollHeight)
  const viewport = arrivalsRegionEl?.querySelector('.stop-popup-arrivals-viewport')
  if (viewport instanceof HTMLElement) {
    return Math.max(
      MOBILE_STOP_POPUP_LOADING_CONTENT_PX,
      Math.ceil(viewport.getBoundingClientRect().height)
    )
  }
  return 0
}

function nextMobileSheetSnap(current) {
  const idx = MOBILE_SHEET_SNAP_ORDER.indexOf(current)
  if (idx === -1) return 'peek'
  return MOBILE_SHEET_SNAP_ORDER[(idx + 1) % MOBILE_SHEET_SNAP_ORDER.length]
}

function mobileSheetSnapFromHeight(heights, currentSnap, nextHeight, velocityY = 0) {
  const entries = MOBILE_SHEET_SNAP_ORDER
    .map((snap) => [snap, heights?.[snap] ?? 0])
    .filter(([, value]) => Number.isFinite(value) && value > 0)
  if (entries.length === 0) return currentSnap || 'minimized'

  const currentIndex = Math.max(
    0,
    MOBILE_SHEET_SNAP_ORDER.indexOf(currentSnap)
  )
  if (velocityY <= -MOBILE_SHEET_VELOCITY_BIAS_PX_PER_MS) {
    return MOBILE_SHEET_SNAP_ORDER[Math.min(entries.length - 1, currentIndex + 1)]
  }
  if (velocityY >= MOBILE_SHEET_VELOCITY_BIAS_PX_PER_MS) {
    return MOBILE_SHEET_SNAP_ORDER[Math.max(0, currentIndex - 1)]
  }
  return entries.reduce((best, entry) => {
    if (!best) return entry
    return Math.abs(entry[1] - nextHeight) < Math.abs(best[1] - nextHeight)
      ? entry
      : best
  }, null)?.[0] ?? currentSnap ?? 'minimized'
}

function resetMobileSheetResizeGesture({
  pointerIdRef,
  dragSourceRef,
  dragMovedRef,
  lastDragSampleRef,
  resetSource = null,
}) {
  pointerIdRef.current = null
  if (dragSourceRef) dragSourceRef.current = resetSource
  dragMovedRef.current = false
  lastDragSampleRef.current = null
}

function startMobileSheetResizeGesture({
  e,
  source,
  heights,
  snap,
  pointerIdRef,
  dragSourceRef,
  dragStartXRef,
  dragStartYRef,
  dragStartHeightRef,
  lastDragSampleRef,
  dragMovedRef,
  onDragStateChange,
  onLiveHeightChange,
  activateDragState = true,
  seedLiveHeight = false,
}) {
  pointerIdRef.current = e.pointerId
  dragSourceRef.current = source
  dragStartXRef.current = e.clientX
  dragStartYRef.current = e.clientY
  dragStartHeightRef.current = heights?.[snap] ?? heights?.minimized ?? 0
  lastDragSampleRef.current = { y: e.clientY, time: Date.now() }
  dragMovedRef.current = false
  onDragStateChange?.(activateDragState)
  if (seedLiveHeight) {
    onLiveHeightChange?.(dragStartHeightRef.current)
  }
  e.currentTarget.setPointerCapture?.(e.pointerId)
}

function updateMobileSheetResizeGesture({
  e,
  heights,
  pointerIdRef,
  dragStartXRef,
  dragStartYRef,
  dragStartHeightRef,
  lastDragSampleRef,
  dragMovedRef,
  onLiveHeightChange,
  moveSlopPx = 3,
}) {
  if (pointerIdRef.current == null || pointerIdRef.current !== e.pointerId) {
    return null
  }
  const deltaX = e.clientX - dragStartXRef.current
  const deltaY = e.clientY - dragStartYRef.current
  const travelPx = Math.hypot(deltaX, deltaY)
  const minHeight = heights?.minimized ?? 0
  const maxHeight = heights?.full ?? minHeight
  const nextHeight = Math.max(
    minHeight,
    Math.min(maxHeight, dragStartHeightRef.current - deltaY)
  )
  const wasMoved = dragMovedRef.current
  if (Math.abs(deltaY) > moveSlopPx) dragMovedRef.current = true
  onLiveHeightChange?.(nextHeight)
  lastDragSampleRef.current = { y: e.clientY, time: Date.now() }
  e.preventDefault()
  return {
    deltaX,
    deltaY,
    travelPx,
    nextHeight,
    moved: dragMovedRef.current,
    justMoved: !wasMoved && dragMovedRef.current,
  }
}

function finishMobileSheetResizeGesture({
  e,
  heights,
  pointerIdRef,
  dragSourceRef,
  dragStartXRef,
  dragStartYRef,
  dragStartHeightRef,
  lastDragSampleRef,
  dragMovedRef,
  onDragStateChange,
  onLiveHeightChange,
  resetSource = null,
}) {
  if (pointerIdRef.current == null || pointerIdRef.current !== e.pointerId) {
    return null
  }
  const dragSource = dragSourceRef.current
  const deltaX = e.clientX - dragStartXRef.current
  const deltaY = e.clientY - dragStartYRef.current
  const travelPx = Math.hypot(deltaX, deltaY)
  const minHeight = heights?.minimized ?? 0
  const maxHeight = heights?.full ?? minHeight
  const nextHeight = Math.max(
    minHeight,
    Math.min(maxHeight, dragStartHeightRef.current - deltaY)
  )
  const lastSample = lastDragSampleRef.current
  const now = Date.now()
  const dt = Math.max(1, now - (lastSample?.time ?? now))
  const velocityY = (e.clientY - (lastSample?.y ?? e.clientY)) / dt
  const moved = dragMovedRef.current

  onLiveHeightChange?.(null)
  onDragStateChange?.(false)
  resetMobileSheetResizeGesture({
    pointerIdRef,
    dragSourceRef,
    dragMovedRef,
    lastDragSampleRef,
    resetSource,
  })

  return {
    dragSource,
    deltaX,
    deltaY,
    travelPx,
    nextHeight,
    velocityY,
    moved,
  }
}

function readShowUnplannedStopLinesPref() {
  try {
    return localStorage.getItem(LS_SHOW_UNPLANNED_STOP_LINES) === '1'
  } catch {
    return false
  }
}

function readSidebarSearchRecent() {
  try {
    const raw = localStorage.getItem(LS_SIDEBAR_SEARCH_RECENT)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.slice(0, SIDEBAR_SEARCH_RECENT_MAX)
  } catch {
    return []
  }
}

function sidebarSearchRecentKey(entry) {
  if (!entry || typeof entry !== 'object') return ''
  if (entry.kind === 'stop' && entry.stop != null) {
    return `s:${String(entry.stop.id ?? '')}`
  }
  if (entry.kind === 'lineDir' && entry.row && entry.variant) {
    const lc = String(
      entry.row.LineCode ?? entry.row.line_code ?? entry.row.lineCode ?? ''
    ).trim()
    const rc = String(entry.variant.routeCode ?? '').trim()
    return `ld:${lc}:${rc}`
  }
  if (entry.kind === 'line' && entry.row) {
    const lc = String(
      entry.row.LineCode ?? entry.row.line_code ?? entry.row.lineCode ?? ''
    ).trim()
    return `l:${lc}`
  }
  try {
    return `x:${JSON.stringify(entry).slice(0, 200)}`
  } catch {
    return 'x:invalid'
  }
}

function pushSidebarSearchRecent(entry) {
  try {
    const prev = readSidebarSearchRecent()
    const k = sidebarSearchRecentKey(entry)
    const filtered = prev.filter((e) => sidebarSearchRecentKey(e) !== k)
    const next = [entry, ...filtered].slice(0, SIDEBAR_SEARCH_RECENT_MAX)
    localStorage.setItem(LS_SIDEBAR_SEARCH_RECENT, JSON.stringify(next))
    return next
  } catch {
    return readSidebarSearchRecent()
  }
}

function removeSidebarSearchRecent(entry) {
  try {
    const prev = readSidebarSearchRecent()
    const k = sidebarSearchRecentKey(entry)
    const next = prev.filter((e) => sidebarSearchRecentKey(e) !== k)
    localStorage.setItem(LS_SIDEBAR_SEARCH_RECENT, JSON.stringify(next))
    return next
  } catch {
    return readSidebarSearchRecent()
  }
}

function cloneForRecentStorage(x) {
  try {
    return JSON.parse(JSON.stringify(x))
  } catch {
    return x
  }
}

function normalizeStoredLineEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const routeCode = String(entry.routeCode ?? '').trim()
  if (!routeCode) return null
  const lineCode = String(entry.lineCode ?? '').trim()
  const lineId = String(entry.lineId ?? '').trim()
  const lineBadgeShort = String(entry.lineBadgeShort ?? '').trim() || routeCode
  const lineBadgeTitle = String(entry.lineBadgeTitle ?? '').trim()
  const directionLabel = String(entry.directionLabel ?? '').trim()
  const anchorStopId = String(entry.anchorStopId ?? '').trim()
  return {
    routeCode,
    lineCode: lineCode || undefined,
    lineId: lineId || undefined,
    lineBadgeShort,
    lineBadgeTitle: lineBadgeTitle || undefined,
    directionLabel: directionLabel || undefined,
    anchorStopId: anchorStopId || undefined,
  }
}

function storedLineEntryKey(entry) {
  const routeCode = String(entry?.routeCode ?? '').trim()
  if (!routeCode) return ''
  const canon = String(canonNumish(routeCode) ?? '').trim()
  return canon || routeCode
}

function normalizeStoredLineEntries(rows, limit = RECENT_LINES_MAX) {
  const seen = new Set()
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = normalizeStoredLineEntry(row)
    if (!entry) continue
    const key = storedLineEntryKey(entry)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(entry)
    if (out.length >= limit) break
  }
  return out
}

function sidebarRecentLineToStoredLine(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (entry.kind !== 'lineDir' || !entry.row || !entry.variant) return null
  const row = entry.row
  const variant = entry.variant
  const routeCode = String(variant.routeCode ?? '').trim()
  if (!routeCode) return null
  const lineCode = String(
    row.LineCode ?? row.line_code ?? row.lineCode ?? ''
  ).trim()
  const lineId = String(
    row.LineID ?? row.LineIDGR ?? row.LineId ?? row.line_id ?? ''
  ).trim()
  const lineBadgeShort = lineId.replace(/\s+/g, ' ').trim() || routeCode
  const lineBadgeTitle = String(row.LineDescr ?? row.line_descr ?? '').trim()
  const directionLabel = String(variant.label ?? '').trim()
  return normalizeStoredLineEntry({
    routeCode,
    lineCode: lineCode || undefined,
    lineId: lineId || undefined,
    lineBadgeShort,
    lineBadgeTitle: lineBadgeTitle || undefined,
    directionLabel: directionLabel || undefined,
    anchorStopId: undefined,
  })
}

function readLeftSidebarPanel() {
  try {
    const v = localStorage.getItem(LS_LEFT_SIDEBAR_PANEL)
    if (v === 'fav-stops') return 'favoriteStops'
    if (v === 'fav-lines' || v === 'favorites') return 'favoriteStops'
    if (v && LEFT_SIDEBAR_PANELS.has(v)) return v
  } catch {
    /* ignore */
  }
  return 'home'
}

function writeLeftSidebarPanel(panel) {
  if (!LEFT_SIDEBAR_PANELS.has(panel)) return
  try {
    localStorage.setItem(LS_LEFT_SIDEBAR_PANEL, panel)
  } catch {
    /* ignore */
  }
}

function readRecentLines() {
  try {
    const raw = localStorage.getItem(LS_RECENT_LINES)
    if (raw) {
      const arr = JSON.parse(raw)
      return normalizeStoredLineEntries(arr, RECENT_LINES_MAX)
    }
  } catch {
    /* ignore and fall back */
  }
  return normalizeStoredLineEntries(
    readSidebarSearchRecent().map(sidebarRecentLineToStoredLine),
    RECENT_LINES_MAX
  )
}

function writeRecentLines(rows) {
  try {
    localStorage.setItem(
      LS_RECENT_LINES,
      JSON.stringify(normalizeStoredLineEntries(rows, RECENT_LINES_MAX))
    )
  } catch {
    /* ignore */
  }
}

function readOrderedIds(key) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    const seen = new Set()
    const out = []
    for (const v of arr) {
      const id = String(v ?? '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  } catch {
    return []
  }
}

function writeOrderedIds(key, ids) {
  try {
    localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    /* ignore quota / private mode */
  }
}

function moveArrayItem(arr, fromIndex, toIndex) {
  if (!Array.isArray(arr)) return []
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= arr.length ||
    toIndex >= arr.length
  ) {
    return arr
  }
  const next = [...arr]
  const [item] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, item)
  return next
}

/** Great-circle distance in meters (haversine). */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Outline “location heading” arrow (classic map / GPS wedge, points north on the map).
 * Filled when `filled` — when the map view is centered on the user.
 */
function LocationArrowIcon({ filled }) {
  return (
    <Navigation2
      size={20}
      strokeWidth={1.75}
      fill={filled ? 'currentColor' : 'none'}
      className="locate-me-arrow"
      aria-hidden
    />
  )
}

function MapBaseStyleIcon({ mode }) {
  const p = { size: 20, strokeWidth: 2, 'aria-hidden': true }
  if (mode === 'streets') return <MapIcon {...p} />
  if (mode === 'light') return <Sun {...p} />
  return <Moon {...p} />
}

/** Max distance from map center to user (m) to show the solid locate icon. */
const LOCATE_CENTER_MAX_M = 35
/** Minimum zoom to treat the view as “location focused”. */
const LOCATE_MIN_ZOOM = 14

/** Pixels vs zoom — solid user dot with white border (no outer halo ring). */
const USER_DOT_CORE_RADIUS = [
  'interpolate',
  ['linear'],
  ['zoom'],
  9,
  3.5,
  11,
  4.5,
  13,
  5.5,
  15,
  7,
  17,
  8.5,
  19,
  10,
  21,
  11.5,
]

const USER_DOT_STROKE_WIDTH = [
  'interpolate',
  ['linear'],
  ['zoom'],
  9,
  2,
  13,
  2.5,
  17,
  3,
  21,
  3.5,
]

function arrivalDirectionLabel(a) {
  const v =
    a.route_descr ??
    a.RouteDescr ??
    a.route_descr_eng ??
    a.RouteDescrEng ??
    a.route_departure_eng ??
    a.LineDescr ??
    a.line_descr ??
    a.linedescr ??
    a.route_direction_el ??
    a.descr ??
    a.descr_el ??
    a.name_el;
  if (v != null && String(v).trim()) return String(v).trim();
  return '—'
}

function arrivalLineBadge(a) {
  const pub = a.line_id ?? a.LineID;
  if (pub != null && String(pub).trim()) return String(pub).trim();
  const rc = a.route_code ?? a.RouteCode;
  if (rc != null && String(rc).trim()) return String(rc).trim();
  return '—'
}

/** Badge shows at most 3 characters; full code in `title` when truncated. */
function arrivalLineBadgeDisplay(a) {
  const line = arrivalLineBadge(a)
  if (line === '—') return { text: line, title: undefined }
  const s = String(line)
  if (s.length <= 3) return { text: s, title: undefined }
  return { text: s.slice(0, 3), title: s }
}

function arrivalEtaMinutes(a) {
  const raw = Number.parseInt(String(a?.btime2 ?? '').trim(), 10)
  return Number.isFinite(raw) && raw >= 0 ? raw : Number.POSITIVE_INFINITY
}

/** `webGetRoutes` row → arrival-shaped object for badge / direction helpers. */
function routeRowToArrivalLikeForDisplay(row) {
  return {
    line_id: row.LineID ?? row.LineId ?? row.line_id,
    LineID: row.LineID ?? row.LineId ?? row.line_id,
    route_code: row.LineCode ?? row.line_code,
    RouteCode: row.RouteCode ?? row.route_code,
    route_descr: row.RouteDescr ?? row.route_descr,
    RouteDescr: row.RouteDescr,
    route_descr_eng: row.RouteDescrEng ?? row.route_descr_eng,
    RouteDescrEng: row.RouteDescrEng,
  }
}

/** Match OASTH `webGetRoutes` / `webRoutesForStop` line id keys (numeric strip). */
function normalizeLineIdKey(v) {
  if (v == null || v === '') return ''
  const s = String(v).trim()
  if (/^\d+$/.test(s)) return String(parseInt(s, 10))
  return s
}

function routeCodesMatch(a, b) {
  if (a == null || b == null) return false
  const sa = String(a).trim()
  const sb = String(b).trim()
  if (sa === sb) return true
  const na = canonNumish(a)
  const nb = canonNumish(b)
  return Boolean(na && nb && na === nb)
}

function routeCodeFromRouteRow(r) {
  if (!r) return ''
  const v =
    r.RouteCode ??
    r.route_code ??
    r.ROUTE_CODE ??
    r.Route_Id ??
    r.route_id
  return v != null && v !== '' ? String(v).trim() : ''
}

function findRouteRowByCode(rows, routeCode) {
  if (!Array.isArray(rows)) return null
  return (
    rows.find((r) => routeCodesMatch(routeCodeFromRouteRow(r), routeCode)) ?? null
  )
}

function buildPlannedRouteCodeSet(arrivals, routesAtStop) {
  const planned = new Set()
  if (!Array.isArray(arrivals)) return planned
  for (const a of arrivals) {
    const embedded = String(a.resolved_route_code ?? '').trim()
    if (embedded) {
      planned.add(canonNumish(embedded))
      continue
    }
    if (Array.isArray(routesAtStop) && routesAtStop.length > 0) {
      const rc = resolveArrivalRouteCode(a, routesAtStop)
      if (rc) planned.add(canonNumish(rc))
    }
  }
  return planned
}

function unplannedRoutesAtStopList(routesAtStop, plannedCodes) {
  if (!Array.isArray(routesAtStop) || routesAtStop.length === 0) return []
  const seen = new Set()
  const out = []
  for (const r of routesAtStop) {
    const ck = canonNumish(routeCodeFromRouteRow(r))
    if (!ck || plannedCodes.has(ck)) continue
    if (seen.has(ck)) continue
    seen.add(ck)
    out.push(r)
  }
  return out
}

/** `webRoutesForStop` row → shape `onSelectArrival` / `resolveRouteCodeForMap` understand. */
function unplannedRouteRowToArrivalForMap(row) {
  const rc = routeCodeFromRouteRow(row)
  return {
    ...routeRowToArrivalLikeForDisplay(row),
    resolved_route_code: rc,
  }
}

/** Optional HUD fields when resolving the current row in a large `routes-for-stop` list. */
function findRouteRowWithLineMeta(rows, currentRouteCode, lineMeta) {
  let row = findRouteRowByCode(rows, currentRouteCode)
  if (row || !lineMeta) return row
  const keys = new Set(
    [
      normalizeLineIdKey(lineMeta.lineId),
      normalizeLineIdKey(lineMeta.lineBadgeShort),
      lineMeta.lineBadgeTitle
        ? normalizeLineIdKey(String(lineMeta.lineBadgeTitle).trim())
        : '',
    ].filter(Boolean)
  )
  if (!keys.size) return null
  const pool = rows.filter((r) =>
    keys.has(normalizeLineIdKey(r.LineID ?? r.LineId))
  )
  return findRouteRowByCode(pool, currentRouteCode)
}

/**
 * `getRoutesForLine` rows are minimal; `webGetRoutes` for the same LineCode adds RouteType / distances.
 * Prefer the official line route list, enriched when possible.
 */
function mergeOasthLineRouteRows(forLineRows, webGetRoutesRows) {
  if (!Array.isArray(forLineRows) || forLineRows.length === 0) {
    return Array.isArray(webGetRoutesRows) ? webGetRoutesRows : []
  }
  const byCode = new Map()
  if (Array.isArray(webGetRoutesRows)) {
    for (const r of webGetRoutesRows) {
      const rc = routeCodeFromRouteRow(r)
      if (rc && !byCode.has(rc)) byCode.set(rc, r)
    }
  }
  const out = []
  for (const r of forLineRows) {
    const rc = routeCodeFromRouteRow(r)
    if (!rc) continue
    const full = byCode.get(rc)
    out.push(full ? { ...r, ...full } : r)
  }
  return out
}

async function fetchMergedLineRoutes(lineCode) {
  const lc = String(lineCode ?? '').trim()
  if (!lc) return []
  const [forLine, webGr] = await Promise.all([
    apiPost(`/api/routes-for-line/${encodeURIComponent(lc)}`).catch(() => null),
    apiPost(`/api/routes/${encodeURIComponent(lc)}`).catch(() => null),
  ])
  return mergeOasthLineRouteRows(
    Array.isArray(forLine) ? forLine : [],
    Array.isArray(webGr) ? webGr : []
  )
}

function routeVariantLabelFromRow(row) {
  if (!row) return '—'
  const v =
    row.RouteDescr ??
    row.route_descr ??
    row.RouteDescrEng ??
    row.route_descr_eng ??
    row.route_departure_eng
  if (v != null && String(v).trim()) return String(v).trim()
  const rc = routeCodeFromRouteRow(row)
  return rc ? `Δρομολόγιο ${rc}` : '—'
}

/** One entry per internal RouteCode, order preserved from `rows`. */
function buildRouteVariantsFromMergedRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return []
  const byCode = new Map()
  for (const r of rows) {
    const rc = routeCodeFromRouteRow(r)
    if (!rc || byCode.has(rc)) continue
    byCode.set(rc, { routeCode: rc, label: routeVariantLabelFromRow(r) })
  }
  return [...byCode.values()]
}

/** Fallback when `LineCode` is missing: routes at this stop with the same published LineID. */
function buildRouteVariantsFromStopRows(stopRows, lineIdKey) {
  if (!Array.isArray(stopRows) || stopRows.length === 0) return []
  const key = normalizeLineIdKey(lineIdKey)
  if (!key) return []
  const filtered = stopRows.filter(
    (r) => normalizeLineIdKey(r.LineID ?? r.LineId) === key
  )
  return buildRouteVariantsFromMergedRows(filtered)
}

function ensureRouteVariantForCurrent(variants, routeCode, fallbackLabel) {
  const rc = String(routeCode ?? '').trim()
  if (!rc) return variants
  const list = Array.isArray(variants) ? [...variants] : []
  if (!list.some((v) => routeCodesMatch(v.routeCode, rc))) {
    list.unshift({
      routeCode: rc,
      label: fallbackLabel && String(fallbackLabel).trim()
        ? String(fallbackLabel).trim()
        : `Δρομολόγιο ${rc}`,
    })
  }
  return list
}

/** Row for HUD labels when we only know internal RouteCode. */
async function fetchRouteRowForMapDisplay(routeCode, anchorStopId, lineMeta) {
  const rc = String(routeCode ?? '').trim()
  if (!rc) return null
  const aid =
    anchorStopId != null && String(anchorStopId).trim() !== ''
      ? String(anchorStopId).trim()
      : ''
  if (aid) {
    try {
      const rs = await apiPost(`/api/routes-for-stop/${encodeURIComponent(aid)}`)
      if (Array.isArray(rs)) {
        const row =
          findRouteRowWithLineMeta(rs, rc, lineMeta) ?? findRouteRowByCode(rs, rc)
        if (row) return row
      }
    } catch {
      /* ignore */
    }
  }
  const keys = [lineMeta?.lineId, rc, lineMeta?.lineBadgeShort].filter(
    (k) => k != null && String(k).trim() !== ''
  )
  const seen = new Set()
  for (const key of keys) {
    const k = String(key).trim()
    if (seen.has(k)) continue
    seen.add(k)
    try {
      const rr = await apiPost(`/api/routes/${encodeURIComponent(k)}`)
      if (Array.isArray(rr)) {
        const row = findRouteRowByCode(rr, rc)
        if (row) return row
      }
    } catch {
      /* ignore */
    }
  }
  return null
}

/** Web Mercator: horizontal meters per pixel at latitude and zoom. */
function metersPerPixelAt(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

/* ── Stop details popup (map-anchored, compact) ───────────────────────── */

const SIDEBAR_SEARCH_MIN_LEN = 1
const SIDEBAR_SEARCH_MAX_STOPS = 14
const SIDEBAR_SEARCH_MAX_LINES = 14

function normalizeSearchText(s) {
  try {
    return String(s ?? '')
      .trim()
      .toLocaleLowerCase('el-GR')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
  } catch {
    return String(s ?? '').trim().toLowerCase()
  }
}

const GREEKLISH_TO_GREEK = {
  th: 'θ', ch: 'χ', ps: 'ψ', ks: 'ξ', ou: 'ου', ei: 'ει', oi: 'οι',
  ai: 'αι', ev: 'ευ', ef: 'εφ', av: 'αυ', af: 'αφ', mp: 'μπ', nt: 'ντ',
  gk: 'γκ', gg: 'γγ',
  a: 'α', b: 'β', v: 'β', g: 'γ', d: 'δ', e: 'ε', z: 'ζ', h: 'η',
  i: 'ι', k: 'κ', l: 'λ', m: 'μ', n: 'ν', x: 'ξ', o: 'ο', p: 'π',
  r: 'ρ', s: 'σ', t: 'τ', u: 'υ', y: 'υ', f: 'φ', w: 'ω', c: 'κ',
  j: 'τζ', q: 'κ',
}
const GREEKLISH_KEYS = Object.keys(GREEKLISH_TO_GREEK).sort((a, b) => b.length - a.length)

function greeklishToGreek(s) {
  const low = s.toLowerCase()
  let out = ''
  let i = 0
  while (i < low.length) {
    let matched = false
    for (const key of GREEKLISH_KEYS) {
      if (low.startsWith(key, i)) {
        out += GREEKLISH_TO_GREEK[key]
        i += key.length
        matched = true
        break
      }
    }
    if (!matched) {
      out += low[i]
      i++
    }
  }
  return out
}

/** Fold η→ι, ω→ο, and final ς→σ for stop name matching. */
function foldGreekStopSearch(s) {
  return s
    .replace(/\u03b7/g, '\u03b9')
    .replace(/\u03c9/g, '\u03bf')
    .replace(/\u03c2/g, '\u03c3')
}

/**
 * Strip abbreviation punctuation, dashes, and spaces so compact queries match published names
 * (e.g. Τ.Σ. without dots; "foo bar" without hyphen vs "foo-bar").
 */
function compactStopSearchText(foldedLower) {
  return String(foldedLower ?? '')
    .replace(/[.\u00b7·\u0387\p{Pd}]/gu, '')
    .replace(/\s+/g, '')
}

/**
 * Greek letters that appear in published line IDs (ΟΑΣΘ) folded onto Latin for search.
 * After normalizeSearchText, capitals are usually already Greek lowercase.
 */
function foldLineSearchString(s) {
  let t = normalizeSearchText(s)
  t = t.replace(/\u03ba/g, 'k') // κ
  t = t.replace(/\u03bf/g, 'o') // ο (vs Latin o)
  t = t.replace(/\u03bd/g, 'n') // ν (published ids sometimes use Ν)
  return t
}

/**
 * Digit-only match on one id string: `1` ↔ `01`, `01N`, `10`, `11`; `12` ↔ `12Κ`.
 * Leading digit run (parseInt) plus prefix on that run. Used for published line badges in search/browse.
 */
function publishedBadgeMatchesDigitQuery(qDigits, badgeFoldedCompact) {
  const qn = parseInt(qDigits, 10)
  if (Number.isNaN(qn)) return false
  const s = String(badgeFoldedCompact ?? '').trim()
  if (!s) return false

  if (/^\d+$/.test(s)) {
    const n = parseInt(canonNumish(s), 10)
    return !Number.isNaN(n) && n === qn
  }

  const m = s.match(/^(\d+)/)
  if (!m) return false
  const run = m[1]
  const runVal = parseInt(run, 10)
  if (!Number.isNaN(runVal) && runVal === qn) return true
  return run.startsWith(qDigits)
}

function sidebarSearchMinSatisfied(queryRaw) {
  const t = String(queryRaw ?? '').trim()
  if (t.length === 0) return false
  if (normalizeSearchText(queryRaw).length >= SIDEBAR_SEARCH_MIN_LEN) return true
  const digitsOnly = t.replace(/\s+/g, '')
  return /^\d+$/.test(digitsOnly) && digitsOnly.length >= 1
}

/** Trimmed query starts with ASCII digit — show bus line hits before stops in the sidebar. */
function sidebarSearchPrioritizeBusLines(queryRaw) {
  return /^\d/.test(String(queryRaw ?? '').trim())
}

function lineRowMatchesSidebarSearch(queryRaw, row) {
  const qFold = foldLineSearchString(queryRaw)
  const qSpaced = qFold.replace(/\s+/g, ' ').trim()
  const qCompact = qFold.replace(/\s+/g, '')
  /* Only ids / codes — not LineDescr (often overlaps direction names and clutters search). */
  const idFields = [
    row.LineCode,
    row.line_code,
    row.lineCode,
    row.LineID,
    row.LineIDGR,
    row.LineId,
    row.line_id,
  ]

  /*
   * Digit-only query: published ids (LineIDGR, …) can include a letter suffix (e.g. 91Κ).
   * Use the same flexible digit logic as the line list filter for those fields only.
   * Internal LineCode must not use digit-prefix matching or "91" would hit "1091".
   */
  if (/^\d+$/.test(qCompact)) {
    const qn = parseInt(qCompact, 10)
    if (Number.isNaN(qn)) return false
    const publishedIds = [
      row.LineIDGR,
      row.LineID,
      row.LineId,
      row.line_id,
    ]
    for (const x of publishedIds) {
      if (x == null) continue
      const raw = String(x).trim()
      if (!raw) continue
      const folded = foldLineSearchString(raw).replace(/\s+/g, '')
      if (publishedBadgeMatchesDigitQuery(qCompact, folded)) return true
    }
    const internalCodes = [row.LineCode, row.line_code, row.lineCode]
    for (const x of internalCodes) {
      if (x == null) continue
      const raw = String(x).trim()
      if (!raw) continue
      const folded = foldLineSearchString(raw).replace(/\s+/g, '')
      if (/^\d+$/.test(folded)) {
        const n = parseInt(canonNumish(folded), 10)
        if (!Number.isNaN(n) && n === qn) return true
        continue
      }
      const m = folded.match(/^(\d+)/)
      if (m) {
        const runVal = parseInt(m[1], 10)
        if (!Number.isNaN(runVal) && runVal === qn) return true
      }
    }
    return false
  }

  const hay = idFields
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => foldLineSearchString(String(x)))
    .join(' ')
  const hayCompact = hay.replace(/\s+/g, '')
  return (
    hay.includes(qSpaced) ||
    (qCompact.length > 0 && hayCompact.includes(qCompact))
  )
}

/**
 * Like `lineRowMatchesSidebarSearch` but only against the published line number
 * (ΟΑΣΘ badge: LineIDGR / LineID / …) — not internal `LineCode`, and not description.
 */
function lineRowMatchesPublishedLineNumberOnly(queryRaw, row) {
  const qFold = foldLineSearchString(queryRaw)
  const qSpaced = qFold.replace(/\s+/g, ' ').trim()
  const qCompact = qFold.replace(/\s+/g, '')
  const publishedOnly = [
    row.LineIDGR,
    row.LineID,
    row.LineId,
    row.line_id,
  ]

  if (/^\d+$/.test(qCompact)) {
    for (const x of publishedOnly) {
      if (x == null) continue
      const raw = String(x).trim()
      if (!raw) continue
      const folded = foldLineSearchString(raw).replace(/\s+/g, '')
      if (publishedBadgeMatchesDigitQuery(qCompact, folded)) return true
    }
    return false
  }

  const hay = publishedOnly
    .filter((x) => x != null && String(x).trim() !== '')
    .map((x) => foldLineSearchString(String(x)))
    .join(' ')
  const hayCompact = hay.replace(/\s+/g, '')
  return (
    hay.includes(qSpaced) ||
    (qCompact.length > 0 && hayCompact.includes(qCompact))
  )
}

/** Sort key for browsing the full `webGetLines` list (published id, then internal code). */
function webGetLinesRowBrowseSortKey(row) {
  return String(
    row.LineIDGR ??
      row.LineID ??
      row.LineId ??
      row.line_id ??
      row.LineCode ??
      row.line_code ??
      ''
  ).trim()
}

function compareWebGetLinesBrowse(a, b) {
  const ka = webGetLinesRowBrowseSortKey(a)
  const kb = webGetLinesRowBrowseSortKey(b)
  return ka.localeCompare(kb, 'el', { numeric: true, sensitivity: 'base' })
}

function favoriteStopDisplayInfo(stop) {
  const showId = passengerFacingStopId(stop)
  const title = String(stop?.descr || '').trim() || `${showId}`
  const street = String(stop?.street || '').trim()
  return {
    title,
    street,
    subtitle: showId ? `${showId}${street ? ` · ${street}` : ''}` : street,
  }
}

function FavoriteStopsList({
  favoriteStopsSorted,
  onPickFavoriteStop,
  onRemoveFavoriteStop,
  onReorderFavoriteStop,
  listKeyPrefix = 'favorite-stop',
}) {
  const [draggedStopId, setDraggedStopId] = useState(null)
  const [dropMarker, setDropMarker] = useState(null)
  const rowRefs = useRef(new Map())
  const dragPointerIdRef = useRef(null)
  const dragSurfaceRef = useRef(null)
  const dragStartYRef = useRef(0)
  const dragMovedRef = useRef(false)
  const suppressClickStopIdRef = useRef(null)

  const clearDragState = useCallback(() => {
    setDraggedStopId(null)
    setDropMarker(null)
  }, [])

  const setRowRef = useCallback((stopId, node) => {
    const key = String(stopId)
    if (!key) return
    if (node) rowRefs.current.set(key, node)
    else rowRefs.current.delete(key)
  }, [])

  const getDropMarkerForPoint = useCallback(
    (clientY) => {
      if (typeof onReorderFavoriteStop !== 'function' || !draggedStopId) return null
      let lastMarker = null
      for (const stop of favoriteStopsSorted) {
        const stopKey = String(stop.id)
        if (!stopKey || stopKey === draggedStopId) continue
        const row = rowRefs.current.get(stopKey)
        if (!(row instanceof HTMLElement)) continue
        const rect = row.getBoundingClientRect()
        const midpoint = rect.top + rect.height / 2
        if (clientY < midpoint) {
          return { stopId: stopKey, position: 'before' }
        }
        lastMarker = { stopId: stopKey, position: 'after' }
      }
      return lastMarker
    },
    [draggedStopId, favoriteStopsSorted, onReorderFavoriteStop]
  )

  const updateDropMarkerForPoint = useCallback(
    (clientY) => {
      const next = getDropMarkerForPoint(clientY)
      setDropMarker((prev) =>
        prev?.stopId === next?.stopId && prev?.position === next?.position
          ? prev
          : next
      )
      return next
    },
    [getDropMarkerForPoint]
  )

  const commitDrop = useCallback(
    (targetStopId, position) => {
      if (typeof onReorderFavoriteStop !== 'function' || !draggedStopId) {
        clearDragState()
        return
      }
      const sourceIndex = favoriteStopsSorted.findIndex(
        (stop) => String(stop.id) === draggedStopId
      )
      const targetIndex = favoriteStopsSorted.findIndex(
        (stop) => String(stop.id) === String(targetStopId)
      )
      if (sourceIndex === -1 || targetIndex === -1) {
        clearDragState()
        return
      }
      let nextIndex = targetIndex + (position === 'after' ? 1 : 0)
      if (sourceIndex < nextIndex) nextIndex -= 1
      const boundedIndex = Math.max(
        0,
        Math.min(favoriteStopsSorted.length - 1, nextIndex)
      )
      onReorderFavoriteStop(draggedStopId, boundedIndex)
      clearDragState()
    },
    [
      clearDragState,
      draggedStopId,
      favoriteStopsSorted,
      onReorderFavoriteStop,
    ]
  )

  const finishPointerDrag = useCallback(
    (pointerId, marker = null) => {
      if (pointerId != null && dragSurfaceRef.current?.hasPointerCapture?.(pointerId)) {
        dragSurfaceRef.current.releasePointerCapture(pointerId)
      }
      dragPointerIdRef.current = null
      dragSurfaceRef.current = null
      dragStartYRef.current = 0
      dragMovedRef.current = false
      if (marker?.stopId) commitDrop(marker.stopId, marker.position)
      else clearDragState()
    },
    [clearDragState, commitDrop]
  )

  return (
    <ul className="map-left-sidebar-list map-left-sidebar-search-list">
      {favoriteStopsSorted.map((stop, index) => {
        const { title, subtitle } = favoriteStopDisplayInfo(stop)
        const stopKey = String(stop.id)
        const isDragged = draggedStopId === stopKey
        const dropBefore =
          dropMarker?.stopId === stopKey && dropMarker.position === 'before'
        const dropAfter =
          dropMarker?.stopId === stopKey && dropMarker.position === 'after'
        return (
          <li
            key={`${listKeyPrefix}-${stop.id}`}
            ref={(node) => setRowRef(stop.id, node)}
            className={
              'map-left-sidebar-favorite-item' +
              (dropBefore ? ' map-left-sidebar-favorite-item--drop-before' : '') +
              (dropAfter ? ' map-left-sidebar-favorite-item--drop-after' : '')
            }
          >
            <div
              className={
                'map-left-sidebar-search-recent-item' +
                (isDragged ? ' map-left-sidebar-search-recent-item--dragging' : '')
              }
              onPointerDown={(e) => {
                if (typeof onReorderFavoriteStop !== 'function') return
                if (e.pointerType === 'mouse' && e.button !== 0) return
                if (
                  e.target instanceof Element &&
                  e.target.closest('.map-left-sidebar-search-recent-dismiss')
                ) {
                  return
                }
                dragPointerIdRef.current = e.pointerId
                dragSurfaceRef.current = e.currentTarget
                dragStartYRef.current = e.clientY
                dragMovedRef.current = false
                e.currentTarget.setPointerCapture?.(e.pointerId)
                setDraggedStopId(stopKey)
                setDropMarker(null)
              }}
              onPointerMove={(e) => {
                if (dragPointerIdRef.current !== e.pointerId) return
                if (!dragMovedRef.current && Math.abs(e.clientY - dragStartYRef.current) > 3) {
                  dragMovedRef.current = true
                  suppressClickStopIdRef.current = stopKey
                }
                if (!dragMovedRef.current) return
                e.preventDefault()
                updateDropMarkerForPoint(e.clientY)
              }}
              onPointerUp={(e) => {
                if (dragPointerIdRef.current !== e.pointerId) return
                if (!dragMovedRef.current) {
                  finishPointerDrag(e.pointerId, null)
                  return
                }
                e.preventDefault()
                const marker = updateDropMarkerForPoint(e.clientY)
                finishPointerDrag(e.pointerId, marker)
              }}
              onPointerCancel={(e) => {
                if (dragPointerIdRef.current !== e.pointerId) return
                finishPointerDrag(e.pointerId, null)
              }}
            >
              <button
                type="button"
                className="map-left-sidebar-search-hit map-left-sidebar-search-recent-hit"
                onClick={(e) => {
                  if (suppressClickStopIdRef.current === stopKey) {
                    suppressClickStopIdRef.current = null
                    e.preventDefault()
                    e.stopPropagation()
                    return
                  }
                  onPickFavoriteStop(stop)
                }}
              >
                <span
                  className="map-left-sidebar-search-hit-icon-wrap"
                  aria-hidden
                >
                  <MapPin size={17} strokeWidth={2} />
                </span>
                <span className="map-left-sidebar-search-hit-text">
                  <span className="map-left-sidebar-row-title" lang="el">
                    {title}
                  </span>
                  {subtitle ? (
                    <span
                      className="map-left-sidebar-row-sub"
                      lang="el"
                      title={subtitle}
                    >
                      {subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
              <div className="map-left-sidebar-search-recent-actions">
                <button
                  type="button"
                  className="map-left-sidebar-search-recent-dismiss"
                  aria-label="Αφαίρεση από τα αγαπημένα"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveFavoriteStop(stop.id)
                  }}
                >
                  <Trash2 size={12} strokeWidth={2.25} aria-hidden />
                </button>
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function MobileFavoriteStopsSection({
  favoriteStopsSorted,
  onPickFavoriteStop,
  onOpenFavoriteStops,
}) {
  return (
    <div className="map-left-sidebar-favorites-section">
      <button
        type="button"
        className="map-left-sidebar-section-link"
        onClick={onOpenFavoriteStops}
        aria-label="Άνοιγμα λίστας αγαπημένων στάσεων"
      >
        <span lang="el">Αγαπημένες στάσεις</span>
        <ChevronRight size={16} strokeWidth={2.25} aria-hidden />
      </button>
      {favoriteStopsSorted.length > 0 ? (
        <ul
          className="map-left-sidebar-mobile-stop-strip"
          aria-label="Αγαπημένες στάσεις"
        >
          {favoriteStopsSorted.map((stop) => {
            const { title, street } = favoriteStopDisplayInfo(stop)
            return (
              <li
                key={`mobile-favorite-stop-strip-${stop.id}`}
                className="map-left-sidebar-mobile-stop-strip-item"
              >
                <button
                  type="button"
                  className="map-left-sidebar-mobile-stop-card"
                  onClick={() => onPickFavoriteStop(stop)}
                  title={street ? `${title} · ${street}` : title}
                >
                  <span
                    className="map-left-sidebar-search-hit-icon-wrap map-left-sidebar-mobile-stop-card-icon"
                    aria-hidden
                  >
                    <MapPin size={17} strokeWidth={2} />
                  </span>
                  <span className="map-left-sidebar-mobile-stop-card-copy">
                    <span
                      className="map-left-sidebar-mobile-stop-card-label"
                      lang="el"
                    >
                      {title}
                    </span>
                    {street ? (
                      <span
                        className="map-left-sidebar-mobile-stop-card-sub"
                        lang="el"
                      >
                        {street}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="map-left-sidebar-empty map-left-sidebar-empty--compact" lang="el">
          Δεν έχετε αγαπημένες στάσεις ακόμη. Ανοίξτε μια στάση και πατήστε το
          κίτρινο αστέρι.
        </p>
      )}
    </div>
  )
}

function lineEntryDisplayInfo(entry) {
  const badge = String(entry?.lineBadgeShort ?? '').trim() ||
    String(entry?.routeCode ?? '').trim() ||
    '—'
  const subtitle =
    String(entry?.directionLabel ?? '').trim() ||
    String(entry?.lineBadgeTitle ?? '').trim()
  return { badge, subtitle }
}

function MobileRecentLinesSection({
  recentLines,
  onPickLine,
  onOpenAllLines,
}) {
  return (
    <div className="map-left-sidebar-favorites-section">
      <button
        type="button"
        className="map-left-sidebar-section-link"
        onClick={onOpenAllLines}
        aria-label="Άνοιγμα λίστας γραμμών"
      >
        <span lang="el">Γραμμές</span>
        <ChevronRight size={16} strokeWidth={2.25} aria-hidden />
      </button>
      {recentLines.length > 0 ? (
        <ul className="map-left-sidebar-mobile-line-strip" aria-label="Πρόσφατες γραμμές">
          {recentLines.map((entry, index) => {
            const { badge, subtitle } = lineEntryDisplayInfo(entry)
            return (
              <li
                key={`mobile-recent-line-${storedLineEntryKey(entry) || index}`}
                className="map-left-sidebar-mobile-line-strip-item"
              >
                <button
                  type="button"
                  className="map-left-sidebar-mobile-line-card"
                  onClick={() => onPickLine(entry)}
                  title={subtitle ? `${badge} · ${subtitle}` : badge}
                >
                  <span
                    className="map-left-sidebar-search-hit-icon-wrap map-left-sidebar-mobile-line-card-icon"
                    aria-hidden
                  >
                    <Bus size={17} strokeWidth={2} />
                  </span>
                  <span className="map-left-sidebar-mobile-line-card-copy">
                    <span
                      className="map-left-sidebar-mobile-line-card-badge"
                      lang="el"
                    >
                      {badge}
                    </span>
                    {subtitle ? (
                      <span
                        className="map-left-sidebar-mobile-line-card-sub"
                        lang="el"
                      >
                        {subtitle}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="map-left-sidebar-empty map-left-sidebar-empty--compact" lang="el">
          Οι 10 τελευταίες γραμμές που ανοίξατε θα εμφανίζονται εδώ.
        </p>
      )}
    </div>
  )
}

/** Filter for the all-lines panel: empty shows all; otherwise published line number only. */
function lineRowMatchesBrowseFilter(queryRaw, row) {
  const t = String(queryRaw ?? '').trim()
  if (!t) return true
  return lineRowMatchesPublishedLineNumberOnly(t, row)
}

/** Left drawer: search, stop favorites, drill-down lists. */
function MapLeftSidebar({
  panelView,
  onPanelViewChange,
  favoriteStopsSorted,
  onPickFavoriteStop,
  onRemoveFavoriteStop,
  onReorderFavoriteStop,
  recentLines,
  onPickLineEntry,
  favoriteStopIds,
  onToggleFavoriteStopSearch,
  searchStops,
  searchLines,
  onSearchPickLine,
  onSearchPickLineDirection,
  apiPost,
  homeSearchResetToken,
  onHomeSearchActiveChange,
  currentTrackedRouteCode,
  mobileUnified = false,
  onAnySearchFocus,
  homeSearchQuery,
  onHomeSearchQueryChange,
  homeSearchInputRef,
  allLinesSearchInputRef,
}) {
  const [sidebarSearchQueryState, setSidebarSearchQueryState] = useState('')
  const [sidebarSearchRecent, setSidebarSearchRecent] = useState(
    readSidebarSearchRecent
  )
  const [sidebarLineOpening, setSidebarLineOpening] = useState(false)
  const [lineSearchVariantsByCode, setLineSearchVariantsByCode] = useState({})
  const lineSearchVariantsFetchedRef = useRef(new Set())
  const [allLinesBrowseQuery, setAllLinesBrowseQuery] = useState('')
  const [lineSearchExpandedByCode, setLineSearchExpandedByCode] = useState({})
  /** Resolved by pole / SIP (`getStopBySIP`) when the user types a numeric code. */
  const [sipResolvedStop, setSipResolvedStop] = useState(null)
  const controlledHomeSearch = typeof homeSearchQuery === 'string'
  const sidebarSearchQuery = controlledHomeSearch
    ? homeSearchQuery
    : sidebarSearchQueryState
  const setSidebarSearchQuery = useCallback(
    (next) => {
      if (typeof next === 'function') {
        if (controlledHomeSearch) {
          const resolved = next(homeSearchQuery)
          onHomeSearchQueryChange?.(resolved)
          return
        }
        setSidebarSearchQueryState((prev) => {
          const resolved = next(prev)
          onHomeSearchQueryChange?.(resolved)
          return resolved
        })
        return
      }
      if (!controlledHomeSearch) setSidebarSearchQueryState(next)
      onHomeSearchQueryChange?.(next)
    },
    [controlledHomeSearch, homeSearchQuery, onHomeSearchQueryChange]
  )

  useEffect(() => {
    if (panelView !== 'home') {
      if (controlledHomeSearch) onHomeSearchQueryChange?.('')
      else setSidebarSearchQueryState('')
    }
    if (panelView !== 'allLines') setAllLinesBrowseQuery('')
    if (panelView !== 'home') setLineSearchExpandedByCode({})
  }, [controlledHomeSearch, onHomeSearchQueryChange, panelView])

  useEffect(() => {
    if (controlledHomeSearch) onHomeSearchQueryChange?.('')
    else setSidebarSearchQueryState('')
    setLineSearchExpandedByCode({})
  }, [controlledHomeSearch, homeSearchResetToken, onHomeSearchQueryChange])

  const allLinesBrowseRows = useMemo(() => {
    if (panelView !== 'allLines') return []
    const base = Array.isArray(searchLines) ? searchLines : []
    const filtered = base.filter((row) =>
      lineRowMatchesBrowseFilter(allLinesBrowseQuery, row)
    )
    filtered.sort(compareWebGetLinesBrowse)
    return filtered
  }, [panelView, searchLines, allLinesBrowseQuery])

  const sidebarSearchHits = useMemo(() => {
    if (panelView !== 'home') return { stops: [], lines: [] }
    if (!sidebarSearchMinSatisfied(sidebarSearchQuery))
      return { stops: [], lines: [] }
    const q = normalizeSearchText(sidebarSearchQuery)
    const qFold = foldGreekStopSearch(q)
    const qGreek = foldGreekStopSearch(greeklishToGreek(q))
    const qCompact = compactStopSearchText(qFold)
    const qGreekCompact = compactStopSearchText(qGreek)
    const stops = (searchStops ?? []).filter((s) => {
      const pole = normalizeSearchText(String(s.poleId ?? ''))
      const name = normalizeSearchText(s.descr ?? '')
      const street = normalizeSearchText(s.street ?? '')
      const nameF = foldGreekStopSearch(name)
      const streetF = foldGreekStopSearch(street)
      if (pole && pole.includes(q)) return true
      if (nameF.includes(qFold)) return true
      if (qGreek !== q && nameF.includes(qGreek)) return true
      if (streetF.includes(qFold)) return true
      if (qGreek !== q && streetF.includes(qGreek)) return true
      const nameC = compactStopSearchText(nameF)
      const streetC = compactStopSearchText(streetF)
      const compactHit = (hay) =>
        hay.length > 0 &&
        qCompact.length > 0 &&
        qCompact.length >= SIDEBAR_SEARCH_MIN_LEN &&
        hay.includes(qCompact)
      const compactHitGreek = (hay) =>
        hay.length > 0 &&
        qGreekCompact.length > 0 &&
        qGreekCompact !== qCompact &&
        qGreekCompact.length >= SIDEBAR_SEARCH_MIN_LEN &&
        hay.includes(qGreekCompact)
      if (compactHit(nameC) || compactHit(streetC)) return true
      if (compactHitGreek(nameC) || compactHitGreek(streetC)) return true
      return false
    })
    const lines = (searchLines ?? []).filter((row) =>
      lineRowMatchesSidebarSearch(sidebarSearchQuery, row)
    )
    return {
      stops: stops.slice(0, SIDEBAR_SEARCH_MAX_STOPS),
      lines: lines.slice(0, SIDEBAR_SEARCH_MAX_LINES),
    }
  }, [panelView, sidebarSearchQuery, searchStops, searchLines])

  const sidebarSearchQueryRef = useRef(sidebarSearchQuery)
  sidebarSearchQueryRef.current = sidebarSearchQuery

  useEffect(() => {
    if (panelView !== 'home') {
      setSipResolvedStop(null)
      return undefined
    }
    const raw = sidebarSearchQuery.trim().replace(/\s+/g, '')
    if (!/^\d{4,}$/.test(raw)) {
      setSipResolvedStop(null)
      return undefined
    }
    let alive = true
    const t = setTimeout(() => {
      apiPost(`/api/stop-by-sip/${encodeURIComponent(raw)}`)
        .then((res) => {
          if (!alive) return
          const qNow = sidebarSearchQueryRef.current.trim().replace(/\s+/g, '')
          if (qNow !== raw) return
          if (res && typeof res === 'object') {
            const sid = res.id ?? res.Id ?? res.ID
            if (sid != null && String(sid).trim() !== '') {
              const title =
                res.titleel ||
                res.titleen ||
                res.TitleEL ||
                res.TitleEN ||
                res.descr ||
                ''
              setSipResolvedStop({
                id: String(sid).trim(),
                descr: String(title),
                lat: String(res.lat ?? res.Lat ?? ''),
                lng: String(res.lng ?? res.Lng ?? ''),
                poleId: raw,
              })
            } else setSipResolvedStop(null)
          } else setSipResolvedStop(null)
        })
        .catch(() => {
          if (alive) setSipResolvedStop(null)
        })
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [panelView, sidebarSearchQuery, apiPost])

  const stopsForSearchDisplay = useMemo(() => {
    const base = sidebarSearchHits.stops
    if (!sipResolvedStop) return base
    const dupe = base.some((s) => String(s.id) === String(sipResolvedStop.id))
    if (dupe) {
      return base.map((s) => {
        if (String(s.id) !== String(sipResolvedStop.id)) return s
        if (String(s.poleId ?? '').trim()) return s
        return { ...s, poleId: sipResolvedStop.poleId }
      })
    }
    return [sipResolvedStop, ...base].slice(0, SIDEBAR_SEARCH_MAX_STOPS)
  }, [sidebarSearchHits.stops, sipResolvedStop])

  useEffect(() => {
    if (panelView !== 'home') return
    for (const row of sidebarSearchHits.lines) {
      const lc = String(
        row.LineCode ?? row.line_code ?? row.lineCode ?? ''
      ).trim()
      if (!lc || lineSearchVariantsFetchedRef.current.has(lc)) continue
      lineSearchVariantsFetchedRef.current.add(lc)
      setLineSearchVariantsByCode((prev) => ({
        ...prev,
        [lc]: { status: 'loading', variants: [] },
      }))
      fetchMergedLineRoutes(lc)
        .then((merged) => {
          const variants = buildRouteVariantsFromMergedRows(
            Array.isArray(merged) ? merged : []
          )
          setLineSearchVariantsByCode((prev) => ({
            ...prev,
            [lc]: { status: 'ready', variants },
          }))
        })
        .catch(() => {
          lineSearchVariantsFetchedRef.current.delete(lc)
          setLineSearchVariantsByCode((prev) => ({
            ...prev,
            [lc]: { status: 'error', variants: [] },
          }))
        })
    }
  }, [panelView, sidebarSearchHits.lines])

  const searchQOk =
    panelView === 'home' && sidebarSearchMinSatisfied(sidebarSearchQuery)
  useEffect(() => {
    onHomeSearchActiveChange?.(searchQOk)
  }, [searchQOk, onHomeSearchActiveChange])
  useEffect(() => {
    setLineSearchExpandedByCode({})
  }, [sidebarSearchQuery])
  const lineSearchGroups = useMemo(() => {
    const out = []
    for (let lix = 0; lix < sidebarSearchHits.lines.length; lix++) {
      const row = sidebarSearchHits.lines[lix]
      const lc = String(
        row.LineCode ?? row.line_code ?? row.lineCode ?? ''
      ).trim()
      const badge = String(
        row.LineIDGR ??
          row.LineID ??
          row.LineId ??
          row.line_id ??
          ''
      ).trim()
      const pack = lc ? lineSearchVariantsByCode[lc] : null
      const loading = !pack || pack.status === 'loading'
      const variants =
        pack?.status === 'ready' && Array.isArray(pack.variants)
          ? pack.variants
          : []
      out.push({
        key: lc ? `ln-${lc}` : `ln-${lix}`,
        lineCode: lc,
        row,
        badge,
        loading,
        variants,
      })
    }
    return out
  }, [sidebarSearchHits.lines, lineSearchVariantsByCode])
  const searchHasHits =
    stopsForSearchDisplay.length > 0 || lineSearchGroups.length > 0

  const sidebarSearchRecentValid = useMemo(
    () =>
      sidebarSearchRecent.filter((entry) => {
        if (!entry || typeof entry !== 'object') return false
        if (entry.kind === 'stop') return entry.stop != null
        if (entry.kind === 'line') return entry.row != null
        if (entry.kind === 'lineDir')
          return entry.row != null && entry.variant != null
        return false
      }),
    [sidebarSearchRecent]
  )

  const showSidebarSearchRecent =
    panelView === 'home' &&
    !searchQOk &&
    sidebarSearchRecentValid.length > 0

  const removeSidebarSearchRecentItem = (entry) => {
    setSidebarSearchRecent(removeSidebarSearchRecent(entry))
  }

  const searchPrioritizeLines = sidebarSearchPrioritizeBusLines(sidebarSearchQuery)
  const sidebarSearchDisplayOrder = useMemo(() => {
    const stopRows = stopsForSearchDisplay.map((stop) => ({
      type: 'stop',
      key: `stop-${stop.id}`,
      stop,
    }))
    const lineRows = lineSearchGroups.map((g) => ({
      type: 'line',
      key: g.key,
      group: g,
    }))
    const withGroupLabel = (rows, label) =>
      rows.length
        ? [{ type: 'groupLabel', key: `lbl-${label}`, label }, ...rows]
        : []
    return searchPrioritizeLines
      ? [...withGroupLabel(lineRows, 'Γραμμές'), ...withGroupLabel(stopRows, 'Στάσεις')]
      : [...withGroupLabel(stopRows, 'Στάσεις'), ...withGroupLabel(lineRows, 'Γραμμές')]
  }, [
    stopsForSearchDisplay,
    lineSearchGroups,
    searchPrioritizeLines,
  ])

  const pickSearchLine = async (row) => {
    if (sidebarLineOpening || typeof onSearchPickLine !== 'function') return
    setSidebarLineOpening(true)
    try {
      await onSearchPickLine(row)
    } finally {
      setSidebarLineOpening(false)
    }
  }

  const pickSearchLineDirection = async (row, variant) => {
    if (
      sidebarLineOpening ||
      typeof onSearchPickLineDirection !== 'function'
    ) {
      return
    }
    setSidebarLineOpening(true)
    try {
      await onSearchPickLineDirection(row, variant)
    } finally {
      setSidebarLineOpening(false)
    }
  }

  const activateSidebarSearchRecentEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return
    if (entry.kind === 'stop' && entry.stop != null) {
      const id = entry.stop.id
      const fresh = (searchStops ?? []).find((s) => String(s.id) === String(id))
      onPickFavoriteStop(fresh ?? entry.stop)
      return
    }
    if (entry.kind === 'line' && entry.row != null) {
      pickSearchLine(entry.row)
      return
    }
    if (
      entry.kind === 'lineDir' &&
      entry.row != null &&
      entry.variant != null
    ) {
      pickSearchLineDirection(entry.row, entry.variant)
    }
  }

  if (panelView === 'allLines') {
    const nTotal = Array.isArray(searchLines) ? searchLines.length : 0
    return (
      <div className="map-left-sidebar-panel map-left-sidebar-panel--list map-left-sidebar-panel--all-lines">
        <div className="map-left-sidebar-all-lines-toolbar">
          <div className="map-left-sidebar-search-wrap map-left-sidebar-search-wrap--all-lines">
            <Search
              className="map-left-sidebar-search-icon"
              size={17}
              strokeWidth={2}
              aria-hidden
            />
              <input
                ref={allLinesSearchInputRef}
                type="search"
                className="map-left-sidebar-search-input map-left-sidebar-search-input--all-lines"
                placeholder="Αναζήτηση γραμμής"
              autoComplete="off"
              spellCheck={false}
                enterKeyHint="search"
                aria-label="Φιλτράρισμα κατά αριθμό γραμμής"
                value={allLinesBrowseQuery}
                onChange={(e) => setAllLinesBrowseQuery(e.target.value)}
                onPointerDown={(e) => {
                  if (!mobileUnified) return
                  if (e.pointerType === 'mouse' && e.button !== 0) return
                  if (document.activeElement === e.currentTarget) return
                  e.preventDefault()
                }}
                onClick={(e) => {
                  if (!mobileUnified) return
                  e.currentTarget.focus()
                }}
                onFocus={() => onAnySearchFocus?.()}
              />
          </div>
        </div>
        <div className="map-left-sidebar-scroll">
          {nTotal === 0 ? (
            <p className="map-left-sidebar-empty" lang="el">
              Φόρτωση γραμμών… Αν συνεχίζει, ελέγξτε ότι ο διακομιστής API
              τρέχει.
            </p>
          ) : allLinesBrowseRows.length === 0 ? (
            <p className="map-left-sidebar-empty" lang="el">
              Κανένα αποτέλεσμα για αυτό το φίλτρο.
            </p>
          ) : (
            <ul className="map-left-sidebar-list map-left-sidebar-search-list">
              {allLinesBrowseRows.map((row, lix) => {
                const lc = String(
                  row.LineCode ?? row.line_code ?? row.lineCode ?? ''
                ).trim()
                const badge = String(
                  row.LineIDGR ??
                    row.LineID ??
                    row.LineId ??
                    row.line_id ??
                    ''
                ).trim()
                const descr = String(
                  row.LineDescr ?? row.line_descr ?? ''
                ).trim()
                return (
                  <li key={lc ? `all-ln-${lc}` : `all-ln-${lix}`}>
                    <button
                      type="button"
                      className="map-left-sidebar-row map-left-sidebar-search-hit map-left-sidebar-search-recent-hit"
                      disabled={sidebarLineOpening}
                      onClick={() => pickSearchLine(row)}
                    >
                      <span
                        className="map-left-sidebar-search-hit-icon-wrap"
                        aria-hidden
                      >
                        <Bus size={17} strokeWidth={2} />
                      </span>
                      <span className="map-left-sidebar-search-hit-text">
                        <span
                          className="map-left-sidebar-row-title"
                          lang="el"
                        >
                          {badge || '—'}
                        </span>
                        {descr ? (
                          <span
                            className="map-left-sidebar-row-sub"
                            lang="el"
                            title={descr}
                          >
                            {descr}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    )
  }

  if (panelView === 'favoriteStops') {
    const noStops = favoriteStopsSorted.length === 0
    return (
      <div className="map-left-sidebar-panel map-left-sidebar-panel--list">
        <div className="map-left-sidebar-scroll">
          {noStops ? (
            <p className="map-left-sidebar-empty" lang="el">
              Δεν έχετε αγαπημένες στάσεις ακόμη. Ανοίξτε μια στάση και πατήστε
              το κίτρινο αστέρι.
            </p>
          ) : (
            <FavoriteStopsList
              favoriteStopsSorted={favoriteStopsSorted}
              onPickFavoriteStop={onPickFavoriteStop}
              onRemoveFavoriteStop={onRemoveFavoriteStop}
              onReorderFavoriteStop={onReorderFavoriteStop}
              listKeyPrefix="favorite-stops-panel"
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={
        'map-left-sidebar-tiles-panel' +
        (searchQOk ? ' map-left-sidebar-tiles-panel--search-active' : '')
      }
    >
      {!mobileUnified ? (
        <div className="map-left-sidebar-search">
          <div className="map-left-sidebar-search-wrap">
            <Search
              className="map-left-sidebar-search-icon"
              size={17}
              strokeWidth={2}
              aria-hidden
            />
            <input
              ref={homeSearchInputRef}
              id="map-left-sidebar-search-input"
              type="search"
              className="map-left-sidebar-search-input"
              placeholder="Αναζήτηση..."
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="search"
              aria-label="Αναζήτηση"
              value={sidebarSearchQuery}
              onChange={(e) => setSidebarSearchQuery(e.target.value)}
              onFocus={() => onAnySearchFocus?.()}
            />
          </div>
        </div>
      ) : null}
      {searchQOk ? (
        <div
          className={
            'map-left-sidebar-search-results' +
            (!searchHasHits ? ' map-left-sidebar-search-results--empty' : '')
          }
        >
          {searchHasHits ? (
            <ul className="map-left-sidebar-search-list">
              {sidebarSearchDisplayOrder.map((row) => {
                if (row.type === 'groupLabel') {
                  return (
                    <li key={row.key} className="map-left-sidebar-search-group-label">
                      <div className="map-left-sidebar-search-section-label" lang="el">
                        {row.label}
                      </div>
                    </li>
                  )
                }
                if (row.type === 'stop') {
                  const stop = row.stop
                  const showId = passengerFacingStopId(stop)
                  const title =
                    String(stop.descr || '').trim() || `${showId}`
                  const subtitleFull = `${showId}${
                    stop.street ? ` · ${stop.street}` : ''
                  }`
                  const stopFav = favoriteStopIds.has(String(stop.id))
                  return (
                    <li key={`stop-${stop.id}`}>
                      <div className="map-left-sidebar-search-result-item">
                        <button
                          type="button"
                          className="map-left-sidebar-search-hit map-left-sidebar-search-result-main"
                          onClick={() => {
                            setSidebarSearchRecent(
                              pushSidebarSearchRecent({
                                kind: 'stop',
                                stop: cloneForRecentStorage(stop),
                              })
                            )
                            onPickFavoriteStop(stop)
                          }}
                        >
                          <span
                            className="map-left-sidebar-search-hit-icon-wrap"
                            aria-hidden
                          >
                            <MapPin size={17} strokeWidth={2} />
                          </span>
                          <span className="map-left-sidebar-search-hit-text">
                            <span className="map-left-sidebar-row-title" lang="el">
                              {title}
                            </span>
                            <span
                              className="map-left-sidebar-row-sub"
                              lang="el"
                              title={subtitleFull}
                            >
                              {subtitleFull}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className={
                            'stop-popup-favorite map-left-sidebar-search-hit-favorite' +
                            (stopFav ? ' stop-popup-favorite--active' : '')
                          }
                          aria-label={
                            stopFav
                              ? 'Αφαίρεση από τα αγαπημένα'
                              : 'Προσθήκη στα αγαπημένα'
                          }
                          aria-pressed={stopFav}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            onToggleFavoriteStopSearch(stop.id)
                          }}
                        >
                          <FavoriteIcon
                            size={17}
                            strokeWidth={2.2}
                            filled={stopFav}
                          />
                        </button>
                      </div>
                    </li>
                  )
                }
                const g = row.group
                const lc = String(g.lineCode ?? '').trim()
                const expanded = lc ? !!lineSearchExpandedByCode[lc] : false
                const variants = Array.isArray(g.variants) ? g.variants : []
                const hasMultipleDirections = variants.length > 1
                const singleDirectionLabel =
                  variants.length === 1
                    ? String(variants[0]?.label ?? '').trim()
                    : ''
                const singleVariant = variants.length === 1 ? variants[0] : null
                const activeRouteCode = String(currentTrackedRouteCode ?? '').trim()
                const directionsSummary = hasMultipleDirections
                  ? `${variants.length} κατευθύνσεις`
                  : singleDirectionLabel
                const lineSubtitle = g.loading
                  ? 'Φόρτωση κατευθύνσεων…'
                  : directionsSummary

                return (
                  <li key={g.key}>
                    <div
                      className={
                        'map-left-sidebar-line-accordion' +
                        (expanded ? ' map-left-sidebar-line-accordion--open' : '')
                      }
                    >
                      <div className="map-left-sidebar-search-result-item map-left-sidebar-search-result-item--in-accordion">
                      <button
                        type="button"
                        className="map-left-sidebar-search-hit map-left-sidebar-search-result-main"
                        disabled={sidebarLineOpening}
                        onClick={() => {
                          if (!lc) return
                          if (g.loading) return
                          if (!g.loading && singleVariant) {
                            setSidebarSearchRecent(
                              pushSidebarSearchRecent({
                                kind: 'lineDir',
                                row: cloneForRecentStorage(g.row),
                                variant: cloneForRecentStorage(singleVariant),
                              })
                            )
                            pickSearchLineDirection(g.row, singleVariant)
                            return
                          }
                          setLineSearchExpandedByCode((prev) => ({
                            ...prev,
                            [lc]: !prev[lc],
                          }))
                        }}
                      >
                        <span
                          className="map-left-sidebar-search-hit-icon-wrap"
                          aria-hidden
                        >
                          <Bus size={17} strokeWidth={2} />
                        </span>
                        <span className="map-left-sidebar-search-hit-text">
                          <span className="map-left-sidebar-row-title" lang="el">
                            {g.badge || '—'}
                          </span>
                          {lineSubtitle ? (
                            <span className="map-left-sidebar-row-sub" lang="el">
                              {lineSubtitle}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      {g.loading || singleVariant ? null : (
                        <button
                          type="button"
                          className={
                            'map-left-sidebar-search-expand' +
                            (expanded ? ' map-left-sidebar-search-expand--open' : '')
                          }
                          disabled={sidebarLineOpening || !lc}
                          aria-label={expanded ? 'Κλείσιμο κατευθύνσεων' : 'Άνοιγμα κατευθύνσεων'}
                          aria-expanded={expanded}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            if (!lc) return
                            setLineSearchExpandedByCode((prev) => ({
                              ...prev,
                              [lc]: !prev[lc],
                            }))
                          }}
                        >
                          <ChevronDown size={14} strokeWidth={2.4} aria-hidden />
                        </button>
                      )}
                    </div>
                    {expanded && (hasMultipleDirections || variants.length === 0) ? (
                      variants.length > 0 ? (
                        <div className="map-left-sidebar-line-accordion-content">
                          <ul className="map-left-sidebar-line-directions-list">
                          {variants.map((v) => {
                            const routeCode = String(v?.routeCode ?? '').trim()
                            const dir = String(v?.label ?? '').trim() || routeCode
                            const isSelectedDirection = Boolean(
                              activeRouteCode &&
                                routeCodesMatch(routeCode, activeRouteCode)
                            )
                            return (
                              <li key={`${g.key}-${routeCode || dir}`}>
                                <div
                                  className={
                                    'map-left-sidebar-search-result-item map-left-sidebar-search-result-item--in-accordion' +
                                    (isSelectedDirection
                                      ? ' map-left-sidebar-search-result-item--selected'
                                      : '')
                                  }
                                >
                                  <button
                                    type="button"
                                    className="map-left-sidebar-line-direction-item map-left-sidebar-search-result-main"
                                    disabled={sidebarLineOpening}
                                    onClick={() => {
                                      setSidebarSearchRecent(
                                        pushSidebarSearchRecent({
                                          kind: 'lineDir',
                                          row: cloneForRecentStorage(g.row),
                                          variant: cloneForRecentStorage(v),
                                        })
                                      )
                                      pickSearchLineDirection(g.row, v)
                                    }}
                                  >
                                    <span className="map-left-sidebar-search-hit-text">
                                      <span className="map-left-sidebar-row-title" lang="el">
                                        {dir}
                                      </span>
                                    </span>
                                  </button>
                                </div>
                              </li>
                            )
                          })}
                          </ul>
                        </div>
                      ) : (
                        <div className="map-left-sidebar-line-accordion-content">
                          <button
                            type="button"
                            className="map-left-sidebar-line-direction-item"
                            disabled={sidebarLineOpening}
                            onClick={() => {
                              setSidebarSearchRecent(
                                pushSidebarSearchRecent({
                                  kind: 'line',
                                  row: cloneForRecentStorage(g.row),
                                })
                              )
                              pickSearchLine(g.row)
                            }}
                          >
                            Άνοιγμα γραμμής
                          </button>
                        </div>
                      )
                    ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="map-left-sidebar-search-empty" lang="el">
              Δεν βρέθηκαν αποτελέσματα.
            </p>
          )}
        </div>
      ) : null}
      {!searchQOk && mobileUnified ? (
        <div className="map-left-sidebar-scroll">
          <MobileFavoriteStopsSection
            favoriteStopsSorted={favoriteStopsSorted}
            onPickFavoriteStop={onPickFavoriteStop}
            onOpenFavoriteStops={() => onPanelViewChange?.('favoriteStops')}
          />
          <MobileRecentLinesSection
            recentLines={recentLines}
            onPickLine={onPickLineEntry}
            onOpenAllLines={() => onPanelViewChange?.('allLines')}
          />
        </div>
      ) : null}
      {!searchQOk && !mobileUnified ? (
        <div className="map-left-sidebar-tiles">
          <button
            type="button"
            className="map-left-sidebar-tile map-left-sidebar-tile--favorites"
            onClick={() => onPanelViewChange('favoriteStops')}
            aria-label="Αγαπημένες στάσεις"
          >
            <FavoriteIcon
              className="map-left-sidebar-favorites-tile-star"
              size={28}
              strokeWidth={2.2}
            />
            <span className="map-left-sidebar-tile-label" lang="el">
              Αγαπημένες στάσεις
            </span>
          </button>
          <button
            type="button"
            className="map-left-sidebar-tile map-left-sidebar-tile--lines"
            onClick={() => onPanelViewChange('allLines')}
            aria-label="Όλες οι γραμμές"
          >
            <Bus
              className="map-left-sidebar-tile-icon"
              size={28}
              strokeWidth={2}
              aria-hidden
            />
            <span className="map-left-sidebar-tile-label" lang="el">
              Γραμμές
            </span>
          </button>
        </div>
      ) : null}
      {showSidebarSearchRecent && !mobileUnified ? (
        <div
          className="map-left-sidebar-search-recent map-left-sidebar-search-recent--below-favorites"
          role="region"
          aria-label="Πρόσφατα από αναζήτηση"
        >
          <div className="map-left-sidebar-search-section-label" lang="el">
            Πρόσφατα
          </div>
          <ul className="map-left-sidebar-search-list">
            {sidebarSearchRecentValid.map((entry, idx) => {
              const listKey = `${sidebarSearchRecentKey(entry)}-${idx}`
              if (entry.kind === 'stop') {
                const stop = entry.stop
                const showId = passengerFacingStopId(stop)
                const title =
                  String(stop.descr || '').trim() || `${showId}`
                const subtitleFull = `${showId}${
                  stop.street ? ` · ${stop.street}` : ''
                }`
                return (
                  <li key={listKey}>
                    <div className="map-left-sidebar-search-recent-item">
                      <button
                        type="button"
                        className="map-left-sidebar-search-hit map-left-sidebar-search-recent-hit"
                        disabled={sidebarLineOpening}
                        onClick={() => {
                          setSidebarSearchRecent(
                            pushSidebarSearchRecent(
                              cloneForRecentStorage(entry)
                            )
                          )
                          activateSidebarSearchRecentEntry(entry)
                        }}
                      >
                        <span
                          className="map-left-sidebar-search-hit-icon-wrap"
                          aria-hidden
                        >
                          <MapPin size={17} strokeWidth={2} />
                        </span>
                        <span className="map-left-sidebar-search-hit-text">
                          <span className="map-left-sidebar-row-title" lang="el">
                            {title}
                          </span>
                          <span
                            className="map-left-sidebar-row-sub"
                            lang="el"
                            title={subtitleFull}
                          >
                            {subtitleFull}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="map-left-sidebar-search-recent-dismiss"
                        aria-label="Αφαίρεση από τα πρόσφατα"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeSidebarSearchRecentItem(entry)
                        }}
                      >
                        <X size={14} strokeWidth={2.5} aria-hidden />
                      </button>
                    </div>
                  </li>
                )
              }
              const row = entry.row
              const badge = String(
                row.LineIDGR ??
                  row.LineID ??
                  row.LineId ??
                  row.line_id ??
                  ''
              ).trim()
              const descr = String(
                row.LineDescr ?? row.line_descr ?? ''
              ).trim()
              if (entry.kind === 'line') {
                return (
                  <li key={listKey}>
                    <div className="map-left-sidebar-search-recent-item">
                      <button
                        type="button"
                        className="map-left-sidebar-search-hit map-left-sidebar-search-recent-hit"
                        disabled={sidebarLineOpening}
                        onClick={() => {
                          setSidebarSearchRecent(
                            pushSidebarSearchRecent(
                              cloneForRecentStorage(entry)
                            )
                          )
                          activateSidebarSearchRecentEntry(entry)
                        }}
                      >
                        <span
                          className="map-left-sidebar-search-hit-icon-wrap"
                          aria-hidden
                        >
                          <Bus size={17} strokeWidth={2} />
                        </span>
                        <span className="map-left-sidebar-search-hit-text">
                          <span className="map-left-sidebar-row-title" lang="el">
                            {badge || '—'}
                          </span>
                          {descr ? (
                            <span
                              className="map-left-sidebar-row-sub"
                              lang="el"
                              title={descr}
                            >
                              {descr}
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="map-left-sidebar-search-recent-dismiss"
                        aria-label="Αφαίρεση από τα πρόσφατα"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeSidebarSearchRecentItem(entry)
                        }}
                      >
                        <X size={14} strokeWidth={2.5} aria-hidden />
                      </button>
                    </div>
                  </li>
                )
              }
              const v = entry.variant
              const dir = String(v?.label ?? '').trim()
              const descrTrim = descr
              return (
                <li key={listKey}>
                  <div className="map-left-sidebar-search-recent-item">
                    <button
                      type="button"
                      className="map-left-sidebar-search-hit map-left-sidebar-search-recent-hit"
                      disabled={sidebarLineOpening}
                      onClick={() => {
                        setSidebarSearchRecent(
                          pushSidebarSearchRecent(cloneForRecentStorage(entry))
                        )
                        activateSidebarSearchRecentEntry(entry)
                      }}
                    >
                      <span
                        className="map-left-sidebar-search-hit-icon-wrap"
                        aria-hidden
                      >
                        <Bus size={17} strokeWidth={2} />
                      </span>
                      <span className="map-left-sidebar-search-hit-text">
                        <span className="map-left-sidebar-row-title" lang="el">
                          {badge || '—'}
                        </span>
                        {dir ? (
                          <span className="map-left-sidebar-row-sub" lang="el">
                            {dir}
                          </span>
                        ) : descrTrim ? (
                          <span
                            className="map-left-sidebar-row-sub"
                            lang="el"
                            title={descrTrim}
                          >
                            {descrTrim}
                          </span>
                        ) : null}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="map-left-sidebar-search-recent-dismiss"
                      aria-label="Αφαίρεση από τα πρόσφατα"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeSidebarSearchRecentItem(entry)
                      }}
                    >
                      <X size={14} strokeWidth={2.5} aria-hidden />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_ARRAY = []

function MobileBrowseSheet({
  snap,
  sheetHeights,
  visibleHeight,
  onSnapChange,
  onLiveHeightChange,
  onDragStateChange,
  headerMode = 'search',
  headerTitle = '',
  onHeaderBack,
  searchValue,
  onSearchChange,
  onSearchFocus,
  searchInputRef,
  bodyClassName = '',
  children,
}) {
  const showSearchHeader = headerMode === 'search'
  const minHeight = Math.max(0, sheetHeights?.minimized ?? 0)
  const peekHeight = Math.max(
    minHeight + 1,
    sheetHeights?.peek ?? sheetHeights?.full ?? minHeight + 1
  )
  const currentHeight = Math.max(
    minHeight,
    Number.isFinite(visibleHeight)
      ? visibleHeight
      : sheetHeights?.[snap] ?? minHeight
  )
  const expansionProgress = Math.max(
    0,
    Math.min(1, (currentHeight - minHeight) / Math.max(1, peekHeight - minHeight))
  )
  const isCollapsed = snap === 'minimized' && currentHeight <= minHeight + 0.5
  const bodyReveal = isCollapsed ? 0 : expansionProgress
  const MOBILE_HEADER_INPUT_DRAG_START_PX = 0.5
  const MOBILE_HEADER_INPUT_TAP_SLOP_PX = 6
  const dragPointerIdRef = useRef(null)
  const dragSourceRef = useRef('grab')
  const dragStateActiveRef = useRef(false)
  const dragStartXRef = useRef(0)
  const dragStartYRef = useRef(0)
  const dragStartHeightRef = useRef(0)
  const lastDragSampleRef = useRef(null)
  const dragMovedRef = useRef(false)
  const inputTapTargetRef = useRef(null)

  const setLiveHeight = useCallback(
    (next) => {
      onLiveHeightChange?.(next)
    },
    [onLiveHeightChange]
  )

  const setDragStateActive = useCallback(
    (next) => {
      if (dragStateActiveRef.current === next) return
      dragStateActiveRef.current = next
      onDragStateChange?.(next)
    },
    [onDragStateChange]
  )

  const onGrabPointerDown = useCallback(
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest('button, a, label')) return
      const textInput = el?.closest('input, textarea') ?? null
      const fromTextInput = !!textInput
      inputTapTargetRef.current = fromTextInput ? textInput : null
      startMobileSheetResizeGesture({
        e,
        source: fromTextInput ? 'input' : 'grab',
        heights: sheetHeights,
        snap,
        pointerIdRef: dragPointerIdRef,
        dragSourceRef,
        dragStartXRef,
        dragStartYRef,
        dragStartHeightRef,
        lastDragSampleRef,
        dragMovedRef,
        onDragStateChange: setDragStateActive,
        activateDragState: !fromTextInput,
      })
    },
    [setDragStateActive, sheetHeights, snap]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onMove = (e) => {
      if (dragPointerIdRef.current == null || dragPointerIdRef.current !== e.pointerId) {
        return
      }
      const deltaX = e.clientX - dragStartXRef.current
      const deltaY = e.clientY - dragStartYRef.current
      const travelPx = Math.hypot(deltaX, deltaY)
      if (
        dragSourceRef.current === 'input' &&
        !dragMovedRef.current &&
        travelPx <= MOBILE_HEADER_INPUT_DRAG_START_PX
      ) {
        return
      }
      if (dragSourceRef.current === 'input' && !dragMovedRef.current) {
        const activeEl = document.activeElement
        if (
          activeEl instanceof HTMLElement &&
          activeEl.matches('input, textarea')
        ) {
          activeEl.blur()
        }
        setDragStateActive(true)
      }
      updateMobileSheetResizeGesture({
        e,
        heights: sheetHeights,
        pointerIdRef: dragPointerIdRef,
        dragStartXRef,
        dragStartYRef,
        dragStartHeightRef,
        lastDragSampleRef,
        dragMovedRef,
        onLiveHeightChange: setLiveHeight,
      })
    }

    const onUp = (e) => {
      const dragResult = finishMobileSheetResizeGesture({
        e,
        heights: sheetHeights,
        pointerIdRef: dragPointerIdRef,
        dragSourceRef,
        dragStartXRef,
        dragStartYRef,
        dragStartHeightRef,
        lastDragSampleRef,
        dragMovedRef,
        onDragStateChange: setDragStateActive,
        onLiveHeightChange: setLiveHeight,
        resetSource: 'grab',
      })
      if (!dragResult) return
      const { dragSource, travelPx, nextHeight, velocityY, moved } = dragResult
      const inputTapTarget = inputTapTargetRef.current
      inputTapTargetRef.current = null
      if (
        dragSource === 'input' &&
        !moved &&
        travelPx <= MOBILE_HEADER_INPUT_TAP_SLOP_PX
      ) {
        const releaseEl =
          typeof document === 'undefined'
            ? null
            : document.elementFromPoint(e.clientX, e.clientY)
        const releasedOnSameInput =
          inputTapTarget instanceof HTMLElement &&
          releaseEl instanceof Element &&
          (releaseEl === inputTapTarget ||
            releaseEl.closest('input, textarea') === inputTapTarget)
        if (releasedOnSameInput) {
          requestAnimationFrame(() => {
            searchInputRef?.current?.focus()
          })
        }
      } else {
        const nextSnap = moved
          ? mobileSheetSnapFromHeight(sheetHeights, snap, nextHeight, velocityY)
          : nextMobileSheetSnap(snap)
        onSnapChange?.(nextSnap)
      }
    }

    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      inputTapTargetRef.current = null
      setDragStateActive(false)
    }
  }, [
    MOBILE_HEADER_INPUT_DRAG_START_PX,
    MOBILE_HEADER_INPUT_TAP_SLOP_PX,
    onSnapChange,
    searchInputRef,
    setDragStateActive,
    setLiveHeight,
    sheetHeights,
    snap,
  ])

  return (
    <div
      className={
        'mobile-sheet-surface mobile-sheet-surface--browse' +
        (isCollapsed ? ' mobile-sheet-surface--minimized' : '')
      }
      style={{
        '--mobile-sheet-expand-progress': `${expansionProgress}`,
        '--mobile-sheet-body-reveal': `${bodyReveal}`,
      }}
    >
      <div
        className="mobile-sheet-grab-zone"
        data-mobile-sheet-grab
        onPointerDown={onGrabPointerDown}
      >
        <div className="mobile-sheet-handle" aria-hidden />
        <div
          className={
            showSearchHeader
              ? 'mobile-sheet-header-search'
              : 'mobile-sheet-header-titlebar'
          }
        >
          {showSearchHeader ? (
            <div className="map-left-sidebar-search-wrap">
              <Search
                className="map-left-sidebar-search-icon"
                size={17}
                strokeWidth={2}
                aria-hidden
              />
              <input
                ref={searchInputRef}
                type="search"
                className="map-left-sidebar-search-input mobile-sheet-header-search-input"
                placeholder="Αναζήτηση..."
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                aria-label="Αναζήτηση"
                value={searchValue}
                onChange={(e) => onSearchChange?.(e.target.value)}
                onPointerDown={(e) => {
                  if (e.pointerType === 'mouse' && e.button !== 0) return
                  if (document.activeElement === e.currentTarget) return
                  e.preventDefault()
                }}
                onFocus={() => onSearchFocus?.()}
              />
            </div>
          ) : (
            <>
              <h2
                className="mobile-sheet-header-title mobile-sheet-header-title--subscreen"
                lang="el"
              >
                {headerTitle}
              </h2>
              <button
                type="button"
                className="stop-popup-close mobile-sheet-header-close"
                onClick={() => onHeaderBack?.()}
                aria-label="Κλείσιμο υποσελίδας"
              >
                <CloseIcon size={16} strokeWidth={2.2} aria-hidden />
              </button>
            </>
          )}
        </div>
      </div>
      {!isCollapsed ? (
        <div
          className={
            'mobile-sheet-body' + (bodyClassName ? ` ${bodyClassName}` : '')
          }
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

function stopPopupTimeColorClass(mins) {
  const m = parseInt(mins, 10)
  if (m <= 5) return 'soon'
  if (m <= 10) return 'medium'
  return 'late'
}

const StopPopupArrivalsRegion = memo(function StopPopupArrivalsRegion({
  activeRouteCode,
  appliedArrivalsListViewportPx,
  arrivalListMeasureRef,
  arrivals,
  arrivalsRegionRef,
  arrivalsScrollContentRef,
  arrivalsViewportRef,
  error,
  groupedArrivals,
  hasOnlyUnplannedRoutes,
  initialLoadingArrivalsViewportPx,
  loading,
  mobileSheet,
  mobileSheetCollapsed,
  onArrivalsPointerDown,
  onSelectArrival,
  showArrivalsListChrome,
  showSpinnerInHeldArrivalsViewport,
  showUnplannedRoutes,
  stopId,
  toggleUnplannedRoutes,
  unplannedRoutes,
  unplannedToggleRowRef,
  visibleUnplannedRoutes,
}) {
  if (mobileSheetCollapsed) return null

  return (
    <div
      ref={arrivalsRegionRef}
      className="stop-popup-arrivals"
      role="region"
      aria-label="Αφίξεις"
    >
      {loading && !arrivals && !showSpinnerInHeldArrivalsViewport ? (
        <div
          className="stop-popup-arrivals-viewport stop-popup-arrivals-viewport--center"
          style={
            !mobileSheet && initialLoadingArrivalsViewportPx != null
              ? { height: initialLoadingArrivalsViewportPx }
              : undefined
          }
        >
          <div className="stop-popup-spinner" aria-hidden />
        </div>
      ) : error ? (
        <div
          className="stop-popup-arrivals-viewport stop-popup-arrivals-viewport--center"
          style={
            !mobileSheet && appliedArrivalsListViewportPx != null
              ? { height: appliedArrivalsListViewportPx }
              : undefined
          }
        >
          <div className="stop-popup-no-data stop-popup-error">{error}</div>
        </div>
      ) : showArrivalsListChrome ? (
        <div
          ref={arrivalsViewportRef}
          className="stop-popup-arrivals-viewport stop-popup-arrivals-viewport--list"
          onPointerDown={onArrivalsPointerDown}
          style={
            !mobileSheet && appliedArrivalsListViewportPx != null
              ? { height: appliedArrivalsListViewportPx }
              : undefined
          }
        >
          <div
            ref={arrivalsScrollContentRef}
            className={
              'stop-popup-arrivals-scroll-inner' +
              (showSpinnerInHeldArrivalsViewport
                ? ' stop-popup-arrivals-scroll-inner--hidden'
                : '')
            }
          >
            <ul ref={arrivalListMeasureRef} className="stop-popup-arrival-list">
              {groupedArrivals.map((group, i) => {
                const a = group.primary
                const badge = arrivalLineBadgeDisplay(a)
                const dirLabel = arrivalDirectionLabel(a)
                const rowRouteCode = String(
                  a?.resolved_route_code ?? arrivalRouteRaw(a) ?? ''
                ).trim()
                const isSelectedRow =
                  Boolean(activeRouteCode) &&
                  routeCodesMatch(rowRouteCode, String(activeRouteCode))
                const allTimes = [a, ...group.extras]
                  .map((x) => Number.parseInt(String(x?.btime2 ?? '').trim(), 10))
                  .filter((n) => Number.isFinite(n) && n >= 0)
                const timeText = allTimes.join(', ')
                const hasNow = allTimes.some((n) => n === 0)
                const timeAria = hasNow
                  ? `Τώρα${allTimes.filter((n) => n !== 0).length ? `, ${allTimes.filter((n) => n !== 0).join(', ')}` : ''}`
                  : timeText
                return (
                  <li key={`g-${group.key}-${i}`}>
                    <button
                      type="button"
                      className={
                        'stop-popup-arrival-item' +
                        (isSelectedRow ? ' stop-popup-arrival-item--selected' : '')
                      }
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectArrival?.(a, stopId)
                      }}
                      aria-label={`Εμφάνιση στο χάρτη: ${badge.title || badge.text || 'γραμμή'}`}
                    >
                      <div className="stop-popup-route-badge" title={badge.title}>
                        {badge.text}
                      </div>
                      <div className="stop-popup-direction" title={dirLabel}>
                        {dirLabel}
                      </div>
                      <div className={`stop-popup-time ${stopPopupTimeColorClass(a.btime2)}`}>
                        {hasNow && allTimes.length === 1 ? (
                          <span className="time-now" lang="el">
                            Τώρα
                          </span>
                        ) : (
                          <>
                            <span className="time-val" aria-label={timeAria}>
                              {timeText}
                            </span>
                            <span className="time-unit" lang="el">
                              λεπ.
                            </span>
                          </>
                        )}
                      </div>
                    </button>
                  </li>
                )
              })}
              {unplannedRoutes.length > 0 && !hasOnlyUnplannedRoutes ? (
                <li
                  ref={unplannedToggleRowRef}
                  className="stop-popup-unplanned-controls-item"
                >
                  <div className="stop-popup-unplanned-controls">
                    <button
                      type="button"
                      className="stop-popup-unplanned-note stop-popup-unplanned-note-toggle"
                      aria-pressed={showUnplannedRoutes}
                      aria-label={
                        showUnplannedRoutes
                          ? 'Απόκρυψη γραμμών χωρίς χρόνο άφιξης'
                          : 'Εμφάνιση γραμμών χωρίς χρόνο άφιξης'
                      }
                      lang="el"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={toggleUnplannedRoutes}
                    >
                      <span>
                        {showUnplannedRoutes ? 'Απόκρυψη' : 'Εμφάνιση'}{' '}
                        {unplannedRoutes.length} γραμμών χωρίς χρόνο άφιξης
                      </span>
                    </button>
                  </div>
                </li>
              ) : null}
              {visibleUnplannedRoutes.map((row, i) => {
                const arrivalForMap = unplannedRouteRowToArrivalForMap(row)
                const badge = arrivalLineBadgeDisplay(arrivalForMap)
                const dirLabel = arrivalDirectionLabel(arrivalForMap)
                const rcKey = canonNumish(routeCodeFromRouteRow(row))
                const rowRouteCode = String(routeCodeFromRouteRow(row) ?? '').trim()
                const isSelectedRow =
                  Boolean(activeRouteCode) &&
                  routeCodesMatch(rowRouteCode, String(activeRouteCode))
                return (
                  <li key={`u-${rcKey}-${i}`}>
                    <button
                      type="button"
                      className={
                        'stop-popup-arrival-item stop-popup-arrival-item--unplanned' +
                        (isSelectedRow ? ' stop-popup-arrival-item--selected' : '')
                      }
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onSelectArrival?.(arrivalForMap, stopId)
                      }}
                      aria-label={`Εμφάνιση στο χάρτη: ${badge.title || badge.text || 'γραμμή'} (χωρίς προγραμματισμένη άφιξη)`}
                    >
                      <div
                        className="stop-popup-route-badge stop-popup-route-badge--unplanned"
                        title={badge.title}
                      >
                        {badge.text}
                      </div>
                      <div className="stop-popup-direction" title={dirLabel}>
                        {dirLabel}
                      </div>
                      <div className="stop-popup-time stop-popup-time--unplanned" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
          {showSpinnerInHeldArrivalsViewport ? (
            <div
              className="stop-popup-arrivals-refresh-only stop-popup-arrivals-refresh-only--overlay"
              aria-busy="true"
              aria-label="Φόρτωση αφίξεων"
            >
              <div className="stop-popup-spinner" aria-hidden />
            </div>
          ) : null}
        </div>
      ) : (
        <div className="stop-popup-arrivals-viewport stop-popup-arrivals-viewport--center">
          {unplannedRoutes.length > 0 && !showUnplannedRoutes ? (
            <div className="stop-popup-no-data" lang="el">
              Δεν υπάρχουν ζωντανές αφίξεις αυτή τη στιγμή. Υπάρχουν{' '}
              {unplannedRoutes.length} γραμμές χωρίς διαθέσιμο χρόνο άφιξης.
            </div>
          ) : (
            <div className="stop-popup-no-data" lang="el">
              Από αυτή τη στάση δεν διέρχονται λεωφορεία.
            </div>
          )}
        </div>
      )}
    </div>
  )
})

function StopMapPopup({
  stop,
  onClose,
  isFavorite,
  onToggleFavorite,
  onSelectArrival,
  onCenterOnMap,
  activeRouteCode,
  mobileSheet = false,
  mobileSheetSnap = 'minimized',
  mobileSheetHeights = null,
  visibleHeight = null,
  onMobileSheetSnapChange,
  onMobileSheetLiveHeightChange,
  onMobileSheetDragStateChange,
  onMobileSheetPeekHeightChange,
  onLoadingStateChange,
}) {
  const [arrivals, setArrivals] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [routesAtStop, setRoutesAtStop] = useState(null)
  /** True while a non-polling arrivals fetch is in flight (keeps list viewport height stable between stops). */
  const [arrivalsRefreshing, setArrivalsRefreshing] = useState(false)
  const cardRef = useRef(null)
  const headerRef = useRef(null)
  const arrivalsRegionRef = useRef(null)
  const arrivalsViewportRef = useRef(null)
  const arrivalsScrollContentRef = useRef(null)
  const arrivalListMeasureRef = useRef(null)
  const unplannedToggleRowRef = useRef(null)
  /** Pixel height for arrivals list viewport; null = use CSS default (loading / empty / error). */
  const [arrivalsListViewportPx, setArrivalsListViewportPx] = useState(null)
  const [showUnplannedRoutes, setShowUnplannedRoutes] = useState(
    readShowUnplannedStopLinesPref
  )
  const [freshMountVisible, setFreshMountVisible] = useState(mobileSheet)
  const [headerDragCursorActive, setHeaderDragCursorActive] = useState(false)
  const [sheetOffsetY, setSheetOffsetY] = useState(0)
  const [sheetDragMaxY, setSheetDragMaxY] = useState(0)
  const sheetInitializedForStopRef = useRef(false)
  const sheetInteractedRef = useRef(false)
  const dragPointerIdRef = useRef(null)
  const mobileDragStartXRef = useRef(0)
  const dragStartYRef = useRef(0)
  const dragStartOffsetRef = useRef(0)
  const mobileDragSourceRef = useRef(null)
  const mobileDragStartHeightRef = useRef(0)
  const mobileDragLastSampleRef = useRef(null)
  const mobileDragMovedRef = useRef(false)
  const mobileHeaderTapActionRef = useRef(null)
  const suppressedHeaderClickActionRef = useRef(null)
  const stopSheetLiveHeightFrameRef = useRef(null)
  const pendingStopSheetLiveHeightRef = useRef(null)
  const lastCardHeightPxRef = useRef(null)
  const lastHeaderHeightPxRef = useRef(null)
  /** Last measured list height — keeps viewport stable while switching stops (spinner inside). */
  const lastArrivalsViewportPxRef = useRef(null)
  const [stopSheetLiveHeight, setStopSheetLiveHeight] = useState(null)

  const stopIdRef = useRef(stop.id)
  stopIdRef.current = stop.id

  /** Tracks whether we've shown arrivals successfully for this popup instance. */
  const everHadArrivalsRef = useRef(false)
  /** Cancels stale `finally` from overlapping non-silent fetches. */
  const arrivalsFetchGen = useRef(0)
  const prevStopIdRef = useRef(undefined)
  const stopJustChanged =
    prevStopIdRef.current !== undefined &&
    String(prevStopIdRef.current) !== String(stop.id)

  const popupShowId = passengerFacingStopId(stop)
  const stopPopupHeading = (stop.descr || '').trim() || `${popupShowId}`
  const subtitleFull = `${popupShowId}${stop.street ? ` · ${stop.street}` : ''}`
  const mobileSheetMinHeight = Math.max(0, mobileSheetHeights?.minimized ?? 0)
  const mobileSheetPeekHeight = Math.max(
    mobileSheetMinHeight + 1,
    mobileSheetHeights?.peek ?? mobileSheetHeights?.full ?? mobileSheetMinHeight + 1
  )
  const mobileSheetCurrentHeight = mobileSheet
    ? Math.max(
        mobileSheetMinHeight,
        Number.isFinite(stopSheetLiveHeight)
          ? stopSheetLiveHeight
          : Number.isFinite(visibleHeight)
          ? visibleHeight
          : mobileSheetHeights?.[mobileSheetSnap] ?? mobileSheetMinHeight
      )
    : 0
  const mobileSheetExpansionProgress = mobileSheet
    ? Math.max(
        0,
        Math.min(
          1,
          (mobileSheetCurrentHeight - mobileSheetMinHeight) /
            Math.max(1, mobileSheetPeekHeight - mobileSheetMinHeight)
        )
      )
    : 1
  const mobileSheetCollapsed =
    mobileSheet &&
    mobileSheetSnap === 'minimized' &&
    mobileSheetCurrentHeight <= mobileSheetMinHeight + 0.5
  const mobileSheetBodyReveal = mobileSheetCollapsed
    ? 0
    : mobileSheetExpansionProgress

  const getMobileHeaderTapAction = useCallback((target) => {
    if (!(target instanceof Element)) return null
    const actionEl = target.closest('[data-stop-header-tap-action]')
    const action = actionEl?.getAttribute('data-stop-header-tap-action')
    return action === 'center' || action === 'favorite' || action === 'close'
      ? action
      : null
  }, [])

  const armSuppressedHeaderClick = useCallback((action) => {
    if (!action) return
    suppressedHeaderClickActionRef.current = action
    requestAnimationFrame(() => {
      if (suppressedHeaderClickActionRef.current === action) {
        suppressedHeaderClickActionRef.current = null
      }
    })
  }, [])

  const invokeHeaderTapAction = useCallback(
    (action) => {
      if (action === 'center') {
        onCenterOnMap?.()
        return
      }
      if (action === 'favorite') {
        onToggleFavorite?.()
        return
      }
      if (action === 'close') {
        onClose?.()
      }
    },
    [onCenterOnMap, onClose, onToggleFavorite]
  )

  const onHeaderActionClick = useCallback(
    (action, e) => {
      e.stopPropagation()
      if (suppressedHeaderClickActionRef.current === action) {
        suppressedHeaderClickActionRef.current = null
        return
      }
      invokeHeaderTapAction(action)
    },
    [invokeHeaderTapAction]
  )

  const setHeaderDragCursor = useCallback((next) => {
    setHeaderDragCursorActive((prev) => (prev === next ? prev : next))
  }, [])

  const setMobileSheetLiveHeight = useCallback(
    (nextHeight) => {
      onMobileSheetLiveHeightChange?.(nextHeight)
      if (typeof window === 'undefined') {
        setStopSheetLiveHeight(nextHeight)
        return
      }
      if (nextHeight == null) {
        pendingStopSheetLiveHeightRef.current = null
        if (stopSheetLiveHeightFrameRef.current != null) {
          cancelAnimationFrame(stopSheetLiveHeightFrameRef.current)
          stopSheetLiveHeightFrameRef.current = null
        }
        setStopSheetLiveHeight(null)
        return
      }
      pendingStopSheetLiveHeightRef.current = nextHeight
      if (stopSheetLiveHeightFrameRef.current != null) return
      stopSheetLiveHeightFrameRef.current = requestAnimationFrame(() => {
        stopSheetLiveHeightFrameRef.current = null
        const pendingHeight = pendingStopSheetLiveHeightRef.current
        setStopSheetLiveHeight((prev) => (prev === pendingHeight ? prev : pendingHeight))
      })
    },
    [onMobileSheetLiveHeightChange]
  )

  const isHeaderTextSelectionTarget = useCallback((target) => {
    if (!(target instanceof Element)) return false
    return !!target.closest('.stop-popup-title-selectable')
  }, [])

  useLayoutEffect(() => {
    if (prevStopIdRef.current !== stop.id) {
      setLoading(true)
      setError(null)
      setHeaderDragCursor(false)
      setSheetOffsetY(0)
      sheetInitializedForStopRef.current = false
      sheetInteractedRef.current = false
      setMobileSheetLiveHeight(null)
    }
    prevStopIdRef.current = stop.id
  }, [
    onMobileSheetPeekHeightChange,
    setMobileSheetLiveHeight,
    setHeaderDragCursor,
    stop.id,
  ])

  useEffect(() => {
    onLoadingStateChange?.(loading)
  }, [loading, onLoadingStateChange])

  useLayoutEffect(() => {
    if (mobileSheet) {
      setFreshMountVisible(true)
      return undefined
    }
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setFreshMountVisible(true)
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [mobileSheet])

  useEffect(() => {
    if (mobileSheet) {
      setSheetDragMaxY(0)
      setSheetOffsetY(0)
      return undefined
    }
    const card = cardRef.current
    if (!card || typeof window === 'undefined') return
    const isMobileViewport = window.matchMedia(
      `(max-width: ${MOBILE_BREAKPOINT_PX}px)`
    ).matches
    if (!isMobileViewport) {
      setSheetDragMaxY(0)
      setSheetOffsetY(0)
      return
    }
    const measure = () => {
      const cardRect = card.getBoundingClientRect()
      const header = card.querySelector('.stop-popup-header')
      const headerRect = header?.getBoundingClientRect()
      const collapsedHeight = Math.max(88, (headerRect?.height ?? 0) + 34)
      const maxY = Math.max(0, cardRect.height - collapsedHeight)
      setSheetDragMaxY(maxY)
      setSheetOffsetY((prev) => {
        if (!sheetInitializedForStopRef.current || !sheetInteractedRef.current) {
          sheetInitializedForStopRef.current = true
          return maxY
        }
        return Math.min(prev, maxY)
      })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [arrivalsRefreshing, error, loading, mobileSheet, stop.id])

  const onHeaderPointerDown = useCallback(
    (e) => {
      const el = e.target instanceof Element ? e.target : null
      if (isHeaderTextSelectionTarget(el)) return
      if (mobileSheet) {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        const tapAction = getMobileHeaderTapAction(el)
        mobileHeaderTapActionRef.current = tapAction
        startMobileSheetResizeGesture({
          e,
          source: tapAction ? 'tap' : 'grab',
          heights: mobileSheetHeights,
          snap: mobileSheetSnap,
          pointerIdRef: dragPointerIdRef,
          dragSourceRef: mobileDragSourceRef,
          dragStartXRef: mobileDragStartXRef,
          dragStartYRef,
          dragStartHeightRef: mobileDragStartHeightRef,
          lastDragSampleRef: mobileDragLastSampleRef,
          dragMovedRef: mobileDragMovedRef,
          onDragStateChange: onMobileSheetDragStateChange,
          onLiveHeightChange: setMobileSheetLiveHeight,
          activateDragState: !tapAction,
          seedLiveHeight: !tapAction,
        })
        return
      }
      if (
        typeof window !== 'undefined' &&
        !window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches
      ) {
        return
      }
      if (e.pointerType === 'mouse' && e.button !== 0) return
      if (el?.closest('.stop-popup-favorite, .stop-popup-close, .stop-popup-map-hit')) return
      dragPointerIdRef.current = e.pointerId
      dragStartYRef.current = e.clientY
      dragStartOffsetRef.current = sheetOffsetY
      sheetInteractedRef.current = true
      e.currentTarget.setPointerCapture?.(e.pointerId)
    },
    [
      getMobileHeaderTapAction,
      isHeaderTextSelectionTarget,
      mobileSheet,
      mobileSheetHeights,
      mobileSheetSnap,
      onMobileSheetDragStateChange,
      setMobileSheetLiveHeight,
      sheetOffsetY,
    ]
  )

  const onArrivalsPointerDown = useCallback(
    (e) => {
      if (!mobileSheet) return
      if (e.pointerType === 'mouse' && e.button !== 0) return
      const el = e.target instanceof Element ? e.target : null
      if (el?.closest('button, input, textarea, a, label')) return
      startMobileSheetResizeGesture({
        e,
        source: 'content',
        heights: mobileSheetHeights,
        snap: mobileSheetSnap,
        pointerIdRef: dragPointerIdRef,
        dragSourceRef: mobileDragSourceRef,
        dragStartXRef: mobileDragStartXRef,
        dragStartYRef,
        dragStartHeightRef: mobileDragStartHeightRef,
        lastDragSampleRef: mobileDragLastSampleRef,
        dragMovedRef: mobileDragMovedRef,
        onDragStateChange: onMobileSheetDragStateChange,
      })
    },
    [mobileSheet, mobileSheetHeights, mobileSheetSnap, onMobileSheetDragStateChange]
  )

  const onDragPointerMove = useCallback(
    (e) => {
      if (mobileSheet) {
        if (dragPointerIdRef.current == null || dragPointerIdRef.current !== e.pointerId) {
          return
        }
        const deltaX = e.clientX - mobileDragStartXRef.current
        const deltaY = e.clientY - dragStartYRef.current
        const travelPx = Math.hypot(deltaX, deltaY)
        if (mobileDragSourceRef.current === 'content') {
          if (mobileSheetSnap === 'full') {
            const view = arrivalsViewportRef.current
            const atTop = !view || view.scrollTop <= 0.5
            if (deltaY <= 0 || !atTop) return
          }
        } else if (
          mobileDragSourceRef.current === 'tap' &&
          !mobileDragMovedRef.current &&
          travelPx <= MOBILE_STOP_HEADER_DRAG_START_PX
        ) {
          return
        } else if (mobileDragSourceRef.current === 'tap' && !mobileDragMovedRef.current) {
          onMobileSheetDragStateChange?.(true)
          setMobileSheetLiveHeight(mobileDragStartHeightRef.current)
        }
        const dragFrame = updateMobileSheetResizeGesture({
          e,
          heights: mobileSheetHeights,
          pointerIdRef: dragPointerIdRef,
          dragStartXRef: mobileDragStartXRef,
          dragStartYRef,
          dragStartHeightRef: mobileDragStartHeightRef,
          lastDragSampleRef: mobileDragLastSampleRef,
          dragMovedRef: mobileDragMovedRef,
          onLiveHeightChange: setMobileSheetLiveHeight,
        })
        if (
          dragFrame?.justMoved &&
          mobileDragSourceRef.current !== 'content'
        ) {
          setHeaderDragCursor(true)
        }
        return
      }
      if (dragPointerIdRef.current == null || dragPointerIdRef.current !== e.pointerId) return
      const deltaY = e.clientY - dragStartYRef.current
      if (Math.abs(deltaY) > 3) setHeaderDragCursor(true)
      const nextOffset = Math.max(0, Math.min(sheetDragMaxY, dragStartOffsetRef.current + deltaY))
      setSheetOffsetY(nextOffset)
      e.preventDefault()
    },
    [
      mobileSheet,
      mobileSheetHeights,
      mobileSheetSnap,
      onMobileSheetDragStateChange,
      setMobileSheetLiveHeight,
      setHeaderDragCursor,
      sheetDragMaxY,
    ]
  )

  const onDragPointerUp = useCallback(
    (e) => {
      if (mobileSheet) {
        const tapAction = mobileHeaderTapActionRef.current
        const dragResult = finishMobileSheetResizeGesture({
          e,
          heights: mobileSheetHeights,
          pointerIdRef: dragPointerIdRef,
          dragSourceRef: mobileDragSourceRef,
          dragStartXRef: mobileDragStartXRef,
          dragStartYRef,
          dragStartHeightRef: mobileDragStartHeightRef,
          lastDragSampleRef: mobileDragLastSampleRef,
          dragMovedRef: mobileDragMovedRef,
          onDragStateChange: onMobileSheetDragStateChange,
          onLiveHeightChange: setMobileSheetLiveHeight,
        })
        if (!dragResult) return
        const { dragSource, travelPx, nextHeight, velocityY, moved } = dragResult
        const shouldTriggerTapAction =
          tapAction != null &&
          !moved &&
          travelPx <= MOBILE_STOP_HEADER_TAP_SLOP_PX
        const nextSnap =
          moved || dragSource === 'grab'
            ? mobileSheetSnapFromHeight(
                mobileSheetHeights,
                mobileSheetSnap,
                nextHeight,
                moved ? velocityY : 0
              )
            : mobileSheetSnap
        if (shouldTriggerTapAction) {
          armSuppressedHeaderClick(tapAction)
          invokeHeaderTapAction(tapAction)
        } else if (!moved && dragSource === 'grab') {
          onMobileSheetSnapChange?.(nextMobileSheetSnap(mobileSheetSnap))
        } else {
          if (tapAction != null) armSuppressedHeaderClick(tapAction)
          onMobileSheetSnapChange?.(nextSnap)
        }
        setHeaderDragCursor(false)
        mobileHeaderTapActionRef.current = null
        return
      }
      if (dragPointerIdRef.current == null || dragPointerIdRef.current !== e.pointerId) return
      const snapped = sheetOffsetY > sheetDragMaxY * 0.45 ? sheetDragMaxY : 0
      setSheetOffsetY(snapped)
      setHeaderDragCursor(false)
      dragPointerIdRef.current = null
    },
    [
      armSuppressedHeaderClick,
      invokeHeaderTapAction,
      mobileSheet,
      mobileSheetHeights,
      mobileSheetSnap,
      onMobileSheetDragStateChange,
      setMobileSheetLiveHeight,
      onMobileSheetSnapChange,
      setHeaderDragCursor,
      sheetOffsetY,
      sheetDragMaxY,
    ]
  )

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const onMove = (e) => onDragPointerMove(e)
    const onUp = (e) => onDragPointerUp(e)
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      onMobileSheetDragStateChange?.(false)
      setHeaderDragCursor(false)
    }
  }, [
    onDragPointerMove,
    onDragPointerUp,
    onMobileSheetDragStateChange,
    setHeaderDragCursor,
  ])

  useEffect(() => {
    if (!mobileSheet) return undefined
    return () => {
      onMobileSheetDragStateChange?.(false)
      setMobileSheetLiveHeight(null)
      onMobileSheetPeekHeightChange?.(null)
      setHeaderDragCursor(false)
    }
  }, [
    mobileSheet,
    onMobileSheetDragStateChange,
    onMobileSheetPeekHeightChange,
    setMobileSheetLiveHeight,
    setHeaderDragCursor,
  ])

  useEffect(() => {
    return () => {
      if (stopSheetLiveHeightFrameRef.current != null) {
        cancelAnimationFrame(stopSheetLiveHeightFrameRef.current)
      }
    }
  }, [])

  const load = useCallback(async (silent = false) => {
    const fetchStopId = stop.id
    let gen = 0
    try {
      if (!silent) {
        gen = ++arrivalsFetchGen.current
        setError(null)
        setArrivalsRefreshing(true)
        setLoading(true)
      }
      const data = await fetchArrivals(fetchStopId)
      if (stopIdRef.current !== fetchStopId) return
      setArrivals(data)
      if (!silent) setError(null)
      everHadArrivalsRef.current = true
    } catch (err) {
      if (stopIdRef.current !== fetchStopId) return
      if (!silent) {
        const msg =
          err && typeof err.message === 'string' && err.message.length < 220
            ? err.message
            : 'Δεν είναι διαθέσιμα δεδομένα αφίξεων σε πραγματικό χρόνο.'
        setError(msg)
      }
    } finally {
      if (!silent && gen === arrivalsFetchGen.current) {
        setLoading(false)
        setArrivalsRefreshing(false)
      }
    }
  }, [stop.id])

  useEffect(() => {
    load(false)
    const int = setInterval(() => load(true), STOP_ARRIVALS_POLL_MS)
    return () => clearInterval(int)
  }, [load])

  useEffect(() => {
    const fetchStopId = stop.id
    let cancelled = false
    ;(async () => {
      try {
        const rows = await apiPost(
          `/api/routes-for-stop/${encodeURIComponent(fetchStopId)}`
        )
        if (cancelled || stopIdRef.current !== fetchStopId) return
        setRoutesAtStop(Array.isArray(rows) ? rows : [])
      } catch {
        if (cancelled || stopIdRef.current !== fetchStopId) return
        setRoutesAtStop([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [stop.id])

  const unplannedRoutes = useMemo(() => {
    if (!Array.isArray(routesAtStop) || routesAtStop.length === 0) return []
    const arr = Array.isArray(arrivals) ? arrivals : []
    const planned = buildPlannedRouteCodeSet(arr, routesAtStop)
    return unplannedRoutesAtStopList(routesAtStop, planned)
  }, [arrivals, routesAtStop])
  const hasOnlyUnplannedRoutes =
    Array.isArray(arrivals) && arrivals.length === 0 && unplannedRoutes.length > 0
  const visibleUnplannedRoutes = useMemo(
    () => (hasOnlyUnplannedRoutes || showUnplannedRoutes ? unplannedRoutes : EMPTY_ARRAY),
    [hasOnlyUnplannedRoutes, showUnplannedRoutes, unplannedRoutes]
  )

  const groupedArrivals = useMemo(() => {
    if (!Array.isArray(arrivals) || arrivals.length === 0) return []
    const byLine = new Map()
    arrivals.forEach((a, index) => {
      const lineKey = normalizeLineIdKey(arrivalLineBadge(a)) || `idx-${index}`
      const withMeta = { arrival: a, index, etaMins: arrivalEtaMinutes(a) }
      const existing = byLine.get(lineKey)
      if (existing) {
        existing.items.push(withMeta)
      } else {
        byLine.set(lineKey, { key: lineKey, items: [withMeta] })
      }
    })
    return [...byLine.values()]
      .map((g) => {
        const items = [...g.items].sort(
          (a, b) => a.etaMins - b.etaMins || a.index - b.index
        )
        return {
          key: g.key,
          primary: items[0]?.arrival ?? null,
          extras: items.slice(1).map((x) => x.arrival),
          firstIndex: items[0]?.index ?? Number.POSITIVE_INFINITY,
          firstEtaMins: items[0]?.etaMins ?? Number.POSITIVE_INFINITY,
        }
      })
      .filter((g) => g.primary)
      .sort(
        (a, b) =>
          a.firstEtaMins - b.firstEtaMins || a.firstIndex - b.firstIndex
      )
  }, [arrivals])

  const showArrivalsListLayout =
    !error &&
    Array.isArray(arrivals) &&
    (arrivals.length > 0 || unplannedRoutes.length > 0)

  const holdArrivalsViewportDuringRefresh =
    arrivalsRefreshing && everHadArrivalsRef.current
  const holdArrivalsViewportDuringStopSwitchLoad =
    !mobileSheet &&
    (stopJustChanged ||
      (loading &&
        !error &&
        arrivals == null)) &&
    lastArrivalsViewportPxRef.current != null
  const showSpinnerInHeldArrivalsViewport =
    holdArrivalsViewportDuringRefresh || holdArrivalsViewportDuringStopSwitchLoad
  const holdCardHeightDuringStopSwitchLoad =
    holdArrivalsViewportDuringStopSwitchLoad &&
    lastCardHeightPxRef.current != null
  const holdHeaderHeightDuringStopSwitchLoad =
    holdArrivalsViewportDuringStopSwitchLoad &&
    lastHeaderHeightPxRef.current != null
  /** Keep list viewport chrome mounted while we swap its contents for a spinner. */
  const showArrivalsListChrome =
    !error && (showArrivalsListLayout || showSpinnerInHeldArrivalsViewport)
  /** While refreshing or swapping stops, lock height to the last good measure so the panel does not jump for the spinner. */
  const ARRIVALS_VIEWPORT_LOADING_PX = 120
  const ARRIVALS_VIEWPORT_HOLD_FALLBACK_PX = 200
  const appliedArrivalsListViewportPx =
    showSpinnerInHeldArrivalsViewport
      ? (arrivalsListViewportPx ??
      lastArrivalsViewportPxRef.current ??
      ARRIVALS_VIEWPORT_HOLD_FALLBACK_PX)
      : arrivalsListViewportPx
  const initialLoadingArrivalsViewportPx =
    !mobileSheet &&
    loading &&
    arrivals == null &&
    !error &&
    !showSpinnerInHeldArrivalsViewport
      ? (appliedArrivalsListViewportPx ?? ARRIVALS_VIEWPORT_LOADING_PX)
      : appliedArrivalsListViewportPx
  const forceLoadingViewportFallbackOnMount =
    !mobileSheet &&
    loading &&
    arrivals == null &&
    !error &&
    !showSpinnerInHeldArrivalsViewport &&
    initialLoadingArrivalsViewportPx != null

  const measureMobileSheetPeekHeight = useCallback(() => {
    if (!mobileSheet || typeof window === 'undefined') return
    const card = cardRef.current
    if (!card) return
    const header = card.querySelector('.stop-popup-header')
    if (!(header instanceof HTMLElement)) return

    const readPx = (value) => {
      const parsed = Number.parseFloat(String(value ?? '0'))
      return Number.isFinite(parsed) ? parsed : 0
    }

    const cardStyle = window.getComputedStyle(card)
    const nextHeight = Math.ceil(
      readPx(cardStyle.paddingTop) +
        header.getBoundingClientRect().height +
        stopPopupMobilePeekContentHeight({
          arrivalsListEl: arrivalListMeasureRef.current,
          arrivalsScrollContentEl: arrivalsScrollContentRef.current,
          arrivalsRegionEl: arrivalsRegionRef.current,
        }) +
        readPx(cardStyle.paddingBottom) +
        MOBILE_STOP_PEEK_MEASURE_BUFFER_PX
    )

    onMobileSheetPeekHeightChange?.(nextHeight > 0 ? nextHeight : null)
  }, [mobileSheet, onMobileSheetPeekHeightChange])

  const measureArrivalsListViewport = useCallback(() => {
    if (mobileSheet) {
      setArrivalsListViewportPx(null)
      return
    }
    if (arrivalsRefreshing || holdArrivalsViewportDuringStopSwitchLoad) return
    const region = arrivalsRegionRef.current
    const view = arrivalsViewportRef.current
    const wrapper = arrivalsScrollContentRef.current
    const card = cardRef.current
    const hasArrivalsArray = Array.isArray(arrivals)
    const canMeasureList = hasArrivalsArray && view != null && wrapper != null
    const canMeasureFallback = loading || error
    if (
      typeof window === 'undefined' ||
      !region ||
      !card ||
      (!canMeasureList && !canMeasureFallback)
    ) {
      if (!arrivalsRefreshing) setArrivalsListViewportPx(null)
      return
    }
    if (
      hasArrivalsArray &&
      arrivals.length === 0 &&
      unplannedRoutes.length === 0 &&
      !loading &&
      !error
    ) {
      if (!arrivalsRefreshing) setArrivalsListViewportPx(null)
      return
    }
    const run = () => {
      const regionTop = region.getBoundingClientRect().top
      let reservedBelowPx = 0
      const stackEl = card.closest('.map-right-stack')
      if (stackEl) {
        let stackChild = card
        while (stackChild && stackChild.parentElement !== stackEl) {
          stackChild = stackChild.parentElement
        }
        if (stackChild) {
          const stackChildren = Array.from(stackEl.children)
          const cardIdx = stackChildren.indexOf(stackChild)
          if (cardIdx !== -1 && cardIdx < stackChildren.length - 1) {
            const belowSiblings = stackChildren.slice(cardIdx + 1)
            for (const siblingEl of belowSiblings) {
              reservedBelowPx += siblingEl.getBoundingClientRect().height
            }
            const stackStyle = window.getComputedStyle(stackEl)
            const rowGapPx = Number.parseFloat(
              stackStyle.rowGap || stackStyle.gap || '0'
            )
            if (Number.isFinite(rowGapPx) && rowGapPx > 0) {
              reservedBelowPx += rowGapPx * belowSiblings.length
            }
          }
        }
      }
      const maxH = Math.max(
        100,
        window.innerHeight - STOP_POPUP_BOTTOM_RESERVE_PX - regionTop - reservedBelowPx
      )
      const listEl = arrivalListMeasureRef.current
      const contentH = canMeasureList
        ? Math.ceil(listEl != null ? listEl.scrollHeight : wrapper.scrollHeight)
        : Math.min(ARRIVALS_VIEWPORT_LOADING_PX, maxH)
      const next = Math.min(contentH, maxH)
      setArrivalsListViewportPx((prev) => {
        if (prev === next) return prev
        if (typeof next === 'number' && next > 0) {
          lastArrivalsViewportPxRef.current = next
        }
        return next
      })
    }
    run()
    requestAnimationFrame(run)
  }, [
    arrivals,
    unplannedRoutes,
    arrivalsRefreshing,
    holdArrivalsViewportDuringStopSwitchLoad,
    loading,
    error,
    mobileSheet,
  ])

  useLayoutEffect(() => {
    if (mobileSheet || holdCardHeightDuringStopSwitchLoad) return undefined
    const card = cardRef.current
    if (!card) return undefined

    const measure = () => {
      const next = Math.ceil(card.getBoundingClientRect().height)
      if (next > 0) lastCardHeightPxRef.current = next
    }

    measure()
    requestAnimationFrame(measure)

    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => measure())
    ro.observe(card)
    return () => ro.disconnect()
  }, [
    holdCardHeightDuringStopSwitchLoad,
    mobileSheet,
    showArrivalsListChrome,
    stopPopupHeading,
    subtitleFull,
    appliedArrivalsListViewportPx,
  ])

  useLayoutEffect(() => {
    if (mobileSheet || holdHeaderHeightDuringStopSwitchLoad) return undefined
    const header = headerRef.current
    if (!header) return undefined

    const measure = () => {
      const next = Math.ceil(header.getBoundingClientRect().height)
      if (next > 0) lastHeaderHeightPxRef.current = next
    }

    measure()
    requestAnimationFrame(measure)

    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(() => measure())
    ro.observe(header)
    return () => ro.disconnect()
  }, [
    holdHeaderHeightDuringStopSwitchLoad,
    mobileSheet,
    stopPopupHeading,
    subtitleFull,
  ])

  useLayoutEffect(() => {
    if (!mobileSheet) {
      onMobileSheetPeekHeightChange?.(null)
      return undefined
    }
    if (mobileSheetCollapsed) return undefined
    if (loading) {
      if (arrivals == null && !error) {
        onMobileSheetPeekHeightChange?.(MOBILE_STOP_PEEK_LOADING_PX)
      }
      return undefined
    }

    measureMobileSheetPeekHeight()
    const observers = []
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measureMobileSheetPeekHeight())
      const targets = [
        cardRef.current?.querySelector('.stop-popup-header'),
        arrivalListMeasureRef.current,
        arrivalsScrollContentRef.current,
        arrivalsRegionRef.current?.querySelector('.stop-popup-arrivals-viewport'),
      ].filter(Boolean)
      for (const target of targets) ro.observe(target)
      observers.push(ro)
    }
    const onResize = () => measureMobileSheetPeekHeight()
    window.addEventListener('resize', onResize)
    return () => {
      for (const ro of observers) ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [
    arrivals,
    arrivalsRefreshing,
    error,
    loading,
    measureMobileSheetPeekHeight,
    mobileSheet,
    mobileSheetCollapsed,
    onMobileSheetPeekHeightChange,
    showArrivalsListChrome,
    stop.id,
    unplannedRoutes,
  ])

  useLayoutEffect(() => {
    if (mobileSheet) {
      setArrivalsListViewportPx(null)
      return undefined
    }
    if (!(showArrivalsListChrome || loading || error)) {
      if (!arrivalsRefreshing) setArrivalsListViewportPx(null)
      return
    }
    if (arrivalsRefreshing || holdArrivalsViewportDuringStopSwitchLoad) return
    measureArrivalsListViewport()
    const card = cardRef.current
    const stack = card?.closest('.map-right-stack')
    const observers = []
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => measureArrivalsListViewport())
      if (stack) {
        ro.observe(stack)
        let stackChild = card
        while (stackChild && stackChild.parentElement !== stack) {
          stackChild = stackChild.parentElement
        }
        if (stackChild) {
          for (const child of stack.children) {
            if (child !== stackChild) ro.observe(child)
          }
        }
      }
      const roTarget =
        arrivalListMeasureRef.current ?? arrivalsScrollContentRef.current
      if (roTarget) ro.observe(roTarget)
      observers.push(ro)
    }
    const onResize = () => measureArrivalsListViewport()
    window.addEventListener('resize', onResize)
    return () => {
      for (const ro of observers) ro.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [
    measureArrivalsListViewport,
    showArrivalsListChrome,
    arrivals,
    arrivalsRefreshing,
    holdArrivalsViewportDuringStopSwitchLoad,
    loading,
    error,
    mobileSheet,
    stop.id,
  ])

  const toggleUnplannedRoutes = useCallback((e) => {
    e.stopPropagation()
    let expanding = false
    setShowUnplannedRoutes((prev) => {
      const next = !prev
      expanding = next
      try {
        localStorage.setItem(LS_SHOW_UNPLANNED_STOP_LINES, next ? '1' : '0')
      } catch {
        /* ignore storage failures */
      }
      return next
    })
    if (!expanding) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const view = arrivalsViewportRef.current
        const row = unplannedToggleRowRef.current
        const card = cardRef.current
        if (!view || !row || !card) return
        const viewTop = view.getBoundingClientRect().top
        let siblingReservePx = 0
        const stackEl = card.closest('.map-right-stack')
        if (stackEl) {
          let stackChild = card
          while (stackChild && stackChild.parentElement !== stackEl) {
            stackChild = stackChild.parentElement
          }
          if (stackChild) {
            for (const child of stackEl.children) {
              if (child !== stackChild) {
                siblingReservePx += child.getBoundingClientRect().height
              }
            }
            const stackStyle = window.getComputedStyle(stackEl)
            const gapPx = Number.parseFloat(
              stackStyle.rowGap || stackStyle.gap || '0'
            )
            if (Number.isFinite(gapPx) && gapPx > 0) {
              const siblingCount = stackEl.children.length - 1
              siblingReservePx += gapPx * siblingCount
            }
          }
        }
        const maxPossibleHeight = Math.max(
          100,
          window.innerHeight - STOP_POPUP_BOTTOM_RESERVE_PX - viewTop - siblingReservePx
        )
        const canStillExpand = view.clientHeight < maxPossibleHeight - 1
        if (canStillExpand) return
        const hasOverflow = view.scrollHeight > view.clientHeight + 1
        if (!hasOverflow) return
        const viewRect = view.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        const deltaTop = rowRect.top - viewRect.top
        if (Math.abs(deltaTop) <= 1) return
        const TOP_INSET_PX = 5
        const maxTop = Math.max(0, view.scrollHeight - view.clientHeight)
        view.scrollTo({
          top: Math.min(
            maxTop,
            Math.max(0, view.scrollTop + deltaTop - TOP_INSET_PX)
          ),
          behavior: 'smooth',
        })
      })
    })
  }, [])

  const cardStyle = mobileSheet
    ? {
        '--mobile-sheet-expand-progress': `${mobileSheetExpansionProgress}`,
        '--mobile-sheet-body-reveal': `${mobileSheetBodyReveal}`,
      }
    : sheetOffsetY > 0 ||
        holdCardHeightDuringStopSwitchLoad ||
        forceLoadingViewportFallbackOnMount ||
        !freshMountVisible
      ? {
          ...(sheetOffsetY > 0
            ? { transform: `translateY(${sheetOffsetY}px)` }
            : {}),
          ...(holdCardHeightDuringStopSwitchLoad
            ? { height: lastCardHeightPxRef.current }
            : {}),
          ...(forceLoadingViewportFallbackOnMount
            ? {
                '--stop-popup-arrivals-h': `${initialLoadingArrivalsViewportPx}px`,
              }
            : {}),
          ...(!freshMountVisible
            ? {
                visibility: 'hidden',
                opacity: 0,
                pointerEvents: 'none',
              }
            : {}),
        }
      : undefined

  return (
    <div
      ref={cardRef}
      className={
        'stop-popup-card' +
        (mobileSheet ? ' stop-popup-card--mobile-sheet' : '') +
        (headerDragCursorActive ? ' stop-popup-card--header-dragging' : '') +
        (mobileSheetCollapsed ? ' stop-popup-card--mobile-minimized' : '')
      }
      data-testid="stop-popup"
      style={cardStyle}
      onMouseDown={(e) => {
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={headerRef}
        className="stop-popup-header"
        onPointerDown={onHeaderPointerDown}
        style={
          !mobileSheet && holdHeaderHeightDuringStopSwitchLoad
            ? {
                height: lastHeaderHeightPxRef.current,
                boxSizing: 'border-box',
                overflow: 'hidden',
              }
            : undefined
        }
      >
        <div className="stop-popup-header-drag-zone" aria-hidden />
        <div className="stop-popup-drag-handle" aria-hidden />
        <div className="stop-popup-header-row">
          <div className="stop-popup-title-block">
            <div className="stop-popup-panel-heading">
              <button
                type="button"
                className="stop-popup-map-hit stop-popup-icon-hit"
                data-stop-header-tap-action="center"
                onClick={(e) => onHeaderActionClick('center', e)}
                aria-label="Κεντράρισμα χάρτη στη στάση"
              >
              <div className="stop-popup-panel-icon" aria-hidden>
                <MapPin size={20} strokeWidth={2} />
              </div>
              </button>
              <div className="stop-popup-title-group">
                <span
                  className="stop-popup-title stop-popup-title-selectable"
                  lang="el"
                >
                  {stopPopupHeading}
                </span>
                <span
                  className="stop-popup-subtitle stop-popup-title-selectable"
                  title={subtitleFull}
                >
                  {subtitleFull}
                </span>
              </div>
            </div>
          </div>
          <div className="stop-popup-actions">
            <button
              type="button"
              className={`stop-popup-favorite${isFavorite ? ' stop-popup-favorite--active' : ''}`}
              data-stop-header-tap-action="favorite"
              onClick={(e) => onHeaderActionClick('favorite', e)}
              aria-label={
                isFavorite ? 'Αφαίρεση από τα αγαπημένα' : 'Προσθήκη στα αγαπημένα'
              }
              aria-pressed={isFavorite}
            >
              <FavoriteIcon
                size={17}
                strokeWidth={2.2}
                filled={isFavorite}
              />
            </button>
            <button
              type="button"
              className="stop-popup-close"
              data-stop-header-tap-action="close"
              onClick={(e) => onHeaderActionClick('close', e)}
              aria-label="Κλείσιμο"
            >
              <CloseIcon size={16} strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>

      <StopPopupArrivalsRegion
        activeRouteCode={activeRouteCode}
        appliedArrivalsListViewportPx={appliedArrivalsListViewportPx}
        arrivalListMeasureRef={arrivalListMeasureRef}
        arrivals={arrivals}
        arrivalsRegionRef={arrivalsRegionRef}
        arrivalsScrollContentRef={arrivalsScrollContentRef}
        arrivalsViewportRef={arrivalsViewportRef}
        error={error}
        groupedArrivals={groupedArrivals}
        hasOnlyUnplannedRoutes={hasOnlyUnplannedRoutes}
        initialLoadingArrivalsViewportPx={initialLoadingArrivalsViewportPx}
        loading={loading}
        mobileSheet={mobileSheet}
        mobileSheetCollapsed={mobileSheetCollapsed}
        onArrivalsPointerDown={onArrivalsPointerDown}
        onSelectArrival={onSelectArrival}
        showArrivalsListChrome={showArrivalsListChrome}
        showSpinnerInHeldArrivalsViewport={showSpinnerInHeldArrivalsViewport}
        showUnplannedRoutes={showUnplannedRoutes}
        stopId={stop.id}
        toggleUnplannedRoutes={toggleUnplannedRoutes}
        unplannedRoutes={unplannedRoutes}
        unplannedToggleRowRef={unplannedToggleRowRef}
        visibleUnplannedRoutes={visibleUnplannedRoutes}
      />
    </div>
  )
}

/* ── Main Application ──────────────────────────────────── */

const APP_BROWSER_TITLE = 'Λεωφορεία ΟΑΣΘ'

function PageAuthGate({ onSuccess }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const submit = useCallback(
    async (e) => {
      e.preventDefault()
      setError(null)
      setBusy(true)
      try {
        const res = await fetch('/api/auth/page-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ password }),
        })
        const data = res.ok ? await res.json().catch(() => ({})) : null
        if (!res.ok) {
          const msg =
            data && typeof data.error === 'string'
              ? data.error
              : 'Σφάλμα σύνδεσης'
          setError(msg)
          return
        }
        onSuccess()
      } catch {
        setError('Δεν ήταν δυνατή η σύνδεση με τον διακομιστή.')
      } finally {
        setBusy(false)
      }
    },
    [password, onSuccess]
  )

  return (
    <div className="page-auth-gate" lang="el">
      <form className="page-auth-gate__card" onSubmit={submit}>
        <h1 className="page-auth-gate__title">{APP_BROWSER_TITLE}</h1>
        <p className="page-auth-gate__hint">
          Απαιτείται κωδικός πρόσβασης για αυτή την εφαρμογή.
        </p>
        <label className="page-auth-gate__label" htmlFor="page-auth-password">
          Κωδικός
        </label>
        <input
          id="page-auth-password"
          type="password"
          className="page-auth-gate__input"
          value={password}
          onChange={(ev) => setPassword(ev.target.value)}
          autoComplete="current-password"
          disabled={busy}
          autoFocus
        />
        {error ? (
          <p className="page-auth-gate__error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="page-auth-gate__submit" disabled={busy}>
          {busy ? 'Σύνδεση…' : 'Σύνδεση'}
        </button>
      </form>
    </div>
  )
}

function AppBootLoading({ label = 'Φόρτωση εφαρμογής…' }) {
  return (
    <div className="app-boot-loading" role="status" aria-label={label} lang="el">
      <div className="stop-popup-spinner app-boot-loading-spinner" aria-hidden />
      <div className="app-boot-loading-text">{label}</div>
    </div>
  )
}

export default function App() {
  useEffect(() => {
    document.title = APP_BROWSER_TITLE
  }, [])

  const [pageAuthEnabled, setPageAuthEnabled] = useState(null)
  const [pageAuthOk, setPageAuthOk] = useState(false)
  const refreshPageAuth = useCallback(() => {
    fetchPageAuthStatus().then((s) => {
      setPageAuthEnabled(!!s.enabled)
      setPageAuthOk(!s.enabled || !!s.authenticated)
    })
  }, [])

  useEffect(() => {
    refreshPageAuth()
  }, [refreshPageAuth])

  const [stops, setStops]       = useState([])
  const [favoriteStopOrder, setFavoriteStopOrder] = useState(() =>
    readOrderedIds(LS_FAVORITE_STOPS)
  )
  const [selectedStop, setSelectedStop]   = useState(null)
  /** Bumped when the map picks a stop that is already selected so the line HUD list re-centers. */
  const [, setTrackedHudStopsRecenterKey] = useState(0)
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false)
  const [leftSidebarPanel, setLeftSidebarPanel] = useState(() =>
    readLeftSidebarPanel()
  )
  const [isMobileViewport, setIsMobileViewport] = useState(() =>
    isMobileViewportNow()
  )
  const [mobileViewportHeight, setMobileViewportHeight] = useState(() =>
    readVisualViewportHeight()
  )
  const [mobileSheetMode, setMobileSheetMode] = useState('browse')
  const [mobileSheetSnap, setMobileSheetSnap] = useState('minimized')
  const [mobileLastBrowseTab, setMobileLastBrowseTab] = useState(() =>
    readLeftSidebarPanel()
  )
  const [mobileSheetLiveHeight, setMobileSheetLiveHeight] = useState(null)
  const [mobileSheetDragging, setMobileSheetDragging] = useState(false)
  const [mobileStopPeekHeight, setMobileStopPeekHeight] = useState(null)
  const [mobileStopOpenTransitionSuppressed, setMobileStopOpenTransitionSuppressed] =
    useState(false)
  const [mobileStopLoading, setMobileStopLoading] = useState(false)
  const [mobileSheetBottomOffset, setMobileSheetBottomOffset] = useState(
    MOBILE_STOP_FLOATING_EDGE_GAP_PX
  )
  const [mobileBrowseSearchQuery, setMobileBrowseSearchQuery] = useState('')
  const [homeSearchHeaderActive, setHomeSearchHeaderActive] = useState(false)

  const [homeSearchResetToken, setHomeSearchResetToken] = useState(0)
  const appViewportRef = useRef(null)
  const leftSidebarPanelRef = useRef('home')
  const homeSearchInputRef = useRef(null)
  const allLinesSearchInputRef = useRef(null)
  const mobileSheetHostRef = useRef(null)
  const mobileSheetLiveHeightFrameRef = useRef(null)
  const pendingMobileSheetLiveHeightRef = useRef(null)
  const mobileStopSheetLiveHeightFrameRef = useRef(null)
  const pendingMobileStopSheetLiveHeightRef = useRef(null)
  const mobileStopInitialOpenPendingRef = useRef(false)
  const [recentLines, setRecentLines] = useState(() => readRecentLines())
  /** `webGetLines` rows for sidebar search (LineCode, LineID, LineDescr, …). */
  const [allLines, setAllLines] = useState([])
  const [loading, setLoading]             = useState(true)
  const [userLocation, setUserLocation]   = useState(null)
  const [geoError, setGeoError]           = useState(() =>
    typeof navigator !== 'undefined' && !navigator.geolocation
      ? 'Ο γεωεντοπισμός δεν υποστηρίζεται σε αυτόν τον περιηγητή.'
      : null
  )
  const [geoPending, setGeoPending]       = useState(() =>
    typeof navigator !== 'undefined' && !!navigator.geolocation
  )
  const mapRef = useRef(null)
  /** Primary button down on empty map — show grabbing cursor while panning. */
  const mapCanvasPanningRef = useRef(false)
  const lastMapPointerPointRef = useRef(null)
  const locateFlyGenRef = useRef(0)
  const [locateFlyHighlight, setLocateFlyHighlight] = useState(false)
  const autoPannedToUserRef = useRef(false)
  const [mapReady, setMapReady] = useState(false)
  /** Camera snapshot for “centered on me” locate icon (updated on load + moveend). */
  const [mapCamera, setMapCamera] = useState(null)
  const [mapBaseStyleKey, setMapBaseStyleKey] = useState(() =>
    readMapBaseStyleKey()
  )
  const mapStyleUrl = useMemo(
    () => MAP_BASE_STYLE_PRESETS[mapBaseStyleKey],
    [mapBaseStyleKey]
  )
  const mapBasemapIsDark = mapBaseStyleKey === 'dark'
  /** Stop / route-vertex symbol labels on the map (not UI chrome). */
  const stopVertexMapLabelPaint = useMemo(
    () =>
      mapBasemapIsDark
        ? {
            textColor: 'rgba(248, 248, 252, 0.96)',
            haloColor: 'rgba(0, 0, 0, 0.62)',
          }
        : {
            textColor: '#3c3c43',
            haloColor: 'rgba(255, 255, 255, 0.9)',
          },
    [mapBasemapIsDark]
  )
  /** Insert stop layers before this basemap layer so place/neighborhood labels paint on top. */
  const [stopsBeforeLayerId, setStopsBeforeLayerId] = useState(null)
  const [trackedLineGeo, setTrackedLineGeo] = useState(null)
  const [trackedBusGeo, setTrackedBusGeo] = useState(null)
  const [liveTracking, setLiveTracking] = useState(null)
  const [, setLineRouteVariantBusy] = useState(false)
  const [, setLineTrackBusy] = useState(false)
  const [, setLineTrackHint] = useState(null)

  const handleMobileSheetLiveHeightChange = useCallback((nextHeight) => {
    if (typeof window === 'undefined') {
      setMobileSheetLiveHeight(nextHeight)
      return
    }
    if (nextHeight == null) {
      pendingMobileSheetLiveHeightRef.current = null
      if (mobileSheetLiveHeightFrameRef.current != null) {
        cancelAnimationFrame(mobileSheetLiveHeightFrameRef.current)
        mobileSheetLiveHeightFrameRef.current = null
      }
      setMobileSheetLiveHeight(null)
      return
    }
    pendingMobileSheetLiveHeightRef.current = nextHeight
    if (mobileSheetLiveHeightFrameRef.current != null) return
    mobileSheetLiveHeightFrameRef.current = requestAnimationFrame(() => {
      mobileSheetLiveHeightFrameRef.current = null
      const pendingHeight = pendingMobileSheetLiveHeightRef.current
      setMobileSheetLiveHeight((prev) => (prev === pendingHeight ? prev : pendingHeight))
    })
  }, [])

  const applyMobileSheetVisibleHeight = useCallback((nextHeight) => {
    const nextPx = `${Math.max(0, Number(nextHeight) || 0)}px`
    mobileSheetHostRef.current?.style.setProperty('height', nextPx)
    appViewportRef.current?.style.setProperty('--mobile-sheet-visible-height', nextPx)
  }, [])

  const handleMobileStopSheetLiveHeightChange = useCallback(
    (nextHeight) => {
      if (typeof window === 'undefined') return
      if (nextHeight == null) {
        pendingMobileStopSheetLiveHeightRef.current = null
        if (mobileStopSheetLiveHeightFrameRef.current != null) {
          cancelAnimationFrame(mobileStopSheetLiveHeightFrameRef.current)
          mobileStopSheetLiveHeightFrameRef.current = null
        }
        return
      }
      pendingMobileStopSheetLiveHeightRef.current = nextHeight
      if (mobileStopSheetLiveHeightFrameRef.current != null) return
      mobileStopSheetLiveHeightFrameRef.current = requestAnimationFrame(() => {
        mobileStopSheetLiveHeightFrameRef.current = null
        const pendingHeight = pendingMobileStopSheetLiveHeightRef.current
        if (pendingHeight == null) return
        applyMobileSheetVisibleHeight(pendingHeight)
      })
    },
    [applyMobileSheetVisibleHeight]
  )

  useEffect(() => {
    return () => {
      if (mobileSheetLiveHeightFrameRef.current != null) {
        cancelAnimationFrame(mobileSheetLiveHeightFrameRef.current)
      }
      if (mobileStopSheetLiveHeightFrameRef.current != null) {
        cancelAnimationFrame(mobileStopSheetLiveHeightFrameRef.current)
      }
    }
  }, [])
  const [liveBusArrowReady, setLiveBusArrowReady] = useState(false)
  const [favoriteStopMapIconReady, setFavoriteStopMapIconReady] = useState(false)
  /** Rows from `webGetStops` while a line is tracked — used for route stop highlights. */
  const [trackedRouteStopsRows, setTrackedRouteStopsRows] = useState(null)
  const stopsRef = useRef(stops)
  const trackedRouteStopIdsRef = useRef(new Set())
  const selectedStopRef = useRef(selectedStop)
  const prevSelectedStopIdRef = useRef(selectedStop?.id ?? null)
  const liveTrackingRef = useRef(liveTracking)
  const trackReqSeq = useRef(0)
  const popupSelectInFlightKeyRef = useRef('')
  /** Empty map clicks clear the path only after popup is dismissed; ref avoids stale clicks. */
  const trackedLineActiveRef = useRef(false)
  useEffect(() => {
    trackedLineActiveRef.current = !!(trackedLineGeo?.features?.length)
  }, [trackedLineGeo])
  useEffect(() => {
    stopsRef.current = stops
  }, [stops])
  useEffect(() => {
    selectedStopRef.current = selectedStop
  }, [selectedStop])
  useEffect(() => {
    liveTrackingRef.current = liveTracking
  }, [liveTracking])

  useEffect(() => {
    if (!trackedRouteStopsRows?.length) {
      trackedRouteStopIdsRef.current = new Set()
      return
    }
    trackedRouteStopIdsRef.current = new Set(
      trackedRouteStopsRows
        .map((r) => String(r.StopCode ?? r.StopID ?? '').trim())
        .filter(Boolean)
    )
  }, [trackedRouteStopsRows])

  const resetLiveLineTracking = useCallback(() => {
    trackReqSeq.current += 1
    setTrackedLineGeo(null)
    setTrackedBusGeo(null)
    setLiveTracking(null)
    setLineTrackBusy(false)
    setLineRouteVariantBusy(false)
    setLineTrackHint(null)
    setTrackedRouteStopsRows(null)
  }, [])

  const loadTrackedRoutesForMap = useCallback(async (routeCodes, lineBadge, options = {}) => {
    const includeStops = options.includeStops !== false
    const onlyRouteCode = String(options.onlyRouteCode ?? '').trim()
    const uniq = [...new Set((Array.isArray(routeCodes) ? routeCodes : []).map((v) => String(v ?? '').trim()).filter(Boolean))]
    const routeList =
      onlyRouteCode && uniq.includes(onlyRouteCode) ? [onlyRouteCode] : uniq
    if (routeList.length === 0) {
      return {
        lineGeo: null,
        routeStopsRows: [],
        busGeo: { type: 'FeatureCollection', features: [] },
      }
    }
    const perRoute = await Promise.all(
      routeList.map(async (routeCode, idx) => {
        const routeColor = trackedRouteColorAt(idx)
        const [stopsRowsRaw, busRowsRaw] = await Promise.all([
          includeStops
            ? fetchRouteStopsForMap(routeCode).catch(() => [])
            : Promise.resolve([]),
          fetchBusLocationsForRoute(routeCode),
        ])
        const stopsRows = Array.isArray(stopsRowsRaw) ? stopsRowsRaw : []
        const linePart = stopsRowsToLineGeoJson(stopsRows)
        const lineFeature = linePart?.features?.[0]
        const lineFeatures = lineFeature
          ? [
              {
                ...lineFeature,
                properties: {
                  ...(lineFeature.properties ?? {}),
                  routeCode,
                  routeColor,
                },
              },
            ]
          : []
        const rowsWithMeta = stopsRows.map((row) => ({
          ...row,
          __routeCode: routeCode,
          routeColor,
        }))
        const busRows = Array.isArray(busRowsRaw) ? busRowsRaw : []
        const busGeo = busLocationsToGeoJson(busRows, lineBadge, routeCode, {
          routeCode,
          routeColor,
        })
        return {
          routeCode,
          lineFeatures,
          rowsWithMeta,
          busFeatures: busGeo.features ?? [],
        }
      })
    )
    return {
      lineGeo: {
        type: 'FeatureCollection',
        features: perRoute.flatMap((r) => r.lineFeatures),
      },
      routeStopsRows: perRoute.flatMap((r) => r.rowsWithMeta),
      busGeo: {
        type: 'FeatureCollection',
        features: perRoute.flatMap((r) => r.busFeatures),
      },
    }
  }, [])

  const cycleMapBaseStyle = useCallback(() => {
    setMapBaseStyleKey((prev) => {
      const i = MAP_BASE_STYLE_ORDER.indexOf(prev)
      const next = MAP_BASE_STYLE_ORDER[(i + 1) % MAP_BASE_STYLE_ORDER.length]
      writeMapBaseStyleKey(next)
      return next
    })
  }, [])

  const handleMapLoad = useCallback(() => {
    setMapReady(true)
    const map = mapRef.current?.getMap()
    if (!map) return
    const canvas = map.getCanvas()
    if (canvas) canvas.style.cursor = 'default'
    const c = map.getCenter()
    setMapCamera({
      longitude: c.lng,
      latitude: c.lat,
      zoom: map.getZoom(),
    })
    const onStyleLoad = () => {
      hideMapBasemapPoiLayers(map)
      hideBasemapTransitStopLayer(map)
      thickenBasemapSymbolTextFonts(map)
      tryInstallFavoriteStopMapIcon(map)
      setStopsBeforeLayerId(findStopsBeforeBasemapLabelLayerId(map.getStyle()))
    }
    map.on('style.load', onStyleLoad)
    if (map.isStyleLoaded()) onStyleLoad()
  }, [])

  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current?.getMap()
    if (!map) return
    let cancelled = false
    setLiveBusArrowReady(false)

    const installLiveBusArrowIcon = () => {
      map.loadImage(liveBusArrowUrl, (err, image) => {
        if (cancelled) return
        if (err || !image) {
          console.error('[oasth] live bus arrow PNG load failed:', liveBusArrowUrl, err)
          return
        }
        try {
          if (map.hasImage(TRACKED_BUS_ARROW_ICON_ID)) {
            map.removeImage(TRACKED_BUS_ARROW_ICON_ID)
          }
        } catch {
          /* not present */
        }
        try {
          map.addImage(TRACKED_BUS_ARROW_ICON_ID, image)
          setLiveBusArrowReady(true)
        } catch {
          console.error('[oasth] live bus arrow addImage failed')
        }
      })
    }

    installLiveBusArrowIcon()
    map.once('idle', installLiveBusArrowIcon)
    map.on('style.load', installLiveBusArrowIcon)
    return () => {
      cancelled = true
      setLiveBusArrowReady(false)
      map.off('idle', installLiveBusArrowIcon)
      map.off('style.load', installLiveBusArrowIcon)
    }
  }, [mapReady])


  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const reinstall = () => {
      setFavoriteStopMapIconReady(false)
      setFavoriteStopMapIconReady(tryInstallFavoriteStopMapIcon(map))
    }
    const onStyleImageMissing = (e) => {
      const missingId = String(e?.id ?? '').trim()
      if (missingId !== STOPS_FAVORITE_MAP_ICON_ID) return
      setFavoriteStopMapIconReady(tryInstallFavoriteStopMapIcon(map))
    }
    reinstall()
    map.on('style.load', reinstall)
    map.on('styleimagemissing', onStyleImageMissing)
    return () => {
      setFavoriteStopMapIconReady(false)
      map.off('style.load', reinstall)
      map.off('styleimagemissing', onStyleImageMissing)
    }
  }, [mapReady])

  const rememberRecentLineSelection = useCallback((entry) => {
    setRecentLines((prev) => {
      const normalized = normalizeStoredLineEntry(entry)
      if (!normalized) return prev
      const key = storedLineEntryKey(normalized)
      const filtered = prev.filter((row) => storedLineEntryKey(row) !== key)
      const next = [normalized, ...filtered].slice(0, RECENT_LINES_MAX)
      writeRecentLines(next)
      return next
    })
  }, [])

  const onSelectArrivalFromPopup = useCallback(async (arrival, stopId) => {
    if (!stopId) return
    const currentTracking = liveTrackingRef.current
    const currentRouteCode = String(currentTracking?.routeCode ?? '').trim()
    const clickedEmbedded = String(arrival?.resolved_route_code ?? '').trim()
    const clickedRaw = String(arrivalRouteRaw(arrival) ?? '').trim()
    const clickedCanon = String(canonNumish(clickedRaw) ?? '').trim()
    let clickedRouteCandidate = clickedEmbedded || clickedRaw || clickedCanon
    const currentLineIdKey = normalizeLineIdKey(
      String(currentTracking?.lineId ?? '').trim()
    )
    const clickedLineIdKey = normalizeLineIdKey(
      String(arrival?.line_id ?? arrival?.LineID ?? '').trim()
    )
    const currentLineBadgeKey = normalizeLineIdKey(
      String(currentTracking?.lineBadgeShort ?? '').trim()
    )
    const clickedLineBadgeKey = normalizeLineIdKey(arrivalLineBadge(arrival))
    const inFlightIdentityKey = [
      String(stopId).trim(),
      clickedRouteCandidate || '',
      clickedLineIdKey || '',
      clickedLineBadgeKey || '',
    ].join('|')
    if (
      popupSelectInFlightKeyRef.current &&
      popupSelectInFlightKeyRef.current === inFlightIdentityKey
    ) {
      return
    }
    const sameLineById =
      Boolean(currentLineIdKey && clickedLineIdKey) &&
      currentLineIdKey === clickedLineIdKey
    const sameLineByBadge =
      Boolean(currentLineBadgeKey && clickedLineBadgeKey) &&
      currentLineBadgeKey === clickedLineBadgeKey
    if (sameLineById || sameLineByBadge) return
    if (
      currentRouteCode &&
      clickedRouteCandidate &&
      routeCodesMatch(clickedRouteCandidate, currentRouteCode)
    ) {
      return
    }
    // Some arrival rows don't carry a map-usable route code; resolve before setting loading,
    // so re-clicking the already selected route does not flash the HUD spinner.
    if (!clickedRouteCandidate && currentRouteCode) {
      try {
        const resolved = await resolveRouteCodeForMap(arrival, stopId)
        clickedRouteCandidate = String(resolved?.routeCode ?? '').trim()
      } catch {
        /* ignore — we'll proceed with normal selection flow below */
      }
      if (
        clickedRouteCandidate &&
        routeCodesMatch(clickedRouteCandidate, currentRouteCode)
      ) {
        return
      }
    }
    popupSelectInFlightKeyRef.current = [
      String(stopId).trim(),
      clickedRouteCandidate || '',
      clickedLineIdKey || '',
      clickedLineBadgeKey || '',
    ].join('|')
    setLineTrackHint(null)
    const seq = ++trackReqSeq.current
    setLineTrackBusy(true)
    const vehFocus = String(
      arrival?.veh_code ?? arrival?.VehCode ?? arrival?.VEH_NO ?? ''
    )
    try {
      // Clicked-row first: use arrival payload before any resolver calls.
      const embeddedRouteCode = String(arrival?.resolved_route_code ?? '').trim()
      const rawRouteCode = String(arrivalRouteRaw(arrival) ?? '').trim()
      const canonRouteCode = String(canonNumish(rawRouteCode) ?? '').trim()
      let routeCode = embeddedRouteCode || rawRouteCode || canonRouteCode || null
      if (!routeCode) {
        const resolved = await resolveRouteCodeForMap(arrival, stopId)
        if (seq !== trackReqSeq.current) return
        routeCode = resolved?.routeCode ?? null
      }
      if (!routeCode) {
        setTrackedLineGeo(null)
        setTrackedBusGeo({ type: 'FeatureCollection', features: [] })
        setLiveTracking(null)
        setTrackedRouteStopsRows(null)
        setLineTrackHint(
          'Δεν ήταν δυνατή η ανάλυση αυτής της γραμμής για το χάρτη. Δοκιμάστε ξανά αργότερα.'
        )
        if (trackReqSeq.current === seq) setLineTrackBusy(false)
        return
      }

      const initialBadgeDisp = arrivalLineBadgeDisplay(arrival)
      const initialDirection = arrivalDirectionLabel(arrival)
      const initialLineId = String(arrival.line_id ?? arrival.LineID ?? '').trim()
      // Update the tracked-line HUD immediately from the clicked arrival row.
      setLiveTracking({
        routeCode,
        vehCode: vehFocus,
        lineId: initialLineId || undefined,
        lineCode: undefined,
        anchorStopId: String(stopId),
        routeVariants: [],
        lineBadgeShort: initialBadgeDisp.text,
        lineBadgeTitle: initialBadgeDisp.title,
        directionLabel: initialDirection,
      })
      setTrackedRouteStopsRows(null)

      let stopRoutes = null
      try {
        stopRoutes = await apiPost(
          `/api/routes-for-stop/${encodeURIComponent(stopId)}`
        )
      } catch {
        /* ignore */
      }
      const stopRoutesArr = Array.isArray(stopRoutes) ? stopRoutes : null

      let lineId = String(arrival.line_id ?? arrival.LineID ?? '').trim()
      if (!lineId && stopRoutesArr) {
        const match = stopRoutesArr.find(
          (r) =>
            String(r.RouteCode ?? '') === String(routeCode) ||
            (canonNumish(r.RouteCode) &&
              canonNumish(r.RouteCode) === canonNumish(routeCode))
        )
        lineId = String(match?.LineID ?? match?.LineId ?? '').trim()
      }

      const lineBadge = arrivalLineBadge(arrival)
      const badgeDisp = initialBadgeDisp

      const matchRow =
        stopRoutesArr?.find((r) =>
          routeCodesMatch(routeCodeFromRouteRow(r), routeCode)
        ) ?? null
      const internalLineCode = String(
        matchRow?.LineCode ?? matchRow?.line_code ?? ''
      ).trim()

      const mergedPromise = internalLineCode
        ? fetchMergedLineRoutes(internalLineCode).catch((e) => {
            if (import.meta.env.DEV) console.warn('[oasth] routeVariants', e)
            return []
          })
        : Promise.resolve([])

      const [merged] = await Promise.all([
        mergedPromise,
      ])
      if (seq !== trackReqSeq.current) return

      let routeVariants = buildRouteVariantsFromMergedRows(
        Array.isArray(merged) ? merged : []
      )
      if (routeVariants.length === 0 && stopRoutesArr?.length && lineId) {
        routeVariants = buildRouteVariantsFromStopRows(stopRoutesArr, lineId)
      }
      routeVariants = ensureRouteVariantForCurrent(
        routeVariants,
        routeCode,
        initialDirection
      )

      // Show core line metadata immediately while map geometry/buses load.
      setLiveTracking({
        routeCode,
        vehCode: vehFocus,
        lineId: lineId || undefined,
        lineCode: internalLineCode || undefined,
        anchorStopId: String(stopId),
        routeVariants,
        lineBadgeShort: badgeDisp.text,
        lineBadgeTitle: badgeDisp.title,
        directionLabel: initialDirection,
      })
      rememberRecentLineSelection({
        routeCode,
        lineCode: internalLineCode || undefined,
        lineId: lineId || undefined,
        lineBadgeShort: badgeDisp.text,
        lineBadgeTitle: badgeDisp.title,
        directionLabel: initialDirection,
        anchorStopId: String(stopId),
      })

      const routeCodesForMap = trackedRouteCodesForMap(
        routeCode
      )
      const trackedMap = await loadTrackedRoutesForMap(routeCodesForMap, lineBadge, {
        onlyRouteCode: routeCode,
      })
      if (seq !== trackReqSeq.current) return
      const lineGeo = trackedMap.lineGeo
      const stopsRows = trackedMap.routeStopsRows
      const busGeo = trackedMap.busGeo
      setTrackedLineGeo(
        lineGeo?.features?.length ? lineGeo : { type: 'FeatureCollection', features: [] }
      )
      setTrackedRouteStopsRows(stopsRows.length ? stopsRows : null)
      setTrackedBusGeo(busGeo)
      if (mapReady) {
        const map = mapRef.current?.getMap()
        fitMapToTrackedRouteSnapshot(map, lineGeo, stopsRows, busGeo)
      }

      if (!lineGeo?.features?.length && (!busGeo.features || busGeo.features.length === 0)) {
        setLineTrackHint(
          'Αυτή η γραμμή δεν έχει ίχνος ή ζωντανά λεωφορεία να εμφανιστούν αυτή τη στιγμή.'
        )
      }
    } catch (err) {
      if (seq !== trackReqSeq.current) return
      setTrackedLineGeo(null)
      setTrackedBusGeo(null)
      setLiveTracking(null)
      setTrackedRouteStopsRows(null)
      const m = err && typeof err.message === 'string' ? err.message : ''
      let hint =
        'Δεν ήταν δυνατή η φόρτωση της γραμμής ή των ζωντανών λεωφορείων. Εκτελείται ο διακομιστής API;'
      if (
        m.includes('Failed to fetch') ||
        m.includes('NetworkError') ||
        m.includes('Load failed')
      ) {
        hint =
          'Δεν είναι δυνατή η σύνδεση με τον διακομιστή API. Με την εφαρμογή ανάπτυξης (Vite), εκτελέστε `npm run server` από τον ριζικό φάκελο του OASTH ώστε η θύρα 3001 να είναι ενεργή και ανανεώστε.'
      } else if (m.length > 0 && m.length < 240) {
        hint = m
      }
      setLineTrackHint(hint)
      if (import.meta.env.DEV) console.error('[oasth] track line from arrival', err)
    } finally {
      popupSelectInFlightKeyRef.current = ''
      if (trackReqSeq.current === seq) setLineTrackBusy(false)
    }
  }, [loadTrackedRoutesForMap, mapReady, rememberRecentLineSelection])

  const openLineEntry = useCallback(async (entry) => {
    const routeCode = String(entry?.routeCode ?? '').trim()
    if (!routeCode) return
    rememberRecentLineSelection(entry)
    setLineTrackHint(null)
    const seq = ++trackReqSeq.current
    setLineTrackBusy(true)
    const vehFocus = ''
    const anchorStopId = String(entry.anchorStopId ?? '').trim()
    try {
      const lineId = String(entry.lineId ?? '').trim()
      const internalLineCode = String(entry.lineCode ?? '').trim()

      const mergedPromise = internalLineCode
        ? fetchMergedLineRoutes(internalLineCode).catch((e) => {
            if (import.meta.env.DEV) console.warn('[oasth] routeVariants entry', e)
            return []
          })
        : Promise.resolve([])

      const [merged] = await Promise.all([
        mergedPromise,
      ])
      if (seq !== trackReqSeq.current) return

      let routeVariants = buildRouteVariantsFromMergedRows(
        Array.isArray(merged) ? merged : []
      )
      const dirFromEntry = String(entry.directionLabel ?? '').trim()
      routeVariants = ensureRouteVariantForCurrent(
        routeVariants,
        routeCode,
        dirFromEntry
      )

      const pseudo = {
        line_id: lineId || entry.lineId,
        LineID: lineId || entry.lineId,
        route_code: entry.lineBadgeShort,
        RouteCode: routeCode,
      }
      const lineBadge = arrivalLineBadge(pseudo)
      const badgeDisp = {
        text: String(entry.lineBadgeShort ?? '').trim() || '—',
        title: entry.lineBadgeTitle || undefined,
      }

      // Show core line metadata immediately while map geometry/buses load.
      setLiveTracking({
        routeCode,
        vehCode: vehFocus,
        lineId: lineId || entry.lineId || undefined,
        lineCode: internalLineCode || undefined,
        anchorStopId: anchorStopId || undefined,
        routeVariants,
        lineBadgeShort: badgeDisp.text,
        lineBadgeTitle: badgeDisp.title,
        directionLabel:
          dirFromEntry || badgeDisp.text,
      })
      setTrackedRouteStopsRows(null)

      const routeCodesForMap = trackedRouteCodesForMap(
        routeCode
      )
      const trackedMap = await loadTrackedRoutesForMap(routeCodesForMap, lineBadge, {
        onlyRouteCode: routeCode,
      })
      if (seq !== trackReqSeq.current) return
      const lineGeo = trackedMap.lineGeo
      const stopsArr = trackedMap.routeStopsRows
      const busGeo = trackedMap.busGeo
      setTrackedLineGeo(
        lineGeo?.features?.length ? lineGeo : { type: 'FeatureCollection', features: [] }
      )
      setTrackedRouteStopsRows(stopsArr.length ? stopsArr : null)
      setTrackedBusGeo(busGeo)

      if (mapReady) {
        const map = mapRef.current?.getMap()
        fitMapToTrackedRouteSnapshot(map, lineGeo, stopsArr, busGeo)
      }

      if (!lineGeo?.features?.length && (!busGeo.features || busGeo.features.length === 0)) {
        setLineTrackHint(
          'Αυτή η γραμμή δεν έχει ίχνος ή ζωντανά λεωφορεία να εμφανιστούν αυτή τη στιγμή.'
        )
      }
    } catch (err) {
      if (seq !== trackReqSeq.current) return
      setTrackedLineGeo(null)
      setTrackedBusGeo(null)
      setLiveTracking(null)
      setTrackedRouteStopsRows(null)
      const m = err && typeof err.message === 'string' ? err.message : ''
      let hint =
        'Δεν ήταν δυνατή η φόρτωση αυτής της γραμμής. Εκτελείται ο διακομιστής API;'
      if (
        m.includes('Failed to fetch') ||
        m.includes('NetworkError') ||
        m.includes('Load failed')
      ) {
        hint =
          'Δεν είναι δυνατή η σύνδεση με τον διακομιστή API. Με την εφαρμογή ανάπτυξης (Vite), εκτελέστε `npm run server` από τον ριζικό φάκελο του OASTH ώστε η θύρα 3001 να είναι ενεργή και ανανεώστε.'
      } else if (m.length > 0 && m.length < 240) {
        hint = m
      }
      setLineTrackHint(hint)
      if (import.meta.env.DEV) console.error('[oasth] open line entry', err)
    } finally {
      if (trackReqSeq.current === seq) setLineTrackBusy(false)
    }
  }, [loadTrackedRoutesForMap, mapReady, rememberRecentLineSelection])

  const openSearchLineDirection = useCallback(
    async (row, variant) => {
      const lineCode = String(
        row?.LineCode ?? row?.line_code ?? row?.lineCode ?? ''
      ).trim()
      const routeCode = String(variant?.routeCode ?? '').trim()
      if (!lineCode || !routeCode) return
      setLineTrackHint(null)
      const lineId = String(
        row.LineID ?? row.LineIDGR ?? row.LineId ?? row.line_id ?? ''
      ).trim()
      const badgeRaw = lineId.replace(/\s+/g, ' ').trim()
      const badge = badgeRaw || routeCode
      const title = String(row.LineDescr ?? row.line_descr ?? '').trim()
      const dir = String(variant?.label ?? '').trim()
      await openLineEntry({
        routeCode,
        lineCode,
        lineId: lineId || undefined,
        lineBadgeShort: badge,
        lineBadgeTitle: title || undefined,
        directionLabel: dir,
        anchorStopId: undefined,
      })
    },
    [openLineEntry]
  )

  const openLineFromWebGetLinesRow = useCallback(
    async (row) => {
      const lineCode = String(
        row?.LineCode ?? row?.line_code ?? row?.lineCode ?? ''
      ).trim()
      if (!lineCode) return
      setLineTrackHint(null)
      let merged = []
      try {
        merged = await fetchMergedLineRoutes(lineCode)
      } catch {
        merged = []
      }
      const variants = buildRouteVariantsFromMergedRows(
        Array.isArray(merged) ? merged : []
      )
      if (variants.length === 0) {
        setLineTrackHint(
          'Δεν βρέθηκαν δρομολόγια για αυτή τη γραμμή αυτή τη στιγμή.'
        )
        return
      }
      await openSearchLineDirection(row, variants[0])
    },
    [openSearchLineDirection]
  )

  const openLineEntryForUi = useCallback(
    async (entry) => {
      await openLineEntry(entry)
      if (!isMobileViewport) return
      setMobileSheetMode('browse')
      setMobileSheetSnap('minimized')
      setMobileSheetLiveHeight(null)
    },
    [isMobileViewport, openLineEntry]
  )

  const openSearchLineDirectionForUi = useCallback(
    async (row, variant) => {
      await openSearchLineDirection(row, variant)
      if (!isMobileViewport) return
      setMobileSheetMode('browse')
      setMobileSheetSnap('minimized')
      setMobileSheetLiveHeight(null)
    },
    [isMobileViewport, openSearchLineDirection]
  )

  const openLineFromWebGetLinesRowForUi = useCallback(
    async (row) => {
      await openLineFromWebGetLinesRow(row)
      if (!isMobileViewport) return
      setMobileSheetMode('browse')
      setMobileSheetSnap('minimized')
      setMobileSheetLiveHeight(null)
    },
    [isMobileViewport, openLineFromWebGetLinesRow]
  )

  const onSelectTrackedRouteVariant = useCallback(
    async (nextRouteCode) => {
      if (!liveTracking?.routeCode || nextRouteCode == null) return
      const prevRc = String(liveTracking.routeCode).trim()
      const nextRc = String(nextRouteCode).trim()
      if (!nextRc || routeCodesMatch(prevRc, nextRc)) return
      setLineTrackHint(null)
      const seq = ++trackReqSeq.current
      setLineTrackBusy(true)
      setLineRouteVariantBusy(true)
      const lineMeta = {
        lineId: liveTracking.lineId,
        lineBadgeShort: liveTracking.lineBadgeShort,
        lineBadgeTitle: liveTracking.lineBadgeTitle,
      }
      const routeVariants = Array.isArray(liveTracking.routeVariants)
        ? liveTracking.routeVariants
        : []
      try {
        let nextRow = null
        if (liveTracking.anchorStopId) {
          try {
            const rs = await apiPost(
              `/api/routes-for-stop/${encodeURIComponent(liveTracking.anchorStopId)}`
            )
            if (Array.isArray(rs)) {
              nextRow =
                findRouteRowWithLineMeta(rs, nextRc, lineMeta) ??
                findRouteRowByCode(rs, nextRc)
            }
          } catch {
            /* ignore */
          }
        }
        if (!nextRow) {
          nextRow = await fetchRouteRowForMapDisplay(
            nextRc,
            liveTracking.anchorStopId,
            lineMeta
          )
        }
        if (seq !== trackReqSeq.current) return

        const routeCodesForMap = trackedRouteCodesForMap(
          nextRc
        )
        const pseudo = nextRow
          ? routeRowToArrivalLikeForDisplay(nextRow)
          : { LineID: liveTracking.lineId, line_id: liveTracking.lineId }
        const lineBadge = nextRow
          ? arrivalLineBadge(pseudo)
          : arrivalLineBadge({
              line_id: liveTracking.lineId,
              LineID: liveTracking.lineId,
              route_code: liveTracking.lineBadgeShort,
            })
        const trackedMap = await loadTrackedRoutesForMap(routeCodesForMap, lineBadge, {
          onlyRouteCode: nextRc,
        })
        if (seq !== trackReqSeq.current) return
        const lineGeo = trackedMap.lineGeo
        const nextStopsArr = trackedMap.routeStopsRows
        setTrackedLineGeo(
          lineGeo?.features?.length ? lineGeo : { type: 'FeatureCollection', features: [] }
        )
        setTrackedRouteStopsRows(nextStopsArr.length ? nextStopsArr : null)

        const curSel = selectedStopRef.current
        if (curSel != null) {
          const sid = String(curSel.id).trim()
          const rows = nextStopsArr ?? []
          const stopOnNewRoute =
            Boolean(sid) &&
            rows.some((r) => {
              const code = String(r.StopCode ?? r.StopID ?? '').trim()
              return code === sid
            })
          if (!stopOnNewRoute) setSelectedStop(null)
        }

        if (seq !== trackReqSeq.current) return
        const badgeDisp = nextRow
          ? arrivalLineBadgeDisplay(pseudo)
          : {
              text: liveTracking.lineBadgeShort,
              title: liveTracking.lineBadgeTitle,
            }
        const busGeo = trackedMap.busGeo
        setTrackedBusGeo(busGeo)

        const nextLineId =
          (nextRow &&
            String(nextRow.LineID ?? nextRow.LineId ?? '').trim()) ||
          String(liveTracking.lineId ?? '').trim()

        const variantLabel =
          routeVariants.find((v) => routeCodesMatch(v.routeCode, nextRc))
            ?.label ??
          (nextRow ? arrivalDirectionLabel(pseudo) : liveTracking.directionLabel)

        setLiveTracking({
          routeCode: nextRc,
          vehCode: liveTracking.vehCode,
          lineId: nextLineId || liveTracking.lineId,
          lineCode: liveTracking.lineCode,
          anchorStopId: liveTracking.anchorStopId,
          routeVariants,
          lineBadgeShort: badgeDisp.text,
          lineBadgeTitle: badgeDisp.title,
          directionLabel: variantLabel,
        })
        rememberRecentLineSelection({
          routeCode: nextRc,
          lineCode:
            String(nextRow?.LineCode ?? nextRow?.line_code ?? '').trim() ||
            String(liveTracking.lineCode ?? '').trim() ||
            undefined,
          lineId: nextLineId || liveTracking.lineId || undefined,
          lineBadgeShort: badgeDisp.text,
          lineBadgeTitle: badgeDisp.title,
          directionLabel: variantLabel,
          anchorStopId: liveTracking.anchorStopId,
        })

        if (!lineGeo?.features?.length && (!busGeo.features || busGeo.features.length === 0)) {
          setLineTrackHint(
            'Αυτή η γραμμή δεν έχει ίχνος ή ζωντανά λεωφορεία να εμφανιστούν αυτή τη στιγμή.'
          )
        }
      } catch {
        if (seq !== trackReqSeq.current) return
        setLineTrackHint(
          'Δεν ήταν δυνατή η φόρτωση αυτής της παραλλαγής δρομολογίου. Δοκιμάστε ξανά.'
        )
      } finally {
        if (trackReqSeq.current === seq) {
          setLineRouteVariantBusy(false)
          setLineTrackBusy(false)
        }
      }
    },
    [liveTracking, loadTrackedRoutesForMap, rememberRecentLineSelection]
  )

  /** Keep live bus markers in sync while a line is selected (initial load is one-shot only). */
  useEffect(() => {
    if (!liveTracking?.routeCode) return
    const routeCode = String(liveTracking.routeCode).trim()
    if (!routeCode) return
    const routeCodes = trackedRouteCodesForMap(
      routeCode
    )

    const pseudo = {
      line_id: liveTracking.lineId,
      LineID: liveTracking.lineId,
      route_code: liveTracking.lineCode,
      RouteCode: liveTracking.routeCode,
    }
    const lineBadge = arrivalLineBadge(pseudo)

    let cancelled = false
    let timerId = null
    const nextDelayMs = (lastTickMs) => {
      if (typeof document !== 'undefined' && document.hidden) return 12_000
      if (lastTickMs > 2_500) return 9_000
      return TRACKED_BUS_LOCATIONS_POLL_MS
    }
    const schedule = (lastTickMs = 0) => {
      if (cancelled) return
      timerId = setTimeout(tick, nextDelayMs(lastTickMs))
    }
    const tick = async () => {
      if (cancelled) return
      const startedAt = Date.now()
      try {
        const trackedMap = await loadTrackedRoutesForMap(routeCodes, lineBadge, {
          includeStops: false,
        })
        if (cancelled) return
        setTrackedBusGeo(trackedMap.busGeo)
      } catch {
        /* keep last positions on transient errors */
      }
      if (cancelled) return
      schedule(Date.now() - startedAt)
    }
    tick()
    return () => {
      cancelled = true
      if (timerId != null) clearTimeout(timerId)
    }
  }, [liveTracking, loadTrackedRoutesForMap])

  const handleMapMove = useCallback((e) => {
    const { longitude, latitude, zoom } = e.viewState
    setMapCamera({ longitude, latitude, zoom })
  }, [])

  const handleMapMoveEnd = useCallback((e) => {
    const { longitude, latitude, zoom } = e.viewState
    setMapCamera({ longitude, latitude, zoom })
  }, [])

  useEffect(() => {
    leftSidebarPanelRef.current = leftSidebarPanel
  }, [leftSidebarPanel])

  useEffect(() => {
    writeLeftSidebarPanel(leftSidebarPanel)
  }, [leftSidebarPanel])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`)
    const syncViewport = () => {
      setIsMobileViewport(media.matches)
      setMobileViewportHeight(readVisualViewportHeight())
    }
    syncViewport()
    media.addEventListener?.('change', syncViewport)
    media.addListener?.(syncViewport)
    window.addEventListener('resize', syncViewport)
    window.visualViewport?.addEventListener('resize', syncViewport)
    return () => {
      media.removeEventListener?.('change', syncViewport)
      media.removeListener?.(syncViewport)
      window.removeEventListener('resize', syncViewport)
      window.visualViewport?.removeEventListener('resize', syncViewport)
    }
  }, [])

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileSheetMode('browse')
      setMobileSheetSnap('minimized')
      setMobileSheetLiveHeight(null)
      setMobileStopPeekHeight(null)
      setMobileSheetBottomOffset(MOBILE_STOP_FLOATING_EDGE_GAP_PX)
      return
    }
    setLeftSidebarOpen(false)
  }, [isMobileViewport])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return undefined
    if (!isMobileViewport) {
      setMobileSheetBottomOffset(MOBILE_STOP_FLOATING_EDGE_GAP_PX)
      return undefined
    }

    let frameId = null
    const measure = () => {
      const host = mobileSheetHostRef.current
      if (!(host instanceof HTMLElement)) return
      const nextBottom = Math.max(
        MOBILE_STOP_FLOATING_EDGE_GAP_PX,
        Math.round(Number.parseFloat(window.getComputedStyle(host).bottom) || 0)
      )
      setMobileSheetBottomOffset((prev) => (prev === nextBottom ? prev : nextBottom))
    }
    const scheduleMeasure = () => {
      if (frameId != null) cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(() => {
        frameId = null
        measure()
      })
    }

    scheduleMeasure()
    window.addEventListener('resize', scheduleMeasure)
    window.visualViewport?.addEventListener('resize', scheduleMeasure)
    window.visualViewport?.addEventListener('scroll', scheduleMeasure)
    return () => {
      if (frameId != null) cancelAnimationFrame(frameId)
      window.removeEventListener('resize', scheduleMeasure)
      window.visualViewport?.removeEventListener('resize', scheduleMeasure)
      window.visualViewport?.removeEventListener('scroll', scheduleMeasure)
    }
  }, [isMobileViewport, mobileSheetMode, mobileViewportHeight, selectedStop?.id])

  useLayoutEffect(() => {
    if (!isMobileViewport) return
    const prevSelectedStopId = prevSelectedStopIdRef.current
    const nextSelectedStopId = selectedStop?.id ?? null
    if (nextSelectedStopId && nextSelectedStopId !== prevSelectedStopId) {
      setMobileLastBrowseTab(leftSidebarPanel)
      setMobileSheetMode('stop')
      setMobileSheetSnap('peek')
      setMobileSheetLiveHeight(null)
      if (!prevSelectedStopId) {
        setMobileStopPeekHeight(MOBILE_STOP_PEEK_LOADING_PX)
        setMobileStopLoading(true)
        setMobileStopOpenTransitionSuppressed(true)
        mobileStopInitialOpenPendingRef.current = true
      }
    }
    if (!nextSelectedStopId && prevSelectedStopId) {
      setMobileSheetMode('browse')
      setMobileSheetSnap('minimized')
      setMobileSheetLiveHeight(null)
      setMobileStopPeekHeight(null)
      setMobileStopOpenTransitionSuppressed(false)
      setMobileStopLoading(false)
      mobileStopInitialOpenPendingRef.current = false
      setLeftSidebarPanel((prev) =>
        LEFT_SIDEBAR_PANELS.has(mobileLastBrowseTab) ? mobileLastBrowseTab : prev
      )
    }
    prevSelectedStopIdRef.current = nextSelectedStopId
  }, [isMobileViewport, leftSidebarPanel, mobileLastBrowseTab, selectedStop])

  useEffect(() => {
    if (!mobileStopInitialOpenPendingRef.current) return undefined
    if (mobileStopLoading) return undefined
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        mobileStopInitialOpenPendingRef.current = false
        setMobileStopOpenTransitionSuppressed(false)
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [mobileStopLoading])

  useEffect(() => {
    if (!isMobileViewport || selectedStop) return
    if (LEFT_SIDEBAR_PANELS.has(leftSidebarPanel)) {
      setMobileLastBrowseTab(leftSidebarPanel)
    }
  }, [isMobileViewport, leftSidebarPanel, selectedStop])

  useEffect(() => {
    if (!leftSidebarOpen) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (leftSidebarPanelRef.current !== 'home') {
        setLeftSidebarPanel('home')
      } else {
        setLeftSidebarOpen(false)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [leftSidebarOpen])

  useEffect(() => {
    if (!navigator.geolocation) return
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setUserLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
        })
        setGeoError(null)
        setGeoPending(false)
      },
      (err) => {
        setGeoPending(false)
        if (err.code === 1) {
          setGeoError('Δεν δόθηκε άδεια πρόσβασης στην τοποθεσία')
        } else {
          setGeoError('Δεν ήταν δυνατή η εύρεση της τοποθεσίας σας')
        }
        setUserLocation(null)
      },
      { enableHighAccuracy: true, maximumAge: 12_000, timeout: 20_000 }
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  const flyToMyLocation = useCallback(() => {
    if (!userLocation || !mapRef.current) return
    const map = mapRef.current.getMap()
    if (!map) return
    locateFlyGenRef.current += 1
    const gen = locateFlyGenRef.current
    setLocateFlyHighlight(true)
    map.stop()
    map.easeTo({
      center: [userLocation.lng, userLocation.lat],
      zoom: 16,
      duration: 1150,
      essential: true,
    })
    const onMoveEnd = () => {
      if (locateFlyGenRef.current === gen) setLocateFlyHighlight(false)
    }
    map.once('moveend', onMoveEnd)
  }, [userLocation])

  useEffect(() => {
    if (!mapReady || !selectedStop) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const lat = parseFloat(selectedStop.lat)
    const lng = parseFloat(selectedStop.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return
    map.stop()
    const zoom = Math.max(map.getZoom(), STOP_FLY_ZOOM)
    map.easeTo({
      center: [lng, lat],
      zoom,
      duration: STOP_FLY_DURATION_MS,
      essential: true,
    })
  }, [selectedStop, mapReady])

  useEffect(() => {
    if (!userLocation || !mapReady || autoPannedToUserRef.current) return
    const map = mapRef.current?.getMap()
    if (!map) return
    autoPannedToUserRef.current = true
    if (selectedStop) return
    map.stop()
    map.easeTo({
      center: [userLocation.lng, userLocation.lat],
      zoom: 16,
      duration: 1150,
      essential: true,
    })
  }, [userLocation, selectedStop, mapReady])

  useEffect(() => {
    if (!pageAuthOk) return undefined
    let cancelled = false
    apiPost('/api/all-stops')
      .then((data) => {
        if (!cancelled && Array.isArray(data)) setStops(data)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    apiPost('/api/all-lines')
      .then((data) => {
        if (!cancelled) setAllLines(coerceWebGetLinesArray(data))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pageAuthOk])

  const dismissStopPopup = useCallback(() => {
    if (isMobileViewport) {
      setMobileSheetMode('browse')
      setMobileSheetSnap('minimized')
      setMobileSheetLiveHeight(null)
      setMobileStopPeekHeight(null)
      if (LEFT_SIDEBAR_PANELS.has(mobileLastBrowseTab)) {
        setLeftSidebarPanel(mobileLastBrowseTab)
      }
    }
    setSelectedStop(null)
  }, [isMobileViewport, mobileLastBrowseTab])

  const centerMapOnSelectedStop = useCallback(() => {
    const map = mapRef.current?.getMap()
    if (!map || !selectedStop) return
    const lat = parseFloat(selectedStop.lat)
    const lng = parseFloat(selectedStop.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) return
    map.stop()
    map.easeTo({
      center: [lng, lat],
      zoom: Math.max(map.getZoom(), STOP_FLY_ZOOM),
      duration: STOP_FLY_DURATION_MS,
      essential: true,
    })
  }, [selectedStop])

  const favoriteStopIds = useMemo(
    () => new Set(favoriteStopOrder),
    [favoriteStopOrder]
  )

  const toggleFavoriteStop = useCallback((stopId) => {
    const key = String(stopId)
    setFavoriteStopOrder((prev) => {
      const exists = prev.includes(key)
      const next = exists ? prev.filter((id) => id !== key) : [...prev, key]
      writeOrderedIds(LS_FAVORITE_STOPS, next)
      return next
    })
  }, [])

  const reorderFavoriteStop = useCallback((stopId, toIndex) => {
    const key = String(stopId)
    const targetIndex = Math.trunc(Number(toIndex))
    if (!Number.isFinite(targetIndex)) return
    setFavoriteStopOrder((prev) => {
      const fromIndex = prev.indexOf(key)
      if (fromIndex === -1) return prev
      const boundedIndex = Math.max(0, Math.min(prev.length - 1, targetIndex))
      const next = moveArrayItem(prev, fromIndex, boundedIndex)
      if (next === prev) return prev
      writeOrderedIds(LS_FAVORITE_STOPS, next)
      return next
    })
  }, [])

  const favoriteStopsSorted = useMemo(() => {
    const byId = new Map(stops.map((stop) => [String(stop.id), stop]))
    return favoriteStopOrder.map((id) => byId.get(id)).filter(Boolean)
  }, [stops, favoriteStopOrder])

  const openMobileBrowseTab = useCallback(
    (nextTab) => {
      if (!LEFT_SIDEBAR_PANELS.has(nextTab)) return
      setLeftSidebarPanel(nextTab)
      setMobileLastBrowseTab(nextTab)
      if (!isMobileViewport) return
      setMobileSheetMode('browse')
      setMobileSheetSnap((prev) => (prev === 'minimized' ? 'peek' : prev))
      setMobileSheetLiveHeight(null)
    },
    [isMobileViewport]
  )

  const onMobileSidebarSearchFocus = useCallback(() => {
    if (!isMobileViewport) return
    setMobileSheetMode('browse')
    setMobileSheetSnap('full')
    setMobileSheetLiveHeight(null)
  }, [isMobileViewport])

  const mobileBrowseHeaderMode = leftSidebarPanel === 'home' ? 'search' : 'title'
  const mobileBrowseHeaderTitle =
    leftSidebarPanel === 'favoriteStops'
      ? 'Αγαπημένες στάσεις'
      : leftSidebarPanel === 'allLines'
        ? 'Γραμμές'
        : ''

  const pickFavoriteStopFromSidebar = useCallback(
    (stop) => {
      const onTrackedLine = trackedRouteStopIdsRef.current.has(String(stop.id))
      if (!onTrackedLine && trackedLineActiveRef.current) {
        resetLiveLineTracking()
      }
      setSelectedStop(stop)
      const map = mapRef.current?.getMap()
      if (map) {
        map.easeTo({
          center: [parseFloat(stop.lng), parseFloat(stop.lat)],
          zoom: Math.max(map.getZoom(), 15),
          duration: 800,
        })
      }
    },
    [resetLiveLineTracking]
  )

  const trackedRouteStopsGeo = useMemo(
    () => buildTrackedRouteStopsGeoJson(trackedRouteStopsRows, selectedStop?.id),
    [trackedRouteStopsRows, selectedStop?.id]
  )

  const trackedBusesDisplayGeo = useMemo(
    () =>
      buildTrackedBusDisplayGeoJson(
        trackedBusGeo,
        trackedLineGeo,
        trackedRouteStopsRows
      ),
    [trackedBusGeo, trackedLineGeo, trackedRouteStopsRows]
  )


  /** While a line is tracked, hide bus sprites/labels at those stops so path vertices read as on the line. */
  const trackedRouteStopIdsForSymbolFilter = useMemo(() => {
    if (!trackedRouteStopsRows?.length) return null
    const ids = [
      ...new Set(
        trackedRouteStopsRows
          .map((r) => String(r.StopCode ?? r.StopID ?? '').trim())
          .filter(Boolean)
      ),
    ]
    return ids.length ? ids : null
  }, [trackedRouteStopsRows])

  /** Exclude route stop ids from sprites; avoid `in`+`literal` here — it evaluated wrong and hid all symbols in GL v3. */
  const stopsSymbolExcludeRouteFilter = useMemo(() => {
    if (!trackedRouteStopIdsForSymbolFilter?.length) return undefined
    const neqs = trackedRouteStopIdsForSymbolFilter.map((id) => [
      '!=',
      ['to-string', ['get', 'id']],
      id,
    ])
    return neqs.length === 1 ? neqs[0] : ['all', ...neqs]
  }, [trackedRouteStopIdsForSymbolFilter])

  const stopInteractiveLayerIds = useMemo(() => {
    const base = [STOPS_ICON_LAYER_ID, STOPS_LABEL_LAYER_ID]
    if (trackedRouteStopsGeo?.features?.length) {
      return [TRACKED_ROUTE_VERTICES_ID, TRACKED_ROUTE_LABELS_ID, ...base]
    }
    return base
  }, [trackedRouteStopsGeo])

  /**
   * Use `mapRef.queryRenderedFeatures` (not `e.target`) so react-map-gl swaps the
   * proxy transform before picking — otherwise hits are empty with `initialViewState`.
   */
  const queryStopFeaturesAtPoint = useCallback(
    (point) => {
      const mb = mapRef.current
      if (!mb) return []
      const map = mb.getMap()
      const layers = stopInteractiveLayerIds.filter((id) => map.getLayer(id))
      if (!layers.length) return []
      try {
        return mb.queryRenderedFeatures(point, { layers })
      } catch {
        return []
      }
    },
    [stopInteractiveLayerIds]
  )

  const onMapClick = useCallback(
    (e) => {
      const isMobileViewport =
        typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches
      const feats = queryStopFeaturesAtPoint(e.point)
      if (feats.length > 0) {
        const first = feats[0]
        const id = first.properties?.id
        const clickedRouteCode = String(first.properties?.routeCode ?? '').trim()
        const currentRouteCode = String(liveTracking?.routeCode ?? '').trim()
        if (
          clickedRouteCode &&
          currentRouteCode &&
          !routeCodesMatch(clickedRouteCode, currentRouteCode)
        ) {
          onSelectTrackedRouteVariant(clickedRouteCode)
        }
        const stop = stopsRef.current.find((s) => String(s.id) === String(id))
        if (stop) {
          const onTrackedLine = trackedRouteStopIdsRef.current.has(String(stop.id))
          if (!onTrackedLine) {
            const cur = selectedStopRef.current
            if (!cur || String(cur.id) !== String(stop.id)) {
              resetLiveLineTracking()
            }
          }
          const sameAsSelected =
            selectedStopRef.current != null &&
            String(selectedStopRef.current.id) === String(stop.id)
          if (leftSidebarOpen && isMobileViewport) {
            setLeftSidebarOpen(false)
          }
          setSelectedStop(stop)
          if (onTrackedLine && sameAsSelected) {
            setTrackedHudStopsRecenterKey((k) => k + 1)
          }
        }
        return
      }
      if (selectedStopRef.current != null) {
        dismissStopPopup()
        return
      }
      if (trackedLineActiveRef.current) {
        resetLiveLineTracking()
      }
    },
    [
      dismissStopPopup,
      liveTracking?.routeCode,
      leftSidebarOpen,
      onSelectTrackedRouteVariant,
      queryStopFeaturesAtPoint,
      resetLiveLineTracking,
    ]
  )

  const onMapMouseMove = useCallback(
    (e) => {
      lastMapPointerPointRef.current = e.point
      const canvas = mapRef.current?.getMap()?.getCanvas()
      if (!canvas) return
      if (mapCanvasPanningRef.current) {
        canvas.style.cursor = 'grabbing'
        return
      }
      const feats = queryStopFeaturesAtPoint(e.point)
      canvas.style.cursor = feats.length > 0 ? 'pointer' : 'default'
    },
    [queryStopFeaturesAtPoint]
  )

  const onMapMouseDown = useCallback(
    (e) => {
      if (e.originalEvent.button !== 0) return
      const feats = queryStopFeaturesAtPoint(e.point)
      if (feats.length > 0) return
      mapCanvasPanningRef.current = true
      const canvas = mapRef.current?.getMap()?.getCanvas()
      if (canvas) canvas.style.cursor = 'grabbing'
    },
    [queryStopFeaturesAtPoint]
  )

  const onMapMouseUp = useCallback(
    (e) => {
      mapCanvasPanningRef.current = false
      lastMapPointerPointRef.current = e.point
      const canvas = mapRef.current?.getMap()?.getCanvas()
      if (!canvas) return
      const feats = queryStopFeaturesAtPoint(e.point)
      canvas.style.cursor = feats.length > 0 ? 'pointer' : 'default'
    },
    [queryStopFeaturesAtPoint]
  )

  const onMapMouseOut = useCallback(() => {
    const canvas = mapRef.current?.getMap()?.getCanvas()
    if (!canvas) return
    if (!mapCanvasPanningRef.current) {
      canvas.style.cursor = 'default'
    }
  }, [])

  useEffect(() => {
    const onWindowMouseUp = () => {
      if (!mapCanvasPanningRef.current) return
      mapCanvasPanningRef.current = false
      const canvas = mapRef.current?.getMap()?.getCanvas()
      const pt = lastMapPointerPointRef.current
      if (!canvas || !pt) return
      const feats = queryStopFeaturesAtPoint(pt)
      canvas.style.cursor = feats.length > 0 ? 'pointer' : 'default'
    }
    window.addEventListener('mouseup', onWindowMouseUp)
    return () => window.removeEventListener('mouseup', onWindowMouseUp)
  }, [mapReady, queryStopFeaturesAtPoint])

  const stopsGeojson = useMemo(() => {
    const linePathActive = Boolean(trackedLineGeo?.features?.length)
    const sourceStops = linePathActive
      ? stops.filter((s) => favoriteStopIds.has(String(s.id)))
      : stops
    return {
      type: 'FeatureCollection',
      features: sourceStops
        .map((s) => {
          const lat = parseFloat(s.lat)
          const lng = parseFloat(s.lng)
          if (Number.isNaN(lat) || Number.isNaN(lng)) return null
          const fav = favoriteStopIds.has(String(s.id)) ? 1 : 0
          const sel =
            selectedStop != null && String(selectedStop.id) === String(s.id)
              ? 1
              : 0
          return {
            type: 'Feature',
            id: s.id,
            geometry: { type: 'Point', coordinates: [lng, lat] },
            properties: {
              id: String(s.id),
              favorite: fav,
              selected: sel,
              label: stopMapLabel(s),
            },
          }
        })
        .filter(Boolean),
    }
  }, [trackedLineGeo, stops, favoriteStopIds, selectedStop])

  /** Point only — radius is a literal paint value (data-driven `['get']` often won’t show with react-map-gl). */
  const userAccuracyGeo = useMemo(() => {
    if (!userLocation) return null
    const { lat, lng } = userLocation
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [lng, lat] },
          properties: {},
        },
      ],
    }
  }, [userLocation])

  const userAccRadiusPx = useMemo(() => {
    if (!userLocation) return 8
    const { lat, accuracyM } = userLocation
    const rM = Math.min(Math.max(accuracyM, 12), 450)
    const zoom = mapCamera?.zoom ?? 13
    const mpp = metersPerPixelAt(lat, zoom)
    if (!Number.isFinite(mpp) || mpp <= 0) return 8
    return Math.max(6, rM / mpp)
  }, [userLocation, mapCamera])

  const userDotGeo = useMemo(() => {
    if (!userLocation) return null
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [userLocation.lng, userLocation.lat] },
          properties: {},
        },
      ],
    }
  }, [userLocation])

  /** Keep user dot above every map layer (routes, buses, and basemap labels). */
  useEffect(() => {
    if (!mapReady || !userDotGeo) return undefined
    const map = mapRef.current?.getMap()
    if (!map) return undefined

    const moveUserDotToTop = () => {
      if (!map.isStyleLoaded()) return
      if (!map.getLayer('user-dot-layer')) return
      try {
        map.moveLayer('user-dot-layer')
      } catch {
        /* style reload race */
      }
    }

    moveUserDotToTop()
    map.on('styledata', moveUserDotToTop)
    return () => {
      map.off('styledata', moveUserDotToTop)
    }
  }, [mapReady, userDotGeo])

  const initialCenter = { lat: 40.6401, lng: 22.9444 }

  const mapCenteredOnUser = useMemo(() => {
    if (!userLocation || !mapCamera) return false
    if (mapCamera.zoom < LOCATE_MIN_ZOOM) return false
    return (
      distanceMeters(
        mapCamera.latitude,
        mapCamera.longitude,
        userLocation.lat,
        userLocation.lng
      ) <= LOCATE_CENTER_MAX_M
    )
  }, [userLocation, mapCamera])

  useEffect(() => {
    if (mapCenteredOnUser) setLocateFlyHighlight(false)
  }, [mapCenteredOnUser])

  const locateOnUserUi =
    mapCenteredOnUser || locateFlyHighlight
  const mobileSheetHeights = useMemo(
    () =>
      mobileSheetSnapHeights(
        mobileSheetMode,
        mobileViewportHeight,
        mobileSheetMode === 'stop' ? mobileStopPeekHeight : null,
        mobileSheetBottomOffset
      ),
    [mobileSheetBottomOffset, mobileSheetMode, mobileStopPeekHeight, mobileViewportHeight]
  )
  const settledMobileSheetHeight =
    mobileSheetHeights?.[mobileSheetSnap] ?? mobileSheetHeights?.minimized ?? 0
  const mobileSheetVisibleHeight =
    mobileSheetMode === 'stop'
      ? settledMobileSheetHeight
      : (mobileSheetLiveHeight ?? settledMobileSheetHeight)

  useLayoutEffect(() => {
    if (!isMobileViewport) return
    applyMobileSheetVisibleHeight(mobileSheetVisibleHeight)
  }, [applyMobileSheetVisibleHeight, isMobileViewport, mobileSheetVisibleHeight])

  if (pageAuthEnabled === null) {
    return <AppBootLoading label="Έλεγχος πρόσβασης…" />
  }

  if (pageAuthEnabled && !pageAuthOk) {
    return <PageAuthGate onSuccess={refreshPageAuth} />
  }

  if (loading) {
    return <AppBootLoading label="Φόρτωση χάρτη και στάσεων…" />
  }

  const showDesktopStopPanel = !isMobileViewport && selectedStop != null
  const appViewportStyle = isMobileViewport
    ? { '--mobile-sheet-visible-height': `${mobileSheetVisibleHeight}px` }
    : undefined
  const mobileSheetHostStyle = isMobileViewport
    ? mobileSheetMode === 'stop'
      ? {
          height: `${mobileSheetVisibleHeight}px`,
          transform: 'translateY(0)',
          ...(mobileSheetDragging || mobileStopOpenTransitionSuppressed
            ? { transition: 'none' }
            : {}),
        }
      : {
          height: `${mobileSheetVisibleHeight}px`,
          transform: 'translateY(0)',
          ...(mobileSheetDragging ? { transition: 'none' } : {}),
        }
    : undefined

  return (
    <div
      ref={appViewportRef}
      style={appViewportStyle}
      className={
        'app-viewport' +
        (!isMobileViewport && leftSidebarOpen ? ' app-viewport--left-sidebar-open' : '') +
        (showDesktopStopPanel ? ' app-viewport--stop-panel-open' : '') +
        (isMobileViewport ? ' app-viewport--mobile-sheet' : '') +
        (isMobileViewport && mobileSheetMode === 'stop'
          ? ' app-viewport--mobile-stop-sheet'
          : '') +
        (isMobileViewport && mobileSheetDragging
          ? ' app-viewport--mobile-sheet-dragging'
          : '') +
        (isMobileViewport &&
        mobileSheetMode === 'stop' &&
        mobileSheetSnap === 'full'
          ? ' app-viewport--mobile-stop-sheet-full'
          : '') +
        (mapBaseStyleKey === 'dark' ? ' app-viewport--map-dark' : '')
      }
    >
      {!isMobileViewport ? (
      <div
        className={
          'map-left-stack' +
          (leftSidebarOpen ? ' map-left-stack--open' : ' map-left-stack--closed')
        }
      >
        <aside
          id="map-left-sidebar"
          className="map-left-sidebar"
          aria-label="Πλαϊνό πάνελ"
          aria-hidden={!leftSidebarOpen}
        >
          {leftSidebarOpen ? (
            <>
              <div
                className={
                  'map-left-sidebar-header' +
                  (leftSidebarPanel === 'favoriteStops'
                    ? ' map-left-sidebar-header--favorite-stops'
                    : leftSidebarPanel === 'allLines'
                      ? ' map-left-sidebar-header--all-lines'
                      : '')
                }
              >
                {leftSidebarPanel === 'favoriteStops' ? (
                  <div className="map-left-sidebar-header-leading">
                    <button
                      type="button"
                      className="map-left-sidebar-back"
                      onClick={() => setLeftSidebarPanel('home')}
                      aria-label="Πίσω"
                    >
                      <ChevronLeft size={21} strokeWidth={2.25} aria-hidden />
                    </button>
                    <h1
                      className="map-left-sidebar-brand map-left-sidebar-brand--subscreen map-left-sidebar-header-favorites-heading"
                      lang="el"
                    >
                      Αγαπημένες στάσεις
                    </h1>
                  </div>
                ) : leftSidebarPanel === 'allLines' ? (
                  <div className="map-left-sidebar-header-leading">
                    <button
                      type="button"
                      className="map-left-sidebar-back"
                      onClick={() => setLeftSidebarPanel('home')}
                      aria-label="Πίσω"
                    >
                      <ChevronLeft size={21} strokeWidth={2.25} aria-hidden />
                    </button>
                    <h1
                      className="map-left-sidebar-brand map-left-sidebar-brand--subscreen map-left-sidebar-header-favorites-heading"
                      lang="el"
                    >
                      Όλες οι γραμμές
                    </h1>
                  </div>
                ) : homeSearchHeaderActive ? (
                  <div className="map-left-sidebar-header-leading">
                    <button
                      type="button"
                      className="map-left-sidebar-back"
                      onClick={() => setHomeSearchResetToken((n) => n + 1)}
                      aria-label="Πίσω"
                    >
                      <ChevronLeft size={21} strokeWidth={2.25} aria-hidden />
                    </button>
                    <h1
                      className="map-left-sidebar-brand map-left-sidebar-header-favorites-heading"
                      lang="el"
                    >
                      Αναζήτηση
                    </h1>
                  </div>
                ) : (
                  <h1 className="map-left-sidebar-brand" lang="el">
                    Λεωφορεία ΟΑΣΘ
                  </h1>
                )}
                <button
                  type="button"
                  className="map-left-sidebar-toggle map-left-sidebar-toggle--docked"
                  onClick={() => setLeftSidebarOpen(false)}
                  aria-expanded
                  aria-controls="map-left-sidebar"
                  title="Κλείσιμο πάνελ"
                  aria-label="Κλείσιμο πάνελ"
                >
                  <PanelLeft size={16} strokeWidth={2.5} aria-hidden />
                </button>
              </div>
              <div className="map-left-sidebar-body">
                <MapLeftSidebar
                  panelView={leftSidebarPanel}
                  onPanelViewChange={setLeftSidebarPanel}
                  favoriteStopsSorted={favoriteStopsSorted}
                  onPickFavoriteStop={pickFavoriteStopFromSidebar}
                  onRemoveFavoriteStop={toggleFavoriteStop}
                  onReorderFavoriteStop={reorderFavoriteStop}
                  recentLines={recentLines}
                  onPickLineEntry={openLineEntryForUi}
                  favoriteStopIds={favoriteStopIds}
                  onToggleFavoriteStopSearch={toggleFavoriteStop}
                  searchStops={stops}
                  searchLines={allLines}
                  onSearchPickLine={openLineFromWebGetLinesRowForUi}
                  onSearchPickLineDirection={openSearchLineDirectionForUi}
                  apiPost={apiPost}
                  homeSearchResetToken={homeSearchResetToken}
                  onHomeSearchActiveChange={setHomeSearchHeaderActive}
                  currentTrackedRouteCode={String(liveTracking?.routeCode ?? '').trim()}
                />
              </div>
            </>
          ) : null}
        </aside>
        {leftSidebarOpen ? (
          <button
            type="button"
            className="map-left-sidebar-backdrop"
            onClick={() => setLeftSidebarOpen(false)}
            aria-label="Κλείσιμο πάνελ"
            tabIndex={-1}
          />
        ) : null}
        {!leftSidebarOpen ? (
          <button
            type="button"
            className="map-left-sidebar-toggle"
            onClick={() => setLeftSidebarOpen(true)}
            aria-expanded={false}
            aria-controls="map-left-sidebar"
            title="Άνοιγμα πάνελ"
            aria-label="Άνοιγμα πάνελ"
          >
            <PanelLeft size={20} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
      ) : null}
      {MAPBOX_TOKEN ? (
        <MapGL
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          mapStyle={mapStyleUrl}
          initialViewState={{
            longitude: initialCenter.lng,
            latitude: initialCenter.lat,
            zoom: 13,
          }}
          style={{ width: '100%', height: '100%' }}
          className="map-container"
          interactiveLayerIds={stopInteractiveLayerIds}
          onClick={onMapClick}
          onMouseMove={onMapMouseMove}
          onMouseDown={onMapMouseDown}
          onMouseUp={onMapMouseUp}
          onMouseOut={onMapMouseOut}
          onLoad={handleMapLoad}
          onMove={handleMapMove}
          onMoveEnd={handleMapMoveEnd}
        >
          {userAccuracyGeo && (
            <Source id="user-acc" type="geojson" data={userAccuracyGeo}>
              <Layer
                id="user-acc-circle"
                type="circle"
                paint={{
                  'circle-radius': userAccRadiusPx,
                  'circle-color': '#007aff',
                  'circle-opacity': 0.14,
                  'circle-stroke-width': 1.25,
                  'circle-stroke-color': '#007aff',
                  'circle-stroke-opacity': 0.35,
                  'circle-pitch-alignment': 'map',
                }}
              />
            </Source>
          )}
          {stopsGeojson.features.length > 0 && (
            <Source id="stops" type="geojson" data={stopsGeojson}>
              <Layer
                id={STOPS_ICON_LAYER_ID}
                type="symbol"
                {...(stopsSymbolExcludeRouteFilter
                  ? { filter: stopsSymbolExcludeRouteFilter }
                  : {})}
                beforeId={stopsBeforeLayerId || undefined}
                layout={{
                  'icon-image': [
                    'case',
                    ['all', favoriteStopMapIconReady, ['==', ['get', 'favorite'], 1]],
                    STOPS_FAVORITE_MAP_ICON_ID,
                    STOPS_MAP_ICON_IMAGE,
                  ],
                  'icon-size': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    [
                      'case',
                      ['==', ['get', 'favorite'], 1],
                      STOPS_ICON_SIZE_FAVORITE * STOPS_SELECTION_SCALE,
                      STOPS_ICON_SIZE * STOPS_SELECTION_SCALE,
                    ],
                    [
                      'case',
                      ['==', ['get', 'favorite'], 1],
                      STOPS_ICON_SIZE_FAVORITE,
                      STOPS_ICON_SIZE,
                    ],
                  ],
                  'icon-allow-overlap': true,
                  'icon-ignore-placement': false,
                  'icon-padding': 0,
                  'symbol-placement': 'point',
                  'symbol-sort-key': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_SYMBOL_SORT_SELECTED,
                    [
                      'case',
                      ['==', ['get', 'favorite'], 1],
                      STOPS_SYMBOL_SORT_FAVORITE,
                      0,
                    ],
                  ],
                }}
              />
              <Layer
                id={STOPS_LABEL_LAYER_ID}
                type="symbol"
                {...(stopsSymbolExcludeRouteFilter
                  ? { filter: stopsSymbolExcludeRouteFilter }
                  : {})}
                minzoom={STOPS_LABEL_MIN_ZOOM}
                beforeId={stopsBeforeLayerId || undefined}
                layout={{
                  'text-field': ['get', 'label'],
                  'text-size': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_SIZE * STOPS_SELECTION_SCALE,
                    STOPS_LABEL_SIZE,
                  ],
                  'symbol-placement': 'point',
                  'text-anchor': 'top',
                  'text-offset': ['literal', [0, STOPS_LABEL_OFFSET_Y]],
                  'text-justify': 'center',
                  'text-max-width': STOPS_LABEL_TEXT_MAX_WIDTH,
                  'text-line-height': 1.15,
                  'text-padding': 1.75,
                  'text-allow-overlap': false,
                  'text-ignore-placement': false,
                  'text-font': STOPS_MAP_LABEL_FONTS,
                  'symbol-sort-key': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_SORT_SELECTED_FIRST,
                    [
                      'case',
                      ['==', ['get', 'favorite'], 1],
                      STOPS_SYMBOL_SORT_FAVORITE,
                      0,
                    ],
                  ],
                }}
                paint={{
                  'text-color': stopVertexMapLabelPaint.textColor,
                  'text-halo-color': stopVertexMapLabelPaint.haloColor,
                  'text-halo-width': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_HALO_WIDTH * STOPS_SELECTION_SCALE,
                    STOPS_LABEL_HALO_WIDTH,
                  ],
                  'text-halo-blur': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_HALO_BLUR * STOPS_SELECTION_SCALE,
                    STOPS_LABEL_HALO_BLUR,
                  ],
                  'text-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    STOPS_LABEL_MIN_ZOOM,
                    0.72,
                    STOPS_LABEL_MIN_ZOOM + 0.5,
                    0.9,
                    STOPS_LABEL_MIN_ZOOM + 1.25,
                    1,
                  ],
                }}
              />
            </Source>
          )}
          <Source id="tracked-route" type="geojson" data={trackedLineGeo?.features?.length ? trackedLineGeo : EMPTY_GEOJSON_FC}>
              <Layer
                id={TRACKED_ROUTE_LINE_CORE_ID}
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': [
                    'coalesce',
                    ['get', 'routeColor'],
                    TRACKED_ROUTE_PRIMARY_COLOR,
                  ],
                  'line-width': 2.5,
                }}
              />
          </Source>
          <Source id="tracked-route-vertices-source" type="geojson" data={trackedRouteStopsGeo?.features?.length ? trackedRouteStopsGeo : EMPTY_GEOJSON_FC}>
              <Layer
                id={TRACKED_ROUTE_VERTICES_ID}
                type="circle"
                paint={{
                  'circle-radius': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    6,
                    4,
                  ],
                  'circle-color': [
                    'case',
                    ['==', ['get', 'isRouteStart'], 1],
                    '#34c759',
                    ['==', ['get', 'isRouteEnd'], 1],
                    '#ff3b30',
                    ['coalesce', ['get', 'routeColor'], TRACKED_ROUTE_PRIMARY_COLOR],
                  ],
                  'circle-stroke-width': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    1.8,
                    1.4,
                  ],
                  'circle-stroke-color': '#ffffff',
                  'circle-opacity': 1,
                  'circle-pitch-alignment': 'map',
                }}
              />
              <Layer
                id={TRACKED_ROUTE_LABELS_ID}
                type="symbol"
                minzoom={13}
                layout={{
                  'text-field': ['get', 'label'],
                  'text-size': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_SIZE * STOPS_SELECTION_SCALE,
                    STOPS_LABEL_SIZE,
                  ],
                  'symbol-placement': 'point',
                  'text-anchor': 'top',
                  'text-offset': [
                    'literal',
                    [0, TRACKED_ROUTE_LABEL_OFFSET_Y],
                  ],
                  'text-justify': 'center',
                  'text-max-width': STOPS_LABEL_TEXT_MAX_WIDTH,
                  'text-line-height': 1.15,
                  'text-padding': 1.75,
                  'text-allow-overlap': false,
                  'text-ignore-placement': false,
                  'text-font': ROUTE_PATH_STOP_LABEL_FONTS,
                  'symbol-sort-key': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_SORT_SELECTED_FIRST,
                    0,
                  ],
                }}
                paint={{
                  'text-color': stopVertexMapLabelPaint.textColor,
                  'text-halo-color': stopVertexMapLabelPaint.haloColor,
                  'text-halo-width': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_HALO_WIDTH * STOPS_SELECTION_SCALE,
                    STOPS_LABEL_HALO_WIDTH,
                  ],
                  'text-halo-blur': [
                    'case',
                    ['==', ['get', 'selected'], 1],
                    STOPS_LABEL_HALO_BLUR * STOPS_SELECTION_SCALE,
                    STOPS_LABEL_HALO_BLUR,
                  ],
                  'text-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    13,
                    0.72,
                    13.5,
                    0.9,
                    14.25,
                    1,
                  ],
                }}
              />
          </Source>
          <Source id="tracked-buses" type="geojson" data={trackedBusesDisplayGeo?.features?.length ? trackedBusesDisplayGeo : EMPTY_GEOJSON_FC}>
              <Layer
                id="tracked-bus-border"
                type="circle"
                filter={['==', ['get', 'busKind'], 'bus']}
                layout={{
                  'circle-sort-key': [
                    'case',
                    [
                      '==',
                      ['to-string', ['get', 'routeCode']],
                      String(liveTracking?.routeCode ?? ''),
                    ],
                    2,
                    1,
                  ],
                }}
                paint={{
                  'circle-radius': TRACKED_BUS_DOT_BORDER_RADIUS,
                  'circle-color': '#ffffff',
                  'circle-opacity': 1,
                  'circle-pitch-alignment': 'map',
                }}
              />
              <Layer
                id={TRACKED_BUS_ARROW_LAYER_ID}
                type="symbol"
                filter={['==', ['get', 'busKind'], 'arrow']}
                layout={{
                  visibility: liveBusArrowReady ? 'visible' : 'none',
                  'icon-image': TRACKED_BUS_ARROW_ICON_ID,
                  'icon-size': TRACKED_BUS_ARROW_ICON_SIZE,
                  'icon-offset': [0, 0.82],
                  'icon-allow-overlap': true,
                  'icon-ignore-placement': true,
                  'icon-rotate': ['-', ['get', 'bearing'], 90],
                  'icon-rotation-alignment': 'map',
                  'icon-pitch-alignment': 'map',
                  'symbol-placement': 'point',
                  'symbol-sort-key': 10,
                }}
                paint={{}}
              />
              <Layer
                id={TRACKED_BUS_ICON_LAYER_ID}
                type="circle"
                filter={['==', ['get', 'busKind'], 'bus']}
                layout={{
                  'circle-sort-key': [
                    'case',
                    [
                      '==',
                      ['to-string', ['get', 'routeCode']],
                      String(liveTracking?.routeCode ?? ''),
                    ],
                    2,
                    1,
                  ],
                }}
                paint={{
                  'circle-radius': TRACKED_BUS_DOT_RADIUS,
                  'circle-color': [
                    'coalesce',
                    ['get', 'routeColor'],
                    TRACKED_ROUTE_PRIMARY_COLOR,
                  ],
                  'circle-opacity': 1,
                  'circle-pitch-alignment': 'map',
                }}
              />
              <Layer
                id={TRACKED_BUS_LINE_LABEL_LAYER_ID}
                type="symbol"
                filter={[
                  'all',
                  ['==', ['get', 'busKind'], 'bus'],
                  ['>', ['length', ['to-string', ['get', 'lineLabel']]], 0],
                ]}
                layout={{
                  'text-field': ['to-string', ['get', 'lineLabel']],
                  'text-size': TRACKED_BUS_LINE_TEXT_SIZE,
                  'symbol-placement': 'point',
                  'text-anchor': 'center',
                  'text-justify': 'center',
                  'text-max-width': 1,
                  'text-line-height': 1,
                  'text-padding': 0,
                  'text-allow-overlap': true,
                  'text-ignore-placement': true,
                  'text-font': TRACKED_BUS_LINE_LABEL_FONTS,
                  'symbol-sort-key': [
                    'case',
                    [
                      '==',
                      ['to-string', ['get', 'routeCode']],
                      String(liveTracking?.routeCode ?? ''),
                    ],
                    2,
                    1,
                  ],
                }}
                paint={{
                  'text-color': '#ffffff',
                  'text-halo-color': 'rgba(0, 0, 0, 0)',
                  'text-halo-width': 0,
                  'text-halo-blur': 0,
                }}
              />
              <Layer
                id="tracked-bus-border-selected-top"
                type="circle"
                filter={[
                  'all',
                  ['==', ['get', 'busKind'], 'bus'],
                  [
                    '==',
                    ['to-string', ['get', 'routeCode']],
                    String(liveTracking?.routeCode ?? ''),
                  ],
                ]}
                paint={{
                  'circle-radius': TRACKED_BUS_DOT_BORDER_RADIUS,
                  'circle-color': '#ffffff',
                  'circle-opacity': 1,
                  'circle-pitch-alignment': 'map',
                }}
              />
              <Layer
                id="tracked-bus-icon-selected-top"
                type="circle"
                filter={[
                  'all',
                  ['==', ['get', 'busKind'], 'bus'],
                  [
                    '==',
                    ['to-string', ['get', 'routeCode']],
                    String(liveTracking?.routeCode ?? ''),
                  ],
                ]}
                paint={{
                  'circle-radius': TRACKED_BUS_DOT_RADIUS,
                  'circle-color': [
                    'coalesce',
                    ['get', 'routeColor'],
                    TRACKED_ROUTE_PRIMARY_COLOR,
                  ],
                  'circle-opacity': 1,
                  'circle-pitch-alignment': 'map',
                }}
              />
              <Layer
                id="tracked-bus-line-label-selected-top"
                type="symbol"
                filter={[
                  'all',
                  ['==', ['get', 'busKind'], 'bus'],
                  ['>', ['length', ['to-string', ['get', 'lineLabel']]], 0],
                  [
                    '==',
                    ['to-string', ['get', 'routeCode']],
                    String(liveTracking?.routeCode ?? ''),
                  ],
                ]}
                layout={{
                  'text-field': ['to-string', ['get', 'lineLabel']],
                  'text-size': TRACKED_BUS_LINE_TEXT_SIZE,
                  'symbol-placement': 'point',
                  'text-anchor': 'center',
                  'text-justify': 'center',
                  'text-max-width': 1,
                  'text-line-height': 1,
                  'text-padding': 0,
                  'text-allow-overlap': true,
                  'text-ignore-placement': true,
                  'text-font': TRACKED_BUS_LINE_LABEL_FONTS,
                  'symbol-sort-key': 3,
                }}
                paint={{
                  'text-color': '#ffffff',
                  'text-halo-color': 'rgba(0, 0, 0, 0)',
                  'text-halo-width': 0,
                  'text-halo-blur': 0,
                }}
              />
          </Source>
          {userDotGeo && (
            <Source id="user-dot" type="geojson" data={userDotGeo}>
              <Layer
                id="user-dot-layer"
                type="circle"
                paint={{
                  'circle-radius': USER_DOT_CORE_RADIUS,
                  'circle-color': '#007aff',
                  'circle-stroke-width': USER_DOT_STROKE_WIDTH,
                  'circle-stroke-color': '#ffffff',
                  'circle-pitch-alignment': 'map',
                }}
              />
            </Source>
          )}
        </MapGL>
      ) : (
        <div className="map-container map-missing-token" lang="el">
          <p>
            Προσθέστε το <code>VITE_MAPBOX_ACCESS_TOKEN</code> στο αρχείο{' '}
            <code>.env</code> (δημόσιο token <code>pk.</code> από το{' '}
            <a
              href="https://account.mapbox.com/access-tokens/"
              target="_blank"
              rel="noreferrer"
            >
              mapbox.com
            </a>
            ). Δείτε το <code>.env.example</code>.
          </p>
        </div>
      )}

      {isMobileViewport ? (
        <div
          ref={mobileSheetHostRef}
          className="mobile-sheet-host"
          data-testid="mobile-sheet"
          data-sheet-mode={mobileSheetMode}
          data-sheet-snap={mobileSheetSnap}
          style={mobileSheetHostStyle}
        >
          {mobileSheetMode === 'stop' && selectedStop ? (
            <StopMapPopup
              stop={selectedStop}
              onClose={dismissStopPopup}
              isFavorite={favoriteStopIds.has(String(selectedStop.id))}
              onToggleFavorite={() => toggleFavoriteStop(selectedStop.id)}
              onSelectArrival={onSelectArrivalFromPopup}
              onCenterOnMap={centerMapOnSelectedStop}
              activeRouteCode={String(liveTracking?.routeCode ?? '').trim()}
              mobileSheet
              mobileSheetSnap={mobileSheetSnap}
              mobileSheetHeights={mobileSheetHeights}
              visibleHeight={settledMobileSheetHeight}
              onMobileSheetSnapChange={setMobileSheetSnap}
              onMobileSheetLiveHeightChange={handleMobileStopSheetLiveHeightChange}
              onMobileSheetDragStateChange={setMobileSheetDragging}
              onMobileSheetPeekHeightChange={setMobileStopPeekHeight}
              onLoadingStateChange={setMobileStopLoading}
            />
          ) : (
            <MobileBrowseSheet
              snap={mobileSheetSnap}
              sheetHeights={mobileSheetHeights}
              visibleHeight={mobileSheetVisibleHeight}
              onSnapChange={setMobileSheetSnap}
              onLiveHeightChange={handleMobileSheetLiveHeightChange}
              onDragStateChange={setMobileSheetDragging}
              headerMode={mobileBrowseHeaderMode}
              headerTitle={mobileBrowseHeaderTitle}
              onHeaderBack={() => openMobileBrowseTab('home')}
              searchValue={mobileBrowseSearchQuery}
              onSearchChange={setMobileBrowseSearchQuery}
              onSearchFocus={onMobileSidebarSearchFocus}
              searchInputRef={homeSearchInputRef}
              bodyClassName={
                leftSidebarPanel === 'favoriteStops'
                  ? 'mobile-sheet-body--favorite-stops'
                  : leftSidebarPanel === 'allLines'
                    ? 'mobile-sheet-body--all-lines'
                  : ''
              }
            >
              <MapLeftSidebar
                panelView={leftSidebarPanel}
                onPanelViewChange={openMobileBrowseTab}
                favoriteStopsSorted={favoriteStopsSorted}
                onPickFavoriteStop={pickFavoriteStopFromSidebar}
                onRemoveFavoriteStop={toggleFavoriteStop}
                onReorderFavoriteStop={reorderFavoriteStop}
                recentLines={recentLines}
                onPickLineEntry={openLineEntryForUi}
                favoriteStopIds={favoriteStopIds}
                onToggleFavoriteStopSearch={toggleFavoriteStop}
                searchStops={stops}
                searchLines={allLines}
                onSearchPickLine={openLineFromWebGetLinesRowForUi}
                onSearchPickLineDirection={openSearchLineDirectionForUi}
                apiPost={apiPost}
                homeSearchResetToken={homeSearchResetToken}
                onHomeSearchActiveChange={setHomeSearchHeaderActive}
                currentTrackedRouteCode={String(liveTracking?.routeCode ?? '').trim()}
                mobileUnified
                onAnySearchFocus={onMobileSidebarSearchFocus}
                homeSearchQuery={mobileBrowseSearchQuery}
                onHomeSearchQueryChange={setMobileBrowseSearchQuery}
                homeSearchInputRef={homeSearchInputRef}
                allLinesSearchInputRef={allLinesSearchInputRef}
              />
            </MobileBrowseSheet>
          )}
        </div>
      ) : null}

      {showDesktopStopPanel && (
        <div className="map-right-stack">
          {selectedStop ? (
            <div className="map-right-stack-stop-panel">
              <StopMapPopup
                stop={selectedStop}
                onClose={dismissStopPopup}
                isFavorite={favoriteStopIds.has(String(selectedStop.id))}
                onToggleFavorite={() => toggleFavoriteStop(selectedStop.id)}
                onSelectArrival={onSelectArrivalFromPopup}
                onCenterOnMap={centerMapOnSelectedStop}
                activeRouteCode={String(liveTracking?.routeCode ?? '').trim()}
              />
            </div>
          ) : null}
        </div>
      )}
      {MAPBOX_TOKEN ? (
        <div className="map-bottom-left-controls">
          {typeof navigator !== 'undefined' && navigator.geolocation ? (
            <button
              type="button"
              className={`locate-me-btn${geoPending ? ' locate-me-pending' : ''}${userLocation && !geoPending ? ' locate-me-btn--geo-ok' : ''}${locateOnUserUi ? ' locate-me-btn--on-user' : ''}`}
              onClick={flyToMyLocation}
              disabled={!userLocation || geoPending}
              title={
                geoPending
                  ? 'Εύρεση τοποθεσίας…'
                  : geoError ||
                    (locateFlyHighlight
                      ? 'Κεντράρισμα χάρτη στην τοποθεσία σας…'
                      : mapCenteredOnUser
                        ? 'Ο χάρτης είναι κεντραρισμένος στην τοποθεσία σας'
                        : 'Κεντράρισμα χάρτη στην τοποθεσία σας')
              }
              aria-label={
                locateOnUserUi
                  ? 'Ο χάρτης είναι κεντραρισμένος στην τοποθεσία σας'
                  : 'Κεντράρισμα χάρτη στην τοποθεσία σας'
              }
              aria-pressed={locateOnUserUi}
            >
              <LocationArrowIcon filled={locateOnUserUi} />
            </button>
          ) : null}
          <button
            type="button"
            className="map-style-cycle-btn"
            onClick={cycleMapBaseStyle}
            title={`${MAP_BASE_STYLE_UI[mapBaseStyleKey].title} — ${MAP_BASE_STYLE_UI[mapBaseStyleKey].nextHint}`}
            aria-label={`${MAP_BASE_STYLE_UI[mapBaseStyleKey].title}. ${MAP_BASE_STYLE_UI[mapBaseStyleKey].nextHint}`}
          >
            <MapBaseStyleIcon mode={mapBaseStyleKey} />
          </button>
        </div>
      ) : null}
    </div>
  )
}
