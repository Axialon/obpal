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

/** ICE servers for a room: STUN, plus TURN when the service mints credentials. Falls back to STUN within the timeout. */
export async function fetchIceServers(service: string, roomId: string, timeoutMs = REACH_TIMEOUT_MS): Promise<RTCIceServer[]> {
  try {
    const r = await fetch(`${service}/api/ice?room=${encodeURIComponent(roomId)}`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    if (r.ok) {
      const j = (await r.json()) as { iceServers?: RTCIceServer[] }
      if (Array.isArray(j.iceServers) && j.iceServers.length) return j.iceServers
    }
  } catch { /* fall through to STUN */ }
  return STUN
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
