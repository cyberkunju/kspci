'use strict';

/**
 * Rebuild the forecast snapshots the API serves, one state at a time.
 *
 * Why per state. The engine needs ~28 seconds for a national 640-district monthly forecast, and
 * a Catalyst Function has a 25-second request ceiling. Splitting by state keeps every call to a
 * few seconds while still producing one national snapshot: each call replaces only its own
 * state's rows inside the shared scope.
 *
 * Run after loading data. Forecasts change when cases arrive, not on a clock, so this is
 * deliberately manual rather than scheduled.
 *
 *   node datastore/refresh-forecast.js
 *   node datastore/refresh-forecast.js --states Karnataka,Kerala
 *   node datastore/refresh-forecast.js --concurrency 4
 */

const path = require('path');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes('--' + name);

const BASE = (arg('base', process.env.KSP_API_BASE || 'https://ksp.cyberkunju.com/server/api')).replace(/\/$/, '');
const ADMIN_KEY = arg('key', process.env.ADMIN_KEY || '');
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '3'), 10));
const RETRIES = 3;

if (!ADMIN_KEY) {
  console.error('ADMIN_KEY is required (env ADMIN_KEY or --key). It is not stored in the repo.');
  process.exit(1);
}

function statesFromRef() {
  const ref = require(path.join(__dirname, 'ref', 'india_districts.json'));
  return [...new Set(ref.map((d) => d.state))].sort();
}

const STATES = (arg('states', '') ? arg('states', '').split(',').map((s) => s.trim()).filter(Boolean)
  : statesFromRef());

async function refreshState(state) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const r = await fetch(`${BASE}/admin/forecast/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
        body: JSON.stringify({ level: 'district', state, partial: true }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
      const fc = (body.results || {}).forecast || {};
      if (fc.error) throw new Error(fc.error);
      return { state, units: fc.inserted, total: fc.totalInScope, ms: body.elapsedMs };
    } catch (e) {
      lastErr = e;
      // Linear backoff. The failure mode here is a cold container or a transient ZCQL timeout,
      // both of which clear in seconds; anything that survives three tries is a real fault and
      // should be reported rather than retried into a loop.
      if (attempt < RETRIES) await new Promise((s) => setTimeout(s, 3000 * attempt));
    }
  }
  return { state, error: String((lastErr && lastErr.message) || lastErr) };
}

async function purge() {
  const r = await fetch(`${BASE}/admin/forecast/purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': ADMIN_KEY },
    body: JSON.stringify({ level: 'district' }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`purge failed: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

(async () => {
  // Rebuild from empty when asked. Per-state writes cannot clear rows left by an earlier
  // national run (their StateName is null) or duplicates from a timed-out request whose inserts
  // landed late, and both show up as extra units on the map.
  if (has('purge')) {
    console.log('purging both district scopes first');
    console.log('  ' + JSON.stringify((await purge()).purged));
  }
  console.log(`refreshing ${STATES.length} states via ${BASE} (concurrency ${CONCURRENCY})`);
  const queue = [...STATES];
  const done = [];
  const failed = [];

  const worker = async () => {
    while (queue.length) {
      const state = queue.shift();
      const r = await refreshState(state);
      if (r.error) {
        failed.push(r);
        console.log(`  ✗ ${state}: ${r.error}`);
      } else {
        done.push(r);
        console.log(`  ✓ ${state.padEnd(28)} ${String(r.units).padStart(4)} districts  ` +
          `${String(r.total).padStart(4)} in scope  ${r.ms}ms`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, STATES.length) }, worker));

  console.log(`\n${done.length} states refreshed, ${failed.length} failed`);
  if (failed.length) {
    // Non-zero exit so this is usable in a deploy script without the caller having to parse
    // output to notice that a third of the country has no forecast.
    console.log('failed: ' + failed.map((f) => f.state).join(', '));
    process.exit(1);
  }
})();
