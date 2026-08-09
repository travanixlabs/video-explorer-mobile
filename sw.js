'use strict';

/**
 * Caches the app shell so it launches from the home screen instantly and
 * survives a flaky connection.
 *
 * Deliberately nothing else: video bytes, Graph responses, and thumbnail URLs
 * are all either huge, short-lived, or signed with an expiry. Caching them
 * would fill the phone and serve stale, dead URLs.
 */

const VERSION = 'v2';
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

  // Network first, cache as the fallback. Cache-first is the usual advice for a
  // shell, but it hands back yesterday's JavaScript every time the app changes —
  // and the cache still covers the case that actually matters, which is opening
  // the app with no signal.
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
      }
      return res;
    }).catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html'))),
  );
});
