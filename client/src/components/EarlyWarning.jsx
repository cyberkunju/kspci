import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Chart, registerables } from 'chart.js';
import {
  Grid, Stack, Heading, Text, Badge, Button, Card, Table, Banner, StatusDot,
  Spinner, Icon, proportional, pixel, Radar, Sparkles, ArrowUp, ArrowDown, Server,
} from '../ui';
import { Kpi, VizCard } from './Cards';
Chart.register(...registerables);

const GRID = 'rgba(255,255,255,0.06)';
const TICK = '#8695b3';
const SEV_COLOR = { critical: '#f43f5e', elevated: '#fbbf24', watch: '#22d3ee' };
const SEV_VARIANT = { critical: 'error', elevated: 'warning', watch: 'info' };
const SEV_DOT = { critical: 'error', elevated: 'warning', watch: 'accent' };

function fmtBrief(t) {
  return String(t || '').split('\n').map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : <span key={j}>{p}</span>);
    return <p key={i} style={{ margin: '0 0 8px' }}>{parts}</p>;
  });
}

// Predicted-hotspot map: circle size = predicted volume, colour = severity/trend.
function ForecastMap({ forecasts, alerts }) {
  const elRef = useRef(null); const mapRef = useRef(null); const layerRef = useRef(null);
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false }).setView([14.7, 76.2], 7);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd' }).addTo(map);
    mapRef.current = map; layerRef.current = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; };
  }, []);
  useEffect(() => {
    const map = mapRef.current, group = layerRef.current;
    if (!map || !group || !forecasts) return;
    group.clearLayers();
    const sevOf = {}; (alerts || []).forEach((a) => (sevOf[a.district] = a.severity));
    const max = Math.max(1, ...forecasts.map((f) => f.predicted));
    forecasts.forEach((f) => {
      if (f.lat == null) return;
      const sev = sevOf[f.district];
      const col = sev ? SEV_COLOR[sev] : '#3d8bfd';
      const r = 8 + (f.predicted / max) * 32;
      const c = L.circleMarker([f.lat, f.lng], { radius: r, color: col, weight: 2, fillColor: col, fillOpacity: sev ? 0.45 : 0.22 }).addTo(group);
      c.bindTooltip(`${f.district}: predicted ${f.predicted} (${f.trendPct >= 0 ? '+' : ''}${f.trendPct}%)`, { direction: 'top' });
      c.bindPopup(`<b>${f.district}</b><br>Predicted: ${f.predicted}<br>90% CI: ${f.low}–${f.high}<br>Baseline: ${f.baseline}<br>Trend: ${f.trendPct >= 0 ? '+' : ''}${f.trendPct}%${sev ? `<br><b style="color:${col}">${sev.toUpperCase()}</b>` : ''}`);
    });
  }, [forecasts, alerts]);
  return <div className="hotspot-map" ref={elRef} />;
}

function LineChart({ statewide }) {
  const ref = useRef(null); const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current || !statewide) return;
    chartRef.current = new Chart(ref.current, {
      type: 'line',
      data: {
        labels: statewide.map((s) => s.label),
        datasets: [
          { label: 'Actual', data: statewide.map((s) => s.actual), borderColor: '#22d3ee', backgroundColor: 'transparent', tension: 0.35, pointRadius: 2, borderWidth: 2 },
          { label: 'Predicted (ensemble)', data: statewide.map((s) => s.predicted), borderColor: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.10)', borderDash: [5, 4], fill: true, tension: 0.35, pointRadius: 2, borderWidth: 2 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: TICK, font: { size: 11 } } } },
        scales: { x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 9 } } }, y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true } }
      }
    });
    return () => chartRef.current && chartRef.current.destroy();
  }, [JSON.stringify(statewide)]);
  return <div style={{ height: 260 }}><canvas ref={ref} /></div>;
}

function RealDataValidation({ v }) {
  if (!v || !v.headline) return null;
  return (
    <Banner status="success" container="card" title={`Validated on real data · ${v.dataset}`} defaultIsExpanded description={v.beatsBaseline}>
      <Stack gap={3}>
        <Grid columns={{ minWidth: 180, max: 4 }} gap={2}>
          {v.headline.map((h, i) => (
            <Card key={i} variant={i === 0 ? 'green' : 'muted'} padding={3}>
              <Stack gap={1.5}>
                <Text type="supporting" color="secondary">{h.config}{i === 0 ? ' · champion' : ''}</Text>
                <Stack direction="horizontal" gap={3} vAlign="baseline">
                  <Stack gap={0}><Text type="large" weight="bold" color={h.mase < 1 ? 'success' : 'error'} hasTabularNumbers>{h.mase}</Text><Text type="supporting" color="tertiary">MASE</Text></Stack>
                  <Stack gap={0}><Text type="large" weight="bold" hasTabularNumbers>{h.paiAt1pct}</Text><Text type="supporting" color="tertiary">PAI@1%</Text></Stack>
                  <Stack gap={0}><Text type="large" weight="bold" hasTabularNumbers>{h.coverage90}%</Text><Text type="supporting" color="tertiary">cov</Text></Stack>
                </Stack>
              </Stack>
            </Card>
          ))}
        </Grid>
        <Text type="supporting" color="tertiary">Full methodology + results: {v.report}</Text>
      </Stack>
    </Banner>
  );
}

