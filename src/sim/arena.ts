import { contactPart, contactSurface } from './contact'
/**
 * Faction arena (CATALOGUE §7, system.gamepad-slots): four player slots in one shared scene. Each device claims a slot
 * (Player 1–4, one per faction) and drives its puck: tilt or the left stick to roll, a drag to push, a tap or A to
 * dash. Knock the others off the ring to score. The same slots are what ob.Pal Link will give a browser game: one
 * gamepad per phone.
 */
import '../styles/base.css'
import '../styles/sim.css'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { batch, bolt, cylinder, environment, floorMaterial, maker, plastic, softKey } from './kit'
import { blobShadow } from './devices/view'
import { Mode, type Frame, type Layout, type PadState } from '@obpal/host'
import { applyTheme, initialTheme } from '../ui/themes'
import { mountMarks } from '../ui/icons'
import { mountTopBar } from '../landing/topbar'
import { startSimScene, type SimScene } from './scene'
import { simView } from './view'
import { Experience } from './vr/experience'
import { SharedPresence } from './vr/presence'
import { looking, type Ride } from './vr/rigs'
import { ControlFrame } from './vr/control-frame'
import { mountSound } from './audio/session'
import { mountSimPanels, numberSections } from './ui/panels'
import { Readout } from '../ui/kit/readout'
import { mountQuick, quickAction, quickViews } from '../ui/quick'
import { modelFailed, startScene } from './kit/recovery'

startScene(() => {
applyTheme(initialTheme())
mountMarks()
mountTopBar()
// The quick-actions tray, before the windows, which keep clear of its edge.
mountQuick()
const $ = (id: string) => document.getElementById(id)!
const panels = mountSimPanels('arena', 'Controls')
const scores = panels.add($('score'), { id: 'scores', title: 'Scores', purpose: 'Player slots and points in this round', icon: 'scores', anchor: 'scores' })

const RING = 2.5
const PUCK = 0.17

interface Slot {
  id: string
  name: string
  faction: string
  model: string
  spawn: THREE.Vector2
  group: THREE.Group
  ring: THREE.Mesh
  pos: THREE.Vector2
  vel: THREE.Vector2
  falling: number
  dashAt: number
  lastHitBy: string | null
  lastHitAt: number
  points: number
  flash: number
}

// Drawn the way every sim is (./view.ts): clean edges at rest, smooth in motion.
const view = simView($('stage') as HTMLCanvasElement, { onResize: resize })
const renderer = view.renderer
renderer.toneMapping = THREE.ACESFilmicToneMapping
const scene = new THREE.Scene()
scene.environment = environment(renderer)
scene.add(new THREE.HemisphereLight('#ffffff', '#26313b', 1.1))
softKey(scene, 3)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
const surface = () => {
  scene.background = new THREE.Color(document.documentElement.dataset.bbTheme === 'carbon' ? '#06080c' : getComputedStyle(document.documentElement).getPropertyValue('--bb-page').trim())
}
surface()
addEventListener('bb-theme', surface)
const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 60)
camera.position.set(0, 4.3, 3.4)
camera.lookAt(0, 0, 0.15)

// The ring: a glass disc with a glowing edge over the void.
const disc = new THREE.Mesh(new THREE.CylinderGeometry(RING, RING, 0.08, 96), floorMaterial('#252e34'))
disc.receiveShadow = true
disc.position.y = -0.04
scene.add(contactSurface(disc))
const edge = new THREE.Mesh(new THREE.TorusGeometry(RING, 0.018, 12, 160), new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#c6ff34', emissiveIntensity: 0.9 }))
edge.rotation.x = Math.PI / 2
scene.add(edge)
const inner = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.36, 96), new THREE.MeshBasicMaterial({ color: '#2a3342', side: THREE.DoubleSide }))
inner.rotation.x = -Math.PI / 2
inner.position.y = 0.001
scene.add(inner)
const plinth = cylinder(RING * 0.92, 0.3, plastic('#151b20'), 96)
plinth.position.y = -0.23
scene.add(plinth)
const lanes = new THREE.Group()
for (let i = 0; i < 24; i++) {
  const a = i / 24 * Math.PI * 2
  const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.018, 0.18), plastic('#566569'))
  mark.rotation.set(-Math.PI / 2, 0, -a)
  mark.position.set(Math.sin(a) * RING * 0.9, 0.002, Math.cos(a) * RING * 0.9)
  lanes.add(mark)
}
batch(lanes); scene.add(lanes)

