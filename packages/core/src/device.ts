import type { Caps, DeviceMsg, HostMsg, PairGrant, SignalIn, SignalPayload } from './messages'
import { CodePake } from './code'
import {
  b64url, bindMac, equalBytes, fromB64url, importPairKey, lanContext, lanIceCredentials, lanOfferSdp, mungeIce, parsePairing, roomIdFor, sdpFingerprint,
  type LanPairing, type Pairing,
} from './pairing'
import { fetchIce, ICE_REFRESH_BEFORE_MS, linkInfo, roomSocketUrl, SignalClient, type IceSet, type LinkInfo } from './signal'
import { PROTO } from './state'
import { putPair, type StoredPair } from './store'

export type LinkStatus =
  | 'signaling' | 'unreachable' | 'waiting-host' | 'connecting' | 'securing' | 'connected'
  | 'reconnecting' | 'taken-over' | 'host-mismatch' | 'lan-failed' | 'lan-unsupported' | 'removed' | 'full' | 'closed'
  /** Joining by short code failed: the code was wrong, or already had its one attempt (PROTOCOL §2b). */
  | 'code-wrong'
  /** The code this device came with has paired a device already, and the screen has moved on to a new one (PROTOCOL §2). */
  | 'invite-used'

/**
 * How this device knew the screen was the right one: `qr`, its fingerprint pinned by the QR code and the code's secret
 * proven (PROTOCOL §2); `code`, the typed code's exchange (§2b); `lan`, a remembered pairing's key and fingerprints (§2a).
 */
export type VerifiedBy = 'qr' | 'code' | 'lan'

export interface LinkStats {
  path: 'direct' | 'relay' | 'unknown'
  /** The control channel's round trip (ping to pong), ms. */
  rttMs: number | null
  /** What the connection's own statistics say: its path in detail, ICE's round trip, DTLS. */
  link?: LinkInfo
  verified?: VerifiedBy
}

