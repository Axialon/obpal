import { DurableObject } from 'cloudflare:workers'
import { Buckets, CodeBook, networks, readLookup, type Claim, type CodeEntry, type Work } from './codes'
import { iceAnswer, relayOf, stunServers, type IceEnv } from './ice'
import { allow, type RateLimit } from './limits'
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
const clientKey = (req: Request) => networks(req.headers.get('CF-Connecting-IP')).addr

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const room = ROOM.exec(url.pathname)
    if (room) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 })
      if (!(await allow(env.RL_SOCKET, clientKey(req)))) return new Response('Too many connections, try again in a minute', { status: 429, headers: { 'Retry-After': '60' } })
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(req)
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true, service: 'obpal', proto: 1 }, { headers: CORS })
    if (url.pathname === '/api/ice') return iceServers(req, url, env)
    if (url.pathname === '/api/code') return lookupCode(req, env)
    if (PAYMENT_ROUTES.includes(url.pathname)) return (await handlePayment(req, env)) ?? new Response('Not found', { status: 404 })
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
  const [live, ok] = await Promise.all([env.ROOMS.get(env.ROOMS.idFromName(room)).hasHost(), allow(env.RL_ICE, clientKey(req))])
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
  const net = networks(ip).addr
  const wait = shed.wait(net)
  if (wait) return json({ error: 'slow-down', retry: wait }, 429, { 'Retry-After': String(wait) })
  shed.take(net)
  const codes = env.CODES.get(env.CODES.idFromName('codes'))
  const busy = () => json({ error: 'busy', retry: 5 }, 503, { 'Retry-After': '5' })
  let r: Awaited<ReturnType<Codes['take']>>
  try { r = await codes.take(read.handle, ip, read.work) } catch { return busy() }
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
  id: string
  role: 'host' | 'device'
  /** The room's name (its id in /r/<room>) and the address the socket came from: a host's short codes need both. */
  room?: string
  ip?: string
  /** The short-code handle this host holds. */
  code?: string
  /** This socket's claims: a token bucket (count left, and when it was last full). */
  cl?: { n: number; t: number }
}

/** Claims per host socket: 10 at once, one back every 6 s. */
const SOCKET_CLAIMS = { cap: 10, every: 6_000 }

/**
 * One room per pairing (room id = hash of the QR secret). A blind signaling mailbox:
 * forwards device -> host and host -> addressed device. Hibernates between messages.
 */
export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async hasHost(): Promise<boolean> {
    return this.ctx.getWebSockets('host').length > 0
  }

  async fetch(req: Request): Promise<Response> {
    const role: Tag['role'] = new URL(req.url).searchParams.get('role') === 'host' ? 'host' : 'device'
    if (role === 'host' && this.ctx.getWebSockets('host').length > 0) return new Response('Room already has a host', { status: 409 })
    if (role === 'device' && this.ctx.getWebSockets('device').length >= 8) return new Response('Room is full', { status: 429 })

    const { 0: client, 1: server } = new WebSocketPair()
    const id = crypto.randomUUID().slice(0, 8)
    this.ctx.acceptWebSocket(server, [role, `id:${id}`])
    const room = ROOM.exec(new URL(req.url).pathname)?.[1]
    server.serializeAttachment({ id, role, ...(role === 'host' ? { room, ip: req.headers.get('CF-Connecting-IP') ?? '' } : {}) } satisfies Tag)

    const hostPresent = this.ctx.getWebSockets('host').length > 0
    server.send(JSON.stringify({ t: 'welcome', id, role, host: hostPresent }))
    const others = this.ctx.getWebSockets(role === 'host' ? 'device' : 'host')
    for (const ws of others) safeSend(ws, { t: 'peer', ev: 'join', id, role })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== 'string' || msg.length > 16_384) return
    let m: { t?: string; to?: string; d?: unknown; op?: string; work?: Work }
    try { m = JSON.parse(msg) } catch { return }
    if (m.t === 'code') return this.onCode(ws, m.op, m.work)
    if (m.t !== 'sig' || m.d === undefined) return
    const me = ws.deserializeAttachment() as Tag
    const targets = me.role === 'device'
      ? this.ctx.getWebSockets('host')
      : typeof m.to === 'string' ? this.ctx.getWebSockets(`id:${m.to}`) : []
    for (const t of targets) safeSend(t, { t: 'sig', from: me.id, d: m.d })
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
      try { r = await codes.claim(me.room, me.ip ?? '', work) } catch { r = { error: 'busy', retry: 15 } }
      ws.serializeAttachment({ ...me, cl: b, ...('code' in r ? { code: r.code } : {}) } satisfies Tag)
      safeSend(ws, { t: 'code', ...r })
    }
  }

  /** A device looked up this room's short code: tell the host, with its replacement. False: no host is here. */
  async codeUsed(handle: string, ticket: string, next: Claim | null): Promise<boolean> {
    const hosts = this.ctx.getWebSockets('host')
    for (const ws of hosts) {
      if (next && 'code' in next) ws.serializeAttachment({ ...(ws.deserializeAttachment() as Tag), code: next.code } satisfies Tag)
      safeSend(ws, { t: 'code', ev: 'used', code: handle, ticket, ...(next ? ('code' in next ? { next } : next) : {}) })
    }
    return hosts.length > 0
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    // A close frame (normal, going away, or none given) is a page that left; anything else is a lost connection.
    this.left(ws, code === 1000 || code === 1001 || code === 1005)
    try { ws.close(code, reason) } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws, false)
  }

  /**
   * A socket went: tell the other side. `clean`: the page closed it (left, or reloaded); otherwise the connection was
   * lost, and a device's peer connection, which doesn't run through here, may well still be up.
   */
  private left(ws: WebSocket, clean: boolean) {
    const me = ws.deserializeAttachment() as Tag | null
    if (!me) return
    // A code is live only while its host is: the handle goes with the host's socket.
    if (me.role === 'host' && me.room && me.code) this.ctx.waitUntil(this.env.CODES.get(this.env.CODES.idFromName('codes')).drop(me.room, me.code).catch(() => {}))
    const others = this.ctx.getWebSockets(me.role === 'host' ? 'device' : 'host')
    for (const t of others) if (t !== ws) safeSend(t, { t: 'peer', ev: 'leave', id: me.id, role: me.role, clean })
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
      const all = await ctx.storage.list<CodeEntry>({ prefix: 'h:' })
      this.book.load([...all].map(([k, v]) => [k.slice(2), v] as [string, CodeEntry]))
    })
  }

  async claim(room: string, ip: string, work?: Work) {
    const r = this.book.claim(room, ip, work)
    await this.sweepLater()
    return r
  }

  async take(handle: string, ip: string, work?: Work) { return this.book.take(handle, ip, work) }

  async drop(room: string, handle?: string) { this.book.drop(room, handle) }

  async alarm() {
    this.book.sweep(true)
    await this.sweepLater()
  }

  private async sweepLater() {
    if (this.book.codes.size && !(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000)
  }
}
