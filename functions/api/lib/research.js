'use strict';

/**
 * Bridge from this function to the OSINT research engine (Catalyst AppSail).
 *
 * The engine is a separate service for one hard reason: an Advanced I/O function is
 * killed at 30 seconds, and a broad research run takes 40 to 300. So this module
 * starts runs and polls them; it never holds one open.
 *
 * It does two things, and the first is the more important.
 *
 * IT SUPPLIES THE ANCHORS. The engine's accuracy rests almost entirely on knowing
 * something discriminating about the subject before it searches. "Suresh Kumar" has
 * millions of matches; "Suresh Kumar", Mysuru, aged 34, FIR 118/2023, co-accused
 * Manjunath has approximately one. Those facts are in our own Data Store, which is
 * why this bridge exists here rather than being a URL the client calls directly.
 *
 * IT DECIDES WHO THE SUBJECT IS TO US. If the name we were handed appears in our
 * records as a victim or a complainant and NOT as an accused, that is passed through
 * as `subject_role` and the engine refuses the run. A person who reported a crime did
 * not volunteer to have their open-source footprint assembled.
 *
 * Both halves fail soft. If the Data Store is unreachable the run still happens with
 * whatever the officer typed, and the report says the anchors were thin — a weakly
 * anchored run is honest about what it cannot conclude, which is the whole design of
 * the attribution stage.
 */

const SERVICE_URL = (process.env.RESEARCH_SERVICE_URL || '').replace(/\/+$/, '');
const INTERNAL_KEY = process.env.RESEARCH_INTERNAL_KEY || '';
const START_TIMEOUT_MS = Number(process.env.RESEARCH_START_TIMEOUT_MS || 15000);
const POLL_TIMEOUT_MS = Number(process.env.RESEARCH_POLL_TIMEOUT_MS || 20000);
// A sync run is capped well below the function's own 30s ceiling: the engine's quick
// budget is 25s, and we must still be able to read and return its response.
const SYNC_TIMEOUT_MS = Number(process.env.RESEARCH_SYNC_TIMEOUT_MS || 27000);

