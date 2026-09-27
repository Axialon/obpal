/**
 * Robot arms (CATALOGUE §7, system.robot-arm): one to four arms in a shared scene, driven by phones. Each arm offers a
 * whole-arm node and a node per joint, by the control profile the screen picks. Whoever holds the whole arm moves it
 * with the phone. Point (Wii-style): aim at a spot on the floor and hold B, and the arm goes there; A picks up or
 * drops like a claw; + and − set the height. 3D (Android): hold the pad and move the phone, and the gripper moves as
 * the hand does, through space. 1:1: with the gyro on and a thumb on the pad, turning swings the arm,
 * tipping raises it and twisting rolls the wrist. Holding the whole arm holds its joints, so nobody else takes one.
 *
 * Each arm is a digital twin. Connect a real one (./drivers.ts) and the twin follows it; once the screen puts it
 * live, the twin's joints drive the hardware at a capped speed. The safety envelope runs here, in the bridge: a
 * deadman, joint limits with speed and acceleration caps, the floor (no part of the arm goes below it, whatever it's
 * asked), a 200 ms watchdog, an e-stop on every device and the screen that holds position, approval before a first
 * claim, a check that a real arm keeps up, and a record of who held what.
 */
import '../../styles/base.css'
import '../../styles/sim.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { SceneNode } from '@obpal/core'
import { Mode, PadButton, type Frame, type Layout, type PadState, type Quat } from '@obpal/host'
import { applyTheme, initialTheme } from '../../ui/themes'
import { mountMarks } from '../../ui/icons'
import { mountTopBar } from '../../landing/topbar'
import { startSimScene, type SimScene } from '../scene'
import {
  calibrateHome, defaultCalibration, FeetechDriver, fromRaw, hasSerial, RosDriver, ROS_DEFAULTS, SerialTextDriver, toRaw,
  type ArmDriver, type Calibration, type DriverKind,
} from './drivers'
import { armParts, eject, restOf, settle as settleBlocks, stepAmong, type Blk, type Stand } from './blocks'
import { holding, type GripBox, type V3 } from './grasp'
import { forward, inverse, stepAboveFloor, toolFloor, type ArmPose, type ToolTarget } from './kinematics'
import { buildArm, JOINTS, type ArmModel, type JointSpec } from './model'
import { reachDown, solveNear } from './reach'
import { GlowFollower, handMove, handTurn, headingOf } from '@obpal/host'
import { ScreenPointer } from '../../viewer/pointer'

applyTheme(initialTheme())
mountMarks()
mountTopBar()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ---- the stage: a work cell, arms around a shared floor ----

const renderer = new THREE.WebGLRenderer({ canvas: $('stage') as HTMLCanvasElement, antialias: true })
renderer.setPixelRatio(Math.min(2, Math.max(1.5, devicePixelRatio)))
renderer.toneMapping = THREE.ACESFilmicToneMapping
const scene = new THREE.Scene()
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture
scene.background = new THREE.Color(document.documentElement.dataset.theme === 'light' ? '#e9edf3' : '#07090d')
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60)
camera.position.set(2.2, 2.1, 3.1)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 0.35, 0)
controls.enableDamping = true
controls.minDistance = 1.2
controls.maxDistance = 7
controls.maxPolarAngle = Math.PI * 0.49

const mats = {
  metal: new THREE.MeshStandardMaterial({ color: '#c9d1dc', metalness: 0.85, roughness: 0.28 }),
  dark: new THREE.MeshStandardMaterial({ color: '#1b2029', metalness: 0.6, roughness: 0.45 }),
}
const floor = new THREE.Mesh(new THREE.CircleGeometry(4.2, 128), new THREE.MeshStandardMaterial({ color: '#0e1118', metalness: 0.2, roughness: 0.9 }))
floor.rotation.x = -Math.PI / 2
scene.add(floor)
const grid = new THREE.PolarGridHelper(2, 8, 8, 128, '#27303d', '#1b222d')
grid.position.y = 0.001
scene.add(grid)
// The cell's fence: everything inside is within some arm's reach.
const fence = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.008, 8, 192), new THREE.MeshBasicMaterial({ color: '#f59e0b', transparent: true, opacity: 0.55 }))
fence.rotation.x = Math.PI / 2
fence.position.y = 0.004
scene.add(fence)

// ---- arms ----

type Profile = 'both' | 'arm' | 'joints'
const PROFILES: { id: Profile; name: string }[] = [
  { id: 'both', name: 'Whole arm and joints' },
  { id: 'arm', name: 'Whole arm only' },
  { id: 'joints', name: 'Joints only' },
]
/** Hand to arm (3D): the sim's arm reaches further than a hand does; a small real arm wants less. */
const SCALES = [0.5, 1, 1.5, 2, 3]

interface Joint {
  spec: JointSpec
  node: string
  angle: number
  vel: number
  /** Where the joint is headed when it follows a target (the whole arm, 1:1, home, the gripper), else null. */
  target: number | null
  /** Why it isn't moving, for the screen: '', 'deadman', 'watchdog', 'limit', 'floor', 'edge', 'mirror', 'stopped'. */
  state: string
  flash: number
}

/** A whole-arm drive, from when its holder's deadman went down: where the tool was, and where the phone pointed. */
interface Drive { grab: number; following: boolean; q0: THREE.Quaternion | null; ref: ToolTarget; acc: ToolTarget }

interface Hardware {
  driver: ArmDriver
  cal: Calibration
  live: boolean
  /** Speed cap while live, a fraction of the sim's. */
  cap: number
  since: number
  /** Since when the real arm has lagged the twin too far (0: it hasn't). */
  lagSince: number
}

interface Arm {
  n: number
  id: string
  name: string
  model: ArmModel
  joints: Joint[]
  profile: Profile
  drive: Drive | null
  /** The whole arm's goal is past what the arm can reach (it holds the last pose it could). */
  edge: boolean
  state: string
  homing: boolean
  flash: number
  hw: Hardware | null
  /** Point and go: how high the gripper hovers over the spot (m), and a claw pick or drop in progress. */
  hover: number
  claw: Claw | null
  /** 3D: where the phone and the gripper were when the thumb went down, and how far the gripper goes per metre of hand. */
  track: Track3 | null
  scale: number
  /** The tool target a 3D drive last asked for (for the record and tests). */
  goal: ToolTarget | null
  /** A block stopped some of its joints this frame (the claw takes that as having come down on something). */
  blocked: boolean
}

interface Track3 { gen: number; p0: [number, number, number]; q0: [number, number, number, number]; heading: number; tool: THREE.Vector3; pitch: number; roll: number }

/** A claw move (A in Point): down to the floor, close or open, back up to the hover height. */
interface Claw {
  phase: 'down' | 'grip' | 'up'
  pick: boolean
  yaw: number
  reach: number
  since: number
  /** Where the gripper is headed, and how far it's been sent so far (the sim's own arm goes straight up or down). */
  goal: number
  h: number
  at: number
}

/** Arms stand around the middle, facing it: left, right, back, front. */
const SLOTS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]]
const CELL = 0.78
const MAX_ARMS = 4
const arms: Arm[] = []
/** The panel: who held what when it was last drawn (to flash changes), and which arms have their settings open. */
let heldBefore: Record<string, string> = {}
const openTools = new Set<string>()
const armOf = (id: string) => arms.find((a) => a.id === id)
/** A node's arm, and its joint (none: the whole arm). */
function findNode(node: string): { arm: Arm; joint?: Joint } | null {
  const arm = armOf(node.split('.')[0])
  if (!arm) return null
  return node === arm.id ? { arm } : { arm, joint: arm.joints.find((j) => j.node === node) }
}

function nodesOf(a: Arm): SceneNode[] {
  const whole: SceneNode = { id: a.id, name: 'Whole arm', kind: 'arm', group: a.name }
  const joints: SceneNode[] = a.joints.map((j) => ({
    id: j.node, name: j.spec.name, kind: j.spec.key === 'gripper' ? 'gripper' : 'joint', group: a.name,
    ...(a.profile === 'both' ? { parent: a.id } : {}),
  }))
  return a.profile === 'arm' ? [whole] : a.profile === 'joints' ? joints : [whole, ...joints]
}

