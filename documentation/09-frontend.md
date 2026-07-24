# 09 · Frontend

Path: `client/`. React 19 + Vite 5 SPA, built entirely on Meta's **Astryx** design system.

## Stack

| Concern | Choice |
|---|---|
| Framework | React 19 (`createRoot`) |
| Build | Vite 5 (`base: './'`, output `dist/`), dev proxy `/server → localhost:3000` |
| Design system | **Astryx** — `@astryxdesign/core@0.1.8` + `@astryxdesign/theme-neutral` (StyleX runtime `@stylexjs/stylex`) |
| Icons | `lucide-react` (no emoji anywhere in the UI) |
| Charts | Chart.js 4 (global professional theme) |
| Maps | Leaflet 1.9 (CARTO dark‑matter basemap) |
| Graphs | d3‑force 3 (custom SVG renderer) |

## Astryx design system

Astryx is Meta's open‑source React design system. It ships **pre‑compiled CSS**, so no Vite/Babel
StyleX plugin is needed — just import the CSS and use the components. Requires **React 19**.

- **CSS imports** (`main.jsx`, in order): `@astryxdesign/core/reset.css`,
  `@astryxdesign/core/astryx.css`, `@astryxdesign/theme-neutral/theme.css`, then `./index.css`.
- **Theme**: fixed dark on `<html data-astryx-theme="neutral" data-theme="dark">` (`index.html`).
- **Central kit** (`src/ui.jsx`): single import surface re‑exporting the Astryx components used
  (AppShell, SideNav*, TopNav*, Stack/HStack/VStack/Grid/Section/Divider, Card/ClickableCard,
  Heading/Text, Button/IconButton/ToggleButton, SegmentedControl*, TextInput, Selector, TabList/Tab,
  Table, Badge, StatusDot, MetadataList*, Item, ProgressBar, EmptyState, Banner, Spinner, Tooltip,
  Icon, Chat* ) plus the lucide icon set and two Table width helpers (`proportional`, `pixel`).

## Component map

| File | Role |
|---|---|
| `App.jsx` | App shell: Astryx `AppShell` + `SideNav` (brand, New investigation, nav sections, conversations, role `Selector`) + `TopNav` (page title, `SegmentedControl` EN/ಕನ್ನಡ, PDF export, role badge). Chat view via `ChatLayout`/`ChatMessageList`/`ChatMessage`/`ChatMessageBubble`, welcome `ClickableCard` grid, evidence rail. Owns chat/session state. |
| `components/Composer.jsx` | Astryx `ChatComposer` with the Sarvam voice button in `sendActions`. |
| `components/EvidencePanel.jsx` | Explainable‑AI rail: `StatusDot`, ZCQL code block, cited‑evidence list, results `Table`. Static column ≥1200px; slide‑over drawer below (backdrop + close). |
| `components/Analytics.jsx` | 6‑tab analytics (`TabList`): Overview, Criminal Networks, Hotspot Map, Sociological Insights, Money Trail, Offenders & Finance. KPI `Card`s, Astryx `Table`s, ring `Selector`. |
| `components/EarlyWarning.jsx` | Predictive dashboard: Leaflet forecast map, KPI scorecard, backtest line chart, model‑comparison table, alert cards, watchlist table, AI brief. Real‑data validation `Banner`. |
| `components/CaseSupport.jsx` | Investigator dossier: `TextInput` search, `MetadataList`, timeline, outcome KPIs, similar‑cases `Table`, AI brief. |
| `components/Sociology.jsx` | Demographic charts (`VizCard` grid + Chart.js). |
| `components/MoneyTrail.jsx` | Money‑flow `NetworkGraph` + suspicious‑hubs `Table`. |
| `components/Ingest.jsx` | OCR FIR upload → extracted fields + raw OCR text; "Ask the AI about this FIR". |
| `components/NetworkGraph.jsx` | d3‑force SVG graph (ring‑coloured, degree‑sized, hover highlight). |
| `components/HotspotMap.jsx` | Leaflet district volume circles + incident scatter. |
| `components/TrendCharts.jsx` | Chart.js line/bar/doughnut trend charts. |
| `components/Cards.jsx` | Shared `Kpi` and `VizCard` (Astryx `Card`) used across views (avoids circular imports). |
| `lib/voice.js` | MediaRecorder capture + Sarvam STT/TTS playback. |
| `lib/pdf.js` | Conversation → branded printable HTML → browser print‑to‑PDF. |
| `lib/chartTheme.js` | Global Chart.js defaults (typography, muted grids, rounded bars, restrained palette). |
| `api.js` | Fetch client for `/server/api` (sends role/user headers). |

