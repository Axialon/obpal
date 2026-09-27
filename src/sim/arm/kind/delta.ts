/**
 * A delta: three motors on a plate overhead each swing an upper arm, and pairs of rods from the arms' ends carry a
 * small platform below, always level, so that the three angles place it anywhere in a dome under the plate; a fourth
 * motor turns the gripper under it. It hangs from a post behind it, out of its way. Its IK is the textbook one, each
 * arm's angle for where the platform is; where it is, from the angles, is where three spheres meet. A pose whose rods
 * can't reach (only by hand, one arm at a time) is no pose at all: its floor (`lowest`) is -Infinity, so the sim stops
 * the arm short of it. Its tool's roll is how far the fingers are turned from closing along its own x. Procedural.
 */
import * as THREE from 'three'
import { rounded } from '../../kit'
import type { Box, Stand } from '../blocks'
import { add, cross, dot, ID, len, nest, place, rotY, scale, sub, unit, type Frame } from '../frames'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W, type GripBox, type V3 } from '../grasp'
import { holdAboveFloor, lowestOf, type ArmKind, type Pose } from '../kin'
import { FLOOR_CLEAR, type ToolTarget } from '../kinematics'
import { boxOfShape, type Placed } from '../look'
import type { ArmModel, JointSpec } from '../model'
import { boxOf, fingerBoxes, FINGER_Y, GRASP_PAST_ROLL } from '../serial'
import { accent, disposeModel, dress, meshOf, plateLabel, stuffOf } from '../shapes3d'
import { turnedOver } from './scara'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** The motors' axes' height, their distance from the middle, the upper arms, the rods, the rods' feet from the platform's middle. */
const HB = 1.8
const RB = 0.1
const RF = 0.34
const RE = 1.5
const RP = 0.05
/** The platform's thickness, and how far the gripper's turning group hangs under its middle. */
const PLATE = 0.03
const HANG = 0.03
/** From the platform's middle down to the tool point. */
const TOOL = HANG + GRASP_PAST_ROLL
/** The rods of a pair stand this far either side of the arm. */
const PAIR = 0.045
/**
 * The motors' headings about the middle (degrees; 0 faces the arm's front, local −x): one under the post's arm behind
 * it, and two reaching out either side of its front, clear of a delta across the cell.
 */
const MOTORS = [60, 180, 300]
/** Where the post it hangs from stands (behind it). */
const POST = 0.85

const dirOf = (deg: number): V3 => [-Math.cos(deg * D2R), 0, Math.sin(deg * D2R)]
/** Each motor: the way its arm reaches (out from the middle), and its axis (across, flat). */
const OUT = MOTORS.map(dirOf)
const ACROSS = OUT.map((u) => unit(cross([0, 1, 0], u)))

export type DeltaPose = { a1: number; a2: number; a3: number; roll: number }
const ARMS = ['a1', 'a2', 'a3'] as const

/** Where arm `i`'s upper arm ends, at angle `deg` below level. */
function elbowOf(i: number, deg: number): V3 {
  const r = RB + RF * Math.cos(deg * D2R)
  return [OUT[i][0] * r, HB - RF * Math.sin(deg * D2R), OUT[i][2] * r]
}

/**
 * Where the platform's middle is for the arms' angles (in the delta's own terms): the lower point where the spheres
 * about the elbows (drawn in by the rods' feet) meet. Null where they don't, unless `loose`: then the point where they
 * come nearest.
 */
export function deltaPlatform(p: DeltaPose, loose = false): V3 | null {
  const C = ARMS.map((k, i) => sub(elbowOf(i, p[k]), scale(OUT[i], RP)))
  const ex = unit(sub(C[1], C[0]))
  const d = len(sub(C[1], C[0]))
  const i = dot(ex, sub(C[2], C[0]))
  const ey = unit(sub(sub(C[2], C[0]), scale(ex, i)))
  const j = dot(ey, sub(C[2], C[0]))
  const ez = cross(ex, ey)
  const x = d / 2
  const y = (i * i + j * j) / (2 * j) - (i / j) * x
  let z2 = RE * RE - x * x - y * y
  if (z2 < -1e-9 && !loose) return null
  z2 = Math.max(0, z2)
  const base = add(C[0], add(scale(ex, x), scale(ey, y)))
  const a = add(base, scale(ez, Math.sqrt(z2))), b = sub(base, scale(ez, Math.sqrt(z2)))
  return a[1] < b[1] ? a : b
}

