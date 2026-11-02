// Offline-Unterstützung: App-Dateien und Firebase-Bibliothek werden zwischengespeichert,
// damit die App auch ohne Internet startet. Daten gleicht die App selbst ab.
const CACHE = 'geschenke-v2';
const CORE = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './badge-96.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE.map(u => new Request(u, {cache:'reload'})))));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Eigene Dateien: erst Netz (immer aktuelle Version, am Browser-Cache vorbei), sonst Cache
  if (url.origin === location.origin){
    e.respondWith(fetch(req.url, {cache:'no-cache'})
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, {ignoreSearch:true}).then(r => r || caches.match('./index.html'))));
    return;
  }

  // Bibliotheken (Firebase, QR-Code): erst Cache, sonst Netz
  if (url.hostname === 'www.gstatic.com' || url.hostname === 'cdnjs.cloudflare.com'){
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
  }
});

// Erinnerungen (verschickt von GitHub Actions, siehe push-senden.js)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch(_) { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Geschenke', {
    body: d.body || '', icon: 'icon-192.png', badge: 'badge-96.png', tag: d.tag || 'geschenke', renotify: true,
    data: {url: d.url || './'},
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({type:'window', includeUncontrolled:true}).then(list => {
    const win = list.find(w => w.url.startsWith(self.registration.scope));
    if (win) return win.navigate(url).then(w => (w || win).focus()).catch(() => win.focus());
    return clients.openWindow(url);
  }));
});
