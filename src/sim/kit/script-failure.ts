/**
 * Whether a script that failed to load is one of this site's own modules. A scene cannot start without those. A script
 * another origin put on the page is no failure of the scene: Cloudflare's Web Analytics adds a module script to pages it
 * serves, the page policy blocks it, and the browser reports the block as an `error` on that script.
 */
export function ownModuleFailed(script: { type: string; src: string }, origin: string): boolean {
  if (script.type !== 'module') return false
  try { return new URL(script.src, origin).origin === origin } catch { return false }
}