/** Arm `i`'s angle below level (degrees) that puts the platform's middle at `e`, or null where it can't. */
function armFor(i: number, e: V3): number | null {
  const A = dot(e, OUT[i]) - (RB - RP), b = dot(e, ACROSS[i]), Z = e[1] - HB
  const K = (A * A + b * b + Z * Z + RF * RF - RE * RE) / (2 * RF)
  const rho = Math.hypot(A, Z)
  if (Math.abs(K) > rho) return null
  return (-Math.atan2(Z, A) - Math.acos(K / rho)) * R2D
}
/** The three angles for the platform at `e`, or null. */
export function deltaArms(e: V3): [number, number, number] | null {
  const a = [0, 1, 2].map((i) => armFor(i, e))
  return a.every((v) => v !== null) ? (a as [number, number, number]) : null
}

/** The home: the platform in the middle, the tool 30 cm up. */
const HOME = deltaArms([0, 0.3 + TOOL, 0])!
export const DELTA_JOINTS: JointSpec[] = [
  ...ARMS.map((key, i): JointSpec => ({ key, name: `Arm ${'ABC'[i]}`, min: -45, max: 110, home: Math.round(HOME[i] * 10) / 10, vmax: 120, amax: 500, unit: '°' })),
  { key: 'roll', name: 'Tool roll', min: -360, max: 360, home: 0, vmax: 240, amax: 800, unit: '°' },
  { key: 'gripper', name: 'Gripper', min: 0, max: 1, home: 1, vmax: 1.4, amax: 6, unit: '' },
]

type Group = 'root' | 'plate' | 'hand'
/** The parts that don't move (the post and its arm, the motors' plate), and the platform's and the gripper's. */
export const DELTA_LOOK: readonly Placed<Group>[] = [
  ['root', { cyl: [0.16, 0.18, 0.04], axis: 'y', at: [POST, 0.02, 0], stuff: 'dark' }],
  ['root', { cyl: [0.05, 0.055, HB + 0.16], axis: 'y', at: [POST, (HB + 0.16) / 2, 0], stuff: 'dark' }],
  ['root', { box: [POST, 0.07, 0.09], at: [POST / 2, HB + 0.12, 0], stuff: 'dark' }],
  ['root', { cyl: [0.2, 0.2, 0.06], axis: 'y', at: [0, HB + 0.06, 0], stuff: 'shell' }],
  ['plate', { cyl: [0.11, 0.11, PLATE], axis: 'y', at: [0, 0, 0], stuff: 'shell' }],
  ['hand', { cyl: [0.045, 0.045, 0.03], axis: 'y', at: [0, -0.005, 0], stuff: 'dark' }],
  ['hand', { box: [0.14, 0.035, 0.07], at: [0, 0.03, 0], stuff: 'shell' }],
  ['hand', { ring: [0.05, 0.008], axis: 'y', at: [0, 0.005, 0], joint: 3 }],
  ['hand', { ring: [0.03, 0.008], axis: 'y', at: [0, 0.05, 0], joint: 4 }],
]
const MOVING: readonly Group[] = ['plate', 'hand']

/** The platform's frame, the gripper's (turned over: its y points down, along the fingers) and the grasp's, in the world. */
export function deltaFrames(s: Stand, p: DeltaPose): { plate: Frame; hand: Frame; grasp: Frame } | null {
  const e = deltaPlatform(p)
  if (!e) return null
  return framesAt(s, e, p.roll)
}
function framesAt(s: Stand, e: V3, roll: number) {
  const root: Frame = { R: rotY(s.turn), t: [s.x, 0, s.z] }
  const plate = nest(root, ID, e)
  const hand = nest(plate, turnedOver(roll), [0, -HANG, 0])
  const grasp = nest(hand, ID, [0, GRASP_PAST_ROLL, 0])
  return { plate, hand, grasp }
}

/** A rod from `a` to `b` (in the world), as a box. */
function rodBox(a: V3, b: V3, r: number): Box {
  const y = unit(sub(b, a))
  const x = unit(Math.abs(y[1]) < 0.9 ? cross(y, [0, 1, 0]) : cross(y, [1, 0, 0]))
  return { c: scale(add(a, b), 0.5), axes: [x, y, cross(x, y)], half: [r, len(sub(b, a)) / 2, r] }
}
/** The rods' ends: each pair's top ends (at the elbows) and bottom ends (at the platform), in the delta's own terms. */
function rodEnds(p: DeltaPose, e: V3): [V3, V3][] {
  const out: [V3, V3][] = []
  ARMS.forEach((k, i) => {
    const top = elbowOf(i, p[k]), foot = add(e, scale(OUT[i], RP))
    for (const side of [-1, 1]) out.push([add(top, scale(ACROSS[i], side * PAIR)), add(foot, scale(ACROSS[i], side * PAIR))])
  })
  return out
}

