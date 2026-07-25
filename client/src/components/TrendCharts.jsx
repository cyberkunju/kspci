import { useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

import { PALETTE, GRID, TICK, ACCENT, SURFACE } from '../lib/chartTheme';
import { Grid, Stack, Text } from '../ui';
import { VizCard } from './Cards';

function ChartCanvas({ type, data, options, height = 240 }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = new Chart(ref.current, {
      type, data,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: TICK, font: { size: 11 } } } },
        scales: type === 'doughnut' || type === 'pie' ? {} : {
          x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } } },
          y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true }
        },
        ...options
      }
    });
    return () => chartRef.current && chartRef.current.destroy();
  }, [type, JSON.stringify(data), JSON.stringify(options)]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}

const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function TrendCharts({ trends }) {
  if (!trends) return <Stack hAlign="center" padding={8}><Text color="tertiary">Loading trends…</Text></Stack>;

  const monthLabels = (trends.byMonth || []).map((m) => `${MONTHS[m.month] || m.month} '${String(m.year).slice(2)}`);
  const monthData = (trends.byMonth || []).map((m) => m.count);

  return (
    <Grid columns={{ minWidth: 300, max: 2 }} gap={3}>
      <VizCard title="Crime volume over time" full>
        <ChartCanvas type="line" height={260} data={{
          labels: monthLabels,
          datasets: [{
            label: 'Cases', data: monthData, borderColor: ACCENT,
            backgroundColor: 'rgba(91,140,255,0.12)', fill: true
          }]
        }} />
      </VizCard>

      <VizCard title="By crime head">
        <ChartCanvas type="bar" data={{
          labels: (trends.byHead || []).map((d) => d.label),
          datasets: [{ label: 'Cases', data: (trends.byHead || []).map((d) => d.count), backgroundColor: PALETTE }]
        }} options={{ indexAxis: 'y', plugins: { legend: { display: false } } }} />
      </VizCard>

      <VizCard title="By case status">
        <ChartCanvas type="doughnut" data={{
          labels: (trends.byStatus || []).map((d) => d.label),
          datasets: [{ data: (trends.byStatus || []).map((d) => d.count), backgroundColor: PALETTE, borderColor: SURFACE, borderWidth: 2 }]
        }} />
      </VizCard>

      <VizCard title="By gravity">
        <ChartCanvas type="doughnut" data={{
          labels: (trends.byGravity || []).map((d) => d.label),
          datasets: [{ data: (trends.byGravity || []).map((d) => d.count), backgroundColor: ['#ec6d5f', '#6d93f5', '#e0aa4e'], borderColor: SURFACE, borderWidth: 2 }]
        }} />
      </VizCard>
    </Grid>
  );
}
