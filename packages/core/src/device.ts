import type { Caps, DeviceMsg, HostMsg, PairGrant, SignalIn, SignalPayload } from './messages'
import {
  bindMac, equalBytes, fromB64url, lanContext, lanIceCredentials, lanOfferSdp, mungeIce, roomIdFor, sdpFingerprint,
  type LanPairing, type Pairing,
} from './pairing'
import { fetchIceServers, linkPath, roomSocketUrl, SignalClient } from './signal'
import { PROTO } from './state'
import { putPair, type StoredPair } from './store'

export type LinkStatus =
  | 'signaling' | 'unreachable' | 'waiting-host' | 'connecting' | 'securing' | 'connected'
  | 'reconnecting' | 'taken-over' | 'host-mismatch' | 'lan-failed' | 'lan-unsupported' | 'closed'

export interface DeviceLinkEvents {
  status: (s: LinkStatus) => void
  message: (m: HostMsg) => void
  stats: (s: { path: 'direct' | 'relay' | 'unknown'; rttMs: number | null }) => void
  /** The host remembers this device now (an online pairing handed over a pairing key). */
  pair: (p: StoredPair) => void
}

interface Common {
  caps: () => Caps
  /** Shown on the host. May still be resolving: it is only needed once the channel opens. */
  name: string | Promise<string>
  /**
   * This device's persistent certificate (see loadCertificate); required for a direct LAN connection. May still
   * be loading when the link starts: signaling gets going meanwhile and the peer connection waits for it.
   */
  cert?: RTCCertificate | Promise<RTCCertificate | null | undefined>
}

export type DeviceLinkOptions = Common & (
  /** Through the room service: the code from the host's screen. remember: keep the pairing the host offers. */
  | { service: string; pairing: Pairing; remember?: boolean }
  /** Direct over the LAN, no server: the host's direct code and the pairing this device remembers for it. */
  | { lan: LanPairing; pair: StoredPair }
)

/** How long a direct LAN attempt may take before it is given up (the code is single-use, so no retry). */
const LAN_TIMEOUT_MS = 10_000
/** How long the offer waits for the ICE server lookup (TURN credentials) before it is built with STUN only. */
const ICE_WAIT_MS = 250

const mark = (name: string) => { try { performance.mark(name) } catch { /* no marks here */ } }

/**
 * Device (controller) side of an ob-pal link. Online it joins the room, opens the WebRTC DataChannels, verifies
 * the host's DTLS fingerprint against the code, then proves it holds the pairing secret. Over a direct LAN code
 * it answers the host's offer with derived ICE credentials instead, and the same fingerprint pinning and binding
 * apply with the remembered pairing key.
 */
export class DeviceLink {
  status: LinkStatus = 'signaling'
  private roomId = ''
  private sig: SignalClient | null = null
  private pc: RTCPeerConnection | null = null
  private ctl: RTCDataChannel | null = null
  private st: RTCDataChannel | null = null
  private ice: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
  private iceReady: Promise<void> | null = null
  /** The offer under construction or ready to go (built while the socket connects). */
  private peerReady: Promise<RTCPeerConnection | null> | null = null
  private offered = false
  /** Local candidates gathered before the offer went out; they follow it. */
  private localCands: RTCIceCandidateInit[] = []
  private hostPresent = false
  private pendingCands: RTCIceCandidateInit[] = []
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private lanTimer: ReturnType<typeof setTimeout> | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private rttMs: number | null = null
  private handlers: { [K in keyof DeviceLinkEvents]: DeviceLinkEvents[K][] } = { status: [], message: [], stats: [], pair: [] }

  constructor(private opts: DeviceLinkOptions) {}

  on<K extends keyof DeviceLinkEvents>(ev: K, fn: DeviceLinkEvents[K]) { this.handlers[ev].push(fn) }
  private emit<K extends keyof DeviceLinkEvents>(ev: K, ...args: Parameters<DeviceLinkEvents[K]>) {
    for (const fn of this.handlers[ev]) (fn as (...a: unknown[]) => void)(...args)
  }
  private setStatus(s: LinkStatus) {
    if (this.status === s) return
    this.status = s
    this.emit('status', s)
  }

  /** True for a direct LAN link (no room service involved). */
  get direct() { return 'lan' in this.opts }

