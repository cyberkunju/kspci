import { Card, Grid, Stack, Heading, Text, Badge, Skeleton, Banner, Button, Icon, RefreshCw } from '../ui';

// True when an API error is an RBAC 403 (the caller's role can't access the view).
export function isForbidden(err) {
  return !!err && (err.status === 403 || err.code === 'forbidden for role');
}

// Role-aware error surface: a calm "restricted" notice for RBAC 403s, and a
// real error banner (with optional retry) for genuine failures. Accepts either
// an Error-like object (with .status/.code/.message) or a plain string.
export function ViewError({ err, onRetry }) {
  if (isForbidden(err)) {
    return (
      <Banner
        status="warning"
        title="Restricted for your access role"
        description="This view is available to the Analyst, Supervisor, Policymaker, and Admin roles. Switch your working access context to open it."
      />
    );
  }
  const message = typeof err === 'string' ? err : (err && err.message) || 'Something went wrong.';
  return (
    <Banner
      status="error"
      title="This view could not be loaded"
      description={message}
      endContent={onRetry && (
        <Button label="Retry" size="sm" variant="secondary" icon={<Icon icon={RefreshCw} size="sm" />} onClick={onRetry} />
      )}
    />
  );
}

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

export function Kpi({ label, value, sub, tone, share }) {
  return (
    <Card padding={4}>
      <Stack gap={0.5}>
        <Heading level={2} type="display-3" color={tone || 'primary'}>{value}</Heading>
        <Text type="supporting" color="secondary">{label}</Text>
        {/* Optional proportion bar: turns a bare percentage into something you
            can read at a glance without parsing the number. */}
        {share != null && (
          <div className="kpi-share" role="presentation">
            <span style={{ width: `${Math.max(0, Math.min(100, share))}%` }} data-tone={tone || 'primary'} />
          </div>
        )}
        {sub && <Text type="supporting" color="tertiary">{sub}</Text>}
      </Stack>
    </Card>
  );
}

/**
 * Table cell that shows a number *and* its magnitude relative to the column
 * max, so ranked tables can be scanned without comparing digits.
 */
export function BarCell({ value, max, display, tone = 'accent' }) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar-cell">
      <span className="bar-cell-track"><i style={{ width: `${w}%` }} data-tone={tone} /></span>
      <b>{display ?? value}</b>
    </div>
  );
}

export function VizCard({ title, action, note, children, full }) {
  return (
    <Card padding={4} className={full ? 'grid-full' : undefined}>
      <Stack gap={3} height="100%">
        {(title || action) && (
          <Stack direction="horizontal" vAlign="center" gap={2} wrap="wrap" className="viz-head">
            {title && <Heading level={5}>{title}</Heading>}
            {action && <div className="push-right viz-head-action">{action}</div>}
          </Stack>
        )}
        {children}
        {note && <Text type="supporting" color="tertiary" justify="center">{note}</Text>}
      </Stack>
    </Card>
  );
}

export { Grid };
