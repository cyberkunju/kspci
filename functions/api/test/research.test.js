'use strict';

/**
 * Tests for the research bridge — specifically the anchor gathering, because that is
 * where a silent defect is expensive.
 *
 * The engine's own accuracy rests on these anchors. If the district silently fails to
 * come through, nothing errors: the run still completes, still returns sources, and
 * simply grades every one of them "possible" instead of "confirmed". That is the worst
 * kind of bug — a working-looking product that has quietly stopped being able to tell
 * one Suresh Kumar from another.
 *
 * The proxy's HTTP transport is not mocked and asserted here; that would only prove the
 * mock was called. What IS tested is the part with a decision in it: that an
 * unconfigured deployment fails with a clear 503 rather than fetching `undefined`, and
 * that the subject role is taken from our records and never from the caller.
 *
 * Run with:  npm test
 */

const test = require('node:test');
const assert = require('node:assert');

const research = require('../lib/research');

/* ------------------------------ a fake Data Store ------------------------------ */

/**
 * Answers ZCQL by matching on the table name in the query, the way the real store
 * would. Records every query so the tests can assert on what was asked, which is how
 * an accidentally-unquoted value gets caught.
 */
function fakeApp(tables, { failing = [] } = {}) {
  const queries = [];
  return {
    queries,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        const table = Object.keys(tables).find((t) => sql.includes(' ' + t + ' '));
        if (failing.includes(table)) throw new Error('table_missing');
        return (tables[table] || []).map((row) => ({ [table]: row }));
      }
    })
  };
}

const CASE = {
  CaseMasterID: 4021, CrimeNo: '118/2023', StateName: 'Karnataka',
  DistrictName: 'Mysuru', StationName: 'Vijayanagar',
  ActsSections: 'IPC 420; IPC 406, IT Act 66D',
  CrimeRegisteredDate: '2023-04-18', IncidentDate: '2023-04-11',
  CrimeHead: 'Cheating', CrimeSubHead: 'Online fraud'
};

const FULL = {
  Cases: [CASE],
  Accused: [{
    AccusedMasterID: 77, AccusedName: 'Suresh Kumar', PersonID: 'P-9', AgeYear: 34,
    Gender: 'Male', RingID: 3, DistrictName: 'Mysuru', CaseMasterID: 4021,
    CrimeNo: '118/2023', CrimeSubHead: 'Online fraud'
  }],
  CoAccusedLinks: [
    { AccusedA: 'Suresh Kumar', AccusedB: 'Manjunath', SharedCases: 3 },
    { AccusedA: 'Ravi Shankar', AccusedB: 'Suresh Kumar', SharedCases: 1 }
  ],
  Victims: [],
  Complainants: []
};

/* ============================ anchors ============================ */

test('anchors: the discriminating facts all come through', async () => {
  const app = fakeApp(FULL);
  const { anchors, meta } = await research.anchorsFor(app, {
    kind: 'person', subject: 'Suresh Kumar'
  });

  assert.equal(anchors.district, 'Mysuru');
  assert.equal(anchors.state, 'Karnataka');
  assert.equal(anchors.station, 'Vijayanagar');
  assert.equal(anchors.age, 34);
  assert.deepEqual(anchors.crime_numbers, ['118/2023']);
  assert.equal(meta.matchedRecords, 1);
  assert.deepEqual(meta.notes, []);
});

test('anchors: a co-accused is picked up from either side of the link', async () => {
  const app = fakeApp(FULL);
  const { anchors } = await research.anchorsFor(app, { kind: 'person', subject: 'Suresh Kumar' });
  // The subject is AccusedA in one row and AccusedB in the other. Reading only
  // AccusedB would silently lose half the network, which is the anchor that most
  // often settles a namesake.
  assert.deepEqual(anchors.associates.sort(), ['Manjunath', 'Ravi Shankar']);
  assert.ok(!anchors.associates.includes('Suresh Kumar'), 'never anchors on the subject');
});

test('anchors: ActsSections is split into individual sections', async () => {
  const app = fakeApp(FULL);
  const { anchors } = await research.anchorsFor(app, { kind: 'crime', crimeNo: '118/2023' });
  assert.deepEqual(anchors.sections, ['IPC 420', 'IPC 406', 'IT Act 66D']);
});

