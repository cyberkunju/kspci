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
  // Pages of 200: deleteRows rejects more than 200 ids at a time, and ZCQL caps LIMIT at 300, so
  // 200 is the binding constraint. The loop is bounded rather than `while (true)` — an unbounded
  // delete loop inside a request that can time out mid-way is how you get a partially cleared
  // scope with no record of where it stopped.
  for (let page = 0; page < 400; page++) {
    const res = await zcql.executeZCQLQuery(
      `SELECT ROWID FROM ${table} WHERE Scope='${esc}'${stateFilter} LIMIT 0, 200`);
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
  // Forecast payloads carry `forecasts`; early-warning payloads carry the same per-unit records
  // under `alerts` with severity attached. Both are stored as rows of the same shape.
  const units = Array.isArray(payload && payload.forecasts) ? payload.forecasts
    : (Array.isArray(payload && payload.alerts) ? payload.alerts : []);

  const cleared = await clearScope(app, TABLE, scope, partialState);
  // Exactly one metadata row per scope, always. A partial refresh rewrites it rather than
  // adding one, otherwise 36 per-state calls would leave 36 rows and the read would pick an
  // arbitrary one.
  await clearScope(app, META_TABLE, scope);

  // Sequence number per row within its state, assigned here.
  //
  // This exists because reading the scope back reliably turned out to be the hard part. ZCQL's
  // OFFSET paging returned overlapping pages, and keyset paging on ROWID skipped rows because
  // Catalyst ROWIDs are not monotonic across insert batches — both failures lost districts
  // silently. Seq is dense and contiguous per state by construction, so the read can request
  // explicit half-open ranges and depend on neither ORDER BY nor OFFSET.
  const rows = units.map((f, i) => ({
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
    // z and severity only exist on early-warning rows. Stored rather than recomputed on read,
    // because z needs the unit's recent variance, which the snapshot does not carry.
    Zscore: num(f.z),
    Severity: f.severity || null,
    ComputedAt: computedAt,
    // Dense and contiguous across the whole snapshot, so the read can ask for explicit ranges.
    // A partial per-state refresh cannot maintain a global sequence; it is numbered within the
    // state and the read detects the shortfall and falls back — see readSnapshot.
    Seq: i,
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

  const COLS = 'ROWID, StateName, DistrictName, UnitName, Predicted, Baseline, TrendPct, Low, ' +
    'High, Band, Latitude, Longitude, Zscore, Severity, Seq';
  const expected = Number(meta.UnitCount) || 0;

  /**
   * Read a scope in explicit half-open Seq ranges.
   *
   * Two paging approaches failed here before this one, both silently losing districts: ZCQL's
   * OFFSET returned overlapping pages, and keyset paging on ROWID skipped rows because Catalyst
   * ROWIDs are not monotonic across insert batches. Fixed ranges over a sequence we assign
   * ourselves depend on neither ORDER BY nor OFFSET, so there is nothing left to be unreliable.
   */
  const forecasts = [];
  const PAGE = 200;
  for (let lo = 0; lo < Math.max(expected, PAGE) + PAGE; lo += PAGE) {
    if (expected && lo >= expected) break;
    const res = await zcql.executeZCQLQuery(
      `SELECT ${COLS} FROM ${TABLE} WHERE Scope='${scope}' AND Seq >= ${lo} AND Seq < ${lo + PAGE}`);
    const batch = (res || []).map((r) => r[TABLE] || {});
    if (!batch.length && lo > 0) break;
    for (const r of batch) {
      forecasts.push({
        state: r.StateName, district: r.DistrictName, name: r.UnitName,
        predicted: num(r.Predicted), baseline: num(r.Baseline), trendPct: num(r.TrendPct),
        low: num(r.Low), high: num(r.High), band: r.Band,
        lat: num(r.Latitude), lng: num(r.Longitude),
        z: num(r.Zscore), severity: r.Severity || undefined,
      });
    }
  }

  // If the ranges did not account for every stored row, the snapshot was written by a partial
  // per-state refresh whose Seq is state-local. Fall back to one query per state, which needs no
  // paging at all because no state has more than ~71 districts.
  if (expected && forecasts.length < expected) {
    const states = await zcql.executeZCQLQuery(
      `SELECT DISTINCT StateName FROM ${TABLE} WHERE Scope='${scope}'`);
    const names = [...new Set((states || []).map((r) => (r[TABLE] || {}).StateName).filter(Boolean))];
    forecasts.length = 0;
    for (const st of names) {
      const res = await zcql.executeZCQLQuery(
        `SELECT ${COLS} FROM ${TABLE} WHERE Scope='${scope}' AND StateName='${String(st).replace(/'/g, "''")}'`);
      for (const raw of (res || [])) {
        const r = raw[TABLE] || {};
        forecasts.push({
          state: r.StateName, district: r.DistrictName, name: r.UnitName,
          predicted: num(r.Predicted), baseline: num(r.Baseline), trendPct: num(r.TrendPct),
          low: num(r.Low), high: num(r.High), band: r.Band,
          lat: num(r.Latitude), lng: num(r.Longitude),
          z: num(r.Zscore), severity: r.Severity || undefined,
        });
      }
    }
  }

  if (forecasts.length) {
    // Belt and braces: even with keyset paging, a duplicate physically present in the table would
    // reach the client. One row per unit is a property callers rely on, so it is enforced here.
    const byUnit = new Map();
    for (const f of forecasts) byUnit.set(`${f.state || ''}|${f.district || ''}`, f);
    if (byUnit.size !== forecasts.length) {
      forecasts.length = 0;
      forecasts.push(...byUnit.values());
    }
  }
  if (!forecasts.length) return null;
  forecasts.sort((a, b) => (b.predicted || 0) - (a.predicted || 0));

  let context = {};
  try { context = JSON.parse(meta.Payload || '{}'); } catch (_) { context = {}; }
  // Early-warning clients read `alerts`, forecast clients read `forecasts`. The rows are the
  // same shape, so the route decides the key rather than the storage duplicating them.
  const keyed = route === 'earlywarning'
    ? { alerts: forecasts.filter((f) => f.severity),
        critical: forecasts.filter((f) => f.severity === 'critical').length,
        elevated: forecasts.filter((f) => f.severity === 'elevated').length }
    : { forecasts };
  return {
    ...context,
    ...keyed,
    cached: true,
    computedAt: meta.ComputedAt,
    ageHours: +((Date.now() - Date.parse(meta.ComputedAt)) / 3.6e6).toFixed(2),
  };
}

/**
 * Remove duplicate units from a scope, keeping the most recently computed row.
 *
 * Duplicates are not a bug that can be designed away: `insert` retries on a failed request, and
 * a request can fail at the client after succeeding at the server, so the retry writes a second
 * copy. On the map that shows up as one district drawn twice, and in any aggregate as a unit
 * counted twice. Cheaper and more reliable to detect and repair than to attempt exactly-once
 * delivery over a plain HTTP insert.
 */
async function dedupeScope(app, scope) {
  const zcql = app.zcql();
  const esc = scope.replace(/'/g, "''");
  const seen = new Map();          // 'state|district' -> { rowid, computedAt }
  const extra = [];
  let lastRowId = 0;
  // Keyset paging, for the same reason as readSnapshot: offset paging returned overlapping pages.
  for (let page = 0; page < 40; page++) {
    const res = await zcql.executeZCQLQuery(
      `SELECT ROWID, StateName, DistrictName, ComputedAt FROM ${TABLE} WHERE Scope='${esc}' AND ROWID > ${lastRowId} ORDER BY ROWID LIMIT 200`);
    const batch = (res || []).map((r) => r[TABLE] || {});
    if (!batch.length) break;
    for (const r of batch) {
      const id = Number(r.ROWID);
      if (Number.isFinite(id) && id > lastRowId) lastRowId = id;
      const key = `${r.StateName || ''}|${r.DistrictName || ''}`;
      const prev = seen.get(key);
      if (!prev) { seen.set(key, { rowid: r.ROWID, computedAt: r.ComputedAt }); continue; }
      // Never treat a row as its own duplicate. With the offset paging this used to do, the same
      // physical row could appear on two pages, and deleting the "older copy" deleted the row
      // itself — this silently destroyed real districts before the paging was fixed.
      if (String(prev.rowid) === String(r.ROWID)) continue;
      // Keep the newer row, discard the older one.
      if (String(r.ComputedAt || '') >= String(prev.computedAt || '')) {
        extra.push(prev.rowid);
        seen.set(key, { rowid: r.ROWID, computedAt: r.ComputedAt });
      } else {
        extra.push(r.ROWID);
      }
    }
    if (batch.length < 200) break;
  }
  const t = app.datastore().table(TABLE);
  for (let i = 0; i < extra.length; i += 200) {
    await t.deleteRows(extra.slice(i, i + 200));
  }
  return { units: seen.size, removed: extra.length };
}

module.exports = { TABLE, META_TABLE, scopeKey, writeSnapshot, readSnapshot, clearScope, dedupeScope };
