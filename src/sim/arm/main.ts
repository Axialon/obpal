import { contactPart, contactSurface } from '../contact'
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
 * asked), a 200 ms watchdog, a Stop on every device (a software hold, not an emergency stop) and the screen that holds
 * position, approval before a first claim, a check that a real arm keeps up, and a record of who held what.
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
import { placeLoading } from '../kit/loading'
import { holdRig, isHeld, type RigHold } from '../kit/reveal'
import { InputSmoother, servo } from '../kit/motion'
import type { SceneNode, SceneSet } from '@obpal/core'
import { Mode, PadButton, type Frame, type Layout, type PadState, type Quat } from '@obpal/host'
import { applyTheme, initialTheme } from '../../ui/themes'
import { mountMarks } from '../../ui/icons'
import { mountTopBar } from '../../landing/topbar'
import { startSimScene, type SimScene } from '../scene'
import { LocalControls } from '../local-controls'
import { mapFaceInput } from '../face-input'
import { restInput } from '../devices/types'
import { simView } from '../view'
import {
  calibrateHome, defaultCalibration, FeetechDriver, firstOutOfLimits, fromRaw, hasSerial, RosDriver, ROS_DEFAULTS, SerialTextDriver, toRaw,
  type ArmDriver, type Calibration, type DriverKind,
} from './drivers'
import { blockBox, eject, restOf, settle as settleBlocks, stepAmong, type Base, type Blk, type Stand } from './blocks'
import { holding, type GripBox, type V3 } from './grasp'
import { reachDown, solveNear, within, type Pose } from './kin'
import type { ToolTarget } from './kinematics'
import { kindFrom } from './kind'
import { ARM_KINDS, type ArmKindId } from './kinds'
import { placement, turnBetween } from './layout'
import type { ArmModel, JointSpec } from './model'
import { GlowFollower, handMove, handTurn, headingOf } from '@obpal/host'
import { ScreenPointer } from '../../viewer/pointer'
import { armWorkspace, armHeight } from './control-space'
import { ArmHandInput } from './hand-input'
import { sceneCells, nearest } from '../../control-space'
import { Experience } from '../vr/experience'
import { SharedPresence } from '../vr/presence'
import { armRide } from '../vr/rigs'
import { ControlFrame } from '../vr/control-frame'
import type { SimValue } from '@obpal/core'
import { mountSound } from '../audio/session'
import { mountSimPanels, numberSections } from '../ui/panels'
import { CapsuleGauge, RingGauge } from '../../ui/kit/gauge'
import { Telemetry } from '../../ui/kit/telemetry'
import { Readout } from '../../ui/kit/readout'
import { iconAction } from '../../ui/kit/action'
import { syncActionState } from '../action-state'
import { mountQuick, quickAction, quickViews } from '../../ui/quick'
import { HandCursor } from '../../ui/hand-cursor'
import { holdReload } from '../../ui/recover'
import { modelFailed, startScene } from '../kit/recovery'

