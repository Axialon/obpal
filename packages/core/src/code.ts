/**
 * The short code (PROTOCOL §2b): ten digits to type on a phone instead of scanning the QR code, for a TV, a headset,
 * or a phone across the room. The first five are a handle the room service keeps for a few minutes (handle -> room);
 * the last five are a secret that never leaves the two devices. Once the phone is in the room, the two run a PAKE on
 * the secret over the DTLS channel: CPace's construction on X25519, bound to both DTLS fingerprints. Someone without
 * the secret, the room service included, gets one guess per code, and the host retires a code after its one attempt.
 *
 * Every code is ten digits and starts with 1 to 9, so no code is the start of another (a leading 0 is kept for a longer
 * code, should one ever be needed).
 */
import { b64url } from './pairing'
import { solveWork } from './work'

export const CODE_SECRET_DIGITS = 5
export const CODE_HANDLE_DIGITS = 5
export const CODE_DIGITS = 10
/** How long the room service keeps a code (the host asks for a fresh one before then while it's shown). */
export const CODE_TTL_MS = 10 * 60_000

/** Letters people type for digits that look like them. */
const LOOKALIKE: Record<string, string> = { o: '0', O: '0', D: '0', i: '1', I: '1', l: '1', L: '1', '|': '1' }

/**
 * What a person typed or pasted, as digits: spaces, dashes, dots and other separators go, lookalike letters
 * (O, I, l) become digits. Null when anything else is in it. The result may be shorter or longer than a code.
 */
export function normalizeCode(input: string): string | null {
  let out = ''
  for (const ch of input.normalize('NFKC')) {
    if (ch >= '0' && ch <= '9') out += ch
    else if (LOOKALIKE[ch]) out += LOOKALIKE[ch]
    else if (!/[\s\-–—.·_/,:]/.test(ch)) return null
  }
  return out
}

/**
 * A code as people read it: 3, 3 and 4 digits ("482 193 7056"). Partial codes group by three as far as they go.
 */
export const formatCode = (digits: string) =>
  digits.length === 10 ? `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}` : digits.replace(/(\d{3})(?=\d)/g, '$1 ')

/** A code for screen readers: each digit on its own, a pause between groups ("4 8 2, 1 9 3, 7 0 5 6"). */
export const spokenCode = (digits: string) => formatCode(digits).split(' ').map((g) => g.split('').join(' ')).join(', ')

/** A whole code: the first five digits are the handle, the last five the secret. */
export function splitCode(digits: string): { handle: string; secret: string } | null {
  if (!/^[1-9]\d{9}$/.test(digits)) return null
  return { handle: digits.slice(0, CODE_HANDLE_DIGITS), secret: digits.slice(CODE_HANDLE_DIGITS) }
}

export const isCodeHandle = (s: unknown): s is string => typeof s === 'string' && /^[1-9]\d{4}$/.test(s)

/** Uniformly random decimal digits (rejection sampling, so no digit is likelier than another). */
export function randomDigits(n: number): string {
  const buf = new Uint32Array(1)
  let out = ''
  while (out.length < n) {
    crypto.getRandomValues(buf)
    if (buf[0] >= 4_294_967_290) continue // the top 6 values would favour 0-5
    out += String(buf[0] % 10)
  }
  return out
}

// ---- the phone's lookup ---------------------------------------------------------------------------------------

export type CodeLookup = { room: string; ticket: string } | { error: 'no-code' | 'slow-down' | 'unreachable'; retry?: number }

/**
 * Ask the room service which room a handle belongs to. The service forgets the handle as it answers, and gives a
 * ticket for the host: the host takes this code's one attempt only from the device that looked it up.
 */
