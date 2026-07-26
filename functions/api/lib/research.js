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
// The only two modes. `quick` was removed: it existed to fit inside this function's
// 30-second ceiling, and ten pages read is a sample rather than research. Callers that
// cannot poll supply a callback instead and are told when the run finishes.
const MODES = ['standard', 'deep'];

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

/* ------------------------------ our own records ------------------------------ */

/**
 * What OUR database already holds about this subject, as short factual statements.
 *
 * Distinct from anchors, and the distinction matters. Anchors go INTO the search — they
 * are what makes "Suresh Kumar" findable. These go into the REPORT: the officer reading
 * what the open web says should see it beside what we already hold, because the useful
 * question is almost never "what does the internet say" but "does the internet agree
 * with our file".
 *
 * The engine cites these as [DB] and is instructed never to let them corroborate an
 * open-source claim. It gets statements rather than rows on purpose: the engine has no
 * database access and should not have any, so what crosses the boundary is a sentence
 * somebody could read out, not a schema.
 *
 * Returns [] when we hold nothing, and the engine then says nothing about records —
 * "our database has no entry" is a claim only a completed query can make, and a partial
 * failure here must not be reported as an absence.
 */
async function recordsFor(app, { kind = 'person', subject = '', crimeNo = '' } = {}) {
  const name = clean(subject);
  const safeName = esc(name);
  const out = [];
  const notes = [];
  const add = (s) => { if (s && out.length < 20) out.push(s); };

  if (crimeNo) {
    try {
      const rows = await q(app,
        `SELECT CrimeNo, CrimeHead, CrimeSubHead, Gravity, CaseStatus, DistrictName, `
        + `StationName, CrimeRegisteredDate, ActsSections, CourtName, OfficerName, `
        + `AccusedCount, VictimCount, BriefFacts FROM Cases WHERE CrimeNo='${esc(crimeNo)}' LIMIT 1`);
      const c = rows[0];
      if (c) {
        add(`Case ${clean(c.CrimeNo)} is on record: ${clean(c.CrimeHead)}`
          + `${clean(c.CrimeSubHead) ? ' / ' + clean(c.CrimeSubHead) : ''}`
          + `, registered at ${clean(c.StationName)} station, ${clean(c.DistrictName)} district`
          + `${clean(c.CrimeRegisteredDate) ? ', on ' + clean(c.CrimeRegisteredDate) : ''}.`);
        if (clean(c.CaseStatus)) add(`Its status in our records is ${clean(c.CaseStatus)}`
          + `${clean(c.CourtName) ? ' before ' + clean(c.CourtName) : ''}.`);
        if (clean(c.ActsSections)) add(`Sections invoked: ${clean(c.ActsSections)}.`);
        if (Number(c.AccusedCount) > 0) {
          add(`${Number(c.AccusedCount)} accused and ${Number(c.VictimCount) || 0} victim(s) `
            + 'are recorded against it.');
        }
        if (clean(c.BriefFacts)) add(`Brief facts on file: ${clean(c.BriefFacts).slice(0, 400)}`);
      }
    } catch (e) { notes.push('case records unavailable: ' + short(e)); }
  }

  if (kind === 'person' && name) {
    let accused = [];
    try {
      accused = await q(app,
        `SELECT AccusedName, AgeYear, Gender, DistrictName, CrimeNo, CrimeSubHead `
        + `FROM Accused WHERE AccusedName='${safeName}' LIMIT 25`);
    } catch (e) { notes.push('accused records unavailable: ' + short(e)); }

    if (accused.length) {
      const districts = [...new Set(accused.map((a) => clean(a.DistrictName)).filter(Boolean))];
      const heads = [...new Set(accused.map((a) => clean(a.CrimeSubHead)).filter(Boolean))];
      const numbers = [...new Set(accused.map((a) => clean(a.CrimeNo)).filter(Boolean))];
      const age = accused.map((a) => Number(a.AgeYear)).find((n) => n > 0);
      add(`${name} appears in our records as an accused in ${accused.length} case(s)`
        + `${districts.length ? ', in ' + districts.slice(0, 4).join(', ') : ''}.`);
      if (age) add(`Recorded age: ${age}.`);
      if (heads.length) add(`Offence types recorded: ${heads.slice(0, 6).join(', ')}.`);
      if (numbers.length) add(`Case numbers: ${numbers.slice(0, 6).join(', ')}.`);
    } else if (!notes.length) {
      add(`${name} does not appear as an accused in our records.`);
    }

    try {
      const arrests = await q(app,
        `SELECT ArrestType, ArrestDate, DistrictName FROM Arrests `
        + `WHERE AccusedName='${safeName}' ORDER BY ArrestDate DESC LIMIT 5`);
      if (arrests.length) {
        add('Arrests on record: ' + arrests.map((a) => (
          `${clean(a.ArrestType) || 'arrest'}${clean(a.ArrestDate) ? ' ' + clean(a.ArrestDate) : ''}`
          + `${clean(a.DistrictName) ? ' (' + clean(a.DistrictName) + ')' : ''}`
        )).join('; ') + '.');
      }
    } catch (e) { notes.push('arrest records unavailable: ' + short(e)); }

    try {
      const risk = await q(app,
        `SELECT TotalCases, ViolentCases, RiskScore, RiskBand, Factors FROM OffenderRisk `
        + `WHERE AccusedName='${safeName}' LIMIT 1`);
      const r = risk[0];
      if (r) {
        add(`Our repeat-offender profile scores them ${clean(r.RiskBand) || 'unrated'} `
          + `(${Number(r.RiskScore) || 0}/100) across ${Number(r.TotalCases) || 0} case(s), `
          + `${Number(r.ViolentCases) || 0} violent.`);
      }
    } catch (e) { notes.push('risk profile unavailable: ' + short(e)); }

    try {
      const links = await q(app,
        `SELECT AccusedA, AccusedB, SharedCases FROM CoAccusedLinks `
        + `WHERE AccusedA='${safeName}' OR AccusedB='${safeName}' `
        + `ORDER BY SharedCases DESC LIMIT 6`);
      const others = links.map((l) => (clean(l.AccusedA) === name ? clean(l.AccusedB) : clean(l.AccusedA)))
        .filter((x) => x && x !== name);
      if (others.length) add(`Co-accused in our records: ${others.slice(0, 5).join(', ')}.`);
    } catch (e) { notes.push('co-accused records unavailable: ' + short(e)); }
  }

  return { records: out, notes };
}

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
  role = 'investigator', officer = '', crimeNo = '',
  callbackUrl = '', callbackContext = null
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

  // What our own file says, for the report. Separate from anchors, which shape the
  // search. A failure here costs the [DB] half of the report and nothing else.
  let records = [];
  try {
    const got = await recordsFor(app, { kind, subject, crimeNo });
    records = got.records;
    meta.notes = meta.notes.concat(got.notes);
  } catch (e) {
    meta.notes.push('record summary unavailable: ' + short(e));
  }

  return {
    body: {
      subject: clean(subject), kind, purpose, question,
      mode: MODES.includes(mode) ? mode : 'standard', role,
      officer: officer || 'unknown', crime_number: clean(crimeNo),
      subject_role: meta.subjectRole, anchors, records,
      ...(callbackUrl ? {
        callback_url: callbackUrl,
        callback_key: INTERNAL_KEY,
        callback_context: callbackContext || {}
      } : {})
    },
    meta
  };
}

/** Start a run. Returns the engine's handle plus what we anchored it with. */
async function start(app, opts) {
  const { body, meta } = await requestBody(app, opts);
  const out = await call('/research', { method: 'POST', body, timeoutMs: START_TIMEOUT_MS });
  return {
    ...out, mode: body.mode, anchors: summariseAnchors(body.anchors),
    records: body.records, anchorNotes: meta.notes
  };
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
  configured, anchorsFor, recordsFor, start, poll, cancel, health, MODES,
  // exported for tests
  _internals: { requestBody, summariseAnchors, applyCase, pushUnique }
};
