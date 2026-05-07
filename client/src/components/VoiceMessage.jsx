/**
 * VoiceMessage.jsx
 * Record audio → base64 chunks → send over router → playback with waveform
 *
 * Exports:
 *   VoiceRecorder  – mic button that records and sends
 *   VoiceBubble    – playback bubble with animated waveform
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const FONT       = "'Share Tech Mono',monospace";
const CHUNK_SIZE = 8192;   // bytes per data-channel chunk
const MAX_SEC    = 60;     // max recording length

// ─── Helpers ──────────────────────────────────────────────────────────────────

function arrayBufferToBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToArrayBuffer(b64) {
  const bin  = atob(b64);
  const buf  = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

// Choose best supported MIME type
function getBestMime() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

// Draw waveform from AudioBuffer onto a canvas
async function drawWaveform(canvas, audioData, color = '#00FF88') {
  if (!canvas) return;
  const ctx    = canvas.getContext('2d');
  const W      = canvas.width;
  const H      = canvas.height;
  ctx.clearRect(0, 0, W, H);

  try {
    const ac     = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await ac.decodeAudioData(audioData.slice(0));
    const data   = buffer.getChannelData(0);
    const step   = Math.ceil(data.length / W);
    const amp    = H / 2;

    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.shadowBlur  = 4;
    ctx.shadowColor = color;
    ctx.beginPath();

    for (let i = 0; i < W; i++) {
      let min = 1, max = -1;
      for (let j = 0; j < step; j++) {
        const d = data[i * step + j] ?? 0;
        if (d < min) min = d;
        if (d > max) max = d;
      }
      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();
    ac.close();
  } catch (_) {
    // Fallback: flat line
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
  }
}

// ─── VoiceRecorder ────────────────────────────────────────────────────────────

export function VoiceRecorder({ onSend, disabled }) {
  const [state,    setState]    = useState('idle');   // idle|requesting|recording|processing
  const [seconds,  setSeconds]  = useState(0);
  const [volLevel, setVolLevel] = useState(0);        // 0–1

  const mrRef      = useRef(null);   // MediaRecorder
  const chunksRef  = useRef([]);
  const streamRef  = useRef(null);
  const timerRef   = useRef(null);
  const analyserRef= useRef(null);
  const rafRef     = useRef(null);

  // Mic volume animation
  const startVolMeter = useCallback((stream) => {
    const ac       = new (window.AudioContext || window.webkitAudioContext)();
    const src      = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyserRef.current = { ac, analyser };

    const buf  = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      setVolLevel(Math.min(1, avg / 80));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const stopVolMeter = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    analyserRef.current?.ac?.close();
    analyserRef.current = null;
    setVolLevel(0);
  }, []);

  const startRecording = useCallback(async () => {
    if (disabled) return;
    setState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime   = getBestMime();
      const mr     = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
      mrRef.current    = mr;
      chunksRef.current = [];

      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.start(250);   // collect chunks every 250ms

      setState('recording');
      setSeconds(0);
      startVolMeter(stream);

      timerRef.current = setInterval(() => {
        setSeconds(s => {
          if (s + 1 >= MAX_SEC) { stopRecording(); return s; }
          return s + 1;
        });
      }, 1000);
    } catch (err) {
      console.error('[Voice] Mic error:', err);
      setState('idle');
    }
  }, [disabled, startVolMeter]);

  const stopRecording = useCallback(() => {
    clearInterval(timerRef.current);
    stopVolMeter();
    const mr = mrRef.current;
    if (!mr || mr.state === 'inactive') { setState('idle'); return; }
    setState('processing');

    mr.onstop = async () => {
      const blob    = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
      const arrBuf  = await blob.arrayBuffer();
      const b64     = arrayBufferToBase64(arrBuf);

      // Split into CHUNK_SIZE chunks
      const chunks  = [];
      for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
        chunks.push(b64.slice(i, i + CHUNK_SIZE));
      }

      onSend?.({
        type     : 'VOICE',
        mime     : mr.mimeType || 'audio/webm',
        duration : chunksRef.current.length * 0.25,   // rough seconds
        chunks,
        totalChunks: chunks.length,
        size     : arrBuf.byteLength,
      });

      chunksRef.current = [];
      setState('idle');
      setSeconds(0);
    };
    mr.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
  }, [onSend, stopVolMeter]);

  const cancelRecording = useCallback(() => {
    clearInterval(timerRef.current);
    stopVolMeter();
    mrRef.current?.stop();
    streamRef.current?.getTracks().forEach(t => t.stop());
    chunksRef.current = [];
    setState('idle');
    setSeconds(0);
  }, [stopVolMeter]);

  useEffect(() => () => {
    clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach(t => t.stop());
  }, []);

  const isRecording   = state === 'recording';
  const isProcessing  = state === 'processing';
  const isRequesting  = state === 'requesting';

  return (
    <>
      <style>{`
        .voice-recorder{display:flex;align-items:center;gap:6px;}
        .mic-btn{
          width:44px;height:44px;border-radius:50%;border:2px solid;
          display:flex;align-items:center;justify-content:center;
          cursor:pointer;transition:all 0.15s;font-size:18px;
          position:relative;overflow:visible;flex-shrink:0;
          font-family:${FONT};
        }
        .mic-btn.idle{background:#0D1F0D;border-color:#00FF8844;color:#00FF88;}
        .mic-btn.idle:hover{border-color:#00FF88;box-shadow:0 0 10px #00FF8833;}
        .mic-btn.recording{
          background:#1a0000;border-color:#FF0000;color:#FF0000;
          animation:micPulse 0.8s ease-in-out infinite;
        }
        .mic-btn.processing{background:#0D1F0D;border-color:#FF660044;color:#FF6600;cursor:wait;}
        .mic-btn.requesting{background:#0D1F0D;border-color:#FF660044;color:#FF6600;cursor:wait;}
        .mic-btn:disabled{opacity:0.3;cursor:not-allowed;}
        @keyframes micPulse{
          0%,100%{box-shadow:0 0 0 0 rgba(255,0,0,0.6)}
          50%{box-shadow:0 0 0 10px rgba(255,0,0,0)}
        }
        .vol-ring{
          position:absolute;inset:-4px;border-radius:50%;
          border:2px solid #FF0000;
          opacity:0;transition:transform 0.1s,opacity 0.1s;
          pointer-events:none;
        }
        .rec-info{
          display:flex;align-items:center;gap:6px;
          font-family:${FONT};font-size:10px;color:#FF3333;
          letter-spacing:0.12em;
        }
        .rec-dot{width:6px;height:6px;border-radius:50%;background:#FF0000;animation:recBlink 1s step-end infinite;}
        @keyframes recBlink{0%,100%{opacity:1}50%{opacity:0}}
        .stop-btn{
          padding:6px 12px;background:#1a0000;border:1px solid #FF3333;
          color:#FF3333;font-family:${FONT};font-size:10px;
          letter-spacing:0.12em;cursor:pointer;
        }
        .stop-btn:hover{background:#2a0000;}
        .cancel-rec-btn{
          padding:6px 10px;background:none;border:1px solid #330000;
          color:#660000;font-family:${FONT};font-size:10px;
          letter-spacing:0.1em;cursor:pointer;
        }
      `}</style>

      <div className="voice-recorder">
        {!isRecording && !isProcessing && (
          <button
            className={`mic-btn ${isRequesting ? 'requesting' : 'idle'}`}
            onClick={startRecording}
            disabled={disabled || isRequesting}
            title="Hold to record voice message"
          >
            🎙
            {/* Volume ring */}
            <div className="vol-ring" style={{
              opacity   : volLevel * 0.8,
              transform : `scale(${1 + volLevel * 0.5})`,
            }} />
          </button>
        )}

        {isRecording && (
          <>
            <button className="mic-btn recording" onClick={stopRecording}>
              ⏹
              <div className="vol-ring" style={{
                opacity   : volLevel * 0.9,
                transform : `scale(${1 + volLevel * 0.6})`,
              }} />
            </button>
            <div className="rec-info">
              <span className="rec-dot" />
              <span>REC {String(Math.floor(seconds/60)).padStart(2,'0')}:{String(seconds%60).padStart(2,'0')}</span>
              <span style={{color:'#330000'}}>/ {MAX_SEC}s</span>
            </div>
            <button className="cancel-rec-btn" onClick={cancelRecording}>✕</button>
          </>
        )}

        {isProcessing && (
          <div style={{fontSize:10,color:'#FF6600',letterSpacing:'0.12em',fontFamily:FONT}}>
            ⋯ ENCODING…
          </div>
        )}
      </div>
    </>
  );
}

