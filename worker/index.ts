import { addressKey, addressNetworks, type NetworkKeys } from './address'
import { DurableObject } from 'cloudflare:workers'
import { Buckets, CodeBook, readLookup, type Claim, type CodeEntry, type Work } from './codes'
import { iceAnswer, relayOf, stunServers, type IceEnv } from './ice'
import { allow, type RateLimit } from './limits'
import { admission, expiredWatch, ownerVerifier, WATCH_IDLE_MS, type Sharing } from './sharing'
import { handlePayment, PAYMENT_ROUTES, type PaymentsEnv } from './payments'

export interface Env extends PaymentsEnv, IceEnv {
  ROOMS: DurableObjectNamespace<Room>
  CODES: DurableObjectNamespace<Codes>
  ASSETS: Fetcher
  /** Room sockets opened, per address (worker/limits.ts). */
  RL_SOCKET?: RateLimit
  /** ICE lookups (TURN credentials), per address. */
  RL_ICE?: RateLimit
}

const ROOM = /^\/r\/([A-Za-z0-9_-]{22})$/
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
/** Short-code lookups answer the controller page on this origin only (no CORS). */
const NO_STORE = { 'Cache-Control': 'no-store' }

/** The limits' key for a request: its address, an IPv6 /64 as one. */
const addressKeys = new WeakMap<Env, Promise<Uint8Array<ArrayBuffer>>>()
const networkKeys = async (env: Env, ip: string | null) => {
  let key = addressKeys.get(env)
  if (!key) {
    key = addressKey(env.TURN_KEY_API_TOKEN || env.TURN_SECRET || env.STRIPE_WEBHOOK_SECRET || env.STRIPE_SECRET_KEY || '')
    addressKeys.set(env, key)
  }
  return addressNetworks(await key, ip)
}
const clientKey = async (req: Request, env: Env) => (await networkKeys(env, req.headers.get('CF-Connecting-IP'))).addr

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const room = ROOM.exec(url.pathname)
    if (room) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 })
      if (!(await allow(env.RL_SOCKET, await clientKey(req, env)))) return new Response('Too many connections, try again in a minute', { status: 429, headers: { 'Retry-After': '60' } })
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(req)
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true, service: 'obpal', proto: 2 }, { headers: CORS })
    if (url.pathname === '/api/ice') return iceServers(req, url, env)
    if (url.pathname === '/api/code') return lookupCode(req, env)
    const share = /^\/api\/share\/([A-Za-z0-9_-]{22})\/(play|watch)$/.exec(url.pathname)
    if (share && req.method === 'GET') {
      if (!(await allow(env.RL_SOCKET, await clientKey(req, env)))) return new Response('Slow down', { status: 429, headers: NO_STORE })
      const sealed = await env.ROOMS.get(env.ROOMS.idFromName(share[1])).shareTarget(share[2] as 'play' | 'watch')
      return Response.json(sealed ? { sealed } : { error: 'removed' }, { status: sealed ? 200 : 404, headers: NO_STORE })
    }
    if (PAYMENT_ROUTES.includes(url.pathname)) return (await handlePayment(req, env)) ?? new Response('Not found', { status: 404 })
    if (url.pathname === '/sim/device/' && url.searchParams.has('d')) {
      const id = url.searchParams.get('d') ?? ''
      if (/^[a-z0-9-]+$/.test(id)) {
        const canonical = new URL(`/sim/${id}/`, url)
        const page = await env.ASSETS.fetch(new Request(canonical, req))
        if (page.ok) return page
      }
    }
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>

/**
 * ICE servers for a room (worker/ice.ts): STUN, plus short-lived TURN credentials, only for rooms that have a host at
 * the moment and within the per-address limit. Otherwise STUN alone, which still finds every direct path.
 */
async function iceServers(req: Request, url: URL, env: Env): Promise<Response> {
  const room = url.searchParams.get('room') ?? ''
  const stunOnly = () => Response.json({ iceServers: stunServers(env), turn: false }, { headers: CORS })
  if (!relayOf(env) || !/^[A-Za-z0-9_-]{22}$/.test(room)) return stunOnly()
  const [live, ok] = await Promise.all([env.ROOMS.get(env.ROOMS.idFromName(room)).hasHost(), allow(env.RL_ICE, await clientKey(req, env))])
  if (!live || !ok) return stunOnly()
  return Response.json(await iceAnswer(env), { headers: CORS })
}

