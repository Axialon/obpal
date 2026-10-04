/**
 * A device sim (/sim/device/?d=<id>): one device from the registry (./registry.ts) on the shared stage, in a shared
 * scene (CATALOGUE §5) where each phone drives a unit of its own. A phone that joins gets a free unit at once (its
 * scene list still picks another); pointing at a unit and pressing A takes it too, where the device can be pointed at.
 * The panel is numbered sections: the view, the controllers that suit the device and how each drives it, who holds
 * which unit with what and a live readout of each (drawn as an instrument, ui/kit/telemetry.ts), and sound.
 */
import '../../styles/base.css'
import '../../styles/sim.css'
import '../../styles/devices.css'
import * as THREE from 'three'
import { PadButton, type Participant } from '@obpal/host'
import { family } from '../../family'
import { applyTheme, initialTheme, themeById } from '../../ui/themes'
import { ICONS, mountMarks } from '../../ui/icons'
import { setMarkup } from '../../ui/markup'
import { mountTopBar } from '../../landing/topbar'
import { startSimScene, type SimScene } from '../scene'
import { faceGlyph, faceName, faceShort } from '../faces'
import { deviceById, DEVICES } from './registry'
import { Seats } from './seats'
import { createStage } from './stage'
import { layoutOf, type DeviceInput } from './types'
import { spotRing, type DeviceView } from './view'
import { devicePresence } from '../vr/devices'
import { mountSound } from '../audio/session'
import { DeviceSound } from '../audio/devices'
import { deviceTarget, sceneSelects } from './control-space'
import { restInput } from './types'
import { routeParts, sceneParts } from './focus'
import { PartHalos } from './halo'
import { mountSimPanels, numberSections } from '../ui/panels'
import { Telemetry } from '../../ui/kit/telemetry'
import { iconAction } from '../../ui/kit/action'
import { syncActionState } from '../action-state'
import { mountQuick, quickAction, quickViews } from '../../ui/quick'
import { startScene } from '../kit/recovery'
import { MarblePhone } from './marblerun.phone'
import { LocalControls } from '../local-controls'
import { mapFaceInput, recommendedFaces } from '../face-input'

