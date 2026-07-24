import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './lib/chartTheme'; // global professional Chart.js defaults

// Astryx design system (Meta) — reset, component styles, theme tokens.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
// App styles + KSP professional theme overrides (loaded last to win where needed).
import './index.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
