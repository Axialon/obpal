/**
 * Short codes (PROTOCOL §2b): the room service's half. A code is <5-digit handle><5-digit secret>; the service only
 * ever sees the handle, which it keeps for one room for a few minutes and hands out once. The book below is plain
 * logic (the Codes Durable Object persists it), so it can be tested without the Workers runtime.
 *
 * Limits are per network (an address, and the networks around it), so no one network can walk the handles or hold
 * them all. Pressure from everyone together never switches pairing off: past a budget, a lookup or a new code has to
 * bring a proof of work (../packages/core/src/work.ts), which slows the flood and lets people through.
 */
import { hmacSha256, workDone } from '../packages/core/src/work'

export const CODE_TTL_MS = 10 * 60_000
/** Handles are five digits from 10000 (a leading 0 is kept for a longer code, should one ever be needed). */
const HANDLE_LOW = 10_000
export const HANDLES = 90_000

/** Token buckets: at most `cap` at once, one back every `every` ms. */
type Rate = { cap: number; every: number }

export const LIMITS = {
  /** Lookups that find nothing, per network: an address (an IPv4 address or an IPv6 /64), an IPv6 /56, and a wide one (an IPv6 /48 or an IPv4 /24). */
  miss: { addr: { cap: 10, every: 60_000 }, mid: { cap: 15, every: 30_000 }, wide: { cap: 20, every: 30_000 } },
  /** Codes spent, per network (each lookup that finds a code retires it). */
  hit: { addr: { cap: 6, every: 100_000 }, wide: { cap: 20, every: 30_000 } },
  /**
   * Lookups that find nothing, everyone together: 10 a minute (a burst of 120), more than any one network may use, so
   * it takes many networks to reach it. Past this budget every lookup brings a proof of work.
   */
  missAll: { cap: 120, every: 6_000 },
  /** New codes (asked for, or replacing a used one), per room and per network of the screen asking. */
  room: { cap: 20, every: 30_000 },
  claim: { addr: { cap: 60, every: 10_000 }, wide: { cap: 200, every: 2_000 } },
  /** Live codes per network of the screens holding them. */
  live: { addr: 32, mid: 64, wide: 128 },
  /** Live codes overall: past `soft` a new code brings a proof of work; at `hard` there are none to give ('busy'). */
  liveSoft: 18_000,
  liveHard: 60_000,
  /** Proof of work: `base` zero bits, one more per doubling of the pressure, at most `max`; a challenge lasts `ttl` ms. */
  work: { base: 16, max: 22, ttl: 120_000 },
} satisfies Record<string, unknown>

export interface CodeEntry { room: string; exp: number; ip: string }
export type Work = { c: string; x: string }

/** A token bucket per key, kept in memory (a restart forgets, which only ever lets someone through sooner). */
export class Buckets {
  private m = new Map<string, { n: number; t: number }>()
  constructor(private rate: Rate, private now: () => number) {}

  private level(key: string) {
    const now = this.now()
    const { cap, every } = this.rate
    const b = this.m.get(key) ?? { n: cap, t: now }
    const back = Math.floor((now - b.t) / every)
    if (back > 0) { b.n = Math.min(cap, b.n + back); b.t = b.n === cap ? now : b.t + back * every }
    this.m.set(key, b)
    return b
  }

  /** Seconds until a token is free (0: one is free now). */
  wait(key: string): number {
    const b = this.level(key)
    return b.n > 0 ? 0 : Math.max(1, Math.ceil((b.t + this.rate.every - this.now()) / 1000))
  }

  take(key: string) { const b = this.level(key); if (b.n > 0) b.n-- }

  /** Forget keys that are full again. */
  sweep() { for (const [k] of this.m) if (this.level(k).n >= this.rate.cap) this.m.delete(k) }
}

/** An IP address as its eight IPv6 groups, or null. IPv4 and IPv4-mapped IPv6 come back as { v4 }. */
function parseIp(ip: string): { v4: number[] } | { v6: number[] } | null {
  const s = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const dotted = (q: string) => { const p = q.split('.').map(Number); return p.length === 4 && p.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? p : null }
  if (!s.includes(':')) { const v4 = dotted(s); return v4 ? { v4 } : null }
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s)
  if (mapped) { const v4 = dotted(mapped[1]); if (v4) return { v4 } }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (part: string) => (part ? part.split(':') : []).flatMap((g) => {
    if (g.includes('.')) { const q = dotted(g); return q ? [(q[0] << 8) | q[1], (q[2] << 8) | q[3]] : [NaN] }
    return /^[0-9a-f]{1,4}$/i.test(g) ? [parseInt(g, 16)] : [NaN]
  })
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const fill = 8 - head.length - tail.length
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null
  const v6 = [...head, ...new Array(Math.max(0, fill)).fill(0), ...tail]
  return v6.length === 8 && v6.every((g) => g >= 0 && g <= 0xffff) ? { v6 } : null
}

