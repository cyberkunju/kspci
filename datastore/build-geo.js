'use strict';

/**
 * Builds the all-India geography + demography reference used by generate-india.js.
 *
 * Why this exists: the previous reference (india_cities.json) only covered 528
 * cities >= 1 lakh, aggregated into 416 districts. That silently excluded every
 * rural district and skewed all generated crime toward metros. This builder uses
 * the full Census 2011 district universe (640 districts) and joins it to real
 * geometry and ~141k real geocoded localities.
 *
 * Inputs (raw, fetched by `fetch-geo.sh`, kept out of git — see ref/SOURCES.md):
 *   raw/census_districts_2011.csv  640 districts x 118 demographic columns
 *                                  (Census of India 2011 Primary Census Abstract)
 *   raw/dists11.geojson            641 district polygons keyed on `censuscode`
 *                                  (datameet/maps, Census 2011 boundaries)
 *   raw/postoffices.csv            154,797 post offices with taluk/district/state
 *   raw/postoffice_latlng.txt      141,709 post offices with lat/lng
 *
 * Join strategy: no hand-maintained district alias table.
 *   1. Census <-> polygon joins on the numeric `censuscode` (verified: all 640
 *      match, and the 21 name disagreements are spelling variants only).
 *   2. Geocoded post offices attach to a district by point-in-polygon, so postal
 *      spellings ("Baramula"/"Baramulla", "Haora"/"Howrah") never matter.
 *   3. That spatial result then *learns* the postal-district -> censuscode map,
 *      which is used to attach the ~13k post offices the geocode file misses.
 *      This matters: the geocode source has very uneven coverage (Nizamabad has
 *      coordinates for 1 of its 481 post offices), so a coordinates-only join
 *      would leave whole districts with a handful of points and produce visible
 *      clustering artefacts in the generated data.
 *   4. Localities with no coordinate get a deterministic point sampled inside
 *      their district's real boundary — real name, real district, plausible spot.
 *
 * The modern state of each district is decided by majority vote of the postal
 * state of its localities, which resolves the 2014 Telangana and 2000
 * Chhattisgarh/Jharkhand/Uttarakhand bifurcations that Census 2011 predates.
 *
 * Outputs:
 *   ref/india_districts_full.json  640 districts: centroid, population, demography
 *   ref/india_localities.json      geocoded localities grouped by district
 */

const fs = require('fs');
const path = require('path');

const REF = path.join(__dirname, 'ref');
const RAW = path.join(__dirname, 'raw');
fs.mkdirSync(REF, { recursive: true });

const norm = (s) => String(s || '').trim().toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
const titleCase = (s) => String(s || '').trim().toLowerCase()
  .replace(/\b([a-z])/g, (m) => m.toUpperCase())
  .replace(/\b(Of|And|The)\b/g, (m) => m.toLowerCase());

