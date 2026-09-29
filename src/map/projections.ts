import {
  geoAlbersUsa,
  geoAzimuthalEqualArea,
  geoAzimuthalEquidistant,
  geoConicConformal,
  geoConicEqualArea,
  geoConicEquidistant,
  geoEqualEarth,
  geoEquirectangular,
  geoGnomonic,
  geoMercator,
  geoNaturalEarth1,
  geoOrthographic,
  geoStereographic,
  geoTransverseMercator,
  type GeoPermissibleObjects,
  type GeoProjection,
} from 'd3-geo';
import * as gp from 'd3-geo-projection';
import * as poly from 'd3-geo-polygon';
import type { ProjectionId, ProjectionSettings } from './types';

/**
 * How a projection is framed and centred:
 * - cylindrical/pseudo: fit the whole sphere; recentre only for regions crossing the antimeridian
 * - interrupted/polyhedral: fixed lobes or nets; never auto-rotated
 * - azimuthal: rotated to face the focus (drag rotates)
 * - conic/regional: rotated to the focus' central meridian
 * - composite: fixed layout (Albers USA)
 */
type Kind = 'cylindrical' | 'pseudo' | 'interrupted' | 'polyhedral' | 'azimuthal' | 'conic' | 'regional' | 'composite';

export const PROJECTION_GROUPS = [
  'Cylindrical',
  'Compromise',
  'Equal-area',
  'Interrupted',
  'Polyhedral & folded',
  'Azimuthal & globe',
  'Conic & regional',
  'Novelty',
] as const;

type Group = (typeof PROJECTION_GROUPS)[number];

interface ProjectionDef {
  label: string;
  group: Group;
  kind: Kind;
  make: () => GeoProjection;
  description: string;
  /** Geographic box to frame for the whole-world view instead of the sphere (for projections that blow up at the poles). */
  worldBox?: BBox;
}

/** Geographic box [west, south, east, north]; west > east means it crosses the antimeridian. */
export type BBox = [number, number, number, number];

export const WORLD_BBOX: BBox = [-180, -58, 180, 84];

type Factory = () => GeoProjection;
const G = gp as unknown as Record<string, Factory>;
const P = poly as unknown as Record<string, Factory>;
type Param = GeoProjection & Record<string, (v: number) => GeoProjection>;
const withParam = (make: Factory, name: string, value: number) => () => (make() as Param)[name](value);

