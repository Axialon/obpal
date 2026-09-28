import { describe, expect, it } from 'vitest'
import { solveWork, workDone } from '../../packages/core/src/work'
import { CODE_TTL_MS, CodeBook as HashedCodeBook, HANDLES, LIMITS, networks, readLookup, type Claim, type Take } from '../../worker/codes'

import { addressKey, addressNetworks } from '../../worker/address'
const hashKey = await addressKey('test address secret')
const net = (ip: string) => addressNetworks(hashKey, ip)
class CodeBook extends HashedCodeBook {
  claim(room: string, ip: string | ReturnType<typeof net>, work?: Parameters<HashedCodeBook['claim']>[2]) { return super.claim(room, typeof ip === 'string' ? net(ip) : ip, work) }
  take(handle: string, ip: string | ReturnType<typeof net>, work?: Parameters<HashedCodeBook['take']>[2]) { return super.take(handle, typeof ip === 'string' ? net(ip) : ip, work) }
}

const room = (n: number) => `room${String(n).padStart(18, '0')}`
function book(start = 1_000_000) {
  const clock = { t: start }
  let n = 0
  const b = new CodeBook(() => clock.t, (max) => (n++ * 7919) % max, () => `ticket${n}`)
  return { b, clock }
}
const code = (c: Claim) => { if (!('code' in c)) throw new Error(`no code: ${JSON.stringify(c)}`); return c.code }
/** An address in the i-th IPv6 /48, so each is a network of its own. */
const v6 = (i: number, host = 1) => `2001:${(0xdb8 + (i >> 16)).toString(16)}:${(i & 0xffff).toString(16)}::${host.toString(16)}`
/** Misses from as many networks as it takes to empty everyone's budget. */
const drain = (b: CodeBook, from = 0) => { for (let i = 0; i < LIMITS.missAll.cap; i++) b.take('99999', v6(from + i)) }
async function solve(r: Claim | Take) {
  if (!('error' in r) || r.error !== 'work') throw new Error(`no challenge: ${JSON.stringify(r)}`)
  return { c: r.challenge, x: (await solveWork(r.challenge, r.bits))! }
}

describe('short codes in the room service', () => {
  it('hands a room a 5-digit handle from 10000, which one lookup spends and replaces at once', () => {
    const { b } = book()
    const h = code(b.claim(room(1), '1.2.3.4'))
    expect(h).toMatch(/^[1-9]\d{4}$/)
    const r = b.take(h, '5.6.7.8')
    if (!('room' in r)) throw new Error(JSON.stringify(r))
    expect(r.room).toBe(room(1))
    const next = code(r.next!)
    expect(next).not.toBe(h)
    expect(b.take(h, '5.6.7.8')).toEqual({ error: 'no-code' })
    expect('room' in b.take(next, '5.6.7.8')).toBe(true)
  })

  it('keeps one handle per room, forgets it after ten minutes, and when the host drops it', () => {
    const { b, clock } = book()
    const first = code(b.claim(room(1), '1.2.3.4'))
    const second = code(b.claim(room(1), '1.2.3.4'))
    expect(b.take(first, '9.9.9.1')).toEqual({ error: 'no-code' })
    clock.t += CODE_TTL_MS + 1
    expect(b.take(second, '9.9.9.2')).toEqual({ error: 'no-code' })
    const third = code(b.claim(room(1), '1.2.3.4'))
    b.drop(room(1), '12345')
    expect(b.codes.has(third)).toBe(true)
    b.drop(room(1), third)
    expect(b.codes.has(third)).toBe(false)
  })

  it('answers the same for unknown, expired and spent handles, and for anything that is not a handle', () => {
    const { b } = book()
    for (const h of ['00000', '1234', '123456', 'abcde', '']) expect(b.take(h, `10.0.${h.length}.1`)).toEqual({ error: 'no-code' })
  })
})

