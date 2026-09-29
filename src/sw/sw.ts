/**
 * Service worker for the phone controller (/p/). Built by the site build (vite.config.ts) into /p/sw.js with the
 * page's asset list baked in, so each deploy is one versioned cache: install precaches the new version, activate
 * (once the old pages are gone) drops the old caches. A phone that has opened the controller once can open it
 * again with no internet, and install it from the browser's menu as an app.
 */
import { cacheName, FONT_CACHE, route, staleCaches } from './routes'
import { cacheHandAsset } from '../controller/hand-assets'
import { cacheBodyAsset } from '../controller/body-assets'

declare const __PRECACHE__: string[]
declare const __VERSION__: string

const sw = self as unknown as ServiceWorkerGlobalScope
const CACHE = cacheName(__VERSION__)
const SHELL = '/p/'
const precached = new Set<string>(__PRECACHE__)

sw.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(__PRECACHE__)))
})

sw.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of staleCaches(await caches.keys(), CACHE)) await caches.delete(name)
    await sw.clients.claim()
  })())
})

sw.addEventListener('fetch', (e) => {
  const req = e.request
  switch (route(req, sw.location.origin, precached)) {
    case 'shell': e.respondWith(shell(req)); break
    case 'precache': e.respondWith(cacheFirst(req)); break
    case 'fonts': e.respondWith(staleWhileRevalidate(req)); break
    case 'models': e.respondWith(cacheHandAsset(new URL(req.url).pathname)); break
    case 'body-model': e.respondWith(cacheBodyAsset(new URL(req.url).pathname)); break
  }
})

/** The page itself, cached: any navigation inside the scope (with a code in the fragment, or a query) gets it. */
async function shell(req: Request): Promise<Response> {
  const cached = await caches.match(SHELL, { cacheName: CACHE })
  if (cached) return cached
  const fresh = await fetch(req)
  if (fresh.ok) void caches.open(CACHE).then((c) => c.put(SHELL, fresh.clone()))
  return fresh
}

async function cacheFirst(req: Request): Promise<Response> {
  const cached = await caches.match(req, { cacheName: CACHE, ignoreSearch: true })
  if (cached) return cached
  const fresh = await fetch(req)
  if (fresh.ok) void caches.open(CACHE).then((c) => c.put(req, fresh.clone()))
  return fresh
}

/** Fonts: what we have, at once; a fresh copy for next time when the network is there. */
async function staleWhileRevalidate(req: Request): Promise<Response> {
  const cache = await caches.open(FONT_CACHE)
  const cached = await cache.match(req)
  const refresh = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') void cache.put(req, r.clone()); return r }).catch(() => null)
  if (cached) { void refresh; return cached }
  const fresh = await refresh
  return fresh ?? new Response('', { status: 504 })
}
