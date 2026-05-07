import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import WebRTCManager from './core/WebRTCManager.js';
import useDeadManSwitch from './core/useDeadManSwitch.js';
import useMessageHistory from './core/useMessageHistory.js';
import Router, { BROADCAST_TARGET } from './core/Router.js';

import CommsTab from './components/CommsTab.jsx';
import MapTab from './components/MapTab.jsx';
import NetworkTab from './components/NetworkTab.jsx';
import SOSTab from './components/SOSTab.jsx';
import DeadManSwitch from './components/DeadManSwitch.jsx';
import { VoiceRecorder, VoiceBubble } from './components/VoiceMessage.jsx';
const SIGNALING_URL = import.meta.env.VITE_SIGNALING_URL ?? 'http://localhost:3001';
const DEFAULT_ZONE  = import.meta.env.VITE_DEFAULT_ZONE  ?? 'zone-alpha';

function getOrCreateIdentity() {
  try {
    const s = localStorage.getItem('meshnet-identity');
    if (s) return JSON.parse(s);
  } catch (_) {}
  const id = { nodeId: uuidv4(), userName: `NODE-${Math.random().toString(36).slice(2,6).toUpperCase()}` };
  try { localStorage.setItem('meshnet-identity', JSON.stringify(id)); } catch (_) {}
  return id;
}

const TABS = [
  { id:'comms',   icon:'💬', label:'COMMS'   },
  { id:'map',     icon:'🗺',  label:'MAP'     },
  { id:'network', icon:'⬡',  label:'NETWORK' },
  { id:'sos',     icon:'⚠',  label:'SOS'     },
];

