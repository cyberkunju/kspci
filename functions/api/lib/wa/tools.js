'use strict';

/**
 * The field agent's action space.
 *
 * Each tool is a small, named, role-gated capability with a bounded result. A
 * tool exists for one of two reasons only: the model cannot express it as a
 * SELECT (a photo comparison, a subscription change, asking the officer a
 * question that will actually resolve), or expressing it as SELECTs would cost
 * several conversational round-trips that a person standing in a street should
 * not wait for. Everything else the model writes as ZCQL.
 *
 * Four invariants hold here rather than in the prompt, because a prompt is
 * advice and this is enforcement:
 *
 *  1. SCOPE IS SERVER-INJECTED. The officer, their role and their posting come
 *     from `ctx`, which came from the roster. No tool reads identity from its
 *     arguments, so no message can talk its way into another officer's scope.
 *
 *  2. WRITES ARE GATED TWICE. Once by role, once by the epistemic gate — a
 *     negated or hypothetical phrasing can never mint a write, whatever the model
 *     decided.
 *
 *  3. EVERY WRITE IS REVERSIBLE AND AUDITED. Each returns an undo token, and
 *     every invocation lands in the ledger with a hash of its arguments.
 *
 *  4. RESULTS FEED THE GROUNDING SET. Identifiers a tool actually returned are
 *     recorded, so the agent can verify afterwards that the reply only cites
 *     things that exist. See verifyGrounding().
 */

const crypto = require('crypto');
const { isSafeSelect, runZcql } = require('../chat');
const photo = require('./photo');
const officers = require('./officers');
const frames = require('./frames');
const guard = require('./waGuard');

const ANY = ['investigator', 'analyst', 'supervisor', 'policymaker', 'admin'];

/**
 * Words that make a message about alert *settings* rather than about a district.
 *
 * "alert" and "notification" are English inside all three copy packs by design, so
 * officers write them in English whatever language they are typing; the Kannada and
 * Devanagari forms are here for the ones who do not. Subscription verbs are included
 * because "unsubscribe me" and "mute this" carry the intent without the noun.
 */
const ALERT_INTENT = /alert|notif|subscrib|unsubscrib|mute|unmute|remind|ಅಲರ್ಟ್|ಸೂಚನೆ|ಎಚ್ಚರಿಕೆ|अलर्ट|सूचना|चेतावनी/i;
const ANALYST_PLUS = ['analyst', 'supervisor', 'policymaker', 'admin'];
// Field-write and biometric actions: everyone operational, minus the read-only
// policymaker role. Mirrors /ingest/* on the web API.
const OPERATIONAL = ['investigator', 'analyst', 'supervisor', 'admin'];

const flat = (rows, n = 25) => rows.slice(0, n);

/** ZCQL caps LIMIT at 300; an agent observation is capped far tighter than that. */
function enforceRowLimit(zcql, max = 40) {
  const s = String(zcql).trim().replace(/;+\s*$/, '');
  const m = s.match(/\blimit\s+(\d+)\s*$/i);
  if (!m) return s + ` LIMIT ${max}`;
  return Number(m[1]) > max ? s.replace(/\blimit\s+\d+\s*$/i, `LIMIT ${max}`) : s;
}

/**
 * A refusal the model cannot mistake for data. The marker is explicit because a
 * plain `{error: "..."}` reads like a transient failure worth retrying, and a
 * denied action retried in a loop burns the officer's turn budget.
 */
const denied = (why) => ({ _DENIED: true, error: why, retry: false });

/* ------------------------------ grounding capture ------------------------------ */

/**
 * Identifier shapes that appear in this corpus.
 *
 * The third alternative is not decoration. `Cases.CrimeNo` in the loaded data is a
 * **19-digit number** (`1009800812023000014`), not the `4021/2026` form the FIR-style
 * examples use — and the original pattern matched neither bare long digits nor
 * anything without a letter prefix. So `harvest()` never recorded a single real
 * CrimeNo as grounded, while `LABELLED_ID` cheerfully cited it out of the model's
 * reply, leaving zero traceable sources and refusing the answer. Any reply that wrote
 * "CrimeNo 1009800812023000014" was rejected as a hallucination for quoting the
 * database correctly.
 *
 * Ten digits is the floor, which keeps years, counts, distances and money out.
 */
