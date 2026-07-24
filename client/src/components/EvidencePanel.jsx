// Explainable-AI panel: the transparency layer for the "Explainable AI & audit
// trail" requirement. Leads with plain-language reasoning and the cited source
// records an officer actually trusts; the generated query and model reasoning
// trace stay available but tucked into one collapsed "technical" section so the
// panel reads like a production evidence view, not a query console.
// Static rail on wide screens; slide-over drawer on smaller screens.
import {
  Stack, Heading, Text, StatusDot, Table, EmptyState, IconButton, Icon,
  Citation, Collapsible, Markdown, proportional, Route, Layers, Network,
  ChartNoAxesCombined, ShieldCheck, X,
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
        description="Ask a question and the reasoning, cited records, and underlying query appear here."
      />
    );
  } else {
    const { zcql, rationale, citations = [], rows = [], reasoning } = evidence;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const tableCols = cols.map((c) => ({ key: c, header: c, width: proportional(1, 110) }));
    count = <Text type="supporting" color="tertiary">{rows.length} record{rows.length === 1 ? '' : 's'}</Text>;
    body = (
      <Stack gap={3}>
        {rationale && (
          <div className="ev-section">
            <Stack gap={1.5}>
              <SectionLabel icon={Route}>Why this answer</SectionLabel>
              <Text type="body" color="secondary">{rationale}</Text>
            </Stack>
          </div>
        )}
        {citations.length > 0 && (
          <div className="ev-section">
            <Stack gap={2}>
              <SectionLabel icon={Network}>Source records ({citations.length})</SectionLabel>
              <Stack gap={1.5}>
                {citations.slice(0, 30).map((citation, index) => (
                  <Citation
                    key={`${citation.type}-${citation.id}-${index}`}
                    source={{ title: `${citation.type} · ${citation.id}` }}
                    number={index + 1}
                    variant="label"
                  />
                ))}
              </Stack>
            </Stack>
          </div>
        )}
        {rows.length > 0 && (
          <div className="ev-section">
            <Stack gap={2}>
              <SectionLabel icon={ChartNoAxesCombined}>Records returned</SectionLabel>
              <div className="ev-table">
                <Table data={rows.slice(0, 100)} columns={tableCols} density="compact" dividers="rows" hasHover textOverflow="truncate" />
              </div>
            </Stack>
          </div>
        )}
        {(zcql || reasoning) && (
          <Collapsible
            trigger={<SectionLabel icon={Layers}>Query &amp; reasoning</SectionLabel>}
            defaultIsOpen={false}
          >
            <Stack gap={3}>
              {zcql && (
                <Stack gap={1}>
                  <Text type="supporting" color="tertiary">Generated ZCQL</Text>
                  <pre className="code-block">{zcql}</pre>
                </Stack>
              )}
              {reasoning && (
                <Stack gap={1}>
                  <Text type="supporting" color="tertiary">Model reasoning trace</Text>
                  <Markdown density="compact" headingLevelStart={4} contentWidth="100%">{reasoning}</Markdown>
                </Stack>
              )}
            </Stack>
          </Collapsible>
        )}
      </Stack>
    );
  }

  return (
    <>
      {open && <button type="button" className="evidence-backdrop" aria-label="Close evidence panel" onClick={onClose} />}
      <aside className={`evidence-rail${open ? ' open' : ''}`} aria-label="Evidence and reasoning">
        <div className="rail-head">
          <StatusDot variant={evidence ? 'success' : 'neutral'} label={evidence ? 'grounded' : 'idle'} />
          <Heading level={6}>Evidence &amp; reasoning</Heading>
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
