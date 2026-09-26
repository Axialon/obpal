/**
 * Robot arm sim (CATALOGUE §7, system.robot-arm): a simulated five-joint arm with a gripper, driven by phones in a
 * shared scene. Each joint and the gripper is a node one person holds at a time. The safety envelope runs here, in the
 * "bridge", as it would beside a real arm: a deadman, joint limits with speed and acceleration caps, a 200 ms
 * watchdog, an e-stop on every device and the screen, approval before a first claim, and a record of who held what.
 */
import '../styles/base.css'
import '../styles/sim.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Mode, type Frame, type Layout, type PadState } from '@obpal/host'
import { applyTheme, initialTheme } from '../ui/themes'
import { startSimScene, type SimScene } from './scene'

applyTheme(initialTheme())
const $ = (id: string) => document.getElementById(id)!
const D2R = Math.PI / 180

// ---- the arm: joints are nodes, with limits a real controller would enforce ----

interface Joint {
  id: string
  name: string
  /** Degrees (the gripper: 0 closed … 1 open). */
  min: number
  max: number
  home: number
  /** Speed and acceleration caps, units per second (per second). */
  vmax: number
  amax: number
  unit: '°' | ''
  angle: number
  vel: number
  /** Where the joint is headed when it follows a target (1:1, home), else null. */
  target: number | null
  /** Why it isn't moving, for the screen: '', 'deadman', 'watchdog', 'limit', 'stopped'. */
  state: string
  apply(v: number): void
  /** Glowing ring in the holder's colour. */
  ring: THREE.Mesh
  flash: number
}

const renderer = new THREE.WebGLRenderer({ canvas: $('stage') as HTMLCanvasElement, antialias: true })
renderer.setPixelRatio(Math.min(2, Math.max(1.5, devicePixelRatio)))
renderer.toneMapping = THREE.ACESFilmicToneMapping
const scene = new THREE.Scene()
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
scene.background = new THREE.Color(document.documentElement.dataset.theme === 'light' ? '#e9edf3' : '#07090d')
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 50)
camera.position.set(1.6, 1.25, 1.9)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.45, 0)
controls.enableDamping = true
controls.minDistance = 1
controls.maxDistance = 5
controls.maxPolarAngle = Math.PI * 0.49

const metal = new THREE.MeshStandardMaterial({ color: '#c9d1dc', metalness: 0.85, roughness: 0.28 })
const dark = new THREE.MeshStandardMaterial({ color: '#1b2029', metalness: 0.6, roughness: 0.45 })
const accent = (c: string) => new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: c, emissiveIntensity: 0.25, metalness: 0.2, roughness: 0.4 })

// Floor and table.
const floor = new THREE.Mesh(new THREE.CircleGeometry(3.2, 96), new THREE.MeshStandardMaterial({ color: '#0e1118', metalness: 0.2, roughness: 0.9 }))
floor.rotation.x = -Math.PI / 2
scene.add(floor)
const grid = new THREE.PolarGridHelper(1.4, 8, 6, 96, '#27303d', '#1b222d')
grid.position.y = 0.001
scene.add(grid)

function ringAt(radius: number, tube = 0.012) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 12, 96), accent('#5b6472'))
  m.userData.ring = true
  return m
}

// Base (yaw) → shoulder (pitch) → upper arm → elbow (pitch) → forearm → wrist (pitch) → roll → gripper.
const base = new THREE.Group()
scene.add(base)
base.add(new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.27, 0.1, 64), dark).translateY(0.05))
const yaw = new THREE.Group()
yaw.position.y = 0.1
base.add(yaw)
yaw.add(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.16, 64), metal).translateY(0.08))
const yawRing = ringAt(0.2)
yawRing.rotation.x = Math.PI / 2
yawRing.position.y = 0.02
yaw.add(yawRing)

