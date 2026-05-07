'use strict';

/**
 * WebRTCManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages the full WebRTC mesh for MeshNet.
 *
 * Responsibilities:
 *  - Connect to the signaling server via Socket.io
 *  - Maintain one RTCPeerConnection + RTCDataChannel per remote node
 *  - Drive offer/answer/ICE exchange through the signaling server
 *  - Pass received data-channel messages to Router.js
 *  - Handle disconnection, ICE restarts, and graceful teardown
 *  - Support 10+ simultaneous peer connections
 *
 * Usage:
 *   import WebRTCManager from './WebRTCManager';
 *   import Router        from './Router';
 *
 *   const mgr = new WebRTCManager({
 *     signalingUrl : 'http://localhost:3001',
 *     nodeInfo     : { nodeId, userName, location, batteryLevel },
 *     zoneId       : 'zone-alpha',
 *     router       : new Router(),
 *   });
 *
 *   mgr.on('peer-connected',    ({ socketId, nodeId }) => …);
 *   mgr.on('peer-disconnected', ({ socketId, nodeId }) => …);
 *   mgr.on('peer-list-updated', (peers)               => …);
 *
 *   await mgr.connect();
 *   mgr.broadcast({ type: 'ALERT', payload: '…' });
 *   mgr.sendTo(socketId, { type: 'PING' });
 *   mgr.destroy();
 */

import { io } from 'socket.io-client';

// ─── Constants ────────────────────────────────────────────────────────────────

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Add TURN servers here for production deployments behind strict NATs:
  // { urls: 'turn:your-turn-server.com:3478', username: '…', credential: '…' }
];

const DC_LABEL            = 'meshnet';
const DC_MAX_RETRIES      = 5;
const DC_RETRY_BASE_MS    = 1_000;   // exponential back-off base
const ICE_RESTART_DELAY   = 3_000;
const HEARTBEAT_INTERVAL  = 15_000;
const HEARTBEAT_TIMEOUT   = 10_000;
const RECONNECT_MAX        = 6;
const RECONNECT_BASE_MS    = 2_000;

const CONNECTION_STATES = Object.freeze({
  NEW          : 'new',
  CONNECTING   : 'connecting',
  CONNECTED    : 'connected',
  DISCONNECTED : 'disconnected',
  FAILED       : 'failed',
  CLOSED       : 'closed',
});

// ─── Tiny EventEmitter ────────────────────────────────────────────────────────

class EventEmitter {
  constructor() { this._listeners = new Map(); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return this;
  }

  off(event, fn) {
    this._listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of (this._listeners.get(event) ?? [])) {
      try { fn(...args); } catch (e) { console.error(`[WebRTCManager] listener error on "${event}":`, e); }
    }
  }
}

// ─── PeerEntry ────────────────────────────────────────────────────────────────
// Internal state per remote peer.

class PeerEntry {
  constructor(socketId, nodeInfo) {
    this.socketId          = socketId;
    this.nodeInfo          = nodeInfo;          // { nodeId, userName, location, batteryLevel, … }
    this.pc                = null;              // RTCPeerConnection
    this.dc                = null;              // RTCDataChannel (our outbound channel)
    this.state             = CONNECTION_STATES.NEW;
    this.isPolite          = false;             // perfect-negotiation role
    this.makingOffer       = false;
    this.ignoreOffer       = false;
    this.pendingCandidates = [];                // queued before remote desc is set
    this.reconnectAttempts = 0;
    this.iceRestartTimer   = null;
    this.heartbeatTimer    = null;
    this.heartbeatAckTimer = null;
    this.dcRetries         = 0;
  }

  get nodeId()   { return this.nodeInfo?.nodeId; }
  get userName() { return this.nodeInfo?.userName; }
}

// ─── WebRTCManager ───────────────────────────────────────────────────────────

