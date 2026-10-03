import type { Geometry } from 'geojson';
import { CATEGORICAL, computeChoropleth, makeFormatter, SCHEME_NAMES } from '../map/colors';
import { renderField } from '../map/field';
import { geo } from '../map/geodata';
import { canTurn, normalizeAngle, PROJECTION_GROUPS, PROJECTION_IDS, PROJECTIONS } from '../map/projections';
import { bboxPolygon, circlePolygon, mergeGeometries, normalizeGeometry, polygonFromRings, vertexCount, type AreaGeometry } from '../map/shapes';
import {
  emptyMapState,
  type ChoroplethMethod,
  type ClipMode,
  type ColorScale,
  type FieldData,
  type MapArea,
  type MapLabel,
  type MapLine,
  type MapMarker,
  type MapState,
  type MarkerShape,
} from '../map/types';
import { useMapStore } from '../store/mapStore';
import type { ToolDef } from './llm';

type Args = Record<string, unknown>;
type Executor = (args: Args, signal: AbortSignal) => Promise<string>;

// ---- helpers ------------------------------------------------------------------------

const map = () => useMapStore.getState().map;
const update = (fn: (m: MapState) => void) => useMapStore.getState().update(fn);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const toNum = (v: unknown): number | undefined => (isNum(v) ? v : isStr(v) && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : isStr(v) ? [v] : []);
const optStr = (v: unknown) => (isStr(v) && v.trim() ? v.trim() : undefined);

function validColor(c: unknown): c is string {
  return isStr(c) && c.trim() !== '' && CSS.supports('color', c.trim());
}

function nextId(prefix: string, items: { id: string }[]) {
  const max = items.reduce((m, it) => Math.max(m, Number(it.id.slice(prefix.length)) || 0), 0);
  return `${prefix}${max + 1}`;
}

function errorsNote(errors: string[]) {
  if (!errors.length) return '';
  const shown = errors.slice(0, 15);
  return `\nUnmatched (${errors.length}): ${shown.join('; ')}${errors.length > shown.length ? '; …' : ''}`;
}

/** Make sure subdivisions of any subdivision ids are drawn; returns newly shown countries. */
function ensureSubdivisionsShown(ids: string[], draft: MapState): string[] {
  const added: string[] = [];
  for (const id of ids) {
    const info = geo.get(id);
    if (info?.kind === 'subdivision' && info.country && !draft.subdivisions.includes(info.country)) {
      draft.subdivisions.push(info.country);
      added.push(info.country);
    }
  }
  return added;
}