test('anchors: the earliest known date opens the search window', async () => {
  const app = fakeApp(FULL);
  const { anchors } = await research.anchorsFor(app, { kind: 'crime', crimeNo: '118/2023' });
  // The incident precedes registration, and reporting can precede either. Taking the
  // later date would start the window after the coverage.
  assert.equal(anchors.date_from, '2023-04-11');
});

test('anchors: a quote in the subject cannot reshape the query', async () => {
  const app = fakeApp(FULL);
  await research.anchorsFor(app, { kind: 'person', subject: "Suresh' OR '1'='1" });
  for (const sql of app.queries) {
    assert.ok(!/'\s*OR\s*'/i.test(sql), 'no injected clause survives: ' + sql);
  }
});

test('anchors: a missing table costs one class of anchor, not the run', async () => {
  const app = fakeApp(FULL, { failing: ['CoAccusedLinks'] });
  const { anchors, meta } = await research.anchorsFor(app, {
    kind: 'person', subject: 'Suresh Kumar'
  });
  assert.equal(anchors.district, 'Mysuru', 'the rest still arrives');
  assert.deepEqual(anchors.associates, []);
  assert.ok(meta.notes.some((n) => n.includes('co-accused')), 'and it is reported: ' + meta.notes);
});

test('anchors: a crime number we do not hold is reported, not invented', async () => {
  const app = fakeApp({ ...FULL, Cases: [] });
  const { meta } = await research.anchorsFor(app, { kind: 'crime', crimeNo: '999/2099' });
  assert.ok(meta.notes.some((n) => n.includes('999/2099')), String(meta.notes));
});

test('anchors: a name with no records yields the name alone', async () => {
  const app = fakeApp({ Cases: [], Accused: [], CoAccusedLinks: [], Victims: [], Complainants: [] });
  const { anchors, meta } = await research.anchorsFor(app, {
    kind: 'person', subject: 'Nobody In Our Records'
  });
  assert.deepEqual(anchors.names, ['Nobody In Our Records']);
  assert.equal(anchors.district, '');
  assert.equal(meta.subjectRole, '', 'absent from every table is not a victim');
});

/* ============================ subject role ============================ */

test('subject role: a complainant is flagged so the engine refuses', async () => {
  const app = fakeApp({
    Cases: [], Accused: [], CoAccusedLinks: [], Victims: [],
    Complainants: [{ ComplainantName: 'Lakshmi Devi' }]
  });
  const { meta } = await research.anchorsFor(app, { kind: 'person', subject: 'Lakshmi Devi' });
  assert.equal(meta.subjectRole, 'complainant');
});

test('subject role: a victim is flagged', async () => {
  const app = fakeApp({
    Cases: [], Accused: [], CoAccusedLinks: [],
    Victims: [{ VictimName: 'Lakshmi Devi' }], Complainants: []
  });
  const { meta } = await research.anchorsFor(app, { kind: 'person', subject: 'Lakshmi Devi' });
  assert.equal(meta.subjectRole, 'victim');
});

test('subject role: an accused who was also a victim is still researchable', async () => {
  // Someone can be both. The accused record governs: they are a subject of an
  // investigation, and treating them as a protected victim would make the tool
  // useless on exactly the people it exists for.
  const app = fakeApp({
    ...FULL, Victims: [{ VictimName: 'Suresh Kumar' }]
  });
  const { meta } = await research.anchorsFor(app, { kind: 'person', subject: 'Suresh Kumar' });
  assert.equal(meta.subjectRole, '');
  assert.ok(!app.queries.some((q) => q.includes(' Victims ')),
    'and we do not even ask, because the accused record already settled it');
});

test('subject role: the caller cannot choose it', async () => {
  const app = fakeApp({
    Cases: [], Accused: [], CoAccusedLinks: [],
    Victims: [{ VictimName: 'Lakshmi Devi' }], Complainants: []
  });
  const { body } = await research._internals.requestBody(app, {
    subject: 'Lakshmi Devi', kind: 'person', purpose: 'checking a lead',
    // A client asserting the subject is a suspect must not be able to launder a
    // protected person past the gate.
    subject_role: 'suspect'
  });
  assert.equal(body.subject_role, 'victim');
});

/* ============================ the proxy ============================ */

test('proxy: an unconfigured deployment fails loudly', async () => {
  assert.equal(research.configured(), false, 'no RESEARCH_SERVICE_URL in the test env');
  await assert.rejects(
    research.poll('rq_whatever'),
    (e) => e.status === 503 && e.code === 'research_unconfigured'
  );
});

