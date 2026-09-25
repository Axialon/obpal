import {
  accumDelta, bindMac, certFingerprint, decodePad, decodeState, PAD_HEADER, packetType, type PadState, DEFAULT_SERVICE, encodePairing, equalBytes,
  fetchIceServers, Flag, Mode, newSecret, PROTO, qIdentity, qSlerp, roomIdFor, roomSocketUrl,
  sdpFingerprint, seqNewer, SignalClient, Tier,
  type Caps, type DeviceMsg, type HostMsg, type Layout, type ModeId, type Quat, type SignalIn,
  type SignalPayload, type TierId, type WireState,
} from '@obpal/core'

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
}

/** Everything a host needs per rendered frame. Deltas are since the previous consume() call. */
export interface Frame {
  connected: boolean
  mode: ModeId
  tier: TierId
  /** True while the user holds the grab control; qRel is then the phone's rotation since grabbing. */
  clutch: boolean
  grab: number
  qRel: Quat
  touching: boolean
  aim: [number, number]
  /** Racing-style tilt stick in [-1, 1]: [steer (+ = right), pitch (+ = top toward the user)]. A position, not a delta. */
  tilt: [number, number]
  pad1: [number, number]
  pad2: [number, number]
  zoom: number
  twist: number
}

interface RemoteEvents {
  status: (s: HostStatus) => void
  connect: (info: { name: string; caps: Caps }) => void
  disconnect: () => void
  button: (e: { id: string; ev: string }) => void
  /** add: the phone asked to add this option alongside the current one (tray select with `add`). */
  value: (e: { id: string; v: number | boolean | string; add?: boolean }) => void
  mode: (m: ModeId) => void
  recenter: () => void
  /** A phone entered (non-null) or left (null) gamepad mode. */
  pad: (connected: boolean) => void
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
}

const isObpalOrigin = () =>
  typeof location !== 'undefined' &&
  (/(^|\.)blackboxes\.(net|dev)$/.test(location.hostname) || location.hostname === 'localhost' || location.hostname === '127.0.0.1')

export const DEFAULT_LAYOUT: Layout = { v: 1, tray: [], modes: [Mode.tilt, Mode.hold, Mode.point] }

