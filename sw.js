'use strict';

/**
 * Caches the app shell so it launches from the home screen instantly and
 * survives a flaky connection.
 *
 * Deliberately nothing else: video bytes, Graph responses, and thumbnail URLs
 * are all either huge, short-lived, or signed with an expiry. Caching them
 * would fill the phone and serve stale, dead URLs.
 */

const VERSION = 'v13';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './auth.js',
  './graph.js',
  './styles.css',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only our own static files. Anything on graph.microsoft.com, the login
  // endpoints, or a signed CDN URL goes straight to the network.
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  // Stale-while-revalidate: the cached copy answers at once -- a launch on a
  // slow connection used to pay a round trip per file before anything rendered
  // -- and the network's answer replaces it behind, so an update lands one
  // open later instead of holding this one up. No signal still means the
  // cached app, exactly as before.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const refresh = fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        }
        return res;
      }).catch(() => hit || caches.match('./index.html'));
      return hit || refresh;
    }),
  );
});
