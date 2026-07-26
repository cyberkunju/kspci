import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  Grid, Stack, Heading, Text, Badge, Button, TextInput, TextArea, Selector, Table,
  Banner, EmptyState, MetadataList, MetadataListItem, Divider, Icon, Markdown, Card,
  SegmentedControl, SegmentedControlItem, ProgressBar, Spinner,
  proportional, pixel, Globe, Search, Sparkles, Download, ArrowUpRight, Languages,
  Landmark, TriangleAlert, BadgeCheck, Timer,
} from '../ui';
import { PageHeader, VizCard } from './Cards';
import { exportResearchPdf } from '../lib/pdf';

const KINDS = [
  { value: 'person', label: 'Person' },
  { value: 'crime', label: 'Crime / case' },
  { value: 'event', label: 'Event' },
  { value: 'organisation', label: 'Organisation' },
  { value: 'identifier', label: 'Identifier (phone, UPI, account)' },
];

// What each mode costs the officer in waiting time, stated up front. A tool that
// silently takes five minutes gets abandoned at ninety seconds.
// Two depths. A third, "quick", was removed: it existed only to fit inside a serverless
// function's 30-second ceiling, and ten pages read is a sample rather than research.
const MODES = [
  { value: 'standard', label: 'Standard', hint: 'about a minute · reads up to 48 sources' },
  { value: 'deep', label: 'Deep', hint: 'up to five minutes · reads up to 120' },
];

const BANDS = {
  confirmed: { label: 'Confirmed', variant: 'success' },
  probable: { label: 'Probable', variant: 'info' },
  possible: { label: 'Possible', variant: 'neutral' },
  different_person: { label: 'Different person', variant: 'error' },
  unrelated: { label: 'Unrelated', variant: 'neutral' },
};

const TIERS = {
  1: { label: 'Official', variant: 'success' },
  2: { label: 'Newsroom', variant: 'info' },
  3: { label: 'Syndicated', variant: 'neutral' },
  4: { label: 'Unvetted', variant: 'warning' },
  5: { label: 'Social', variant: 'warning' },
};

const LANGS = { kn: 'ಕನ್ನಡ', hi: 'हिन्दी', ta: 'தமிழ்', te: 'తెలుగు', ml: 'മലയാളം', mr: 'मराठी' };

// Which tier found the link. Worth showing: a hit from a court's own search and a hit
// from a news aggregator deserve different amounts of trust before you even open them.
const VIA = {
  gdelt: 'wire index (GDELT)',
  bingnews: 'news feed',
  'wikipedia:en': 'Wikipedia',
  searxng: 'metasearch',
  marginalia: 'metasearch',
  mojeek: 'metasearch',
};

const viaLabel = (v) => VIA[v] || (v.startsWith('onsite:') ? `${v.slice(7)}'s own search` : v);

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '—'; }
};

const POLL_MS = 1500;

