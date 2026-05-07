'use strict';

/**
 * BluetoothManager.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Web Bluetooth Low Energy transport for MeshNet.
 *
 * Acts as a secondary transport when WiFi/WebRTC is unavailable.
 * Uses a custom GATT service to exchange mesh message payloads between
 * devices over BLE (~10–50m range).
 *
 * Architecture:
 *  - Each device acts as both a GATT Central (scanner) and Peripheral (advertiser)
 *  - Central role: scans, connects, reads/subscribes to remote characteristic
 *  - Peripheral role: not natively supported in Web BT — simulated via
 *    a shared "relay" characteristic that peers poll
 *
 * Limitations of Web Bluetooth API:
 *  - Cannot advertise (peripheral mode) — browsers cannot act as BLE servers
 *  - Only Central (client) role is available
 *  - Requires user gesture to initiate scan (requestDevice)
 *  - Chrome only (as of 2024); behind flag on Android
 *
 * Strategy used here:
 *  - Device A manually pairs with Device B via requestDevice() UI
 *  - Both sides open a data channel over BLE GATT characteristics
 *  - Messages are written/read as chunked JSON (MTU ~512 bytes per write)
 *  - Received messages are passed to Router.receive() just like WebRTC messages
 *
 * UUIDs (custom MeshNet service):
 *  Service:        6e400001-b5a3-f393-e0a9-e50e24dcca9e  (Nordic UART clone)
 *  TX Char (write):6e400002-b5a3-f393-e0a9-e50e24dcca9e
 *  RX Char (notify):6e400003-b5a3-f393-e0a9-e50e24dcca9e
 */

const MESHNET_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const TX_CHAR_UUID         = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const RX_CHAR_UUID         = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

const MAX_CHUNK_BYTES = 512;
const SEND_TIMEOUT_MS = 5_000;
const RECONNECT_DELAY = 3_000;
const MAX_RECONNECTS  = 5;

// ─── Tiny EventEmitter ────────────────────────────────────────────────────────
class EventEmitter {
  constructor() { this._l = new Map(); }
  on(ev,fn)   { if(!this._l.has(ev)) this._l.set(ev,new Set()); this._l.get(ev).add(fn); return this; }
  off(ev,fn)  { this._l.get(ev)?.delete(fn); return this; }
  emit(ev,...a){ for(const fn of this._l.get(ev)??[]) { try{fn(...a);}catch(e){console.error(e);} } }
}

// ─── BLEPeer ──────────────────────────────────────────────────────────────────
class BLEPeer {
  constructor(device) {
    this.device      = device;
    this.server      = null;
    this.txChar      = null;    // we write to this
    this.rxChar      = null;    // we subscribe to notifications on this
    this.connected   = false;
    this.reconnects  = 0;
    this._rxBuffer   = '';
  }
  get id()   { return this.device.id; }
  get name() { return this.device.name ?? this.device.id.slice(0, 8); }
}