function deltaParts(s: Stand, p: DeltaPose, open: number, held?: Box | null): Box[] {
  const e = deltaPlatform(p, true)!
  const f = framesAt(s, e, p.roll)
  const root: Frame = { R: rotY(s.turn), t: [s.x, 0, s.z] }
  const out: Box[] = []
  for (const [g, sh] of DELTA_LOOK) if (MOVING.includes(g)) out.push(boxOfShape(g === 'plate' ? f.plate : f.hand, sh))
  out.push(...fingerBoxes(f.hand, open))
  // The rods: boxed from end to end, in the world.
  for (const [a, b] of rodEnds(p, e)) out.push(rodBox(place(root, a), place(root, b), 0.011))
  if (held) out.push(boxOf(f.grasp, held))
  return out
}
const COUNT = DELTA_LOOK.filter(([g]) => MOVING.includes(g)).length
const FINGERS: [number, number] = [COUNT, COUNT + 1]
const HERE: Stand = { x: 0, z: 0, turn: 0 }

export function deltaForward(p: DeltaPose): ToolTarget {
  const e = deltaPlatform(p, true)!
  const x = e[0], z = e[2]
  return { yaw: Math.atan2(z, -x) * R2D, reach: Math.hypot(x, z), height: e[1] - TOOL, pitch: 180, roll: p.roll }
}

/** How far below the tool point the gripper, and what it holds, reach (the fingers wide open). */
function drop(roll: number, held?: GripBox | null): number {
  const f = framesAt(HERE, [0, 1, 0], roll)
  const parts = DELTA_LOOK.filter(([g]) => g === 'hand').map(([, sh]) => boxOfShape(f.hand, sh))
  parts.push(...fingerBoxes(f.hand, 1))
  if (held) parts.push(boxOf(f.grasp, held))
  return f.grasp.t[1] - lowestOf(parts)
}
export const deltaToolFloor = (roll: number, held?: GripBox | null) => FLOOR_CLEAR + drop(roll, held)

/** The middle of what it reaches: out of reach, a target is pulled toward here until it can be reached. */
const MIDDLE: V3 = [0, 0.2 + TOOL, 0]

/**
 * The pose for a tool target, holding `held`. A place the rods can't reach, or the arms can't within their limits, is
 * pulled in toward the middle of the dome until they can, and `reached` says so.
 */
export function deltaInverse(t: ToolTarget, held?: GripBox | null): { pose: DeltaPose; reached: boolean } {
  const h = Math.max(t.height, deltaToolFloor(t.roll, held))
  const want: V3 = [-t.reach * Math.cos(t.yaw * D2R), h + TOOL, t.reach * Math.sin(t.yaw * D2R)]
  const fits = (e: V3) => { const a = deltaArms(e); return a && a.every((v, i) => v >= DELTA_JOINTS[i].min && v <= DELTA_JOINTS[i].max) ? a : null }
  let arms = fits(want)
  const reached = !!arms
  if (!arms) {
    let lo = 0, hi = 1
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (fits(add(MIDDLE, scale(sub(want, MIDDLE), mid)))) lo = mid; else hi = mid
    }
    arms = fits(add(MIDDLE, scale(sub(want, MIDDLE), lo))) ?? HOME
  }
  return { pose: { a1: arms[0], a2: arms[1], a3: arms[2], roll: t.roll }, reached }
}

const low = (p: DeltaPose, held?: GripBox | null) => (deltaPlatform(p) ? lowestOf(deltaParts(HERE, p, 1, held)) : -Infinity)
const asDelta = (p: Pose) => p as DeltaPose

/**
 * The model: the post, its arm and the motors' plate; each upper arm turning on its motor's axis; the rods, placed
 * from end to end whenever an arm turns; the platform and the gripper under it.
 */
