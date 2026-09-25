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

interface Pose { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }
interface Live { base: Pose; user: number; hl: number; hlTarget: number }
/** One object in the scene: its loaded root, the group that places it, and what describes it. */
interface Model { wrap: THREE.Object3D; engine: string | null; name: string; links: Map<string, Set<string>>; tradeoff: Tradeoff | null }

/** Picks, describes and manipulates the objects in the viewer and their parts. */
export class Parts {
  hovered: Part | null = null
  selected: Part | null = null
  private models = new Map<THREE.Object3D, Model>()
  private live = new Map<THREE.Object3D, Live>()
  private raycaster = new THREE.Raycaster()
  private halo: THREE.Mesh
  /** Part halo, and a finer one for whole objects (a ring that size would read as a band). */
  private rings = { part: new THREE.RingGeometry(0.9, 1, 96), object: new THREE.RingGeometry(0.975, 1, 160) }
  private haloOpacity = 0
  private card: HTMLElement
  private cardPos = new THREE.Vector2(-9999, -9999)
  private cardShown = false
  private tmpV = new THREE.Vector3()
  private tmpQ = new THREE.Quaternion()
  private shown: Part | null = null

  constructor(private camera: THREE.PerspectiveCamera, scene: THREE.Scene, private hooks: { changed: (hover: Part | null, sel: Part | null) => void }) {
    this.raycaster.params.Line = { threshold: 0.015 }
    this.raycaster.params.Points = { threshold: 0.015 }
    this.halo = new THREE.Mesh(
      this.rings.part,
      new THREE.MeshBasicMaterial({ color: '#c6ff34', transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide }),
    )
    this.halo.renderOrder = 999
    this.halo.visible = false
    scene.add(this.halo)
    this.card = document.createElement('div')
    this.card.className = 'node-card glass'
    this.card.setAttribute('role', 'status')
    this.card.innerHTML = '<div class="nc-head"><span class="nc-dot"></span><strong class="nc-title"></strong><button class="nc-x" aria-label="Release part">×</button></div><div class="nc-rows"></div><div class="nc-range" hidden><i></i></div><div class="nc-foot"></div>'
    this.card.querySelector<HTMLButtonElement>('.nc-x')!.onclick = () => this.select(null)
    document.body.appendChild(this.card)
  }

  setAccent(hex: string) {
    ;(this.halo.material as THREE.MeshBasicMaterial).color.set(hex)
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
    if (this.selected?.root === root) this.select(null)
    if (this.hovered?.root === root) { this.hovered = null; this.hooks.changed(null, this.selected) }
    for (const o of [...this.live.keys()]) if (inside(o, m.wrap)) this.live.delete(o)
    this.models.delete(root)
  }

