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
export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))

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

/**
 * The SHA-256 DTLS fingerprint an SDP blob commits to, read strictly: the description must have exactly one media
 * section and exactly one `a=fingerprint` line (at session level or in that section, so it is the one DTLS checks),
 * and it must be a well-formed sha-256 fingerprint. Anything else is null. A description that says more (a second
 * fingerprint anywhere, one hidden in another line's text, a second media section) could show one fingerprint to
 * this parser and another to DTLS, which is how someone relaying between two DTLS sessions would pass a check.
 */
export function sdpFingerprint(sdp: string | undefined | null): Uint8Array | null {
  const lines = (sdp ?? '').split(/\r?\n/)
  if (lines.filter((l) => l.startsWith('m=')).length !== 1) return null
  const fps = lines.filter((l) => l.startsWith('a=fingerprint:'))
  if (fps.length !== 1) return null
  const m = /^a=fingerprint:sha-256 ((?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/i.exec(fps[0].trimEnd())
  return m ? Uint8Array.from(m[1].split(':').map((h) => parseInt(h, 16))) : null
}

/**
 * The session an SDP blob belongs to: its o= line's session id, which stays the same through every offer one peer
 * connection makes (RFC 8829 §5.2.2), so a later offer with it renegotiates that connection. Null without one.
 */
export function sdpSession(sdp: string | undefined | null): string | null {
  return /^o=\S+ (\d{1,20}) \d+ IN /m.exec(sdp ?? '')?.[1] ?? null
}

/** Fingerprint as SDP writes it: upper-case hex pairs joined by colons. */
export const fingerprintHex = (fp: Uint8Array) => Array.from(fp, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')

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
 * A key both ends of a binding hold: the QR code's secret as bytes, or a remembered pairing's key, which is kept as a
 * non-extractable HKDF key (importPairKey).
 */
export type BindKey = Uint8Array | CryptoKey

/**
 * A remembered pairing's key as both ends keep it: a non-extractable HKDF key, good for the binding's MAC (deriveKey)
 * and the direct code's ICE credentials (deriveBits). Script can use it, but no script, the page's own included, can
 * read it back.
 */
export function importPairKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey'])
}

/** HKDF's input key: bytes are imported for this one use, and a kept key is used as it is. */
const hkdfKey = (key: BindKey, usage: KeyUsage): Promise<CryptoKey> =>
  key instanceof Uint8Array ? crypto.subtle.importKey('raw', key as BufferSource, 'HKDF', false, [usage]) : Promise.resolve(key)

async function hkdf(key: BindKey, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const base = await hkdfKey(key, 'deriveBits')
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(info) }, base, bytes * 8)
  return new Uint8Array(bits)
}

/**
 * Channel binding: proves the device holds the pairing key and binds it to both DTLS identities and to the
 * context of this attempt (the room id online, "lan:<nonce>" for a direct LAN connection).
 * mac = HMAC-SHA256(HKDF(key, salt=context, info="obpal bind v1"), fpDevice || fpHost || context)
 */
export async function bindMac(key: BindKey, fpDevice: Uint8Array, fpHost: Uint8Array, context: string): Promise<string> {
  const base = await hkdfKey(key, 'deriveKey')
  const mac = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(context), info: enc.encode('obpal bind v1') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', mac, concat(fpDevice, fpHost, enc.encode(context)) as BufferSource)
  return b64url(new Uint8Array(sig))
}

// ---- Direct LAN pairing (no room service) ---------------------------------------------------------------------
//
// After one online pairing both sides remember each other (a pairing id and key, each side's persistent DTLS
// fingerprint). When the room service can't be reached, the host shows a second kind of code: its own live ICE
// credentials and host candidates plus a fresh nonce. The phone answers with ICE credentials derived from the
// pairing key and the nonce, so the host can complete ICE without ever receiving the phone's SDP: the phone's
// address is learnt from its connectivity checks (a peer-reflexive candidate). DTLS then pins the remembered
// fingerprints on both sides, and the same HMAC binding as online proves the phone holds the key.

/** A host candidate for the LAN code: an mDNS name (<uuid>.local, what browsers advertise) or an IP literal. */
export interface LanCandidate { host: string; port: number }

export interface LanPairing {
  /** Pairing id (16 bytes), minted by the host when the phone first paired online. */
  id: Uint8Array
  /** Fresh per-code nonce (16 bytes); the derived credentials and the binding change with it. */
  nonce: Uint8Array
  /** The host's real ICE credentials for this attempt. */
  ufrag: string
  pwd: string
  /** The host's UDP host candidates (at most LAN_MAX_CANDIDATES). */
  cands: LanCandidate[]
}

export const LAN_MAX_CANDIDATES = 4
/** The direct code's binding context (also the salt of the derived ICE credentials). */
export const lanContext = (nonce: Uint8Array) => `lan:${b64url(nonce)}`

const ICE_CHARS = /^[A-Za-z0-9+/]+$/
const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const IPV6 = /^[0-9a-f:]+(%[A-Za-z0-9._-]{1,16})?$/i
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$/

export const isIceChars = (s: string, min: number) => s.length >= min && s.length <= 256 && ICE_CHARS.test(s)
export const isLanHost = (h: string) => h.length <= 253 && (IPV4.test(h) || (h.includes(':') && IPV6.test(h)) || HOSTNAME.test(h))

