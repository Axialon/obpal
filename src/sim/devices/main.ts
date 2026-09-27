/**
 * A device sim (/sim/device/?d=<id>): one device from the registry (./registry.ts) on the shared stage, in a shared
 * scene (CATALOGUE §5) where each phone drives a unit of its own. A phone that joins gets a free unit at once (its
 * scene list still picks another); pointing at a unit and pressing A takes it too, where the device can be pointed at.
 * The panel shows the controllers that suit the device and how each drives it, who holds which unit with what, and a
 * live readout of each.
 */
import '../../styles/base.css'
import '../../styles/sim.css'
import '../../styles/devices.css'
import * as THREE from 'three'
import { PadButton, type Participant } from '@obpal/host'
import { family } from '../../family'
import { applyTheme, initialTheme, themeById } from '../../ui/themes'
import { mountMarks } from '../../ui/icons'
import { mountTopBar } from '../../landing/topbar'
import { startSimScene, type SimScene } from '../scene'
import { faceGlyph, faceName, faceShort } from '../faces'
import { deviceById, DEVICES } from './registry'
import { Seats } from './seats'
import { createStage } from './stage'
import { layoutOf, type DeviceInput } from './types'
import { spotRing, type DeviceView } from './view'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const params = new URLSearchParams(location.search)
const entry = deviceById(params.get('d')) ?? DEVICES[0]
const spec = entry.spec

applyTheme(initialTheme())
mountMarks()
mountTopBar()
family.mountThemes($('t-theme'), $('themes'))
family.watchTheme()

document.title = `${spec.name} · ob.Pal`
$('dev-kind').textContent = spec.kind
$('dev-name').textContent = spec.name
$('dev-blurb').textContent = spec.blurb
$('stage').setAttribute('aria-label', spec.name)

const stage = createStage($<HTMLCanvasElement>('stage'), themeById(family.getTheme()))
const logic = entry.logic()
const units = Array.from({ length: spec.units }, (_, n) => ({ id: `${spec.id}${n + 1}`, name: spec.unitNames?.[n] ?? `${spec.unit} ${n + 1}` }))
const unitOf = (node: string | undefined) => units.findIndex((u) => u.id === node)
let view: DeviceView | null = null
let sim: SimScene | null = null
let following = true
let followedUnit = 0

addEventListener('bb-theme', (e) => {
  const t = themeById((e as CustomEvent<{ theme: string }>).detail.theme)
  applyTheme(t)
  stage.setTheme(t)
  view?.setTheme?.(t)
})

// ---- the panel: the controllers that suit it, and how each drives it ----

let shownFace = spec.controllers[0]
function renderFaces() {
  const using = new Map<string, string[]>()
  for (const p of sim?.remote.participants ?? []) if (p.controller) using.set(p.controller, [...(using.get(p.controller) ?? []), p.color])
  $('dev-faces').replaceChildren(...spec.controllers.map((c, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `dev-face${i === 0 ? ' first' : ''}`
    b.dataset.face = c
    b.setAttribute('aria-pressed', String(c === shownFace))
    b.title = faceName(c)
    b.innerHTML = `${faceGlyph(c)}<span></span><i class="dots"></i>`
    b.querySelector('span')!.textContent = faceShort(c)
    const dots = b.querySelector('.dots')!
    for (const color of using.get(c) ?? []) { const d = document.createElement('b'); d.style.background = color; dots.appendChild(d) }
    b.onclick = () => { shownFace = c; renderFaces() }
    return b
  }))
  $('dev-how').textContent = spec.how[shownFace] ?? ''
}
renderFaces()

// ---- units: who holds each, with what, and how it's doing ----

function renderUnits() {
  const held = sim?.claims.snapshot() ?? {}
  const people = new Map((sim?.remote.participants ?? []).map((p) => [p.id, p]))
  $('dev-units').replaceChildren(...units.map((u, n) => {
    const who = held[u.id]
    const p = who ? people.get(who) : undefined
    const li = document.createElement('li')
    li.classList.toggle('held', !!who)
    li.dataset.unit = u.id
    li.innerHTML = '<span class="dot"></span><span class="nn"><b></b><small></small></span><span class="nv"></span>'
    const dot = li.querySelector<HTMLElement>('.dot')!
    if (who) dot.style.background = sim!.colorOf(who)
    li.querySelector('b')!.textContent = u.name
    const small = li.querySelector('small')!
    if (p?.controller) small.insertAdjacentHTML('afterbegin', faceGlyph(p.controller))
    small.append(who ? sim!.nameOf(who) : 'Free: scan to drive')
    li.querySelector('.nv')!.textContent = logic.readout(n)
    return li
  }))
}
let readoutAt = 0
function refreshReadouts(now: number) {
  if (now - readoutAt < 250) return
  readoutAt = now
  document.querySelectorAll<HTMLElement>('#dev-units li').forEach((li, n) => { li.querySelector('.nv')!.textContent = logic.readout(n) })
}