// ---------------------------------------------------------------- CSV reading
function readCsv(file, delim = ',') {
  const txt = fs.readFileSync(file, 'utf8');
  const rows = [];
  let field = '', row = [], inQ = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (inQ) {
      if (c === '"') { if (txt[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

// -------------------------------------------------- state-name reconciliation
// Postal and Census spellings -> the NCRB 2023 state/UT names we calibrate on.
const STATE_ALIAS = {
  chattisgarh: 'Chhattisgarh',
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  nctofdelhi: 'Delhi',
  damananddiu: 'Dadra and Nagar Haveli and Daman and Diu',
  dadraandnagarhaveli: 'Dadra and Nagar Haveli and Daman and Diu',
  andamanandnicobarislands: 'Andaman and Nicobar Islands',
  jammuandkashmir: 'Jammu and Kashmir',
};
// Ladakh was carved out of Jammu & Kashmir in 2019 and Telangana out of Andhra
// Pradesh in 2014. The postal snapshot marks most of Telangana but still files
// Hyderabad and Nizamabad under the Andhra Pradesh postal circle, and predates
// Ladakh entirely. These are settled facts no input source carries reliably, so
// they are stated explicitly rather than inferred.
const LADAKH_DISTRICTS = new Set(['lehladakh', 'kargil', 'leh']);
const TELANGANA_DISTRICTS = new Set([
  'adilabad', 'nizamabad', 'karimnagar', 'medak', 'hyderabad', 'rangareddy',
  'rangareddi', 'mahbubnagar', 'nalgonda', 'warangal', 'khammam',
]);

// District renames between the postal directory and Census 2011. These cannot be
// derived: the two administrations simply use different official names for the
// same district. Fifteen entries is the whole set for the 640-district universe.
const DISTRICT_ALIAS = {
  'assam/northcacharhills': 'dimahasao',
  'chattisgarh/kanker': 'uttarbastarkanker',
  'chattisgarh/kawardha': 'kabeerdham',
  'himachalpradesh/hamirpurhp': 'hamirpur',
  'jammuandkashmir/bandipur': 'bandipore',
  'madhyapradesh/khandwa': 'khandwaeastnimar',
  'madhyapradesh/khargone': 'khargonewestnimar',
  'maharashtra/raigarhmh': 'raigarh',
  'punjab/ropar': 'rupnagar',
  'punjab/nawanshahr': 'shahidbhagatsinghnagar',
  'tamilnadu/nilgiris': 'thenilgiris',
  'tamilnadu/tuticorin': 'thoothukkudi',
  'uttarpradesh/hathras': 'mahamayanagar',
  'uttarakhand/paurigarhwal': 'garhwal',
  'bihar/aurangabadbh': 'aurangabad',        // disambiguated from Aurangabad, Maharashtra by state
  'telangana/mahabubnagar': 'mahbubnagar',
};
// Districts created after the postal directory snapshot, whose post offices are
// still filed under the parent district. They are served by the locality floor.
const POST_SNAPSHOT_DISTRICTS = ['Mewat (Nuh)', 'Palwal'];

const ncrb = JSON.parse(fs.readFileSync(path.join(REF, 'ncrb_states_2023.json'), 'utf8'));
const NCRB_BY_NORM = new Map(ncrb.states.map((s) => [norm(s.state), s.state]));
const toNcrbState = (raw) => {
  const n = norm(raw);
  return NCRB_BY_NORM.get(n) || STATE_ALIAS[n] || null;
};

// --------------------------------------------------------------- 1. census
const census = readCsv(path.join(RAW, 'census_districts_2011.csv'));
const num = (v) => { const n = Number(String(v || '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; };

const districts = new Map(); // censuscode -> record
for (const r of census) {
  const code = num(r['District code']);
  if (!code) continue;
  const pop = num(r.Population);
  if (pop <= 0) continue;
  const households = num(r.Households) || 1;
  const relTotal = ['Hindus', 'Muslims', 'Christians', 'Sikhs', 'Buddhists', 'Jains', 'Others_Religions', 'Religion_Not_Stated']
    .reduce((a, k) => a + num(r[k]), 0) || pop;
  const workers = num(r.Workers) || 1;
  const ageTotal = num(r.Age_Group_0_29) + num(r.Age_Group_30_49) + num(r.Age_Group_50) || pop;
  districts.set(code, {
    code,
    censusDistrict: titleCase(r['District name']),
    censusState: titleCase(r['State name']),
    pop2011: pop,
    demo: {
      maleShare: +(num(r.Male) / pop).toFixed(4),
      literacy: +(num(r.Literate) / pop).toFixed(4),
      scShare: +(num(r.SC) / pop).toFixed(4),
      stShare: +(num(r.ST) / pop).toFixed(4),
      urbanShare: +(num(r.Urban_Households) / households).toFixed(4),
      workerShare: +(workers / pop).toFixed(4),
      graduateShare: +(num(r.Graduate_Education) / pop).toFixed(4),
      internetShare: +(num(r.Households_with_Internet) / households).toFixed(4),
      religion: {
        Hindu: +(num(r.Hindus) / relTotal).toFixed(4),
        Muslim: +(num(r.Muslims) / relTotal).toFixed(4),
        Christian: +(num(r.Christians) / relTotal).toFixed(4),
        Sikh: +(num(r.Sikhs) / relTotal).toFixed(4),
        Buddhist: +(num(r.Buddhists) / relTotal).toFixed(4),
        Jain: +(num(r.Jains) / relTotal).toFixed(4),
        Other: +((num(r.Others_Religions) + num(r.Religion_Not_Stated)) / relTotal).toFixed(4),
      },
      occupation: {
        Cultivator: +(num(r.Cultivator_Workers) / workers).toFixed(4),
        'Agricultural Labourer': +(num(r.Agricultural_Workers) / workers).toFixed(4),
        'Household Industry': +(num(r.Household_Workers) / workers).toFixed(4),
        Other: +(num(r.Other_Workers) / workers).toFixed(4),
      },
      age: {
        a0_29: +(num(r.Age_Group_0_29) / ageTotal).toFixed(4),
        a30_49: +(num(r.Age_Group_30_49) / ageTotal).toFixed(4),
        a50: +(num(r.Age_Group_50) / ageTotal).toFixed(4),
      },
    },
  });
}
console.log(`census      : ${districts.size} districts`);

// -------------------------------------------------------------- 2. polygons
const gj = JSON.parse(fs.readFileSync(path.join(RAW, 'dists11.geojson'), 'utf8'));

/** Flatten a Polygon/MultiPolygon into outer rings (holes are irrelevant here). */
function outerRings(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates[0]];
  if (geom.type === 'MultiPolygon') return geom.coordinates.map((p) => p[0]);
  return [];
}
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}
function ringCentroid(ring) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
  }
  a /= 2;
  if (!a) return null;
  return { lng: cx / (6 * a), lat: cy / (6 * a), area: Math.abs(a) };
}
function bbox(rings) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function pointInRings(lng, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

let polyMatched = 0;
const polys = [];
for (const f of gj.features) {
  const code = Math.round(Number(f.properties.censuscode));
  const rec = districts.get(code);
  if (!rec) continue;
  const rings = outerRings(f.geometry).filter((r) => r && r.length > 3);
  if (!rings.length) continue;
  // Area-weighted centroid across parts, so island/enclave districts land sanely.
  let wx = 0, wy = 0, wa = 0;
  for (const r of rings) {
    const c = ringCentroid(r);
    if (c) { wx += c.lng * c.area; wy += c.lat * c.area; wa += c.area; }
  }
  if (!wa) continue;
  rec.lat = +(wy / wa).toFixed(5);
  rec.lng = +(wx / wa).toFixed(5);
  rec.areaDeg2 = +wa.toFixed(5);
  rec.bbox = bbox(rings).map((v) => +v.toFixed(5));
  polys.push({ code, rings, bbox: rec.bbox });
  polyMatched++;
}
console.log(`polygons    : ${polyMatched} districts matched on censuscode`);
const noGeom = [...districts.values()].filter((d) => d.lat === undefined);
if (noGeom.length) console.log(`  WARNING no geometry: ${noGeom.map((d) => d.code + ':' + d.censusDistrict).join(', ')}`);

// ------------------------------------------------------- 3. locality coords
const llRows = readCsv(path.join(RAW, 'postoffice_latlng.txt'), '|');
const coordByKey = new Map();
for (const r of llRows) {
  const lat = Number(r.lat), lng = Number(r.lon);
  if (!(lat > 6 && lat < 38 && lng > 68 && lng < 98)) continue;
  coordByKey.set(norm(r.address) + '|' + String(r.pincode).trim(), [lat, lng]);
}
console.log(`coords      : ${coordByKey.size} geocoded post offices`);

const poRows = readCsv(path.join(RAW, 'postoffices.csv'));
const localities = [];
for (const r of poRows) {
  const name = String(r.officename || '').replace(/\s+(B\.O|S\.O|H\.O|G\.P\.O)\.?$/i, '').trim();
  if (!name) continue;
  const c = coordByKey.get(norm(r.officename) + '|' + String(r.pincode).trim());
  localities.push({
    name,
    taluk: titleCase(r.Taluk) || null,
    pin: String(r.pincode).trim(),
    lat: c ? c[0] : null,
    lng: c ? c[1] : null,
    postalState: r.statename,
    postalDistrict: r.Districtname,
    kind: String(r.officeType || '').toUpperCase(), // H.O / S.O / B.O ~ urban..rural
  });
}
const geocoded = localities.filter((l) => l.lat !== null).length;
console.log(`localities  : ${localities.length} post offices, ${geocoded} with coordinates ` +
  `(${(geocoded / localities.length * 100).toFixed(1)}%)`);

// ---------------------------------------------- 4. spatial join: point -> district
// Grid index over district bboxes keeps this O(n) rather than 141k x 640.
const CELL = 1.0; // degrees
const grid = new Map();
const cellKey = (gx, gy) => gx + ':' + gy;
for (const p of polys) {
  const [x0, y0, x1, y1] = p.bbox;
  for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++) {
    for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) {
      const k = cellKey(gx, gy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(p);
    }
  }
}

const polyByCode = new Map(polys.map((p) => [p.code, p]));
const districtOf = (lng, lat) => {
  const cands = grid.get(cellKey(Math.floor(lng / CELL), Math.floor(lat / CELL))) || [];
  for (const p of cands) {
    const [x0, y0, x1, y1] = p.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    if (pointInRings(lng, lat, p.rings)) return p.code;
  }
  return null;
};

// -- pass A: strict point-in-polygon for the geocoded subset
let inside = 0;
for (const loc of localities) {
  if (loc.lat === null) continue;
  const code = districtOf(loc.lng, loc.lat);
  if (code) { loc.code = code; inside++; }
}
console.log(`pass A      : ${inside} geocoded localities placed inside a district polygon`);

// -- pass B: learn postal-district -> censuscode from where its points actually landed
const voteByPostalKey = new Map();
for (const loc of localities) {
  if (!loc.code) continue;
  const key = norm(loc.postalState) + '/' + norm(loc.postalDistrict);
  if (!voteByPostalKey.has(key)) voteByPostalKey.set(key, new Map());
  const v = voteByPostalKey.get(key);
  v.set(loc.code, (v.get(loc.code) || 0) + 1);
}
// Candidate census districts sharing a normalised name (Aurangabad, Bilaspur,
// Hamirpur and Pratapgarh each exist in two states, so names alone are ambiguous).
const codesByName = new Map();
for (const [code, rec] of districts) {
  const k = norm(rec.censusDistrict);
  if (!codesByName.has(k)) codesByName.set(k, []);
  codesByName.get(k).push(code);
}
// Every postal key is scored against both kinds of evidence. Neither alone is
// sufficient: names drift across sources, and the geocode file is sparse enough
// that a single stray point must not be allowed to redirect a whole district.
const postalKeys = new Set(localities.map((l) => norm(l.postalState) + '/' + norm(l.postalDistrict)));
const postalToCode = new Map();
const resolveLog = { spatial: 0, name: 0, both: 0, unresolved: [] };
for (const key of postalKeys) {
  const [pState, rawDist] = key.split('/');
  const pDist = DISTRICT_ALIAS[key] || rawDist;
  const votes = voteByPostalKey.get(key) || new Map();
  const totalVotes = [...votes.values()].reduce((a, b) => a + b, 0);
  const cands = new Set([...votes.keys(), ...(codesByName.get(pDist) || [])]);
  let best = null, bestScore = 0, bestParts = null;
  for (const code of cands) {
    const rec = districts.get(code);
    if (!rec) continue;
    const v = votes.get(code) || 0;
    const nameEq = norm(rec.censusDistrict) === pDist;
    const stateEq = norm(toNcrbState(rec.censusState) || '') === norm(toNcrbState(pState) || '');
    let s = 0;
    if (nameEq) s += 100;
    if (totalVotes) s += 60 * (v / totalVotes);
    if (v >= 5) s += 20;             // enough points to trust the geometry
    if (stateEq) s += 15;            // same state after alias normalisation
    if (s > bestScore) { bestScore = s; best = code; bestParts = { nameEq, v, totalVotes }; }
  }
  if (best && bestScore >= 40) {
    postalToCode.set(key, best);
    if (bestParts.nameEq && bestParts.v >= 5) resolveLog.both++;
    else if (bestParts.nameEq) resolveLog.name++;
    else resolveLog.spatial++;
  } else if (best) {
    postalToCode.set(key, best);
    resolveLog.spatial++;
  } else {
    resolveLog.unresolved.push(key);
  }
}
console.log(`pass B      : ${postalToCode.size}/${postalKeys.size} postal districts resolved ` +
  `(${resolveLog.both} name+geometry, ${resolveLog.name} name-led, ${resolveLog.spatial} geometry-led, ` +
  `${resolveLog.unresolved.length} unresolved)`);
if (resolveLog.unresolved.length) {
  console.log(`  unresolved: ${resolveLog.unresolved.slice(0, 15).join(', ')}`);
}

// -- pass C: attach every post office, sampling a point for the ungeocoded ones
/** Deterministic PRNG so repeated builds place the same locality in the same spot. */
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function samplePoint(code, seedStr) {
  const p = polyByCode.get(code);
  const rec = districts.get(code);
  if (!p) return [rec.lat, rec.lng];
  let s = hashSeed(seedStr) || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const [x0, y0, x1, y1] = p.bbox;
  for (let i = 0; i < 300; i++) {
    const lng = x0 + rnd() * (x1 - x0), lat = y0 + rnd() * (y1 - y0);
    if (pointInRings(lng, lat, p.rings)) return [+lat.toFixed(5), +lng.toFixed(5)];
  }
  return [rec.lat, rec.lng];
}

const byDistrict = new Map();
let attached = 0, sampled = 0, orphan = 0;
for (const loc of localities) {
  let code = loc.code;
  if (!code) code = postalToCode.get(norm(loc.postalState) + '/' + norm(loc.postalDistrict)) || null;
  if (!code || !districts.has(code)) { orphan++; continue; }
  if (loc.lat === null) {
    const [la, ln] = samplePoint(code, loc.name + loc.pin);
    loc.lat = la; loc.lng = ln; loc.synthetic = true;
    sampled++;
  }
  loc.code = code;
  if (!byDistrict.has(code)) byDistrict.set(code, []);
  byDistrict.get(code).push(loc);
  attached++;
}
console.log(`pass C      : ${attached} localities attached (${sampled} coordinates sampled inside district), ${orphan} unresolved`);

// -------------------------------------------------------- 5. modern state per district
// The census state is authoritative — Census 2011 already reflects the 2000
// Chhattisgarh / Jharkhand / Uttarakhand splits. Only Telangana (2014) and Ladakh
// (2019) postdate it, and both are handled by the explicit lists above. An earlier
// version voted on the postal state of each district's localities; that misfiled
// thinly-covered districts (Imphal West -> Assam) off a single border point.
let bifurcated = 0;
for (const [code, rec] of districts) {
  const locs = byDistrict.get(code) || [];
  const dn = norm(rec.censusDistrict);
  rec.state = toNcrbState(rec.censusState);
  if (LADAKH_DISTRICTS.has(dn)) rec.state = 'Ladakh';
  else if (TELANGANA_DISTRICTS.has(dn) && norm(rec.censusState) === 'andhrapradesh') rec.state = 'Telangana';
  if (rec.state !== toNcrbState(rec.censusState)) bifurcated++;
  rec.localityCount = locs.length;
  rec.syntheticCoords = locs.filter((l) => l.synthetic).length;
}
console.log(`states      : ${bifurcated} districts reassigned for post-census bifurcations (Telangana, Ladakh)`);
const unresolved = [...districts.values()].filter((d) => !d.state);
if (unresolved.length) console.log(`  WARNING unresolved state: ${unresolved.map((d) => d.censusState).join(', ')}`);

// ----------------------------------------- 5b. locality floor for thin districts
// A handful of districts (mostly 2007-era J&K creations and Arunachal's tiny
// hill districts) have almost no post-office rows. Without a floor, every incident
// generated there would stack on one or two points, which reads as a data bug on
// the map. Backfilled points carry Indian locality-type names and are marked
// synthetic; they affect ~2% of districts.
const LOCALITY_SUFFIX = ['Bazar', 'Nagar', 'Colony', 'Chowk', 'Pura', 'Ganj', 'Cross', 'Extension',
  'Town', 'Old Town', 'New Colony', 'Market', 'Road', 'Camp', 'Basti', 'Tola'];
const FLOOR = 12;
let backfilled = 0;
for (const [code, rec] of districts) {
  if (!rec.state || rec.lat === undefined) continue;
  const locs = byDistrict.get(code) || [];
  if (locs.length >= FLOOR) continue;
  if (!byDistrict.has(code)) byDistrict.set(code, locs);
  const taluk = locs.find((l) => l.taluk)?.taluk || rec.censusDistrict;
  for (let i = locs.length; i < FLOOR; i++) {
    const name = `${rec.censusDistrict} ${LOCALITY_SUFFIX[i % LOCALITY_SUFFIX.length]}`;
    const [la, ln] = samplePoint(code, name + code);
    locs.push({ name, taluk, pin: '', lat: la, lng: ln, kind: 'B.O', synthetic: true });
    backfilled++;
  }
  rec.localityCount = locs.length;
  rec.syntheticCoords = locs.filter((l) => l.synthetic).length;
}
console.log(`floor       : ${backfilled} localities backfilled across districts under ${FLOOR} real localities`);

// --------------------------------------------------------------- 6. write out
const out = [...districts.values()]
  .filter((d) => d.state && d.lat !== undefined)
  .map((d) => ({
    code: d.code,
    district: d.censusDistrict,
    state: d.state,
    pop2011: d.pop2011,
    lat: d.lat,
    lng: d.lng,
    areaDeg2: d.areaDeg2,
    bbox: d.bbox,
    localities: d.localityCount,
    demo: d.demo,
  }))
  .sort((a, b) => a.code - b.code);

fs.writeFileSync(path.join(REF, 'india_districts_full.json'), JSON.stringify(out));
console.log(`\nref/india_districts_full.json -> ${out.length} districts, ` +
  `${new Set(out.map((d) => d.state)).size} states/UTs, ` +
  `pop ${(out.reduce((a, d) => a + d.pop2011, 0) / 1e7).toFixed(2)} crore`);

// Localities are stored as compact tuples: the readable form would be ~5x larger
// for no benefit, since only the generator reads this file.
const locOut = {};
for (const d of out) {
  const locs = byDistrict.get(d.code) || [];
  if (!locs.length) continue;
  locOut[d.code] = locs.map((l) => [l.name, l.taluk || '', l.pin, +l.lat.toFixed(5), +l.lng.toFixed(5), l.kind]);
}
fs.writeFileSync(path.join(REF, 'india_localities.json'), JSON.stringify(locOut));
const locTotal = Object.values(locOut).reduce((a, v) => a + v.length, 0);
const taluks = new Set();
for (const v of Object.values(locOut)) for (const l of v) if (l[1]) taluks.add(l[1]);
console.log(`ref/india_localities.json     -> ${locTotal} localities, ${taluks.size} taluks/tehsils`);

// Coverage report: thin districts would show up as visible clustering in the data.
const counts = out.map((d) => d.localities).sort((a, b) => a - b);
console.log(`localities per district        -> min ${counts[0]}, p10 ${counts[Math.floor(counts.length * 0.1)]}, ` +
  `median ${counts[counts.length >> 1]}, max ${counts[counts.length - 1]}`);
const thin = out.filter((d) => d.localities < 10);
console.log(`districts with <10 localities  -> ${thin.length}` +
  (thin.length ? ': ' + thin.map((d) => `${d.district}=${d.localities}`).join(', ') : ''));

// Integrity check. Post offices track population fairly tightly, so a district
// whose locality density is wildly off is the signature of a misrouted postal
// district (all of district A's post offices landing on district B).
const dens = out.filter((d) => d.pop2011 > 50000).map((d) => ({ d, r: d.localities / (d.pop2011 / 1e5) }));
const sortedR = dens.map((x) => x.r).sort((a, b) => a - b);
const med = sortedR[sortedR.length >> 1];
const outliers = dens.filter((x) => x.r < med / 6 || x.r > med * 6)
  .sort((a, b) => a.r - b.r);
console.log(`post offices per lakh          -> median ${med.toFixed(1)}; ${outliers.length} districts beyond 6x either way`);
outliers.slice(0, 12).forEach((x) => console.log(`    ${x.d.district}/${x.d.state}: ${x.r.toFixed(1)} (${x.d.localities} localities, ${(x.d.pop2011 / 1e5).toFixed(1)} lakh)`));
console.log(`  expected outliers: dense metros have few post offices per head, sparse hill`);
console.log(`  districts have many; ${POST_SNAPSHOT_DISTRICTS.join(' and ')} postdate the postal snapshot.`);
const perState = {};
for (const d of out) perState[d.state] = (perState[d.state] || 0) + 1;
console.log(`\ndistricts per state/UT:`);
Object.entries(perState).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`  ${s.padEnd(42)} ${n}`));
