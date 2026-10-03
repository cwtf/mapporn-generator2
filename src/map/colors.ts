import { extent, quantile } from 'd3-array';
import { format as d3format } from 'd3-format';
import { interpolateRgbBasis } from 'd3-interpolate';
import * as chromatic from 'd3-scale-chromatic';
import type { Choropleth, ColorScale, MapStyle } from './types';

export interface ResolvedStyle {
  ocean: string;
  land: string;
  border: string;
  borderWidth: number;
  subdivisionBorder: string;
  graticule: boolean;
  graticuleColor: string;
  background: string;
  textColor: string;
  panel: string;
  font: string;
}

const THEMES: Record<'light' | 'dark', Omit<ResolvedStyle, 'graticule' | 'borderWidth' | 'font'>> = {
  light: {
    ocean: '#cfe2ee',
    land: '#efebe3',
    border: '#8d8a84',
    subdivisionBorder: '#b3aea6',
    graticuleColor: '#aac6d8',
    background: '#f7f6f2',
    textColor: '#1d1f23',
    panel: '#ffffff',
  },
  dark: {
    ocean: '#101c2a',
    land: '#2c3038',
    border: '#6a717e',
    subdivisionBorder: '#4c525d',
    graticuleColor: '#1f3246',
    background: '#0c1219',
    textColor: '#e8e9ec',
    panel: '#161b22',
  },
};

export const DEFAULT_FONT = "'Inter', 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif";

export function resolveStyle(style: MapStyle, theme: 'light' | 'dark'): ResolvedStyle {
  const t = THEMES[theme];
  return {
    ocean: style.ocean ?? t.ocean,
    land: style.land ?? t.land,
    border: style.border ?? t.border,
    borderWidth: style.borderWidth ?? 0.6,
    subdivisionBorder: style.subdivisionBorder ?? t.subdivisionBorder,
    graticule: style.graticule ?? false,
    graticuleColor: t.graticuleColor,
    background: style.background ?? t.background,
    textColor: style.textColor ?? t.textColor,
    panel: t.panel,
    font: style.font ?? DEFAULT_FONT,
  };
}

// ---- colour schemes ------------------------------------------------------------

type Interp = (t: number) => string;

const SEQUENTIAL = [
  'Blues', 'Greens', 'Greys', 'Oranges', 'Purples', 'Reds', 'BuGn', 'BuPu', 'GnBu', 'OrRd', 'PuBuGn', 'PuBu',
  'PuRd', 'RdPu', 'YlGnBu', 'YlGn', 'YlOrBr', 'YlOrRd',
] as const;
const PERCEPTUAL = ['Viridis', 'Inferno', 'Magma', 'Plasma', 'Cividis', 'Turbo', 'Warm', 'Cool', 'Rainbow', 'Sinebow'] as const;
const DIVERGING = ['BrBG', 'PRGn', 'PiYG', 'PuOr', 'RdBu', 'RdGy', 'RdYlBu', 'RdYlGn', 'Spectral'] as const;
/** Cartographic ramps d3-scale-chromatic lacks: hypsometric tints for land, depth tints for sea. */
const CUSTOM: Record<string, string[]> = {
  Terrain: ['#4f8f4a', '#9dc36f', '#e8e3a0', '#d8a863', '#a8703f', '#8a6d5e', '#f4f4f2'],
  Bathymetry: ['#0b2a5b', '#15528f', '#2f7fbf', '#6aaed6', '#b9daee'],
};

export const SCHEME_NAMES = [...SEQUENTIAL, ...PERCEPTUAL, ...DIVERGING, ...Object.keys(CUSTOM)];

export const CATEGORICAL: Record<string, readonly string[]> = {
  Tableau10: chromatic.schemeTableau10,
  Category10: chromatic.schemeCategory10,
  Set1: chromatic.schemeSet1,
  Set2: chromatic.schemeSet2,
  Set3: chromatic.schemeSet3,
  Dark2: chromatic.schemeDark2,
  Paired: chromatic.schemePaired,
  Pastel1: chromatic.schemePastel1,
  Accent: chromatic.schemeAccent,
};

function interpolator(name: string): { fn: Interp; lo: number; hi: number } {
  const key = SCHEME_NAMES.find((n) => n.toLowerCase() === name.toLowerCase()) ?? 'Blues';
  if (CUSTOM[key]) return { fn: interpolateRgbBasis(CUSTOM[key]), lo: 0, hi: 1 };
  const fn = (chromatic as unknown as Record<string, Interp>)[`interpolate${key}`];
  // Light ends of sequential schemes are near-white and vanish against the land colour.
  const lo = (SEQUENTIAL as readonly string[]).includes(key) ? 0.15 : 0;
  return { fn, lo, hi: 1 };
}

export function sampleScheme(name: string, n: number, reverse = false): string[] {
  const { fn, lo, hi } = interpolator(name);
  const out = Array.from({ length: n }, (_, i) => fn(n === 1 ? hi : lo + ((hi - lo) * i) / (n - 1)));
  return reverse ? out.reverse() : out;
}

// ---- colour scales ------------------------------------------------------------