$('home-all').onclick = () => { units.forEach((_, n) => logic.home(n)); sim?.log('The screen sent every unit home') }
if (logic.reset) {
  $('reset').hidden = false
  $('reset').textContent = logic.resetLabel ?? 'Reset'
  $('reset').onclick = () => { logic.reset!(); sim?.log(`The screen: ${(logic.resetLabel ?? 'reset').toLowerCase()}`) }
}

// ---- pointing: a cursor per pointing phone, and a ring where it meets the floor ----

const cursors = new Map<string, { el: HTMLElement; ring: THREE.Group | null }>()
function cursorOf(id: string) {
  let c = cursors.get(id)
  if (!c) {
    const el = document.createElement('div')
    el.className = 'dev-cursor'
    $('cursors').appendChild(el)
    const ring = view?.pickY !== undefined ? spotRing() : null
    if (ring) stage.scene.add(ring)
    c = { el, ring }
    cursors.set(id, c)
  }
  return c
}
function dropCursor(id: string) {
  const c = cursors.get(id)
  if (!c) return
  c.el.remove()
  c.ring?.removeFromParent()
  cursors.delete(id)
}
/**
 * Where a participant's pointer aims on the screen. Where the device says aiming straight means the middle of your unit
 * (a claw's small pit), the pointer moves from there, at a finer rate, rather than from the middle of the screen.
 */
function aimAt(x: number, y: number, who: string): [number, number] {
  const n = unitOf(sim?.claims.held(who))
  const from = n >= 0 ? view?.pointFrom?.(n) : undefined
  const mid = from ? stage.toScreen(from) : null
  return mid ? [mid.x + (x - innerWidth / 2) * 0.6, mid.y + (y - innerHeight / 2) * 0.6] : [x, y]
}

function drawCursors(inputs: Map<string, DeviceInput>) {
  for (const id of cursors.keys()) if (!inputs.get(id)?.point) dropCursor(id)
  for (const [id, inp] of inputs) {
    if (!inp.point) continue
    const c = cursorOf(id)
    const color = sim?.colorOf(id) || '#ffffff'
    const [x, y] = aimAt(inp.point.x, inp.point.y, id)
    c.el.style.setProperty('--c', color)
    c.el.style.transform = `translate(${Math.max(6, Math.min(innerWidth - 6, x))}px, ${Math.max(6, Math.min(innerHeight - 6, y))}px)`
    c.el.classList.toggle('off', inp.point.off)
    c.el.classList.toggle('press', inp.held.has('wii-b') || inp.held.has('mouse-left'))
    if (c.ring) {
      c.ring.visible = !!inp.spot
      if (inp.spot) c.ring.position.set(inp.spot[0], (view?.pickY ?? 0) + 0.004, inp.spot[1])
      c.ring.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined; m?.color?.set(color) })
    }
  }
}

/**
 * Pointing at a unit and pressing A (or the air mouse's Left) takes it, as pointing at a part does in the Viewer
 * (CATALOGUE §5): true when it did, so the press isn't also the unit's.
 */
function pointToTake(who: string, inp: DeviceInput): boolean {
  if (!view?.anchor || !inp.point || inp.point.off || !sim) return false
  if (!inp.presses.includes('wii-a') && !inp.presses.includes('mouse-left')) return false
  let best = -1
  let bestD = 90
  units.forEach((_, n) => {
    const s = stage.toScreen(view!.anchor!(n))
    if (!s) return
    const d = Math.hypot(s.x - inp.point!.x, s.y - inp.point!.y)
    if (d < bestD) { best = n; bestD = d }
  })
  if (best < 0 || sim.claims.held(who) === units[best].id) return false
  sim.take(units[best].id, who)
  return true
}

// ---- the shared scene ----

/**
 * A phone as the screen, held upright, shows the device small above the panel: once someone has joined (the pairing
 * card is out of the way), a note suggests turning it sideways, once.
 */
const upright = matchMedia('(orientation: portrait) and (max-width: 600px)')
let nudged = false

const layout = layoutOf(spec)
function howTo(node: string) {
  const n = unitOf(node)
  return `${units[n]?.name ?? spec.name} · ${spec.how[spec.controllers[0]] ?? ''}`
}

void entry.view().then((m) => {
  view = m.createView(stage, logic)
  stage.frame(view.framing)
  if (view.afterRender) stage.afterRender = () => view!.afterRender!()
  const resetView = document.createElement('button')
  resetView.className = 'btn'
  resetView.textContent = 'Reset view'
  resetView.onclick = () => { following = true; stage.frame(view!.framing) }
  $('home-all').parentElement!.appendChild(resetView)
  if (view.overview) {
    const overview = document.createElement('button')
    overview.className = 'btn'
    overview.textContent = 'Overview'
    overview.onclick = () => { following = false; stage.frame(view!.overview!) }
    resetView.after(overview)
  }
  if (view.inspect) {
    const inspect = document.createElement('button')
    inspect.className = 'btn'
    inspect.textContent = 'Inspect model'
    inspect.onclick = () => { following = false; stage.frame(view!.inspect!()) }
    resetView.after(inspect)
  }
})

