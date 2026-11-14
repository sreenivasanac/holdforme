// CallEnvoy service worker: shows alerts and opens the call on click.
// No fetch handler and no cache, so it can never serve an old console.
const BASE = '/callenvoy';

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data && event.data.text() }; }
  const url = d.url || (d.call_id ? `${BASE}/calls/${d.call_id}` : `${BASE}/`);
  event.waitUntil(self.registration.showNotification(d.title || 'CallEnvoy', {
    body: d.body || 'A person is on the line. Tap to join.',
    tag: d.call_id || 'callenvoy', // same tag as the in-page notification, so only one shows
    renotify: true,
    requireInteraction: true,
    icon: `${BASE}/icon.png`,
    data: { url },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || `${BASE}/`;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).pathname.startsWith(BASE));
    if (tab) {
      await tab.focus();
      tab.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
