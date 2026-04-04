/**
 * Shared arrival-row dedupe for proxy + client. OASTH sometimes returns duplicates;
 * keys can also differ only by formatting (e.g. 258 vs "0258").
 */
export function canonNumish(v) {
  if (v == null || v === '') return '';
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

function arrivalDedupeKey(row) {
  return [
    canonNumish(row?.route_code),
    canonNumish(row?.veh_code),
    canonNumish(row?.btime2),
  ].join('\0');
}

export function dedupeStopArrivals(data) {
  if (!Array.isArray(data)) return data;
  const seen = new Set();
  const out = [];
  for (const row of data) {
    const key = arrivalDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
