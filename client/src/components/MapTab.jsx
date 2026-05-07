import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: new URL('leaflet/dist/images/marker-icon-2x.png', import.meta.url).href,
  iconUrl:       new URL('leaflet/dist/images/marker-icon.png',    import.meta.url).href,
  shadowUrl:     new URL('leaflet/dist/images/marker-shadow.png',  import.meta.url).href,
});

const DARK_TILE  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const DARK_ATTR  = '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';
const FONT       = "'Share Tech Mono',monospace";

const ETYPE_COLOR = { MEDICAL:'#FF0000', FIRE:'#FF6600', FLOOD:'#0088FF', TRAPPED:'#FFCC00' };

function localIcon() {
  return L.divIcon({
    className: '',
    iconSize: [40,40], iconAnchor: [20,20], popupAnchor: [0,-20],
    html: `<div style="position:relative;width:40px;height:40px;">
      <div style="position:absolute;inset:0;border-radius:50%;background:rgba(0,180,255,0.15);animation:localPing 2s ease-out infinite;"></div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:14px;height:14px;border-radius:50%;background:#00BFFF;border:2px solid #fff;box-shadow:0 0 12px #00BFFF,0 0 24px rgba(0,191,255,0.5);"></div>
    </div>`,
  });
}

function peerIcon(name, battery) {
  const col = battery <= 20 ? '#FFCC00' : '#00FF88';
  return L.divIcon({
    className: '',
    iconSize: [36,48], iconAnchor: [18,46], popupAnchor: [0,-46],
    html: `<div style="position:relative;width:36px;height:48px;">
      <svg viewBox="0 0 36 48" width="36" height="48">
        <path d="M18 2C10.27 2 4 8.27 4 16c0 11 14 30 14 30s14-19 14-30C32 8.27 25.73 2 18 2z"
          fill="#0D1F0D" stroke="${col}" stroke-width="2" style="filter:drop-shadow(0 0 6px ${col}66)"/>
        <circle cx="18" cy="16" r="6" fill="${col}" style="filter:drop-shadow(0 0 4px ${col})"/>
      </svg>
      <div style="position:absolute;top:50px;left:50%;transform:translateX(-50%);font-family:${FONT};font-size:9px;color:${col};letter-spacing:0.1em;white-space:nowrap;text-shadow:0 0 6px ${col};">${name.toUpperCase().slice(0,8)}</div>
    </div>`,
  });
}

function sosIcon(type) {
  const col = ETYPE_COLOR[type] ?? '#FF0000';
  return L.divIcon({
    className: '',
    iconSize: [48,48], iconAnchor: [24,24], popupAnchor: [0,-20],
    html: `<div style="position:relative;width:48px;height:48px;">
      <div style="position:absolute;inset:0;border-radius:50%;background:${col}22;animation:sosPing 1s ease-out infinite;"></div>
      <div style="position:absolute;inset:8px;border-radius:50%;background:${col}33;animation:sosPing 1s ease-out infinite 0.3s;"></div>
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:50%;background:${col};border:2px solid #fff;box-shadow:0 0 16px ${col};display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;font-family:${FONT};">!</div>
    </div>`,
  });
}

function getTileXY(lat, lng, z) {
  const n = 2**z;
  const x = Math.floor((lng + 180) / 360 * n);
  const r = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * n);
  return { x: Math.max(0,x), y: Math.max(0,y) };
}

