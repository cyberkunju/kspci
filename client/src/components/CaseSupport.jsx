import { useState } from 'react';
import { api } from '../api';
import {
  Grid, Stack, Heading, Text, Badge, Button, TextInput, Table, Banner, EmptyState,
  MetadataList, MetadataListItem, Divider, Icon, proportional, pixel, Search, Sparkles, Fingerprint,
} from '../ui';
import { VizCard } from './Cards';

function fmt(t) {
  return String(t || '').split('\n').map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : <span key={j}>{p}</span>);
    return <p key={i} style={{ margin: '0 0 8px' }}>{parts}</p>;
  });
}

export default function CaseSupport({ role, language }) {
  const [crimeNo, setCrimeNo] = useState('');
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = (cn) => {
    setLoading(true); setErr(null); setD(null);
    api.investigatorCase({ crimeNo: cn || undefined, caseId: cn ? undefined : 1, language, role })
      .then((r) => { if (r.error) setErr(r.error); else setD(r); })
      .catch((e) => setErr(e.message)).finally(() => setLoading(false));
  };

  const c = d && d.case;
  return (
    <div className="view">
      <Stack gap={1} className="view-head">
        <Heading level={3}>Investigator Decision Support</Heading>
        <Text type="body" color="secondary">Case dossier · timeline · similar-case outcomes · AI-generated leads — grounded in the crime database</Text>
      </Stack>

      <Stack direction="horizontal" gap={2} vAlign="end" className="case-search">
        <TextInput
          label="CrimeNo" isLabelHidden value={crimeNo} onChange={setCrimeNo} onEnter={() => load(crimeNo)}
          startIcon={<Icon icon={Search} size="sm" />} width="100%"
          placeholder="Enter CrimeNo (or leave blank for a sample case)"
        />
        <Button label={loading ? 'Analyzing…' : 'Analyze case'} variant="primary" isLoading={loading}
          icon={<Icon icon={Sparkles} size="sm" />} onClick={() => load(crimeNo)} />
      </Stack>

      {err && <Banner status={err === 'case_not_found' ? 'warning' : 'error'} title={err === 'case_not_found' ? 'No case found with that CrimeNo.' : err} />}
      {!d && !err && !loading && (
        <EmptyState icon={<Icon icon={Fingerprint} size="lg" color="tertiary" />}
          title="Build a decision-support dossier"
          description="Enter a CrimeNo (or click Analyze for a sample) to assemble a full case dossier, timeline, similar-case outcomes and AI leads." />
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
            <div className="brief-body">{d.brief ? fmt(d.brief) : <Text color="tertiary">No brief generated.</Text>}</div>
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
