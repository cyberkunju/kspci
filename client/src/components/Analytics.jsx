import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import NetworkGraph from './NetworkGraph';
import HotspotMap from './HotspotMap';
import TrendCharts from './TrendCharts';
import Sociology from './Sociology';
import MoneyTrail from './MoneyTrail';
import {
  TabList, Tab, Grid, Stack, Text, Badge, Table, Selector,
  Banner, EmptyState, Button, Icon, RefreshCw, proportional, pixel,
} from '../ui';
import { Kpi, MetricSkeletons, PageHeader, VizCard } from './Cards';

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
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('view');
  const tab = TABS.some((item) => item.id === requestedTab) ? requestedTab : 'overview';
  const [overview, setOverview] = useState(null);
  const [trends, setTrends] = useState(null);
  const [hotspots, setHotspots] = useState(null);
  const [net, setNet] = useState(null);
  const [ring, setRing] = useState('');
  const [offenders, setOffenders] = useState(null);
  const [financial, setFinancial] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tabLoading, setTabLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true); setErr(null); setOverview(null); setTrends(null);
    Promise.all([api.overview(role), api.trends(role)])
      .then(([nextOverview, nextTrends]) => {
        if (!current) return;
        setOverview(nextOverview); setTrends(nextTrends);
      })
      .catch((error) => current && setErr(error.message))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [role, refreshKey]);

  useEffect(() => {
    let current = true;
    setErr(null);
    if (tab === 'map') {
      setTabLoading(true); setHotspots(null);
      api.hotspots(role).then((data) => current && setHotspots(data)).catch((error) => current && setErr(error.message)).finally(() => current && setTabLoading(false));
    } else if (tab === 'network') {
      setTabLoading(true); setNet(null); setRing('');
      api.network(role).then((data) => current && setNet(data)).catch((error) => current && setErr(error.message)).finally(() => current && setTabLoading(false));
    } else if (tab === 'offenders') {
      setTabLoading(true); setOffenders(null); setFinancial(null);
      Promise.all([api.offenders(role), api.financial(role)])
        .then(([nextOffenders, nextFinancial]) => { if (current) { setOffenders(nextOffenders); setFinancial(nextFinancial); } })
        .catch((error) => current && setErr(error.message))
        .finally(() => current && setTabLoading(false));
    } else {
      setTabLoading(false);
    }
    return () => { current = false; };
  }, [tab, role, refreshKey]);

  const changeTab = (nextTab) => setSearchParams(nextTab === 'overview' ? {} : { view: nextTab });
  const selectRing = (nextRing) => {
    setRing(nextRing); setNet(null); setTabLoading(true); setErr(null);
    api.network(role, nextRing || undefined)
      .then(setNet).catch((error) => setErr(error.message)).finally(() => setTabLoading(false));
  };

  const fmtAmt = (n) => '₹' + Number(n).toLocaleString('en-IN');

  return (
    <div className="view">
      <PageHeader
        eyebrow="STATEWIDE INTELLIGENCE"
        title="See the signal before opening the detail"
        description="Explore live patterns, networks, hotspots, social context, and financial links with a clear path back to source records."
        badge={`Access: ${role}`}
      />

      <TabList value={tab} onChange={changeTab} hasDivider>
        {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
      </TabList>

      {err && (
        <Banner
          status="error" title="This intelligence view could not be loaded" description={err}
          endContent={<Button label="Retry" size="sm" variant="secondary" icon={<Icon icon={RefreshCw} size="sm" />} onClick={() => setRefreshKey((key) => key + 1)} />}
        />
      )}

      {loading ? <MetricSkeletons /> : overview && (
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
        {tabLoading && <MetricSkeletons count={2} />}
        {!tabLoading && tab === 'overview' && !err && <TrendCharts trends={trends} />}
        {!tabLoading && tab === 'sociology' && <Sociology role={role} />}
        {!tabLoading && tab === 'money' && <MoneyTrail role={role} />}

        {!tabLoading && tab === 'network' && (
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

        {!tabLoading && tab === 'map' && (
          <VizCard title="Crime hotspots across Karnataka">
            <HotspotMap data={hotspots} />
          </VizCard>
        )}

        {!tabLoading && tab === 'offenders' && (
          <Grid columns={{ minWidth: 420, max: 2 }} gap={3}>
            <VizCard title="Highest-risk repeat offenders">
              <Table
                data={offenders || []} density="compact" dividers="rows" hasHover
                emptyState={<EmptyState title="No offenders match this view" description="Try another access context or refresh the data." />}
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
                emptyState={<EmptyState title="No transactions in this view" description="No suspicious transactions were returned." />}
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
