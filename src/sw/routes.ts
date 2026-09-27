/**
 * Routing rules of the controller's service worker, kept pure so they are unit-tested:
 *  - the page itself (any navigation inside /p/) comes from the cached shell, so it opens with no internet;
 *  - its build assets (hashed, immutable) are cache-first;
 *  - web fonts (this origin's /fonts/, scripts/fonts.mjs) are cached as they are seen (stale-while-revalidate);
 *  - the room service (/api, /r) and everything else stay live.
 */
export const CACHE_PREFIX = 'obpal-p-'
export const FONT_CACHE = 'obpal-fonts-v1'
export const cacheName = (version: string) => `${CACHE_PREFIX}${version}`

export type Route = 'shell' | 'precache' | 'fonts' | 'network'

export function route(req: { url: string; method: string; mode: string }, origin: string, precached: ReadonlySet<string>): Route {
  if (req.method !== 'GET') return 'network'
  let url: URL
  try { url = new URL(req.url) } catch { return 'network' }
  if (url.origin !== origin) return 'network'
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/r/')) return 'network'
  if (req.mode === 'navigate') return url.pathname === '/p' || url.pathname.startsWith('/p/') ? 'shell' : 'network'
  if (precached.has(url.pathname)) return 'precache'
  return url.pathname.startsWith('/fonts/') && url.pathname.endsWith('.woff2') ? 'fonts' : 'network'
}

/** Old versions of this app's cache (never the font cache, which is shared across versions). */
export const staleCaches = (names: readonly string[], current: string) => names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== current)
