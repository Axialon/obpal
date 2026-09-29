import {
  b64url, bindMac, candidatesOf, certFingerprint, controllerOf, CONTROLLERS, DEFAULT_SERVICE, encodeLanPairing, encodePairing, equalBytes,
  fetchIce, forgetPair, ICE_REFRESH_BEFORE_MS, iceRefreshIn, fromB64url, importPairKey, isControllerId, lanAnswerSdp, lanContext, lanIceCredentials, linkInfo, listPairs, loadCertificate, MAX_NODE_ID, MAX_TEXT, MAX_TOSS, Mode, newSecret, PAD_HEADER,
  packetType, BODY_HEADER, HAND_HEADER, POINTER_HEADER, POSE_HEADER, PROTO, putPair, randomBytes, REACH_TIMEOUT_MS, readLocalIce, readMode, roomIdFor, roomSocketUrl, sdpFingerprint, sdpSession, SignalClient,
  withControllers,
  type Caps, type DeviceMsg, type HostMsg, type Layout, type ModeId, type PadState, type PairGrant, type PointerState, type SceneNode,
  type ScenePerson, type SignalIn, type SignalPayload, type StoredPair, type IceSet, type LinkInfo, type VerifiedBy, type ScreenKind,
} from '@obpal/core'
import { CODE_SECRET_DIGITS, CodePake, isCodeHandle, randomDigits, solveWork } from '@obpal/core'
import { Stream, type Frame } from './stream'
import { validSimMessage, type SimMessage } from '@obpal/core'

export type { Frame } from './stream'

export type HostStatus = 'starting' | 'ready' | 'connecting' | 'connected' | 'offline'

export interface RemoteOptions {
  /** Shown on the phone ("Controlling <appName>"). */
  appName: string
  /** A label for the phone's local connection list. This describes the screen, never its permissions. */
  kind?: ScreenKind
  /** Room service origin. Defaults to this origin on ob-pal hosts, else the public service. */
  service?: string
  /**
   * Tray buttons and modes offered to the phone. `controllers` names catalogue controllers (`face.wii`, …) instead of or
   * beside `modes`; phones that predate them get the matching modes (withControllers in @obpal/core).
   */
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
  /**
   * Offer a short code beside the QR code (PROTOCOL §2b), while something shows it (wantCode, or a PairingChip).
   * Default true.
   */
  shortCode?: boolean
  /**
   * Move the invite on each time a device pairs through it (the QR code, its link, or a short code): a new secret, and
   * so a new room, link, QR code and short code. A photo of the old code or a replayed link then pairs nothing. The
   * room a device paired in is kept for it (and only it): through it the device reloads and finds new paths
   * (PROTOCOL §2). Default false.
   */
  rotateInvite?: boolean
}

/**
 * A room this host has moved its invite on from (rotateInvite), kept for the devices that paired in it: their pages
 * reload with its code, and their ICE restarts come through it. It takes offers from those devices alone.
 */
interface KeptRoom {
  secret: Uint8Array
  roomId: string
  sig: SignalClient
  /** The DTLS fingerprints (base64url) of the devices that paired in this room: the only offers it takes. */
  fps: Set<string>
}

/** At most this many kept rooms: past it, the oldest nobody is connected through goes. */
const MAX_KEPT_ROOMS = 8

/** A device's hello when it joins by short code. */
type CodeHello = Extract<DeviceMsg, { t: 'hello'; code: string }>

/**
 * A device in the scene (CATALOGUE §5). The lead is the oldest; while it holds nothing it drives the shared view.
 * `controller`: the catalogue controller it uses now (CATALOGUE §9.1), as it says in `mode{c}` or, from a device that
 * doesn't say, as its mode implies; `profile`: the profile it applies, where it says (`mode{p}`).
 * Who it is, for a host that keeps something per device (ob.Pal Link's answer to "may this phone control the PC"):
 * `pair`, the id of the pairing this host remembers it by (remember: true), and `fp`, its DTLS certificate's
 * fingerprint (base64url), which it proved when it connected.
 */
export interface Participant {
  id: string; name: string; color: string; lead: boolean; since: number; caps: Caps | null
  controller?: string; profile?: string
  pair?: string; fp?: string
  paused?: boolean
}

/** A connected device's link (Remote.links): who, how it proved itself, and what its connection says of itself. */
export interface DeviceLinkInfo { id: string; name: string; verified: VerifiedBy; link: LinkInfo }

/** A remembered phone, as shown to people (no key material). */
export interface PairSummary { id: string; name: string; at: number }

/** Connection timeline for diagnostics and benches (epoch ms; 0 when it hasn't happened). */
export interface LinkDiag { status: HostStatus; connectedAt: number; firstInputAt: number; direct: boolean }

interface RemoteEvents {
  /** A phone paused or resumed this connection. Says nothing about any other screen. */
  attention: (who: Participant) => void
  sim: (message: SimMessage, who: Participant) => void
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
  /** The short code changed (see `code`; empty when there's none). */
  code: () => void
  /** A new invite (resetInvite, or a pairing with rotateInvite): the pairing link and the QR code changed. */
  invite: () => void
}