export default class WebRTCManager extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {string}   opts.signalingUrl  – Socket.io server URL
   * @param {object}   opts.nodeInfo      – { nodeId, userName, location, batteryLevel }
   * @param {string}   opts.zoneId        – disaster zone identifier
   * @param {object}   opts.router        – Router instance (must expose .receive(msg, fromSocketId))
   * @param {object[]} [opts.iceServers]  – override default ICE servers
   */
  constructor({ signalingUrl, nodeInfo, zoneId, router, iceServers } = {}) {
    super();

    if (!signalingUrl) throw new Error('signalingUrl is required');
    if (!nodeInfo?.nodeId) throw new Error('nodeInfo.nodeId is required');
    if (!zoneId)     throw new Error('zoneId is required');
    if (!router)     throw new Error('router is required');

    this._signalingUrl  = signalingUrl;
    this._nodeInfo      = nodeInfo;
    this._zoneId        = zoneId;
    this._router        = router;
    this._iceServers    = iceServers ?? ICE_SERVERS;

    /** @type {Map<string, PeerEntry>}  socketId → PeerEntry */
    this._peers = new Map();

    this._socket    = null;
    this._destroyed = false;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Connect to the signaling server and join the zone.
   * Resolves once the `join-zone` ACK is received.
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this._destroyed) return reject(new Error('Manager has been destroyed'));

      this._socket = io(this._signalingUrl, {
        transports       : ['websocket', 'polling'],
        reconnection     : true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1_500,
        timeout          : 10_000,
      });

      this._registerSignalingEvents();

      this._socket.once('connect', () => {
        this._socket.emit(
          'join-zone',
          {
            zoneId       : this._zoneId,
            nodeId       : this._nodeInfo.nodeId,
            userName     : this._nodeInfo.userName,
            location     : this._nodeInfo.location,
            batteryLevel : this._nodeInfo.batteryLevel,
          },
          (ack) => {
            if (!ack?.ok) {
              const err = new Error(ack?.error ?? 'join-zone failed');
              this.emit('error', err);
              return reject(err);
            }

            // Initiate connections to every pre-existing peer
            for (const peer of (ack.peers ?? [])) {
              this._initPeer(peer.socketId, peer, /* isOfferer */ true);
            }

            this.emit('connected', { socketId: this._socket.id });
            resolve({ socketId: this._socket.id, peers: ack.peers });
          }
        );
      });

      this._socket.once('connect_error', (err) => {
        reject(new Error(`Signaling connect error: ${err.message}`));
      });
    });
  }

  /**
   * Send a message to a specific peer via their data channel.
   * @param {string} socketId
   * @param {object} message
   * @returns {boolean} true if enqueued / sent
   */
  sendTo(socketId, message) {
    const entry = this._peers.get(socketId);
    if (!entry) return false;
    return this._dcSend(entry, message);
  }

  /**
   * Broadcast a message to ALL connected peers.
   * @param {object} message
   */
  broadcast(message) {
    for (const entry of this._peers.values()) {
      this._dcSend(entry, message);
    }
  }

  /**
   * Update this node's metadata (location / battery).
   * Pushes the update to the signaling server, which relays it to all peers.
   * @param {{ location?, batteryLevel? }} update
   */
  updateNodeInfo(update) {
    Object.assign(this._nodeInfo, update);
    this._socket?.emit('update-node', update);
  }

  /**
   * Return a snapshot of all known peers.
   * @returns {Array<{ socketId, nodeId, userName, state }>}
   */
  getPeers() {
    return Array.from(this._peers.values()).map(e => ({
      socketId     : e.socketId,
      nodeId       : e.nodeId,
      userName     : e.userName,
      state        : e.state,
      nodeInfo     : { ...e.nodeInfo },
    }));
  }

  /**
   * Cleanly close all peer connections and the signaling socket.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    for (const [socketId] of this._peers) {
      this._closePeer(socketId, 'destroy');
    }

    if (this._socket) {
      this._socket.emit('leave-zone');
      this._socket.disconnect();
      this._socket = null;
    }

    this.emit('destroyed');
    this._listeners.clear();
  }

  // ─── Signaling event wiring ──────────────────────────────────────────────────

  _registerSignalingEvents() {
    const s = this._socket;

    s.on('connect', () => {
      console.info('[WebRTCManager] Signaling socket reconnected');
      this.emit('signaling-reconnected');
    });

    s.on('disconnect', (reason) => {
      console.warn('[WebRTCManager] Signaling socket disconnected:', reason);
      this.emit('signaling-disconnected', { reason });
      // Individual peer connections survive — they are P2P
    });

    // A new node entered the zone
    s.on('node-joined', ({ node }) => {
      if (node.socketId === s.id) return;
      // The new node will send us an offer; we wait (polite peer)
      this._initPeer(node.socketId, node, /* isOfferer */ false);
      this.emit('peer-list-updated', this.getPeers());
    });

    // A node left the zone
    s.on('node-left', ({ socketId }) => {
      this._closePeer(socketId, 'remote-leave');
      this.emit('peer-list-updated', this.getPeers());
    });

    // Node metadata update
    s.on('node-updated', ({ node }) => {
      const entry = this._peers.get(node.socketId);
      if (entry) {
        entry.nodeInfo = { ...entry.nodeInfo, ...node };
        this.emit('peer-updated', { socketId: node.socketId, nodeInfo: entry.nodeInfo });
      }
    });

    // WebRTC signaling messages
    s.on('offer',         (data) => this._handleOffer(data));
    s.on('answer',        (data) => this._handleAnswer(data));
    s.on('ice-candidate', (data) => this._handleIceCandidate(data));

    s.on('server-shutdown', () => {
      console.warn('[WebRTCManager] Signaling server shutting down — mesh P2P links remain active');
      this.emit('signaling-shutdown');
    });
  }

  // ─── Peer lifecycle ──────────────────────────────────────────────────────────

  _initPeer(socketId, nodeInfo, isOfferer) {
    if (this._peers.has(socketId)) return this._peers.get(socketId);

    const entry       = new PeerEntry(socketId, nodeInfo);
    entry.isPolite    = !isOfferer; // impolite = offerer, polite = answerer
    this._peers.set(socketId, entry);

    this._createPeerConnection(entry);

    if (isOfferer) {
      this._createDataChannel(entry);
      this._negotiate(entry);
    }

    this.emit('peer-list-updated', this.getPeers());
    return entry;
  }

  _createPeerConnection(entry) {
    const pc = new RTCPeerConnection({ iceServers: this._iceServers });
    entry.pc    = pc;
    entry.state = CONNECTION_STATES.CONNECTING;

    // ── ICE candidate ─────────────────────────────────────────────────────────
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      this._socket?.emit('ice-candidate', {
        targetSocketId : entry.socketId,
        candidate,
      });
    };

    // ── ICE connection state ──────────────────────────────────────────────────
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.debug(`[WebRTCManager] ICE ${entry.socketId.slice(0,6)} → ${s}`);

      if (s === 'failed') {
        this._scheduleIceRestart(entry);
      } else if (s === 'disconnected') {
        // Give it a moment before deciding it's dead
        entry.iceRestartTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') {
            this._scheduleIceRestart(entry);
          }
        }, ICE_RESTART_DELAY);
      } else if (s === 'connected' || s === 'completed') {
        clearTimeout(entry.iceRestartTimer);
        entry.reconnectAttempts = 0;
      }
    };

    // ── Peer connection state ─────────────────────────────────────────────────
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.debug(`[WebRTCManager] PC ${entry.socketId.slice(0,6)} → ${s}`);

      switch (s) {
        case 'connected':
          entry.state = CONNECTION_STATES.CONNECTED;
          this._startHeartbeat(entry);
          this.emit('peer-connected', { socketId: entry.socketId, nodeId: entry.nodeId, userName: entry.userName });
          this.emit('peer-list-updated', this.getPeers());
          break;

        case 'disconnected':
          entry.state = CONNECTION_STATES.DISCONNECTED;
          this._stopHeartbeat(entry);
          this.emit('peer-disconnected', { socketId: entry.socketId, nodeId: entry.nodeId });
          this.emit('peer-list-updated', this.getPeers());
          break;

        case 'failed':
          entry.state = CONNECTION_STATES.FAILED;
          this._stopHeartbeat(entry);
          this._attemptReconnect(entry);
          break;

        case 'closed':
          entry.state = CONNECTION_STATES.CLOSED;
          this._stopHeartbeat(entry);
          break;
      }
    };

    // ── Incoming data channel (answerer side) ─────────────────────────────────
    pc.ondatachannel = ({ channel }) => {
      if (channel.label !== DC_LABEL) return;
      this._wireDataChannel(entry, channel);
    };

    // ── Perfect negotiation — onnegotiationneeded ─────────────────────────────
    pc.onnegotiationneeded = async () => {
      await this._negotiate(entry);
    };

    return pc;
  }

  // ─── DataChannel ─────────────────────────────────────────────────────────────

  _createDataChannel(entry) {
    const dc = entry.pc.createDataChannel(DC_LABEL, {
      ordered  : true,
      protocol : 'meshnet-v1',
    });
    this._wireDataChannel(entry, dc);
    return dc;
  }

  _wireDataChannel(entry, channel) {
    entry.dc = channel;
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      console.info(`[WebRTCManager] DataChannel open ↔ ${entry.userName ?? entry.socketId.slice(0,6)}`);
      entry.dcRetries = 0;
      entry.state     = CONNECTION_STATES.CONNECTED;
      this.emit('channel-open', { socketId: entry.socketId, nodeId: entry.nodeId });
    };

    channel.onclose = () => {
      console.warn(`[WebRTCManager] DataChannel closed ↔ ${entry.socketId.slice(0,6)}`);
      // Only retry if the peer connection itself is still alive
      if (entry.pc?.connectionState === 'connected') {
        this._retryDataChannel(entry);
      }
    };

    channel.onerror = (ev) => {
      const detail = ev?.error?.message ?? 'unknown';
      console.error(`[WebRTCManager] DataChannel error (${entry.socketId.slice(0,6)}): ${detail}`);
      this.emit('channel-error', { socketId: entry.socketId, error: detail });
    };

    channel.onmessage = ({ data }) => {
      this._handleDataChannelMessage(entry, data);
    };
  }

  _retryDataChannel(entry) {
    if (entry.dcRetries >= DC_MAX_RETRIES) {
      console.error(`[WebRTCManager] DC retry limit reached for ${entry.socketId.slice(0,6)}`);
      this._attemptReconnect(entry);
      return;
    }
    const delay = DC_RETRY_BASE_MS * 2 ** entry.dcRetries;
    entry.dcRetries += 1;
    console.info(`[WebRTCManager] Retrying DC in ${delay}ms (attempt ${entry.dcRetries})`);
    setTimeout(() => {
      if (entry.pc?.connectionState === 'connected') {
        this._createDataChannel(entry);
      }
    }, delay);
  }

  // ─── Incoming data-channel message ───────────────────────────────────────────

  _handleDataChannelMessage(entry, data) {
    let msg;
    try {
      msg = typeof data === 'string'
        ? JSON.parse(data)
        : JSON.parse(new TextDecoder().decode(data));
    } catch (e) {
      console.warn('[WebRTCManager] Failed to parse incoming message:', e);
      return;
    }

    // Internal heartbeat handling
    if (msg?.__type === '__heartbeat_ping') {
      this._dcSendRaw(entry, JSON.stringify({ __type: '__heartbeat_pong', ts: msg.ts }));
      return;
    }
    if (msg?.__type === '__heartbeat_pong') {
      clearTimeout(entry.heartbeatAckTimer);
      return;
    }

    // Delegate to Router
    try {
      this._router.receive(msg, entry.socketId, entry.nodeInfo);
    } catch (e) {
      console.error('[WebRTCManager] Router.receive threw:', e);
    }

    this.emit('message', { from: entry.socketId, nodeInfo: entry.nodeInfo, message: msg });
  }

  // ─── Offer / Answer / ICE ─────────────────────────────────────────────────────

  async _negotiate(entry) {
    const pc = entry.pc;
    if (!pc || pc.signalingState === 'closed') return;

    try {
      entry.makingOffer = true;
      await pc.setLocalDescription();                           // browser generates offer
      this._socket?.emit('offer', {
        targetSocketId : entry.socketId,
        offer          : pc.localDescription,
      });
    } catch (e) {
      console.error(`[WebRTCManager] _negotiate error (${entry.socketId.slice(0,6)}):`, e);
    } finally {
      entry.makingOffer = false;
    }
  }

  async _handleOffer({ fromSocketId, offer }) {
    // Lazily create an entry for peers who joined before us
    let entry = this._peers.get(fromSocketId);
    if (!entry) {
      entry = this._initPeer(fromSocketId, { socketId: fromSocketId }, /* isOfferer */ false);
    }

    const pc             = entry.pc;
    const offerCollision = offer.type === 'offer' &&
                           (entry.makingOffer || pc.signalingState !== 'stable');

    entry.ignoreOffer = !entry.isPolite && offerCollision;
    if (entry.ignoreOffer) return;

    try {
      if (offerCollision) {
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }),
          pc.setRemoteDescription(offer),
        ]);
      } else {
        await pc.setRemoteDescription(offer);
      }

      // Flush queued candidates
      await this._flushPendingCandidates(entry);

      await pc.setLocalDescription();
      this._socket?.emit('answer', {
        targetSocketId : fromSocketId,
        answer         : pc.localDescription,
      });
    } catch (e) {
      console.error(`[WebRTCManager] _handleOffer error (${fromSocketId.slice(0,6)}):`, e);
    }
  }

  async _handleAnswer({ fromSocketId, answer }) {
    const entry = this._peers.get(fromSocketId);
    if (!entry) return;

    if (entry.pc.signalingState === 'closed') return;

    try {
      await entry.pc.setRemoteDescription(answer);
      await this._flushPendingCandidates(entry);
    } catch (e) {
      console.error(`[WebRTCManager] _handleAnswer error (${fromSocketId.slice(0,6)}):`, e);
    }
  }

  async _handleIceCandidate({ fromSocketId, candidate }) {
    const entry = this._peers.get(fromSocketId);
    if (!entry) return;

    if (!entry.pc.remoteDescription) {
      // Queue — remote description not yet set
      entry.pendingCandidates.push(candidate);
      return;
    }

    try {
      await entry.pc.addIceCandidate(candidate);
    } catch (e) {
      if (!entry.ignoreOffer) {
        console.warn(`[WebRTCManager] addIceCandidate error (${fromSocketId.slice(0,6)}):`, e);
      }
    }
  }

  async _flushPendingCandidates(entry) {
    while (entry.pendingCandidates.length) {
      const c = entry.pendingCandidates.shift();
      try {
        await entry.pc.addIceCandidate(c);
      } catch (e) {
        console.warn('[WebRTCManager] flush candidate error:', e);
      }
    }
  }

  // ─── ICE restart ─────────────────────────────────────────────────────────────

  _scheduleIceRestart(entry) {
    if (entry.reconnectAttempts >= RECONNECT_MAX) {
      console.error(`[WebRTCManager] Max ICE restarts reached for ${entry.socketId.slice(0,6)}`);
      this._closePeer(entry.socketId, 'max-restarts');
      return;
    }

    const delay = RECONNECT_BASE_MS * 2 ** entry.reconnectAttempts;
    entry.reconnectAttempts += 1;
    console.info(`[WebRTCManager] ICE restart in ${delay}ms (attempt ${entry.reconnectAttempts})`);

    clearTimeout(entry.iceRestartTimer);
    entry.iceRestartTimer = setTimeout(async () => {
      if (!entry.pc || entry.pc.connectionState === 'closed') return;
      try {
        const offer = await entry.pc.createOffer({ iceRestart: true });
        await entry.pc.setLocalDescription(offer);
        this._socket?.emit('offer', {
          targetSocketId : entry.socketId,
          offer          : entry.pc.localDescription,
        });
      } catch (e) {
        console.error('[WebRTCManager] ICE restart failed:', e);
      }
    }, delay);
  }

  // ─── Full peer reconnect (when ICE restart isn't enough) ─────────────────────

  _attemptReconnect(entry) {
    if (entry.reconnectAttempts >= RECONNECT_MAX) {
      console.error(`[WebRTCManager] Giving up on ${entry.socketId.slice(0,6)}`);
      this._closePeer(entry.socketId, 'failed');
      return;
    }

    const delay = RECONNECT_BASE_MS * 2 ** entry.reconnectAttempts;
    entry.reconnectAttempts += 1;

    console.info(`[WebRTCManager] Full reconnect to ${entry.socketId.slice(0,6)} in ${delay}ms (attempt ${entry.reconnectAttempts})`);

    setTimeout(() => {
      if (this._destroyed || !this._peers.has(entry.socketId)) return;

      // Tear down old PC, keep entry
      this._teardownPeerConnection(entry);
      this._createPeerConnection(entry);
      this._createDataChannel(entry);
      this._negotiate(entry);
    }, delay);
  }

  // ─── Heartbeat (P2P keep-alive) ───────────────────────────────────────────────

  _startHeartbeat(entry) {
    this._stopHeartbeat(entry);

    entry.heartbeatTimer = setInterval(() => {
      if (entry.dc?.readyState !== 'open') return;

      const ping = JSON.stringify({ __type: '__heartbeat_ping', ts: Date.now() });
      this._dcSendRaw(entry, ping);

      entry.heartbeatAckTimer = setTimeout(() => {
        console.warn(`[WebRTCManager] Heartbeat timeout for ${entry.socketId.slice(0,6)}`);
        this._scheduleIceRestart(entry);
      }, HEARTBEAT_TIMEOUT);
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat(entry) {
    clearInterval(entry.heartbeatTimer);
    clearTimeout(entry.heartbeatAckTimer);
    entry.heartbeatTimer    = null;
    entry.heartbeatAckTimer = null;
  }

  // ─── Send helpers ─────────────────────────────────────────────────────────────

  _dcSend(entry, message) {
    if (!entry.dc || entry.dc.readyState !== 'open') {
      console.warn(`[WebRTCManager] DC not open for ${entry.socketId.slice(0,6)} (${entry.dc?.readyState ?? 'null'})`);
      return false;
    }
    try {
      entry.dc.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error('[WebRTCManager] send error:', e);
      return false;
    }
  }

  _dcSendRaw(entry, str) {
    try {
      if (entry.dc?.readyState === 'open') entry.dc.send(str);
    } catch (_) { /* swallow heartbeat send errors */ }
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────────

  _teardownPeerConnection(entry) {
    clearTimeout(entry.iceRestartTimer);
    this._stopHeartbeat(entry);

    if (entry.dc) {
      entry.dc.onopen    = null;
      entry.dc.onclose   = null;
      entry.dc.onerror   = null;
      entry.dc.onmessage = null;
      try { entry.dc.close(); } catch (_) {}
      entry.dc = null;
    }

    if (entry.pc) {
      entry.pc.onicecandidate            = null;
      entry.pc.oniceconnectionstatechange = null;
      entry.pc.onconnectionstatechange   = null;
      entry.pc.ondatachannel             = null;
      entry.pc.onnegotiationneeded       = null;
      try { entry.pc.close(); } catch (_) {}
      entry.pc = null;
    }

    entry.pendingCandidates = [];
    entry.makingOffer       = false;
    entry.ignoreOffer       = false;
  }

  _closePeer(socketId, reason) {
    const entry = this._peers.get(socketId);
    if (!entry) return;

    console.info(`[WebRTCManager] Closing peer ${socketId.slice(0,6)} (${reason})`);

    this._teardownPeerConnection(entry);
    entry.state = CONNECTION_STATES.CLOSED;
    this._peers.delete(socketId);

    this.emit('peer-disconnected', { socketId, nodeId: entry.nodeId, reason });
    this.emit('peer-list-updated', this.getPeers());
  }
}