function addArm(): Arm | null {
  const used = new Set(arms.map((a) => a.n))
  const n = [1, 2, 3, 4].find((k) => !used.has(k))
  if (!n) return null
  const model = buildArm(n, mats)
  const [x, z] = SLOTS[n - 1]
  model.root.position.set(x * CELL, 0, z * CELL)
  // Reach (local −x) toward the middle.
  model.root.rotation.y = Math.atan2(z, x) + Math.PI
  scene.add(model.root)
  const id = `a${n}`
  const joints: Joint[] = JOINTS.map((spec) => ({ spec, node: `${id}.${spec.key}`, angle: spec.home, vel: 0, target: null, state: '', flash: 0 }))
  joints.forEach((j, i) => model.apply[i](j.angle))
  const arm: Arm = { n, id, name: `Arm ${n}`, model, joints, profile: 'both', drive: null, edge: false, state: '', homing: false, flash: 0, hw: null, hover: 0.2, claw: null, track: null, scale: 1.5, goal: null, blocked: false }
  arms.push(arm)
  arms.sort((a, b) => a.n - b.n)
  refreshNodes()
  return arm
}

async function removeArm(a: Arm) {
  if (a.hw?.live) { sim?.note(`${a.name} is live: take it off live first`); return }
  if (a.hw) await disconnect(a)
  for (const b of blocks) if (b.by === a) drop(b)
  a.model.dispose()
  arms.splice(arms.indexOf(a), 1)
  for (const n of [a.id, ...a.joints.map((j) => j.node)]) sim?.claims.unnest(n)
  sim?.log(`The screen removed ${a.name}`)
  refreshNodes()
}

function setProfile(a: Arm, p: Profile) {
  if (a.profile === p) return
  a.profile = p
  sim?.log(`${a.name}: ${PROFILES.find((x) => x.id === p)!.name.toLowerCase()}`)
  refreshNodes()
}

/** Offer every arm's nodes, by profile. A joint always sits inside its arm, so the two never have different holders. */
function refreshNodes() {
  if (sim) {
    for (const a of arms) for (const j of a.joints) sim.claims.nest(j.node, a.id)
    sim.setNodes(arms.flatMap(nodesOf))
  }
  renderPanel()
}

const poseOf = (a: Arm): ArmPose => ({ yaw: a.joints[0].angle, shoulder: a.joints[1].angle, elbow: a.joints[2].angle, wrist: a.joints[3].angle, roll: a.joints[4].angle })
const POSE_KEYS = ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const
const within = (p: ArmPose) => POSE_KEYS.every((k, i) => p[k] >= JOINTS[i].min && p[k] <= JOINTS[i].max)
function setPose(a: Arm, p: ArmPose) { POSE_KEYS.forEach((k, i) => { a.joints[i].target = p[k] }) }
/** The whole arm stops where it is (the gripper keeps what it was told). */
function settle(a: Arm) {
  a.drive = null
  a.claw = null
  a.track = null
  if (!a.homing) for (let i = 0; i < 5; i++) a.joints[i].target = null
}
function toggleGrip(a: Arm) {
  const g = a.joints[5]
  // Closed on a block, it's shut, however wide the block keeps it.
  const shut = blocks.some((b) => b.by === a) || (g.target ?? g.angle) <= 0.5
  g.target = shut ? 1 : 0
}
function homeArm(a: Arm, by: string) {
  a.drive = null
  a.claw = null
  a.homing = true
  for (const j of a.joints) j.target = j.spec.home
  sim?.log(`${sim.nameOf(by)} sent ${a.name} home`, sim.colorOf(by))
}

// ---- blocks on the shared floor: pushed along it, stopping what they can't give way to, held (./blocks.ts) ----

const BLOCK = 0.06
const BLOCK_HALF: V3 = [BLOCK / 2, BLOCK / 2, BLOCK / 2]
interface Block {
  mesh: THREE.Mesh
  by: Arm | null
  vy: number
  /** The opening its holder's fingers stopped at on it. */
  grip: number
}
const blocks: Block[] = ['#38bdf8', '#fb7185', '#fcd34d', '#a78bfa', '#34d399', '#f472b6'].map((c, i) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(BLOCK, BLOCK, BLOCK), new THREE.MeshStandardMaterial({ color: c, metalness: 0.1, roughness: 0.35, emissive: c, emissiveIntensity: 0.12 }))
  const a = (i / 6) * Math.PI * 2 + 0.5
  const r = i % 2 ? 0.34 : 0.22
  mesh.position.set(Math.cos(a) * r, BLOCK / 2, Math.sin(a) * r)
  scene.add(mesh)
  return { mesh, by: null, vy: 0, grip: 0 }
})
const bq = new THREE.Quaternion()
const bm = new THREE.Matrix4()
const level = new THREE.Quaternion()
const levelTurn = new THREE.Euler()
function drop(b: Block) {
  scene.attach(b.mesh)
  b.by = null
  b.vy = 0
}
/** How far a block reaches above (and below) its middle, as it's turned. */
function halfHeight(b: Block) {
  const e = bm.makeRotationFromQuaternion(b.mesh.getWorldQuaternion(bq)).elements
  return (BLOCK / 2) * (Math.abs(e[1]) + Math.abs(e[5]) + Math.abs(e[9]))
}
const bx = new THREE.Vector3()
const bz = new THREE.Vector3()
const yq = new THREE.Quaternion()
/** How a block is turned about the vertical: whichever of its sides lies flatter says. */
function yawOf(q: THREE.Quaternion) {
  bx.set(1, 0, 0).applyQuaternion(q)
  bz.set(0, 0, 1).applyQuaternion(q)
  return Math.abs(bx.y) <= Math.abs(bz.y) ? Math.atan2(-bx.z, bx.x) : Math.atan2(bz.x, bz.z)
}
/** A free block as ./blocks.ts has it. */
const blkOf = (b: Block): Blk => ({ x: b.mesh.position.x, y: b.mesh.position.y, z: b.mesh.position.z, yaw: yawOf(b.mesh.quaternion), half: BLOCK_HALF })
/** Move a free block to where ./blocks.ts put it, turning it about the vertical as far as it turned it. */
function setBlk(b: Block, t: Blk) {
  b.mesh.position.set(t.x, t.y, t.z)
  const turn = t.yaw - yawOf(b.mesh.quaternion)
  if (Math.abs(turn) > 1e-9) b.mesh.quaternion.premultiply(yq.setFromAxisAngle(UP, turn))
}
/** Where an arm stands, its parts (and what it holds) as boxes, and every arm's base, for ./blocks.ts. */
const standOf = (a: Arm): Stand => ({ x: a.model.root.position.x, z: a.model.root.position.z, turn: a.model.root.rotation.y })
const partsOf = (a: Arm) => armParts(standOf(a), poseOf(a), a.joints[5].angle, heldBox(a))
const bases = () => arms.map((a) => ({ x: a.model.root.position.x, z: a.model.root.position.z }))

function updateBlocks(dt: number) {
  const free = blocks.filter((b) => !b.by)
  const all = free.map(blkOf)
  free.forEach((b, i) => {
    // Down to the floor, or onto a block under it (one whose middle it's over: past an edge, it slides off), levelling
    // as it goes: it rests on its lowest corner or face, never in what's under it.
    const rest = restOf(all[i], all.filter((_, j) => j !== i))
    const p = b.mesh.position
    p.x = rest.x
    p.z = rest.z
    level.setFromEuler(levelTurn.set(0, yawOf(b.mesh.quaternion), 0))
    if (b.mesh.quaternion.angleTo(level) > 1e-4) b.mesh.quaternion.slerp(level, Math.min(1, dt * 6))
    const y = rest.y - BLOCK / 2 + halfHeight(b)
    if (p.y > y + 1e-4) {
      b.vy -= 9.8 * dt
      p.y = Math.max(y, p.y + b.vy * dt)
    } else {
      b.vy = 0
      p.y = y
    }
    all[i] = blkOf(b)
  })
  // Nothing in anything: a block that fell against an arm, or that another arm's push left in one, is pushed out of it,
  // and out of the other blocks and the bases; one pinned among them goes where there's room.
  const parts = arms.flatMap(partsOf)
  if (settleBlocks(all, [], parts, bases()) !== 'ok') eject(all, parts, bases())
  free.forEach((b, i) => setBlk(b, all[i]))
}

// ---- an arm among the blocks: what it holds, what it pushes, and what stops it (./blocks.ts) ----

const m4 = new THREE.Matrix4()

/** The block an arm holds, in its gripper's frame, where it sits fixed while held; or null. */
function heldBox(a: Arm): GripBox | null {
  const b = blocks.find((o) => o.by === a)
  if (!b) return null
  const e = bm.makeRotationFromQuaternion(b.mesh.quaternion).elements
  const p = b.mesh.position
  return { c: [p.x, p.y, p.z], axes: [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]], half: BLOCK_HALF }
}

/**
 * Holding a block, the gripper closes no further than it, and opening lets it go. A real arm holds none of these
 * blocks, which aren't really there: one its twin held when it was connected is let go.
 */