interface Peer {
  paused?: boolean
  id: string
  /** The signaling socket it talks through: its first, or a new one after its phone's socket was lost and came back. */
  sig: string
  /** The kept room that socket is in (rotateInvite), or none: the current invite's room. */
  room?: KeptRoom
  /** The id of the pairing this host remembers it by, once it's bound (remember: true). */
  pair?: string
  /** Its offer's SDP session (sdpSession): a later offer in the same session renegotiates this connection. */
  session: string | null
  /** An ICE restart's offer is being applied: its candidates wait until it has. */
  renegotiating: boolean
  /** How it proved itself when it bound: the QR code's secret, the typed code's exchange, or a remembered pairing. */
  via?: VerifiedBy
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
  /** What it uses (Participant.controller and .profile); `says` once it has named its controller itself. */
  controller?: string
  profile?: string
  says: boolean
}

/**
 * The room service as an origin: https, or http only on this machine (localhost, 127.0.0.1, [::1]). It becomes the
 * pairing link, the QR code and the chip's link, so anything else (a javascript: or data: URL) is refused.
 */
export function serviceOrigin(service: string): string {
  let u: URL | null = null
  try { u = new URL(service) } catch { /* not a URL */ }
  const local = !!u && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (!u || !(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new Error(`ob.Pal: the service must be an https URL, not "${service}"`)
  return u.origin
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
  /** What the last lookup that counted gave: TURN or not, and when its credentials lapse. */
  private iceSet: IceSet | null = null
  /** The next ICE server lookup (refreshIce). */
  private iceTimer: ReturnType<typeof setTimeout> | null = null
  /** The first lookup is done (iceFirst settles then): answers carry the service's ICE servers, TURN included. */
  private iceLoaded = false
  private iceFirst: Promise<void>
  private iceFirstDone: () => void = () => {}
  /** Candidates for offers still waiting for the first ICE servers, by signaling id. */
  private early = new Map<string, RTCIceCandidateInit[]>()
  private destroyed = false
  private sig!: SignalClient
  /** Rooms the invite has moved on from, oldest first, each kept for the devices that paired in it (rotateInvite). */
  private kept: KeptRoom[] = []
  /** The invite moves on one pairing at a time. */
  private moving: Promise<void> = Promise.resolve()
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
    status: [], connect: [], disconnect: [], join: [], leave: [], button: [], text: [], toss: [], value: [], mode: [], recenter: [], pad: [], input: [], claim: [], lan: [], code: [], invite: [], sim: [], attention: [],
  }
  private cards: { el: HTMLElement; status: HTMLElement; qr: HTMLElement; link: HTMLAnchorElement | null; compact: boolean }[] = []
  /** The short code on show (PROTOCOL §2b): the room service's handle, this host's secret, and when it lapses. */
  private shortCode: { handle: string; secret: string; exp: number } | null = null
  /** Codes a device just looked up, each kept for that device's one attempt (with the ticket the service gave it). */
  private spentCodes = new Map<string, { secret: string; ticket: string; until: number }>()
  /** Codes taken off the screen in the last minute: a lookup made just before still gets its attempt. */
  private recentCodes = new Map<string, { secret: string; until: number }>()
  /** How many things show the code now. */
  private codeWant = 0
  /** The next ask (renewal, or a retry), and the wait for the service's answer to the last one. */
  private codeTimer: ReturnType<typeof setTimeout> | null = null
  private codeWait: ReturnType<typeof setTimeout> | null = null
  /** Seconds before asking again after a refusal or no answer: doubles each time, to 5 minutes; 0 after a code. */
  private codeBackoff = 0
  /** A proof of work is being found for the service. */
  private codeSolving = false
  /** Peers part-way through the short-code exchange: their hello, and the confirmation they owe. */
  private codeBinds = new Map<Peer, { hello: CodeHello; theirs: string }>()

  private constructor(private opts: RemoteOptions) {
    this.service = serviceOrigin(opts.service ?? (isObpalOrigin() ? location.origin : DEFAULT_SERVICE))
    this.layout = withControllers(opts.layout ?? DEFAULT_LAYOUT)
    this.iceFirst = new Promise((r) => { this.iceFirstDone = r })
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
    this.refreshIce()
    void this.prepareLan()
  }

  /** Join the signaling room of the current secret: the invite the pairing code carries. */
  private async openRoom() {
    this.roomId = await roomIdFor(this.secret)
    this.joinRoom()
  }

  /** The current invite's room (its secret and room id are set): the pairing link, and this host's socket there. */
  private joinRoom() {
    this.pairingUrl = `${this.service}/p/#${encodePairing({ secret: this.secret, fp: this.fp })}`
    this.sig = new SignalClient(roomSocketUrl(this.service, this.roomId, 'host'))
    this.sig.onmessage = (m) => this.onSignal(m)
    // Unreachable within the connect budget counts as offline at once: the direct code takes over on the popup.
    this.sig.onstatus = (open) => {
      if (open && this.status !== 'connected') this.setStatus('ready')
      if (!open && this.status !== 'connected') this.setStatus('offline')
      // The service forgets a code when this socket goes; a new socket asks again.
      if (open) this.askCode()
      else this.setCode(null)
    }
    this.sig.connect()
  }

  /**
   * Fetch ICE servers, and again before their TURN credentials lapse: a relay drops an allocation whose credentials
   * have run out, and a host can stay open for days (ob.Pal Link's lives as long as the browser). They're asked for
   * with the current invite's room, since TURN is only minted for rooms with a live host (so the first fetch waits
   * until this host has joined). The credentials name no room: they serve every room this host is in.
   */
  private refreshIce(delay = 400) {
    if (this.iceTimer) clearTimeout(this.iceTimer)
    this.iceTimer = setTimeout(async () => {
      this.iceTimer = null
      const set = await fetchIce(this.service, this.roomId)
      if (this.destroyed) return
      // An answer without TURN (a room this host has only just joined isn't live yet, or the lookup failed) leaves
      // credentials that still hold where they are, and asks again in a minute.
      const held = this.iceSet?.turn && !set.turn && (this.iceSet.expires ?? 0) - Date.now() > ICE_REFRESH_BEFORE_MS
      if (!held) {
        this.iceSet = set
        this.ice = set.servers
      }
      this.iceLoaded = true
      this.iceFirstDone()
      this.refreshIce(held ? 60_000 : iceRefreshIn(set))
    }, delay)
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
    for (const p of [...this.peers.values()]) if (!p.bound && !p.lan && !p.room) this.dropPeer(p.id)
    this.setCode(null)
    this.spentCodes.clear()
    await this.openRoom()
    for (const c of this.cards) this.renderQr(c)
    this.emit('invite')
    this.renderCards()
  }

  /**
   * The invite moves on once a device has paired through it (rotateInvite, spec/SECURITY.md §8, L2). The room it
   * paired in is kept for it: the phone's page reloads with that room's code, and its ICE restarts come through it,
   * but the room takes offers from no one else, so a photo of the old code or a replayed link pairs nothing. A device
   * still on its way in through the old room scans the new code. A new secret makes the new room, link, QR code and
   * short code. `from` is the socket the device paired through: if the invite has moved on since, there's nothing to do.
   */
  private moveInvite(by: Peer, from: SignalClient) {
    this.moving = this.moving.then(async () => {
      if (by.room || this.sig !== from || this.destroyed) return
      const secret = newSecret()
      const roomId = await roomIdFor(secret)
      if (by.room || this.sig !== from || this.destroyed) return
      const kept: KeptRoom = { secret: this.secret, roomId: this.roomId, sig: from, fps: new Set() }
      // Whoever paired here keeps the room (the device that moved the invite, even if it has gone already).
      for (const p of [by, ...this.peers.values()]) {
        if (p.lan || p.room) continue
        if (p.bound || p === by) {
          p.room = kept
          if (p.fp) kept.fps.add(b64url(p.fp))
        } else this.dropPeer(p.id)
      }
      // A device that paired here is done with the room it paired in before: its page keeps the latest code it used.
      for (const r of this.kept) for (const fp of kept.fps) r.fps.delete(fp)
      // The service forgets this room's short code; the new room gets one of its own.
      if (this.shortCode) from.send({ t: 'code', op: 'drop' })
      this.setCode(null)
      this.spentCodes.clear()
      from.onmessage = (m) => this.onSignal(m, kept)
      // What the screen says (ready, offline) follows the current invite's room alone.
      from.onstatus = () => {}
      this.kept.push(kept)
      this.pruneKept()
      this.secret = secret
      this.roomId = roomId
      this.joinRoom()
      for (const c of this.cards) this.renderQr(c)
      this.emit('invite')
      this.renderCards()
    }).catch(() => {})
  }

  /**
   * Close the kept rooms nobody needs: those no device may use any more (each paired again elsewhere, or was
   * forgotten) with nobody connected through them, and past MAX_KEPT_ROOMS the oldest that nobody is connected through.
   */
  private pruneKept() {
    const used = (r: KeptRoom) => [...this.peers.values()].some((p) => p.room === r)
    const close = (r: KeptRoom) => {
      this.kept = this.kept.filter((k) => k !== r)
      r.sig.onmessage = () => {}
      r.sig.close()
    }
    for (const r of [...this.kept]) if (!r.fps.size && !used(r)) close(r)
    for (const r of [...this.kept]) {
      if (this.kept.length <= MAX_KEPT_ROOMS) break
      if (!used(r)) close(r)
    }
  }

  on<K extends keyof RemoteEvents>(ev: K, fn: RemoteEvents[K]) { this.handlers[ev].push(fn); return this }
  off<K extends keyof RemoteEvents>(ev: K, fn: RemoteEvents[K]) { const l = this.handlers[ev]; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); return this }
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

  /**
   * Forget a remembered phone: it can only pair online again, and only through the invite on the screen now (the room
   * it paired in, if it was kept for it, takes it no more).
   */
  async forget(id: string) {
    const gone = this.pairs.find((p) => p.id === id)
    this.pairs = this.pairs.filter((p) => p.id !== id)
    if (gone) {
      for (const r of this.kept) r.fps.delete(b64url(gone.peerFp))
      this.pruneKept()
    }
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

  /**
   * After an online pairing: a (new) key for this phone, handed to it in `welcome` (the one time its bytes travel) and
   * kept here only as `minted.key`, the non-extractable key made from them (mintKey). Stored in the background.
   */
  private rememberDevice(peer: Peer, name: string, minted: { raw: Uint8Array; key: CryptoKey } | null): PairGrant | null {
    if (!this.opts.remember || !peer.fp || !minted) return null
    const existing = this.pairs.find((p) => equalBytes(p.peerFp, peer.fp!))
    const rec: StoredPair = { id: existing?.id ?? b64url(randomBytes(16)), key: minted.key, peerFp: peer.fp, peerName: name, at: Date.now() }
    this.pairs = [rec, ...this.pairs.filter((p) => p.id !== rec.id)]
    void putPair(rec).then(() => this.emit('lan'))
    const grant = { id: rec.id, key: b64url(minted.raw) }
    minted.raw.fill(0)
    return grant
  }

  /** A pairing key: 32 random bytes for the grant, and the non-extractable key this host keeps (importPairKey). */
  private async mintKey(): Promise<{ raw: Uint8Array; key: CryptoKey }> {
    const raw = randomBytes(32)
    return { raw, key: await importPairKey(raw) }
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
    // A code asked for before destroy() waits its turn; by then there's nothing to make one for.
    if (!this.opts.remember || this.destroyed) return
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

  /** A message from the room service: in the current invite's room, or in a kept one (`room`). */
  private onSignal(m: SignalIn, room?: KeptRoom) {
    if (m.t === 'peer' && m.ev === 'leave') this.peerLeft(m.id, m.clean !== false, room)
    if (m.t === 'sig') void this.onPayload(m.from, m.d, room)
    // Short codes belong to the current invite's room.
    if (m.t === 'code' && !room) this.onCode(m)
  }

  /** The socket that talks to a peer: its kept room's, or the current invite's. */
  private sigOf(peer: Peer): SignalClient { return peer.room?.sig ?? this.sig }

  /**
   * A device's signaling socket went. A device that closed it (`clean`: it left or reloaded), or one still connecting,
   * goes with it. A bound device whose socket was lost stays while its connection lives, since that doesn't run
   * through the room service (and a phone that changes networks loses its socket first): it goes only if the
   * connection fails too (scheduleLost). A service that doesn't say which counts as clean.
   */
  private peerLeft(sig: string, clean: boolean, room?: KeptRoom) {
    if (!room) this.early.delete(sig)
    const p = this.bySig(sig, room)
    if (!p) return
    const s = p.pc.connectionState
    if (clean || !p.bound || s === 'closed' || s === 'failed') return this.dropPeer(p.id)
    if (s !== 'connected') this.scheduleLost(p)
  }

  /** One peer connection with the two pre-negotiated channels, wired into this host. */
  private addPeer(id: string, pc: RTCPeerConnection, fp: Uint8Array | null): Peer {
    const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0 })
    const st = pc.createDataChannel('st', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
    st.binaryType = 'arraybuffer'
    const peer: Peer = {
      id, sig: id, session: null, renegotiating: false,
      pc, ctl, st, fp, bound: false, name: 'Phone', cands: [], color: this.host.color, since: 0, caps: null, lost: null, nodesSent: -1, says: false,
      stream: new Stream({
        mode: (m) => {
          // The packets can bring a new mode before the mode message naming the controller: until it comes, the
          // controller that mode stands for (a device that never names one keeps being read that way).
          const said = peer.says && peer.controller && isControllerId(peer.controller) ? CONTROLLERS[peer.controller] : null
          if (!said?.modes.includes(m)) peer.controller = controllerOf(m, this.layout) ?? undefined
          this.emit('mode', m, this.participant(peer))
        },
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
      if (!this.listening(peer) || peer.paused || !(e.data instanceof ArrayBuffer)) return
      const type = packetType(e.data)
      if (type === PAD_HEADER) peer.stream.onPad(e.data)
      else if (type === POINTER_HEADER) peer.stream.onPointer(e.data)
      else if (type === POSE_HEADER) peer.stream.onPose(e.data)
      else if (type === HAND_HEADER) peer.stream.onHand(e.data)
      else if (type === BODY_HEADER) peer.stream.onBody(e.data)
      else peer.stream.onState(e.data)
    }
    return peer
  }

  /** Whether a bound device's input counts: every participant in a shared scene, only the device in control otherwise. */
  private listening(peer: Peer) { return peer.bound && (this.shared || this.active === peer) }

  private async onPayload(id: string, d: SignalPayload, room?: KeptRoom) {
    const sig = room?.sig ?? this.sig
    if ('offer' in d) {
      // The same connection again (its phone changed networks): renegotiate it, and keep everything else. A restart
      // for a connection this host no longer has can't be taken up: the phone builds a new one at once.
      const again = this.sameConnection(d.offer?.sdp, room)
      if (again) return this.renegotiate(again, id, d.offer)
      if (d.restart) { sig.send({ t: 'sig', to: id, d: { gone: true } }); return }
      const old = this.bySig(id, room)
      if (old) this.dropPeer(old.id)
      // An offer that doesn't commit to exactly one fingerprint (the one DTLS will check) could never bind: no answer.
      const fp = sdpFingerprint(d.offer?.sdp)
      if (!fp) return
      // A kept room takes the devices that paired in it, and nobody else: its code has been used.
      if (room && !room.fps.has(b64url(fp))) { sig.send({ t: 'sig', to: id, d: { spent: true } }); return }
      if (this.status !== 'connected') this.setStatus('connecting')
      // An offer in this host's first moments may come before its ICE servers: a moment for them, so the answer
      // carries a relay where one is needed (its candidates wait meanwhile). A newer offer from the same socket wins.
      const early: RTCIceCandidateInit[] = []
      if (!this.iceLoaded && !room) {
        this.early.set(id, early)
        await Promise.race([this.iceFirst, new Promise((r) => setTimeout(r, REACH_TIMEOUT_MS))])
        if (this.early.get(id) !== early) return
        this.early.delete(id)
      }
      const pc = new RTCPeerConnection({ iceServers: this.ice, certificates: [this.cert] })
      const peer = this.addPeer(id, pc, fp)
      peer.room = room
      peer.session = sdpSession(d.offer.sdp)
      peer.cands.push(...early)
      pc.onicecandidate = (e) => { this.sigOf(peer).send({ t: 'sig', to: peer.sig, d: { cand: e.candidate?.toJSON() ?? { candidate: '' } } }) }
      await pc.setRemoteDescription(d.offer)
      for (const c of peer.cands.splice(0)) await pc.addIceCandidate(c).catch(() => {})
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.sigOf(peer).send({ t: 'sig', to: id, d: { answer: pc.localDescription!.toJSON() } })
    } else if ('cand' in d) {
      const peer = this.bySig(id, room)
      if (!peer) { if (!room) this.early.get(id)?.push(d.cand); return }
      if (peer.pc.remoteDescription && !peer.renegotiating) await peer.pc.addIceCandidate(d.cand).catch(() => {})
      else peer.cands.push(d.cand)
    }
  }

  /** The peer that talks through signaling socket `sig`, in the current invite's room or the kept room `room`. */
  private bySig(sig: string, room?: KeptRoom): Peer | undefined {
    for (const p of this.peers.values()) if (p.sig === sig && p.room === room) return p
    return undefined
  }

  /**
   * The bound peer an offer renegotiates, if it does: the same DTLS fingerprint and the same SDP session (a connection
   * keeps its session through all its offers; a new one starts another), on a connection that isn't closed, through
   * the room it talks through. Anyone else's offer, or a phone's new connection, is a new peer.
   */
  private sameConnection(sdp: string | undefined, room?: KeptRoom): Peer | null {
    const fp = sdpFingerprint(sdp)
    const session = sdpSession(sdp)
    if (!fp || !session) return null
    for (const p of this.peers.values()) {
      if (p.bound && !p.lan && p.room === room && p.fp && p.session === session && equalBytes(p.fp, fp) && p.pc.connectionState !== 'closed') return p
    }
    return null
  }

  /**
   * A bound phone renegotiates its connection: an ICE restart (RFC 8445 §9), after its network changed or its path went
   * quiet. The new ICE credentials and candidates go in with fresh ICE servers (a relay then has live credentials),
   * and the DTLS session, the channels and the binding stay: the phone was proven once, and DTLS still holds both
   * fingerprints. A phone whose socket was lost and came back talks through its new one from now on.
   */
  private async renegotiate(peer: Peer, sig: string, offer: RTCSessionDescriptionInit) {
    peer.sig = sig
    if (peer.lost) { clearTimeout(peer.lost); peer.lost = null }
    peer.renegotiating = true
    try {
      peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers: this.ice })
      await peer.pc.setRemoteDescription(offer)
      await peer.pc.setLocalDescription(await peer.pc.createAnswer())
      this.sigOf(peer).send({ t: 'sig', to: sig, d: { answer: peer.pc.localDescription!.toJSON() } })
    } catch {
      // Not one this connection can take: the phone builds a new one when its restart doesn't come up.
    } finally {
      peer.renegotiating = false
    }
    for (const c of peer.cands.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {})
  }

  private async onCtl(peer: Peer, data: unknown) {
    if (typeof data !== 'string') return
    if (data.length > 65536) return
    let m: DeviceMsg
    try { m = JSON.parse(data) } catch { return }
    if (!peer.bound) {
      if (m.t === 'pake' || (m.t === 'hello' && 'code' in m)) {
        // By short code: the exchange proves the code, then the device's hello goes on like a verified one. Codes
        // belong to the current invite's room: a kept room has none.
        if (peer.room) { this.reject(peer); return }
        const hello = await this.codeStep(peer, m)
        if (!hello) return
        m = hello
      } else {
        if (m.t !== 'hello' || !peer.fp) return
        // Online: the code's secret and the room (the current invite's, or the kept room the device came back through).
        // Direct: the remembered pairing key and the code's nonce.
        const room = peer.room ?? { secret: this.secret, roomId: this.roomId }
        const expected = peer.lan
          ? await bindMac(peer.lan.pair.key, peer.fp, this.fp, lanContext(peer.lan.nonce))
          : await bindMac(room.secret, peer.fp, this.fp, room.roomId)
        if (peer.lan && m.pair !== peer.lan.pair.id) { this.reject(peer); return }
        if (!equalBytes(new TextEncoder().encode(expected), new TextEncoder().encode(m.mac))) { this.reject(peer); return }
      }
      // A remembered phone's new key is made before anything about this bind changes: making it is the one wait.
      const minted = !peer.lan && this.opts.remember ? await this.mintKey() : null
      if (peer.bound || this.peers.get(peer.id) !== peer) return
      if (this.shared && this.bound().length >= this.seats) {
        this.send(peer, { t: 'lock', reason: 'full' })
        setTimeout(() => this.dropPeer(peer.id), 200)
        return
      }
      peer.bound = true
      peer.via = peer.lan ? 'lan' : 'code' in m ? 'code' : 'qr'
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
        pair = this.rememberDevice(peer, peer.name, minted) ?? undefined
      }
      peer.pair = peer.lan?.pair.id ?? pair?.id
      // A device that came by short code gets the QR link's code, to reconnect and reload with like a scanned one.
      const invite = 'code' in m ? encodePairing({ secret: this.secret, fp: this.fp }) : undefined
      // Through the room service, the phone may renegotiate this connection when its path goes (restart).
      const kind = this.opts.kind ?? (typeof location === 'undefined' ? 'site' : location.protocol === 'chrome-extension:' ? 'pc' : location.pathname.startsWith('/sim/') ? 'sim' : location.pathname.startsWith('/view/') ? 'viewer' : 'site')
      this.send(peer, { t: 'welcome', proto: PROTO, name: this.opts.appName, layout: this.layout, attention: true, kind, ...(pair ? { pair } : {}), ...(invite ? { invite } : {}), ...(peer.lan ? {} : { restart: true }) })
      // A shared scene's settings so far, and this participant's colour (a device wears it as its accent).
      if (this.shared) this.send(peer, { t: 'state', values: { ...this.values, color: peer.color } })
      // Paired through the invite: it moves on, so the code that paired this device pairs nobody else.
      if (this.opts.rotateInvite && !peer.lan && !peer.room) this.moveInvite(peer, this.sig)
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
    if (m.t === 'attention' && typeof m.active === 'boolean') {
      const paused = !m.active
      if (!!peer.paused === paused) return
      peer.paused = paused
      const hadPad = !!peer.stream.pad
      peer.stream.reset()
      if (hadPad) this.emit('pad', false, this.participant(peer))
      this.emit('attention', this.participant(peer))
      this.renderCards()
      return
    }
    if (peer.paused && m.t !== 'ping' && m.t !== 'bye') return
    const who = this.participant(peer)
    switch (m.t) {
      case 'sim': if (m.kind !== 'frame' && validSimMessage(m)) this.emit('sim', m, who); break
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
      case 'mode': {
        // What it uses (mode{c, p}); a device that doesn't say is taken to use the controller its mode stands for.
        const said = readMode(m, this.layout)
        if (said.controller === m.c) peer.says = true
        peer.controller = said.controller
        peer.profile = said.profile
        this.emit('mode', m.m, this.participant(peer))
        break
      }
      case 'recenter': this.emit('recenter', who); break
      case 'claim':
        if (this.shared && (m.node === null || (typeof m.node === 'string' && m.node.length <= MAX_NODE_ID))) this.emit('claim', { node: m.node }, who)
        break
      case 'ping': this.send(peer, { t: 'pong', t0: m.t0 }); break
      case 'bye': this.dropPeer(peer.id); break
    }
  }

  private reject(peer: Peer) {
    this.codeBinds.delete(peer)
    this.send(peer, { t: 'lock', reason: 'rejected' })
    setTimeout(() => this.dropPeer(peer.id), 200)
  }

  // ---- the short code (PROTOCOL §2b) ----------------------------------------------------------------------------

  /** The short code to type on a phone, digits only: '' while there's none (nothing shows one, or the service can't). */
  get code(): string { return this.shortCode ? this.shortCode.handle + this.shortCode.secret : '' }

  /** Where to type it: the controller's start page, without the scheme ("obpal.blackboxes.net/p"). */
  get codeSite(): string { return `${this.service.replace(/^https?:\/\//, '')}/p` }

  /** Keep a short code live while something shows it. Call the function it returns when nothing does any more. */
  wantCode(): () => void {
    if (this.opts.shortCode === false) return () => {}
    this.codeWant++
    if (this.codeWant === 1) this.askCode()
    let done = false
    return () => {
      if (done) return
      done = true
      if (--this.codeWant > 0) return
      if (this.shortCode) this.sig?.send({ t: 'code', op: 'drop' })
      this.setCode(null)
    }
  }

  /**
   * Ask the room service for a handle (it replaces this room's last one), with a proof of work when the service asked
   * for one. A service that doesn't answer (an older one, or a lost message) is asked again later, less often each time.
   */
  private askCode(work?: { c: string; x: string }) {
    if (!this.codeWant || !this.sig?.open) return
    if (this.codeTimer) { clearTimeout(this.codeTimer); this.codeTimer = null }
    if (this.codeWait) clearTimeout(this.codeWait)
    this.sig.send({ t: 'code', op: 'claim', ...(work ? { work } : {}) })
    this.codeWait = setTimeout(() => { this.codeWait = null; this.retryCode() }, 15_000)
  }

  /** Show a handle from the service with a fresh secret (null: no code), and ask again before it lapses. */
  private setCode(c: { code: string; exp: number } | null) {
    if (this.codeTimer) { clearTimeout(this.codeTimer); this.codeTimer = null }
    const had = this.code
    const now = Date.now()
    const shown = this.shortCode
    if (shown && shown.handle !== c?.code) this.recentCodes.set(shown.handle, { secret: shown.secret, until: now + 60_000 })
    for (const [h, r] of this.recentCodes) if (r.until < now) this.recentCodes.delete(h)
    this.shortCode = c && this.codeWant ? { handle: c.code, secret: randomDigits(CODE_SECRET_DIGITS), exp: c.exp } : null
    if (this.shortCode) this.codeTimer = setTimeout(() => this.askCode(), Math.max(5_000, this.shortCode.exp - now - 30_000))
    if (this.code !== had) this.emit('code')
  }

  /** Ask again later: 15 s, doubling to 5 minutes, or what the service asked for if that's longer. */
  private retryCode(seconds?: number) {
    if (this.codeTimer) clearTimeout(this.codeTimer)
    this.codeBackoff = Math.min(300, this.codeBackoff ? this.codeBackoff * 2 : 15)
    this.codeTimer = setTimeout(() => this.askCode(), Math.min(300, Math.max(seconds ?? 0, this.codeBackoff)) * 1000)
  }

  /** The service asked for a proof of work before a new code: find one, then ask again with it. */
  private async solveCode(challenge: string, bits: number) {
    if (this.codeSolving) return
    if (!(bits <= 24)) { this.retryCode(); return }
    this.codeSolving = true
    const x = await solveWork(challenge, bits)
    this.codeSolving = false
    if (x === null) this.retryCode()
    else this.askCode({ c: challenge, x })
  }

  private onCode(m: Extract<SignalIn, { t: 'code' }>) {
    const now = Date.now()
    const work = m.error === 'work' && typeof m.challenge === 'string' && typeof m.bits === 'number'
    if (m.ev === 'used') {
      // A device looked a code up: it gets that code's one attempt (a code just taken off the screen counts too).
      const cur = this.shortCode
      const secret = cur && cur.handle === m.code ? cur.secret : this.recentCodes.get(String(m.code))?.secret
      if (secret && typeof m.code === 'string' && typeof m.ticket === 'string') this.spentCodes.set(m.code, { secret, ticket: m.ticket, until: now + 60_000 })
      for (const [h, s] of this.spentCodes) if (s.until < now) this.spentCodes.delete(h)
      // Only the code on show gets replaced: a notice about an older one says nothing about what's on screen now.
      if (!cur || cur.handle !== m.code) return
      if (m.next) { this.codeBackoff = 0; this.setCode(m.next); return }
      this.setCode(null)
      if (work) void this.solveCode(m.challenge!, m.bits!)
      else this.retryCode(m.retry)
      return
    }
    if (this.codeWait) { clearTimeout(this.codeWait); this.codeWait = null }
    if (isCodeHandle(m.code) && typeof m.exp === 'number') {
      // A handle that came after nothing wanted one any more is handed straight back.
      if (!this.codeWant) { this.sig?.send({ t: 'code', op: 'drop' }); return }
      this.codeBackoff = 0
      this.setCode({ code: m.code, exp: m.exp })
    } else if (work) {
      void this.solveCode(m.challenge!, m.bits!)
    } else if (m.error) {
      // Refused (busy, or slow down): whatever code was on show may be gone at the service, so it leaves the screen.
      if (this.shortCode) this.sig?.send({ t: 'code', op: 'drop' })
      this.setCode(null)
      this.retryCode(m.retry)
    }
  }

  /**
   * The short-code exchange, host side. hello{code, ticket, pake}: the code must be one a device has just looked up,
   * shown with that lookup's ticket, and it gets that code's one attempt. pake{mac}: the device's confirmation. Returns
   * the device's hello once the code is proven.
   */
  private async codeStep(peer: Peer, m: DeviceMsg): Promise<CodeHello | null> {
    if (m.t === 'pake') {
      const b = this.codeBinds.get(peer)
      if (!b) return null
      this.codeBinds.delete(peer)
      const enc = new TextEncoder()
      if (typeof m.mac !== 'string' || !equalBytes(enc.encode(m.mac), enc.encode(b.theirs))) { this.reject(peer); return null }
      return b.hello
    }
    if (m.t !== 'hello' || !('code' in m) || !peer.fp || this.codeBinds.has(peer)) return null
    // The service's notice that the code was looked up can trail the device by a moment.
    for (let i = 0; i < 30 && !this.spentCodes.has(m.code) && this.shortCode?.handle === m.code; i++) await new Promise((r) => setTimeout(r, 100))
    const spent = this.spentCodes.get(m.code)
    if (!spent || spent.until < Date.now() || spent.ticket !== m.ticket || typeof m.pake !== 'string') { this.reject(peer); return null }
    this.spentCodes.delete(m.code)
    let share: Uint8Array
    try { share = fromB64url(m.pake) } catch { this.reject(peer); return null }
    const pake = await CodePake.start('host', { secret: spent.secret, handle: m.code, room: this.roomId })
    const macs = await pake.confirm(share, peer.fp, this.fp)
    if (!macs || !this.peers.has(peer.id)) { this.reject(peer); return null }
    this.codeBinds.set(peer, { hello: m, theirs: macs.theirs })
    this.send(peer, { t: 'pake', y: b64url(pake.share), mac: macs.mine })
    // A device that never confirms has had its attempt.
    setTimeout(() => { if (this.codeBinds.has(peer)) this.reject(peer) }, 20_000)
    return null
  }

  // ---- participants -------------------------------------------------------------------------------------------

  /** Bound devices, oldest first. */
  private bound(): Peer[] {
    return [...this.peers.values()].filter((p) => p.bound).sort((a, b) => a.since - b.since)
  }

  private participant(p: Peer): Participant {
    return {
      id: p.id, name: p.name, color: p.color, lead: p === this.active, since: p.since, caps: p.caps,
      ...(p.controller ? { controller: p.controller } : {}), ...(p.profile ? { profile: p.profile } : {}),
      ...(p.pair ? { pair: p.pair } : {}), ...(p.fp ? { fp: b64url(p.fp) } : {}),
      ...(p.paused ? { paused: true } : {}),
    }
  }

  /** Everyone controlling the scene, oldest (the lead) first. */
  get participants(): Participant[] { return this.bound().map((p) => this.participant(p)) }

  /**
   * Each connected device's link, oldest first, from the connection's own statistics: its path, ICE's round trip and
   * DTLS (linkInfo), and how the device proved itself when it bound. For a connection badge that claims only this.
   */
  async links(): Promise<DeviceLinkInfo[]> {
    return Promise.all(this.bound().map(async (p) => ({ id: p.id, name: p.name, verified: p.via ?? 'qr', link: await linkInfo(p.pc) })))
  }

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
    return (this.active?.stream ?? this.idle).consume(now, this.status === 'connected' && !this.active?.paused)
  }

  /** One participant's gamepad state, pointer and frame (shared scenes). */
  padOf(who: string): PadState | null { const p = this.peers.get(who); return p?.bound ? p.stream.pad : null }
  pointerOf(who: string): PointerState | null { const p = this.peers.get(who); return p?.bound ? p.stream.pointer : null }
  consumeOf(who: string, now = performance.now()): Frame {
    const p = this.peers.get(who)
    return (p?.bound ? p.stream : this.idle).consume(now, !!p?.bound && !p.paused)
  }

  // ---- output -------------------------------------------------------------------------------------------------

  /** Vibrate a device (Gamepad API dual-rumble semantics): `who`, else the device in control. */
  rumble(strong: number, weak: number, ms: number, who?: string) {
    const p = who ? this.peers.get(who) : this.active
    if (p?.bound) this.send(p, { t: 'rumble', strong, weak, ms })
  }

  /** The tray and modes (or controllers, filled in as withControllers does): for `who`, else for everyone. */
  setLayout(layout: Layout, who?: string) {
    const full = withControllers(layout)
    if (!who) this.layout = full
    for (const p of this.targets(who)) this.send(p, { t: 'layout', layout: full })
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
    this.destroyed = true
    if (this.iceTimer) { clearTimeout(this.iceTimer); this.iceTimer = null }
    this.lan = null
    this.codeWant = 0
    this.setCode(null)
    if (this.codeWait) { clearTimeout(this.codeWait); this.codeWait = null }
    for (const id of [...this.peers.keys()]) this.dropPeer(id)
    this.sig?.close()
    for (const r of this.kept.splice(0)) r.sig.close()
    for (const c of this.cards) c.el.remove()
    this.cards = []
  }

  private send(peer: Peer, m: HostMsg) {
    if (peer.ctl.readyState === 'open') peer.ctl.send(JSON.stringify(m))
  }

  /** Optional shared-sim state, sent only to subscribers and dropped under backpressure. */
  sendSim(m: SimMessage, who: string) {
    const p = this.peers.get(who)
    if (p?.bound && p.ctl.bufferedAmount < 65536 && validSimMessage(m)) this.send(p, m)
  }

  /**
   * A bound peer's connection went quiet or failed: it goes unless it comes back in time. A phone through the room
   * service gets longer, since it may be finding a new path (an ICE restart) after changing networks.
   */
  private scheduleLost(peer: Peer) {
    if (peer.lost) return
    peer.lost = setTimeout(() => {
      peer.lost = null
      if (peer.pc.connectionState !== 'connected') this.dropPeer(peer.id)
    }, peer.lan ? 4000 : 10_000)
  }

  private dropPeer(id: string) {
    const p = this.peers.get(id)
    if (!p) return
    this.peers.delete(id)
    if (p.lost) { clearTimeout(p.lost); p.lost = null }
    if (this.lan?.peer === p) this.lan = null
    try { p.pc.close() } catch { /* closed */ }
    // The last one through a kept room nobody may use any more: the room goes too.
    if (p.room) this.pruneKept()
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
    const node = (parent: Element, tag: string, cls: string, text = '') => {
      const el = document.createElement(tag)
      el.className = cls
      el.textContent = text
      parent.appendChild(el)
      return el
    }
    const glyph = (parent: Element, phone: boolean) => {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('aria-hidden', 'true')
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', phone ? 'M9.8 2.8h4.4A2.8 2.8 0 0 1 17 5.6v12.8a2.8 2.8 0 0 1-2.8 2.8H9.8A2.8 2.8 0 0 1 7 18.4V5.6a2.8 2.8 0 0 1 2.8-2.8ZM10.5 18h3' : 'M14 4.5h5.5V10M19.5 4.5 11 13M18 14v4a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5h4')
      svg.append(path)
      parent.append(svg)
    }
    const qr = node(card, 'div', 'obpal-qr')
    qr.setAttribute('role', 'img')
    qr.setAttribute('aria-label', 'QR code to pair your phone')
    const body = node(card, 'div', 'obpal-body')
    const title = node(body, 'div', 'obpal-title')
    if (compact) glyph(node(title, 'span', 'obpal-ic'), true)
    node(title, 'span', 'obpal-title-text')
    if (!compact) {
      const steps = node(body, 'ol', 'obpal-steps')
      node(steps, 'li', '', 'Open your phone’s camera')
      node(steps, 'li', '', 'Point it at this code')
      const tap = node(steps, 'li', '', 'Tap ')
      node(tap, 'b', '', 'Start')
      tap.append(' on your phone')
    }
    node(body, 'div', 'obpal-status').setAttribute('aria-live', 'polite')
    if (opts.testLink !== false) {
      const link = node(body, 'a', 'obpal-link')
      link.setAttribute('target', '_blank')
      link.setAttribute('rel', 'noopener')
      link.setAttribute('title', 'Open the controller on this device')
      if (compact) { glyph(link, false); node(link, 'span', '', 'This device') }
      else link.textContent = 'Open the controller on this device'
    }
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
    void import('./qr').then(({ plainQrElement }) => { if (url === this.pairingUrl) c.qr.replaceChildren(plainQrElement(url)) })
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
      c.status.textContent = this.bound().length && this.bound().every((p) => p.paused) ? 'Phone paused' : (c.compact ? short : text)[this.status]
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
