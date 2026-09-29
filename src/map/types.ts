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
}

export interface Legend {
  title?: string;
  items: LegendItem[];
}

export type ChoroplethMethod = 'quantize' | 'quantile' | 'continuous' | 'threshold';

export interface Choropleth {
  values: Record<string, number>;
  scheme: string;
  method: ChoroplethMethod;
  classes?: number;
  /** Class breaks for method=threshold (n breaks -> n+1 classes). */
  breaks?: number[];
  domain?: [number, number];
  reverse?: boolean;
  title?: string;
  unit?: string;
  /** Fill for regions with no data; defaults to the land colour. */
  noDataColor?: string;
  showNoData?: boolean;
  /** Format for legend numbers, e.g. ",.0f" or ".1%" (d3-format) */
  format?: string;
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
    labels: [],
    markers: [],
    lines: [],
    style: { graticule: false },
    view: { k: 1, x: 0, y: 0 },
  };
}
