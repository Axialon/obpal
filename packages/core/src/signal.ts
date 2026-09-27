import type { SignalIn } from './messages'

export const DEFAULT_SERVICE = 'https://obpal.blackboxes.net'
/** How long a connect attempt may take before the service counts as unreachable (the offline fallback's budget). */
export const REACH_TIMEOUT_MS = 1500

export function roomSocketUrl(service: string, roomId: string, role: 'host' | 'device'): string {
  return `${service.replace(/^http/, 'ws')}/r/${roomId}?role=${role}`
}

/**
 * Room signaling socket with jittered reconnect and keep-alive pings (answered by the service without waking it).
 * A connect attempt that hasn't opened within REACH_TIMEOUT_MS is abandoned and reported as unreachable, so
 * callers can fall back within the budget instead of waiting for the network stack's own timeout.
 */
export class SignalClient {
  onmessage: (m: SignalIn) => void = () => {}
  /** open: the socket is usable. reachable (only with open=false): whether this attempt reached the service at all. */
  onstatus: (open: boolean, reachable: boolean) => void = () => {}
  /** Ever connected successfully. */
  everOpened = false
  private ws: WebSocket | null = null
  private closed = false
  private backoff = 400
  private ping: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private url: string, private connectTimeout = REACH_TIMEOUT_MS) {}

  connect() {
    if (this.closed) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      this.onstatus(false, false)
      this.retry()
      return
    }
    this.ws = ws
    let opened = false
    this.timer = setTimeout(() => { if (!opened) ws.close() }, this.connectTimeout)
    ws.onopen = () => {
      opened = true
      this.everOpened = true
      if (this.timer) clearTimeout(this.timer)
      this.backoff = 400
      this.onstatus(true, true)
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000)
    }
    ws.onmessage = (e) => {
      if (e.data === 'pong') return
      try { this.onmessage(JSON.parse(e.data)) } catch { /* ignore malformed */ }
    }
    ws.onclose = () => {
      if (this.timer) clearTimeout(this.timer)
      if (this.ping) clearInterval(this.ping)
      if (this.ws !== ws) return
      this.ws = null
      this.onstatus(false, opened)
      this.retry()
    }
  }

  private retry() {
    if (this.closed) return
    const wait = this.backoff * (0.75 + Math.random() * 0.5)
    this.backoff = Math.min(this.backoff * 2, 8000)
    setTimeout(() => this.connect(), wait)
  }

  get open() { return this.ws?.readyState === 1 }

  send(obj: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj))
  }

  close() {
    this.closed = true
    if (this.ping) clearInterval(this.ping)
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
  }
}

const STUN: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]

/**
 * A room's ICE servers: STUN, plus TURN when the service mints credentials, and when those lapse (`expires`, epoch
 * ms; absent without TURN). Falls back to STUN within the timeout.
 */
export interface IceSet { servers: RTCIceServer[]; turn: boolean; expires?: number }

/** How long before TURN credentials lapse a host asks for fresh ones (a relay drops an allocation once they have). */
export const ICE_REFRESH_BEFORE_MS = 10 * 60_000
/** Without TURN (none minted, or the lookup failed), ask again this often: the service may have one later. */
export const ICE_RETRY_MS = 10 * 60_000