startScene(async () => {
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const params = new URLSearchParams(location.search)
const entry = deviceById(params.get('d') ?? location.pathname.split('/')[2]) ?? DEVICES[0]
const spec = entry.spec

applyTheme(initialTheme())
mountMarks()
mountTopBar()
// The quick-actions tray, before the windows, which keep clear of its edge. The theme lives there; the bar stays clear.
mountQuick()
family.watchTheme()

document.title = `${spec.name} · ob.Pal`
$('dev-kind').textContent = spec.kind
$('dev-name').textContent = spec.name
$('dev-blurb').textContent = spec.blurb
document.getElementById('seo-device')?.remove()
$('stage').setAttribute('aria-label', spec.name)
const panels = mountSimPanels(`device:${spec.id}`, 'Controls')
const scored = ['slotcars', 'kart', 'airhockey', 'football', 'pinball', 'maze', 'claw', 'sorting', 'marblerun', 'trebuchet'].includes(spec.id)
if (scored) panels.add($('dev-units'), { id: 'scores', title: spec.id === 'slotcars' || spec.id === 'kart' ? 'Scores & laps' : 'Scores & seats', purpose: 'Live results and who controls each unit', icon: 'scores', anchor: 'scores' })
if (spec.id === 'studio') {
  const stations = document.createElement('div'); stations.id = 'dev-units'; stations.className = 'panel-collection'
  $('dev-units').replaceWith(stations); panels.root.append(stations)
}
// Units with a window of their own (scores, the studio's stations) leave their section. Units in the panel carry
// Home all (and the device's own reset) in their section's header; otherwise those stay in a row of their own.
$('dev-units-sec').hidden = scored || spec.id === 'studio'
if (!$('dev-units-sec').hidden) {
  $('dev-count').after($('home-all'), $('reset'))
  document.querySelector<HTMLElement>('.dev-panel .safety')!.hidden = true
}

// The octopus re-poses its swept arms every frame, so it caps the pixel ratio at 1.5 to keep within its frame budget.
const stage = createStage($<HTMLCanvasElement>('stage'), themeById(family.getTheme()), { ready: () => view !== null, ...(spec.id === 'octopus' ? { maxDpr: 1.5 } : {}) })
const logic = entry.logic()
const units = Array.from({ length: spec.units }, (_, n) => ({ id: `${spec.id}${n + 1}`, name: spec.unitNames?.[n] ?? `${spec.unit} ${n + 1}` }))
const unitOf = (node: string | undefined) => units.findIndex((u) => u.id === node)
let view: DeviceView | null = null
let sim: SimScene | null = null
const sound = spec.id === 'studio' ? null : mountSound(spec.id, (strong, weak, ms, who) => sim?.remote.rumble(strong, weak, ms, who))
const deviceSound = sound ? new DeviceSound(logic, sound, n => sim?.claims.holder(units[n].id)) : null
let following = true
let followedUnit = 0
const presence = devicePresence(logic, stage, () => view, () => sim)
const localUnits = new Set<number>()
let localSignature = ''
const local = presence.shared.guest ? null : new LocalControls({
  id: spec.id, canvas: stage.renderer.domElement, units: () => units, tray: spec.tray,
  phone: () => document.getElementById('chip-invite')?.click(),
  controllerWindow: () => { if (sim?.remote.pairingUrl) window.open(sim.remote.pairingUrl, '_blank', 'noopener') },
  orbit: enabled => { if (!(spec.id === 'marblerun' && matchMedia('(pointer: coarse)').matches)) stage.controls.enabled = enabled && !presence.experience.immersive },
})
const marblePhone = spec.id === 'marblerun' && !presence.shared.guest && matchMedia('(pointer: coarse)').matches ? new MarblePhone() : null
let marbleMotionButton: HTMLButtonElement | null = null
if (marblePhone) {
  const dock = document.createElement('div'); dock.className = 'marble-phone glass'; dock.setAttribute('role', 'toolbar'); dock.setAttribute('aria-label', 'Marble controls')
  marbleMotionButton = document.createElement('button'); marbleMotionButton.type = 'button'; marbleMotionButton.className = 'kit-action marble-motion'
  const label = document.createElement('span'); label.textContent = marblePhone.state
  setMarkup(marbleMotionButton, ICONS.tilt)
  marbleMotionButton.append(label); marbleMotionButton.onclick = () => { void marblePhone.enable() }
  dock.append(marbleMotionButton)
  for (const [id, icon, name] of [['recentre', 'center', 'Recentre tilt'], ['run', 'play', 'Run / build'], ['home', 'home', 'Home']]) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'kit-action'; b.dataset.marble = id
    if (id === 'recentre') b.title = 'Tap here or hold the board to recentre tilt'
    iconAction(b, icon, name)
    b.onclick = () => { if (id === 'recentre') marblePhone.recenter(); else marblePhone.press(id) }; dock.append(b)
  }
  document.body.append(dock)
  // Dragging and tapping keep working when sensors are absent or permission is refused.
  stage.controls.enabled = false
  let finger: { id: number; x: number; y: number; travel: number; at: number } | null = null
  const canvas = stage.renderer.domElement
  canvas.addEventListener('pointerdown', e => { if (document.body.classList.contains('phone-playing')) return; finger = { id: e.pointerId, x: e.clientX, y: e.clientY, travel: 0, at: performance.now() }; canvas.setPointerCapture(e.pointerId) })
  canvas.addEventListener('pointermove', e => { if (!finger || finger.id !== e.pointerId) return; const x = e.clientX - finger.x, y = e.clientY - finger.y; finger.travel += Math.hypot(x, y); marblePhone.move(x, y); finger.x = e.clientX; finger.y = e.clientY })
  canvas.addEventListener('pointerup', e => {
    if (finger?.id !== e.pointerId) return
    if (finger.travel < 8) { if (performance.now() - finger.at >= 550) marblePhone.recenter(); else marblePhone.press('place') }
    finger = null
  })
  canvas.addEventListener('pointercancel', () => { finger = null })
  addEventListener('pagehide', () => marblePhone.stop(), { once: true })
  addEventListener('obpal:localplay', () => { finger = null; stage.controls.enabled = true; stage.controls.touches.ONE = -1 as THREE.TOUCH; stage.controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE })
}
function directMarbleInput(perUnit: (DeviceInput | null)[]) {
  if (!marblePhone) return
  const input = marblePhone.read()
  // Local play only owns the free first board; a paired participant retains its claim.
  if (!sim?.claims.holder(units[0].id)) {
    if (input.presses.includes('home')) { marblePhone.recenter(); logic.home(0); input.recentred = true; input.tilt = [0, 0] }
    perUnit[0] = input
  }
  const text = sim?.claims.holder(units[0].id) ? 'Phone controller has Track 1' : marblePhone.state
  marbleMotionButton!.parentElement!.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = !!sim?.claims.holder(units[0].id) })
  const label = marbleMotionButton!.querySelector('span:last-child')!
  if (label.textContent !== text) label.textContent = text
  marbleMotionButton!.title = text
  marbleMotionButton!.setAttribute('aria-pressed', String(text === 'Tilt active'))
}
/** The parts each unit's holder drives on its own, ringed on the model (./halo.ts). */
const halos = new PartHalos((n, part) => view?.partAt?.(n, part) ?? null)
numberSections(document.querySelector('.dev-panel')!)

