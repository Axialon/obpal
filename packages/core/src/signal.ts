import type { SignalIn } from './messages'

export const DEFAULT_SERVICE = 'https://obpal.blackboxes.net'

export function roomSocketUrl(service: string, roomId: string, role: 'host' | 'device'): string {
  return `${service.replace(/^http/, 'ws')}/r/${roomId}?role=${role}`
}

/** Room signaling socket with jittered reconnect and keep-alive pings (answered by the service without waking it). */
export class SignalClient {
  onmessage: (m: SignalIn) => void = () => {}
  onstatus: (open: boolean) => void = () => {}
  private ws: WebSocket | null = null
  private closed = false
  private backoff = 400
  private ping: ReturnType<typeof setInterval> | null = null

  constructor(private url: string) {}

  connect() {
    if (this.closed) return
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.backoff = 400
      this.onstatus(true)
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25_000)
    }
    ws.onmessage = (e) => {
      if (e.data === 'pong') return
      try { this.onmessage(JSON.parse(e.data)) } catch { /* ignore malformed */ }
    }
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping)
      this.onstatus(false)
      if (this.closed) return
      const wait = this.backoff * (0.75 + Math.random() * 0.5)
      this.backoff = Math.min(this.backoff * 2, 8000)
      setTimeout(() => this.connect(), wait)
    }
  }

  get open() { return this.ws?.readyState === 1 }

  send(obj: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj))
  }

  close() {
    this.closed = true
    if (this.ping) clearInterval(this.ping)
    this.ws?.close()
  }
}

export async function fetchIceServers(service: string, roomId: string): Promise<RTCIceServer[]> {
  try {
    const r = await fetch(`${service}/api/ice?room=${encodeURIComponent(roomId)}`, { cache: 'no-store' })
    if (r.ok) {
      const j = (await r.json()) as { iceServers?: RTCIceServer[] }
      if (Array.isArray(j.iceServers) && j.iceServers.length) return j.iceServers
    }
  } catch { /* fall through to STUN */ }
  return [{ urls: 'stun:stun.cloudflare.com:3478' }]
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