export interface ChoroplethLegend {
  title?: string;
  items?: { color: string; label: string }[];
  gradient?: { stops: string[]; min: string; max: string };
  noData?: string;
}

export interface ChoroplethResult {
  colorOf: (id: string) => string | undefined;
  legend: ChoroplethLegend;
}

export interface Scale {
  colorAt: (v: number) => string;
  /** Lower bounds of every class above the first (empty for continuous scales) */
  breaks: number[];
  continuous: boolean;
  min: number;
  max: number;
  legend: ChoroplethLegend;
}

export function makeFormatter(values: number[], fmt?: string, unit?: string): (v: number) => string {
  let f: (v: number) => string;
  if (fmt) {
    try {
      f = d3format(fmt);
    } catch {
      f = d3format(',');
    }
  } else {
    const max = Math.max(...values.map(Math.abs));
    if (max >= 1e6) f = (v) => d3format('.3~s')(v).replace(/G$/, 'B');
    else if (max >= 1000) f = d3format(',.0f');
    else if (max >= 10) f = d3format(',.1~f');
    else f = d3format('.3~g');
  }
  if (!unit) return f;
  const glue = /^[%‰°]/.test(unit) ? '' : ' ';
  return /^[$€£¥]/.test(unit) ? (v) => unit + f(v) : (v) => f(v) + glue + unit;
}

/** Classify numbers into colours (or a gradient) and describe the result as a legend. */
export function buildScale(values: number[], c: ColorScale): Scale {
  let [dmin, dmax] = c.domain ?? (extent(values) as [number, number]);
  if (!Number.isFinite(dmin) || !Number.isFinite(dmax)) [dmin, dmax] = [0, 1];
  const fmt = makeFormatter(values.length ? values : [dmin, dmax], c.format, c.unit);
  const legend: ChoroplethLegend = { title: c.title };
  const custom = c.colors?.length ? (c.colors.length === 1 ? [c.colors[0], c.colors[0]] : c.colors) : undefined;

  if (c.method === 'continuous') {
    const { fn, lo, hi } = custom ? { fn: interpolateRgbBasis(custom), lo: 0, hi: 1 } : interpolator(c.scheme);
    const span = dmax - dmin || 1;
    const colorAt = (v: number) => {
      let t = Math.min(1, Math.max(0, (v - dmin) / span));
      if (c.reverse) t = 1 - t;
      return fn(lo + (hi - lo) * t);
    };
    legend.gradient = {
      stops: Array.from({ length: 9 }, (_, i) => colorAt(dmin + (span * i) / 8)),
      min: fmt(dmin),
      max: fmt(dmax),
    };
    return { colorAt, breaks: [], continuous: true, min: dmin, max: dmax, legend };
  }

  let breaks: number[];
  if (c.method === 'threshold' && c.breaks?.length) {
    breaks = [...c.breaks].sort((a, b) => a - b);
  } else {
    const distinct = new Set(values).size;
    const n = Math.min(Math.max(c.classes ?? custom?.length ?? 5, 2), 9, Math.max(distinct, 2));
    if (c.method === 'quantile') {
      const sorted = [...values].sort((a, b) => a - b);
      breaks = Array.from({ length: n - 1 }, (_, i) => quantile(sorted, (i + 1) / n)!);
      breaks = [...new Set(breaks)];
    } else {
      breaks = Array.from({ length: n - 1 }, (_, i) => dmin + ((dmax - dmin) * (i + 1)) / n);
    }
  }
  const n = breaks.length + 1;
  let colors: string[];
  if (custom?.length === n) colors = c.reverse ? [...custom].reverse() : custom;
  else if (custom) {
    const fn = interpolateRgbBasis(custom);
    colors = Array.from({ length: n }, (_, i) => fn(i / (n - 1)));
    if (c.reverse) colors.reverse();
  } else colors = sampleScheme(c.scheme, n, c.reverse);
  const classOf = (v: number) => {
    let i = 0;
    while (i < breaks.length && v >= breaks[i]) i++;
    return i;
  };
  const threshold = c.method === 'threshold';
  legend.items = colors.map((color, i) => {
    let label: string;
    if (i === 0) label = threshold ? `< ${fmt(breaks[0])}` : `${fmt(dmin)} – ${fmt(breaks[0])}`;
    else if (i === breaks.length) label = threshold ? `≥ ${fmt(breaks[i - 1])}` : `${fmt(breaks[i - 1])} – ${fmt(dmax)}`;
    else label = `${fmt(breaks[i - 1])} – ${fmt(breaks[i])}`;
    return { color, label };
  });
  return { colorAt: (v) => colors[classOf(v)], breaks, continuous: false, min: dmin, max: dmax, legend };
}

export function computeChoropleth(c: Choropleth, noDataFallback: string): ChoroplethResult {
  const values = Object.values(c.values).filter((v) => Number.isFinite(v));
  if (!values.length) return { colorOf: () => undefined, legend: { title: c.title } };
  const scale = buildScale(values, c);
  const legend = scale.legend;
  if (c.showNoData !== false) legend.noData = c.noDataColor ?? noDataFallback;
  return { colorOf: (id) => (id in c.values ? scale.colorAt(c.values[id]) : undefined), legend };
}
