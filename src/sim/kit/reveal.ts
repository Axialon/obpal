/**
 * The first appearance of a device that wears a Blender mesh. Its procedural rig is built at once (it carries the
 * device's state and its joints), but is kept out of view while the mesh downloads: the visitor sees the room and a
 * calm loading pill (./loading.ts), then the finished device comes in with one short ease. The procedural rig is
 * only ever shown when the mesh cannot come: it failed, did not fit, or took longer than LOAD_BUDGET_MS. The device
 * runs meanwhile (a phone can join and drive it), so the mesh appears in whatever pose it has reached.
 */
import type { Object3D, Vector3 } from 'three'
import { beginLoading, endLoading, loadingNow, motionAllowed } from './loading'
import { downloadStage, downloadStarted, type Prototype } from './models'

/** How long a rig waits for its mesh, counted from when the download began, before the procedural rig is shown. */
export const LOAD_BUDGET_MS = 4000
/** A rig always waits at least this long from being held, whatever the download has already used up. */
const MIN_WAIT_MS = 1200
/** Once the mesh's bytes are in, the rest is decoding, which is finite: the wait may run this much longer, once. */
const DECODE_GRACE_MS = 3000
const ENTRANCE_MS = 320
const ENTRANCE_FROM = 0.92

export interface RigHold {
  /** The mesh is here: `swap` puts it in place, and the rig is shown. An error in `swap` shows the procedural rig. */
  install(swap: () => void): void
  /** The mesh is not coming: show the procedural rig. Nothing once the rig is shown. */
  fallback(): void
  /** The rig has gone before it was shown. */
  cancel(): void
  /** Objects that belong with the rig but stand outside it (a shadow on the floor): held and shown with it. */
  alongside(...objects: Object3D[]): void
}

interface Hold {
  name: Prototype
  roots: Object3D[]
  also: Object3D[]
  state: 'held' | 'shown' | 'gone'
  timer: ReturnType<typeof setTimeout> | undefined
  frame: number
  base: Vector3[]
  /** The wait has been extended for the decoder. */
  graced?: boolean
  shown?: () => void
}

const holds = new WeakMap<Object3D, Hold>()
/** ?test=load: every rig held, for the tests that watch frames. */
const watched = new Set<Object3D>()
const watching = typeof location !== 'undefined' && /[?&]test=load\b/.test(location.search)
let created = 0
// ?test=load: what a test asks of the page, before any frame is drawn.
if (watching) Object.assign(window, { __rigs: () => ({ created, held: [...watched].filter(isHeld).length, standIn: standInVisible(), loading: loadingNow() }) })

/** Whether the rig is held back right now (the shared draws of copies leave it out until it is shown). */
export const isHeld = (root: Object3D) => holds.get(root)?.state === 'held'

const objects = (h: Hold) => [...h.roots, ...h.also]

function settle(h: Hold) {
  if (!h.frame) return
  cancelAnimationFrame(h.frame)
  h.frame = 0
  h.roots.forEach((r, i) => r.scale.copy(h.base[i]))
}

/** The rig eases in from a little smaller, about its own origin (the floor or the base under it). */
function enter(h: Hold) {
  settle(h)
  if (!motionAllowed()) return
  h.base = h.roots.map(r => r.scale.clone())
  const start = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - start) / ENTRANCE_MS))
    const k = ENTRANCE_FROM + (1 - ENTRANCE_FROM) * (1 - (1 - t) ** 3)
    h.roots.forEach((r, i) => r.scale.copy(h.base[i]).multiplyScalar(k))
    h.frame = t < 1 ? requestAnimationFrame(step) : 0
    if (!h.frame) h.roots.forEach((r, i) => r.scale.copy(h.base[i]))
  }
  step(start)
}

function show(h: Hold, source: 'model' | 'stand-in') {
  clearTimeout(h.timer)
  const first = h.state === 'held'
  h.state = 'shown'
  for (const o of objects(h)) o.visible = true
  for (const r of h.roots) r.userData.prototype = source === 'model' ? 'blender' : 'procedural'
  if (first) endLoading()
  if (source === 'model') performance.mark(`obpal:${h.name}:visible`)
  else if (first) h.shown?.()
  enter(h)
}

/**
 * Keeps `roots` (and the `also` that go with them, such as a blob shadow) out of view until the mesh `name` is
 * installed, and shows the loading pill meanwhile. The caller ends the hold with `install` when the mesh is ready, or
 * `fallback` when it will not be; failing both, the wait ends by itself (LOAD_BUDGET_MS). `shown` runs if the
 * procedural rig is shown instead, for anything that has to be set up once it is (shared draws of copies).
 */
export function holdRig(name: Prototype, roots: readonly Object3D[], options: { also?: readonly Object3D[]; shown?: () => void } = {}): RigHold {
  const h: Hold = { name, roots: [...roots], also: [...options.also ?? []], state: 'held', timer: undefined, frame: 0, base: [], shown: options.shown }
  created++
  for (const r of h.roots) { holds.set(r, h); r.userData.prototype = 'procedural'; if (watching) watched.add(r) }
  for (const o of objects(h)) o.visible = false
  beginLoading()
  performance.mark(`obpal:${name}:held`)
  const started = downloadStarted(name)
  const due = () => {
    if (downloadStage(name) === 'decoding' && !h.graced) { h.graced = true; h.timer = setTimeout(due, DECODE_GRACE_MS); return }
    rig.fallback()
  }
  h.timer = setTimeout(due, Math.max(MIN_WAIT_MS, started === null ? LOAD_BUDGET_MS : LOAD_BUDGET_MS - (performance.now() - started)))
  const rig: RigHold = {
    install(swap) {
      if (h.state === 'gone') return
      settle(h)
      try { swap() } catch { rig.fallback(); return }
      show(h, 'model')
    },
    fallback() { if (h.state === 'held') show(h, 'stand-in') },
    alongside(...objects) { h.also.push(...objects); if (h.state === 'held') for (const o of objects) o.visible = false },
    cancel() {
      if (h.state === 'held') endLoading()
      h.state = 'gone'
      clearTimeout(h.timer)
      settle(h)
      for (const r of h.roots) watched.delete(r)
    },
  }
  return rig
}

/** Whether a procedural rig that was held is in the picture: attached to a scene, and every object above it shown. */
export function standInVisible(): boolean {
  for (const root of watched) {
    if (root.userData.prototype !== 'procedural') continue
    let o: Object3D | null = root
    while (o && o.visible && o.parent) o = o.parent
    if (o && o.visible && (o as Object3D & { isScene?: boolean }).isScene) return true
  }
  return false
}

/**
 * ?test=load: called with every drawn frame, it records whether a procedural rig was in it, whether the pill was up, and
 * the first held rig's scale (its entrance), in window.__loadFrames.
 */
export function recordFrame() {
  const w = window as unknown as { __loadFrames?: { t: number; standIn: boolean; loading: boolean; scale: number | null }[] }
  ;(w.__loadFrames ??= []).push({ t: performance.now(), standIn: standInVisible(), loading: loadingNow(), scale: [...watched][0]?.scale.x ?? null })
}
