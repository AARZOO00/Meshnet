'use strict';

/**
 * MeshNode.js
 * ─────────────────────────────────────────────────────────────────────────────
 * High-level facade that combines WebRTCManager + Router into a single object
 * consumed by App.jsx.
 *
 * Responsibilities:
 *  - Own the node identity (nodeId, userName)
 *  - Instantiate and wire WebRTCManager + Router
 *  - Expose simple send/broadcast methods
 *  - Proxy events from both subsystems via a unified EventEmitter
 *  - Handle graceful shutdown
 *
 * Usage:
 *   const node = new MeshNode({ signalingUrl, nodeId, userName, zoneId });
 *   node.on('ready',            ({ peers }) => …);
 *   node.on('message',          ({ message, from }) => …);
 *   node.on('sos',              ({ message }) => …);
 *   node.on('peer-connected',   ({ nodeId, userName }) => …);
 *   node.on('peer-disconnected',({ nodeId }) => …);
 *   node.on('peers-updated',    (peers) => …);
 *   node.on('route-updated',    (graphSnapshot) => …);
 *   node.on('error',            (err) => …);
 *
 *   await node.start();
 *   node.sendChat('Hello mesh!');
 *   node.sendSOS({ emergencyType: 'MEDICAL', location, batteryLevel });
 *   node.destroy();
 */

import WebRTCManager from './WebRTCManager.js';
import Router, { BROADCAST_TARGET, DEFAULT_TTL } from './Router.js';

// ─── Tiny EventEmitter ────────────────────────────────────────────────────────
class EventEmitter {
  constructor() { this._listeners = new Map(); }
  on(ev, fn)   { if (!this._listeners.has(ev)) this._listeners.set(ev, new Set()); this._listeners.get(ev).add(fn); return this; }
  off(ev, fn)  { this._listeners.get(ev)?.delete(fn); return this; }
  emit(ev, ...a){ for (const fn of this._listeners.get(ev) ?? []) { try { fn(...a); } catch(e) { console.error(`[MeshNode] listener "${ev}":`, e); } } }
  removeAll()  { this._listeners.clear(); }
}

