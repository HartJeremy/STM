const CACHE = 'stage-manager-0.7.2-2026-10-09';
const CORE = [
  './',
  './index.html',
  './styles.css?v=0.7.2',
  './app.js?v=0.7.2',
  './supabase-config.js?v=0.7.2',
  './cloud-sync.js?v=0.7.2',
  './manifest.webmanifest',
  './data/seed-workspace.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isAppShell(request) {
  const url = new URL(request.url);
  if (request.mode === 'navigate') return true;
  return /\/(index\.html|app\.js|cloud-sync\.js|supabase-config\.js|styles\.css)$/.test(url.pathname);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (response && response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return caches.match('./index.html');
    throw error;
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(isAppShell(event.request) ? networkFirst(event.request) : cacheFirst(event.request));
});
