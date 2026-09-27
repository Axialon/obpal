/** Address and network limit keys. The relay secret has a separate HKDF use here; it never signs these directly. */
import { networks } from './codes'
import { hmacSha256 } from '../packages/core/src/work'

export interface NetworkKeys { addr: string; mid: string | null; wide: string }

export async function addressKey(secret: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!secret) throw new Error('Address limits need an existing worker secret')
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('obpal-address-limits-v1') }, key, 256))
}

/** Canonicalise before hashing, so all the spellings and addresses of one limited network share a key. */
export function addressNetworks(key: Uint8Array, ip: string | null): NetworkKeys {
  const net = networks(ip)
  const hash = (s: string) => Array.from(hmacSha256(key, s), (b) => b.toString(16).padStart(2, '0')).join('')
  return { addr: hash(net.addr), mid: net.mid === null ? null : hash(net.mid), wide: hash(net.wide) }
}
