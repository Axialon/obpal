import { DurableObject } from 'cloudflare:workers'
import { handlePayment, PAYMENT_ROUTES, type PaymentsEnv } from './payments'

export interface Env extends PaymentsEnv {
  ROOMS: DurableObjectNamespace<Room>
  ASSETS: Fetcher
  TURN_KEY_ID?: string
  TURN_KEY_API_TOKEN?: string
}

const ROOM = /^\/r\/([A-Za-z0-9_-]{22})$/
const STUN: RTCIceServerLike[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }]
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }

interface RTCIceServerLike { urls: string | string[]; username?: string; credential?: string }

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url)
    const room = ROOM.exec(url.pathname)
    if (room) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426 })
      return env.ROOMS.get(env.ROOMS.idFromName(room[1])).fetch(req)
    }
    if (url.pathname === '/api/health') return Response.json({ ok: true, service: 'obpal', proto: 1 }, { headers: CORS })
    if (url.pathname === '/api/ice') return iceServers(url, env)
    if (PAYMENT_ROUTES.includes(url.pathname)) return (await handlePayment(req, env)) ?? new Response('Not found', { status: 404 })
    return env.ASSETS.fetch(req)
  },
} satisfies ExportedHandler<Env>

/** Short-lived Cloudflare TURN credentials, only for rooms that currently have a host. STUN-only until TURN secrets are set. */
async function iceServers(url: URL, env: Env): Promise<Response> {
  const room = url.searchParams.get('room') ?? ''
  const stunOnly = () => Response.json({ iceServers: STUN, turn: false }, { headers: CORS })
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN || !/^[A-Za-z0-9_-]{22}$/.test(room)) return stunOnly()
  const live = await env.ROOMS.get(env.ROOMS.idFromName(room)).hasHost()
  if (!live) return stunOnly()
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 7200 }),
  })
  if (!r.ok) return stunOnly()
  const j = (await r.json()) as { iceServers?: RTCIceServerLike | RTCIceServerLike[] }
  const list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : []
  // Browsers refuse some ports (e.g. 53); drop those URLs.
  const servers = list
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length)
  return Response.json({ iceServers: servers.length ? servers : STUN, turn: servers.length > 0 }, { headers: CORS })
}

interface Tag { id: string; role: 'host' | 'device' }

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
    server.serializeAttachment({ id, role } satisfies Tag)

    const hostPresent = this.ctx.getWebSockets('host').length > 0
    server.send(JSON.stringify({ t: 'welcome', id, role, host: hostPresent }))
    const others = this.ctx.getWebSockets(role === 'host' ? 'device' : 'host')
    for (const ws of others) safeSend(ws, { t: 'peer', ev: 'join', id, role })
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (typeof msg !== 'string' || msg.length > 16_384) return
    let m: { t?: string; to?: string; d?: unknown }
    try { m = JSON.parse(msg) } catch { return }
    if (m.t !== 'sig' || m.d === undefined) return
    const me = ws.deserializeAttachment() as Tag
    const targets = me.role === 'device'
      ? this.ctx.getWebSockets('host')
      : typeof m.to === 'string' ? this.ctx.getWebSockets(`id:${m.to}`) : []
    for (const t of targets) safeSend(t, { t: 'sig', from: me.id, d: m.d })
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.left(ws)
    try { ws.close(code, reason) } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket) {
    this.left(ws)
  }

  private left(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Tag | null
    if (!me) return
    const others = this.ctx.getWebSockets(me.role === 'host' ? 'device' : 'host')
    for (const t of others) if (t !== ws) safeSend(t, { t: 'peer', ev: 'leave', id: me.id, role: me.role })
  }
}

function safeSend(ws: WebSocket, obj: unknown) {
  try { ws.send(JSON.stringify(obj)) } catch { /* peer went away */ }
}
