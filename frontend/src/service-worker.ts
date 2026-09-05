export function serviceWorkerSource(precache: string[]): string {
  return `const CACHE = 'kuvth-zebrafish-lims-shell-v3'
const PRECACHE = ${JSON.stringify(precache)}
self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())))
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())))
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return
  const network = () => fetch(event.request).then((response) => { if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone())); return response })
  event.respondWith(event.request.mode === 'navigate' ? network().catch(() => caches.match('/').then((response) => response || new Response('', { status: 503 }))) : caches.match(event.request).then((cached) => cached || network().catch(() => new Response('', { status: 503 }))))
})
`;
}