export interface DeviceLinkEvents {
  status: (s: LinkStatus) => void
  message: (m: HostMsg) => void
  stats: (s: LinkStats) => void
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
/** A path that went quiet gets a new one this soon (an ICE restart), where the host takes restarts. */
const RESTART_GRACE_MS = 500
/** An ICE restart that hasn't brought a path back in this long gives way to building the connection again. */
const RESTART_MS = 6000
/** No pong in this long (pings go every 2 s) counts as a path gone quiet. */
const PONG_LOST_MS = 3500

const mark = (name: string) => { try { performance.mark(name) } catch { /* no marks here */ } }
/** The Network Information API where there is one (Chromium: `navigator.connection` says `change` on a new network). */
const netInfo = () => (typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { connection?: EventTarget }).connection)

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
  /** When the last pong came (performance.now()): a path that stops answering is looked for again (poll). */
  private pongAt = 0
  private handlers: { [K in keyof DeviceLinkEvents]: DeviceLinkEvents[K][] } = { status: [], message: [], stats: [], pair: [], invite: [] }
  /** By short code: the host's fingerprint as its answer gave it, and this side of the exchange. */
  private hostFp: Uint8Array | null = null
  private pake: CodePake | null = null
  /** By short code: the host has proven it holds the code (its confirmation checked). Until then only pake and lock count. */
  private codeProven = false
  /** The offer (its description) an answer has been taken for: one answer per offer, the first. */
  private answeredOffer: string | null = null
  /** The host takes ICE restarts (welcome{restart}): a path that goes is found again without a new connection. */
  private canRestart = false
  /** An ICE restart is under way (restartDue: its deadline), or one waits for the socket to come back. */
  private restarting = false
  private restartDue: ReturnType<typeof setTimeout> | null = null
  private restartWanted = false
  /** How this device knew the screen was the right one (the way it joined; a short code's invite doesn't change it). */
  readonly verifiedBy: VerifiedBy

  constructor(private opts: DeviceLinkOptions) {
    this.verifiedBy = 'lan' in opts ? 'lan' : 'code' in opts ? 'code' : 'qr'
  }

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
    globalThis.addEventListener?.('online', this.onNetwork)
    netInfo()?.addEventListener?.('change', this.onNetwork)
  }

  private onVisible = () => {
    if (document.visibilityState !== 'visible' || this.direct) return
    const s = this.pc?.connectionState
    if (this.hostPresent && s !== 'connected' && s !== 'connecting') this.restart(0)
  }

  /** The phone's network changed (it's online again, or on another kind of connection): look for a new path now. */
  private onNetwork = () => {
    if (this.status === 'connected' && this.canRestart) this.scheduleIceRestart(RESTART_GRACE_MS)
  }

  /** The link is up (bound, its connection alive or finding a new path), whatever the room service does. */
  private linkUp() {
    const s = this.pc?.connectionState
    return (this.status === 'connected' || this.restarting) && !!s && s !== 'closed' && s !== 'failed'
  }

  private onSignal(m: SignalIn) {
    if (m.t === 'welcome') {
      this.hostPresent = m.host
      // The socket came back while the link held: an ICE restart waiting for it goes now, and nothing else changes.
      if (this.linkUp()) { if (m.host && this.restartWanted) void this.restartIce(); return }
      if (m.host) void this.sendOffer()
      else this.setStatus('waiting-host')
    } else if (m.t === 'peer' && m.role === 'host') {
      this.hostPresent = m.ev === 'join'
      // The host's socket came back, or was lost (not closed): the link doesn't run through it.
      if (this.linkUp() && (m.ev === 'join' || m.clean === false)) return
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
    if ('gone' in d) {
      // The host no longer has the connection an ICE restart was for: a new one, at once.
      if (this.restarting) { this.restarting = false; this.restart(0, true) }
      return
    }
    if ('spent' in d) {
      // This code paired a device already, and the screen moved on to a new one: trying again won't help. The device that
      // paired with it comes back through it; this one needs the code on the screen now.
      if (this.status === 'connected' || this.restarting) return
      this.teardown()
      this.sig?.close()
      this.setStatus('invite-used')
      return
    }
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
      // An ICE restart's answer, while the connection held: the new path takes over as soon as ICE has it.
      if (this.restarting && pc.connectionState === 'connected') this.restartDone(pc)
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
    if (this.iceReady) await Promise.race([this.iceReady.catch(() => {}), new Promise((r) => setTimeout(r, ICE_WAIT_MS))])
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
      if (pc.connectionState === 'connected') { this.clearAttempt(); if (this.restarting && pc.signalingState === 'stable') this.restartDone(pc) }
      else if (pc.connectionState === 'failed') this.pathLost(true)
      else if (pc.connectionState === 'disconnected') this.pathLost(false)
    }
    this.ctl!.onclose = () => { if (this.pc === pc && (this.status === 'connected' || this.restarting)) { this.restarting = false; this.restart(500) } }
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
    if (!this.offered && this.peerReady && this.builtWith && JSON.stringify(this.builtWith) !== JSON.stringify(set.servers)) this.peerReady = this.buildPeer()
  }

  /**
   * The prepared offer goes to the host, followed by whatever candidates gathered meanwhile. It counts as sent only
   * once the socket took it: with the socket down it waits for the next welcome.
   */
  private async sendOffer() {
    if (this.offered) return
    this.setStatus('connecting')
    // Without its ICE servers the offer would carry no relay: give them a moment more (they're usually here first).
    if (!this.iceSet && this.iceReady) await Promise.race([this.iceReady.catch(() => {}), new Promise((r) => setTimeout(r, ICE_SEND_WAIT_MS))])
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
      this.canRestart = m.restart === true && !this.direct
      this.pongAt = performance.now()
      this.setStatus('connected')
      void this.poll()
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
    if (m.t === 'pong') { this.rttMs = Math.round(performance.now() - m.t0); this.pongAt = performance.now() }
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

  /** The host's pairing grant, kept: its key as a non-extractable key (importPairKey), and the bytes let go. */
  private async remember(grant: PairGrant, hostName: string) {
    if (!('pairing' in this.opts)) return
    try {
      const raw = fromB64url(grant.key)
      if (raw.length !== 32 || fromB64url(grant.id).length !== 16) return
      const key = await importPairKey(raw)
      raw.fill(0)
      const p: StoredPair = { id: grant.id, key, peerFp: this.opts.pairing.fp, peerName: String(hostName || 'Screen').slice(0, 40), at: Date.now() }
      await putPair(p)
      this.emit('pair', p)
    } catch { /* malformed grant: ignore */ }
  }

  /** Build the connection again after `delay`, unless it has come back by then (`gone`: the host says it hasn't). */
  private restart(delay: number, gone = false) {
    if (this.direct) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      const s = this.pc?.connectionState
      if (!gone && s === 'connected' && this.status === 'connected') return
      if (this.hostPresent) { this.setStatus('reconnecting'); void this.startPeer() }
    }, delay)
  }

  /**
   * The path went quiet (disconnected) or died (failed). A bound link whose host takes restarts looks for a new path
   * (an ICE restart); anything else is built again.
   */
  private pathLost(failed: boolean) {
    if (this.canRestart && (this.status === 'connected' || this.restarting)) {
      if (!this.restarting) this.scheduleIceRestart(failed ? 0 : RESTART_GRACE_MS)
      return
    }
    this.restart(failed ? 300 : 3000)
  }

  private scheduleIceRestart(delay: number) {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => { this.restartTimer = null; void this.restartIce() }, delay)
  }

  /**
   * A new path for the live connection, without building it again (RFC 8445 §9): new ICE credentials and candidates go
   * to the host through the room service, while the DTLS session, the channels and the binding stay, so input carries
   * on the moment a path is back. With the socket down, it goes on the socket's next welcome. A restart that hasn't
   * brought a path back in RESTART_MS gives way to a new connection.
   */
  private async restartIce() {
    const pc = this.pc
    if (!pc || this.direct || !this.canRestart || this.restarting || pc.connectionState === 'closed') return
    if (pc.connectionState !== 'connected') this.setStatus('reconnecting')
    if (!this.sig?.open) { this.restartWanted = true; return }
    this.restartWanted = false
    this.restarting = true
    try {
      await this.freshIce()
      pc.setConfiguration({ ...pc.getConfiguration(), iceServers: this.ice })
      pc.restartIce()
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: true }))
    } catch {
      this.restarting = false
      if (this.pc === pc) this.restart(0)
      return
    }
    if (this.pc !== pc || !this.sig?.open) { this.restarting = false; if (this.pc === pc) this.restartWanted = true; return }
    this.sig.send({ t: 'sig', d: { offer: pc.localDescription!.toJSON(), restart: true } })
    mark('obpal:restart')
    if (this.restartDue) clearTimeout(this.restartDue)
    this.restartDue = setTimeout(() => this.restartDone(pc), RESTART_MS)
  }

  /**
   * An ICE restart ends: at its deadline, or once the host's answer applied with the connection up. Up, the link goes
   * on (a pending offer the host never answered is rolled back: the old path held); down, it is built again.
   */
  private restartDone(pc: RTCPeerConnection) {
    if (this.restartDue) { clearTimeout(this.restartDue); this.restartDue = null }
    if (!this.restarting) return
    this.restarting = false
    if (this.pc !== pc) return
    if (pc.connectionState === 'connected') {
      if (pc.signalingState === 'have-local-offer') pc.setLocalDescription({ type: 'rollback' }).catch(() => {})
      this.pongAt = performance.now()
      if (this.status === 'reconnecting') this.setStatus('connected')
      return
    }
    this.restart(0)
  }

  /** ICE servers whose TURN credentials won't lapse in the next few minutes, fetched again if they would. */
  private async freshIce() {
    if (!('service' in this.opts) || !this.roomId) return
    const expires = this.iceSet?.expires
    if (this.iceSet?.turn && expires && expires - Date.now() > ICE_REFRESH_BEFORE_MS) return
    const set = await fetchIce(this.opts.service, this.roomId)
    this.iceSet = set
    this.ice = set.servers
  }

  private async poll() {
    // An offer that should be out and isn't (the host is there, the socket open, nothing under way): it goes now.
    if (!this.direct && !this.offered && !this.restarting && this.hostPresent && this.sig?.open && this.status !== 'connected') void this.sendOffer()
    if (this.status !== 'connected' || !this.pc) return
    // No pong since the ping before last: the path has gone quiet, and ICE would take a while longer to say so.
    if (this.canRestart && !this.restarting && this.pongAt && performance.now() - this.pongAt > PONG_LOST_MS) this.scheduleIceRestart(0)
    this.sendCtl({ t: 'ping', t0: performance.now() })
    const link = await linkInfo(this.pc)
    const path = link.path === 'relay' ? 'relay' : link.path === 'unknown' ? 'unknown' : 'direct'
    this.emit('stats', { path, rttMs: this.rttMs, link, verified: this.verifiedBy })
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
    // Restarts belong to a connection: the next one says again whether its host takes them.
    this.canRestart = false
    this.pongAt = 0
    this.restarting = false
    this.restartWanted = false
    if (this.restartDue) { clearTimeout(this.restartDue); this.restartDue = null }
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
    globalThis.removeEventListener?.('online', this.onNetwork)
    netInfo()?.removeEventListener?.('change', this.onNetwork)
    this.teardown()
    this.sig?.close()
    this.setStatus('closed')
  }
}
