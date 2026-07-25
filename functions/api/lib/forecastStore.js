'use strict';

/**
 * Batch-scored forecast snapshots.
 *
 * The problem this solves. The forecast routes train inside the HTTP request: roughly seventy
 * paged ZCQL queries to assemble the panel, then a gradient-boosted model fitted from scratch,
 * all inside a Catalyst Function's 25-second ceiling. That worked at Karnataka scale and does
 * not at national scale, and it is the reason the live service was pinned to the coarsest
 * resolution available. Training per request is also simply wrong: every user pays for a fit
 * whose answer is identical for all of them and changes only when new cases land.
 *
 * So scoring is batched. An admin-triggered refresh computes the forecast once and writes it to
 * the Data Store; the read routes select from that table and serve it. Reads become a single
 * indexed query.
 *
 * Why the Data Store and not Cache. A national district-level payload is ~300 KB. A single
 * Catalyst cache item is limited to 16,000 characters, so it would have to be split across
 * roughly twenty-five keys and reassembled on every read, non-atomically — a partial write
 * would serve a half-updated forecast with no way to detect it. The Data Store gives one query,
 * one consistent snapshot, and no size ceiling.
 *
 * Degradation is deliberate: when the table is absent or empty the routes fall back to live
 * computation, so this is additive and deploying it cannot break the existing behaviour.
 */

const TABLE = 'Forecasts';
const META_TABLE = 'ForecastMetrics';

/** Scope key for a snapshot. One snapshot per (route, level, state) combination. */
const scopeKey = (route, { level = 'district', state = null } = {}) =>
  `${route}|${level}|${state || 'ALL'}`;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Rows are written in batches. insertRows has a per-call row ceiling and a 640-district
 * snapshot exceeds it, so the write is chunked; 200 matches what the bulk loader uses.
 */
async function insertChunked(app, table, rows, chunk = 200) {
  const t = app.datastore().table(table);
  for (let i = 0; i < rows.length; i += chunk) {
    await t.insertRows(rows.slice(i, i + chunk));
  }
  return rows.length;
}

/**
 * Delete rows of a scope before rewriting them, so a snapshot is never half-old.
 *
 * ``onlyState`` narrows the delete to one state's rows. That is what makes a national snapshot
 * buildable from a Catalyst Function at all: a 640-district forecast takes the engine ~28s,
 * past the 25s request ceiling, so the refresh runs one state per call and each call replaces
 * only its own slice of the shared national scope.
 */
