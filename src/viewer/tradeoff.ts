/**
 * Live trade-off models. A Blackboxes engine model is a set of pillars on fixed axes: each pillar's distance from
 * the centre shows one input (time, budget, SLA, ...). Changing one pillar re-solves the model with the Blackboxes
 * solver, so the others move to keep the trade-off consistent. The links between pillars stretch with them and
 * the hull (one vertex per pillar) reshapes.
 *
 * Maths comes from the vendored Blackboxes runtime: model-core.js solves; spatial-drag.js maps a value to a
 * radius on a log curve anchored at the canonical default. This module is the three.js wiring for ob.Pal:
 * mouse drags and phone drags both arrive as screen deltas (nudge), and the phone's tilt as a rate (drive).
 */import { setMarkup, html } from '../ui/markup'

import * as THREE from 'three'
import { models, spatial, type Constraints, type VisualMapping } from '../vendor/blackboxes'
import { PILLARS } from './pillars'

interface Rig {
  key: string
  field: string
  node: THREE.Object3D
  dir: THREE.Vector3
  /** Model units per Blackboxes radius unit, calibrated so the model's authored pose is the default state. */
  scale: number
  radius: number
  target: number
  anchor: THREE.Object3D | null
  anchorRatio: number
  color: string
  label: string
  unit: string
  tag: HTMLElement
}
interface Link { obj: THREE.Object3D; a: string; b: string }
interface HullSlot { key: string; ratio: number }

/** Tag labels, as the engines print them on the model; the detail card keeps the full name. */
const SHORT: Record<string, string> = { cost: 'budget', quality: 'qual', complexity: 'ops', security: 'sec', autophagy: 'autoph', longevity: 'longev', resource: 'res', mobility: 'mob' }
const BOXEM_BOUNDS: Record<string, [string, string]> = { time: ['timeMin', 'timeMax'], cost: ['costMin', 'costMax'], quality: ['qualMin', 'qualMax'], scope: ['scopeMin', 'scopeMax'] }
const Y = new THREE.Vector3(0, 1, 0)
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

/** Compact, unit-aware value text for tags and cards. */
export function formatValue(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '—'
  const num = (x: number, d = 2) => (Math.abs(x) >= 1000 ? Math.round(x).toLocaleString('en') : Number(x.toFixed(Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : d)).toString())
  const money = (x: number) => (Math.abs(x) >= 1e6 ? `$${Number((x / 1e6).toFixed(2))}M` : `$${Math.round(x).toLocaleString('en')}`)
  switch (unit) {
    case 'USD': return money(v)
    case 'USD/month': return `${money(v)}/mo`
    case 'weeks': return `${num(v, 1)} wks`
    case 'months': return `${num(v, 1)} mo`
    case '%': return `${Math.abs(v) >= 99 && Math.abs(v) < 100 ? Number(v.toFixed(3)) : num(v, 1)}%`
    case 'ms': return `${Math.round(v)} ms`
    case 'seconds': return `${num(v, 2)} s`
    case 'dB': return `${num(v, 1)} dB`
    case 'ratio': return `×${v.toFixed(2)}`
    default: return /index$/.test(unit) ? num(v) : `${num(v)} ${unit}`
  }
}

export class Tradeoff {
  readonly engine: string
  state: Constraints
  private readonly initial: Constraints
  private rigs = new Map<string, Rig>()
  private links: Link[] = []
  private hull: { mesh: THREE.Mesh; geo: THREE.BufferGeometry; slots: HullSlot[] } | null = null
  private profile: { min: number; max: number }
  private dirty = true
  private tmp = new THREE.Vector3()
  private tmp2 = new THREE.Vector3()
  onChange: ((key: string) => void) | null = null

