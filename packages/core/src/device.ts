import type { Caps, DeviceMsg, HostMsg, SignalIn, SignalPayload } from './messages'
import { bindMac, equalBytes, roomIdFor, sdpFingerprint, type Pairing } from './pairing'
import { fetchIceServers, linkPath, roomSocketUrl, SignalClient } from './signal'
import { PROTO } from './state'

export type LinkStatus =
  | 'signaling' | 'waiting-host' | 'connecting' | 'securing' | 'connected'
  | 'reconnecting' | 'taken-over' | 'host-mismatch' | 'closed'

export interface DeviceLinkEvents {
  status: (s: LinkStatus) => void
  message: (m: HostMsg) => void
  stats: (s: { path: 'direct' | 'relay' | 'unknown'; rttMs: number | null }) => void
}

/**
 * Device (controller) side of an ob-pal link: joins the room, opens the WebRTC DataChannels,
 * verifies the host's DTLS fingerprint against the QR, then proves it holds the pairing secret.
 */
export class DeviceLink {
  status: LinkStatus = 'signaling'
  private roomId = ''
  private sig: SignalClient | null = null
  private pc: RTCPeerConnection | null = null
  private ctl: RTCDataChannel | null = null
  private st: RTCDataChannel | null = null
  private ice: RTCIceServer[] = []
  private hostPresent = false
  private pendingCands: RTCIceCandidateInit[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private rttMs: number | null = null
  private handlers: { [K in keyof DeviceLinkEvents]: DeviceLinkEvents[K][] } = { status: [], message: [], stats: [] }

  constructor(private opts: { service: string; pairing: Pairing; caps: () => Caps; name: string }) {}

  on<K extends keyof DeviceLinkEvents>(ev: K, fn: DeviceLinkEvents[K]) { this.handlers[ev].push(fn) }
  private emit<K extends keyof DeviceLinkEvents>(ev: K, ...args: Parameters<DeviceLinkEvents[K]>) {
    for (const fn of this.handlers[ev]) (fn as (...a: unknown[]) => void)(...args)
  }
  private setStatus(s: LinkStatus) {
    if (this.status === s) return
    this.status = s
    this.emit('status', s)
  }

  async start() {
    this.roomId = await roomIdFor(this.opts.pairing.secret)
    this.ice = await fetchIceServers(this.opts.service, this.roomId)
    this.sig = new SignalClient(roomSocketUrl(this.opts.service, this.roomId, 'device'))
    this.sig.onmessage = (m) => this.onSignal(m)
    this.sig.onstatus = (open) => { if (!open && this.status !== 'connected') this.setStatus('signaling') }
    this.sig.connect()
    document.addEventListener('visibilitychange', this.onVisible)
    this.statsTimer = setInterval(() => this.poll(), 2000)
  }

  private onVisible = () => {
    if (document.visibilityState !== 'visible') return
    const s = this.pc?.connectionState
    if (this.hostPresent && s !== 'connected' && s !== 'connecting') this.restart(0)
  }

  private onSignal(m: SignalIn) {
    if (m.t === 'welcome') {
      this.hostPresent = m.host
      if (m.host) this.startPeer()
      else this.setStatus('waiting-host')
    } else if (m.t === 'peer' && m.role === 'host') {
      this.hostPresent = m.ev === 'join'
      if (m.ev === 'join') this.startPeer()
      else { this.teardown(); this.setStatus('waiting-host') }
    } else if (m.t === 'sig') {
      void this.onPayload(m.d)
    }
  }

  private async onPayload(d: SignalPayload) {
    const pc = this.pc
    if (!pc) return
    if ('answer' in d) {
      const fp = sdpFingerprint(d.answer.sdp)
      if (!fp || !equalBytes(fp, this.opts.pairing.fp)) {
        this.teardown()
        this.setStatus('host-mismatch')
        return
      }
      await pc.setRemoteDescription(d.answer)
      for (const c of this.pendingCands.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    } else if ('cand' in d) {
      if (pc.remoteDescription) await pc.addIceCandidate(d.cand).catch(() => {})
      else this.pendingCands.push(d.cand)
    }
  }

  private async startPeer() {
    this.teardown()
    this.setStatus('connecting')
    const pc = new RTCPeerConnection({ iceServers: this.ice })
    this.pc = pc
    this.ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0 })
    this.st = pc.createDataChannel('st', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
    this.st.binaryType = 'arraybuffer'
    pc.onicecandidate = (e) => { if (e.candidate) this.sig?.send({ t: 'sig', d: { cand: e.candidate.toJSON() } }) }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'failed') this.restart(300)
      else if (pc.connectionState === 'disconnected') this.restart(3000)
    }
    this.ctl.onopen = () => void this.bind(pc)
    this.ctl.onmessage = (e) => this.onCtl(e.data)
    this.ctl.onclose = () => { if (this.pc === pc && this.status === 'connected') this.restart(500) }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.sig?.send({ t: 'sig', d: { offer: pc.localDescription!.toJSON() } })
  }

  private async bind(pc: RTCPeerConnection) {
    this.setStatus('securing')
    const fpDevice = sdpFingerprint(pc.localDescription?.sdp)
    if (!fpDevice) return this.restart(500)
    const mac = await bindMac(this.opts.pairing.secret, fpDevice, this.opts.pairing.fp, this.roomId)
    this.sendCtl({ t: 'hello', proto: PROTO, caps: this.opts.caps(), mac, name: this.opts.name })
  }

  private onCtl(data: unknown) {
    if (typeof data !== 'string') return
    let m: HostMsg
    try { m = JSON.parse(data) } catch { return }
    if (m.t === 'welcome') this.setStatus('connected')
    if (m.t === 'pong') this.rttMs = Math.round(performance.now() - m.t0)
    if (m.t === 'lock') { this.teardown(); this.setStatus(m.reason === 'taken-over' ? 'taken-over' : 'waiting-host') }
    this.emit('message', m)
  }

  private restart(delay: number) {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const s = this.pc?.connectionState
      if (s === 'connected' && this.status === 'connected') return
      if (this.hostPresent) { this.setStatus('reconnecting'); void this.startPeer() }
    }, delay)
  }

  private async poll() {
    if (this.status !== 'connected' || !this.pc) return
    this.sendCtl({ t: 'ping', t0: performance.now() })
    this.emit('stats', { path: await linkPath(this.pc), rttMs: this.rttMs })
  }

  private teardown() {
    this.pendingCands = []
    const pc = this.pc
    this.pc = null
    this.ctl = null
    this.st = null
    try { pc?.close() } catch { /* already closed */ }
  }

  get ready() { return this.status === 'connected' }

  sendState(buf: ArrayBuffer) {
    const st = this.st
    if (!st || st.readyState !== 'open' || this.status !== 'connected') return false
    if (st.bufferedAmount > 256) return false // newest wins; never queue stale motion
    st.send(buf)
    return true
  }

  sendCtl(m: DeviceMsg) {
    if (this.ctl?.readyState === 'open') this.ctl.send(JSON.stringify(m))
  }

  close() {
    this.sendCtl({ t: 'bye' })
    if (this.statsTimer) clearInterval(this.statsTimer)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.teardown()
    this.sig?.close()
    this.setStatus('closed')
  }
}
