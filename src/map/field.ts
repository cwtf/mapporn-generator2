import { contours } from 'd3-contour';
import type { MultiPolygon } from 'geojson';
import { buildScale, type Scale } from './colors';
import { orient } from './shapes';
import type { FieldData, MapField } from './types';

// A field is sampled onto a regular, cell-centred lon/lat grid (row 0 = north) and turned into nested
// filled contours with d3-contour. Each band is drawn on top of the previous one, so band i covers
// every cell with value >= its threshold.

type BBox = [number, number, number, number];

export interface FieldGrid {
  /** West/east may exceed ±180 when the area crosses the antimeridian. */
  bbox: BBox;
  nx: number;
  ny: number;
  /** Row-major, NaN = no data */
  values: Float64Array;
}

export interface FieldBand {
  threshold: number;
  color: string;
  geometry: MultiPolygon;
}

export interface FieldRender {
  grid: FieldGrid;
  scale: Scale;
  bands: FieldBand[];
  min: number;
  max: number;
  /** Share of grid cells that have data */
  coverage: number;
}

const MAX_CELLS = 64_800;
/** Budget for inverse-distance weighting: cells × sample points. */
const MAX_IDW_WORK = 40_000_000;
/** Bands used to approximate a continuous gradient */
const CONTINUOUS_LEVELS = 28;
const RAD = Math.PI / 180;
const EARTH_RADIUS_KM = 6371.0088;

// ---- extent ----------------------------------------------------------------------------

function medianStep(sorted: number[]): number {
  const d = sorted.slice(1).map((v, i) => v - sorted[i]).filter((x) => x > 0).sort((a, b) => a - b);
  return d.length ? d[Math.floor(d.length / 2)] : 1;
}

/** Extent the data naturally covers, [w, s, e, n]. */
export function dataExtent(data: FieldData): BBox {
  let w: number, s: number, e: number, n: number;
  if (data.kind === 'grid') {
    const lons = [...data.lons].sort((a, b) => a - b);
    const lats = [...data.lats].sort((a, b) => a - b);
    const hx = medianStep(lons) / 2;
    const hy = medianStep(lats) / 2;
    [w, e, s, n] = [lons[0] - hx, lons[lons.length - 1] + hx, lats[0] - hy, lats[lats.length - 1] + hy];
  } else {
    const lons = data.points.map((p) => p[0]);
    const lats = data.points.map((p) => p[1]);
    [w, e, s, n] = [Math.min(...lons), Math.max(...lons), Math.min(...lats), Math.max(...lats)];
    const px = Math.max(2, (e - w) * 0.05);
    const py = Math.max(2, (n - s) * 0.05);
    [w, e, s, n] = [w - px, e + px, s - py, n + py];
  }
  if (e - w >= 350) [w, e] = [-180, 180];
  return [Math.max(-180, w), Math.max(-90, s), Math.min(180, e), Math.min(90, n)];
}

// ---- sampling ---------------------------------------------------------------------------

type Sampler = (lon: number, lat: number) => number;

