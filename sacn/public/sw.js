// public/sw.js
const CACHE_NAME = 'dmx-console-v1.0.1';

self.addEventListener('install', (event) => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    // Delete any old caches that don't match the current app version
                    if (cacheName !== CACHE_NAME && cacheName.startsWith('dmx-console-')) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // 1. WebSockets bypass the Service Worker automatically.
    // 2. Only intercept HTTP GET requests.
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // --- THE BUG FIX: DO NOT CACHE API OR GATEWAY CALLS ---
    if (url.pathname.includes('/api/') || url.pathname.includes('/gateway/')) {
        return; // Returning undefined lets the browser handle it normally over the network
    }

    // Is this a navigation request? (e.g., loading /the-venue-club/main-stage)
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request).then((response) => {
                // If Gateway says 404 (Tunnel is down), serve the cached app shell
                if (response.status === 404) {
                    return caches.match(self.registration.scope + 'index.html');
                }
                // Otherwise, cache the successful HTML and return it
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            }).catch(() => {
                // Device has no internet connection at all
                return caches.match(self.registration.scope + 'index.html');
            })
        );
        return;
    }

    // For static assets (js, css, images) - Stale-While-Revalidate pattern
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            const networkFetch = fetch(event.request).then((response) => {
                // Update the cache with the fresh asset in the background
                if (response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => { /* Ignore network errors for background asset fetches */ });

            return cachedResponse || networkFetch;
        })
    );
});