const FACTIONS = [
  { faction: 'CVC', model: '/models/cvc/CVC_insignia.glb' },
  { faction: 'CC', model: '/models/cvc/CC_insignia.glb' },
  { faction: 'K9C', model: '/models/cvc/K9C_insignia.glb' },
  { faction: 'MMC', model: '/models/cvc/MMC_insignia.glb' },
]
const loader = new GLTFLoader()
const slots: Slot[] = FACTIONS.map((f, i) => {
  const a = Math.PI / 4 + (i * Math.PI) / 2
  const spawn = new THREE.Vector2(Math.cos(a) * RING * 0.55, Math.sin(a) * RING * 0.55)
  const group = new THREE.Group()
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(PUCK, PUCK * 1.05, 0.07, 64), new THREE.MeshStandardMaterial({ color: '#171c25', metalness: 0.7, roughness: 0.3 }))
  puck.position.y = 0.035
  puck.castShadow = true
  group.add(contactPart(puck, `puck-${i}`, { active: () => group.visible, mode: () => slots[i].falling ? 'free' : 'touch' }))
  const bumper = new THREE.Mesh(new THREE.TorusGeometry(PUCK, 0.014, 8, 48), plastic('#11171d'))
  bumper.rotation.x = Math.PI / 2; bumper.position.y = 0.027; group.add(bumper)
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; const screw = bolt(0.007); screw.position.set(Math.cos(a) * PUCK * 0.76, 0.073, Math.sin(a) * PUCK * 0.76); group.add(screw) }
  maker(group, 0, 0.073, PUCK * 0.64, 0.025)
  group.add(blobShadow(PUCK * 1.15, 0.5))
  const ring = new THREE.Mesh(new THREE.TorusGeometry(PUCK * 1.02, 0.012, 10, 80), new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: '#5b6472', emissiveIntensity: 1 }))
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.07
  group.add(ring)
  batch(group, [ring])
  group.visible = false
  scene.add(group)
  // The faction's insignia rides on top of its puck.
  loader.load(f.model, (g) => {
    const m = g.scene
    // These small, rigid insignias need one draw per finish, including their crystal facets.
    m.traverse(o => { if (!(o as THREE.Mesh).isMesh) o.userData.static = true })
    batch(m, [], true)
    const box = new THREE.Box3().setFromObject(m)
    const size = box.getSize(new THREE.Vector3())
    const k = (PUCK * 1.5) / Math.max(size.x, size.y, size.z)
    m.scale.setScalar(k)
    box.setFromObject(m)
    const c = box.getCenter(new THREE.Vector3())
    m.position.sub(c)
    const holder = new THREE.Group()
    holder.add(m)
    holder.position.y = 0.07 + (box.max.y - box.min.y) / 2
    holder.name = 'insignia'
    group.add(holder)
  }, undefined, modelFailed)
  return { id: `p${i + 1}`, name: `Player ${i + 1} · ${f.faction}`, faction: f.faction, model: f.model, spawn, group, ring, pos: spawn.clone(), vel: new THREE.Vector2(), falling: 0, dashAt: -9, lastHitBy: null, lastHitAt: 0, points: 0, flash: 0 }
})
const slotOf = (id: string) => slots.find((s) => s.id === id)!
Object.assign(window, { __arena: { slots } })

// ---- the shared scene ----

