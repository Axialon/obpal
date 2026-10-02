import { b64url, fromB64url, newSecret } from '@obpal/core'

export interface ShareSession { play: string; watch: string; owner: string; room?: string; playOpen: boolean; watchOpen: boolean; revision?: number; pending?: boolean }
/** Tab-scoped secrets survive reload; the persistent certificate supplies the unchanged DTLS identity. */
export function shareSession(id: string): ShareSession {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`obpal.share:${id}`) ?? 'null') as ShareSession | null
    if (saved && ['play', 'watch', 'owner'].every(k => /^[A-Za-z0-9_-]{22}$/.test(saved[k as 'play'])) && typeof saved.playOpen === 'boolean' && typeof saved.watchOpen === 'boolean') return saved
  } catch { /* Storage may be unavailable. */ }
  return { play: b64url(newSecret()), watch: b64url(newSecret()), owner: b64url(newSecret()), playOpen: true, watchOpen: true }
}
export function keepShareSession(id: string, session: ShareSession) {
  try { sessionStorage.setItem(`obpal.share:${id}`, JSON.stringify(session)) } catch { /* An ephemeral session still works. */ }
}
export const sessionKey = (s: ShareSession, key: 'play' | 'watch') => fromB64url(s[key])