describe('networks', () => {
  it('reads an address as its networks: IPv4 /32 and /24, IPv6 /64, /56 and /48', () => {
    expect(networks('203.0.113.9')).toEqual({ addr: '4:203.0.113.9', mid: null, wide: '4:203.0.113/24' })
    expect(networks('::ffff:203.0.113.9')).toEqual(networks('203.0.113.9'))
    expect(networks('2001:db8:1:2:3:4:5:6')).toEqual({ addr: '6:2001:db8:1:2/64', mid: '6:2001:db8:1:0/56', wide: '6:2001:db8:1/48' })
    // "::" may stand for zeros inside the prefix too.
    expect(networks('2001:db8::a:b:c:d:e').addr).toBe('6:2001:db8:0:a/64')
    expect(networks('2001:db8:1:2ff::1').mid).toBe('6:2001:db8:1:200/56')
    expect(networks('not an address').addr).toBe('unknown')
  })
})

describe('limits per network', () => {
  it('stops an address after 10 misses, and then answers "slow down" for live handles too', () => {
    const { b, clock } = book()
    const live = code(b.claim(room(1), '1.2.3.4'))
    for (let i = 0; i < LIMITS.miss.addr.cap; i++) expect(b.take(String(90000 + i), '66.6.6.6')).toEqual({ error: 'no-code' })
    const blocked = b.take('89999', '66.6.6.6')
    expect(blocked).toMatchObject({ error: 'slow-down' })
    expect(b.take(live, '66.6.6.6')).toEqual(blocked)
    expect(b.codes.has(live)).toBe(true)
    expect('room' in b.take(live, '77.7.7.7')).toBe(true)
    clock.t += LIMITS.miss.addr.every
    expect(b.take('89998', '66.6.6.6')).toEqual({ error: 'no-code' })
    expect(b.take('89997', '66.6.6.6')).toMatchObject({ error: 'slow-down' })
  })

  it('counts a whole IPv6 /64 as one address, and limits a /56 and a /48 as networks', () => {
    const { b } = book()
    for (let i = 0; i < LIMITS.miss.addr.cap; i++) b.take('99999', `2001:db8:1:2::${i + 1}`)
    expect(b.take('99999', '2001:db8:1:2:ffff::9')).toMatchObject({ error: 'slow-down' })
    expect(b.take('99999', '2001:db8:1:3::1')).toEqual({ error: 'no-code' })
    // A home /56 (256 /64s) gets 20 misses between them, then slows down; its neighbours don't.
    const { b: b2 } = book()
    let first = -1
    for (let s = 0; s < 64 && first < 0; s++) if ('error' in b2.take('99999', `2001:db8:5:${s.toString(16)}::1`) && (b2.take('99999', `2001:db8:5:${s.toString(16)}::2`) as { error: string }).error === 'slow-down') first = s
    expect(first).toBeGreaterThan(0)
    expect(b2.take('99999', '2001:db8:5:ff00::1')).toEqual({ error: 'no-code' })
  })

  it('an IPv4 /24 is a network too', () => {
    const { b } = book()
    for (let i = 0; i < LIMITS.miss.wide.cap; i++) expect(b.take('99999', `198.51.100.${i}`)).toEqual({ error: 'no-code' })
    expect(b.take('99999', '198.51.100.200')).toMatchObject({ error: 'slow-down' })
    expect(b.take('99999', '198.51.101.1')).toEqual({ error: 'no-code' })
  })
})