addEventListener('bb-theme', (e) => {
  const t = themeById((e as CustomEvent<{ theme: string }>).detail.theme)
  applyTheme(t)
  stage.setTheme(t)
  view?.setTheme?.(t)
})

// ---- the panel: the controllers that suit it, and how each drives it ----

let shownFace = spec.controllers[0]
/** A tile per controller: its icon in a disc (ringed in the accent while shown), its name, and a dot per phone using it. */
function renderFaces() {
  const using = new Map<string, string[]>()
  for (const p of sim?.remote.participants ?? []) if (p.controller) using.set(p.controller, [...(using.get(p.controller) ?? []), p.color])
  $('dev-faces').replaceChildren(...recommendedFaces(spec.controllers).map((c, i) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `dev-face${i === 0 ? ' first' : ''}`
    b.dataset.face = c
    b.setAttribute('aria-pressed', String(c === shownFace))
    b.title = faceName(c)
    b.innerHTML = `<span class="dev-face-ic">${faceGlyph(c)}</span><span class="dev-face-name"></span><i class="dots"></i>`
    b.querySelector('.dev-face-name')!.textContent = faceShort(c)
    const dots = b.querySelector('.dots')!
    for (const color of using.get(c) ?? []) { const d = document.createElement('b'); d.style.background = color; dots.appendChild(d) }
    b.onclick = () => { shownFace = c; renderFaces() }
    return b
  }))
  $('dev-how').textContent = spec.how[shownFace] ?? 'Works here · movement, aim and actions use the shared mapping'
}
renderFaces()

// ---- units: who holds each, with what, and how it's doing ----