test('proxy: the request body carries purpose, role and officer for the audit', async () => {
  const app = fakeApp(FULL);
  const { body } = await research._internals.requestBody(app, {
    subject: 'Suresh Kumar', kind: 'person', purpose: 'tracing an absconding accused',
    role: 'investigator', officer: 'off_12', crimeNo: '118/2023', mode: 'standard'
  });
  assert.equal(body.purpose, 'tracing an absconding accused');
  assert.equal(body.role, 'investigator');
  assert.equal(body.officer, 'off_12');
  assert.equal(body.crime_number, '118/2023');
  assert.equal(body.anchors.district, 'Mysuru');
});

test('proxy: a Data Store outage still produces a runnable request', async () => {
  const broken = { zcql: () => { throw new Error('datastore down'); } };
  const { body, meta } = await research._internals.requestBody(broken, {
    subject: 'Suresh Kumar', kind: 'person', purpose: 'tracing an absconding accused'
  });
  assert.deepEqual(body.anchors.names, ['Suresh Kumar']);
  assert.ok(meta.notes.length, 'and says the anchors are thin');
});

/* ============================ anchor summary ============================ */

test('summary: only names the anchors that exist', async () => {
  const s = research._internals.summariseAnchors({
    names: ['Suresh Kumar'], district: 'Mysuru', crime_numbers: ['118/2023'], age: null
  });
  assert.equal(s.district, 'Mysuru');
  assert.deepEqual(s.crimeNumbers, ['118/2023']);
  assert.equal(s.station, '');
  assert.equal(s.age, null);
  assert.deepEqual(s.associates, []);
});

/* ============================ the WhatsApp tool ============================ */

const waTools = require('../lib/wa/tools');

test('wa tool: the role gate is on the subject kind, not on the tool', async () => {
  // Mirrors the engine's own rule: person-level research needs an operational role,
  // aggregate kinds do not. A field channel must not be a way round that.
  //
  // This previously asserted the tool was absent from the policymaker's catalogue,
  // which is a coarser rule than the one it was mirroring — it denied them the
  // aggregate research the engine permits. It also made the capability invisible to
  // the model, so the officer was told the system could not search the internet at
  // all rather than that their access level did not cover it.
  for (const role of ['investigator', 'analyst', 'supervisor', 'admin', 'policymaker']) {
    assert.ok(waTools.allowedToolNames(role).includes('open_source_research'), role);
  }

  const original = research.configured;
  research.configured = () => true;
  try {
    const person = await waTools.TOOLS.open_source_research.run(
      { app: null, officer: { role: 'policymaker', officerId: 'off_p', phone: '919000000000' } },
      { subject: 'Suresh Kumar', kind: 'person', purpose: 'checking his antecedents properly' }
    );
    assert.match(person.error, /operational role/i, 'a policymaker must not research a person');
    assert.match(person.error, /aggregate/i, 'and must be told what they can do instead');
  } finally {
    research.configured = original;
  }
});

