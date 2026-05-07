<<<<<<< HEAD
# ⬡ MeshNet — Offline Disaster Communication System

> **Peer-to-peer mesh networking for emergency responders and civilians when infrastructure fails.**
> No internet. No cell towers. No central server after the initial handshake. Just devices talking directly to each other.

---

## 📸 Screenshots

```
┌─────────────────────────────────────────────────────────────────┐
│  [SCREENSHOT: Boot sequence with green terminal-style log]      │
│  Boot screen: "MESHNET v1.0 INITIALIZING…"                      │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  [SCREENSHOT: Main tactical dashboard — 3-column layout]         │
│  Left: node list with battery/signal indicators                  │
│  Center: Share Tech Mono chat with hop-count badges              │
│  Right: D3 force-directed mesh graph with glowing green nodes    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  [SCREENSHOT: SOS broadcast panel]                               │
│  Giant pulsing red button, 4 emergency types, active alert list  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  [SCREENSHOT: Offline map with node pins + SOS pulsing markers]  │
│  Dark-filtered OSM tiles, collapsible bottom panel               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  [SCREENSHOT: QR Bridge — encode/scan modal]                     │
│  QR code with green glow + camera scanner with scan-line overlay │
└──────────────────────────────────────────────────────────────────┘
```

---

## ⚡ What Is MeshNet?

MeshNet is a **browser-based WebRTC mesh network** built for disaster scenarios — earthquakes, floods, wildfires, grid-down events — where traditional communication infrastructure is unavailable.

Each device running MeshNet becomes a **node** in a self-healing peer-to-peer network. Messages hop between nodes like packets in a router: if Node A cannot reach Node D directly, the message travels A → B → C → D automatically, up to 7 hops.

**After the initial signaling handshake, zero internet is required.** The signaling server is only needed to introduce nodes to each other — once WebRTC data channels are open, the server can be turned off and the mesh continues operating.

---

## 🔬 How It Works — Technical

### Architecture

```
┌─────────────┐     WebRTC        ┌─────────────┐
│  Device A   │◄──────────────────►│  Device B   │
│  (Node)     │   RTCDataChannel  │  (Node)     │
└──────┬──────┘                   └──────┬──────┘
       │  WebRTC                         │  WebRTC
       ▼                                 ▼
┌─────────────┐                   ┌─────────────┐
│  Device C   │◄──────────────────►│  Device D   │
│  (Node)     │   RTCDataChannel  │  (Node)     │
└─────────────┘                   └─────────────┘

          [Only during initial setup]
                      │
              ┌───────▼────────┐
              │ Signaling      │
              │ Server         │
              │ (Socket.io)    │
              └────────────────┘
```

### Stack

| Layer | Technology |
|---|---|
| **Signaling** | Node.js + Express + Socket.io |
| **P2P Transport** | WebRTC (`RTCPeerConnection` + `RTCDataChannel`) |
| **Routing** | Dijkstra's algorithm (custom implementation, binary min-heap) |
| **Frontend** | React 18 + Vite |
| **Visualisation** | D3.js v7 (force-directed graph) |
| **Maps** | Leaflet.js + OpenStreetMap (dark-filtered) |
| **Offline Maps** | Service Worker (cache-first tile strategy) |
| **QR Bridge** | qrcode.js + jsQR |
| **Styling** | Tailwind CSS + Share Tech Mono |

### Message Routing

Every message in MeshNet is a self-contained packet:

```json
{
  "messageId": "uuid-v4",
  "senderId": "originating-node-id",
  "targetId": "destination-node-id OR __BROADCAST__",
  "hopCount": 2,
  "ttl": 5,
  "path": ["node-a", "node-b"],
  "payload": { "type": "CHAT", "text": "Is everyone okay?" },
  "timestamp": 1712345678901
}
```

At each hop the Router:
1. Checks `seenMessages` cache — drops duplicates
2. Decrements `ttl` — drops if zero
3. Checks `path[]` for loops — drops if self already in path
4. Runs Dijkstra on the weighted graph to find `nextHopNodeId`
5. Calls `WebRTCManager.sendTo(socketId, msg)`

**SOS broadcast** uses controlled flooding: each node re-broadcasts to all direct peers (except the incoming peer), controlled by the dedup cache. TTL=7 is the hard limit.

### WebRTC Perfect Negotiation

