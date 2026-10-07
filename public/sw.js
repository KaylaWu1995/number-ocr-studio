/* App assets only: credentials and OCR traffic are never cached. */
const CACHE = 'number-ocr-pages-__BUILD_ID__';
const SHELL = ['index.html', 'styles.css', 'core.js', 'selection.js', 'ocr-client.js', 'app.js', 'mobile.js', 'updates.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg'];
const urls = new Set(SHELL.map(p => new URL(p, self.registration.scope).href));
urls.add(self.registration.scope);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && (k.startsWith('number-ocr-pages-') || k.startsWith('number-ocr-studio-'))).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !urls.has(event.request.url)) return;
  event.respondWith(fetch(event.request, { cache: 'no-cache' }).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? await caches.match(new URL('index.html', self.registration.scope).href) : Response.error())));
});
