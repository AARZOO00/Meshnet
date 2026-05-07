/**
 * DeadManSwitch.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Dead Man Switch UI for MeshNet.
 *
 * Props (all from App.jsx via useDeadManSwitch hook):
 *   dms  – return value of useDeadManSwitch()
 *   location    – { lat, lng } | null
 *   userName    – string
 */

import { useState } from 'react';

const FONT = "'Share Tech Mono',monospace";
const CIRC = 2 * Math.PI * 54;   // circumference of the SVG countdown ring (r=54)

const PRESET_MINS = [1, 2, 5, 10, 15, 30, 60];

function fmtTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function fmtAgo(ts) {
  if (!ts) return 'NEVER';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}

export default function DeadManSwitch({ dms, location, userName }) {
  const {
    phase, secondsLeft, pct,
    enable, disable, checkIn,
    timeoutMinutes, setTimeoutMinutes,
    triggerCount, lastCheckIn,
    PHASES,
  } = dms;

  const [confirmDisable, setConfirmDisable] = useState(false);
  const [customMin,      setCustomMin]      = useState('');

  const isDisabled   = phase === PHASES.DISABLED;
  const isArmed      = phase === PHASES.ARMED;
  const isWarning    = phase === PHASES.WARNING;
  const isTriggered  = phase === PHASES.TRIGGERED;
  const isActive     = isArmed || isWarning;

  // Ring color
  const ringColor = isTriggered ? '#FF0000'
    : isWarning    ? '#FF6600'
    : isArmed      ? '#00FF88'
    : '#1a3a1a';

  // Stroke dashoffset: full ring = CIRC, empty = 0
  const dashOffset = CIRC * (1 - pct);

  return (
    <>
      <style>{`
        .dms-root{
          display:flex;flex-direction:column;
          background:#000;color:#fff;
          font-family:${FONT};height:100%;overflow-y:auto;
        }
        .dms-root::-webkit-scrollbar{width:3px;}
        .dms-root::-webkit-scrollbar-thumb{background:#FF000033;}

        /* Header */
        .dms-header{
          flex:none;padding:14px 16px;
          background:#0D1F0D;border-bottom:1px solid #00FF8822;
        }
        .dms-title{font-size:14px;color:#00FF88;letter-spacing:0.25em;margin-bottom:3px;}
        .dms-sub{font-size:10px;color:#AAFFCC;letter-spacing:0.12em;line-height:1.6;}

        /* Status banner */
        .dms-banner{
          flex:none;display:flex;align-items:center;gap:10px;
          padding:10px 16px;font-size:11px;letter-spacing:0.15em;
          border-bottom:1px solid;
        }
        .dms-banner-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}

        /* Center dial area */
        .dms-dial-area{
          display:flex;flex-direction:column;align-items:center;
          padding:24px 16px 16px;gap:16px;
        }
        .dms-dial-wrap{position:relative;width:148px;height:148px;}
        .dms-dial-svg{position:absolute;top:0;left:0;transform:rotate(-90deg);}
        .dms-dial-inner{
          position:absolute;inset:0;display:flex;flex-direction:column;
          align-items:center;justify-content:center;gap:2px;
          background:#000;border-radius:50%;
          border:2px solid;
        }
        .dms-time-display{font-size:26px;letter-spacing:0.05em;line-height:1;}
        .dms-phase-label{font-size:9px;letter-spacing:0.2em;}

        /* Pulse animation for warning */
        @keyframes dmsWarnPulse{
          0%,100%{box-shadow:0 0 0 0 rgba(255,102,0,0.6),0 0 20px rgba(255,102,0,0.3)}
          50%{box-shadow:0 0 0 16px rgba(255,102,0,0),0 0 40px rgba(255,102,0,0.5)}
        }
        @keyframes dmsArmedBreath{
          0%,100%{box-shadow:0 0 8px rgba(0,255,136,0.2)}
          50%{box-shadow:0 0 20px rgba(0,255,136,0.4)}
        }
        @keyframes dmsTriggered{
          0%,100%{box-shadow:0 0 0 0 rgba(255,0,0,0.9),0 0 40px rgba(255,0,0,0.5)}
          70%{box-shadow:0 0 0 30px rgba(255,0,0,0),0 0 60px rgba(255,0,0,0.2)}
        }
        .dial-armed   { animation:dmsArmedBreath 2.5s ease-in-out infinite; }
        .dial-warning { animation:dmsWarnPulse 1s ease-in-out infinite; }
        .dial-triggered{ animation:dmsTriggered 1.2s ease-in-out infinite; }

        /* Check-in button */
        .checkin-btn{
          width:100%;max-width:280px;padding:16px;
          background:#001a0d;border:2px solid #00FF88;
          color:#00FF88;font-family:${FONT};
          font-size:14px;letter-spacing:0.25em;
          cursor:pointer;transition:all 0.15s;
          display:flex;align-items:center;justify-content:center;gap:10px;
        }
        .checkin-btn:hover{background:#002a14;box-shadow:0 0 20px rgba(0,255,136,0.3);}
        .checkin-btn:active{transform:scale(0.97);}
        @keyframes checkinPulse{
          0%,100%{box-shadow:0 0 0 0 rgba(0,255,136,0.6)}
          50%{box-shadow:0 0 0 12px rgba(0,255,136,0)}
        }
        .checkin-btn.urgent{
          border-color:#FF6600;color:#FF6600;background:#1a0800;
          animation:checkinPulse 0.8s ease-in-out infinite;
        }
        .checkin-btn.urgent:hover{background:#2a1000;}

        /* Enable/Disable buttons */
        .dms-actions{display:flex;flex-direction:column;gap:8px;padding:0 16px 16px;align-items:center;}
        .enable-btn{
          width:100%;max-width:280px;padding:12px;
          background:#001a0d;border:1px solid #00FF8866;
          color:#00FF88;font-family:${FONT};font-size:12px;
          letter-spacing:0.2em;cursor:pointer;transition:all 0.15s;
        }
        .enable-btn:hover{background:#002a14;border-color:#00FF88;}
        .disable-btn{
          width:100%;max-width:280px;padding:10px;
          background:none;border:1px solid #330000;
          color:#660000;font-family:${FONT};font-size:11px;
          letter-spacing:0.2em;cursor:pointer;transition:all 0.15s;
        }
        .disable-btn:hover{border-color:#FF3333;color:#FF3333;}

        /* Confirm disable */
        .confirm-box{
          width:100%;max-width:280px;
          background:#1a0000;border:1px solid #FF000044;
          padding:12px;display:flex;flex-direction:column;gap:8px;
        }
        .confirm-text{font-size:11px;color:#FF8888;letter-spacing:0.1em;text-align:center;}
        .confirm-btns{display:flex;gap:8px;}
        .confirm-yes{flex:1;padding:8px;background:#2a0000;border:1px solid #FF3333;color:#FF3333;font-family:${FONT};font-size:11px;letter-spacing:0.15em;cursor:pointer;}
        .confirm-no{flex:1;padding:8px;background:none;border:1px solid #444;color:#888;font-family:${FONT};font-size:11px;letter-spacing:0.15em;cursor:pointer;}

        /* Timeout selector */
        .timeout-section{padding:0 16px 16px;}
        .timeout-label{font-size:10px;color:#AAFFCC;letter-spacing:0.15em;margin-bottom:10px;}
        .preset-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:10px;}
        .preset-btn{
          padding:8px 4px;background:none;border:1px solid #1a3a1a;
          color:#446644;font-family:${FONT};font-size:11px;letter-spacing:0.1em;
          cursor:pointer;transition:all 0.12s;text-align:center;
        }
        .preset-btn:hover{border-color:#00FF8844;color:#AAFFCC;}
        .preset-btn.selected{border-color:#00FF88;color:#00FF88;background:#00FF8811;}
        .preset-btn:disabled{opacity:0.3;cursor:not-allowed;}
        .custom-row{display:flex;gap:8px;align-items:center;}
        .custom-input{
          flex:1;background:#000;border:1px solid #1a3a1a;
          color:#fff;font-family:${FONT};font-size:12px;
          padding:7px 10px;outline:none;
        }
        .custom-input:focus{border-color:#00FF8866;}
        .custom-set-btn{
          padding:7px 14px;background:none;border:1px solid #00FF8833;
          color:#AAFFCC;font-family:${FONT};font-size:11px;
          letter-spacing:0.1em;cursor:pointer;
          white-space:nowrap;
        }
        .custom-set-btn:hover{border-color:#00FF88;color:#00FF88;}

        /* Stats */
        .dms-stats{
          margin:0 16px 16px;
          background:#0D1F0D;border:1px solid #00FF8811;
          padding:10px 12px;display:flex;flex-direction:column;gap:6px;
        }
        .stat-row{display:flex;justify-content:space-between;font-size:11px;letter-spacing:0.08em;}
        .stat-key{color:#446644;}
        .stat-val{color:#AAFFCC;}

        /* Triggered overlay */
        .triggered-overlay{
          flex:none;margin:0 16px 16px;
          background:#1a0000;border:2px solid #FF0000;
          padding:16px;text-align:center;
        }
        @keyframes triggeredFlash{0%,100%{border-color:#FF0000}50%{border-color:#FF000033}}
        .triggered-overlay{animation:triggeredFlash 0.8s step-end infinite;}
        .triggered-icon{font-size:32px;margin-bottom:8px;}
        .triggered-title{font-size:14px;color:#FF0000;letter-spacing:0.25em;margin-bottom:6px;}
        .triggered-sub{font-size:11px;color:#FF8888;letter-spacing:0.1em;line-height:1.7;}
        .rearm-btn{
          margin-top:12px;width:100%;padding:10px;
          background:#0a0000;border:1px solid #FF333366;
          color:#FF6666;font-family:${FONT};font-size:11px;
          letter-spacing:0.2em;cursor:pointer;
        }
        .rearm-btn:hover{border-color:#FF3333;color:#FF3333;}

        /* GPS warning */
        .gps-warning{
          margin:0 16px 12px;padding:8px 12px;
          background:#1a0800;border:1px solid #FF660033;
          font-size:10px;color:#FF6600;letter-spacing:0.1em;
          display:flex;align-items:center;gap:8px;
        }
      `}</style>

      <div className="dms-root">

        {/* Header */}
        <div className="dms-header">
          <div className="dms-title">⬡ DEAD MAN SWITCH</div>
          <div className="dms-sub">
            Auto-broadcasts SOS if you go silent for the set time.<br/>
            Check in before the timer expires to reset.
          </div>
        </div>

        {/* Status banner */}
        <div className="dms-banner" style={{
          background  : isTriggered ? '#1a0000' : isWarning ? '#1a0800' : isArmed ? '#001a0d' : '#0d0d0d',
          borderColor : isTriggered ? '#FF000033' : isWarning ? '#FF660033' : isArmed ? '#00FF8822' : '#1a1a1a',
          color       : isTriggered ? '#FF0000' : isWarning ? '#FF6600' : isArmed ? '#00FF88' : '#444',
        }}>
          <div className="dms-banner-dot" style={{
            background : isTriggered ? '#FF0000' : isWarning ? '#FF6600' : isArmed ? '#00FF88' : '#333',
            boxShadow  : isArmed ? '0 0 6px #00FF88' : isWarning ? '0 0 6px #FF6600' : isTriggered ? '0 0 8px #FF0000' : 'none',
            animation  : (isArmed||isWarning||isTriggered) ? 'breathe 1.5s ease-in-out infinite' : 'none',
          }} />
          <span>
            {isDisabled  && 'SWITCH DISARMED — NOT MONITORING'}
            {isArmed     && `ARMED — CHECK IN WITHIN ${fmtTime(secondsLeft)}`}
            {isWarning   && `⚠ WARNING — ONLY ${fmtTime(secondsLeft)} REMAINING`}
            {isTriggered && '◈ SOS BROADCAST SENT — SWITCH TRIGGERED'}
          </span>
        </div>

        {/* GPS warning */}
        {!location && isActive && (
          <div className="gps-warning">
            <span>⚠</span>
            <span>NO GPS FIX — SOS will broadcast without coordinates</span>
          </div>
        )}

        {/* Triggered overlay */}
        {isTriggered && (
          <div className="triggered-overlay">
            <div className="triggered-icon">⚠</div>
            <div className="triggered-title">SWITCH TRIGGERED</div>
            <div className="triggered-sub">
              SOS has been broadcast to all mesh nodes.<br/>
              Auto-rebroadcasting every 30s for 5 minutes.<br/>
              {location ? `Last GPS: ${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : 'No GPS location included.'}
            </div>
            <button className="rearm-btn" onClick={() => { disable(); setTimeout(enable, 100); }}>
              ↺ DISARM &amp; RE-ARM
            </button>
          </div>
        )}

        {/* Countdown dial */}
        {!isDisabled && (
          <div className="dms-dial-area">
            <div className="dms-dial-wrap">
              <svg className="dms-dial-svg" width={148} height={148} viewBox="0 0 148 148">
                {/* Track */}
                <circle cx={74} cy={74} r={54} fill="none" stroke="#1a1a1a" strokeWidth={8} />
                {/* Progress */}
                <circle
                  cx={74} cy={74} r={54}
                  fill="none"
                  stroke={ringColor}
                  strokeWidth={8}
                  strokeLinecap="round"
                  strokeDasharray={CIRC}
                  strokeDashoffset={dashOffset}
                  style={{
                    transition: 'stroke-dashoffset 0.5s linear, stroke 0.3s',
                    filter: `drop-shadow(0 0 6px ${ringColor}88)`,
                  }}
                />
              </svg>
              <div
                className={`dms-dial-inner ${isWarning?'dial-warning':isArmed?'dial-armed':isTriggered?'dial-triggered':''}`}
                style={{ borderColor: ringColor }}
              >
                <div className="dms-time-display" style={{ color: ringColor }}>
                  {isTriggered ? '⚠' : fmtTime(secondsLeft)}
                </div>
                <div className="dms-phase-label" style={{ color: `${ringColor}88` }}>
                  {isArmed ? 'ARMED' : isWarning ? 'WARNING' : 'TRIGGERED'}
                </div>
              </div>
            </div>

            {/* Check-in button */}
            {!isTriggered && (
              <button
                className={`checkin-btn ${isWarning ? 'urgent' : ''}`}
                onClick={checkIn}
              >
                <span style={{ fontSize:18 }}>✓</span>
                <span>I'M OK — RESET TIMER</span>
              </button>
            )}
          </div>
        )}

        {/* Timeout selector */}
        {isDisabled && (
          <div className="timeout-section">
            <div className="timeout-label">SET TIMEOUT DURATION</div>
            <div className="preset-grid">
              {PRESET_MINS.map(m => (
                <button
                  key={m}
                  className={`preset-btn ${timeoutMinutes === m ? 'selected' : ''}`}
                  onClick={() => setTimeoutMinutes(m)}
                >
                  {m < 60 ? `${m}m` : '1h'}
                </button>
              ))}
              <button
                className={`preset-btn ${!PRESET_MINS.includes(timeoutMinutes) ? 'selected' : ''}`}
                style={{ fontSize: 9 }}
                onClick={() => {}}
              >
                CUSTOM
              </button>
            </div>
            <div className="custom-row">
              <input
                className="custom-input"
                type="number" min="1" max="120"
                placeholder="MINUTES..."
                value={customMin}
                onChange={e => setCustomMin(e.target.value)}
              />
              <button
                className="custom-set-btn"
                onClick={() => {
                  const v = parseInt(customMin, 10);
                  if (v >= 1 && v <= 120) { setTimeoutMinutes(v); setCustomMin(''); }
                }}
              >
                SET
              </button>
            </div>
          </div>
        )}

        {/* Enable / Disable */}
        <div className="dms-actions">
          {isDisabled && (
            <button className="enable-btn" onClick={enable}>
              ◈ ARM SWITCH — {timeoutMinutes}m TIMEOUT
            </button>
          )}

          {isActive && !confirmDisable && (
            <button className="disable-btn" onClick={() => setConfirmDisable(true)}>
              ✕ DISARM SWITCH
            </button>
          )}

          {isActive && confirmDisable && (
            <div className="confirm-box">
              <div className="confirm-text">DISARM THE DEAD MAN SWITCH?</div>
              <div className="confirm-btns">
                <button className="confirm-yes" onClick={() => { disable(); setConfirmDisable(false); }}>
                  YES, DISARM
                </button>
                <button className="confirm-no" onClick={() => setConfirmDisable(false)}>
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Stats */}
        <div className="dms-stats">
          <div className="stat-row">
            <span className="stat-key">TIMEOUT</span>
            <span className="stat-val">{timeoutMinutes} MIN</span>
          </div>
          <div className="stat-row">
            <span className="stat-key">LAST CHECK-IN</span>
            <span className="stat-val">{fmtAgo(lastCheckIn)}</span>
          </div>
          <div className="stat-row">
            <span className="stat-key">TRIGGERS THIS SESSION</span>
            <span className="stat-val" style={{ color: triggerCount > 0 ? '#FF3333' : '#AAFFCC' }}>
              {triggerCount}
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-key">GPS STATUS</span>
            <span className="stat-val" style={{ color: location ? '#00FF88' : '#FF6600' }}>
              {location ? `${location.lat.toFixed(3)}, ${location.lng.toFixed(3)}` : 'NO FIX'}
            </span>
          </div>
          <div className="stat-row">
            <span className="stat-key">CALLSIGN</span>
            <span className="stat-val">{userName.toUpperCase()}</span>
          </div>
        </div>

        {/* How it works */}
        {isDisabled && (
          <div style={{ margin:'0 16px 24px', padding:'12px', background:'#0D1F0D', border:'1px solid #00FF8811', fontSize:10, color:'#446644', letterSpacing:'0.08em', lineHeight:1.8 }}>
            <div style={{ color:'#AAFFCC', marginBottom:6, letterSpacing:'0.15em' }}>HOW IT WORKS</div>
            1. Set timeout duration (how long before SOS fires)<br/>
            2. Tap ARM SWITCH to start the countdown<br/>
            3. Tap I'M OK before timer expires to reset<br/>
            4. If timer hits zero → auto-SOS to all mesh nodes<br/>
            5. SOS includes your GPS location + battery level<br/>
            <div style={{ marginTop:8, color:'#FF6600' }}>⚠ Keep this tab open — timer runs in browser</div>
          </div>
        )}

      </div>
    </>
  );
}