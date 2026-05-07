'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT        = parseInt(process.env.PORT, 10) || 3001;
const NODE_ENV    = process.env.NODE_ENV || 'development';
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8080'];

const MAX_NODES_PER_ZONE = parseInt(process.env.MAX_NODES_PER_ZONE, 10) || 100;

// ─── In-memory state ──────────────────────────────────────────────────────────

/**
 * disasterZones : Map<zoneId, Zone>
 *
 * Zone = {
 *   id          : string
 *   createdAt   : number
 *   nodes       : Map<socketId, NodeInfo>
 * }
 *
 * NodeInfo = {
 *   socketId     : string
 *   nodeId       : string   – client-generated UUID (stable across reconnects)
 *   userName     : string
 *   location     : { lat: number, lng: number, label?: string }
 *   batteryLevel : number   – 0-100
 *   joinedAt     : number
 *   lastSeen     : number
 * }
 */
const disasterZones = new Map();

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();

app.use(cors({
  origin : CORS_ORIGIN,
  methods : ['GET', 'POST'],
  credentials : true,
}));

app.use(express.json({ limit: '16kb' }));

// Health / liveness
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), env: NODE_ENV });
});

// Zone snapshot (useful for initial dashboard / debug)
app.get('/zones', (_req, res) => {
  const snapshot = [];
  for (const [zoneId, zone] of disasterZones) {
    snapshot.push({
      zoneId,
      createdAt  : zone.createdAt,
      nodeCount  : zone.nodes.size,
      nodes      : Array.from(zone.nodes.values()).map(publicNode),
    });
  }
  res.json({ zones: snapshot });
});

app.get('/zones/:zoneId', (req, res) => {
  const zone = disasterZones.get(req.params.zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  res.json({
    zoneId     : zone.id,
    createdAt  : zone.createdAt,
    nodeCount  : zone.nodes.size,
    nodes      : Array.from(zone.nodes.values()).map(publicNode),
  });
});

// 404 catch-all
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─── HTTP + Socket.io servers ─────────────────────────────────────────────────

const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin      : CORS_ORIGIN,
    methods     : ['GET', 'POST'],
    credentials : true,
  },
  pingTimeout      : 60_000,
  pingInterval     : 25_000,
  upgradeTimeout   : 10_000,
  maxHttpBufferSize: 1e6,
  transports       : ['websocket', 'polling'],
});

// ─── Socket.io signaling ──────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Socket connected  id=${socket.id}  ip=${socket.handshake.address}`);

  // ── join-zone ──────────────────────────────────────────────────────────────
  //
  // Payload: { zoneId, nodeId, userName, location, batteryLevel }
  //
  // location = { lat, lng, label? }
  // batteryLevel = 0–100

  socket.on('join-zone', (payload, ack) => {
    const { zoneId, nodeId, userName, location, batteryLevel } = payload || {};

    // Validate required fields
    if (!zoneId || typeof zoneId !== 'string') {
      return ack?.({ ok: false, error: 'INVALID_ZONE_ID' });
    }
    if (!nodeId || typeof nodeId !== 'string') {
      return ack?.({ ok: false, error: 'INVALID_NODE_ID' });
    }
    if (!userName || typeof userName !== 'string') {
      return ack?.({ ok: false, error: 'INVALID_USER_NAME' });
    }
    // location is optional — nodes may not have a GPS fix yet
    if (location !== null && location !== undefined) {
      if (typeof location.lat !== 'number' || typeof location.lng !== 'number') {
        return ack?.({ ok: false, error: 'INVALID_LOCATION' });
      }
    }

    // Enforce capacity
    const zone = getOrCreateZone(zoneId);
    if (zone.nodes.size >= MAX_NODES_PER_ZONE) {
      return ack?.({ ok: false, error: 'ZONE_FULL' });
    }

    const nodeInfo = {
      socketId     : socket.id,
      nodeId       : sanitize(nodeId),
      userName     : sanitize(userName).slice(0, 64),
      location     : location
        ? {
            lat   : Number(location.lat),
            lng   : Number(location.lng),
            label : location.label ? sanitize(String(location.label)).slice(0, 128) : undefined,
          }
        : null,
      batteryLevel : clamp(Number(batteryLevel ?? 100), 0, 100),
      joinedAt     : Date.now(),
      lastSeen     : Date.now(),
    };

    // Store
    zone.nodes.set(socket.id, nodeInfo);
    socket.join(zoneId);
    socket.data.zoneId = zoneId;

    // Send the joining node the full current peer list (excluding itself)
    const peers = Array.from(zone.nodes.values())
      .filter(n => n.socketId !== socket.id)
      .map(publicNode);

    ack?.({ ok: true, peers });

    // Broadcast to every other node in the zone
    socket.to(zoneId).emit('node-joined', {
      zoneId,
      node : publicNode(nodeInfo),
    });

    console.log(`[zone:${zoneId}] node joined  nodeId=${nodeInfo.nodeId}  user=${nodeInfo.userName}  total=${zone.nodes.size}`);
  });

  // ── update-node ────────────────────────────────────────────────────────────
  //
  // A node can push updated location / battery without rejoining.
  // Payload: { location?, batteryLevel? }

  socket.on('update-node', (payload) => {
    const { zoneId } = socket.data;
    if (!zoneId) return;

    const zone = disasterZones.get(zoneId);
    if (!zone) return;

    const nodeInfo = zone.nodes.get(socket.id);
    if (!nodeInfo) return;

    if (payload?.location &&
        typeof payload.location.lat === 'number' &&
        typeof payload.location.lng === 'number') {
      nodeInfo.location = {
        lat   : Number(payload.location.lat),
        lng   : Number(payload.location.lng),
        label : payload.location.label
          ? sanitize(String(payload.location.label)).slice(0, 128)
          : nodeInfo.location?.label || "Unknown",
      };
    }

    if (typeof payload?.batteryLevel === 'number') {
      nodeInfo.batteryLevel = clamp(Number(payload.batteryLevel), 0, 100);
    }

    nodeInfo.lastSeen = Date.now();

    // Broadcast delta to peers
    socket.to(zoneId).emit('node-updated', {
      zoneId,
      node : publicNode(nodeInfo),
    });
  });

  // ── WebRTC offer ───────────────────────────────────────────────────────────
  //
  // Payload: { targetSocketId, offer }

  socket.on('offer', ({ targetSocketId, offer } = {}) => {
    if (!targetSocketId || !isValidSdp(offer)) return;
    if (!inSameZone(socket.id, targetSocketId)) return;

    io.to(targetSocketId).emit('offer', {
      fromSocketId : socket.id,
      offer,
    });
  });

  // ── WebRTC answer ──────────────────────────────────────────────────────────
  //
  // Payload: { targetSocketId, answer }

  socket.on('answer', ({ targetSocketId, answer } = {}) => {
    if (!targetSocketId || !isValidSdp(answer)) return;
    if (!inSameZone(socket.id, targetSocketId)) return;

    io.to(targetSocketId).emit('answer', {
      fromSocketId : socket.id,
      answer,
    });
  });

  // ── ICE candidate ──────────────────────────────────────────────────────────
  //
  // Payload: { targetSocketId, candidate }

  socket.on('ice-candidate', ({ targetSocketId, candidate } = {}) => {
    if (!targetSocketId || !candidate) return;
    if (!inSameZone(socket.id, targetSocketId)) return;

    io.to(targetSocketId).emit('ice-candidate', {
      fromSocketId : socket.id,
      candidate,
    });
  });

  // ── leave-zone (explicit) ─────────────────────────────────────────────────

  socket.on('leave-zone', () => {
    handleNodeLeave(socket);
  });

  // ── disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    console.log(`[-] Socket disconnected  id=${socket.id}  reason=${reason}`);
    handleNodeLeave(socket);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getOrCreateZone(zoneId) {
  if (!disasterZones.has(zoneId)) {
    disasterZones.set(zoneId, {
      id        : zoneId,
      createdAt : Date.now(),
      nodes     : new Map(),
    });
  }
  return disasterZones.get(zoneId);
}