startScene(() => {
applyTheme(initialTheme())
mountMarks()
mountTopBar()
// The quick-actions tray, before the windows, which keep clear of its edge.
mountQuick()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const D2R = Math.PI / 180
const R2D = 180 / Math.PI
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ---- which kind of arm: every arm in the cell is one (?kind=, ./kinds.ts) ----

const KIND = kindFrom(new URLSearchParams(location.search).get('kind'))
const KIN = KIND.kin
const INFO = ARM_KINDS.find((k) => k.id === KIND.id)!
const panels = mountSimPanels(`arm:${KIND.id}`, 'Controls')
panels.root.append($('arms'))
/** Each joint's dial, and each arm's whole-arm readout and reach, by node id (rebuilt with the cards). */
const dials = new Map<string, { dial: RingGauge; angle: Readout }>()
const reaches = new Map<string, { readout: Telemetry; reach: CapsuleGauge }>()
const sound = mountSound(KIND.id, (strong, weak, ms, who) => sim?.remote.rumble(strong, weak, ms, who))
numberSections(document.querySelector('.arm-panel')!)
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
const surface = () => {
  scene.background = new THREE.Color(document.documentElement.dataset.bbTheme === 'carbon' ? '#07090d' : getComputedStyle(document.documentElement).getPropertyValue('--bb-page').trim())
}
surface()
addEventListener('bb-theme', surface)
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
scene.add(tiledDeck(KIND.cell.fence * 2.8, KIND.cell.fence * 2.8, 0, .48, .14))
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
  fixtureMeshes.add(contactSurface(m))
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
  cameraHand: ArmHandInput
  cameraTrack: { tool: THREE.Vector3; delta: THREE.Vector3; pitch: number; roll: number } | null
  scale: number
  /** The tool target a 3D drive last asked for (for the record and tests). */
  goal: ToolTarget | null
  /** A block stopped some of its joints this frame (the claw takes that as having come down on something). */
  blocked: boolean
  /** The holder's choice on the phone's strip last frame (PartFocus serial): a new one starts from where the arm is. */
  chosen: number
  /** For the finger now down: which way each joint it drives turns, so the gripper goes the way the finger does. */
  jog: Map<string, [number, number]>
}

interface Track3 { gen: number; p0: [number, number, number]; q0: [number, number, number, number]; heading: number; tool: THREE.Vector3; delta: THREE.Vector3; forward: number; pitch: number; roll: number; space: { origin: { yaw: number; reach: number; height: number }; tool: ToolTarget } | null }

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
/** Each arm's hold on its procedural model until its Blender mesh is in (../kit/reveal.ts), and the roots shared draws may take. */
const holds = new Map<ArmModel, RigHold>()
const shownRoots = () => arms.map(a => a.model.root).filter(root => !isHeld(root))
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

/** A joint's glyph on the phone's node strip, by how it moves. */
const JOINT_ICON: Record<string, string> = { base: 'turn', shoulder: 'lift', elbow: 'bend', wrist: 'nod', twist: 'roll', roll: 'roll', z: 'slide', gripper: 'grip' }

/**
 * The ways to move an arm a set of joints at a time (PROTOCOL §3a), each holding the rest where it is: Reach, the
 * joints that place the gripper, and Wrist, those that turn it. A way of one joint is that joint's own item (the
 * gripper is Grip), and the joints one by one follow the sets on the phone's strip.
 */
function armSets(a: Arm): SceneSet[] {
  const of = (keys: string[]) => keys.flatMap((k) => a.joints.filter((j) => j.spec.key === k).map((j) => j.node))
  return [
    { id: 'reach', name: 'Reach', icon: 'reach', parts: of(['base', 'shoulder', 'z', 'elbow', 'a1', 'a2', 'a3']), locks: true },
    { id: 'wrist', name: 'Wrist', icon: 'wrist', parts: of(['roll', 'wrist', 'twist']), locks: true },
  ].filter((s) => s.parts.length > 1)
}

function nodesOf(a: Arm): SceneNode[] {
  // Its holder can drive any joint on its own, or a set of them, from the phone's strip.
  const whole: SceneNode = {
    id: a.id, name: 'Whole arm', kind: 'arm', group: a.name, icon: 'arm',
    parts: a.joints.map((j) => ({ id: j.node, name: j.spec.key === 'gripper' ? 'Grip' : j.spec.name, icon: JOINT_ICON[j.spec.key] ?? 'lift' })), sets: armSets(a),
  }
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
  model.root.userData.contactName = id
  const joints: Joint[] = KIN.joints.map((spec) => ({ spec, node: `${id}.${spec.key}`, angle: spec.home, vel: 0, target: null, state: '', flash: 0 }))
  joints.forEach((j, i) => model.apply[i](j.angle))
  const arm: Arm = { n, id, name: `Arm ${n}`, model, joints, profile: 'both', drive: null, edge: false, state: '', homing: false, flash: 0, hw: null, hover: KIND.drive.hover[0], claw: null, track: null, cameraHand: new ArmHandInput(), cameraTrack: null, scale: KIND.drive.scale, goal: null, blocked: false, chosen: 0, jog: new Map() }
  // The procedural arm stays out of view until its Blender mesh is in (or cannot come).
  const hold = model.upgrade ? holdRig(KIND.id as ArmKindId, [model.root], { shown: () => { armInstances.set(shownRoots()); view.invalidate() } }) : null
  if (hold) holds.set(model, hold)
  arms.push(arm)
  arms.sort((a, b) => a.n - b.n)
  armInstances.set(shownRoots())
  void model.upgrade?.().then(install => {
    if (!install || !arms.some(a => a.model === model)) return hold?.fallback()
    armInstances.clear()
    if (hold) hold.install(install); else install()
    armInstances.set(shownRoots()); view.invalidate()
  }).catch(() => { hold?.fallback(); modelFailed() }) // Optional meshes must never prevent an arm from running.
  refreshNodes()
  return arm
}

async function removeArm(a: Arm) {
  if (a.hw?.live) { sim?.note(`${a.name} is live: take it off live first`); return }
  if (a.hw) await disconnect(a)
  for (const b of blocks) if (b.by === a) drop(b)
  armInstances.clear()
  holds.get(a.model)?.cancel(); holds.delete(a.model)
  a.model.dispose()
  arms.splice(arms.indexOf(a), 1)
  armInstances.set(shownRoots())
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
/** A released camera hand holds its gripper too; a tray Grip remains an independent command. */
function releaseCameraHand(a: Arm) {
  a.cameraHand.reset()
  if (a.cameraTrack) { a.cameraTrack = null; for (const j of a.joints) j.target = null }
}
/** The whole arm stops where it is (the gripper keeps what it was told). */
function settle(a: Arm) {
  a.drive = null
  a.claw = null
  a.track = null
  releaseCameraHand(a)
  if (!a.homing) for (let i = 0; i < GRIP; i++) a.joints[i].target = null
}
/** A scoped release holds only that simulated seat, including its Home and Grip targets. */
function holdSimSeat(node: string) {
  const found = findNode(node)
  if (!found || found.arm.hw) return
  if (!found.joint) { found.arm.homing = false; settle(found.arm) }
  for (const joint of found.joint ? [found.joint] : found.arm.joints) { joint.target = null; joint.vel = 0; jointInputs.delete(joint) }
}
function gripClosed(a: Arm) {
  const g = a.joints[GRIP]
  // Closed on a block, it's shut, however wide the block keeps it.
  return blocks.some((b) => b.by === a) || (g.target ?? g.angle) <= 0.5
}
function toggleGrip(a: Arm) {
  a.joints[GRIP].target = gripClosed(a) ? 1 : 0
}
function homeArm(a: Arm, by: string) {
  a.drive = null
  a.claw = null
  releaseCameraHand(a)
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
  scene.add(contactPart(mesh, `stock-${i + 1}`, { obstacle: 'stock', supports: `stock-${i + 1}`, mode: () => blocks[i].by || blocks[i].vy ? 'clear' : 'touch' }))
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
  controllers: ['face.trackpad', 'face.hand', 'face.wii', 'face.gamepad'],
  utilities: ['pad', 'motion.aim', 'motion.steer', 'motion.point', 'motion.track', 'touch.trackpad', 'motion.hold', 'motion.tilt', 'camera.hand'],
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
  if (!f?.joint) return 'Point: hold B to move · A picks up or drops · 3D: hold the pad and move · Camera hand: Hold to move, pinch to close'
  if (f.joint.spec.key === 'gripper') return 'Hold a finger on the pad: tilt or drag to open and close, tap to toggle'
  return 'Hold a finger on the pad: tilt or drag to move it. 1:1: turn the phone like a dial'
}

let sim: SimScene | null = null
const genericEvents = new Map<string, { presses: string[]; values: { id: string; v: number | boolean | string }[]; text: string }>()
const localArms = new Set<string>()
const eventsOf = (id: string) => { let e = genericEvents.get(id); if (!e) { e = { presses: [], values: [], text: '' }; genericEvents.set(id, e) }; return e }
/** When each participant's input last arrived: the watchdog stops what it drives 200 ms after its input goes quiet. */
const lastInput = new Map<string, number>()
const lastButtons = new Map<string, number>()
let stopped: { by: string; why: string } | null = null

/**
 * What every phone is told while the arms are stopped, as a standing line (a toast is gone in seconds, and the controls
 * would look live again): it stays until the screen resumes.
 */
function stoppedLine(): string {
  if (!stopped) return ''
  if (stopped.why) return stopped.why
  return stopped.by === 'host' ? 'The screen stopped the arms: it resumes them there' : `${sim?.nameOf(stopped.by) ?? 'A phone'} stopped the arms: the screen resumes them`
}
function tellStopped(id: string) { sim?.notice(id, stoppedLine()) }

function estop(by: string, why = '') {
  if (stopped) return
  stopped = { by, why }
  // A live arm's driver stops it where it is, and liveStep sends it nothing more: a goal already sent would be carried out.
  for (const a of arms) { a.homing = false; a.drive = null; a.claw = null; a.track = null; a.cameraTrack = null; a.cameraHand.stop(); for (const j of a.joints) j.target = null; if (a.hw?.live) void holdDriver(a.hw.driver) }
  document.body.classList.add('stopped')
  const who = sim?.nameOf(by) ?? 'The screen'
  $('stop-by').textContent = why || `Stopped by ${who}`
  const live = arms.filter((a) => a.hw?.live).length
  sim?.log(`${why || `Stopped by ${who}`}: every arm halted${live ? ', real arms holding where they are' : ''}`, '#fb7185')
  // The phones feel it; the standing line (tellStopped) says it and stays until the screen resumes, so no toast repeats it.
  for (const p of sim?.remote.participants ?? []) sim?.remote.feedback({ haptic: 'bump' }, p.id)
  for (const p of sim?.remote.participants ?? []) tellStopped(p.id)
  renderPanel()
}
function resume() {
  if (!stopped) return
  stopped = null
  for (const p of sim?.remote.participants ?? []) tellStopped(p.id)
  document.body.classList.remove('stopped')
  for (const a of arms) {
    if (!a.hw) continue
    a.hw.lagSince = 0
    // The arm held where it was, and its twin braked somewhere else: start again from the arm, so resuming never jumps it.
    const r = a.hw.live ? reported(a.hw) : null
    if (r) startFrom(a, fromRaw(a.hw.cal, r.raw))
  }
  sim?.log('Resumed from the screen')
  renderPanel()
}

for (let i = 0; i < 2; i++) addArm()

const xrDrives = new Map<string, { pad: PadState; at: number }>()
const rides = () => arms.map(a => armRide(a.id, a.name, a.model.root, a.model.grasp, KIND.drive.reach[1], KIND.drive.height[1]))
const droppedBlocks = new Map<string, Block>()
const shared = new SharedPresence({
  sim: 'arm', hardwareLive: () => arms.some(a => !!a.hw?.live),
  seatSafe: seat => !arms.find(a => a.id === seat || a.joints.some(j => j.node === seat))?.hw,
  seatInput(who, seat, input) {
    const found = findNode(seat)
    if (!sim || !found || found.arm.hw || stopped || sim.claims.holder(seat) !== who) return
    if (!input.pad) { xrDrives.delete(who); lastInput.delete(who); return }
    if (!found.joint) xrDrives.set(who, { pad: { ...input.pad, triggers: [0, 0] }, at: performance.now() })
    lastInput.set(who, performance.now())
  },
  placeDrop(object, at) {
    if (arms.some(a => !!a.hw?.live)) return null
    const r = object.radius, mesh = object.kind === 'ball' ? new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), plastic('#79b9be')) : box(r * 2, r * 2, r * 2, plastic('#79b9be'), .004)
    mesh.position.set(...at); mesh.castShadow = mesh.receiveShadow = true
    const block: Block = { mesh, half: [r, r, r], mass: .12, by: null, vy: 0, grip: 0 }
    blocks.push(block); scene.add(contactPart(mesh, `drop-${crypto.randomUUID()}`, { obstacle: 'stock', mode: () => block.by || block.vy ? 'clear' : 'touch' }))
    const body = shared.world.add('block', at, r, { read: () => mesh.getWorldPosition(new THREE.Vector3()).toArray(), write: (p, v) => { if (!block.by) { mesh.position.set(...p); block.vy = v[1] } }, busy: () => !!block.by || arms.some(a => !!a.hw?.live) })
    body.kind = object.kind; body.rendered = true; body.guestOnly = true
    droppedBlocks.set(body.id, block)
    return body
  },
  removeDrop(id) {
    const block = droppedBlocks.get(id)
    if (!block) return
    if (block.by) drop(block)
    const index = blocks.indexOf(block); if (index >= 0) blocks.splice(index, 1)
    block.mesh.removeFromParent(); block.mesh.geometry.dispose(); (block.mesh.material as THREE.Material).dispose(); droppedBlocks.delete(id)
  },
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
const localControls = shared.guest ? null : new LocalControls({
  id: `arm:${KIND.id}`, canvas: renderer.domElement, units: () => arms.map(a => ({ id: a.id, name: a.name })), tray: layout.tray,
  phone: () => document.getElementById('chip-invite')?.click(),
  controllerWindow: () => { if (sim?.remote.pairingUrl) window.open(sim.remote.pairingUrl, '_blank', 'noopener') },
  hardware: () => arms.some(a => !!a.hw?.live), orbit: enabled => { controls.enabled = enabled && !view.presence?.immersive },
})
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
  focused: () => { renderReadouts(); view.invalidate() },
  // A phone that comes in while the arms are stopped is told so too.
  joined: (p) => { if (stopped) tellStopped(p.id) },
}).then((s) => {
  sim = s
  shared.connect(s.remote)
  s.remote.on('input', (who) => lastInput.set(who.id, performance.now()))
  s.remote.on('value', (v, who) => eventsOf(who.id).values.push(v))
  s.remote.on('text', (v, who) => { eventsOf(who.id).text += v.s })
  s.remote.on('button', ({ id, ev }, who) => {
    if (ev === 'tap' || ev === 'down') eventsOf(who.id).presses.push(id)
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
    if (a) { a.track = null; a.drive = null; releaseCameraHand(a) }
  })
  s.remote.on('leave', (p) => { xrDrives.delete(p.id); dropAim(p.id); renderPanel() })
  s.remote.on('sim', (m, who) => {
    if (m.kind !== 'seat' || !who.simSeat) return
    const found = findNode(who.simSeat), action = (m.data as { action?: string }).action
    if (!found || found.arm.hw || s.claims.holder(who.simSeat) !== who.id) return
    // Scoped guests can hold their simulated arm, but never reach the global hardware stop/resume channel.
    if (action === 'estop') { holdSimSeat(who.simSeat); xrDrives.delete(who.id); return }
    if (stopped) return
    if (action === 'home') { if (found.joint) found.joint.target = found.joint.spec.home; else homeArm(found.arm, who.id) }
    if (action === 'grip' && (!found.joint || found.joint.spec.key === 'gripper')) toggleGrip(found.arm)
  })
  s.remote.on('role', p => {
    xrDrives.delete(p.id); lastInput.delete(p.id); lastButtons.delete(p.id); genericEvents.delete(p.id); dropAim(p.id)
    if (p.role === 'watch' && arms.some(a => a.hw?.live)) estop('host', 'Control handed over')
    if (p.releasedSeat) holdSimSeat(p.releasedSeat)
  })
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
quickAction({ id: 'stop', group: 'page', label: 'Stop', icon: 'stop', hint: 'Stop every arm', run: () => estop('host') })
// A live arm never runs unwatched: the screen going to the background stops everything.
document.addEventListener('visibilitychange', () => { if (document.hidden && arms.some((a) => a.hw?.live)) estop('host', 'The screen went to the background') })
addEventListener('beforeunload', (e) => { if (arms.some((a) => a.hw?.live)) e.preventDefault() })
// Nor does the page reload itself for an update (src/ui/recover.ts) while one is live.
holdReload(() => arms.some((a) => a.hw?.live))

// ---- driving one joint: deadman, velocity from the input, then the caps ----

const twistOf = (q: Quat) => 2 * Math.atan2(q[2], q[3]) * R2D
/**
 * Where a 1:1 turn (or a calibrated aim) started for a participant's joint: the joint's value then, and the phone's
 * twist and aim. A joint newly chosen mid-turn starts from where it is, and the turn carries on from where the phone is.
 */
const dialBase = new Map<string, { grab: number; node: string; angle: number; twist: number; aim: number }>()

/**
 * How a finger drives one joint (PROTOCOL §3a): alone ('solo': a drag whichever way), or as the k-th of a set (0 a
 * drag across, 1 up and down, 2 two fingers up and down, 3 two fingers across).
 */
type Slot = 'solo' | 0 | 1 | 2 | 3

/**
 * Which way a joint turns for the finger: the gripper goes right on the screen for a drag right, and up for a drag up
 * ([across, up], each ±1). Worked out when the finger goes down and kept until it lifts, so nothing flips mid-drag.
 */
function jogSigns(a: Arm, j: Joint, who: string): [number, number] {
  const kept = a.jog.get(j.node)
  if (kept) return kept
  const i = a.joints.indexOf(j)
  let signs: [number, number] = [1, 1]
  if (i < GRIP) {
    const pose = poseOf(a), key = KIN.keys[i]
    const at = toolWorld(a, KIN.forward(pose))
    const moved = toolWorld(a, KIN.forward({ ...pose, [key]: pose[key] + (j.spec.unit === 'm' ? 0.004 : 1) })).sub(at)
    const across = moved.dot(controlFrame(who).right), up = moved.y
    const sx = Math.abs(across) > 1e-5 ? Math.sign(across) : 1
    signs = [sx, Math.abs(up) > 1e-5 ? Math.sign(up) : sx]
  }
  a.jog.set(j.node, signs)
  return signs
}

/**
 * The velocity a participant commands for a joint this frame (units/s), or null when its deadman is released. `slot`:
 * how the finger reaches it (a joint held as a node of its own is 'solo'). `chosen`: picked on the phone's strip, where
 * a calibrated aim moves it on from where it was rather than to where the aim points.
 */
function commanded(a: Arm, j: Joint, who: string, f: Frame, pad: PadState | null, dt: number, slot: Slot = 'solo', chosen = false): number | null {
  const span = j.spec.max - j.spec.min
  if (sim?.control.scope(who) === 'scene') return null
  if (!pad && f.hand) return null // Camera hands drive a claimed whole arm, never a separately held joint.
  const space = sim?.control.aim(who)
  // A degree of the phone's turn: a degree, 1/6 cm of a joint that slides, 1/120 of the gripper's opening.
  const scale = j.spec.unit === '°' ? 1 : j.spec.unit === 'm' ? 1 / 600 : 1 / 120
  const dial = (twist: number, aim: number) => {
    const b = dialBase.get(who)
    if (!b || b.grab !== f.grab || b.node !== j.node) dialBase.set(who, { grab: f.grab, node: j.node, angle: j.angle, twist, aim })
    return dialBase.get(who)!
  }
  if (!pad && space && f.clutch && f.mode === Mode.hold) {
    // Of a set, the first joint follows the turn; the others hold.
    if (slot !== 'solo' && slot !== 0) return null
    if (!chosen) { j.target = j.spec.min + (space.aim[0] + 1) * span / 2; return 0 }
    const b = dial(0, space.aim[0])
    j.target = clamp(b.angle + (space.aim[0] - b.aim) * span / 2, j.spec.min, j.spec.max)
    return 0
  }
  if (pad) {
    // Gamepad: a deflected stick is its own deadman; the triggers work the gripper.
    const x = Math.abs(pad.axes[0]) > 0.12 ? pad.axes[0] : Math.abs(pad.axes[2]) > 0.12 ? pad.axes[2] : 0
    const t = (pad.triggers[1] ?? 0) - (pad.triggers[0] ?? 0)
    if (j.spec.key === 'gripper' && Math.abs(t) > 0.05) return -t * j.spec.vmax
    return x ? x * j.spec.vmax : null
  }
  // 1:1: turn the phone like a dial while the gyro is on; the joint follows the phone's twist from where it was.
  if (f.mode === Mode.hold && f.clutch) {
    if (slot !== 'solo' && slot !== 0) return null
    const b = dial(twistOf(f.qRel), 0)
    j.target = clamp(b.angle + (twistOf(f.qRel) - b.twist) * scale, j.spec.min, j.spec.max)
    return 0
  }
  if (dialBase.get(who)?.node === j.node) dialBase.delete(who)
  if (!f.touching) return null
  // A finger on the pad is the deadman. Tilting drives the joint at a speed, the way the phone tips.
  const [sx, sy] = jogSigns(a, j, who)
  const tilt = f.mode === Mode.tilt ? (slot === 'solo' ? f.tilt[0] * sx - f.tilt[1] * sy : slot === 0 ? f.tilt[0] * sx : slot === 1 ? -f.tilt[1] * sy : 0) : 0
  if (Math.abs(tilt) > 0.02) { j.target = null; return clamp(tilt, -1, 1) * j.spec.vmax }
  // Dragging moves it on as far as the finger went (its target leads, and it follows within its caps), the way the
  // finger goes on the screen: however the finger's moves arrive, the joint goes the whole way.
  let px = slot === 'solo' ? f.pad1[0] * sx - f.pad1[1] * sy : slot === 0 ? f.pad1[0] * sx : slot === 1 ? -f.pad1[1] * sy : slot === 2 ? -f.pad2[1] * sy : f.pad2[0] * sx
  // A pinch opens and closes the gripper.
  if (slot === 'solo' && j.spec.key === 'gripper') px += f.zoom * 540
  if (px) j.target = clamp((j.target ?? j.angle) + px * span / 900, j.spec.min, j.spec.max)
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
  if (!pad && f.hand) return driveCameraHand(a, who, f)
  releaseCameraHand(a)
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
const handCursors = new Map<string, HandCursor>()
function readInputs(now: number, dt: number) {
  frames.clear()
  const s = sim
  if (!s) return
  for (const [id, cursor] of handCursors) if (!s.remote.participants.some(p => p.id === id)) { cursor.el.remove(); handCursors.delete(id) }
  for (const p of s.remote.participants) {
    const f = s.remote.consumeOf(p.id, now)
    const native = layout.controllers ?? []
    if (!native.includes(p.controller ?? 'face.trackpad') || f.body || eventsOf(p.id).text || eventsOf(p.id).presses.some(id => id.startsWith('key-'))) {
      const raw = { ...restInput(p.controller, f.mode), pad: f.mode === Mode.gamepad ? s.remote.padOf(p.id) : null, touching: f.touching, drag: f.pad1, pan: f.pad2, pinch: f.zoom, twist: f.twist, tilt: f.tilt, hold: f.clutch ? f.qRel : null,
        point: f.mode === Mode.point ? { x: innerWidth / 2, y: innerHeight / 2, yaw: -f.aim[0], pitch: f.aim[1], off: false } : null,
        held: aims.get(p.id)?.b ? new Set(['wii-b']) : new Set<string>(), pose: f.pose, hand: f.hand, body: f.body, space: s.control.aim(p.id) ?? undefined, ...eventsOf(p.id) }
      const mapped = mapFaceInput('arm', native, raw, dt)
      if (mapped.pad && now - (lastInput.get(p.id) ?? 0) < 200) xrDrives.set(p.id, { pad: mapped.pad, at: now })
    }
    genericEvents.delete(p.id)
    if (f.hand || handCursors.has(p.id)) {
      let cursor = handCursors.get(p.id)
      if (!cursor) {
        const el = document.createElement('div'); el.style.setProperty('--accent', p.color); document.body.append(el)
        cursor = new HandCursor(el); handCursors.set(p.id, cursor)
      }
      cursor.step(f.connected ? f.hand : null, now)
    }
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
const glowContent = document.createElement('div'); glowContent.className = 'panel-feed kit-brackets'
const glowNote = document.createElement('p'); glowNote.className = 'feed-caption'; glowNote.textContent = 'Turn on camera tracking in Controls.'
glowContent.append(glowView, glowNote)
const glowPanel = panels.add(glowContent, { id: 'tracking-camera', title: 'Phone tracking camera', purpose: 'Camera tracking for glowing phones', icon: 'camera', anchor: 'camera', state: 'closed', camera: true })
follower.onUnseen = (id) => sim?.remote.feedback({ haptic: 'bump', toast: 'The camera can’t see your glow: turn the screen toward it' }, id)
follower.onCameraOff = () => sim?.note('A phone is glowing: turn on “Follow glowing phones with this camera”')

$('glow-cam').onclick = async () => {
  if (follower.cam.on) follower.cam.stop()
  else {
    try { await follower.cam.start(); sim?.note('Hold glowing phones toward the camera') } catch { sim?.note('The camera didn’t start: allow it for this page') }
  }
  $('glow-cam').setAttribute('aria-pressed', String(follower.cam.on))
  glowView.hidden = !follower.cam.on
  glowNote.hidden = follower.cam.on
  if (follower.cam.on) { glowPanel.notify(); glowPanel.setState('open') }
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

/** The approved holder's camera hand follows the same tool solver and limits as 3D, while its deadman is held. */
function driveCameraHand(a: Arm, who: string, f: Frame): string {
  const move = a.cameraHand.step(f.hand, f.connected && f.touching && !!sim?.allowed(who), who)
  if (!move) { settle(a); return 'deadman' }
  a.homing = false; a.drive = null; a.claw = null; a.track = null
  if (move.started || !a.cameraTrack) {
    const tool = KIN.forward(poseOf(a))
    a.cameraTrack = { tool: toolWorld(a, tool), delta: new THREE.Vector3(), pitch: tool.pitch, roll: tool.roll }
  }
  const k = a.cameraTrack
  const frame = controlFrame(who)
  const delta = k.delta.clone().addScaledVector(frame.right, move.delta[0] * a.scale).addScaledVector(UP, move.delta[1] * a.scale).addScaledVector(frame.forward, -move.delta[2] * a.scale)
  const local = a.model.root.worldToLocal(k.tool.clone().add(delta))
  const turn = handTurn([0, 0, 0, 1], move.rotation, 0)
  const current = poseOf(a), want = Math.atan2(local.z, -local.x) * R2D
  const goal: ToolTarget = {
    yaw: KIN.heading(want, current), reach: Math.max(KIND.drive.reach[0], Math.hypot(local.x, local.z)),
    height: Math.max(CLAW_LOW, local.y), pitch: clamp(k.pitch - turn.tip, ...KIN.pitchRange), roll: clamp(k.roll + turn.twist, ...KIN.rollRange),
  }
  const solved = solveNear(KIN, goal, 60, heldBox(a), current)
  if (solved) { setPose(a, solved.pose); k.delta.copy(delta) }
  a.joints[GRIP].target = move.pinch ? 0 : 1
  a.goal = goal
  const ok = !!solved && turnBetween(goal.yaw, want) < 1e-6
  if (!ok && !a.edge) sim?.remote.feedback({ haptic: 'bump' }, who)
  a.edge = !ok
  view.presence?.motionControl(true)
  return ok ? '' : 'edge'
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
    a.track = { gen: pose.gen, p0: [...pose.p], q0: [...pose.q], heading: headingOf(pose.q), tool: toolWorld(a, t), delta: new THREE.Vector3(), forward: 0, pitch: t.pitch, roll: t.roll, space: null }
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
    const target = { ...workspace(a, who, [space.aim[0], 0]), height: armHeight(space.aim[1], KIND.drive.height) }
    // Calibrated motion shares the pose's grab anchor. Moving the released phone must not retarget the tool.
    k.space ??= { origin: target, tool: KIN.forward(current) }
    const origin = k.space.origin, tool = k.space.tool
    goal.yaw = KIN.heading(tool.yaw + ((target.yaw - origin.yaw + 540) % 360) - 180, current)
    goal.height = Math.max(CLAW_LOW, tool.height + target.height - origin.height)
    k.forward += m.forward
    goal.reach = clamp(tool.reach + target.reach - origin.reach + k.forward * (KIND.drive.reach[1] - KIND.drive.reach[0]) / 0.3, ...KIND.drive.reach)
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
  const armWho = s?.claims.holder(a.id) ?? (localArms.has(a.id) ? `local:${a.id}` : undefined)
  // What the holder's node strip chose (PROTOCOL §3a): on the trackpad, the one finger drives those joints, the rest hold.
  const focus = armWho && armWho !== 'host' && s ? s.focus.of(armWho) : null
  const frame = focus ? frames.get(armWho!) : undefined
  const onPad = !!frame && !frame.hand && !s?.remote.padOf(armWho!) && (frame.mode === Mode.hold || frame.mode === Mode.tilt || frame.mode === Mode.orbit)
  const chosen = onPad && focus!.parts.length ? focus!.parts : null
  if (focus && focus.serial !== a.chosen) {
    // A new choice starts from where the arm is: no drive, dial or jog carried over; the newly chosen joints' rings flare.
    a.chosen = focus.serial
    settle(a)
    a.jog.clear()
    dialBase.delete(armWho!)
    for (const j of a.joints) if (focus.parts.includes(j.node)) j.flash = 1
  }
  a.state = ''
  if (stopped || mirror || !armWho || armWho === 'host' && !xrDrives.has(armWho) || !s) { a.drive = null; releaseCameraHand(a); if (!armWho) a.edge = false }
  else if (chosen) { a.drive = null; a.claw = null; a.track = null; releaseCameraHand(a); if (now - (lastInput.get(armWho) ?? 0) > 200) a.state = 'watchdog' }
  else {
    a.state = driveWhole(a, armWho, now, dt)
    // Locked joints hold where they are while the rest of the arm moves.
    if (onPad && focus?.locks.size && !a.homing) for (const j of a.joints) if (focus.locks.has(j.node)) j.target = null
  }
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
    } else if (chosen && s && armWho) {
      // Chosen on the strip: the k-th of a set takes its gesture, one alone takes the drag either way; the rest hold.
      const k = chosen.indexOf(j.node)
      const f = frame!
      if (!f.touching) a.jog.delete(j.node)
      if (a.state === 'watchdog') { j.state = 'watchdog'; if (!a.homing) j.target = null }
      else if (k < 0 || focus!.locks.has(j.node)) { j.state = focus!.locks.has(j.node) ? 'locked' : 'held'; if (!a.homing && j.spec.key !== 'gripper') j.target = null }
      else {
        const c = commanded(a, j, armWho, f, null, dt, chosen.length === 1 ? 'solo' : (Math.min(k, 3) as 0 | 1 | 2 | 3), true)
        if (c === null) { j.state = 'deadman'; if (!a.homing && j.spec.key !== 'gripper') j.target = null } else v = c
      }
    } else if (armWho && armWho !== 'host') j.state = focus?.locks.has(j.node) && onPad ? 'locked' : a.state
    else if (who && who !== 'host' && s) {
      if (now - (lastInput.get(who) ?? 0) > 200) { j.state = 'watchdog'; if (!a.homing) j.target = null } else {
        const f = frames.get(who) ?? s.remote.consumeOf(who, now)
        if (!f.touching) a.jog.delete(j.node)
        const c = commanded(a, j, who, f, !hw && s.remote.participants.find(p => p.id === who)?.simSeat === j.node ? s.remote.simPadOf(who, now) : s.remote.padOf(who), dt)
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
    // Acceleration cap; a Stop brakes four times harder.
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
  // Rings wear their controller's colour, and flash when control changes. While the holder's trackpad drives what its
  // strip chose, those joints breathe in it, the others dim, and a locked one goes grey (PROTOCOL §3a): the switch
  // shows on the model too.
  const live = chosen
  a.joints.forEach((j, i) => paint(a.model.rings[i], s?.claims.controller(j.node), j, dt, Math.abs(j.vel) > 1e-3,
    onPad && focus?.locks.has(j.node) ? 'locked' : live ? (live.includes(j.node) ? 'live' : 'idle') : ''))
  paint(a.model.plate, armWho, a, dt, false)
  if (live) view.invalidate()
  if (hw?.live) liveStep(a, now)
}

function paint(ring: THREE.Mesh, who: string | undefined, o: { flash: number }, dt: number, moving: boolean, focus: '' | 'live' | 'idle' | 'locked' = '') {
  const mat = ring.material as THREE.MeshStandardMaterial
  const idle = ring.userData.idleColor ?? '#5b6472'
  mat.emissive.set(who && focus !== 'locked' ? sim!.colorOf(who) || idle : idle)
  o.flash = Math.max(0, o.flash - dt / 0.7)
  const breath = focus === 'live' ? 0.5 + 0.5 * Math.sin(performance.now() * 0.0032) : 0
  const lit = !who ? 0.25 : focus === 'live' ? 2.2 + 1.1 * breath : focus === 'idle' ? 0.55 : focus === 'locked' ? 0.35 : 1.4
  mat.emissiveIntensity = lit + 2.2 * o.flash + (moving ? 0.6 : 0)
  ring.scale.setScalar(1 + 0.25 * o.flash + 0.06 * breath)
}

let last = 0
function loop(now: number) {
  const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
  last = now
  if (!shared.guest) {
    readInputs(now, dt)
    const localFrames = localControls?.frames(n => {
      const a = arms[n]
      return !a || !!sim?.claims.holder(a.id) && sim.claims.holder(a.id) !== 'host' || a.joints.some(j => { const who = sim?.claims.holder(j.node); return !!who && who !== 'host' })
    }, dt) ?? new Map()
    for (const id of [...localArms]) if (![...localFrames.keys()].some(n => arms[n]?.id === id)) {
      const a = arms.find(a => a.id === id); if (a) settle(a)
      localArms.delete(id); xrDrives.delete(`local:${id}`); lastInput.delete(`local:${id}`)
    }
    for (const [n, input] of localFrames) {
      const a = arms[n]
      if (!a || !input.pad || !sim) continue
      const who = `local:${a.id}`
      localArms.add(a.id); xrDrives.set(who, { pad: input.pad, at: now }); lastInput.set(who, now)
      if (input.presses.includes('estop')) estop(who)
      if (input.presses.includes('home') || input.padPressed & (1 << PadButton.Guide)) homeArm(a, who)
      if (input.presses.includes('grip')) toggleGrip(a)
    }
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

/** How old an arm's report can be, in ms, and still count as where it is: past it the arm is silent. */
const REPORT_MS = 1200

/**
 * While live: stop everything if the arm stops reporting or can't keep up, otherwise copy the twin to the arm. Once
 * stopped it sends nothing: the driver was told to hold, and any goal after that would aim the arm away again.
 */
function liveStep(a: Arm, now: number) {
  if (stopped) return
  const hw = a.hw!
  if (hw.driver.feedback === 'measured') {
    const r = hw.driver.read()
    if (!r || now - r.at > REPORT_MS) {
      if (now - hw.since > 2000) { estop('host', `${a.name} stopped reporting where it is`); return }
    } else {
      const got = fromRaw(hw.cal, r.raw.map((v) => v ?? NaN))
      let off = 0
      for (let i = 0; i < GRIP; i++) if (Number.isFinite(got[i])) off = Math.max(off, Math.abs(got[i] - a.joints[i].angle))
      if (off <= 12) hw.lagSince = 0
      else {
        hw.lagSince ||= now
        if (now - hw.lagSince > 600) { estop('host', `${a.name} isn’t keeping up (${Math.round(off)}° off): check for something in its way`); return }
      }
    }
  }
  hw.driver.send(toRaw(hw.cal, a.joints.map((j) => j.angle)))
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
    if (wasLive) {
      // The arm is no longer on the arm's list, so estop can't reach its driver: tell it here, in case the link still carries it.
      void holdDriver(driver)
      estop('host', `${a.name} lost its connection: ${why}`)
    }
    renderPanel()
  }
  sim?.log(`The screen connected ${a.name} to ${driver.label}: the twin follows it`)
  renderPanel()
}

/** Tell a driver to stop where its arm is. A failing link mustn't get in the way of a stop, so nothing it throws gets out. */
function holdDriver(driver: ArmDriver): Promise<void> {
  try { return Promise.resolve(driver.hold?.()).catch(() => {}) } catch { return Promise.resolve() }
}

async function disconnect(a: Arm) {
  const hw = a.hw
  if (!hw) return
  const wasLive = hw.live
  if (wasLive) {
    // Stop sending, then let the hold out before the link closes (a link that hangs doesn't hold this up for long).
    hw.live = false
    await Promise.race([holdDriver(hw.driver), new Promise((resolve) => setTimeout(resolve, 400))])
  }
  a.hw = null
  await hw.driver.close().catch(() => {})
  sim?.log(`The screen disconnected ${a.name}${wasLive ? ' while live: it holds where it is' : ''}`)
  renderPanel()
}

/** The arm's latest report when it has a value for every joint and isn't stale. */
function reported(hw: Hardware): { raw: number[]; at: number } | null {
  const r = hw.driver.read()
  return r && r.raw.every((v) => v !== null) && performance.now() - r.at <= REPORT_MS ? { raw: r.raw as number[], at: r.at } : null
}

/** Put the twin where the arm is, at rest and aimed at nothing. */
function startFrom(a: Arm, angles: number[]) {
  a.joints.forEach((j, i) => { j.angle = clamp(angles[i], j.spec.min, j.spec.max); j.vel = 0; j.target = null })
}

async function goLive(a: Arm, cap: number) {
  const hw = a.hw
  if (!hw || hw.live) return
  if (stopped) { sim?.note(`${a.name} can’t go live while everything is stopped: resume first`); return }
  if (sim?.waived()) { sim.note(`${a.name} can’t go live while everyone is let in without asking: switch that off first`); return }
  const r = hw.driver.read()
  if (!r || r.raw.some((v) => v === null)) { sim?.note(`${a.name} hasn’t reported every joint yet`); return }
  if (performance.now() - r.at > REPORT_MS) { sim?.note(`${a.name} isn’t reporting where it is right now`); return }
  const angles = fromRaw(hw.cal, r.raw as number[])
  const out = firstOutOfLimits(KIN.joints, angles)
  if (out >= 0) { sim?.note(`${a.name}’s ${KIN.joints[out].name.toLowerCase()} reads outside its limits: calibrate it first`); return }
  // Start from where the arm is, so going live never jumps.
  startFrom(a, angles)
  await hw.driver.torque(true)
  // Something happened while the arm took the torque: it was disconnected, lost, or everything was stopped.
  if (a.hw !== hw || stopped) return
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
  void holdDriver(a.hw.driver)
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
  dials.clear(); reaches.clear()
  for (const child of [...$('arms').children]) {
    const id = (child as HTMLElement).dataset.panel!
    if (!arms.some(a => `arm-${a.id}` === id)) panels.remove(id)
  }
  arms.forEach((a, n) => {
    const p = panels.add(armCard(a, held), { id: `arm-${a.id}`, title: a.name, purpose: 'Joint positions, control profile and hardware settings', icon: 'arm', anchor: 'arm', index: n })
    $('arms').append(p.element)
  })
  $('add-arm').hidden = arms.length >= MAX_ARMS
  const live = arms.filter((a) => a.hw?.live).length
  // Approval can't be waived while a real arm is live: a stranger let in unasked would be steering hardware.
  sim?.holdApproval(live > 0)
  const connected = arms.filter((a) => a.hw).length
  const badge = $('sim-badge')
  badge.textContent = live ? `${live} real arm${live > 1 ? 's' : ''} live` : connected ? `Twin of ${connected} real arm${connected > 1 ? 's' : ''}` : 'Simulated · no hardware connected'
  badge.classList.toggle('live', live > 0)
  renderReadouts()
  disableGuestPanel()
}

function disableGuestPanel() {
  if (view.presence?.shared?.guest) document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('.sim-panel button, .sim-panel input, .sim-panel select, .arm button, .arm input, .arm select').forEach(e => { if (!e.closest('.presence-controls, .sim-sound')) e.disabled = true })
}

function takeBack(node: string) { sim?.take(node, 'host', true); sim?.release('host') }

function holderText(who: string | undefined, via?: string) {
  if (!who) return 'Free'
  return via ? `${sim!.nameOf(who)}, with ${via}` : sim!.nameOf(who)
}

/** A joint's position as its readout shows it: degrees, centimetres (the readout adds the unit), or open percent. */
function jointText(spec: JointSpec, v: number) {
  return spec.unit === '°' ? `${Math.round(v)}°` : spec.unit === 'm' ? `${Math.round(v * 100)}` : `${Math.round(v * 100)}%`
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
  hwBtn.textContent = hw ? 'Hardware' : 'Connect a real arm (experimental)'
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
    li.innerHTML = '<i class="dot"></i><span class="nn"><b>Whole arm</b><small></small></span><span class="nv"></span>'
    li.querySelector('small')!.textContent = holderText(armWho)
    if (armWho) { li.classList.add('held'); li.style.setProperty('--c', sim!.colorOf(armWho)) }
    // Where the gripper is (reach and height, as an instrument), and how far out it reaches as a capsule.
    const readout = new Telemetry(''), reach = new CapsuleGauge({ label: `${a.name} reach`, value: 0 })
    reach.el.classList.add('arm-reach')
    li.querySelector('.nv')!.append(readout.el)
    li.append(reach.el)
    reaches.set(a.id, { readout, reach })
    if (armWho) li.appendChild(xButton(() => takeBack(a.id)))
    sec.querySelector('.arm-nodes')!.appendChild(li)
  }
  if (a.profile !== 'arm') {
    sec.querySelector('.jgrid')!.replaceChildren(...a.joints.map((j) => {
      const li = document.createElement('li')
      li.dataset.node = j.node
      const who = held[j.node] ?? armWho
      // A dial (a ring of dots lit across the joint's range) beside its position in dot-matrix, and its name.
      const dial = new RingGauge({ label: j.spec.name, value: j.angle, min: j.spec.min, max: j.spec.max, kind: 'dots', dots: 17, size: 40, thickness: 3.4, format: (v) => jointText(j.spec, v) })
      const angle = new Readout({ value: jointText(j.spec, j.angle), pitch: 2.4, unit: j.spec.unit === 'm' ? 'cm' : undefined })
      angle.el.setAttribute('aria-hidden', 'true')
      dials.set(j.node, { dial, angle })
      li.innerHTML = '<i class="dot"></i><b></b>'
      li.prepend(dial.el, angle.el)
      li.querySelector('b')!.textContent = j.spec.name
      li.title = holderText(who, held[j.node] ? undefined : armWho ? 'the whole arm' : undefined)
      if (who) { li.classList.add('held'); li.style.setProperty('--c', sim!.colorOf(who)) }
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
  if (sim) syncActionState(sim.remote, who => {
    const node = sim!.claims.held(who), f = node ? findNode(node) : null
    return { 'action.grip': !!f && gripClosed(f.arm) }
  })
  for (const a of arms) {
    // The joints its holder's strip drives, and those locked, marked in the grid as on the model.
    const armWho = sim?.claims.holder(a.id)
    const focus = armWho && armWho !== 'host' ? sim!.focus.of(armWho) : null
    const row = document.querySelector<HTMLElement>(`#arms li[data-node="${a.id}"]`)
    const whole = reaches.get(a.id)
    if (row && whole) {
      const t = KIN.forward(poseOf(a))
      const [near, far] = KIND.drive.reach
      whole.readout.value = `${Math.round(t.reach * 100)} cm · ${Math.round(t.height * 100)} up`
      whole.reach.value = clamp((t.reach - near) / (far - near), 0, 1)
      row.dataset.state = a.state || (a.hw && !a.hw.live ? 'mirror' : stopped ? 'stopped' : '')
    }
    for (const j of a.joints) {
      const li = document.querySelector<HTMLElement>(`#arms li[data-node="${j.node}"]`)
      if (!li) continue
      const shown = dials.get(j.node)
      if (shown && shown.dial.value !== j.angle) { shown.dial.value = j.angle; shown.angle.value = jointText(j.spec, j.angle) }
      li.dataset.state = j.state
      li.classList.toggle('live', !!focus?.parts.includes(j.node) && !focus.locks.has(j.node))
      li.classList.toggle('locked', !!focus?.locks.has(j.node))
    }
  }
}

/** Centre the stage in the space beside the panel (wide screens) or above it (narrow). */
let overview = false
function resize() {
  const w = view.width
  const h = view.height
  camera.aspect = w / h
  const control = panels.get('controls')!, panel = control.placement.rect
  const left = control.visible && panel.x < 80 && panel.w < w / 2 ? panel.x + panel.w : 0
  if (left) camera.setViewOffset(w, h, -left / 2, 0, w, h)
  else camera.clearViewOffset()
  placeLoading(w / 2 + left / 2)
  const free = Math.min(w - left, h - 90)
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
/** Familiar view actions share their spoken name with the glass tooltip. */
function viewAction(label: string, glyph: string) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'kit-action'
  iconAction(b, glyph, label)
  $('arm-view').append(b)
  return b
}
const resetView = viewAction('Reset view', 'center')
resetView.onclick = () => { overview = false; resize() }
const inspectArm = viewAction('Inspect arm', 'zoom-in')
const overviewView = viewAction('Overview', 'orbit')
overviewView.onclick = () => { overview = true; resize() }
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
// The quick-actions tray: its camera steps through the same framings and first person (the viewpoint row's own
// button; on a phone, right after the play view), a framing bringing the scene back from first person first; its reset
// sends every arm home.
const framed = (button: HTMLButtonElement) => () => { const e = view.presence; if (e?.immersive) void e.leave().then(() => button.click()); else button.click() }
quickViews([
  { name: 'Play view', show: framed(resetView) },
  { name: 'Overview', show: framed(overviewView) },
  { name: 'Close-up', show: framed(inspectArm) },
  { name: 'First person', show: () => document.querySelector<HTMLButtonElement>('.presence-controls .presence-enter')?.click(), current: () => view.presence?.mode === 'first-person', phone: true },
])
if (!view.presence?.shared?.guest) quickAction({ id: 'reset', group: 'page', label: 'Reset', hint: 'Every arm home', icon: 'reset', run: () => $('home-all').click() })
resize()
renderPanel()
renderer.setAnimationLoop(loop)
disableGuestPanel()

Object.assign(window, {
  __arm: {
    arms: () => arms.map((a) => ({
      id: a.id, profile: a.profile, state: a.state, edge: a.edge, live: !!a.hw?.live, twin: !!a.hw, hover: a.hover, claw: a.claw?.phase ?? null, goal: a.goal, anchor: a.track ? { p0: a.track.p0, tool: a.track.tool.y } : null,
      pose: frames.get(sim?.claims.holder(a.id) ?? '')?.pose ?? null,
      hand: frames.get(sim?.claims.holder(a.id) ?? '')?.hand ?? null, handActive: !!a.cameraTrack,
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
    kind: () => ({ id: KIND.id, keys: KIN.keys, floorHeight: KIN.toolFloor(180, 0) }),
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
    /** What the holder of an arm drives on its own from the phone's strip (tests): the choice, its joints, those locked. */
    focus: (id: string) => { const who = sim?.claims.holder(id); if (!who || !sim) return null; const f = sim.focus.of(who); return { part: f.part, parts: [...f.parts], locks: [...f.locks] } },
    addArm: () => addArm()?.id ?? null,
    removeArm: (id: string) => { const a = armOf(id); return a ? removeArm(a) : undefined },
    setProfile: (id: string, p: Profile) => { const a = armOf(id); if (a) setProfile(a, p) },
    /** Attach a driver without the port chooser (tests, and pages embedding this one with their own transport). */
    connectWith: async (id: string, driver: ArmDriver) => { const a = armOf(id); if (!a || a.hw) return false; await driver.connect(); attach(a, driver); return true },
  },
})
})
