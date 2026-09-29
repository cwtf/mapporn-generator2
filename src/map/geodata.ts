import { geoArea, geoBounds, geoCentroid } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import type { Topology } from 'topojson-specification';

export interface CountryProps {
  name: string;
  iso2?: string;
  a3: string;
  continent: string;
  subregion: string;
  aliases: string[];
}

export interface SubdivisionProps {
  name: string;
  type?: string;
  country: string;
  aliases: string[];
}

export type CountryFeature = Feature<Geometry, CountryProps> & { id: string };
export type SubdivisionFeature = Feature<Geometry, SubdivisionProps> & { id: string };
export type RegionFeature = CountryFeature | SubdivisionFeature;

export interface RegionInfo {
  id: string;
  name: string;
  kind: 'country' | 'subdivision';
  /** parent country id for subdivisions */
  country?: string;
  feature: RegionFeature;
}

// Common names that Natural Earth's own name/alias fields don't cover.
const EXTRA_ALIASES: Record<string, string[]> = {
  USA: ['US', 'America', 'United States'],
  GBR: ['UK', 'Britain', 'Great Britain', 'United Kingdom'],
  COD: ['DRC', 'DR Congo', 'Congo-Kinshasa', 'Democratic Republic of the Congo'],
  COG: ['Republic of the Congo', 'Congo-Brazzaville'],
  CIV: ['Ivory Coast', "Cote d'Ivoire"],
  CZE: ['Czech Republic', 'Czechia'],
  MKD: ['Macedonia', 'North Macedonia'],
  SWZ: ['Swaziland', 'Eswatini'],
  MMR: ['Burma'],
  TUR: ['Türkiye', 'Turkiye'],
  CPV: ['Cape Verde', 'Cabo Verde'],
  TLS: ['East Timor', 'Timor-Leste'],
  VAT: ['Vatican', 'Holy See', 'Vatican City'],
  ARE: ['UAE'],
  CAF: ['CAR'],
  BIH: ['Bosnia'],
  PRK: ['DPRK', 'North Korea'],
  KOR: ['ROK', 'South Korea', 'Korea'],
  RUS: ['Russian Federation'],
  FSM: ['Micronesia'],
  FLK: ['Falklands', 'Falkland Islands'],
  LAO: ['Laos'],
  STP: ['Sao Tome and Principe', 'São Tomé and Príncipe'],
  GMB: ['Gambia', 'The Gambia'],
  BHS: ['Bahamas', 'The Bahamas'],
  PSE: ['Palestine', 'State of Palestine'],
  TWN: ['Taiwan', 'Republic of China'],
  CHN: ["People's Republic of China", 'PRC'],
  NLD: ['Holland', 'The Netherlands'],
};

export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

class GeoData {
  countries: CountryFeature[] = [];
  admin1Index: Record<string, { name: string; count: number }> = {};
  private admin1 = new Map<string, SubdivisionFeature[]>();
  private admin1Pending = new Map<string, Promise<SubdivisionFeature[]>>();
  private regions = new Map<string, RegionInfo>();
  private countryNames = new Map<string, string[]>();
  /** exact Natural Earth display names; these win over aliases */
  private primaryNames = new Map<string, string[]>();
  private iso2 = new Map<string, string>();
  private subNames = new Map<string, Map<string, string[]>>();
  private subPrimary = new Map<string, Map<string, string[]>>();
  private ready?: Promise<void>;
  private listeners = new Set<() => void>();
  /** bumps whenever new subdivision data is loaded */
  version = 0;

