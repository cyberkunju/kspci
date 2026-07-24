import { useEffect, useState } from 'react';
import { api } from '../api';
import {
  Grid, Stack, Heading, Text, Badge, Button, TextInput, Table, Banner, EmptyState,
  MetadataList, MetadataListItem, Divider, Icon, Markdown, Skeleton, Card,
  proportional, pixel, Search, Sparkles, Fingerprint, FileSearch,
} from '../ui';
import { PageHeader, VizCard } from './Cards';

export default function CaseSupport({ role, language }) {
  const [crimeNo, setCrimeNo] = useState('');
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setD(null);
    setErr(null);
  }, [role, language]);

  const load = (cn, sample = false) => {
    if (!sample && !cn?.trim()) return;
    setLoading(true); setErr(null); setD(null);
    api.investigatorCase({ crimeNo: sample ? undefined : cn.trim(), caseId: sample ? 1 : undefined, language, role })
      .then((response) => { if (response.error) setErr(response.error); else setD(response); })
      .catch((e) => setErr(e.message)).finally(() => setLoading(false));
  };

  const c = d && d.case;
  return (
    <div className="view">
      <PageHeader
        eyebrow="INVESTIGATION WORKSPACE"
        title="Build a case dossier with the evidence in view"
        description="Bring together the FIR, people, timeline, comparable outcomes, and grounded AI leads without losing source context."
        badge="Decision support"
      />

      <Card variant="muted" padding={4}>
        <Stack gap={2}>
          <Text type="label" color="tertiary">OPEN A CASE</Text>
          <Stack direction="horizontal" gap={2} vAlign="end" wrap="wrap" className="case-search">
            <TextInput
              label="Crime number" value={crimeNo} onChange={setCrimeNo} onEnter={() => load(crimeNo)}
              startIcon={<Icon icon={Search} size="sm" />} width="100%" isDisabled={loading}
              placeholder="Enter an exact CrimeNo"
              description="Use the number recorded on the FIR."
            />
            <Button label={loading ? 'Building dossier…' : 'Analyze case'} variant="primary" isLoading={loading}
              isDisabled={!crimeNo.trim()} icon={<Icon icon={Sparkles} size="sm" />} onClick={() => load(crimeNo)} />
            <Button label="Open sample" variant="secondary" isDisabled={loading}
              icon={<Icon icon={FileSearch} size="sm" />} onClick={() => load('', true)} />
          </Stack>
        </Stack>
      </Card>

      {err && <Banner status={err === 'case_not_found' ? 'warning' : 'error'} title={err === 'case_not_found' ? 'No case matches that CrimeNo' : 'The dossier could not be built'} description={err === 'case_not_found' ? 'Check the number and try again.' : err} />}
      {loading && (
        <Grid columns={{ minWidth: 360, max: 2 }} gap={3} aria-label="Building case dossier">
          {[0, 1, 2, 3].map((index) => <Skeleton key={index} height={260} index={index} />)}
        </Grid>
      )}
      {!d && !err && !loading && (
        <EmptyState icon={<Icon icon={Fingerprint} size="lg" color="tertiary" />}
          title="No case open"
          description="Enter a CrimeNo to build a live dossier, or open the clearly labelled sample to explore the workflow." />
      )}

      {c && (
        <Grid columns={{ minWidth: 440, max: 2 }} gap={3}>
          <VizCard title={`Case ${c.CrimeNo}`}>
            <MetadataList columns="single" label={{ position: 'start', width: 150 }}>
              <MetadataListItem label="Crime"><Text type="body" weight="semibold">{c.CrimeHead} · {c.CrimeSubHead}</Text></MetadataListItem>
              <MetadataListItem label="Gravity"><Badge variant={c.Gravity === 'Heinous' ? 'error' : 'neutral'} label={c.Gravity} /></MetadataListItem>
              <MetadataListItem label="District / Station">{c.DistrictName} · {c.StationName}</MetadataListItem>
              <MetadataListItem label="Acts & Sections">{c.ActsSections}</MetadataListItem>
              <MetadataListItem label="Status"><Badge variant="info" label={c.CaseStatus} /></MetadataListItem>
              <MetadataListItem label="IO">{c.OfficerName}</MetadataListItem>
            </MetadataList>
            <Divider />
            <Text type="body" color="secondary">{c.BriefFacts}</Text>
            <Divider />
            <Stack gap={2}>
              <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                <Text type="label" color="tertiary">Accused</Text>
                {(d.accused || []).map((a, i) => <Badge key={i} variant="neutral" label={`${a.AccusedName}${a.RingID ? ` · ring ${a.RingID}` : ''}`} />)}
              </Stack>
              <Stack direction="horizontal" gap={1.5} wrap="wrap" vAlign="center">
                <Text type="label" color="tertiary">Victims</Text>
                {(d.victims || []).map((v, i) => <Badge key={i} variant="neutral" label={v.VictimName} />)}
              </Stack>
            </Stack>
          </VizCard>

          <VizCard title="AI case summary & investigative leads" action={<Badge variant="info" label={d.model} />}>
            {d.brief ? (
              <Markdown density="compact" headingLevelStart={3} contentWidth="100%">{d.brief}</Markdown>
            ) : (
              <Text color="tertiary">No AI brief was returned for this case.</Text>
            )}
          </VizCard>

          <VizCard title="Investigation timeline">
            <div className="timeline">
              {(d.timeline || []).map((t, i) => (
                <div className={`tl-row tl-${t.kind}`} key={i}>
                  <div className="tl-dot" /><div className="tl-date">{t.date || '—'}</div><div className="tl-event"><Text type="body">{t.event}</Text></div>
                </div>
              ))}
            </div>
          </VizCard>

          <VizCard title="Similar cases & historical outcome">
            <Grid columns={3} gap={2}>
              <Stack gap={0.5}><Heading level={4} type="display-3">{d.outcomeInsight.totalSimilar}</Heading><Text type="supporting" color="tertiary">similar {d.outcomeInsight.crimeType} cases</Text></Stack>
              <Stack gap={0.5}><Heading level={4} type="display-3" color="success">{d.outcomeInsight.convictionRate}%</Heading><Text type="supporting" color="tertiary">conviction rate</Text></Stack>
              <Stack gap={0.5}><Heading level={4} type="display-3" color="accent">{d.outcomeInsight.chargesheetRate}%</Heading><Text type="supporting" color="tertiary">chargesheeted</Text></Stack>
            </Grid>
            <Table
              data={d.similarCases || []} density="compact" dividers="rows" hasHover
              columns={[
                { key: 'crimeNo', header: 'CrimeNo', width: proportional(1, 110) },
                { key: 'district', header: 'District', width: proportional(1, 110) },
                { key: 'status', header: 'Status', width: pixel(120) },
                { key: 'date', header: 'Registered', width: pixel(110), renderCell: (s) => (s.date || '').slice(0, 10) },
              ]}
            />
          </VizCard>
        </Grid>
      )}
    </div>
  );
}
