// Bulk data loaders for map tools. Unlike research tools, these are called by the browser-side map
// tools directly and return JSON for the map rather than text for the model, so large datasets
// (elevation grids, GeoJSON features) never pass through the model's context.

import { safeGet } from './net.js';

type Args = Record<string, unknown>;

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 20) cache.delete(cache.keys().next().value!);
  return value;
}

const MAX_BYTES_HINT = 8 * 1024 * 1024;

// ---- elevation -------------------------------------------------------------------

// ETOPO 2022-derived 1 arc-minute relief (land elevation and ocean depth, metres) served by NOAA's
// ERDDAP, which can subsample on the server: stride n = every n-th arc-minute.
const ETOPO = 'https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.csv';
const MAX_SAMPLES = 60_000;

async function etopo(s: number, n: number, w: number, e: number, stride: number) {
  const url = `${ETOPO}?altitude%5B(${s}):${stride}:(${n})%5D%5B(${w}):${stride}:(${e})%5D`;
  const doc = await safeGet(url, { timeoutMs: 60000 });
  if (doc.status >= 400) throw new Error(`Elevation service error ${doc.status}: ${doc.body.slice(0, 300)}`);
  // latitude,longitude,altitude + a units row, then one row per sample
  return doc.body
    .split('\n')
    .slice(2)
    .map((l) => l.split(',').map(Number))
    .filter((r) => r.length === 3 && r.every(Number.isFinite));
}

async function elevationGrid(args: Args) {
  const b = Array.isArray(args.bbox) ? args.bbox.map(Number) : [-180, -90, 180, 90];
  if (b.length !== 4 || !b.every(Number.isFinite)) throw new Error('bbox must be [west, south, east, north]');
  let [w, s, e, n] = b;
  s = Math.max(-90, Math.min(s, n));
  n = Math.min(90, Math.max(s, n));
  const width = (e <= w ? e + 360 : e) - w;
  const auto = Math.max(Math.sqrt((width * (n - s)) / MAX_SAMPLES), 1 / 60);
  const want = typeof args.resolution === 'number' && args.resolution > 0 ? args.resolution : auto;
  const stride = Math.max(1, Math.round(Math.max(want, auto) * 60));
  const step = stride / 60;
  return cached(`etopo:${w},${s},${e},${n},${stride}`, async () => {
    const rows =
      e > w
        ? await etopo(s, n, w, e, stride)
        : [...(await etopo(s, n, w, 180, stride)), ...(await etopo(s, n, -180, e, stride)).map(([la, lo, v]) => [la, lo + 360, v])];
    const lats = [...new Set(rows.map((r) => r[0]))].sort((a, b) => b - a);
    const lons = [...new Set(rows.map((r) => r[1]))].sort((a, b) => a - b);
    const li = new Map(lats.map((v, i) => [v, i]));
    const lj = new Map(lons.map((v, i) => [v, i]));
    const values: (number | null)[][] = lats.map(() => lons.map(() => null));
    for (const [la, lo, v] of rows) values[li.get(la)!][lj.get(lo)!] = Math.round(v);
    return { lats, lons, values, resolution: step, origin: 'ETOPO 2022 (NOAA NCEI) via ERDDAP' };
  });
}

// ---- GeoJSON ---------------------------------------------------------------------------

interface Feature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates?: unknown; geometries?: unknown[] } | null;
}

const round3 = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : Array.isArray(v) ? v.map(round3) : v);

/** where: { KEY: value | [values] }, case-insensitive. Values may be "<5", ">=1000" or "~partial". */
function matcher(where: Args | undefined) {
  const conds = Object.entries(where ?? {}).map(([k, v]) => ({ key: k.toLowerCase(), wants: (Array.isArray(v) ? v : [v]).map(String) }));
  const test = (actual: unknown, want: string): boolean => {
    const cmp = want.match(/^(<=|>=|<|>)\s*(-?[\d.]+)$/);
    if (cmp) {
      const a = Number(actual);
      const x = Number(cmp[2]);
      if (!Number.isFinite(a)) return false;
      return cmp[1] === '<' ? a < x : cmp[1] === '<=' ? a <= x : cmp[1] === '>' ? a > x : a >= x;
    }
    const act = String(actual ?? '').trim().toLowerCase();
    if (want.startsWith('~')) return act.includes(want.slice(1).trim().toLowerCase());
    return act === want.trim().toLowerCase();
  };
  return (props: Record<string, unknown>) =>
    conds.every(({ key, wants }) => {
      const k = Object.keys(props).find((p) => p.toLowerCase() === key);
      return k !== undefined && wants.some((w) => test(props[k], w));
    });
}