const layout: Layout = { v: 1, modes: [Mode.tilt, Mode.gamepad], tray: [{ id: 'dash', label: 'Dash', type: 'button', icon: 'spin' }] }
let sim: SimScene | null = null
const sound = mountSound('arena', (strong, weak, ms, who) => sim?.remote.rumble(strong, weak, ms, who))
numberSections(document.querySelector('.arena-panel')!)
let soundAt = 0
const xrPads = new Map<string, { pad: PadState; at: number }>()
const rides = (): Ride[] => slots.map(s => {
  const seat = () => looking(new THREE.Vector3(s.spawn.x * 2.5, 2.1, s.spawn.y * 2.5), new THREE.Vector3(0, 0.1, 0))
  return { id: s.id, name: s.name, style: 'table', horizon: true, pose: seat, views: [{ name: 'Player', pose: seat }, { name: 'Wide', pose: () => looking(new THREE.Vector3(s.spawn.x * 3.2, 3.3, s.spawn.y * 3.2), new THREE.Vector3()) }] }
})
const shared = new SharedPresence({
  rides,
  capture: () => slots.map(s => ({ p: s.group.position.toArray(), visible: s.group.visible, color: (s.ring.material as THREE.MeshStandardMaterial).emissive.getHex() })),
  apply: state => { (state as { p: [number, number, number]; visible: boolean; color: number }[]).forEach((r, i) => { const s = slots[i]; if (!s) return; s.group.position.set(...r.p); s.pos.set(r.p[0], r.p[2]); s.group.visible = r.visible; (s.ring.material as THREE.MeshStandardMaterial).emissive.setHex(r.color) }) },
  drive(who, ride, pad) { if (!sim) return; if (!sim.claims.holder(ride)) sim.take(ride, who); if (sim.claims.holder(ride) === who) xrPads.set(who, { pad, at: performance.now() }) },
  colliders: () => slots.filter(s => s.group.visible).map(s => ({ p: [s.pos.x, 0.15, s.pos.y], r: PUCK })),
})
scene.add(shared.group)
view.presence = new Experience(renderer, scene, camera, rides, shared)
if (!shared.guest) shared.world.add('ball', [0, 0.16, 0], 0.16)
if (!shared.guest) void startSimScene({
  appName: 'ob.Pal faction arena',
  layout,
  nodes: slots.map((s) => ({ id: s.id, name: s.name, kind: 'slot', group: 'Players' })),
  approval: false,
  howTo: () => 'Tilt to roll · drag to push · tap to dash',
  changed: () => { spawnHeld(); renderScore() },
}).then((s) => {
  sim = s
  shared.connect(s.remote)
  s.remote.on('button', ({ id, ev }, who) => {
    const node = s.claims.held(who.id)
    if (!node) return
    if (id === 'dash' || (id === 'pad' && ev === 'tap')) dash(slotOf(node), who.id)
  })
  renderScore()
})
$('reset-scores').onclick = () => { for (const s of slots) s.points = 0; renderScore(); sim?.log('Scores reset') }
// The quick-actions tray: its camera goes from the ring to a player's own view (the viewpoint row's first person) and
// back; its reset clears the scores.
quickViews([
  { name: 'Overview', show: () => { void view.presence?.leave() } },
  { name: 'First person', show: () => document.querySelector<HTMLButtonElement>('.presence-controls .presence-enter')?.click(), current: () => view.presence?.mode === 'first-person', phone: true },
])
if (!shared.guest) quickAction({ id: 'reset', group: 'page', label: 'Reset', hint: 'The scores back to nothing', icon: 'reset', run: () => $('reset-scores').click() })

/** A slot that just got a player enters at its spawn point; an empty one leaves the ring. */
function spawnHeld() {
  for (const s of slots) {
    const who = sim?.claims.holder(s.id)
    if (who && !s.group.visible) { respawn(s); s.flash = 1 }
    if (!who && s.group.visible) s.group.visible = false
  }
}
function respawn(s: Slot) {
  s.pos.copy(s.spawn)
  s.vel.set(0, 0)
  s.falling = 0
  s.lastHitBy = null
  s.group.position.set(s.pos.x, 0, s.pos.y)
  s.group.visible = true
}
function dash(s: Slot, who: string) {
  const now = performance.now() / 1000
  if (now - s.dashAt < 1.1 || s.falling) return
  s.dashAt = now
  const dir = s.vel.lengthSq() > 1e-4 ? s.vel.clone().normalize() : s.spawn.clone().negate().normalize()
  s.vel.addScaledVector(dir, 2.6)
  s.flash = Math.max(s.flash, 0.7)
  sound.bus.emit({ kind: 'action', action: 'launch', source: s.id, at: [s.pos.x, 0.1, s.pos.y], strength: 0.6, who })
}

