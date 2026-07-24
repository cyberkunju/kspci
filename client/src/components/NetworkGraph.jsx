import { useEffect, useMemo, useRef, useState } from 'react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';

const RING_COLORS = ['#3d8bfd', '#22d3ee', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171', '#38bdf8', '#facc15'];
const ringColor = (r) => (r ? RING_COLORS[r % RING_COLORS.length] : '#64748b');

export default function NetworkGraph({ data, width = 720, height = 520, onSelect }) {
  const [, setTick] = useState(0);
  const [hover, setHover] = useState(null);
  const nodesRef = useRef([]);
  const linksRef = useRef([]);
  const simRef = useRef(null);

  const maxDegree = useMemo(
    () => Math.max(1, ...(data?.nodes || []).map((n) => n.degree || 1)), [data]);

  useEffect(() => {
    if (!data || !data.nodes?.length) return;
    // cap for performance/legibility
    const nodes = data.nodes.slice(0, 220).map((n) => ({ ...n }));
    const ids = new Set(nodes.map((n) => n.id));
    const links = (data.links || [])
      .filter((l) => ids.has(l.source) && ids.has(l.target))
      .map((l) => ({ ...l }));
    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance((l) => 60 - Math.min(l.weight, 4) * 6).strength(0.5))
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide().radius((d) => 6 + (d.degree / maxDegree) * 12))
      .alphaDecay(0.035);

    let raf;
    const loop = () => { setTick((t) => t + 1); if (sim.alpha() > 0.02) raf = requestAnimationFrame(loop); };
    sim.on('tick', () => {});
    raf = requestAnimationFrame(loop);
    simRef.current = sim;
    return () => { cancelAnimationFrame(raf); sim.stop(); };
  }, [data, width, height, maxDegree]);

  const nodes = nodesRef.current;
  const links = linksRef.current;
  const radius = (n) => 5 + (n.degree / maxDegree) * 13;

  if (!data || !nodes.length) {
    return <div className="viz-empty">No network data.</div>;
  }

  return (
    <div className="netgraph">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%">
        <g>
          {links.map((l, i) => {
            const s = typeof l.source === 'object' ? l.source : nodes.find((n) => n.id === l.source);
            const t = typeof l.target === 'object' ? l.target : nodes.find((n) => n.id === l.target);
            if (!s || !t) return null;
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y}
              stroke={ringColor(l.ring)} strokeOpacity={0.22} strokeWidth={Math.min(l.weight, 4)} />;
          })}
          {nodes.map((n) => (
            <circle key={n.id} cx={n.x} cy={n.y} r={radius(n)}
              fill={ringColor(n.ring)} stroke="#0b1120" strokeWidth={1.5}
              opacity={hover && hover !== n.id ? 0.35 : 0.95}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
              onClick={() => onSelect && onSelect(n)}>
              <title>{n.id} · ring {n.ring || '—'} · {n.degree} links</title>
            </circle>
          ))}
        </g>
      </svg>
      {hover && <div className="netgraph-hover">{hover}</div>}
    </div>
  );
}