describe('a lookup that finds a live code costs its network nothing', () => {
  /** `n` screens, each in a network of its own (so the limits on new codes stay out of it), each showing a live code. */
  const screens = (b: CodeBook, n: number) => Array.from({ length: n }, (_, i) => code(b.claim(room(i), `10.${i}.0.1`)))
  /** Where the i-th phone of a class is, for each way a class can share a network. */
  const classes: Record<string, (i: number) => string> = {
    'one IPv4 address': () => '203.0.113.9',
    'one IPv6 /64': (i) => `2001:db8:9:9::${i + 1}`,
    'one IPv4 /24, an address each': (i) => `198.51.100.${i + 1}`,
    'one IPv6 /56, a /64 each': (i) => `2001:db8:9:${(i + 1).toString(16)}::1`,
  }

  for (const [where, from] of Object.entries(classes)) {
    it(`lets 30 phones on ${where} pair within a minute`, () => {
      const { b, clock } = book()
      for (const [i, handle] of screens(b, 30).entries()) {
        expect(b.take(handle, from(i))).toMatchObject({ room: room(i) })
        clock.t += 2_000
      }
    })
  }

  it('leaves a network its whole allowance of misses, however many codes it found', () => {
    const { b } = book()
    for (const handle of screens(b, 30)) expect('room' in b.take(handle, '203.0.113.9')).toBe(true)
    for (let i = 0; i < LIMITS.miss.addr.cap; i++) expect(b.take(String(90000 + i), '203.0.113.9')).toEqual({ error: 'no-code' })
    expect(b.take('89999', '203.0.113.9')).toMatchObject({ error: 'slow-down' })
  })

  it('never lets finds reset or hide the misses before them', () => {
    const { b } = book()
    const handles = screens(b, 30)
    for (let i = 0; i < LIMITS.miss.addr.cap - 1; i++) expect(b.take(String(90000 + i), '203.0.113.9')).toEqual({ error: 'no-code' })
    // One miss from its limit, the address still finds live codes, and that changes nothing: it has one miss left.
    for (const handle of handles) expect('room' in b.take(handle, '203.0.113.9')).toBe(true)
    expect(b.take('89000', '203.0.113.9')).toEqual({ error: 'no-code' })
    expect(b.take('89001', '203.0.113.9')).toMatchObject({ error: 'slow-down' })
  })

  /**
   * The broader networks, each with the misses it may have between its addresses (its limit) and a way to reach the n-th
   * distinct address inside it: an IPv4 /24 by address, an IPv6 /56 by /64, an IPv6 /48 by /56 (so that only the /48's own
   * limit can be the one that binds).
   */
  const broad: Record<string, { cap: number; at: (n: number) => string }> = {
    'an IPv4 /24': { cap: LIMITS.miss.wide.cap, at: (n) => `198.51.100.${n + 1}` },
    'an IPv6 /56': { cap: LIMITS.miss.mid.cap, at: (n) => `2001:db8:9:10${n.toString(16).padStart(2, '0')}::1` },
    'an IPv6 /48': { cap: LIMITS.miss.wide.cap, at: (n) => `2001:db8:a:${(n + 1).toString(16)}00::1` },
  }
  for (const [where, { cap, at }] of Object.entries(broad)) {
    it(`never lets finds refill the misses that ${where} has spent between its addresses`, () => {
      const { b } = book()
      const handles = screens(b, 30)
      // Half an address's limit each, so that no address trips its own limit before the network does.
      const each = Math.floor(LIMITS.miss.addr.cap / 2)
      const miss = (i: number) => b.take(String(90000 + i), at(Math.floor(i / each)))
      for (let i = 0; i < cap - 1; i++) expect(miss(i)).toEqual({ error: 'no-code' })
      // One miss from the limit, and phones all over the network find their codes: it still has one miss left, no more.
      for (const [i, handle] of handles.entries()) expect(b.take(handle, at(100 + i))).toMatchObject({ room: room(i) })
      expect(miss(cap - 1)).toEqual({ error: 'no-code' })
      expect(miss(cap)).toMatchObject({ error: 'slow-down' })
    })
  }

  it('gives a guesser nothing for finds in between: misses are answered as they would be with none', () => {
    /** 40 misses from `ip`, one every `gap` ms, each after a lookup of a live code from the same address when `finds` is set. */
    const guess = (ip: string, gap: number, finds: boolean) => {
      const { b, clock } = book()
      const handles = finds ? screens(b, 40) : []
      const answers: Take[] = []
      for (let i = 0; i < 40; i++) {
        if (finds) b.take(handles[i], ip)
        answers.push(b.take(String(90000 + i), ip))
        clock.t += gap
      }
      return answers
    }
    for (const ip of ['66.6.6.6', '2001:db8:6:6::1']) {
      for (const gap of [1_000, 10_000]) expect(guess(ip, gap, true), `${ip} every ${gap} ms`).toEqual(guess(ip, gap, false))
      // Faster than the limit refills: the tenth miss is the last let through, with or without finds.
      for (const finds of [false, true]) {
        const answers = guess(ip, 1_000, finds)
        expect(answers.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => ({ error: 'no-code' })))
        expect(answers.slice(10).every((a) => 'error' in a && a.error === 'slow-down')).toBe(true)
      }
    }
  })
})

