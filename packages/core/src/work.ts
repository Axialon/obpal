/**
 * Proof of work for the short code's room service (PROTOCOL §2b), Hashcash-style. Under pressure the service hands out
 * a challenge, and a lookup or a new code comes back with a counter `x` for which SHA-256("<challenge>:<x>") starts
 * with `bits` zero bits. It is open (no third party, nothing to sign up for), and the same few lines serve the phone,
 * the screen and the service. SHA-256 is written out here, synchronous, for the tight loop.
 */

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
const W = new Uint32Array(64)

/** SHA-256 of some bytes. */
export function sha256(data: Uint8Array): Uint8Array {
  const n = data.length
  const blocks = Math.ceil((n + 9) / 64)
  const m = new Uint8Array(blocks * 64)
  m.set(data)
  m[n] = 0x80
  const bits = n * 8
  const view = new DataView(m.buffer)
  view.setUint32(m.length - 8, Math.floor(bits / 2 ** 32))
  view.setUint32(m.length - 4, bits >>> 0)
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(b * 64 + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = W[i - 15], y = W[i - 2]
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0
    }
    let a = h0, bb = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
      const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  ;[h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => ov.setUint32(i * 4, v >>> 0))
  return out
}

const enc = new TextEncoder()

/** HMAC-SHA-256 (the service signs its challenges with it). */
export function hmacSha256(key: Uint8Array, message: string | Uint8Array): Uint8Array {
  const k = key.length > 64 ? sha256(key) : key
  const pad = (x: number) => Uint8Array.from({ length: 64 }, (_, i) => (k[i] ?? 0) ^ x)
  const msg = typeof message === 'string' ? enc.encode(message) : message
  const inner = new Uint8Array(64 + msg.length)
  inner.set(pad(0x36))
  inner.set(msg, 64)
  const outer = new Uint8Array(96)
  outer.set(pad(0x5c))
  outer.set(sha256(inner), 64)
  return sha256(outer)
}

/** How many zero bits a digest starts with. */
export function leadingZeroBits(d: Uint8Array): number {
  let n = 0
  for (const byte of d) {
    if (byte === 0) { n += 8; continue }
    return n + Math.clz32(byte) - 24
  }
  return n
}

/** Whether `x` is a solution: SHA-256("<challenge>:<x>") starts with `bits` zero bits. */
export const workDone = (challenge: string, x: string, bits: number) => leadingZeroBits(sha256(enc.encode(`${challenge}:${x}`))) >= bits

/**
 * Find a solution (a base-36 counter), giving the page a moment every few thousand tries so it stays responsive.
 * Null past `maxTries` (about 2^bits tries are needed on average).
 */
export async function solveWork(challenge: string, bits: number, maxTries = 2 ** 26): Promise<string | null> {
  for (let i = 0; i < maxTries; i++) {
    const x = i.toString(36)
    if (workDone(challenge, x, bits)) return x
    if ((i & 4095) === 4095) await new Promise((r) => setTimeout(r, 0))
  }
  return null
}
