// שומר את קבצי האפליקציה כדי שתיפתח מהר. הנתונים עצמם תמיד נטענים מ-Google.
const CACHE = 'therapy-calendar-v6';
const FILES = ['./', 'index.html', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'therapy-calendar-share').map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // צילום ששותף לאפליקציה מתפריט השיתוף של אנדרואיד
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const file = form.get('image');
        if (file && file.size) {
          const cache = await caches.open('therapy-calendar-share');
          await cache.put('shared-receipt', new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
        }
      } catch (err) { /* ignore */ }
      return Response.redirect(new URL('./?receipt=shared', self.registration.scope).href, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Google: תמיד מהרשת
  // קודם מהרשת (כדי לקבל עדכונים), ואם אין אינטרנט – מהמטמון
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