function holdStep(a: Arm) {
  const b = blocks.find((o) => o.by === a)
  if (!b) return
  const g = a.joints[5]
  const h = holding(b.grip, g.angle)
  if (h.release || a.hw) { drop(b); return }
  if (h.open === g.angle) return
  g.angle = h.open
  g.vel = 0
  // On the block, the gripper is as closed as it goes: done.
  if (g.target !== null && g.target < h.open) g.target = null
  a.model.apply[5](g.angle)
}

/**
 * The blocks, as an arm makes this frame's move from `was` (./blocks.ts): what it runs into is pushed along the floor,
 * what can't give way (under a part coming down on it, or pinned) stops the joints that would take it in, and a block
 * the fingers close on, turned square, is held. A real arm is stopped by none of it: it pushes them out of its way.
 */
function blockStep(a: Arm, was: ArmPose, gripWas: number, following: boolean) {
  const free = blocks.filter((b) => !b.by)
  const g = a.joints[5]
  const r = stepAmong(standOf(a), { pose: was, open: gripWas }, { pose: poseOf(a), open: g.angle }, heldBox(a),
    { blocks: free.map(blkOf), still: arms.filter((o) => o !== a).flatMap(partsOf), bases: bases() },
    { real: !!a.hw, following, minShoulder: JOINTS[1].min })
  free.forEach((b, i) => { if (i !== r.took?.i) setBlk(b, r.blocks[i]) })
  a.blocked = r.stopped.some((k) => k !== 'grip')
  if (a.hw) return
  POSE_KEYS.forEach((k, i) => {
    if (a.joints[i].angle === r.pose[k]) return
    a.joints[i].angle = r.pose[k]
    a.model.apply[i](r.pose[k])
  })
  if (g.angle !== r.open) { g.angle = r.open; a.model.apply[5](g.angle) }
  for (const k of r.stopped) {
    const j = a.joints[k === 'grip' ? 5 : POSE_KEYS.indexOf(k)]
    j.vel = 0
    j.state ||= 'block'
  }
  // Stopped on a block, the gripper is as closed as it goes: done.
  if (r.stopped.includes('grip') && g.target !== null && g.target < g.angle) g.target = null
  if (!r.took) return
  const b = free[r.took.i], box = r.took.box
  a.model.grasp.add(b.mesh)
  b.mesh.position.set(...box.c)
  b.mesh.quaternion.setFromRotationMatrix(m4.makeBasis(new THREE.Vector3(...box.axes[0]), new THREE.Vector3(...box.axes[1]), new THREE.Vector3(...box.axes[2])))
  b.by = a
  b.grip = r.open
  b.vy = 0
  const who = sim?.claims.controller(g.node)
  if (who && who !== 'host') sim?.remote.feedback({ haptic: 'tick' }, who)
}

// ---- the shared scene ----

const layout: Layout = {
  v: 1,
  modes: [Mode.point, Mode.track, Mode.hold, Mode.tilt, Mode.gamepad],
  tray: [
    { id: 'estop', label: 'Stop', type: 'button', tone: 'stop' },
    { id: 'grip', label: 'Grip', type: 'button', icon: 'grip' },
    { id: 'home', label: 'Home', type: 'button', icon: 'reset' },
  ],
  // Volume up grips, volume down (or Esc) stops everything, next sends what you hold home.
  keys: { primary: 'grip', secondary: 'estop', next: 'home' },
}
function howTo(node: string) {
  const f = findNode(node)
  if (!f?.joint) return 'Point at a spot and hold B: the arm goes there · A picks up or drops · + and − height · 3D: hold the pad and move'
  if (f.joint.spec.key === 'gripper') return 'Hold a finger on the pad: tilt or drag to open and close, tap to toggle'
  return 'Hold a finger on the pad: tilt or drag to move it. 1:1: turn the phone like a dial'
}

let sim: SimScene | null = null
/** When each participant's input last arrived: the watchdog stops what it drives 200 ms after its input goes quiet. */
const lastInput = new Map<string, number>()
const lastButtons = new Map<string, number>()
let stopped: { by: string; why: string } | null = null

function estop(by: string, why = '') {
  if (stopped) return
  stopped = { by, why }
  for (const a of arms) { a.homing = false; a.drive = null; a.claw = null; for (const j of a.joints) j.target = null }
  document.body.classList.add('stopped')
  const who = sim?.nameOf(by) ?? 'The screen'
  $('stop-by').textContent = why || `Stopped by ${who}`
  const live = arms.filter((a) => a.hw?.live).length
  sim?.log(`${why || `E-stop by ${who}`}: every arm halted${live ? ', real arms holding where they are' : ''}`, '#fb7185')
  sim?.remote.feedback({ haptic: 'bump', toast: 'Stopped: the screen resumes' }, by === 'host' ? undefined : by)
  for (const p of sim?.remote.participants ?? []) if (p.id !== by) sim?.remote.feedback({ haptic: 'bump', toast: why || `${who} stopped the arms` }, p.id)
  renderPanel()
}
function resume() {
  if (!stopped) return
  stopped = null
  document.body.classList.remove('stopped')
  for (const a of arms) if (a.hw) a.hw.lagSince = 0
  sim?.log('Resumed from the screen')
  renderPanel()
}

for (let i = 0; i < 2; i++) addArm()

void startSimScene({
  appName: 'ob.Pal robot arms',
  layout,
  nodes: arms.flatMap(nodesOf),
  approval: true,
  howTo,
  label: (n) => (n.group ? `${n.group} · ${n.name}` : n.name),
  changed: () => renderPanel(),
}).then((s) => {
  sim = s
  s.remote.on('input', (who) => lastInput.set(who.id, performance.now()))
  s.remote.on('button', ({ id, ev }, who) => {
    if (id === 'estop') { estop(who.id); return }
    // B is Point's deadman: the arm follows the pointer while it's held.
    if (id === 'wii-b') { const aim = aimOf(who.id); aim.b = ev === 'down'; return }
    const node = s.claims.held(who.id)
    const f = node ? findNode(node) : null
    if (!f || stopped) return
    if (!f.joint && id === 'wii-a') { startClaw(f.arm); return }
    if (!f.joint && (id === 'wii-plus' || id === 'wii-minus')) {
      f.arm.hover = clamp(Math.round((f.arm.hover + (id === 'wii-plus' ? 0.05 : -0.05)) * 100) / 100, 0.08, 0.8)
      s.remote.feedback({ haptic: 'tick', toast: `Hovering ${Math.round(f.arm.hover * 100)} cm up` }, who.id)
      return
    }
    if (id === 'wii-home') { homeArm(f.arm, who.id); return }
    if (id === 'home') {
      if (f.joint) { f.joint.target = f.joint.spec.home; s.log(`${who.name} sent ${s.nodeName(f.joint.node)} home`, who.color) } else homeArm(f.arm, who.id)
    } else if (id === 'grip' || (id === 'pad' && ev === 'tap')) {
      if (!f.joint || f.joint.spec.key === 'gripper') toggleGrip(f.arm)
      else if (id === 'grip') s.remote.feedback({ toast: 'Grip works with the whole arm or the gripper' }, who.id)
    }
  })
  s.remote.on('recenter', (who) => aims.get(who.id)?.pointer.recenter())
  s.remote.on('leave', (p) => { dropAim(p.id); renderPanel() })
  refreshNodes()
})

$('estop').onclick = () => estop('host')
$('resume').onclick = resume
$('home-all').onclick = () => { if (!stopped) for (const a of arms) if (!a.hw || a.hw.live) homeArm(a, 'host') }
$('add-arm').onclick = () => { const a = addArm(); if (a) sim?.log(`The screen added ${a.name}`) }
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLButtonElement)) { e.preventDefault(); estop('host') }
})
// A live arm never runs unwatched: the screen going to the background stops everything.
document.addEventListener('visibilitychange', () => { if (document.hidden && arms.some((a) => a.hw?.live)) estop('host', 'The screen went to the background') })
addEventListener('beforeunload', (e) => { if (arms.some((a) => a.hw?.live)) e.preventDefault() })

// ---- driving one joint: deadman, velocity from the input, then the caps ----

const twistOf = (q: Quat) => 2 * Math.atan2(q[2], q[3]) * R2D
const dialBase = new Map<string, { grab: number; angle: number }>()

