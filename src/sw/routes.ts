/**
 * Routing rules of the controller's service worker, kept pure so they are unit-tested:
 *  - the page itself (any navigation inside /p/) comes from the cached shell, so it opens with no internet;
 *  - its build assets (hashed, immutable) are cache-first;
 *  - web fonts are cached as they are seen (stale-while-revalidate);
 *  - the room service (/api, /r) and everything else stay live.
 */
export const CACHE_PREFIX = 'obpal-p-'
export const FONT_CACHE = 'obpal-fonts-v1'
export const cacheName = (version: string) => `${CACHE_PREFIX}${version}`

export type Route = 'shell' | 'precache' | 'fonts' | 'network'

const FONT_ORIGINS = new Set(['https://fonts.googleapis.com', 'https://fonts.gstatic.com'])

export function route(req: { url: string; method: string; mode: string }, origin: string, precached: ReadonlySet<string>): Route {
  if (req.method !== 'GET') return 'network'
  let url: URL
  try { url = new URL(req.url) } catch { return 'network' }
  if (url.origin === origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/')) return 'network'
    if (req.mode === 'navigate') return url.pathname === '/p' || url.pathname.startsWith('/p/') ? 'shell' : 'network'
    return precached.has(url.pathname) ? 'precache' : 'network'
  }
  return FONT_ORIGINS.has(url.origin) ? 'fonts' : 'network'
}

/** Old versions of this app's cache (never the font cache, which is shared across versions). */
export const staleCaches = (names: readonly string[], current: string) => names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current)
