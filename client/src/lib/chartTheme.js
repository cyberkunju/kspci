// Global professional Chart.js theme — applied once, upgrades every chart in the app
// (typography, muted grids, refined tooltips, rounded bars, thin lines/points).
import { Chart, registerables } from 'chart.js';
// Register all controllers/elements/scales/plugins first so their defaults exist.
Chart.register(...registerables);

Chart.defaults.font.family = "'Inter', system-ui, -apple-system, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.font.weight = 500;
Chart.defaults.color = '#a3a3a3'; // Astryx --color-text-secondary (dark)

// Built-in legends are off by default: colour-key legends are hard to read and
// carry no values. Charts render <ChartLegend> (label · value · share) instead,
// and can opt back in with plugins.legend.display = true where a key is needed.
Chart.defaults.plugins.legend.display = false;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
Chart.defaults.plugins.legend.labels.boxWidth = 7;
Chart.defaults.plugins.legend.labels.boxHeight = 7;
Chart.defaults.plugins.legend.labels.padding = 14;

const tt = Chart.defaults.plugins.tooltip;
// Tooltip/surface colours mirror the Astryx neutral dark theme so charts sit
// naturally inside the cards (no competing blue-black).
tt.backgroundColor = 'rgba(47,47,47,0.96)';
tt.borderColor = '#525252';
tt.borderWidth = 1;
tt.padding = 11;
tt.cornerRadius = 10;
tt.titleColor = '#fafafa';
tt.titleFont = { size: 12, weight: 600 };
tt.bodyColor = '#a3a3a3';
tt.bodySpacing = 4;
tt.boxPadding = 6;
tt.usePointStyle = true;

Chart.defaults.elements.bar.borderRadius = 4;
Chart.defaults.elements.bar.borderSkipped = false;
Chart.defaults.elements.point.radius = 0;
Chart.defaults.elements.point.hoverRadius = 4;
Chart.defaults.elements.line.tension = 0.38;
Chart.defaults.elements.line.borderWidth = 2;
Chart.defaults.elements.arc.borderWidth = 2;
Chart.defaults.elements.arc.borderColor = '#1b1b1b'; // card surface

Chart.defaults.scale.grid.color = 'rgba(255,255,255,0.04)';
Chart.defaults.scale.grid.drawTicks = false;
Chart.defaults.scale.border.display = false;
Chart.defaults.scale.ticks.padding = 8;

// Professional, restrained categorical palette — same hues as the app accents
// and the network-graph ring colours, so every visualisation feels like one system.
export const PALETTE = ['#6d93f5', '#45b5d1', '#42c990', '#e0aa4e', '#a78bfa', '#f472b6', '#ec6d5f', '#38bdf8'];
export const ACCENT = '#6d93f5';
export const ACCENT_2 = '#45b5d1';
export const GRID = 'rgba(255,255,255,0.06)';
export const TICK = '#a3a3a3';
export const SURFACE = '#1b1b1b';
export const TEXT = '#fafafa';

/* ---------------------------------------------------------------------------
   Formatting + small plugins that make the charts readable at a glance.
   Values are printed on the chart itself, so users don't have to hover or
   eyeball an axis to read a number.
   --------------------------------------------------------------------------- */

export const fmtInt = (n) => Number(n || 0).toLocaleString('en-IN');
export const fmtCompact = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return (v / 1e7).toFixed(1).replace(/\.0$/, '') + ' Cr';
  if (Math.abs(v) >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, '') + ' L';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(v);
};
export const fmtRupees = (n) => '₹' + fmtCompact(n);
export const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);

/** Vertical gradient fill for area/line charts — subtle, themed, no hard block. */
export function areaFill(ctx, color, opacity = 0.28) {
  const { chartArea, ctx: c } = ctx.chart;
  if (!chartArea) return 'transparent';
  const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, color + Math.round(opacity * 255).toString(16).padStart(2, '0'));
  g.addColorStop(1, color + '00');
  return g;
}

/** Prints the value at the end of each bar so the axis becomes optional. */
export const barValueLabels = {
  id: 'barValueLabels',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart;
    const format = (opts && opts.format) || fmtCompact;
    ctx.save();
    ctx.font = '600 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = opts?.color || '#fafafa';
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.type !== 'bar' || meta.hidden) return;
      meta.data.forEach((el, i) => {
        const v = ds.data[i];
        if (v == null || v === 0) return;
        const horizontal = chart.options.indexAxis === 'y';
        const label = format(v);
        if (horizontal) {
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(label, el.x + 8, el.y);
        } else {
          ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
          ctx.fillText(label, el.x, el.y - 6);
        }
      });
    });
    ctx.restore();
  },
};

/** Big total (and caption) in the middle of a doughnut — instant context. */
export const doughnutCenter = {
  id: 'doughnutCenter',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || opts.enabled === false) return;
    const meta = chart.getDatasetMeta(0);
    const arc = meta?.data?.[0];
    if (!arc) return;
    const total = chart.data.datasets[0].data.reduce((a, b) => a + (Number(b) || 0), 0);
    const { x, y } = arc.getCenterPoint ? arc.getCenterPoint() : { x: 0, y: 0 };
    // Centre of the ring, not of the first slice.
    const cx = (chart.chartArea.left + chart.chartArea.right) / 2;
    const cy = (chart.chartArea.top + chart.chartArea.bottom) / 2;
    const { ctx } = chart;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = TEXT;
    ctx.font = '700 20px Inter, system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText((opts.format || fmtCompact)(total), cx || x, (cy || y) + 2);
    if (opts.label) {
      ctx.fillStyle = TICK;
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      ctx.fillText(opts.label, cx || x, (cy || y) + 18);
    }
    ctx.restore();
  },
};

Chart.register(barValueLabels, doughnutCenter);
// Off unless a chart opts in, so registering globally stays harmless.
Chart.defaults.plugins.barValueLabels = false;
Chart.defaults.plugins.doughnutCenter = { enabled: false };