/** The velocity a participant commands for its joint this frame (units/s), or null when its deadman is released. */
function commanded(j: Joint, who: string, f: Frame, pad: PadState | null, dt: number): number | null {
  const span = j.spec.max - j.spec.min
  if (pad) {
    // Gamepad: a deflected stick is its own deadman; the triggers work the gripper.
    const x = Math.abs(pad.axes[0]) > 0.12 ? pad.axes[0] : Math.abs(pad.axes[2]) > 0.12 ? pad.axes[2] : 0
    const t = (pad.triggers[1] ?? 0) - (pad.triggers[0] ?? 0)
    if (j.spec.key === 'gripper' && Math.abs(t) > 0.05) return -t * j.spec.vmax
    return x ? x * j.spec.vmax : null
  }
  // 1:1: turn the phone like a dial while the gyro is on; the joint follows the phone's twist.
  if (f.mode === Mode.hold && f.clutch) {
    const b = dialBase.get(who)
    if (!b || b.grab !== f.grab) dialBase.set(who, { grab: f.grab, angle: j.angle })
    const base = dialBase.get(who)!.angle
    const scale = j.spec.unit === '°' ? 1 : 1 / 120
    j.target = clamp(base + twistOf(f.qRel) * scale, j.spec.min, j.spec.max)
    return 0
  }
  dialBase.delete(who)
  if (!f.touching) return null
  // A finger on the pad is the deadman: dragging moves the joint, tilting drives it.
  if (f.pad1[0] && dt > 0) return (f.pad1[0] * span / 900) / dt
  if (f.zoom && j.spec.key === 'gripper' && dt > 0) return (f.zoom * 0.6) / dt
  if (f.mode === Mode.tilt) return f.tilt[0] * j.spec.vmax
  return 0
}

// ---- driving the whole arm: the tool follows the phone (./kinematics.ts) ----

const tq = new THREE.Quaternion()
const tq0 = new THREE.Quaternion()
const te = new THREE.Euler()
/** How the phone turned since the drive began, in the view frame (y up): heading, tip and twist, degrees. */
function phoneTurn(q0: THREE.Quaternion, q: Quat) {
  tq.set(q[0], q[1], q[2], q[3]).multiply(tq0.copy(q0).invert())
  te.setFromQuaternion(tq, 'YXZ')
  return { yaw: te.y * R2D, pitch: te.x * R2D, roll: te.z * R2D }
}
/** Metres the tool rises per radian the phone tips. */
const LIFT = 0.55
const zeroTarget = (): ToolTarget => ({ yaw: 0, reach: 0, height: 0, pitch: 0, roll: 0 })

/** One frame of a participant driving a whole arm: sets its joints' targets. Returns why it isn't moving, if it isn't. */
function driveWhole(a: Arm, who: string, now: number, dt: number): string {
  const s = sim!
  const f = frames.get(who) ?? s.remote.consumeOf(who, now)
  const pad = s.remote.padOf(who)
  if (now - (lastInput.get(who) ?? 0) > 200) { settle(a); return 'watchdog' }
  if (!pad && f.mode === Mode.point) return drivePoint(a, who, now)
  if (!pad && f.mode === Mode.track) return driveTrack(a, who, f)
  const grip = a.joints[5]
  const inc = zeroTarget()
  let active = false
  let following = false
  if (pad) {
    const dz = (v: number) => (Math.abs(v) > 0.12 ? v : 0)
    const [lx, ly, rx, ry] = pad.axes.map(dz)
    const t = (pad.triggers[1] ?? 0) - (pad.triggers[0] ?? 0)
    const pressed = pad.buttons & ~(lastButtons.get(who) ?? 0)
    lastButtons.set(who, pad.buttons)
    if (pressed & (1 << PadButton.A)) toggleGrip(a)
    if (pressed & (1 << PadButton.B)) homeArm(a, who)
    if (Math.abs(t) > 0.05) grip.target = clamp((grip.target ?? grip.angle) - t * grip.spec.vmax * dt, 0, 1)
    active = !!(lx || ly || rx || ry)
    inc.yaw = -lx * 60 * dt
    inc.reach = -ly * 0.35 * dt
    inc.height = -ry * 0.35 * dt
    inc.roll = rx * 120 * dt
  } else {
    // A thumb on the pad is the deadman. With the gyro on (1:1), the phone's own motion drives the tool.
    active = f.touching
    following = f.clutch && f.mode === Mode.hold
    inc.yaw = -f.pad1[0] * 0.2
    inc.reach = -f.pad1[1] * 0.0008
    inc.height = -f.pad2[1] * 0.0008
    inc.pitch = f.pad2[0] * 0.15
    inc.roll = -f.twist * R2D
    if (f.mode === Mode.tilt) { inc.yaw -= f.tilt[0] * 55 * dt; inc.height += f.tilt[1] * 0.3 * dt }
    if (f.zoom) grip.target = clamp((grip.target ?? grip.angle) + f.zoom * 0.6, 0, 1)
  }
  if (!active) { settle(a); return a.homing ? '' : 'deadman' }
  a.homing = false
  // Begin a drive from where the tool is and where the phone points: letting go and pressing again ratchets.
  if (!a.drive || a.drive.grab !== f.grab || a.drive.following !== following) {
    a.drive = { grab: f.grab, following, q0: following ? new THREE.Quaternion(f.qRel[0], f.qRel[1], f.qRel[2], f.qRel[3]) : null, ref: forward(poseOf(a)), acc: zeroTarget() }
  }
  const d = a.drive
  for (const k of ['yaw', 'reach', 'height', 'pitch', 'roll'] as const) d.acc[k] += inc[k]
  const ph = d.q0 ? phoneTurn(d.q0, f.qRel) : { yaw: 0, pitch: 0, roll: 0 }
  const pitch = clamp(d.ref.pitch + d.acc.pitch, 20, 200)
  const roll = clamp(d.ref.roll + d.acc.roll - ph.roll, JOINTS[4].min, JOINTS[4].max)
  const goal: ToolTarget = {
    yaw: clamp(d.ref.yaw + d.acc.yaw + ph.yaw, JOINTS[0].min, JOINTS[0].max),
    reach: clamp(d.ref.reach + d.acc.reach, 0.25, 1.2),
    // No lower than the gripper can go at its angle: pushed down, it stops on the floor.
    height: clamp(d.ref.height + d.acc.height + ph.pitch * D2R * LIFT, Math.max(0.06, toolFloor(pitch, roll, heldBox(a))), 1.45),
    pitch,
    roll,
  }
  // No winding up past the clamps: pushing further out and back again answers at once.
  d.acc = { yaw: goal.yaw - d.ref.yaw - ph.yaw, reach: goal.reach - d.ref.reach, height: goal.height - d.ref.height - ph.pitch * D2R * LIFT, pitch: goal.pitch - d.ref.pitch, roll: goal.roll - d.ref.roll + ph.roll }
  const { pose, reached } = inverse(goal, heldBox(a))
  const ok = reached && within(pose)
  // Past the arm's reach or a joint's limit, the arm holds the last pose it could reach.
  if (ok) setPose(a, pose)
  if (!ok && !a.edge) s.remote.feedback({ haptic: 'bump' }, who)
  a.edge = !ok
  return ok ? '' : 'edge'
}

// ---- Point and go: each participant's aim lands on the floor, Wii-style ----

interface Aim { pointer: ScreenPointer; on: boolean; b: boolean; hit: THREE.Vector3 | null; dot: THREE.Group; beam: THREE.Mesh }
const aims = new Map<string, Aim>()
/** This frame's input from each participant: read once, used by whatever they drive. */
const frames = new Map<string, Frame>()
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
const tv = new THREE.Vector3()

function aimOf(id: string): Aim {
  let a = aims.get(id)
  if (a) return a
  const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.95, depthWrite: false })
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.062, 48), mat)
  const core = new THREE.Mesh(new THREE.CircleGeometry(0.016, 24), mat)
  ring.rotation.x = core.rotation.x = -Math.PI / 2
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1, 8), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.4, depthWrite: false }))
  const dot = new THREE.Group()
  dot.add(ring, core, beam)
  dot.visible = false
  dot.renderOrder = 2
  scene.add(dot)
  a = { pointer: new ScreenPointer(), on: false, b: false, hit: null, dot, beam }
  aims.set(id, a)
  return a
}

function dropAim(id: string) {
  const a = aims.get(id)
  if (!a) return
  a.dot.removeFromParent()
  a.dot.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose() } })
  aims.delete(id)
}

