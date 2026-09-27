import {
  b64url, bindMac, candidatesOf, certFingerprint, DEFAULT_SERVICE, encodeLanPairing, encodePairing, equalBytes,
  fetchIceServers, forgetPair, fromB64url, lanAnswerSdp, lanContext, lanIceCredentials, listPairs, loadCertificate, MAX_NODE_ID, MAX_TEXT, MAX_TOSS, Mode, newSecret, PAD_HEADER,
  packetType, POINTER_HEADER, POSE_HEADER, PROTO, putPair, randomBytes, readLocalIce, roomIdFor, roomSocketUrl, sdpFingerprint, SignalClient,
  type Caps, type DeviceMsg, type HostMsg, type Layout, type ModeId, type PadState, type PairGrant, type PointerState, type SceneNode,
  type ScenePerson, type SignalIn, type SignalPayload, type StoredPair,
} from '@obpal/core'
import { Stream, type Frame } from './stream'

export type { Frame } from './stream'

export type HostStatus = 'starting' | 'ready' | 'connecting' | 'connected' | 'offline'

export interface RemoteOptions {
  /** Shown on the phone ("Controlling <appName>"). */
  appName: string
  /** Room service origin. Defaults to this origin on ob-pal hosts, else the public service. */
  service?: string
  /** Tray buttons and modes offered to the phone. */
  layout?: Layout
  /** 'smooth' interpolates motion one sensor period behind (default); 'direct' uses the newest sample. */
  latency?: 'smooth' | 'direct'
  /**
   * Keep a persistent DTLS certificate and remember paired phones (IndexedDB). A remembered phone can then
   * connect over the LAN through a direct code (lanUrl) when the room service is unreachable.
   */
  remember?: boolean
  /**
   * How many devices control the scene at once (CATALOGUE §5). 1, the default: a device that connects takes over from
   * the one before. More: a shared scene, where each device is a participant with its own input, colour and claim.
   */
  seats?: number
}

/** A device in the scene (CATALOGUE §5). The lead is the oldest; while it holds nothing it drives the shared view. */
export interface Participant { id: string; name: string; color: string; lead: boolean; since: number; caps: Caps | null }

/** A remembered phone, as shown to people (no key material). */
export interface PairSummary { id: string; name: string; at: number }

/** Connection timeline for diagnostics and benches (epoch ms; 0 when it hasn't happened). */
export interface LinkDiag { status: HostStatus; connectedAt: number; firstInputAt: number; direct: boolean }

interface RemoteEvents {
  status: (s: HostStatus) => void
  /** A device connected to an empty scene (with one seat: every device that takes over). */
  connect: (info: { name: string; caps: Caps }) => void
  /** The last device left. */
  disconnect: () => void
  /** A participant joined or left (fired with one seat too). */
  join: (p: Participant) => void
  leave: (p: Participant) => void
  button: (e: { id: string; ev: string }, who: Participant) => void
  /** Typing on the device's keyboard (a `keyboard` tray control): delete `del` characters, then type `s`. */
  text: (e: { s: string; del: number }, who: Participant) => void
  /** The device was flicked upward (a layout with `toss`): how fast it went up, m/s. */
  toss: (e: { v: number }, who: Participant) => void
  /** add: the phone asked to add this option alongside the current one (tray select with `add`). */
  value: (e: { id: string; v: number | boolean | string; add?: boolean }, who: Participant) => void
  mode: (m: ModeId, who: Participant) => void
  recenter: (who: Participant) => void
  /** A device entered (true) or left (false) gamepad mode. */
  pad: (connected: boolean, who: Participant) => void
  /** A STATE or PAD packet just arrived (sample now for the lowest latency). */
  input: (who: Participant) => void
  /** A device asked to claim a node (null: release). The host decides, then publishes the outcome with setScene(). */
  claim: (e: { node: string | null }, who: Participant) => void
  /** The direct LAN code or the remembered phones changed. */
  lan: () => void
}

interface Peer {
  id: string
  pc: RTCPeerConnection
  ctl: RTCDataChannel
  st: RTCDataChannel
  fp: Uint8Array | null
  bound: boolean
  name: string
  cands: RTCIceCandidateInit[]
  /** Set for a direct LAN peer: which remembered pairing it must prove, and the nonce of its code. */
  lan?: { pair: StoredPair; nonce: Uint8Array }
  stream: Stream
  color: string
  since: number
  caps: Caps | null
  lost: ReturnType<typeof setTimeout> | null
  /** The node list version this peer last received. */
  nodesSent: number
}

