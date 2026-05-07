'use strict';

/**
 * Router.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Mesh routing engine for MeshNet.
 *
 * Responsibilities:
 *  - Maintain a weighted graph of all known nodes and their link costs
 *  - Run Dijkstra to compute shortest paths on demand
 *  - Route incoming messages: deliver locally OR forward to next hop
 *  - Enforce TTL (max 7 hops) and deduplicate seen message IDs
 *  - Support broadcast (SOS) mode — flood to all reachable nodes
 *  - Update routing table automatically on node join / leave / update
 *
 * Integration:
 *   WebRTCManager calls → router.receive(msg, fromSocketId, nodeInfo)
 *   Router calls        → webrtcManager.sendTo(socketId, msg)
 *   Router emits        → 'message'  for locally-delivered packets
 *                         'routed'   when this node forwarded a packet
 *                         'dropped'  when TTL=0 or loop detected
 *                         'sos'      for broadcast messages delivered here
 *
 * Message schema:
 *   {
 *     messageId : string,   // UUID — unique per original message
 *     senderId  : string,   // nodeId of origin
 *     targetId  : string,   // nodeId of destination  OR  '__BROADCAST__'
 *     hopCount  : number,   // incremented at each hop (starts at 0)
 *     ttl       : number,   // decremented at each hop (starts at 7)
 *     payload   : any,      // application data
 *     timestamp : number,   // ms since epoch at origin
 *     path      : string[], // nodeIds traversed so far (for loop detection)
 *   }
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const BROADCAST_TARGET  = '__BROADCAST__';
export const DEFAULT_TTL       = 7;
export const MAX_SEEN_CACHE    = 2_000;   // max messageIds retained in memory
export const SEEN_TTL_MS       = 5 * 60_000; // 5 minutes — evict old seen IDs
export const LINK_BASE_COST    = 1;           // hop count cost per edge
export const INFINITY          = Infinity;

// ─── Tiny EventEmitter (same pattern as WebRTCManager) ───────────────────────

class EventEmitter {
  constructor() { this._listeners = new Map(); }
  on(event, fn)  { if (!this._listeners.has(event)) this._listeners.set(event, new Set()); this._listeners.get(event).add(fn); return this; }
  off(event, fn) { this._listeners.get(event)?.delete(fn); return this; }
  emit(event, ...args) { for (const fn of (this._listeners.get(event) ?? [])) { try { fn(...args); } catch (e) { console.error(`[Router] listener error "${event}":`, e); } } }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default class Router extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.localNodeId   – this node's nodeId
   * @param {string} opts.localSocketId – this node's socketId (for send calls)
   */
  constructor({ localNodeId, localSocketId } = {}) {
    super();

    if (!localNodeId)   throw new Error('localNodeId is required');
    if (!localSocketId) throw new Error('localSocketId is required');

    this._localNodeId   = localNodeId;
    this._localSocketId = localSocketId;

    /**
     * Graph adjacency: nodeId → Map<neighbourNodeId, cost>
     * Cost is currently hop-count (1 per edge) but can be replaced with
     * signal strength, battery level, etc.
     * @type {Map<string, Map<string, number>>}
     */
    this._graph = new Map();

    /**
     * nodeId → socketId mapping.
     * Needed to call webrtcManager.sendTo(socketId, msg).
     * @type {Map<string, string>}
     */
    this._nodeToSocket = new Map();

    /**
     * socketId → nodeId reverse mapping.
     * @type {Map<string, string>}
     */
    this._socketToNode = new Map();

    /**
     * nodeId → full NodeInfo (userName, location, batteryLevel, …)
     * @type {Map<string, object>}
     */
    this._nodeInfo = new Map();

    /**
     * Dijkstra result cache: targetNodeId → { cost, nextHopNodeId }
     * Invalidated whenever the graph changes.
     * @type {Map<string, { cost: number, nextHopNodeId: string|null }>}
     */
    this._routeCache = new Map();

    /**
     * Seen message IDs → timestamp first seen (ms).
     * Used to deduplicate forwarded messages.
     * @type {Map<string, number>}
     */
    this._seenMessages = new Map();

    /**
     * WebRTCManager reference (set via attachManager).
     */
    this._manager = null;

    // Add self to graph immediately
    this._addNodeToGraph(localNodeId);
    this._nodeToSocket.set(localNodeId, localSocketId);
    this._socketToNode.set(localSocketId, localNodeId);

    // Periodic seen-message cache eviction
    this._evictionTimer = setInterval(() => this._evictSeen(), 60_000);
    if (this._evictionTimer.unref) this._evictionTimer.unref();
  }

  // ─── Setup ──────────────────────────────────────────────────────────────────

  /**
   * Attach the WebRTCManager so the router can call sendTo().
   * Call this after creating both objects.
   * @param {object} manager – WebRTCManager instance
   */
  attachManager(manager) {
    this._manager = manager;

    // Wire manager events into the routing table
    manager.on('peer-connected',    ({ socketId, nodeId })     => this._onPeerConnected(socketId, nodeId));
    manager.on('peer-disconnected', ({ socketId })             => this._onPeerDisconnected(socketId));
    manager.on('peer-updated',      ({ socketId, nodeInfo })   => this._onPeerUpdated(socketId, nodeInfo));
    manager.on('peer-list-updated', (peers)                    => this._syncPeers(peers));
  }

  // ─── Public send API ─────────────────────────────────────────────────────────

  /**
   * Send a message to a specific node (unicast).
   * @param {string} targetNodeId
   * @param {any}    payload
   * @param {object} [opts]
   * @param {number} [opts.ttl=DEFAULT_TTL]
   * @returns {{ sent: boolean, messageId: string, nextHop: string|null }}
   */
  send(targetNodeId, payload, { ttl = DEFAULT_TTL } = {}) {
    const msg = this._buildMessage(targetNodeId, payload, ttl);
    this._markSeen(msg.messageId);
    return { ...this._dispatch(msg), messageId: msg.messageId };
  }

  /**
   * Send a broadcast (SOS) message to every reachable node.
   * Uses controlled flooding: each node forwards once per messageId.
   * @param {any}    payload
   * @param {object} [opts]
   * @param {number} [opts.ttl=DEFAULT_TTL]
   * @returns {{ messageId: string }}
   */
  broadcast(payload, { ttl = DEFAULT_TTL } = {}) {
    const msg = this._buildMessage(BROADCAST_TARGET, payload, ttl);
    this._markSeen(msg.messageId);
    this._flood(msg);
    return { messageId: msg.messageId };
  }

  // ─── Called by WebRTCManager on every incoming data-channel message ──────────

  /**
   * Entry point for all messages arriving from the mesh.
   * @param {object} msg          – full message object
   * @param {string} fromSocketId – socket of the immediate sender (previous hop)
   * @param {object} [nodeInfo]   – sender node metadata
   */
  receive(msg, fromSocketId, nodeInfo) {
    if (!this._validateMessage(msg)) {
      console.warn('[Router] Dropped malformed message', msg);
      return;
    }

    // Deduplicate
    if (this._hasSeen(msg.messageId)) {
      this.emit('dropped', { reason: 'duplicate', messageId: msg.messageId });
      return;
    }
    this._markSeen(msg.messageId);

    // TTL guard
    if (msg.ttl <= 0 || msg.hopCount >= DEFAULT_TTL) {
      this.emit('dropped', { reason: 'ttl-expired', messageId: msg.messageId, hopCount: msg.hopCount });
      return;
    }

    // Loop guard — don't route back through ourselves
    if (msg.path.includes(this._localNodeId)) {
      this.emit('dropped', { reason: 'loop', messageId: msg.messageId, path: msg.path });
      return;
    }

    // Decrement TTL & increment hop for next leg
    const forwarded = {
      ...msg,
      ttl      : msg.ttl - 1,
      hopCount : msg.hopCount + 1,
      path     : [...msg.path, this._localNodeId],
    };

    // Broadcast (SOS) — deliver locally AND flood
    if (msg.targetId === BROADCAST_TARGET) {
      this.emit('sos',     { message: msg, fromSocketId });
      this.emit('message', { message: msg, fromSocketId });
      this._flood(forwarded);
      return;
    }

    // Unicast — are we the destination?
    if (msg.targetId === this._localNodeId) {
      this.emit('message', { message: msg, fromSocketId });
      return;
    }

    // Not for us — forward toward destination
    this._dispatch(forwarded);
  }

  // ─── Routing table query ─────────────────────────────────────────────────────

  /**
   * Get the full routing table: targetNodeId → { cost, nextHopNodeId }.
   * Runs Dijkstra from localNodeId over the current graph.
   * @returns {Map<string, { cost: number, nextHopNodeId: string|null }>}
   */
  getRoutingTable() {
    const table = this._dijkstra(this._localNodeId);
    this._routeCache = table;
    return table;
  }

  /**
   * Get the next-hop nodeId towards targetNodeId.
   * Returns null if unreachable.
   * @param {string} targetNodeId
   * @returns {string|null}
   */
  nextHop(targetNodeId) {
    if (!this._routeCache.has(targetNodeId)) {
      this.getRoutingTable(); // rebuild
    }
    return this._routeCache.get(targetNodeId)?.nextHopNodeId ?? null;
  }

  /**
   * Return graph snapshot (for UI visualisation).
   * @returns {{ nodes: string[], edges: Array<{ from, to, cost }> }}
   */
  getGraphSnapshot() {
    const nodes = Array.from(this._graph.keys());
    const edges = [];
    const seen  = new Set();

    for (const [fromId, neighbours] of this._graph) {
      for (const [toId, cost] of neighbours) {
        const key = [fromId, toId].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ from: fromId, to: toId, cost });
        }
      }
    }
    return { nodes, edges };
  }

  /**
   * Return all known nodes and their info.
   * @returns {Array<{ nodeId, socketId, userName, location, batteryLevel }>}
   */
  getNodes() {
    return Array.from(this._nodeInfo.entries()).map(([nodeId, info]) => ({
      nodeId,
      socketId: this._nodeToSocket.get(nodeId) ?? null,
      ...info,
    }));
  }

  // ─── Graph management ────────────────────────────────────────────────────────

  _addNodeToGraph(nodeId) {
    if (!this._graph.has(nodeId)) {
      this._graph.set(nodeId, new Map());
    }
  }

  _removeNodeFromGraph(nodeId) {
    this._graph.delete(nodeId);
    // Remove all edges pointing to this node
    for (const neighbours of this._graph.values()) {
      neighbours.delete(nodeId);
    }
  }

  _addEdge(nodeIdA, nodeIdB, cost = LINK_BASE_COST) {
    this._addNodeToGraph(nodeIdA);
    this._addNodeToGraph(nodeIdB);
    this._graph.get(nodeIdA).set(nodeIdB, cost);
    this._graph.get(nodeIdB).set(nodeIdA, cost);
    this._invalidateCache();
  }

  _removeEdge(nodeIdA, nodeIdB) {
    this._graph.get(nodeIdA)?.delete(nodeIdB);
    this._graph.get(nodeIdB)?.delete(nodeIdA);
    this._invalidateCache();
  }

  _invalidateCache() {
    this._routeCache = new Map();
  }

  // ─── Manager event handlers ──────────────────────────────────────────────────

  _onPeerConnected(socketId, nodeId) {
    if (!nodeId) return;
    this._nodeToSocket.set(nodeId, socketId);
    this._socketToNode.set(socketId, nodeId);
    this._addEdge(this._localNodeId, nodeId, LINK_BASE_COST);
    this.emit('route-updated', this.getGraphSnapshot());
  }

  _onPeerDisconnected(socketId) {
    const nodeId = this._socketToNode.get(socketId);
    if (!nodeId) return;
    this._socketToNode.delete(socketId);
    this._nodeToSocket.delete(nodeId);
    this._nodeInfo.delete(nodeId);
    this._removeNodeFromGraph(nodeId);
    this.emit('route-updated', this.getGraphSnapshot());
  }

  _onPeerUpdated(socketId, nodeInfo) {
    const nodeId = this._socketToNode.get(socketId) ?? nodeInfo?.nodeId;
    if (!nodeId) return;
    this._nodeInfo.set(nodeId, { ...this._nodeInfo.get(nodeId), ...nodeInfo });
    // Optionally reweight edge by battery level (lower battery = higher cost)
    // this._adjustEdgeCost(nodeId, nodeInfo.batteryLevel);
    this.emit('peer-info-updated', { nodeId, nodeInfo: this._nodeInfo.get(nodeId) });
  }

  _syncPeers(peers) {
    // peers = [{ socketId, nodeId, userName, state, nodeInfo }]
    for (const peer of peers) {
      if (!peer.nodeId) continue;
      this._nodeToSocket.set(peer.nodeId, peer.socketId);
      this._socketToNode.set(peer.socketId, peer.nodeId);
      if (peer.nodeInfo) this._nodeInfo.set(peer.nodeId, peer.nodeInfo);
      if (peer.state === 'connected') {
        this._addEdge(this._localNodeId, peer.nodeId, LINK_BASE_COST);
      }
    }
  }

  // ─── Dijkstra ─────────────────────────────────────────────────────────────────

  /**
   * Classic Dijkstra using a simple min-priority queue (binary heap).
   * Returns a Map: nodeId → { cost, nextHopNodeId }
   * where nextHopNodeId is the immediate neighbour on the shortest path.
   *
   * @param {string} sourceNodeId
   * @returns {Map<string, { cost: number, nextHopNodeId: string|null }>}
   */
  _dijkstra(sourceNodeId) {
    const dist     = new Map();   // nodeId → shortest known distance from source
    const prev     = new Map();   // nodeId → previous nodeId on shortest path
    const visited  = new Set();
    const table    = new Map();

    // Initialise
    for (const nodeId of this._graph.keys()) {
      dist.set(nodeId, INFINITY);
      prev.set(nodeId, null);
    }
    dist.set(sourceNodeId, 0);

    // Min-heap: [cost, nodeId]
    const heap = new MinHeap((a, b) => a[0] - b[0]);
    heap.push([0, sourceNodeId]);

    while (!heap.isEmpty()) {
      const [currentCost, u] = heap.pop();

      if (visited.has(u)) continue;
      visited.add(u);

      const neighbours = this._graph.get(u);
      if (!neighbours) continue;

      for (const [v, weight] of neighbours) {
        if (visited.has(v)) continue;
        const alt = currentCost + weight;
        if (alt < dist.get(v)) {
          dist.set(v, alt);
          prev.set(v, u);
          heap.push([alt, v]);
        }
      }
    }

    // Build routing table: trace back next-hop from source
    for (const [nodeId] of dist) {
      if (nodeId === sourceNodeId) continue;
      if (dist.get(nodeId) === INFINITY) {
        table.set(nodeId, { cost: INFINITY, nextHopNodeId: null });
        continue;
      }

      // Walk back the prev chain to find the node immediately after source
      let cursor   = nodeId;
      let nextHop  = nodeId;
      while (prev.get(cursor) !== sourceNodeId && prev.get(cursor) !== null) {
        nextHop = cursor;
        cursor  = prev.get(cursor);
      }
      // cursor is now a direct neighbour of source (or the target itself)
      nextHop = prev.get(cursor) === sourceNodeId ? cursor : nextHop;

      table.set(nodeId, { cost: dist.get(nodeId), nextHopNodeId: nextHop });
    }

    return table;
  }

  // ─── Message dispatch ─────────────────────────────────────────────────────────

  /**
   * Forward a unicast message toward its destination.
   * @param {object} msg
   * @returns {{ sent: boolean, nextHop: string|null }}
   */
  _dispatch(msg) {
    const nextHopNodeId = this.nextHop(msg.targetId);

    if (!nextHopNodeId) {
      this.emit('dropped', { reason: 'no-route', messageId: msg.messageId, targetId: msg.targetId });
      return { sent: false, nextHop: null };
    }

    const nextHopSocketId = this._nodeToSocket.get(nextHopNodeId);
    if (!nextHopSocketId) {
      this.emit('dropped', { reason: 'no-socket', messageId: msg.messageId, nextHopNodeId });
      return { sent: false, nextHop: nextHopNodeId };
    }

    const sent = this._manager?.sendTo(nextHopSocketId, msg) ?? false;

    if (sent) {
      this.emit('routed', {
        messageId   : msg.messageId,
        targetId    : msg.targetId,
        nextHopNodeId,
        hopCount    : msg.hopCount,
        ttl         : msg.ttl,
      });
    } else {
      this.emit('dropped', { reason: 'send-failed', messageId: msg.messageId, nextHopNodeId });
    }

    return { sent, nextHop: nextHopNodeId };
  }

  /**
   * Flood a broadcast message to all DIRECTLY connected peers
   * (each peer will in turn flood to their peers, controlled by dedup).
   * @param {object} msg
   */
  _flood(msg) {
    if (msg.ttl <= 0) return;

    const directNeighbours = this._graph.get(this._localNodeId) ?? new Map();

    for (const [neighbourNodeId] of directNeighbours) {
      if (neighbourNodeId === this._localNodeId) continue;
      if (msg.path.includes(neighbourNodeId)) continue; // came from there

      const socketId = this._nodeToSocket.get(neighbourNodeId);
      if (!socketId) continue;

      this._manager?.sendTo(socketId, msg);
    }
  }

  // ─── Seen-message deduplication ──────────────────────────────────────────────

  _hasSeen(messageId) {
    return this._seenMessages.has(messageId);
  }

  _markSeen(messageId) {
    if (this._seenMessages.size >= MAX_SEEN_CACHE) {
      // Evict the oldest 20% when at capacity
      const evictCount = Math.floor(MAX_SEEN_CACHE * 0.2);
      const iter       = this._seenMessages.keys();
      for (let i = 0; i < evictCount; i++) {
        const { value, done } = iter.next();
        if (done) break;
        this._seenMessages.delete(value);
      }
    }
    this._seenMessages.set(messageId, Date.now());
  }

  _evictSeen() {
    const threshold = Date.now() - SEEN_TTL_MS;
    for (const [id, ts] of this._seenMessages) {
      if (ts < threshold) this._seenMessages.delete(id);
    }
  }

  // ─── Message construction ─────────────────────────────────────────────────────

  _buildMessage(targetId, payload, ttl) {
    return {
      messageId : crypto.randomUUID(),
      senderId  : this._localNodeId,
      targetId,
      hopCount  : 0,
      ttl,
      payload,
      timestamp : Date.now(),
      path      : [this._localNodeId],
    };
  }

  _validateMessage(msg) {
    return (
      msg &&
      typeof msg.messageId  === 'string' &&
      typeof msg.senderId   === 'string' &&
      typeof msg.targetId   === 'string' &&
      typeof msg.hopCount   === 'number' &&
      typeof msg.ttl        === 'number' &&
      typeof msg.timestamp  === 'number' &&
      Array.isArray(msg.path)
    );
  }

  // ─── Teardown ─────────────────────────────────────────────────────────────────

  destroy() {
    clearInterval(this._evictionTimer);
    this._graph.clear();
    this._nodeToSocket.clear();
    this._socketToNode.clear();
    this._nodeInfo.clear();
    this._routeCache.clear();
    this._seenMessages.clear();
    this._listeners.clear();
  }
}

// ─── MinHeap ──────────────────────────────────────────────────────────────────
// Generic binary min-heap used by Dijkstra.

class MinHeap {
  /**
   * @param {(a: T, b: T) => number} compareFn – negative means a < b
   */
  constructor(compareFn) {
    this._data    = [];
    this._compare = compareFn;
  }

  push(item) {
    this._data.push(item);
    this._bubbleUp(this._data.length - 1);
  }

  pop() {
    const top  = this._data[0];
    const last = this._data.pop();
    if (this._data.length > 0) {
      this._data[0] = last;
      this._siftDown(0);
    }
    return top;
  }

  isEmpty() { return this._data.length === 0; }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._compare(this._data[i], this._data[parent]) < 0) {
        [this._data[i], this._data[parent]] = [this._data[parent], this._data[i]];
        i = parent;
      } else break;
    }
  }

  _siftDown(i) {
    const n = this._data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this._compare(this._data[l], this._data[smallest]) < 0) smallest = l;
      if (r < n && this._compare(this._data[r], this._data[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [this._data[i], this._data[smallest]] = [this._data[smallest], this._data[i]];
      i = smallest;
    }
  }
}