async function clearScope(app, table, scope, onlyState = null) {
  const zcql = app.zcql();
  const esc = scope.replace(/'/g, "''");
  const stateFilter = onlyState
    ? ` AND StateName='${String(onlyState).replace(/'/g, "''")}'` : '';
  const t = app.datastore().table(table);
  // ZCQL caps LIMIT at 300, so this pages. The loop is bounded rather than `while (true)`:
  // an unbounded delete loop inside a request that can time out mid-way is how you get a
  // partially cleared scope and no record of where it stopped.
  for (let page = 0; page < 400; page++) {
    const res = await zcql.executeZCQLQuery(
      `SELECT ROWID FROM ${table} WHERE Scope='${esc}'${stateFilter} LIMIT 0, 300`);
    const ids = (res || []).map((r) => (r[table] || {}).ROWID).filter(Boolean);
    if (!ids.length) return page;
    await t.deleteRows(ids);
  }
  return -1; // hit the page ceiling; caller reports it rather than assuming success
}

/**
 * Write one forecast payload as a snapshot.
 *
 * The per-unit rows carry the numbers a client renders; the payload's scalar context (model
 * weights, accuracy, horizon) goes to ForecastMetrics as one JSON row, because it is metadata
 * about the snapshot rather than per-unit data and duplicating it 640 times would be silly.
 */
async function writeSnapshot(app, route, opts, payload, { partialState = null } = {}) {
  // A partial refresh contributes one state's rows to the shared national scope rather than
  // creating a scope of its own, so the national read still returns every district.
  const scope = scopeKey(route, partialState ? { ...opts, state: null } : opts);
  const computedAt = new Date().toISOString();
  const units = Array.isArray(payload && payload.forecasts) ? payload.forecasts : [];

  const cleared = await clearScope(app, TABLE, scope, partialState);
  // Exactly one metadata row per scope, always. A partial refresh rewrites it rather than
  // adding one, otherwise 36 per-state calls would leave 36 rows and the read would pick an
  // arbitrary one.
  await clearScope(app, META_TABLE, scope);

  const rows = units.map((f) => ({
    Scope: scope,
    Level: opts.level || 'district',
    StateName: f.state || null,
    DistrictName: f.district || null,
    UnitName: f.name || f.district || f.state || null,
    Horizon: payload.horizon || null,
    Predicted: num(f.predicted),
    Baseline: num(f.baseline),
    TrendPct: num(f.trendPct),
    Low: num(f.low),
    High: num(f.high),
    Band: f.band || f.riskBand || null,
    Latitude: num(f.lat),
    Longitude: num(f.lng),
    ComputedAt: computedAt,
  }));

  const inserted = rows.length ? await insertChunked(app, TABLE, rows) : 0;

  // For a partial refresh the metadata must describe the whole scope, not the slice just
  // written, so the count comes from the table rather than from this call.
  let total = inserted;
  if (partialState) {
    try {
      const c = await app.zcql().executeZCQLQuery(
        `SELECT COUNT(ROWID) FROM ${TABLE} WHERE Scope='${scope.replace(/'/g, "''")}'`);
      const obj = c && c[0] && c[0][TABLE];
      if (obj) total = Number(Object.values(obj)[0]) || inserted;
    } catch (_) { /* count is informational; a failure must not lose the snapshot */ }
  }

  // Everything except the per-unit array, so a read can reconstruct the exact payload.
  const context = { ...payload };
  delete context.forecasts;
  await insertChunked(app, META_TABLE, [{
    Scope: scope,
    Level: opts.level || 'district',
    StateName: partialState ? null : (opts.state || null),
    Payload: JSON.stringify(context),
    UnitCount: total,
    ComputedAt: computedAt,
  }]);

  return { scope, inserted, totalInScope: total, computedAt, clearedPages: cleared,
    partialState: partialState || undefined };
}

/**
 * Read a snapshot back. Returns null when there is none, which the caller treats as
 * "compute it live" rather than as an error.
 */
async function readSnapshot(app, route, opts, { maxAgeHours = 0 } = {}) {
  const scope = scopeKey(route, opts).replace(/'/g, "''");
  const zcql = app.zcql();
  let metaRows;
  try {
    metaRows = await zcql.executeZCQLQuery(
      `SELECT Payload, UnitCount, ComputedAt FROM ${META_TABLE} WHERE Scope='${scope}' LIMIT 0, 1`);
  } catch (_) {
    return null; // table not created yet
  }
  const meta = metaRows && metaRows[0] && metaRows[0][META_TABLE];
  if (!meta || !meta.ComputedAt) return null;

  if (maxAgeHours > 0) {
    const ageH = (Date.now() - Date.parse(meta.ComputedAt)) / 3.6e6;
    // Stale is reported, not silently served: a forecast whose age the caller cannot see is
    // indistinguishable from a current one.
    if (Number.isFinite(ageH) && ageH > maxAgeHours) return null;
  }

  const forecasts = [];
  for (let offset = 0; offset < 4000; offset += 300) {
    const res = await zcql.executeZCQLQuery(
      `SELECT StateName, DistrictName, UnitName, Predicted, Baseline, TrendPct, Low, High, Band, Latitude, Longitude FROM ${TABLE} WHERE Scope='${scope}' ORDER BY Predicted DESC LIMIT ${offset}, 300`);
    const batch = (res || []).map((r) => r[TABLE] || {});
    for (const r of batch) {
      forecasts.push({
        state: r.StateName, district: r.DistrictName, name: r.UnitName,
        predicted: num(r.Predicted), baseline: num(r.Baseline), trendPct: num(r.TrendPct),
        low: num(r.Low), high: num(r.High), band: r.Band,
        lat: num(r.Latitude), lng: num(r.Longitude),
      });
    }
    if (batch.length < 300) break;
  }
  if (!forecasts.length) return null;

  let context = {};
  try { context = JSON.parse(meta.Payload || '{}'); } catch (_) { context = {}; }
  return {
    ...context,
    forecasts,
    cached: true,
    computedAt: meta.ComputedAt,
    ageHours: +((Date.now() - Date.parse(meta.ComputedAt)) / 3.6e6).toFixed(2),
  };
}

module.exports = { TABLE, META_TABLE, scopeKey, writeSnapshot, readSnapshot, clearScope };
