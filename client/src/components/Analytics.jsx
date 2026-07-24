import { useEffect, useState } from 'react';
import { api } from '../api';
import NetworkGraph from './NetworkGraph';
import HotspotMap from './HotspotMap';
import TrendCharts from './TrendCharts';
import Sociology from './Sociology';
import MoneyTrail from './MoneyTrail';
import {
  TabList, Tab, Grid, Stack, Heading, Text, Badge, Table, Selector,
  Banner, Spinner, proportional, pixel,
} from '../ui';
import { Kpi, VizCard } from './Cards';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Criminal Networks' },
  { id: 'map', label: 'Hotspot Map' },
  { id: 'sociology', label: 'Sociological Insights' },
  { id: 'money', label: 'Money Trail' },
  { id: 'offenders', label: 'Offenders & Finance' },
];

const BAND_VARIANT = { high: 'error', medium: 'warning', low: 'success' };

export default function Analytics({ role }) {
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [trends, setTrends] = useState(null);
  const [hotspots, setHotspots] = useState(null);
  const [net, setNet] = useState(null);
  const [ring, setRing] = useState('');
  const [offenders, setOffenders] = useState(null);
  const [financial, setFinancial] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.overview(role).then(setOverview).catch((e) => setErr(e.message));
    api.trends(role).then(setTrends).catch(() => {});
  }, [role]);

  useEffect(() => {
    if (tab === 'map' && !hotspots) api.hotspots(role).then(setHotspots).catch(() => {});
    if (tab === 'network' && !net) api.network(role).then(setNet).catch(() => {});
    if (tab === 'offenders' && !offenders) {
      api.offenders(role).then(setOffenders).catch(() => {});
      api.financial(role).then(setFinancial).catch(() => {});
    }
  }, [tab]); // eslint-disable-line

  const selectRing = (r) => {
    setRing(r); setNet(null);
    api.network(role, r || undefined).then(setNet).catch(() => {});
  };

  const fmtAmt = (n) => '₹' + Number(n).toLocaleString('en-IN');

  return (
    <div className="view">
      <Stack gap={1} className="view-head">
        <Heading level={3}>Crime Analytics &amp; Intelligence</Heading>
        <Text type="body" color="secondary">Live aggregates over the KSP crime database · patterns, networks, hotspots, risk</Text>
      </Stack>

      <TabList value={tab} onChange={setTab} hasDivider>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </TabList>

      {err && <Banner status="error" title={err} />}

      {overview && (
        <Grid columns={{ minWidth: 150, max: 6 }} gap={3}>
          <Kpi label="Total FIRs / Cases" value={overview.totalCases.toLocaleString('en-IN')} />
          <Kpi label="Accused persons" value={overview.totalAccused.toLocaleString('en-IN')} />
          <Kpi label="Heinous crimes" value={overview.heinous} sub={`${overview.heinousPct}% of cases`} tone="error" />
          <Kpi label="Chargesheeted" value={`${overview.chargesheetRate}%`} sub={`${overview.chargesheeted} cases`} tone="success" />
          <Kpi label="High-risk offenders" value={overview.highRiskOffenders} tone="warning" />
          <Kpi label="Districts covered" value={overview.districts} />
        </Grid>
      )}

      <div className="view-body">
        {tab === 'overview' && <TrendCharts trends={trends} />}
        {tab === 'sociology' && <Sociology role={role} />}
        {tab === 'money' && <MoneyTrail role={role} />}

        {tab === 'network' && (
          <VizCard
            title="Co-accused network & organized-crime rings"
            action={
              <Selector
                label="Ring filter" isLabelHidden value={ring} onChange={(v) => selectRing(v || '')}
                width={240} placeholder="All strongest links"
                options={[{ value: '', label: 'All strongest links' },
                  ...(net?.rings || []).map((r) => ({ value: String(r.ring), label: `Ring ${r.ring} (${r.links} links)` }))]}
              />
            }
            note="Nodes = accused persons · size = number of links · colour = ring · edges = shared cases"
          >
            <NetworkGraph data={net} />
          </VizCard>
        )}

        {tab === 'map' && (
          <VizCard title="Crime hotspots across Karnataka">
            <HotspotMap data={hotspots} />
          </VizCard>
        )}

        {tab === 'offenders' && (
          <Grid columns={{ minWidth: 420, max: 2 }} gap={3}>
            <VizCard title="Highest-risk repeat offenders">
              <Table
                data={offenders || []} density="compact" dividers="rows" hasHover
                emptyState={<Stack hAlign="center" padding={4}><Spinner size="sm" /></Stack>}
                columns={[
                  { key: 'name', header: 'Offender', width: proportional(1.4, 130) },
                  { key: 'riskScore', header: 'Risk', width: pixel(64), align: 'end', renderCell: (o) => <Text type="body" weight="semibold" hasTabularNumbers>{o.riskScore}</Text> },
                  { key: 'riskBand', header: 'Band', width: pixel(90), renderCell: (o) => <Badge variant={BAND_VARIANT[(o.riskBand || '').toLowerCase()] || 'neutral'} label={o.riskBand} /> },
                  { key: 'totalCases', header: 'Cases', width: pixel(64), align: 'end' },
                  { key: 'violentCases', header: 'Violent', width: pixel(70), align: 'end' },
                  { key: 'ring', header: 'Ring', width: pixel(64), renderCell: (o) => o.ring || '—' },
                ]}
              />
            </VizCard>
            <VizCard title="Largest suspicious transactions">
              <Table
                data={financial || []} density="compact" dividers="rows" hasHover
                emptyState={<Stack hAlign="center" padding={4}><Spinner size="sm" /></Stack>}
                columns={[
                  { key: 'accused', header: 'Accused', width: proportional(1, 120) },
                  { key: 'counterparty', header: 'Counterparty', width: proportional(1, 120) },
                  { key: 'amount', header: 'Amount', width: pixel(120), align: 'end', renderCell: (t) => <Text type="code" size="small" color="success">{fmtAmt(t.amount)}</Text> },
                  { key: 'date', header: 'Date', width: pixel(96), renderCell: (t) => (t.date || '').slice(0, 10) },
                ]}
              />
            </VizCard>
          </Grid>
        )}
      </div>
    </div>
  );
}