function Scorecard({ bt }) {
  if (!bt || bt.error) return null;
  const ens = (bt.modelComparison || []).find((m) => m.model && m.model.startsWith('ENSEMBLE'));
  const sp = bt.spatial || {};
  const mase = ens ? ens.mase : null;
  const cards = [
    { label: 'MASE (vs naive)', value: mase ?? '—', sub: mase != null ? (mase < 1 ? `beats naive by ${Math.round((1 - mase) * 100)}%` : 'above naive') : 'skill score', tone: mase != null && mase < 1 ? 'success' : 'error' },
    { label: 'Hit-Rate', value: sp.hitRate != null ? sp.hitRate + '%' : '—', sub: `top ${sp.flaggedDistricts} districts (${sp.areaFraction}% area)`, tone: 'success' },
    { label: 'PAI', value: sp.pai ?? '—', sub: 'accuracy index (>1 beats random)', tone: 'accent' },
    { label: 'PEI', value: sp.pei != null ? sp.pei + '%' : '—', sub: 'of oracle-optimal ranking', tone: 'accent' },
    { label: '90% coverage', value: sp.coverage90 != null ? sp.coverage90 + '%' : '—', sub: 'conformal interval calibration', tone: 'primary' },
    { label: 'Ensemble MAE', value: ens ? ens.mae : '—', sub: `held-out · ${bt.origins} eval origins`, tone: 'warning' },
  ];
  return (
    <Grid columns={{ minWidth: 150, max: 6 }} gap={3}>
      {cards.map((c, i) => <Kpi key={i} {...c} />)}
    </Grid>
  );
}