export default function App() {
  const identity    = useMemo(() => getOrCreateIdentity(), []);
  const [tab,       setTab]       = useState('comms');
  const [connStatus,setConnStatus]= useState('connecting');
  const [peers,     setPeers]     = useState([]);
  const [messages,  setMessages]  = useState([]);
  const [sosAlerts, setSosAlerts] = useState([]);
  const [location,  setLocation]  = useState(null);
  const [battery,   setBattery]   = useState(100);
  const [unreadComms, setUnreadComms] = useState(0);
  const [bootDone,  setBootDone]  = useState(false);
  const [bootError, setBootError] = useState(null);
  const [bootLines, setBootLines] = useState([]);

  const managerRef = useRef(null);
  const routerRef  = useRef(null);
  const bootedRef  = useRef(false);

  const addLine = (l) => setBootLines(p => [...p, l]);

  // Battery API
  useEffect(() => {
    navigator.getBattery?.().then(b => {
      setBattery(Math.round(b.level * 100));
      b.addEventListener('levelchange', () => setBattery(Math.round(b.level * 100)));
    }).catch(() => {});
  }, []);

  // Boot
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    async function boot() {
      addLine('MESHNET INITIALIZING…');
      await sleep(150);
      addLine(`NODE: ${identity.nodeId.slice(0,8).toUpperCase()}`);
      await sleep(100);
      addLine(`CALLSIGN: ${identity.userName}`);
      await sleep(100);
      addLine(`ZONE: ${DEFAULT_ZONE.toUpperCase()}`);
      await sleep(100);

      const router = new Router({ localNodeId: identity.nodeId, localSocketId: 'pending' });
      routerRef.current = router;

      router.on('message', ({ message }) => {
        if (message.payload?.type !== 'CHAT') return;
        const msg = {
          id: message.messageId, senderId: message.senderId,
          senderName: message.payload.senderName ?? message.senderId.slice(0,8),
          text: message.payload.text, hopCount: message.hopCount,
          timestamp: message.timestamp, direction: 'inbound',
        };
        setMessages(p => p.some(m => m.id === msg.id) ? p : [...p, msg]);
        setUnreadComms(n => n + 1);
      });
      router.on('sos', ({ message }) => {
        if (message.payload?.type !== 'SOS') return;
        const alert = {
          id: message.messageId, nodeId: message.senderId,
          userName: message.payload.userName, emergencyType: message.payload.emergencyType,
          location: message.payload.location, batteryLevel: message.payload.batteryLevel,
          timestamp: message.payload.timestamp, hopCount: message.hopCount,
          broadcastSeq: message.payload.broadcastSeq ?? 0, receivedAt: Date.now(),
        };
        setSosAlerts(p => {
          const idx = p.findIndex(a => a.nodeId === alert.nodeId);
          if (idx >= 0) { const c=[...p]; c[idx]=alert; return c; }
          return [...p, alert];
        });
      });
      router.on('route-updated', () => {
        if (managerRef.current) setPeers(managerRef.current.getPeers());
      });

      const manager = new WebRTCManager({
        signalingUrl: SIGNALING_URL,
        nodeInfo: { nodeId: identity.nodeId, userName: identity.userName, location: null, batteryLevel: battery },
        zoneId: DEFAULT_ZONE, router,
      });
      managerRef.current = manager;

      manager.on('connected',           ({ socketId }) => {
        setConnStatus('connected');
        router._localSocketId = socketId;
        router._nodeToSocket.set(identity.nodeId, socketId);
        router._socketToNode.set(socketId, identity.nodeId);
      });
      manager.on('signaling-disconnected', () => setConnStatus('disconnected'));
      manager.on('signaling-reconnected',  () => setConnStatus('connected'));
      manager.on('peer-list-updated',  p => setPeers(p));
      manager.on('peer-connected',     () => setPeers(manager.getPeers()));
      manager.on('peer-disconnected',  () => setPeers(manager.getPeers()));

      router.attachManager(manager);

      addLine(`CONNECTING → ${SIGNALING_URL}`);
      try {
        const result = await manager.connect();
        setPeers(result.peers ?? []);
        addLine(`JOINED — ${result.peers?.length ?? 0} PEER(S) FOUND`);
        await sleep(200);
        addLine('SYSTEM READY ✓');
        await sleep(300);
        setBootDone(true);
      } catch (err) {
        addLine(`ERROR: ${err.message}`);
        setBootError(err.message);
        setBootDone(true);
      }
    }
    boot();
    return () => {
      try { managerRef.current?.destroy(); } catch(_){}
      try { routerRef.current?.destroy();  } catch(_){}
      bootedRef.current = false;
    };
  }, []);

  useEffect(() => {
    managerRef.current?.updateNodeInfo({ location, batteryLevel: battery });
  }, [location, battery]);

  const handleTabChange = (t) => {
    setTab(t);
    if (t === 'comms') setUnreadComms(0);
  };

  const connected = peers.filter(p => p.state === 'connected').length;
  const activeSos = sosAlerts.filter(a => Date.now() - a.receivedAt < 5*60_000).length;

  if (!bootDone) return <BootScreen lines={bootLines} />;

  return (
    <>
      <GlobalStyles />
      <div className="app-shell">
        <TopBar
          status={connStatus}
          peers={connected}
          battery={battery}
          userName={identity.userName}
          zoneId={DEFAULT_ZONE}
          activeSos={activeSos}
        />

        <div className="tab-content">
          <div className={`tab-pane ${tab==='comms'   ? 'active' : ''}`}>
            <CommsTab
              router={routerRef.current}
              localNodeId={identity.nodeId}
              localUserName={identity.userName}
              peers={peers}
              messages={messages}
              setMessages={setMessages}
              visible={tab==='comms'}
            />
          </div>
          <div className={`tab-pane ${tab==='map'     ? 'active' : ''}`}>
            <MapTab
              peers={peers}
              sosAlerts={sosAlerts}
              localNodeId={identity.nodeId}
              onLocationUpdate={setLocation}
              visible={tab==='map'}
            />
          </div>
          <div className={`tab-pane ${tab==='network' ? 'active' : ''}`}>
            <NetworkTab
              router={routerRef.current}
              localNodeId={identity.nodeId}
              peers={peers}
              visible={tab==='network'}
            />
          </div>
          <div className={`tab-pane ${tab==='sos'     ? 'active' : ''}`}>
            <SOSTab
              router={routerRef.current}
              localNodeId={identity.nodeId}
              localUserName={identity.userName}
              batteryLevel={battery}
              location={location}
              sosAlerts={sosAlerts}
              setSosAlerts={setSosAlerts}
              visible={tab==='sos'}
            />
          </div>
        </div>

        <BottomNav tab={tab} onChange={handleTabChange} unreadComms={unreadComms} activeSos={activeSos} />
      </div>
    </>
  );
}

