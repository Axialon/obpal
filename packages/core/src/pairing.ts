const enc = new TextEncoder()

export function b64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array {
  let t = s.replace(/-/g, '+').replace(/_/g, '/')
  while (t.length % 4) t += '='
  const bin = atob(t)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** What the QR code carries, in the URL fragment (never sent to any server). */
export interface Pairing {
  /** 128-bit pairing secret. */
  secret: Uint8Array
  /** SHA-256 fingerprint of the host's DTLS certificate (32 bytes). */
  fp: Uint8Array
}

export const newSecret = () => crypto.getRandomValues(new Uint8Array(16))

export function encodePairing(p: Pairing): string {
  return `1.${b64url(p.secret)}.${b64url(p.fp)}`
}

export function parsePairing(fragment: string): Pairing | null {
  const [v, s, f] = fragment.replace(/^#/, '').split('.')
  if (v !== '1' || !s || !f) return null
  try {
    const secret = fromB64url(s)
    const fp = fromB64url(f)
    return secret.length === 16 && fp.length === 32 ? { secret, fp } : null
  } catch {
    return null
  }
}

/** Public room id: a hash of the secret, so the room service never learns the secret. */
export async function roomIdFor(secret: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', concat(enc.encode('obpal-room-v1'), secret))
  return b64url(new Uint8Array(d)).slice(0, 22)
}

/** SHA-256 DTLS fingerprint from an SDP blob. */
export function sdpFingerprint(sdp: string | undefined | null): Uint8Array | null {
  const m = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/i.exec(sdp ?? '')
  if (!m) return null
  const hex = m[1].split(':')
  return hex.length === 32 ? Uint8Array.from(hex.map((h) => parseInt(h, 16))) : null
}

/** Fingerprint of a certificate, via getFingerprints() or a throwaway offer where unsupported. */
export async function certFingerprint(cert: RTCCertificate): Promise<Uint8Array> {
  const list = (cert as RTCCertificate & { getFingerprints?: () => RTCDtlsFingerprint[] }).getFingerprints?.()
  const f = list?.find((x) => x.algorithm?.toLowerCase() === 'sha-256')
  if (f?.value) return Uint8Array.from(f.value.split(':').map((h) => parseInt(h, 16)))
  const pc = new RTCPeerConnection({ certificates: [cert] })
  pc.createDataChannel('fp')
  const offer = await pc.createOffer()
  pc.close()
  const fp = sdpFingerprint(offer.sdp)
  if (!fp) throw new Error('Could not read the DTLS fingerprint')
  return fp
}

/**
 * Channel binding: proves the device holds the pairing secret and binds it to both DTLS identities.
 * mac = HMAC-SHA256(HKDF(secret, salt=roomId, info="obpal bind v1"), fpDevice || fpHost || roomId)
 */
export async function bindMac(secret: Uint8Array, fpDevice: Uint8Array, fpHost: Uint8Array, roomId: string): Promise<string> {
  const base = await crypto.subtle.importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(roomId), info: enc.encode('obpal bind v1') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, concat(fpDevice, fpHost, enc.encode(roomId)) as BufferSource)
  return b64url(new Uint8Array(sig))
}