  clear() {
    this.select(null)
    this.hover(null, null)
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

  /** Pick at screen coordinates (CSS px); null clears the hover. */
  hover(x: number | null, y: number | null) {
    let next: Part | null = null
    if (x != null && y != null && this.models.size) {
      const ndc = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1)
      this.raycaster.setFromCamera(ndc, this.camera)
      const hit = this.raycaster.intersectObjects([...this.models.keys()], true).find((h) => (h.object as THREE.Mesh).isMesh)
      if (hit) next = this.resolve(hit.object)
    }
    if (next?.object === this.hovered?.object && next?.kind === this.hovered?.kind) return
    if (this.hovered && this.hovered.object !== this.selected?.object) this.state(this.hovered.object).hlTarget = 1
    this.hovered = next
    if (next?.movable) this.state(next.object).hlTarget = 1.1
    this.hooks.changed(this.hovered, this.selected)
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

  selectHovered(): boolean {
    if (!this.hovered) return false
    this.select(this.hovered)
    return true
  }

  /**
   * Pick what's under the cursor, stepping between a part and its whole object: the first pick selects the
   * part, picking the selected part again selects the whole object, and again goes back to the part.
   */
  pick(): boolean {
    const h = this.hovered
    if (!h?.movable) return false
    const sel = this.selected
    if (sel?.kind === 'object' && sel.root === h.root) this.select(h)
    else if (sel?.object === h.object) this.select(this.objectPart(h.root))
    else this.select(h)
    return true
  }

  /** Whether dragging from the hovered part moves the current selection (the part itself, or its whole object). */
  holdsHovered(): boolean {
    const h = this.hovered
    const sel = this.selected
    return !!h && !!sel && (sel.object === h.object || (sel.kind === 'object' && sel.root === h.root))
  }

  select(part: Part | null) {
    if (this.selected && this.selected.object !== part?.object) this.state(this.selected.object).hlTarget = this.selected.object === this.hovered?.object ? 1.1 : 1
    this.selected = part
    // A whole object is marked by the halo alone: growing it would shove its neighbours.
    if (part?.movable) this.state(part.object).hlTarget = part.kind === 'object' ? 1 : 1.14
    this.card.classList.toggle('pinned', !!part)
    this.hooks.changed(this.hovered, this.selected)
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

  /** Move the selected part in the view plane by screen pixels. */
  move(dx: number, dy: number) {
    const part = this.selected
    if (!part?.movable || (!dx && !dy)) return
    if (this.live_(part)) { this.tradeoffOf(part)!.nudge(part.key!, dx, dy, this.camera); return }
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
  }

  /** Scale the selected part by 2^log2 (pinch). */
  scaleBy(log2: number) {
    if (!this.selected?.movable || !log2 || this.live_(this.selected)) return
    const s = this.state(this.selected.object)
    s.user = THREE.MathUtils.clamp(s.user * Math.pow(2, log2), 0.3, 4)
  }

  /** Rotate the selected part by a world-space rotation. */
  rotateWorld(q: THREE.Quaternion) {
    const o = this.selected?.movable && !this.live_(this.selected) ? this.selected.object : null
    if (!o) return
    const pw = o.parent!.getWorldQuaternion(this.tmpQ)
    const local = pw.clone().invert().multiply(q).multiply(pw)
    o.quaternion.premultiply(local)
  }

  /** Twist the selected part about the view axis (degrees, + = clockwise on screen). */
  twist(deg: number) {
    if (!deg) return
    const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion)
    this.rotateWorld(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(-deg)))
  }

  /** A pillar whose position is its value (a live trade-off model). */
  live_(part: Part | null | undefined): boolean {
    return part?.kind === 'pillar' && !!this.tradeoffOf(part)?.has(part.key)
  }

  /** Re-render the detail card (values changed while it's open). */
  refreshCard() {
    if (this.shown) this.fill(this.shown)
  }

  resetSelected() {
    const sel = this.selected
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
    const sel = this.selected
    const showHalo = !!sel?.movable
    this.haloOpacity += ((showHalo ? 0.9 : 0) - this.haloOpacity) * k
    ;(this.halo.material as THREE.MeshBasicMaterial).opacity = this.haloOpacity
    this.halo.visible = this.haloOpacity > 0.02
    if (sel && this.halo.visible) {
      const sphere = new THREE.Box3().setFromObject(sel.object).getBoundingSphere(new THREE.Sphere())
      this.halo.position.copy(sphere.center)
      this.halo.quaternion.copy(this.camera.quaternion)
      this.halo.geometry = sel.kind === 'object' ? this.rings.object : this.rings.part
      this.halo.scale.setScalar(Math.max(0.08, sphere.radius * (sel.kind === 'object' ? 1.04 : 1.35)))
    }
    const part = sel ?? this.hovered
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
    rows.innerHTML = ''
    for (const [k, v] of part.rows) {
      const r = document.createElement('div')
      r.className = 'nc-row'
      r.innerHTML = '<span></span><b></b>'
      r.querySelector('span')!.textContent = k
      r.querySelector('b')!.textContent = v
      rows.appendChild(r)
    }
    const range = this.card.querySelector<HTMLElement>('.nc-range')!
    range.hidden = !part.range && !live
    if (live) range.querySelector('i')!.style.left = `${live.fraction * 100}%`
    else if (part.range) {
      const { def, min, max } = part.range.pillar
      const t = max > min * 50 && min > 0 ? Math.log(def / min) / Math.log(max / min) : (def - min) / (max - min || 1)
      range.querySelector('i')!.style.left = `${Math.max(0, Math.min(1, t)) * 100}%`
    }
    this.card.querySelector('.nc-foot')!.textContent = part.related?.join(' · ') ?? ''
  }
}
