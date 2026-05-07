/**
 * Dashboard.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Network health + statistics dashboard panel for MeshNet.
 *
 * Shows:
 *  - Live mesh graph metrics (nodes, links, avg hops)
 *  - Per-peer status cards with signal/battery/hop-distance
 *  - Message throughput counter
 *  - Routing table (next-hop for each known node)
 *  - Zone activity timeline (last 10 events)
 *
 * Props:
 *   router       – Router instance
 *   peers        – Array<{ nodeId, socketId, userName, state, nodeInfo }>
 *   localNodeId  – string
 *   localUserName– string
 *   messages     – Array<MeshMessage>
 *   sosAlerts    – Array<SosAlert>
 */

import { useState, useEffect, useRef } from 'react';

const FONT = "'Share Tech Mono', monospace";
const MAX_EVENTS = 20;

// ─── Component ────────────────────────────────────────────────────────────────

export default function Dashboard({
  router,
  peers = [],
  localNodeId,
  localUserName = 'UNKNOWN',
  messages = [],
  sosAlerts = [],
}) {
  const [routingTable, setRoutingTable] = useState(new Map());
  const [graphSnap,    setGraphSnap]    = useState({ nodes: [], edges: [] });
  const [events,       setEvents]       = useState([]);
  const [, tick]                        = useState(0);

  // Re-render every 5s for live time-ago updates
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 5_000);
    return () => clearInterval(t);
  }, []);

  // Rebuild routing table when peers change
  useEffect(() => {
    if (!router) return;
    try {
      setRoutingTable(router.getRoutingTable());
      setGraphSnap(router.getGraphSnapshot());
    } catch (_) {}
  }, [router, peers]);

  // Log network events
  useEffect(() => {
    if (!router) return;
    const addEvent = (type, detail) => {
      setEvents(prev => [
        { id: Date.now() + Math.random(), type, detail, ts: Date.now() },
        ...prev,
      ].slice(0, MAX_EVENTS));
    };

    router.on('peer-connected',    ev => addEvent('JOINED',   ev.userName ?? ev.nodeId?.slice(0,8)));
    router.on('peer-disconnected', ev => addEvent('LEFT',     ev.nodeId?.slice(0,8)));
    router.on('sos',               ev => addEvent('SOS',      ev.message?.payload?.userName ?? '?'));
    router.on('routed',            ev => addEvent('RELAYED',  `→ ${ev.nextHopNodeId?.slice(0,8)??'?'}`));
    router.on('dropped',           ev => addEvent('DROPPED',  ev.reason));
  }, [router]);

  // Stats
  const connected    = peers.filter(p => p.state === 'connected').length;
  const chatMessages = messages.filter(m => m.payload?.type === 'CHAT').length;
  const activeSos    = sosAlerts.filter(a => Date.now() - a.receivedAt < 5*60_000).length;
  const avgHops      = messages.length > 0
    ? (messages.reduce((s, m) => s + (m.hopCount ?? 0), 0) / messages.length).toFixed(1)
    : '—';

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
        .dash * { font-family: ${FONT}; box-sizing: border-box; }
        .dash ::-webkit-scrollbar { width: 3px; }
        .dash ::-webkit-scrollbar-track { background: #0a0a0a; }
        .dash ::-webkit-scrollbar-thumb { background: #00ff8833; }

        @keyframes statIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .stat-card { animation: statIn 0.2s ease forwards; }

        @keyframes rowIn {
          from { opacity: 0; transform: translateX(-4px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        .event-row { animation: rowIn 0.15s ease forwards; }
      `}</style>

      <div
        className="dash"
        style={{
          height    : '100%',
          overflowY : 'auto',
          background: '#0a0a0a',
          color     : '#00ff88',
          display   : 'flex',
          flexDirection: 'column',
          gap       : 0,
        }}
      >
        {/* ── Header ──────────────────────────────────────────────────── */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #00ff8822', background: '#0d0d0d', flexShrink: 0 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.2em', color: '#00ff88' }}>◈ NETWORK DASHBOARD</div>
          <div style={{ fontSize: 9, color: '#003322', marginTop: 2, letterSpacing: '0.12em' }}>
            {localUserName.toUpperCase()} · {localNodeId.slice(0,8).toUpperCase()}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* ── Stat grid ─────────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <StatCard value={graphSnap.nodes.length} label="NODES"    color="#00ff88" />
            <StatCard value={connected}              label="LIVE"     color="#00ffcc" />
            <StatCard value={graphSnap.edges.length} label="LINKS"    color="#00cc66" />
            <StatCard value={chatMessages}           label="MSGS"     color="#00ff88" />
            <StatCard value={avgHops}                label="AVG HOPS" color="#ffcc00" />
            <StatCard value={activeSos}              label="SOS"      color={activeSos > 0 ? '#ff3b3b' : '#002211'} />
          </div>

          {/* ── Peer table ────────────────────────────────────────────── */}
          <Section label="PEER STATUS">
            {peers.length === 0 ? (
              <EmptyState>NO PEERS DETECTED</EmptyState>
            ) : peers.map(peer => (
              <PeerRow key={peer.nodeId ?? peer.socketId} peer={peer} routingTable={routingTable} />
            ))}
          </Section>

          {/* ── Routing table ─────────────────────────────────────────── */}
          <Section label="ROUTING TABLE">
            {routingTable.size === 0 ? (
              <EmptyState>NO ROUTES</EmptyState>
            ) : Array.from(routingTable.entries())
                .sort((a, b) => (a[1].cost ?? 99) - (b[1].cost ?? 99))
                .map(([nodeId, route]) => (
                  <RouteRow key={nodeId} nodeId={nodeId} route={route} peers={peers} />
                ))
            }
          </Section>

          {/* ── Graph metrics ─────────────────────────────────────────── */}
          <Section label="GRAPH TOPOLOGY">
            <GraphMetrics snapshot={graphSnap} peers={peers} />
          </Section>

          {/* ── Event log ─────────────────────────────────────────────── */}
          <Section label="ZONE ACTIVITY">
            {events.length === 0 ? (
              <EmptyState>MONITORING…</EmptyState>
            ) : events.map(ev => (
              <EventRow key={ev.id} event={ev} />
            ))}
          </Section>

        </div>
      </div>
    </>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({ value, label, color }) {
  return (
    <div
      className="stat-card"
      style={{
        background  : '#0d0d0d',
        border      : `1px solid ${color}22`,
        padding     : '8px 6px',
        textAlign   : 'center',
      }}
    >
      <div style={{ fontSize: 20, color, fontFamily: FONT, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 8, color: '#002211', letterSpacing: '0.15em', marginTop: 3 }}>{label}</div>
    </div>
  );
}

// ─── PeerRow ──────────────────────────────────────────────────────────────────

function PeerRow({ peer, routingTable }) {
  const isOn    = peer.state === 'connected';
  const color   = isOn ? '#00ff88' : peer.state === 'disconnected' ? '#ffcc00' : '#ff3b3b';
  const bat     = peer.nodeInfo?.batteryLevel ?? peer.batteryLevel;
  const route   = routingTable.get(peer.nodeId);
  const hops    = route?.cost !== Infinity ? route?.cost : '∞';

  return (
    <div style={{
      display      : 'flex',
      alignItems   : 'center',
      gap          : 8,
      padding      : '5px 8px',
      background   : '#0d0d0d',
      borderLeft   : `2px solid ${color}44`,
      marginBottom : 3,
    }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}`, flexShrink: 0 }} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ fontSize: 10, color: isOn ? '#aaffdd' : '#444', letterSpacing: '0.08em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {(peer.userName ?? peer.nodeId?.slice(0,8) ?? '?').toUpperCase()}
        </div>
        <div style={{ fontSize: 8, color: '#003322', letterSpacing: '0.06em' }}>
          {peer.nodeId?.slice(0,12).toUpperCase()}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
        {bat != null && (
          <div style={{ fontSize: 8, color: bat <= 20 ? '#ff8800' : '#003322' }}>⚡{bat}%</div>
        )}
        {hops != null && (
          <div style={{ fontSize: 8, color: '#003322' }}>↻{hops}H</div>
        )}
      </div>
    </div>
  );
}

// ─── RouteRow ─────────────────────────────────────────────────────────────────

function RouteRow({ nodeId, route, peers }) {
  const peer     = peers.find(p => p.nodeId === nodeId);
  const nextPeer = peers.find(p => p.nodeId === route.nextHopNodeId);
  const reachable= route.cost !== Infinity && route.nextHopNodeId;

  return (
    <div style={{
      display      : 'flex',
      alignItems   : 'center',
      gap          : 6,
      padding      : '4px 8px',
      borderBottom : '1px solid #0d0d0d',
      fontSize     : 9,
      letterSpacing: '0.06em',
    }}>
      <span style={{ color: reachable ? '#004422' : '#220000', width: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }}>
        {(peer?.userName ?? nodeId.slice(0,8)).toUpperCase()}
      </span>
      <span style={{ color: '#002211', flexShrink: 0 }}>→</span>
      <span style={{ color: reachable ? '#00ff8866' : '#330000', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {reachable ? (nextPeer?.userName ?? route.nextHopNodeId?.slice(0,8) ?? '?').toUpperCase() : 'UNREACHABLE'}
      </span>
      {reachable && (
        <span style={{ color: '#003322', flexShrink: 0 }}>{route.cost}H</span>
      )}
    </div>
  );
}

// ─── GraphMetrics ─────────────────────────────────────────────────────────────

function GraphMetrics({ snapshot, peers }) {
  const connected = peers.filter(p => p.state === 'connected').length;
  const density   = snapshot.nodes.length > 1
    ? ((2 * snapshot.edges.length) / (snapshot.nodes.length * (snapshot.nodes.length - 1))).toFixed(2)
    : '—';
  const avgDegree = snapshot.nodes.length > 0
    ? ((2 * snapshot.edges.length) / snapshot.nodes.length).toFixed(1)
    : '—';

  const rows = [
    ['TOTAL NODES',   snapshot.nodes.length],
    ['TOTAL LINKS',   snapshot.edges.length],
    ['CONNECTED',     connected],
    ['LINK DENSITY',  density],
    ['AVG DEGREE',    avgDegree],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {rows.map(([label, val]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, padding: '3px 8px', letterSpacing: '0.08em' }}>
          <span style={{ color: '#003322' }}>{label}</span>
          <span style={{ color: '#006633' }}>{val}</span>
        </div>
      ))}
    </div>
  );
}

// ─── EventRow ─────────────────────────────────────────────────────────────────

const EVENT_COLORS = {
  JOINED : '#00ff88',
  LEFT   : '#ffcc00',
  SOS    : '#ff3b3b',
  RELAYED: '#00ccff',
  DROPPED: '#666',
};

function EventRow({ event }) {
  const color   = EVENT_COLORS[event.type] ?? '#004422';
  const elapsed = Math.round((Date.now() - event.ts) / 1000);
  const timeStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed/60)}m`;

  return (
    <div
      className="event-row"
      style={{
        display      : 'flex',
        alignItems   : 'center',
        gap          : 8,
        padding      : '4px 8px',
        borderBottom : '1px solid #0d0000',
        fontSize     : 9,
        letterSpacing: '0.06em',
      }}
    >
      <span style={{ color, width: 52, flexShrink: 0 }}>{event.type}</span>
      <span style={{ flex: 1, color: '#004422', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {String(event.detail).toUpperCase()}
      </span>
      <span style={{ color: '#002211', flexShrink: 0 }}>{timeStr}</span>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Section({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 8, color: '#002211', letterSpacing: '0.2em', marginBottom: 6 }}>{label}</div>
      <div style={{ background: '#0d0d0d', border: '1px solid #00ff8811' }}>
        {children}
      </div>
    </div>
  );
}

function EmptyState({ children }) {
  return (
    <div style={{ fontSize: 9, color: '#001a00', letterSpacing: '0.15em', padding: '10px 8px', textAlign: 'center' }}>
      {children}
    </div>
  );
}