describe('pressure from everyone together slows pairing down instead of switching it off', () => {
  it('past the budget of misses, every lookup brings a proof of work, and a solved one goes through', async () => {
    const { b } = book()
    const live = code(b.claim(room(1), '192.0.2.10'))
    // Misses from 120 networks empty everyone's budget (no one network could: its own limit comes first).
    drain(b)
    const asked = b.take(live, '203.0.113.50')
    expect(asked).toMatchObject({ error: 'work', bits: LIMITS.work.base })
    // The same answer for a live handle and a dead one, and the handle stays live.
    expect(b.take('99999', '203.0.113.51')).toMatchObject({ error: 'work' })
    expect(b.codes.has(live)).toBe(true)
    const work = await solve(asked)
    const r = b.take(live, '203.0.113.50', work)
    expect('room' in r).toBe(true)
    // A solution works once.
    expect(b.take('99999', '203.0.113.50', work)).toMatchObject({ error: 'work' })
  })

  it('refuses a proof that is forged, lapsed, or for another book', async () => {
    const { b, clock } = book()
    drain(b)
    const asked = b.take('99999', '203.0.113.60')
    const work = await solve(asked)
    expect(workDone(work.c, work.x, LIMITS.work.base)).toBe(true)
    // A different challenge body under the same tag.
    const forged = { c: work.c.replace(/^[^.]+/, 'zzzzzz'), x: work.x }
    expect(b.take('99999', '203.0.113.61', forged)).toMatchObject({ error: 'work' })
    // Another book (another key) doesn't take it.
    const other = new CodeBook(() => clock.t)
    drain(other)
    expect(other.take('99999', '203.0.113.62', work)).toMatchObject({ error: 'work' })
    // Nor does this one once it has lapsed (the budget emptied again, as it would be under pressure).
    clock.t += LIMITS.work.ttl + 1000
    drain(b, 1000)
    expect(b.take('99999', '203.0.113.63', work)).toMatchObject({ error: 'work' })
  })

  it('asks more bits as the pressure grows, up to the most a phone can do', async () => {
    const { b } = book()
    drain(b)
    let bits = 0
    for (let i = 0; i < 400; i++) {
      const asked = b.take('99999', v6(5000 + i))
      if ('error' in asked && asked.error === 'work') {
        bits = Math.max(bits, asked.bits)
        // Pretend it was solved: count the pressure as the book does.
        ;(b as unknown as { pressure: { n: number } }).pressure.n++
      }
    }
    expect(bits).toBeGreaterThan(LIMITS.work.base)
    expect(bits).toBeLessThanOrEqual(LIMITS.work.max)
  })

  it('keeps blind guessing under one expected join a year with 1,000 live codes, at the budget', () => {
    // Misses at the budget r; hits come at r·d/(1−d); each hit is one attempt at a 5-digit secret.
    const r = 1000 / LIMITS.missAll.every
    const d = 1000 / HANDLES
    const perYear = r * (d / (1 - d)) * 1e-5 * 365.25 * 24 * 3600
    expect(perYear).toBeLessThan(1)
    expect(perYear).toBeGreaterThan(0.5) // 0.59: the number PROTOCOL §2b quotes
  })
})