/** Once a frame: take every participant's input, and move the pointers of those in Point. */
function readInputs(now: number) {
  frames.clear()
  const s = sim
  if (!s) return
  for (const p of s.remote.participants) {
    const f = s.remote.consumeOf(p.id, now)
    frames.set(p.id, f)
    const pointing = f.connected && f.mode === Mode.point
    const aim = pointing || aims.has(p.id) ? aimOf(p.id) : null
    if (!aim) continue
    if (pointing && !aim.on) aim.pointer.recenter()
    aim.on = pointing
    if (!pointing) { aim.dot.visible = false; aim.b = false; continue }
    // A phone without motion sensors points with its trackpad.
    const st = aim.pointer.step(f.aim, [f.pad1[0] * 1.2, f.pad1[1] * 1.2], innerWidth, innerHeight)
    // Aiming straight at the screen is the middle of the floor; the pointer moves from there.
    const mid = tv.set(0, 0, 0).project(camera)
    ndc.set(mid.x + ((st.x - innerWidth / 2) / innerWidth) * 2, mid.y - ((st.y - innerHeight / 2) / innerHeight) * 2)
    raycaster.setFromCamera(ndc, camera)
    const hit = st.off ? null : raycaster.ray.intersectPlane(floorPlane, aim.hit ?? new THREE.Vector3())
    // Keep it inside the cell's fence.
    if (hit && Math.hypot(hit.x, hit.z) > 2) { const k = 2 / Math.hypot(hit.x, hit.z); hit.x *= k; hit.z *= k }
    // Aim assist, as on the Wii: near a block on the floor, the dot settles onto it.
    if (hit) {
      let best: Block | null = null
      let bestD = 0.09
      for (const b of blocks) {
        if (b.by) continue
        const d = Math.hypot(b.mesh.position.x - hit.x, b.mesh.position.z - hit.z)
        if (d < bestD) { best = b; bestD = d }
      }
      if (best) { hit.x += (best.mesh.position.x - hit.x) * 0.7; hit.z += (best.mesh.position.z - hit.z) * 0.7 }
    }
    aim.hit = hit
    aim.dot.visible = !!hit
    if (!hit) continue
    aim.dot.position.set(hit.x, 0.004, hit.z)
    const color = s.colorOf(p.id) || '#ffffff'
    aim.dot.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.MeshBasicMaterial).color.set(color) })
    aim.dot.scale.setScalar(aim.b ? 1.35 : 1)
    // Holding a whole arm: a beam up to where the gripper will hover.
    const held = s.claims.held(p.id)
    const arm = held ? armOf(held) : undefined
    aim.beam.visible = !!arm
    if (arm) { aim.beam.scale.y = arm.hover; aim.beam.position.y = arm.hover / 2 }
  }
  glowStep(now)
}

// ---- camera tracking: phones without WebXR glow their colour, and this computer's camera follows them ----

const follower = new GlowFollower()
const glowView = $('glow-view') as HTMLCanvasElement
const glowCtx = glowView.getContext('2d')!
follower.onUnseen = (id) => sim?.remote.feedback({ haptic: 'bump', toast: 'The camera can’t see your glow: turn the screen toward it' }, id)
follower.onCameraOff = () => sim?.note('A phone is glowing: turn on “Follow glowing phones with this camera”')

$('glow-cam').onclick = async () => {
  if (follower.cam.on) follower.cam.stop()
  else {
    try { await follower.cam.start(); sim?.note('Hold glowing phones toward the camera') } catch { sim?.note('The camera didn’t start: allow it for this page') }
  }
  $('glow-cam').setAttribute('aria-pressed', String(follower.cam.on))
  glowView.hidden = !follower.cam.on
}

/** Give each glowing phone (3D without its own tracking) a pose from the camera, as a tracked phone would send. */
function glowStep(now: number) {
  const s = sim
  if (!s) return
  const people = s.remote.participants.flatMap((p) => { const frame = frames.get(p.id); return frame ? [{ id: p.id, color: s.colorOf(p.id), frame }] : [] })
  for (const [id, pose] of follower.step(now, people)) frames.set(id, { ...frames.get(id)!, pose })
  if (follower.cam.on) follower.draw(glowCtx, (id) => s.colorOf(id))
}

/** Point: while B is held, the gripper goes over the spot the phone points at. */
function drivePoint(a: Arm, who: string, now: number): string {
  if (a.claw) return clawStep(a, now)
  const aim = aims.get(who)
  if (!aim?.b || !aim.hit) { settle(a); return 'deadman' }
  a.homing = false
  const local = a.model.root.worldToLocal(tv.copy(aim.hit))
  const r = reachDown(Math.atan2(local.z, -local.x) * R2D, Math.hypot(local.x, local.z), a.hover, a.joints[4].angle, heldBox(a))
  if (r) setPose(a, r.pose)
  const ok = !!r?.exact
  if (!ok && !a.edge) sim?.remote.feedback({ haptic: 'bump' }, who)
  a.edge = !ok
  return ok ? '' : 'edge'
}

// ---- 3D: the gripper follows the phone through space ----

const UP = new THREE.Vector3(0, 1, 0)
const camFwd = new THREE.Vector3()
const camRight = new THREE.Vector3()

/** Where the gripper is, in the world. */
function toolWorld(a: Arm, t: ToolTarget) {
  const y = t.yaw * D2R
  return a.model.root.localToWorld(new THREE.Vector3(-t.reach * Math.cos(y), t.height, t.reach * Math.sin(y)))
}

/**
 * 3D (mode 6): while a thumb is on the pad, the gripper moves as the phone does (right, up, toward the screen, as the
 * screen shows the stage), and the phone's tip and twist set the gripper's angle and roll. Letting go holds; pressing
 * again carries on from there, facing wherever the phone points.
 */
function driveTrack(a: Arm, who: string, f: Frame): string {
  const pose = f.pose
  // The deadman as the phone saw it with this pose (a glow's pose comes from the camera, so from STATE).
  const held = pose ? pose.touching || f.touching : false
  if (!pose || !pose.tracked || !held) {
    if (pose && !pose.tracked && held && a.track) sim?.remote.feedback({ toast: 'Lost track: more light, slower moves' }, who)
    settle(a)
    return 'deadman'
  }
  a.homing = false
  a.claw = null
  if (!a.track || a.track.gen !== pose.gen) {
    const t = forward(poseOf(a))
    a.track = { gen: pose.gen, p0: [...pose.p], q0: [...pose.q], heading: headingOf(pose.q), tool: toolWorld(a, t), pitch: t.pitch, roll: t.roll }
  }
  const k = a.track
  const m = handMove([pose.p[0] - k.p0[0], pose.p[1] - k.p0[1], pose.p[2] - k.p0[2]], k.heading)
  const turn = handTurn(k.q0, pose.q, k.heading)
  // The stage as the screen shows it: its right, and into it.
  camera.getWorldDirection(camFwd)
  camFwd.y = 0
  camFwd.normalize()
  camRight.crossVectors(camFwd, UP).normalize()
  const w = tv.copy(k.tool).addScaledVector(camRight, m.right * a.scale).addScaledVector(UP, m.up * a.scale).addScaledVector(camFwd, m.forward * a.scale)
  const local = a.model.root.worldToLocal(w)
  const goal: ToolTarget = {
    yaw: Math.atan2(local.z, -local.x) * R2D,
    reach: Math.max(0.2, Math.hypot(local.x, local.z)),
    height: Math.max(CLAW_LOW, local.y),
    pitch: clamp(k.pitch - turn.tip, 20, 200),
    roll: clamp(k.roll + turn.twist, JOINTS[4].min, JOINTS[4].max),
  }
  a.goal = goal
  // Where the gripper goes comes first: tip it if that's what it takes to get there.
  const r = solveNear(goal, 60, heldBox(a))
  if (r) setPose(a, r.pose)
  if (!r && !a.edge) sim?.remote.feedback({ haptic: 'bump' }, who)
  a.edge = !r
  return r ? '' : 'edge'
}

/** The gripper this close above the floor grasps a block lying there. */
const CLAW_LOW = 0.035

/** How fast the sim's own arm takes the gripper straight down or up for the claw (m/s). */
const CLAW_SPEED = 0.3

/** Send the gripper to a height over the claw's spot. */
function clawAt(a: Arm, c: Claw, height: number) {
  const r = reachDown(c.yaw, c.reach, height, a.joints[4].angle, heldBox(a))
  if (r) setPose(a, r.pose)
}

/**
 * Send the claw's gripper to a height over its spot. The sim's own arm takes it there straight down (or up), a little
 * further each frame, so that its fingers come down around a block rather than on it: each joint heading straight for
 * its end would swing the gripper a few centimetres to the side on the way. A real arm goes as it always has.
 */
function clawTo(a: Arm, c: Claw, height: number) {
  c.goal = height
  c.h = a.hw ? height : forward(poseOf(a)).height
  c.at = performance.now()
  if (a.hw) clawAt(a, c, height)
}