export default function MapTab({ peers, sosAlerts, localNodeId, onLocationUpdate, visible }) {
  const mapDivRef   = useRef(null);
  const mapRef      = useRef(null);
  const localMkRef  = useRef(null);
  const peerMksRef  = useRef(new Map());
  const sosMksRef   = useRef(new Map());
  const [coords,    setCoords]    = useState(null);
  const [offline,   setOffline]   = useState(!navigator.onLine);
  const [caching,   setCaching]   = useState(false);
  const [cached,    setCached]    = useState(0);
  const [swReady,   setSwReady]   = useState(false);
  const [nodePanel, setNodePanel] = useState(false);

  // Inject map keyframes once
  useEffect(() => {
    if (document.getElementById('map-kf')) return;
    const s = document.createElement('style');
    s.id = 'map-kf';
    s.textContent = `
      @keyframes localPing{0%{transform:scale(0.8);opacity:0.9}70%{transform:scale(2.4);opacity:0}100%{transform:scale(0.8);opacity:0}}
      @keyframes sosPing{0%{transform:scale(0.8);opacity:0.9}70%{transform:scale(2.4);opacity:0}100%{transform:scale(0.8);opacity:0}}
      .leaflet-tile-pane{filter:brightness(1.05) contrast(1.05);}
      .leaflet-control-zoom a{background:#0D1F0D!important;color:#00FF88!important;border-color:#00FF8833!important;font-family:'Share Tech Mono',monospace!important;font-size:18px!important;}
      .leaflet-control-zoom a:hover{background:#001a0d!important;box-shadow:0 0 8px #00FF8822!important;}
      .leaflet-control-attribution{display:none!important;}
      .leaflet-popup-content-wrapper{background:#0D1F0D!important;border:1px solid #00FF8844!important;border-radius:0!important;color:#fff!important;font-family:'Share Tech Mono',monospace!important;font-size:11px!important;box-shadow:0 0 20px rgba(0,255,136,0.1)!important;}
      .leaflet-popup-tip{background:#0D1F0D!important;}
      .leaflet-popup-close-button{color:#00FF8866!important;}
    `;
    document.head.appendChild(s);
  }, []);

  // SW registration
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(() => {
        setSwReady(true);
        navigator.serviceWorker.addEventListener('message', ev => {
          if (ev.data?.type === 'TILE_CACHE_COUNT') setCached(ev.data.count);
        });
        navigator.serviceWorker.controller?.postMessage({ type: 'GET_TILE_COUNT' });
      }).catch(() => {});
    window.addEventListener('online',  () => setOffline(false));
    window.addEventListener('offline', () => setOffline(true));
  }, []);

  // Init map
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const map = L.map(mapDivRef.current, {
      center: [20, 78], zoom: 5,
      zoomControl: false, attributionControl: false,
    });
    L.tileLayer(DARK_TILE, { maxZoom: 19, attribution: DARK_ATTR }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Invalidate when tab becomes visible
  useEffect(() => {
    if (visible) setTimeout(() => mapRef.current?.invalidateSize(), 200);
  }, [visible]);

  // GPS
  useEffect(() => {
    if (!navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(pos => {
      const c = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
      setCoords(c);
      onLocationUpdate?.(c);
      const map = mapRef.current;
      if (!map) return;
      const ll = [c.lat, c.lng];
      if (!localMkRef.current) {
        localMkRef.current = L.marker(ll, { icon: localIcon(), zIndexOffset: 1000 })
          .addTo(map)
          .bindPopup(`<b style="color:#00BFFF">◉ YOUR POSITION</b><br/>${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}<br/><span style="color:#AAFFCC">ACC: ±${Math.round(c.accuracy)}m</span>`);
        localMkRef.current._accCircle = L.circle(ll, {
          radius: c.accuracy, color:'#00BFFF', fillColor:'#00BFFF', fillOpacity:0.06, weight:1, opacity:0.3,
        }).addTo(map);
        map.setView(ll, 15);
      } else {
        localMkRef.current.setLatLng(ll);
        localMkRef.current._accCircle?.setLatLng(ll).setRadius(c.accuracy);
      }
    }, err => console.warn('[Map] GPS:', err.message), { enableHighAccuracy: true, maximumAge: 10000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [onLocationUpdate]);

  // Peer markers
  useEffect(() => {
    const map = mapRef.current;
    const mks = peerMksRef.current;
    if (!map) return;
    const active = new Set();
    for (const p of peers) {
      const loc = p.nodeInfo?.location;
      const bat = p.nodeInfo?.batteryLevel ?? 100;
      if (!loc?.lat || !loc?.lng || p.nodeId === localNodeId) continue;
      active.add(p.nodeId);
      const ll = [loc.lat, loc.lng];
      const name = p.userName ?? p.nodeId?.slice(0,8) ?? '?';
      const pop = `<b style="color:#00FF88">◈ ${name.toUpperCase()}</b><br/>STATUS: <span style="color:${p.state==='connected'?'#00FF88':'#FF6600'}">${(p.state??'UNKNOWN').toUpperCase()}</span><br/>BAT: ${bat}%<br/><span style="color:#446644">${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}</span>`;
      if (mks.has(p.nodeId)) {
        mks.get(p.nodeId).setLatLng(ll).setIcon(peerIcon(name, bat)).getPopup()?.setContent(pop);
      } else {
        mks.set(p.nodeId, L.marker(ll, { icon: peerIcon(name, bat), zIndexOffset: 500 }).addTo(map).bindPopup(pop));
      }
    }
    for (const [id, mk] of mks) if (!active.has(id)) { map.removeLayer(mk); mks.delete(id); }
  }, [peers, localNodeId]);

  // SOS markers
  useEffect(() => {
    const map = mapRef.current;
    const mks = sosMksRef.current;
    if (!map) return;
    const active = new Set();
    for (const a of sosAlerts) {
      if (!a.location?.lat || !a.location?.lng) continue;
      active.add(a.nodeId);
      const ll = [a.location.lat, a.location.lng];
      const col = ETYPE_COLOR[a.emergencyType] ?? '#FF0000';
      const elapsed = Math.round((Date.now()-a.timestamp)/1000);
      const timeStr = elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed/60)}m ago`;
      const pop = `<b style="color:${col}">⚠ SOS — ${a.emergencyType}</b><br/>${(a.userName??'?').toUpperCase()}<br/>BAT: ${a.batteryLevel??'?'}%<br/>${timeStr}`;
      if (mks.has(a.nodeId)) {
        mks.get(a.nodeId).setLatLng(ll).getPopup()?.setContent(pop);
      } else {
        mks.set(a.nodeId, L.marker(ll, { icon: sosIcon(a.emergencyType), zIndexOffset: 2000 }).addTo(map).bindPopup(pop));
      }
    }
    for (const [id, mk] of mks) if (!active.has(id)) { map.removeLayer(mk); mks.delete(id); }
  }, [sosAlerts]);

  const cacheArea = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !swReady) return;
    setCaching(true);
    const b = map.getBounds(); const z = map.getZoom();
    const urls = [];
    for (let dz = -1; dz <= 2; dz++) {
      const zoom = Math.max(1, Math.min(18, z + dz));
      const nw = getTileXY(b.getNorth(), b.getWest(), zoom);
      const se = getTileXY(b.getSouth(), b.getEast(), zoom);
      for (let x = nw.x; x <= se.x; x++)
        for (let y = nw.y; y <= se.y; y++)
          urls.push(`https://a.basemaps.cartocdn.com/dark_all/${zoom}/${x}/${y}.png`);
    }
    navigator.serviceWorker.controller?.postMessage({ type: 'PRE_CACHE_TILES', urls });
    setTimeout(() => {
      navigator.serviceWorker.controller?.postMessage({ type: 'GET_TILE_COUNT' });
      setCaching(false);
    }, urls.length * 15 + 2000);
  }, [swReady]);

  const peersWithLoc = peers.filter(p => p.nodeInfo?.location?.lat && p.nodeId !== localNodeId);
  const activeSos    = sosAlerts.filter(a => a.location?.lat && Date.now() - a.receivedAt < 5*60_000);

  return (
    <>
      <style>{`
        .map-root{position:relative;width:100%;height:100%;background:#000;}

        /* Floating node list */
        .node-panel{
          position:absolute;top:12px;left:12px;z-index:1000;
          background:rgba(0,0,0,0.88);border:1px solid #00FF8844;
          min-width:180px;max-width:220px;
          backdrop-filter:blur(4px);
        }
        .node-panel-header{
          display:flex;align-items:center;justify-content:space-between;
          padding:8px 12px;border-bottom:1px solid #00FF8822;cursor:pointer;
          font-family:${FONT};font-size:11px;color:#00FF88;letter-spacing:0.15em;
        }
        .node-panel-body{padding:6px 0;}
        .node-item{
          display:flex;align-items:center;gap:8px;
          padding:6px 12px;font-family:${FONT};font-size:11px;color:#AAFFCC;
          letter-spacing:0.08em;cursor:pointer;transition:background 0.1s;
        }
        .node-item:hover{background:#00FF8811;}
        .node-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}

        /* HUD chips */
        .hud-top{
          position:absolute;top:12px;right:12px;z-index:1000;
          display:flex;flex-direction:column;gap:6px;align-items:flex-end;
        }
        .hud-chip{
          background:rgba(0,0,0,0.85);border:1px solid #00FF8833;
          padding:5px 10px;font-family:${FONT};font-size:10px;
          color:#00FF88;letter-spacing:0.1em;
          backdrop-filter:blur(4px);
        }
        .hud-btn{
          background:rgba(13,31,13,0.9);border:1px solid #00FF8866;
          padding:7px 14px;font-family:${FONT};font-size:11px;
          color:#00FF88;letter-spacing:0.15em;cursor:pointer;
          transition:all 0.15s;
        }
        .hud-btn:hover{background:#001a0d;box-shadow:0 0 10px #00FF8833;}
        .hud-btn:disabled{opacity:0.4;cursor:wait;}

        /* Legend */
        .map-legend{
          position:absolute;bottom:60px;right:12px;z-index:1000;
          display:flex;flex-direction:column;gap:4px;
          background:rgba(0,0,0,0.8);border:1px solid #00FF8822;
          padding:8px 10px;backdrop-filter:blur(4px);
        }
        .legend-row{display:flex;align-items:center;gap:7px;font-family:${FONT};font-size:9px;color:#AAFFCC;letter-spacing:0.1em;}
        .legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
      `}</style>

      <div className="map-root">
        {/* Map canvas — full size */}
        <div ref={mapDivRef} style={{ width:'100%', height:'100%' }} />

        {/* Floating node list */}
        <div className="node-panel">
          <div className="node-panel-header" onClick={() => setNodePanel(p => !p)}>
            <span>◈ NODES ({peersWithLoc.length + 1})</span>
            <span>{nodePanel ? '▲' : '▼'}</span>
          </div>
          {nodePanel && (
            <div className="node-panel-body">
              {/* Local */}
              <div className="node-item">
                <span className="node-dot" style={{ background:'#00BFFF', boxShadow:'0 0 5px #00BFFF' }} />
                <span style={{ color:'#00BFFF' }}>{`YOU (${(coords?.lat?.toFixed(3) ?? '--')})`}</span>
              </div>
              {/* Peers */}
              {peersWithLoc.map(p => {
                const on = p.state === 'connected';
                const col = on ? '#00FF88' : '#FF6600';
                return (
                  <div key={p.nodeId} className="node-item" onClick={() => {
                    const loc = p.nodeInfo?.location;
                    if (loc && mapRef.current) mapRef.current.flyTo([loc.lat, loc.lng], 16);
                  }}>
                    <span className="node-dot" style={{ background: col, boxShadow: on ? `0 0 5px ${col}`:'' }} />
                    <span>{(p.userName ?? p.nodeId?.slice(0,8)).toUpperCase()}</span>
                  </div>
                );
              })}
              {/* SOS */}
              {activeSos.map(a => (
                <div key={a.nodeId} className="node-item" onClick={() => {
                  if (a.location && mapRef.current) mapRef.current.flyTo([a.location.lat, a.location.lng], 16);
                }}>
                  <span className="node-dot" style={{ background:'#FF0000', boxShadow:'0 0 5px #FF0000' }} />
                  <span style={{ color:'#FF3333' }}>⚠ {(a.userName??'?').toUpperCase()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top-right HUD */}
        <div className="hud-top">
          {coords && (
            <div className="hud-chip">
              ◉ {coords.lat.toFixed(4)}, {coords.lng.toFixed(4)}
            </div>
          )}
          {offline && <div className="hud-chip" style={{ color:'#FF6600', borderColor:'#FF660033' }}>⚡ OFFLINE MODE</div>}
          {swReady && !offline && (
            <button className="hud-btn" onClick={cacheArea} disabled={caching}>
              {caching ? '⋯ CACHING…' : `↓ CACHE AREA${cached > 0 ? ` (${cached})` : ''}`}
            </button>
          )}
        </div>

        {/* Legend */}
        <div className="map-legend">
          <div className="legend-row"><span className="legend-dot" style={{ background:'#00BFFF', boxShadow:'0 0 4px #00BFFF' }} />YOUR POSITION</div>
          <div className="legend-row"><span className="legend-dot" style={{ background:'#00FF88', boxShadow:'0 0 4px #00FF88' }} />MESH NODE</div>
          <div className="legend-row"><span className="legend-dot" style={{ background:'#FF0000', boxShadow:'0 0 4px #FF0000' }} />SOS ALERT</div>
        </div>
      </div>
    </>
  );
}