const CRIME_NO = /\b(?:[A-Z]{2,}[0-9]{2,}[A-Z0-9-]*|\d{1,5}\s*\/\s*(?:19|20)\d{2}|\d{10,25})\b/g;

/**
 * Fields whose value IS an identifier, whatever it looks like.
 *
 * Harvested verbatim rather than pattern-matched, so a future schema that numbers
 * cases differently does not silently stop being verifiable. This is the precise half
 * of the pairing; CRIME_NO is the half that catches identifiers embedded in prose.
 */
const ID_FIELD = /^(?:crimeno|casemasterid|caseid|fir|firno|photoid|ringid)$/i;

/**
 * Record the identifiers a tool actually returned. Walks the result shallowly and
 * harvests CrimeNo-shaped strings and person names from the fields we know carry
 * them, rather than regexing the whole blob — precision here is what makes the
 * later verification trustworthy.
 */
function harvest(ctx, value, depth = 0) {
  if (!value || depth > 4) return;
  if (typeof value === 'string') {
    for (const m of value.match(CRIME_NO) || []) ctx.grounded.ids.add(normalizeId(m));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 60)) harvest(ctx, v, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    if (/name$/i.test(k) && typeof v === 'string' && v.trim()) ctx.grounded.names.add(v.trim().toLowerCase());
    // A field that is an identifier by name is recorded whatever its format, so the
    // verifier does not depend on a regex keeping pace with the schema.
    if (ID_FIELD.test(k) && (typeof v === 'string' || typeof v === 'number')) {
      const raw = String(v).trim();
      if (raw && raw.length <= 40) ctx.grounded.ids.add(normalizeId(raw));
    }
    harvest(ctx, v, depth + 1);
  }
}

const normalizeId = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');

/**
 * Punctuation-insensitive form, for comparing an identifier the model wrote against
 * one a tool returned: `4021/2026`, `4021 / 2026` and `4021-2026` are the same FIR.
 *
 * This replaced a substring comparison, which was the wrong tool for the job — with
 * it, a fabricated "AB1299/2026" passed verification because some real record
 * contained "AB12". Canonical equality tolerates formatting without tolerating
 * invention.
 */
const canonId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Identifiers the reply CLAIMS, found only where they are explicitly labelled.
 * Requiring the label is what keeps a date ("12/2026") or a section number from
 * being read as a cited FIR and triggering a false refusal.
 */
/*
 * The trailing optional group allows the one spaced form that actually occurs —
 * "FIR 4021 / 2026". Without it the capture stopped at "4021", which then failed to
 * match the real 4021/2026 and refused a perfectly good reply. It is scoped to a
 * slash followed by a year, so it cannot run on and swallow the rest of the sentence.
 */
