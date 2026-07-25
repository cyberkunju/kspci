// Global professional Chart.js theme — applied once, upgrades every chart in the app
// (typography, muted grids, refined tooltips, rounded bars, thin lines/points).
import { Chart, registerables } from 'chart.js';
// Register all controllers/elements/scales/plugins first so their defaults exist.
Chart.register(...registerables);

Chart.defaults.font.family = "'Inter', system-ui, -apple-system, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.font.weight = 500;
Chart.defaults.color = '#a3a3a3'; // Astryx --color-text-secondary (dark)

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