const isObpalOrigin = () =>
  typeof location !== 'undefined' &&
  (/(^|\.)blackboxes\.(net|dev)$/.test(location.hostname) || location.hostname === 'localhost' || location.hostname === '127.0.0.1')

export const DEFAULT_LAYOUT: Layout = { v: 1, tray: [], modes: [Mode.tilt, Mode.hold, Mode.point] }

/** How long the direct code's offer may gather host candidates before the code is published. */
const LAN_GATHER_MS = 800

/**
 * Participant colours in a shared scene, in the order they're handed out: the Blackboxes family accents (sky, rose,
 * amber, mint, lavender, lime, turquoise, candy), so a device can wear its colour as its accent. The screen's own
 * colour is skipped.
 */
export const PARTICIPANT_COLORS = ['#38bdf8', '#fb7185', '#fcd34d', '#6ee7b7', '#d2c3f6', '#c6ff34', '#99e1d9', '#b2d5e5']

const quiet = { mode: () => {}, pad: () => {}, input: () => {} }

/** Host side of an ob-pal link, for any web page. */
export class Remote {
  status: HostStatus = 'starting'
  pairingUrl = ''
  /** The lead device's name (the only device's, with one seat). */
  deviceName: string | null = null
  readonly service: string
  private layout: Layout
  private secret = newSecret()
  private fp: Uint8Array = new Uint8Array(32)
  private roomId = ''
  private cert!: RTCCertificate
  private ice: RTCIceServer[] = []
  private sig!: SignalClient
  private peers = new Map<string, Peer>()
  /** With one seat, the device in control; in a shared scene, the lead. */
  private active: Peer | null = null
  private pairs: StoredPair[] = []
  /** The pending direct-code offer: a peer connection waiting for the remembered phone's checks. */
  private lan: { peer: Peer; url: string; pairId: string } | null = null
  private lanChoice: string | null = null
  private lanBusy: Promise<void> = Promise.resolve()
  private connectedAt = 0
  private firstInputAt = 0
  private idle = new Stream(quiet)
  /** The last values set for everyone, sent to each participant as it joins a shared scene. */
  private values: Record<string, number | boolean | string> = {}
  private host: ScenePerson = { id: 'host', name: 'Screen', color: '#c6ff34' }
  private nodes: SceneNode[] = []
  private nodesVersion = 0
  private held: Record<string, string> = {}
  private scenePending = false
  private handlers: { [K in keyof RemoteEvents]: RemoteEvents[K][] } = {
    status: [], connect: [], disconnect: [], join: [], leave: [], button: [], text: [], toss: [], value: [], mode: [], recenter: [], pad: [], input: [], claim: [], lan: [],
  }
  private cards: { el: HTMLElement; status: HTMLElement; qr: HTMLElement; link: HTMLAnchorElement | null; compact: boolean }[] = []

  private constructor(private opts: RemoteOptions) {
    this.service = (opts.service ?? (isObpalOrigin() ? location.origin : DEFAULT_SERVICE)).replace(/\/$/, '')
    this.layout = opts.layout ?? DEFAULT_LAYOUT
  }

  static async create(opts: RemoteOptions): Promise<Remote> {
    const r = new Remote(opts)
    await r.init()
    return r
  }

  private get seats() { return Math.max(1, Math.min(8, Math.floor(this.opts.seats ?? 1))) }
  /** A shared scene: several devices at once, each with its own claim. */
  get shared() { return this.seats > 1 }

