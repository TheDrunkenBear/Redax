/* Redax — сервис-воркер: офлайн-работа установленного приложения.
   Оболочка кешируется при установке; шрифты и прочее — по мере обращения. */
var VERSION = 'redax-v3';
var SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/vault.js',
  './js/app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) { return c.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) {
        // обновляем кеш в фоне, чтобы подтягивались новые версии
        e.waitUntil(
          fetch(e.request).then(function (res) {
            if (res && res.ok) {
              return caches.open(VERSION).then(function (c) { return c.put(e.request, res); });
            }
          }).catch(function () { /* офлайн — ок */ })
        );
        return hit;
      }
      return fetch(e.request).then(function (res) {
        if (res && res.ok && (e.request.url.indexOf('http') === 0)) {
          var copy = res.clone();
          e.waitUntil(caches.open(VERSION).then(function (c) { return c.put(e.request, copy); }));
        }
        return res;
      });
    })
  );
});