/**
 * The networks an address belongs to, as limit keys: `addr` (an IPv4 address, or an IPv6 /64: one household or one
 * phone), `mid` (an IPv6 /56, a typical home allocation; none for IPv4) and `wide` (an IPv6 /48 or an IPv4 /24).
 */
export function networks(ip: string | null | undefined): { addr: string; mid: string | null; wide: string } {
  const p = ip ? parseIp(ip) : null
  if (!p) return { addr: 'unknown', mid: null, wide: 'unknown' }
  if ('v4' in p) { const [a, b, c, d] = p.v4; return { addr: `4:${a}.${b}.${c}.${d}`, mid: null, wide: `4:${a}.${b}.${c}/24` } }
  const h = p.v6.map((g) => g.toString(16))
  return { addr: `6:${h.slice(0, 4).join(':')}/64`, mid: `6:${h.slice(0, 3).join(':')}:${(p.v6[3] & 0xff00).toString(16)}/56`, wide: `6:${h.slice(0, 3).join(':')}/48` }
}

export type Claim = { code: string; exp: number } | { error: 'busy' | 'slow-down'; retry: number } | { error: 'work'; challenge: string; bits: number }
export type Take = { room: string; ticket: string; next: Claim | null } | { error: 'no-code' } | { error: 'slow-down'; retry: number } | { error: 'work'; challenge: string; bits: number }