/** A (Point): pick up what's under the gripper, or put down what it holds. */
function startClaw(a: Arm) {
  if (a.claw || stopped || (a.hw && !a.hw.live)) return
  const t = forward(poseOf(a))
  a.homing = false
  // Holding a block, it puts it down; else it picks one up, opening on the way down.
  const pick = !blocks.some((b) => b.by === a)
  if (pick) a.joints[5].target = 1
  a.claw = { phase: 'down', pick, yaw: t.yaw, reach: t.reach, since: performance.now(), goal: CLAW_LOW, h: t.height, at: performance.now() }
  clawTo(a, a.claw, CLAW_LOW)
}

function clawStep(a: Arm, now: number): string {
  const c = a.claw!
  if (c.h !== c.goal) {
    const d = (CLAW_SPEED * Math.min(50, now - c.at)) / 1000
    c.h = c.goal < c.h ? Math.max(c.goal, c.h - d) : Math.min(c.goal, c.h + d)
    clawAt(a, c, c.h)
  }
  c.at = now
  const still = c.h === c.goal && a.joints.slice(0, 5).every((j) => j.target === null && Math.abs(j.vel) < 2)
  const g = a.joints[5]
  if (now - c.since > 8000) { a.claw = null; return '' }
  // Down (or down on a block that stops it): close or open.
  if (c.phase === 'down' && (still || a.blocked)) { c.phase = 'grip'; g.target = c.pick ? 0 : 1 } else if (c.phase === 'grip' && g.target === null) {
    c.phase = 'up'
    clawTo(a, c, a.hover)
  } else if (c.phase === 'up' && still) a.claw = null
  return ''
}

// ---- the loop ----

function stepArm(a: Arm, now: number, dt: number) {
  const s = sim
  const hw = a.hw
  // Connected but not live: the twin follows the real arm, and nobody drives it.
  const mirror = !!hw && !hw.live
  const armWho = s?.claims.holder(a.id)
  a.state = ''
  if (stopped || mirror || !armWho || armWho === 'host' || !s) { a.drive = null; if (!armWho) a.edge = false }
  else a.state = driveWhole(a, armWho, now, dt)
  const got = mirror ? hw.driver.read() : null
  const angles = got ? fromRaw(hw!.cal, got.raw.map((v) => v ?? NaN)) : null
  const cap = hw?.live ? hw.cap : 1
  // Where the arm and the gripper were, and whether it's headed for a pose, for the floor and the grip (below).
  const was = poseOf(a)
  const gripWas = a.joints[5].angle
  const following = !stopped && a.joints.slice(1, 5).some((j) => j.target !== null)
  a.joints.forEach((j, i) => {
    const who = s?.claims.holder(j.node)
    let v = 0
    j.state = ''
    if (stopped) { j.state = 'stopped'; j.target = null } else if (mirror) {
      j.state = 'mirror'
      j.target = null
      j.vel = 0
      const g = angles?.[i]
      if (g !== undefined && Number.isFinite(g)) j.angle += (g - j.angle) * Math.min(1, dt * 12)
      a.model.apply[i](j.angle)
      return
    } else if (armWho && armWho !== 'host') j.state = a.state
    else if (who && who !== 'host' && s) {
      if (now - (lastInput.get(who) ?? 0) > 200) { j.state = 'watchdog'; if (!a.homing) j.target = null } else {
        const c = commanded(j, who, frames.get(who) ?? s.remote.consumeOf(who, now), s.remote.padOf(who), dt)
        if (c === null) { j.state = 'deadman'; if (!a.homing && j.spec.key !== 'gripper') j.target = null } else v = c
      }
    }
    // Following a target (the whole arm, 1:1, home, the gripper): a proportional approach under the same caps.
    if (j.target !== null && !stopped) {
      const e = j.target - j.angle
      v = Math.abs(e) < (j.spec.unit === '°' ? 0.05 : 0.002) ? 0 : e * 6
      if (!v) j.target = null
    }
    const vmax = j.spec.vmax * cap
    v = clamp(v, -vmax, vmax)
    // Acceleration cap; an e-stop brakes four times harder.
    const acc = (stopped ? 4 : 1) * j.spec.amax * cap * dt
    j.vel += clamp(v - j.vel, -acc, acc)
    let next = j.angle + j.vel * dt
    if (next <= j.spec.min || next >= j.spec.max) { next = clamp(next, j.spec.min, j.spec.max); j.vel = 0; if (v) j.state = 'limit' }
    j.angle = next
    a.model.apply[i](j.angle)
  })
  // The floor: no step takes any part of the arm below it. Headed for a pose, the arm rides along it while its joints
  // catch up; turned by hand, a joint stops there as at a limit.
  if (!mirror) {
    const { pose, floored } = stepAboveFloor(was, poseOf(a), following, JOINTS[1].min, heldBox(a))
    for (const k of floored) {
      const i = POSE_KEYS.indexOf(k)
      const j = a.joints[i]
      j.angle = pose[k]
      j.vel = 0
      j.state ||= 'floor'
      a.model.apply[i](j.angle)
    }
  }
  // The blocks: a held one keeps the gripper from closing further; the rest are pushed, stop the arm, or are taken.
  holdStep(a)
  blockStep(a, was, gripWas, following)
  if (a.homing && a.joints.every((j) => j.target === null)) a.homing = false
  // Rings wear their controller's colour, and flash when control changes.
  a.joints.forEach((j, i) => paint(a.model.rings[i], s?.claims.controller(j.node), j, dt, Math.abs(j.vel) > 1e-3))
  paint(a.model.plate, armWho, a, dt, false)
  if (hw?.live) liveStep(a, now)
}

function paint(ring: THREE.Mesh, who: string | undefined, o: { flash: number }, dt: number, moving: boolean) {
  const mat = ring.material as THREE.MeshStandardMaterial
  mat.emissive.set(who ? sim!.colorOf(who) || '#5b6472' : '#5b6472')
  o.flash = Math.max(0, o.flash - dt / 0.7)
  mat.emissiveIntensity = (who ? 1.4 : 0.25) + 2.2 * o.flash + (moving ? 0.6 : 0)
  ring.scale.setScalar(1 + 0.25 * o.flash)
}

let last = 0
function loop(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  readInputs(now)
  for (const a of arms) stepArm(a, now, dt)
  updateBlocks(dt)
  controls.update()
  renderer.render(scene, camera)
  if (Math.floor(now / 100) !== Math.floor((now - dt * 1000) / 100)) renderReadouts()
  requestAnimationFrame(loop)
}

// ---- real arms: connect, calibrate, go live (./drivers.ts) ----

/** While live: copy the twin to the arm, and stop everything if the arm stops reporting or can't keep up. */
function liveStep(a: Arm, now: number) {
  const hw = a.hw!
  hw.driver.send(toRaw(hw.cal, a.joints.map((j) => j.angle)))
  if (hw.driver.feedback !== 'measured' || stopped) return
  const r = hw.driver.read()
  if (!r || now - r.at > 1200) { if (now - hw.since > 2000) estop('host', `${a.name} stopped reporting where it is`); return }
  const got = fromRaw(hw.cal, r.raw.map((v) => v ?? NaN))
  let off = 0
  for (let i = 0; i < 5; i++) if (Number.isFinite(got[i])) off = Math.max(off, Math.abs(got[i] - a.joints[i].angle))
  if (off <= 12) { hw.lagSince = 0; return }
  hw.lagSince ||= now
  if (now - hw.lagSince > 600) estop('host', `${a.name} isn’t keeping up (${Math.round(off)}° off): check for something in its way`)
}

const calKey = (kind: DriverKind, a: Arm) => `obpal-arm-cal:${kind}:${a.n}`
function loadCal(kind: DriverKind, a: Arm): Calibration {
  const base = defaultCalibration(kind)
  try {
    const c = JSON.parse(localStorage.getItem(calKey(kind, a)) ?? 'null') as Partial<Calibration> | null
    if (c && Array.isArray(c.zero) && c.zero.length === 5 && Array.isArray(c.dir) && c.dir.length === 5 && [...c.zero, ...c.dir, c.gripOpen, c.gripClosed].every((v) => typeof v === 'number' && Number.isFinite(v))) return { ...base, ...c }
  } catch { /* none saved */ }
  return base
}
function saveCal(a: Arm) {
  if (!a.hw) return
  try { localStorage.setItem(calKey(a.hw.driver.kind, a), JSON.stringify(a.hw.cal)) } catch { /* private window */ }
}

/** Attach a connected driver to an arm: the twin starts following it. */
function attach(a: Arm, driver: ArmDriver) {
  a.hw = { driver, cal: loadCal(driver.kind, a), live: false, cap: 0.25, since: performance.now(), lagSince: 0 }
  driver.onLost = (why) => {
    if (a.hw?.driver !== driver) return
    const wasLive = a.hw.live
    a.hw = null
    sim?.log(`${a.name} lost its hardware: ${why}`, '#fb7185')
    if (wasLive) estop('host', `${a.name} lost its connection: ${why}`)
    renderPanel()
  }
  sim?.log(`The screen connected ${a.name} to ${driver.label}: the twin follows it`)
  renderPanel()
}

