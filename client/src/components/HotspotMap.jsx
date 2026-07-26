import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// All-India crime hotspot map — state or district circles sized/coloured by case volume,
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

    // district (or state) volume circles
    const bounds = [];
    (data.districts || []).forEach((d) => {
      if (d.lat == null || d.lng == null) return;
      bounds.push([d.lat, d.lng]);
      // Square-root scaling: with linear radius the largest unit covered several states at
      // national zoom, hiding everything under it.
      const r = 5 + Math.sqrt(d.count / max) * 24;
      const c = L.circleMarker([d.lat, d.lng], {
        radius: r, color: heat(d.count), weight: 2, fillColor: heat(d.count), fillOpacity: 0.35
      }).addTo(group);
      c.bindPopup(`<b>${d.district || d.name}</b><br>${d.count.toLocaleString('en-IN')} cases`);
      c.bindTooltip(`${d.name}: ${d.count.toLocaleString('en-IN')}`, { direction: 'top' });
    });

    // Fit to the data. The view was pinned to Karnataka at zoom 7, so on national coverage most
    // of the country — including Bengaluru's own neighbours — sat outside the viewport and the
    // map looked like it was missing data.
    if (bounds.length) map.fitBounds(bounds, { padding: [26, 26], maxZoom: 9 });
  }, [data]);

  return <div className="hotspot-map" ref={elRef} />;
}