function coord(v: unknown): [number, number] | undefined {
  if (Array.isArray(v) && v.length >= 2) {
    const lon = toNum(v[0]);
    const lat = toNum(v[1]);
    if (lon !== undefined && lat !== undefined && Math.abs(lat) <= 90) return [lon, lat];
  }
  if (v && typeof v === 'object') {
    const o = v as Args;
    const lon = toNum(o.lon ?? o.lng ?? o.longitude);
    const lat = toNum(o.lat ?? o.latitude);
    if (lon !== undefined && lat !== undefined) return [lon, lat];
  }
  return undefined;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function bbox(v: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const b = v.map(toNum);
  if (!b.every((x): x is number => x !== undefined) || b[1] >= b[3] || Math.abs(b[1]) > 90 || Math.abs(b[3]) > 90) return undefined;
  return [b[0], b[1], b[2], b[3]];
}

const CLIPS: ClipMode[] = ['land', 'ocean', 'none'];
const clipMode = (v: unknown, dflt: ClipMode): ClipMode => (CLIPS.includes(v as ClipMode) ? (v as ClipMode) : dflt);
const METHODS: ChoroplethMethod[] = ['quantize', 'quantile', 'threshold', 'continuous'];
const numList = (v: unknown) => (Array.isArray(v) ? v.map(toNum).filter((x): x is number => x !== undefined) : undefined);

/** Colour-scale arguments shared by set_choropleth and set_field. */
function colorScaleArgs(a: Args, dflt: { scheme: string; method: ChoroplethMethod }): ColorScale {
  const domain = numList(a.domain);
  const colors = Array.isArray(a.colors) ? a.colors.filter(validColor).map((c) => String(c).trim()) : undefined;
  return {
    scheme: optStr(a.scheme) ?? dflt.scheme,
    method: METHODS.includes(a.method as ChoroplethMethod) ? (a.method as ChoroplethMethod) : dflt.method,
    classes: toNum(a.classes),
    breaks: numList(a.breaks),
    colors: colors?.length ? colors : undefined,
    domain: domain?.length === 2 ? [domain[0], domain[1]] : undefined,
    reverse: a.reverse === true,
    title: optStr(a.title),
    unit: optStr(a.unit),
    format: optStr(a.format),
  };
}

const COLOR_SCALE_PARAMS = {
  scheme: { type: 'string', description: `One of: ${SCHEME_NAMES.join(', ')}` },
  method: { type: 'string', enum: METHODS },
  classes: { type: 'integer', description: 'Number of classes for quantize/quantile (2-9, default 5)' },
  breaks: { type: 'array', items: { type: 'number' }, description: 'Class breaks for method=threshold, ascending' },
  colors: {
    type: 'array',
    items: { type: 'string' },
    description: 'Exact colours overriding scheme: one per class (breaks + 1) for classed methods, gradient stops for continuous',
  },
  domain: { type: 'array', items: { type: 'number' }, description: 'Optional [min, max] override' },
  reverse: { type: 'boolean' },
  unit: { type: 'string', description: 'Unit appended to legend numbers, e.g. "%", "$", "°C", "mm"' },
  format: { type: 'string', description: 'd3-format specifier for legend numbers, e.g. ",.0f", ".1f", ".2s"' },
};

/** Browser-side call to the server's bulk data loaders (results go to the map, not the model). */
async function loadData<T>(name: string, args: Args, signal: AbortSignal): Promise<T> {
  const res = await fetch(`/api/data/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (data.error) throw new Error(data.error);
  return data.result as T;
}

/** Rings from [[lon, lat], …] (one ring) or [[[lon, lat], …], …] (outline + holes). */
function rings(v: unknown): [number, number][][] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  const nested = Array.isArray(v[0]) && Array.isArray(v[0][0]);
  const list = (nested ? v : [v]) as unknown[];
  const out = list.map((r) => (Array.isArray(r) ? r.map(coord).filter(Boolean) : [])) as [number, number][][];
  return out[0]?.length >= 3 ? out : undefined;
}

let fieldSeq = 0;

const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

type AreaStyle = Omit<MapArea, 'id' | 'geometry'>;

const AREA_STYLE_PARAMS = {
  fill: { type: 'string', description: 'CSS colour, or "none" for an outline only' },
  opacity: { type: 'number', description: 'Fill opacity 0–1 (default 1); ~0.5 lets country colours show through' },
  stroke: { type: 'string', description: 'Outline colour (default none)' },
  stroke_width: { type: 'number' },
  dashed: { type: 'boolean' },
  hatch: { type: 'boolean', description: 'Diagonal hatching instead of a solid fill, good for overlapping zones' },
  clip: { type: 'string', enum: CLIPS, description: 'land (default for hand-drawn areas), ocean, or none (default for GeoJSON)' },
  smooth: { type: 'boolean', description: 'Round the corners of hand-drawn outlines' },
};

interface GeojsonResult {
  total: number;
  matched: number;
  skipped: number;
  truncated?: boolean;
  geometryTypes: string[];
  properties: Record<string, unknown>;
  features: { properties: Record<string, unknown>; geometry: Geometry }[];
}

/** Conventional framings for continent maps (full extents are dominated by Russia, overseas territories, etc.) */
const CONTINENT_FRAMES: Record<string, [number, number, number, number]> = {
  europe: [-25, 34, 45, 71.5],
  africa: [-26, -36, 58, 38],
  asia: [25, -12, 150, 62],
  'north america': [-170, 6, -50, 84],
  'south america': [-93, -57, -29, 14],
  oceania: [110, -50, 180, 2],
  'middle east': [25, 12, 63, 42],
};

// ---- map tools --------------------------------------------------------------------------

const COUNTRY_PARAM = {
  type: 'string',
  description: "Optional country (ISO3 like 'USA') to scope region NAMES to that country's subdivisions, e.g. so 'Georgia' means the US state.",
};

const REGION_REF_HELP =
  'Region references may be ISO 3166-1 alpha-3/alpha-2 codes (FRA, FR), ISO 3166-2 subdivision codes (US-CA, DE-BY), ' +
  'English names, or group selectors: "all", "continent:Africa", "subregion:Western Europe", "USA:*" (all US states).';

const mapTools: (ToolDef & { run: Executor })[] = [
  {
    name: 'get_map_state',
    description: 'Return a compact summary of everything currently on the map (projection, colours, choropleth, labels, markers, lines, legend, title, style). Call this when unsure what the map currently shows.',
    parameters: { type: 'object', properties: {} },
    run: async () => JSON.stringify(summarizeMap(map())),
  },
  {
    name: 'list_regions',
    description:
      'List region ids and names. With `country`, lists that country\'s first-level subdivisions (states/provinces) and their ids. Without it, lists countries, optionally filtered by `query` (substring) or `continent`/`subregion`. Use this to find exact ids before colouring.',
    parameters: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country id or name whose subdivisions to list' },
        query: { type: 'string', description: 'Case-insensitive substring filter on names' },
        continent: { type: 'string' },
        subregion: { type: 'string' },
      },
    },
    run: async (a) => {
      await geo.load();
      const q = optStr(a.query)?.toLowerCase();
      if (optStr(a.country)) {
        const cid = await geo.resolveCountry(String(a.country));
        if (!cid) return `Unknown country "${a.country}".`;
        if (!geo.hasSubdivisions(cid)) return `No subdivision data for ${cid}.`;
        const subs = await geo.loadSubdivisions(cid);
        const rows = subs
          .filter((f) => !q || f.properties.name.toLowerCase().includes(q))
          .map((f) => `${f.id}=${f.properties.name}${f.properties.type ? ` (${f.properties.type})` : ''}`);
        return `${cid} has ${subs.length} subdivisions:\n${rows.join('; ')}`;
      }
      const cont = optStr(a.continent)?.toLowerCase();
      const subr = optStr(a.subregion)?.toLowerCase();
      const rows = geo.countries
        .filter((f) => !q || f.properties.name.toLowerCase().includes(q) || f.properties.aliases.some((x) => x.toLowerCase().includes(q)))
        .filter((f) => !cont || f.properties.continent.toLowerCase() === cont)
        .filter((f) => !subr || f.properties.subregion.toLowerCase() === subr)
        .map((f) => `${f.id}=${f.properties.name}${geo.hasSubdivisions(f.id) ? '' : '†'}`);
      return (
        `${rows.length} countries (†=no subdivision data):\n${rows.join('; ')}` +
        (!q && !cont && !subr ? `\nContinents: ${geo.groupNames('continent').join(', ')}\nSubregions: ${geo.groupNames('subregion').join(', ')}` : '')
      );
    },
  },
  {
    name: 'set_projection',
    description:
      "Change the map projection (resets the user's pan/zoom). Available, by family — " +
      PROJECTION_GROUPS.map((g) => `${g}: ${PROJECTION_IDS.filter((id) => PROJECTIONS[id].group === g).map((id) => `${id} (${PROJECTIONS[id].label})`).join(', ')}`).join('. ') +
      '. Interrupted and polyhedral projections (e.g. airocean = Dymaxion) keep their fixed layout: zoom_to crops to an area but does not re-centre them.',
    parameters: {
      type: 'object',
      properties: {
        projection: { type: 'string', enum: PROJECTION_IDS },
        rotate: { type: 'array', items: { type: 'number' }, description: 'Optional [lambda, phi, gamma] rotation in degrees, e.g. [-150, 0] for a Pacific-centred map, [0, -90] for a north-polar azimuthal view. Omit to auto-centre.' },
        parallels: { type: 'array', items: { type: 'number' }, description: 'Optional standard parallels for conic projections, e.g. [35, 65] for Europe' },
        angle: { type: 'number', description: 'Optional in-plane rotation of the whole map in degrees, clockwise (e.g. 90 turns north to the right, 180 is a south-up map). Omit to keep the current angle; 0 resets.' },
      },
      required: ['projection'],
    },
    run: async (a) => {
      const id = String(a.projection) as MapState['projection']['id'];
      if (!PROJECTION_IDS.includes(id)) return `Unknown projection "${a.projection}". Options: ${PROJECTION_IDS.join(', ')}`;
      const rot = Array.isArray(a.rotate) ? a.rotate.map(Number).filter(Number.isFinite) : [];
      const par = Array.isArray(a.parallels) ? a.parallels.map(Number).filter(Number.isFinite) : [];
      const angle = a.angle === undefined || a.angle === null ? map().projection.angle : normalizeAngle(Number(a.angle)) || undefined;
      update((m) => {
        m.projection = {
          id,
          ...(angle && Number.isFinite(angle) && canTurn(id) ? { angle } : {}),
          ...(rot.length >= 2 ? { rotate: [rot[0], rot[1], rot[2] ?? 0] as [number, number, number] } : {}),
          ...(par.length === 2 ? { parallels: [par[0], par[1]] as [number, number] } : {}),
        };
        m.view = { k: 1, x: 0, y: 0 };
      });
      return `Projection set to ${PROJECTIONS[id].label}${angle && canTurn(id) ? `, rotated ${angle}° clockwise` : ''}.`;
    },
  },
  {
    name: 'color_regions',
    description:
      `Fill countries or subdivisions with colours. Pass one group per colour; a group's label (if given) is added to the legend. ${REGION_REF_HELP} ` +
      'Colouring a subdivision automatically draws its country\'s subdivisions. Manual colours override choropleth colours.',
    parameters: {
      type: 'object',
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              color: { type: 'string', description: 'Any CSS colour, e.g. "#d7301f"' },
              regions: { type: 'array', items: { type: 'string' } },
              label: { type: 'string', description: 'Legend label for this colour' },
            },
            required: ['color', 'regions'],
          },
        },
        country: COUNTRY_PARAM,
        legend_title: { type: 'string' },
        add_to_legend: { type: 'boolean', description: 'Default true; set false to not touch the legend' },
      },
      required: ['groups'],
    },
    run: async (a) => {
      const groups = Array.isArray(a.groups) ? (a.groups as Args[]) : [];
      if (!groups.length) return 'No groups given.';
      const country = optStr(a.country);
      const errors: string[] = [];
      const resolved: { color: string; label?: string; ids: string[] }[] = [];
      for (const g of groups) {
        if (!validColor(g.color)) {
          errors.push(`invalid colour ${JSON.stringify(g.color)}`);
          continue;
        }
        const { ids, errors: e } = await geo.resolveMany(strList(g.regions), country);
        errors.push(...e);
        resolved.push({ color: String(g.color).trim(), label: optStr(g.label), ids });
      }
      let shown: string[] = [];
      update((m) => {
        for (const g of resolved) for (const id of g.ids) m.regions[id] = { ...m.regions[id], fill: g.color };
        shown = ensureSubdivisionsShown(resolved.flatMap((g) => g.ids), m);
        if (a.add_to_legend !== false) {
          const labelled = resolved.filter((g) => g.label);
          if (labelled.length) {
            m.legend ??= { items: [] };
            for (const g of labelled) {
              const existing = m.legend.items.find((it) => it.label === g.label);
              if (existing) existing.color = g.color;
              else m.legend.items.push({ color: g.color, label: g.label! });
            }
          }
          if (optStr(a.legend_title)) (m.legend ??= { items: [] }).title = optStr(a.legend_title);
        }
      });
      const n = resolved.reduce((s, g) => s + g.ids.length, 0);
      return `Coloured ${n} regions in ${resolved.length} group(s).${shown.length ? ` Now drawing subdivisions of ${shown.join(', ')}.` : ''}${errorsNote(errors)}`;
    },
  },
  {
    name: 'set_choropleth',
    description:
      `Colour regions by numeric value with an automatic colour scale and legend (replaces any previous choropleth). ${REGION_REF_HELP} ` +
      `Schemes: ${SCHEME_NAMES.join(', ')}. Methods: quantize (equal intervals), quantile (equal counts), threshold (explicit breaks), continuous (smooth gradient). ` +
      'For quantities that vary within countries (climate, terrain) use set_field instead.',
    parameters: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: { region: { type: 'string' }, value: { type: 'number' } },
            required: ['region', 'value'],
          },
        },
        country: COUNTRY_PARAM,
        ...COLOR_SCALE_PARAMS,
        scheme: { type: 'string', description: 'Default YlOrRd; use diverging schemes (RdBu, BrBG, …) for data centred on a midpoint' },
        title: { type: 'string', description: 'Legend title, e.g. "GDP per capita (USD, 2024)"' },
        no_data_color: { type: 'string' },
        show_no_data: { type: 'boolean', description: 'Show a "No data" legend entry (default true)' },
      },
      required: ['data'],
    },
    run: async (a) => {
      let rows: { region: string; value: unknown }[] = [];
      if (Array.isArray(a.data)) rows = (a.data as Args[]).map((r) => ({ region: String(r.region ?? r.id ?? r.name ?? ''), value: r.value }));
      else if (a.data && typeof a.data === 'object') rows = Object.entries(a.data as Args).map(([region, value]) => ({ region, value }));
      const country = optStr(a.country);
      const values: Record<string, number> = {};
      const errors: string[] = [];
      for (const r of rows) {
        const v = toNum(r.value);
        if (v === undefined) {
          errors.push(`${r.region}: non-numeric value ${JSON.stringify(r.value)}`);
          continue;
        }
        const res = await geo.resolve(r.region, country);
        if ('id' in res) values[res.id] = v;
        else errors.push(res.error);
      }
      if (!Object.keys(values).length) return `No values could be matched to regions.${errorsNote(errors)}`;
      let shown: string[] = [];
      const next = update((m) => {
        m.choropleth = {
          values,
          ...colorScaleArgs(a, { scheme: 'YlOrRd', method: 'quantize' }),
          noDataColor: validColor(a.no_data_color) ? String(a.no_data_color) : undefined,
          showNoData: a.show_no_data !== false,
        };
        shown = ensureSubdivisionsShown(Object.keys(values), m);
      });
      const legend = computeChoropleth(next.choropleth!, '#ccc').legend;
      const classes = legend.items?.map((i) => `${i.color} ${i.label}`).join('; ') ?? `gradient ${legend.gradient?.min} → ${legend.gradient?.max}`;
      return `Choropleth applied to ${Object.keys(values).length} regions. Legend: ${classes}.${shown.length ? ` Now drawing subdivisions of ${shown.join(', ')}.` : ''}${errorsNote(errors)}`;
    },
  },
  {
    name: 'set_field',
    description:
      'Colour the map with a continuous surface that ignores borders: temperature, rainfall, snowfall, elevation, pollution, sunshine, anything measured at places rather than per country. ' +
      'Values are interpolated between samples and drawn as smooth filled contour bands with an automatic legend (replaces any previous field; drawn above country colours, below areas). ' +
      'Give exactly one data source: `points` (scattered samples such as weather stations or cities, interpolated by inverse distance weighting; 30+ well-spread points look best), ' +
      '`grid` (values on a regular lat/lon lattice) or `source: "elevation"` (built-in ETOPO 2022 relief: land elevation and ocean depth in metres, fetched for `bbox` or the current zoom_to framing; no data needed). ' +
      'Schemes include Terrain (hypsometric land tints) and Bathymetry (ocean depths). Default method is continuous; use threshold + breaks for classed maps such as "land above 2000 m".',
    parameters: {
      type: 'object',
      properties: {
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[lon, lat, value], …]' },
        grid: {
          type: 'object',
          properties: {
            lats: { type: 'array', items: { type: 'number' } },
            lons: { type: 'array', items: { type: 'number' } },
            values: { type: 'array', items: { type: 'array', items: { type: ['number', 'null'] } }, description: 'One row per lat, one column per lon; null = no data' },
          },
          required: ['lats', 'lons', 'values'],
        },
        source: { type: 'string', enum: ['elevation'] },
        bbox: { type: 'array', items: { type: 'number' }, description: 'Area to cover, [west, south, east, north]. Defaults to the data extent (for elevation, the current framing).' },
        resolution: { type: 'number', description: 'Elevation only: degrees between samples (default: automatic, ~60k samples)' },
        clip: {
          type: 'string',
          enum: CLIPS,
          description: 'Where the field is drawn: land (default), ocean (e.g. sea temperature, depth) or none (both, e.g. elevation with bathymetry)',
        },
        ...COLOR_SCALE_PARAMS,
        title: { type: 'string', description: 'Legend title, e.g. "Mean July temperature (°C, 1991–2020)"' },
        opacity: { type: 'number', description: '0–1 (default 1); lower it to let country colours show through' },
        power: { type: 'number', description: 'points only: inverse-distance power (default 2; higher = more local)' },
        max_distance_km: { type: 'number', description: 'points only: leave places farther than this from every sample blank' },
      },
    },
    run: async (a, signal) => {
      const errors: string[] = [];
      const elevation = a.source === 'elevation';
      let data: FieldData | undefined;
      let area = bbox(a.bbox);
      if (a.bbox !== undefined && !area) errors.push('ignored invalid bbox (use [west, south, east, north])');
      let origin: string | undefined;
      if (elevation) {
        if (!area && map().focus) {
          // The framed area rarely matches the map's aspect ratio; fetch a margin around it.
          const [w, s, e, n] = map().focus!;
          const px = ((e < w ? e + 360 : e) - w) * 0.3;
          const py = (n - s) * 0.3;
          area = [w - px, Math.max(-90, s - py), e + px, Math.min(90, n + py)];
          if (area[2] - area[0] >= 360) [area[0], area[2]] = [-180, 180];
        }
        area ??= [-180, -90, 180, 90];
        const g = await loadData<{ lats: number[]; lons: number[]; values: (number | null)[][]; resolution: number; origin: string }>(
          'elevation_grid',
          { bbox: area, resolution: toNum(a.resolution) },
          signal,
        );
        data = { kind: 'grid', lats: g.lats, lons: g.lons, values: g.values };
        origin = `${g.origin}, ${round(g.resolution)}° samples`;
      } else if (Array.isArray(a.points)) {
        const points: [number, number, number][] = [];
        for (const p of a.points as unknown[]) {
          const ll = coord(p);
          const v = toNum(Array.isArray(p) ? p[2] : p && typeof p === 'object' ? (p as Args).value : undefined);
          if (ll && v !== undefined) points.push([round(ll[0]), round(ll[1]), v]);
          else errors.push(`bad point ${JSON.stringify(p)}`);
        }
        if (points.length < 3) return `A field needs at least 3 valid [lon, lat, value] points.${errorsNote(errors)}`;
        data = { kind: 'points', points, power: toNum(a.power), maxDistanceKm: toNum(a.max_distance_km) };
      } else if (a.grid && typeof a.grid === 'object') {
        const g = a.grid as Args;
        const lats = numList(g.lats) ?? [];
        const lons = numList(g.lons) ?? [];
        const rows = Array.isArray(g.values) ? (g.values as unknown[]) : [];
        if (lats.length < 2 || lons.length < 2) return 'grid needs at least 2 lats and 2 lons.';
        if (rows.length !== lats.length || rows.some((r) => !Array.isArray(r) || r.length !== lons.length)) {
          return `grid.values must have ${lats.length} rows (one per lat) of ${lons.length} values (one per lon).`;
        }
        data = { kind: 'grid', lats, lons, values: (rows as unknown[][]).map((r) => r.map((v) => toNum(v) ?? null)) };
      } else {
        return 'Give one data source: points, grid or source="elevation".';
      }

      const clip = clipMode(a.clip, 'land');
      const scale = colorScaleArgs(a, { scheme: elevation ? (clip === 'ocean' ? 'Bathymetry' : 'Terrain') : 'Viridis', method: 'continuous' });
      if (elevation && !scale.domain && !scale.breaks && !scale.colors && !optStr(a.scheme) && !optStr(a.method)) {
        const vals = data.kind === 'grid' ? (data.values.flat().filter((v) => v !== null) as number[]) : [];
        const [lo, hi] = [Math.min(...vals), Math.max(...vals)];
        if (clip === 'land') scale.domain = [0, Math.max(hi, 1)];
        else if (clip === 'ocean') scale.domain = [Math.min(lo, -1), 0];
        else {
          // Classic hypsometric + bathymetric tints
          scale.method = 'threshold';
          scale.breaks = [-6000, -4000, -2000, -200, 0, 200, 500, 1000, 2000, 3000, 4500];
          scale.colors = ['#08254f', '#0d3c78', '#1b5c9e', '#3d85c0', '#8cc0e3', '#4f8f4a', '#8dba66', '#d9d991', '#d8a863', '#a8703f', '#8a6d5e', '#f4f4f2'];
        }
      }
      const opacity = toNum(a.opacity);
      update((m) => {
        m.field = {
          key: `f${Date.now().toString(36)}${fieldSeq++}`,
          data: data!,
          bbox: area,
          clip,
          opacity: opacity !== undefined ? Math.min(1, Math.max(0, opacity)) : undefined,
          origin,
          ...scale,
        };
      });
      const r = renderField(map().field!);
      if (!r.bands.length) return `The field has no data inside [${r.grid.bbox.map(round).join(', ')}]; check bbox and coordinates.${errorsNote(errors)}`;
      const fmt = makeFormatter([r.min, r.max], scale.format, scale.unit);
      const legend = r.scale.legend;
      const classes = legend.items?.map((i) => `${i.color} ${i.label}`).join('; ') ?? `gradient ${legend.gradient?.min} → ${legend.gradient?.max}`;
      const src = origin ?? (data.kind === 'points' ? `${data.points.length} points` : `${data.lats.length}×${data.lons.length} grid`);
      return (
        `Field drawn from ${src} over [${r.grid.bbox.map(round).join(', ')}] (${r.grid.nx}×${r.grid.ny} cells, ${Math.round(r.coverage * 100)}% with data), ` +
        `values ${fmt(r.min)} to ${fmt(r.max)}, clip=${clip}. Legend: ${classes}.${errorsNote(errors)}`
      );
    },
  },
  {
    name: 'draw_areas',
    description:
      'Draw zones that ignore administrative borders: deserts, mountain ranges, biomes, climate zones, permafrost, monsoon or tornado belts, flood plains, "within 500 km of X", ' +
      'latitude bands (tropics, Arctic Circle)… Each item of `areas` is ONE of: `polygon` (outline as [[lon, lat], …], or a list of rings where the first is the outline and the rest are holes), ' +
      '`polygons` (several separate outlines of the same zone), `bbox` [west, south, east, north] (follows parallels and meridians; west > east crosses the antimeridian) or `circle` {lon, lat, radius_km}. ' +
      'Hand-drawn areas are clipped to land by default so rough outlines snap to coastlines; set smooth=true to round the corners of hand-drawn outlines. ' +
      'Labelled areas go into the legend. Style keys given at the top level apply to every area and GeoJSON feature. ' +
      'Prefer real geometry over hand-drawn guesses: `geojson_url` loads Polygon/LineString features from any public GeoJSON, filtered by `where` and coloured by a property with `color_by`. ' +
      `Natural Earth (public domain) has ${NATURAL_EARTH}<file>.geojson with: ne_50m_geography_regions_polys (FEATURECLA: Desert, Range/mtn, Plateau, Basin, Plain, Tundra, Delta, Wetlands, Lowland, Valley…; NAME; SCALERANK), ` +
      'ne_50m_glaciated_areas, ne_50m_antarctic_ice_shelves_polys, ne_50m_lakes, ne_50m_rivers_lake_centerlines (lines; SCALERANK), ne_10m_playas, ne_10m_reefs, ne_50m_geography_marine_polys, ' +
      'ne_10m_bathymetry_K_200 (J_1000, I_2000, H_3000, G_4000, F_5000, E_6000… for deeper shelves). Use preview=true to list a file\'s properties without drawing.',
    parameters: {
      type: 'object',
      properties: {
        areas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Legend label' },
              polygon: { type: 'array', items: { type: 'array' }, description: '[[lon, lat], …] or [[[lon, lat], …] outline, [[lon, lat], …] hole, …]' },
              polygons: { type: 'array', items: { type: 'array' } },
              bbox: { type: 'array', items: { type: 'number' } },
              circle: { type: 'object', properties: { lon: { type: 'number' }, lat: { type: 'number' }, radius_km: { type: 'number' } }, required: ['lon', 'lat', 'radius_km'] },
              ...AREA_STYLE_PARAMS,
            },
          },
        },
        geojson_url: { type: 'string' },
        where: {
          type: 'object',
          description: 'Feature filter, case-insensitive: {"FEATURECLA": "Desert"} or {"FEATURECLA": ["Desert", "Plateau"], "SCALERANK": "<=3", "NAME": "~sahara"} (~ = contains)',
        },
        color_by: { type: 'string', description: 'Property whose values become separate colours and legend entries' },
        colors: { type: 'object', description: 'Colour per color_by value, e.g. {"Desert": "#e3c27d"}; unlisted values get palette colours' },
        preview: { type: 'boolean', description: 'Only describe the GeoJSON (feature count, property values); draw nothing' },
        ...AREA_STYLE_PARAMS,
        label: { type: 'string', description: 'Legend label for GeoJSON features when not using color_by' },
        replace: { type: 'boolean', description: 'Remove all existing areas first' },
        add_to_legend: { type: 'boolean', description: 'Default true' },
        legend_title: { type: 'string' },
      },
    },
    run: async (a, signal) => {
      const errors: string[] = [];
      const notes: string[] = [];
      const style = (o: Args, base: AreaStyle = {}): AreaStyle => {
        const opacity = toNum(o.opacity);
        return {
          label: optStr(o.label) ?? base.label,
          fill: o.fill === 'none' ? 'none' : validColor(o.fill) ? String(o.fill).trim() : base.fill,
          opacity: opacity !== undefined ? Math.min(1, Math.max(0, opacity)) : base.opacity,
          stroke: validColor(o.stroke) ? String(o.stroke).trim() : base.stroke,
          strokeWidth: toNum(o.stroke_width) ?? base.strokeWidth,
          dashed: typeof o.dashed === 'boolean' ? o.dashed || undefined : base.dashed,
          hatch: typeof o.hatch === 'boolean' ? o.hatch || undefined : base.hatch,
          clip: o.clip !== undefined ? clipMode(o.clip, 'land') : base.clip,
        };
      };
      const shared: AreaStyle = { ...style(a), label: undefined };
      const pending: Omit<MapArea, 'id'>[] = [];
      const existing = a.replace === true ? [] : map().areas;
      const used = new Set(existing.map((x) => x.fill));
      const palette = CATEGORICAL.Tableau10.filter((c) => !used.has(c));
      let nextColor = 0;
      const autoColor = () => palette[nextColor++ % palette.length] ?? CATEGORICAL.Tableau10[nextColor % 10];

      for (const [i, ar] of (Array.isArray(a.areas) ? (a.areas as Args[]) : []).entries()) {
        const what = optStr(ar.label) ? `"${optStr(ar.label)}"` : `area ${i + 1}`;
        const smooth = typeof ar.smooth === 'boolean' ? ar.smooth : a.smooth === true;
        const geoms: AreaGeometry[] = [];
        const addPolygon = (v: unknown) => {
          const r = rings(v);
          const p = r && polygonFromRings(r, smooth);
          if (p) geoms.push(p);
          else errors.push(`${what}: a polygon needs at least 3 [lon, lat] points`);
        };
        if (ar.polygon !== undefined) addPolygon(ar.polygon);
        if (Array.isArray(ar.polygons)) ar.polygons.forEach(addPolygon);
        if (ar.bbox !== undefined) {
          const b = bbox(ar.bbox);
          const p = b && bboxPolygon(b);
          if (p) geoms.push(p);
          else errors.push(`${what}: bbox must be [west, south, east, north]`);
        }
        if (ar.circle !== undefined) {
          const c = (ar.circle ?? {}) as Args;
          const pt = coord(c);
          const radius = toNum(c.radius_km);
          if (pt && radius && radius > 0) geoms.push(circlePolygon(pt[0], pt[1], radius));
          else errors.push(`${what}: circle needs lon, lat and a positive radius_km`);
        }
        if (!geoms.length) {
          if (ar.polygon === undefined && ar.polygons === undefined && ar.bbox === undefined && ar.circle === undefined) {
            errors.push(`${what}: give polygon, polygons, bbox or circle`);
          }
          continue;
        }
        const s = style(ar, shared);
        pending.push({ geometry: mergeGeometries(geoms)[0], ...s, clip: s.clip ?? 'land', fill: s.fill ?? (s.hatch || !s.stroke ? autoColor() : 'none') });
      }

      const url = optStr(a.geojson_url);
      if (url) {
        const colorBy = optStr(a.color_by);
        const res = await loadData<GeojsonResult>(
          'load_geojson',
          { url, where: a.where, keep: [colorBy, 'name'].filter(Boolean), preview: a.preview === true },
          signal,
        );
        const props = JSON.stringify(res.properties);
        const summary = `${res.matched} of ${res.total} features match${a.where ? ` ${JSON.stringify(a.where)}` : ''} (${res.geometryTypes.join(', ') || 'none'}). Properties: ${props}`;
        if (a.preview === true) return `GeoJSON preview: ${summary}`;
        if (!res.features.length) errors.push(`no drawable GeoJSON features: ${summary}`);
        const prop = (p: Record<string, unknown>, key: string) => p[Object.keys(p).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key];
        const groups = new Map<string, { geoms: AreaGeometry[]; names: string[] }>();
        for (const f of res.features) {
          const g = normalizeGeometry(f.geometry);
          if (!g) continue;
          const key = colorBy ? String(prop(f.properties, colorBy) ?? 'Other') : '';
          let group = groups.get(key);
          if (!group) groups.set(key, (group = { geoms: [], names: [] }));
          group.geoms.push(g);
          const name = prop(f.properties, 'name');
          if (name) group.names.push(String(name));
        }
        const colorMap = a.colors && typeof a.colors === 'object' ? (a.colors as Args) : {};
        const lookup = (key: string) => {
          const hit = Object.keys(colorMap).find((k) => k.toLowerCase() === key.toLowerCase());
          return hit && validColor(colorMap[hit]) ? String(colorMap[hit]).trim() : undefined;
        };
        const described: string[] = [];
        for (const [key, group] of groups) {
          const color = (colorBy ? lookup(key) : undefined) ?? shared.fill ?? autoColor();
          const label = colorBy ? key : optStr(a.label);
          for (const geometry of mergeGeometries(group.geoms)) {
            const line = geometry.type === 'LineString' || geometry.type === 'MultiLineString';
            pending.push({
              geometry,
              ...shared,
              label,
              fill: line ? 'none' : color,
              stroke: line ? (colorBy ? color : (shared.stroke ?? color)) : shared.stroke,
              strokeWidth: line ? (shared.strokeWidth ?? 1.2) : shared.strokeWidth,
              clip: shared.clip ?? 'none',
            });
          }
          const names = [...new Set(group.names)];
          described.push(
            `${label ? `"${label}" ` : ''}${group.geoms.length} feature(s)${names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}` : ''}`,
          );
        }
        if (groups.size) notes.push(`GeoJSON: ${described.join('; ')}.${res.truncated ? ' Only the first 5000 features were used.' : ''}${res.skipped ? ` Skipped ${res.skipped} point feature(s); use add_markers for points.` : ''}`);
      }

      if (!pending.length) return `Nothing drawn.${errorsNote(errors)}`;
      const added: string[] = [];
      update((m) => {
        if (a.replace === true) m.areas = [];
        for (const p of pending) {
          const id = nextId('a', m.areas);
          m.areas.push({ id, ...p });
          added.push(id);
        }
        if (a.add_to_legend !== false) {
          const labelled = pending.filter((p) => p.label);
          if (labelled.length) {
            m.legend ??= { items: [] };
            for (const p of labelled) {
              const color = p.fill && p.fill !== 'none' ? p.fill : (p.stroke ?? '#888');
              const existingItem = m.legend.items.find((it) => it.label === p.label);
              if (existingItem) Object.assign(existingItem, { color, hatch: p.hatch });
              else m.legend.items.push({ color, label: p.label!, ...(p.hatch ? { hatch: true } : {}) });
            }
          }
          if (optStr(a.legend_title)) (m.legend ??= { items: [] }).title = optStr(a.legend_title);
        }
      });
      const list = added.map((id, k) => {
        const p = pending[k];
        return `${id}${p.label ? ` "${p.label}"` : ''} ${p.geometry.type} ${vertexCount(p.geometry)} pts clip=${p.clip ?? 'none'}`;
      });
      return `Drew ${added.length} area(s): ${list.slice(0, 20).join('; ')}${list.length > 20 ? '; …' : ''}.${notes.length ? ' ' + notes.join(' ') : ''}${errorsNote(errors)}`;
    },
  },
  {
    name: 'show_subdivisions',
    description: 'Draw (or hide) the first-level subdivisions (states, provinces, regions…) of countries so they can be coloured/labelled individually. Returns their ids.',
    parameters: {
      type: 'object',
      properties: {
        countries: { type: 'array', items: { type: 'string' } },
        show: { type: 'boolean', description: 'Default true; false hides them' },
      },
      required: ['countries'],
    },
    run: async (a) => {
      const out: string[] = [];
      const ok: string[] = [];
      for (const ref of strList(a.countries)) {
        const cid = await geo.resolveCountry(ref);
        if (!cid) out.push(`Unknown country "${ref}".`);
        else if (!geo.hasSubdivisions(cid)) out.push(`No subdivision data for ${cid}.`);
        else {
          const subs = await geo.loadSubdivisions(cid);
          ok.push(cid);
          if (a.show !== false) out.push(`${cid}: ${subs.length} subdivisions — ${subs.map((f) => `${f.id}=${f.properties.name}`).join('; ')}`);
        }
      }
      update((m) => {
        if (a.show === false) m.subdivisions = m.subdivisions.filter((c) => !ok.includes(c));
        else for (const c of ok) if (!m.subdivisions.includes(c)) m.subdivisions.push(c);
      });
      return a.show === false ? `Hid subdivisions of ${ok.join(', ') || 'nothing'}.` + out.join('\n') : out.join('\n');
    },
  },
  {
    name: 'add_labels',
    description:
      'Add text labels. Either give explicit `labels` (each anchored to a region or lon/lat), or give `regions` to label many regions at once using `template`. ' +
      'Templates may use {name}, {id} and {value} (the region\'s choropleth value, formatted). Labels keep a constant on-screen size.',
    parameters: {
      type: 'object',
      properties: {
        labels: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Defaults to the region name' },
              region: { type: 'string' },
              lon: { type: 'number' },
              lat: { type: 'number' },
              size: { type: 'number', description: 'Font size in px (default 14)' },
              color: { type: 'string' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              halo: { type: 'boolean', description: 'Outline for legibility (default true)' },
              dx: { type: 'number', description: 'Horizontal pixel offset' },
              dy: { type: 'number', description: 'Vertical pixel offset' },
            },
          },
        },
        regions: { type: 'array', items: { type: 'string' }, description: 'Regions to label using `template`' },
        template: { type: 'string', description: 'Default "{name}"; e.g. "{name}\\n{value}"' },
        country: COUNTRY_PARAM,
        size: { type: 'number' },
        color: { type: 'string' },
        bold: { type: 'boolean' },
        halo: { type: 'boolean' },
      },
    },
    run: async (a) => {
      const country = optStr(a.country);
      const errors: string[] = [];
      const pending: Omit<MapLabel, 'id'>[] = [];
      const m0 = map();
      const cp = m0.choropleth;
      const fmt = cp ? makeFormatter(Object.values(cp.values), cp.format, cp.unit) : undefined;
      const common = {
        size: toNum(a.size),
        color: validColor(a.color) ? String(a.color) : undefined,
        bold: typeof a.bold === 'boolean' ? a.bold : undefined,
        halo: typeof a.halo === 'boolean' ? a.halo : undefined,
      };
      const fill = (tpl: string, id?: string) => {
        const info = id ? geo.get(id) : undefined;
        const v = id && cp ? cp.values[id] : undefined;
        return tpl
          .replace(/\{name\}/g, info?.name ?? '')
          .replace(/\{id\}/g, id ?? '')
          .replace(/\{value\}/g, v !== undefined && fmt ? fmt(v) : '')
          .replace(/\\n/g, '\n')
          .trim();
      };

      if (Array.isArray(a.regions)) {
        const { ids, errors: e } = await geo.resolveMany(strList(a.regions), country);
        errors.push(...e);
        const tpl = optStr(a.template) ?? '{name}';
        for (const id of ids) {
          const pt = geo.labelPoint(id);
          const text = fill(tpl, id);
          if (pt && text) pending.push({ text, lon: round(pt[0]), lat: round(pt[1]), regionId: id, ...common });
        }
      }
      for (const l of Array.isArray(a.labels) ? (a.labels as Args[]) : []) {
        let pt = coord(l);
        let regionId: string | undefined;
        if (optStr(l.region)) {
          const res = await geo.resolve(String(l.region), country);
          if ('error' in res) {
            errors.push(res.error);
            continue;
          }
          regionId = res.id;
          pt ??= geo.labelPoint(res.id);
        }
        if (!pt) {
          errors.push(`label ${JSON.stringify(l.text ?? '')} needs a region or lon/lat`);
          continue;
        }
        const text = optStr(l.text) ? fill(String(l.text), regionId) : regionId ? geo.get(regionId)!.name : '';
        if (!text) continue;
        pending.push({
          text,
          lon: round(pt[0]),
          lat: round(pt[1]),
          regionId,
          size: toNum(l.size) ?? common.size,
          color: validColor(l.color) ? String(l.color) : common.color,
          bold: typeof l.bold === 'boolean' ? l.bold : common.bold,
          italic: l.italic === true || undefined,
          halo: typeof l.halo === 'boolean' ? l.halo : common.halo,
          dx: toNum(l.dx),
          dy: toNum(l.dy),
        });
      }
      const added: string[] = [];
      update((m) => {
        for (const p of pending) {
          const id = nextId('l', m.labels);
          m.labels.push({ id, ...p });
          added.push(id);
        }
      });
      return `Added ${added.length} label(s)${added.length ? ` (${added[0]}${added.length > 1 ? `–${added[added.length - 1]}` : ''})` : ''}.${errorsNote(errors)}`;
    },
  },
  {
    name: 'add_markers',
    description: 'Add point markers (cities, events…) at lon/lat coordinates, with optional labels. Use geocode or Wikidata to find coordinates.',
    parameters: {
      type: 'object',
      properties: {
        markers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              lon: { type: 'number' },
              lat: { type: 'number' },
              label: { type: 'string' },
              color: { type: 'string' },
              size: { type: 'number', description: 'Radius in px (default 5)' },
              shape: { type: 'string', enum: ['circle', 'square', 'triangle', 'star', 'diamond'] },
            },
            required: ['lon', 'lat'],
          },
        },
      },
      required: ['markers'],
    },
    run: async (a) => {
      const errors: string[] = [];
      const added: string[] = [];
      update((m) => {
        for (const mk of Array.isArray(a.markers) ? (a.markers as Args[]) : []) {
          const pt = coord(mk);
          if (!pt) {
            errors.push(`bad coordinates ${JSON.stringify(mk)}`);
            continue;
          }
          const id = nextId('m', m.markers);
          const marker: MapMarker = {
            id,
            lon: round(pt[0]),
            lat: round(pt[1]),
            label: optStr(mk.label),
            color: validColor(mk.color) ? String(mk.color) : undefined,
            size: toNum(mk.size),
            shape: (['circle', 'square', 'triangle', 'star', 'diamond'].includes(String(mk.shape)) ? mk.shape : undefined) as MarkerShape | undefined,
          };
          m.markers.push(marker);
          added.push(id);
        }
      });
      return `Added ${added.length} marker(s): ${added.join(', ')}.${errorsNote(errors)}`;
    },
  },
  {
    name: 'add_lines',
    description: 'Draw lines/routes between coordinates: geodesic (great-circle, default), arc (curved flow line) or straight. Optional arrowhead, dashes and label.',
    parameters: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[lon, lat], [lon, lat], ...] (at least 2)' },
              color: { type: 'string' },
              width: { type: 'number', description: 'Stroke width in px (default 2)' },
              dashed: { type: 'boolean' },
              style: { type: 'string', enum: ['geodesic', 'arc', 'straight'] },
              arrow: { type: 'boolean' },
              label: { type: 'string' },
            },
            required: ['points'],
          },
        },
      },
      required: ['lines'],
    },
    run: async (a) => {
      const errors: string[] = [];
      const added: string[] = [];
      update((m) => {
        for (const ln of Array.isArray(a.lines) ? (a.lines as Args[]) : []) {
          const pts = (Array.isArray(ln.points) ? ln.points : []).map(coord).filter(Boolean) as [number, number][];
          if (pts.length < 2) {
            errors.push('a line needs at least 2 valid [lon, lat] points');
            continue;
          }
          const id = nextId('ln', m.lines);
          const line: MapLine = {
            id,
            points: pts.map(([x, y]) => [round(x), round(y)]),
            color: validColor(ln.color) ? String(ln.color) : undefined,
            width: toNum(ln.width),
            dashed: ln.dashed === true || undefined,
            style: (['geodesic', 'arc', 'straight'].includes(String(ln.style)) ? ln.style : 'geodesic') as MapLine['style'],
            arrow: ln.arrow === true || undefined,
            label: optStr(ln.label),
          };
          m.lines.push(line);
          added.push(id);
        }
      });
      return `Added ${added.length} line(s): ${added.join(', ')}.${errorsNote(errors)}`;
    },
  },
  {
    name: 'set_title',
    description: 'Set the map title, subtitle and source/credit caption (drawn on the map and included in exports). Omit a field to keep it; pass "" to remove it.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        subtitle: { type: 'string' },
        source: { type: 'string', description: 'e.g. "Source: World Bank (2024)"' },
      },
    },
    run: async (a) => {
      update((m) => {
        for (const k of ['title', 'subtitle', 'source'] as const) {
          if (isStr(a[k])) m[k] = (a[k] as string).trim() || undefined;
        }
      });
      return 'Title updated.';
    },
  },
  {
    name: 'set_legend',
    description: 'Set the manual (categorical) legend entries and/or its title and position. Choropleth legends are generated automatically and shown alongside.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: { type: 'object', properties: { color: { type: 'string' }, label: { type: 'string' } }, required: ['color', 'label'] },
          description: 'Replaces the existing manual legend entries',
        },
        position: { type: 'string', enum: ['bottom-left', 'bottom-right', 'top-left', 'top-right'], description: 'Snap to a corner (discards a position the user dragged it to)' },
        scale: { type: 'number', description: 'Size multiplier, 0.4–3 (default 1). The user can also drag and resize the legend.' },
      },
    },
    run: async (a) => {
      update((m) => {
        if (Array.isArray(a.items)) {
          m.legend = {
            title: m.legend?.title,
            items: (a.items as Args[]).filter((i) => validColor(i.color) && optStr(i.label)).map((i) => ({ color: String(i.color), label: String(i.label) })),
          };
        }
        if (isStr(a.title)) (m.legend ??= { items: [] }).title = a.title.trim() || undefined;
        if (isStr(a.position)) {
          m.legendPosition = a.position as MapState['legendPosition'];
          if (m.legendLayout) m.legendLayout = { scale: m.legendLayout.scale };
        }
        const scale = toNum(a.scale);
        if (scale !== undefined) m.legendLayout = { ...m.legendLayout, scale: Math.min(3, Math.max(0.4, scale)) };
      });
      return 'Legend updated.';
    },
  },
  {
    name: 'set_style',
    description:
      'Change base styling. Colours accept any CSS colour; pass "default" to restore the theme default. `only_countries` hides every other country (e.g. a Europe-only map); pass [] to show all again.',
    parameters: {
      type: 'object',
      properties: {
        ocean: { type: 'string' },
        land: { type: 'string', description: 'Default fill for uncoloured land' },
        border: { type: 'string' },
        border_width: { type: 'number' },
        subdivision_border: { type: 'string' },
        background: { type: 'string', description: 'Area outside the globe outline' },
        text_color: { type: 'string' },
        font: { type: 'string', description: 'CSS font-family' },
        graticule: { type: 'boolean', description: 'Latitude/longitude grid lines' },
        only_countries: { type: 'array', items: { type: 'string' } },
      },
    },
    run: async (a) => {
      const errors: string[] = [];
      let visible: string[] | undefined;
      if (Array.isArray(a.only_countries)) {
        const { ids, errors: e } = await geo.resolveMany(strList(a.only_countries));
        errors.push(...e);
        visible = ids.filter((id) => geo.get(id)?.kind === 'country');
      }
      update((m) => {
        const colorKeys: [string, keyof MapState['style']][] = [
          ['ocean', 'ocean'],
          ['land', 'land'],
          ['border', 'border'],
          ['subdivision_border', 'subdivisionBorder'],
          ['background', 'background'],
          ['text_color', 'textColor'],
        ];
        for (const [arg, key] of colorKeys) {
          const v = a[arg];
          if (v === 'default' || v === '') delete m.style[key];
          else if (validColor(v)) (m.style as Record<string, unknown>)[key] = v;
          else if (v !== undefined) errors.push(`invalid colour for ${arg}: ${JSON.stringify(v)}`);
        }
        if (isNum(a.border_width)) m.style.borderWidth = a.border_width;
        if (typeof a.graticule === 'boolean') m.style.graticule = a.graticule;
        if (isStr(a.font)) m.style.font = a.font.trim() || undefined;
        if (visible) m.visibleCountries = visible.length ? visible : undefined;
      });
      return `Style updated.${visible ? ` Showing ${visible.length || 'all'} countries.` : ''}${errorsNote(errors)}`;
    },
  },
  {
    name: 'zoom_to',
    description:
      'Frame the map on regions or a bounding box (reprojects so the area fills the view; conic/azimuthal projections re-centre on it). ' +
      'A single "continent:Europe" (or Africa, Asia, North America, South America, Oceania, Middle East) uses a conventional continent framing. Use reset=true to show the whole world again.',
    parameters: {
      type: 'object',
      properties: {
        regions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["continent:Europe"] or ["USA"] or ["DEU","POL"]' },
        bbox: { type: 'array', items: { type: 'number' }, description: '[west, south, east, north] in degrees' },
        country: COUNTRY_PARAM,
        padding: { type: 'number', description: 'Extra margin as a fraction of the size (default 0.05)' },
        reset: { type: 'boolean' },
      },
    },
    run: async (a) => {
      if (a.reset === true) {
        update((m) => {
          m.focus = undefined;
          m.view = { k: 1, x: 0, y: 0 };
        });
        return 'Showing the whole world.';
      }
      let box: [number, number, number, number] | undefined;
      let errors: string[] = [];
      if (Array.isArray(a.bbox) && a.bbox.length === 4) {
        const b = a.bbox.map(Number);
        if (b.every(Number.isFinite)) box = [b[0], b[1], b[2], b[3]];
      } else if (Array.isArray(a.regions)) {
        const refs = strList(a.regions);
        const preset = refs.length === 1 ? CONTINENT_FRAMES[refs[0].toLowerCase().replace(/^continents*:s*/, '')] : undefined;
        if (preset) {
          update((m) => {
            m.focus = preset;
            m.view = { k: 1, x: 0, y: 0 };
          });
          return `Framed map on ${refs[0]} [${preset.join(', ')}].`;
        }
        const res = await geo.resolveMany(refs, optStr(a.country));
        errors = res.errors;
        box = geo.bounds(res.ids);
      }
      if (!box) return `Nothing to zoom to.${errorsNote(errors)}`;
      const pad = toNum(a.padding) ?? 0.05;
      let [w, s, e, n] = box;
      const width = (e < w ? e + 360 : e) - w;
      const dx = width * pad;
      const dy = (n - s) * pad;
      w -= dx;
      e += dx;
      s = Math.max(-89, s - dy);
      n = Math.min(89, n + dy);
      if (w < -180) w += 360;
      if (e > 180) e -= 360;
      const focus: [number, number, number, number] = width + 2 * dx >= 350 ? [-180, s, 180, n] : [round(w), round(s), round(e), round(n)];
      update((m) => {
        m.focus = focus;
        m.view = { k: 1, x: 0, y: 0 };
      });
      return `Framed map on [${focus.join(', ')}].${errorsNote(errors)}`;
    },
  },
  {
    name: 'remove_elements',
    description:
      'Remove things from the map. `what` lists element kinds to clear: colors, choropleth, field, areas, labels, markers, lines, legend, title, subdivisions, style, focus. ' +
      'With `ids`, only those elements are removed (area/label/marker/line ids like a2, l3, m1, ln2, or region refs for colors, or country ids for subdivisions).',
    parameters: {
      type: 'object',
      properties: {
        what: {
          type: 'array',
          items: { type: 'string', enum: ['colors', 'choropleth', 'field', 'areas', 'labels', 'markers', 'lines', 'legend', 'title', 'subdivisions', 'style', 'focus'] },
        },
        ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['what'],
    },
    run: async (a) => {
      const what = strList(a.what);
      const ids = Array.isArray(a.ids) ? strList(a.ids) : undefined;
      let regionIds: string[] | undefined;
      if (ids && (what.includes('colors') || what.includes('subdivisions'))) regionIds = (await geo.resolveMany(ids)).ids;
      update((m) => {
        const keep = <T extends { id: string }>(list: T[]) => (ids ? list.filter((x) => !ids.includes(x.id)) : []);
        if (what.includes('colors')) {
          if (regionIds) for (const id of regionIds) delete m.regions[id];
          else m.regions = {};
        }
        if (what.includes('choropleth')) m.choropleth = undefined;
        if (what.includes('field')) m.field = undefined;
        if (what.includes('areas')) m.areas = keep(m.areas);
        if (what.includes('labels')) m.labels = keep(m.labels);
        if (what.includes('markers')) m.markers = keep(m.markers);
        if (what.includes('lines')) m.lines = keep(m.lines);
        if (what.includes('legend')) m.legend = undefined;
        if (what.includes('title')) m.title = m.subtitle = m.source = undefined;
        if (what.includes('subdivisions')) m.subdivisions = regionIds ? m.subdivisions.filter((c) => !regionIds!.includes(c)) : [];
        if (what.includes('style')) {
          m.style = { graticule: false };
          m.visibleCountries = undefined;
        }
        if (what.includes('focus')) {
          m.focus = undefined;
          m.view = { k: 1, x: 0, y: 0 };
        }
      });
      return `Removed ${what.join(', ')}${ids ? ` (${ids.join(', ')})` : ''}.`;
    },
  },
  {
    name: 'reset_map',
    description: 'Clear everything and return to a blank world map.',
    parameters: { type: 'object', properties: { keep_projection: { type: 'boolean' } } },
    run: async (a) => {
      const { projection } = map();
      useMapStore.getState().setMap({ ...emptyMapState(), ...(a.keep_projection === true ? { projection } : {}) });
      return 'Map reset.';
    },
  },
];

// ---- research tools (executed by the local server) ----------------------------------

const researchTools: ToolDef[] = [
  {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo, falls back to Wikipedia). Returns titles, URLs and snippets; follow up with fetch_url.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a public web page, JSON API or CSV and return it as text (HTML tables become "a | b | c" rows). Long documents are paginated: continue with start=<offset>. ' +
      'Useful open data: World Bank API (https://api.worldbank.org/v2/country/all/indicator/SP.POP.TOTL?format=json&date=2023&per_page=400), ' +
      'Our World in Data grapher CSVs (https://ourworldindata.org/grapher/<slug>.csv), REST Countries (https://restcountries.com/v3.1/all?fields=cca3,name,population).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' }, start: { type: 'integer' }, max_chars: { type: 'integer', description: 'Default 12000, max 40000' } },
      required: ['url'],
    },
  },
  {
    name: 'wikipedia_search',
    description: 'Search Wikipedia article titles.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, lang: { type: 'string', description: 'Wiki language code, default en' }, limit: { type: 'integer' } }, required: ['query'] },
  },
  {
    name: 'wikipedia_page',
    description: 'Read a Wikipedia article as text including its tables (great for "List of countries by …" pages). Paginated: continue with start=<offset>.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' }, lang: { type: 'string' }, start: { type: 'integer' }, max_chars: { type: 'integer' } },
      required: ['title'],
    },
  },
  {
    name: 'wikidata_sparql',
    description:
      'Run a SPARQL query on the Wikidata Query Service; returns TSV. Tip: countries have ISO3 codes in wdt:P298, subdivisions ISO 3166-2 in wdt:P300, ' +
      'population P1082, area P2046, coordinates P625, instance-of P31 (sovereign state Q3624078). Use SERVICE wikibase:label for names.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'geocode',
    description: 'Look up coordinates of a place name via OpenStreetMap Nominatim.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
  },
];

async function runResearch(name: string, args: Args, signal: AbortSignal): Promise<string> {
  const res = await fetch(`/api/tools/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal,
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (data.error) throw new Error(data.error);
  return String(data.result);
}

// ---- registry -----------------------------------------------------------------------------

export const TOOL_DEFS: ToolDef[] = [
  ...mapTools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  ...researchTools,
];

export const MAP_TOOL_NAMES = new Set(mapTools.map((t) => t.name));

export async function executeTool(name: string, args: Args, signal: AbortSignal): Promise<string> {
  const mapTool = mapTools.find((t) => t.name === name);
  if (mapTool) return mapTool.run(args, signal);
  if (researchTools.some((t) => t.name === name)) return runResearch(name, args, signal);
  throw new Error(`Unknown tool "${name}"`);
}

// ---- map summary for the model -------------------------------------------------------

export function summarizeMap(m: MapState) {
  const byColor: Record<string, string[]> = {};
  for (const [id, s] of Object.entries(m.regions)) if (s.fill) (byColor[s.fill] ??= []).push(id);
  const cp = m.choropleth;
  return {
    projection: m.projection,
    focus: m.focus,
    title: m.title,
    subtitle: m.subtitle,
    source: m.source,
    colors: byColor,
    choropleth: cp && {
      regions: Object.keys(cp.values).length,
      scheme: cp.scheme,
      method: cp.method,
      classes: cp.classes,
      breaks: cp.breaks,
      title: cp.title,
      unit: cp.unit,
      values: Object.fromEntries(Object.entries(cp.values).slice(0, 60)),
    },
    field: m.field && {
      data: m.field.origin ?? (m.field.data.kind === 'points' ? `${m.field.data.points.length} points` : `${m.field.data.lats.length}×${m.field.data.lons.length} grid`),
      bbox: m.field.bbox,
      clip: m.field.clip,
      scheme: m.field.colors ? undefined : m.field.scheme,
      colors: m.field.colors,
      method: m.field.method,
      breaks: m.field.breaks,
      domain: m.field.domain,
      title: m.field.title,
      unit: m.field.unit,
      opacity: m.field.opacity,
    },
    areas: m.areas.map(
      (a) =>
        `${a.id}: ${a.label ?? ''} ${a.geometry.type} ${vertexCount(a.geometry)} pts fill=${a.fill ?? 'none'}` +
        `${a.hatch ? ' hatched' : ''}${a.opacity !== undefined ? ` opacity=${a.opacity}` : ''}${a.stroke ? ` stroke=${a.stroke}` : ''} clip=${a.clip ?? 'none'}`,
    ),
    subdivisions: m.subdivisions,
    labels: m.labels.map((l) => `${l.id}: ${l.text.replace(/\n/g, ' / ')}`),
    markers: m.markers.map((k) => `${k.id}: ${k.label ?? ''} (${k.lon}, ${k.lat})`),
    lines: m.lines.map((l) => `${l.id}: ${l.label ?? ''} ${l.points.length} pts`),
    legend: m.legend,
    legendPosition: m.legendLayout?.x !== undefined ? `dragged to (${m.legendLayout.x}, ${m.legendLayout.y}) of 1600×1000` : m.legendPosition,
    legendScale: m.legendLayout?.scale,
    style: m.style,
    visibleCountries: m.visibleCountries,
    userZoom: m.view.k !== 1 ? m.view : undefined,
  };
}

/** One-line description of the map, attached to each user message so the model notices manual changes. */
export function briefMapState(m: MapState): string {
  const parts = [`projection=${m.projection.id}`];
  if (m.projection.angle) parts.push(`rotated ${m.projection.angle}° clockwise`);
  if (m.focus) parts.push(`focus=[${m.focus.join(',')}]`);
  if (m.title) parts.push(`title="${m.title}"`);
  const colored = Object.keys(m.regions).length;
  if (colored) parts.push(`${colored} regions manually coloured`);
  if (m.choropleth) parts.push(`choropleth on ${Object.keys(m.choropleth.values).length} regions (${m.choropleth.title ?? 'untitled'})`);
  if (m.field) parts.push(`field (${m.field.title ?? m.field.origin ?? 'untitled'})`);
  if (m.areas.length) parts.push(`${m.areas.length} areas`);
  if (m.subdivisions.length) parts.push(`subdivisions shown for ${m.subdivisions.join(',')}`);
  if (m.labels.length) parts.push(`${m.labels.length} labels`);
  if (m.markers.length) parts.push(`${m.markers.length} markers`);
  if (m.lines.length) parts.push(`${m.lines.length} lines`);
  if (m.legend?.items.length) parts.push(`legend with ${m.legend.items.length} items`);
  return parts.join('; ');
}
