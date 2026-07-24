// Shared Astryx-based presentational cards used across every analytics view.
import { Card, Grid, Stack, Heading, Text } from '../ui';

export function Kpi({ label, value, sub, tone }) {
  return (
    <Card padding={4}>
      <Stack gap={0.5}>
        <Heading level={2} type="display-3" color={tone || 'primary'}>{value}</Heading>
        <Text type="supporting" color="secondary">{label}</Text>
        {sub && <Text type="supporting" color="tertiary">{sub}</Text>}
      </Stack>
    </Card>
  );
}

export function VizCard({ title, action, note, children, full }) {
  return (
    <Card padding={4} className={full ? 'grid-full' : undefined}>
      <Stack gap={3} height="100%">
        {(title || action) && (
          <Stack direction="horizontal" vAlign="center" gap={2}>
            {title && <Heading level={5}>{title}</Heading>}
            {action && <div className="push-right">{action}</div>}
          </Stack>
        )}
        {children}
        {note && <Text type="supporting" color="tertiary" justify="center">{note}</Text>}
      </Stack>
    </Card>
  );
}

export { Grid };