export const PROJECTIONS: Record<string, ProjectionDef> = {
  // ---- Cylindrical --------------------------------------------------------------------
  mercator: { label: 'Mercator', group: 'Cylindrical', kind: 'cylindrical', make: geoMercator, worldBox: WORLD_BBOX, description: 'Conformal; the web-map default. Inflates high latitudes.' },
  equirectangular: { label: 'Equirectangular (Plate Carrée)', group: 'Cylindrical', kind: 'cylindrical', make: geoEquirectangular, description: 'Simple lat/lon grid.' },
  miller: { label: 'Miller', group: 'Cylindrical', kind: 'cylindrical', make: G.geoMiller, worldBox: WORLD_BBOX, description: 'Mercator-like with less polar inflation.' },
  gallStereographic: { label: 'Gall Stereographic', group: 'Cylindrical', kind: 'cylindrical', make: withParam(G.geoCylindricalStereographic, 'parallel', 45), description: 'Compromise cylindrical used in atlases.' },
  gallPeters: { label: 'Gall–Peters', group: 'Cylindrical', kind: 'cylindrical', make: withParam(G.geoCylindricalEqualArea, 'parallel', 45), description: 'Equal-area cylindrical, standard parallels 45°.' },
  hoboDyer: { label: 'Hobo–Dyer', group: 'Cylindrical', kind: 'cylindrical', make: withParam(G.geoCylindricalEqualArea, 'parallel', 37.5), description: 'Equal-area cylindrical, standard parallels 37.5°.' },
  behrmann: { label: 'Behrmann', group: 'Cylindrical', kind: 'cylindrical', make: withParam(G.geoCylindricalEqualArea, 'parallel', 30), description: 'Equal-area cylindrical, standard parallels 30°.' },
  lambertCylindrical: { label: 'Lambert Cylindrical Equal-Area', group: 'Cylindrical', kind: 'cylindrical', make: withParam(G.geoCylindricalEqualArea, 'parallel', 0), description: 'Equal-area; very squashed poles.' },

  // ---- Compromise -----------------------------------------------------------------------
  robinson: { label: 'Robinson', group: 'Compromise', kind: 'pseudo', make: G.geoRobinson, description: 'Classic compromise world map.' },
  winkelTripel: { label: 'Winkel Tripel', group: 'Compromise', kind: 'pseudo', make: G.geoWinkel3, description: 'National Geographic standard; low overall distortion.' },
  naturalEarth: { label: 'Natural Earth I', group: 'Compromise', kind: 'pseudo', make: geoNaturalEarth1, description: 'Pleasant compromise world map.' },
  naturalEarth2: { label: 'Natural Earth II', group: 'Compromise', kind: 'pseudo', make: G.geoNaturalEarth2, description: 'Rounder-cornered sibling of Natural Earth.' },
  patterson: { label: 'Patterson', group: 'Compromise', kind: 'pseudo', make: G.geoPatterson, description: 'Miller-like cylindrical with gentler poles.' },
  kavrayskiy7: { label: 'Kavrayskiy VII', group: 'Compromise', kind: 'pseudo', make: G.geoKavrayskiy7, description: 'Low-distortion pseudocylindrical popular in the former USSR.' },
  wagner6: { label: 'Wagner VI', group: 'Compromise', kind: 'pseudo', make: G.geoWagner6, description: 'Compromise pseudocylindrical.' },
  vanDerGrinten: { label: 'Van der Grinten', group: 'Compromise', kind: 'pseudo', make: G.geoVanDerGrinten, description: 'Circular world map; former National Geographic standard.' },
  vanDerGrinten4: { label: 'Van der Grinten IV', group: 'Compromise', kind: 'pseudo', make: G.geoVanDerGrinten4, description: 'Apple-shaped variant.' },
  aitoff: { label: 'Aitoff', group: 'Compromise', kind: 'pseudo', make: G.geoAitoff, description: 'Elliptical azimuthal-derived world map.' },
  times: { label: 'Times', group: 'Compromise', kind: 'pseudo', make: G.geoTimes, description: 'Used by The Times Atlas.' },
  bertin1953: { label: 'Bertin 1953', group: 'Compromise', kind: 'pseudo', make: G.geoBertin1953, description: 'Stylish oblique world map by Jacques Bertin.' },
  fahey: { label: 'Fahey', group: 'Compromise', kind: 'pseudo', make: G.geoFahey, description: 'Pseudocylindrical compromise.' },
  loximuthal: { label: 'Loximuthal', group: 'Compromise', kind: 'pseudo', make: G.geoLoximuthal, description: 'Rhumb lines from the centre are straight and true length.' },

  // ---- Equal-area ------------------------------------------------------------------------
  equalEarth: { label: 'Equal Earth', group: 'Equal-area', kind: 'pseudo', make: geoEqualEarth, description: 'Modern equal-area world map; great for choropleths.' },
  mollweide: { label: 'Mollweide', group: 'Equal-area', kind: 'pseudo', make: G.geoMollweide, description: 'Elliptical equal-area.' },
  hammer: { label: 'Hammer', group: 'Equal-area', kind: 'pseudo', make: G.geoHammer, description: 'Elliptical equal-area with curved parallels.' },
  eckert4: { label: 'Eckert IV', group: 'Equal-area', kind: 'pseudo', make: G.geoEckert4, description: 'Equal-area with rounded poles.' },
  eckert6: { label: 'Eckert VI', group: 'Equal-area', kind: 'pseudo', make: G.geoEckert6, description: 'Equal-area with flat poles.' },
  wagner4: { label: 'Wagner IV', group: 'Equal-area', kind: 'pseudo', make: G.geoWagner4, description: 'Equal-area pseudocylindrical.' },
  wagner7: { label: 'Wagner VII', group: 'Equal-area', kind: 'pseudo', make: G.geoWagner7, description: 'Equal-area with curved parallels.' },
  sinusoidal: { label: 'Sinusoidal', group: 'Equal-area', kind: 'pseudo', make: G.geoSinusoidal, description: 'Equal-area; true scale along parallels.' },
  homolosine: { label: 'Goode Homolosine (uninterrupted)', group: 'Equal-area', kind: 'pseudo', make: G.geoHomolosine, description: 'Sinusoidal/Mollweide hybrid.' },
  boggs: { label: 'Boggs Eumorphic', group: 'Equal-area', kind: 'pseudo', make: G.geoBoggs, description: 'Equal-area pseudocylindrical.' },
  craster: { label: 'Craster Parabolic', group: 'Equal-area', kind: 'pseudo', make: G.geoCraster, description: 'Equal-area with parabolic meridians.' },
  mtFlatPolarQuartic: { label: 'McBryde–Thomas Flat-Polar Quartic', group: 'Equal-area', kind: 'pseudo', make: G.geoMtFlatPolarQuartic, description: 'Equal-area with flat poles.' },

  // ---- Interrupted -------------------------------------------------------------------------
  interruptedHomolosine: { label: 'Goode Homolosine (interrupted)', group: 'Interrupted', kind: 'interrupted', make: P.geoInterruptedHomolosine, description: 'The classic "orange peel"; land-focused equal-area.' },
  interruptedMollweide: { label: 'Interrupted Mollweide', group: 'Interrupted', kind: 'interrupted', make: P.geoInterruptedMollweide, description: 'Mollweide split into lobes.' },
  interruptedMollweideHemispheres: { label: 'Mollweide Hemispheres', group: 'Interrupted', kind: 'interrupted', make: P.geoInterruptedMollweideHemispheres, description: 'Two Mollweide hemispheres.' },
  interruptedSinusoidal: { label: 'Interrupted Sinusoidal', group: 'Interrupted', kind: 'interrupted', make: P.geoInterruptedSinusoidal, description: 'Sinusoidal split into lobes.' },
  interruptedSinuMollweide: { label: 'Interrupted Sinu-Mollweide', group: 'Interrupted', kind: 'interrupted', make: P.geoInterruptedSinuMollweide, description: 'Ocean-focused interruption.' },
  interruptedBoggs: { label: 'Interrupted Boggs', group: 'Interrupted', kind: 'interrupted', make: P.geoInterruptedBoggs, description: 'Boggs eumorphic in lobes.' },

  // ---- Polyhedral & folded -------------------------------------------------------------------
  airocean: { label: 'Dymaxion (Fuller AirOcean)', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoAirocean, description: "Buckminster Fuller's icosahedral net; continents nearly unbroken." },
  cahillKeyes: { label: 'Cahill–Keyes', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoCahillKeyes, description: 'Octahedral butterfly; low distortion.' },
  polyhedralWaterman: { label: 'Waterman Butterfly', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoPolyhedralWaterman, description: 'Truncated-octahedron butterfly.' },
  polyhedralButterfly: { label: 'Cahill Butterfly (gnomonic)', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoPolyhedralButterfly, description: "Bernard Cahill's octahedral butterfly." },
  polyhedralCollignon: { label: 'Collignon Butterfly', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoPolyhedralCollignon, description: 'Octahedral butterfly with Collignon faces.' },
  imago: { label: 'Imago (AuthaGraph-like)', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoImago, description: 'Rectangular near-equal-area tiling map.' },
  tetrahedralLee: { label: 'Lee Tetrahedral', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoTetrahedralLee, description: 'Conformal map on an unfolded tetrahedron.' },
  cox: { label: 'Cox (triangular)', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoCox, description: 'Conformal world in an equilateral triangle.' },
  icosahedral: { label: 'Icosahedral', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoIcosahedral, description: 'Gnomonic icosahedron net.' },
  dodecahedral: { label: 'Dodecahedral', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoDodecahedral, description: 'Gnomonic dodecahedron net.' },
  cubic: { label: 'Cubic', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoCubic, description: 'Gnomonic cube net.' },
  rhombic: { label: 'Rhombic', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoRhombic, description: 'Rhombic polyhedral net.' },
  healpix: { label: 'HEALPix', group: 'Polyhedral & folded', kind: 'polyhedral', make: P.geoHealpix, description: 'Equal-area crenellated map from astronomy.' },
  peirceQuincuncial: { label: 'Peirce Quincuncial', group: 'Polyhedral & folded', kind: 'polyhedral', make: G.geoPeirceQuincuncial, description: 'Conformal world in a square, centred on the North Pole.' },
  gringortenQuincuncial: { label: 'Gringorten Quincuncial', group: 'Polyhedral & folded', kind: 'polyhedral', make: G.geoGringortenQuincuncial, description: 'Equal-area world in a square.' },

  // ---- Azimuthal & globe ------------------------------------------------------------------------
  orthographic: { label: 'Globe (Orthographic)', group: 'Azimuthal & globe', kind: 'azimuthal', make: () => geoOrthographic().clipAngle(90), description: 'Globe view; drag to rotate.' },
  satellite: {
    label: 'Satellite (tilted perspective)',
    group: 'Azimuthal & globe',
    kind: 'azimuthal',
    make: () => {
      const distance = 1.8;
      const p = G.geoSatellite() as Param;
      p.distance(distance);
      p.tilt(20);
      return p.clipAngle((Math.acos(1 / distance) * 180) / Math.PI - 1e-3);
    },
    description: 'View from orbit with a tilted camera; drag to rotate.',
  },
  azimuthalEquidistant: { label: 'Azimuthal Equidistant', group: 'Azimuthal & globe', kind: 'azimuthal', make: geoAzimuthalEquidistant, description: 'True distances from the centre (e.g. UN-logo polar view with rotate [0,-90]).' },
  azimuthalEqualArea: { label: 'Lambert Azimuthal Equal-Area', group: 'Azimuthal & globe', kind: 'azimuthal', make: geoAzimuthalEqualArea, description: 'Equal-area disc; the EU statistics standard (LAEA).' },
  stereographic: { label: 'Stereographic', group: 'Azimuthal & globe', kind: 'azimuthal', make: () => geoStereographic().clipAngle(142), description: 'Conformal; ideal for polar maps.' },
  gnomonic: { label: 'Gnomonic', group: 'Azimuthal & globe', kind: 'azimuthal', make: () => geoGnomonic().clipAngle(60), description: 'Great circles are straight lines; shows under a hemisphere.' },
  nicolosi: { label: 'Nicolosi Globular', group: 'Azimuthal & globe', kind: 'azimuthal', make: () => G.geoNicolosi().clipAngle(90), description: 'Hemisphere in a circle.' },

  // ---- Conic & regional -------------------------------------------------------------------------
  albers: { label: 'Albers Equal-Area Conic', group: 'Conic & regional', kind: 'conic', make: geoConicEqualArea, description: 'Equal-area conic for mid-latitude regions (USA, Europe, Russia).' },
  lambertConformalConic: { label: 'Lambert Conformal Conic', group: 'Conic & regional', kind: 'conic', make: geoConicConformal, description: 'Conformal conic; the EU standard for Europe maps.' },
  conicEquidistant: { label: 'Equidistant Conic', group: 'Conic & regional', kind: 'conic', make: geoConicEquidistant, description: 'Distances true along meridians.' },
  transverseMercator: {
    label: 'Transverse Mercator',
    group: 'Conic & regional',
    kind: 'regional',
    make: geoTransverseMercator,
    worldBox: [-75, -80, 75, 80],
    description: 'For tall, narrow regions (Chile, Japan, UTM zones).',
  },
  polyconic: { label: 'American Polyconic', group: 'Conic & regional', kind: 'regional', make: G.geoPolyconic, worldBox: [-180, -80, 180, 80], description: 'Historic USGS mapping projection.' },
  bonne: { label: 'Bonne', group: 'Conic & regional', kind: 'regional', make: G.geoBonne, description: 'Equal-area heart-ish shape; classic atlas continents.' },
  albersUsa: { label: 'Albers USA (with AK & HI insets)', group: 'Conic & regional', kind: 'composite', make: geoAlbersUsa, description: 'US-only composite with Alaska & Hawaii insets.' },

  // ---- Novelty --------------------------------------------------------------------------------------
  werner: { label: 'Werner (heart)', group: 'Novelty', kind: 'regional', make: withParam(G.geoBonne, 'parallel', 90), description: 'Heart-shaped equal-area map.' },
  berghaus: { label: 'Berghaus Star', group: 'Novelty', kind: 'interrupted', make: P.geoBerghaus, description: 'Five-pointed star centred on the North Pole.' },
  gingery: { label: 'Gingery', group: 'Novelty', kind: 'interrupted', make: P.geoGingery, description: 'Petal-shaped world centred on the North Pole.' },
  lagrange: { label: 'Lagrange', group: 'Novelty', kind: 'pseudo', make: G.geoLagrange, description: 'Conformal world in a circle.' },
  august: { label: 'August Epicycloidal', group: 'Novelty', kind: 'pseudo', make: G.geoAugust, description: 'Conformal world in an epicycloid.' },
  eisenlohr: { label: 'Eisenlohr', group: 'Novelty', kind: 'pseudo', make: G.geoEisenlohr, description: 'Conformal with a smooth outline.' },
  guyou: { label: 'Guyou', group: 'Novelty', kind: 'polyhedral', make: G.geoGuyou, description: 'Conformal world as two squares.' },
  collignon: { label: 'Collignon', group: 'Novelty', kind: 'pseudo', make: G.geoCollignon, description: 'Equal-area triangle.' },
};

