// The phone client's service worker: it draws the notifications the Mac
// pushes (`main/remoteAccess.ts` → `maybePush`) and opens the chat a tap is
// about. Nothing is cached — the client is served by the Mac it talks to, and
// is useless without it.
//
// Every push shows a notification. iOS revokes a subscription whose pushes
// draw nothing, so deciding *whether* to notify is the Mac's job, not this one's.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Carbon', {
      body: data.body || '',
      tag: data.tag,
      data: { chatId: data.chatId || null },
      icon: '/remote-icon.png'
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const chatId = event.notification.data && event.notification.data.chatId
  const hash = chatId ? `#/c/${encodeURIComponent(chatId)}` : '#/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows[0]
      if (open) {
        // The page routes on its hash; it moves itself (`remote/push.ts`).
        open.postMessage({ type: 'open', hash })
        return open.focus()
      }
      return self.clients.openWindow(`/${hash}`)
    })()
  )
})
