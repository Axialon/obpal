import { describe, expect, it } from 'vitest'
import { b64url, CodePake, elligator2, formatCode, isCodeHandle, ladder, normalizeCode, randomDigits, splitCode, spokenCode, x25519 } from '@obpal/core'

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)))
const fp = (n: number) => new Uint8Array(32).fill(n)

describe('reading a typed code', () => {
  it('keeps digits and drops separators', () => {
    expect(normalizeCode('482 193 705')).toBe('482193705')
    expect(normalizeCode(' 482-193-705 ')).toBe('482193705')
    expect(normalizeCode('482.193.705')).toBe('482193705')
    expect(normalizeCode('482 193 705')).toBe('482193705')
  })
  it('reads lookalike letters and full-width digits as digits', () => {
    expect(normalizeCode('O82 I93 7o5')).toBe('082193705')
    expect(normalizeCode('l23')).toBe('123')
    expect(normalizeCode('４８２１９３７０５')).toBe('482193705')
  })
  it('refuses anything else', () => {
    for (const s of ['48219370x', 'https://x', '482+193']) expect(normalizeCode(s)).toBeNull()
  })
  it('groups for reading and spells out for screen readers', () => {
    expect(formatCode('4821937056')).toBe('482 193 7056')
    expect(formatCode('4821')).toBe('482 1')
    expect(formatCode('482193705')).toBe('482 193 705')
    expect(spokenCode('4821937056')).toBe('4 8 2, 1 9 3, 7 0 5 6')
  })
  it('splits a ten-digit code into its handle and its secret, five digits each', () => {
    expect(splitCode('4821937056')).toEqual({ handle: '48219', secret: '37056' })
    for (const s of ['482193705', '48219370561', '482193705a', '0482193705']) expect(splitCode(s)).toBeNull()
    expect(isCodeHandle('48219')).toBe(true)
    for (const h of ['04821', '4821', '482190']) expect(isCodeHandle(h)).toBe(false)
  })
  it('has one length, starting 1 to 9, so no code is the start of another', () => {
    // A code being typed is never mistaken for a whole one: only the tenth digit completes it.
    for (let n = 1; n < 10; n++) expect(splitCode('4821937056'.slice(0, n))).toBeNull()
  })
  it('makes secrets of evenly spread digits', () => {
    const counts = new Array(10).fill(0)
    for (let i = 0; i < 2000; i++) for (const d of randomDigits(5)) counts[Number(d)]++
    expect(randomDigits(5)).toMatch(/^\d{5}$/)
    for (const c of counts) expect(c).toBeGreaterThan(800) // 1000 each on average
  })
})

describe('X25519 (RFC 7748)', () => {
  it('matches the RFC test vector', () => {
    const k = unhex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
    const u = unhex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    expect(hex(x25519(k, u))).toBe('c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552')
  })
  it('agrees with the platform X25519 on random keys and points', async () => {
    const pkcs8 = (k: Uint8Array) => Uint8Array.from([...unhex('302e020100300506032b656e04220420'), ...k])
    for (let i = 0; i < 6; i++) {
      const k = crypto.getRandomValues(new Uint8Array(32))
      const other = crypto.getRandomValues(new Uint8Array(32))
      const u = x25519(other, Uint8Array.of(9))
      const priv = await crypto.subtle.importKey('pkcs8', pkcs8(k), { name: 'X25519' }, true, ['deriveBits'])
      const pub = await crypto.subtle.importKey('raw', u as BufferSource, { name: 'X25519' }, true, [])
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
      expect(hex(x25519(k, u))).toBe(hex(shared))
      const jwk = await crypto.subtle.exportKey('jwk', priv)
      expect(b64url(x25519(k, Uint8Array.of(9)))).toBe(jwk.x)
    }
  })
})