  load(): Promise<void> {
    this.ready ??= (async () => {
      const [topo, index] = await Promise.all([
        fetch('/data/countries.json').then((r) => r.json() as Promise<Topology>),
        fetch('/data/admin1/index.json').then((r) => r.json()),
      ]);
      this.admin1Index = index;
      const fc = feature(topo, topo.objects.countries) as unknown as FeatureCollection<Geometry, CountryProps>;
      this.countries = (fc.features as CountryFeature[]).map(rewind);
      for (const f of this.countries) {
        this.regions.set(f.id, { id: f.id, name: f.properties.name, kind: 'country', feature: f });
        if (f.properties.iso2) this.iso2.set(f.properties.iso2, f.id);
        addName(this.primaryNames, normalizeName(f.properties.name), f.id);
        const names = [f.properties.name, ...f.properties.aliases, ...(EXTRA_ALIASES[f.id] ?? [])];
        for (const n of names) addName(this.countryNames, normalizeName(n), f.id);
      }
    })();
    return this.ready;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  hasSubdivisions(countryId: string) {
    return countryId in this.admin1Index;
  }

  getSubdivisions(countryId: string): SubdivisionFeature[] | undefined {
    return this.admin1.get(countryId);
  }

  async loadSubdivisions(countryId: string): Promise<SubdivisionFeature[]> {
    await this.load();
    const have = this.admin1.get(countryId);
    if (have) return have;
    if (!this.hasSubdivisions(countryId)) throw new Error(`No subdivision data for ${countryId}`);
    let pending = this.admin1Pending.get(countryId);
    if (!pending) {
      pending = (async () => {
        const topo = (await fetch(`/data/admin1/${countryId}.json`).then((r) => r.json())) as Topology;
        const fc = feature(topo, topo.objects.regions) as unknown as FeatureCollection<Geometry, SubdivisionProps>;
        const feats = (fc.features as SubdivisionFeature[]).map(rewind);
        const names = new Map<string, string[]>();
        const primary = new Map<string, string[]>();
        for (const f of feats) {
          this.regions.set(f.id, { id: f.id, name: f.properties.name, kind: 'subdivision', country: countryId, feature: f });
          addName(primary, normalizeName(f.properties.name), f.id);
          for (const n of [f.properties.name, ...f.properties.aliases]) addName(names, normalizeName(n), f.id);
        }
        this.subNames.set(countryId, names);
        this.subPrimary.set(countryId, primary);
        this.admin1.set(countryId, feats);
        this.version++;
        this.listeners.forEach((l) => l());
        return feats;
      })();
      this.admin1Pending.set(countryId, pending);
    }
    return pending;
  }

  get(id: string): RegionInfo | undefined {
    return this.regions.get(id);
  }

  /**
   * Resolve a user/agent supplied reference (id, ISO code or name) to a region id.
   * `country` scopes name lookups to that country's subdivisions.
   */
  async resolve(ref: string, country?: string): Promise<{ id: string } | { error: string }> {
    await this.load();
    const raw = ref.trim();
    if (!raw) return { error: 'empty region reference' };
    const up = raw.toUpperCase();

    if (country) {
      const cid = (await this.resolveCountry(country)) ?? country;
      if (this.hasSubdivisions(cid)) {
        await this.loadSubdivisions(cid);
        if (this.regions.get(up)?.country === cid) return { id: up };
        const norm = normalizeName(raw);
        const hit = only(this.subPrimary.get(cid)?.get(norm)) ?? only(this.subNames.get(cid)?.get(norm));
        if (hit) return { id: hit };
        const fuzzy = this.fuzzy(normalizeName(raw), this.subNames.get(cid));
        if (fuzzy) return { id: fuzzy };
      }
    }

    // Exact ids: ISO3 / NE country ids, ISO2, then ISO 3166-2 subdivision codes (e.g. US-CA)
    if (this.regions.get(up)?.kind === 'country') return { id: up };
    if (this.iso2.has(up)) return { id: this.iso2.get(up)! };
    const sub = up.match(/^([A-Z]{2})-[A-Z0-9]{1,3}$/);
    if (sub) {
      const cid = this.iso2.get(sub[1]);
      if (cid && this.hasSubdivisions(cid)) {
        await this.loadSubdivisions(cid);
        if (this.regions.has(up)) return { id: up };
      }
    }
    if (this.regions.has(up)) return { id: up };

    const norm = normalizeName(raw);
    const c = this.countryName(norm);
    if (c) return { id: c };

    // Names of subdivisions that are already loaded
    const primaryHits = [...this.subPrimary.values()].flatMap((m) => m.get(norm) ?? []);
    if (primaryHits.length === 1) return { id: primaryHits[0] };
    const subHits = primaryHits.length ? primaryHits : [...this.subNames.values()].flatMap((m) => m.get(norm) ?? []);
    if (subHits.length === 1) return { id: subHits[0] };
    if (subHits.length > 1) {
      return { error: `"${raw}" is ambiguous (${subHits.join(', ')}); use an id or pass "country"` };
    }

    const fuzzy = this.fuzzy(norm, this.countryNames);
    if (fuzzy) return { id: fuzzy };
    return { error: `unknown region "${raw}"${this.suggest(norm)}` };
  }

  async resolveCountry(ref: string): Promise<string | undefined> {
    await this.load();
    const up = ref.trim().toUpperCase();
    if (this.regions.get(up)?.kind === 'country') return up;
    if (this.iso2.has(up)) return this.iso2.get(up);
    return this.countryName(normalizeName(ref));
  }

  private countryName(norm: string): string | undefined {
    const primary = this.primaryNames.get(norm);
    if (primary?.length === 1) return primary[0];
    const c = this.countryNames.get(norm);
    return c?.length === 1 ? c[0] : undefined;
  }

  /**
   * Resolve a list of references, expanding group selectors:
   *   "*" / "all", "continent:Europe", "subregion:Western Africa", "USA:*" (all subdivisions)
   */
  async resolveMany(refs: string[], country?: string): Promise<{ ids: string[]; errors: string[] }> {
    await this.load();
    const ids: string[] = [];
    const errors: string[] = [];
    for (const ref of refs) {
      const r = String(ref).trim();
      const lower = r.toLowerCase();
      if (lower === '*' || lower === 'all' || lower === 'world') {
        ids.push(...this.countries.map((f) => f.id));
        continue;
      }
      const group = r.match(/^(continent|subregion)\s*:\s*(.+)$/i);
      if (group) {
        const key = group[1].toLowerCase() as 'continent' | 'subregion';
        const want = normalizeName(group[2]);
        const hits = this.countries.filter((f) => normalizeName(f.properties[key]) === want).map((f) => f.id);
        if (hits.length) ids.push(...hits);
        else errors.push(`no countries in ${key} "${group[2]}" (${key}s: ${this.groupNames(key).join(', ')})`);
        continue;
      }
      const all = r.match(/^(.+?)\s*:\s*\*$/);
      if (all) {
        const cid = await this.resolveCountry(all[1]);
        if (!cid || !this.hasSubdivisions(cid)) {
          errors.push(`no subdivision data for "${all[1]}"`);
          continue;
        }
        ids.push(...(await this.loadSubdivisions(cid)).map((f) => f.id));
        continue;
      }
      const res = await this.resolve(r, country);
      if ('id' in res) ids.push(res.id);
      else errors.push(res.error);
    }
    return { ids: [...new Set(ids)], errors };
  }

  groupNames(key: 'continent' | 'subregion'): string[] {
    return [...new Set(this.countries.map((f) => f.properties[key]))].sort();
  }

  /** A good label anchor: centroid of the region's largest polygon. */
  labelPoint(id: string): [number, number] | undefined {
    const info = this.regions.get(id);
    if (!info) return undefined;
    const g = info.feature.geometry;
    if (g.type === 'MultiPolygon') {
      let best: Polygon | undefined;
      let bestArea = -1;
      for (const coords of (g as MultiPolygon).coordinates) {
        const poly: Polygon = { type: 'Polygon', coordinates: coords };
        const a = geoArea(poly);
        if (a > bestArea) (bestArea = a), (best = poly);
      }
      return best ? geoCentroid(best) : undefined;
    }
    return geoCentroid(info.feature);
  }

  /** Combined bounds of regions as [w, s, e, n]. Uses each region's largest parts only for far-flung countries. */
  bounds(ids: string[]): [number, number, number, number] | undefined {
    const feats = ids.map((id) => this.regions.get(id)?.feature).filter(Boolean) as RegionFeature[];
    if (!feats.length) return undefined;
    const [[w, s], [e, n]] = geoBounds({ type: 'FeatureCollection', features: feats.map(mainland) });
    return [w, s, e, n];
  }

  private fuzzy(norm: string, names?: Map<string, string[]>): string | undefined {
    if (!names || norm.length < 4) return undefined;
    const hits = new Set<string>();
    for (const [n, ids] of names) if (n.startsWith(norm) || norm.startsWith(n + ' ')) ids.forEach((i) => hits.add(i));
    return hits.size === 1 ? [...hits][0] : undefined;
  }

  private suggest(norm: string): string {
    const word = norm.split(' ')[0];
    if (!word || word.length < 3) return '';
    const sug = new Set<string>();
    for (const [n, ids] of this.countryNames) if (n.includes(word)) ids.forEach((i) => sug.add(`${i} (${this.regions.get(i)?.name})`));
    for (const m of this.subNames.values()) for (const [n, ids] of m) if (n.includes(word)) ids.forEach((i) => sug.add(`${i} (${this.regions.get(i)?.name})`));
    const list = [...sug].slice(0, 6);
    return list.length ? `; did you mean: ${list.join(', ')}?` : '';
  }
}

/**
 * d3-geo reads polygon winding spherically: a ring wound the "wrong" way means "the whole
 * globe except this shape". Simplification occasionally flips a ring, so fix any polygon
 * that claims more than a hemisphere.
 */
function rewind<F extends RegionFeature>(f: F): F {
  const g = f.geometry;
  const fix = (rings: Polygon['coordinates']) =>
    geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI ? rings.map((r) => [...r].reverse()) : rings;
  if (g.type === 'Polygon') return { ...f, geometry: { ...g, coordinates: fix(g.coordinates) } };
  if (g.type === 'MultiPolygon') return { ...f, geometry: { ...g, coordinates: g.coordinates.map(fix) } };
  return f;
}

const only = (list?: string[]) => (list?.length === 1 ? list[0] : undefined);

function addName(map: Map<string, string[]>, name: string, id: string) {
  if (!name) return;
  const list = map.get(name);
  if (!list) map.set(name, [id]);
  else if (!list.includes(id)) list.push(id);
}

/**
 * Drop small polygons far from the main landmass (e.g. French Guiana, Hawaii) so that
 * zooming to "France" frames metropolitan France.
 */
function mainland(f: RegionFeature): Feature {
  const g = f.geometry;
  if (g.type !== 'MultiPolygon') return f;
  const polys = (g as MultiPolygon).coordinates.map((c) => ({ c, a: geoArea({ type: 'Polygon', coordinates: c }) }));
  const max = Math.max(...polys.map((p) => p.a));
  const main = polys.find((p) => p.a === max)!;
  const [mx, my] = geoCentroid({ type: 'Polygon', coordinates: main.c });
  const kept = polys.filter((p) => {
    if (p.a >= max * 0.35) return true;
    const [x, y] = geoCentroid({ type: 'Polygon', coordinates: p.c });
    return Math.abs(x - mx) < 25 && Math.abs(y - my) < 20;
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: kept.map((p) => p.c) } };
}

export const geo = new GeoData();
