import { useState, useEffect, useRef, useCallback } from 'react';
import { BROADCAST_TARGET } from '../core/Router.js';

const FMT = new Intl.DateTimeFormat('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
const FONT = "'Share Tech Mono',monospace";

export default function CommsTab({ router, localNodeId, localUserName, peers, messages, setMessages, visible }) {
  const [input,        setInput]        = useState('');
  const [targetNodeId, setTargetNodeId] = useState(null);
  const [offlineQueue, setOfflineQueue] = useState([]);
  const [sending,      setSending]      = useState(false);
  const [newMsgId,     setNewMsgId]     = useState(null);
  const [typing,       setTyping]       = useState({});     // nodeId → timeout
  const [typingNodes,  setTypingNodes]  = useState([]);     // who is typing
  const [search,       setSearch]       = useState('');
  const [showSearch,   setShowSearch]   = useState(false);
  const [reactions,    setReactions]    = useState({});     // msgId → emoji[]
  const [showReact,    setShowReact]    = useState(null);   // msgId showing picker
  const [pinnedMsgs,   setPinnedMsgs]   = useState([]);     // pinned message ids
  const [showPinned,   setShowPinned]   = useState(false);

  const bottomRef  = useRef(null);
  const inputRef   = useRef(null);
  const typingTimer= useRef(null);

  const effectiveTarget = targetNodeId ?? BROADCAST_TARGET;
  const isBroadcast     = effectiveTarget === BROADCAST_TARGET;
  const connected       = peers.filter(p => p.state === 'connected');

  const EMOJIS = ['👍','❤️','⚠️','✅','🆘','📍'];

  // Auto scroll
  useEffect(() => {
    if (!showSearch) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, showSearch]);

  // Focus input when tab visible
  useEffect(() => {
    if (visible) setTimeout(() => inputRef.current?.focus(), 150);
  }, [visible]);

  // Listen for typing indicators from router
  useEffect(() => {
    if (!router) return;
    const onTyping = ({ message }) => {
      if (message.payload?.type !== 'TYPING') return;
      const { senderId } = message;
      const name = message.payload.userName ?? senderId.slice(0,8);
      setTypingNodes(p => p.some(t=>t.id===senderId) ? p : [...p, { id:senderId, name }]);
      clearTimeout(typing[senderId]);
      const t = setTimeout(() => {
        setTypingNodes(p => p.filter(t=>t.id!==senderId));
      }, 3000);
      setTyping(prev => ({ ...prev, [senderId]: t }));
    };
    router.on('message', onTyping);
    return () => router.off('message', onTyping);
  }, [router, typing]);

  // Send typing indicator
  const onInputChange = (val) => {
    setInput(val);
    if (!router || !val) return;
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      router.broadcast({ type:'TYPING', userName: localUserName });
    }, 400);
  };

  // Flush offline queue
  useEffect(() => {
    if (!router || offlineQueue.length === 0 || connected.length === 0) return;
    setOfflineQueue(prev => {
      const remaining = [];
      for (const q of prev) {
        const { sent } = router.send(q.targetId, q.payload);
        if (sent) setMessages(ms => ms.map(m => m.id === q.tempId ? { ...m, status: 'sent' } : m));
        else remaining.push(q);
      }
      return remaining;
    });
  }, [peers]);

  const doSend = useCallback(() => {
    const text = input.trim();
    if (!text || !router) return;
    setSending(true);
    const tempId  = crypto.randomUUID();
    const payload = { type: 'CHAT', text, senderName: localUserName };
    const msg = {
      id: tempId, senderId: localNodeId, senderName: localUserName,
      text, hopCount: 0, timestamp: Date.now(), direction: 'outbound', status: 'pending',
    };
    setMessages(p => [...p, msg]);
    setNewMsgId(tempId);
    setTimeout(() => setNewMsgId(null), 800);
    setInput('');

    if (isBroadcast) {
      const { messageId } = router.broadcast(payload);
      setMessages(ms => ms.map(m => m.id === tempId ? { ...m, id: messageId, status: 'sent' } : m));
    } else {
      const { sent, messageId } = router.send(effectiveTarget, payload);
      if (sent) setMessages(ms => ms.map(m => m.id === tempId ? { ...m, id: messageId, status: 'sent' } : m));
      else {
        setOfflineQueue(p => [...p, { tempId, targetId: effectiveTarget, payload }]);
        setMessages(ms => ms.map(m => m.id === tempId ? { ...m, status: 'queued' } : m));
      }
    }
    setTimeout(() => setSending(false), 200);
    inputRef.current?.focus();
  }, [input, router, localNodeId, localUserName, effectiveTarget, isBroadcast]);

  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  };

  const addReaction = (msgId, emoji) => {
    setReactions(r => ({ ...r, [msgId]: [...new Set([...(r[msgId]||[]), emoji])] }));
    setShowReact(null);
  };

  const togglePin = (msgId) => {
    setPinnedMsgs(p => p.includes(msgId) ? p.filter(id=>id!==msgId) : [...p, msgId]);
  };

  // Filter messages by search or channel
  const displayMsgs = messages.filter(m => {
    if (showSearch && search) return m.text?.toLowerCase().includes(search.toLowerCase()) || m.senderName?.toLowerCase().includes(search.toLowerCase());
    if (!targetNodeId) return true; // broadcast = all msgs
    return m.senderId === targetNodeId || (m.senderId === localNodeId && m.direction === 'outbound');
  });

  const pinnedList = messages.filter(m => pinnedMsgs.includes(m.id));

  return (
    <>
      <style>{`
        .comms-root{display:flex;flex-direction:column;height:100%;background:#000;overflow:hidden;font-family:${FONT};}

        /* Toolbar */
        .comms-toolbar{
          flex:none;display:flex;align-items:center;justify-content:space-between;
          padding:6px 12px;background:#0D1F0D;border-bottom:1px solid #00FF8822;
          gap:8px;
        }
        .toolbar-btn{
          background:none;border:1px solid #00FF8822;color:#AAFFCC;
          font-family:${FONT};font-size:10px;letter-spacing:0.1em;
          padding:5px 10px;cursor:pointer;transition:all 0.15s;white-space:nowrap;
        }
        .toolbar-btn:hover{border-color:#00FF8866;color:#00FF88;}
        .toolbar-btn.active{border-color:#00FF88;color:#00FF88;background:#00FF8811;}
        .search-input{
          flex:1;background:#000;border:1px solid #00FF8833;color:#fff;
          font-family:${FONT};font-size:12px;padding:5px 10px;outline:none;
        }
        .search-input:focus{border-color:#00FF88;}
        .msg-count{font-size:10px;color:#1a3a1a;letter-spacing:0.1em;}

        /* Pinned banner */
        .pinned-banner{
          flex:none;background:#0a1500;border-bottom:1px solid #00FF8822;
          max-height:120px;overflow-y:auto;
        }
        .pinned-header{
          display:flex;align-items:center;justify-content:space-between;
          padding:5px 12px;font-size:10px;color:#AAFFCC;letter-spacing:0.15em;
          cursor:pointer;border-bottom:1px solid #00FF8811;
        }
        .pinned-item{
          display:flex;align-items:flex-start;gap:8px;
          padding:5px 12px;border-bottom:1px solid #00FF8811;
          font-size:11px;color:#AAFFCC;
        }
        .pinned-pin{color:#00FF88;font-size:10px;flex-shrink:0;}
        .pinned-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}

        /* Channel bar */
        .channel-bar{flex:none;display:flex;gap:6px;padding:8px 12px;background:#0D1F0D;border-bottom:1px solid #00FF8822;overflow-x:auto;scrollbar-width:none;}
        .channel-bar::-webkit-scrollbar{display:none;}
        .ch-btn{
          flex:none;display:flex;align-items:center;gap:5px;
          padding:6px 12px;border:1px solid #00FF8822;background:none;
          color:#AAFFCC;font-family:${FONT};font-size:11px;
          letter-spacing:0.1em;cursor:pointer;white-space:nowrap;
          transition:all 0.15s;min-height:36px;
        }
        .ch-btn.active{background:#00FF8822;border-color:#00FF88;color:#00FF88;}
        .ch-dot{width:7px;height:7px;border-radius:50%;}

        /* Message list */
        .msg-list{flex:1;min-height:0;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px;}
        .msg-list::-webkit-scrollbar{width:3px;}
        .msg-list::-webkit-scrollbar-thumb{background:#00FF8833;}

        .msg-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#1a3a1a;}
        .msg-empty-icon{font-size:40px;}

        /* Date separator */
        .date-sep{
          display:flex;align-items:center;gap:8px;
          font-size:9px;color:#1a3a1a;letter-spacing:0.2em;margin:6px 0;
        }
        .date-sep-line{flex:1;height:1px;background:#0d1a0d;}

        /* Bubbles */
        .msg-wrap{display:flex;flex-direction:column;gap:2px;}
        .msg-wrap.out{align-items:flex-end;}
        .msg-wrap.in{align-items:flex-start;}

        .msg-bubble{
          max-width:80%;padding:10px 13px;position:relative;
          animation:bubbleIn 0.18s ease forwards;
          cursor:pointer;
        }
        @keyframes bubbleIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
        .msg-bubble.new{animation:bubbleIn 0.18s ease forwards,newFlash 0.8s ease;}
        @keyframes newFlash{0%{box-shadow:0 0 0 2px #00FF8855}100%{box-shadow:none}}
        .msg-bubble.out{background:#001a0d;border:1px solid #00FF8833;border-bottom-right-radius:0;}
        .msg-bubble.in{background:#0D1F0D;border:1px solid #00FF8822;border-bottom-left-radius:0;}
        .msg-bubble.sos-msg{background:#1a0000;border:1px solid #FF000044;border-bottom-left-radius:0;}
        .msg-bubble.pinned-msg{border-top:2px solid #00FF88;}

        .msg-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:5px;}
        .msg-sender{font-size:12px;letter-spacing:0.1em;font-weight:bold;}
        .msg-time{font-size:10px;color:#446644;}
        .msg-status{font-size:9px;}
        .msg-hop{font-size:10px;color:#446644;margin-top:4px;}
        .msg-text{font-size:13px;color:#fff;line-height:1.6;word-break:break-word;white-space:pre-wrap;}

        /* Reactions */
        .msg-reactions{display:flex;flex-wrap:wrap;gap:3px;margin-top:5px;}
        .reaction-chip{
          font-size:13px;padding:2px 6px;
          background:#00FF8811;border:1px solid #00FF8822;
          cursor:pointer;transition:all 0.1s;
        }
        .reaction-chip:hover{background:#00FF8822;}

        /* Reaction picker */
        .react-picker{
          position:absolute;bottom:100%;right:0;
          display:flex;gap:3px;padding:5px 8px;
          background:#0D1F0D;border:1px solid #00FF8833;
          z-index:100;box-shadow:0 -4px 20px rgba(0,255,136,0.1);
        }
        .react-emoji{font-size:18px;cursor:pointer;padding:2px 4px;transition:transform 0.1s;}
        .react-emoji:hover{transform:scale(1.3);}

        /* Context menu */
        .msg-actions{
          position:absolute;top:4px;right:4px;
          display:none;gap:3px;
        }
        .msg-bubble:hover .msg-actions{display:flex;}
        .action-btn{
          background:#0D1F0D;border:1px solid #00FF8822;
          color:#AAFFCC;font-size:9px;padding:2px 5px;
          cursor:pointer;font-family:${FONT};transition:all 0.1s;
        }
        .action-btn:hover{border-color:#00FF88;color:#00FF88;}

        /* Typing indicator */
        .typing-bar{
          flex:none;padding:4px 14px;
          font-size:10px;color:#446644;letter-spacing:0.1em;
          min-height:22px;
        }
        .typing-dots span{animation:typeDot 1.2s ease-in-out infinite;}
        .typing-dots span:nth-child(2){animation-delay:0.2s;}
        .typing-dots span:nth-child(3){animation-delay:0.4s;}
        @keyframes typeDot{0%,80%,100%{opacity:0.2}40%{opacity:1}}

        /* Queue */
        .queue-banner{flex:none;padding:6px 14px;background:#0f0800;border-top:1px solid #FF660033;font-size:10px;color:#FF6600;letter-spacing:0.12em;}

        /* Input */
        .input-area{flex:none;padding:10px 12px;background:#0D1F0D;border-top:1px solid #00FF8833;}
        .input-target{font-size:10px;color:#AAFFCC;letter-spacing:0.12em;margin-bottom:6px;}
        .input-row{display:flex;gap:8px;align-items:stretch;}
        .input-wrap{flex:1;position:relative;}
        .input-prompt{position:absolute;left:10px;top:12px;color:#00FF8866;font-size:13px;pointer-events:none;user-select:none;}
        .msg-input{
          width:100%;background:#000;border:1px solid #00FF8833;
          color:#fff;font-family:${FONT};font-size:13px;
          padding:10px 10px 10px 32px;caret-color:#00FF88;
          outline:none;resize:none;letter-spacing:0.04em;line-height:1.5;
        }
        .msg-input:focus{border-color:#00FF88;box-shadow:0 0 8px #00FF8822;}
        .msg-input::placeholder{color:#1a3a1a;}
        .send-btn{
          padding:0 18px;background:#001a0d;border:1px solid #00FF88;
          color:#00FF88;font-family:${FONT};font-size:12px;letter-spacing:0.2em;
          cursor:pointer;transition:all 0.15s;
          display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
          min-width:60px;min-height:52px;
        }
        .send-btn:hover{background:#002a14;}
        .send-btn:disabled{opacity:0.3;cursor:not-allowed;}
        .input-hint{font-size:9px;color:#1a3a1a;letter-spacing:0.1em;margin-top:4px;display:flex;justify-content:space-between;}
      `}</style>

      <div className="comms-root">

        {/* Toolbar */}
        <div className="comms-toolbar">
          <span style={{fontSize:11,color:'#00FF88',letterSpacing:'0.15em'}}>
            💬 {messages.length} MSGS
          </span>
          <button className={`toolbar-btn ${showSearch?'active':''}`} onClick={()=>{setShowSearch(s=>!s);setSearch('');}}>
            🔍 SEARCH
          </button>
          {showSearch && (
            <input
              className="search-input"
              placeholder="SEARCH MESSAGES..."
              value={search}
              onChange={e=>setSearch(e.target.value)}
              autoFocus
            />
          )}
          <button
            className={`toolbar-btn ${showPinned?'active':''}`}
            onClick={()=>setShowPinned(s=>!s)}
          >
            📌 {pinnedMsgs.length}
          </button>
          <button
            className="toolbar-btn"
            onClick={()=>{ if(window.confirm('Clear all messages?')) setMessages([]); }}
          >
            🗑 CLEAR
          </button>
        </div>

        {/* Pinned messages */}
        {showPinned && pinnedList.length > 0 && (
          <div className="pinned-banner">
            <div className="pinned-header" onClick={()=>setShowPinned(false)}>
              <span>📌 PINNED ({pinnedList.length})</span>
              <span>▲</span>
            </div>
            {pinnedList.map(m=>(
              <div key={m.id} className="pinned-item">
                <span className="pinned-pin">📌</span>
                <span className="pinned-text">
                  <span style={{color:'#00FF88',marginRight:6}}>{m.senderName?.toUpperCase()}</span>
                  {m.text}
                </span>
                <span style={{cursor:'pointer',color:'#446644',fontSize:11}} onClick={()=>togglePin(m.id)}>✕</span>
              </div>
            ))}
          </div>
        )}

        {/* Channel selector */}
        <div className="channel-bar">
          <button className={`ch-btn ${!targetNodeId?'active':''}`} onClick={()=>setTargetNodeId(null)}>
            <span className="ch-dot" style={{background:'#FF3333',boxShadow:!targetNodeId?'0 0 5px #FF3333':'none'}}/>
            ALL ({messages.length})
          </button>
          {peers.map(p => {
            const on = p.state==='connected';
            const peerMsgs = messages.filter(m=>m.senderId===p.nodeId).length;
            return (
              <button
                key={p.nodeId??p.socketId}
                className={`ch-btn ${targetNodeId===p.nodeId?'active':''}`}
                onClick={()=>setTargetNodeId(p.nodeId)}
              >
                <span className="ch-dot" style={{background:on?'#00FF88':'#FF6600',boxShadow:on?'0 0 4px #00FF88':'none'}}/>
                {(p.userName??p.nodeId?.slice(0,8)??'?').toUpperCase()}
                {peerMsgs>0&&<span style={{color:'#446644',fontSize:9,marginLeft:2}}>({peerMsgs})</span>}
              </button>
            );
          })}
        </div>

        {/* Messages */}
        <div className="msg-list">
          {displayMsgs.length === 0 ? (
            <div className="msg-empty">
              <div className="msg-empty-icon">⬡</div>
              <div style={{fontSize:12,letterSpacing:'0.3em',color:'#1a3a1a'}}>
                {showSearch && search ? `NO RESULTS FOR "${search.toUpperCase()}"` : 'AWAITING TRANSMISSION'}
              </div>
              <div style={{fontSize:10,color:'#0d2a0d',letterSpacing:'0.2em'}}>MESH NETWORK STANDBY</div>
            </div>
          ) : (
            displayMsgs.map((msg, i) => {
              const isOut  = msg.senderId === localNodeId;
              const isSos  = msg.isSos;
              const isPinned = pinnedMsgs.includes(msg.id);
              const hopColor = msg.hopCount<=2?'#00FF88':msg.hopCount<=4?'#FF6600':'#FF3333';
              const statusMap = { pending:'○ SENDING', sent:'✓ SENT', queued:'⋯ QUEUED' };
              const statusCol = { pending:'#FF6600', sent:'#00FF88', queued:'#FF6600' };

              // Date separator
              const prevMsg = displayMsgs[i-1];
              const showDate = !prevMsg || new Date(msg.timestamp).toDateString() !== new Date(prevMsg.timestamp).toDateString();
              const msgReactions = reactions[msg.id] || [];

              return (
                <div key={msg.id??i}>
                  {showDate && (
                    <div className="date-sep">
                      <div className="date-sep-line"/>
                      <span style={{whiteSpace:'nowrap'}}>{new Date(msg.timestamp).toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'}).toUpperCase()}</span>
                      <div className="date-sep-line"/>
                    </div>
                  )}
                  <div className={`msg-wrap ${isOut?'out':'in'}`}>
                    <div
                      className={`msg-bubble ${isOut?'out':'in'} ${isSos?'sos-msg':''} ${msg.id===newMsgId?'new':''} ${isPinned?'pinned-msg':''}`}
                      style={{position:'relative'}}
                    >
                      {/* Action buttons */}
                      <div className="msg-actions">
                        <button className="action-btn" onClick={()=>setShowReact(showReact===msg.id?null:msg.id)} title="React">😊</button>
                        <button className="action-btn" onClick={()=>togglePin(msg.id)} title="Pin">{isPinned?'📌':'📍'}</button>
                        <button className="action-btn" onClick={()=>{navigator.clipboard?.writeText(msg.text)}} title="Copy">⎘</button>
                      </div>

                      {/* Reaction picker */}
                      {showReact===msg.id && (
                        <div className="react-picker">
                          {EMOJIS.map(e=>(
                            <span key={e} className="react-emoji" onClick={()=>addReaction(msg.id,e)}>{e}</span>
                          ))}
                        </div>
                      )}

                      <div className="msg-meta">
                        {isSos && <span style={{fontSize:10,color:'#FF0000',border:'1px solid #FF000044',padding:'0 5px'}}>◈ SOS</span>}
                        {isPinned && <span style={{fontSize:10}}>📌</span>}
                        <span className="msg-sender" style={{color:isOut?'#00FF88':isSos?'#FF0000':'#AAFFCC'}}>
                          {isOut?`▶ ${msg.senderName?.toUpperCase()}` : `◀ ${msg.senderName?.toUpperCase()}`}
                        </span>
                        <span className="msg-time">{FMT.format(new Date(msg.timestamp))}</span>
                        {isOut && msg.status && (
                          <span className="msg-status" style={{color:statusCol[msg.status]??'#666'}}>{statusMap[msg.status]??''}</span>
                        )}
                      </div>

                      <div className="msg-text" style={{color:isSos?'#FF8888':'#fff'}}>{msg.text}</div>

                      {msg.hopCount > 0 && (
                        <div className="msg-hop">
                          ↻ {msg.hopCount} HOP{msg.hopCount>1?'S':''}&nbsp;
                          {Array.from({length:Math.min(msg.hopCount,7)}).map((_,j)=>(
                            <span key={j} style={{display:'inline-block',width:4,height:4,borderRadius:'50%',background:hopColor,opacity:1-j*0.12,marginRight:2}}/>
                          ))}
                        </div>
                      )}

                      {msgReactions.length > 0 && (
                        <div className="msg-reactions">
                          {msgReactions.map((e,i)=>(
                            <span key={i} className="reaction-chip" onClick={()=>addReaction(msg.id,e)}>{e}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} style={{height:1}}/>
        </div>

        {/* Typing indicator */}
        <div className="typing-bar">
          {typingNodes.length > 0 && (
            <span>
              {typingNodes.map(t=>t.name).join(', ').toUpperCase()} TYPING&nbsp;
              <span className="typing-dots"><span>•</span><span>•</span><span>•</span></span>
            </span>
          )}
        </div>

        {/* Offline queue */}
        {offlineQueue.length > 0 && (
          <div className="queue-banner">⋯ {offlineQueue.length} MSG{offlineQueue.length>1?'S':''} QUEUED — WILL SEND WHEN ROUTE AVAILABLE</div>
        )}

        {/* Input */}
        <div className="input-area">
          <div className="input-target">
            TO:&nbsp;
            <span style={{color:isBroadcast?'#FF3333':'#00FF88'}}>
              {isBroadcast?'⚠ ALL NODES (BROADCAST)':(peers.find(p=>p.nodeId===effectiveTarget)?.userName??effectiveTarget.slice(0,8)).toUpperCase()}
            </span>
            <span style={{float:'right',color:'#1a3a1a',fontSize:9}}>{connected.length} ONLINE</span>
          </div>
          <div className="input-row">
            <div className="input-wrap">
              <span className="input-prompt">&gt;_</span>
              <textarea
                ref={inputRef}
                className="msg-input"
                rows={2}
                value={input}
                onChange={e=>onInputChange(e.target.value)}
                onKeyDown={onKeyDown}
                maxLength={500}
                placeholder="ENTER MESSAGE..."
              />
            </div>
            <button className="send-btn" onClick={doSend} disabled={!input.trim()||sending}>
              <span style={{fontSize:16}}>▶</span>
              <span>SEND</span>
            </button>
          </div>
          <div className="input-hint">
            <span>ENTER=SEND &nbsp;·&nbsp; SHIFT+ENTER=NEWLINE</span>
            <span style={{color:input.length>400?'#FF6600':'#1a3a1a'}}>{input.length}/500</span>
          </div>
        </div>
      </div>
    </>
  );
}