function buildDelta(n: number, stuff: ReturnType<typeof stuffOf>): ArmModel {
  const root = new THREE.Group()
  const plate = new THREE.Group()
  const hand = new THREE.Group()
  const turn = new THREE.Group()
  turn.position.y = -HANG
  plate.add(turn)
  hand.rotation.z = Math.PI
  turn.add(hand)
  root.add(plate)
  const grasp = new THREE.Object3D()
  grasp.position.y = GRASP_PAST_ROLL
  hand.add(grasp)
  const handRings = dress(DELTA_LOOK.filter(([g]) => g !== 'root'), { plate, hand }, stuff, 0)
  for (const [g, sh] of DELTA_LOOK) if (g === 'root') root.add(meshOf(sh, stuff))
  // The motors and the upper arms, each turning about its axis (across the arm), and a ring on each motor.
  const rings: THREE.Mesh[] = []
  const uppers = OUT.map((u, i) => {
    const mount = new THREE.Group()
    mount.position.set(u[0] * RB, HB, u[2] * RB)
    mount.rotation.y = MOTORS[i] * D2R
    root.add(mount)
    const motor = meshOf({ box: [0.1, 0.12, 0.14], at: [0.02, 0.02, 0], stuff: 'black' }, stuff)
    mount.add(motor)
    const ring = meshOf({ ring: [0.07, 0.01], axis: 'z', at: [0, 0, 0.08], joint: i }, stuff)
    mount.add(ring)
    rings.push(ring)
    const arm = new THREE.Group()
    mount.add(arm)
    arm.add(meshOf({ box: [RF, 0.05, 0.07], at: [-RF / 2, 0, 0], stuff: 'shell' }, stuff))
    arm.add(meshOf({ cyl: [0.03, 0.03, 2 * PAIR + 0.03], axis: 'z', at: [-RF, 0, 0], stuff: 'dark' }, stuff))
    return arm
  })
  rings.push(...handRings.filter(Boolean))
  // The rods: unit cylinders, stretched and turned into place.
  const rodGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 12)
  const rods = Array.from({ length: 6 }, () => { const m = new THREE.Mesh(rodGeo, stuff.metal); root.add(m); return m })
  const ringPlate = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.01, 8, 48), accent())
  ringPlate.rotation.x = Math.PI / 2
  ringPlate.position.set(POST, 0.05, 0)
  root.add(ringPlate)
  const label = plateLabel(n)
  label.position.set(POST + 0.22, 0.12, 0)
  root.add(label)
  const fingerGeo = rounded(FINGER_W, 0.1, 0.055)
  const fingers = [new THREE.Mesh(fingerGeo, stuff.metal), new THREE.Mesh(fingerGeo, stuff.metal)]
  for (const m of fingers) { m.position.y = FINGER_Y; hand.add(m) }
  const pose: DeltaPose = { a1: HOME[0], a2: HOME[1], a3: HOME[2], roll: 0 }
  const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3()
  /** Place the platform and the rods for the arms as they are (as they were, if they can't be). */
  const place3 = () => {
    const e = deltaPlatform(pose)
    if (!e) return
    plate.position.set(...e)
    rodEnds(pose, e).forEach(([a, b], k) => {
      const m = rods[k]
      m.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
      dir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      m.scale.set(1, dir.length(), 1)
      m.quaternion.setFromUnitVectors(up, dir.normalize())
    })
  }
  const apply = [
    ...ARMS.map((k, i) => (v: number) => { pose[k] = v; uppers[i].rotation.z = v * D2R; place3() }),
    (v: number) => { pose.roll = v; turn.rotation.y = v * D2R },
    (v: number) => { const x = FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL * v; fingers[0].position.x = -x; fingers[1].position.x = x },
  ]
  place3()
  return { root, apply, rings, plate: ringPlate, grasp, dispose: () => disposeModel(root, Object.values(stuff)) }
}

export const delta: ArmKind = {
  id: 'delta',
  kin: {
    keys: [...ARMS, 'roll'],
    joints: DELTA_JOINTS,
    forward: (p) => deltaForward(asDelta(p)),
    inverse: (t, held) => { const r = deltaInverse(t, held); return { pose: r.pose, reached: r.reached } },
    heading: (want) => want,
    yawRange: [-3600, 3600],
    pitchRange: [180, 180],
    rollRange: [-360, 360],
    pitches: [180],
    toolFloor: (_pitch, roll, held) => deltaToolFloor(roll, held),
    lowest: (p, held) => low(asDelta(p), held),
    stepAboveFloor: (was, next, following, held) => holdAboveFloor([...ARMS], (p) => low(asDelta(p), held), was, next, following, FLOOR_CLEAR,
      { key: 'a1', by: (p, d) => ({ ...p, a1: Math.max(-45, p.a1 - d), a2: Math.max(-45, p.a2 - d), a3: Math.max(-45, p.a3 - d) }), most: 60 }),
    parts: (s, p, open, held) => deltaParts(s, asDelta(p), open, held),
    fingers: FINGERS,
    grasp: (s, p) => framesAt(s, deltaPlatform(asDelta(p), true)!, p.roll).grasp,
    posts: [{ x: POST, z: 0, r: 0.18, y0: 0, y1: 0.04 }, { x: POST, z: 0, r: 0.055, y0: 0.04, y1: HB + 0.2 }],
  },
  build: (n, mats) => buildDelta(n, stuffOf(mats, '#c7cfe0')),
  cell: { stand: 0.7, fence: 1.75, blocks: [0.1, 0.16], camera: [2.7, 2.8, 3.6], look: 0.75 },
  drive: { reach: [0, 0.8], height: [0.06, 0.4], hover: [0.15, 0.06, 0.35], scale: 1 },
  hardware: false,
}