export async function fetchIce(service: string, roomId: string, timeoutMs = REACH_TIMEOUT_MS): Promise<IceSet> {
  try {
    const r = await fetch(`${service}/api/ice?room=${encodeURIComponent(roomId)}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (r.ok) {
      const j = (await r.json()) as { iceServers?: RTCIceServer[]; turn?: boolean; expires?: number }
      if (Array.isArray(j.iceServers) && j.iceServers.length) {
        const expires = typeof j.expires === 'number' && j.expires > Date.now() ? j.expires : undefined
        return { servers: j.iceServers, turn: j.turn === true, ...(expires ? { expires } : {}) }
      }
    }
  } catch { /* fall through to STUN */ }
  return { servers: STUN, turn: false }
}

/** ICE servers for a room (see fetchIce). */
export async function fetchIceServers(service: string, roomId: string, timeoutMs = REACH_TIMEOUT_MS): Promise<RTCIceServer[]> {
  return (await fetchIce(service, roomId, timeoutMs)).servers
}

/**
 * When to ask for a room's ICE servers again: shortly before TURN credentials lapse (credentials that say nothing
 * about it are taken to last a day), else after ICE_RETRY_MS. Never sooner than a minute.
 */
export function iceRefreshIn(set: Pick<IceSet, 'turn' | 'expires'>, now = Date.now()): number {
  const lapses = set.expires ?? (set.turn ? now + 24 * 3600_000 : 0)
  return Math.max(60_000, lapses ? Math.min(lapses - now - ICE_REFRESH_BEFORE_MS, 2 ** 31 - 1) : ICE_RETRY_MS)
}

/**
 * What a live connection's own statistics say about it (W3C webrtc-stats), for a connection badge that claims only what
 * is true: the path the selected ICE pair takes, its round trip, and how DTLS secures it.
 */
export interface LinkInfo {
  /**
   * lan: both ends' host candidates (the same network). nat: peer to peer through a router found with STUN (a server
   * reflexive candidate). direct: peer to peer otherwise (an address learnt from the other side's checks). relay: a
   * TURN server carries it. unknown: no selected pair yet.
   */
  path: 'lan' | 'nat' | 'direct' | 'relay' | 'unknown'
  /** How this end reaches its relay: udp, tcp or tls (TURN over TLS). */
  relayProtocol?: string
  /** The pair's round trip as ICE measures it, ms. */
  rttMs?: number
  /** The DTLS version agreed ('DTLS 1.2', 'DTLS 1.3') and its cipher suite, where the browser reports them. */
  dtls?: string
  cipher?: string
  /** Every transport (ICE and DTLS) is connected: the channels are encrypted and authenticated end to end. */
  secure: boolean
}

const DTLS_VERSIONS: Record<string, string> = { FEFD: 'DTLS 1.2', FEFC: 'DTLS 1.3' }

export async function linkInfo(pc: RTCPeerConnection): Promise<LinkInfo> {
  const secure = pc.connectionState === 'connected'
  try {
    const stats = await pc.getStats()
    let transport: any
    stats.forEach((s) => { if (s.type === 'transport' && (s.selectedCandidatePairId || !transport)) transport = s })
    let pair: any = transport?.selectedCandidatePairId ? stats.get(transport.selectedCandidatePairId) : undefined
    if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s })
    const local = pair ? stats.get(pair.localCandidateId) : undefined
    const remote = pair ? stats.get(pair.remoteCandidateId) : undefined
    const types = [local?.candidateType, remote?.candidateType]
    const path: LinkInfo['path'] = !pair ? 'unknown'
      : types.includes('relay') ? 'relay'
        : types[0] === 'host' && types[1] === 'host' ? 'lan'
          : types.includes('srflx') ? 'nat' : 'direct'
    const version = typeof transport?.tlsVersion === 'string' ? transport.tlsVersion.toUpperCase() : ''
    return {
      path, secure,
      ...(path === 'relay' && typeof local?.relayProtocol === 'string' ? { relayProtocol: local.relayProtocol } : {}),
      ...(typeof pair?.currentRoundTripTime === 'number' ? { rttMs: Math.round(pair.currentRoundTripTime * 1000) } : {}),
      ...(DTLS_VERSIONS[version] ? { dtls: DTLS_VERSIONS[version] } : {}),
      ...(typeof transport?.dtlsCipher === 'string' ? { cipher: transport.dtlsCipher } : {}),
    }
  } catch {
    return { path: 'unknown', secure }
  }
}

/** Which path the selected ICE pair uses. */
export async function linkPath(pc: RTCPeerConnection): Promise<'direct' | 'relay' | 'unknown'> {
  try {
    const stats = await pc.getStats()
    let pairId: string | undefined
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId })
    let pair: any
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) pair = s
    })
    if (!pair) return 'unknown'
    const local = stats.get(pair.localCandidateId)
    const remote = stats.get(pair.remoteCandidateId)
    return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct'
  } catch {
    return 'unknown'
  }
}
