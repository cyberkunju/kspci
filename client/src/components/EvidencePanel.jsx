// Explainable-AI panel: shows the generated ZCQL, the model's rationale,
// cited evidence records, and the raw query result — the transparency layer
// that satisfies the "Explainable AI & audit trail" requirement.
// Static rail on wide screens; slide-over drawer on smaller screens.
import {
  Stack, Heading, Text, Badge, StatusDot, Table, EmptyState, IconButton, Icon,
  proportional, Route, Layers, Network, ScrollText, ChartNoAxesCombined, ShieldCheck, X,
} from '../ui';

function SectionLabel({ icon, children }) {
  return (
    <Stack direction="horizontal" gap={1.5} vAlign="center">
      <Icon icon={icon} size="sm" color="accent" />
      <Text type="label" color="accent">{children}</Text>
    </Stack>
  );
}

export default function EvidencePanel({ evidence, open, onClose }) {
  let body;
  let count = null;
  if (!evidence) {
    body = (
      <EmptyState
        icon={<Icon icon={ShieldCheck} size="lg" color="tertiary" />}
        title="Grounded in the crime database"
        description="Ask a question and the exact query, reasoning, and cited records appear here."
      />
    );
  } else {
    const { zcql, rationale, citations = [], rows = [], reasoning } = evidence;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const tableCols = cols.map((c) => ({ key: c, header: c, width: proportional(1, 110) }));
    count = <Text type="supporting" color="tertiary">{rows.length} record{rows.length === 1 ? '' : 's'}</Text>;
    body = (
      <Stack gap={4}>
        {rationale && (
          <Stack gap={2}>
            <SectionLabel icon={Route}>Why this query</SectionLabel>
            <div className="ev-quote"><Text type="body" color="secondary">{rationale}</Text></div>
          </Stack>
        )}
        {zcql && (
          <Stack gap={2}>
            <SectionLabel icon={Layers}>Generated ZCQL</SectionLabel>
            <pre className="code-block">{zcql}</pre>
          </Stack>
        )}
        {citations.length > 0 && (
          <Stack gap={2}>
            <SectionLabel icon={Network}>Cited evidence ({citations.length})</SectionLabel>
            <Stack gap={1.5}>
              {citations.slice(0, 30).map((c, i) => (
                <Stack key={i} direction="horizontal" gap={2} vAlign="center" className="ev-cite">
                  <Badge variant="info" label={c.type} />
                  <Text type="code" size="small">{c.id}</Text>
                </Stack>
              ))}
            </Stack>
          </Stack>
        )}
        {rows.length > 0 && (
          <Stack gap={2}>
            <SectionLabel icon={ChartNoAxesCombined}>Query result</SectionLabel>
            <div className="ev-table">
              <Table data={rows.slice(0, 100)} columns={tableCols} density="compact" dividers="rows" hasHover textOverflow="truncate" />
            </div>
          </Stack>
        )}
        {reasoning && (
          <Stack gap={2}>
            <SectionLabel icon={ScrollText}>Model reasoning trace</SectionLabel>
            <div className="ev-quote ev-quote-accent"><Text type="body" color="secondary">{reasoning}</Text></div>
          </Stack>
        )}
      </Stack>
    );
  }

  return (
    <>
      {open && <div className="evidence-backdrop" onClick={onClose} />}
      <aside className={`evidence-rail${open ? ' open' : ''}`}>
        <div className="rail-head">
          <StatusDot variant={evidence ? 'success' : 'neutral'} label={evidence ? 'grounded' : 'idle'} isPulsing={!!evidence} />
          <Heading level={6}>Evidence &amp; Reasoning</Heading>
          <span className="rail-count">{count}</span>
          <span className="rail-close">
            <IconButton icon={<Icon icon={X} size="sm" />} label="Close evidence panel" variant="ghost" onClick={onClose} />
          </span>
        </div>
        <div className="rail-body">{body}</div>
      </aside>
    </>
  );
}
