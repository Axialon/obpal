/**
 * Pages that outlive a deploy. Each build names its chunks by content, and a deploy replaces the site's files, so a
 * page opened before one (or its HTML, still on an edge cache just after) can ask for a lazy chunk that is gone: the
 * QR code of the pairing chip, a model loader, a sim's view. Vite reports it as `vite:preloadError`, and the page
 * reloads itself once to pick up the new build.
 *
 * It never loops and never harms: at most one reload per RELOAD_WINDOW_MS in a tab (sessionStorage), none where
 * sessionStorage can't say so, none while offline or while the site doesn't answer, and none while something holds
 * the page: a phone pairing with it or driving it would lose its screen (the room is new on every load). The build
 * puts this on every page but the phone controller, whose service worker serves the cached page whatever a reload
 * does, and the embed demo, whose element recovers by itself (vite.config.ts).
 */

/** Where the last reload of this tab is written, as its time. */
export const RELOAD_KEY = 'obpal:deploy-reload'
/** A second failure inside this window is left alone: the build a reload found is the one that's broken. */
export const RELOAD_WINDOW_MS = 10 * 60_000

/** What the recovery needs from the page, so that it can be tested without one. */
export interface RecoverEnv {
  now(): number
  /** sessionStorage, or null where the browser won't give it. */
  storage: Pick<Storage, 'getItem' | 'setItem'> | null
  /** Something the page holds that a reload would lose. */
  held(): boolean
  /** The site answers for this page now. */
  reachable(): Promise<boolean>
  reload(): void
}

/** The handler for a failed chunk: true once it has reloaded the page. Events that arrive while it decides are dropped. */
export function recoverer(env: RecoverEnv): () => Promise<boolean> {
  let deciding = false
  return async () => {
    if (deciding) return false
    deciding = true
    try {
      if (env.held() || !env.storage) return false
      const last = Number(env.storage.getItem(RELOAD_KEY))
      // A clock set back leaves `last` in the future: that counts as recent too.
      if (last > 0 && env.now() - last < RELOAD_WINDOW_MS) return false
      if (!(await env.reachable())) return false
      // Written before the reload, so the page that comes back can't do it again.
      env.storage.setItem(RELOAD_KEY, String(env.now()))
      env.reload()
      return true
    } catch {
      return false
    } finally {
      deciding = false
    }
  }
}

const holds = new Set<() => boolean>()

/** Whether a page's hold applies now. A hold that can't answer applies. */
export function reloadHeld(): boolean {
  for (const busy of holds) {
    try { if (busy()) return true } catch { return true }
  }
  return false
}

/** Keeps the page from reloading itself while `busy()` is true. Returns a function that withdraws the hold. */
export function holdReload(busy: () => boolean): () => void {
  holds.add(busy)
  return () => { holds.delete(busy) }
}

/** Holds while a phone is pairing with this page or connected to it (the Remote's status), for as long as the page lives. */
export function holdForPhone(remote: { status: string }): () => void {
  return holdReload(() => remote.status === 'connecting' || remote.status === 'connected')
}

/** A head request for this page, so that a page is only replaced when there's a page to replace it with. */
async function siteAnswers(): Promise<boolean> {
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort(), 4000)
  try { return (await fetch(location.href, { method: 'HEAD', cache: 'no-store', signal: stop.signal })).ok } catch { return false } finally { clearTimeout(timer) }
}

if (typeof window !== 'undefined') {
  const recover = recoverer({
    now: () => Date.now(),
    get storage() { try { return sessionStorage } catch { return null } },
    held: reloadHeld,
    reachable: () => (navigator.onLine === false ? Promise.resolve(false) : siteAnswers()),
    reload: () => { console.warn('ob.Pal was updated while this page was open: loading the new version.'); location.reload() },
  })
  addEventListener('vite:preloadError', () => { void recover() })
}
