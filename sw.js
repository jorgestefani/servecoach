/**
 * ServeCoach Service Worker
 * Cache-first strategy for app shell, network-first for model assets
 */

const CACHE_NAME = 'servecoach-v6';
const MODEL_CACHE_NAME = 'servecoach-models-v6';

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
];

// Model assets from CDN (cached separately with longer TTL)
const MODEL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/wasm_exec.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm/vision_wasm_internal.wasm',
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task',
];

// Install - cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        console.log('App shell cache partial:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== MODEL_CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch handler
self.addEventListener('fetch', (event) => {
  const {request} = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip chrome-extension, blob, etc.
  if (!url.protocol.startsWith('http')) return;

  // Model assets - cache first with long TTL
  if (MODEL_ASSETS.some(asset => request.url.startsWith(asset))) {
    event.respondWith(modelCacheFirst(request));
    return;
  }

  // App shell - network first (para as correções chegarem logo)

  // Other requests - network first, fallback to cache
  event.respondWith(networkFirst(request));
});

// Cache-first strategy
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Return offline fallback for navigation
    if (request.mode === 'navigate') {
      return cache.match('./index.html');
    }
    throw err;
  }
}

// Network-first strategy
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    if (request.mode === 'navigate') {
      return cache.match('./index.html');
    }
    throw err;
  }
}

// Model cache-first (separate cache, longer retention)
async function modelCacheFirst(request) {
  const cache = await caches.open(MODEL_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    // Check age - if older than 30 days, refresh in background
    const cachedDate = cached.headers.get('sw-cached-date');
    if (cachedDate) {
      const age = Date.now() - parseInt(cachedDate);
      if (age > 30 * 24 * 60 * 60 * 1000) {
        // Stale - refresh in background
        fetch(request).then(r => {
          if (r.ok) {
            const newResp = new Response(r.body, r);
            newResp.headers.set('sw-cached-date', Date.now().toString());
            cache.put(request, newResp);
          }
        }).catch(() => {});
      }
    }
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const newResp = new Response(response.body, response);
      newResp.headers.set('sw-cached-date', Date.now().toString());
      cache.put(request, newResp.clone());
      return newResp;
    }
    return response;
  } catch (err) {
    throw err;
  }
}

// Handle messages from clients
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data === 'clearCache') {
    caches.delete(CACHE_NAME);
    caches.delete(MODEL_CACHE_NAME);
  }
});