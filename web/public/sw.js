const SHELL_CACHE = 'nyc-parking-shell-v4'
const SHELL_ASSETS = [
  '/manifest.webmanifest', '/pigeon.png', '/pidge-192.png', '/pidge-512.png',
  '/privacy.html', '/accessibility.html', '/terms.html', '/data-sources.html'
]

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE)
    const indexResponse = await fetch('/', { cache: 'no-store' })
    await cache.put('/', indexResponse.clone())
    const html = await indexResponse.text()
    const entryAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
    await cache.addAll([...SHELL_ASSETS, ...new Set(entryAssets)])
  })())
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== SHELL_CACHE).map(key => caches.delete(key))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)

  // Parking APIs and external map resources must always remain network-only.
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/livez' || url.pathname === '/readyz') {
    event.respondWith(fetch(request))
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone()
          void caches.open(SHELL_CACHE).then(cache => cache.put('/', copy))
          return response
        })
        .catch(() => caches.match('/'))
    )
    return
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok && response.type === 'basic' && url.pathname !== '/sw.js') {
        const copy = response.clone()
        void caches.open(SHELL_CACHE).then(cache => cache.put(request, copy))
      }
      return response
    }))
  )
})
