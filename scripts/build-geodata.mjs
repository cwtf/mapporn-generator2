// Builds the map data shipped in public/data from Natural Earth (public domain).
//   public/data/countries.json         TopoJSON, one object "countries"
//   public/data/admin1/index.json      { [countryId]: { name, count } }
//   public/data/admin1/<ID>.json       TopoJSON, one object "regions" per country
//
// Usage: npm run geodata   (downloads ~55 MB into .cache/ on first run)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { topology } from 'topojson-server';
import { presimplify, simplify, sphericalTriangleArea } from 'topojson-simplify';
import { quantize } from 'topojson-client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'public', 'data');
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';

async function download(file) {
  const dest = path.join(CACHE, file);
  try {
    return JSON.parse(await fs.readFile(dest, 'utf8'));
  } catch {
    console.log(`Downloading ${file} ...`);
    const res = await fetch(NE + file);
    if (!res.ok) throw new Error(`${res.status} fetching ${file}`);
    const text = await res.text();
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(dest, text);
    return JSON.parse(text);
  }
}

const valid = (v) => typeof v === 'string' && v !== '-99' && v.trim() !== '';

function buildTopo(features, objectName, minWeight) {
  let topo = topology({ [objectName]: { type: 'FeatureCollection', features } }, 1e5);
  topo = presimplify(topo, sphericalTriangleArea);
  topo = simplify(topo, minWeight);
  // drop presimplify weights and re-quantize (delta-encoded integers are far smaller)
  topo.arcs = topo.arcs.map((arc) => arc.map((p) => [p[0], p[1]]));
  return quantize(topo, 1e5);
}

async function main() {
  const countries = await download('ne_50m_admin_0_countries.geojson');
  const admin1 = await download('ne_10m_admin_1_states_provinces.geojson');

  // ---- countries -----------------------------------------------------------
  const a3ToId = new Map();
  const seen = new Set();
  const countryFeatures = [];
  for (const f of countries.features) {
    const p = f.properties;
    let id = valid(p.ISO_A3_EH) ? p.ISO_A3_EH : valid(p.ISO_A3) ? p.ISO_A3 : p.ADM0_A3;
    if (seen.has(id)) id = p.ADM0_A3;
    if (seen.has(id)) throw new Error(`Duplicate country id ${id}`);
    seen.add(id);
    a3ToId.set(p.ADM0_A3, id);
    const iso2 = valid(p.ISO_A2_EH) ? p.ISO_A2_EH : valid(p.ISO_A2) ? p.ISO_A2 : undefined;
    const aliases = [...new Set([p.NAME_LONG, p.FORMAL_EN, p.NAME_EN, p.ADMIN, p.NAME_SORT, p.ABBREV, p.BRK_NAME, p.GEOUNIT]
      .filter((a) => valid(a) && a !== p.NAME))];
    countryFeatures.push({
      type: 'Feature',
      id,
      properties: {
        name: p.NAME,
        iso2,
        a3: p.ADM0_A3,
        continent: p.CONTINENT,
        subregion: p.SUBREGION,
        aliases,
      },
      geometry: f.geometry,
    });
  }
  await fs.mkdir(path.join(OUT, 'admin1'), { recursive: true });
  const ctopo = buildTopo(countryFeatures, 'countries', 1e-6);
  await fs.writeFile(path.join(OUT, 'countries.json'), JSON.stringify(ctopo));
  console.log(`countries.json: ${countryFeatures.length} features`);

  // ---- admin-1 subdivisions, split per country ------------------------------
  const byCountry = new Map();
  for (const f of admin1.features) {
    const p = f.properties;
    const cid = a3ToId.get(p.adm0_a3);
    if (!cid || !f.geometry) continue;
    if (!byCountry.has(cid)) byCountry.set(cid, []);
    byCountry.get(cid).push(f);
  }

  const index = {};
  let total = 0;
  for (const [cid, feats] of [...byCountry].sort()) {
    if (feats.length < 2) continue; // single-region countries add nothing
    const ids = new Set();
    const out = feats.map((f) => {
      const p = f.properties;
      let id = /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(p.iso_3166_2 ?? '') ? p.iso_3166_2 : p.adm1_code;
      if (ids.has(id)) id = p.adm1_code;
      ids.add(id);
      const name = valid(p.name) ? p.name : valid(p.name_en) ? p.name_en : id;
      const aliases = [...new Set([p.name_en, p.name_alt, p.woe_name, p.gn_name].filter((a) => valid(a) && a !== name)
        .flatMap((a) => a.split('|')))];
      return {
        type: 'Feature',
        id,
        properties: { name, type: p.type_en ?? p.type ?? undefined, country: cid, aliases },
        geometry: f.geometry,
      };
    });
    const topo = buildTopo(out, 'regions', 4e-7);
    const json = JSON.stringify(topo);
    await fs.writeFile(path.join(OUT, 'admin1', `${cid}.json`), json);
    total += json.length;
    const name = countryFeatures.find((c) => c.id === cid)?.properties.name ?? cid;
    index[cid] = { name, count: out.length };
  }
  await fs.writeFile(path.join(OUT, 'admin1', 'index.json'), JSON.stringify(index));
  console.log(`admin1: ${Object.keys(index).length} countries, ${(total / 1e6).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
