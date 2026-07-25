import { fmtInt, pct } from '../lib/chartTheme';

/**
 * Readable legend for category charts. Replaces Chart.js's colour-key legend
 * with label + value + share, so a doughnut/bar can be understood without
 * hovering every slice. Rendered as a definition list for screen readers.
 */
export default function ChartLegend({ items = [], colors = [], format = fmtInt, total }) {
  const sum = total ?? items.reduce((a, b) => a + (Number(b.count) || 0), 0);
  if (!items.length) return null;
  return (
    <dl className="chart-legend">
      {items.map((item, i) => (
        <div className="chart-legend-row" key={item.label ?? i}>
          <dt>
            <i style={{ background: colors[i % colors.length] }} aria-hidden="true" />
            <span>{item.label || '—'}</span>
          </dt>
          <dd>
            <b>{format(item.count)}</b>
            <em>{pct(item.count, sum)}%</em>
          </dd>
        </div>
      ))}
    </dl>
  );
}
