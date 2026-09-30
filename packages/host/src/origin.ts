export const OFFICIAL_ORIGIN = 'https://obpal.blackboxes.net'
export const OFFICIAL_EXTENSION_ORIGIN = 'chrome-extension://jnnpcnoilofjaffabnhecfokjjknlemg'

/** Exact origins only. Local loopback is for development, never a similarly named public host. */
export function isOfficialOrigin(origin: string): boolean {
  if (origin === OFFICIAL_EXTENSION_ORIGIN) return true
  try {
    const u = new URL(origin)
    return u.origin === OFFICIAL_ORIGIN || (['http:', 'https:'].includes(u.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch { return false }
}

/** An honest fork can keep this disclosure. A malicious copy can remove it; it is not authentication. */
export function communityMarker(origin: string): HTMLAnchorElement | null {
  if (isOfficialOrigin(origin)) return null
  const a = document.createElement('a')
  a.className = 'community-build'
  a.href = `${OFFICIAL_ORIGIN}/trust/`
  a.textContent = 'Community build: not run by ob.Pal'
  a.rel = 'noopener'
  return a
}