  /** A live model for this object, or null if it has no pillar nodes for a known engine. */
  static attach(root: THREE.Object3D, engine: string | null, overlay: HTMLElement): Tradeoff | null {
    if (!engine || !models?.definitions?.[engine]) return null
    const nodes: THREE.Object3D[] = []
    root.traverse((o) => { if (o.userData?.isNode && o.userData?.pillarKey) nodes.push(o) })
    const fields = models.definitions[engine].fields
    const usable = nodes.filter((n) => Object.values(fields).some((f) => f.pillar === n.userData.pillarKey) && n.position.lengthSq() > 1e-6)
    return usable.length >= 3 ? new Tradeoff(root, engine, usable, overlay) : null
  }

  private constructor(private root: THREE.Object3D, engine: string, nodes: THREE.Object3D[], private overlay: HTMLElement) {
    this.engine = engine
    this.state = models.defaults(engine)
    this.initial = JSON.parse(JSON.stringify(this.state))
    const p = spatial.radialProfile(engine, 'index')
    this.profile = { min: p.min, max: p.max }
    const fields = models.definitions[engine].fields
    const labels = PILLARS[engine] ?? {}
    for (const node of nodes) {
      const key = node.userData.pillarKey as string
      const field = Object.keys(fields).find((k) => fields[k].pillar === key)!
      const dir = node.position.clone().normalize()
      const r0 = node.position.length()
      const f0 = spatial.visualFraction(this.mapping(key, field), Number(this.state[field]))
      const tag = document.createElement('div')
      tag.className = 'to-tag'
      setMarkup(tag, html`<i></i><b></b><span></span>`)
      const color = pillarColor(node)
      tag.style.setProperty('--c', color)
      tag.querySelector('b')!.textContent = (SHORT[key] ?? key).toUpperCase()
      overlay.appendChild(tag)
      const radius = this.profile.min + (this.profile.max - this.profile.min) * f0
      this.rigs.set(key, { key, field, node, dir, scale: r0 / radius, radius, target: radius, anchor: null, anchorRatio: 1.36, color, label: labels[key]?.label ?? key, unit: fields[field].unit, tag })
    }
    this.findAnchors()
    this.findLinks()
    this.findHull()
    this.refreshTags()
  }

  // ---- queries ----------------------------------------------------------------------------------------------

  has(key: string | undefined | null): key is string { return !!key && this.rigs.has(key) }
  value(key: string) { const r = this.rigs.get(key); return r ? Number(this.state[r.field]) : NaN }
  describe(key: string) {
    const r = this.rigs.get(key)
    if (!r) return null
    const spec = models.definitions[this.engine].fields[r.field]
    return { label: r.label, value: this.value(key), text: formatValue(this.value(key), r.unit), min: spec.min, max: spec.max, unit: r.unit, color: r.color, fraction: spatial.visualFraction(this.mapping(key, r.field), this.value(key)) }
  }

  /** Highlight one pillar's tag (the selected or hovered pillar). */
  setFocus(key: string | null) {
    for (const r of this.rigs.values()) r.tag.classList.toggle('on', r.key === key)
  }

  // ---- edits ------------------------------------------------------------------------------------------------

  /** Set one pillar's value and re-solve; false (and nothing changes) if the model can't satisfy it. */
  set(key: string, value: number): boolean {
    const r = this.rigs.get(key)
    if (!r || !Number.isFinite(value)) return false
    const input = { ...this.state, [r.field]: value }
    let res = models.solve(this.engine, input, { changed: key })
    // The engine's default target can't always absorb the change (e.g. Box'em's scope floor needs more budget):
    // let the next pillar the engine allows take it instead.
    for (const target of res.valid ? [] : models.solveTargets(this.engine, key) ?? []) {
      res = models.solve(this.engine, input, { changed: key, solveFor: target })
      if (res.valid) break
    }
    if (!res.valid) return false
    this.state = res.constraints
    this.retarget()
    this.onChange?.(key)
    return true
  }

