import { setMarkup, html } from '../ui/markup'
import * as THREE from 'three'
import { PILLARS, type Pillar } from './pillars'
import { formatValue, type Tradeoff } from './tradeoff'

export type PartKind = 'object' | 'pillar' | 'submodule' | 'link' | 'part'

export interface Part {
  /** The object that moves when the part is manipulated. */
  object: THREE.Object3D
  kind: PartKind
  title: string
  rows: [string, string][]
  range?: { pillar: Pillar }
  related?: string[]
  /** Parts that can be picked up and moved (links are informational). */
  movable: boolean
  /** Pillar key, for pillar parts. */
  key?: string
  /** The scene object this part belongs to (the loaded model's root). */
  root: THREE.Object3D
}

/** Catalogue item -> Blackboxes engine whose pillar definitions describe it. */
export const ENGINE_OF: Record<string, string> = {
  boxem: 'boxem', orbitem: 'orbitem', pulseem: 'pulseem', capem: 'capem', synthem: 'synthem', balancem: 'balancem',
  cost: 'boxem', quality: 'boxem', scope: 'boxem', time: 'boxem',
  aerospace: 'boxem', architecture: 'boxem', biomedical: 'boxem', vfx: 'boxem', software: 'boxem',
}

const meaningful = (n: string) => !!n && !/^(object|mesh|node|group|scene|root)?[_ .-]?\d*$/i.test(n) && !/^[0-9a-f-]{16,}$/i.test(n)
const humanize = (n: string) => n.replace(/^node-/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase())
const fmt = (v: number) => (Math.abs(v) >= 10000 ? v.toLocaleString('en', { maximumFractionDigits: 0 }) : v.toLocaleString('en', { maximumFractionDigits: 2 }))
const inside = (o: THREE.Object3D, ancestor: THREE.Object3D) => { for (let a: THREE.Object3D | null = o; a; a = a.parent) if (a === ancestor) return true; return false }

/**
 * Who hovers and holds parts: the screen's own mouse (id "host") or a participant of a shared scene (CATALOGUE §5).
 * A part is held by one hand at a time.
 */
export interface Hand {
  readonly id: string
  color: string
  hovered: Part | null
  selected: Part | null
  halo: THREE.Mesh
  haloOpacity: number
  /** 1 when control just changed (taken, handed over, let go), easing to 0: the halo pops, then settles. */
  flash: number
  /** The part this hand just let go of: its halo lingers there while it fades. */
  fade: Part | null
  /** 1 while the hand's device is turning or moving what it holds. */
  busy: number
}

interface Pose { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }
interface Live { base: Pose; user: number; hl: number; hlTarget: number }
/** One object in the scene: its loaded root, the group that places it, and what describes it. */
interface Model { wrap: THREE.Object3D; engine: string | null; name: string; links: Map<string, Set<string>>; tradeoff: Tradeoff | null }

/** Picks, describes and manipulates the objects in the viewer and their parts. */
export class Parts {
  /** The screen's own hand (the mouse). hovered / selected below are its. */
  readonly host: Hand
  private hands = new Map<string, Hand>()
  private models = new Map<THREE.Object3D, Model>()
  private live = new Map<THREE.Object3D, Live>()
  private raycaster = new THREE.Raycaster()
  /** Part halo, and a finer one for whole objects (a ring that size would read as a band). */
  private rings = { part: new THREE.RingGeometry(0.9, 1, 96), object: new THREE.RingGeometry(0.975, 1, 160), shared: new THREE.RingGeometry(0.955, 1, 128) }
  private card: HTMLElement
  /** The hand whose part the card shows: the screen's own, else whoever picked something last. */
  private cardHand: Hand
  private cardPos = new THREE.Vector2(-9999, -9999)
  private cardShown = false
  private tmpV = new THREE.Vector3()
  private tmpQ = new THREE.Quaternion()
  private shown: Part | null = null