/**
 * Lookups shed in this isolate before they reach the book: a network sending more than this is turned away here.
 * Best effort (each isolate counts its own), in front of the book's own limits, which hold everywhere.
 */
const shed = new Buckets({ cap: 20, every: 3_000 }, Date.now)
let shedKeys = 0

/**
 * A phone typed a short code: which room is it, and a ticket to show that room's host (PROTOCOL §2b). The handle is
 * spent as it's found, and the host hears so at once, with the handle that replaces it.
 */
async function lookupCode(req: Request, env: Env): Promise<Response> {
  const json = (body: object, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } })
  const body = req.method === 'POST' ? (await req.text()).slice(0, 1024) : ''
  const read = readLookup(req.method, req.url, req.headers, body)
  if ('status' in read) return json({ error: read.error }, read.status, read.status === 405 ? { Allow: 'POST' } : {})
  const ip = req.headers.get('CF-Connecting-IP') ?? ''
  if (++shedKeys > 50_000) { shed.sweep(); shedKeys = 0 }
  const keys = await networkKeys(env, ip)
  const net = keys.addr
  const wait = shed.wait(net)
  if (wait) return json({ error: 'slow-down', retry: wait }, 429, { 'Retry-After': String(wait) })
  shed.take(net)
  const codes = env.CODES.get(env.CODES.idFromName('codes'))
  const busy = () => json({ error: 'busy', retry: 5 }, 503, { 'Retry-After': '5' })
  let r: Awaited<ReturnType<Codes['take']>>
  try { r = await codes.take(read.handle, keys, read.work) } catch { return busy() }
  if ('error' in r) {
    if (r.error === 'no-code') return json({ error: 'no-code' }, 404)
    if (r.error === 'work') return json({ error: 'work', challenge: r.challenge, bits: r.bits }, 429)
    return json({ error: 'slow-down', retry: r.retry }, 429, { 'Retry-After': String(r.retry) })
  }
  let live = false
  try { live = await env.ROOMS.get(env.ROOMS.idFromName(r.room)).codeUsed(read.handle, r.ticket, r.next) } catch { return busy() }
  if (!live) { await codes.drop(r.room).catch(() => {}); return json({ error: 'no-code' }, 404) }
  return json({ room: r.room, ticket: r.ticket })
}

interface Tag {
  capability?: 'player' | 'watcher'
  id: string
  role: 'host' | 'device'
  /** The room's name (its id in /r/<room>) and keyed network hashes for the socket: a host's short codes need both. */
  room?: string
  net?: NetworkKeys
  /** The short-code handle this host holds. */
  code?: string
  /** This socket's claims: a token bucket (count left, and when it was last full). */
  cl?: { n: number; t: number }
}

/** Claims per host socket: 10 at once, one back every 6 s. */
const SOCKET_CLAIMS = { cap: 10, every: 6_000 }

