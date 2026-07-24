// Global professional Chart.js theme — applied once, upgrades every chart in the app
// (typography, muted grids, refined tooltips, rounded bars, thin lines/points).
import { Chart, registerables } from 'chart.js';
// Register all controllers/elements/scales/plugins first so their defaults exist.
Chart.register(...registerables);

Chart.defaults.font.family = "'Inter', system-ui, -apple-system, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.font.weight = 500;
Chart.defaults.color = '#8b95a5';

Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.pointStyle = 'circle';
Chart.defaults.plugins.legend.labels.boxWidth = 7;
Chart.defaults.plugins.legend.labels.boxHeight = 7;
Chart.defaults.plugins.legend.labels.padding = 14;

const tt = Chart.defaults.plugins.tooltip;
tt.backgroundColor = 'rgba(16,19,24,0.96)';
tt.borderColor = '#30363f';
tt.borderWidth = 1;
tt.padding = 11;
tt.cornerRadius = 9;
tt.titleColor = '#e9ecf1';
tt.titleFont = { size: 12, weight: 600 };
tt.bodyColor = '#9aa3b2';
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
Chart.defaults.elements.arc.borderColor = '#101318';

Chart.defaults.scale.grid.color = 'rgba(255,255,255,0.04)';
Chart.defaults.scale.grid.drawTicks = false;
Chart.defaults.scale.border.display = false;
Chart.defaults.scale.ticks.padding = 8;

// Professional, restrained categorical palette
export const PALETTE = ['#5b8cff', '#29b6d8', '#34c98a', '#d9a441', '#c084fc', '#f472b6', '#e5644e', '#7c9cff'];
export const ACCENT = '#5b8cff';
export const ACCENT_2 = '#29b6d8';
export const GRID = 'rgba(255,255,255,0.045)';
export const TICK = '#8b95a5';