  private async init() {
    if (this.opts.remember) {
      const c = await loadCertificate('host')
      this.cert = c.cert
      this.fp = c.fp
      this.pairs = await listPairs()
    } else {
      this.cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams)
      this.fp = await certFingerprint(this.cert)
    }
    await this.openRoom()
    void this.prepareLan()
  }

  /** Join the signaling room of the current secret: the invite the pairing code carries. */
  private async openRoom() {
    this.roomId = await roomIdFor(this.secret)
    this.pairingUrl = `${this.service}/p/#${encodePairing({ secret: this.secret, fp: this.fp })}`
    this.sig = new SignalClient(roomSocketUrl(this.service, this.roomId, 'host'))
    this.sig.onmessage = (m) => this.onSignal(m)
    // Unreachable within the connect budget counts as offline at once: the direct code takes over on the popup.
    this.sig.onstatus = (open) => {
      if (open && this.status !== 'connected') this.setStatus('ready')
      if (!open && this.status !== 'connected') this.setStatus('offline')
    }
    this.sig.connect()
    // TURN credentials are only minted for rooms with a live host, so fetch after joining.
    const room = this.roomId
    setTimeout(async () => { const ice = await fetchIceServers(this.service, room); if (room === this.roomId) this.ice = ice }, 400)
  }

  /**
   * A new invite: the old code and link stop working, and everyone connected stays. Devices that joined but haven't
   * finished connecting have to scan again.
   */
  async resetInvite() {
    const old = this.sig
    this.secret = newSecret()
    old.onmessage = () => {}
    old.onstatus = () => {}
    old.close()
    for (const p of [...this.peers.values()]) if (!p.bound && !p.lan) this.dropPeer(p.id)
    await this.openRoom()
    for (const c of this.cards) this.renderQr(c)
    this.renderCards()
  }

  on<K extends keyof RemoteEvents>(ev: K, fn: RemoteEvents[K]) { this.handlers[ev].push(fn); return this }
  private emit<K extends keyof RemoteEvents>(ev: K, ...args: Parameters<RemoteEvents[K]>) {
    for (const fn of this.handlers[ev]) (fn as (...a: unknown[]) => void)(...args)
  }
  private setStatus(s: HostStatus) {
    if (this.status === s) return
    this.status = s
    this.renderCards()
    this.emit('status', s)
  }

  // ---- remembered phones and the direct LAN code -------------------------------------------------------------

  /** Phones this host remembers, newest first. */
  get remembered(): PairSummary[] { return this.pairs.map((p) => ({ id: p.id, name: p.peerName, at: p.at })) }
  /** The direct code URL (empty until a remembered phone exists and the offer has gathered). */
  get lanUrl() { return this.lan?.url ?? '' }
  /** Which remembered phone the direct code is for. */
  get lanFor() { return this.lan?.pairId ?? null }
  /** True while the room service can't be reached (the direct code is the way in). */
  get offline() { return this.status === 'offline' }

  diag(): LinkDiag {
    return { status: this.status, connectedAt: this.connectedAt, firstInputAt: this.firstInputAt, direct: !!this.active?.lan }
  }

  /** Make the direct code for another remembered phone. */
  selectLan(id: string) {
    if (!this.pairs.some((p) => p.id === id) || this.lan?.pairId === id) return
    this.lanChoice = id
    void this.prepareLan()
  }

  /** Forget a remembered phone: it can only pair online again. */
  async forget(id: string) {
    this.pairs = this.pairs.filter((p) => p.id !== id)
    if (this.lanChoice === id) this.lanChoice = null
    await forgetPair(id)
    if (this.lan?.pairId === id) this.discardLan()
    this.emit('lan')
    void this.prepareLan()
  }

  private discardLan() {
    const l = this.lan
    this.lan = null
    if (l) this.dropPeer(l.peer.id)
  }

  /** After an online pairing: a (new) key for this phone, kept here and handed to it in `welcome`. Stored in the background. */
  private rememberDevice(peer: Peer, name: string): PairGrant | null {
    if (!this.opts.remember || !peer.fp) return null
    const existing = this.pairs.find((p) => equalBytes(p.peerFp, peer.fp!))
    const key = randomBytes(32)
    const rec: StoredPair = { id: existing?.id ?? b64url(randomBytes(16)), key, peerFp: peer.fp, peerName: name, at: Date.now() }
    this.pairs = [rec, ...this.pairs.filter((p) => p.id !== rec.id)]
    void putPair(rec).then(() => this.emit('lan'))
    return { id: rec.id, key: b64url(key) }
  }

  /**
   * Prepare the direct code: an offer with this host's real ICE credentials and host candidates, already paired
   * with a synthetic answer holding the remembered phone's fingerprint and the ICE credentials both sides derive
   * from the pairing key and a fresh nonce. Its connection then waits for the phone's connectivity checks.
   */
  private prepareLan(): Promise<void> {
    this.lanBusy = this.lanBusy.then(() => this.buildLan()).catch(() => {})
    return this.lanBusy
  }

  private async buildLan() {
    if (!this.opts.remember) return
    const pair = this.pairs.find((p) => p.id === this.lanChoice) ?? this.pairs[0]
    if (!pair) { if (this.lan) { this.discardLan(); this.emit('lan') } return }
    if (this.lan?.pairId === pair.id && this.lan.peer.pc.connectionState === 'new') return
    this.discardLan()
    const nonce = randomBytes(16)
    const id = `lan:${b64url(nonce).slice(0, 8)}`
    const pc = new RTCPeerConnection({ iceServers: [], certificates: [this.cert] })
    const peer = this.addPeer(id, pc, pair.peerFp)
    peer.lan = { pair, nonce }
    const gathered = new Set<string>()
    pc.onicecandidate = (e) => { if (e.candidate) gathered.add(e.candidate.candidate) }
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await new Promise<void>((r) => {
      const done = () => { if (pc.iceGatheringState === 'complete') r() }
      pc.addEventListener('icegatheringstatechange', done)
      setTimeout(r, LAN_GATHER_MS)
    })
    const local = readLocalIce(pc.localDescription?.sdp)
    const cands = local?.cands.length ? local.cands : candidatesOf([...gathered].join('\n'))
    if (!local || !cands.length || this.peers.get(id) !== peer) { this.dropPeer(id); return }
    const creds = await lanIceCredentials(pair.key, nonce)
    await pc.setRemoteDescription({ type: 'answer', sdp: lanAnswerSdp({ ...creds, fp: pair.peerFp }) })
    if (this.peers.get(id) !== peer) return
    this.lan = { peer, pairId: pair.id, url: `${this.service}/p/#${encodeLanPairing({ id: fromB64url(pair.id), nonce, ufrag: local.ufrag, pwd: local.pwd, cands })}` }
    this.emit('lan')
  }

  // ---- signaling and peers ------------------------------------------------------------------------------------

  private onSignal(m: SignalIn) {
    if (m.t === 'peer' && m.ev === 'leave') this.dropPeer(m.id)
    if (m.t === 'sig') void this.onPayload(m.from, m.d)
  }

  /** One peer connection with the two pre-negotiated channels, wired into this host. */
  private addPeer(id: string, pc: RTCPeerConnection, fp: Uint8Array | null): Peer {
    const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0 })
    const st = pc.createDataChannel('st', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
    st.binaryType = 'arraybuffer'
    const peer: Peer = {
      id, pc, ctl, st, fp, bound: false, name: 'Phone', cands: [], color: this.host.color, since: 0, caps: null, lost: null, nodesSent: -1,
      stream: new Stream({
        mode: (m) => this.emit('mode', m, this.participant(peer)),
        pad: (on) => this.emit('pad', on, this.participant(peer)),
        input: () => { if (!this.firstInputAt) this.firstInputAt = Date.now(); this.emit('input', this.participant(peer)) },
      }, this.opts.latency),
    }
    this.peers.set(id, peer)
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState
      if ((s === 'failed' || s === 'closed' || s === 'disconnected') && peer.bound) this.scheduleLost(peer)
      // A direct-code attempt that died before binding: its code is spent, make a fresh one.
      if ((s === 'failed' || s === 'closed') && !peer.bound && this.lan?.peer === peer) { this.lan = null; this.dropPeer(id); void this.prepareLan() }
      if (s === 'connected' && peer.lost) { clearTimeout(peer.lost); peer.lost = null }
    }
    ctl.onmessage = (e) => void this.onCtl(peer, e.data)
    st.onmessage = (e) => {
      if (!this.listening(peer) || !(e.data instanceof ArrayBuffer)) return
      const type = packetType(e.data)
      if (type === PAD_HEADER) peer.stream.onPad(e.data)
      else if (type === POINTER_HEADER) peer.stream.onPointer(e.data)
      else if (type === POSE_HEADER) peer.stream.onPose(e.data)
      else peer.stream.onState(e.data)
    }
    return peer
  }

  /** Whether a bound device's input counts: every participant in a shared scene, only the device in control otherwise. */
  private listening(peer: Peer) { return peer.bound && (this.shared || this.active === peer) }

  private async onPayload(id: string, d: SignalPayload) {
    if ('offer' in d) {
      this.dropPeer(id)
      if (this.status !== 'connected') this.setStatus('connecting')
      const pc = new RTCPeerConnection({ iceServers: this.ice, certificates: [this.cert] })
      const peer = this.addPeer(id, pc, sdpFingerprint(d.offer.sdp))
      pc.onicecandidate = (e) => { if (e.candidate) this.sig.send({ t: 'sig', to: id, d: { cand: e.candidate.toJSON() } }) }
      await pc.setRemoteDescription(d.offer)
      for (const c of peer.cands.splice(0)) await pc.addIceCandidate(c).catch(() => {})
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.sig.send({ t: 'sig', to: id, d: { answer: pc.localDescription!.toJSON() } })
    } else if ('cand' in d) {
      const peer = this.peers.get(id)
      if (!peer) return
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(d.cand).catch(() => {})
      else peer.cands.push(d.cand)
    }
  }

  private async onCtl(peer: Peer, data: unknown) {
    if (typeof data !== 'string') return
    let m: DeviceMsg
    try { m = JSON.parse(data) } catch { return }
    if (!peer.bound) {
      if (m.t !== 'hello' || !peer.fp) return
      // Online: the code's secret and the room. Direct: the remembered pairing key and the code's nonce.
      const expected = peer.lan
        ? await bindMac(peer.lan.pair.key, peer.fp, this.fp, lanContext(peer.lan.nonce))
        : await bindMac(this.secret, peer.fp, this.fp, this.roomId)
      if (peer.lan && m.pair !== peer.lan.pair.id) { this.reject(peer); return }
      if (!equalBytes(new TextEncoder().encode(expected), new TextEncoder().encode(m.mac))) { this.reject(peer); return }
      if (this.shared && this.bound().length >= this.seats) {
        this.send(peer, { t: 'lock', reason: 'full' })
        setTimeout(() => this.dropPeer(peer.id), 200)
        return
      }
      peer.bound = true
      peer.name = String(m.name || 'Phone').slice(0, 40)
      peer.caps = m.caps ?? null
      peer.since = Date.now()
      if (this.shared) {
        peer.color = this.freeColor(peer)
        if (!this.active) this.active = peer
      } else {
        const prev = this.active
        if (prev && prev !== peer) {
          this.send(prev, { t: 'lock', reason: 'taken-over' })
          setTimeout(() => this.dropPeer(prev.id), 300)
        }
        this.active = peer
      }
      peer.stream.reset()
      this.deviceName = this.active?.name ?? null
      this.connectedAt = Date.now()
      this.firstInputAt = 0
      if (peer.lost) { clearTimeout(peer.lost); peer.lost = null }
      let pair: PairGrant | undefined
      if (peer.lan) {
        // The code is used up: the next connection needs a fresh nonce and offer.
        this.lan = null
        peer.lan.pair.at = Date.now()
        peer.lan.pair.peerName = peer.name
        void putPair(peer.lan.pair)
      } else {
        pair = this.rememberDevice(peer, peer.name) ?? undefined
      }
      this.send(peer, { t: 'welcome', proto: PROTO, name: this.opts.appName, layout: this.layout, ...(pair ? { pair } : {}) })
      // A shared scene's settings so far, and this participant's colour (a device wears it as its accent).
      if (this.shared) this.send(peer, { t: 'state', values: { ...this.values, color: peer.color } })
      const first = this.status !== 'connected'
      this.setStatus('connected')
      if (first || !this.shared) this.emit('connect', { name: peer.name, caps: m.caps })
      this.emit('join', this.participant(peer))
      this.renderCards()
      this.sceneChanged()
      void this.prepareLan()
      return
    }
    if (!this.listening(peer)) return
    const who = this.participant(peer)
    switch (m.t) {
      case 'btn': this.emit('button', { id: m.id, ev: m.ev }, who); break
      case 'text': {
        const del = m.del ?? 0
        if (typeof m.s === 'string' && m.s.length <= MAX_TEXT && Number.isInteger(del) && del >= 0 && del <= MAX_TEXT && (m.s || del)) this.emit('text', { s: m.s, del }, who)
        break
      }
      case 'toss':
        if (typeof m.v === 'number' && m.v > 0 && m.v <= MAX_TOSS) this.emit('toss', { v: m.v }, who)
        break
      case 'value': this.emit('value', { id: m.id, v: m.v, add: m.add === true }, who); break
      case 'mode': this.emit('mode', m.m, who); break
      case 'recenter': this.emit('recenter', who); break
      case 'claim':
        if (this.shared && (m.node === null || (typeof m.node === 'string' && m.node.length <= MAX_NODE_ID))) this.emit('claim', { node: m.node }, who)
        break
      case 'ping': this.send(peer, { t: 'pong', t0: m.t0 }); break
      case 'bye': this.dropPeer(peer.id); break
    }
  }

  private reject(peer: Peer) {
    this.send(peer, { t: 'lock', reason: 'rejected' })
    setTimeout(() => this.dropPeer(peer.id), 200)
  }

  // ---- participants -------------------------------------------------------------------------------------------

  /** Bound devices, oldest first. */
  private bound(): Peer[] {
    return [...this.peers.values()].filter((p) => p.bound).sort((a, b) => a.since - b.since)
  }

  private participant(p: Peer): Participant {
    return { id: p.id, name: p.name, color: p.color, lead: p === this.active, since: p.since, caps: p.caps }
  }

  /** Everyone controlling the scene, oldest (the lead) first. */
  get participants(): Participant[] { return this.bound().map((p) => this.participant(p)) }

  private freeColor(peer: Peer): string {
    const used = new Set([this.host.color.toLowerCase(), ...this.bound().filter((p) => p !== peer).map((p) => p.color)])
    return PARTICIPANT_COLORS.find((c) => !used.has(c)) ?? PARTICIPANT_COLORS[used.size % PARTICIPANT_COLORS.length]
  }

  /** The peers a message for `who` goes to: that participant, else everyone in a shared scene, else the device in control. */
  private targets(who?: string): Peer[] {
    if (who) { const p = this.peers.get(who); return p?.bound ? [p] : [] }
    return this.shared ? this.bound() : this.active ? [this.active] : []
  }

  // ---- input --------------------------------------------------------------------------------------------------

  /** Latest controller state while the device in control (the lead) is in gamepad mode (null otherwise). */
  get pad(): PadState | null { return this.active?.stream.pad ?? null }
  /** Where the device in control (the lead) points (PROTOCOL §6) while a pointing utility is on, else null. */
  get pointer(): PointerState | null { return this.active?.stream.pointer ?? null }

  /** Read the device in control's (the lead's) input for this frame. Call once per rendered frame. */
  consume(now = performance.now()): Frame {
    return (this.active?.stream ?? this.idle).consume(now, this.status === 'connected')
  }

  /** One participant's gamepad state, pointer and frame (shared scenes). */
  padOf(who: string): PadState | null { const p = this.peers.get(who); return p?.bound ? p.stream.pad : null }
  pointerOf(who: string): PointerState | null { const p = this.peers.get(who); return p?.bound ? p.stream.pointer : null }
  consumeOf(who: string, now = performance.now()): Frame {
    const p = this.peers.get(who)
    return (p?.bound ? p.stream : this.idle).consume(now, !!p?.bound)
  }

  // ---- output -------------------------------------------------------------------------------------------------

  /** Vibrate a device (Gamepad API dual-rumble semantics): `who`, else the device in control. */
  rumble(strong: number, weak: number, ms: number, who?: string) {
    const p = who ? this.peers.get(who) : this.active
    if (p?.bound) this.send(p, { t: 'rumble', strong, weak, ms })
  }

  /** The tray and modes: for `who`, else for everyone. */
  setLayout(layout: Layout, who?: string) {
    if (!who) this.layout = layout
    for (const p of this.targets(who)) this.send(p, { t: 'layout', layout })
  }

  /** Sync toggle/label state shown on devices: for `who`, else for everyone. */
  setValues(values: Record<string, number | boolean | string>, who?: string) {
    if (!who) Object.assign(this.values, values)
    for (const p of this.targets(who)) this.send(p, { t: 'state', values })
  }

  /** A haptic tick or bump and an optional toast: for `who`, else for the device in control. */
  feedback(f: { haptic?: 'tick' | 'bump'; toast?: string }, who?: string) {
    const p = who ? this.peers.get(who) : this.active
    if (p?.bound) this.send(p, { t: 'feedback', ...f })
  }

  // ---- shared scene -------------------------------------------------------------------------------------------

  /** How the screen appears among the participants (CATALOGUE §5: the screen is participant `host`). */
  setHostPerson(p: { name?: string; color?: string }) {
    this.host = { ...this.host, ...p, id: 'host' }
    this.sceneChanged()
  }

  /**
   * Publish the scene: what can be claimed (omit `nodes` to keep the last list) and who holds what (node id ->
   * participant id, `host` for the screen). Every participant receives it.
   */
  setScene(s: { nodes?: SceneNode[]; held: Record<string, string> }) {
    if (s.nodes) { this.nodes = s.nodes.map((n) => ({ ...n, id: n.id.slice(0, MAX_NODE_ID), ...(n.parent ? { parent: n.parent.slice(0, MAX_NODE_ID) } : {}) })); this.nodesVersion++ }
    this.held = { ...s.held }
    this.sceneChanged()
  }

  private sceneChanged() {
    if (!this.shared || this.scenePending) return
    this.scenePending = true
    queueMicrotask(() => {
      this.scenePending = false
      const people: ScenePerson[] = [this.host, ...this.bound().map((p) => ({ id: p.id, name: p.name, color: p.color, ...(p === this.active ? { lead: true } : {}) }))]
      for (const p of this.bound()) {
        const m: HostMsg = { t: 'scene', you: p.id, people, held: this.held }
        if (p.nodesSent !== this.nodesVersion) { m.nodes = this.nodes; p.nodesSent = this.nodesVersion }
        this.send(p, m)
      }
    })
  }

  /** Disconnect a participant (it can't rejoin by itself; a new invite keeps it out), or with no `who` everyone. */
  disconnect(who?: string) {
    const list = who ? this.targets(who) : this.bound()
    for (const p of list) {
      this.send(p, { t: 'lock', reason: who ? 'removed' : 'host-closed' })
      setTimeout(() => this.dropPeer(p.id), 200)
    }
  }

  destroy() {
    this.lan = null
    for (const id of [...this.peers.keys()]) this.dropPeer(id)
    this.sig?.close()
    for (const c of this.cards) c.el.remove()
    this.cards = []
  }

  private send(peer: Peer, m: HostMsg) {
    if (peer.ctl.readyState === 'open') peer.ctl.send(JSON.stringify(m))
  }

  private scheduleLost(peer: Peer) {
    if (peer.lost) return
    peer.lost = setTimeout(() => {
      peer.lost = null
      if (peer.pc.connectionState !== 'connected') this.dropPeer(peer.id)
    }, 4000)
  }

  private dropPeer(id: string) {
    const p = this.peers.get(id)
    if (!p) return
    this.peers.delete(id)
    if (p.lost) { clearTimeout(p.lost); p.lost = null }
    if (this.lan?.peer === p) this.lan = null
    try { p.pc.close() } catch { /* closed */ }
    if (!p.bound) return
    const who = this.participant(p)
    p.bound = false
    // What it held is free again.
    for (const [node, holder] of Object.entries(this.held)) if (holder === id) delete this.held[node]
    if (this.active === p) this.active = this.shared ? this.bound()[0] ?? null : null
    this.deviceName = this.active?.name ?? null
    this.emit('leave', who)
    this.renderCards()
    if (!this.bound().length) {
      this.setStatus(this.sig?.open ? 'ready' : 'offline')
      this.emit('disconnect')
    }
    this.sceneChanged()
  }

  // ---- pairing card -------------------------------------------------------------------------------------------

  /**
   * Render the pairing card into an element. 'full' shows numbered steps; 'compact' is visual-first:
   * the QR code, a one-line call to action and a live status dot.
   */
  mountPairing(el: HTMLElement, opts: { title?: string; testLink?: boolean; variant?: 'full' | 'compact' } = {}) {
    injectStyles()
    const compact = opts.variant === 'compact'
    const card = document.createElement('div')
    card.className = compact ? 'obpal-card obpal-compact' : 'obpal-card'
    const phone = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.8" width="10" height="18.4" rx="2.8"/><path d="M10.5 18h3"/></svg>'
    const open = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4"/></svg>'
    card.innerHTML = `
      <div class="obpal-qr" role="img" aria-label="QR code to pair your phone"></div>
      <div class="obpal-body">
        <div class="obpal-title">${compact ? `<span class="obpal-ic">${phone}</span>` : ''}<span class="obpal-title-text"></span></div>
        ${compact ? '' : '<ol class="obpal-steps"><li>Open your phone’s camera</li><li>Point it at this code</li><li>Tap <b>Start</b> on your phone</li></ol>'}
        <div class="obpal-status" aria-live="polite"></div>
        ${opts.testLink === false ? '' : `<a class="obpal-link" target="_blank" rel="noopener" title="Open the controller on this device">${compact ? `${open}<span>This device</span>` : 'Open the controller on this device'}</a>`}
      </div>`
    card.querySelector('.obpal-title-text')!.textContent = opts.title ?? (compact ? 'Scan to control' : 'Use your phone as a remote')
    el.appendChild(card)
    const entry = { el: card, status: card.querySelector<HTMLElement>('.obpal-status')!, qr: card.querySelector<HTMLElement>('.obpal-qr')!, link: card.querySelector<HTMLAnchorElement>('.obpal-link'), compact }
    this.cards.push(entry)
    this.renderQr(entry)
    this.renderCards()
    return card
  }

  private renderQr(c: { qr: HTMLElement; link: HTMLAnchorElement | null }) {
    const url = this.pairingUrl
    if (c.link) c.link.href = url
    void import('uqr').then(({ renderSVG }) => { if (url === this.pairingUrl) c.qr.innerHTML = renderSVG(url, { border: 2, ecc: 'M' }) })
  }

  private renderCards() {
    const n = this.bound().length
    const text: Record<HostStatus, string> = {
      starting: 'Starting…',
      ready: 'Waiting for your phone',
      connecting: 'Phone found, connecting…',
      connected: n > 1 ? `${n} devices connected` : `Connected${this.deviceName ? ` to ${this.deviceName}` : ''}`,
      offline: 'Offline, retrying…',
    }
    const short: Record<HostStatus, string> = { starting: 'Starting', ready: 'Waiting', connecting: 'Connecting', connected: n > 1 ? `${n} connected` : 'Connected', offline: 'Offline' }
    for (const c of this.cards) {
      c.status.textContent = (c.compact ? short : text)[this.status]
      c.status.dataset.s = this.status
    }
  }
}