/**
 * A stable room per shared session (legacy pairing rooms hash the QR secret). A signaling mailbox:
 * forwards device -> host and host -> addressed device. Hibernates between messages.
 */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    void ctx.blockConcurrencyWhile(async () => {
      for (const ws of ctx.getWebSockets()) {
        const tag = ws.deserializeAttachment() as Tag & { ip?: string }
        if (tag && 'ip' in tag) {
          const { ip, ...rest } = tag
          ws.serializeAttachment({ ...rest, net: await networkKeys(env, ip ?? null) } satisfies Tag)
        }
      }
    })
  }

  async hasHost(): Promise<boolean> {
    return this.ctx.getWebSockets('host').length > 0
  }

  async fetch(req: Request): Promise<Response> {
    const query = new URL(req.url).searchParams
    const role: Tag['role'] = query.get('role') === 'host' ? 'host' : 'device'
    const reject = (code: number, reason: string) => {
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept(); server.close(code, reason)
      return new Response(null, { status: 101, webSocket: client })
    }
    let sharing = await this.ctx.storage?.get<Sharing>('sharing')
    if (sharing && sharing.watch && expiredWatch(sharing, Date.now())) { sharing.expiredWatchKey = sharing.watch; sharing.watch = null; await this.ctx.storage.put('sharing', sharing) }
    if (role === 'host' && sharing && await ownerVerifier(query.get('owner') ?? '') !== sharing.owner) return reject(4009, 'removed')
    if (role === 'host' && !sharing && query.has('owner')) {
      const play = query.get('play'), watch = query.get('watch')
      if (!/^[A-Za-z0-9_-]{22}$/.test(query.get('owner') ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(play ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(watch ?? '')) return reject(4009, 'removed')
      sharing = { owner: await ownerVerifier(query.get('owner')!), play: query.get('playOpen') === '0' ? null : play, watch: query.get('watchOpen') === '0' ? null : watch, emptyAt: null }
      await this.ctx.storage.put('sharing', sharing)
    }
    let capability: Tag['capability'] = 'player'
    if (role === 'device' && sharing) {
      const ticket = query.get('ticket')
      const tickets = ticket ? await this.ctx.storage.get<Record<string, number>>('tickets') : undefined
      const validTicket = ticket && sharing.play && tickets?.[ticket]
      capability = admission(sharing, query.get('key'), Date.now()) ?? (validTicket && validTicket > Date.now() ? 'player' : undefined)
      if (!capability) return reject(4009, 'removed')
    }
    if (role === 'host' && this.ctx.getWebSockets('host').length > 0) return new Response('Room already has a host', { status: 409 })
    if (role === 'device' && this.ctx.getWebSockets(sharing ? capability : 'device').length >= (capability === 'watcher' ? 24 : 8)) {
      // Browsers hide failed upgrade bodies. Reject over an unregistered socket so clients can read the reason.
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()
      server.close(4008, 'full')
      return new Response(null, { status: 101, webSocket: client })
    }

    const { 0: client, 1: server } = new WebSocketPair()
    const id = crypto.randomUUID().slice(0, 8)
    this.ctx.acceptWebSocket(server, [role, `id:${id}`, ...(role === 'device' ? [capability!] : [])])
    const room = ROOM.exec(new URL(req.url).pathname)?.[1]
    server.serializeAttachment({ id, role, capability: role === 'device' ? capability : undefined, ...(role === 'host' ? { room, net: await networkKeys(this.env, req.headers.get('CF-Connecting-IP')) } : {}) } satisfies Tag)
    if (sharing) { sharing.emptyAt = null; await this.ctx.storage.put('sharing', sharing); await this.ctx.storage.deleteAlarm() }

    const hostPresent = this.ctx.getWebSockets('host').length > 0
    server.send(JSON.stringify({ t: 'welcome', id, role, host: hostPresent, ...(role === 'host' && sharing ? { sharing: { play: !!sharing.play, watch: !!sharing.watch } } : {}) }))
    const others = this.ctx.getWebSockets(role === 'host' ? 'device' : 'host')
    for (const ws of others) safeSend(ws, { t: 'peer', ev: 'join', id, role })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== 'string' || msg.length > 16_384) return
    let m: { t?: string; to?: string; d?: unknown; op?: string; work?: Work; play?: string | null; watch?: string | null; revision?: number; links?: { play?: string; watch?: string } }
    try { m = JSON.parse(msg) } catch { return }
    if (m.t === 'sharing') {
      const me = ws.deserializeAttachment() as Tag
      const sharing = await this.ctx.storage.get<Sharing>('sharing')
      if (me.role !== 'host' || !sharing) return
      if (!Number.isSafeInteger(m.revision) || m.revision! < (sharing.revision ?? 0)) return
      sharing.revision = m.revision
      let resetTickets = false
      for (const key of ['play', 'watch'] as const) {
        if (!(key in m) || !(m[key] === null || /^[A-Za-z0-9_-]{43}$/.test(m[key] ?? ''))) continue
        if (key === 'watch' && m[key] !== null && m[key] === sharing.expiredWatchKey) continue
        if (sharing[key] !== m[key]) {
          sharing[key] = m[key]!
          if (sharing.links) delete sharing.links[key]
          if (key === 'play') resetTickets = true
          for (const peer of this.ctx.getWebSockets(key === 'watch' ? 'watcher' : 'player')) peer.close(4009, 'removed')
        }
        const sealed = m.links?.[key]
        if (sharing[key] && typeof sealed === 'string' && /^[A-Za-z0-9_-]{40,2048}$/.test(sealed)) (sharing.links ??= {})[key] = sealed
      }
      if (resetTickets) await this.ctx.storage.put({ sharing, tickets: {} }); else await this.ctx.storage.put('sharing', sharing)
      safeSend(ws, { t: 'sharing', play: !!sharing.play, watch: !!sharing.watch, revision: m.revision })
      return
    }
    if (m.t === 'code') return this.onCode(ws, m.op, m.work)
    if (m.t !== 'sig' || m.d === undefined) return
    const me = ws.deserializeAttachment() as Tag
    const targets = me.role === 'device'
      ? this.ctx.getWebSockets('host')
      : typeof m.to === 'string' ? this.ctx.getWebSockets(`id:${m.to}`) : []
    for (const t of targets) safeSend(t, { t: 'sig', from: me.id, d: m.d, ...(me.role === 'device' ? { capability: me.capability } : {}) })
  }

  /**
   * The host asks for a short code for this room (claim, with a proof of work when the book asked for one), or no
   * longer shows one (drop). Claims are limited per socket here, before they reach the book; if the book can't
   * answer, the host hears 'busy' and tries again later.
   */
  private async onCode(ws: WebSocket, op: string | undefined, work: Work | undefined) {
    const me = ws.deserializeAttachment() as Tag
    if (me.role !== 'host' || !me.room) return
    const codes = this.env.CODES.get(this.env.CODES.idFromName('codes'))
    if (op === 'drop') {
      if (me.code) await codes.drop(me.room, me.code).catch(() => {})
      ws.serializeAttachment({ ...me, code: undefined } satisfies Tag)
    } else if (op === 'claim') {
      const now = Date.now()
      const b = me.cl ?? { n: SOCKET_CLAIMS.cap, t: now }
      const back = Math.floor((now - b.t) / SOCKET_CLAIMS.every)
      if (back > 0) { b.n = Math.min(SOCKET_CLAIMS.cap, b.n + back); b.t = b.n === SOCKET_CLAIMS.cap ? now : b.t + back * SOCKET_CLAIMS.every }
      if (b.n <= 0) {
        ws.serializeAttachment({ ...me, cl: b } satisfies Tag)
        safeSend(ws, { t: 'code', error: 'slow-down', retry: Math.max(1, Math.ceil((b.t + SOCKET_CLAIMS.every - now) / 1000)) })
        return
      }
      b.n--
      let r: Claim
      try { r = await codes.claim(me.room, me.net ?? await networkKeys(this.env, null), work) } catch { r = { error: 'busy', retry: 15 } }
      ws.serializeAttachment({ ...me, cl: b, ...('code' in r ? { code: r.code } : {}) } satisfies Tag)
      safeSend(ws, { t: 'code', ...r })
    }
  }

  /** A device looked up this room's short code: tell the host, with its replacement. False: no host is here. */
  async codeUsed(handle: string, ticket: string, next: Claim | null): Promise<boolean> {
    const sharing = await this.ctx.storage.get<Sharing>('sharing')
    if (sharing && !sharing.play) return false
    const now = Date.now(), tickets = await this.ctx.storage.get<Record<string, number>>('tickets') ?? {}
    const live = Object.entries(tickets).filter(([, until]) => until > now).slice(-63)
    await this.ctx.storage.put('tickets', { ...Object.fromEntries(live), [ticket]: now + 60_000 })
    const hosts = this.ctx.getWebSockets('host')
    for (const ws of hosts) {
      if (next && 'code' in next) ws.serializeAttachment({ ...(ws.deserializeAttachment() as Tag), code: next.code } satisfies Tag)
      safeSend(ws, { t: 'code', ev: 'used', code: handle, ticket, ...(next ? ('code' in next ? { next } : next) : {}) })
    }
    return hosts.length > 0
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // A close frame (normal, going away, or none given) is a page that left; anything else is a lost connection.
    await this.left(ws, code === 1000 || code === 1001 || code === 1005)
    try { ws.close(code, reason) } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    await this.left(ws, false)
  }

  /**
   * A socket went: tell the other side. `clean`: the page closed it (left, or reloaded); otherwise the connection was
   * lost, and a device's peer connection, which doesn't run through here, may well still be up.
   */
  private async left(ws: WebSocket, clean: boolean) {
    const me = ws.deserializeAttachment() as Tag | null
    if (!me) return
    // A code is live only while its host is: the handle goes with the host's socket.
    if (me.role === 'host' && me.room && me.code) this.ctx.waitUntil(this.env.CODES.get(this.env.CODES.idFromName('codes')).drop(me.room, me.code).catch(() => {}))
    const others = this.ctx.getWebSockets(me.role === 'host' ? 'device' : 'host')
    for (const t of others) if (t !== ws) safeSend(t, { t: 'peer', ev: 'leave', id: me.id, role: me.role, clean })
    if (this.ctx.getWebSockets().filter(peer => peer !== ws && peer.readyState === 1).length === 0) {
      const sharing = await this.ctx.storage.get<Sharing>('sharing')
      if (sharing) { sharing.emptyAt = Date.now(); await this.ctx.storage.put('sharing', sharing); await this.ctx.storage.setAlarm(sharing.emptyAt + WATCH_IDLE_MS) }
    }
  }

  /** Ciphertext is public metadata; its corresponding live capability is still required to decrypt and join. */
  async shareTarget(key: 'play' | 'watch'): Promise<string | null> {
    const sharing = await this.ctx.storage.get<Sharing>('sharing')
    if (!sharing?.[key] || key === 'watch' && expiredWatch(sharing, Date.now())) return null
    return sharing.links?.[key] ?? null
  }

  async alarm() {
    const sharing = await this.ctx.storage.get<Sharing>('sharing')
    if (sharing && sharing.watch && expiredWatch(sharing, Date.now()) && !this.ctx.getWebSockets().length) { sharing.expiredWatchKey = sharing.watch; sharing.watch = null; await this.ctx.storage.put('sharing', sharing) }
  }
}