/** Keys and their common values, so the model can write `where`/`color_by` against real data. */
function describe(features: Feature[], focus: string[]) {
  const keys = new Map<string, Map<string, number>>();
  for (const f of features) {
    for (const [k, v] of Object.entries(f.properties ?? {})) {
      if (v === null || typeof v === 'object') continue;
      let counts = keys.get(k);
      if (!counts) keys.set(k, (counts = new Map()));
      const s = String(v);
      if (counts.size < 200 || counts.has(s)) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }
  const lowFocus = focus.map((f) => f.toLowerCase());
  const out: Record<string, string[] | string> = {};
  for (const [k, counts] of keys) {
    // Skip translated names ("NAME_DE", "name_fr"…): they only repeat NAME.
    if (/^name_[a-z]{2,3}$/i.test(k)) continue;
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (counts.size <= 40 || lowFocus.includes(k.toLowerCase())) out[k] = top.slice(0, 40).map(([v, c]) => `${v} (${c})`);
    else out[k] = `${counts.size >= 200 ? '200+' : counts.size} distinct values, e.g. ${top.slice(0, 4).map(([v]) => v).join(', ')}`;
  }
  return out;
}

async function loadGeojson(args: Args) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  if (!url) throw new Error('"url" is required');
  const data = await cached(`geojson:${url}`, async () => {
    const doc = await safeGet(url, { timeoutMs: 60000, headers: { Accept: 'application/geo+json,application/json,*/*;q=0.5' } });
    if (doc.status >= 400) throw new Error(`HTTP ${doc.status} fetching ${doc.url}`);
    let json: { type?: string; features?: Feature[]; geometry?: Feature['geometry'] };
    try {
      json = JSON.parse(doc.body);
    } catch {
      throw new Error(
        doc.body.length >= MAX_BYTES_HINT - 1024
          ? 'File is larger than 8 MB; use a coarser version (e.g. Natural Earth 50m or 110m instead of 10m).'
          : 'Response is not valid JSON/GeoJSON.',
      );
    }
    const features: Feature[] =
      json.type === 'FeatureCollection' && Array.isArray(json.features)
        ? json.features
        : json.type === 'Feature'
          ? [json as Feature]
          : json.type && 'coordinates' in json
            ? [{ type: 'Feature', properties: {}, geometry: json as Feature['geometry'] }]
            : [];
    if (!features.length) throw new Error('No GeoJSON features found at that URL.');
    return features;
  });

  const where = args.where && typeof args.where === 'object' ? (args.where as Args) : undefined;
  const keep = (Array.isArray(args.keep) ? args.keep.map(String) : []).map((k) => k.toLowerCase());
  const match = matcher(where);
  const matched = data.filter((f) => f.geometry && match(f.properties ?? {}));
  const drawable = matched.filter((f) => /Polygon|LineString/.test(f.geometry!.type));
  const summary = {
    total: data.length,
    matched: matched.length,
    skipped: matched.length - drawable.length,
    geometryTypes: [...new Set(matched.map((f) => f.geometry!.type))],
    properties: describe(where && !matched.length ? data : matched, [...Object.keys(where ?? {}), ...keep]),
  };
  if (args.preview === true) return { ...summary, features: [] };
  const limit = 5000;
  return {
    ...summary,
    truncated: drawable.length > limit,
    features: drawable.slice(0, limit).map((f) => ({
      properties: Object.fromEntries(Object.entries(f.properties ?? {}).filter(([k]) => keep.includes(k.toLowerCase()))),
      geometry: { type: f.geometry!.type, coordinates: round3(f.geometry!.coordinates) },
    })),
  };
}

export const dataTools: Record<string, (args: Args) => Promise<unknown>> = {
  elevation_grid: elevationGrid,
  load_geojson: loadGeojson,
};
