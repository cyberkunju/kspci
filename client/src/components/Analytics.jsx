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
  EmptyState, proportional, pixel,
} from '../ui';
import { BarCell, Kpi, MetricSkeletons, PageHeader, ViewError, VizCard } from './Cards';
import { fmtInt, fmtRupees } from '../lib/chartTheme';

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
  // Districts by default. The map used to only ever request the state roll-up, so individual
  // districts — Bengaluru among them — simply had no circle, which reads as missing data.
  const [mapLevel, setMapLevel] = useState('district');
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
      .catch((error) => current && setErr(error))
      .finally(() => current && setLoading(false));
    return () => { current = false; };
  }, [role, refreshKey]);

  useEffect(() => {
    let current = true;
    setErr(null);
    if (tab === 'map') {
      setTabLoading(true); setHotspots(null);
      api.hotspots(role, mapLevel).then((data) => current && setHotspots(data)).catch((error) => current && setErr(error)).finally(() => current && setTabLoading(false));
    } else if (tab === 'network') {
      setTabLoading(true); setNet(null); setRing('');
      api.network(role).then((data) => current && setNet(data)).catch((error) => current && setErr(error)).finally(() => current && setTabLoading(false));
    } else if (tab === 'offenders') {
      setTabLoading(true); setOffenders(null); setFinancial(null);
      Promise.all([api.offenders(role), api.financial(role)])
        .then(([nextOffenders, nextFinancial]) => { if (current) { setOffenders(nextOffenders); setFinancial(nextFinancial); } })
        .catch((error) => current && setErr(error))
        .finally(() => current && setTabLoading(false));
    } else {
      setTabLoading(false);
    }
    return () => { current = false; };
  }, [tab, role, refreshKey, mapLevel]);

  const changeTab = (nextTab) => setSearchParams(nextTab === 'overview' ? {} : { view: nextTab });
  const selectRing = (nextRing) => {
    setRing(nextRing); setNet(null); setTabLoading(true); setErr(null);
    api.network(role, nextRing || undefined)
      .then(setNet).catch((error) => setErr(error)).finally(() => setTabLoading(false));
  };

  // Column maxima drive the in-cell magnitude bars.
  const maxTxn = Math.max(1, ...(financial || []).map((t) => Number(t.amount) || 0));

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

      {err && <ViewError err={err} onRetry={() => setRefreshKey((key) => key + 1)} />}

      {loading ? <MetricSkeletons /> : overview && (
        <Grid columns={{ minWidth: 150, max: 6 }} gap={3}>
          <Kpi label="Total FIRs / Cases" value={fmtInt(overview.totalCases)} />
          <Kpi label="Accused persons" value={fmtInt(overview.totalAccused)} sub={`≈${(overview.totalAccused / Math.max(1, overview.totalCases)).toFixed(1)} per case`} />
          <Kpi label="Heinous crimes" value={fmtInt(overview.heinous)} sub={`${overview.heinousPct}% of all cases`} tone="error" share={overview.heinousPct} />
          <Kpi label="Chargesheeted" value={`${overview.chargesheetRate}%`} sub={`${fmtInt(overview.chargesheeted)} cases filed`} tone="success" share={overview.chargesheetRate} />
          <Kpi label="High-risk offenders" value={fmtInt(overview.highRiskOffenders)} sub="risk band: high" tone="warning" />
          <Kpi label="Districts covered" value={overview.districts} sub={`across ${overview.states || 36} states & UTs`} />
        </Grid>
      )}

      <div className="view-body">
        {tabLoading && <MetricSkeletons count={2} />}
        {!tabLoading && tab === 'overview' && !err && <TrendCharts trends={trends} />}
        {!tabLoading && tab === 'sociology' && <Sociology role={role} />}
        {!tabLoading && tab === 'money' && <MoneyTrail role={role} />}

        {!tabLoading && !err && tab === 'network' && (
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

        {!tabLoading && !err && tab === 'map' && (
          <VizCard
            title="Crime hotspots across India"
            action={
              <Stack direction="horizontal" gap={2} vAlign="center">
                <Text type="supporting" color="tertiary">
                  {(hotspots?.districts || []).length} {mapLevel === 'district' ? 'districts' : 'states & UTs'}
                </Text>
                <Selector
                  label="Map detail" isLabelHidden value={mapLevel} width={200}
                  onChange={(v) => setMapLevel(v || 'district')}
                  options={[
                    { value: 'district', label: 'District detail' },
                    { value: 'state', label: 'State / UT roll-up' },
                  ]}
                />
              </Stack>
            }
            note="Circle area is proportional to recorded case volume. Switch to the roll-up for a national comparison."
          >
            <HotspotMap data={hotspots} />
          </VizCard>
        )}

        {!tabLoading && !err && tab === 'offenders' && (
          <Grid columns={{ minWidth: 420, max: 2 }} gap={3}>
            <VizCard title="Highest-risk repeat offenders">
              <Table
                data={offenders || []} density="compact" dividers="rows" hasHover
                emptyState={<EmptyState title="No offenders match this view" description="Try another access context or refresh the data." />}
                columns={[
                  { key: 'name', header: 'Offender', width: proportional(1.3, 130) },
                  { key: 'riskScore', header: 'Risk score', width: proportional(1, 110), renderCell: (o) => <BarCell value={o.riskScore} max={100} tone={(o.riskBand || '').toLowerCase() === 'high' ? 'error' : 'warning'} /> },
                  { key: 'riskBand', header: 'Band', width: pixel(88), renderCell: (o) => <Badge variant={BAND_VARIANT[(o.riskBand || '').toLowerCase()] || 'neutral'} label={o.riskBand} /> },
                  { key: 'totalCases', header: 'Cases', width: pixel(64), align: 'end', renderCell: (o) => <Text type="body" hasTabularNumbers>{fmtInt(o.totalCases)}</Text> },
                  { key: 'violentCases', header: 'Violent', width: pixel(72), align: 'end', renderCell: (o) => <Text type="body" color={o.violentCases > 0 ? 'error' : 'tertiary'} hasTabularNumbers>{fmtInt(o.violentCases)}</Text> },
                  { key: 'ring', header: 'Ring', width: pixel(60), renderCell: (o) => (o.ring ? <Badge variant="neutral" label={String(o.ring)} /> : <Text color="tertiary">—</Text>) },
                ]}
              />
            </VizCard>
            <VizCard title="Largest suspicious transactions">
              <Table
                data={financial || []} density="compact" dividers="rows" hasHover
                emptyState={<EmptyState title="No transactions in this view" description="No suspicious transactions were returned." />}
                columns={[
                  { key: 'accused', header: 'Accused', width: proportional(1, 110) },
                  { key: 'counterparty', header: 'Counterparty', width: proportional(1, 110) },
                  {
                    key: 'amount', header: 'Amount', width: proportional(1.2, 140),
                    renderCell: (t) => <BarCell value={t.amount} max={maxTxn} display={fmtRupees(t.amount)} tone="success" />,
                  },
                  { key: 'date', header: 'Date', width: pixel(92), renderCell: (t) => <Text type="supporting" color="tertiary">{(t.date || '').slice(0, 10)}</Text> },
                ]}
              />
            </VizCard>
          </Grid>
        )}
      </div>
    </div>
  );
}
