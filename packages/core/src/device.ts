import type { Caps, DeviceMsg, HostMsg, PairGrant, SignalIn, SignalPayload } from './messages'
import { CodePake } from './code'
import {
  b64url, bindMac, equalBytes, fromB64url, lanContext, lanIceCredentials, lanOfferSdp, mungeIce, parsePairing, roomIdFor, sdpFingerprint,
  type LanPairing, type Pairing,
} from './pairing'
import { fetchIce, linkPath, roomSocketUrl, SignalClient, type IceSet } from './signal'
import { PROTO } from './state'
import { putPair, type StoredPair } from './store'

export type LinkStatus =
  | 'signaling' | 'unreachable' | 'waiting-host' | 'connecting' | 'securing' | 'connected'
  | 'reconnecting' | 'taken-over' | 'host-mismatch' | 'lan-failed' | 'lan-unsupported' | 'removed' | 'full' | 'closed'
  /** Joining by short code failed: the code was wrong, or already had its one attempt (PROTOCOL §2b). */
  | 'code-wrong'

export interface DeviceLinkEvents {
  status: (s: LinkStatus) => void
  message: (m: HostMsg) => void
  stats: (s: { path: 'direct' | 'relay' | 'unknown'; rttMs: number | null }) => void
  /** The host remembers this device now (an online pairing handed over a pairing key). */
  pair: (p: StoredPair) => void
  /**
   * Joined by short code: the online pairing code the host handed over (the QR link's fragment). The link carries on
   * with it, and a page keeps it to reload with.
   */
  invite: (fragment: string) => void
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
  /**
   * Through the room service by short code (PROTOCOL §2b): the code as typed, split into its handle and secret, and
   * the room and ticket its lookup gave. Once in, the host's invite makes this the pairing above.
   */
  | { service: string; code: { handle: string; secret: string; room: string; ticket: string }; remember?: boolean }
  /** Direct over the LAN, no server: the host's direct code and the pairing this device remembers for it. */
  | { lan: LanPairing; pair: StoredPair }
)

/** How long a direct LAN attempt may take before it is given up (the code is single-use, so no retry). */
const LAN_TIMEOUT_MS = 10_000
/** How long the offer waits for the ICE server lookup (TURN credentials) before it is built with STUN only. */
const ICE_WAIT_MS = 250
/**
 * Once the host is there, how much longer an offer whose ICE servers haven't come holds on for them: without them it
 * carries no relay, and on a network that only a relay gets through, ICE would search for a path that isn't there.
 */
const ICE_SEND_WAIT_MS = 400
/**
 * An attempt that hasn't connected after ATTEMPT_MS starts again if it made no progress at all (a lost offer or
 * answer, or no candidates to try) or was built before its TURN servers came; any attempt does after ATTEMPT_MAX_MS.
 */