function TopBar({ status, peers, battery, userName, zoneId, activeSos }) {
  const [time, setTime] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(t); }, []);
  const isOnline = status === 'connected';
  const batColor = battery <= 15 ? '#FF0000' : battery <= 30 ? '#FF6600' : '#00FF88';
  const bars = Math.ceil(peers / 2);

  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="topbar-logo">⬡ MESHNET</span>
        <span className="topbar-zone">{zoneId.toUpperCase()}</span>
      </div>
      <div className="topbar-right">
        {activeSos > 0 && (
          <span className="topbar-sos-badge">⚠ {activeSos} SOS</span>
        )}
        <div className="signal-bars">
          {[1,2,3,4,5].map(i => (
            <span key={i} className="bar" style={{
              height: 4 + i*3,
              background: peers >= i ? '#00FF88' : '#1a3a1a',
              boxShadow: peers >= i ? '0 0 4px #00FF88' : 'none',
            }} />
          ))}
        </div>
        <span className="topbar-peers">{peers} <span style={{color:'#AAFFCC',fontSize:9}}>NODES</span></span>
        <span className="topbar-status" style={{ color: isOnline ? '#00FF88' : '#FF3333' }}>
          <span className="status-dot" style={{ background: isOnline ? '#00FF88' : '#FF3333' }} />
          {isOnline ? 'LIVE' : 'OFFLINE'}
        </span>
        <span className="topbar-bat" style={{ color: batColor }}>⚡{battery}%</span>
        <span className="topbar-time">{time.toTimeString().slice(0,8)}</span>
      </div>
    </div>
  );
}