// ─── BluetoothManager ─────────────────────────────────────────────────────────
export default class BluetoothManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.localNodeId
   * @param {object} opts.router  – Router instance
   */
  constructor({ localNodeId, router }) {
    super();
    this._localNodeId = localNodeId;
    this._router      = router;
    this._peers       = new Map();   // deviceId → BLEPeer
    this._supported   = typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  get isSupported() { return this._supported; }

  get connectedPeers() {
    return Array.from(this._peers.values()).filter(p => p.connected);
  }

  /**
   * Prompt user to select a nearby BLE device and connect to it.
   * Must be called from a user gesture (button click).
   * @returns {Promise<BLEPeer>}
   */
  async scanAndConnect() {
    if (!this._supported) throw new Error('Web Bluetooth not supported in this browser');

    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters          : [{ services: [MESHNET_SERVICE_UUID] }],
        optionalServices : [MESHNET_SERVICE_UUID],
      });
    } catch (err) {
      if (err.name === 'NotFoundError') throw new Error('No MeshNet device selected');
      throw err;
    }

    return this._connectDevice(device);
  }

  /**
   * Send a mesh message to all connected BLE peers.
   * @param {object} message – full router message object
   */
  async broadcast(message) {
    const json = JSON.stringify(message);
    const results = await Promise.allSettled(
      this.connectedPeers.map(peer => this._write(peer, json))
    );
    const sent = results.filter(r => r.status === 'fulfilled').length;
    return { sent, total: this.connectedPeers.length };
  }

  /**
   * Send to a specific BLE peer by deviceId.
   * @param {string} deviceId
   * @param {object} message
   */
  async sendTo(deviceId, message) {
    const peer = this._peers.get(deviceId);
    if (!peer || !peer.connected) return false;
    await this._write(peer, JSON.stringify(message));
    return true;
  }

  /**
   * Disconnect all peers and clean up.
   */
  destroy() {
    for (const peer of this._peers.values()) {
      this._disconnectPeer(peer);
    }
    this._peers.clear();
    this._l.clear();
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  async _connectDevice(device) {
    const peer = new BLEPeer(device);
    this._peers.set(device.id, peer);

    device.addEventListener('gattserverdisconnected', () => {
      peer.connected = false;
      this.emit('peer-disconnected', { deviceId: device.id, name: peer.name });
      this._scheduleReconnect(peer);
    });

    await this._doConnect(peer);
    return peer;
  }

  async _doConnect(peer) {
    try {
      peer.server = await peer.device.gatt.connect();

      const service = await peer.server.getPrimaryService(MESHNET_SERVICE_UUID);
      peer.txChar   = await service.getCharacteristic(TX_CHAR_UUID);
      peer.rxChar   = await service.getCharacteristic(RX_CHAR_UUID);

      // Subscribe to incoming notifications
      await peer.rxChar.startNotifications();
      peer.rxChar.addEventListener('characteristicvaluechanged', (ev) => {
        this._onChunk(peer, ev.target.value);
      });

      peer.connected = true;
      peer.reconnects = 0;

      this.emit('peer-connected', { deviceId: peer.id, name: peer.name });
      console.info(`[BT] Connected to ${peer.name}`);

      // Send a handshake with our nodeId
      await this._write(peer, JSON.stringify({
        __type  : 'BT_HANDSHAKE',
        nodeId  : this._localNodeId,
        ts      : Date.now(),
      }));

    } catch (err) {
      console.error('[BT] Connect failed:', err);
      peer.connected = false;
      this.emit('error', { deviceId: peer.id, error: err.message });
      throw err;
    }
  }

  _scheduleReconnect(peer) {
    if (peer.reconnects >= MAX_RECONNECTS) {
      console.warn(`[BT] Max reconnects reached for ${peer.name}`);
      this._peers.delete(peer.id);
      return;
    }
    peer.reconnects++;
    const delay = RECONNECT_DELAY * peer.reconnects;
    console.info(`[BT] Reconnecting to ${peer.name} in ${delay}ms (attempt ${peer.reconnects})`);
    setTimeout(async () => {
      try { await this._doConnect(peer); } catch (_) {}
    }, delay);
  }

  _disconnectPeer(peer) {
    try {
      peer.rxChar?.stopNotifications().catch(() => {});
      peer.device?.gatt?.disconnect();
    } catch (_) {}
    peer.connected = false;
  }

  // ── Chunked read/write ────────────────────────────────────────────────────────

  /**
   * Write a JSON string to the TX characteristic, chunked to MTU.
   */
  async _write(peer, jsonStr) {
    if (!peer.txChar) throw new Error('Not connected');

    const encoder = new TextEncoder();
    const bytes   = encoder.encode(jsonStr);
    const total   = bytes.length;
    const chunks  = Math.ceil(total / MAX_CHUNK_BYTES);

    for (let i = 0; i < chunks; i++) {
      const chunk = bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES);
      // Prepend a 1-byte header: bit 7 = isLast
      const isLast  = i === chunks - 1;
      const header  = new Uint8Array([isLast ? 0x81 : 0x01]);
      const payload = new Uint8Array(header.length + chunk.length);
      payload.set(header, 0);
      payload.set(chunk, header.length);

      const writePromise = peer.txChar.writeValueWithResponse(payload);
      await Promise.race([
        writePromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Write timeout')), SEND_TIMEOUT_MS)),
      ]);
    }
  }

  /**
   * Handle an incoming DataView chunk from the RX characteristic.
   */
  _onChunk(peer, dataView) {
    const bytes  = new Uint8Array(dataView.buffer);
    if (bytes.length === 0) return;

    const header  = bytes[0];
    const isLast  = (header & 0x80) !== 0;
    const decoder = new TextDecoder();
    const chunk   = decoder.decode(bytes.slice(1));

    peer._rxBuffer += chunk;

    if (isLast) {
      const raw = peer._rxBuffer;
      peer._rxBuffer = '';
      this._handleIncoming(peer, raw);
    }
  }

  _handleIncoming(peer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // BLE handshake — store peer's nodeId
    if (msg.__type === 'BT_HANDSHAKE') {
      peer.nodeId = msg.nodeId;
      this.emit('peer-identified', { deviceId: peer.id, name: peer.name, nodeId: msg.nodeId });
      return;
    }

    // Regular mesh message → inject into router
    this.emit('message', { message: msg, peer });

    if (this._router && msg.messageId) {
      try {
        this._router.receive(msg, null, {
          nodeId   : peer.nodeId ?? peer.id,
          userName : peer.name,
        });
      } catch (e) {
        console.warn('[BT] Router.receive error:', e);
      }
    }
  }
}
