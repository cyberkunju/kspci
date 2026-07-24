import { Card, Grid, Stack, Heading, Text, Badge, Skeleton } from '../ui';

export function PageHeader({ eyebrow, title, description, action, badge }) {
  return (
    <Stack direction="horizontal" gap={4} vAlign="start" wrap="wrap" className="view-head">
      <Stack gap={1} className="view-head-copy">
        <Stack direction="horizontal" gap={1.5} vAlign="center" wrap="wrap">
          {eyebrow && <Text type="label" color="accent">{eyebrow}</Text>}
          {badge && <Badge variant="neutral" label={badge} />}
        </Stack>
        <Heading level={2}>{title}</Heading>
        {description && <Text type="body" color="secondary">{description}</Text>}
      </Stack>
      {action && <div className="view-head-action">{action}</div>}
    </Stack>
  );
}

export function MetricSkeletons({ count = 6 }) {
  return (
    <Grid columns={{ minWidth: 150, max: count }} gap={3}>
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} padding={4}>
          <Stack gap={2}>
            <Skeleton width="58%" height={30} index={index} />
            <Skeleton width="82%" height={14} index={index + 1} />
          </Stack>
        </Card>
      ))}
    </Grid>
  );
}

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
