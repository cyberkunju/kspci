import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Scan, Search, X } from 'lucide-react';

// Ring palette (crime rings) — index 0 = "no ring" grey.
const RING_COLORS = ['#8a94a6', '#6d93f5', '#22d3ee', '#42c990', '#e0aa4e', '#f472b6', '#a78bfa', '#f87171', '#38bdf8', '#facc15'];
const ringColor = (r) => RING_COLORS[(r || 0) % RING_COLORS.length];
const moneyColor = (r) => (r === 2 ? '#e0aa4e' : '#6d93f5');
// Canvas surface: a subtle inset below the Astryx card (#1b1b1b) it sits in,
// kept in the theme's warm-neutral family (never blue-black).
const CANVAS_BG = '#171717';
const LABEL_BG = 'rgba(23,23,23,0.86)';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Interactive network graph built on react-force-graph-2d (d3-zoom powered
 * pan/zoom, canvas rendering). Shared by Criminal Networks and Money Trail.
 * - Constrained, smooth pan/zoom with a single "Fit" reset — no gesture overload.
 * - Hover highlights a node's neighbourhood; click pins a detail card and
 *   isolates the ego-network. Search focuses a specific person.
 * - Money view animates directional particles to convey flow.
 */
export default function NetworkGraph({ data, kind = 'crime', height, onSelect }) {
  const wrapRef = useRef(null);
  const fgRef = useRef(null);
  const [width, setWidth] = useState(800);
  // Responsive canvas height: shorter on phones so the graph plus its controls
  // fit the viewport without endless scrolling, taller on desktop for detail.
  const graphHeight = height ?? (width < 560 ? 360 : width < 900 ? 440 : 520);
  const [selected, setSelected] = useState(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [tip, setTip] = useState(null);
  const [query, setQuery] = useState('');
  const colorOf = kind === 'money' ? moneyColor : ringColor;

  // Prepare graph data: attach neighbour + link references for highlighting.
  const graphData = useMemo(() => {
    const nodes = (data?.nodes || []).slice(0, 260).map((n) => ({ ...n, neighbors: [], adj: [] }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links = (data?.links || [])
      .filter((l) => byId.has(l.source) && byId.has(l.target))
      .map((l) => ({ source: l.source, target: l.target, weight: l.weight || 1 }));
    links.forEach((l) => {
      const a = byId.get(l.source), b = byId.get(l.target);
      a.neighbors.push(b); b.neighbors.push(a); a.adj.push(l); b.adj.push(l);
    });
    return { nodes, links };
  }, [data]);

  const maxDegree = useMemo(
    () => Math.max(1, ...graphData.nodes.map((n) => n.degree || 1)), [graphData]);
  const radiusOf = useCallback((n) => 3 + Math.sqrt((n.degree || 1) / maxDegree) * 13, [maxDegree]);
  const hubs = useMemo(
    () => new Set(graphData.nodes.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 8).map((n) => n.id)),
    [graphData]);

  const focus = selected || hoverNode;
  const { hlNodes, hlLinks } = useMemo(() => {
    const hn = new Set(), hl = new Set();
    if (focus) {
      hn.add(focus.id);
      (focus.neighbors || []).forEach((n) => hn.add(n.id));
      (focus.adj || []).forEach((l) => hl.add(l));
    }
    return { hlNodes: hn, hlLinks: hl };
  }, [focus]);

  // Measure the PARENT, not our own wrapper: the canvas sets an explicit width
  // on the wrapper, so observing the wrapper would feed its own size back in and
  // latch at the initial default (leaving the graph clipped on small screens).
  useEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host) return;
    const apply = () => setWidth(Math.max(280, Math.floor(host.clientWidth)));
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => fgRef.current && fgRef.current.zoomToFit(500, 48), []);

  const paintNode = useCallback((node, ctx, scale) => {
    const r = radiusOf(node);
    const dim = hlNodes.size && !hlNodes.has(node.id);
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
    ctx.fillStyle = colorOf(node.ring);
    ctx.fill();
    const isFocus = focus && node.id === focus.id;
    ctx.lineWidth = (isFocus ? 2.5 : 1) / scale;
    ctx.strokeStyle = isFocus ? '#ffffff' : 'rgba(0,0,0,0.55)';
    ctx.stroke();

    const showLabel = !dim && (hubs.has(node.id) || hlNodes.has(node.id));
    if (showLabel) {
      const raw = String(node.id);
      const label = raw.length > 24 ? raw.slice(0, 23) + '…' : raw;
      const fs = clamp(12 / scale, 2, 13);
      ctx.font = `600 ${fs}px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = LABEL_BG;
      ctx.fillRect(node.x - tw / 2 - 3 / scale, node.y - r - 4 / scale - fs, tw + 6 / scale, fs + 3 / scale);
      ctx.fillStyle = '#eef1f5';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(label, node.x, node.y - r - 3 / scale);
    }
    ctx.globalAlpha = 1;
  }, [radiusOf, colorOf, hlNodes, hubs, focus]);

  const paintPointer = useCallback((node, color, ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radiusOf(node) + 2, 0, 2 * Math.PI);
    ctx.fill();
  }, [radiusOf]);

  const handleHover = useCallback((node) => {
    setHoverNode(node || null);
    if (node && fgRef.current) {
      const c = fgRef.current.graph2ScreenCoords(node.x, node.y);
      setTip({ x: c.x, y: c.y, node });
    } else setTip(null);
    if (wrapRef.current) wrapRef.current.style.cursor = node ? 'pointer' : 'grab';
  }, []);

  const handleClick = useCallback((node) => {
    setSelected(node || null);
    onSelect && onSelect(node || null);
    if (node && fgRef.current) {
      fgRef.current.centerAt(node.x, node.y, 600);
      fgRef.current.zoom(clamp(fgRef.current.zoom() * 1.1, 1.2, 5), 600);
    }
  }, [onSelect]);

  const clearSelection = useCallback(() => { setSelected(null); onSelect && onSelect(null); }, [onSelect]);

  const submitSearch = (e) => {
    e.preventDefault();
    const q = query.trim().toLowerCase();
    if (!q) return;
    const n = graphData.nodes.find((x) => String(x.id).toLowerCase().includes(q));
    if (!n || !fgRef.current) return;
    setSelected(n); onSelect && onSelect(n);
    fgRef.current.centerAt(n.x, n.y, 600);
    fgRef.current.zoom(2, 600);
  };

  if (!data || !data.nodes?.length) return <div className="viz-empty">No network data to display.</div>;

  // Keep the legend to a single row: fewer ring swatches on narrow screens so it
  // never stacks over the graph itself.
  const maxLegend = width < 560 ? 3 : 6;
  const legend = kind === 'money'
    ? [{ c: moneyColor(1), t: 'Accused' }, { c: moneyColor(2), t: 'Counterparty' }]
    : (data.rings || []).slice(0, maxLegend).map((r) => ({ c: ringColor(r.ring), t: `Ring ${r.ring}` }));
  const selNeighbors = selected ? (selected.neighbors?.length || 0) : 0;

  return (
    <div className="ng-wrap" ref={wrapRef} style={{ height: graphHeight }}>
      <ForceGraph2D
        ref={fgRef}
        width={width}
        height={graphHeight}
        graphData={graphData}
        backgroundColor={CANVAS_BG}
        nodeRelSize={5}
        nodeVal={(n) => (n.degree || 1)}
        autoPauseRedraw={false}
        nodeCanvasObject={paintNode}
        nodePointerAreaPaint={paintPointer}
        linkColor={(l) => (hlLinks.has(l) ? 'rgba(170,190,230,0.7)' : (hlNodes.size ? 'rgba(120,130,150,0.05)' : 'rgba(140,155,185,0.20)'))}
        linkWidth={(l) => (hlLinks.has(l) ? 2 : 0.7)}
        linkDirectionalParticles={kind === 'money' ? 2 : 0}
        linkDirectionalParticleWidth={(l) => (hlLinks.has(l) ? 2.6 : 1.6)}
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalArrowLength={kind === 'money' ? 3 : 0}
        linkDirectionalArrowRelPos={1}
        enableNodeDrag={false}
        minZoom={0.4}
        maxZoom={6}
        cooldownTicks={120}
        onEngineStop={fit}
        onNodeHover={handleHover}
        onNodeClick={handleClick}
        onBackgroundClick={clearSelection}
      />

      <div className="ng-toolbar">
        <form className="ng-search" onSubmit={submitSearch}>
          <Search size={14} />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={kind === 'money' ? 'Find account / person…' : 'Find a person…'}
            aria-label="Search the network"
          />
        </form>
        <button type="button" className="ng-fit" onClick={fit} aria-label="Fit graph to view" title="Fit to view">
          <Scan size={15} /><span>Fit</span>
        </button>
      </div>

      {legend.length > 0 && (
        <div className="ng-legend">
          {legend.map((l) => (
            <span key={l.t} className="ng-legend-item"><i style={{ background: l.c }} />{l.t}</span>
          ))}
          <span className="ng-legend-note">{kind === 'money' ? 'arrows = flow · size = links' : 'size = links'}</span>
        </div>
      )}

      {tip && !selected && (
        <div className="ng-tooltip" style={{ left: clamp(tip.x + 12, 8, width - 200), top: tip.y + 12 }}>
          <strong>{tip.node.id}</strong>
          <span>{tip.node.degree || 0} links{tip.node.ring ? ` · ring ${tip.node.ring}` : ''}</span>
        </div>
      )}

      {selected && (
        <div className="ng-detail" role="dialog" aria-label="Selected node details">
          <button type="button" className="ng-detail-close" aria-label="Clear selection" onClick={clearSelection}><X size={14} /></button>
          <span className="ng-detail-dot" style={{ background: colorOf(selected.ring) }} />
          <strong>{selected.id}</strong>
          <dl>
            <div><dt>Connections</dt><dd>{selNeighbors}</dd></div>
            <div><dt>Total links</dt><dd>{selected.degree || 0}</dd></div>
            {kind === 'money'
              ? <div><dt>Role</dt><dd>{selected.ring === 2 ? 'Counterparty' : 'Accused'}</dd></div>
              : <div><dt>Ring</dt><dd>{selected.ring || '—'}</dd></div>}
          </dl>
          <p className="ng-detail-hint">Direct connections highlighted. Click empty space to reset.</p>
        </div>
      )}
    </div>
  );
}