function b64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * A lookup request, checked before the book sees it: a POST of JSON from the controller page on this origin (a form or
 * a script on another site can't send JSON here without CORS, and browsers say where a request came from), with a
 * handle of the right shape. Anything else is answered here: a malformed handle as "no code", which it is.
 */
export function readLookup(
  method: string, url: string, headers: { get(name: string): string | null }, body: string,
): { handle: string; work?: Work } | { status: number; error: string } {
  if (method !== 'POST') return { status: 405, error: 'post' }
  if (!/^application\/json\s*(;|$)/i.test(headers.get('Content-Type') ?? '')) return { status: 415, error: 'json' }
  const site = headers.get('Sec-Fetch-Site')
  if (site && site !== 'same-origin') return { status: 403, error: 'origin' }
  const origin = headers.get('Origin')
  if (origin && origin !== new URL(url).origin) return { status: 403, error: 'origin' }
  let j: { code?: unknown; work?: { c?: unknown; x?: unknown } }
  try { j = JSON.parse(body) } catch { return { status: 400, error: 'json' } }
  const handle = typeof j?.code === 'string' ? j.code : ''
  if (!/^[1-9]\d{4}$/.test(handle)) return { status: 404, error: 'no-code' }
  const w = j.work
  const work = w && typeof w.c === 'string' && typeof w.x === 'string' && w.c.length <= 96 && w.x.length <= 12 ? { c: w.c, x: w.x } : undefined
  return work ? { handle, work } : { handle }
}

export class CodeBook {
  /** handle -> entry */
  readonly codes = new Map<string, CodeEntry>()
  /** room -> its live handle */
  private byRoom = new Map<string, string>()
  /** Live codes per network key (kept as codes come and go, so no request scans them all). */
  private live = new Map<string, number>()
  private b: Record<'missAddr' | 'missMid' | 'missWide' | 'hitAddr' | 'hitWide' | 'missAll' | 'room' | 'claimAddr' | 'claimWide', Buckets>
  /** The key that signs challenges (new on every start: challenges from before simply fail, and are asked again). */
  private key = crypto.getRandomValues(new Uint8Array(32))
  /** Challenges already solved (spent), until they would have lapsed. */
  private spent = new Map<string, number>()
  /** Lookups served with a proof of work lately, decaying by half a minute: it raises the bits asked. */
  private pressure = { n: 0, t: 0 }
  private swept = 0

  constructor(
    private now: () => number = Date.now,
    private random: (n: number) => number = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n,
    private ticket: () => string = () => b64(crypto.getRandomValues(new Uint8Array(16))),
    /** Writes through to storage (the Durable Object passes these). */
    private persist: { put(h: string, e: CodeEntry): void; del(h: string): void } = { put() {}, del() {} },
  ) {
    const bucket = (r: Rate) => new Buckets(r, now)
    this.b = {
      missAddr: bucket(LIMITS.miss.addr), missMid: bucket(LIMITS.miss.mid), missWide: bucket(LIMITS.miss.wide),
      hitAddr: bucket(LIMITS.hit.addr), hitWide: bucket(LIMITS.hit.wide), missAll: bucket(LIMITS.missAll),
      room: bucket(LIMITS.room), claimAddr: bucket(LIMITS.claim.addr), claimWide: bucket(LIMITS.claim.wide),
    }
  }

  /** Entries restored from storage; expired ones are dropped. */
  load(entries: Iterable<[string, CodeEntry]>) {
    for (const [h, e] of entries) {
      if (e.exp > this.now() && !this.byRoom.has(e.room) && /^[1-9]\d{4}$/.test(h)) this.add(h, e, false)
      else this.persist.del(h)
    }
  }

  private count(e: CodeEntry, by: 1 | -1) {
    const n = networks(e.ip)
    for (const k of [`a:${n.addr}`, n.mid && `m:${n.mid}`, `w:${n.wide}`]) {
      if (!k) continue
      const v = (this.live.get(k) ?? 0) + by
      if (v > 0) this.live.set(k, v)
      else this.live.delete(k)
    }
  }

  private add(handle: string, e: CodeEntry, persist = true) {
    this.codes.set(handle, e)
    this.byRoom.set(e.room, handle)
    this.count(e, 1)
    if (persist) this.persist.put(handle, e)
  }

  private remove(handle: string) {
    const e = this.codes.get(handle)
    if (!e) return
    this.codes.delete(handle)
    if (this.byRoom.get(e.room) === handle) this.byRoom.delete(e.room)
    this.count(e, -1)
    this.persist.del(handle)
  }

  /** Drop expired codes, full buckets and lapsed challenges (every half minute at most: it walks them all). */
  sweep(force = false) {
    const now = this.now()
    if (!force && now - this.swept < 30_000) return
    this.swept = now
    for (const [h, e] of this.codes) if (e.exp <= now) this.remove(h)
    for (const b of Object.values(this.b)) b.sweep()
    for (const [c, exp] of this.spent) if (exp <= now) this.spent.delete(c)
  }

  // ---- proof of work -------------------------------------------------------------------------------------------

  /** Bits to ask of a lookup now: the base, and one more for each doubling of recent lookups made past the budget. */
  private lookupBits(): number {
    const w = LIMITS.work
    const now = this.now()
    this.pressure.n *= 0.5 ** ((now - this.pressure.t) / 30_000)
    this.pressure.t = now
    return Math.min(w.max, w.base + Math.floor(Math.log2(1 + this.pressure.n / 10)))
  }

  /** Bits to ask of a new code: the base past the soft cap, one more for each 5,000 live codes beyond it. */
  private claimBits(live: number): number {
    const w = LIMITS.work
    return Math.min(w.max, w.base + Math.floor((live - LIMITS.liveSoft) / 5_000))
  }

  private challenge(bits: number): { error: 'work'; challenge: string; bits: number } {
    const exp = Math.ceil((this.now() + LIMITS.work.ttl) / 1000).toString(36)
    const body = `${exp}.${bits}.${b64(crypto.getRandomValues(new Uint8Array(12)))}`
    return { error: 'work', challenge: `${body}.${b64(hmacSha256(this.key, body).slice(0, 16))}`, bits }
  }

  /** A solved challenge this book issued, not spent, not lapsed, for at least `bits` bits. It is spent by passing. */
  private checkWork(w: Work | undefined, bits: number): boolean {
    if (!w || typeof w.c !== 'string' || typeof w.x !== 'string' || w.c.length > 96 || !/^[0-9a-z]{1,12}$/.test(w.x)) return false
    const parts = w.c.split('.')
    if (parts.length !== 4) return false
    const [exp, b, nonce, tag] = parts
    if (b64(hmacSha256(this.key, `${exp}.${b}.${nonce}`).slice(0, 16)) !== tag) return false
    const expMs = parseInt(exp, 36) * 1000
    if (!(Number(b) >= bits) || !(expMs > this.now()) || this.spent.has(w.c)) return false
    if (!workDone(w.c, w.x, Number(b))) return false
    this.spent.set(w.c, expMs)
    return true
  }

  // ---- codes ---------------------------------------------------------------------------------------------------

  /** A fresh handle for a room, replacing the room's previous one (which stays if this is refused). */
  claim(room: string, ip: string, work?: Work): Claim {
    this.sweep()
    const net = networks(ip)
    const wait = Math.max(this.b.room.wait(room), this.b.claimAddr.wait(net.addr), this.b.claimWide.wait(net.wide))
    if (wait) return { error: 'slow-down', retry: wait }
    // Every attempt past the rate check spends a token, whatever comes of it.
    this.b.room.take(room)
    this.b.claimAddr.take(net.addr)
    this.b.claimWide.take(net.wide)
    const old = this.byRoom.get(room)
    const oldE = old ? this.codes.get(old) : undefined
    const oldNet = oldE ? networks(oldE.ip) : null
    // Live codes this network holds (its own code for this room is about to be replaced, so it doesn't count).
    const held = (key: string, same: boolean) => (this.live.get(key) ?? 0) - (same ? 1 : 0)
    const L = LIMITS.live
    if (held(`a:${net.addr}`, oldNet?.addr === net.addr) >= L.addr
      || (net.mid && held(`m:${net.mid}`, oldNet?.mid === net.mid) >= L.mid)
      || held(`w:${net.wide}`, oldNet?.wide === net.wide) >= L.wide) return { error: 'busy', retry: 60 }
    const live = this.codes.size - (old ? 1 : 0)
    if (live >= LIMITS.liveHard) return { error: 'busy', retry: 60 }
    if (live >= LIMITS.liveSoft) {
      const bits = this.claimBits(live)
      if (!this.checkWork(work, bits)) return this.challenge(bits)
    }
    let handle = ''
    for (let i = 0; i < 64 && !handle; i++) {
      const h = String(HANDLE_LOW + this.random(HANDLES))
      if (!this.codes.has(h)) handle = h
    }
    if (!handle) return { error: 'busy', retry: 60 }
    if (old) this.remove(old)
    const entry = { room, exp: this.now() + CODE_TTL_MS, ip }
    this.add(handle, entry)
    return { code: handle, exp: entry.exp }
  }

  /**
   * A device looks a handle up. Found: the handle is spent (removed), the room gets its replacement at once, and
   * the device a ticket to show the host. Not found, expired and spent all answer the same, and so does every
   * lookup while a limit holds: nothing tells a live handle from a dead one.
   */
  take(handle: string, ip: string, work?: Work): Take {
    this.sweep()
    const net = networks(ip)
    const b = this.b
    const wait = Math.max(
      b.missAddr.wait(net.addr), net.mid ? b.missMid.wait(net.mid) : 0, b.missWide.wait(net.wide),
      b.hitAddr.wait(net.addr), b.hitWide.wait(net.wide),
    )
    if (wait) return { error: 'slow-down', retry: wait }
    // Past everyone's budget, pairing slows down instead of stopping: each lookup brings a proof of work.
    const budget = b.missAll.wait('all') === 0
    if (!budget) {
      const bits = this.lookupBits()
      if (!this.checkWork(work, bits)) return this.challenge(bits)
      this.pressure.n++
    }
    const e = /^[1-9]\d{4}$/.test(handle) ? this.codes.get(handle) : undefined
    if (!e || e.exp <= this.now()) {
      b.missAddr.take(net.addr)
      if (net.mid) b.missMid.take(net.mid)
      b.missWide.take(net.wide)
      if (budget) b.missAll.take('all')
      if (e) this.remove(handle)
      return { error: 'no-code' }
    }
    b.hitAddr.take(net.addr)
    b.hitWide.take(net.wide)
    this.remove(handle)
    return { room: e.room, ticket: this.ticket(), next: this.claim(e.room, e.ip) }
  }

  /** The room's host went away or no longer shows a code: forget its handle (only that one, if given). */
  drop(room: string, handle?: string) {
    const h = this.byRoom.get(room)
    if (h && (!handle || h === handle)) this.remove(h)
  }
}
