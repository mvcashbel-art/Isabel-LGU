/*
 * Isabel LGU portal - service worker
 * Keeps a copy of the page on the phone so it still opens with weak or no signal.
 * The internet is always tried first (so updates show up right away); the saved copy is used only if the
 * internet is slow (more than 4 seconds) or off. Requests to the backend are never touched.
 */
var CACHE = 'isabel-lgu-v1';
var SHELL = ['./', 'index.html', 'tailwind.css', 'signup-patch.js', 'extras.js', 'services.json', 'manifest.webmanifest',
  'isabel-seal.png', 'icon-192.png', 'favicon-32.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    // add one by one so a missing file does not stop the rest
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function networkFirst(req) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      caches.match(req, { ignoreSearch: true }).then(function (hit) { if (hit && !settled) { settled = true; resolve(hit); } });
    }, 4000);
    fetch(req).then(function (res) {
      clearTimeout(timer);
      if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      if (!settled) { settled = true; resolve(res); }
    }).catch(function () {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (settled) return;
        settled = true;
        resolve(hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
      });
    });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // backend and anything else: leave alone
  if (url.pathname.slice(-6) === '/sw.js') return;
  e.respondWith(networkFirst(req));
});