test('wa tool: a second run on a subject already reported is refused, not started', async () => {
  // "Do not call it twice for the same subject" was advice in the tool description and
  // nothing enforced it: asked about one source in a delivered report, the model started
  // the whole search again — a minute of waiting and paid search calls, for something the
  // officer was already holding.
  const original = research.configured;
  research.configured = () => true;
  const history = [
    { role: 'user', content: 'search the internet for the Karnataka Lokayukta' },
    { role: 'assistant', content: '*Karnataka Lokayukta organisation* — open-source research complete\n\nThe Registrar is the First Appellant Authority [S1].' }
  ];
  const ctx = (officerText) => ({
    app: null, history, officerText,
    officer: { role: 'investigator', officerId: 'off_i', phone: '919000000000' }
  });
  try {
    const again = await waTools.TOOLS.open_source_research.run(
      ctx('what did the second source say'),
      { subject: 'Karnataka Lokayukta', kind: 'organisation', purpose: 'following up on the briefing note' });
    assert.match(again.error, /already delivered/i);
    assert.match(again.error, /answer the officer's question from that report/i);

    // And an officer who explicitly wants it re-run is not blocked. It gets past the
    // guard; it stops later for want of a callback address in this test environment.
    const fresh = await waTools.TOOLS.open_source_research.run(
      ctx('run that search again, I want the latest'),
      { subject: 'Karnataka Lokayukta', kind: 'organisation', purpose: 'checking for newer coverage' });
    assert.ok(!/already delivered/i.test(String(fresh.error || '')),
      'an explicit request for a fresh search is not treated as a duplicate');
  } finally {
    research.configured = original;
  }
});

test('wa tool: a thin purpose is refused before the engine is called', async () => {
  const ctx = {
    app: null,
    officer: { role: 'investigator', officerId: 'off_1', name: 'PSI Rao' }
  };
  // With no RESEARCH_SERVICE_URL the tool short-circuits on configuration, so the
  // purpose check is verified against a configured stub.
  const original = research.configured;
  research.configured = () => true;
  try {
    const thin = await waTools.TOOLS.open_source_research.run(ctx, {
      subject: 'Suresh Kumar', purpose: 'checking'
    });
    assert.match(thin.error, /purpose/i);

    const none = await waTools.TOOLS.open_source_research.run(ctx, {
      subject: 'Suresh Kumar'
    });
    assert.match(none.error, /purpose/i);
  } finally {
    research.configured = original;
  }
});

test('wa tool: an unconfigured deployment says so instead of failing obscurely', async () => {
  const out = await waTools.TOOLS.open_source_research.run(
    { app: null, officer: { role: 'investigator' } },
    { subject: 'Suresh Kumar', purpose: 'tracing an absconding accused' });
  assert.match(out.error, /not configured/i);
});

/*
 * The tool starts a run and ends the turn. These tests exist because the handler was
 * once written against a synchronous `research.sync()` that had already been removed,
 * and nothing failed until someone read the file: no test touched this path, so the only
 * research route a field officer has would have thrown "research.sync is not a function"
 * on first use. Every branch of it is covered now.
 */

const RESEARCH_CTX = {
  app: null,
  language: 'en',
  messages: require('../lib/wa/copy').EN,
  officer: { role: 'investigator', officerId: 'off_1', name: 'PSI Rao', phone: '919000000000' }
};

function withStartStub(fn) {
  const originals = {
    configured: research.configured, start: research.start,
    callbackUrl: waResearch.callbackUrl, env: process.env.RESEARCH_CALLBACK_URL
  };
  const calls = [];
  research.configured = () => true;
  research.start = async (app, opts) => { calls.push(opts); return { id: 'rq_test', mode: opts.mode }; };
  process.env.RESEARCH_CALLBACK_URL = 'https://x.example/server/api/research/callback';
  return Promise.resolve(fn(calls)).finally(() => {
    research.configured = originals.configured;
    research.start = originals.start;
    waResearch.callbackUrl = originals.callbackUrl;
    if (originals.env === undefined) delete process.env.RESEARCH_CALLBACK_URL;
    else process.env.RESEARCH_CALLBACK_URL = originals.env;
  });
}

test('wa tool: research starts a run and ends the turn instead of answering', async () => {
  await withStartStub(async (calls) => {
    const out = await waTools.TOOLS.open_source_research.run(RESEARCH_CTX, {
      subject: 'Suresh Kumar', kind: 'person',
      purpose: 'tracing an absconding accused in FIR 118/2023'
    });
    assert.equal(calls.length, 1, 'the engine was asked to start exactly one run');
    assert.equal(out._TERMINAL, true, 'the loop must stop; the model has nothing to add');
    assert.match(out.reply, /About a minute/,
      'the officer is told it is running and that they need not wait');
    assert.equal(out.researchStarted.id, 'rq_test');
    // The callback must carry everything needed to find this officer again.
    assert.equal(calls[0].callbackContext.channel, 'whatsapp');
    assert.equal(calls[0].callbackContext.phone, '919000000000');
    assert.equal(calls[0].callbackContext.language, 'en');
    assert.equal(calls[0].callbackUrl, 'https://x.example/server/api/research/callback');
    // The officer id, never the handset number, reaches the engine's audit line.
    assert.equal(calls[0].officer, 'off_1');
    assert.equal(calls[0].mode, 'standard');
  });
});

test('wa tool: deep mode is selectable and gets its own longer promise', async () => {
  await withStartStub(async (calls) => {
    const out = await waTools.TOOLS.open_source_research.run(RESEARCH_CTX, {
      subject: 'Suresh Kumar', purpose: 'tracing an absconding accused', mode: 'deep'
    });
    assert.equal(calls[0].mode, 'deep');
    assert.match(out.reply, /five minutes/);
  });
  // An invented mode falls back rather than being passed through to the engine.
  await withStartStub(async (calls) => {
    await waTools.TOOLS.open_source_research.run(RESEARCH_CTX, {
      subject: 'Suresh Kumar', purpose: 'tracing an absconding accused', mode: 'quick'
    });
    assert.equal(calls[0].mode, 'standard', 'quick no longer exists');
  });
});

test('wa tool: Kannada gets the Kannada wait message', async () => {
  await withStartStub(async () => {
    const out = await waTools.TOOLS.open_source_research.run(
      { ...RESEARCH_CTX, language: 'kn', messages: require('../lib/wa/copy').KN },
      { subject: 'Suresh Kumar', purpose: 'tracing an absconding accused' });
    assert.match(out.reply, /[\u0C80-\u0CFF]/, 'the reply is in Kannada script');
  });
});

test('wa tool: a run with nowhere to deliver is refused, not started', async () => {
  // A started run whose result cannot be delivered is worse than a refusal, because the
  // officer waits for a message that will never arrive.
  const originals = { configured: research.configured, start: research.start,
                      cb: process.env.RESEARCH_CALLBACK_URL, wa: process.env.WA_PROCESS_URL };
  let started = 0;
  research.configured = () => true;
  research.start = async () => { started += 1; return { id: 'x' }; };
  delete process.env.RESEARCH_CALLBACK_URL;
  delete process.env.WA_PROCESS_URL;
  try {
    const out = await waTools.TOOLS.open_source_research.run(RESEARCH_CTX, {
      subject: 'Suresh Kumar', purpose: 'tracing an absconding accused' });
    assert.match(out.error, /cannot be delivered/i);
    assert.equal(started, 0, 'no run was started');

    // Same for an officer with no handset on file.
    process.env.RESEARCH_CALLBACK_URL = 'https://x.example/server/api/research/callback';
    const noPhone = await waTools.TOOLS.open_source_research.run(
      { ...RESEARCH_CTX, officer: { ...RESEARCH_CTX.officer, phone: '' } },
      { subject: 'Suresh Kumar', purpose: 'tracing an absconding accused' });
    assert.match(noPhone.error, /handset/i);
    assert.equal(started, 0);
  } finally {
    research.configured = originals.configured;
    research.start = originals.start;
    if (originals.cb === undefined) delete process.env.RESEARCH_CALLBACK_URL;
    else process.env.RESEARCH_CALLBACK_URL = originals.cb;
    if (originals.wa !== undefined) process.env.WA_PROCESS_URL = originals.wa;
  }
});

test('wa callback url: derived from WA_PROCESS_URL when not set explicitly', () => {
  const originals = { cb: process.env.RESEARCH_CALLBACK_URL, wa: process.env.WA_PROCESS_URL };
  try {
    delete process.env.RESEARCH_CALLBACK_URL;
    process.env.WA_PROCESS_URL = 'https://ksp.example/server/api/wa/process?x=1';
    assert.equal(waResearch.callbackUrl(),
                 'https://ksp.example/server/api/wa/research/callback');
    process.env.RESEARCH_CALLBACK_URL = 'https://explicit.example/cb';
    assert.equal(waResearch.callbackUrl(), 'https://explicit.example/cb',
                 'an explicit value always wins');
    delete process.env.RESEARCH_CALLBACK_URL;
    delete process.env.WA_PROCESS_URL;
    assert.equal(waResearch.callbackUrl(), '', 'neither configured means no address');
  } finally {
    if (originals.cb === undefined) delete process.env.RESEARCH_CALLBACK_URL;
    else process.env.RESEARCH_CALLBACK_URL = originals.cb;
    if (originals.wa === undefined) delete process.env.WA_PROCESS_URL;
    else process.env.WA_PROCESS_URL = originals.wa;
  }
});

/* ============================ our own records ============================ */

const RICH = {
  ...FULL,
  Arrests: [{ ArrestType: 'Arrested', ArrestDate: '2023-04-20', DistrictName: 'Mysuru' }],
  OffenderRisk: [{ TotalCases: 3, ViolentCases: 1, RiskScore: 72, RiskBand: 'High', Factors: 'repeat' }]
};

test('records: our file is summarised as statements, not rows', async () => {
  const app = fakeApp(RICH);
  const { records } = await research.recordsFor(app, { kind: 'person', subject: 'Suresh Kumar' });
  const joined = records.join('\n');
  // Statements, because the engine has no database access and should not have any: what
  // crosses that boundary is a sentence somebody could read out, not a schema.
  assert.match(joined, /appears in our records as an accused in 1 case/);
  assert.match(joined, /Recorded age: 34/);
  assert.match(joined, /Arrests on record/);
  assert.match(joined, /High/);
  assert.match(joined, /Co-accused in our records/);
  assert.ok(records.length <= 20, 'bounded');
});

test('records: a subject we hold nothing on says exactly that', async () => {
  const app = fakeApp({ Cases: [], Accused: [], CoAccusedLinks: [], Arrests: [], OffenderRisk: [], Victims: [], Complainants: [] });
  const { records } = await research.recordsFor(app, { kind: 'person', subject: 'Nobody At All' });
  assert.match(records.join('\n'), /does not appear as an accused in our records/);
});

test('records: a failed lookup is never reported as an absence', async () => {
  // The dangerous case. "Not in our records" and "we could not read our records" must
  // never collapse into the same sentence.
  const app = fakeApp(RICH, { failing: ['Accused'] });
  const { records, notes } = await research.recordsFor(app, { kind: 'person', subject: 'Suresh Kumar' });
  assert.ok(!records.some((r) => /does not appear/.test(r)), records.join(' | '));
  assert.ok(notes.some((n) => /accused records unavailable/.test(n)), String(notes));
});

test('records: a case number pulls the case onto the record sheet', async () => {
  const app = fakeApp(RICH);
  const { records } = await research.recordsFor(app, { kind: 'crime', crimeNo: '118/2023' });
  const joined = records.join('\n');
  assert.match(joined, /Case 118\/2023 is on record/);
  assert.match(joined, /Vijayanagar station, Mysuru district/);
  assert.match(joined, /Sections invoked/);
});

test('records: travel in the request body alongside the anchors', async () => {
  const app = fakeApp(RICH);
  const { body } = await research._internals.requestBody(app, {
    subject: 'Suresh Kumar', kind: 'person', purpose: 'tracing an absconding accused'
  });
  assert.ok(Array.isArray(body.records) && body.records.length > 0);
  assert.equal(body.anchors.district, 'Mysuru', 'anchors still shape the search');
});

/* ============================ modes and callback ============================ */

test('modes: quick is gone and an unknown mode becomes standard', async () => {
  assert.deepEqual(research.MODES, ['standard', 'deep']);
  assert.equal(typeof research.sync, 'undefined', 'the synchronous path is removed');
  const app = fakeApp(RICH);
  for (const [asked, expected] of [['deep', 'deep'], ['quick', 'standard'], ['', 'standard']]) {
    const { body } = await research._internals.requestBody(app, {
      subject: 'Suresh Kumar', purpose: 'tracing an absconding accused', mode: asked
    });
    assert.equal(body.mode, expected, `mode ${asked}`);
  }
});

test('callback: only attached when one is asked for, and carries the key', async () => {
  const app = fakeApp(RICH);
  const bare = await research._internals.requestBody(app, {
    subject: 'Suresh Kumar', purpose: 'tracing an absconding accused'
  });
  assert.ok(!('callback_url' in bare.body), 'no callback unless requested');

  const withCb = await research._internals.requestBody(app, {
    subject: 'Suresh Kumar', purpose: 'tracing an absconding accused',
    callbackUrl: 'https://example.test/research/callback',
    callbackContext: { channel: 'whatsapp', phone: '919000000000' }
  });
  assert.equal(withCb.body.callback_url, 'https://example.test/research/callback');
  assert.deepEqual(withCb.body.callback_context.channel, 'whatsapp');
});

/* ============================ WhatsApp delivery ============================ */

const waResearch = require('../lib/wa/research');

const RESULT = {
  subject: 'Suresh Kumar', mode: 'standard', summary_kind: 'findings',
  summary: 'He was arrested in Mysuru [S1]. Our records show three cases [DB].',
  counts: { candidates: 120, readable: 45, by_attribution: { confirmed: 2, probable: 1, possible: 7 } },
  records: ['Suresh Kumar appears in our records as an accused in 3 case(s), in Mysuru.'],
  disclaimer: 'Open-source material, not evidence.',
  findings: [
    { attribution: 'confirmed', title: 'Man held in Mysuru cheating case', outlet: 'thehindu.com', published: '2023-04-19', url: 'https://www.thehindu.com/news/cities/mysuru/man-held-12345/' },
    { attribution: 'possible', title: 'Unrelated column', outlet: 'example.com', published: '2020-01-01', url: 'https://example.com/x' }
  ]
};

test('wa delivery: the message carries the full article url', () => {
  const parts = waResearch.format(RESULT, { subject: 'Suresh Kumar' });
  const all = parts.join('\n');
  assert.match(all, /https:\/\/www\.thehindu\.com\/news\/cities\/mysuru\/man-held-12345\//);
  assert.match(all, /confirmed/);
});

test('wa delivery: our records are shown apart from the sources', () => {
  const all = waResearch.format(RESULT, { subject: 'Suresh Kumar' }).join('\n');
  assert.match(all, /From our own records/);
  assert.match(all, /Sources/);
  assert.ok(all.indexOf('From our own records') < all.indexOf('*Sources*'),
    'records come first and are separately headed');
});

test('wa delivery: strong matches are shown, weak ones are not padded in', () => {
  const all = waResearch.format(RESULT, { subject: 'Suresh Kumar' }).join('\n');
  assert.match(all, /Man held in Mysuru/);
  assert.ok(!/Unrelated column/.test(all), 'a possible match is not listed when a confirmed one exists');
});

test('wa delivery: with only weak matches, they are shown rather than nothing', () => {
  const weak = { ...RESULT, findings: [RESULT.findings[1]] };
  const all = waResearch.format(weak, { subject: 'Suresh Kumar' }).join('\n');
  assert.match(all, /Unrelated column/);
});

test('wa delivery: the source list is labelled with the markers the summary cites', () => {
  // The summary says [S2]; the officer must be able to find S2 in the list. Numbering the
  // list 1, 2, 3 by band gave two orderings in one message, and asked about "the sixth
  // source" the model answered about whichever document happened to be sixth by band.
  const marked = {
    ...RESULT,
    summary: 'He was arrested in Mysuru [S2]. A later report clears him [S1].',
    findings: [
      { ...RESULT.findings[0], marker: 'S2' },
      { attribution: 'confirmed', marker: 'S1', title: 'Acquitted on appeal', outlet: 'deccanherald.com', url: 'https://deccanherald.com/a' },
      { attribution: 'probable', title: 'Uncited but strong', outlet: 'thenewsminute.com', url: 'https://thenewsminute.com/b' }
    ]
  };
  const all = waResearch.format(marked, { subject: 'Suresh Kumar' }).join('\n');
  assert.match(all, /S1\. Acquitted on appeal/, 'cited sources are labelled by their marker');
  assert.match(all, /S2\. Man held in Mysuru/);
  assert.ok(all.indexOf('S1. Acquitted') < all.indexOf('S2. Man held'),
    'and listed in marker order, not band order');
  assert.match(all, /—\. Uncited but strong/,
    'a strong source the summary does not cite is still listed, and not given a number that would read as a marker');
});

test('wa delivery: an engine that reports no markers still numbers the list', () => {
  // Forward compatibility runs both ways: a function deployed ahead of the engine must
  // not produce a list of dashes.
  const all = waResearch.format(RESULT, { subject: 'Suresh Kumar' }).join('\n');
  assert.match(all, /1\. Man held in Mysuru/);
});

test('wa delivery: a no-match run is labelled as one', () => {
  const none = { ...RESULT, summary_kind: 'no_match', findings: [] };
  const all = waResearch.format(none, { subject: 'Suresh Kumar' }).join('\n');
  assert.match(all, /no source could be tied to this subject/);
});

test('wa delivery: Kannada renders in Kannada', () => {
  const all = waResearch.format(RESULT, { subject: 'Suresh Kumar', language: 'kn' }).join('\n');
  assert.match(all, /ಮೂಲಗಳು/);
  assert.ok(!/\bSources\b/.test(all), 'no English dead-end in a Kannada delivery');
});

test('wa delivery: a callback with no phone is refused, not guessed at', async () => {
  const out = await waResearch.deliver(fakeApp({}), { result: RESULT, context: {} });
  assert.equal(out.delivered, false);
  assert.match(out.reason, /no phone/);
});
