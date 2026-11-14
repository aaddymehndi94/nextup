// The phone app (nexttupp.com/watch added to a home screen) keeps its own page here, so it opens without the
// internet: the computer is on the same Wi-Fi, and /watch can still open it. Network first, so a deploy shows at
// once; the copy is used only when the network fails. Registered from watch.js with scope /watch, so nothing else
// on nexttupp.com is touched. The API (another origin) is never cached.

const CACHE = 'watch-v1'
const PAGE = '/watch'
const SHELL = [PAGE, '/styles.css', '/watch.js', '/cloud.js', '/site.js', '/fonts/MonaSansVF.woff2', '/favicon.svg', '/icon-192.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  // Every page this worker controls is /watch, whatever its query (?choose).
  const key = req.mode === 'navigate' ? PAGE : url.pathname
  if (!SHELL.includes(key)) return
  e.respondWith(fetch(req).then(res => {
    if (res.ok && !res.redirected) {
      const copy = res.clone()
      e.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)))
    }
    return res
  }).catch(() => caches.match(key).then(hit => hit || Response.error())))
})