describe('new codes', () => {
  it('limits how fast one room gets new codes, so its code can not be spun faster than a person types', () => {
    const { b, clock } = book()
    for (let i = 0; i < LIMITS.room.cap; i++) code(b.claim(room(1), '1.2.3.4'))
    expect(b.claim(room(1), '1.2.3.4')).toMatchObject({ error: 'slow-down' })
    clock.t += LIMITS.room.every
    expect(code(b.claim(room(1), '1.2.3.4'))).toMatch(/^[1-9]\d{4}$/)
  })

  it('holds each network to its share of live codes, counting as codes come and go, and a refused ask spends a token', () => {
    const { b } = book()
    for (let i = 0; i < LIMITS.live.addr; i++) code(b.claim(room(i), '2001:db8:5:5::1'))
    const out = new Set<string>()
    for (let i = 0; i < 100; i++) { const r = b.claim(room(1000 + i), '2001:db8:5:5::2'); out.add('error' in r ? r.error : 'code') }
    // 'busy' for its share, then 'slow down' once its tokens are spent: 100 asks never became 100 answers of work.
    expect(out).toEqual(new Set(['busy', 'slow-down']))
    // Another /64 in the same /56 still gets codes, up to the /56's share.
    expect(code(b.claim(room(5000), '2001:db8:5:6::1'))).toBeTruthy()
    // Handing one back frees a place.
    b.drop(room(0))
    const { b: fresh } = book()
    for (let i = 0; i < LIMITS.live.addr; i++) code(fresh.claim(room(i), '2001:db8:7:7::1'))
    expect(fresh.claim(room(99), '2001:db8:7:7::1')).toMatchObject({ error: 'busy' })
    fresh.drop(room(0))
    expect(code(fresh.claim(room(99), '2001:db8:7:7::1'))).toBeTruthy()
  })

  it('keeps a room’s code when its new ask is refused, so what the screen shows still works', () => {
    const { b } = book()
    const shown = code(b.claim(room(1), '1.2.3.4'))
    for (let i = 1; i < LIMITS.room.cap; i++) code(b.claim(room(1), '1.2.3.4'))
    const now = [...b.codes.keys()][0]
    expect(b.claim(room(1), '1.2.3.4')).toMatchObject({ error: 'slow-down' })
    expect(b.codes.has(now)).toBe(true)
    expect(shown).toBeTruthy()
  })

  it('past the soft cap a new code brings a proof of work, and a solved one gets it', async () => {
    const { b } = book()
    b.load(Array.from({ length: LIMITS.liveSoft }, (_, i) => [String(10000 + i), { room: room(100000 + i), exp: 9e12, net: net(v6(i >> 5)) }] as [string, { room: string; exp: number; net: ReturnType<typeof net> }]))
    const asked = b.claim(room(1), '192.0.2.10')
    expect(asked).toMatchObject({ error: 'work' })
    expect(code(b.claim(room(1), '192.0.2.10', await solve(asked)))).toBeTruthy()
  })

  it('restores codes from storage, leaving out expired ones and old shapes', () => {
    const { clock } = book()
    const del: string[] = []
    const restored = new CodeBook(() => clock.t, undefined, undefined, { put: () => {}, del: (h) => del.push(h) })
    restored.load([['12345', { room: room(1), exp: clock.t + 1000, net: net('1.2.3.4') }], ['56789', { room: room(2), exp: clock.t - 1, net: net('1.2.3.4') }], ['1234', { room: room(3), exp: clock.t + 1000, net: net('1.2.3.4') }]])
    expect([...restored.codes.keys()]).toEqual(['12345'])
    expect(del.sort()).toEqual(['1234', '56789'])
  })
})

describe('the lookup request', () => {
  const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n] ?? h[n.toLowerCase()] ?? null })
  const url = 'https://obpal.blackboxes.net/api/code'
  it('takes a same-origin POST of JSON with a handle, and a proof of work beside it', () => {
    expect(readLookup('POST', url, headers({ 'Content-Type': 'application/json' }), '{"code":"48219"}')).toEqual({ handle: '48219' })
    expect(readLookup('POST', url, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Sec-Fetch-Site': 'same-origin', Origin: 'https://obpal.blackboxes.net' }), '{"code":"48219","work":{"c":"a.b.c.d","x":"1z"}}'))
      .toEqual({ handle: '48219', work: { c: 'a.b.c.d', x: '1z' } })
  })
  it('refuses cross-site requests: a form post, another site’s fetch, another origin', () => {
    expect(readLookup('POST', url, headers({ 'Content-Type': 'text/plain' }), '{"code":"48219"}')).toMatchObject({ status: 415 })
    expect(readLookup('POST', url, headers({ 'Content-Type': 'application/x-www-form-urlencoded' }), 'code=48219')).toMatchObject({ status: 415 })
    expect(readLookup('POST', url, headers({ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }), '{"code":"48219"}')).toMatchObject({ status: 403 })
    expect(readLookup('POST', url, headers({ 'Content-Type': 'application/json', Origin: 'https://evil.test' }), '{"code":"48219"}')).toMatchObject({ status: 403 })
    expect(readLookup('GET', url, headers({}), '')).toMatchObject({ status: 405 })
  })
  it('answers a malformed handle as no code without asking the book', () => {
    for (const code of ['4821', '04821', '482190', 'abcde']) expect(readLookup('POST', url, headers({ 'Content-Type': 'application/json' }), JSON.stringify({ code }))).toEqual({ status: 404, error: 'no-code' })
  })
})
