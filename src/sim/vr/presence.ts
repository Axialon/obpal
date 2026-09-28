import { DeviceLink, emptyPad, parsePairing, validSimMessage, type SimMessage, type SimValue, type PadState } from '@obpal/core'
import type { Remote } from '@obpal/host'
import { ConeGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, SphereGeometry, BoxGeometry, Vector3, Quaternion } from 'three'
import type { Ride } from './rigs'
import { PropWorld, validVector, distance, type Body, type Collider, type V3 } from './world'

export interface Pose { p: V3; q: [number, number, number, number] }
export interface PresenceInput { ride: string; active: boolean; head: Pose; hands: Pose[]; grab: boolean; pad: PadState | null }
export interface Person extends PresenceInput { id: string; color: string; phone?: boolean }
export interface SceneAdapter { capture(): SimValue; apply(state: SimValue): void; rides(): Ride[]; colliders?(): Collider[]; drive?(who: string, ride: string, pad: PadState): void; allowed?(who: string): boolean }
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
  readonly guest = new URLSearchParams(location.search).get('join') === '1'
  readonly world = new PropWorld()
  readonly group = new Group()
  readonly people = new Map<string, Person>()
  id = 'host'
  status = 'Local scene'
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
    this.group.name = 'shared-presence'
    if (this.guest) {
      const key = `obpal.scene:${location.pathname}${location.search.replace(/[?&]test=vr/g, '')}`
      let fragment = location.hash
      try { if (fragment) sessionStorage.setItem(key, fragment); else fragment = sessionStorage.getItem(key) ?? '' } catch { /* private storage */ }
      const pairing = parsePairing(fragment)
      history.replaceState(null, '', location.pathname + location.search)
      if (!pairing) { this.status = 'Open a fresh shared scene link'; return }
      this.link = new DeviceLink({ pairing, service: location.origin, name: 'Scene visitor', caps: () => ({ tier: 0, sensorApi: 'none', haptics: 'none', platform: 'scene' }) })
      this.link.on('message', m => {
        if (m.t === 'scene') this.id = m.you
        if (m.t === 'sim' && m.kind === 'frame' && validSimMessage(m) && m.seq > this.frames) {
          const d = m.data as unknown as { state: SimValue; bodies: Body[]; people: Person[]; colors: (string | null)[] }
          if (!d || !Array.isArray(d.bodies) || !Array.isArray(d.people) || !Array.isArray(d.colors)) return
          this.frames = m.seq
          this.adapter.apply(d.state)
          this.world.bodies.splice(0, this.world.bodies.length, ...d.bodies)
          this.people.clear()
          d.people.filter(validPresence).forEach(p => this.people.set(p.id, p))
          this.colors = d.colors
          this.status = 'Shared scene'
        }
      })
      this.link.on('status', s => {
        this.status = s === 'connected' ? 'Waiting for the scene' : s
        if (s === 'connected') { this.frames = -1; this.link!.sendCtl({ t: 'sim', v: 1, kind: 'watch', seq: ++this.seq, data: null }); this.joinedAt = performance.now() }
        else { this.people.clear(); this.world.bodies.forEach(b => { b.owner = null }); }
      })
      void this.link.start()
      addEventListener('pagehide', () => this.link?.close(), { once: true })
    }
  }
  connect(remote: Remote) {
    this.remote = remote
    remote.on('sim', (m, who) => {
      if (m.kind === 'watch') { this.subscribers.set(who.id, { seq: -1, at: performance.now() }); return }
      const peer = this.subscribers.get(who.id)
      if (!peer || m.seq <= peer.seq || !validPresence(m.data)) return
      peer.seq = m.seq; peer.at = performance.now()
      this.accept(who.id, who.color, m.data, peer.at)
    })
    remote.on('leave', who => { this.subscribers.delete(who.id); this.people.delete(who.id); this.previousGrab.delete(who.id); this.world.release(who.id, false) })
  }
  isVisitor(who: string) { return this.subscribers.has(who) }
  /** Use the arm scene's existing stop channel; watching never grants permission to resume or drive. */
  stopArms() { this.link?.sendCtl({ t: 'btn', id: 'estop', ev: 'tap' }) }
  shareUrl() {
    if (!this.remote) return ''
    const url = new URL(location.href)
    url.searchParams.delete('test'); url.searchParams.set('join', '1')
    url.hash = new URL(this.remote.pairingUrl).hash
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
      for (const [id, s] of this.subscribers) if (now - s.at > 750) { this.people.delete(id); this.world.release(id, false) }
      this.world.step(dt, now, this.adapter.colliders?.() ?? [])
    }
    if (now - this.sent >= 50) {
      this.sent = now
      if (this.guest && this.lastInput) this.link?.sendCtl({ t: 'sim', v: 1, kind: 'input', seq: ++this.seq, data: value(this.lastInput) })
      if (!this.guest && this.subscribers.size) {
        const msg: SimMessage = { t: 'sim', v: 1, kind: 'frame', seq: ++this.seq, data: value({ state: this.adapter.capture(), bodies: this.world.bodies, people: [...this.people.values()], colors: this.colors }) }
        for (const id of this.subscribers.keys()) this.remote?.sendSim(msg, id)
      }
    }
    if (this.guest && this.frames < 0 && this.joinedAt && now - this.joinedAt > 5000) this.status = 'Waiting for a compatible host'
    this.draw()
  }
  private draw() {
    for (const b of this.world.bodies) {
      let m = this.meshes.get(b.id)
      if (!m) {
        // Bound props already have their own models.
        const geometry = b.kind === 'cone' ? new ConeGeometry(b.r, b.r * 2, 16) : b.kind === 'ball' ? new SphereGeometry(b.r, 16, 10) : new BoxGeometry(b.r * 1.5, b.r * 1.5, b.r * 1.5)
        m = new Mesh(geometry, new MeshStandardMaterial({ color: b.kind === 'cone' ? '#ee8f47' : '#79b9be', roughness: 0.65 }))
        m.name = b.id; m.castShadow = true; this.group.add(m); this.meshes.set(b.id, m)
      }
      m.position.set(...b.p)
      m.visible = !b.bound
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
