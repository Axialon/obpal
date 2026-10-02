import { DeviceLink, decodePad, emptyPad, parsePairing, validSimMessage, type SimMessage, type SimValue, type PadState, type Layout } from '@obpal/core'
import type { Remote } from '@obpal/host'
import { ConeGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, BoxGeometry, Vector3, Quaternion } from 'three'
import type { Ride } from './rigs'
import { PropWorld, validVector, distance, type Body, type Collider, type V3 } from './world'
import { ICONS } from '../../ui/icons'
import { SharePanel } from '../../ui/share-panel'
import { iconAction } from '../../ui/kit/action'
import { PhonePlay } from '../local-play'
import { ParticipantStrip } from '../../ui/participants'
import { Audience, Handover, type RoomState, type AudienceState } from '../participation'
import { restInput, type DeviceInput } from '../devices/types'
import { clearPlacement, dropClearance, nearDropPositions, playerDropBounds, DropQueue, dropCatalogue, type DropCredit, type DropObject } from './drops'
import { dotLoading } from '../../ui/kit/loading'
import '../../styles/presence.css'

export interface Pose { p: V3; q: [number, number, number, number] }
export interface PresenceInput { ride: string; active: boolean; head: Pose; hands: Pose[]; grab: boolean; pad: PadState | null }
export interface Person extends PresenceInput { id: string; color: string; phone?: boolean }
export interface SceneAdapter {
  capture(): SimValue; apply(state: SimValue): void; rides(): Ride[]; colliders?(): Collider[]; drive?(who: string, ride: string, pad: PadState): void; allowed?(who: string): boolean
  sim?: string; dropBudget?: number; hardwareLive?(): boolean
  placeDrop?(object: DropObject, at: V3): Body | null
  dropPosition?(object: DropObject, at: V3 | null, near?: V3): V3 | null
  removeDrop?(id: string): void
  dropAlive?(id: string): boolean
  audienceUnits?(): { id: string; name: string; busy?: boolean }[]
  reserveAudience?(unit: string | null): boolean
  audienceInput?(unit: string, input: DeviceInput): void
  seatInput?(who: string, seat: string, input: DeviceInput): void
  seatSafe?(seat: string): boolean
}
const value = (x: unknown) => x as SimValue
const poseOK = (x: unknown): x is Pose => {
  const p = x as Pose | null
  return !!p && validVector(p.p) && Array.isArray(p.q) && p.q.length === 4 && p.q.every(n => Number.isFinite(n)) && Math.abs(Math.hypot(...p.q) - 1) < 0.05
}
export function validPresence(x: unknown): x is PresenceInput {
  const p = x as PresenceInput | null
  if (!p || typeof p.ride !== 'string' || p.ride.length > 64 || typeof p.active !== 'boolean' || typeof p.grab !== 'boolean' || !poseOK(p.head) || !Array.isArray(p.hands) || p.hands.length > 2 || !p.hands.every(poseOK)) return false
  return p.pad === null || !!p.pad && Number.isInteger(p.pad.buttons) && p.pad.buttons >= 0 && p.pad.buttons < 131072 && Array.isArray(p.pad.axes) && p.pad.axes.length === 4 && p.pad.axes.every(n => Number.isFinite(n) && Math.abs(n) <= 1) && Array.isArray(p.pad.triggers) && p.pad.triggers.length === 2 && p.pad.triggers.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
}