/** Each unit row's live readout, drawn as an instrument (ui/kit/telemetry.ts). */
const readouts = new WeakMap<HTMLElement, Telemetry>()
function renderUnits() {
  const held = sim?.claims.snapshot() ?? {}
  const people = new Map((sim?.remote.participants ?? []).map((p) => [p.id, p]))
  const rows = units.map((u, n) => {
    const who = held[u.id]
    const locallyDriven = !who && localUnits.has(n)
    const p = who ? people.get(who) : undefined
    const li = document.createElement('li')
    li.classList.toggle('held', !!who || locallyDriven)
    li.dataset.unit = u.id
    li.innerHTML = '<span class="dot" aria-hidden="true"></span><span class="nn"><b></b><small></small></span><span class="nv"></span>'
    // The unit's number in a ring, in its holder's colour while someone drives it.
    li.querySelector('.dot')!.textContent = String(n + 1)
    if (who) li.style.setProperty('--c', sim!.colorOf(who))
    else if (locallyDriven) li.style.setProperty('--c', sim!.colorOf(`local:${n}`))
    li.querySelector('b')!.textContent = u.name
    const small = li.querySelector('small')!
    if (p?.controller) small.insertAdjacentHTML('afterbegin', faceGlyph(p.controller))
    small.append(who ? sim!.nameOf(who) : locallyDriven ? local?.input.source === 'gamepad' ? 'Local gamepad' : 'Local keyboard' : 'Free')
    // What their trackpad drives on its own, when it isn't the whole unit.
    const chosen = who && who !== 'host' ? sim!.focus.of(who).part : ''
    const named = chosen && (spec.sets?.find((x) => x.id === chosen) ?? spec.parts?.find((x) => x.id === chosen))
    if (named) small.append(` · ${named.name}`)
    const readout = new Telemetry(logic.readout(n))
    readouts.set(li, readout)
    li.querySelector('.nv')!.append(readout.el)
    return li
  })
  const count = document.getElementById('dev-count')
  if (count) count.textContent = `${rows.filter((li) => li.classList.contains('held')).length}/${units.length}`
  if (spec.id === 'studio') rows.forEach((row, n) => {
    const list = document.createElement('ul'); list.className = 'dev-units'; list.append(row)
    const p = panels.add(list, { id: `station-${n + 1}`, title: units[n].name, purpose: 'Station player and live instrument readout', icon: 'station', anchor: 'station', index: n })
    $('dev-units').append(p.element)
  })
  else $('dev-units').replaceChildren(...rows)
}
let readoutAt = 0
function refreshReadouts(now: number) {
  if (now - readoutAt < 250) return
  readoutAt = now
  document.querySelectorAll<HTMLElement>('#dev-units li').forEach((li, n) => {
    const readout = readouts.get(li), text = logic.readout(n)
    if (readout && readout.value !== text) { readout.value = text; if (spec.id === 'studio') panels.get(`station-${n + 1}`)?.notify() }
  })
}

$('home-all').onclick = () => {
  units.forEach((unit, n) => {
    logic.home(n)
    const who = sim?.claims.holder(unit.id)
    if (who && sim?.control.calibrated(who)) sim.control.position(who)
  })
  sim?.log('The screen sent every unit home')
}
if (logic.reset) {
  $('reset').hidden = false
  $('reset').textContent = logic.resetLabel ?? 'Reset'
  $('reset').onclick = () => { logic.reset!(); sim?.log(`The screen: ${(logic.resetLabel ?? 'reset').toLowerCase()}`) }
}
// The tray's reset: every unit home, and the device's own reset (a race, a game) where it has one. A guest's screen
// only watches.
if (!presence.shared.guest) quickAction({
  id: 'reset', group: 'page', label: 'Reset', hint: logic.reset ? `${logic.resetLabel ?? 'Reset'}, and every unit home` : 'Every unit home', icon: 'reset',
  run: () => { $('home-all').click(); if (logic.reset) $('reset').click() },
})

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
    const color = '#c6ff34'
    const [x, y] = aimAt(inp.point.x, inp.point.y, id)
    c.el.style.setProperty('--c', color)
    c.el.style.transform = `translate(${Math.max(6, Math.min(innerWidth - 6, x))}px, ${Math.max(6, Math.min(innerHeight - 6, y))}px)`
    c.el.classList.toggle('off', inp.point.off)
    c.el.classList.toggle('press', inp.held.has('wii-b') || inp.held.has('mouse-left'))
    c.el.hidden = !!inp.space || !!c.ring
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
  if (inp.space && inp.scope === 'object') return false
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
layout.tray = [...(layout.tray ?? []), { id: 'scene-grab', label: 'Grab object', type: 'button' }]
function howTo(node: string) {
  const n = unitOf(node)
  return `${units[n]?.name ?? spec.name} · ${spec.how[spec.controllers[0]] ?? ''}`
}

