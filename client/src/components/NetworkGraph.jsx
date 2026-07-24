import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY,
} from 'd3-force';
import { ZoomIn, ZoomOut, Scan, Search, X } from 'lucide-react';

// Ring palette (crime rings) — index 0 = "no ring" grey.
const RING_COLORS = ['#8a94a6', '#6d93f5', '#22d3ee', '#42c990', '#e0aa4e', '#f472b6', '#a78bfa', '#f87171', '#38bdf8', '#facc15'];
const ringColor = (r) => RING_COLORS[(r || 0) % RING_COLORS.length];
// Money view: ring 1 = accused (blue), ring 2 = counterparty (amber).
const moneyColor = (r) => (r === 2 ? '#e0aa4e' : '#6d93f5');

const BG = '#12151b';
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Interactive force-directed graph on <canvas>.
 * - Pan (drag), zoom (wheel / buttons), zoom-to-fit.
 * - Hover highlights a node + its neighbourhood; click pins a detail card.
 * - Hubs are labelled by default; search focuses a specific person.
 * Canvas keeps it smooth at a few hundred nodes (no per-tick React re-render).
 */
export default function NetworkGraph({ data, kind = 'crime', height = 520, onSelect }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const stateRef = useRef({
    nodes: [], links: [], adj: new Map(),
    t: { k: 1, x: 0, y: 0 }, size: { w: 800, h: height },
    hover: null, selected: null, dragging: false, panned: false, last: null,
  });
  const [selected, setSelected] = useState(null);
  const [hoverNode, setHoverNode] = useState(null);
  const [tip, setTip] = useState(null); // { x, y, node }
  const [query, setQuery] = useState('');
  const colorOf = kind === 'money' ? moneyColor : ringColor;

  const maxDegree = useMemo(
    () => Math.max(1, ...((data?.nodes) || []).map((n) => n.degree || 1)), [data]);

  const nodeRadius = (n) => 4 + Math.sqrt((n.degree || 1) / maxDegree) * 16;

  // ---- build simulation + draw loop ----
  useEffect(() => {
    const canvas = canvasRef.current, wrap = wrapRef.current;
    if (!canvas || !wrap || !data?.nodes?.length) return;
    const st = stateRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const nodes = data.nodes.slice(0, 260).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = (data.links || [])
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ ...l }));
    const adj = new Map(nodes.map((n) => [n.id, new Set()]));
    links.forEach((l) => { adj.get(l.source)?.add(l.target); adj.get(l.target)?.add(l.source); });
    st.nodes = nodes; st.links = links; st.adj = adj;
    st.hover = null; st.selected = null;

    const resize = () => {
      const w = wrap.clientWidth || 800, h = height;
      st.size = { w, h };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    };
    resize();

    const ctx = canvas.getContext('2d');
    const { w, h } = st.size;

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance((l) => 42 - Math.min(l.weight || 1, 4) * 4).strength(0.65))
      .force('charge', forceManyBody().strength(-140).distanceMax(360))
      .force('center', forceCenter(w / 2, h / 2))
      .force('x', forceX(w / 2).strength(0.04))
      .force('y', forceY(h / 2).strength(0.04))
      .force('collide', forceCollide().radius((d) => nodeRadius(d) + 2))
      .alpha(1).alphaDecay(0.045);

    let fitted = false;
    const draw = () => {
      const { k, x, y } = st.t;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, st.size.w, st.size.h);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, st.size.w, st.size.h);
      ctx.translate(x, y); ctx.scale(k, k);

      const focus = st.selected || st.hover;
      const active = focus ? new Set([focus, ...(st.adj.get(focus) || [])]) : null;

      // edges
      for (const l of st.links) {
        const s = l.source, t = l.target;
        if (!s.x || !t.x) continue;
        const lit = !active || (active.has(s.id) && active.has(t.id) && (s.id === focus || t.id === focus));
        ctx.strokeStyle = lit ? 'rgba(150,170,210,0.45)' : 'rgba(120,130,150,0.06)';
        ctx.lineWidth = (lit ? 1.4 : 0.6) / k;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y); ctx.stroke();
      }
      // nodes
      for (const n of st.nodes) {
        const r = nodeRadius(n);
        const dim = active && !active.has(n.id);
        ctx.globalAlpha = dim ? 0.18 : 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.fillStyle = colorOf(n.ring);
        ctx.fill();
        if (n.id === st.selected || n.id === st.hover) {
          ctx.lineWidth = 2 / k; ctx.strokeStyle = '#ffffff'; ctx.stroke();
        } else {
          ctx.lineWidth = 1 / k; ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // labels: hubs always, plus focus + its neighbours
      const labelSet = new Set(st.hubs);
      if (focus) { labelSet.add(focus); (st.adj.get(focus) || []).forEach((id) => labelSet.add(id)); }
      ctx.font = `600 ${11 / k}px Inter, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      for (const n of st.nodes) {
        if (!labelSet.has(n.id)) continue;
        if (active && !active.has(n.id)) continue;
        const r = nodeRadius(n);
        const label = String(n.id).length > 22 ? String(n.id).slice(0, 21) + '…' : String(n.id);
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(8,11,16,0.72)';
        ctx.fillRect(n.x - tw / 2 - 3 / k, n.y - r - 15 / k, tw + 6 / k, 13 / k);
        ctx.fillStyle = '#eef1f5';
        ctx.fillText(label, n.x, n.y - r - 4 / k);
      }
    };
    st.draw = draw;

    // hubs = top-degree nodes to always label
    st.hubs = new Set(nodes.slice().sort((a, b) => (b.degree || 0) - (a.degree || 0)).slice(0, 8).map((n) => n.id));

    const fit = () => {
      const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const gw = Math.max(1, maxX - minX), gh = Math.max(1, maxY - minY);
      const pad = 48;
      const k = clamp(Math.min((st.size.w - pad) / gw, (st.size.h - pad) / gh), 0.2, 2.2);
      st.t = { k, x: st.size.w / 2 - ((minX + maxX) / 2) * k, y: st.size.h / 2 - ((minY + maxY) / 2) * k };
    };
    st.fit = () => { fit(); draw(); };

    sim.on('tick', () => {
      if (!fitted && sim.alpha() < 0.5) { fit(); fitted = true; }
      draw();
    });
    sim.on('end', () => { if (!fitted) { fit(); fitted = true; } draw(); });

    const ro = new ResizeObserver(() => { resize(); draw(); });
    ro.observe(wrap);
    stateRef.current.sim = sim;

    return () => { ro.disconnect(); sim.stop(); };
  }, [data, height, maxDegree, colorOf]);

  // ---- pointer interaction ----
  const nodeAt = (cx, cy) => {
    const st = stateRef.current, { k, x, y } = st.t;
    const wx = (cx - x) / k, wy = (cy - y) / k;
    let best = null, bestD = Infinity;
    for (const n of st.nodes) {
      const r = nodeRadius(n) + 4;
      const d = (n.x - wx) ** 2 + (n.y - wy) ** 2;
      if (d < r * r && d < bestD) { best = n; bestD = d; }
    }
    return best;
  };
  const rel = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };
  const onMove = (e) => {
    const st = stateRef.current;
    const [cx, cy] = rel(e);
    if (st.dragging) {
      st.panned = true;
      st.t.x += cx - st.last[0]; st.t.y += cy - st.last[1]; st.last = [cx, cy];
      st.draw && st.draw();
      return;
    }
    const n = nodeAt(cx, cy);
    if ((n && n.id) !== st.hover) { st.hover = n ? n.id : null; setHoverNode(n ? n.id : null); st.draw && st.draw(); }
    setTip(n ? { x: cx, y: cy, node: n } : null);
    canvasRef.current.style.cursor = n ? 'pointer' : (st.dragging ? 'grabbing' : 'grab');
  };
  const onDown = (e) => { const st = stateRef.current; st.dragging = true; st.panned = false; st.last = rel(e); };
  const onUp = (e) => {
    const st = stateRef.current;
    const wasPan = st.panned; st.dragging = false;
    if (!wasPan) {
      const [cx, cy] = rel(e);
      const n = nodeAt(cx, cy);
      st.selected = n ? n.id : null;
      setSelected(n || null);
      onSelect && onSelect(n || null);
      st.draw && st.draw();
    }
  };
  const onLeave = () => { const st = stateRef.current; st.hover = null; st.dragging = false; setHoverNode(null); setTip(null); st.draw && st.draw(); };
  const onWheel = (e) => {
    e.preventDefault();
    const st = stateRef.current, [cx, cy] = rel(e);
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const nk = clamp(st.t.k * factor, 0.15, 4);
    st.t.x = cx - (cx - st.t.x) * (nk / st.t.k);
    st.t.y = cy - (cy - st.t.y) * (nk / st.t.k);
    st.t.k = nk;
    st.draw && st.draw();
  };
  const zoomBy = (factor) => {
    const st = stateRef.current, cx = st.size.w / 2, cy = st.size.h / 2;
    const nk = clamp(st.t.k * factor, 0.15, 4);
    st.t.x = cx - (cx - st.t.x) * (nk / st.t.k);
    st.t.y = cy - (cy - st.t.y) * (nk / st.t.k);
    st.t.k = nk; st.draw && st.draw();
  };

  const submitSearch = (e) => {
    e.preventDefault();
    const st = stateRef.current, q = query.trim().toLowerCase();
    if (!q) return;
    const n = st.nodes.find((x) => String(x.id).toLowerCase().includes(q));
    if (!n) return;
    st.selected = n.id; setSelected(n);
    st.t.k = clamp(Math.max(st.t.k, 1.3), 0.15, 4);
    st.t.x = st.size.w / 2 - n.x * st.t.k; st.t.y = st.size.h / 2 - n.y * st.t.k;
    onSelect && onSelect(n); st.draw && st.draw();
  };
  const clearSelection = () => {
    const st = stateRef.current; st.selected = null; setSelected(null); onSelect && onSelect(null); st.draw && st.draw();
  };

  if (!data || !data.nodes?.length) return <div className="viz-empty">No network data to display.</div>;

  const legend = kind === 'money'
    ? [{ c: moneyColor(1), t: 'Accused' }, { c: moneyColor(2), t: 'Counterparty' }]
    : (data.rings || []).slice(0, 6).map((r) => ({ c: ringColor(r.ring), t: `Ring ${r.ring}` }));
  const selNeighbors = selected ? (stateRef.current.adj.get(selected.id)?.size || 0) : 0;

  return (
    <div className="ng-wrap" ref={wrapRef} style={{ height }}>
      <canvas
        ref={canvasRef} className="ng-canvas" role="img"
        aria-label={`Interactive ${kind === 'money' ? 'money-trail' : 'co-accused'} network graph with ${data.nodes.length} nodes. Drag to pan, scroll to zoom, click a node for details.`}
        onMouseMove={onMove} onMouseDown={onDown} onMouseUp={onUp} onMouseLeave={onLeave} onWheel={onWheel}
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
        <div className="ng-zoom">
          <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)}><ZoomIn size={16} /></button>
          <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)}><ZoomOut size={16} /></button>
          <button type="button" aria-label="Fit to view" onClick={() => stateRef.current.fit && stateRef.current.fit()}><Scan size={16} /></button>
        </div>
      </div>

      {legend.length > 0 && (
        <div className="ng-legend">
          {legend.map((l) => (
            <span key={l.t} className="ng-legend-item"><i style={{ background: l.c }} />{l.t}</span>
          ))}
          <span className="ng-legend-note">size = links</span>
        </div>
      )}

      {tip && !selected && (
        <div className="ng-tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>
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
          <p className="ng-detail-hint">Highlighting direct connections. Click empty space or ✕ to reset.</p>
        </div>
      )}
    </div>
  );
}