  async start() {
    mark('obpal:start')
    this.statsTimer = setInterval(() => this.poll(), 2000)
    if ('lan' in this.opts) return this.startLan()
    const { service, pairing } = this.opts
    this.roomId = await roomIdFor(pairing.secret)
    // The socket and the ICE server lookup race; neither waits for the other.
    this.iceReady = fetchIceServers(service, this.roomId).then((ice) => { this.ice = ice; mark('obpal:ice') })
    this.sig = new SignalClient(roomSocketUrl(service, this.roomId, 'device'))
    this.sig.onmessage = (m) => this.onSignal(m)
    this.sig.onstatus = (open, reachable) => {
      if (open) { mark('obpal:signal'); return }
      if (this.status === 'connected') return
      this.setStatus(reachable || this.sig?.everOpened ? 'signaling' : 'unreachable')
    }
    this.sig.connect()
    // The offer (and its candidates) take shape while the socket connects, so they leave the moment the host is known to be there.
    this.peerReady = this.buildPeer()
    document.addEventListener('visibilitychange', this.onVisible)
  }

  private onVisible = () => {
    if (document.visibilityState !== 'visible' || this.direct) return
    const s = this.pc?.connectionState
    if (this.hostPresent && s !== 'connected' && s !== 'connecting') this.restart(0)
  }

  private onSignal(m: SignalIn) {
    if (m.t === 'welcome') {
      this.hostPresent = m.host
      if (m.host) void this.sendOffer()
      else this.setStatus('waiting-host')
    } else if (m.t === 'peer' && m.role === 'host') {
      this.hostPresent = m.ev === 'join'
      // A host arriving later takes the prepared offer if nobody had it yet, else a fresh one.
      if (m.ev === 'join') void (this.offered ? this.startPeer() : this.sendOffer())
      else { this.teardown(); this.setStatus('waiting-host') }
    } else if (m.t === 'sig') {
      void this.onPayload(m.d)
    }
  }

  private async onPayload(d: SignalPayload) {
    const pc = this.pc
    if (!pc || !('pairing' in this.opts)) return
    if ('answer' in d) {
      const fp = sdpFingerprint(d.answer.sdp)
      if (!fp || !equalBytes(fp, this.opts.pairing.fp)) {
        this.teardown()
        this.setStatus('host-mismatch')
        return
      }
      mark('obpal:answer')
      await pc.setRemoteDescription(d.answer)
      for (const c of this.pendingCands.splice(0)) await pc.addIceCandidate(c).catch(() => {})
    } else if ('cand' in d) {
      if (pc.remoteDescription) await pc.addIceCandidate(d.cand).catch(() => {})
      else this.pendingCands.push(d.cand)
    }
  }