  /** Drag a pillar by a screen delta (px): movement along the pillar's on-screen axis changes its value. */
  nudge(key: string, dx: number, dy: number, camera: THREE.Camera): boolean {
    const r = this.rigs.get(key)
    if (!r || (!dx && !dy)) return false
    const map = this.mapping(key, r.field)
    const a = this.screen(r, 0, camera)
    const b = this.screen(r, 1, camera)
    let ax = b.x - a.x, ay = b.y - a.y
    let len = Math.hypot(ax, ay)
    // An axis pointing at the viewer has no on-screen length: fall back to "up = more".
    if (len < 24) { ax = 0; ay = -1; len = 180 } else { ax /= len; ay /= len }
    const f = clamp01(spatial.visualFraction(map, this.value(key)) + (dx * ax + dy * ay) / len)
    return this.set(key, spatial.visualValue(map, f))
  }

  /** Continuous change from the phone's tilt: rate in [-1, 1] sweeps the whole range in about 2.5 s. */
  drive(key: string, rate: number, dt: number): boolean {
    const r = this.rigs.get(key)
    if (!r || !rate || !(dt > 0)) return false
    const map = this.mapping(key, r.field)
    const f = clamp01(spatial.visualFraction(map, this.value(key)) + rate * dt * 0.4)
    return this.set(key, spatial.visualValue(map, f))
  }

  /** Back to the canonical default for one pillar (re-solved), or the whole model. */
  reset(key?: string) {
    if (key && this.rigs.has(key)) { this.set(key, Number(this.initial[this.rigs.get(key)!.field])); return }
    this.state = JSON.parse(JSON.stringify(this.initial))
    this.retarget()
    this.onChange?.('')
  }

  // ---- per frame --------------------------------------------------------------------------------------------

  update(dt: number, camera: THREE.Camera) {
    const k = dt > 0 ? 1 - Math.exp(-dt * 16) : 1
    for (const r of this.rigs.values()) {
      if (Math.abs(r.target - r.radius) > 1e-5) { r.radius += (r.target - r.radius) * k; this.dirty = true }
    }
    if (this.dirty) { this.layout(); this.dirty = false }
    this.placeTags(camera)
  }

  /** Remove this model's tags (each model has its own overlay container). */
  dispose() { this.overlay.replaceChildren() }

  // ---- internals ---------------------------------------------------------------------------------------------

  private mapping(key: string, field: string): VisualMapping {
    const b = this.engine === 'boxem' ? BOXEM_BOUNDS[key] : null
    const bounds = this.state.bounds as Record<string, number> | undefined
    return spatial.visualMapping(this.engine, field, b && bounds ? { min: bounds[b[0]], max: bounds[b[1]] } : undefined)
  }

  private retarget() {
    for (const r of this.rigs.values()) {
      const f = spatial.visualFraction(this.mapping(r.key, r.field), Number(this.state[r.field]))
      r.target = this.profile.min + (this.profile.max - this.profile.min) * f
    }
    this.refreshTags()
  }

  private refreshTags() {
    for (const r of this.rigs.values()) r.tag.querySelector('span')!.textContent = formatValue(Number(this.state[r.field]), r.unit)
  }

  private screen(r: Rig, fraction: number, camera: THREE.Camera) {
    const radius = r.scale * (this.profile.min + (this.profile.max - this.profile.min) * fraction)
    const p = r.node.parent!.localToWorld(this.tmp.copy(r.dir).multiplyScalar(radius)).project(camera)
    return { x: (p.x + 1) / 2 * innerWidth, y: (1 - p.y) / 2 * innerHeight }
  }

  private layout() {
    for (const r of this.rigs.values()) {
      r.node.position.copy(r.dir).multiplyScalar(r.radius * r.scale)
      if (r.anchor) r.anchor.position.copy(r.dir).multiplyScalar(r.radius * r.scale * r.anchorRatio)
    }
    this.root.updateMatrixWorld(true)
    for (const l of this.links) {
      const A = this.rigs.get(l.a)!.node.getWorldPosition(this.tmp)
      const B = this.rigs.get(l.b)!.node.getWorldPosition(this.tmp2)
      const parent = l.obj.parent!
      parent.worldToLocal(A)
      parent.worldToLocal(B)
      const span = B.clone().sub(A)
      const len = span.length()
      if (len < 1e-6) continue
      l.obj.position.copy(A).add(B).multiplyScalar(0.5)
      l.obj.quaternion.setFromUnitVectors(Y, span.divideScalar(len))
      l.obj.scale.y = len
    }
    if (this.hull) {
      const pos = this.hull.geo.getAttribute('position') as THREE.BufferAttribute
      const local = new Map<string, THREE.Vector3>()
      for (const r of this.rigs.values()) local.set(r.key, this.hull.mesh.worldToLocal(r.node.getWorldPosition(new THREE.Vector3())))
      this.hull.slots.forEach((s, i) => { const v = local.get(s.key)!; pos.setXYZ(i, v.x * s.ratio, v.y * s.ratio, v.z * s.ratio) })
      pos.needsUpdate = true
      this.hull.geo.computeVertexNormals()
      this.hull.geo.computeBoundingSphere()
    }
  }

