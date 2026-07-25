import { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

import { PALETTE, GRID, TICK, ACCENT, SURFACE, areaFill, fmtInt, fmtCompact, pct } from '../lib/chartTheme';
import { Grid, Stack, Text } from '../ui';
import ChartLegend from './ChartLegend';
import { VizCard } from './Cards';

function ChartCanvas({ type, data, options, height = 240, ariaLabel }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const isRadial = type === 'doughnut' || type === 'pie';
    const { plugins: optPlugins, scales: optScales, ...restOptions } = options || {};
    chartRef.current = new Chart(ref.current, {
      type, data,
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        ...restOptions,
        // Merge (not replace) so per-chart options can't resurrect the built-in
        // legend we deliberately replace with our own readable one.
        plugins: { legend: { display: false }, ...optPlugins },
        scales: isRadial ? {} : {
          x: { grid: { display: false }, ticks: { color: TICK, font: { size: 10 }, maxRotation: 0, autoSkipPadding: 12 } },
          y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true },
          ...optScales,
        },
      },
    });
    return () => chartRef.current && chartRef.current.destroy();
  }, [type, JSON.stringify(data), JSON.stringify(options)]);
  return (
    <div style={{ height }} className="chart-box">
      <canvas ref={ref} role="img" aria-label={ariaLabel} />
    </div>
  );
}

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Small "headline" strip above a chart: the one number that matters, plus context.
function Insight({ value, caption }) {
  return (
    <Stack direction="horizontal" gap={2} vAlign="baseline" wrap="wrap">
      <Text type="large" weight="bold">{value}</Text>
      <Text type="supporting" color="tertiary">{caption}</Text>
    </Stack>
  );
}

export default function TrendCharts({ trends }) {
  if (!trends) return <Stack hAlign="center" padding={8}><Text color="tertiary">Loading trends…</Text></Stack>;

  // The dataset contains occasional far-historic strays (e.g. a single 2005 FIR)
  // that stretch the axis and hide the real trend. Chart the contiguous recent
  // window and disclose anything excluded rather than silently dropping it.
  const allMonths = trends.byMonth || [];
  const idx = (m) => m.year * 12 + m.month;
  const newest = allMonths.length ? Math.max(...allMonths.map(idx)) : 0;
  const WINDOW_MONTHS = 36;
  const months = allMonths.filter((m) => newest - idx(m) < WINDOW_MONTHS);
  const excluded = allMonths.length - months.length;

  const monthLabels = months.map((m) => `${MONTHS[m.month] || m.month} '${String(m.year).slice(2)}`);
  const monthData = months.map((m) => m.count);
  const peak = months.reduce((best, m) => (!best || m.count > best.count ? m : best), null);
  const latest = months[months.length - 1];
  const prev = months[months.length - 2];
  const delta = latest && prev ? latest.count - prev.count : 0;
  const deltaPct = latest && prev && prev.count ? Math.round((delta / prev.count) * 100) : 0;

  const heads = trends.byHead || [];
  const statuses = trends.byStatus || [];
  const gravity = trends.byGravity || [];
  const GRAVITY_COLORS = ['#ec6d5f', '#6d93f5', '#e0aa4e'];
  const topHead = heads.reduce((best, h) => (!best || h.count > best.count ? h : best), null);
  const headTotal = heads.reduce((a, h) => a + h.count, 0);

  return (
    <Grid columns={{ minWidth: 300, max: 2 }} gap={3}>
      <VizCard
        title="Crime volume over time"
        note={[
          peak ? `Peak: ${fmtInt(peak.count)} cases in ${MONTHS[peak.month]} ${peak.year}` : null,
          `Showing the last ${WINDOW_MONTHS} months`,
          excluded ? `${excluded} earlier outlier record${excluded === 1 ? '' : 's'} excluded` : null,
        ].filter(Boolean).join(' · ')}
        full
      >
        <Insight
          value={latest ? `${fmtInt(latest.count)} cases` : '—'}
          caption={latest ? `in ${MONTHS[latest.month]} ${latest.year}${prev ? ` · ${delta >= 0 ? '+' : ''}${deltaPct}% vs previous month` : ''}` : ''}
        />
        <ChartCanvas
          type="line" height={250}
          ariaLabel="Monthly crime case volume"
          data={{
            labels: monthLabels,
            datasets: [{
              label: 'Cases', data: monthData,
              borderColor: ACCENT, borderWidth: 2.5,
              backgroundColor: (c) => areaFill(c, ACCENT, 0.3), fill: true,
              pointRadius: (c) => (c.dataIndex === monthData.length - 1 ? 4 : 0),
              pointBackgroundColor: ACCENT, pointBorderColor: SURFACE, pointBorderWidth: 2,
            }],
          }}
          options={{ plugins: { tooltip: { callbacks: { label: (c) => ` ${fmtInt(c.parsed.y)} cases` } } } }}
        />
      </VizCard>

      <VizCard
        title="By crime head"
        note={topHead ? `${topHead.label} accounts for ${pct(topHead.count, headTotal)}% of classified cases` : undefined}
      >
        <ChartCanvas
          type="bar" height={Math.max(200, heads.length * 34)}
          ariaLabel="Cases by crime head"
          data={{
            labels: heads.map((d) => d.label),
            datasets: [{ label: 'Cases', data: heads.map((d) => d.count), backgroundColor: PALETTE, borderRadius: 6, barThickness: 16 }],
          }}
          options={{
            indexAxis: 'y',
            layout: { padding: { right: 44 } },
            scales: {
              x: { display: false, beginAtZero: true, grace: '8%' },
              y: { grid: { display: false }, ticks: { color: TICK, font: { size: 11 }, crossAlign: 'far' } },
            },
            plugins: {
              barValueLabels: { format: fmtCompact },
              tooltip: { callbacks: { label: (c) => ` ${fmtInt(c.parsed.x)} cases · ${pct(c.parsed.x, headTotal)}%` } },
            },
          }}
        />
      </VizCard>

      <VizCard title="By case status">
        <Stack gap={3}>
          <ChartCanvas
            type="doughnut" height={190}
            ariaLabel="Cases by investigation status"
            data={{ labels: statuses.map((d) => d.label), datasets: [{ data: statuses.map((d) => d.count), backgroundColor: PALETTE, borderColor: SURFACE, borderWidth: 3 }] }}
            options={{
              cutout: '68%',
              plugins: {
                doughnutCenter: { enabled: true, label: 'total cases', format: fmtCompact },
                tooltip: { callbacks: { label: (c) => ` ${fmtInt(c.parsed)} cases` } },
              },
            }}
          />
          <ChartLegend items={statuses} colors={PALETTE} />
        </Stack>
      </VizCard>

      <VizCard title="By gravity">
        <Stack gap={3}>
          <ChartCanvas
            type="doughnut" height={190}
            ariaLabel="Cases by gravity"
            data={{ labels: gravity.map((d) => d.label), datasets: [{ data: gravity.map((d) => d.count), backgroundColor: GRAVITY_COLORS, borderColor: SURFACE, borderWidth: 3 }] }}
            options={{
              cutout: '68%',
              plugins: {
                doughnutCenter: { enabled: true, label: 'total cases', format: fmtCompact },
                tooltip: { callbacks: { label: (c) => ` ${fmtInt(c.parsed)} cases` } },
              },
            }}
          />
          <ChartLegend items={gravity} colors={GRAVITY_COLORS} />
        </Stack>
      </VizCard>
    </Grid>
  );
}