export const PROJECTION_IDS = Object.keys(PROJECTIONS) as ProjectionId[];

export function projectionDef(id: ProjectionId): ProjectionDef {
  return PROJECTIONS[id] ?? PROJECTIONS.mercator;
}

/** Projections the user rotates by dragging instead of panning. */
export const isRotatable = (id: ProjectionId) => projectionDef(id).kind === 'azimuthal';

/** A grid of points covering a bbox; fitting to it frames the bbox in any projection. */
function bboxPoints([w, s, e, n]: BBox): GeoPermissibleObjects {
  if (e < w) e += 360;
  const pts: [number, number][] = [];
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const lon = w + ((e - w) * i) / steps;
      pts.push([lon > 180 ? lon - 360 : lon, s + ((n - s) * j) / steps]);
    }
  }
  return { type: 'MultiPoint', coordinates: pts };
}

export function bboxCenter([w, s, e, n]: BBox): [number, number] {
  if (e < w) e += 360;
  let lon = (w + e) / 2;
  if (lon > 180) lon -= 360;
  return [lon, (s + n) / 2];
}

export interface Frame {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Build a projection framed to `bbox` (or the whole world) inside `frame`.
 * Rotation/parallels are taken from settings when given, otherwise derived from the bbox
 * so regional conic/azimuthal maps are centred sensibly.
 */
export function buildProjection(settings: ProjectionSettings, frame: Frame, bbox?: BBox, usaFeature?: GeoPermissibleObjects): GeoProjection {
  const def = projectionDef(settings.id);
  const p = def.make();
  const extent: [[number, number], [number, number]] = [
    [frame.x0, frame.y0],
    [frame.x1, frame.y1],
  ];

  if (def.kind === 'composite') {
    if (usaFeature) p.fitExtent(extent, usaFeature);
    return p;
  }

  const isWorld = !bbox;
  const box = bbox ?? def.worldBox ?? WORLD_BBOX;
  const [clon, clat] = bboxCenter(box);

  if (settings.rotate) {
    p.rotate([settings.rotate[0], settings.rotate[1], settings.rotate[2] ?? 0]);
  } else if (def.kind === 'azimuthal') {
    p.rotate([-clon, isWorld ? -20 : -clat, 0]);
  } else if (def.kind === 'conic' || (def.kind === 'regional' && !isWorld)) {
    p.rotate([-clon, 0, 0]);
  } else if (!isWorld && (def.kind === 'cylindrical' || def.kind === 'pseudo') && box[2] < box[0]) {
    // Recentre maps of regions that cross the antimeridian (e.g. the Pacific).
    p.rotate([-clon, 0, 0]);
  }

  if (def.kind === 'conic') {
    const conic = p as GeoProjection & { parallels(p: [number, number]): GeoProjection };
    if (settings.parallels) conic.parallels(settings.parallels);
    else {
      const [, s, , n] = isWorld ? [0, 20, 0, 60] : box;
      const span = n - s;
      let p1 = s + span / 6;
      let p2 = n - span / 6;
      if (Math.abs(p1 + p2) < 1) (p1 = 20), (p2 = 50); // avoid a degenerate cone at the equator
      conic.parallels([p1, p2]);
    }
    p.fitExtent(extent, bboxPoints(isWorld ? [-180, -30, 180, 84] : box));
    return p;
  }

  if (isWorld && !def.worldBox) {
    p.fitExtent(extent, { type: 'Sphere' });
    return p;
  }

  p.fitExtent(extent, bboxPoints(box));
  return p;
}
