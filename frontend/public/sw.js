/**
 * Minimal service worker: makes the app installable (PWA) and owns
 * notifications — on Android, page-created notifications are not allowed,
 * they must go through registration.showNotification(). It also receives
 * Web Push messages so a phone is notified with the app closed.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Web Push: the server pushes {title, body, tag} for incoming WhatsApp
// messages. Skip showing it when the app is already focused — the in-page
// path handles that case and a double notification is noise.
self.addEventListener('push', (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();
  const title = data.title || 'New message';
  const options = {
    body: data.body || '',
    tag: data.tag, // collapse repeats per chat
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const focused = wins.some((w) => w.focused && w.visibilityState === 'visible');
      if (focused) return undefined; // app in front — the page already handles it
      return self.registration.showNotification(title, options);
    }),
  );
});

// Open the exact target when a notification is clicked. The app has no URL
// router (tab state lives in App.tsx), so an already-open tab can't be steered
// by changing its URL — we focus it and post the deep-link for the page to
// route in-place. Only a cold start (no tab) opens the URL directly.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const client = wins[0];
      if (client) {
        client.postMessage({ type: 'navigate', url });
        return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
