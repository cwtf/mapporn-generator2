import { geoCircle } from 'd3-geo';
import type { Geometry, LineString, MultiLineString, MultiPolygon, Polygon, Position } from 'geojson';

// Geometry for free-form areas. Agents think of outlines as flat lon/lat drawings ("a box from 20°N to
// 30°N"), while d3-geo joins vertices with great-circle arcs and decides which side of a ring is inside
// from its winding. These helpers turn the former into the latter.

type Pt = [number, number];
type Ring = Pt[];

const EARTH_RADIUS_KM = 6371.0088;
/** Longest edge, in degrees, before it is split so it follows the parallel rather than a great circle. */
const MAX_EDGE = 1;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const onSeam = (p: Pt) => Math.abs(p[0]) === 180;
const pinned = (p: Pt) => onSeam(p) || Math.abs(p[1]) === 90;

function closed(ring: Ring): Ring {
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a];
}

/** Twice the signed planar area; negative = clockwise with latitude pointing up. */
function shoelace(ring: Position[]): number {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s;
}

/** d3-geo convention: exterior rings clockwise, holes counter-clockwise (in lon/lat with north up). */
export function orient<T extends Position[]>(ring: T, exterior: boolean): T {
  const cw = shoelace(ring) < 0;
  return cw === exterior ? ring : ([...ring].reverse() as T);
}

/**
 * Make longitudes continuous so an outline crossing the antimeridian (170 → -170) stays one shape.
 * Jumps from -180 to 180 (or back) are kept: that is how full-width edges are written.
 */
function unwrap(ring: Ring): { ring: Ring; turns: number } {
  const out: Ring = [ring[0]];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    const d = ring[i][0] - ring[i - 1][0];
    const fullWidth = onSeam(ring[i]) && ring[i][0] === -ring[i - 1][0];
    if (Math.abs(d) > 180 && !fullWidth) offset -= Math.sign(d) * 360;
    out.push([ring[i][0] + offset, ring[i][1]]);
  }
  return { ring: out, turns: Math.round(offset / 360) };
}

/** Chaikin corner cutting; vertices on the antimeridian or a pole stay put so seams don't open. */
function smoothRing(ring: Ring, iterations = 3): Ring {
  let pts = ring.slice(0, -1);
  for (let k = 0; k < iterations && pts.length >= 3; k++) {
    const next: Ring = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (pinned(p)) {
        next.push(p);
        continue;
      }
      const prev = pts[(i - 1 + pts.length) % pts.length];
      const nxt = pts[(i + 1) % pts.length];
      next.push([0.75 * p[0] + 0.25 * prev[0], 0.75 * p[1] + 0.25 * prev[1]]);
      next.push([0.75 * p[0] + 0.25 * nxt[0], 0.75 * p[1] + 0.25 * nxt[1]]);
    }
    pts = next;
  }
  return closed(pts);
}

function densify(ring: Ring): Ring {
  const out: Ring = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const [x0, y0] = ring[i - 1];
    const [x1, y1] = ring[i];
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / MAX_EDGE);
    for (let k = 1; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    out.push(ring[i]);
  }
  return out;
}