function safeSend(ws: WebSocket, obj: unknown) {
  try { ws.send(JSON.stringify(obj)) } catch { /* peer went away */ }
}

/**
 * The short codes' book (worker/codes.ts): one instance for the whole service, so a handle means one room
 * everywhere. Codes persist across restarts; the limits live in memory.
 */
export class Codes extends DurableObject<Env> {
  private book: CodeBook

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.book = new CodeBook(Date.now, undefined, undefined, {
      put: (h, e) => void ctx.storage.put(`h:${h}`, e),
      del: (h) => void ctx.storage.delete(`h:${h}`),
    })
    void ctx.blockConcurrencyWhile(async () => {
      const all = await ctx.storage.list<CodeEntry & { ip?: string }>({ prefix: 'h:' })
      for (const [h, e] of all) {
        if ('ip' in e) {
          const clean: CodeEntry = { room: e.room, exp: e.exp, net: await networkKeys(env, e.ip ?? null) }
          await ctx.storage.put(h, clean)
          all.set(h, clean)
        }
      }
      this.book.load([...all].map(([k, v]) => [k.slice(2), v] as [string, CodeEntry]))
    })
  }

  async claim(room: string, net: NetworkKeys, work?: Work) {
    const r = this.book.claim(room, net, work)
    await this.sweepLater()
    return r
  }

  async take(handle: string, net: NetworkKeys, work?: Work) { return this.book.take(handle, net, work) }

  async drop(room: string, handle?: string) { this.book.drop(room, handle) }

  async alarm() {
    this.book.sweep(true)
    await this.sweepLater()
  }

  private async sweepLater() {
    if (this.book.codes.size && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000)
  }
}
