/**
 * Robot arms (CATALOGUE §7, system.robot-arm): one to four arms in a shared scene, driven by phones, all of one kind
 * (?kind=, ./kinds.ts: the five-axis arm, the SO-101, a six-axis industrial arm, a SCARA, a delta, a desk arm; each
 * moves by its own kinematics, ./kind/). Each arm offers a whole-arm node and a node per joint, by the control
 * profile the screen picks. Whoever holds the whole arm moves it
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
import { batch, box, environment, floorMaterial, metal, palette, plastic, softKey } from '../kit'
import { tiledDeck } from '../kit/precision'
import { ceramic, darkTitanium } from '../kit/surfaces'
import { fixtures, payloadSpeed, STOCK } from './workspace'
import { instanceCopies } from '../kit/instances'
import { InputSmoother, servo } from '../kit/motion'
import type { SceneNode } from '@obpal/core'
import { Mode, PadButton, type Frame, type Layout, type PadState, type Quat } from '@obpal/host'
import { applyTheme, initialTheme } from '../../ui/themes'
import { mountMarks } from '../../ui/icons'
import { mountTopBar } from '../../landing/topbar'
import { startSimScene, type SimScene } from '../scene'
import { simView } from '../view'
import {
  calibrateHome, defaultCalibration, FeetechDriver, fromRaw, hasSerial, RosDriver, ROS_DEFAULTS, SerialTextDriver, toRaw,
  type ArmDriver, type Calibration, type DriverKind,
} from './drivers'
import { blockBox, eject, restOf, settle as settleBlocks, stepAmong, type Base, type Blk, type Stand } from './blocks'
import { holding, type GripBox, type V3 } from './grasp'
import { reachDown, solveNear, within, type Pose } from './kin'
import type { ToolTarget } from './kinematics'
import { kindFrom } from './kind'
import { ARM_KINDS } from './kinds'
import { placement, turnBetween } from './layout'
import type { ArmModel, JointSpec } from './model'
import { GlowFollower, handMove, handTurn, headingOf } from '@obpal/host'
import { ScreenPointer } from '../../viewer/pointer'
import { armWorkspace, armHeight } from './control-space'
import { sceneCells, nearest } from '../../control-space'
import { Experience } from '../vr/experience'
import { SharedPresence } from '../vr/presence'
import { armRide } from '../vr/rigs'
import { ControlFrame } from '../vr/control-frame'
import type { SimValue } from '@obpal/core'
import { mountSound } from '../audio/session'

applyTheme(initialTheme())
mountMarks()
mountTopBar()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ---- which kind of arm: every arm in the cell is one (?kind=, ./kinds.ts) ----

const KIND = kindFrom(new URLSearchParams(location.search).get('kind'))
const KIN = KIND.kin
const INFO = ARM_KINDS.find((k) => k.id === KIND.id)!
const sound = mountSound(KIND.id, (strong, weak, ms, who) => sim?.remote.rumble(strong, weak, ms, who))
const soundPosition = new THREE.Vector3()
let soundAt = 0
/** The gripper's joint, after the pose's. */
const GRIP = KIN.keys.length

// ---- the stage: a work cell, arms around a shared floor ----

// Drawn the way every sim is (../view.ts): clean edges at rest, smooth in motion.
const view = simView($('stage') as HTMLCanvasElement, { onResize: resize })
const renderer = view.renderer
renderer.toneMapping = THREE.ACESFilmicToneMapping
const scene = new THREE.Scene()
scene.environment = environment(renderer)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
scene.environmentIntensity = 0.65
scene.add(new THREE.HemisphereLight(0xffffff, 0x313941, 0.65))
softKey(scene, KIND.cell.fence * 1.35).intensity = 1.8
scene.background = new THREE.Color(document.documentElement.dataset.theme === 'light' ? '#e9edf3' : '#07090d')
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 60)
camera.position.set(...KIND.cell.camera)
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, KIND.cell.look, 0)
controls.enableDamping = true
controls.minDistance = 1.2
controls.maxDistance = 14
controls.enablePan = false
controls.maxPolarAngle = Math.PI * 0.49

const mats = { metal, dark: plastic(palette.carbon) }
const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100), floorMaterial('#090e12'))
floor.rotation.x = -Math.PI / 2
floor.position.y = -0.16
floor.receiveShadow = true
scene.add(floor)
scene.add(tiledDeck(KIND.cell.fence * 2.8, KIND.cell.fence * 2.8, -.004, .48, .14))
// The cell's fence: the arms work inside it.
const fence = new THREE.Mesh(new THREE.TorusGeometry(KIND.cell.fence * 1.3, 0.005, 6, 128), ceramic)
fence.rotation.x = Math.PI / 2
fence.position.y = 0.004
scene.add(fence)
const workholding = fixtures(KIND.cell.stand)
const fixedBoxes = workholding.map(blockBox)
const fixtureMeshes = new THREE.Group()
for (const f of workholding) {
  const m = f.finish === 'peg'
    ? new THREE.Mesh(new THREE.CylinderGeometry(f.half[0], f.half[0], f.half[1] * 2, 16), metal)
    : box(f.half[0] * 2, f.half[1] * 2, f.half[2] * 2, f.finish === 'shelf' ? darkTitanium : ceramic)
  m.position.set(f.x, f.y, f.z)
  m.castShadow = m.receiveShadow = true
  fixtureMeshes.add(m)
}
batch(fixtureMeshes)
scene.add(fixtureMeshes)

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
interface Drive { grab: number; following: boolean; q0: THREE.Quaternion | null; ref: ToolTarget; acc: ToolTarget; world: THREE.Vector3; phone: { yaw: number; pitch: number } }

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

interface Track3 { gen: number; p0: [number, number, number]; q0: [number, number, number, number]; heading: number; tool: THREE.Vector3; delta: THREE.Vector3; forward: number; pitch: number; roll: number }

/** A claw move (A in Point): down to the floor, close or open, back up to the hover height. */
interface Claw {
  phase: 'down' | 'grip' | 'up'
  pick: boolean
  yaw: number
  reach: number
  roll: number
  since: number
  /** Where the gripper is headed, and how far it's been sent so far (the sim's own arm goes straight up or down). */
  goal: number
  h: number
  at: number
}

