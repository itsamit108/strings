/* Nodal service worker: keeps the app usable without a network. */
const CACHE = 'nodal-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'store' && Array.isArray(data.urls)) {
    event.waitUntil(
      caches.open(CACHE).then((c) =>
        Promise.all(data.urls.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {})))),
      ),
    );
  }
});

const store = (request, response) => {
  if (response && response.ok && response.type === 'basic') {
    const copy = response.clone();
    caches.open(CACHE).then((c) => c.put(request, copy));
  }
  return response;
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Built files have a fingerprint in their name and never change: cache first.
  if (url.pathname.startsWith('/_next/static/') || /\.(png|woff2?)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((r) => store(request, r))));
    return;
  }
  // Everything else: fresh when online, stored copy when not.
  event.respondWith(
    fetch(request)
      .then((r) => store(request, r))
      .catch(() => caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match('/') : Response.error()))),
  );
});