/** Shared renderers join as normal authenticated participants; the screen alone steps physics. */
export class SharedPresence {
  readonly guest = new URLSearchParams(location.search).has('watch') || ['1', 'play'].includes(new URLSearchParams(location.search).get('join') ?? '')
  readonly drops: DropQueue
  private share: SharePanel | null = null
  private tray: HTMLElement | null = null
  private dropStatus: HTMLElement | null = null
  private selectedDrop = ''
  private dropName = ''
  private credits: Record<string, DropCredit> = {}
  private credit = document.createElement('div')
  private epoch = crypto.randomUUID()
  private tickNumber = 0
  private receivedEpoch = ''
  private receivedTick = -1
  private player = false
  get canControl() { return !this.guest || this.player }
  private phonePlay: PhonePlay | null = null
  readonly handover = new Handover()
  readonly audience = new Audience()
  private strip: ParticipantStrip
  private roomSent = 0
  private roomSeq = -1
  private operations = new Map<string, { seq: number; at: number }>()
  private layout: Layout | null = null
  private simName = ''
  private grant = ''
  private streamQr = document.createElement('div')
  private showWatchQr = false
  private qrRevision = 0
  private enabledSent: boolean | null = null
  /** Scene geometry contributes conservative placement bounds; hardware is checked independently. */
  placementClear: (at: V3, radius: number) => boolean = () => true
  pickDrop: ((x: number, y: number) => V3 | null) | null = null
  readonly world = new PropWorld()
  readonly group = new Group()
  readonly people = new Map<string, Person>()
  id = 'host'
  private statusText = 'Local scene'
  private chip: HTMLElement | null = null
  get status() { return this.statusText }
  set status(text: string) {
    if (text === this.statusText) return
    this.statusText = text
    if (!this.chip) return
    this.chip.dataset.state = text.toLowerCase().replaceAll(' ', '-')
    const state = this.chip.querySelector<HTMLElement>('.guest-state')!
    state.textContent = text
    const waiting = text === 'Connecting' || text === 'Waiting for host'
    state.classList.toggle('dot-wait-label', waiting)
    dotLoading(this.chip, waiting, text)
  }
  colors: (string | null)[] = []
  private link: DeviceLink | null = null
  private remote: Remote | null = null
  private subscribers = new Map<string, { seq: number; at: number }>()
  private frames = -1
  private seq = 0
  private sent = 0
  private avatars = new Map<string, Group>()
  private meshes = new Map<string, Mesh>()
  private previousGrab = new Map<string, boolean>()
  private lastInput: PresenceInput | null = null
  private joinedAt = 0
  constructor(readonly adapter: SceneAdapter) {
    const sim = adapter.sim ?? (location.pathname.includes('/arm/') ? 'arm' : location.pathname.includes('/humanoid/') ? 'humanoid' : location.pathname.includes('/view/') ? 'viewer' : new URLSearchParams(location.search).get('d') ?? location.pathname.split('/')[2])
    this.simName = sim
    this.strip = new ParticipantStrip({
      handover: (op, to) => this.guest ? this.link?.sendCtl({ t: 'sim', v: 1, kind: 'handover', seq: ++this.seq, data: { op, ...(to ? { to } : {}) } }) : this.handoverAction('host', op, to),
      audience: data => this.link?.sendCtl({ t: 'sim', v: 1, kind: 'audience', seq: ++this.seq, data }),
      ...(!this.guest ? { configure: (mode: AudienceState['mode'], unit: string, seconds: number) => this.configureAudience(mode, unit, seconds), stream: () => this.toggleStream(), share: () => this.openShare() } : {}),
    }, !this.guest)
    this.streamQr.className = 'stream-watch-qr'; this.streamQr.hidden = true; document.body.append(this.streamQr)
    this.drops = new DropQueue(dropCatalogue(sim), adapter.dropBudget ?? 8, !['arm', 'humanoid'].includes(sim))
    this.group.name = 'shared-presence'
    this.credit.className = 'drop-credit'; this.credit.setAttribute('role', 'status'); this.credit.hidden = true; document.body.append(this.credit)
    if (this.guest) {
      document.body.classList.add('presence-guest')
      this.chip = document.createElement('div')
      this.chip.className = 'kit-chip guest-status'
      this.chip.setAttribute('role', 'status')
      this.chip.setAttribute('aria-live', 'polite')
      this.chip.innerHTML = `${ICONS.view}<span>Watching</span><i class="guest-dot" aria-hidden="true"></i><span class="guest-state"></span>`
      document.body.append(this.chip)
      this.status = 'Connecting'
      const key = `obpal.scene:${location.pathname}${location.search.replace(/[?&]test=vr/g, '')}`
      let fragment = location.hash
      try { if (fragment) sessionStorage.setItem(key, fragment); else fragment = sessionStorage.getItem(key) ?? '' } catch { /* private storage */ }
      const pairing = parsePairing(fragment)
      history.replaceState(null, '', location.pathname + location.search)
      if (!pairing || (new URLSearchParams(location.search).get('join') === 'play' ? pairing.capability !== 'play' : pairing.capability !== 'watch')) { this.status = 'Open a fresh shared scene link'; return }
      this.player = pairing.capability === 'play' && new URLSearchParams(location.search).get('join') === 'play'
      this.chip.querySelector('span')!.textContent = this.player ? 'Playing' : 'Watching'
      this.link = new DeviceLink({ pairing, service: location.origin, name: this.player ? 'Scene player' : 'Scene visitor', caps: () => ({ tier: 0, sensorApi: 'none', haptics: 'none', platform: this.player ? 'scene-player' : 'scene' }) })
      this.link.on('message', m => {
        if (m.t === 'welcome' || m.t === 'layout') this.layout = m.layout
        if (m.t === 'welcome' && this.player && !this.phonePlay) this.phonePlay = new PhonePlay({ id: this.id, pad: b => this.link!.sendState(b), state: b => this.link!.sendState(b), control: m => this.link!.sendCtl(m), close: () => this.link?.close() }, m.layout, sim)
        if (m.t === 'scene') this.id = m.you
        if (m.t === 'sim' && m.kind === 'room' && validSimMessage(m) && m.seq > this.roomSeq) {
          const room = m.data as unknown as RoomState
          if (!Array.isArray(room?.people) || !Array.isArray(room.requests) || !Array.isArray(room.units) || !room.audience) return
          this.roomSeq = m.seq; this.id = room.you; this.strip.update(room); this.applyRole(room)
        }
        if (m.t === 'sim' && m.kind === 'frame' && validSimMessage(m) && m.seq > this.frames) {
          const d = m.data as unknown as { epoch: string; tick: number; state: SimValue; bodies: Body[]; people: Person[]; colors: (string | null)[]; drops: Record<string, DropCredit>; dropsEnabled: boolean }
          if (!d || !Array.isArray(d.bodies) || !Array.isArray(d.people) || !Array.isArray(d.colors)) return
          if (typeof d.epoch !== 'string' || !Number.isSafeInteger(d.tick)) return
          if (this.receivedEpoch === d.epoch && d.tick <= this.receivedTick) return
          this.receivedEpoch = d.epoch; this.receivedTick = d.tick
          this.frames = m.seq
          this.adapter.apply(d.state)
          this.world.bodies.splice(0, this.world.bodies.length, ...d.bodies)
          this.people.clear()
          d.people.filter(validPresence).forEach(p => this.people.set(p.id, p))
          this.colors = d.colors
          this.credits = d.drops ?? {}; this.drops.enabled = d.dropsEnabled
          this.renderDropState()
          this.status = 'Live'
        }
      })
      this.link.on('status', s => {
        this.status = s === 'connected' ? 'Waiting for host' : s === 'waiting-host' ? this.frames >= 0 ? 'Host left' : 'Waiting for host' : s === 'full' ? 'Room full' : s === 'removed' ? 'Removed' : s === 'closed' ? 'Host left' : s === 'unreachable' ? 'Connection lost' : 'Connecting'
        if (s === 'connected') { this.frames = -1; this.receivedTick = -1; this.link!.sendCtl({ t: 'sim', v: 1, kind: 'watch', seq: ++this.seq, data: null }); this.joinedAt = performance.now() }
        else { this.roomSeq = -1; this.phonePlay?.close(false); this.phonePlay = null; this.grant = ''; this.strip.root.hidden = true; this.people.clear(); this.credits = {}; this.world.bodies.forEach(b => { b.owner = null }); }
      })
      void this.link.start()
      this.mountDropTray()
      addEventListener('pagehide', () => this.link?.close(), { once: true })
    }
  }
  connect(remote: Remote) {
    this.remote = remote
    remote.extendTray([{ id: 'drops.undo', label: 'Undo drop', icon: 'undo' }, { id: 'drops.clear', label: 'Clear drops', icon: 'reset' }, { id: 'drops.toggle', label: 'Drop-ins', icon: 'plus', type: 'toggle' }])
    remote.on('join', who => remote.offerScene(this.shareUrl('play'), who.id))
    remote.on('invite', () => remote.participants.forEach(who => remote.offerScene(this.shareUrl('play'), who.id)))
    remote.participants.forEach(who => remote.offerScene(this.shareUrl('play'), who.id))
    this.enabledSent = null; this.publishDropSwitch()
    remote.setShareTarget(this.shareUrl())
    this.share = new SharePanel(remote, key => remote.shortShareUrl(key))
    const actions = document.createElement('div'); actions.className = 'drop-actions'
    for (const [glyph, label, op] of [['undo', 'Undo drop', 'undo'], ['reset', 'Clear drops', 'clear'], ['plus', 'Drop-ins', 'toggle']]) {
      const b = document.createElement('button'); iconAction(b, glyph, label); b.onclick = () => this.controlDrops(op); actions.append(b)
      if (op === 'toggle') b.setAttribute('aria-pressed', String(this.drops.enabled && !this.adapter.hardwareLive?.()))
    }
    document.querySelector('.presence-controls')?.append(actions)
    remote.on('sim', (m, who) => {
      if (m.kind === 'handover') {
        const last = this.operations.get(who.id), now = performance.now()
        if (last && (m.seq <= last.seq || now - last.at < 100)) return
        this.operations.set(who.id, { seq: m.seq, at: now }); const d = m.data as { op: string; to?: string }; this.handoverAction(who.id, d.op, d.to); return
      }
      if (m.kind === 'audience') {
        const d = m.data as { op?: string; x: number; y: number }, now = performance.now(), watchers = this.watchers()
        if (d.op === 'join' || d.op === 'leave') { if (this.audience.command(who.id, m.seq, d.op, now, watchers)) this.publishRoom() }
        else this.audience.input(who.id, m.seq, d.x, d.y, now, watchers)
        return
      }
      if (m.kind === 'watch') { this.subscribers.set(who.id, { seq: -1, at: performance.now() }); this.sendFrame(who.id); return }
      const peer = this.subscribers.get(who.id)
      if (m.kind === 'drops' && who.capability !== 'watch') { this.controlDrops(String(m.data)); return }
      if (!peer || m.seq <= peer.seq) return
      peer.seq = m.seq; peer.at = performance.now()
      if (m.kind === 'drop') {
        const accepted = this.drops.request(who.id, who.color, m.data, peer.at, !!this.adapter.hardwareLive?.())
        remote.feedback({ toast: accepted ? 'Drop queued' : 'Drop unavailable' }, who.id)
        return
      }
      if (!['input', 'camera'].includes(m.kind) || !validPresence(m.data)) return
      // Visitors retain their pose for presence, but never drive or grab through a watch link.
      const input = m.data as unknown as PresenceInput
      this.accept(who.id, who.color, { ...input, grab: false, pad: null }, peer.at)
    })
    remote.on('join', () => this.publishRoom())
    remote.on('scene', () => this.publishRoom())
    remote.on('role', who => { this.handover.leave(who.id); if (who.simSeat) this.handover.grants.set(who.id, who.simSeat); this.audience.leave(who.id); this.world.release(who.id, false); this.previousGrab.delete(who.id); this.publishRoom() })
    remote.on('attention', who => { if (who.paused) this.audience.leave(who.id); this.publishRoom() })
    remote.on('leave', who => { this.operations.delete(who.id); this.handover.leave(who.id); this.audience.disconnect(who.id); this.subscribers.delete(who.id); this.people.delete(who.id); this.previousGrab.delete(who.id); this.world.release(who.id, false); this.drops.leave(who.id); this.publishRoom() })
    remote.on('button', (e, who) => { if (who.capability !== 'watch' && ['drops.undo', 'drops.clear', 'drops.toggle'].includes(e.id)) this.controlDrops(e.id.slice(6)) })
    remote.on('value', (e, who) => { if (who.capability !== 'watch' && e.id === 'drops.toggle' && typeof e.v === 'boolean') this.controlDrops(e.v ? 'on' : 'off') })
    const watchQr = document.createElement('button'); watchQr.type = 'button'; watchQr.textContent = 'Show watch QR'; watchQr.setAttribute('aria-pressed', 'false'); watchQr.className = 'stream-qr-toggle'; watchQr.onclick = () => { this.showWatchQr = !this.showWatchQr; watchQr.setAttribute('aria-pressed', String(this.showWatchQr)); this.renderStreamQr() }; this.strip.root.append(watchQr)
    remote.on('invite', () => this.renderStreamQr())
    this.publishRoom()
  }
  private watchers() { return new Set(this.remote?.participants.filter(p => p.role === 'watch' && !p.paused).map(p => p.id)) }
  private handoverAction(from: string, op: string, to?: string) {
    if (!this.remote) return
    const watchers = this.watchers(), people = this.remote.participants, lead = from === 'host' || !!people.find(p => p.id === from)?.lead, target = to ?? from, scene = this.remote.sceneSnapshot
    if (op === 'ask') this.handover.ask(from, watchers)
    else if (op === 'cancel') this.handover.decline(from)
    else if (op === 'decline' && lead) this.handover.decline(target)
    else if (op === 'demote' && (from === 'host' || from === target)) this.remote.setSimSeat(target, null)
    else if (op === 'accept' && lead) {
      const overlapsHeld = (root: string) => Object.keys(scene.held).some(id => {
        for (let node: string | undefined = id, depth = 0; node && depth < 8; node = scene.nodes.find(n => n.id === node)?.parent, depth++) if (node === root) return true
        return false
      })
      const free = scene.nodes.find(n => !n.parent && !overlapsHeld(n.id) && this.adapter.seatSafe?.(n.id) !== false)
      if (people.filter(p => p.role === 'play').length < 8 && this.handover.accept(target, free?.id, watchers, new Set(Object.keys(scene.held)))) this.remote.setSimSeat(target, free!.id)
      else this.remote.feedback({ toast: 'No free sim seat' }, from === 'host' ? undefined : from)
    } else if (op === 'give' && to) {
      const seat = Object.entries(scene.held).find(([, who]) => who === from)?.[0]
      if (this.adapter.seatSafe?.(seat ?? '') !== false && this.handover.give(from, to, seat, watchers)) { this.remote.setSimSeat(from, null); this.remote.setSimSeat(to, seat!) }
    }
    this.publishRoom()
  }
  configureAudience(mode: AudienceState['mode'], unit: string, seconds = 60) {
    if (this.guest || !['off', 'queue', 'crowd'].includes(mode) || this.adapter.hardwareLive?.()) return false
    const units = this.audienceUnits(), selected = units.find(u => u.id === unit)
    if (mode !== 'off' && (!selected || selected.busy && unit !== this.audience.unit)) return false
    if (this.adapter.reserveAudience && !this.adapter.reserveAudience(mode === 'off' ? null : unit)) return false
    if (!this.adapter.audienceUnits && mode !== 'off' && !this.world.bodies.some(b => b.id === 'audience-prop')) { const prop = this.world.add('ball', [0, .2, -1], .2); prop.id = 'audience-prop' }
    this.audience.configure(mode, mode === 'off' ? '' : unit, seconds); this.publishRoom(); return true
  }
  private audienceUnits() { return this.adapter.audienceUnits?.() ?? [{ id: 'audience-prop', name: 'Audience ball' }] }
  private publishRoom() {
    if (!this.remote) return
    const scene = this.remote.sceneSnapshot, audience = this.audience.snapshot(performance.now(), this.watchers())
    const room: RoomState = { people: this.remote.participants.map(p => {
      const seat = scene.nodes.find(n => scene.held[n.id] === p.id)?.name
      return { id: p.id, name: p.name || 'Guest', color: p.color, role: p.role ?? (p.capability === 'watch' ? 'watch' : 'play'), lead: p.lead, ...(seat ? { seat } : {}) }
    }), requests: [...this.handover.requests], audience, units: this.audienceUnits(), you: 'host' }
    this.strip.update(room)
    for (const p of this.remote.participants) this.remote.sendSim({ t: 'sim', v: 1, kind: 'room', seq: ++this.seq, data: value({ ...room, you: p.id, grant: p.simSeat ?? '' }) }, p.id)
  }
  private applyRole(room: RoomState) {
    this.strip.root.hidden = false
    const player = room.people.find(p => p.id === this.id)?.role === 'play', grant = (room as RoomState & { grant?: string }).grant ?? ''
    if (!player && this.phonePlay || grant !== this.grant) { this.phonePlay?.close(false); this.phonePlay = null }
    this.player = !!player; this.grant = grant; if (this.chip) this.chip.querySelector('span')!.textContent = player ? 'Playing' : 'Watching'
    if (player && grant && this.layout && !this.phonePlay) this.phonePlay = new PhonePlay({
      id: this.id, pad: buffer => { const p = decodePad(buffer); if (p) this.link?.sendCtl({ t: 'sim', v: 1, kind: 'seat', seq: ++this.seq, data: { x: p.axes[0], y: p.axes[1], rx: p.axes[2], ry: p.axes[3] } }) }, state: () => {},
      control: m => { if (m.t === 'btn' && m.ev === 'tap') this.link?.sendCtl({ t: 'sim', v: 1, kind: 'seat', seq: ++this.seq, data: { x: 0, y: 0, action: m.id } }) },
      close: () => this.link?.sendCtl({ t: 'sim', v: 1, kind: 'handover', seq: ++this.seq, data: { op: 'demote' } }),
    }, this.layout, this.simName, true)
  }
  toggleStream() { document.body.classList.toggle('stream-view'); this.share?.root.close(); const menu = this.strip.root.querySelector('details'); if (menu) menu.open = false; this.renderStreamQr() }
  private renderStreamQr() {
    const revision = ++this.qrRevision, visible = document.body.classList.contains('stream-view') && this.showWatchQr && !!this.remote?.sharingOpen('watch')
    this.streamQr.hidden = !visible; this.streamQr.replaceChildren()
    if (visible) void import('../../../packages/host/src/qr').then(({ brandedQrElement }) => { if (revision === this.qrRevision) this.streamQr.append(brandedQrElement(this.remote!.shortShareUrl('watch'), { label: 'Watch this scene' })) })
  }
  isVisitor(who: string) { return this.remote?.participants.find(p => p.id === who)?.capability === 'watch' }
  /** Use the arm scene's existing stop channel; watching never grants permission to resume or drive. */
  stopArms() { if (this.player) this.link?.sendCtl({ t: 'btn', id: 'estop', ev: 'tap' }) }
  openShare(tab: 'watch' | 'play' = 'watch') { this.share?.open(tab) }
  shareUrl(capability: 'watch' | 'play' = 'watch') {
    if (!this.remote) return ''
    const url = new URL(location.href)
    url.searchParams.delete('test'); url.searchParams.delete('join'); url.searchParams.delete('local'); url.searchParams.delete('watch')
    if (capability === 'watch') url.searchParams.set('watch', '1'); else url.searchParams.set('join', 'play')
    url.hash = capability === 'watch' ? this.remote.watchFragment : new URL(this.remote.pairingUrl).hash
    return url.href
  }
  input(input: PresenceInput, now: number) {
    this.lastInput = input
    if (!this.guest) this.accept('host', '#b3a4ff', input, now)
  }
  private accept(id: string, color: string, p: PresenceInput, now: number) {
    const ride = this.adapter.rides().find(r => r.id === p.ride)
    if (!ride) return
    // A seated presence can lean and reach, but cannot teleport a grab across the world.
    const viewpoints = ride.views ?? [{ pose: ride.pose }]
    if (viewpoints.every(v => distance(v.pose().p.toArray() as V3, p.head.p) > 3) || p.hands.some(h => distance(h.p, p.head.p) > 2)) return
    this.people.set(id, { ...p, id, color })
    if (this.adapter.allowed?.(id) === false) { this.world.release(id, false); return }
    if (p.active && p.pad) this.adapter.drive?.(id, p.ride, p.pad)
    const hand = p.hands[0]?.p ?? new Vector3(0, 0, -0.75).applyQuaternion(new Quaternion(...p.head.q)).add(new Vector3(...p.head.p)).toArray() as V3
    if (p.active && p.grab) {
      if (!this.previousGrab.get(id)) {
        const near = this.world.bodies.filter(b => !b.owner && distance(b.p, hand) < 1.5).sort((a, b) => distance(a.p, hand) - distance(b.p, hand))[0]
        if (near) this.world.grab(id, near.id, hand, now)
      }
      this.world.move(id, hand, now)
    } else this.world.release(id)
    this.previousGrab.set(id, p.active && p.grab)
  }
  tick(dt: number, now: number) {
    if (!this.guest) {
      this.tickNumber++
      if (this.adapter.hardwareLive?.() && this.audience.mode !== 'off') this.configureAudienceOff()
      const audience = this.audience.snapshot(now, this.watchers()), input = restInput(); input.pad = { ...emptyPad(), axes: [...audience.direction, 0, 0] }
      if (audience.mode !== 'off') {
        if (this.adapter.audienceInput) this.adapter.audienceInput(audience.unit, input)
        else this.audiencePropInput(audience.unit, input)
      }
      for (const p of this.remote?.participants ?? []) if (p.simSeat) {
        if (this.adapter.seatSafe?.(p.simSeat) === false) { this.remote!.setSimSeat(p.id, null); continue }
        if (this.adapter.seatInput) { const pad = this.remote!.simPadOf(p.id, now); this.adapter.seatInput(p.id, p.simSeat, { ...restInput(), pad }) }
      }
      if (now - this.roomSent >= 100) { this.roomSent = now; this.publishRoom() }
      if (this.adapter.hardwareLive?.()) { this.drops.enabled = false; this.drops.clear(this.removeDrop) }
      this.publishDropSwitch()
      for (const id of this.drops.live.keys()) if (this.adapter.dropAlive?.(id) === false) { this.removeDrop(id); this.drops.live.delete(id) }
      this.drops.tick(now, !!this.adapter.hardwareLive?.(), (object, requested) => {
        const lead = this.remote?.participants.find(p => p.lead)?.id, person = lead ? this.people.get(lead) : null
        const rides = this.adapter.rides(), ride = rides.find(r => r.id === person?.ride) ?? rides[0]
        const near = ride?.pose().p.toArray() as V3 | undefined ?? [0, 0, 0]
        const clearance = dropClearance(object.kind, object.radius)
        const occupied = [...this.world.bodies.map(b => ({ p: b.p, r: dropClearance(b.kind, b.r) })), ...(this.adapter.colliders?.() ?? []), ...playerDropBounds(this.people.values())]
        const positions = requested ? [requested] : [...(this.adapter.dropPosition ? [null] : []), ...nearDropPositions(near, object.radius)]
        for (const candidate of positions) {
          const at = this.adapter.dropPosition ? this.adapter.dropPosition(object, candidate, near) : candidate
          if (!at || !clearPlacement(at, clearance, occupied) || !this.placementClear(at, clearance)) continue
          const body = this.adapter.placeDrop ? this.adapter.placeDrop(object, at) : this.world.add(object.kind, at, object.radius)
          if (body) return body
        }
        return null
      })
      for (const [id, s] of this.subscribers) if (now - s.at > 750) { this.people.delete(id); this.world.release(id, false) }
      this.world.step(dt, now, this.adapter.colliders?.() ?? [])
    }
    if (now - this.sent >= 50) {
      this.sent = now
      if (this.guest && this.lastInput) this.link?.sendCtl({ t: 'sim', v: 1, kind: 'input', seq: ++this.seq, data: value({ ...this.lastInput, grab: false, pad: null }) })
      if (!this.guest && this.subscribers.size) {
        const msg = this.frame()
        for (const id of this.subscribers.keys()) this.remote?.sendSim(msg, id)
      }
    }
    if (this.guest && this.link?.ready && this.frames < 0 && this.joinedAt && now - this.joinedAt > 5000) this.status = 'Waiting for host'
    this.draw()
  }
  private configureAudienceOff() { this.adapter.reserveAudience?.(null); this.audience.configure('off', ''); this.publishRoom() }
  private audiencePropInput(unit: string, input: DeviceInput) { const prop = this.world.bodies.find(b => b.id === unit); if (prop) { prop.v[0] = (input.pad?.axes[0] ?? 0) * 1.5; prop.v[2] = (input.pad?.axes[1] ?? 0) * 1.5 } }
  private frame(): SimMessage {
    return { t: 'sim', v: 1, kind: 'frame', seq: ++this.seq, data: value({ epoch: this.epoch, tick: this.tickNumber, state: this.adapter.capture(), bodies: this.world.bodies, people: [...this.people.values()], colors: this.colors, drops: Object.fromEntries(this.drops.live), dropsEnabled: this.drops.enabled && !this.adapter.hardwareLive?.() }) }
  }
  private sendFrame(id: string) { this.remote?.sendSim(this.frame(), id) }
  private removeDrop = (id: string) => { this.adapter.removeDrop?.(id); this.world.remove(id) }
  controlDrops(op: string) {
    if (this.guest) { if (this.player) this.link?.sendCtl({ t: 'sim', v: 1, kind: 'drops', seq: ++this.seq, data: op }); return }
    if (op === 'undo') this.drops.undo(this.removeDrop)
    if (op === 'clear') this.drops.clear(this.removeDrop)
    if (['toggle', 'on', 'off'].includes(op)) { this.drops.enabled = (op === 'on' || op === 'toggle' && !this.drops.enabled) && !this.adapter.hardwareLive?.(); if (!this.drops.enabled) this.drops.clear(this.removeDrop) }
    this.publishDropSwitch()
  }
  private publishDropSwitch() {
    const enabled = this.drops.enabled && !this.adapter.hardwareLive?.()
    if (this.enabledSent === enabled) return
    this.enabledSent = enabled; this.remote?.setValues({ 'drops.toggle': enabled })
    document.body.dataset.dropsEnabled = String(enabled)
    document.querySelectorAll('[aria-label="Drop-ins"]').forEach(b => b.setAttribute('aria-pressed', String(enabled)))
  }
  requestDrop(object: string, at: V3 | null = null) { this.link?.sendCtl({ t: 'sim', v: 1, kind: 'drop', seq: ++this.seq, data: value({ object, at, name: this.dropName }) }) }
  private mountDropTray() {
    const tray = document.createElement('div'); tray.className = 'drop-tray'; tray.setAttribute('role', 'toolbar'); tray.setAttribute('aria-label', 'Drop objects')
    for (const object of this.drops.catalogue) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = object.name; b.dataset.drop = object.id
      b.onclick = () => { this.selectedDrop = object.id; tray.querySelectorAll('button[data-drop]').forEach(button => button.setAttribute('aria-pressed', String((button as HTMLElement).dataset.drop === object.id))); this.dropStatus!.textContent = 'Tap a spot, or drop near the player' }; tray.append(b)
    }
    const near = document.createElement('button'); near.type = 'button'; iconAction(near, 'position', 'Drop near the player'); near.onclick = () => { if (this.selectedDrop) this.requestDrop(this.selectedDrop) }; tray.append(near)
    const name = document.createElement('input'); name.placeholder = 'Name (optional)'; name.setAttribute('aria-label', 'Dropper name (optional)'); name.maxLength = 24; name.oninput = () => { this.dropName = name.value }; tray.append(name)
    this.dropStatus = document.createElement('small'); this.dropStatus.setAttribute('role', 'status'); tray.append(this.dropStatus)
    document.body.append(tray); this.tray = tray; this.renderDropState()
    const canvas = document.querySelector('canvas'), taps = new Map<number, { x: number; y: number; moved: boolean }>()
    canvas?.addEventListener('pointerdown', e => { if (taps.size) for (const tap of taps.values()) tap.moved = true; taps.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: taps.size > 0 }) })
    canvas?.addEventListener('pointermove', e => { const tap = taps.get(e.pointerId); if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 8) tap.moved = true })
    canvas?.addEventListener('pointercancel', e => taps.delete(e.pointerId))
    canvas?.addEventListener('pointerup', e => { const tap = taps.get(e.pointerId); taps.delete(e.pointerId); if (!tap || tap.moved || !this.selectedDrop || !this.drops.enabled) return; const at = this.pickDrop?.(e.clientX, e.clientY); if (at) { this.requestDrop(this.selectedDrop, at); this.selectedDrop = ''; tray.querySelectorAll('button[data-drop]').forEach(b => b.setAttribute('aria-pressed', 'false')) } })
  }
  private renderDropState() {
    if (!this.tray) return
    document.body.dataset.dropsEnabled = String(this.drops.enabled)
    this.tray.querySelectorAll<HTMLButtonElement>('button[data-drop], button[aria-label="Drop near the player"]').forEach(b => { b.disabled = !this.drops.enabled })
    document.querySelectorAll('[aria-label="Drop-ins"]').forEach(b => b.setAttribute('aria-pressed', String(this.drops.enabled)))
    if (this.dropStatus && !this.drops.enabled) this.dropStatus.textContent = 'Drop-ins off'
  }
  private draw() {
    const recent = Object.values(this.guest ? this.credits : Object.fromEntries(this.drops.live)).filter(c => c.who).at(-1)
    this.credit.hidden = !recent
    if (recent) { this.credit.textContent = recent.name ? `${recent.name} dropped an object` : 'A watcher dropped an object'; this.credit.style.setProperty('--dot', recent.color) }
    for (const [id, mesh] of this.meshes) if (!this.world.bodies.some(b => b.id === id)) { mesh.removeFromParent(); mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); this.meshes.delete(id) }
    for (const b of this.world.bodies) {
      let m = this.meshes.get(b.id)
      if (!m) {
        // Bound props already have their own models.
        const geometry = b.kind === 'cone' ? new ConeGeometry(b.r, b.r * 2, 16) : b.kind === 'ball' ? new SphereGeometry(b.r, 16, 10) : new BoxGeometry(b.r * 1.5, b.r * 1.5, b.r * 1.5)
        m = new Mesh(geometry, new MeshStandardMaterial({ color: b.kind === 'cone' ? '#ee8f47' : '#79b9be', roughness: 0.65 }))
        m.name = b.id; m.castShadow = true; this.group.add(m); this.meshes.set(b.id, m)
      }
      m.position.set(...b.p)
      m.visible = !b.bound || !!b.rendered && (!b.guestOnly || this.guest)
      const credit = this.guest ? this.credits[b.id] : this.drops.live.get(b.id)
      if (credit) (m.material as MeshStandardMaterial).color.set(credit.color)
    }
    for (const [id, g] of this.avatars) g.visible = this.people.has(id) && id !== this.id && !!this.people.get(id)?.active && !this.people.get(id)?.phone
    for (const p of this.people.values()) {
      if (p.id === this.id || !p.active || p.phone) continue
      let g = this.avatars.get(p.id)
      if (!g) {
        g = new Group()
        const mat = new MeshBasicMaterial({ color: p.color })
        g.add(new Mesh(new SphereGeometry(0.09, 12, 8), mat))
        for (let n = 0; n < 2; n++) {
          const hand = new Mesh(new BoxGeometry(0.045, 0.025, 0.075), mat)
          g.add(hand)
        }
        this.avatars.set(p.id, g); this.group.add(g)
      }
      g.visible = true
      ;[p.head, ...p.hands].forEach((pose, n) => { g!.children[n].position.set(...pose.p); g!.children[n].quaternion.set(...pose.q) })
      g.children[1].visible = !!p.hands[0]; g.children[2].visible = !!p.hands[1]
    }
  }
  /** Phone controls retain their normal device claim; a separate prop hold uses its ride frame. */
  phone(who: string, ride: string, grab: boolean, offset: V3 = [0, 0, -0.7]) {
    const r = this.adapter.rides().find(x => x.id === ride)
    if (!r) return
    const pose = r.pose(), hand = new Vector3(...offset).applyQuaternion(pose.q).add(pose.p)
    this.accept(who, this.remote?.participants.find(p => p.id === who)?.color ?? '#b3a4ff', { ride, active: true, head: { p: pose.p.toArray() as V3, q: pose.q.toArray() }, hands: [{ p: hand.toArray() as V3, q: pose.q.toArray() }], grab, pad: null }, performance.now())
    const person = this.people.get(who)
    if (person) person.phone = true
  }
  neutralPad() { return emptyPad() }
}