function handleNodeLeave(socket) {
  const { zoneId } = socket.data;
  if (!zoneId) return;

  const zone = disasterZones.get(zoneId);
  if (!zone) return;

  const nodeInfo = zone.nodes.get(socket.id);
  if (!nodeInfo) return;

  zone.nodes.delete(socket.id);
  socket.leave(zoneId);

  // Broadcast departure to remaining nodes
  io.to(zoneId).emit('node-left', {
    zoneId,
    socketId : socket.id,
    nodeId   : nodeInfo.nodeId,
    userName : nodeInfo.userName,
  });

  console.log(`[zone:${zoneId}] node left  nodeId=${nodeInfo.nodeId}  user=${nodeInfo.userName}  remaining=${zone.nodes.size}`);

  // Destroy empty zones to free memory
  if (zone.nodes.size === 0) {
    disasterZones.delete(zoneId);
    console.log(`[zone:${zoneId}] destroyed (empty)`);
  }

  socket.data.zoneId = null;
}

/** Strip keys not meant for peers */
function publicNode({ socketId, nodeId, userName, location, batteryLevel, joinedAt, lastSeen }) {
  return { socketId, nodeId, userName, location, batteryLevel, joinedAt, lastSeen };
}

/** Basic HTML-entity sanitizer */
function sanitize(str) {
  return String(str).replace(/[<>"'`]/g, c => ({
    '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;',
  }[c]));
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

function isValidSdp(sdp) {
  return sdp && typeof sdp.type === 'string' && typeof sdp.sdp === 'string';
}

function inSameZone(socketIdA, socketIdB) {
  const sockA = io.sockets.sockets.get(socketIdA);
  const sockB = io.sockets.sockets.get(socketIdB);
  if (!sockA || !sockB) return false;
  return sockA.data.zoneId &&
         sockA.data.zoneId === sockB.data.zoneId;
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n[!] ${signal} received — shutting down…`);
  io.emit('server-shutdown', { message: 'Signaling server is restarting. Mesh links remain active.' });

  setTimeout(() => {
    io.close(() => {
      httpServer.close(() => {
        console.log('[✓] Clean shutdown complete');
        process.exit(0);
      });
    });
  }, 1200);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[!] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[!] Uncaught exception:', err);
  shutdown('uncaughtException');
});

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║        MeshNet Signaling Server              ║
╠══════════════════════════════════════════════╣
║  Port    : ${String(PORT).padEnd(34)}║
║  Env     : ${NODE_ENV.padEnd(34)}║
║  CORS    : ${CORS_ORIGIN[0].slice(0, 34).padEnd(34)}║
╚══════════════════════════════════════════════╝
`);
});

module.exports = { httpServer, io }; // exported for tests