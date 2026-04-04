import { canonNumish } from './dedupe.js';

/**
 * LineID keys as in webRoutesForStop (e.g. "72", "Α21"). Pure numbers normalized like dedupe.
 */
function normalizeLineIdKey(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function metaFromRow(row) {
  const rd =
    row.RouteDescr ??
    row.route_descr ??
    row.LineDescr ??
    row.line_descr;
  const rde = row.RouteDescrEng ?? row.route_descr_eng ?? row.LineDescrEng ?? row.line_descr_eng;
  const lineId = row.LineID ?? row.LineId ?? row.line_id;
  return {
    route_descr: rd != null ? String(rd).trim() : '',
    route_descr_eng: rde != null ? String(rde).trim() : '',
    line_id:
      lineId != null && String(lineId).trim() !== ''
        ? String(lineId).trim()
        : '',
  };
}

function mergeMetaList(arr) {
  const descrs = [...new Set(arr.map((m) => m.route_descr).filter(Boolean))];
  const engs = [...new Set(arr.map((m) => m.route_descr_eng).filter(Boolean))];
  const line_id = arr.find((m) => m.line_id)?.line_id ?? '';
  if (descrs.length <= 1 && engs.length <= 1) {
    return {
      route_descr: descrs[0] ?? '',
      route_descr_eng: engs[0] ?? '',
      line_id,
    };
  }
  return {
    route_descr: descrs.join(' · '),
    route_descr_eng: engs.join(' · '),
    line_id,
  };
}

function pushGroup(groups, key, meta) {
  if (!key) return;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(meta);
}

function groupsToMap(groups) {
  const m = new Map();
  for (const [k, arr] of groups) m.set(k, mergeMetaList(arr));
  return m;
}

/** Value OASTH puts on getStopArrivals (usually published line / LineID). */
function arrivalRouteKey(row) {
  const v =
    row?.route_code ?? row?.RouteCode ?? row?.line_code ?? row?.LineCode;
  if (v == null || v === '') return '';
  return v;
}

/**
 * Indexes for webRoutesForStop rows. getStopArrivals.route_code is almost always LineID
 * (often zero-padded: "05"). Match LineID before RouteCode so a small RouteCode id never
 * masks the real line with an empty descr.
 */
export function buildStopRouteIndexes(stopRoutesData) {
  const byRouteCode = new Map();
  const lineIdGroups = new Map();
  const lineCodeGroups = new Map();
  const masterLineGroups = new Map();
  if (!Array.isArray(stopRoutesData)) {
    return {
      byRouteCode,
      byLineId: new Map(),
      byLineCode: new Map(),
      byMasterLine: new Map(),
    };
  }

  for (const row of stopRoutesData) {
    const meta = metaFromRow(row);

    const rck = canonNumish(row.RouteCode ?? row.route_code);
    if (rck && !byRouteCode.has(rck)) byRouteCode.set(rck, meta);

    pushGroup(lineIdGroups, normalizeLineIdKey(row.LineID ?? row.LineId ?? row.line_id), meta);
    pushGroup(lineCodeGroups, canonNumish(row.LineCode ?? row.line_code), meta);
    pushGroup(
      masterLineGroups,
      canonNumish(row.MasterLineCode ?? row.master_line_code),
      meta
    );
  }

  return {
    byRouteCode,
    byLineId: groupsToMap(lineIdGroups),
    byLineCode: groupsToMap(lineCodeGroups),
    byMasterLine: groupsToMap(masterLineGroups),
  };
}

export function lookupArrivalMeta(row, ix) {
  const raw = arrivalRouteKey(row);
  if (raw === '') return null;

  const lid = normalizeLineIdKey(raw);
  if (lid && ix.byLineId.has(lid)) return ix.byLineId.get(lid);

  const num = canonNumish(raw);
  if (num && ix.byLineCode.has(num)) return ix.byLineCode.get(num);
  if (num && ix.byMasterLine.has(num)) return ix.byMasterLine.get(num);
  if (num && ix.byRouteCode.has(num)) return ix.byRouteCode.get(num);

  return null;
}

function descrNorm(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Internal OASTH RouteCode for map geometry / getBusLocation — not the published line number.
 * getStopArrivals.route_code is usually LineID (e.g. "27"); webGetStops needs RouteCode ("166").
 */
export function resolveArrivalRouteCode(row, stopRoutesData) {
  if (!Array.isArray(stopRoutesData) || stopRoutesData.length === 0) return null;

  const raw = String(row?.route_code ?? row?.RouteCode ?? '').trim();
  const lineId = String(row?.line_id ?? row?.LineID ?? '').trim();
  const rawCanon = canonNumish(raw);
  const lineCanon = lineId ? canonNumish(lineId) : '';
  const arrDescr = descrNorm(
    row?.route_descr ?? row?.RouteDescr ?? row?.route_descr_eng ?? ''
  );

  let best = null;
  let bestScore = -1;
  for (const r of stopRoutesData) {
    let score = 0;
    if (String(r.RouteCode ?? '') === raw) score += 8;
    if (canonNumish(r.RouteCode) === rawCanon) score += 8;
    const rid = String(r.LineID ?? '').trim();
    if (rid === raw) score += 7;
    if (normalizeLineIdKey(rid) === normalizeLineIdKey(raw)) score += 7;
    if (lineId && rid === lineId) score += 9;
    if (lineCanon && canonNumish(r.LineID) === lineCanon) score += 9;
    if (lineCanon && canonNumish(r.LineCode) === lineCanon) score += 8;
    if (lineCanon && canonNumish(r.MasterLineCode) === lineCanon) score += 4;
    if (arrDescr && descrNorm(r.RouteDescr ?? '') === arrDescr) score += 12;
    if (arrDescr && descrNorm(r.RouteDescrEng ?? '') === descrNorm(row?.route_descr_eng ?? '')) {
      score += 10;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (bestScore > 0 && best) return String(best.RouteCode);
  return null;
}

/**
 * Merge RouteDescr / LineID from webRoutesForStop. (getRouteName returns null on OASTH.)
 */
export async function enrichStopArrivals(rows, stopCode, oasthPost) {
  if (!Array.isArray(rows)) return rows;

  const enc = encodeURIComponent(stopCode);
  let stopRoutesData = [];
  try {
    const routesRes = await oasthPost(`webRoutesForStop&p1=${enc}`);
    if (Array.isArray(routesRes.data)) stopRoutesData = routesRes.data;
  } catch {
    /* ignore */
  }

  const indexes = buildStopRouteIndexes(stopRoutesData);
  return rows.map((row) => {
    const next = { ...row };
    const meta = lookupArrivalMeta(row, indexes);
    if (meta) {
      if (meta.route_descr) next.route_descr = meta.route_descr;
      if (meta.route_descr_eng) next.route_descr_eng = meta.route_descr_eng;
      if (meta.line_id) next.line_id = meta.line_id;
    }
    const routeForMap = resolveArrivalRouteCode(next, stopRoutesData);
    if (routeForMap) next.resolved_route_code = routeForMap;
    return next;
  });
}
