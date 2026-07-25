import { useEffect, useState } from 'react';
import { api } from '../api';
import NetworkGraph from './NetworkGraph';
import { Grid, Stack, Text, Table, Badge, Icon, proportional, pixel, CircleDot } from '../ui';
import { BarCell, ViewError, VizCard } from './Cards';
import { fmtRupees } from '../lib/chartTheme';

export default function MoneyTrail({ role }) {
  const [d, setD] = useState(null); const [err, setErr] = useState(null);
  useEffect(() => {
    let current = true;
    setErr(null); setD(null);
    api.moneytrail(role)
      .then((data) => { if (current) setD(data); })
      .catch((e) => { if (current) setErr(e); });
    return () => { current = false; };
  }, [role]);
  if (err) return <ViewError err={err} />;
  if (!d) return <Stack hAlign="center" padding={8}><Text color="tertiary">Tracing money flows…</Text></Stack>;

  // Column maxima drive the in-cell magnitude bars.
  const maxLinked = Math.max(1, ...(d.hubs || []).map((h) => Number(h.linkedAccused) || 0));
  const maxFlow = Math.max(1, ...(d.hubs || []).map((h) => Number(h.totalAmount) || 0));

  // adapt to the D3 graph: accused = ring 1 (blue), counterparty = ring 2 (amber)
  const graph = {
    nodes: (d.nodes || []).map((n) => ({ id: n.id, ring: n.type === 'counterparty' ? 2 : 1, degree: n.degree })),
    links: (d.links || []).slice(0, 300).map((l) => ({ source: l.source, target: l.target, weight: 1, ring: 0 })),
    rings: []
  };

  return (
    <Grid columns={1} gap={3}>
      <VizCard
        title="Money-trail network · accused ↔ counterparty flows"
        action={
          <Stack direction="horizontal" gap={3} vAlign="center">
            <Text type="supporting" color="tertiary">{d.totalFlows} transactions</Text>
            <Stack direction="horizontal" gap={1} vAlign="center"><Icon icon={CircleDot} size="xsm" color="accent" /><Text type="supporting" color="secondary">accused</Text></Stack>
            <Stack direction="horizontal" gap={1} vAlign="center"><Icon icon={CircleDot} size="xsm" color="warning" /><Text type="supporting" color="secondary">counterparty</Text></Stack>
          </Stack>
        }
        note="Edges = money transfers. Counterparties linked to many distinct accused are potential mule/layering hubs (flagged)."
      >
        <NetworkGraph data={graph} kind="money" />
      </VizCard>
      <VizCard
        title="Suspicious hubs (money-mule / layering signals)"
        note="Counterparties linked to 4 or more distinct accused are flagged for review."
      >
        <Table
          data={d.hubs || []} density="compact" dividers="rows" hasHover
          columns={[
            { key: 'counterparty', header: 'Counterparty / Account', width: proportional(1.4, 150) },
            {
              key: 'linkedAccused', header: 'Linked accused', width: proportional(1, 130),
              renderCell: (h) => <BarCell value={h.linkedAccused} max={maxLinked} tone={h.linkedAccused >= 4 ? 'error' : 'warning'} />,
            },
            {
              key: 'totalAmount', header: 'Total flow', width: proportional(1.1, 140),
              renderCell: (h) => <BarCell value={h.totalAmount} max={maxFlow} display={fmtRupees(h.totalAmount)} tone="success" />,
            },
            {
              key: 'flag', header: '', width: pixel(84),
              renderCell: (h) => (h.linkedAccused >= 4 ? <Badge variant="error" label="Review" /> : null),
            },
          ]}
        />
      </VizCard>
    </Grid>
  );
}