function tidy(ring: Ring): Ring {
  const out: Ring = [];
  for (const [x, y] of ring) {
    const p: Pt = [round3(x), round3(Math.max(-90, Math.min(90, y)))];
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/**
 * An unwrapped ring that circles a pole (e.g. a line along 66.5°N) ends a full turn from where it
 * started. Restart it where it crosses the antimeridian so it runs from -180 to 180, then close it
 * along the antimeridian over the nearer pole; outline() leaves those closing edges out.
 */
function closeOverPole(ring: Ring, turns: number): Ring {
  const pole = ring.reduce((s, p) => s + p[1], 0) >= 0 ? 90 : -90;
  const band = (x: number) => Math.floor((x + 180) / 360);
  const i = ring.findIndex((p, k) => k < ring.length - 1 && band(p[0]) !== band(ring[k + 1][0]));
  const [[x0, y0], [x1, y1]] = [ring[i], ring[i + 1]];
  const b = -180 + 360 * Math.max(band(x0), band(x1));
  const cut: Pt = [b, y0 + ((y1 - y0) * (b - x0)) / (x1 - x0)];
  const turn = 360 * turns;
  const cycle: Ring = [cut, ...ring.slice(i + 1, -1), ...ring.slice(0, i + 1).map(([x, y]): Pt => [x + turn, y]), [cut[0] + turn, cut[1]]];
  const shift = (turns > 0 ? -180 : 180) - b;
  const moved = cycle.map(([x, y]): Pt => [x + shift, y]);
  const [first, last] = [moved[0], moved[moved.length - 1]];
  return [...moved, [last[0], pole], [first[0], pole], first];
}

function prepareRing(input: Ring, exterior: boolean, smooth: boolean): Ring | undefined {
  if (input.length < 3) return undefined;
  let { ring, turns } = unwrap(closed(input));
  if (turns !== 0) ring = closeOverPole(ring, turns);
  if (smooth) ring = smoothRing(ring);
  ring = tidy(densify(ring));
  if (ring.length < 4) return undefined;
  return orient(ring, exterior);
}

/** A polygon from rings drawn in lon/lat: the first ring is the outline, the rest are holes. */
export function polygonFromRings(rings: Ring[], smooth = false): Polygon | undefined {
  const [outer, ...holes] = rings;
  const ext = outer && prepareRing(outer, true, smooth);
  if (!ext) return undefined;
  const inner = holes.map((h) => prepareRing(h, false, smooth)).filter((r): r is Ring => !!r);
  return { type: 'Polygon', coordinates: [ext, ...inner] };
}

/** A lat/lon box, following parallels and meridians. West > east crosses the antimeridian. */
export function bboxPolygon([w, s, e, n]: [number, number, number, number]): Polygon | undefined {
  if (e < w) e += 360;
  if (e === w || n === s) return undefined;
  return polygonFromRings([
    [
      [w, s],
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  ]);
}

export function circlePolygon(lon: number, lat: number, radiusKm: number): Polygon {
  const radius = ((radiusKm / EARTH_RADIUS_KM) * 180) / Math.PI;
  const circle = geoCircle().center([lon, lat]).radius(Math.min(radius, 179)).precision(Math.max(0.2, Math.min(2, radius / 20)))();
  return { type: 'Polygon', coordinates: circle.coordinates.map((r) => tidy(r as Ring)) };
}

export type AreaGeometry = Polygon | MultiPolygon | LineString | MultiLineString;

/** Normalise geometry from an arbitrary GeoJSON source (any winding convention). */
export function normalizeGeometry(g: Geometry): AreaGeometry | undefined {
  switch (g.type) {
    case 'Polygon':
      return polygonFromRings(g.coordinates as Ring[]);
    case 'MultiPolygon': {
      const polys = g.coordinates.map((p) => polygonFromRings(p as Ring[])).filter((p): p is Polygon => !!p);
      return polys.length ? { type: 'MultiPolygon', coordinates: polys.map((p) => p.coordinates) } : undefined;
    }
    case 'LineString':
      return g.coordinates.length >= 2 ? { type: 'LineString', coordinates: tidy(g.coordinates as Ring) } : undefined;
    case 'MultiLineString': {
      const lines = g.coordinates.filter((l) => l.length >= 2).map((l) => tidy(l as Ring));
      return lines.length ? { type: 'MultiLineString', coordinates: lines } : undefined;
    }
    default:
      return undefined;
  }
}

/** Merge several geometries of one kind (polygonal or linear) into a single multi-geometry. */
export function mergeGeometries(list: AreaGeometry[]): AreaGeometry[] {
  const polys: Position[][][] = [];
  const lines: Position[][] = [];
  for (const g of list) {
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polys.push(...g.coordinates);
    else if (g.type === 'LineString') lines.push(g.coordinates);
    else lines.push(...g.coordinates);
  }
  const out: AreaGeometry[] = [];
  if (polys.length) out.push(polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys });
  if (lines.length) out.push(lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines });
  return out;
}

/**
 * The visible edges of polygons, for stroking: edges running along the antimeridian or through a
 * pole only exist to close shapes that wrap the globe or were split at ±180, so they are left out.
 */
export function outline(g: Polygon | MultiPolygon): MultiLineString {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  const hidden = (a: Position, b: Position) => (Math.abs(a[0]) === 180 && a[0] === b[0]) || (Math.abs(a[1]) === 90 && a[1] === b[1]);
  const lines: Position[][] = [];
  for (const ring of polys.flat()) {
    // Start at a hidden edge (if any) so a visible run isn't split at the ring's first vertex.
    const start = ring.findIndex((p, i) => i < ring.length - 1 && hidden(p, ring[i + 1]));
    const pts = start > 0 ? [...ring.slice(start, -1), ...ring.slice(0, start + 1)] : ring;
    let run: Position[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (hidden(pts[i - 1], pts[i])) {
        if (run.length > 1) lines.push(run);
        run = [pts[i]];
      } else run.push(pts[i]);
    }
    if (run.length > 1) lines.push(run);
  }
  return { type: 'MultiLineString', coordinates: lines };
}

export function vertexCount(g: AreaGeometry): number {
  const flat = (g.coordinates as unknown[]).flat(3) as unknown[];
  return flat.length / 2;
}
