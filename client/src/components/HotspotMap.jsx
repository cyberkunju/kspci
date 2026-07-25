import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Karnataka crime hotspot map — district circles sized/coloured by case volume,
// plus a sampled incident scatter layer.
export default function HotspotMap({ data }) {
  const elRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { zoomControl: true, attributionControl: false })
      .setView([14.7, 76.2], 7);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      maxZoom: 19, subdomains: 'abcd'
    }).addTo(map);
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 200);
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current, group = layerRef.current;
    if (!map || !group || !data) return;
    group.clearLayers();

    const max = Math.max(1, ...(data.districts || []).map((d) => d.count));
    const heat = (v) => {
      const t = v / max; // 0..1
      const r = Math.round(60 + t * 195), g = Math.round(190 - t * 150), b = Math.round(255 - t * 210);
      return `rgb(${r},${g},${b})`;
    };

    // sampled incident points (subtle)
    (data.points || []).forEach((p) => {
      L.circleMarker([p.lat, p.lng], {
        radius: 2, color: '#45b5d1', weight: 0, fillOpacity: 0.28
      }).addTo(group);
    });

    // district volume circles
    (data.districts || []).forEach((d) => {
      const r = 10 + (d.count / max) * 34;
      const c = L.circleMarker([d.lat, d.lng], {
        radius: r, color: heat(d.count), weight: 2, fillColor: heat(d.count), fillOpacity: 0.35
      }).addTo(group);
      c.bindPopup(`<b>${d.district || d.name}</b><br>${d.count} cases`);
      c.bindTooltip(`${d.name}: ${d.count}`, { direction: 'top' });
    });
  }, [data]);

  return <div className="hotspot-map" ref={elRef} />;
}