const MAX_ARMS = 4
const arms: Arm[] = []
const armInstances = instanceCopies(scene)
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

function addArm(number?: number): Arm | null {
  const used = new Set(arms.map((a) => a.n))
  const n = [1, 2, 3, 4].find((k) => !used.has(k) && (number === undefined || number === k))
  if (!n) return null
  const model = KIND.build(n, mats)
  // Around the middle, facing it: the sector its base can't turn to faces out, behind it (./layout.ts).
  const at = placement(n, KIND.cell.stand)
  model.root.position.set(at.x, 0, at.z)
  model.root.rotation.y = at.turn
  scene.add(model.root)
  const id = `a${n}`
  const joints: Joint[] = KIN.joints.map((spec) => ({ spec, node: `${id}.${spec.key}`, angle: spec.home, vel: 0, target: null, state: '', flash: 0 }))
  joints.forEach((j, i) => model.apply[i](j.angle))
  const arm: Arm = { n, id, name: `Arm ${n}`, model, joints, profile: 'both', drive: null, edge: false, state: '', homing: false, flash: 0, hw: null, hover: KIND.drive.hover[0], claw: null, track: null, scale: KIND.drive.scale, goal: null, blocked: false }
  arms.push(arm)
  arms.sort((a, b) => a.n - b.n)
  armInstances.set(arms.map(a => a.model.root))
  void model.upgrade?.().then(install => {
    if (!install || !arms.some(a => a.model === model)) return
    armInstances.clear(); install(); armInstances.set(arms.map(a => a.model.root)); view.invalidate()
  }).catch(() => { /* Optional meshes must never prevent an arm from running. */ })
  refreshNodes()
  return arm
}