// ─── MeshNode ─────────────────────────────────────────────────────────────────
export default class MeshNode extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.signalingUrl
   * @param {string} opts.nodeId       – stable UUID for this device
   * @param {string} opts.userName
   * @param {string} opts.zoneId
   * @param {object} [opts.location]   – { lat, lng, label? }
   * @param {number} [opts.batteryLevel]
   */
  constructor({ signalingUrl, nodeId, userName, zoneId, location = null, batteryLevel = 100 }) {
    super();

    if (!signalingUrl) throw new Error('signalingUrl is required');
    if (!nodeId)       throw new Error('nodeId is required');
    if (!zoneId)       throw new Error('zoneId is required');

    this.nodeId       = nodeId;
    this.userName     = userName;
    this.zoneId       = zoneId;
    this.location     = location;
    this.batteryLevel = batteryLevel;

    this._manager = null;
    this._router  = null;
    this._started = false;
    this._sigUrl  = signalingUrl;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Boot the node: create Router + WebRTCManager, connect to signaling server.
   * @returns {Promise<{ peers: object[] }>}
   */
  async start() {
    if (this._started) throw new Error('MeshNode already started');
    this._started = true;

    // 1. Router (needs socketId — patched after connect)
    const router = new Router({
      localNodeId   : this.nodeId,
      localSocketId : 'pending',
    });
    this._router = router;

    // 2. Wire router events
    router.on('message',      (ev) => this.emit('message',      ev));
    router.on('sos',          (ev) => this.emit('sos',          ev));
    router.on('routed',       (ev) => this.emit('routed',       ev));
    router.on('dropped',      (ev) => this.emit('dropped',      ev));
    router.on('route-updated',(ev) => this.emit('route-updated',ev));

    // 3. WebRTCManager
    const manager = new WebRTCManager({
      signalingUrl : this._sigUrl,
      nodeInfo     : {
        nodeId       : this.nodeId,
        userName     : this.userName,
        location     : this.location,
        batteryLevel : this.batteryLevel,
      },
      zoneId : this.zoneId,
      router,
    });
    this._manager = manager;

    // 4. Wire manager events
    manager.on('peer-connected',    (ev) => this.emit('peer-connected',    ev));
    manager.on('peer-disconnected', (ev) => this.emit('peer-disconnected', ev));
    manager.on('peer-updated',      (ev) => this.emit('peer-updated',      ev));
    manager.on('peer-list-updated', (peers) => this.emit('peers-updated',  peers));
    manager.on('error',             (err) => this.emit('error',            err));
    manager.on('signaling-disconnected', (ev) => this.emit('signaling-disconnected', ev));
    manager.on('signaling-reconnected',  ()  => this.emit('signaling-reconnected'));

    // 5. Attach router ↔ manager
    router.attachManager(manager);

    // 6. Connect
    const result = await manager.connect();

    // 7. Patch router socketId now that we have it
    const socketId = result.socketId ?? manager._socket?.id;
    if (socketId) {
      router._localSocketId = socketId;
      router._nodeToSocket.set(this.nodeId, socketId);
      router._socketToNode.set(socketId, this.nodeId);
    }

    this.emit('ready', { socketId, peers: result.peers ?? [] });
    return result;
  }

  // ── Public send API ──────────────────────────────────────────────────────────

  /**
   * Send a chat message.
   * @param {string} text
   * @param {string|null} [targetNodeId]  null = broadcast
   */
  sendChat(text, targetNodeId = null) {
    if (!this._router) throw new Error('Node not started');
    const payload = { type: 'CHAT', text, senderName: this.userName };
    if (targetNodeId) {
      return this._router.send(targetNodeId, payload);
    }
    return this._router.broadcast(payload);
  }

  /**
   * Broadcast an SOS alert.
   * @param {{ emergencyType, location?, batteryLevel? }} opts
   */
  sendSOS({ emergencyType = 'MEDICAL', location, batteryLevel } = {}) {
    if (!this._router) throw new Error('Node not started');
    return this._router.broadcast({
      type         : 'SOS',
      userName     : this.userName,
      nodeId       : this.nodeId,
      location     : location ?? this.location,
      batteryLevel : batteryLevel ?? this.batteryLevel,
      emergencyType,
      timestamp    : Date.now(),
      broadcastSeq : 0,
    });
  }

  /**
   * Send any arbitrary payload via the router.
   * @param {string}      targetNodeId  or BROADCAST_TARGET
   * @param {object}      payload
   */
  send(targetNodeId, payload) {
    if (!this._router) throw new Error('Node not started');
    if (targetNodeId === BROADCAST_TARGET) return this._router.broadcast(payload);
    return this._router.send(targetNodeId, payload);
  }

  // ── Node info updates ────────────────────────────────────────────────────────

  updateLocation(location) {
    this.location = location;
    this._manager?.updateNodeInfo({ location });
  }

  updateBattery(batteryLevel) {
    this.batteryLevel = batteryLevel;
    this._manager?.updateNodeInfo({ batteryLevel });
  }

  updateUserName(userName) {
    this.userName = userName;
  }

  // ── Accessors ────────────────────────────────────────────────────────────────

  getPeers()        { return this._manager?.getPeers() ?? []; }
  getRouter()       { return this._router; }
  getManager()      { return this._manager; }
  getGraphSnapshot(){ return this._router?.getGraphSnapshot() ?? { nodes: [], edges: [] }; }
  getRoutingTable() { return this._router?.getRoutingTable() ?? new Map(); }
  getSocketId()     { return this._manager?._socket?.id ?? null; }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  destroy() {
    this._manager?.destroy();
    this._router?.destroy();
    this.removeAll();
    this._started = false;
  }
}

export { BROADCAST_TARGET, DEFAULT_TTL };