  constructor(
    private camera: THREE.PerspectiveCamera,
    private scene: THREE.Scene,
    private hooks: {
      /** A hand's hover or selection changed. */
      changed: (hand: Hand) => void
      /** The screen took a part a participant was holding. */
      taken?: (from: Hand, part: Part) => void
    },
  ) {
    this.raycaster.params.Line = { threshold: 0.015 }
    this.raycaster.params.Points = { threshold: 0.015 }
    this.host = this.hand('host', '#c6ff34')
    this.cardHand = this.host
    this.card = document.createElement('div')
    this.card.className = 'node-card glass'
    this.card.setAttribute('role', 'status')
    setMarkup(this.card, html`<div class="nc-head"><span class="nc-dot"></span><strong class="nc-title"></strong><button class="nc-x" aria-label="Release part">×</button></div><div class="nc-rows"></div><div class="nc-range bb-meter" hidden><i></i></div><div class="nc-foot"></div>`)
    this.card.querySelector<HTMLButtonElement>('.nc-x')!.onclick = () => this.select(null, this.cardHand)
    document.body.appendChild(this.card)
  }

  /** The screen's hover and selection (the mouse). */
  get hovered() { return this.host.hovered }
  get selected() { return this.host.selected }

  /** A hand, created on first use: `host` for the mouse, or a participant's id. */
  hand(id: string, color?: string): Hand {
    let h = this.hands.get(id)
    if (!h) {
      const halo = new THREE.Mesh(
        this.rings.part,
        new THREE.MeshBasicMaterial({ color: color ?? '#c6ff34', transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
      )
      halo.renderOrder = 999
      halo.visible = false
      halo.name = `selection-${id}`
      this.scene.add(halo)
      h = { id, color: color ?? '#c6ff34', hovered: null, selected: null, halo, haloOpacity: 0, flash: 0, fade: null, busy: 0 }
      this.hands.set(id, h)
    } else if (color && color !== h.color) this.recolor(h, color)
    return h
  }

  /** A participant left: let go of what it held and remove its halo. */
  dropHand(id: string) {
    const h = this.hands.get(id)
    if (!h || h === this.host) return
    this.select(null, h)
    this.hover(null, null, h)
    this.scene.remove(h.halo)
    ;(h.halo.material as THREE.Material).dispose()
    this.hands.delete(id)
    if (this.cardHand === h) this.cardHand = this.host
  }

  /** A hand's device is driving what it holds this frame: its halo brightens. */
  active(h: Hand) { h.busy = 1 }

  /** Every hand holding something, the screen's included. */
  holders(): Hand[] { return [...this.hands.values()].filter((h) => h.selected) }

  /** The hand holding this part's object, if any. */
  holderOf(part: Part | null | undefined): Hand | null {
    if (!part) return null
    for (const h of this.hands.values()) if (h.selected?.object === part.object) return h
    return null
  }

  private recolor(h: Hand, color: string) {
    h.color = color
    ;(h.halo.material as THREE.MeshBasicMaterial).color.set(color)
  }

  setAccent(hex: string) {
    this.recolor(this.host, hex)
  }

  // ---- the scene's objects ----------------------------------------------------------------------------------

  /** Index an object added to the scene: `root` is the loaded model, `wrap` the group that places it. */
  add(root: THREE.Object3D, wrap: THREE.Object3D, itemId: string | null, name: string) {
    const links = new Map<string, Set<string>>()
    root.traverse((o) => {
      const u = o.userData as { k1?: string; k2?: string }
      if (u?.k1 && u?.k2) {
        if (!links.has(u.k1)) links.set(u.k1, new Set())
        if (!links.has(u.k2)) links.set(u.k2, new Set())
        links.get(u.k1)!.add(u.k2)
        links.get(u.k2)!.add(u.k1)
      }
    })
    this.models.set(root, { wrap, engine: itemId ? ENGINE_OF[itemId] ?? null : null, name, links, tradeoff: null })
  }

  /** Forget an object that left the scene. */
  remove(root: THREE.Object3D) {
    const m = this.models.get(root)
    if (!m) return
    for (const h of this.hands.values()) {
      if (h.selected?.root === root) this.select(null, h)
      if (h.hovered?.root === root) { h.hovered = null; this.hooks.changed(h) }
      if (h.fade?.root === root) {
        h.fade = null
        h.flash = h.haloOpacity = h.busy = 0
        h.halo.visible = false
      }
    }
    for (const o of [...this.live.keys()]) if (inside(o, m.wrap)) this.live.delete(o)
    this.models.delete(root)
  }

  clear() {
    for (const h of this.hands.values()) { this.select(null, h); this.hover(null, null, h) }
    this.live.clear()
    this.models.clear()
  }

  /** The live trade-off model of an object (a Blackboxes engine), once it is attached. */
  setTradeoff(root: THREE.Object3D, t: Tradeoff | null) {
    const m = this.models.get(root)
    if (m) m.tradeoff = t
  }

  tradeoffOf(part: Part | null | undefined): Tradeoff | null {
    return part ? this.models.get(part.root)?.tradeoff ?? null : null
  }

  /** A whole object as a part of its own: select it to move, turn or scale all of it. */
  objectPart(root: THREE.Object3D): Part | null {
    const m = this.models.get(root)
    if (!m) return null
    return { object: m.wrap, kind: 'object', title: m.name, rows: [], related: [m.tradeoff ? 'Live trade-off model' : 'Whole object'], movable: true, root }
  }

  /**
   * What a device can claim from its scene list: each object, then its semantic parts (engine pillars and submodules),
   * or for a plain model its named top-level parts.
   */
  listable(limit = 48): Part[] {
    const out: Part[] = []
    for (const [root, m] of this.models) {
      if (out.length >= limit) break
      const whole = this.objectPart(root)
      if (whole) out.push(whole)
      const seen = new Set<THREE.Object3D>()
      root.traverse((o) => {
        const u = o.userData as { pillarKey?: unknown; isSubmodule?: boolean }
        if (out.length >= limit || (typeof u?.pillarKey !== 'string' && !u?.isSubmodule)) return
        const p = this.resolve(o)
        if (p?.movable && !seen.has(p.object)) { seen.add(p.object); out.push(p) }
      })
      if (!seen.size) {
        for (const c of root.children) {
          if (out.length >= limit) break
          if (meaningful(c.name)) out.push({ object: c, kind: 'part', title: humanize(c.name), rows: [], related: [m.name], movable: true, root })
        }
      }
    }
    return out
  }

  /** The object a part belongs to, by name (the scene list's grouping). */
  groupOf(part: Part): string { return this.models.get(part.root)?.name ?? '' }

  /** Forget an object's resting pose after the scene moved it, so a reset returns it to the new place. */
  rebase(o: THREE.Object3D) {
    this.live.delete(o)
  }

  private pillarLabel(m: Model, key: string) {
    return (m.engine && PILLARS[m.engine]?.[key]?.label) || humanize(key)
  }

  private rootOf(o: THREE.Object3D | null): THREE.Object3D | null {
    for (; o; o = o.parent) if (this.models.has(o)) return o
    return null
  }

  private resolve(hit: THREE.Object3D): Part | null {
    const root = this.rootOf(hit)
    if (!root) return null
    const m = this.models.get(root)!
    for (let o: THREE.Object3D | null = hit; o && o !== root; o = o.parent) {
      const u = o.userData as Record<string, unknown>
      if (u?.isSubmodule) {
        const rows: [string, string][] = []
        if (u.category) rows.push(['Category', String(u.category)])
        if (u.tier) rows.push(['Tier', String(u.tier)])
        if (typeof u.costShare === 'number') rows.push(['Cost share', fmt(u.costShare)])
        return { object: o, kind: 'submodule', title: String(u.name ?? 'Submodule'), rows, movable: true, related: [u.status === 'active' || u.isActive ? 'Active in this scenario' : 'Inactive'], root }
      }
      if (typeof u?.pillarKey === 'string') {
        let node: THREE.Object3D = o
        for (let a: THREE.Object3D | null = o; a && a !== root; a = a.parent) if ((a.userData as { isNode?: boolean }).isNode) { node = a; break }
        const key = u.pillarKey
        const pillar = m.engine ? PILLARS[m.engine]?.[key] : undefined
        const rows: [string, string][] = pillar ? [['Default', `${fmt(pillar.def)} ${pillar.unit}`], ['Range', `${fmt(pillar.min)} – ${fmt(pillar.max)}`]] : []
        const rel = [...(m.links.get(key) ?? [])].map((k) => this.pillarLabel(m, k))
        return { object: node, kind: 'pillar', key, title: this.pillarLabel(m, key), rows, range: pillar ? { pillar } : undefined, related: rel.length ? [`Trades off with ${rel.join(', ')}`] : undefined, movable: true, root }
      }
      if (typeof u?.k1 === 'string' && typeof u?.k2 === 'string') {
        return { object: o, kind: 'link', title: `${this.pillarLabel(m, u.k1)} ↔ ${this.pillarLabel(m, u.k2)}`, rows: [], related: ['Trade-off link'], movable: false, root }
      }
    }
    // A model that is a single mesh is its own only part.
    if (hit === root) return { object: root, kind: 'part', title: m.name, rows: [], related: ['Whole object'], movable: true, root }
    let top = hit
    while (top.parent && top.parent !== root) top = top.parent
    const name = meaningful(hit.name) ? hit.name : meaningful(top.name) ? top.name : ''
    return { object: top, kind: 'part', title: name ? humanize(name) : 'Part', rows: [], related: [m.name], movable: true, root }
  }

  // ---- picking and selection --------------------------------------------------------------------------------

  /** Pick at screen coordinates (CSS px) for a hand (the screen's by default); null clears its hover. */
  hover(x: number | null, y: number | null, h: Hand = this.host) {
    let next: Part | null = null
    if (x != null && y != null && this.models.size) {
      const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1)
      this.raycaster.setFromCamera(ndc, this.camera)
      const hit = this.raycaster.intersectObjects([...this.models.keys()], true).find((i) => (i.object as THREE.Mesh).isMesh)
      if (hit) next = this.resolve(hit.object)
    }
    if (next?.object === h.hovered?.object && next?.kind === h.hovered?.kind) return
    const was = h.hovered
    h.hovered = next
    if (was) this.settle(was.object)
    if (next) this.settle(next.object)
    this.hooks.changed(h)
  }

  /** An object's highlight from every hand: held (grown, or only haloed as a whole object), hovered, or resting. */
  private settle(o: THREE.Object3D) {
    let target = 1
    for (const h of this.hands.values()) {
      if (h.selected?.object === o && h.selected.movable) { target = h.selected.kind === 'object' ? 1 : 1.14; break }
      if (h.hovered?.object === o && h.hovered.movable) target = 1.1
    }
    this.state(o).hlTarget = target
  }

  /** Screen position of the nearest movable semantic part within radius (aim assist for gyro pointing). */
  magnet(x: number, y: number, radius = 56): THREE.Vector2 | null {
    let best: THREE.Vector2 | null = null
    let bestD = radius
    for (const root of this.models.keys()) {
      root.traverse((o) => {
        const u = o.userData as { isNode?: boolean; isSubmodule?: boolean }
        if (!u?.isNode && !u?.isSubmodule) return
        const p = this.project(o)
        const d = Math.hypot(p.x - x, p.y - y)
        if (d < bestD) { bestD = d; best = p }
      })
    }
    return best
  }

  selectHovered(h: Hand = this.host): boolean {
    if (!h.hovered) return false
    return this.select(h.hovered, h)
  }

  /**
   * Pick what's under a hand's cursor, stepping between a part and its whole object: the first pick selects the
   * part, picking the selected part again selects the whole object, and again goes back to the part. 'held': someone
   * else holds it (only the screen can take a part back).
   */
  pickFor(h: Hand = this.host): 'picked' | 'held' | 'none' {
    const hov = h.hovered
    if (!hov?.movable) return 'none'
    const sel = h.selected
    const next = sel?.kind === 'object' && sel.root === hov.root ? hov : sel?.object === hov.object ? this.objectPart(hov.root) : hov
    return this.select(next, h) ? 'picked' : 'held'
  }

  pick(h: Hand = this.host): boolean { return this.pickFor(h) !== 'none' }

  /** Whether dragging from the hovered part moves the hand's selection (the part itself, or its whole object). */
  holdsHovered(h: Hand = this.host): boolean {
    const hov = h.hovered
    const sel = h.selected
    return !!hov && !!sel && (sel.object === hov.object || (sel.kind === 'object' && sel.root === hov.root))
  }

  /**
   * Select a part for a hand (null lets go). A part another hand holds is refused (false), except for the screen,
   * which takes it back. A whole object is marked by the halo alone: growing it would shove its neighbours.
   */
  select(part: Part | null, h: Hand = this.host): boolean {
    const holder = this.holderOf(part)
    if (part && holder && holder !== h) {
      if (h !== this.host) return false
      const lost = holder.selected!
      holder.selected = null
      holder.flash = 1
      holder.fade = lost
      this.hooks.changed(holder)
      this.hooks.taken?.(holder, lost)
    }
    const was = h.selected
    h.selected = part
    // A change of control shows: the new halo pops in, and a released one flashes and lingers as it fades.
    if (was?.object !== part?.object) {
      h.flash = 1
      h.fade = part ? null : was?.movable ? was : null
    }
    if (was && was.object !== part?.object) this.settle(was.object)
    if (part) this.settle(part.object)
    if (part) this.cardHand = h
    else if (this.cardHand === h) this.cardHand = this.holders()[0] ?? this.host
    this.card.classList.toggle('pinned', !!this.cardHand.selected)
    this.hooks.changed(h)
    return true
  }

  private state(o: THREE.Object3D): Live {
    let s = this.live.get(o)
    if (!s) {
      s = { base: { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }, user: 1, hl: 1, hlTarget: 1 }
      this.live.set(o, s)
    }
    return s
  }

  private project(o: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(o)
    box.getCenter(this.tmpV)
    this.tmpV.project(this.camera)
    return new THREE.Vector2((this.tmpV.x + 1) / 2 * innerWidth, (1 - this.tmpV.y) / 2 * innerHeight)
  }

  // ---- manipulation -----------------------------------------------------------------------------------------

  /** Move a hand's selected part in the view plane by screen pixels. Returns whether anything changed (a live value snaps to its steps). */
  move(dx: number, dy: number, h: Hand = this.host): boolean {
    const part = h.selected
    if (!part?.movable || (!dx && !dy)) return false
    if (this.live_(part)) return this.tradeoffOf(part)!.nudge(part.key!, dx, dy, this.camera)
    const o = part.object
    const center = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3())
    const dist = center.distanceTo(this.camera.position)
    const perPx = (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / innerHeight
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion)
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion)
    const target = center.clone().addScaledVector(right, dx * perPx).addScaledVector(up, -dy * perPx)
    const parent = o.parent!
    const a = parent.worldToLocal(center.clone())
    const b = parent.worldToLocal(target)
    o.position.add(b.sub(a))
    return true
  }

  /** Scale a hand's selected part by 2^log2 (pinch). */
  scaleBy(log2: number, h: Hand = this.host) {
    if (!h.selected?.movable || !log2 || this.live_(h.selected)) return
    const s = this.state(h.selected.object)
    s.user = THREE.MathUtils.clamp(s.user * Math.pow(2, log2), 0.3, 4)
  }

  /** Rotate a hand's selected part by a world-space rotation. */
  rotateWorld(q: THREE.Quaternion, h: Hand = this.host) {
    const o = h.selected?.movable && !this.live_(h.selected) ? h.selected.object : null
    if (!o) return
    const pw = o.parent!.getWorldQuaternion(this.tmpQ)
    const local = pw.clone().invert().multiply(q).multiply(pw)
    o.quaternion.premultiply(local)
  }

  /** Twist a hand's selected part about the view axis (degrees, + = clockwise on screen). */
  twist(deg: number, h: Hand = this.host) {
    if (!deg) return
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion)
    this.rotateWorld(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(-deg)), h)
  }

  /** A pillar whose position is its value (a live trade-off model). */
  live_(part: Part | null | undefined): boolean {
    return part?.kind === 'pillar' && !!this.tradeoffOf(part)?.has(part.key)
  }

  /** Re-render the detail card (values changed while it's open). */
  refreshCard() {
    if (this.shown) this.fill(this.shown)
  }

  resetSelected(h: Hand = this.host) {
    const sel = h.selected
    if (this.live_(sel)) { this.tradeoffOf(sel)!.reset(sel!.key); return }
    const o = sel?.object
    if (!o) return
    const s = this.state(o)
    o.position.copy(s.base.p)
    o.quaternion.copy(s.base.q)
    s.user = 1
  }

  /** Per-frame: highlight easing, halo, and the floating detail card. */
  update(dt: number) {
    const k = 1 - Math.exp(-dt * 14)
    for (const [o, s] of this.live) {
      s.hl += (s.hlTarget - s.hl) * k
      o.scale.copy(s.base.s).multiplyScalar(s.user * s.hl)
    }
    // One halo per hand, in its colour. In quickly; out slowly, flashing and widening as it goes.
    for (const h of this.hands.values()) {
      const sel = h.selected
      const shown = sel ?? h.fade
      h.flash = Math.max(0, h.flash - dt / 0.7)
      h.busy = Math.max(0, h.busy - dt / 0.3)
      h.haloOpacity += ((sel?.movable ? 0.9 : 0) - h.haloOpacity) * (sel ? k : 1 - Math.exp(-dt * 4.5))
      const opacity = Math.min(1, h.haloOpacity + 0.45 * h.flash + 0.1 * h.busy)
      ;(h.halo.material as THREE.MeshBasicMaterial).opacity = opacity
      h.halo.visible = !!shown && opacity > 0.02
      if (!sel && h.haloOpacity < 0.02 && h.flash <= 0) h.fade = null
      if (shown && h.halo.visible) {
        const sphere = new THREE.Box3().setFromObject(shown.object).getBoundingSphere(new THREE.Sphere())
        const sel = shown
        h.halo.position.copy(sphere.center)
        h.halo.quaternion.copy(this.camera.quaternion)
        // A participant's halo is finer and closer than the screen's own, so several holds don't crowd the model.
        const own = h === this.host
        h.halo.geometry = sel.kind === 'object' ? this.rings.object : own ? this.rings.part : this.rings.shared
        h.halo.scale.setScalar(Math.max(0.08, sphere.radius * (sel.kind === 'object' ? 1.04 : own ? 1.35 : 1.2) * (1 + 0.16 * h.flash)))
      }
    }
    const part = this.cardHand.selected ?? this.host.hovered
    if (!part) {
      if (this.cardShown) { this.card.classList.remove('in'); this.cardShown = false }
      return
    }
    if (!this.cardShown || this.shown?.object !== part.object || this.shown.kind !== part.kind) this.fill(part)
    const p = this.project(part.object)
    const sphere = new THREE.Box3().setFromObject(part.object).getBoundingSphere(new THREE.Sphere())
    const pxRadius = (sphere.radius / (sphere.center.distanceTo(this.camera.position) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) * (innerHeight / 2)
    const w = this.card.offsetWidth
    const h = this.card.offsetHeight
    let x = p.x + Math.min(pxRadius, 160) + 18
    if (x + w > innerWidth - 12) x = p.x - Math.min(pxRadius, 160) - 18 - w
    x = Math.min(innerWidth - w - 12, Math.max(12, x))
    const y = Math.min(innerHeight - h - 12, Math.max(84, p.y - h / 2))
    if (this.cardPos.x < -999) this.cardPos.set(x, y)
    this.cardPos.x += (x - this.cardPos.x) * k
    this.cardPos.y += (y - this.cardPos.y) * k
    this.card.style.transform = `translate3d(${this.cardPos.x.toFixed(1)}px, ${this.cardPos.y.toFixed(1)}px, 0)`
    if (!this.cardShown) { this.card.classList.add('in'); this.cardShown = true }
  }

  private fill(part: Part) {
    this.shown = part
    const live = this.live_(part) ? this.tradeoffOf(part)!.describe(part.key!) : null
    if (live) part = { ...part, rows: [['Now', live.text], ['Range', `${formatValue(live.min, live.unit)} – ${formatValue(live.max, live.unit)}`]] }
    this.card.dataset.for = part.title
    this.card.dataset.kind = part.kind
    this.card.querySelector('.nc-title')!.textContent = part.title
    const rows = this.card.querySelector('.nc-rows')!
    rows.replaceChildren()
    for (const [k, v] of part.rows) {
      const r = document.createElement('div')
      r.className = 'nc-row'
      setMarkup(r, html`<span></span><b></b>`)
      r.querySelector('span')!.textContent = k
      r.querySelector('b')!.textContent = v
      rows.appendChild(r)
    }
    const range = this.card.querySelector<HTMLElement>('.nc-range')!
    range.hidden = !part.range && !live
    // The meter fills up to its knob (the family's .bb-meter).
    if (live) range.style.setProperty('--fill', `${live.fraction * 100}%`)
    else if (part.range) {
      const { def, min, max } = part.range.pillar
      const t = max > min * 50 && min > 0 ? Math.log(def / min) / Math.log(max / min) : (def - min) / (max - min || 1)
      range.style.setProperty('--fill', `${Math.max(0, Math.min(1, t)) * 100}%`)
    }
    this.card.querySelector('.nc-foot')!.textContent = part.related?.join(' · ') ?? ''
  }
}