const shoulder = new THREE.Group()
shoulder.position.y = 0.26
yaw.add(shoulder)
const shoulderHub = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.2, 48), dark)
shoulderHub.rotation.x = Math.PI / 2
shoulder.add(shoulderHub)
const shoulderRing = ringAt(0.1)
shoulderRing.position.z = 0.105
shoulder.add(shoulderRing)
shoulder.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.55, 0.11), metal).translateY(0.275))

const elbow = new THREE.Group()
elbow.position.y = 0.55
shoulder.add(elbow)
const elbowHub = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.17, 48), dark)
elbowHub.rotation.x = Math.PI / 2
elbow.add(elbowHub)
const elbowRing = ringAt(0.082)
elbowRing.position.z = 0.09
elbow.add(elbowRing)
elbow.add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.46, 0.09), metal).translateY(0.23))

const wrist = new THREE.Group()
wrist.position.y = 0.46
elbow.add(wrist)
const wristHub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.13, 40), dark)
wristHub.rotation.x = Math.PI / 2
wrist.add(wristHub)
const wristRing = ringAt(0.065)
wristRing.position.z = 0.07
wrist.add(wristRing)
wrist.add(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.1, 40), metal).translateY(0.06))

const roll = new THREE.Group()
roll.position.y = 0.12
wrist.add(roll)
const rollRing = ringAt(0.052)
rollRing.rotation.x = Math.PI / 2
roll.add(rollRing)
const palm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.07), dark)
palm.position.y = 0.03
roll.add(palm)
const fingerGeo = new THREE.BoxGeometry(0.018, 0.1, 0.055)
const fingers = [new THREE.Mesh(fingerGeo, metal), new THREE.Mesh(fingerGeo, metal)]
for (const f of fingers) { f.position.y = 0.095; roll.add(f) }
const gripRing = ringAt(0.03, 0.008)
gripRing.position.y = 0.05
gripRing.rotation.x = Math.PI / 2
roll.add(gripRing)
/** Where held blocks sit, between the fingers. */
const grasp = new THREE.Object3D()
grasp.position.y = 0.11
roll.add(grasp)

function joint(id: string, name: string, min: number, max: number, home: number, vmax: number, amax: number, ring: THREE.Mesh, apply: (v: number) => void, unit: '°' | '' = '°'): Joint {
  return { id, name, min, max, home, vmax, amax, unit, angle: home, vel: 0, target: null, state: '', apply, ring, flash: 0 }
}
const joints: Joint[] = [
  joint('base', 'Base', -170, 170, 0, 70, 220, yawRing, (v) => { yaw.rotation.y = v * D2R }),
  joint('shoulder', 'Shoulder', -80, 95, 18, 55, 160, shoulderRing, (v) => { shoulder.rotation.z = v * D2R }),
  joint('elbow', 'Elbow', -135, 140, 72, 70, 220, elbowRing, (v) => { elbow.rotation.z = v * D2R }),
  joint('wrist', 'Wrist', -115, 115, 62, 90, 300, wristRing, (v) => { wrist.rotation.z = v * D2R }),
  joint('roll', 'Wrist roll', -180, 180, 0, 120, 400, rollRing, (v) => { roll.rotation.y = v * D2R }),
  joint('gripper', 'Gripper', 0, 1, 1, 1.4, 6, gripRing, (v) => {
    fingers[0].position.x = -0.012 - 0.042 * v
    fingers[1].position.x = 0.012 + 0.042 * v
  }, ''),
]
for (const j of joints) j.apply(j.angle)
const jointOf = (id: string) => joints.find((j) => j.id === id)!
Object.assign(window, { __arm: { joints, blocks: () => blocks.map((b) => b.held), stopped: () => stopped } })

// ---- blocks to pick up: the gripper closes on a block between its fingers; opening drops it ----