let styled = false
function injectStyles() {
  if (styled || typeof document === 'undefined') return
  styled = true
  const s = document.createElement('style')
  s.id = 'obpal-style'
  s.textContent = `
.obpal-card{--_bg:var(--obpal-bg,rgb(var(--surface-rgb, 13 20 33) / .82));--_ink:var(--obpal-ink,#e6edf7);--_muted:var(--obpal-muted,#a3b1c5);--_line:var(--obpal-line,#293548);--_accent:var(--obpal-accent,#a78bfa);
 display:flex;gap:20px;align-items:center;padding:18px;border-radius:22px;background:var(--_bg);color:var(--_ink);border:1px solid var(--_line);
 backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);font:15px/1.5 var(--obpal-font,'Plus Jakarta Sans',system-ui,sans-serif);box-shadow:0 24px 60px rgba(0,0,0,.35)}
.obpal-qr{flex:none;width:168px;height:168px;background:#fff;border-radius:14px;padding:6px;box-sizing:border-box}
.obpal-qr svg{width:100%;height:100%;display:block}
.obpal-title{font-weight:700;font-size:18px;letter-spacing:-.02em;margin-bottom:6px}
.obpal-steps{margin:0 0 10px;padding-left:20px;color:var(--_muted)}
.obpal-title-text{white-space:nowrap}
.obpal-steps b{color:var(--_ink)}
.obpal-status{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.obpal-status::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--_muted)}
.obpal-status[data-s=ready]::before{background:var(--_accent);animation:obpal-pulse 1.6s ease-in-out infinite}
.obpal-status[data-s=connecting]::before{background:#fcd34d}
.obpal-status[data-s=connected]::before{background:#6ee7b7}
.obpal-status[data-s=offline]::before{background:#fb7185}
.obpal-link{display:inline-block;margin-top:10px;font-size:13px;color:var(--_muted)}
.obpal-link:hover{color:var(--_ink)}
@keyframes obpal-pulse{50%{opacity:.35}}
.obpal-compact{gap:16px;padding:14px;border-radius:24px;background:var(--obpal-bg,linear-gradient(145deg,rgb(255 255 255 / .1),rgb(255 255 255 / .035)));border:1px solid var(--obpal-line,rgb(255 255 255 / .13));
 backdrop-filter:blur(22px) saturate(170%);-webkit-backdrop-filter:blur(22px) saturate(170%);box-shadow:0 18px 50px rgba(0,0,0,.34),inset 0 1px 0 rgb(255 255 255 / .14)}
.obpal-compact .obpal-qr{width:124px;height:124px;border-radius:16px;padding:5px}
.obpal-compact .obpal-body{display:flex;flex-direction:column;gap:10px;min-width:150px}
.obpal-compact .obpal-title{display:flex;align-items:center;gap:10px;margin:0;font-size:16px}
.obpal-ic{display:grid;place-items:center;width:34px;height:34px;border-radius:11px;background:linear-gradient(145deg,rgb(var(--accent-rgb, 167 139 250) / .35),rgb(var(--accent2-rgb, 103 232 249) / .15));border:1px solid rgb(255 255 255 / .14)}
.obpal-ic svg,.obpal-compact .obpal-link svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.obpal-compact .obpal-status{font-size:13px;color:var(--_muted)}
.obpal-compact .obpal-link{display:inline-flex;align-items:center;gap:6px;margin:0;font-size:12px;font-weight:600;text-decoration:none;opacity:.8}
.obpal-compact .obpal-link:hover{opacity:1}
@media (max-width:520px){.obpal-card{flex-direction:column;text-align:center}.obpal-steps{text-align:left}}
@media (prefers-reduced-motion:reduce){.obpal-status::before{animation:none!important}}`
  document.head.appendChild(s)
}