const uuidBytes = (name: string): Uint8Array | null => {
  const m = UUID.exec(name)
  if (!m) return null
  const hex = m.slice(1).join('')
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16))
}
const uuidString = (b: Uint8Array) => {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** mDNS names (36-char UUIDs) shrink to 22 characters; everything else travels as written. */
function encodeCandidate(c: LanCandidate): string {
  const u = c.host.endsWith('.local') ? uuidBytes(c.host.slice(0, -6)) : null
  return `${u ? `m${b64url(u)}` : `a${c.host}`}~${c.port}`
}

function decodeCandidate(s: string): LanCandidate | null {
  const m = /^([ma])(.+)~(\d{1,5})$/.exec(s)
  if (!m) return null
  const port = Number(m[3])
  if (!(port >= 1 && port <= 65535)) return null
  if (m[1] === 'm') {
    if (m[2].length !== 22) return null
    try {
      const b = fromB64url(m[2])
      return b.length === 16 ? { host: `${uuidString(b)}.local`, port } : null
    } catch {
      return null
    }
  }
  return isLanHost(m[2]) ? { host: m[2], port } : null
}

/** The direct code: `2.<id>.<nonce>.<ufrag>.<pwd>.<candidates>`, in the same URL fragment position as the online code. */
export function encodeLanPairing(p: LanPairing): string {
  return `2.${b64url(p.id)}.${b64url(p.nonce)}.${p.ufrag}.${p.pwd}.${p.cands.slice(0, LAN_MAX_CANDIDATES).map(encodeCandidate).join(',')}`
}

const LAN_CODE = /^2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9+/]{4,256})\.([A-Za-z0-9+/]{22,256})\.([^.,]*(?:[.,][^.,]*)*)$/

export function parseLanPairing(fragment: string): LanPairing | null {
  // The first five fields never contain dots; candidates (IP literals, names) may, so they are the tail.
  const m = LAN_CODE.exec(fragment.replace(/^#/, ''))
  if (!m) return null
  const [, idS, nonceS, ufrag, pwd, candS] = m
  if (candS.length > 1024) return null
  try {
    const id = fromB64url(idS)
    const nonce = fromB64url(nonceS)
    if (id.length !== 16 || nonce.length !== 16) return null
    const cands = candS.split(',').map(decodeCandidate)
    if (!cands.length || cands.length > LAN_MAX_CANDIDATES || cands.some((c) => !c)) return null
    return { id, nonce, ufrag, pwd, cands: cands as LanCandidate[] }
  } catch {
    return null
  }
}

/** Either kind of code from a pairing URL's fragment. */
export type PairingCode = { v: 1; pairing: Pairing } | { v: 2; lan: LanPairing }

export function parsePairingCode(fragment: string): PairingCode | null {
  const pairing = parsePairing(fragment)
  if (pairing) return { v: 1, pairing }
  const lan = parseLanPairing(fragment)
  return lan ? { v: 2, lan } : null
}

/**
 * The phone's ICE credentials for a direct code, known to both sides without any exchange:
 * HKDF-SHA256(key, salt = nonce, info = "obpal lan ice v1") -> 24 bytes -> base64 (the ice-char alphabet):
 * 8 characters of ufrag and 24 of password.
 */
export async function lanIceCredentials(key: BindKey, nonce: Uint8Array): Promise<{ ufrag: string; pwd: string }> {
  const bytes = await hkdf(key, nonce, 'obpal lan ice v1', 24)
  const s = btoa(String.fromCharCode(...bytes))
  return { ufrag: s.slice(0, 8), pwd: s.slice(8, 32) }
}

/** Replace the ICE credentials of a local description before setLocalDescription. */
export function mungeIce(sdp: string, ufrag: string, pwd: string): string {
  return sdp.replace(/^a=ice-ufrag:.*$/gm, `a=ice-ufrag:${ufrag}`).replace(/^a=ice-pwd:.*$/gm, `a=ice-pwd:${pwd}`)
}

/** Read the ICE credentials and UDP host candidates of a gathered local description. */
export function readLocalIce(sdp: string | undefined | null): { ufrag: string; pwd: string; cands: LanCandidate[] } | null {
  const ufrag = /^a=ice-ufrag:(\S+)/m.exec(sdp ?? '')?.[1]
  const pwd = /^a=ice-pwd:(\S+)/m.exec(sdp ?? '')?.[1]
  if (!ufrag || !pwd) return null
  return { ufrag, pwd, cands: candidatesOf(sdp ?? '') }
}

/** UDP host candidates from candidate lines (SDP a= lines or RTCIceCandidate.candidate strings), deduplicated. */
export function candidatesOf(text: string): LanCandidate[] {
  const out: LanCandidate[] = []
  for (const m of text.matchAll(/candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gi)) {
    const c = { host: m[1], port: Number(m[2]) }
    if (isLanHost(c.host) && c.port > 0 && !out.some((o) => o.host === c.host && o.port === c.port)) out.push(c)
  }
  return out.slice(0, LAN_MAX_CANDIDATES)
}

const sdpHead = (ufrag: string, pwd: string, fp: Uint8Array, setup: 'actpass' | 'active') => [
  'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, 'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${fingerprintHex(fp)}`, `a=setup:${setup}`, 'a=mid:0', 'a=sctp-port:5000', 'a=max-message-size:262144',
]

/** The host's offer as the phone reconstructs it from the direct code and the remembered host fingerprint. */
export function lanOfferSdp(p: { ufrag: string; pwd: string; fp: Uint8Array; cands: LanCandidate[] }): string {
  const cands = p.cands.map((c, i) => `a=candidate:${i + 1} 1 udp ${2113937151 - i} ${c.host} ${c.port} typ host`)
  return [...sdpHead(p.ufrag, p.pwd, p.fp, 'actpass'), ...cands, ''].join('\r\n')
}

/** The phone's answer as the host reconstructs it: derived credentials, the remembered phone fingerprint, no candidates. */
export function lanAnswerSdp(p: { ufrag: string; pwd: string; fp: Uint8Array }): string {
  return [...sdpHead(p.ufrag, p.pwd, p.fp, 'active'), ''].join('\r\n')
}