async function disconnect(a: Arm) {
  const hw = a.hw
  if (!hw) return
  a.hw = null
  await hw.driver.close().catch(() => {})
  sim?.log(`The screen disconnected ${a.name}${hw.live ? ' while live: it holds where it is' : ''}`)
  renderPanel()
}

async function goLive(a: Arm, cap: number) {
  const hw = a.hw
  if (!hw || hw.live) return
  const r = hw.driver.read()
  if (!r || r.raw.some((v) => v === null)) { sim?.note(`${a.name} hasn’t reported every joint yet`); return }
  const angles = fromRaw(hw.cal, r.raw as number[])
  const out = JOINTS.findIndex((s, i) => !(angles[i] >= s.min - 3 && angles[i] <= s.max + 3))
  if (out >= 0) { sim?.note(`${a.name}’s ${JOINTS[out].name.toLowerCase()} reads outside its limits: calibrate it first`); return }
  // Start from where the arm is, so going live never jumps.
  a.joints.forEach((j, i) => { j.angle = clamp(angles[i], j.spec.min, j.spec.max); j.vel = 0; j.target = null })
  await hw.driver.torque(true)
  hw.live = true
  hw.cap = cap
  hw.since = performance.now()
  hw.lagSince = 0
  sim?.log(`The screen put ${a.name} live, at ${Math.round(cap * 100)}% speed`, '#fb7185')
  renderPanel()
}

function offLive(a: Arm) {
  if (!a.hw?.live) return
  a.hw.live = false
  sim?.log(`The screen took ${a.name} off live: it holds where it is`)
  renderPanel()
}

// The connect dialog.
let dialogArm: Arm | null = null
const kindInput = () => (document.querySelector<HTMLInputElement>('#hw input[name=kind]:checked')?.value ?? 'feetech') as DriverKind
function openHardware(a: Arm) {
  dialogArm = a
  $('hw-err').textContent = ''
  renderHardware()
  ;($('hw') as HTMLDialogElement).showModal()
}
function renderHardware() {
  const a = dialogArm
  if (!a) return
  const hw = a.hw
  $('hw-title').textContent = hw ? `${a.name} · ${hw.driver.label}` : `Connect ${a.name} to a real arm`
  $('hw-kinds').hidden = !!hw
  $('hw-ros').hidden = !!hw || kindInput() !== 'ros'
  $('hw-connect').hidden = !!hw
  $('hw-disconnect').hidden = !hw
  $('hw-noserial').hidden = !!hw || kindInput() === 'ros' || hasSerial()
  const cal = !!hw && !hw.live && hw.driver.kind !== 'serial'
  $('hw-cal').hidden = !cal
  $('hw-live-note').hidden = !hw?.live
  if (cal) {
    $('hw-dirs').replaceChildren(...JOINTS.slice(0, 5).map((s, i) => {
      const l = document.createElement('label')
      l.innerHTML = '<input type="checkbox" /> <span></span>'
      l.querySelector('span')!.textContent = s.name
      const box = l.querySelector('input')!
      box.checked = hw.cal.dir[i] < 0
      box.onchange = () => { hw.cal.dir[i] = box.checked ? -1 : 1; saveCal(a) }
      return l
    }))
  }
}
document.querySelectorAll<HTMLInputElement>('#hw input[name=kind]').forEach((r) => { r.onchange = renderHardware })
$('ros-url').setAttribute('value', ROS_DEFAULTS.url)
;($('ros-topic') as HTMLInputElement).value = ROS_DEFAULTS.topic
;($('ros-joints') as HTMLInputElement).value = ROS_DEFAULTS.joints.join(', ')
;($('ros-cmd') as HTMLSelectElement).onchange = (e) => {
  ;($('ros-topic') as HTMLInputElement).value = (e.target as HTMLSelectElement).value === 'array' ? '/forward_position_controller/commands' : ROS_DEFAULTS.topic
}
$('hw-close').onclick = () => ($('hw') as HTMLDialogElement).close()
$('hw-connect').onclick = async () => {
  const a = dialogArm
  if (!a || a.hw) return
  const kind = kindInput()
  const btn = $('hw-connect') as HTMLButtonElement
  btn.disabled = true
  $('hw-err').textContent = ''
  try {
    const driver = kind === 'feetech' ? new FeetechDriver() : kind === 'serial' ? new SerialTextDriver() : new RosDriver({
      url: ($('ros-url') as HTMLInputElement).value.trim(),
      command: ($('ros-cmd') as HTMLSelectElement).value as 'trajectory' | 'array',
      topic: ($('ros-topic') as HTMLInputElement).value.trim() || ROS_DEFAULTS.topic,
      stateTopic: ROS_DEFAULTS.stateTopic,
      joints: ($('ros-joints') as HTMLInputElement).value.split(',').map((s) => s.trim()).slice(0, 6),
    })
    await driver.connect()
    attach(a, driver)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    // Closing the port chooser isn't an error worth showing.
    if (!/No port selected|cancel/i.test(m)) $('hw-err').textContent = m
  } finally {
    btn.disabled = false
    renderHardware()
  }
}
$('hw-disconnect').onclick = async () => { if (dialogArm) await disconnect(dialogArm); renderHardware() }
$('cal-home').onclick = () => {
  const a = dialogArm
  const r = a?.hw?.driver.read()
  if (!a?.hw || !r || r.raw.some((v) => v === null)) { $('hw-err').textContent = 'The arm hasn’t reported every joint yet'; return }
  a.hw.cal = calibrateHome(a.hw.cal, r.raw as number[], JOINTS.map((s) => s.home))
  saveCal(a)
  $('hw-err').textContent = ''
  sim?.log(`The screen set ${a.name}’s home from the real arm`)
}
$('cal-closed').onclick = () => {
  const a = dialogArm
  const g = a?.hw?.driver.read()?.raw[5]
  if (!a?.hw || g === null || g === undefined) { $('hw-err').textContent = 'The gripper hasn’t reported yet'; return }
  a.hw.cal.gripClosed = g
  saveCal(a)
}
$('hw-limp').onclick = async () => {
  const a = dialogArm
  if (!a?.hw || a.hw.live) return
  await a.hw.driver.torque(false)
  sim?.note(`${a.name} is limp: pose it by hand`)
}

// The go-live dialog: the screen, never a phone, puts a real arm live.
let liveArm: Arm | null = null
function askLive(a: Arm) {
  liveArm = a
  $('live-title').textContent = `Put ${a.name} live?`
  ;($('live') as HTMLDialogElement).showModal()
}
$('live-go').onclick = () => { if (liveArm) void goLive(liveArm, Number(($('live-cap') as HTMLSelectElement).value) || 0.25) }

// ---- the screen's panel: each arm, what it offers, who holds what, and why something isn't moving ----

function renderPanel() {
  const held = sim?.claims.snapshot() ?? {}
  for (const a of arms) {
    for (const j of a.joints) if ((held[j.node] ?? '') !== (heldBefore[j.node] ?? '')) j.flash = 1
    if ((held[a.id] ?? '') !== (heldBefore[a.id] ?? '')) { a.flash = 1; for (const j of a.joints) j.flash = 1 }
  }
  heldBefore = held
  $('arms').replaceChildren(...arms.map((a) => armCard(a, held)))
  $('add-arm').hidden = arms.length >= MAX_ARMS
  const live = arms.filter((a) => a.hw?.live).length
  const connected = arms.filter((a) => a.hw).length
  const badge = $('sim-badge')
  badge.textContent = live ? `${live} real arm${live > 1 ? 's' : ''} live` : connected ? `Twin of ${connected} real arm${connected > 1 ? 's' : ''}` : 'Simulated · no hardware connected'
  badge.classList.toggle('live', live > 0)
  renderReadouts()
}

function takeBack(node: string) { sim?.take(node, 'host', true); sim?.release('host') }

function holderText(who: string | undefined, via?: string) {
  if (!who) return 'Free'
  return via ? `${sim!.nameOf(who)}, with ${via}` : sim!.nameOf(who)
}