await entry.view().then((m) => {
  view = m.createView(stage, logic)
  const home = $<HTMLButtonElement>('home-all')
  if (home.textContent?.trim() === 'Home all') iconAction(home, 'home', 'Home all')
  if (sim) view.connect?.(sim)
  numberSections(document.querySelector('.dev-panel')!)
  stage.resize()
  stage.frame(view.framing)
  if (view.afterRender) stage.afterRender = () => view!.afterRender!()
  // Familiar view actions share their spoken name with the glass tooltip.
  const action = (label: string, glyph: string, onclick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'kit-action'
    iconAction(b, glyph, label)
    b.onclick = onclick
    $('dev-view').append(b)
    return b
  }
  const play = () => { following = true; stage.frame(view!.framing) }
  const close = () => { following = false; stage.frame(view!.inspect!()) }
  const wide = () => { following = false; stage.frame(view!.overview!) }
  action('Reset view', 'center', play)
  if (view.inspect) action('Inspect model', 'zoom-in', close)
  if (view.overview) action('Overview', 'orbit', wide)
  // The body camera's home (ui/body-capture.ts) joins the views' row, last, whenever the shared shell adds it.
  const joinViews = () => {
    const body = document.querySelector<HTMLElement>('.body-home [data-body-capture]')
    if (!body) return false
    const row = body.parentElement!; $('dev-view').append(body); row.remove(); return true
  }
  if (!joinViews()) { const mo = new MutationObserver(() => { if (joinViews()) mo.disconnect() }); mo.observe(document.querySelector('.dev-panel')!, { childList: true, subtree: true }) }
  // The tray's camera steps through the same framings and first person (the viewpoint row's own button; on a phone,
  // right after the play view), and a framing brings the scene back from first person first.
  const experience = presence.experience
  const framed = (show: () => void) => () => { if (experience.immersive) void experience.leave().then(show); else show() }
  quickViews([
    { name: 'Play view', show: framed(play) },
    ...(view.overview ? [{ name: 'Overview', show: framed(wide) }] : []),
    ...(view.inspect ? [{ name: 'Close-up', show: framed(close) }] : []),
    { name: 'First person', show: () => document.querySelector<HTMLButtonElement>('.presence-controls .presence-enter')?.click(), current: () => experience.mode === 'first-person', phone: true },
  ])
})