interface Block { mesh: THREE.Mesh; held: boolean; vy: number }
const blocks: Block[] = ['#38bdf8', '#fb7185', '#fcd34d'].map((c, i) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), new THREE.MeshStandardMaterial({ color: c, metalness: 0.1, roughness: 0.35, emissive: c, emissiveIntensity: 0.12 }))
  const a = (-0.5 + i * 0.5) * 1.1
  mesh.position.set(Math.sin(a) * 0.62 - 0.1, 0.03, Math.cos(a) * 0.62 * 0.4 + 0.25)
  scene.add(mesh)
  return { mesh, held: false, vy: 0 }
})
const tmp = new THREE.Vector3()
function updateBlocks(dt: number) {
  const grip = jointOf('gripper').angle
  grasp.getWorldPosition(tmp)
  for (const b of blocks) {
    if (b.held) {
      if (grip > 0.55) {
        // Let go: the block keeps its place in the world and falls.
        b.mesh.getWorldPosition(tmp)
        scene.attach(b.mesh)
        b.held = false
        b.vy = 0
      }
      continue
    }
    if (grip < 0.35 && b.mesh.position.distanceTo(tmp) < 0.06 && !blocks.some((o) => o.held)) {
      grasp.attach(b.mesh)
      b.mesh.position.set(0, 0, 0)
      b.held = true
      continue
    }
    // Fall to the floor (or onto another block).
    const rest = 0.03 + (blocks.some((o) => o !== b && !o.held && Math.hypot(o.mesh.position.x - b.mesh.position.x, o.mesh.position.z - b.mesh.position.z) < 0.055 && o.mesh.position.y < b.mesh.position.y) ? 0.06 : 0)
    if (b.mesh.position.y > rest + 1e-4) {
      b.vy -= 9.8 * dt
      b.mesh.position.y = Math.max(rest, b.mesh.position.y + b.vy * dt)
      b.mesh.quaternion.slerp(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, b.mesh.rotation.y, 0)), Math.min(1, dt * 6))
    } else b.vy = 0
  }
}

// ---- the shared scene ----

const layout: Layout = {
  v: 1,
  modes: [Mode.tilt, Mode.hold, Mode.gamepad],
  tray: [{ id: 'estop', label: 'Stop', type: 'button', icon: 'stop' }, { id: 'home', label: 'Home', type: 'button', icon: 'reset' }],
}
const HOW: Record<string, string> = {
  gripper: 'Hold a finger on the pad: tilt or drag to open and close, tap to toggle',
}
let sim: SimScene | null = null
/** When each participant's input last arrived: the watchdog stops a joint 200 ms after its input goes quiet. */
const lastInput = new Map<string, number>()
let stopped: { by: string } | null = null
let homing = false

function estop(by: string) {
  if (stopped) return
  stopped = { by }
  homing = false
  for (const j of joints) j.target = null
  document.body.classList.add('stopped')
  $('stop-by').textContent = `Stopped by ${sim?.nameOf(by) ?? 'the screen'}`
  sim?.log(`E-stop by ${sim.nameOf(by)}: every joint halted`, '#fb7185')
  sim?.remote.feedback({ haptic: 'bump', toast: 'Stopped: the screen resumes' })
  for (const p of sim?.remote.participants ?? []) if (p.id !== by) sim?.remote.feedback({ haptic: 'bump', toast: `${sim.nameOf(by)} stopped the arm` }, p.id)
}
function resume() {
  if (!stopped) return
  stopped = null
  document.body.classList.remove('stopped')
  sim?.log('Resumed from the screen')
}

