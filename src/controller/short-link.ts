import { encodePairing, fromB64url, openShareTarget } from '@obpal/core'

/** A short capability URL resolves locally. Only encrypted scene metadata comes back from the service. */
export async function resolveShortLink(fragment: string, origin: string): Promise<string> {
  const match = /^#?s\.([pw])\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(fragment)
  if (!match) throw new Error('Open a fresh shared scene link')
  const [, role, room, key] = match, capability = role === 'w' ? 'watch' : 'play', secret = fromB64url(key)
  for (let n = 0; n < 4; n++) {
    const response = await fetch(`${origin}/api/share/${room}/${capability}`, { cache: 'no-store', signal: AbortSignal.timeout(1500) })
    if (response.ok) {
      const { sealed } = await response.json() as { sealed: string }
      let target
      try { target = await openShareTarget(secret, sealed) } catch { throw new Error('Open a fresh shared scene link') }
      const url = new URL(target.path, origin)
      if (url.origin !== origin || !/^\/(?:sim|view)\//.test(url.pathname)) throw new Error('Invalid shared scene')
      url.searchParams.delete('watch'); url.searchParams.delete('join')
      if (capability === 'watch') url.searchParams.set('watch', '1'); else url.searchParams.set('join', 'play')
      url.hash = encodePairing({ room, secret, fp: fromB64url(target.fp), capability })
      return url.href
    }
    if (response.status !== 404) throw new Error('Connection lost')
    if (n < 3) await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Sharing stopped')
}
