/**
 * tile-cache.sw.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Service Worker for MeshNet offline map tile caching.
 *
 * Strategy:
 *   1. On every tile fetch → serve from cache if present (cache-first)
 *   2. If not in cache and network available → fetch + cache the tile
 *   3. If offline and not cached → return offline placeholder SVG
 *
 * Place this file in your project's /public directory so it is served
 * at the root scope: https://yourdomain.com/tile-cache.sw.js
 *
 * Responds to postMessage commands from OfflineMap.jsx:
 *   { type: 'GET_TILE_COUNT' }          → replies { type: 'TILE_CACHE_COUNT', count }
 *   { type: 'PRE_CACHE_TILES', urls[] } → fetches and caches all given tile URLs
 *   { type: 'CLEAR_TILE_CACHE' }        → deletes the tile cache
 */

const CACHE_NAME    = 'meshnet-tiles-v1';
const APP_CACHE     = 'meshnet-app-v1';
const TILE_HOSTS    = ['tile.openstreetmap.org'];
const MAX_TILE_AGE  = 30 * 24 * 60 * 60 * 1000;  // 30 days in ms

// ─── App shell files to pre-cache on install ────────────────────────────────

const APP_SHELL = [
  '/',
  '/index.html',
  // Vite build outputs — adjust to match your actual bundle filenames or
  // use a Workbox manifest injection instead.
  // '/assets/index.js',
  // '/assets/index.css',
];

// ─── Offline tile placeholder ────────────────────────────────────────────────

const OFFLINE_TILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
  <rect width="256" height="256" fill="#0a0f0a"/>
  <line x1="0" y1="0" x2="256" y2="256" stroke="#0d1a0d" stroke-width="1"/>
  <line x1="256" y1="0" x2="0" y2="256" stroke="#0d1a0d" stroke-width="1"/>
  <text x="128" y="115" text-anchor="middle" fill="#1a3a1a"
    font-family="monospace" font-size="11" letter-spacing="2">TILE OFFLINE</text>
  <text x="128" y="133" text-anchor="middle" fill="#0d2a0d"
    font-family="monospace" font-size="9">[NOT IN CACHE]</text>
  <rect x="80" y="145" width="96" height="16" rx="2"
    fill="none" stroke="#0d2a0d" stroke-width="1"/>
  <rect x="82" y="147" width="30" height="12" rx="1" fill="#0d2a0d"/>
</svg>`;

const OFFLINE_TILE_RESPONSE = () => new Response(OFFLINE_TILE_SVG, {
  status  : 200,
  headers : {
    'Content-Type' : 'image/svg+xml',
    'Cache-Control': 'no-store',
    'X-Offline'    : '1',
  },
});

// ─── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  console.log('[MeshNet SW] Installing…');
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[MeshNet SW] App shell pre-cache failed (non-fatal):', err))
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  console.log('[MeshNet SW] Activated');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== APP_CACHE)
          .map(k => { console.log('[MeshNet SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch ────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // ── Tile request ──────────────────────────────────────────────────────────
  if (isTileRequest(url)) {
    event.respondWith(handleTile(event.request));
    return;
  }

  // ── App shell (navigation + same-origin assets) ───────────────────────────
  if (event.request.mode === 'navigate' || isSameOriginAsset(url)) {
    event.respondWith(handleAppShell(event.request));
    return;
  }

  // Everything else — network only
});

// ─── Tile strategy: cache-first, network fallback, offline placeholder ────────

async function handleTile(request) {
  const cache = await caches.open(CACHE_NAME);

  // 1. Cache hit
  const cached = await cache.match(request);
  if (cached) {
    // Serve from cache; revalidate in background if stale
    const age = Date.now() - new Date(cached.headers.get('sw-cached-at') ?? 0).getTime();
    if (age > MAX_TILE_AGE) {
      // Background refresh (stale-while-revalidate)
      fetchAndCache(request, cache).catch(() => {});
    }
    return cached;
  }

  // 2. Network fetch
  try {
    return await fetchAndCache(request, cache);
  } catch (_) {
    // 3. Offline placeholder
    return OFFLINE_TILE_RESPONSE();
  }
}

async function fetchAndCache(request, cache) {
  // Clone so we can read body for caching while also returning it
  const networkResp = await fetch(request.clone(), { mode: 'cors' });

  if (!networkResp.ok) throw new Error(`Tile fetch ${networkResp.status}`);

  // Add custom header to track cache time
  const headers = new Headers(networkResp.headers);
  headers.set('sw-cached-at', new Date().toISOString());
  headers.set('cache-control', 'public, max-age=2592000'); // 30d

  const blobBody   = await networkResp.blob();
  const toCache    = new Response(blobBody, { status: 200, statusText: 'OK', headers });

  cache.put(request, toCache.clone()).catch(() => {}); // non-blocking

  return new Response(blobBody, { status: 200, headers: networkResp.headers });
}

// ─── App shell strategy: network-first, cache fallback ───────────────────────

async function handleAppShell(request) {
  try {
    const resp = await fetch(request);
    const cache = await caches.open(APP_CACHE);
    cache.put(request, resp.clone()).catch(() => {});
    return resp;
  } catch (_) {
    const cached = await caches.match(request) ?? await caches.match('/index.html');
    if (cached) return cached;
    return new Response('Offline — open the app while connected first.', {
      status: 503, headers: { 'Content-Type': 'text/plain' },
    });
  }
}

// ─── postMessage commands ─────────────────────────────────────────────────────

self.addEventListener('message', (event) => {
  const { type } = event.data ?? {};

  if (type === 'GET_TILE_COUNT') {
    getTileCount().then(count => {
      event.source?.postMessage({ type: 'TILE_CACHE_COUNT', count });
    });
    return;
  }

  if (type === 'PRE_CACHE_TILES') {
    const { urls = [] } = event.data;
    preCacheTiles(urls, event.source).catch(err =>
      console.warn('[MeshNet SW] Pre-cache error:', err)
    );
    return;
  }

  if (type === 'CLEAR_TILE_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source?.postMessage({ type: 'TILE_CACHE_CLEARED' });
    });
  }
});

// ─── Pre-cache tile URLs ──────────────────────────────────────────────────────

async function preCacheTiles(urls, client) {
  const cache   = await caches.open(CACHE_NAME);
  let   cached  = 0;
  const BATCH   = 6;   // concurrent fetches

  for (let i = 0; i < urls.length; i += BATCH) {
    const batch = urls.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const existing = await cache.match(url);
          if (existing) { cached++; return; } // already have it

          const resp = await fetch(url, { mode: 'cors' });
          if (!resp.ok) return;

          const headers = new Headers(resp.headers);
          headers.set('sw-cached-at', new Date().toISOString());

          const blob    = await resp.blob();
          const toCache = new Response(blob, { status: 200, statusText: 'OK', headers });
          await cache.put(url, toCache);
          cached++;
        } catch (_) {}
      })
    );

    // Progress update every batch
    const total = await getTileCount();
    client?.postMessage({ type: 'TILE_CACHE_COUNT', count: total });
  }

  // Final count
  const final = await getTileCount();
  client?.postMessage({ type: 'TILE_CACHE_COUNT', count: final });
  client?.postMessage({ type: 'PRE_CACHE_COMPLETE', cached });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isTileRequest(url) {
  return TILE_HOSTS.some(h => url.hostname.endsWith(h));
}

function isSameOriginAsset(url) {
  return url.origin === self.location.origin;
}

async function getTileCount() {
  const cache = await caches.open(CACHE_NAME);
  const keys  = await cache.keys();
  return keys.length;
}