  private placeTags(camera: THREE.Camera) {
    for (const r of this.rigs.values()) {
      const at = (r.anchor ?? r.node).getWorldPosition(this.tmp)
      const d = at.clone().sub(camera.position)
      const facing = d.dot(camera.getWorldDirection(this.tmp2)) > 0
      at.project(camera)
      const x = (at.x + 1) / 2 * innerWidth
      const y = (1 - at.y) / 2 * innerHeight
      r.tag.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
      r.tag.style.visibility = facing ? '' : 'hidden'
      r.tag.style.zIndex = String(Math.round(1000 - d.length() * 50))
    }
  }

  /** Label anchors: bare empties further out along a pillar's axis (BlackBoxes places tags there). */
  private findAnchors() {
    const rigs = [...this.rigs.values()]
    this.root.traverse((o) => {
      if (o.children.length || (o as THREE.Mesh).isMesh || Object.keys(o.userData ?? {}).length || o.position.lengthSq() < 1e-6) return
      const d = o.position.clone().normalize()
      const r = rigs.find((x) => x.node.parent === o.parent && x.dir.dot(d) > 0.998 && o.position.length() > x.node.position.length())
      if (r && !r.anchor) { r.anchor = o; r.anchorRatio = o.position.length() / r.node.position.length() }
    })
  }

  private findLinks() {
    this.root.traverse((o) => {
      const { k1, k2 } = o.userData ?? {}
      if (this.has(k1) && this.has(k2)) this.links.push({ obj: o, a: k1, b: k2 })
    })
  }

  /** The hull is the mesh whose distinct vertices each sit on one pillar's axis (at a fixed share of its radius). */
  private findHull() {
    this.root.updateMatrixWorld(true)
    const rigs = [...this.rigs.values()]
    let found: typeof this.hull = null
    this.root.traverse((o) => {
      const m = o as THREE.Mesh
      if (found || !m.isMesh || !m.geometry?.getAttribute('position')) return
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute
      if (pos.count > 96) return
      const local = new Map(rigs.map((r) => [r.key, m.worldToLocal(r.node.getWorldPosition(new THREE.Vector3()))]))
      const slots: HullSlot[] = []
      const v = new THREE.Vector3()
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i)
        const len = v.length()
        if (len < 1e-6) return
        let best: Rig | null = null
        let cos = 0.985
        for (const r of rigs) { const c = v.clone().normalize().dot(local.get(r.key)!.clone().normalize()); if (c > cos) { cos = c; best = r } }
        if (!best) return
        slots.push({ key: best.key, ratio: len / local.get(best.key)!.length() })
      }
      if (new Set(slots.map((s) => s.key)).size !== rigs.length) return
      // Each loaded model owns its geometry, so the hull can be reshaped in place.
      found = { mesh: m, geo: m.geometry, slots }
    })
    this.hull = found
  }
}

/** A pillar's identity colour: its gem's material colour (the authored node colour). */
function pillarColor(node: THREE.Object3D): string {
  let c: THREE.Color | null = null
  node.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined
    if (!c && mat && !Array.isArray(mat) && mat.color && (o as THREE.Mesh).isMesh && mat.emissive) c = mat.emissive.clone().lerp(mat.color, 0.35)
  })
  return c ? `#${(c as THREE.Color).getHexString()}` : '#9ca3af'
}
