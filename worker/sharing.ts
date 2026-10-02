/** Room admission persists across hibernation. Keys here are one-way verifiers, never link secrets. */
export interface Sharing {
  revision?: number
  owner: string
  play: string | null
  watch: string | null
  expiredWatchKey?: string
  links?: { play?: string; watch?: string }
  /** The instant the last signaling connection left, or null while anyone is here. */
  emptyAt: number | null
}
export const WATCH_IDLE_MS = 60 * 60_000
export const expiredWatch = (s: Sharing, now: number) => s.emptyAt !== null && now - s.emptyAt >= WATCH_IDLE_MS
export function admission(s: Sharing, key: string | null, now: number): 'player' | 'watcher' | null {
  if (!key) return null
  if (s.play && key === s.play) return 'player'
  if (s.watch && key === s.watch && !expiredWatch(s, now)) return 'watcher'
  return null
}
export async function ownerVerifier(proof: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`obpal owner v2:${proof}`)))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