void startSimScene({
  appName: 'ob.Pal robot arm (sim)',
  layout,
  nodes: joints.map((j) => ({ id: j.id, name: j.name, kind: j.id === 'gripper' ? 'gripper' : 'joint', group: 'Arm' })),
  approval: true,
  howTo: (n) => HOW[n] ?? 'Hold a finger on the pad: tilt or drag to move it. 1:1: turn the phone like a dial',
  changed: renderPanel,
}).then((s) => {
  sim = s
  s.remote.on('input', (who) => lastInput.set(who.id, performance.now()))
  s.remote.on('button', ({ id, ev }, who) => {
    if (id === 'estop') estop(who.id)
    else if (id === 'home') {
      const node = s.claims.held(who.id)
      if (node && !stopped) { const j = jointOf(node); j.target = j.home; s.log(`${who.name} sent ${j.name} home`, who.color) }
    } else if (id === 'pad' && ev === 'tap') {
      // Tapping the pad while holding the gripper toggles it.
      if (s.claims.held(who.id) === 'gripper' && !stopped) { const g = jointOf('gripper'); g.target = g.angle > 0.5 ? 0 : 1 }
    }
  })
  s.remote.on('leave', () => renderPanel())
  renderPanel()
})

$('estop').onclick = () => estop('host')
$('resume').onclick = resume
$('home-all').onclick = () => {
  if (stopped) return
  homing = true
  for (const j of joints) j.target = j.home
  sim?.log('The screen sent every joint home')
}
addEventListener('keydown', (e) => { if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); estop('host') } })

// ---- driving a joint: deadman, velocity from the input, then the controller's caps ----

const twistOf = (q: [number, number, number, number]) => 2 * Math.atan2(q[2], q[3]) / D2R
const dialBase = new Map<string, { grab: number; angle: number }>()

/** The velocity a participant commands for its joint this frame (units/s), or null when its deadman is released. */
function commanded(j: Joint, who: string, f: Frame, pad: PadState | null, dt: number): number | null {
  const span = j.max - j.min
  if (pad) {
    // Gamepad: a deflected stick is its own deadman; the triggers work the gripper.
    const x = Math.abs(pad.axes[0]) > 0.12 ? pad.axes[0] : Math.abs(pad.axes[2]) > 0.12 ? pad.axes[2] : 0
    const t = (pad.triggers[1] ?? 0) - (pad.triggers[0] ?? 0)
    if (j.id === 'gripper' && Math.abs(t) > 0.05) return -t * j.vmax
    return x ? x * j.vmax : null
  }
  // 1:1: turn the phone like a dial while holding the grab control; the joint follows the phone's twist.
  if (f.mode === Mode.hold && f.clutch) {
    const b = dialBase.get(who)
    if (!b || b.grab !== f.grab) dialBase.set(who, { grab: f.grab, angle: j.angle })
    const base = dialBase.get(who)!.angle
    const scale = j.unit === '°' ? 1 : 1 / 120
    j.target = Math.min(j.max, Math.max(j.min, base + twistOf(f.qRel) * scale))
    return 0
  }
  dialBase.delete(who)
  if (!f.touching) return null
  // A finger on the pad is the deadman: dragging moves the joint, tilting drives it.
  if (f.pad1[0] && dt > 0) return (f.pad1[0] * span / 900) / dt
  if (f.zoom && j.id === 'gripper' && dt > 0) return (f.zoom * 0.6) / dt
  if (f.mode === Mode.tilt) return f.tilt[0] * j.vmax
  return 0
}