void startSimScene({
  appName: `ob.Pal ${spec.name.toLowerCase()}`,
  layout,
  nodes: units.map((u) => ({ id: u.id, name: u.name, kind: spec.id, group: `${spec.name}s` })),
  approval: false,
  howTo,
  changed: () => { renderUnits(); renderFaces() },
  // A phone that joins drives a free unit straight away.
  joined: (p: Participant) => {
    if (upright.matches && !nudged) { nudged = true; setTimeout(() => { if (upright.matches) sim?.note('Turn this screen sideways for a bigger view') }, 1200) }
    if (!sim || sim.claims.held(p.id)) return
    const free = units.find((u) => !sim!.claims.holder(u.id))
    if (free) sim.take(free.id, p.id)
  },
  left: (p) => dropCursor(p.id),
}).then((s) => {
  sim = s
  const seats = new Seats(s.remote, layout)
  s.remote.on('mode', () => { renderFaces(); renderUnits() })
  // For tests: the device, and what each participant's input looked like last frame.
  const seen: Record<string, { face: string; mode: number; touching: boolean; touchFrames: number; frames: number; drag: [number, number]; tilt: [number, number]; point: boolean; spot: [number, number] | null; presses: string[] }> = {}
  Object.assign(window, { __device: { spec, logic, units, seats, stage, seen, anchorOnScreen: (n: number) => (view?.anchor ? stage.toScreen(view.anchor(n)) : null) } })
  renderUnits()
  stage.onFrame = (t, dt) => {
    const now = performance.now()
    const spotOf = view?.pickY !== undefined ? (x: number, y: number, who: string) => {
      const [ax, ay] = aimAt(x, y, who)
      if (!view?.pointFrom && (ax < 0 || ay < 0 || ax > innerWidth || ay > innerHeight)) return null
      const p = stage.pick(ax, ay, view!.pickY)
      return p ? [p.x, p.z] as [number, number] : null
    } : undefined
    const inputs = seats.read(now, spotOf)
    for (const [who, i] of inputs) {
      const was = seen[who]
      seen[who] = { face: i.face, mode: i.mode, touching: i.touching, touchFrames: (was?.touchFrames ?? 0) + (i.touching ? 1 : 0), frames: (was?.frames ?? 0) + 1, drag: [(was?.drag[0] ?? 0) + i.drag[0], (was?.drag[1] ?? 0) + i.drag[1]], tilt: [...i.tilt], point: !!i.point, spot: i.spot, presses: [...(was?.presses ?? []), ...i.presses].slice(-12) }
    }
    const perUnit = units.map((u) => {
      const who = s.claims.holder(u.id)
      return who ? inputs.get(who) ?? null : null
    })
    for (const [who, inp] of inputs) if (pointToTake(who, inp)) inp.presses = inp.presses.filter((x) => x !== 'wii-a' && x !== 'mouse-left')
    // Home on every device: the tray's Home, or the gamepad's Guide.
    perUnit.forEach((inp, n) => {
      if (!inp) return
      if (inp.presses.includes('home') || (inp.padPressed >>> PadButton.Guide) & 1) {
        logic.home(n)
        const who = s.claims.holder(units[n].id)!
        s.remote.feedback({ haptic: 'tick', toast: `${units[n].name} went home` }, who)
        s.log(`${s.nameOf(who)} sent ${units[n].name} home`, s.colorOf(who))
      }
    })
    logic.step(perUnit, dt)
    const events = logic.drain()
    // While anyone drives a unit, or something happened, the device moves: the still picture starts again (../view.ts).
    // Left alone, the stage settles into its supersampled still.
    if (events.length || perUnit.some((i) => i)) stage.view.invalidate()
    for (const e of events) {
      const who = s.claims.holder(units[e.unit]?.id)
      if (e.kind === 'bump' && who) s.remote.rumble(Math.min(1, e.strength ?? 0.5), Math.min(1, (e.strength ?? 0.5) * 0.6), 90, who)
      if (e.kind === 'fall' && who) s.remote.rumble(1, 1, 260, who)
      if ((e.kind === 'tick' || e.kind === 'score') && who) s.remote.feedback({ haptic: 'tick', ...(e.text ? { toast: e.text } : {}) }, who)
      if (e.text && (e.kind === 'score' || e.kind === 'fall')) s.log(`${who ? s.nameOf(who) : units[e.unit]?.name}: ${e.text}`, who ? s.colorOf(who) : undefined)
    }
    view?.update(units.map((u) => { const who = s.claims.holder(u.id); return who ? s.colorOf(who) : null }), t, dt)
    if (following && view?.follow) {
      const active = perUnit.findIndex((i) => i && !i.quiet && (i.touching || i.held.size || i.presses.length || i.pose?.touching || i.pad && [...i.pad.axes, ...i.pad.triggers].some((v) => Math.abs(v) > 0.04)))
      if (active >= 0) followedUnit = active
      stage.follow(view.follow(followedUnit))
    }
    drawCursors(inputs)
    refreshReadouts(now)
  }
})

stage.onFrame = (t, dt) => {
  // Before the scene is up the device idles, so the stage never stands empty.
  logic.step(units.map(() => null), dt)
  view?.update(units.map(() => null), t, dt)
}