## API client (`api.js`)

Thin wrapper over `fetch` against `/server/api`, injecting `x-user-role` / `x-user-id`. Methods:
`health, warmup, chat, history, stt, tts, overview, hotspots, trends, network, offenders, financial,
sociology, moneytrail, investigatorCase, forecast, earlywarning, backtest, watchlist, brief,
ingestOcr`. Exports `ROLES`.

## Charts (`lib/chartTheme.js`)

A single global theme upgrades every Chart.js chart: Inter typography, muted grid lines,
point‑style legends, refined tooltips, rounded bars, thin lines. **Must `Chart.register(...registerables)`
before setting defaults** (otherwise Chart.js throws on `defaults.plugins.legend.labels`). Exports a
restrained categorical `PALETTE`, `ACCENT`, `GRID`, `TICK`.

## Responsive design & scaling

The UI is tuned from phones to large monitors (see the two responsive passes in the build history):

- **Mobile (<1200px)**: Astryx `AppShell` renders a hamburger + slide‑in nav **drawer** containing the
  full SideNav (nav, New investigation, role selector). The chat is full‑width; the **evidence panel
  becomes a slide‑over drawer** with a dimming backdrop and close button (`EvidencePanel` +
  `index.css` media queries at ≤1200px). Analytics grids reflow (Astryx `Grid columns={{minWidth,max}}`);
  tabs scroll horizontally; maps/graphs use `clamp()` heights.
- **Desktop (≥1200px)**: three columns — SideNav + chat + static evidence rail.
- **Display scaling — the key fix**: Astryx is **rem‑based**, so `index.css` lifts the **root
  font‑size** by CSS‑viewport width so the whole UI scales up on larger/scaled displays (this matters
  because Windows display scaling, e.g. 125%, shrinks the CSS viewport):
  - `≥1200px → 17.5px`, `≥1500 → 18px`, `≥1800 → 19px`, `≥2200 → 20.5px`; `<1200` stays the 16px base.
  - The chat column max‑width is widened to ~1080px (≥1200px) so desktops fill nicely; the evidence
    rail widens on large screens (416px ≥1500, 480px ≥2100).
  - Thresholds are keyed to the **CSS** viewport (post‑OS‑scaling), starting at 1200px where the
    desktop 3‑column layout activates — so scaling actually fires on scaled laptops.

## CSS strategy (`index.css`)

Astryx components own their own styling (StyleX + theme tokens). `index.css` is intentionally lean —
only **layout glue** Astryx doesn't cover: the chat/evidence‑rail geometry, the responsive scaling
media queries, Chart.js/Leaflet/D3 canvas sizing, the case timeline, mono code blocks (ZCQL/OCR), the
brand mark, and the ingest drop zone. A small palette of CSS variables backs the canvas/SVG visuals.

## Build & assets

`npm run build` → `vite build` (→ `dist/`) → `scripts/copy-config.cjs` copies `client-package.json`
and `404.html` into `dist`. Bundle ≈ 950 KB (Astryx is a large system) — acceptable for the demo;
could be code‑split later.

Continue to [10-security-and-governance.md](./10-security-and-governance.md).