`WebRTCManager.js` implements the W3C [Perfect Negotiation](https://www.w3.org/TR/webrtc/#perfect-negotiation-example) pattern to handle offer collisions in a mesh (when two nodes both try to initiate simultaneously):

- `isPolite` flag determines who rolls back on collision
- `makingOffer` + `ignoreOffer` guard against race conditions
- ICE candidates are queued before `setRemoteDescription` and flushed immediately after

### Offline Map Caching

The Service Worker (`tile-cache.sw.js`) intercepts all `*.tile.openstreetmap.org` requests:

- **Online**: fetch tile → cache with `sw-cached-at` timestamp header → serve
- **Offline**: serve from cache if present → fallback to offline SVG placeholder
- **Pre-cache**: the "Cache Area" button sends current viewport tile URLs to the SW, which fetches them in batches of 6

---

## 🚀 Setup Instructions

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9
- A modern browser (Chrome 90+, Firefox 85+, Safari 15+)

### 1. Clone

```bash
git clone https://github.com/your-username/meshnet.git
cd meshnet
```

### 2. Server

```bash
cd server
cp .env.example .env
npm install
npm run dev
# → Signaling server running on http://localhost:3001
```

### 3. Client

```bash
cd client
cp .env.example .env
# Edit .env: VITE_SIGNALING_URL=http://localhost:3001
npm install
npm run dev
# → Vite dev server on http://localhost:5173
```

### 4. Open Multiple Tabs

Open `http://localhost:5173` in two or more browser tabs. Each tab becomes a separate mesh node. They will auto-join `zone-alpha` and form a P2P mesh.

---

## 🔧 Testing with Multiple Devices (Local Network)

### Find your local IP

```bash
# macOS / Linux
ipconfig getifaddr en0
# or
ip route get 1 | awk '{print $7}'

# Windows
ipconfig | findstr IPv4
# typical result: 192.168.1.105
```

### Start server with network access

```bash
cd server
PORT=3001 CORS_ORIGIN="http://192.168.1.105:5173" npm run dev
```

### Start client bound to all interfaces

```bash
cd client
# Edit .env: VITE_SIGNALING_URL=http://192.168.1.105:3001
npx vite --host 0.0.0.0
```

### Connect other devices

On any device on the same WiFi network, open:
```
http://192.168.1.105:5173
```

All devices will join the same mesh zone and form peer connections.

### Test offline behaviour

1. Open the app and let tiles load on the map
2. Click **Cache Area** in the map panel to pre-cache the current view
3. Stop the signaling server: `Ctrl+C` in the server terminal
4. Disconnect from WiFi on both devices
5. Reload the page — the app boots with the cached SW
6. Send chat messages — they route P2P over WebRTC (no server needed)
7. Observe that map tiles load from the Service Worker cache

### Multi-device SOS test

1. Device A: press the SOS button → hold to confirm → select MEDICAL
2. Device B: SOS alert card appears within seconds
3. Device C (not directly connected to A): message hops through B, arrives at C with `hopCount: 2`

---

## ☁️ Deployment

### Frontend → Vercel

```bash
cd client
npm i -g vercel
vercel

# Set environment variables in Vercel dashboard:
# VITE_SIGNALING_URL = https://meshnet-signaling.onrender.com
# VITE_DEFAULT_ZONE  = zone-alpha
```

Or connect your GitHub repo and Vercel auto-deploys on every push.

The `vercel.json` in `client/` handles:
- SPA routing (all paths → `index.html`)
- Service Worker headers (`Service-Worker-Allowed: /`)
- Immutable cache headers for hashed assets
- Camera + geolocation permissions policy

### Backend → Render

```bash
# Option 1: Infrastructure as Code (recommended)
# Push render.yaml to repo root, then connect repo in Render dashboard

# Option 2: Manual
# 1. Go to https://render.com → New Web Service
# 2. Connect GitHub repo
# 3. Root directory: server
# 4. Build: npm install
# 5. Start: node index.js
# 6. Add env var: CORS_ORIGIN = https://your-app.vercel.app
```

### Environment Variables Reference

#### Server (`server/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP port |
| `NODE_ENV` | No | `development` | `production` disables debug logs |
| `CORS_ORIGIN` | **Yes** | — | Comma-separated allowed origins |
| `MAX_NODES_PER_ZONE` | No | `100` | Max simultaneous nodes per zone |
| `LOG_LEVEL` | No | `info` | `error\|warn\|info\|debug` |

#### Client (`client/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_SIGNALING_URL` | **Yes** | — | Full URL of signaling server |
| `VITE_DEFAULT_ZONE` | No | `zone-alpha` | Zone nodes join on first load |

---

## 🌍 Real-World Use Cases

### 1. Earthquake Response — Urban Search & Rescue
Rescue teams carry phones/tablets pre-loaded with MeshNet. When a building collapses and cell towers are down, teams form an instant mesh. Trapped individuals broadcast SOS with GPS coordinates. Rescuers see their position on the offline map (tiles pre-cached for the city) without any internet.

### 2. Wildfire Evacuation Coordination
Evacuation coordinators at different road checkpoints form a mesh across several kilometres. Chat messages relay through intermediate nodes (vehicles with phones) when direct links fail. The D3 visualiser shows the network topology so coordinators know if a node has gone offline.

### 3. Festival / Mass Gathering Safety
At an off-grid festival with no cell coverage, medical staff and security use MeshNet. The SOS system lets attendees broadcast a distress signal that floods the entire mesh within seconds. Medical type with GPS location routes the nearest responder.

### 4. Sailing / Maritime
Vessels within VHF radio range but without sat-com use MeshNet via device WiFi hotspots. Chat and position sharing work without any shore-side infrastructure. The QR Bridge allows message exchange when two vessels meet in port with no shared network.

### 5. Protest / Civil Unrest Situations
Groups in areas with network throttling or shutdowns use MeshNet in a local WiFi hotspot mesh. The QR Bridge provides a last-resort physical data transfer mechanism when even Bluetooth is jammed.

### 6. Remote Hiking / SAR Teams
Search and rescue teams in a canyon or forest use MeshNet over device WiFi hotspots. One team member's phone acts as a relay node, forwarding messages between teams on opposite sides of a ridge that can't connect directly.

---

## 🔮 Future Scope

### Connectivity
- **Bluetooth Low Energy transport** — replace WiFi with BLE for longer range, lower power
- **LoRa radio bridge** — connect a LoRa module via Web Serial API for km-range links
- **WebUSB modem support** — use a USB radio dongle as a long-range transport layer
- **Wi-Fi Direct / P2P** — eliminate the need for a shared WiFi AP entirely

### Routing
- **Battery-aware Dijkstra** — use battery level as edge weight (prefer routing through high-battery nodes)
- **Signal-strength weighting** — use WebRTC `getStats()` RTT as dynamic edge cost
- **Store-and-forward** — buffer messages for offline nodes and deliver when they reconnect
- **Onion routing option** — for operational security in sensitive deployments

### Features
- **Voice messages** — WebRTC MediaRecorder → compressed audio over data channel
- **File transfer** — chunked binary over data channel for document sharing
- **Persistent message log** — IndexedDB storage for offline message history
- **Node reputation** — track reliable relayers and prefer them in routing
- **Encrypted channels** — end-to-end encryption via Web Crypto API
- **APRS integration** — relay mesh messages to amateur radio APRS network

### Platform
- **PWA with background sync** — keep mesh alive when app is backgrounded
- **React Native port** — native iOS/Android with better BLE/WiFi access
- **Electron desktop** — persistent relay node for base camps
- **Raspberry Pi image** — pre-built relay node that runs headless on solar power

### Operations
- **Zone bridge** — relay between two isolated zones via a border node
- **Incident management** — structured forms (casualty reports, resource requests) layered on top of the mesh
- **Satellite handoff** — when Starlink/Iridium is available, sync the mesh state to a cloud backbone

---

## 🗂️ Project Structure

```
meshnet/
├── server/
│   ├── index.js              # Signaling server (Express + Socket.io)
│   ├── package.json
│   └── .env.example
│
├── client/
│   ├── public/
│   │   └── tile-cache.sw.js  # Service Worker for offline map tiles
│   ├── src/
│   │   ├── core/
│   │   │   ├── WebRTCManager.js   # P2P connection + data channels
│   │   │   └── Router.js          # Dijkstra routing + flood broadcast
│   │   ├── components/
│   │   │   ├── Chat.jsx           # Tactical chat interface
│   │   │   ├── SOSButton.jsx      # Emergency broadcast system
│   │   │   ├── MeshVisualizer.jsx # D3 force-directed graph
│   │   │   ├── OfflineMap.jsx     # Leaflet offline map
│   │   │   └── QRBridge.jsx       # QR encode/scan bridge
│   │   └── App.jsx                # Root — initialises + assembles everything
│   ├── vercel.json
│   └── .env.example
│
├── render.yaml                # Render.com deployment config
└── README.md
```

---

## 📄 License

MIT — free to use, fork, and deploy in emergency response scenarios. Attribution appreciated but not required.

---

## 🙏 Acknowledgements

Built with: WebRTC, Socket.io, React, D3.js, Leaflet, OpenStreetMap contributors, jsQR, qrcode.js, Share Tech Mono (Google Fonts).

> *"When the grid goes down, the mesh comes up."*
=======
# Meshnet
>>>>>>> 1073d6ef0b515b28b523af58689eea18cab2acd9