if (!presence.shared.guest) void startSimScene({
  appName: `ob.Pal ${spec.name.toLowerCase()}`,
  layout,
  // Each unit offers its parts and sets to the phone that holds it (PROTOCOL §3a).
  nodes: units.map((u) => ({ id: u.id, name: u.name, kind: spec.id, group: `${spec.name}s`, ...sceneParts(spec) })),
  approval: false,
  howTo,
  changed: () => { renderUnits(); renderFaces() },
  focused: () => { renderUnits(); stage.view.invalidate() },
  // A phone that joins drives a free unit straight away.
  joined: (p: Participant) => {
    if (p.capability === 'watch') return
    if (upright.matches && !nudged) { nudged = true; setTimeout(() => { if (upright.matches) sim?.note('Turn this screen sideways for a bigger view') }, 1200) }
    if (!sim || sim.claims.held(p.id)) return
    const free = units.find((u) => !sim!.claims.holder(u.id))
    if (free) sim.take(free.id, p.id)
  },
  left: (p) => { dropCursor(p.id); sound?.gate.drop(p.id) },
}).then((s) => {
  sim = s
  presence.connect(s)
  view?.connect?.(s)
  numberSections(document.querySelector('.dev-panel')!)
  const seats = new Seats(s.remote, layout, s.control)
  s.remote.on('mode', () => { renderFaces(); renderUnits() })
  // For tests: the device, and what each participant's input looked like last frame.
  const seen: Record<string, { face: string; mode: number; touching: boolean; touchFrames: number; frames: number; drag: [number, number]; tilt: [number, number]; point: boolean; spot: [number, number] | null; presses: string[] }> = {}
  Object.assign(window, { __device: { spec, logic, units, seats, stage, seen, anchorOnScreen: (n: number) => (view?.anchor ? stage.toScreen(view.anchor(n)) : null),
    /** What unit n's holder drives on its own (tests): the choice, the parts it drives and those that hold. */
    focus: (n: number) => { const who = s.claims.holder(units[n].id); if (!who) return null; const f = s.focus.of(who); return { part: f.part, parts: [...f.parts], locks: [...f.locks] } },
    /** The rings on the model (tests): which parts show live. */
    halos: () => { const out: string[] = []; stage.scene.traverse((o) => { if (o.name.startsWith('part-halo-')) out.push(o.name.slice(10)) }); return out },
  } })
  if (params.get('test') === 'vr') Object.assign((window as unknown as { __device: object }).__device, { mapInput: presence.mapInput })
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
    const aimed = new Set<number>()
    document.querySelectorAll<HTMLElement>('#dev-units [data-unit]').forEach(row => row.style.removeProperty('outline'))
    for (const [who, inp] of inputs) {
      const held = unitOf(s.claims.held(who))
      if (spec.id === 'studio') continue
      if (inp.scope === 'scene' && sceneSelects(spec.id)) {
        inputs.set(who, { ...restInput(inp.face, inp.mode), scope: 'scene', quiet: true })
        if (!inp.space) continue
        const target = deviceTarget(spec.id, 'scene', held, inp.space.aim, units.length)
        aimed.add(target)
        s.control.target(who, units[target].name)
        if (inp.presses.some(p => ['control.take', 'wii-a', 'mouse-left', 'pad'].includes(p)) || (inp.padPressed >>> PadButton.A) & 1) {
          if (s.take(units[target].id, who)) s.control.setScope(who, 'object')
        }
        const row = document.querySelector<HTMLElement>(`[data-unit="${units[target].id}"]`)
        row?.style.setProperty('outline', '1px solid #c6ff34')
      }
    }
    const perUnit = units.map((u) => {
      const who = s.claims.holder(u.id)
      return who ? inputs.get(who) ?? null : null
    })
    directMarbleInput(perUnit)
    presence.inputs(perUnit, inputs)
    const localFrames = local?.frames(n => !!s.claims.holder(units[n]?.id), dt)
    const signature = `${local?.input.source}:${[...(localFrames?.keys() ?? [])].join(',')}`
    if (signature !== localSignature) {
      localSignature = signature
      localUnits.clear(); for (const n of localFrames?.keys() ?? []) localUnits.add(n)
      renderUnits()
    }
    for (const [n, input] of localFrames ?? []) perUnit[n] = input
    for (const [who, i] of inputs) {
      const was = seen[who]
      seen[who] = { face: i.face, mode: i.mode, touching: i.touching, touchFrames: (was?.touchFrames ?? 0) + (i.touching ? 1 : 0), frames: (was?.frames ?? 0) + 1, drag: [(was?.drag[0] ?? 0) + i.drag[0], (was?.drag[1] ?? 0) + i.drag[1]], tilt: [...i.tilt], point: !!i.point, spot: i.spot, presses: [...(was?.presses ?? []), ...i.presses].slice(-12) }
    }
    for (const [who, inp] of inputs) if (pointToTake(who, inp)) inp.presses = inp.presses.filter((x) => x !== 'wii-a' && x !== 'mouse-left')
    // Home on every device: the tray's Home, or the gamepad's Guide.
    perUnit.forEach((inp, n) => {
      if (!inp) return
      if (inp.presses.includes('home') || (inp.padPressed >>> PadButton.Guide) & 1) {
        logic.home(n)
        const who = s.claims.holder(units[n].id)!
        if (s.control.calibrated(who)) { s.control.position(who); perUnit[n] = null }
        if (who) s.remote.feedback({ haptic: 'tick', toast: `${units[n].name} went home` }, who)
        s.log(`${s.nameOf(who)} sent ${units[n].name} home`, s.colorOf(who))
      }
    })
    // What each holder's node strip chose: the one finger drives those parts, and the rest hold (./focus.ts).
    const focus = units.map((u) => { const who = s.claims.holder(u.id); return who && who !== 'host' ? s.focus.of(who) : null })
    perUnit.forEach((inp, n) => { if (inp && focus[n]) perUnit[n] = routeParts(spec, inp, focus[n]!, dt) })
    perUnit.forEach((inp, n) => { if (inp) perUnit[n] = mapFaceInput(spec.id, spec.controllers, inp, dt) })
    logic.step(perUnit, dt)
    if (logic.actionState) syncActionState(s.remote, who => {
      const n = unitOf(s.claims.held(who))
      return n < 0 ? { 'action.record': false } : logic.actionState!(n)
    })
    presence.afterStep()
    const events = logic.drain()
    deviceSound?.update(now, events)
    // While anyone drives a unit, or something happened, the device moves: the still picture starts again (../view.ts).
    // Left alone, the stage settles into its supersampled still.
    if (events.length || perUnit.some((i) => i)) stage.view.invalidate()
    for (const e of events) {
      if (e.kind === 'score') panels.get('scores')?.notify()
      const who = s.claims.holder(units[e.unit]?.id)
      if ((e.kind === 'tick' || e.kind === 'score') && who && e.text) s.remote.feedback({ toast: e.text }, who)
      if (e.text && (e.kind === 'score' || e.kind === 'fall')) s.log(`${who ? s.nameOf(who) : units[e.unit]?.name}: ${e.text}`, who ? s.colorOf(who) : undefined)
    }
    view?.update(units.map((u, n) => { const who = s.claims.holder(u.id); return aimed.has(n) ? '#c6ff34' : who ? s.colorOf(who) : null }), t, dt)
    // While a holder's trackpad drives parts on their own, they breathe in its colour on the model (the stage keeps
    // drawing while they do); on another controller the whole unit is driven, and nothing rings.
    const ringed = focus.map((f, n) => {
      const who = s.claims.holder(units[n].id)
      return f && who && inputs.get(who)?.face === 'face.trackpad' ? { parts: f.parts, locks: f.locks, color: s.colorOf(who) || null } : { parts: [], locks: new Set<string>(), color: null }
    })
    if (halos.update(ringed, t, dt)) stage.view.invalidate()
    if (following && presence.experience.followPlayer && view?.follow) {
      const active = perUnit.findIndex((i) => i && !i.quiet && (i.touching || i.held.size || i.presses.length || i.pose?.touching || spec.id === 'marblerun' && (i.space?.active || !!i.hold || Math.hypot(...i.tilt) > .01) || i.pad && [...i.pad.axes, ...i.pad.triggers].some((v) => Math.abs(v) > 0.04)))
      if (active >= 0) followedUnit = active
      stage.follow(view.follow(followedUnit))
    }
    drawCursors(inputs)
    refreshReadouts(now)
  }
})

stage.onFrame = (t, dt) => {
  // Before the scene is up the device idles, so the stage never stands empty.
  if (!presence.shared.guest) { const inputs = units.map((): DeviceInput | null => null); directMarbleInput(inputs); logic.step(inputs, dt) }
  deviceSound?.update(performance.now(), presence.shared.guest ? [] : logic.drain())
  view?.update(presence.shared.guest ? presence.shared.colors : units.map(() => null), t, dt)
}
if (presence.shared.guest) {
  document.querySelectorAll<HTMLButtonElement>('#home-all, #reset').forEach(b => { b.disabled = true })
  Object.assign(window, { __device: { spec, logic, units, stage } })
}
})