/** Bilinear interpolation on an arbitrary (possibly unsorted, non-uniform) lat/lon lattice. */
function gridSampler(d: Extract<FieldData, { kind: 'grid' }>): Sampler {
  const latOrder = d.lats.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const lonOrder = d.lons.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const lats = latOrder.map((x) => x[0]);
  const lons = lonOrder.map((x) => x[0]);
  const at = (i: number, j: number) => {
    const v = d.values[latOrder[i][1]]?.[lonOrder[j][1]];
    return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
  };
  const hy = medianStep(lats) / 2;
  const hx = medianStep(lons) / 2;
  const periodic = lons[lons.length - 1] - lons[0] + 2 * hx >= 359.5;

  /** Index of the lattice line at or below v, plus the fraction towards the next one. */
  const locate = (arr: number[], v: number): [number, number] | undefined => {
    if (v < arr[0] || v > arr[arr.length - 1]) return undefined;
    let lo = 0;
    let hi = arr.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid;
      else hi = mid;
    }
    if (arr.length === 1) return [0, 0];
    return [lo, (v - arr[lo]) / (arr[lo + 1] - arr[lo] || 1)];
  };

  return (lon, lat) => {
    const la = Math.max(lats[0], Math.min(lats[lats.length - 1], lat));
    if (Math.abs(la - lat) > hy + 1e-9) return NaN;
    const li = locate(lats, la)!;
    let j0: number, j1: number, fx: number;
    let x = lon;
    while (x < lons[0] - (periodic ? 0 : hx)) x += 360;
    while (x > lons[0] + 360) x -= 360;
    if (periodic && x > lons[lons.length - 1]) {
      // Between the last column and the first one, across the seam.
      j0 = lons.length - 1;
      j1 = 0;
      fx = (x - lons[j0]) / (lons[0] + 360 - lons[j0]);
    } else {
      const xc = Math.max(lons[0], Math.min(lons[lons.length - 1], x));
      if (Math.abs(xc - x) > hx + 1e-9) return NaN;
      const lj = locate(lons, xc)!;
      j0 = lj[0];
      j1 = Math.min(lj[0] + 1, lons.length - 1);
      fx = lj[1];
    }
    const i0 = li[0];
    const i1 = Math.min(li[0] + 1, lats.length - 1);
    const fy = li[1];
    let sum = 0;
    let wsum = 0;
    const add = (v: number, w: number) => {
      if (w > 0 && !Number.isNaN(v)) (sum += v * w), (wsum += w);
    };
    add(at(i0, j0), (1 - fx) * (1 - fy));
    add(at(i0, j1), fx * (1 - fy));
    add(at(i1, j0), (1 - fx) * fy);
    add(at(i1, j1), fx * fy);
    // Tolerate missing corners (e.g. a coastline mask) but not cells surrounded by gaps.
    return wsum >= 0.25 ? sum / wsum : NaN;
  };
}

const unit = (lon: number, lat: number): [number, number, number] => {
  const cl = Math.cos(lat * RAD);
  return [cl * Math.cos(lon * RAD), cl * Math.sin(lon * RAD), Math.sin(lat * RAD)];
};

/** Inverse distance weighting on the sphere (chord distance), optionally limited to a radius. */
function idwSampler(d: Extract<FieldData, { kind: 'points' }>): Sampler {
  const pts = d.points.filter((p) => p.every(Number.isFinite));
  const xyz = pts.map((p) => unit(p[0], p[1]));
  const vals = pts.map((p) => p[2]);
  const half = (d.power ?? 2) / 2;
  const maxChord2 = d.maxDistanceKm ? (2 * Math.sin(Math.min(Math.PI, d.maxDistanceKm / EARTH_RADIUS_KM) / 2)) ** 2 : Infinity;
  return (lon, lat) => {
    const [x, y, z] = unit(lon, lat);
    let sum = 0;
    let wsum = 0;
    for (let k = 0; k < xyz.length; k++) {
      const q = xyz[k];
      const c2 = Math.max(0, 2 - 2 * (x * q[0] + y * q[1] + z * q[2]));
      if (c2 < 1e-14) return vals[k];
      if (c2 > maxChord2) continue;
      const w = c2 ** -half;
      sum += vals[k] * w;
      wsum += w;
    }
    return wsum > 0 ? sum / wsum : NaN;
  };
}

function buildGrid(field: MapField): FieldGrid {
  let [w, s, e, n] = field.bbox ?? dataExtent(field.data);
  if (e <= w) e += 360;
  s = Math.max(-90, s);
  n = Math.min(90, n);
  const width = e - w;
  const height = Math.max(n - s, 1e-6);
  let step = Math.sqrt((width * height) / MAX_CELLS);
  if (field.data.kind === 'points') step = Math.max(step, Math.sqrt((width * height * field.data.points.length) / MAX_IDW_WORK));
  else step = Math.max(step, Math.min(medianStep([...field.data.lons].sort((a, b) => a - b)), medianStep([...field.data.lats].sort((a, b) => a - b))) / 8);
  const nx = Math.max(2, Math.round(width / step));
  const ny = Math.max(2, Math.round(height / step));
  const dx = width / nx;
  const dy = height / ny;
  const sample = field.data.kind === 'grid' ? gridSampler(field.data) : idwSampler(field.data);
  const values = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = n - (j + 0.5) * dy;
    for (let i = 0; i < nx; i++) values[j * nx + i] = sample(w + (i + 0.5) * dx, lat);
  }
  return { bbox: [w, s, e, n], nx, ny, values };
}

