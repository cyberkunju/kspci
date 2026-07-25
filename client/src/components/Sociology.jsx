import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

import { PALETTE as PAL, GRID, TICK, SURFACE, ACCENT } from '../lib/chartTheme';
import { Grid, Stack, Text } from '../ui';
import ChartLegend from './ChartLegend';
import { ViewError, VizCard } from './Cards';

function C({ type, data, options, height = 230 }) {
  const ref = useRef(null); const ch = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ch.current = new Chart(ref.current, {
      type, data,
      options: {
        responsive: true, maintainAspectRatio: false,
        // Doughnuts use <ChartLegend> below the chart; bars are self-labelling.
        scales: type === 'doughnut' ? {} : {
          x: { grid: { display: false }, ticks: { color: TICK, font: { size: 10 } } },
          y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true },
        },
        ...options,
      }
    });
    return () => ch.current && ch.current.destroy();
  }, [JSON.stringify(data), type]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}
const cat = (arr) => ({ labels: (arr || []).map((x) => x.label), data: (arr || []).map((x) => x.count) });

export default function Sociology({ role }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => {
    let current = true;
    setErr(null); setD(null);
    api.sociology(role)
      .then((data) => { if (current) setD(data); })
      .catch((e) => { if (current) setErr(e); });
    return () => { current = false; };
  }, [role]);
  if (err) return <ViewError err={err} />;
  if (!d) return <Stack hAlign="center" padding={8}><Text color="tertiary">Loading sociological insights…</Text></Stack>;
  const occ = cat(d.occupation);
  return (
    <Grid columns={{ minWidth: 280, max: 3 }} gap={3}>
      <VizCard title="Accused — age distribution">
        <C type="bar" data={{ labels: cat(d.accusedAge).labels, datasets: [{ label: 'Accused', data: cat(d.accusedAge).data, backgroundColor: ACCENT }] }} options={{ plugins: { legend: { display: false } } }} />
      </VizCard>
      <VizCard title="Victim — age distribution">
        <C type="bar" data={{ labels: cat(d.victimAge).labels, datasets: [{ label: 'Victims', data: cat(d.victimAge).data, backgroundColor: '#f472b6' }] }} options={{ plugins: { legend: { display: false } } }} />
      </VizCard>
      <VizCard title="Complainant occupation (socio-economic)">
        <C type="bar" data={{ labels: occ.labels, datasets: [{ label: 'Complaints', data: occ.data, backgroundColor: PAL }] }} options={{ indexAxis: 'y', plugins: { legend: { display: false } } }} height={260} />
      </VizCard>
      {[
        { title: 'Accused gender', rows: d.accusedGender },
        { title: 'Community — religion', rows: d.religion },
        { title: 'Social category', rows: d.caste },
      ].map(({ title, rows }) => (
        <VizCard title={title} key={title}>
          <Stack gap={3}>
            <C
              type="doughnut" height={170}
              data={{ labels: cat(rows).labels, datasets: [{ data: cat(rows).data, backgroundColor: PAL, borderColor: SURFACE, borderWidth: 3 }] }}
              options={{ cutout: '68%', plugins: { doughnutCenter: { enabled: true, label: 'records' } } }}
            />
            <ChartLegend items={rows || []} colors={PAL} />
          </Stack>
        </VizCard>
      ))}
      <VizCard title="Crime type × accused gender (behavioural pattern)" note={d.note} full>
        <C type="bar" height={280} data={{
          labels: (d.crimeByGender || []).map((x) => x.sub),
          datasets: [
            { label: 'Male', data: (d.crimeByGender || []).map((x) => x.male), backgroundColor: ACCENT },
            { label: 'Female', data: (d.crimeByGender || []).map((x) => x.female), backgroundColor: '#f472b6' }
          ]
        }} options={{
          plugins: { legend: { display: true, position: 'bottom', labels: { color: TICK, font: { size: 11 } } } },
          scales: { x: { stacked: true, grid: { display: false }, ticks: { color: TICK, font: { size: 9 } } }, y: { stacked: true, grid: { color: GRID }, ticks: { color: TICK } } },
        }} />
      </VizCard>
    </Grid>
  );
}