function BottomNav({ tab, onChange, unreadComms, activeSos }) {
  return (
    <nav className="bottom-nav">
      {TABS.map(t => {
        const badge = t.id === 'comms' ? unreadComms : t.id === 'sos' ? activeSos : 0;
        const isSos = t.id === 'sos';
        return (
          <button
            key={t.id}
            className={`nav-btn ${tab === t.id ? 'active' : ''} ${isSos ? 'sos-nav' : ''}`}
            onClick={() => onChange(t.id)}
          >
            {badge > 0 && <span className="nav-badge">{badge}</span>}
            <span className="nav-icon">{t.icon}</span>
            <span className="nav-label">{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function BootScreen({ lines }) {
  return (
    <div className="boot-screen">
      <GlobalStyles />
      <div className="boot-hex">⬡</div>
      <div className="boot-title">MESHNET</div>
      <div className="boot-sub">OFFLINE DISASTER COMMUNICATION</div>
      <div className="boot-log">
        {lines.map((l,i) => <div key={i} className="boot-line">&gt; {l}</div>)}
        <span className="boot-cursor" />
      </div>
    </div>
  );
}

function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
      html,body,#root{height:100%;background:#000;overflow:hidden;font-family:'Share Tech Mono',monospace;}
      ::-webkit-scrollbar{width:4px;height:4px;}
      ::-webkit-scrollbar-track{background:#000;}
      ::-webkit-scrollbar-thumb{background:#00FF8844;border-radius:2px;}

      .app-shell{
        height:100vh;display:flex;flex-direction:column;
        background:#000;color:#fff;overflow:hidden;
      }

      /* TOP BAR */
      .topbar{
        flex:none;height:48px;
        display:flex;align-items:center;justify-content:space-between;
        padding:0 16px;background:#0D1F0D;
        border-bottom:1px solid #00FF8844;z-index:100;
      }
      .topbar-left{display:flex;align-items:center;gap:12px;}
      .topbar-right{display:flex;align-items:center;gap:10px;}
      .topbar-logo{font-size:15px;color:#00FF88;letter-spacing:0.3em;text-shadow:0 0 10px #00FF8888;}
      .topbar-zone{font-size:9px;color:#AAFFCC;letter-spacing:0.2em;background:#00FF8811;padding:2px 6px;border:1px solid #00FF8822;}
      .topbar-status{display:flex;align-items:center;gap:4px;font-size:11px;letter-spacing:0.15em;font-weight:bold;}
      .status-dot{width:7px;height:7px;border-radius:50%;animation:breathe 2s ease-in-out infinite;}
      .topbar-peers{font-size:13px;color:#00FF88;letter-spacing:0.1em;}
      .topbar-bat{font-size:11px;letter-spacing:0.1em;}
      .topbar-time{font-size:11px;color:#AAFFCC;letter-spacing:0.15em;}
      .topbar-sos-badge{
        font-size:10px;color:#FF0000;letter-spacing:0.15em;
        background:#1a0000;border:1px solid #FF000066;padding:2px 8px;
        animation:sosBlink 1s step-end infinite;
      }
      .signal-bars{display:flex;align-items:flex-end;gap:2px;height:16px;}
      .bar{width:3px;border-radius:1px;transition:all 0.3s;}

      /* TAB CONTENT */
      .tab-content{flex:1;min-height:0;position:relative;overflow:hidden;}
      .tab-pane{
        position:absolute;inset:0;
        opacity:0;pointer-events:none;
        transform:translateY(8px);
        transition:opacity 0.2s ease,transform 0.2s ease;
        overflow:hidden;
      }
      .tab-pane.active{opacity:1;pointer-events:auto;transform:translateY(0);}

      /* BOTTOM NAV */
      .bottom-nav{
        flex:none;height:58px;
        display:flex;background:#0D1F0D;
        border-top:1px solid #00FF8844;z-index:100;
      }
      .nav-btn{
        flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
        background:none;border:none;cursor:pointer;position:relative;
        border-top:2px solid transparent;transition:all 0.15s;
        min-height:44px;
      }
      .nav-btn.active{background:#00FF8811;border-top-color:#00FF88;}
      .nav-btn.sos-nav .nav-icon{color:#FF0000 !important;filter:drop-shadow(0 0 6px #FF0000);}
      .nav-btn.sos-nav.active{background:#1a000011;border-top-color:#FF0000;}
      .nav-icon{font-size:18px;color:#444;transition:all 0.15s;}
      .nav-btn.active .nav-icon{color:#00FF88;filter:drop-shadow(0 0 6px #00FF88);}
      .nav-label{font-size:9px;color:#444;letter-spacing:0.15em;transition:color 0.15s;}
      .nav-btn.active .nav-label{color:#00FF88;}
      .nav-badge{
        position:absolute;top:4px;right:20%;
        background:#FF0000;color:#fff;font-size:8px;
        border-radius:10px;padding:1px 5px;min-width:16px;text-align:center;
      }

      /* BOOT */
      .boot-screen{
        height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;
        gap:16px;background:#000;
      }
      .boot-hex{font-size:64px;color:#00FF88;text-shadow:0 0 30px #00FF88;animation:hexGlow 2s ease-in-out infinite;}
      .boot-title{font-size:28px;color:#00FF88;letter-spacing:0.5em;text-shadow:0 0 20px #00FF8866;}
      .boot-sub{font-size:10px;color:#AAFFCC;letter-spacing:0.3em;}
      .boot-log{
        width:min(360px,90vw);background:#0D1F0D;border:1px solid #00FF8833;
        padding:14px 16px;display:flex;flex-direction:column;gap:5px;
      }
      .boot-line{font-size:11px;color:#AAFFCC;letter-spacing:0.1em;animation:lineIn 0.15s ease forwards;}
      .boot-cursor{width:8px;height:13px;background:#00FF88;animation:cursorBlink 1s step-end infinite;margin-top:2px;}

      /* KEYFRAMES */
      @keyframes breathe{0%,100%{opacity:1;box-shadow:0 0 4px currentColor}50%{opacity:0.5;box-shadow:none}}
      @keyframes sosBlink{0%,100%{opacity:1}50%{opacity:0.4}}
      @keyframes hexGlow{0%,100%{text-shadow:0 0 20px #00FF88}50%{text-shadow:0 0 50px #00FF88,0 0 80px #00FF8844}}
      @keyframes lineIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
      @keyframes cursorBlink{0%,100%{opacity:1}50%{opacity:0}}
      @keyframes msgFlash{0%{background:#00FF8822}100%{background:transparent}}
      @keyframes sosPulse{0%{box-shadow:0 0 0 0 rgba(255,0,0,0.8),0 0 30px #FF000044}70%{box-shadow:0 0 0 40px rgba(255,0,0,0),0 0 60px #FF000022}100%{box-shadow:0 0 0 0 rgba(255,0,0,0)}}
      @keyframes nodeBreath{0%,100%{filter:drop-shadow(0 0 4px #00FF88)}50%{filter:drop-shadow(0 0 12px #00FF88)}}
      @keyframes ripple{0%{transform:scale(0.8);opacity:0.8}100%{transform:scale(2.5);opacity:0}}
    `}</style>
  );
}