// ---- rendering ----------------------------------------------------------------------------

function bandsFor(grid: FieldGrid, scale: Scale, min: number): FieldBand[] {
  const { nx, ny, bbox } = grid;
  const [w, s, e, n] = bbox;
  const dx = (e - w) / nx;
  const dy = (n - s) / ny;
  let thresholds: number[];
  let colorOf: (t: number, i: number) => string;
  if (scale.continuous) {
    const step = (scale.max - scale.min) / CONTINUOUS_LEVELS || 1;
    const levels = Array.from({ length: CONTINUOUS_LEVELS - 1 }, (_, k) => scale.min + step * (k + 1));
    thresholds = [min, ...levels.filter((t) => t > min)];
    // The base band starts at the data minimum; colour it like the level it falls in.
    const floor = levels.filter((t) => t <= min).pop() ?? scale.min;
    colorOf = (t, i) => scale.colorAt((i === 0 ? floor : t) + step / 2);
  } else {
    thresholds = [min, ...scale.breaks.filter((b) => b > min)];
    colorOf = (t) => scale.colorAt(t);
  }
  const gen = contours().size([nx, ny]).smooth(true);
  const values = grid.values as unknown as number[];
  const toLonLat = (p: number[]) => {
    p[0] = w + p[0] * dx;
    p[1] = Math.max(-90, Math.min(90, n - p[1] * dy));
  };
  const out: FieldBand[] = [];
  thresholds.forEach((t, i) => {
    const c = gen.contour(values, t);
    if (!c.coordinates.length) return;
    for (const poly of c.coordinates) {
      for (const ring of poly) ring.forEach(toLonLat);
      poly.forEach((ring, k) => (poly[k] = orient(ring, k === 0)));
    }
    out.push({ threshold: t, color: colorOf(t, i), geometry: { type: 'MultiPolygon', coordinates: c.coordinates } });
  });
  return out;
}

const gridCache = new Map<string, FieldGrid>();
const renderCache = new Map<string, FieldRender>();

function remember<T>(cache: Map<string, T>, key: string, make: () => T): T {
  let v = cache.get(key);
  if (!v) {
    v = make();
    cache.set(key, v);
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return v;
}

/** Interpolate, classify and contour a field. Cached by the field's key and colour settings. */
export function renderField(field: MapField): FieldRender {
  const { key, data: _data, bbox: _bbox, clip: _clip, opacity: _opacity, origin: _origin, ...colorSettings } = field;
  const gridKey = `${key}|${JSON.stringify(field.bbox ?? null)}`;
  return remember(renderCache, `${gridKey}|${JSON.stringify(colorSettings)}`, () => {
    const grid = remember(gridCache, gridKey, () => buildGrid(field));
    const finite: number[] = [];
    for (const v of grid.values) if (!Number.isNaN(v)) finite.push(v);
    let min = Infinity;
    let max = -Infinity;
    for (const v of finite) (min = Math.min(min, v)), (max = Math.max(max, v));
    const scale = buildScale(finite, field);
    const bands = finite.length ? bandsFor(grid, scale, min) : [];
    return { grid, scale, bands, min, max, coverage: finite.length / grid.values.length };
  });
}

/** Field value at a location (nearest grid cell), or undefined outside the data. */
export function fieldValueAt(render: FieldRender, lon: number, lat: number): number | undefined {
  const { bbox, nx, ny, values } = render.grid;
  const [w, s, e, n] = bbox;
  let x = lon;
  while (x < w) x += 360;
  while (x >= w + 360) x -= 360;
  const i = Math.floor(((x - w) / (e - w)) * nx);
  const j = Math.floor(((n - lat) / (n - s)) * ny);
  if (i < 0 || i >= nx || j < 0 || j >= ny) return undefined;
  const v = values[j * nx + i];
  return Number.isNaN(v) ? undefined : v;
}
