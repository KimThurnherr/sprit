// Service Worker nur für die Installation als App. Kein Offline-Cache der Daten.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