describe('Elligator 2 onto curve25519 (RFC 9380, curve25519_XMD:SHA-512_ELL2_NU_)', () => {
  // u is the field element hashed from each message; Q = map_to_curve(u); P = clear_cofactor(Q) = 8Q.
  const vectors = [
    ['608d892b641f0328523802a6603427c26e55e6f27e71a91a478148d45b5093cd', '51125222da5e763d97f3c10fcc92ea6860b9ccbbd2eb1285728f566721c1e65b', '1bb913f0c9daefa0b3375378ffa534bda5526c97391952a7789eb976edfe4d08'],
    ['46f5b22494bfeaa7f232cc8d054be68561af50230234d7d1d63d1d9abeca8da5', '7d56d1e08cb0ccb92baf069c18c49bb5a0dcd927eff8dcf75ca921ef7f3e6eeb', '7c22950b7d900fa866334262fcaea47a441a578df43b894b4625c9b450f9a026'],
    ['235fe40c443766ce7e18111c33862d66c3b33267efa50d50f9e8e5d252a40aaa', '3fbe66b9c9883d79e8407150e7c2a1c8680bee496c62fabe4619a72b3cabe90f', '31ad08a8b0deeb2a4d8b0206ca25f567ab4e042746f792f4b7973f3ae2096c52'],
    ['001e92a544463bda9bd04ddbe3d6eed248f82de32f522669efc5ddce95f46f5b', '227e0bb89de700385d19ec40e857db6e6a3e634b1c32962f370d26f84ff19683', '027877759d155b1997d0d84683a313eb78bdb493271d935b622900459d52ceaa'],
    ['1a68a1af9f663592291af987203393f707305c7bac9c8d63d6a729bdc553dc19', '3bcd651ee54d5f7b6013898aab251ee8ecc0688166fce6e9548d38472f6bd196', '5fd892c0958d1a75f54c3182a18d286efab784e774d1e017ba2fb252998b5dc1'],
  ]
  it('maps each u to the expected point, and 8 times it to the cleared one', () => {
    for (const [u, qx, px] of vectors) {
      const q = elligator2(BigInt(`0x${u}`))
      expect(q.toString(16).padStart(64, '0')).toBe(qx)
      expect(ladder(8n, q).toString(16).padStart(64, '0')).toBe(px)
    }
  })
})

describe('the short-code exchange', () => {
  const room = 'A'.repeat(22)
  const run = async (dev: { secret: string; handle?: string; room?: string }, host: { secret: string; handle?: string; room?: string }, fps = [fp(1), fp(2), fp(1), fp(2)]) => {
    const d = await CodePake.start('device', { handle: '4821', room, ...dev })
    const h = await CodePake.start('host', { handle: '4821', room, ...host })
    const dm = await d.confirm(h.share, fps[0], fps[1])
    const hm = await h.confirm(d.share, fps[2], fps[3])
    return { dm, hm }
  }
  it('agrees when both hold the same code and see the same two fingerprints', async () => {
    const { dm, hm } = await run({ secret: '93705' }, { secret: '93705' })
    expect(dm && hm).toBeTruthy()
    expect(dm!.mine).toBe(hm!.theirs)
    expect(hm!.mine).toBe(dm!.theirs)
    expect(dm!.mine).not.toBe(hm!.mine)
  })
  it('fails with a wrong secret, handle or room', async () => {
    for (const [dev, host] of [
      [{ secret: '93706' }, { secret: '93705' }],
      [{ secret: '93705', handle: '4822' }, { secret: '93705' }],
      [{ secret: '93705', room: 'B'.repeat(22) }, { secret: '93705' }],
    ] as const) {
      const { dm, hm } = await run(dev, host)
      expect(dm!.mine).not.toBe(hm!.theirs)
      expect(hm!.mine).not.toBe(dm!.theirs)
    }
  })
  it('fails when someone in the middle terminates DTLS on either side (the fingerprints differ)', async () => {
    const { dm, hm } = await run({ secret: '93705' }, { secret: '93705' }, [fp(1), fp(9), fp(8), fp(2)])
    expect(dm!.mine).not.toBe(hm!.theirs)
  })
  it('is fresh every time, and refuses shares that would fix the key', async () => {
    const a = await CodePake.start('device', { secret: '93705', handle: '4821', room })
    const b = await CodePake.start('device', { secret: '93705', handle: '4821', room })
    expect(b64url(a.share)).not.toBe(b64url(b.share))
    expect(await a.confirm(new Uint8Array(32), fp(1), fp(2))).toBeNull()
    expect(await a.confirm(Uint8Array.of(1, ...new Uint8Array(31)), fp(1), fp(2))).toBeNull() // u = 1 has order 4
    expect(await a.confirm(new Uint8Array(31), fp(1), fp(2))).toBeNull()
  })
})