export async function lookupCode(service: string, handle: string, opts: { timeoutMs?: number; onWork?: () => void } = {}): Promise<CodeLookup> {
  let work: { c: string; x: string } | undefined
  // Under pressure the service asks for a proof of work first: find it, then ask again (at most a few rounds).
  for (let round = 0; round < 3; round++) {
    let r: Response
    try {
      r = await fetch(`${service}/api/code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: handle, ...(work ? { work } : {}) }),
        cache: 'no-store', signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
      })
    } catch {
      return { error: 'unreachable' }
    }
    const j = (await r.json().catch(() => ({}))) as { room?: unknown; ticket?: unknown; retry?: unknown; error?: unknown; challenge?: unknown; bits?: unknown }
    const id = /^[A-Za-z0-9_-]{22}$/
    if (r.ok && typeof j.room === 'string' && id.test(j.room) && typeof j.ticket === 'string' && id.test(j.ticket)) return { room: j.room, ticket: j.ticket }
    if (r.status === 404) return { error: 'no-code' }
    if (j.error === 'work' && typeof j.challenge === 'string' && typeof j.bits === 'number' && j.bits <= 24) {
      opts.onWork?.()
      const x = await solveWork(j.challenge, j.bits)
      if (x === null) break
      work = { c: j.challenge, x }
      continue
    }
    if (r.status === 429 || r.status === 503) return { error: 'slow-down', retry: typeof j.retry === 'number' ? j.retry : 30 }
    return { error: 'unreachable' }
  }
  return { error: 'slow-down', retry: 30 }
}

// ---- X25519 and Elligator 2 (RFC 7748, RFC 9380 §6.7.1) --------------------------------------------------------

const P = (1n << 255n) - 19n
const J = 486662n
const A24 = 121665n
const mod = (a: bigint) => { const r = a % P; return r < 0n ? r + P : r }

function pow(b: bigint, e: bigint): bigint {
  let r = 1n
  b = mod(b)
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P
    b = (b * b) % P
    e >>= 1n
  }
  return r
}
/** 1/a, and 0 for 0 (inv0). */
const inv = (a: bigint) => pow(a, P - 2n)
const isSquare = (a: bigint) => pow(a, (P - 1n) / 2n) !== P - 1n

const toLE = (n: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn))
function fromLE(b: Uint8Array): bigint {
  let n = 0n
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i])
  return n
}

/** The Montgomery ladder on curve25519: the u-coordinate of k·(u), for any k below 2^bits (no clamping). */
export function ladder(k: bigint, u: bigint, bits = 255): bigint {
  const x1 = mod(u)
  let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n
  for (let t = bits - 1; t >= 0; t--) {
    const kt = (k >> BigInt(t)) & 1n
    if (swap ^ kt) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2] }
    swap = kt
    const a = mod(x2 + z2), aa = (a * a) % P, b = mod(x2 - z2), bb = (b * b) % P, e = mod(aa - bb)
    const c = mod(x3 + z3), d = mod(x3 - z3), da = (d * a) % P, cb = (c * b) % P
    const s = mod(da + cb), m = mod(da - cb)
    x3 = (s * s) % P
    z3 = (x1 * ((m * m) % P)) % P
    x2 = (aa * bb) % P
    z2 = (e * mod(aa + A24 * e)) % P
  }
  if (swap) { [x2, x3] = [x3, x2]; [z2, z3] = [z3, z2] }
  return (x2 * inv(z2)) % P
}

/** X25519(k, u) as RFC 7748 defines it: the scalar clamped, the top bit of u ignored, 32 bytes little-endian. */
export function x25519(scalar: Uint8Array, u: Uint8Array): Uint8Array {
  const k = Uint8Array.from(scalar)
  k[0] &= 248
  k[31] = (k[31] & 127) | 64
  const uu = Uint8Array.from(u)
  uu[31] &= 127
  return toLE(ladder(fromLE(k), fromLE(uu)))
}

/** Elligator 2 onto curve25519 (Z = 2), the u-coordinate only: RFC 9380's map_to_curve_elligator2. */
export function elligator2(u: bigint): bigint {
  let t = mod(2n * u * u)
  if (t === P - 1n) t = 0n
  const x1 = mod(-J * inv(t + 1n))
  const gx1 = mod((mod((x1 + J) * x1) + 1n) * x1)
  return isSquare(gx1) ? x1 : mod(-x1 - J)
}

// ---- the exchange ---------------------------------------------------------------------------------------------

const enc = new TextEncoder()
const LABEL = 'obpal code v1'

/** Length-prefixed concatenation (one length byte each), so no two different inputs run together the same way. */
function lv(...parts: (Uint8Array | string)[]): Uint8Array<ArrayBuffer> {
  const bytes = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p))
  const out = new Uint8Array(bytes.reduce((n, b) => n + 1 + b.length, 0))
  let o = 0
  for (const b of bytes) {
    if (b.length > 255) throw new Error('field too long')
    out[o++] = b.length
    out.set(b, o)
    o += b.length
  }
  return out
}

/** The code's generator: SHA-512 over the label, the secret, the handle and the room, mapped onto the curve. */
async function generator(secret: string, handle: string, room: string): Promise<Uint8Array> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-512', lv(LABEL, secret, handle, room)))
  const u = h.slice(0, 32)
  u[31] &= 127
  return toLE(elligator2(fromLE(u)))
}

const allZero = (b: Uint8Array) => b.every((x) => x === 0)

/**
 * One side's X25519 key for one exchange. The platform's where it has X25519 in WebCrypto (Chrome 133, Safari 17,
 * Firefox 130 and later): native and constant time, and its private half out of script's reach. Elsewhere a random
 * scalar for the ladder above, which gives the same results (RFC 7748's vectors check both).
 */
type Ephemeral = { platform: CryptoKey } | { scalar: Uint8Array }

let platformX25519: Promise<boolean> | null = null
/** Whether WebCrypto here does X25519 (asked once). */
const hasPlatformX25519 = () =>
  (platformX25519 ??= crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']).then(() => true, () => false))

async function ephemeral(ladderOnly = false): Promise<Ephemeral> {
  if (!ladderOnly && (await hasPlatformX25519())) {
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
    return { platform: pair.privateKey }
  }
  return { scalar: crypto.getRandomValues(new Uint8Array(32)) }
}

/** X25519 of this side's key and `u`, or null for an all-zero result (a low-order `u`, which would fix the key). */
async function dh(key: Ephemeral, u: Uint8Array): Promise<Uint8Array | null> {
  if ('scalar' in key) {
    const k = x25519(key.scalar, u)
    return allZero(k) ? null : k
  }
  try {
    const pub = await crypto.subtle.importKey('raw', u as BufferSource, { name: 'X25519' }, false, [])
    const k = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, key.platform, 256))
    return allZero(k) ? null : k
  } catch {
    return null // WebCrypto refuses an all-zero result by throwing (RFC 7748 §6.1)
  }
}

/**
 * One side of the short-code exchange. Each side sends `share`; with the other's share, `confirm` gives the
 * confirmation to send (`mine`) and the one to expect (`theirs`). They match only if both used the same secret,
 * handle and room and see the same two DTLS fingerprints.
 */
export class CodePake {
  private constructor(readonly role: 'device' | 'host', private key: Ephemeral, readonly share: Uint8Array, private handle: string, private room: string) {}

  /** `ladderOnly`: use the ladder even where the platform has X25519 (tests check the two agree). */
  static async start(role: 'device' | 'host', p: { secret: string; handle: string; room: string }, o: { ladderOnly?: boolean } = {}): Promise<CodePake> {
    const g = await generator(p.secret, p.handle, p.room)
    const key = await ephemeral(o.ladderOnly)
    const share = await dh(key, g)
    if (!share) throw new Error('The code’s generator is a low-order point') // odds 2^-252: a hash that lands on one
    return new CodePake(role, key, share, p.handle, p.room)
  }

  /** Null when the other share is unusable (wrong size, or a low-order point that would fix the key). */
  async confirm(other: Uint8Array, fpDevice: Uint8Array, fpHost: Uint8Array): Promise<{ mine: string; theirs: string } | null> {
    if (other.length !== 32 || allZero(other)) return null
    const k = await dh(this.key, other)
    if (!k) return null
    const [shareDevice, shareHost] = this.role === 'device' ? [this.share, other] : [other, this.share]
    const base = await crypto.subtle.importKey('raw', k as BufferSource, 'HKDF', false, ['deriveKey'])
    const isk = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(LABEL), info: lv(shareDevice, shareHost, fpDevice, fpHost, this.room, this.handle) },
      base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign'],
    )
    const mac = async (who: string) => b64url(new Uint8Array(await crypto.subtle.sign('HMAC', isk, enc.encode(`${LABEL} ${who}`))))
    const [host, device] = await Promise.all([mac('host'), mac('device')])
    return this.role === 'device' ? { mine: device, theirs: host } : { mine: host, theirs: device }
  }
}
