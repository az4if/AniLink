// Ryuu service worker — app-shell caching for installable, offline-tolerant PWA.
// Bump CACHE_VERSION whenever a shell file changes so clients pick up the update.
const CACHE_VERSION = 'ryuu-v11';
const CACHE_NAME = `ryuu-cache-${CACHE_VERSION}`;

// Everything needed to paint the app shell while offline.
// Paths are relative so this works whether the site is hosted at a domain
// root or under a GitHub Pages project subpath (e.g. /Ryuu/).
const APP_SHELL = [
    './',
    './index.html',
    './style.css',
    './enhancements.css',
    './app.js',
    './overrides.js',
    './key.js',
    './site.webmanifest',
    './favicons/favicon-16x16.png',
    './favicons/favicon-32x32.png',
    './favicons/favicon-48x48.png',
    './favicons/favicon-96x96.png',
    './favicons/apple-touch-icon-180x180.png',
    './favicons/android-chrome-192x192.png',
    './favicons/android-chrome-512x512.png',
    './assets/favicon.png',
    './assets/logo.svg'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only handle same-origin GET requests. AniList API calls, the video
    // iframe/stream host, and any other cross-origin traffic pass straight
    // through to the network untouched.
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        caches.match(request).then((cached) => {
            const networkFetch = fetch(request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => {
                    // Offline and not cached: fall back to the app shell for
                    // page navigations so the app still opens.
                    if (request.mode === 'navigate') {
                        return caches.match('./index.html');
                    }
                    return cached;
                });

            // Cache-first for speed & offline reliability, refresh in background.
            return cached || networkFetch;
        })
    );
});
