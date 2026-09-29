/** Only this deployment's pairing links, or a complete short code. A scan is data, never a navigation. */
import { encodeLanPairing, encodePairing, parsePairingCode, splitCode, type PairingCode } from '@obpal/core'

export type ScanCode = { kind: 'pairing'; code: PairingCode } | { kind: 'short'; digits: string }

export function readScan(text: string, origin: string): ScanCode | null {
  if (text.length > 2048 || /[\u0000-\u001f\u007f\\]/.test(text)) return null
  const value = text.trim()
  if (/^[1-9][0-9 -]{9,18}$/.test(value)) {
    const digits = value.replace(/[ -]/g, '')
    return splitCode(digits) ? { kind: 'short', digits } : null
  }
  try {
    const u = new URL(value)
    const home = new URL(origin)
    if (u.origin !== home.origin || u.username || u.password || u.search || u.pathname !== '/p/' ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) return null
    // Reject encoded paths, normalised dot segments and alternate spellings, not just the parsed result.
    if (value !== `${u.origin}/p/${u.hash}`) return null
    const code = parsePairingCode(u.hash)
    if (!code || (code.v === 2 && encodeLanPairing(code.lan) !== u.hash.slice(1))) return null
    return { kind: 'pairing', code }
  } catch { return null }
}

/** Site navigation is reconstructed from parsed data, never copied from a QR value. */
export function scanDestination(text: string, origin: string): string | null {
  const result = readScan(text, origin)
  if (!result) return null
  if (result.kind === 'short') return `/p/#code=${result.digits}`
  const code = result.code
  if (code.v === 1) return `/p/#${encodePairing(code.pairing)}`
  if (code.v === 2) return `/p/#${encodeLanPairing(code.lan)}`
  return null
}
