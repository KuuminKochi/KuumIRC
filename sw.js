const CACHE = 'kuumirc-shell-v21';
const SHELL = ['./', './index.html', './style.css', './client.js', './render.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(path, { cache: 'no-store' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  const fresh = ['document', 'script', 'style'].includes(event.request.destination);
  event.respondWith(fetch(event.request, fresh ? { cache: 'no-store' } : undefined).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? caches.match('./') : Response.error())));
});
