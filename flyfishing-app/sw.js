/* Hatched service worker — offline support with fresh-when-online updates.
   Strategy: network-first for the app shell & data (so updates show immediately
   when online), falling back to cache when offline. */
const CACHE = 'hatched-v218';
const ASSETS = [
  './',
  './index.html',
  './data.js?v=188',
  './manifest.json',
  './privacy.html',
  './icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  let sameOrigin = false;
  try { sameOrigin = new URL(e.request.url).origin === location.origin; } catch (_) {}
  if (!sameOrigin) return; // let cross-origin (e.g. maps) go straight to network

  // network-first: try the network, update cache, fall back to cache offline
  e.respondWith(
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return resp;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