  private async newPeer(config: RTCConfiguration): Promise<RTCPeerConnection | null> {
    const cert = await this.opts.cert
    if (this.status === 'closed') return null
    const pc = new RTCPeerConnection(cert ? { ...config, certificates: [cert] } : config)
    this.pc = pc
    this.ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0 })
    this.st = pc.createDataChannel('st', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
    this.st.binaryType = 'arraybuffer'
    this.ctl.onopen = () => { mark('obpal:open'); void this.bind(pc) }
    this.ctl.onmessage = (e) => this.onCtl(e.data)
    return pc
  }

  /** A peer connection with a local offer, candidates gathering. Nothing is sent until sendOffer(). */
  private async buildPeer(): Promise<RTCPeerConnection | null> {
    // ICE servers were requested at start and are normally here first. Never wait long for TURN credentials
    // though: on the LAN the host candidates carry the connection, and a rebuild picks TURN up later.
    if (this.iceReady) await Promise.race([this.iceReady, new Promise((r) => setTimeout(r, ICE_WAIT_MS))])
    this.teardown()
    const pc = await this.newPeer({ iceServers: this.ice })
    if (!pc) return null
    pc.onicecandidate = (e) => {
      if (!e.candidate || this.pc !== pc) return
      if (this.offered) this.sig?.send({ t: 'sig', d: { cand: e.candidate.toJSON() } })
      else this.localCands.push(e.candidate.toJSON())
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'failed') this.restart(300)
      else if (pc.connectionState === 'disconnected') this.restart(3000)
    }
    this.ctl!.onclose = () => { if (this.pc === pc && this.status === 'connected') this.restart(500) }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    mark('obpal:offer')
    return pc
  }

  /** The prepared offer goes to the host, followed by whatever candidates gathered meanwhile. */
  private async sendOffer() {
    if (this.offered) return
    this.setStatus('connecting')
    const pc = await (this.peerReady ??= this.buildPeer())
    if (!pc || this.pc !== pc || this.offered) return
    this.offered = true
    this.sig?.send({ t: 'sig', d: { offer: pc.localDescription!.toJSON() } })
    for (const c of this.localCands.splice(0)) this.sig?.send({ t: 'sig', d: { cand: c } })
    mark('obpal:sent')
  }

  /** A fresh offer (reconnect, or a new host): rebuild, then send. */
  private async startPeer() {
    this.teardown()
    this.setStatus('connecting')
    this.peerReady = this.buildPeer()
    await this.sendOffer()
  }

  /**
   * Direct LAN link: the host's offer is rebuilt from its code and the remembered fingerprint; the answer's ICE
   * credentials are derived from the pairing key and the code's nonce, which the host derived too. The host
   * learns this device's address from its connectivity checks, so no description ever travels back.
   */
  private async startLan() {
    if (!('lan' in this.opts)) return
    const { lan, pair } = this.opts
    this.setStatus('connecting')
    const [creds, cert] = await Promise.all([lanIceCredentials(pair.key, lan.nonce), this.opts.cert])
    if (!cert) return this.setStatus('lan-unsupported')
    const pc = await this.newPeer({ iceServers: [] })
    if (!pc) return
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.failLan()
    }
    this.ctl!.onclose = () => { if (this.pc === pc && this.status === 'connected') { this.teardown(); this.setStatus('lan-failed') } }
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: lanOfferSdp({ ufrag: lan.ufrag, pwd: lan.pwd, fp: pair.peerFp, cands: lan.cands }) })
      const answer = await pc.createAnswer()
      await pc.setLocalDescription({ type: 'answer', sdp: mungeIce(answer.sdp ?? '', creds.ufrag, creds.pwd) })
    } catch (e) {
      this.teardown()
      // A browser that refuses modified ICE credentials cannot take this path at all.
      this.setStatus((e as { name?: string })?.name === 'InvalidModificationError' ? 'lan-unsupported' : 'lan-failed')
      return
    }
    mark('obpal:offer')
    this.lanTimer = setTimeout(() => this.failLan(), LAN_TIMEOUT_MS)
  }

  private failLan() {
    if (this.status === 'connected' || this.status === 'lan-failed' || this.status === 'lan-unsupported') return
    this.teardown()
    this.setStatus('lan-failed')
  }

  private async bind(pc: RTCPeerConnection) {
    this.setStatus('securing')
    const fpDevice = sdpFingerprint(pc.localDescription?.sdp)
    if (!fpDevice) return this.direct ? this.failLan() : this.restart(500)
    const o = this.opts
    const [key, fpHost, context, pair] = 'lan' in o
      ? [o.pair.key, o.pair.peerFp, lanContext(o.lan.nonce), o.pair.id]
      : [o.pairing.secret, o.pairing.fp, this.roomId, undefined]
    const [mac, name] = await Promise.all([bindMac(key, fpDevice, fpHost, context), o.name])
    this.sendCtl({ t: 'hello', proto: PROTO, caps: o.caps(), mac, name, pair })
  }

  private onCtl(data: unknown) {
    if (typeof data !== 'string') return
    let m: HostMsg
    try { m = JSON.parse(data) } catch { return }
    if (m.t === 'welcome') {
      mark('obpal:welcome')
      if (this.lanTimer) { clearTimeout(this.lanTimer); this.lanTimer = null }
      this.setStatus('connected')
      if (m.pair && 'pairing' in this.opts && this.opts.remember) void this.remember(m.pair, m.name)
    }
    if (m.t === 'pong') this.rttMs = Math.round(performance.now() - m.t0)
    if (m.t === 'lock') { this.teardown(); this.setStatus(m.reason === 'taken-over' ? 'taken-over' : 'waiting-host') }
    this.emit('message', m)
  }

  private async remember(grant: PairGrant, hostName: string) {
    if (!('pairing' in this.opts)) return
    try {
      const key = fromB64url(grant.key)
      if (key.length !== 32 || fromB64url(grant.id).length !== 16) return
      const p: StoredPair = { id: grant.id, key, peerFp: this.opts.pairing.fp, peerName: String(hostName || 'Screen').slice(0, 40), at: Date.now() }
      await putPair(p)
      this.emit('pair', p)
    } catch { /* malformed grant: ignore */ }
  }

  private restart(delay: number) {
    if (this.direct) return
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
    this.localCands = []
    this.offered = false
    this.peerReady = null
    if (this.lanTimer) { clearTimeout(this.lanTimer); this.lanTimer = null }
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
    if (this.restartTimer) clearTimeout(this.restartTimer)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.teardown()
    this.sig?.close()
    this.setStatus('closed')
  }
}