let last = 0
function loop(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  const s = sim
  for (const j of joints) {
    const who = s?.claims.holder(j.id)
    let v = 0
    j.state = ''
    if (stopped) {
      j.state = 'stopped'
      j.target = null
    } else if (who && who !== 'host' && s) {
      const quiet = now - (lastInput.get(who) ?? 0) > 200
      const f = s.remote.consumeOf(who, now)
      const pad = s.remote.padOf(who)
      if (quiet) { j.state = 'watchdog'; if (!homing) j.target = null }
      else {
        const c = commanded(j, who, f, pad, dt)
        if (c === null) { j.state = 'deadman'; if (!homing) j.target = j.target !== null && j.id === 'gripper' ? j.target : null }
        else v = c
      }
    }
    // Following a target (1:1 dial, home, gripper toggle): a proportional approach under the same caps.
    if (j.target !== null && !stopped) {
      const e = j.target - j.angle
      v = Math.abs(e) < (j.unit === '°' ? 0.05 : 0.002) ? 0 : e * 6
      if (!v) j.target = null
    }
    v = Math.max(-j.vmax, Math.min(j.vmax, v))
    // Acceleration cap; an e-stop brakes four times harder.
    const a = (stopped ? 4 : 1) * j.amax * dt
    j.vel += Math.max(-a, Math.min(a, v - j.vel))
    let next = j.angle + j.vel * dt
    if (next <= j.min || next >= j.max) { next = Math.min(j.max, Math.max(j.min, next)); j.vel = 0; if (v) j.state = 'limit' }
    j.angle = next
    j.apply(j.angle)
    // The joint's ring wears its holder's colour, and flashes when control changes.
    const mat = j.ring.material as THREE.MeshStandardMaterial
    const color = who ? s!.colorOf(who) : '#5b6472'
    mat.emissive.set(color)
    j.flash = Math.max(0, j.flash - dt / 0.7)
    mat.emissiveIntensity = (who ? 1.4 : 0.25) + 2.2 * j.flash + (Math.abs(j.vel) > 1e-3 ? 0.6 : 0)
    j.ring.scale.setScalar(1 + 0.25 * j.flash)
  }
  if (homing && joints.every((j) => j.target === null)) homing = false
  updateBlocks(dt)
  controls.update()
  renderer.render(scene, camera)
  if (Math.floor(now / 100) !== Math.floor((now - dt * 1000) / 100)) renderReadouts()
  requestAnimationFrame(loop)
}

// ---- the screen's panel: each node, who holds it, where it is, and why it isn't moving ----

let heldBefore: Record<string, string> = {}
function renderPanel() {
  const list = $('nodes')
  const held = sim?.claims.snapshot() ?? {}
  for (const j of joints) if ((held[j.id] ?? '') !== (heldBefore[j.id] ?? '')) j.flash = 1
  heldBefore = held
  list.replaceChildren(...joints.map((j) => {
    const li = document.createElement('li')
    li.dataset.node = j.id
    const who = held[j.id]
    li.innerHTML = '<i class="dot"></i><span class="nn"><b></b><small></small></span><span class="nv"></span><span class="bar"><span></span></span>'
    li.querySelector('b')!.textContent = j.name
    const dot = li.querySelector<HTMLElement>('.dot')!
    if (who) dot.style.background = sim!.colorOf(who)
    li.querySelector('small')!.textContent = who ? sim!.nameOf(who) : 'Free'
    li.classList.toggle('held', !!who)
    if (who) {
      const x = document.createElement('button')
      x.className = 'chip-x'
      x.title = 'Take it back'
      x.textContent = '×'
      x.onclick = () => { sim?.take(j.id, 'host', true); sim?.release('host') }
      li.appendChild(x)
    }
    return li
  }))
  renderReadouts()
}
function renderReadouts() {
  for (const j of joints) {
    const li = document.querySelector<HTMLElement>(`#nodes li[data-node="${j.id}"]`)
    if (!li) continue
    li.querySelector('.nv')!.textContent = j.unit === '°' ? `${Math.round(j.angle)}°` : `${Math.round(j.angle * 100)}% open`
    li.querySelector<HTMLElement>('.bar span')!.style.width = `${((j.angle - j.min) / (j.max - j.min)) * 100}%`
    li.dataset.state = j.state
  }
}

/** Centre the stage in the space beside the panel (wide screens) or above it (narrow). */
function resize() {
  const w = innerWidth
  const h = innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  const panel = document.querySelector('.sim-panel')!.getBoundingClientRect()
  if (w > 860) camera.setViewOffset(w, h, -panel.right / 2, 0, w, h)
  else camera.setViewOffset(w, h, 0, (h - panel.top) / 2, w, h)
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()
renderPanel()
requestAnimationFrame(loop)