async function removeArm(a: Arm) {
  if (a.hw?.live) { sim?.note(`${a.name} is live: take it off live first`); return }
  if (a.hw) await disconnect(a)
  for (const b of blocks) if (b.by === a) drop(b)
  armInstances.clear()
  a.model.dispose()
  arms.splice(arms.indexOf(a), 1)
  armInstances.set(arms.map(a => a.model.root))
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

/** An arm's joints but the gripper, as a pose (./kin.ts). */
function poseOf(a: Arm): Pose {
  const p: Pose = {}
  KIN.keys.forEach((k, i) => { p[k] = a.joints[i].angle })
  return p
}
function setPose(a: Arm, p: Pose) { KIN.keys.forEach((k, i) => { a.joints[i].target = p[k] }) }
/** The whole arm stops where it is (the gripper keeps what it was told). */
function settle(a: Arm) {
  a.drive = null
  a.claw = null
  a.track = null
  if (!a.homing) for (let i = 0; i < GRIP; i++) a.joints[i].target = null
}
function toggleGrip(a: Arm) {
  const g = a.joints[GRIP]
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

interface Block {
  mesh: THREE.Mesh
  half: V3
  mass: number
  by: Arm | null
  vy: number
  /** The opening its holder's fingers stopped at on it. */
  grip: number
  lastHolder?: string
}
const blocks: Block[] = STOCK.map((stock, i) => {
  const [x, y, z] = stock.half
  const material = stock.shape === 'drum' ? metal : plastic(stock.color)
  const mesh = stock.shape === 'drum' ? new THREE.Mesh(new THREE.CylinderGeometry(x, x, y * 2, 24), material) : box(x * 2, y * 2, z * 2, material, 0.004)
  const a = ((i % 6) / 6) * Math.PI * 2 + (i < 6 ? 0.5 : 0.9)
  const r = i < 6 ? KIND.cell.blocks[i % 2] : KIND.cell.stand * 0.58
  mesh.position.set(Math.cos(a) * r, y, Math.sin(a) * r)
  mesh.castShadow = mesh.receiveShadow = true
  mesh.userData.pickable = true
  scene.add(mesh)
  return { mesh, half: stock.half, mass: stock.mass, by: null, vy: 0, grip: 0 }
})
const bq = new THREE.Quaternion()
const bm = new THREE.Matrix4()
const level = new THREE.Quaternion()
const levelTurn = new THREE.Euler()
function drop(b: Block) {
  b.lastHolder = b.by ? sim?.claims.controller(b.by.joints[GRIP].node) : undefined
  scene.attach(b.mesh)
  b.by = null
  b.vy = 0
}
/** How far a block reaches above (and below) its middle, as it's turned. */
function halfHeight(b: Block) {
  const e = bm.makeRotationFromQuaternion(b.mesh.getWorldQuaternion(bq)).elements
  return b.half[0] * Math.abs(e[1]) + b.half[1] * Math.abs(e[5]) + b.half[2] * Math.abs(e[9])
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
const blkOf = (b: Block): Blk => ({ x: b.mesh.position.x, y: b.mesh.position.y, z: b.mesh.position.z, yaw: yawOf(b.mesh.quaternion), half: b.half })
/** Move a free block to where ./blocks.ts put it, turning it about the vertical as far as it turned it. */
function setBlk(b: Block, t: Blk) {
  b.mesh.position.set(t.x, t.y, t.z)
  const turn = t.yaw - yawOf(b.mesh.quaternion)
  if (Math.abs(turn) > 1e-9) b.mesh.quaternion.premultiply(yq.setFromAxisAngle(UP, turn))
}
/** Where an arm stands, its parts (and what it holds) as boxes, and every arm's base, for ./blocks.ts. */
const standOf = (a: Arm): Stand => ({ x: a.model.root.position.x, z: a.model.root.position.z, turn: a.model.root.rotation.y })
const partsOf = (a: Arm) => KIN.parts(standOf(a), poseOf(a), a.joints[GRIP].angle, heldBox(a))
/** Every arm's base as posts standing on the floor, in the world. */
function bases(): Base[] {
  return arms.flatMap((a) => {
    const s = standOf(a), c = Math.cos(s.turn), n = Math.sin(s.turn)
    return KIN.posts.map((p) => ({ x: s.x + c * p.x + n * p.z, z: s.z - n * p.x + c * p.z, column: [[p.r, p.y0, p.y1] as const] }))
  })
}

function updateBlocks(dt: number) {
  const free = blocks.filter((b) => !b.by)
  const all = free.map(blkOf)
  free.forEach((b, i) => {
    // Down to the floor, or onto a block under it (one whose middle it's over: past an edge, it slides off), levelling
    // as it goes: it rests on its lowest corner or face, never in what's under it.
    const rest = restOf(all[i], [...all.filter((_, j) => j !== i), ...workholding])
    const p = b.mesh.position
    p.x = rest.x
    p.z = rest.z
    level.setFromEuler(levelTurn.set(0, yawOf(b.mesh.quaternion), 0))
    if (b.mesh.quaternion.angleTo(level) > 1e-4) b.mesh.quaternion.slerp(level, Math.min(1, dt * 6))
    const y = rest.y - b.half[1] + halfHeight(b)
    if (p.y > y + 1e-4) {
      b.vy -= 9.8 * dt
      p.y = Math.max(y, p.y + b.vy * dt)
    } else {
      if (b.vy < -0.15) {
        sound.bus.emit({ kind: 'contact', source: 'block', at: [p.x, p.y, p.z], who: b.lastHolder, strength: 1, speed: -b.vy, impulse: -b.vy * b.mass, materials: ['plastic', 'metal'] })
        b.lastHolder = undefined
      }
      b.vy = 0
      p.y = y
    }
    all[i] = blkOf(b)
  })
  // Nothing in anything: a block that fell against an arm, or that another arm's push left in one, is pushed out of it,
  // and out of the other blocks and the bases; one pinned among them goes where there's room.
  const parts = [...arms.flatMap(partsOf), ...fixedBoxes]
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
  return { c: [p.x, p.y, p.z], axes: [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]], half: b.half }
}

/**
 * Holding a block, the gripper closes no further than it, and opening lets it go. A real arm holds none of these
 * blocks, which aren't really there: one its twin held when it was connected is let go.
 */
function holdStep(a: Arm) {
  const b = blocks.find((o) => o.by === a)
  if (!b) return
  const g = a.joints[GRIP]
  const h = holding(b.grip, g.angle)
  if (h.release || a.hw) { drop(b); return }
  if (h.open === g.angle) return
  g.angle = h.open
  g.vel = 0
  // On the block, the gripper is as closed as it goes: done.
  if (g.target !== null && g.target < h.open) g.target = null
  a.model.apply[GRIP](g.angle)
}

/**
 * The blocks, as an arm makes this frame's move from `was` (./blocks.ts): what it runs into is pushed along the floor,
 * what can't give way (under a part coming down on it, or pinned) stops the joints that would take it in, and a block
 * the fingers close on, turned square, is held. A real arm is stopped by none of it: it pushes them out of its way.
 */
function blockStep(a: Arm, was: Pose, gripWas: number, following: boolean) {
  const free = blocks.filter((b) => !b.by)
  const g = a.joints[GRIP]
  const r = stepAmong(KIN, standOf(a), { pose: was, open: gripWas }, { pose: poseOf(a), open: g.angle }, heldBox(a),
    { blocks: free.map(blkOf), still: [...arms.filter((o) => o !== a).flatMap(partsOf), ...fixedBoxes], bases: bases() },
    { real: !!a.hw, following })
  free.forEach((b, i) => { if (i !== r.took?.i) setBlk(b, r.blocks[i]) })
  a.blocked = r.stopped.some((k) => k !== 'grip')
  if (a.hw) return
  KIN.keys.forEach((k, i) => {
    if (a.joints[i].angle === r.pose[k]) return
    a.joints[i].angle = r.pose[k]
    a.model.apply[i](r.pose[k])
  })
  if (g.angle !== r.open) { g.angle = r.open; a.model.apply[GRIP](g.angle) }
  for (const k of r.stopped) {
    const j = a.joints[k === 'grip' ? GRIP : KIN.keys.indexOf(k)]
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
  a.model.grasp.getWorldPosition(soundPosition)
  sound.bus.emit({ kind: 'action', action: 'grab', source: a.id, at: [soundPosition.x, soundPosition.y, soundPosition.z], who, strength: 0.4 })
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

const xrDrives = new Map<string, { pad: PadState; at: number }>()
const rides = () => arms.map(a => armRide(a.id, a.name, a.model.root, a.model.grasp, KIND.drive.reach[1], KIND.drive.height[1]))
const shared = new SharedPresence({
  rides,
  capture: () => ({ arms: arms.map(a => ({ id: a.id, angles: a.joints.map(j => j.angle) })), blocks: blocks.map(b => ({ p: b.mesh.getWorldPosition(new THREE.Vector3()).toArray(), q: b.mesh.getWorldQuaternion(new THREE.Quaternion()).toArray() })) }),
  apply(state: SimValue) {
    const s = state as unknown as { arms: { id: string; angles: number[] }[]; blocks: { p: V3; q: [number, number, number, number] }[] }
    if (!Array.isArray(s?.arms) || !Array.isArray(s.blocks)) return
    for (const a of [...arms]) if (!s.arms.some(r => r.id === a.id)) void removeArm(a)
    s.arms.forEach(r => {
      const a = arms.find(a => a.id === r.id) ?? addArm(Number(r.id.slice(1)))
      r.angles.forEach((angle, i) => { if (!a?.joints[i]) return; a.joints[i].angle = angle; a.model.apply[i](angle) })
    })
    s.blocks.forEach((r, i) => { if (blocks[i]) { blocks[i].mesh.position.set(...r.p); blocks[i].mesh.quaternion.set(...r.q) } })
  },
  allowed: who => who === 'host' || !!sim?.allowed(who),
  drive(who, ride, pad) {
    if (!sim || stopped || who !== 'host' && !sim.allowed(who)) return
    if (!sim.claims.holder(ride)) sim.take(ride, who)
    if (sim.claims.holder(ride) !== who) return
    const held = pad.triggers.some(t => t > 0.5)
    xrDrives.set(who, { pad: held ? { ...pad, triggers: [0, 0] } : { ...pad, axes: [0, 0, 0, 0], triggers: [0, 0], buttons: 0 }, at: performance.now() })
    lastInput.set(who, performance.now())
  },
})
scene.add(shared.group)
view.presence = new Experience(renderer, scene, camera, rides, shared, controls)
const controlFrame = (who: string) => {
  const input = xrDrives.get(who)
  const head = input && performance.now() - input.at < 200 ? shared.people.get(who)?.head.q : undefined
  return head ? new ControlFrame().set(new THREE.Quaternion(...head)) : view.presence!.controlFrame
}
/** Calibrated reach uses the participant's view expressed in this arm's base frame. */
function workspace(a: Arm, who: string, aim: readonly [number, number]) {
  a.model.root.updateWorldMatrix(true, false)
  const right = controlFrame(who).right.clone().transformDirection(a.model.root.matrixWorld.clone().invert())
  return armWorkspace(aim, KIN.yawRange, KIND.drive.reach, Math.atan2(-right.z, right.x))
}
if (!shared.guest) blocks.forEach(b => shared.world.add('block', b.mesh.position.toArray(), b.half[1], {
  read: () => b.mesh.getWorldPosition(new THREE.Vector3()).toArray(),
  write: (p, v) => { if (!b.by) { b.mesh.position.set(...p); b.vy = v[1] } },
  busy: () => !!b.by || arms.some(a => !!a.hw?.live),
}))

if (!shared.guest) void startSimScene({
  appName: 'ob.Pal robot arms',
  layout,
  nodes: arms.flatMap(nodesOf),
  approval: true,
  howTo,
  label: (n) => (n.group ? `${n.group} · ${n.name}` : n.name),
  changed: () => renderPanel(),
}).then((s) => {
  sim = s
  shared.connect(s.remote)
  s.remote.on('input', (who) => lastInput.set(who.id, performance.now()))
  s.remote.on('button', ({ id, ev }, who) => {
    if (id === 'estop') { estop(who.id); return }
    if (id === 'wii-a' && ev !== 'tap') return
    if (s.control.scope(who.id) === 'scene' && (id === 'control.take' || id === 'wii-a')) {
      const space = s.control.aim(who.id)
      if (space && s.allowed(who.id) && !stopped && arms.length) {
        const target = nearest(sceneCells(arms.length).map(([x, y], n) => ({ x, y, n })), space.aim)
        if (s.take(arms[target.n].id, who.id)) s.control.setScope(who.id, 'object')
      }
      return
    }
    // B is Point's deadman: the arm follows the pointer while it's held.
    if (id === 'wii-b') { const aim = aimOf(who.id); aim.b = ev === 'down'; return }
    const node = s.claims.held(who.id)
    const f = node ? findNode(node) : null
    if (!f || stopped) return
    if (!f.joint && id === 'wii-a') { startClaw(f.arm); return }
    if (!f.joint && (id === 'wii-plus' || id === 'wii-minus')) {
      f.arm.hover = clamp(Math.round((f.arm.hover + (id === 'wii-plus' ? 0.05 : -0.05)) * 100) / 100, KIND.drive.hover[1], KIND.drive.hover[2])
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
  s.remote.on('recenter', (who) => {
    aims.get(who.id)?.pointer.recenter()
    const a = armOf(s.claims.held(who.id) ?? '')
    if (a) { a.track = null; a.drive = null }
  })
  s.remote.on('leave', (p) => { xrDrives.delete(p.id); dropAim(p.id); renderPanel() })
  refreshNodes()
})

// The kind of arm: another kind is another cell, so the page again with it (./kinds.ts).
const kindPick = $('arm-kind') as HTMLSelectElement
for (const k of ARM_KINDS) kindPick.add(new Option(k.name, k.id, false, k.id === KIND.id))
kindPick.title = INFO.blurb
kindPick.onchange = () => { const u = new URL(location.href); u.searchParams.set('kind', kindPick.value); location.assign(u) }

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
  if (sim?.control.scope(who) === 'scene') return null
  const space = sim?.control.aim(who)
  if (!pad && space && f.clutch && f.mode === Mode.hold) {
    j.target = j.spec.min + (space.aim[0] + 1) * span / 2
    return 0
  }
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
    // A degree of the phone's turn: a degree, 1/6 cm of a joint that slides, 1/120 of the gripper's opening.
    const scale = j.spec.unit === '°' ? 1 : j.spec.unit === 'm' ? 1 / 600 : 1 / 120
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
  if (xrDrives.has(who) && now - xrDrives.get(who)!.at >= 200) xrDrives.delete(who)
  const xr = xrDrives.get(who)
  const pad = xr?.pad ?? s.remote.padOf(who)
  if (now - (lastInput.get(who) ?? 0) > 200) { settle(a); return 'watchdog' }
  if (s.control.scope(who) === 'scene') { settle(a); return 'deadman' }
  if (!pad && f.mode === Mode.point) return drivePoint(a, who, now)
  if (!pad && f.mode === Mode.track) return driveTrack(a, who, f)
  const grip = a.joints[GRIP]
  const inc = zeroTarget()
  let right = 0, forward = 0
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
    right = lx * 0.35 * dt
    forward = -ly * 0.35 * dt
    inc.height = -ry * 0.35 * dt
    inc.roll = rx * 120 * dt
  } else {
    // A thumb on the pad is the deadman. With the gyro on (1:1), the phone's own motion drives the tool.
    active = f.touching
    following = f.clutch && f.mode === Mode.hold
    right = f.pad1[0] * 0.0008
    forward = -f.pad1[1] * 0.0008
    inc.height = -f.pad2[1] * 0.0008
    inc.pitch = f.pad2[0] * 0.15
    inc.roll = -f.twist * R2D
    if (f.mode === Mode.tilt) { right += f.tilt[0] * 0.35 * dt; forward -= f.tilt[1] * 0.35 * dt }
    if (f.zoom) grip.target = clamp((grip.target ?? grip.angle) + f.zoom * 0.6, 0, 1)
  }
  if (!active) { settle(a); return a.homing ? '' : 'deadman' }
  a.homing = false
  // Begin a drive from where the tool is and where the phone points: letting go and pressing again ratchets.
  if (!a.drive || a.drive.grab !== f.grab || a.drive.following !== following) {
    const ref = KIN.forward(poseOf(a))
    a.drive = { grab: f.grab, following, q0: following ? new THREE.Quaternion(f.qRel[0], f.qRel[1], f.qRel[2], f.qRel[3]) : null, ref, acc: zeroTarget(), world: toolWorld(a, ref), phone: { yaw: 0, pitch: 0 } }
  }
  const d = a.drive
  for (const k of ['yaw', 'reach', 'height', 'pitch', 'roll'] as const) d.acc[k] += inc[k]
  const ph = d.q0 ? phoneTurn(d.q0, f.qRel) : { yaw: 0, pitch: 0, roll: 0 }
  const world = d.world.clone().add(controlFrame(who).move(right - (ph.yaw - d.phone.yaw) * D2R * LIFT, inc.height + (ph.pitch - d.phone.pitch) * D2R * LIFT, forward))
  d.phone = ph
  const local = a.model.root.worldToLocal(world.clone())
  const pitch = clamp(d.ref.pitch + d.acc.pitch, ...KIN.pitchRange)
  const roll = clamp(d.ref.roll + d.acc.roll - ph.roll, ...KIN.rollRange)
  const goal: ToolTarget = {
    yaw: KIN.heading(Math.atan2(local.z, -local.x) * R2D, poseOf(a)),
    reach: clamp(Math.hypot(local.x, local.z), ...KIND.drive.reach),
    // No lower than the gripper can go at its angle: pushed down, it stops on the floor.
    height: clamp(local.y, Math.max(KIND.drive.height[0], KIN.toolFloor(pitch, roll, heldBox(a))), KIND.drive.height[1]),
    pitch,
    roll,
  }
  const space = s.control.aim(who)
  if (space && following && !pad) {
    const target = workspace(a, who, [space.aim[0], 0])
    goal.yaw = target.yaw; goal.reach = target.reach
    goal.height = Math.max(KIN.toolFloor(pitch, roll, heldBox(a)), armHeight(space.aim[1], KIND.drive.height))
  }
  // No winding up past the clamps: pushing further out and back again answers at once.
  d.acc = { yaw: goal.yaw - d.ref.yaw - ph.yaw, reach: goal.reach - d.ref.reach, height: goal.height - d.ref.height - ph.pitch * D2R * LIFT, pitch: goal.pitch - d.ref.pitch, roll: goal.roll - d.ref.roll + ph.roll }
  const { pose, reached } = KIN.inverse(goal, heldBox(a), poseOf(a))
  const ok = reached && within(KIN, pose)
  // Past the arm's reach or a joint's limit, the arm holds the last pose it could reach.
  if (ok) { setPose(a, pose); d.world.copy(toolWorld(a, goal)) }
  a.goal = goal
  view.presence?.motionControl(f.mode === Mode.tilt || following)
  if (!ok && !a.edge) s.remote.feedback({ haptic: 'bump' }, who)
  a.edge = !ok
  return ok ? '' : 'edge'
}

// ---- Point and go: each participant's aim lands on the floor, Wii-style ----

interface Aim { pointer: ScreenPointer; on: boolean; b: boolean; hit: THREE.Vector3 | null; dot: THREE.Group }
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
  const dot = new THREE.Group()
  dot.add(ring, core)
  dot.visible = false
  dot.renderOrder = 2
  scene.add(dot)
  a = { pointer: new ScreenPointer(), on: false, b: false, hit: null, dot }
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
    view.presence?.motionControl(!!s.control.aim(p.id))
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
    const activeCamera = view.presence?.activeCamera ?? camera
    const mid = tv.set(0, 0, 0).project(activeCamera)
    ndc.set(mid.x + ((st.x - innerWidth / 2) / innerWidth) * 2, mid.y - ((st.y - innerHeight / 2) / innerHeight) * 2)
    raycaster.setFromCamera(ndc, activeCamera)
    let hit = st.off ? null : raycaster.ray.intersectPlane(floorPlane, aim.hit ?? new THREE.Vector3())
    const space = s.control.aim(p.id), heldArm = armOf(s.claims.held(p.id) ?? '')
    if (space && heldArm && s.control.scope(p.id) === 'object') {
      const local = workspace(heldArm, p.id, space.aim)
      hit = heldArm.model.root.localToWorld(new THREE.Vector3(local.x, 0, local.z))
    } else if (space && arms.length && s.control.scope(p.id) === 'scene') {
      const target = nearest(sceneCells(arms.length).map(([x, y], n) => ({ x, y, n })), space.aim)
      s.control.target(p.id, s.nodeName(arms[target.n].id))
      hit = arms[target.n].model.root.getWorldPosition(new THREE.Vector3())
    }
    // Keep it inside the cell's fence.
    const edge = KIND.cell.fence - 0.05
    if (hit && Math.hypot(hit.x, hit.z) > edge) { const k = edge / Math.hypot(hit.x, hit.z); hit.x *= k; hit.z *= k }
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
    const color = '#c6ff34'
    aim.dot.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) (m.material as THREE.MeshBasicMaterial).color.set(color) })
    aim.dot.scale.setScalar(aim.b ? 1.35 : 1)
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
  // Behind the arm, it holds at a limit rather than swinging round (./layout.ts); `exact` says it faces the spot.
  const pose = poseOf(a)
  const r = reachDown(KIN, Math.atan2(local.z, -local.x) * R2D, Math.hypot(local.x, local.z), a.hover, KIN.forward(pose).roll, heldBox(a), pose)
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
  // The deadman as the phone saw it with this pose (a glow's pose comes from the camera, so from STATE). Only the
  // pose's: a STATE that lags the thumb lifting doesn't keep the arm following the poses after it.
  const held = pose ? pose.touching : false
  if (!pose || !pose.tracked || !held) {
    if (pose && !pose.tracked && held && a.track) sim?.remote.feedback({ toast: 'Lost track: more light, slower moves' }, who)
    settle(a)
    return 'deadman'
  }
  a.homing = false
  a.claw = null
  if (!a.track || a.track.gen !== pose.gen) {
    const t = KIN.forward(poseOf(a))
    a.track = { gen: pose.gen, p0: [...pose.p], q0: [...pose.q], heading: headingOf(pose.q), tool: toolWorld(a, t), delta: new THREE.Vector3(), forward: 0, pitch: t.pitch, roll: t.roll }
  }
  const k = a.track
  const m = handMove([pose.p[0] - k.p0[0], pose.p[1] - k.p0[1], pose.p[2] - k.p0[2]], k.heading)
  const turn = handTurn(k.q0, pose.q, k.heading)
  // The stage as the screen shows it: its right, and into it.
  const frame = controlFrame(who)
  camFwd.copy(frame.forward); camRight.copy(frame.right)
  k.p0 = [...pose.p]
  const delta = k.delta.clone().addScaledVector(camRight, m.right * a.scale).addScaledVector(UP, m.up * a.scale).addScaledVector(camFwd, m.forward * a.scale)
  const w = tv.copy(k.tool).add(delta)
  const local = a.model.root.worldToLocal(w)
  // Behind the arm, it holds at a limit rather than swinging round (./layout.ts).
  const want = Math.atan2(local.z, -local.x) * R2D
  const current = poseOf(a)
  const goal: ToolTarget = {
    yaw: KIN.heading(want, current),
    reach: Math.max(KIND.drive.reach[0], Math.hypot(local.x, local.z)),
    height: Math.max(CLAW_LOW, local.y),
    pitch: clamp(k.pitch - turn.tip, ...KIN.pitchRange),
    roll: clamp(k.roll + turn.twist, ...KIN.rollRange),
  }
  const space = sim?.control.aim(who)
  if (space) {
    const target = workspace(a, who, [space.aim[0], 0])
    goal.yaw = target.yaw
    goal.height = armHeight(space.aim[1], KIND.drive.height)
    k.forward += m.forward
    goal.reach = clamp(target.reach + k.forward * (KIND.drive.reach[1] - KIND.drive.reach[0]) / 0.3, ...KIND.drive.reach)
  }
  a.goal = goal
  // Where the gripper goes comes first: tip it if that's what it takes to get there.
  const r = solveNear(KIN, goal, 60, heldBox(a), current)
  if (r) { setPose(a, r.pose); k.delta.copy(delta) }
  view.presence?.motionControl(true)
  const ok = !!r && (!!space || turnBetween(goal.yaw, want) < 1e-6)
  if (!ok && !a.edge) sim?.remote.feedback({ haptic: 'bump' }, who)
  a.edge = !ok
  return ok ? '' : 'edge'
}

/** The gripper this close above the floor grasps a block lying there. */
const CLAW_LOW = 0.035

/** How fast the sim's own arm takes the gripper straight down or up for the claw (m/s). */
const CLAW_SPEED = 0.3

/** Send the gripper to a height over the claw's spot. */
function clawAt(a: Arm, c: Claw, height: number) {
  const r = reachDown(KIN, c.yaw, c.reach, height, c.roll, heldBox(a), poseOf(a))
  if (r) setPose(a, r.pose)
}

/**
 * Send the claw's gripper to a height over its spot. The sim's own arm takes it there straight down (or up), a little
 * further each frame, so that its fingers come down around a block rather than on it: each joint heading straight for
 * its end would swing the gripper a few centimetres to the side on the way. A real arm goes as it always has.
 */
function clawTo(a: Arm, c: Claw, height: number) {
  c.goal = height
  c.h = a.hw ? height : KIN.forward(poseOf(a)).height
  c.at = performance.now()
  if (a.hw) clawAt(a, c, height)
}

/** A (Point): pick up what's under the gripper, or put down what it holds. */
function startClaw(a: Arm) {
  if (a.claw || stopped || (a.hw && !a.hw.live)) return
  const t = KIN.forward(poseOf(a))
  a.homing = false
  // Holding a block, it puts it down; else it picks one up, opening on the way down.
  const pick = !blocks.some((b) => b.by === a)
  if (pick) a.joints[GRIP].target = 1
  a.claw = { phase: 'down', pick, yaw: t.yaw, reach: t.reach, roll: t.roll, since: performance.now(), goal: CLAW_LOW, h: t.height, at: performance.now() }
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
  const still = c.h === c.goal && a.joints.slice(0, GRIP).every((j) => j.target === null && Math.abs(j.vel) < 2)
  const g = a.joints[GRIP]
  if (now - c.since > 8000) { a.claw = null; return '' }
  // Down (or down on a block that stops it): close or open.
  if (c.phase === 'down' && (still || a.blocked)) { c.phase = 'grip'; g.target = c.pick ? 0 : 1 } else if (c.phase === 'grip' && g.target === null) {
    c.phase = 'up'
    clawTo(a, c, a.hover)
  } else if (c.phase === 'up' && still) a.claw = null
  return ''
}

// ---- the loop ----
const jointInputs = new WeakMap<Joint, InputSmoother>()

function stepArm(a: Arm, now: number, dt: number) {
  const s = sim
  const hw = a.hw
  // Connected but not live: the twin follows the real arm, and nobody drives it.
  const mirror = !!hw && !hw.live
  const armWho = s?.claims.holder(a.id)
  a.state = ''
  if (stopped || mirror || !armWho || armWho === 'host' && !xrDrives.has(armWho) || !s) { a.drive = null; if (!armWho) a.edge = false }
  else a.state = driveWhole(a, armWho, now, dt)
  const got = mirror ? hw.driver.read() : null
  const angles = got ? fromRaw(hw!.cal, got.raw.map((v) => v ?? NaN)) : null
  const cap = hw?.live ? hw.cap : hw ? 1 : payloadSpeed(blocks.find(b => b.by === a)?.mass ?? 0)
  // Where the arm and the gripper were, and whether it's headed for a pose, for the floor and the grip (below).
  const was = poseOf(a)
  const gripWas = a.joints[GRIP].angle
  const following = !stopped && a.joints.slice(0, GRIP).some((j) => j.target !== null)
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
    // The prototype's simulated joints share a damped response. The hardware path retains its existing controller.
    if (KIND.id === 'so101' && !hw && !stopped) {
      let filter = jointInputs.get(j)
      if (!filter) { filter = new InputSmoother(); jointInputs.set(j, filter) }
      const released = j.state === 'deadman' || j.state === 'watchdog' || (!who && !armWho && j.target === null)
      if (released) filter.reset()
      const target = j.target !== null ? filter.sample('target', j.target, dt, j.angle) : j.angle + (released ? 0 : filter.sample('velocity', v, dt)) * .2
      const next = servo(j.angle, j.vel, target, dt, { ...j.spec, vmax: j.spec.vmax * cap, amax: j.spec.amax * cap })
      j.angle = next.position; j.vel = next.velocity
      const tolerance = j.spec.unit === '°' ? .05 : .002
      if (j.target !== null && Math.abs(j.target - j.angle) < tolerance && Math.abs(j.vel) < tolerance * 6) { j.target = null; filter.reset() }
      if ((v || j.target !== null) && (j.angle === j.spec.min || j.angle === j.spec.max)) j.state ||= 'limit'
      a.model.apply[i](j.angle)
      return
    }
    if (stopped) jointInputs.delete(j)
    // Following a target (the whole arm, 1:1, home, the gripper): a proportional approach under the same caps.
    if (j.target !== null && !stopped) {
      const e = j.target - j.angle
      v = Math.abs(e) < (j.spec.unit === '°' ? 0.05 : j.spec.unit === 'm' ? 0.0005 : 0.002) ? 0 : e * 6
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
    const { pose, floored } = KIN.stepAboveFloor(was, poseOf(a), following, heldBox(a))
    for (const k of floored) {
      const i = KIN.keys.indexOf(k)
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
  a.model.secondary?.(dt)
  if (a.homing && a.joints.every((j) => j.target === null)) a.homing = false
  // Rings wear their controller's colour, and flash when control changes.
  a.joints.forEach((j, i) => paint(a.model.rings[i], s?.claims.controller(j.node), j, dt, Math.abs(j.vel) > 1e-3))
  paint(a.model.plate, armWho, a, dt, false)
  if (hw?.live) liveStep(a, now)
}

function paint(ring: THREE.Mesh, who: string | undefined, o: { flash: number }, dt: number, moving: boolean) {
  const mat = ring.material as THREE.MeshStandardMaterial
  const idle = ring.userData.idleColor ?? '#5b6472'
  mat.emissive.set(who ? sim!.colorOf(who) || idle : idle)
  o.flash = Math.max(0, o.flash - dt / 0.7)
  mat.emissiveIntensity = (who ? 1.4 : 0.25) + 2.2 * o.flash + (moving ? 0.6 : 0)
  ring.scale.setScalar(1 + 0.25 * o.flash)
}

let last = 0
function loop(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  if (!shared.guest) {
    readInputs(now)
    for (const a of arms) stepArm(a, now, dt)
    updateBlocks(dt)
  }
  if (now - soundAt >= 50) {
    soundAt = now
    for (const a of arms) for (let i = 0; i < a.joints.length; i++) {
      const j = a.joints[i], speed = Math.min(1, Math.abs(j.vel) / Math.max(0.01, j.spec.vmax))
      const stalled = j.state === 'limit' || j.state === 'floor' || a.blocked && j.target !== null && Math.abs(j.target - j.angle) > 0.015
      if (speed < 0.02 && !stalled) continue
      a.model.rings[i].getWorldPosition(soundPosition)
      const payload = blocks.find(b => b.by === a)?.mass ?? 0
      sound.bus.emit({ kind: 'motor', texture: 'servo', source: j.node, spatialGroup: a.id, at: [soundPosition.x, soundPosition.y, soundPosition.z], who: sim?.claims.controller(j.node), strength: stalled ? Math.max(0.35, speed) : speed, rpm: speed, load: stalled ? 1 : Math.min(0.9, 0.25 + payload * 0.7) })
    }
  }
  sound.tick(now)
  controls.update()
  armInstances.update()
  view.draw(scene, camera, dt)
  if (Math.floor(now / 100) !== Math.floor((now - dt * 1000) / 100)) renderReadouts()
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
  for (let i = 0; i < GRIP; i++) if (Number.isFinite(got[i])) off = Math.max(off, Math.abs(got[i] - a.joints[i].angle))
  if (off <= 12) { hw.lagSince = 0; return }
  hw.lagSince ||= now
  if (now - hw.lagSince > 600) estop('host', `${a.name} isn’t keeping up (${Math.round(off)}° off): check for something in its way`)
}

/** Where an arm's calibration is kept: per kind of arm (the five-axis arm's as it always was), driver and arm. */
const calKey = (kind: DriverKind, a: Arm) => `obpal-arm-cal:${KIND.id === 'arm5' ? '' : `${KIND.id}:`}${kind}:${a.n}`
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
  const out = KIN.joints.findIndex((s, i) => !(angles[i] >= s.min - 3 && angles[i] <= s.max + 3))
  if (out >= 0) { sim?.note(`${a.name}’s ${KIN.joints[out].name.toLowerCase()} reads outside its limits: calibrate it first`); return }
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
    $('hw-dirs').replaceChildren(...KIN.joints.slice(0, GRIP).map((s, i) => {
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
  a.hw.cal = calibrateHome(a.hw.cal, r.raw as number[], KIN.joints.map((s) => s.home))
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
  disableGuestPanel()
}

function disableGuestPanel() {
  if (view.presence?.shared?.guest) document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('.sim-panel button, .sim-panel input, .sim-panel select').forEach(e => { if (!e.closest('.presence-controls, .sim-sound')) e.disabled = true })
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
  // Only an arm with a real one's joints can be its twin (./drivers.ts).
  hwBtn.hidden = !KIND.hardware
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
    li.innerHTML = '<i class="dot"></i><span class="nn"><b>Whole arm</b><small></small></span><span class="nv"></span><span class="bar bb-meter"></span>'
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
      li.innerHTML = '<i class="dot"></i><b></b><span class="nv"></span><span class="bar bb-meter"></span>'
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
      const t = KIN.forward(poseOf(a))
      const [near, far] = KIND.drive.reach
      row.querySelector('.nv')!.textContent = `${Math.round(t.reach * 100)} cm · ${Math.round(t.height * 100)} up`
      row.querySelector<HTMLElement>('.bar')!.style.setProperty('--fill', `${clamp((t.reach - near) / (far - near), 0, 1) * 100}%`)
      row.dataset.state = a.state || (a.hw && !a.hw.live ? 'mirror' : stopped ? 'stopped' : '')
    }
    for (const j of a.joints) {
      const li = document.querySelector<HTMLElement>(`#arms li[data-node="${j.node}"]`)
      if (!li) continue
      li.querySelector('.nv')!.textContent = j.spec.unit === '°' ? `${Math.round(j.angle)}°` : j.spec.unit === 'm' ? `${Math.round(j.angle * 100)} cm` : `${Math.round(j.angle * 100)}%`
      li.querySelector<HTMLElement>('.bar')!.style.setProperty('--fill', `${((j.angle - j.spec.min) / (j.spec.max - j.spec.min)) * 100}%`)
      li.dataset.state = j.state
    }
  }
}

/** Centre the stage in the space beside the panel (wide screens) or above it (narrow). */
let overview = false
function resize() {
  const w = view.width
  const h = view.height
  camera.aspect = w / h
  const panel = document.querySelector('.sim-panel')!.getBoundingClientRect()
  if (w > 860) camera.setViewOffset(w, h, -panel.right / 2, 0, w, h)
  else camera.setViewOffset(w, h, 0, (h - panel.top) / 2, w, h)
  const free = w > 860 ? Math.min(w - panel.right, h - 90) : Math.min(w, panel.top - 64)
  const height = arms.length ? new THREE.Box3().setFromObject(arms[0].model.root).getSize(new THREE.Vector3()).y : 0
  const radius = Math.max(KIND.cell.fence * (overview ? 0.95 : 0.48), height * 0.6)
  const distance = radius / (Math.tan(camera.fov * Math.PI / 360) * Math.max(0.2, free / h))
  const target = new THREE.Vector3(0, overview ? KIND.cell.look : Math.max(KIND.cell.look, height * 0.45), 0)
  const direction = new THREE.Vector3(...KIND.cell.camera).sub(target)
  camera.position.copy(target).addScaledVector(direction.normalize(), distance)
  controls.target.copy(target)
  controls.maxDistance = Math.max(14, distance * 1.6)
  controls.update()
  camera.updateProjectionMatrix()
}
const resetView = document.createElement('button')
resetView.className = 'add-arm'
resetView.textContent = 'Reset view'
resetView.onclick = () => { overview = false; resize() }
$('add-arm').after(resetView)
const overviewView = document.createElement('button')
overviewView.className = 'add-arm'
overviewView.textContent = 'Overview'
overviewView.onclick = () => { overview = true; resize() }
resetView.after(overviewView)
const inspectArm = document.createElement('button')
inspectArm.className = 'add-arm'
inspectArm.textContent = 'Inspect arm'
inspectArm.onclick = () => {
  if (!arms.length) return
  const bounds = new THREE.Box3().setFromObject(arms[0].model.root)
  const target = bounds.getCenter(new THREE.Vector3())
  const span = bounds.getSize(new THREE.Vector3()).length() * 0.45
  const distance = span / (Math.tan(camera.fov * Math.PI / 360) * Math.min(1, camera.aspect))
  camera.position.copy(target).addScaledVector(new THREE.Vector3(0.7, 0.4, 1).normalize(), distance)
  controls.target.copy(target)
  controls.update()
}
resetView.after(inspectArm)
resize()
renderPanel()
renderer.setAnimationLoop(loop)
disableGuestPanel()

Object.assign(window, {
  __arm: {
    arms: () => arms.map((a) => ({
      id: a.id, profile: a.profile, state: a.state, edge: a.edge, live: !!a.hw?.live, twin: !!a.hw, hover: a.hover, claw: a.claw?.phase ?? null, goal: a.goal, anchor: a.track ? { p0: a.track.p0, tool: a.track.tool.y } : null,
      tool: KIN.forward(poseOf(a)), joints: a.joints.map((j) => ({ node: j.node, angle: j.angle, target: j.target, vel: j.vel, state: j.state })),
    })),
    blocks: () => blocks.map((b) => b.by?.id ?? null),
    /** A block: where it is, how it's turned, how low it reaches, who holds it and the opening they hold it at. */
    block: (i: number) => {
      const b = blocks[i], p = b.mesh.getWorldPosition(new THREE.Vector3())
      return { x: p.x, y: p.y, z: p.z, yaw: yawOf(b.mesh.getWorldQuaternion(new THREE.Quaternion())), bottom: p.y - halfHeight(b), by: b.by?.id ?? null, grip: b.by ? b.grip : null }
    },
    /** Send an arm to a pose (degrees; the gripper 0 closed … 1 open), as Home does (tests and screenshots). */
    goTo: (id: string, pose: Pose, open?: number) => { const a = armOf(id); if (!a) return; a.homing = false; setPose(a, pose); if (open !== undefined) a.joints[GRIP].target = open },
    /** The kind of arm, and its pose's joints. */
    kind: () => ({ id: KIND.id, keys: KIN.keys }),
    toolPosition: (id: string) => { const a = armOf(id); return a ? toolWorld(a, KIN.forward(poseOf(a))).toArray() : null },
    /** Where an arm stands, and which way it's turned. */
    stand: (id: string) => { const a = armOf(id); return a ? standOf(a) : null },
    /** The pose that puts an arm's gripper `height` over (x, z) on the floor, as Point would (null: it can't, exactly). */
    solve: (id: string, x: number, z: number, height: number) => {
      const a = armOf(id)
      if (!a) return null
      const local = a.model.root.worldToLocal(new THREE.Vector3(x, 0, z))
      const pose = poseOf(a)
      const r = reachDown(KIN, Math.atan2(local.z, -local.x) * R2D, Math.hypot(local.x, local.z), height, KIN.forward(pose).roll, heldBox(a), pose)
      return r?.exact ? r.pose : null
    },
    /** Put a block down on the floor at (x, z), turned `yaw` degrees (tests and screenshots). */
    placeBlock: (i: number, x: number, z: number, yaw = 0) => { const b = blocks[i]; if (b.by) drop(b); b.mesh.position.set(x, b.half[1], z); b.mesh.quaternion.setFromAxisAngle(UP, yaw * D2R); b.vy = 0 },
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