export default function EarlyWarning({ role, language }) {
  const [fc, setFc] = useState(null);
  const [ew, setEw] = useState(null);
  const [bt, setBt] = useState(null);
  const [wl, setWl] = useState(null);
  const [brief, setBrief] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    setErr(null);
    api.forecast(role).then(setFc).catch((e) => setErr(e.message));
    api.earlywarning(role).then(setEw).catch(() => {});
    api.backtest(role).then(setBt).catch(() => {});
    api.watchlist(role).then((d) => setWl(d.watchlist || [])).catch(() => {});
  }, [role]);

  const loadBrief = () => {
    setBriefLoading(true); setBrief(null);
    api.brief(role, language).then((d) => setBrief(d)).catch((e) => setBrief({ brief: '⚠️ ' + e.message })).finally(() => setBriefLoading(false));
  };

  return (
    <div className="view">
      <Stack direction="horizontal" vAlign="start" gap={3} className="view-head">
        <Stack gap={1}>
          <Heading level={3}>Predictive Early-Warning Engine</Heading>
          <Text type="body" color="secondary">4-model ensemble (Seasonal-Trend · Holt · Hawkes self-excitation · Gradient-Boosted ML) · walk-forward backtested · conformal intervals</Text>
        </Stack>
        {fc && !fc.error && (
          <div className="push-right">
            <Card variant="muted" padding={3}>
              <Stack gap={0.5} hAlign="end">
                <Text type="supporting" color="tertiary">Forecast horizon</Text>
                <Text type="large" weight="bold" color="accent">{fc.horizon}</Text>
                {fc.servedBy && (
                  <Stack direction="horizontal" gap={1} vAlign="center">
                    <Icon icon={Server} size="xsm" color="success" />
                    <Text type="supporting" color="success">{fc.servedBy.includes('appsail') ? 'Catalyst AppSail (Python ML)' : 'in-function engine'}</Text>
                  </Stack>
                )}
              </Stack>
            </Card>
          </div>
        )}
      </Stack>

      {err && <Banner status="error" title={err} />}
      {bt && bt.validation && <RealDataValidation v={bt.validation} />}

      <Text type="label" color="tertiary">Live self-check · synthetic KSP demo data (district×month)</Text>
      <Scorecard bt={bt} />

      <Grid columns={{ minWidth: 440, max: 2 }} gap={3}>
        <VizCard title="Predicted crime concentration · next month"
          action={fc && !fc.error && <Text type="supporting" color="tertiary">Statewide: <b>{fc.statewide?.predicted}</b> · circles sized by forecast, coloured by alert severity</Text>}
          full>
          <ForecastMap forecasts={fc && fc.forecasts} alerts={ew && ew.alerts} />
        </VizCard>

        <VizCard title="Backtest — predicted vs actual (statewide)" note="Expanding-window walk-forward. Dashed = ensemble forecast, solid = ground truth.">
          {bt && bt.statewide ? <LineChart statewide={bt.statewide} /> : <Stack hAlign="center" padding={6}><Spinner size="sm" /></Stack>}
        </VizCard>

        <VizCard title="Model comparison (learned ensemble)">
          <Table
            data={bt?.modelComparison || []} density="compact" dividers="rows" hasHover
            columns={[
              { key: 'model', header: 'Model', width: proportional(1.4, 150), renderCell: (m) => <Text type="body" weight={m.model?.startsWith('ENSEMBLE') ? 'semibold' : 'regular'} color={m.model?.startsWith('ENSEMBLE') ? 'accent' : (m.model?.includes('naive') ? 'tertiary' : 'primary')}>{m.model}</Text> },
              { key: 'mase', header: 'MASE', width: pixel(72), align: 'end', renderCell: (m) => <Text type="body" weight="semibold" color={m.mase != null && m.mase < 1 ? 'success' : 'secondary'} hasTabularNumbers>{m.mase ?? '—'}</Text> },
              { key: 'mae', header: 'MAE', width: pixel(64), align: 'end' },
              { key: 'rmse', header: 'RMSE', width: pixel(64), align: 'end' },
              { key: 'weight', header: 'Weight', width: pixel(70), align: 'end', renderCell: (m) => (m.weight === 1 ? '—' : (m.weight || '—')) },
            ]}
          />
          {bt?.validation?.realData && <Banner status="success" title={bt.validation.realData} />}
        </VizCard>

        <VizCard
          title="Emerging hotspot alerts"
          action={ew && <Stack direction="horizontal" gap={1.5}><Badge variant="error" label={`${ew.critical} critical`} /><Badge variant="warning" label={`${ew.elevated} elevated`} /></Stack>}
          note="Expectation-based: ensemble forecast vs 12-month control baseline (z-score). Decision-support, exposure-normalized — not automated enforcement."
          full>
          <Stack gap={2}>
            {(ew?.alerts || []).length === 0 && <Text color="tertiary" justify="center">No districts breaching the control-chart threshold this cycle.</Text>}
            {(ew?.alerts || []).map((a, i) => (
              <Card key={i} variant="muted" padding={3}>
                <Stack direction="horizontal" gap={3} vAlign="center" wrap="wrap">
                  <StatusDot variant={SEV_DOT[a.severity]} label={a.severity} isPulsing={a.severity === 'critical'} />
                  <Text type="body" weight="semibold">{a.district}</Text>
                  <div className="push-right">
                    <Stack direction="horizontal" gap={3} vAlign="center" wrap="wrap">
                      <Text type="supporting" color="secondary">predicted <b>{a.predicted}</b></Text>
                      <Text type="supporting" color="tertiary">baseline {a.baseline}</Text>
                      <Stack direction="horizontal" gap={1} vAlign="center">
                        <Icon icon={a.trendPct >= 0 ? ArrowUp : ArrowDown} size="xsm" color={a.trendPct >= 0 ? 'error' : 'success'} />
                        <Text type="supporting" color={a.trendPct >= 0 ? 'error' : 'success'}>{Math.abs(a.trendPct)}%</Text>
                      </Stack>
                      <Text type="supporting" color="tertiary">z={a.z}</Text>
                      <Badge variant={SEV_VARIANT[a.severity]} label={a.severity} />
                    </Stack>
                  </div>
                </Stack>
              </Card>
            ))}
          </Stack>
        </VizCard>

        <VizCard title="Reoffending watchlist">
          <Table
            data={wl || []} density="compact" dividers="rows" hasHover
            columns={[
              { key: 'name', header: 'Offender', width: proportional(1.4, 130) },
              { key: 'riskScore', header: 'Risk', width: pixel(64), align: 'end', renderCell: (o) => <Text type="body" weight="semibold" hasTabularNumbers>{o.riskScore}</Text> },
              { key: 'band', header: 'Band', width: pixel(90), renderCell: (o) => <Badge variant={{ high: 'error', medium: 'warning', low: 'success' }[(o.band || '').toLowerCase()] || 'neutral'} label={o.band} /> },
              { key: 'reoffendProb', header: 'Reoffend P', width: pixel(96), align: 'end', renderCell: (o) => Math.round(o.reoffendProb * 100) + '%' },
              { key: 'ring', header: 'Ring', width: pixel(64), renderCell: (o) => o.ring || '—' },
            ]}
          />
        </VizCard>

        <VizCard title="AI analyst brief"
          action={<Button label={briefLoading ? 'Generating…' : 'Generate brief'} variant="primary" size="sm" isLoading={briefLoading} icon={<Icon icon={Sparkles} size="sm" />} onClick={loadBrief} />}>
          <div className="brief-body">
            {brief ? fmtBrief(brief.brief) : <Text color="tertiary">Generate a decision-ready early-warning brief for leadership from the live forecast (GLM-4.7-Flash).</Text>}
          </div>
        </VizCard>
      </Grid>
    </div>
  );
}
