import { type BindKey, importPairKey } from './pairing'

/** Three six-bit glyph indices. Public comparison aid, never a credential. */
export type ConnectionSeal = readonly [number, number, number]

/**
 * Online: the ordered, verified DTLS fingerprints and room. LAN: the remembered key, salted by both fingerprints
 * and the fresh LAN context. Peers authenticate a fresh session nonce before using it here, even with persistent
 * certificates. A separate HKDF label keeps this display value apart from authentication and ICE keys.
 */
export async function connectionSeal(fpDevice: Uint8Array, fpHost: Uint8Array, context: string, lanKey?: BindKey, nonce = ''): Promise<ConnectionSeal> {
  if (fpDevice.length !== 32 || fpHost.length !== 32 || !context) throw new Error('Invalid seal binding')
  const enc = new TextEncoder()
  const room = enc.encode(nonce ? sealSessionContext(context, nonce) : context)
  const binding = new Uint8Array(64 + room.length)
  binding.set(fpDevice); binding.set(fpHost, 32); binding.set(room, 64)
  const key = lanKey instanceof Uint8Array ? await importPairKey(lanKey) : lanKey ?? await importPairKey(binding)
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: binding, info: enc.encode('obpal connection seal v1') }, key, 24))
  return [bits[0] >> 2, ((bits[0] & 3) << 4) | (bits[1] >> 4), ((bits[1] & 15) << 2) | (bits[2] >> 6)]
}
/** Freshness is authenticated by a MAC under the already-proven pairing key before either end shows the seal. */
export function sealSessionContext(context: string, nonce: string): string {
  if (!/^[A-Za-z0-9_-]{22}$/.test(nonce)) throw new Error('Invalid seal nonce')
  return `${context}\0seal:${nonce}`
}

export { GLYPH_GRID, SEAL_GLYPHS, glyphDots } from './seal-glyphs'
import { SEAL_GLYPHS } from './seal-glyphs'
export const sealNames = (seal: ConnectionSeal) => seal.map((i) => SEAL_GLYPHS[i].name).join(', ')
