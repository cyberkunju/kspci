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

test('wa tool: read-only policymaker cannot research a person over WhatsApp', () => {
  // Mirrors the engine's own role gate. A field channel must not be a way round the
  // rule that person-level research needs an operational role.
  assert.ok(!waTools.allowedToolNames('policymaker').includes('open_source_research'));
  for (const role of ['investigator', 'analyst', 'supervisor', 'admin']) {
    assert.ok(waTools.allowedToolNames(role).includes('open_source_research'), role);
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