const esc = (s) => String(s == null ? '' : s).replace(/'/g, '');
const clean = (s) => String(s == null ? '' : s).trim();

function configured() {
  return Boolean(SERVICE_URL && INTERNAL_KEY);
}

async function q(app, query) {
  const rows = (await app.zcql().executeZCQLQuery(query)) || [];
  // ZCQL nests each row under its table name; a joined row carries several keys.
  return rows.map((r) => Object.assign({}, ...Object.values(r)));
}

/* --------------------------------- anchors --------------------------------- */

/**
 * Everything our records know that could distinguish this subject from a namesake.
 *
 * Every query here is capped and none of them are on a hot path — one research run
 * costs a handful of reads against tables the analytics endpoints already hit far
 * harder. Each lookup is independently wrapped: a missing table (a deployment where
 * CoAccusedLinks was never created) costs one class of anchor, not the run.
 */
async function anchorsFor(app, { kind = 'person', subject = '', crimeNo = '' } = {}) {
  const name = clean(subject);
  const out = {
    names: name ? [name] : [],
    district: '', state: '', station: '', age: null,
    crime_numbers: [], sections: [], associates: [], organisations: [],
    date_from: '', date_to: ''
  };
  const meta = { subjectRole: '', matchedRecords: 0, notes: [] };
  if (!name && !crimeNo) return { anchors: out, meta };

  const safeName = esc(name);
  const caseIds = new Set();

  // ---- the case, when we were given one. Most discriminating single anchor. ----
  if (crimeNo) {
    try {
      const rows = await q(app,
        `SELECT CaseMasterID, CrimeNo, StateName, DistrictName, StationName, ActsSections, `
        + `CrimeRegisteredDate, IncidentDate, CrimeHead, CrimeSubHead `
        + `FROM Cases WHERE CrimeNo='${esc(crimeNo)}' LIMIT 1`);
      if (rows.length) applyCase(out, caseIds, rows[0]);
      else meta.notes.push(`no case in our records with CrimeNo ${crimeNo}`);
    } catch (e) { meta.notes.push('case lookup failed: ' + short(e)); }
  }

  // ---- the person, as an accused ----
  let accused = [];
  if (kind === 'person' && name) {
    try {
      accused = await q(app,
        `SELECT AccusedMasterID, AccusedName, PersonID, AgeYear, Gender, RingID, `
        + `DistrictName, CrimeNo, CaseMasterID, CrimeSubHead `
        + `FROM Accused WHERE AccusedName='${safeName}' LIMIT 20`);
    } catch (e) { meta.notes.push('accused lookup failed: ' + short(e)); }
    for (const a of accused) {
      meta.matchedRecords += 1;
      if (!out.district && clean(a.DistrictName)) out.district = clean(a.DistrictName);
      if (!out.age && Number(a.AgeYear) > 0) out.age = Number(a.AgeYear);
      if (clean(a.CrimeNo)) pushUnique(out.crime_numbers, clean(a.CrimeNo), 4);
      if (Number(a.CaseMasterID) > 0) caseIds.add(Number(a.CaseMasterID));
    }
  }

  // ---- subject role: is this person a victim or a complainant to us? ----
  // Only asked when they are NOT an accused. Someone who is both is a subject of
  // investigation, and the accused record is the one that governs.
  if (kind === 'person' && name && !accused.length) {
    meta.subjectRole = await subjectRole(app, safeName, meta);
  }

  // ---- the cases behind those accused records: state, station, sections, dates ----
  const ids = [...caseIds].slice(0, 8);
  if (ids.length) {
    try {
      const where = ids.map((i) => `CaseMasterID=${i}`).join(' OR ');
      const rows = await q(app,
        `SELECT CaseMasterID, CrimeNo, StateName, DistrictName, StationName, ActsSections, `
        + `CrimeRegisteredDate, IncidentDate, CrimeHead, CrimeSubHead `
        + `FROM Cases WHERE ${where} LIMIT 20`);
      for (const c of rows) applyCase(out, caseIds, c);
    } catch (e) { meta.notes.push('case detail lookup failed: ' + short(e)); }
  }

  // ---- co-accused: a second name in the same report is near-conclusive ----
  if (name) {
    try {
      const rows = await q(app,
        `SELECT AccusedA, AccusedB, SharedCases FROM CoAccusedLinks `
        + `WHERE AccusedA='${safeName}' OR AccusedB='${safeName}' `
        + `ORDER BY SharedCases DESC LIMIT 12`);
      for (const r of rows) {
        const other = clean(r.AccusedA) === name ? clean(r.AccusedB) : clean(r.AccusedA);
        if (other && other !== name) pushUnique(out.associates, other, 6);
      }
    } catch (e) { meta.notes.push('co-accused lookup failed: ' + short(e)); }
  }

  return { anchors: out, meta };
}

function applyCase(out, caseIds, c) {
  if (Number(c.CaseMasterID) > 0) caseIds.add(Number(c.CaseMasterID));
  if (!out.state && clean(c.StateName)) out.state = clean(c.StateName);
  if (!out.district && clean(c.DistrictName)) out.district = clean(c.DistrictName);
  if (!out.station && clean(c.StationName)) out.station = clean(c.StationName);
  if (clean(c.CrimeNo)) pushUnique(out.crime_numbers, clean(c.CrimeNo), 4);
  // ActsSections is a free-text list; split it so each section is its own anchor.
  for (const s of clean(c.ActsSections).split(/[,;/]+/)) {
    const v = s.trim();
    if (v.length >= 2 && v.length <= 40) pushUnique(out.sections, v, 6);
  }
  // Earliest date we know about opens the search window. The engine widens it
  // backwards by sixty days and leaves it open at the top, because a verdict is
  // reported years after the incident.
  for (const d of [clean(c.IncidentDate), clean(c.CrimeRegisteredDate)]) {
    if (d && (!out.date_from || d < out.date_from)) out.date_from = d;
  }
}

/** Does our own record cast this person as someone the engine must not research? */
async function subjectRole(app, safeName, meta) {
  const probes = [
    ['Victims', 'VictimName', 'victim'],
    ['Complainants', 'ComplainantName', 'complainant']
  ];
  for (const [table, column, role] of probes) {
    try {
      const rows = await q(app,
        `SELECT ${column} FROM ${table} WHERE ${column}='${safeName}' LIMIT 1`);
      if (rows.length) return role;
    } catch (e) { meta.notes.push(`${table} lookup failed: ` + short(e)); }
  }
  return '';
}

function pushUnique(arr, value, cap) {
  const v = clean(value);
  if (!v || arr.length >= cap) return;
  if (!arr.some((x) => x.toLowerCase() === v.toLowerCase())) arr.push(v);
}

const short = (e) => String((e && e.message) || e).slice(0, 120);

/* ---------------------------------- proxy ---------------------------------- */

async function call(path, { method = 'GET', body, timeoutMs } = {}) {
  if (!configured()) {
    const err = new Error(
      'the research engine is not configured — set RESEARCH_SERVICE_URL and '
      + 'RESEARCH_INTERNAL_KEY on this function');
    err.status = 503;
    err.code = 'research_unconfigured';
    throw err;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || POLL_TIMEOUT_MS);
  try {
    const res = await fetch(SERVICE_URL + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        // The engine fetches attacker-influenceable URLs on instruction. This key is
        // what stops it being an open proxy; it never reaches a client.
        'x-research-key': INTERNAL_KEY
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = data && data.detail;
      const err = new Error(
        (detail && detail.message) || data.message || data.error || `engine returned ${res.status}`);
      err.status = res.status === 401 ? 502 : res.status;
      err.code = (detail && detail.error) || data.error || 'research_failed';
      throw err;
    }
    return data;
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = new Error('the research engine did not answer in time');
      err.status = 504;
      err.code = 'research_timeout';
      throw err;
    }
    if (e && e.status) throw e;
    const err = new Error('could not reach the research engine: ' + short(e));
    err.status = 502;
    err.code = 'research_unreachable';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the engine's request body: the officer's words plus our records' facts.
 *
 * `subject_role` is set from OUR records, never from the caller. A client that could
 * choose the subject's role could choose to omit it.
 */
async function requestBody(app, {
  subject, kind = 'person', purpose = '', question = '', mode = 'standard',
  role = 'investigator', officer = '', crimeNo = ''
}) {
  let anchors = { names: [clean(subject)].filter(Boolean) };
  let meta = { subjectRole: '', matchedRecords: 0, notes: ['records were not consulted'] };
  try {
    const got = await anchorsFor(app, { kind, subject, crimeNo });
    anchors = got.anchors;
    meta = got.meta;
  } catch (e) {
    meta = { subjectRole: '', matchedRecords: 0, notes: ['anchor lookup failed: ' + short(e)] };
  }
  return {
    body: {
      subject: clean(subject), kind, purpose, question, mode, role,
      officer: officer || 'unknown', crime_number: clean(crimeNo),
      subject_role: meta.subjectRole, anchors
    },
    meta
  };
}

/** Start a run. Returns the engine's handle plus what we anchored it with. */
async function start(app, opts) {
  const { body, meta } = await requestBody(app, opts);
  const out = await call('/research', { method: 'POST', body, timeoutMs: START_TIMEOUT_MS });
  return { ...out, anchors: summariseAnchors(body.anchors), anchorNotes: meta.notes };
}

/** Run to completion inside this request. Quick mode only — see SYNC_TIMEOUT_MS. */
async function sync(app, opts) {
  const { body, meta } = await requestBody(app, { ...opts, mode: 'quick' });
  const out = await call('/research/sync', { method: 'POST', body, timeoutMs: SYNC_TIMEOUT_MS });
  return { ...out, anchors: summariseAnchors(body.anchors), anchorNotes: meta.notes };
}

const poll = (id) => call('/research/' + encodeURIComponent(id));
const cancel = (id) => call('/research/' + encodeURIComponent(id), { method: 'DELETE' });
const health = () => call('/health', { timeoutMs: 8000 });

/**
 * What the run was anchored on, for the officer to see.
 *
 * Shown in the UI on purpose. An officer reading "confirmed" needs to know it was
 * confirmed against a district and an FIR number rather than against a bare name,
 * because those two claims deserve very different amounts of trust.
 */
function summariseAnchors(a) {
  return {
    names: a.names || [], district: a.district || '', state: a.state || '',
    station: a.station || '', age: a.age || null,
    crimeNumbers: a.crime_numbers || [], sections: a.sections || [],
    associates: a.associates || [], from: a.date_from || ''
  };
}

module.exports = {
  configured, anchorsFor, start, sync, poll, cancel, health,
  // exported for tests
  _internals: { requestBody, summariseAnchors, applyCase, pushUnique }
};