/** The direction a player steers, from whatever its device sends. */
function steer(f: Frame, pad: PadState | null): THREE.Vector2 {
  if (pad) return new THREE.Vector2(pad.axes[0], pad.axes[1])
  const d = new THREE.Vector2(f.tilt[0], f.tilt[1])
  if (f.pad1[0] || f.pad1[1]) d.add(new THREE.Vector2(f.pad1[0], f.pad1[1]).multiplyScalar(0.08))
  return d
}

const padA = new Map<string, number>()
let last = 0
function loop(now: number) {
  const dt = last ? Math.min(0.033, (now - last) / 1000) : 0
  last = now
  if (shared.guest) { view.draw(scene, camera, dt); return }
  const t = now / 1000
  const active = slots.filter((s) => s.group.visible)
  for (const s of active) {
    const who = sim?.claims.holder(s.id)
    if (!who || !sim) continue
    if (s.falling) continue
    const f = sim.remote.consumeOf(who, now)
    const xrPad = xrPads.get(who)
    const pad = xrPad && now - xrPad.at < 300 ? xrPad.pad : sim.remote.padOf(who)
    // A on a gamepad dashes, once per press.
    const a = pad ? pad.buttons & 1 : 0
    if (a && !padA.get(who)) dash(s, who)
    padA.set(who, a)
    const calibrated = sim.control.aim(who)
    const d = steer(calibrated && !pad ? { ...f, tilt: calibrated.tilt } : f, pad)
    const head = xrPad ? shared.people.get(who)?.head.q : undefined
    const frame = head ? new ControlFrame().set(new THREE.Quaternion(...head)) : view.presence!.controlFrame
    d.set(...frame.planar(d.x, d.y))
    if (d.lengthSq() > 1) d.normalize()
    s.vel.addScaledVector(d, 4.3 * dt)
  }
  // Rolling: drag, a speed cap, then collisions between pucks.
  for (const s of active) {
    if (s.falling) continue
    s.vel.multiplyScalar(Math.exp(-1.5 * dt))
    const sp = s.vel.length()
    if (sp > 3.8) s.vel.multiplyScalar(3.8 / sp)
    s.pos.addScaledVector(s.vel, dt)
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]
      const b = active[j]
      if (a.falling || b.falling) continue
      const n = b.pos.clone().sub(a.pos)
      const dist = n.length()
      if (dist >= PUCK * 2 || dist < 1e-6) continue
      n.divideScalar(dist)
      const push = (PUCK * 2 - dist) / 2
      a.pos.addScaledVector(n, -push)
      b.pos.addScaledVector(n, push)
      const rel = a.vel.clone().sub(b.vel).dot(n)
      if (rel > 0) {
        const imp = rel * 0.95
        a.vel.addScaledVector(n, -imp)
        b.vel.addScaledVector(n, imp)
        const ha = sim?.claims.holder(a.id)
        const hb = sim?.claims.holder(b.id)
        a.lastHitBy = hb ?? null
        b.lastHitBy = ha ?? null
        a.lastHitAt = b.lastHitAt = t
        a.flash = b.flash = Math.max(0.5, Math.min(1, rel / 2))
        sound.bus.emit({ kind: 'contact', source: a.id, at: [a.pos.x, 0.1, a.pos.y], strength: 1, speed: rel, impulse: imp, who: ha })
        sound.bus.emit({ kind: 'contact', source: b.id, at: [b.pos.x, 0.1, b.pos.y], strength: 1, speed: rel, impulse: imp, who: hb })
      }
    }
  }
  // Over the edge: the puck falls; whoever hit it last in the past 3 s scores.
  for (const s of active) {
    if (!s.falling && s.pos.length() > RING + PUCK * 0.4) {
      s.falling = t
      const by = s.lastHitBy && t - s.lastHitAt < 3 ? s.lastHitBy : null
      const scorer = by ? slots.find((o) => sim?.claims.holder(o.id) === by) : null
      if (scorer) { scorer.points++; scorer.flash = 1; sim?.log(`${sim.nameOf(by!)} knocked ${sim.nameOf(sim.claims.holder(s.id))} off`, sim.colorOf(by!)) }
      else sim?.log(`${sim.nameOf(sim.claims.holder(s.id))} rolled off`, sim.colorOf(sim.claims.holder(s.id)))
      const who = sim?.claims.holder(s.id)
      sound.bus.emit({ kind: 'contact', source: s.id, at: [s.pos.x, 0.1, s.pos.y], strength: 0.9, who })
      renderScore()
    }
    if (s.falling) {
      s.group.position.y -= 3 * dt * (t - s.falling + 0.2)
      if (t - s.falling > 1.2) respawn(s)
    }
    if (!s.falling) s.group.position.set(s.pos.x, 0, s.pos.y)
    // The puck wears its player's colour, flashes on a hit, and its insignia turns.
    const who = sim?.claims.holder(s.id)
    const mat = s.ring.material as THREE.MeshStandardMaterial
    mat.emissive.set(who ? sim!.colorOf(who) : '#5b6472')
    s.flash = Math.max(0, s.flash - dt / 0.6)
    mat.emissiveIntensity = 1.4 + 3 * s.flash
    s.ring.scale.setScalar(1 + 0.3 * s.flash)
    const ins = s.group.getObjectByName('insignia')
    if (ins) ins.rotation.y = t * 0.9 + Number(s.id.slice(1))
  }
  // The ring's edge breathes while anyone plays; with nobody here, it glows steady (and the still picture can settle).
  ;(edge.material as THREE.MeshStandardMaterial).emissiveIntensity = active.length ? 0.8 + 0.2 * Math.sin(t * 2) : 0.9
  if (now - soundAt >= 50) {
    soundAt = now
    for (const s of active) if (!s.falling) sound.bus.emit({ kind: 'sustain', source: s.id, at: [s.pos.x, 0.1, s.pos.y], strength: s.vel.length() / 4, texture: 'roll', who: sim?.claims.holder(s.id) })
  }
  sound.tick(now)
  view.draw(scene, camera, dt)
}