// ─── VoiceBubble ──────────────────────────────────────────────────────────────

export function VoiceBubble({ payload, isOut }) {
  const [state,    setState]    = useState('idle');  // idle|loading|playing|error
  const [progress, setProgress] = useState(0);       // 0–1
  const [duration, setDuration] = useState(payload.duration ?? 0);
  const [curTime,  setCurTime]  = useState(0);

  const canvasRef  = useRef(null);
  const audioRef   = useRef(null);
  const blobUrlRef = useRef(null);
  const rafRef     = useRef(null);

  // Reassemble chunks → blob URL once
  useEffect(() => {
    if (!payload.chunks?.length) return;
    try {
      const b64    = payload.chunks.join('');
      const arrBuf = base64ToArrayBuffer(b64);
      const blob   = new Blob([arrBuf], { type: payload.mime ?? 'audio/webm' });
      blobUrlRef.current = URL.createObjectURL(blob);

      // Draw waveform
      if (canvasRef.current) {
        drawWaveform(canvasRef.current, arrBuf, isOut ? '#00FF88' : '#AAFFCC');
      }

      // Get real duration
      const tmp = new Audio(blobUrlRef.current);
      tmp.onloadedmetadata = () => {
        if (isFinite(tmp.duration)) setDuration(tmp.duration);
      };
    } catch (err) {
      console.error('[VoiceBubble] decode error:', err);
      setState('error');
    }

    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const playPause = useCallback(() => {
    const url = blobUrlRef.current;
    if (!url) return;

    if (state === 'playing') {
      audioRef.current?.pause();
      setState('idle');
      cancelAnimationFrame(rafRef.current);
      return;
    }

    if (!audioRef.current) {
      audioRef.current = new Audio(url);
      audioRef.current.onended = () => {
        setState('idle');
        setProgress(0);
        setCurTime(0);
        cancelAnimationFrame(rafRef.current);
      };
      audioRef.current.onerror = () => setState('error');
    }

    setState('playing');
    audioRef.current.play();

    const tick = () => {
      const a = audioRef.current;
      if (!a) return;
      const dur = isFinite(a.duration) ? a.duration : duration;
      setCurTime(a.currentTime);
      setProgress(dur > 0 ? a.currentTime / dur : 0);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [state, duration]);

  const seek = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const a    = audioRef.current;
    if (a && isFinite(a.duration)) {
      a.currentTime = pct * a.duration;
      setProgress(pct);
    }
  }, []);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
  }, []);

  const fmtSec = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  const totalFmt = fmtSec(duration || 0);
  const curFmt   = fmtSec(curTime);
  const color    = isOut ? '#00FF88' : '#AAFFCC';
  const isPlaying= state === 'playing';

  return (
    <>
      <style>{`
        .voice-bubble{
          display:flex;flex-direction:column;gap:6px;
          padding:10px 12px;min-width:220px;max-width:300px;
          font-family:${FONT};
        }
        .vb-top{display:flex;align-items:center;gap:8px;}
        .vb-play{
          width:36px;height:36px;border-radius:50%;flex-shrink:0;
          display:flex;align-items:center;justify-content:center;
          border:2px solid;cursor:pointer;font-size:13px;
          transition:all 0.15s;
        }
        .vb-play:hover{filter:brightness(1.3);}
        .vb-wave-wrap{
          flex:1;height:40px;position:relative;cursor:pointer;
          overflow:hidden;
        }
        .vb-wave-canvas{width:100%;height:100%;display:block;}
        .vb-progress-overlay{
          position:absolute;top:0;left:0;height:100%;
          background:rgba(0,0,0,0.55);
          pointer-events:none;
          transition:width 0.1s linear;
        }
        .vb-times{
          display:flex;justify-content:space-between;
          font-size:9px;letter-spacing:0.1em;
          opacity:0.7;margin-top:2px;
        }
        .vb-meta{font-size:9px;letter-spacing:0.1em;opacity:0.5;margin-top:1px;}
        .vb-error{font-size:10px;color:#FF6600;letter-spacing:0.1em;}
        @keyframes wavePlay{
          0%,100%{opacity:0.8}50%{opacity:1}
        }
      `}</style>

      <div className="voice-bubble">
        {state === 'error' ? (
          <div className="vb-error">⚠ AUDIO DECODE FAILED</div>
        ) : (
          <>
            <div className="vb-top">
              {/* Play/Pause */}
              <div
                className="vb-play"
                style={{ borderColor: color, color, background: isPlaying ? `${color}22` : 'transparent' }}
                onClick={playPause}
              >
                {isPlaying ? '⏸' : '▶'}
              </div>

              {/* Waveform canvas */}
              <div className="vb-wave-wrap" onClick={seek}>
                <canvas
                  ref={canvasRef}
                  className="vb-wave-canvas"
                  width={240}
                  height={40}
                  style={{ animation: isPlaying ? 'wavePlay 1s ease-in-out infinite' : 'none' }}
                />
                {/* Scrub overlay: covers the "unplayed" right portion */}
                <div
                  className="vb-progress-overlay"
                  style={{ left: `${progress * 100}%`, width: `${(1 - progress) * 100}%` }}
                />
              </div>
            </div>

            <div className="vb-times" style={{ color }}>
              <span>{isPlaying ? curFmt : '0:00'}</span>
              <span>{totalFmt}</span>
            </div>

            <div className="vb-meta" style={{ color }}>
              🎙 VOICE &nbsp;·&nbsp; {(payload.size / 1024).toFixed(0)} KB &nbsp;·&nbsp; {payload.mime?.split('/')[1]?.split(';')[0] ?? 'audio'}
            </div>
          </>
        )}
      </div>
    </>
  );
}
export default VoiceRecorder;