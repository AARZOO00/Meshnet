import { useState, useEffect, useRef, useCallback } from 'react';

const TYPES = [
  { id:'MEDICAL', label:'MEDICAL', icon:'✚', color:'#FF0000', bg:'#1a0000' },
  { id:'FIRE',    label:'FIRE',    icon:'◈', color:'#FF6600', bg:'#1a0800' },
  { id:'FLOOD',   label:'FLOOD',   icon:'◉', color:'#0088FF', bg:'#001018' },
  { id:'TRAPPED', label:'TRAPPED', icon:'⚠', color:'#FFCC00', bg:'#1a1400' },
];
const TYPE_MAP = Object.fromEntries(TYPES.map(t=>[t.id,t]));
const REBROADCAST_MS = 30_000;
const FONT = "'Share Tech Mono',monospace";

function haversineKm(a, b) {
  if (!a||!b) return null;
  const R=6371, dLat=(b.lat-a.lat)*Math.PI/180, dLon=(b.lng-a.lng)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function fmtDist(km) { if(km===null)return'?km'; return km<1?`${Math.round(km*1000)}m`:`${km.toFixed(1)}km`; }
function fmtAgo(ts)  { const s=Math.floor((Date.now()-ts)/1000); return s<60?`${s}s ago`:s<3600?`${Math.floor(s/60)}m ago`:`${Math.floor(s/3600)}h ago`; }

export default function SOSTab({ router, localNodeId, localUserName, batteryLevel, location, sosAlerts, setSosAlerts, visible }) {
  const [phase,       setPhase]       = useState('idle');   // idle|confirm|active
  const [selType,     setSelType]     = useState('MEDICAL');
  const [countdown,   setCountdown]   = useState(null);
  const [broadcastSeq,setBroadcastSeq]= useState(0);
  const [holdPct,     setHoldPct]     = useState(0);
  const [, tick]                      = useState(0);

  const rbTimerRef  = useRef(null);
  const cdTimerRef  = useRef(null);
  const holdRAF     = useRef(null);
  const holdStart   = useRef(null);
  const tickRef     = useRef(REBROADCAST_MS/1000);

  // Refresh time-ago every 15s
  useEffect(() => {
    const t = setInterval(() => tick(n=>n+1), 15_000);
    return () => clearInterval(t);
  }, []);

  // Expire old alerts
  useEffect(() => {
    const t = setInterval(() => setSosAlerts(p=>p.filter(a=>Date.now()-a.receivedAt<5*60_000)), 10_000);
    return () => clearInterval(t);
  }, [setSosAlerts]);

  const doBroadcast = useCallback((seq) => {
    if (!router) return;
    router.broadcast({
      type:'SOS', userName:localUserName, nodeId:localNodeId,
      location, batteryLevel, emergencyType:selType,
      timestamp:Date.now(), broadcastSeq:seq,
    });
  }, [router, localUserName, localNodeId, location, batteryLevel, selType]);

  const activateSOS = useCallback(() => {
    doBroadcast(0);
    setBroadcastSeq(0);
    setPhase('active');
    tickRef.current = REBROADCAST_MS/1000;
    setCountdown(tickRef.current);

    cdTimerRef.current = setInterval(() => {
      tickRef.current -= 1;
      setCountdown(tickRef.current);
      if (tickRef.current <= 0) tickRef.current = REBROADCAST_MS/1000;
    }, 1000);

    rbTimerRef.current = setInterval(() => {
      setBroadcastSeq(p => { doBroadcast(p+1); return p+1; });
    }, REBROADCAST_MS);
  }, [doBroadcast]);

  const cancelSOS = useCallback(() => {
    clearInterval(rbTimerRef.current);
    clearInterval(cdTimerRef.current);
    setPhase('idle');
    setCountdown(null);
    setBroadcastSeq(0);
    setHoldPct(0);
  }, []);

  const onHoldStart = () => {
    if (phase !== 'confirm') return;
    holdStart.current = performance.now();
    const animate = () => {
      const pct = Math.min(100, (performance.now()-holdStart.current)/1500*100);
      setHoldPct(pct);
      if (pct < 100) holdRAF.current = requestAnimationFrame(animate);
      else { activateSOS(); setHoldPct(0); }
    };
    holdRAF.current = requestAnimationFrame(animate);
  };
  const onHoldEnd = () => {
    cancelAnimationFrame(holdRAF.current);
    if (holdPct < 100) setHoldPct(0);
  };

  useEffect(() => () => { clearInterval(rbTimerRef.current); clearInterval(cdTimerRef.current); cancelAnimationFrame(holdRAF.current); }, []);

  const type  = TYPE_MAP[selType];
  const activeSos = sosAlerts.filter(a => Date.now()-a.receivedAt<5*60_000);
  const holdCircumference = 2*Math.PI*70;

  return (
    <>
      <style>{`
        .sos-root{display:flex;flex-direction:column;height:100%;background:#000;overflow-y:auto;}
        .sos-root::-webkit-scrollbar{width:3px;}
        .sos-root::-webkit-scrollbar-thumb{background:#FF000033;}

        /* Type selector */
        .type-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;padding:14px 14px 0;}
        .type-btn{
          display:flex;flex-direction:column;align-items:center;gap:5px;
          padding:12px 6px;border:1px solid #1a0000;background:#0a0000;
          cursor:pointer;transition:all 0.15s;min-height:44px;
          font-family:${FONT};
        }
        .type-btn.active{box-shadow:0 0 12px var(--tc);}
        .type-btn-icon{font-size:20px;}
        .type-btn-label{font-size:9px;letter-spacing:0.12em;}

        /* SOS button area */
        .sos-btn-area{
          display:flex;flex-direction:column;align-items:center;
          padding:24px 14px 16px;
        }
        .sos-btn-wrap{position:relative;width:160px;height:160px;display:flex;align-items:center;justify-content:center;}
        .sos-hold-ring{position:absolute;top:0;left:0;transform:rotate(-90deg);}
        .sos-btn{
          width:140px;height:140px;border-radius:50%;
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          border:none;cursor:pointer;transition:all 0.2s;
          font-family:${FONT};position:relative;z-index:1;
        }
        .sos-btn.idle{
          background:radial-gradient(circle at 40% 35%,#220000,#0a0000);
          border:3px solid #660000;
          box-shadow:0 0 20px rgba(255,0,0,0.2);
          animation:idlePulse 3s ease-in-out infinite;
        }
        .sos-btn.confirm{
          background:radial-gradient(circle at 40% 35%,#330000,#1a0000);
          border:3px solid #FF0000;
          animation:confirmPulse 0.8s ease-in-out infinite;
        }
        .sos-btn.active{
          background:radial-gradient(circle at 40% 35%,#3a0000,#1a0000);
          border:3px solid #FF0000;
          animation:sosPulse 1.2s ease-in-out infinite;
          cursor:default;
        }
        @keyframes idlePulse{0%,100%{box-shadow:0 0 20px rgba(255,0,0,0.2)}50%{box-shadow:0 0 40px rgba(255,0,0,0.4)}}
        @keyframes confirmPulse{0%,100%{box-shadow:0 0 20px rgba(255,0,0,0.6),0 0 0 4px rgba(255,0,0,0.3)}50%{box-shadow:0 0 50px rgba(255,0,0,0.8),0 0 0 8px rgba(255,0,0,0.15)}}
        @keyframes sosPulse{0%{box-shadow:0 0 0 0 rgba(255,0,0,0.9),0 0 40px rgba(255,0,0,0.5)}70%{box-shadow:0 0 0 40px rgba(255,0,0,0),0 0 60px rgba(255,0,0,0.2)}100%{box-shadow:0 0 0 0 rgba(255,0,0,0)}}
        .sos-label{font-size:38px;color:#FF0000;line-height:1;letter-spacing:0.1em;text-shadow:0 0 20px #FF0000,0 0 40px rgba(255,0,0,0.5);}
        .sos-sublabel{font-size:9px;color:#660000;letter-spacing:0.2em;margin-top:4px;}
        .sos-active-label{font-size:38px;color:#FF0000;line-height:1;animation:flicker 3s step-end infinite;}
        @keyframes flicker{0%,94%,100%{opacity:1}96%{opacity:0.4}98%{opacity:0.7}}

        .sos-instruction{font-family:${FONT};font-size:11px;color:#660000;letter-spacing:0.15em;text-align:center;margin-top:8px;line-height:1.7;}

        /* Active info */
        .sos-active-info{padding:0 14px 12px;display:flex;flex-direction:column;gap:8px;}
        .sos-broadcast-type{
          display:flex;align-items:center;justify-content:center;gap:10px;
          padding:10px;font-family:${FONT};font-size:13px;letter-spacing:0.2em;
        }
        .sos-countdown{font-family:${FONT};font-size:10px;color:#660000;letter-spacing:0.15em;text-align:center;}
        .sos-progress{width:100%;height:2px;background:#1a0000;position:relative;overflow:hidden;}
        .sos-progress-fill{height:100%;background:#FF0000;box-shadow:0 0 6px #FF0000;}
        .cancel-btn{
          width:100%;padding:12px;background:#0a0000;
          border:1px solid #330000;color:#660000;
          font-family:${FONT};font-size:11px;letter-spacing:0.2em;
          cursor:pointer;transition:all 0.15s;
        }
        .cancel-btn:hover{border-color:#FF0000;color:#FF3333;}

        /* Alert list */
        .alerts-section{padding:0 14px 80px;}
        .alerts-header{
          display:flex;align-items:center;justify-content:space-between;
          padding:10px 0 8px;
          font-family:${FONT};font-size:10px;color:#440000;letter-spacing:0.2em;
          border-bottom:1px solid #1a0000;
        }
        .alert-badge{color:#FF0000;animation:sosBlink 1.5s ease-in-out infinite;}
        @keyframes sosBlink{0%,100%{opacity:1}50%{opacity:0.4}}
        .alert-card{
          display:flex;gap:10px;padding:12px 0;
          border-bottom:1px solid #0d0000;
          animation:alertIn 0.2s ease forwards;
        }
        @keyframes alertIn{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:translateX(0)}}
        .alert-type-icon{
          flex:none;width:36px;height:36px;border-radius:2px;
          display:flex;align-items:center;justify-content:center;
          font-size:18px;border:1px solid;
        }
        .alert-body{flex:1;min-width:0;}
        .alert-name{font-family:${FONT};font-size:13px;letter-spacing:0.1em;margin-bottom:4px;}
        .alert-meta{display:flex;gap:10px;flex-wrap:wrap;font-family:${FONT};font-size:10px;color:#555;letter-spacing:0.08em;}
        .alert-empty{
          text-align:center;padding:30px 0;
          font-family:${FONT};font-size:11px;color:#1a0000;letter-spacing:0.2em;
        }

        .sos-gps-info{
          font-family:${FONT};font-size:9px;letter-spacing:0.1em;
          padding:0 14px 8px;display:flex;justify-content:space-between;
        }
      `}</style>

      <div className="sos-root">
        {/* Emergency type selector */}
        {phase !== 'active' && (
          <div className="type-grid">
            {TYPES.map(t => (
              <button
                key={t.id}
                className={`type-btn ${selType===t.id?'active':''}`}
                style={{
                  '--tc': t.color,
                  borderColor: selType===t.id ? t.color : '#1a0000',
                  background:  selType===t.id ? t.bg : '#0a0000',
                }}
                onClick={() => { setSelType(t.id); if(phase==='confirm') setPhase('idle'); }}
              >
                <span className="type-btn-icon" style={{ color:t.color }}>{t.icon}</span>
                <span className="type-btn-label" style={{ color: selType===t.id ? t.color : '#440000' }}>{t.label}</span>
              </button>
            ))}
          </div>
        )}

        {/* Active type banner */}
        {phase === 'active' && (
          <div className="sos-broadcast-type" style={{ background: type.bg, borderBottom:`1px solid ${type.color}33`, color: type.color }}>
            <span style={{ fontSize:20 }}>{type.icon}</span>
            <span>{type.label} EMERGENCY BROADCAST</span>
            <span style={{ fontSize:20 }}>{type.icon}</span>
          </div>
        )}

        {/* SOS button */}
        <div className="sos-btn-area">
          <div className="sos-btn-wrap">
            {/* Hold progress ring */}
            {phase === 'confirm' && (
              <svg className="sos-hold-ring" width={160} height={160}>
                <circle cx={80} cy={80} r={70} fill="none" stroke="#FF0000" strokeWidth={3}
                  strokeLinecap="round"
                  strokeDasharray={holdCircumference}
                  strokeDashoffset={holdCircumference*(1-holdPct/100)}
                  style={{ filter:'drop-shadow(0 0 6px #FF0000)', transition:'stroke-dashoffset 0.05s' }}
                />
              </svg>
            )}

            <button
              className={`sos-btn ${phase}`}
              onClick={() => { if(phase==='idle') setPhase('confirm'); else if(phase==='confirm') setPhase('idle'); }}
              onMouseDown={onHoldStart} onMouseUp={onHoldEnd} onMouseLeave={onHoldEnd}
              onTouchStart={onHoldStart} onTouchEnd={onHoldEnd}
              disabled={phase==='active'}
            >
              {phase === 'active' ? (
                <>
                  <span className="sos-active-label">SOS</span>
                  <span className="sos-sublabel">LIVE</span>
                </>
              ) : (
                <>
                  <span className="sos-label">SOS</span>
                  <span className="sos-sublabel">{phase==='idle'?'TAP TO ARM':'HOLD TO SEND'}</span>
                </>
              )}
            </button>
          </div>

          {phase === 'confirm' && (
            <div className="sos-instruction">
              HOLD BUTTON 1.5 SECONDS TO BROADCAST<br/>
              <span style={{color:'#330000'}}>TAP TO CANCEL</span>
            </div>
          )}
        </div>

        {/* Active SOS info */}
        {phase === 'active' && (
          <div className="sos-active-info">
            <div className="sos-countdown">
              NEXT REBROADCAST IN {countdown}s · TX #{broadcastSeq+1}
            </div>
            <div className="sos-progress">
              <div
                key={broadcastSeq}
                className="sos-progress-fill"
                style={{
                  animation: `drainBar ${REBROADCAST_MS}ms linear forwards`,
                }}
              />
            </div>
            <style>{`@keyframes drainBar{from{width:100%}to{width:0%}}`}</style>
            <button className="cancel-btn" onClick={cancelSOS}>✕ CANCEL SOS BROADCAST</button>
          </div>
        )}

        {/* GPS info */}
        <div className="sos-gps-info">
          <span style={{ color: location ? '#333' : '#FF6600' }}>
            {location ? `GPS: ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : '⚠ NO GPS FIX'}
          </span>
          <span style={{ color: batteryLevel<=20?'#FF6600':'#333' }}>BAT: {batteryLevel}%</span>
        </div>

        {/* Active alerts list */}
        <div className="alerts-section">
          <div className="alerts-header">
            <span>ACTIVE DISTRESS SIGNALS</span>
            {activeSos.length > 0 && (
              <span className="alert-badge">⚠ {activeSos.length} ACTIVE</span>
            )}
          </div>

          {activeSos.length === 0 ? (
            <div className="alert-empty">
              <div style={{fontSize:28,marginBottom:8,color:'#0d0000'}}>◎</div>
              <div>NO ACTIVE ALERTS</div>
              <div style={{fontSize:9,marginTop:4,color:'#0a0000'}}>ZONE CLEAR</div>
            </div>
          ) : (
            activeSos
              .slice().sort((a,b)=>b.timestamp-a.timestamp)
              .map(alert => {
                const t = TYPE_MAP[alert.emergencyType] ?? TYPE_MAP.MEDICAL;
                const dist = haversineKm(location, alert.location);
                return (
                  <div key={alert.nodeId} className="alert-card">
                    <div className="alert-type-icon" style={{ background:t.bg, borderColor:`${t.color}44`, color:t.color }}>
                      {t.icon}
                    </div>
                    <div className="alert-body">
                      <div className="alert-name" style={{ color:t.color }}>
                        {(alert.userName??'?').toUpperCase()}
                        <span style={{fontSize:10,marginLeft:8,color:`${t.color}88`,border:`1px solid ${t.color}33`,padding:'1px 5px'}}>{t.label}</span>
                      </div>
                      <div className="alert-meta">
                        <span>◷ {fmtAgo(alert.timestamp)}</span>
                        {dist!==null && <span>⊕ {fmtDist(dist)}</span>}
                        <span>↻ {alert.hopCount}hop{alert.hopCount!==1?'s':''}</span>
                        <span style={{color:alert.batteryLevel<=20?'#FF6600':'#444'}}>⚡{alert.batteryLevel??'?'}%</span>
                        {alert.broadcastSeq>0 && <span>TX×{alert.broadcastSeq+1}</span>}
                      </div>
                      {alert.location && (
                        <div style={{fontSize:9,color:'#1a0000',marginTop:3,fontFamily:FONT}}>
                          {alert.location.label ?? `${alert.location.lat?.toFixed(4)}, ${alert.location.lng?.toFixed(4)}`}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setSosAlerts(p=>p.filter(a=>a.nodeId!==alert.nodeId))}
                      style={{flexShrink:0,background:'none',border:'none',color:'#330000',cursor:'pointer',fontSize:14,padding:'2px 6px',fontFamily:FONT,alignSelf:'flex-start'}}
                      onMouseEnter={e=>e.currentTarget.style.color='#FF3333'}
                      onMouseLeave={e=>e.currentTarget.style.color='#330000'}
                    >✕</button>
                  </div>
                );
              })
          )}
        </div>
      </div>
    </>
  );
}