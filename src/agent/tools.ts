import { computeChoropleth, makeFormatter, SCHEME_NAMES } from '../map/colors';
import { geo } from '../map/geodata';
import { canTurn, normalizeAngle, PROJECTION_GROUPS, PROJECTION_IDS, PROJECTIONS } from '../map/projections';
import { emptyMapState, type ChoroplethMethod, type MapLabel, type MapLine, type MapMarker, type MapState, type MarkerShape } from '../map/types';
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
      `Schemes: ${SCHEME_NAMES.join(', ')}. Methods: quantize (equal intervals), quantile (equal counts), threshold (explicit breaks), continuous (smooth gradient).`,
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
        scheme: { type: 'string', description: 'Default YlOrRd; use diverging schemes (RdBu, BrBG, …) for data centred on a midpoint' },
        method: { type: 'string', enum: ['quantize', 'quantile', 'threshold', 'continuous'] },
        classes: { type: 'integer', description: 'Number of classes for quantize/quantile (2-9, default 5)' },
        breaks: { type: 'array', items: { type: 'number' }, description: 'Class breaks for method=threshold, ascending' },
        domain: { type: 'array', items: { type: 'number' }, description: 'Optional [min, max] override' },
        reverse: { type: 'boolean' },
        title: { type: 'string', description: 'Legend title, e.g. "GDP per capita (USD, 2024)"' },
        unit: { type: 'string', description: 'Unit appended to legend numbers, e.g. "%", "$", "km²"' },
        format: { type: 'string', description: 'd3-format specifier for legend numbers, e.g. ",.0f", ".1f", ".2s"' },
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
      const method = (['quantize', 'quantile', 'threshold', 'continuous'].includes(String(a.method)) ? a.method : 'quantize') as ChoroplethMethod;
      const nums = (v: unknown) => (Array.isArray(v) ? v.map(toNum).filter((x): x is number => x !== undefined) : undefined);
      const domain = nums(a.domain);
      let shown: string[] = [];
      const next = update((m) => {
        m.choropleth = {
          values,
          scheme: optStr(a.scheme) ?? 'YlOrRd',
          method,
          classes: toNum(a.classes),
          breaks: nums(a.breaks),
          domain: domain?.length === 2 ? [domain[0], domain[1]] : undefined,
          reverse: a.reverse === true,
          title: optStr(a.title),
          unit: optStr(a.unit),
          format: optStr(a.format),
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
      'Remove things from the map. `what` lists element kinds to clear: colors, choropleth, labels, markers, lines, legend, title, subdivisions, style, focus. ' +
      'With `ids`, only those elements are removed (label/marker/line ids like l3, m1, ln2, or region refs for colors, or country ids for subdivisions).',
    parameters: {
      type: 'object',
      properties: {
        what: {
          type: 'array',
          items: { type: 'string', enum: ['colors', 'choropleth', 'labels', 'markers', 'lines', 'legend', 'title', 'subdivisions', 'style', 'focus'] },
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
  if (m.subdivisions.length) parts.push(`subdivisions shown for ${m.subdivisions.join(',')}`);
  if (m.labels.length) parts.push(`${m.labels.length} labels`);
  if (m.markers.length) parts.push(`${m.markers.length} markers`);
  if (m.lines.length) parts.push(`${m.lines.length} lines`);
  if (m.legend?.items.length) parts.push(`legend with ${m.legend.items.length} items`);
  return parts.join('; ');
}
