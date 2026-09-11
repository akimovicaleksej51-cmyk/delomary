// Minimal service worker for the admin panel — its ONLY job is to satisfy
// Chrome/Android's "installability" checklist (a registered service worker
// with a fetch handler) so the "Установить приложение" / "Добавить на
// главный экран" prompt actually shows up and installs as a standalone app
// icon, not a plain browser bookmark.
//
// Deliberately does NOT cache or intercept anything: it never calls
// event.respondWith(), so every request still goes straight to the network
// exactly as if there were no service worker at all. That's on purpose —
// the admin panel (bookings, Касса, live balances) must always show
// current data, never a stale cached copy.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally empty — falls through to the browser's normal network
  // fetch. Present only so the browser counts this as an installable PWA.
});