export default function Research({ role }) {
  const [subject, setSubject] = useState('');
  const [kind, setKind] = useState('person');
  const [purpose, setPurpose] = useState('');
  const [question, setQuestion] = useState('');
  const [crimeNo, setCrimeNo] = useState('');
  const [mode, setMode] = useState('standard');

  const [run, setRun] = useState(null);          // { id, state, stage, message, events }
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [engine, setEngine] = useState(null);
  const [band, setBand] = useState('all');
  const timer = useRef(null);

  useEffect(() => {
    let live = true;
    api.researchHealth(role)
      .then((h) => live && setEngine(h))
      .catch((e) => live && setEngine({ ok: false, error: e.message }));
    return () => { live = false; };
  }, [role]);

  // One interval, cleared on unmount and on every state change that ends the run.
  // Without the cleanup a navigation away leaves a timer polling a finished run.
  useEffect(() => () => clearTimeout(timer.current), []);

  const busy = Boolean(run && (run.state === 'queued' || run.state === 'running'));
  const purposeWords = purpose.trim().split(/\s+/).filter(Boolean).length;
  const canStart = subject.trim().length > 1 && purposeWords >= 3 && !busy;

  function poll(id) {
    api.researchPoll(id, role)
      .then((r) => {
        setRun(r);
        if (r.state === 'done' && r.result) setResult(r.result);
        else if (r.state === 'failed') setErr(r.error || 'the run failed');
        if (r.state === 'queued' || r.state === 'running') {
          timer.current = setTimeout(() => poll(id), POLL_MS);
        }
      })
      .catch((e) => {
        // A single missed poll is not a failed run — the gateway drops one
        // occasionally. Give up only after the run has clearly gone.
        if (e.status === 404) setErr('the run expired before it could be read');
        else timer.current = setTimeout(() => poll(id), POLL_MS * 2);
      });
  }

  function startRun() {
    clearTimeout(timer.current);
    setErr(null); setResult(null); setRun({ state: 'queued', stage: 'plan', message: 'starting' });
    api.researchStart({ subject, kind, purpose, question, mode, crimeNo, role })
      .then((r) => { setRun({ ...r, events: [] }); poll(r.id); })
      .catch((e) => { setRun(null); setErr(e.message); });
  }

  function cancelRun() {
    clearTimeout(timer.current);
    if (run && run.id) api.researchCancel(run.id, role).catch(() => {});
    setRun((r) => (r ? { ...r, state: 'cancelled' } : null));
  }

  const findings = result ? (result.findings || []) : [];
  const shown = band === 'all' ? findings : findings.filter((f) => f.attribution === band);
  const counts = (result && result.counts) || {};
  const bandCounts = counts.by_attribution || {};

  return (
    <div className="view">
      <PageHeader
        eyebrow="OPEN-SOURCE RESEARCH"
        title="Find what the open internet says, and how much of it is really them"
        description="Searches news, court and government sources in English, Kannada and Hindi, then grades every source by how confident it is that the source is about your subject. Nothing it returns is evidence."
        badge="OSINT"
      />

      {engine && engine.ok === false && (
        <Banner status="warning" title="The research engine is not reachable"
          description={engine.configured === false
            ? 'This deployment has no RESEARCH_SERVICE_URL configured, so runs cannot be started.'
            : String(engine.error || 'The engine did not answer.')} />
      )}

      <Card variant="muted" padding={4}>
        <Stack gap={3}>
          <Text type="label" color="tertiary">WHAT ARE YOU RESEARCHING</Text>
          <Grid columns={{ minWidth: 240, max: 2 }} gap={3}>
            <TextInput
              label="Subject" value={subject} onChange={setSubject} onEnter={() => canStart && startRun()}
              startIcon={<Icon icon={Search} size="sm" />} width="100%" isDisabled={busy}
              placeholder="A name, a case, an event or an organisation"
              description="For a person, the exact name as it appears in our records finds the most anchors."
            />
            <Selector label="Kind" options={KINDS} value={kind} onChange={(v) => setKind(v || 'person')}
              width="100%" isDisabled={busy} />
            <TextInput
              label="Purpose (recorded)" value={purpose} onChange={setPurpose} width="100%" isDisabled={busy}
              placeholder="Why this research is needed"
              description={purposeWords < 3
                ? 'A few words at least. This is recorded against your name and the case.'
                : 'Recorded against your name and the case.'}
            />
            <TextInput
              label="Crime number (optional)" value={crimeNo} onChange={setCrimeNo} width="100%" isDisabled={busy}
              placeholder="FIR / CrimeNo"
              description="The single most useful anchor: it pulls the district, station, sections and co-accused from our records."
            />
          </Grid>
          <TextArea
            label="A specific question (optional)" value={question} onChange={setQuestion}
            isDisabled={busy} rows={2} width="100%"
            placeholder="e.g. Has this person been reported in connection with any earlier case?"
            description="Shapes the summary. The source list is returned either way."
          />
          <Divider />
          <Stack direction="horizontal" gap={3} vAlign="end" wrap="wrap">
            <Stack gap={1}>
              <Text type="label" color="tertiary">DEPTH</Text>
              <SegmentedControl label="Research depth" value={mode} onChange={setMode} size="sm" isDisabled={busy}>
                {MODES.map((m) => <SegmentedControlItem key={m.value} value={m.value} label={m.label} />)}
              </SegmentedControl>
              <Text type="supporting" color="tertiary">
                <Icon icon={Timer} size="xsm" /> {(MODES.find((m) => m.value === mode) || {}).hint}
              </Text>
            </Stack>
            <Button label={busy ? 'Researching…' : 'Start research'} variant="primary" isLoading={busy}
              isDisabled={!canStart} icon={<Icon icon={Sparkles} size="sm" />} onClick={startRun} />
            {busy && <Button label="Stop" variant="secondary" onClick={cancelRun} />}
            {result && (
              <Button label="Export report" variant="secondary" icon={<Icon icon={Download} size="sm" />}
                onClick={() => exportResearchPdf({ result, role })} />
            )}
          </Stack>
        </Stack>
      </Card>

      {err && <Banner status="error" title="The research run could not be completed" description={err} />}

      {busy && <RunProgress run={run} />}

      {result && (
        <>
          {result.partial && (
            <Banner status="warning" title="This run hit its time limit"
              description={`Everything below is real and graded; it is just not everything that exists. Stages reached: ${(result.stages || []).join(' → ')}. Try Deep mode for more.`} />
          )}

          <Grid columns={{ minWidth: 440, max: 2 }} gap={3}>
            <VizCard
              title={result.summary_kind === 'no_match'
                ? 'No source could be tied to this subject'
                : 'What the engine concluded'}
              action={<Badge variant="neutral" label={`${result.mode} · ${result.elapsed_s}s`} />}>
              {result.summary_kind === 'no_match' && (
                <Banner status="warning" title="This is not a finding about the subject"
                  description="Nothing retrieved could be attributed to them. The note below describes what came back instead — often coverage of other people sharing the name." />
              )}
              {result.summary ? (
                <Markdown density="compact" headingLevelStart={3} contentWidth="100%">{result.summary}</Markdown>
              ) : (
                <EmptyState icon={<Icon icon={TriangleAlert} size="lg" color="tertiary" />}
                  title="No summary was written"
                  description="Either no source met the bar for summarising, or no model is configured. The graded source list below is unaffected." />
              )}
              {(result.warnings || []).length > 0 && (
                <>
                  <Divider />
                  <Stack gap={1}>
                    <Text type="label" color="tertiary">WITHHELD OR UNAVAILABLE</Text>
                    {(result.warnings || []).slice(0, 8).map((w, i) => (
                      <Text key={i} type="supporting" color="secondary">· {w}</Text>
                    ))}
                  </Stack>
                </>
              )}
            </VizCard>

            <VizCard title="How this run was anchored"
              action={<Badge variant={anchorVariant(result.anchors)} label={anchorLabel(result.anchors)} />}>
              <Text type="supporting" color="secondary">
                Attribution is only as good as what we knew before searching. This is what came from our own records.
              </Text>
              <MetadataList columns="single" label={{ position: 'start', width: 130 }}>
                <MetadataListItem label="Subject"><Text weight="semibold">{result.subject}</Text></MetadataListItem>
                {anchorRow('District', (result.anchors || {}).district)}
                {anchorRow('Station', (result.anchors || {}).station)}
                {anchorRow('Age', (result.anchors || {}).age)}
                {anchorList('FIR numbers', (result.anchors || {}).crimeNumbers)}
                {anchorList('Co-accused', (result.anchors || {}).associates)}
                {anchorList('Sections', (result.anchors || {}).sections)}
              </MetadataList>
              <Divider />
              <Grid columns={4} gap={2}>
                <Stat value={counts.candidates} label="candidates" />
                <Stat value={counts.readable} label="read" />
                <Stat value={counts.kannada_sources} label="Kannada" icon={Languages} />
                <Stat value={counts.official_sources} label="official" icon={Landmark} />
              </Grid>
              {(result.records || []).length > 0 && (
                <>
                  <Divider />
                  <Stack gap={1}>
                    <Text type="label" color="tertiary">FROM OUR OWN RECORDS — cited as [DB]</Text>
                    {/* Kept visibly apart from the source table. A report that blends the
                        police file with open-source material is unusable as either, and
                        the engine is instructed never to let [DB] corroborate a source. */}
                    {(result.records || []).map((r, i) => (
                      <Text key={i} type="supporting" color="secondary">· {r}</Text>
                    ))}
                  </Stack>
                </>
              )}
              {(result.namesakes || []).length > 1 && (
                <>
                  <Divider />
                  <Text type="supporting" color="secondary">
                    {result.namesakes.length} publicly known people share this name, so an unanchored
                    match cannot be treated as confirmed:
                  </Text>
                  <Stack direction="horizontal" gap={1.5} wrap="wrap">
                    {result.namesakes.slice(0, 6).map((n) => (
                      <Badge key={n.id} variant="neutral" label={`${n.label}${n.description ? ' — ' + n.description : ''}`} />
                    ))}
                  </Stack>
                </>
              )}
            </VizCard>
          </Grid>

          <VizCard
            title={`Sources (${findings.length})`}
            action={
              <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                <BandFilter value={band} onChange={setBand} counts={bandCounts} total={findings.length} />
              </Stack>
            }
          >
            {shown.length === 0 ? (
              <EmptyState icon={<Icon icon={Globe} size="lg" color="tertiary" />}
                title="No source in this band"
                description="Change the filter to see the rest of what was retrieved." />
            ) : (
              <Table
                data={shown} density="compact" dividers="rows" hasHover
                columns={[
                  {
                    key: 'attribution', header: 'Confidence', width: pixel(132),
                    renderCell: (f) => (
                      <Stack gap={0.5}>
                        {/* The citation marker the summary uses for this source. Without
                            it the summary's "[S3]" resolved to nothing on any screen,
                            which makes the every-sentence-is-cited contract unverifiable
                            by the one person who needs to verify it. */}
                        {f.marker && (
                          <Text type="supporting" weight="semibold" color="accent">[{f.marker}]</Text>
                        )}
                        <Badge variant={(BANDS[f.attribution] || {}).variant || 'neutral'}
                          label={(BANDS[f.attribution] || {}).label || f.attribution} />
                        {(f.matched || []).length > 0 && (
                          <Text type="supporting" color="tertiary">
                            matched: {(f.matched || []).join(', ')}
                          </Text>
                        )}
                      </Stack>
                    )
                  },
                  {
                    key: 'title', header: 'Source', width: proportional(3, 260),
                    renderCell: (f) => (
                      <Stack gap={0.5}>
                        <a href={f.url} target="_blank" rel="noopener noreferrer" className="src-title">
                          <Text type="body" weight="semibold" maxLines={2}>{f.title || f.url}</Text>
                        </a>
                        {/* The exact article url, in full and selectable. An officer
                            citing a source in a case file needs the link itself, not a
                            hyperlink they cannot read or paste. */}
                        <Text type="supporting" color="accent" maxLines={2}>
                          <span className="src-url">{f.url}</span>
                        </Text>
                        {/* The reasons are the audit trail. An identification an officer
                            cannot check is one they should not act on. */}
                        <Text type="supporting" color="tertiary" maxLines={3}>{(f.why || []).join(' · ')}</Text>
                      </Stack>
                    )
                  },
                  {
                    key: 'outlet', header: 'Site', width: proportional(1, 132),
                    renderCell: (f) => (
                      <Stack gap={0.5}>
                        <Text type="supporting" weight="semibold">{f.outlet || hostOf(f.url)}</Text>
                        <Stack direction="horizontal" gap={1} wrap="wrap">
                          <Badge variant={TIERS[f.tier] ? TIERS[f.tier].variant : 'neutral'}
                            label={(TIERS[f.tier] || {}).label || `tier ${f.tier}`}
                            icon={f.tier === 1 ? <Icon icon={BadgeCheck} size="xsm" /> : undefined} />
                          {f.language && f.language !== 'en' && (
                            <Badge variant="info" label={LANGS[f.language] || f.language} />
                          )}
                        </Stack>
                      </Stack>
                    )
                  },
                  {
                    key: 'published', header: 'Published', width: pixel(104),
                    renderCell: (f) => <Text type="supporting">{(f.published || '').slice(0, 10) || 'undated'}</Text>
                  },
                  {
                    key: 'via', header: 'Found by', width: pixel(150),
                    renderCell: (f) => (
                      <Stack gap={0.5}>
                        {(f.via || []).slice(0, 3).map((v) => (
                          <Text key={v} type="supporting" color="tertiary">{viaLabel(v)}</Text>
                        ))}
                        {f.outlet_count > 1 && (
                          <Text type="supporting" color="secondary">
                            {f.outlet_count} independent outlets
                          </Text>
                        )}
                      </Stack>
                    )
                  },
                  {
                    key: 'url', header: 'Open', width: pixel(56),
                    renderCell: (f) => (
                      <a href={f.url} target="_blank" rel="noopener noreferrer"
                        aria-label={`Open ${f.title || f.url} in a new tab`}>
                        <Icon icon={ArrowUpRight} size="sm" />
                      </a>
                    )
                  },
                ]}
              />
            )}
          </VizCard>

          {(result.timeline || []).length > 0 && (
            <VizCard title="Dated claims, in order">
              <Text type="supporting" color="secondary">
                Each line was quoted verbatim from the source it links to, and the quote was
                re-found in that page before it was admitted here.
              </Text>
              <div className="timeline">
                {(result.timeline || []).map((t, i) => (
                  <div className="tl-row tl-event" key={i}>
                    <div className="tl-dot" />
                    <div className="tl-date">{t.date}</div>
                    <div className="tl-event">
                      <Text type="body">{t.text}</Text>
                      <a href={t.url} target="_blank" rel="noopener noreferrer">
                        <Text type="supporting" color="accent">source</Text>
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </VizCard>
          )}

          <Banner status="info" title="Read this before acting on any of the above"
            description={result.disclaimer} />
        </>
      )}

      {!result && !busy && !err && (
        <EmptyState icon={<Icon icon={Globe} size="lg" color="tertiary" />}
          title="No research run yet"
          description="Name a subject and state why the research is needed. The engine anchors the search on our own records, then grades every source it finds." />
      )}
    </div>
  );
}

/* ------------------------------ progress ------------------------------ */

/**
 * Live stage detail rather than a spinner.
 *
 * A deep run takes minutes. Without visible stages an officer concludes it has hung
 * and starts it again, which costs the instance two runs and them their patience.
 */
function RunProgress({ run }) {
  const events = (run && run.events) || [];
  const last = events[events.length - 1];
  const done = STAGES.filter((s) => events.some((e) => e.stage === s.id)).length;
  return (
    <Card padding={4}>
      <Stack gap={3}>
        <Stack direction="horizontal" gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text weight="semibold">{(last && last.message) || 'starting the run'}</Text>
          <Badge variant="neutral" label={`${run.state}${last ? ` · ${last.t}s` : ''}`} />
        </Stack>
        <ProgressBar value={Math.round((done / STAGES.length) * 100)} label="Research progress" />
        <Stack direction="horizontal" gap={1.5} wrap="wrap">
          {STAGES.map((s) => (
            <Badge key={s.id}
              variant={events.some((e) => e.stage === s.id) ? 'success' : 'neutral'}
              label={s.label} />
          ))}
        </Stack>
        {events.length > 1 && (
          <Stack gap={0.5}>
            {events.slice(-5).map((e, i) => (
              <Text key={i} type="supporting" color="tertiary">{e.t}s · {e.stage} · {e.message}</Text>
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

const STAGES = [
  { id: 'plan', label: 'Plan' },
  { id: 'discover', label: 'Discover' },
  { id: 'retrieve', label: 'Read' },
  { id: 'attribute', label: 'Grade' },
  { id: 'done', label: 'Summarise' },
];

/* ------------------------------ small parts ------------------------------ */

function BandFilter({ value, onChange, counts, total }) {
  const options = [
    { value: 'all', label: `All (${total})` },
    ...Object.keys(BANDS)
      .filter((b) => counts[b])
      .map((b) => ({ value: b, label: `${BANDS[b].label} (${counts[b]})` })),
  ];
  return (
    <Selector label="Filter by confidence" options={options} value={value}
      onChange={(v) => onChange(v || 'all')} width={220} />
  );
}

function Stat({ value, label, icon }) {
  return (
    <Stack gap={0.5}>
      <Heading level={4} type="display-3">{value == null ? '—' : value}</Heading>
      <Text type="supporting" color="tertiary">
        {icon && <Icon icon={icon} size="xsm" />} {label}
      </Text>
    </Stack>
  );
}

function anchorRow(label, value) {
  if (!value) return null;
  return <MetadataListItem label={label}>{String(value)}</MetadataListItem>;
}

function anchorList(label, values) {
  if (!values || !values.length) return null;
  return (
    <MetadataListItem label={label}>
      <Stack direction="horizontal" gap={1} wrap="wrap">
        {values.slice(0, 8).map((v) => <Badge key={v} variant="neutral" label={String(v)} />)}
      </Stack>
    </MetadataListItem>
  );
}

/**
 * How much the anchors can support. Shown as a badge because it is the honest ceiling
 * on every band in the table below it: a run anchored on a bare name cannot reach
 * "confirmed", and the officer should be able to see that at a glance.
 */
function anchorStrength(a) {
  const x = a || {};
  let score = 0;
  if ((x.crimeNumbers || []).length) score += 4;
  if ((x.associates || []).length) score += 2;
  if (x.district) score += 2;
  if (x.station) score += 1;
  if (x.age) score += 1;
  if ((x.sections || []).length) score += 1;
  return score;
}

function anchorLabel(a) {
  const s = anchorStrength(a);
  if (s >= 6) return 'Strongly anchored';
  if (s >= 3) return 'Partly anchored';
  return 'Name only';
}

function anchorVariant(a) {
  const s = anchorStrength(a);
  return s >= 6 ? 'success' : s >= 3 ? 'info' : 'warning';
}