/** Continuous (unwrapped) accumulator totals, so the host can interpolate them in time. */
interface Acc { aim: [number, number]; pad1: [number, number]; pad2: [number, number]; zoom: number; twist: number }
const zeroAcc = (): Acc => ({ aim: [0, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0, twist: 0 })
function combineAcc(a: Acc, b: Acc, k: number): Acc {
  return {
    aim: [a.aim[0] + b.aim[0] * k, a.aim[1] + b.aim[1] * k],
    pad1: [a.pad1[0] + b.pad1[0] * k, a.pad1[1] + b.pad1[1] * k],
    pad2: [a.pad2[0] + b.pad2[0] * k, a.pad2[1] + b.pad2[1] * k],
    zoom: a.zoom + b.zoom * k,
    twist: a.twist + b.twist * k,
  }
}
const lerpAcc = (a: Acc, b: Acc, t: number) => combineAcc(a, combineAcc(b, a, -1), t)

/** Host side of an ob-pal link, for any web page. */
export class Remote {
  status: HostStatus = 'starting'
  pairingUrl = ''
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
  private active: Peer | null = null
  private latest: WireState | null = null
  private padState: PadState | null = null
  private padAt = 0
  private stateAt = 0
  private latestAcc: Acc | null = null
  private outAcc: Acc | null = null
  private outMode: ModeId | null = null
  private lastConsumeAt = 0
  private buf: { t: number; s: WireState; acc: Acc }[] = []
  private offsets: [number, number][] = []
  private tBase = 0
  private tLast = -1
  private lastMode: ModeId | null = null
  private lostTimer: ReturnType<typeof setTimeout> | null = null
  private handlers: { [K in keyof RemoteEvents]: RemoteEvents[K][] } = {
    status: [], connect: [], disconnect: [], button: [], value: [], mode: [], recenter: [], pad: [],
  }
  private cards: { el: HTMLElement; status: HTMLElement; compact: boolean }[] = []

  private constructor(private opts: RemoteOptions) {
    this.service = (opts.service ?? (isObpalOrigin() ? location.origin : DEFAULT_SERVICE)).replace(/\/$/, '')
    this.layout = opts.layout ?? DEFAULT_LAYOUT
  }

  static async create(opts: RemoteOptions): Promise<Remote> {
    const r = new Remote(opts)
    await r.init()
    return r
  }

  private async init() {
    this.cert = await RTCPeerConnection.generateCertificate({ name: 'ECDSA', namedCurve: 'P-256' } as EcKeyGenParams)
    this.fp = await certFingerprint(this.cert)
    this.roomId = await roomIdFor(this.secret)
    this.pairingUrl = `${this.service}/p/#${encodePairing({ secret: this.secret, fp: this.fp })}`
    this.sig = new SignalClient(roomSocketUrl(this.service, this.roomId, 'host'))
    this.sig.onmessage = (m) => this.onSignal(m)
    this.sig.onstatus = (open) => {
      if (open && this.status !== 'connected') this.setStatus('ready')
      if (!open && this.status !== 'connected') this.setStatus('offline')
    }
    this.sig.connect()
    // TURN credentials are only minted for rooms with a live host, so fetch after joining.
    setTimeout(async () => { this.ice = await fetchIceServers(this.service, this.roomId) }, 400)
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

  private onSignal(m: SignalIn) {
    if (m.t === 'peer' && m.ev === 'leave') this.dropPeer(m.id)
    if (m.t === 'sig') void this.onPayload(m.from, m.d)
  }

  private async onPayload(id: string, d: SignalPayload) {
    if ('offer' in d) {
      this.dropPeer(id)
      if (this.status !== 'connected') this.setStatus('connecting')
      const pc = new RTCPeerConnection({ iceServers: this.ice, certificates: [this.cert] })
      const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 0 })
      const st = pc.createDataChannel('st', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 })
      st.binaryType = 'arraybuffer'
      const peer: Peer = { id, pc, ctl, st, fp: sdpFingerprint(d.offer.sdp), bound: false, name: 'Phone', cands: [] }
      this.peers.set(id, peer)
      pc.onicecandidate = (e) => { if (e.candidate) this.sig.send({ t: 'sig', to: id, d: { cand: e.candidate.toJSON() } }) }
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState
        if ((s === 'failed' || s === 'closed' || s === 'disconnected') && this.active === peer) this.scheduleLost()
        if (s === 'connected' && this.active === peer && this.lostTimer) { clearTimeout(this.lostTimer); this.lostTimer = null }
      }
      ctl.onmessage = (e) => void this.onCtl(peer, e.data)
      st.onmessage = (e) => {
        if (!peer.bound || this.active !== peer || !(e.data instanceof ArrayBuffer)) return
        if (packetType(e.data) === PAD_HEADER) this.onPad(e.data)
        else this.onState(e.data)
      }
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
      const expected = await bindMac(this.secret, peer.fp, this.fp, this.roomId)
      if (!equalBytes(new TextEncoder().encode(expected), new TextEncoder().encode(m.mac))) {
        this.send(peer, { t: 'lock', reason: 'rejected' })
        setTimeout(() => this.dropPeer(peer.id), 200)
        return
      }
      peer.bound = true
      peer.name = String(m.name || 'Phone').slice(0, 40)
      const prev = this.active
      if (prev && prev !== peer) {
        this.send(prev, { t: 'lock', reason: 'taken-over' })
        setTimeout(() => this.dropPeer(prev.id), 300)
      }
      this.active = peer
      this.resetStream()
      this.deviceName = peer.name
      if (this.lostTimer) { clearTimeout(this.lostTimer); this.lostTimer = null }
      this.send(peer, { t: 'welcome', proto: PROTO, name: this.opts.appName, layout: this.layout })
      this.setStatus('connected')
      this.emit('connect', { name: peer.name, caps: m.caps })
      return
    }
    if (this.active !== peer) return
    switch (m.t) {
      case 'btn': this.emit('button', { id: m.id, ev: m.ev }); break
      case 'value': this.emit('value', { id: m.id, v: m.v, add: m.add === true }); break
      case 'mode': this.emit('mode', m.m); break
      case 'recenter': this.emit('recenter'); break
      case 'ping': this.send(peer, { t: 'pong', t0: m.t0 }); break
      case 'bye': this.dropPeer(peer.id); break
    }
  }

  private unwrapMs(t: number): number {
    if (this.tLast >= 0 && t < this.tLast && this.tLast - t > 0x80000000) this.tBase += 0x100000000
    this.tLast = t
    return (this.tBase + t) / 1000
  }

  private onState(data: unknown) {
    if (!(data instanceof ArrayBuffer)) return
    const s = decodeState(data)
    if (!s || (this.latest && !seqNewer(s.seq, this.latest.seq))) return
    const now = performance.now()
    const dev = this.unwrapMs(s.t)
    this.offsets.push([now, now - dev])
    while (this.offsets.length && now - this.offsets[0][0] > 2000) this.offsets.shift()
    const offset = Math.min(...this.offsets.map((o) => o[1]))
    const acc = this.latest && this.latestAcc ? combineAcc(this.latestAcc, accumDelta(s, this.latest), 1) : zeroAcc()
    this.buf.push({ t: dev + offset, s, acc })
    if (this.buf.length > 40) this.buf.shift()
    this.latest = s
    this.latestAcc = acc
    this.stateAt = now
    if (s.mode !== this.lastMode) { this.lastMode = s.mode; this.emit('mode', s.mode) }
  }

  private onPad(data: ArrayBuffer) {
    const p = decodePad(data)
    if (!p || (this.padState && !seqNewer(p.seq, this.padState.seq))) return
    const was = this.padLive
    this.padState = p
    this.padAt = performance.now()
    if (!was) this.emit('pad', true)
  }

  private get padLive() { return !!this.padState && performance.now() - this.padAt < 1500 }

  /** Latest controller state while the phone is in gamepad mode (null otherwise). */
  get pad(): PadState | null {
    if (this.padState && !this.padLive) { this.padState = null; this.emit('pad', false) }
    return this.padState
  }

  /** Vibrate the phone (Gamepad API dual-rumble semantics). */
  rumble(strong: number, weak: number, ms: number) {
    if (this.active) this.send(this.active, { t: 'rumble', strong, weak, ms })
  }

  private resetStream() {
    this.padState = null
    this.padAt = 0
    this.stateAt = 0
    this.latest = null
    this.latestAcc = null
    this.outAcc = null
    this.outMode = null
    this.buf = []
    this.offsets = []
    this.tBase = 0
    this.tLast = -1
    this.lastMode = null
  }

  /** Read input for this frame. Call once per rendered frame (e.g. inside requestAnimationFrame). */
  consume(now = performance.now()): Frame {
    const s = this.latest
    const frame: Frame = {
      connected: this.status === 'connected', mode: s?.mode ?? Mode.hold, tier: s?.tier ?? Tier.touch,
      clutch: false, grab: s?.grab ?? 0, qRel: qIdentity(), touching: false,
      aim: [0, 0], tilt: [0, 0], pad1: [0, 0], pad2: [0, 0], zoom: 0, twist: 0,
    }
    if (!s || !this.buf.length) return frame
    // Gamepad mode: PAD packets replace STATE, so the last STATE (a held tilt, a gyro grab) must not keep driving
    // the view even if every hand-off STATE was lost on the unreliable channel.
    if (this.padLive && this.padAt > this.stateAt) { frame.mode = Mode.gamepad; return frame }

    // Sample everything one sensor period behind and interpolate, so motion is even from frame to frame
    // regardless of network jitter. 'direct' uses the newest packet instead.
    let ai = this.buf.length - 1
    let bi = -1
    let alpha = 0
    if (this.opts.latency !== 'direct') {
      const target = now - 1000 / 60
      ai = 0
      for (let i = this.buf.length - 1; i >= 0; i--) {
        if (this.buf[i].t <= target) {
          ai = i
          if (i + 1 < this.buf.length) {
            bi = i + 1
            alpha = Math.min(1, Math.max(0, (target - this.buf[i].t) / Math.max(1, this.buf[bi].t - this.buf[i].t)))
          }
          break
        }
      }
    }
    const A = this.buf[ai]
    const B = bi >= 0 ? this.buf[bi] : null
    const accNow = B ? lerpAcc(A.acc, B.acc, alpha) : A.acc
    // After a stall (hidden tab, long frame) drop the backlog instead of applying it as one jump. Point mode is the
    // exception: its aim is where the phone points (absolute), so the cursor catches up rather than falling out of step.
    const fresh = !!this.outAcc && now - this.lastConsumeAt < 250
    const d = fresh ? combineAcc(accNow, this.outAcc!, -1) : zeroAcc()
    if (!fresh && this.outAcc && this.outMode === Mode.point && A.s.mode === Mode.point) {
      d.aim = [accNow.aim[0] - this.outAcc.aim[0], accNow.aim[1] - this.outAcc.aim[1]]
    }
    this.outAcc = accNow
    this.outMode = A.s.mode
    this.lastConsumeAt = now
    frame.aim = d.aim
    frame.pad1 = d.pad1
    frame.pad2 = d.pad2
    frame.zoom = d.zoom
    frame.twist = d.twist
    frame.touching = (s.flags & Flag.touching) !== 0

    const a = A.s
    const b = B?.s
    frame.mode = a.mode
    frame.tilt = b ? [a.tilt[0] + (b.tilt[0] - a.tilt[0]) * alpha, a.tilt[1] + (b.tilt[1] - a.tilt[1]) * alpha] : a.tilt
    frame.clutch = (a.flags & Flag.clutch) !== 0
    frame.grab = a.grab
    frame.qRel = a.qRel
    if (b && frame.clutch && (b.flags & Flag.clutch) && b.grab === a.grab) frame.qRel = qSlerp(a.qRel, b.qRel, Math.min(1, Math.max(0, alpha)))
    // No STATE for 250 ms (phone backgrounded, network stall): ease rate controls to rest over 150 ms instead of
    // leaving a tilt latched. The phone sends at least 15 Hz while connected, so this only trips on a real gap.
    const silent = now - this.stateAt
    if (silent > 250) {
      const k = Math.max(0, 1 - (silent - 250) / 150)
      frame.tilt = [frame.tilt[0] * k, frame.tilt[1] * k]
      frame.touching = false
    }
    return frame
  }

  setLayout(layout: Layout) {
    this.layout = layout
    if (this.active) this.send(this.active, { t: 'layout', layout })
  }

  /** Sync toggle/label state shown on the phone. */
  setValues(values: Record<string, number | boolean | string>) {
    if (this.active) this.send(this.active, { t: 'state', values })
  }

  feedback(f: { haptic?: 'tick' | 'bump'; toast?: string }) {
    if (this.active) this.send(this.active, { t: 'feedback', ...f })
  }

  /** Disconnect the current phone (it can rescan to reconnect). */
  disconnect() {
    const p = this.active
    if (!p) return
    this.send(p, { t: 'lock', reason: 'host-closed' })
    setTimeout(() => this.dropPeer(p.id), 200)
  }

  destroy() {
    for (const id of [...this.peers.keys()]) this.dropPeer(id)
    this.sig?.close()
    for (const c of this.cards) c.el.remove()
    this.cards = []
  }

  private send(peer: Peer, m: HostMsg) {
    if (peer.ctl.readyState === 'open') peer.ctl.send(JSON.stringify(m))
  }

  private scheduleLost() {
    if (this.lostTimer) return
    this.lostTimer = setTimeout(() => {
      this.lostTimer = null
      if (this.active && this.active.pc.connectionState !== 'connected') this.dropPeer(this.active.id)
    }, 4000)
  }

  private dropPeer(id: string) {
    const p = this.peers.get(id)
    if (!p) return
    this.peers.delete(id)
    try { p.pc.close() } catch { /* closed */ }
    if (this.active === p) {
      this.active = null
      this.deviceName = null
      this.resetStream()
      this.setStatus(this.sig?.open ? 'ready' : 'offline')
      this.emit('disconnect')
    }
  }

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
    const link = card.querySelector<HTMLAnchorElement>('.obpal-link')
    if (link) link.href = this.pairingUrl
    void import('uqr').then(({ renderSVG }) => {
      card.querySelector('.obpal-qr')!.innerHTML = renderSVG(this.pairingUrl, { border: 2, ecc: 'M' })
    })
    el.appendChild(card)
    this.cards.push({ el: card, status: card.querySelector('.obpal-status')!, compact })
    this.renderCards()
    return card
  }

  private renderCards() {
    const text: Record<HostStatus, string> = {
      starting: 'Starting…',
      ready: 'Waiting for your phone',
      connecting: 'Phone found, connecting…',
      connected: `Connected${this.deviceName ? ` to ${this.deviceName}` : ''}`,
      offline: 'Offline, retrying…',
    }
    const short: Record<HostStatus, string> = { starting: 'Starting', ready: 'Waiting', connecting: 'Connecting', connected: 'Connected', offline: 'Offline' }
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