const LABELLED_ID = /\b(?:FIR|F\.I\.R\.?|CrimeNo|Crime\s*No\.?|Crime\s*Number|OCR)\s*[:#-]?\s*([A-Z0-9][A-Z0-9/-]{3,24}(?:\s*\/\s*(?:19|20)\d{2})?)/gi;

/**
 * Verify the model's final answer against what was actually observed.
 *
 * Refuses only in the case that matters: the reply cites identifiers and NONE of
 * them can be traced to tool output or to the officer's own message. That is the
 * signature of an answer produced from the model's memory, which in a policing
 * tool is the single most damaging thing it can do. A partial mismatch is
 * reported and logged rather than refused, because a reply that is 90% grounded
 * is still worth showing and a false refusal teaches officers to distrust the
 * channel.
 */
function verifyGrounding(reply, ctx, officerText) {
  const cited = [];
  let m;
  LABELLED_ID.lastIndex = 0;
  while ((m = LABELLED_ID.exec(String(reply || '')))) {
    const id = normalizeId(m[1]).replace(/[-\s]+$/, '');
    if (id.length >= 4) cited.push(id);
  }
  if (!cited.length) return { ok: true, cited: [], unverified: [] };

  // Everything that may be cited without a fresh lookup, in canonical form:
  //
  //  1. what tools returned this turn;
  //  2. what the officer supplied themselves — they can name an FIR we then fail to
  //     find, and repeating it back to say so is correct;
  //  3. what this conversation has already exchanged.
  //
  // (3) is what makes follow-ups work at all. Grounding was per-turn, so the moment an
  // officer said "full details of number three" about a list we had just given them,
  // the reply cited an identifier from the previous turn, nothing this turn could
  // vouch for it, and they got "I could not confirm that against the records" — about
  // our own answer. Twice in a row, because rephrasing cannot fix it.
  //
  // Safe because the transcript is the record of what was actually exchanged: an
  // identifier we printed already passed this check when it was produced, and one the
  // officer typed is theirs to cite. The narrow widening is that a partial mismatch is
  // logged rather than refused, so an identifier that slipped through once stays
  // citable afterwards — worth it against refusing every follow-up question.
  const sources = new Set();
  for (const id of ctx.grounded.ids) sources.add(canonId(id));
  for (const found of String(officerText || '').match(CRIME_NO) || []) sources.add(canonId(found));
  for (const turn of Array.isArray(ctx.history) ? ctx.history : []) {
    for (const found of String((turn && turn.content) || '').match(CRIME_NO) || []) sources.add(canonId(found));
  }

  const unverified = cited.filter((id) => !sources.has(canonId(id)));

  const verified = cited.length - unverified.length;
  return { ok: unverified.length === 0 || verified > 0, cited, unverified, verified };
}

/* ------------------------------ tool definitions ------------------------------ */

const TOOLS = {
  query_db: {
    roles: ANY,
    args: '{"tool":"query_db","zcql":"SELECT ... LIMIT 20","purpose":"why this helps"}',
    describe: 'Run one read-only ZCQL SELECT against the crime database. Use for anything factual not covered by a more specific tool.',
    async run(ctx, args) {
      if (!isSafeSelect(args.zcql)) {
        return { error: 'Rejected: only a single read-only SELECT is permitted. Rewrite the query.' };
      }
      const zcql = enforceRowLimit(args.zcql);
      const rows = await runZcql(ctx.app, zcql);
      ctx.executed.push({ zcql, purpose: args.purpose || '', rowCount: rows.length, rows });
      const out = { rowCount: rows.length, rows: flat(rows) };
      // A result for a period the records do not cover says nothing about crime there,
      // and saying so in the observation is the only reliable way to stop the model
      // reporting it as "no cases".
      const note = require('./window').outOfWindowNote(zcql);
      if (note) out.note = note;
      return out;
    }
  },

  person_history: {
    roles: ANY,
    args: '{"tool":"person_history","name":"exact accused name"}',
    describe: 'Full antecedents for one person: their cases, arrests, and (analyst and above) risk score and known associates. One call instead of four queries.',
    async run(ctx, args) {
      const name = guard.sanitizeIdentifier(args.name);
      if (!name) return { error: 'A usable person name is required (letters and spaces, no quotes).' };

      const [cases, arrests] = await Promise.all([
        runZcql(ctx.app, `SELECT CrimeNo, CaseMasterID, CrimeSubHead, CrimeHead, DistrictName, CaseStatus, CrimeRegisteredDate FROM Accused WHERE AccusedName='${name}' LIMIT 25`)
          .then((rows) => hydrateCases(ctx.app, rows)),
        runZcql(ctx.app, `SELECT ArrestType, ArrestDate, DistrictName, IOName FROM Arrests WHERE AccusedName='${name}' LIMIT 15`)
      ]);

      const out = { name, caseCount: cases.length, cases: flat(cases, 15), arrests: flat(arrests, 10) };

      // Risk scoring and associate networks are analyst-and-above on the web API.
      // The same restriction applies here rather than leaking through a new channel.
      if (ANALYST_PLUS.includes(ctx.officer.role)) {
        const [risk, links] = await Promise.all([
          runZcql(ctx.app, `SELECT TotalCases, ViolentCases, RiskScore, RiskBand, RingID, Factors FROM OffenderRisk WHERE AccusedName='${name}' LIMIT 1`),
          runZcql(ctx.app, `SELECT AccusedA, AccusedB, SharedCases, RingID FROM CoAccusedLinks WHERE AccusedA='${name}' LIMIT 12`)
        ]);
        out.risk = risk[0] || null;
        out.associates = links.map((l) => ({ with: l.AccusedB, sharedCases: Number(l.SharedCases) || 1, ring: Number(l.RingID) || 0 }));
      } else {
        out.restricted = 'Risk score and associate network require analyst access; cases and arrests shown.';
      }
      return out;
    }
  },

  case_dossier: {
    roles: ANY,
    args: '{"tool":"case_dossier","crimeNo":"FIR or crime number"}',
    describe: 'Complete dossier for one FIR: record, accused, victims, arrests, timeline, similar past cases and their outcomes.',
    async run(ctx, args) {
      const crimeNo = guard.sanitizeIdentifier(args.crimeNo, { max: 80 });
      if (!crimeNo) return { error: 'A usable crimeNo is required.' };
      const { caseSupport } = require('../investigator');
      const d = await caseSupport(ctx.app, { crimeNo, language: ctx.language });
      if (d.error) return { error: d.error, crimeNo, found: false };
      const c = d.case || {};
      return {
        crimeNo: c.CrimeNo, status: c.CaseStatus, head: c.CrimeHead, subHead: c.CrimeSubHead,
        gravity: c.Gravity, district: c.DistrictName, station: c.StationName,
        registered: c.CrimeRegisteredDate, acts: c.ActsSections,
        facts: String(c.BriefFacts || '').slice(0, 600),
        accused: (d.accused || []).map((a) => a.AccusedName).slice(0, 12),
        victims: (d.victims || []).map((v) => v.VictimName).slice(0, 12),
        arrests: (d.arrests || []).map((a) => `${a.ArrestType} ${a.AccusedName} ${a.ArrestDate || ''}`.trim()).slice(0, 10),
        timeline: (d.timeline || []).slice(0, 10),
        outcomes: d.outcomeInsight || null,
        officerBrief: String(d.brief || '').slice(0, 900)
      };
    }
  },

  identify_photo: {
    roles: OPERATIONAL,
    needsImage: true,
    args: '{"tool":"identify_photo"}  — optionally "district":"..." to narrow, or "name":"..." to verify one specific person',
    describe: 'Compare the attached photo against the enrolled reference gallery. Returns ranked candidate leads with confidence bands — never an identification.',
    async run(ctx, args) {
      const res = await photo.identifyPerson(ctx.app, {
        buffer: ctx.image.buffer,
        mime: ctx.image.mime,
        district: guard.sanitizeIdentifier(args.district, { max: 80 }) || undefined,
        personName: guard.sanitizeIdentifier(args.name) || undefined
      });
      ctx.usedBiometrics = true;
      return res;
    }
  },

  read_document: {
    roles: ANY,
    needsImage: true,
    args: '{"tool":"read_document"}',
    describe: 'Run OCR on the attached image of a document, FIR or notice and return the text plus any registration numbers, FIR numbers and sections found in it.',
    async run(ctx) {
      const res = await photo.readDocument(ctx.app, {
        buffer: ctx.image.buffer, mime: ctx.image.mime, language: ctx.language
      });
      // OCR text is untrusted input that an adversary can literally hold up to a
      // camera, so it is screened before the model reads it.
      const screen = guard.screenInjection(res.text);
      if (screen.suspicious) {
        ctx.injectionFlags.push({ source: 'ocr', patterns: screen.patterns });
      }
      return {
        text: res.text.slice(0, 1800),
        confidence: res.confidence,
        identifiers: res.identifiers,
        ...(screen.suspicious ? { warning: guard.injectionNotice('scanned document') } : {})
      };
    }
  },

  area_alerts: {
    roles: ANY,
    args: '{"tool":"area_alerts","district":"optional district name"}',
    describe: 'Current early-warning picture: next-month forecast and flagged districts from the predictive engine.',
    async run(ctx, args) {
      const engine = require('../backtest');
      const ew = await engine.computeEarlyWarning(ctx.app);
      if (ew.error) return { error: ew.error };
      const wanted = String(args.district || '').trim().toLowerCase();
      const alerts = (ew.alerts || []).filter((a) => !wanted || String(a.district).toLowerCase().includes(wanted));
      return {
        horizon: ew.horizon, method: ew.method,
        critical: ew.critical, elevated: ew.elevated,
        alerts: alerts.slice(0, 8).map((a) => ({
          district: a.district, severity: a.severity, predicted: a.predicted,
          baseline: a.baseline, trendPct: a.trendPct, z: a.z
        })),
        caveat: 'Forecast is exposure-normalized decision support for deployment planning. It is not grounds for action against any individual.'
      };
    }
  },

  ask_choice: {
    roles: ANY,
    args: '{"tool":"ask_choice","question":"which one?","options":[{"label":"Suresh Kumar, Mysuru, FIR 4021/2026","resolve":"full history for Suresh Kumar in FIR 4021/2026"}]}',
    describe: 'Ask the officer to pick between specific candidates when a lookup is genuinely ambiguous. Their next reply resolves THIS question — "resolve" is the request you want to receive when they pick that option. Use this instead of asking a question in prose, and never for something you can determine yourself.',
    async run(ctx, args) {
      const question = String(args.question || '').trim();
      const options = (Array.isArray(args.options) ? args.options : [])
        .map((o) => ({
          id: String((o && o.id) || '').slice(0, 40) || undefined,
          label: String((o && o.label) || '').trim(),
          resolve: String((o && (o.resolve || o.label)) || '').trim()
        }))
        .filter((o) => o.label && o.resolve)
        .slice(0, 9);

      if (!question || options.length < 2) {
        return { error: 'ask_choice needs a question and at least two options, each with a label and a resolve. If there is only one candidate, just answer.' };
      }

      frames.openFrame(ctx.pending, {
        kind: 'pick',
        prompt: question,
        options,
        context: { intent: String(args.purpose || '').slice(0, 120) }
      });
      const frame = frames.getFrame(ctx.pending);
      return { _TERMINAL: true, reply: frames.renderPrompt(frame, ctx.messages), frameOpened: 'pick' };
    }
  },

  ask_detail: {
    roles: ANY,
    args: '{"tool":"ask_detail","question":"what is the person\'s name?","resolveTemplate":"enrol the attached photo for {answer}"}',
    describe: 'Ask the officer for one missing free-text detail. Their next reply is substituted into resolveTemplate at {answer} and comes back to you as a complete request. Use when a single fact is missing and you cannot proceed without it.',
    async run(ctx, args) {
      const question = String(args.question || '').trim();
      const template = String(args.resolveTemplate || '').trim();
      if (!question || !template.includes('{answer}')) {
        return { error: 'ask_detail needs a question and a resolveTemplate containing {answer}.' };
      }
      const context = { resolveTemplate: template.slice(0, 400) };
      // Carry the photo forward so the answer can still act on it: the Meta media
      // URL expires in five minutes, and the officer may take longer than that.
      if (ctx.image) {
        try {
          context.photoKey = await photo.stashTurnPhoto(ctx.app, ctx.image);
          context.photoMime = ctx.image.mime;
        } catch (_) { /* the frame still works, just without the image */ }
      }
      frames.openFrame(ctx.pending, { kind: 'detail', prompt: question, context });
      return { _TERMINAL: true, reply: question, frameOpened: 'detail' };
    }
  },

  enroll_photo: {
    roles: OPERATIONAL,
    needsImage: true,
    writes: true,
    args: '{"tool":"enroll_photo","name":"person name","crimeNo":"optional FIR to attach to"}',
    describe: 'Add the attached photo to the reference gallery for a named person. This is how the gallery is built — every future identification depends on it. Reversible.',
    async run(ctx, args) {
      const name = guard.sanitizeIdentifier(args.name);
      if (!name) return { error: 'A person name is required to enrol a photo, and it must contain no quotes.' };
      const crimeNo = args.crimeNo ? guard.sanitizeIdentifier(args.crimeNo, { max: 80 }) : null;
      if (args.crimeNo && !crimeNo) return { error: 'That crimeNo is not a usable identifier.' };

      const res = await photo.enrollPhoto(ctx.app, {
        buffer: ctx.image.buffer, mime: ctx.image.mime,
        personName: name, crimeNo: crimeNo || undefined, officer: ctx.officer
      });
      ctx.wrote = true;
      const token = officers.recordUndo(ctx.pending, {
        action: 'undo_enroll',
        payload: { photoId: res.photoId, objectKey: res.objectKey, person: res.person },
        describe: `the enrolment of ${res.person}`
      });
      ctx.undoToken = token;
      return { enrolled: true, ...res, undoToken: token };
    }
  },

  set_language: {
    roles: ANY,
    writes: true,
    args: '{"tool":"set_language","language":"en|kn|hi"}',
    describe: 'Switch the language this officer is answered in, when they ask for it in any phrasing ("reply in Hindi", "ಕನ್ನಡದಲ್ಲಿ ಹೇಳಿ", "अंग्रेज़ी में बताओ"). Sticks until they change it again.',
    async run(ctx, args) {
      const code = require('./lang').normalize(args.language);
      if (!code) {
        return { error: 'language must be one of en, kn, hi. Ask which of the three the officer wants.' };
      }
      const before = ctx.officer.language;
      await officers.setLanguage(ctx.app, ctx.officer, code);
      ctx.officer.language = code;

      // Take effect on THIS turn, not the next one. Confirming a switch to Hindi in
      // English is the exact failure the copy pack exists to prevent, and the officer
      // would reasonably conclude the switch had not worked.
      ctx.pending.langLock = code;
      ctx.language = code;
      ctx.messages = require('./copy').messages(code);
      ctx.wrote = true;

      const token = officers.recordUndo(ctx.pending, {
        action: 'undo_language', payload: { language: before }, describe: 'the language change'
      });
      ctx.undoToken = token;
      return { updated: true, language: code, name: require('./copy').languageName(code), undoToken: token };
    }
  },

  set_alerts: {
    roles: ANY,
    writes: true,
    args: '{"tool":"set_alerts","districts":["District A"],"severity":"critical|elevated|watch|none"}',
    describe: "Change which districts this officer receives push alerts for, and at what severity. ONLY when the officer explicitly asks to subscribe, unsubscribe or change alerts — a question about what is happening in a district is NOT a request to subscribe to it; answer that with area_alerts. Reversible.",
    async run(ctx, args) {
      // An alert subscription may only change when the officer's own words mention
      // alerts. This is not belt-and-braces: asked "ಬಳ್ಳಾರಿಯಲ್ಲಿ ಮುಂದಿನ ತಿಂಗಳು ಏನು
      // ಅಪಾಯ ಇದೆ" — what is the risk in Ballari next month — the model called this
      // tool twice and silently resubscribed the officer to Ballari before answering.
      //
      // The epistemic write gate cannot catch that: the phrasing is a plain question,
      // and questions are deliberately treated as permissible requests there so a
      // politely-asked enrolment is not refused. So the check has to be about topic,
      // not mood, and it has to read the officer's words rather than the model's
      // reading of them — a model that misidentified the intent will happily assert it.
      if (!ALERT_INTENT.test(String(ctx.officerText || ''))) {
        return { error: 'Refused: the officer did not ask to change alert settings. If they asked what is happening in a district, use area_alerts instead.' };
      }
      const before = { districts: ctx.officer.alertDistricts.join(','), severity: ctx.officer.alertSeverity };
      // Three distinct cases, and conflating them was a bug: not supplied (leave
      // alone), supplied empty (the officer wants the list cleared), and supplied
      // but unusable (refuse and ask, rather than silently clearing their
      // subscription because a name had a quote in it).
      let districts;
      if (args.districts !== undefined) {
        const raw = (Array.isArray(args.districts) ? args.districts : String(args.districts).split(','))
          .map((d) => String(d).trim()).filter(Boolean);
        districts = raw.map((d) => guard.sanitizeIdentifier(d, { max: 80 })).filter(Boolean);
        if (raw.length && !districts.length) {
          return { error: 'None of those district names were usable. Ask the officer to name the district plainly.' };
        }
      }
      const res = await officers.setAlertPrefs(ctx.app, ctx.officer, { districts, severity: args.severity });
      ctx.wrote = true;
      const token = officers.recordUndo(ctx.pending, {
        action: 'undo_alerts', payload: before, describe: 'the alert subscription change'
      });
      ctx.undoToken = token;
      return { updated: true, districts: res.districts || '(none)', severity: res.severity || ctx.officer.alertSeverity, undoToken: token };
    }
  },

  whoami: {
    roles: ANY,
    args: '{"tool":"whoami"}',
    describe: 'Report who this officer is registered as, what access they hold, and their current alert subscription.',
    async run(ctx) {
      const o = ctx.officer;
      return {
        name: o.name, rank: o.rank, role: o.role,
        posting: [o.station, o.district, o.state].filter(Boolean).join(', '),
        alertDistricts: o.alertDistricts.length ? o.alertDistricts : ['(none)'],
        alertSeverity: o.alertSeverity,
        available: allowedToolNames(o.role),
        galleryPhotos: await photo.galleryCount(ctx.app)
      };
    }
  }
};

/* ------------------------------ helpers ------------------------------ */

/**
 * `Accused` carries the crime sub-head but not the case status or date, so the
 * agent would otherwise need a round-trip per case. Fetch them in one batched
 * query over the case ids.
 */
async function hydrateCases(app, accusedRows) {
  const ids = [...new Set(accusedRows.map((r) => Number(r.CaseMasterID)).filter(Boolean))].slice(0, 25);
  if (!ids.length) return accusedRows;
  let cases = [];
  try {
    cases = await runZcql(app,
      `SELECT CaseMasterID, CrimeNo, CrimeSubHead, CrimeHead, DistrictName, CaseStatus, CrimeRegisteredDate, Gravity FROM Cases WHERE CaseMasterID IN (${ids.join(',')}) LIMIT 25`);
  } catch (_) {
    return accusedRows;
  }
  const byId = new Map(cases.map((c) => [Number(c.CaseMasterID), c]));
  return accusedRows.map((r) => {
    const c = byId.get(Number(r.CaseMasterID));
    return c
      ? { crimeNo: c.CrimeNo, subHead: c.CrimeSubHead, head: c.CrimeHead, district: c.DistrictName, status: c.CaseStatus, registered: c.CrimeRegisteredDate, gravity: c.Gravity }
      : { crimeNo: r.CrimeNo, subHead: r.CrimeSubHead, district: r.DistrictName };
  });
}

function allowedToolNames(role) {
  return Object.keys(TOOLS).filter((k) => TOOLS[k].roles.includes(role));
}

/** The catalogue rendered for the system prompt, filtered to this officer's role. */
function toolCatalogue(role, { hasImage }) {
  return allowedToolNames(role).map((name) => {
    const t = TOOLS[name];
    const gated = t.needsImage && !hasImage ? '\n  [unavailable on this turn: no image attached]' : '';
    return `- ${name}: ${t.describe}\n  action: ${t.args}${gated}`;
  }).join('\n');
}

const argsHash = (args) => crypto.createHash('sha256')
  .update(JSON.stringify(args || {}))
  .digest('hex').slice(0, 16);

/**
 * Execute one tool call.
 *
 * The order of these checks is the security model: existence, then role, then
 * write-intent, then preconditions. A denial is returned as data with the
 * `_DENIED` marker so the model reports it to the officer rather than looping.
 */
async function dispatch(ctx, args) {
  const name = String((args && args.tool) || '').trim();
  const tool = TOOLS[name];
  if (!tool) {
    return { error: `Unknown tool "${name}". Available: ${allowedToolNames(ctx.officer.role).join(', ')}` };
  }
  // A denial is audited like any other attempt. A role violation or a blocked write
  // is precisely the event a reviewer will come looking for, and returning early
  // without recording it left the most interesting attempts out of the trail.
  const refuse = (why, reason) => {
    ctx.invoked.push({ tool: name, args: argsHash(args), ok: false, denied: reason });
    return denied(why);
  };

  if (!tool.roles.includes(ctx.officer.role)) {
    return refuse(
      `Not permitted for the ${ctx.officer.role} role. Tell the officer this action needs higher access, and do not retry it.`,
      'role:' + ctx.officer.role
    );
  }
  if (tool.writes) {
    const gate = ctx.writeGate || { allowed: true };
    if (!gate.allowed) {
      return refuse(gate.reason === 'negated'
        ? 'The officer\'s message says NOT to do this ("' + (gate.clause || '') + '"). The write was refused. Confirm what they want instead of acting.'
        : 'The officer is asking about a possibility, not requesting it ("' + (gate.clause || '') + '"). The write was refused. Explain what would happen if they do want it.',
      'write_gate:' + gate.reason);
    }
  }
  if (tool.needsImage && !ctx.image) {
    return { error: 'That action needs a photo, and none is attached to this turn. Ask the officer to send the image with their request.' };
  }

  let result;
  try {
    result = await tool.run(ctx, args || {});
  } catch (e) {
    result = { error: String((e && e.message) || e).slice(0, 300) };
  }

  ctx.invoked.push({ tool: name, args: argsHash(args), ok: !result || !result.error, writes: Boolean(tool.writes) });
  if (result && !result.error) harvest(ctx, result);
  return result;
}

/* ------------------------------ undo execution ------------------------------ */

/**
 * Reverse a recorded action. Deliberately outside the agent loop: an officer who
 * types an undo code has already decided, and routing that decision through a
 * model that might reinterpret it would be a strange thing to do.
 */
async function performUndo(ctx, record) {
  if (!record || !record.action) return { ok: false, error: 'nothing to reverse' };
  try {
    if (record.action === 'undo_enroll') {
      await photo.deleteEnrollment(ctx.app, record.payload || {});
      return { ok: true, describe: record.describe };
    }
    if (record.action === 'undo_language') {
      const back = require('./lang').normalize(record.payload && record.payload.language) || 'en';
      await officers.setLanguage(ctx.app, ctx.officer, back);
      ctx.officer.language = back;
      // Reverse the lock and the reply language too, otherwise the confirmation that
      // the change was undone arrives in the language it was undone from.
      ctx.pending.langLock = back;
      ctx.language = back;
      ctx.messages = require('./copy').messages(back);
      return { ok: true, describe: record.describe };
    }
    if (record.action === 'undo_alerts') {
      await officers.setAlertPrefs(ctx.app, ctx.officer, {
        districts: String((record.payload && record.payload.districts) || ''),
        severity: (record.payload && record.payload.severity) || 'none'
      });
      return { ok: true, describe: record.describe };
    }
    return { ok: false, error: 'unknown action ' + record.action };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}

module.exports = {
  TOOLS, dispatch, toolCatalogue, allowedToolNames, enforceRowLimit,
  verifyGrounding, harvest, performUndo, argsHash, denied
};
