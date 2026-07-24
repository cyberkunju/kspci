import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Chart, registerables } from 'chart.js';
Chart.register(...registerables);

import { PALETTE as PAL, GRID, TICK } from '../lib/chartTheme';
import { Grid, Stack, Text, Banner } from '../ui';
import { VizCard } from './Cards';

function C({ type, data, options, height = 230 }) {
  const ref = useRef(null); const ch = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ch.current = new Chart(ref.current, {
      type, data,
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: TICK, font: { size: 10 } }, display: type === 'doughnut' } },
        scales: type === 'doughnut' ? {} : { x: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } } }, y: { grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true } },
        ...options
      }
    });
    return () => ch.current && ch.current.destroy();
  }, [JSON.stringify(data), type]);
  return <div style={{ height }}><canvas ref={ref} /></div>;
}
const cat = (arr) => ({ labels: (arr || []).map((x) => x.label), data: (arr || []).map((x) => x.count) });

export default function Sociology({ role }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => { api.sociology(role).then(setD).catch((e) => setErr(e.message)); }, [role]);
  if (err) return <Banner status="error" title={err} />;
  if (!d) return <Stack hAlign="center" padding={8}><Text color="tertiary">Loading sociological insights…</Text></Stack>;
  const occ = cat(d.occupation);
  return (
    <Grid columns={{ minWidth: 280, max: 3 }} gap={3}>
      <VizCard title="Accused — age distribution">
        <C type="bar" data={{ labels: cat(d.accusedAge).labels, datasets: [{ label: 'Accused', data: cat(d.accusedAge).data, backgroundColor: '#3d8bfd' }] }} options={{ plugins: { legend: { display: false } } }} />
      </VizCard>
      <VizCard title="Victim — age distribution">
        <C type="bar" data={{ labels: cat(d.victimAge).labels, datasets: [{ label: 'Victims', data: cat(d.victimAge).data, backgroundColor: '#f472b6' }] }} options={{ plugins: { legend: { display: false } } }} />
      </VizCard>
      <VizCard title="Complainant occupation (socio-economic)">
        <C type="bar" data={{ labels: occ.labels, datasets: [{ label: 'Complaints', data: occ.data, backgroundColor: PAL }] }} options={{ indexAxis: 'y', plugins: { legend: { display: false } } }} height={260} />
      </VizCard>
      <VizCard title="Accused gender">
        <C type="doughnut" data={{ labels: cat(d.accusedGender).labels, datasets: [{ data: cat(d.accusedGender).data, backgroundColor: PAL, borderColor: '#0b1120', borderWidth: 2 }] }} />
      </VizCard>
      <VizCard title="Community — religion">
        <C type="doughnut" data={{ labels: cat(d.religion).labels, datasets: [{ data: cat(d.religion).data, backgroundColor: PAL, borderColor: '#0b1120', borderWidth: 2 }] }} />
      </VizCard>
      <VizCard title="Social category">
        <C type="doughnut" data={{ labels: cat(d.caste).labels, datasets: [{ data: cat(d.caste).data, backgroundColor: PAL, borderColor: '#0b1120', borderWidth: 2 }] }} />
      </VizCard>
      <VizCard title="Crime type × accused gender (behavioural pattern)" note={d.note} full>
        <C type="bar" height={280} data={{
          labels: (d.crimeByGender || []).map((x) => x.sub),
          datasets: [
            { label: 'Male', data: (d.crimeByGender || []).map((x) => x.male), backgroundColor: '#3d8bfd' },
            { label: 'Female', data: (d.crimeByGender || []).map((x) => x.female), backgroundColor: '#f472b6' }
          ]
        }} options={{ plugins: { legend: { display: true } }, scales: { x: { stacked: true, grid: { color: GRID }, ticks: { color: TICK, font: { size: 9 } } }, y: { stacked: true, grid: { color: GRID }, ticks: { color: TICK } } } }} />
      </VizCard>
    </Grid>
  );
}