const ATTEMPT_MS = 6000
const ATTEMPT_MAX_MS = 20_000

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
  /** The room's ICE servers as the service gave them (null until they come). */
  private iceSet: IceSet | null = null
  /** The ICE servers the current peer connection was built with. */
  private builtWith: RTCIceServer[] | null = null
  /** Counts builds: a build that a newer one (or a teardown) overtook gives up. */
  private builds = 0
  private attemptTimer: ReturnType<typeof setTimeout> | null = null
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
  private handlers: { [K in keyof DeviceLinkEvents]: DeviceLinkEvents[K][] } = { status: [], message: [], stats: [], pair: [], invite: [] }
  /** By short code: the host's fingerprint as its answer gave it, and this side of the exchange. */
  private hostFp: Uint8Array | null = null
  private pake: CodePake | null = null
  /** By short code: the host has proven it holds the code (its confirmation checked). Until then only pake and lock count. */
  private codeProven = false
  /** The offer (its description) an answer has been taken for: one answer per offer, the first. */
  private answeredOffer: string | null = null

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
    const { service } = this.opts
    this.roomId = 'code' in this.opts ? this.opts.code.room : await roomIdFor(this.opts.pairing.secret)
    // The socket and the ICE server lookup race; neither waits for the other.
    this.iceReady = fetchIce(service, this.roomId).then((set) => this.takeIce(set))
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
    if (!pc || 'lan' in this.opts) return
    if ('answer' in d) {
      // Only while an offer of ours waits (the first, or a later one on this connection, such as an ICE restart), and
      // one answer per offer, the first: any other is ignored, whatever it says.
      const offer = pc.localDescription?.sdp
      if (pc.signalingState !== 'have-local-offer' || !offer || this.answeredOffer === offer) return
      this.answeredOffer = offer
      const fp = sdpFingerprint(d.answer.sdp)
      // The QR code pins the host's fingerprint. By short code there's nothing to pin yet: the first answer binds its
      // own, and the exchange proves it. Either way a later answer on this connection carries exactly that one.
      const pin = 'pairing' in this.opts ? this.opts.pairing.fp : null
      if (!fp || (pin && !equalBytes(fp, pin)) || (this.hostFp && !equalBytes(fp, this.hostFp))) {
        this.teardown()
        this.setStatus('host-mismatch')
        return
      }
      mark('obpal:answer')
      try {
        await pc.setRemoteDescription(d.answer)
      } catch {
        if (this.pc === pc) this.restart(300)
        return
      }
      // The fingerprint of the answer that applied is the one DTLS checks, so it's the one the exchange binds.
      if (this.pc !== pc) return
      this.hostFp = fp
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

  /**
   * A peer connection with a local offer, candidates gathering. Nothing is sent until sendOffer(). A newer build (or
   * a teardown) overtakes this one, which then gives up.
   */
  private async buildPeer(): Promise<RTCPeerConnection | null> {
    const build = ++this.builds
    // ICE servers were requested at start and are normally here first. Never wait long for TURN credentials
    // though: on the LAN the host candidates carry the connection, and an offer not yet sent is built again
    // when they come (takeIce).
    if (this.iceReady) await Promise.race([this.iceReady, new Promise((r) => setTimeout(r, ICE_WAIT_MS))])
    // The certificate first (the first one is generated now): the ICE servers may come meanwhile.
    await this.opts.cert
    if (build !== this.builds) return null
    this.closePeer()
    const servers = this.ice
    this.builtWith = servers
    const pc = await this.newPeer({ iceServers: servers })
    if (!pc || build !== this.builds) return null
    pc.onicecandidate = (e) => {
      if (!e.candidate || this.pc !== pc) return
      if (this.offered) this.sig?.send({ t: 'sig', d: { cand: e.candidate.toJSON() } })
      else this.localCands.push(e.candidate.toJSON())
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      if (pc.connectionState === 'connected') this.clearAttempt()
      else if (pc.connectionState === 'failed') this.restart(300)
      else if (pc.connectionState === 'disconnected') this.restart(3000)
    }
    this.ctl!.onclose = () => { if (this.pc === pc && this.status === 'connected') this.restart(500) }
    try {
      await pc.setLocalDescription(await pc.createOffer())
    } catch {
      return null // closed meanwhile: a newer build or a teardown overtook this one
    }
    if (build !== this.builds || this.pc !== pc) return null
    mark('obpal:offer')
    return pc
  }

  /**
   * The room's ICE servers came. An offer built without them and not sent yet is built again with them (it takes a
   * few milliseconds), so a relay is in it from the start.
   */
  private takeIce(set: IceSet) {
    this.iceSet = set
    this.ice = set.servers
    mark('obpal:ice')
    if (!this.offered && this.peerReady && this.builtWith && this.builtWith !== set.servers) this.peerReady = this.buildPeer()
  }

  /**
   * The prepared offer goes to the host, followed by whatever candidates gathered meanwhile. It counts as sent only
   * once the socket took it: with the socket down it waits for the next welcome.
   */
  private async sendOffer() {
    if (this.offered) return
    this.setStatus('connecting')
    // Without its ICE servers the offer would carry no relay: give them a moment more (they're usually here first).
    if (!this.iceSet && this.iceReady) await Promise.race([this.iceReady, new Promise((r) => setTimeout(r, ICE_SEND_WAIT_MS))])
    let ready = (this.peerReady ??= this.buildPeer())
    let pc = await ready
    // Built again meanwhile (the ICE servers came): take the newer one.
    while (this.peerReady && this.peerReady !== ready) { ready = this.peerReady; pc = await ready }
    if (!pc || this.pc !== pc || this.offered || !this.sig?.open) return
    this.offered = true
    this.sig.send({ t: 'sig', d: { offer: pc.localDescription!.toJSON() } })
    for (const c of this.localCands.splice(0)) this.sig.send({ t: 'sig', d: { cand: c } })
    mark('obpal:sent')
    this.watchAttempt(pc)
  }

  /**
   * An attempt that doesn't connect starts again: after ATTEMPT_MS if it made no progress at all (a lost offer or
   * answer, or no candidates to try) or was built before its TURN servers came, and after ATTEMPT_MAX_MS whatever.
   */
  private watchAttempt(pc: RTCPeerConnection) {
    this.clearAttempt()
    const check = (last: boolean) => {
      this.attemptTimer = null
      if (this.pc !== pc || pc.connectionState === 'connected' || this.status === 'connected') return
      if (last || pc.connectionState === 'new' || this.builtWith !== this.ice) this.restart(0)
      else this.attemptTimer = setTimeout(() => check(true), ATTEMPT_MAX_MS - ATTEMPT_MS)
    }
    this.attemptTimer = setTimeout(() => check(false), ATTEMPT_MS)
  }

  private clearAttempt() {
    if (this.attemptTimer) { clearTimeout(this.attemptTimer); this.attemptTimer = null }
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
    if ('code' in o) {
      if (!this.hostFp) return this.restart(500)
      const pake = await CodePake.start('device', { secret: o.code.secret, handle: o.code.handle, room: this.roomId })
      this.pake = pake
      this.sendCtl({ t: 'hello', proto: PROTO, caps: o.caps(), name: await o.name, code: o.code.handle, ticket: o.code.ticket, pake: b64url(pake.share) })
      return
    }
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
    if (m.t === 'pake') { void this.confirmCode(m); return }
    // By short code, nothing the host says counts until it has proven the code: no welcome, layout, state or invite
    // from a host that skipped the exchange. Only its refusal is heard.
    if ('code' in this.opts && !this.codeProven && m.t !== 'lock') return
    if (m.t === 'welcome') {
      mark('obpal:welcome')
      if (this.lanTimer) { clearTimeout(this.lanTimer); this.lanTimer = null }
      this.setStatus('connected')
      const { pair, name } = m
      // By short code, the invite comes first: it is the pairing a grant is remembered with.
      void ('code' in this.opts ? this.takeInvite(m.invite) : Promise.resolve()).then(() => {
        if (pair && 'pairing' in this.opts && this.opts.remember) void this.remember(pair, name)
      })
    }
    if (m.t === 'lock' && m.reason === 'rejected' && 'code' in this.opts) {
      // The host turned the code down: wrong, or it already had its one attempt. It won't work again.
      this.teardown()
      this.sig?.close()
      this.setStatus('code-wrong')
      this.emit('message', m)
      return
    }
    if (m.t === 'pong') this.rttMs = Math.round(performance.now() - m.t0)
    if (m.t === 'lock') {
      this.teardown()
      // Removed or turned away: leave the room too, so this device neither rejoins nor holds one of its places.
      if (m.reason === 'removed' || m.reason === 'full') { this.sig?.close(); this.setStatus(m.reason) }
      else this.setStatus(m.reason === 'taken-over' ? 'taken-over' : 'waiting-host')
    }
    this.emit('message', m)
  }

  /** The host's share and confirmation: check it, then confirm back. A wrong code shows up here first. */
  private async confirmCode(m: Extract<HostMsg, { t: 'pake' }>) {
    const pake = this.pake
    const fpDevice = sdpFingerprint(this.pc?.localDescription?.sdp)
    if (!pake || !fpDevice || !this.hostFp || !('code' in this.opts)) return
    this.pake = null
    let share: Uint8Array
    try { share = fromB64url(m.y) } catch { share = new Uint8Array() }
    const macs = await pake.confirm(share, fpDevice, this.hostFp)
    const enc = new TextEncoder()
    if (!macs || typeof m.mac !== 'string' || !equalBytes(enc.encode(m.mac), enc.encode(macs.theirs))) {
      this.teardown()
      this.sig?.close()
      this.setStatus('code-wrong')
      return
    }
    this.codeProven = true
    this.sendCtl({ t: 'pake', mac: macs.mine })
  }

  /**
   * In by short code: the host's invite is the QR link's pairing code for the same room and the same host, and from
   * now on the link reconnects with it like a phone that scanned.
   */
  private async takeInvite(invite: string | undefined) {
    const o = this.opts
    const p = invite ? parsePairing(invite) : null
    if (!p || !('code' in o) || !this.hostFp || !equalBytes(p.fp, this.hostFp) || (await roomIdFor(p.secret)) !== this.roomId) return
    this.opts = { service: o.service, pairing: p, remember: o.remember, caps: o.caps, name: o.name, cert: o.cert }
    this.emit('invite', invite!)
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
    // A peer connection still being built is dropped too.
    this.builds++
    this.peerReady = null
    this.closePeer()
  }

  /** Close the peer connection and forget this attempt: its offer, candidates and timers. */
  private closePeer() {
    this.pendingCands = []
    this.answeredOffer = null
    this.hostFp = null
    this.pake = null
    // A new connection has to prove the code again (the old one's proof was for its own DTLS session).
    this.codeProven = false
    this.localCands = []
    this.offered = false
    this.builtWith = null
    this.clearAttempt()
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
