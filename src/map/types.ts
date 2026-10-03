import type { LineString, MultiLineString, MultiPolygon, Polygon } from 'geojson';

/** Key of PROJECTIONS in projections.ts */
export type ProjectionId = string;

export type LonLat = [number, number];

export interface RegionStyle {
  fill?: string;
}

export interface MapLabel {
  id: string;
  text: string;
  lon: number;
  lat: number;
  size?: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  /** Draw a halo in the background colour behind the text for legibility. */
  halo?: boolean;
  /** Screen-space offset in px. */
  dx?: number;
  dy?: number;
  regionId?: string;
}

export type MarkerShape = 'circle' | 'square' | 'triangle' | 'star' | 'diamond';

export interface MapMarker {
  id: string;
  lon: number;
  lat: number;
  label?: string;
  color?: string;
  size?: number;
  shape?: MarkerShape;
}

export interface MapLine {
  id: string;
  points: LonLat[];
  color?: string;
  width?: number;
  dashed?: boolean;
  /** geodesic = great-circle path, arc = curved screen-space bezier, straight = straight screen line */
  style?: 'geodesic' | 'arc' | 'straight';
  arrow?: boolean;
  label?: string;
}

export interface LegendItem {
  color: string;
  label: string;
  /** Draw the swatch hatched, matching a hatched area. */
  hatch?: boolean;
}

/** Where a free-form area or field is drawn: only over land, only over sea, or everywhere. */
export type ClipMode = 'land' | 'ocean' | 'none';

/**
 * A shape that ignores administrative borders (a desert, a climate zone, a 500 km radius, a river…).
 * Polygons are wound for d3-geo (exterior rings clockwise) and densified, see shapes.ts.
 */
export interface MapArea {
  id: string;
  geometry: Polygon | MultiPolygon | LineString | MultiLineString;
  /** Legend label and name */
  label?: string;
  /** 'none' draws only the outline */
  fill?: string;
  opacity?: number;
  stroke?: string;
  strokeWidth?: number;
  dashed?: boolean;
  /** Diagonal hatching in the fill colour instead of a solid fill */
  hatch?: boolean;
  clip?: ClipMode;
}

/** How numbers map to colours; shared by choropleths and fields. */
export interface ColorScale {
  scheme: string;
  method: ChoroplethMethod;
  classes?: number;
  /** Class breaks for method=threshold (n breaks -> n+1 classes). */
  breaks?: number[];
  /** Explicit colours: one per class for classed methods, gradient stops for continuous. Overrides scheme. */
  colors?: string[];
  domain?: [number, number];
  reverse?: boolean;
  title?: string;
  unit?: string;
  /** Format for legend numbers, e.g. ",.0f" or ".1%" (d3-format) */
  format?: string;
}

export type FieldData =
  /** Scattered samples, interpolated by inverse distance weighting. */
  | { kind: 'points'; points: [number, number, number][]; power?: number; maxDistanceKm?: number }
  /** Values on a lat/lon lattice (values[i][j] at lats[i], lons[j]), interpolated bilinearly. */
  | { kind: 'grid'; lats: number[]; lons: number[]; values: (number | null)[][] };

/** A continuous surface (temperature, rainfall, elevation…) drawn as filled contour bands. */
export interface MapField extends ColorScale {
  /** Changes whenever the data changes; the renderer caches interpolation and contours by it. */
  key: string;
  data: FieldData;
  /** Area covered, [west, south, east, north]. Defaults to the data extent. */
  bbox?: [number, number, number, number];
  clip: ClipMode;
  opacity?: number;
  /** Human-readable origin of the data, e.g. "ETOPO 2022 elevation" */
  origin?: string;
}

export interface Legend {
  title?: string;
  items: LegendItem[];
}

export type ChoroplethMethod = 'quantize' | 'quantile' | 'continuous' | 'threshold';

export interface Choropleth extends ColorScale {
  values: Record<string, number>;
  /** Fill for regions with no data; defaults to the land colour. */
  noDataColor?: string;
  showNoData?: boolean;
}

export interface MapStyle {
  ocean?: string;
  land?: string;
  border?: string;
  borderWidth?: number;
  subdivisionBorder?: string;
  graticule?: boolean;
  background?: string;
  textColor?: string;
  font?: string;
}

export interface MapView {
  /** zoom transform in map (viewBox) units */
  k: number;
  x: number;
  y: number;
}

export interface ProjectionSettings {
  id: ProjectionId;
  /** [lambda, phi, gamma] rotation in degrees */
  rotate?: [number, number, number?];
  /** Standard parallels for conic projections */
  parallels?: [number, number];
  /** In-plane rotation of the whole map in degrees, clockwise positive. */
  angle?: number;
}

export interface MapState {
  projection: ProjectionSettings;
  title?: string;
  subtitle?: string;
  source?: string;
  regions: Record<string, RegionStyle>;
  choropleth?: Choropleth;
  /** Countries (ids) whose admin-1 subdivisions are drawn */
  subdivisions: string[];
  /** Continuous surface drawn over the land/ocean, below areas */
  field?: MapField;
  /** Free-form shapes, drawn in order above the field */
  areas: MapArea[];
  labels: MapLabel[];
  markers: MapMarker[];
  lines: MapLine[];
  legend?: Legend;
  legendPosition?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  /** Custom legend placement from dragging/resizing: top-left corner in map units and a size multiplier. Unset x/y = legendPosition corner. */
  legendLayout?: { x?: number; y?: number; scale?: number };
  style: MapStyle;
  /** Countries not listed here are hidden when set (e.g. only show Europe) */
  visibleCountries?: string[];
  /** Geographic area the projection is framed to: [west, south, east, north]. Whole world when unset. */
  focus?: [number, number, number, number];
  /** Interactive pan/zoom on top of the framed projection */
  view: MapView;
}

export const MAP_WIDTH = 1600;
export const MAP_HEIGHT = 1000;

export function emptyMapState(): MapState {
  return {
    projection: { id: 'mercator' },
    regions: {},
    subdivisions: [],
    areas: [],
    labels: [],
    markers: [],
    lines: [],
    style: { graticule: false },
    view: { k: 1, x: 0, y: 0 },
  };
}