function renderScore() {
  scores.notify()
  const held = sim?.claims.snapshot() ?? {}
  $('score').replaceChildren(...slots.map((s) => {
    const li = document.createElement('li')
    const who = held[s.id]
    li.classList.toggle('held', !!who)
    li.innerHTML = '<span class="fx"></span><span><b></b><small></small></span><span class="pts"></span>'
    const fx = li.querySelector<HTMLElement>('.fx')!
    fx.textContent = s.faction
    fx.style.background = who ? sim!.colorOf(who) : 'rgb(var(--hl-rgb) / 0.15)'
    li.querySelector('b')!.textContent = `Player ${s.id.slice(1)}`
    li.querySelector('small')!.textContent = who ? sim!.nameOf(who) : 'Open: pick it on your phone'
    // The points as a dot-matrix counter.
    li.querySelector('.pts')!.append(new Readout({ value: s.points, pitch: 3, label: 'points' }).el)
    return li
  }))
}

function resize() {
  const w = view.width
  const h = view.height
  camera.aspect = w / h
  // Keep the whole ring in view on narrow screens, and centred beside (or above) the panel.
  camera.position.set(0, w < h ? 9.5 : 6.4, w < h ? 7.4 : 5)
  const halfAngle = Math.atan(Math.tan(camera.fov * Math.PI / 360) * Math.min(1, w / h))
  camera.position.setLength(Math.max(camera.position.length(), RING * 1.08 / Math.sin(halfAngle)))
  camera.lookAt(0, 0, 0.15)
  const control = panels.get('controls')!, panel = control.placement.rect
  if (control.visible && panel.x < 80 && panel.w < w / 2) camera.setViewOffset(w, h, -(panel.x + panel.w) / 2, 0, w, h)
  else camera.clearViewOffset()
  camera.updateProjectionMatrix()
}
resize()
renderScore()
renderer.setAnimationLoop(loop)
})