function armCard(a: Arm, held: Record<string, string>): HTMLElement {
  const sec = document.createElement('section')
  sec.className = 'arm'
  sec.dataset.arm = a.id
  const hw = a.hw
  sec.dataset.hw = hw ? (hw.live ? 'live' : 'twin') : 'sim'
  sec.innerHTML = `<header class="arm-head"><span class="arm-n"></span><span class="nn"><b></b><small></small></span><span class="arm-badge"></span><button class="chip-x arm-more" aria-expanded="false">⋯</button></header>
    <div class="arm-tools" hidden><label class="arm-prof"><span>Control</span><select class="arm-profile"></select></label><label class="arm-prof"><span>3D: hand to arm</span><select class="arm-scale"></select></label><div class="arm-btns"><button class="btn sm arm-hw"></button><button class="btn sm arm-live" hidden></button><button class="btn sm arm-remove">Remove</button></div></div>
    <ul class="nodes arm-nodes"></ul><ul class="jgrid"></ul>`
  sec.querySelector('.arm-n')!.textContent = String(a.n)
  sec.querySelector('.arm-head b')!.textContent = a.name
  sec.querySelector('.arm-head small')!.textContent = hw ? (hw.live ? `Live at ${Math.round(hw.cap * 100)}% · ${hw.driver.label}` : `Following ${hw.driver.label}`) : PROFILES.find((p) => p.id === a.profile)!.name
  sec.querySelector('.arm-badge')!.textContent = hw ? (hw.live ? 'Live' : 'Twin') : 'Sim'
  // Tools: control profile, hardware, remove.
  const more = sec.querySelector<HTMLButtonElement>('.arm-more')!
  const tools = sec.querySelector<HTMLElement>('.arm-tools')!
  more.setAttribute('aria-label', `${a.name} settings`)
  const setOpen = (on: boolean) => { tools.hidden = !on; more.setAttribute('aria-expanded', String(on)); if (on) openTools.add(a.id); else openTools.delete(a.id) }
  setOpen(openTools.has(a.id))
  more.onclick = () => setOpen(!openTools.has(a.id))
  const sel = sec.querySelector<HTMLSelectElement>('.arm-profile')!
  for (const p of PROFILES) sel.add(new Option(p.name, p.id, false, p.id === a.profile))
  sel.onchange = () => setProfile(a, sel.value as Profile)
  const scale = sec.querySelector<HTMLSelectElement>('.arm-scale')!
  for (const k of SCALES) scale.add(new Option(`${k}×`, String(k), false, k === a.scale))
  scale.onchange = () => { a.scale = Number(scale.value) || 1.5; a.track = null }
  const hwBtn = sec.querySelector<HTMLButtonElement>('.arm-hw')!
  hwBtn.textContent = hw ? 'Hardware' : 'Connect a real arm'
  hwBtn.onclick = () => openHardware(a)
  const liveBtn = sec.querySelector<HTMLButtonElement>('.arm-live')!
  liveBtn.hidden = !hw
  liveBtn.textContent = hw?.live ? 'Take off live' : 'Go live'
  liveBtn.classList.toggle('danger', !hw?.live)
  liveBtn.onclick = () => (hw?.live ? offLive(a) : askLive(a))
  const rm = sec.querySelector<HTMLButtonElement>('.arm-remove')!
  rm.hidden = arms.length <= 1
  rm.onclick = () => void removeArm(a)

  // The whole arm, then its joints.
  const armWho = held[a.id]
  if (a.profile !== 'joints') {
    const li = document.createElement('li')
    li.dataset.node = a.id
    li.innerHTML = '<i class="dot"></i><span class="nn"><b>Whole arm</b><small></small></span><span class="nv"></span><span class="bar"><span></span></span>'
    li.querySelector('small')!.textContent = holderText(armWho)
    if (armWho) { li.classList.add('held'); li.querySelector<HTMLElement>('.dot')!.style.background = sim!.colorOf(armWho) }
    if (armWho) li.appendChild(xButton(() => takeBack(a.id)))
    sec.querySelector('.arm-nodes')!.appendChild(li)
  }
  if (a.profile !== 'arm') {
    sec.querySelector('.jgrid')!.replaceChildren(...a.joints.map((j) => {
      const li = document.createElement('li')
      li.dataset.node = j.node
      const who = held[j.node] ?? armWho
      li.innerHTML = '<i class="dot"></i><b></b><span class="nv"></span><span class="bar"><span></span></span>'
      li.querySelector('b')!.textContent = j.spec.name
      li.title = holderText(who, held[j.node] ? undefined : armWho ? 'the whole arm' : undefined)
      if (who) { li.classList.add('held'); li.querySelector<HTMLElement>('.dot')!.style.background = sim!.colorOf(who) }
      if (held[j.node]) li.appendChild(xButton(() => takeBack(j.node)))
      return li
    }))
  }
  return sec
}

function xButton(onclick: () => void) {
  const x = document.createElement('button')
  x.className = 'chip-x'
  x.title = 'Take it back'
  x.setAttribute('aria-label', 'Take it back')
  x.textContent = '×'
  x.onclick = onclick
  return x
}

function renderReadouts() {
  for (const a of arms) {
    const row = document.querySelector<HTMLElement>(`#arms li[data-node="${a.id}"]`)
    if (row) {
      const t = forward(poseOf(a))
      row.querySelector('.nv')!.textContent = `${Math.round(t.reach * 100)} cm · ${Math.round(t.height * 100)} up`
      row.querySelector<HTMLElement>('.bar span')!.style.width = `${clamp((t.reach - 0.25) / 0.95, 0, 1) * 100}%`
      row.dataset.state = a.state || (a.hw && !a.hw.live ? 'mirror' : stopped ? 'stopped' : '')
    }
    for (const j of a.joints) {
      const li = document.querySelector<HTMLElement>(`#arms li[data-node="${j.node}"]`)
      if (!li) continue
      li.querySelector('.nv')!.textContent = j.spec.unit === '°' ? `${Math.round(j.angle)}°` : `${Math.round(j.angle * 100)}%`
      li.querySelector<HTMLElement>('.bar span')!.style.width = `${((j.angle - j.spec.min) / (j.spec.max - j.spec.min)) * 100}%`
      li.dataset.state = j.state
    }
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

Object.assign(window, {
  __arm: {
    arms: () => arms.map((a) => ({
      id: a.id, profile: a.profile, state: a.state, edge: a.edge, live: !!a.hw?.live, twin: !!a.hw, hover: a.hover, claw: a.claw?.phase ?? null, goal: a.goal, anchor: a.track ? { p0: a.track.p0, tool: a.track.tool.y } : null,
      tool: forward(poseOf(a)), joints: a.joints.map((j) => ({ node: j.node, angle: j.angle, target: j.target, state: j.state })),
    })),
    blocks: () => blocks.map((b) => b.by?.id ?? null),
    /** A block: where it is, how it's turned, how low it reaches, who holds it and the opening they hold it at. */
    block: (i: number) => {
      const b = blocks[i], p = b.mesh.getWorldPosition(new THREE.Vector3())
      return { x: p.x, y: p.y, z: p.z, yaw: yawOf(b.mesh.getWorldQuaternion(new THREE.Quaternion())), bottom: p.y - halfHeight(b), by: b.by?.id ?? null, grip: b.by ? b.grip : null }
    },
    /** Send an arm to a pose (degrees; the gripper 0 closed … 1 open), as Home does (tests and screenshots). */
    goTo: (id: string, pose: ArmPose, open?: number) => { const a = armOf(id); if (!a) return; a.homing = false; setPose(a, pose); if (open !== undefined) a.joints[5].target = open },
    /** Put a block down on the floor at (x, z), turned `yaw` degrees (tests and screenshots). */
    placeBlock: (i: number, x: number, z: number, yaw = 0) => { const b = blocks[i]; if (b.by) drop(b); b.mesh.position.set(x, BLOCK / 2, z); b.mesh.quaternion.setFromAxisAngle(UP, yaw * D2R); b.vy = 0 },
    /** Look from `at` toward `to` (metres; tests and screenshots). The camera keeps its limits. */
    view: (at: [number, number, number], to: [number, number, number]) => { camera.position.set(...at); controls.target.set(...to); controls.update() },
    aims: () => [...aims.entries()].map(([id, a]) => ({ id, on: a.on, b: a.b, hit: a.hit ? { x: a.hit.x, z: a.hit.z } : null })),
    stopped: () => stopped,
    addArm: () => addArm()?.id ?? null,
    removeArm: (id: string) => { const a = armOf(id); return a ? removeArm(a) : undefined },
    setProfile: (id: string, p: Profile) => { const a = armOf(id); if (a) setProfile(a, p) },
    /** Attach a driver without the port chooser (tests, and pages embedding this one with their own transport). */
    connectWith: async (id: string, driver: ArmDriver) => { const a = armOf(id); if (!a || a.hw) return false; await driver.connect(); attach(a, driver); return true },
  },
})
