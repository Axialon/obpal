/**
 * A six-axis industrial arm: a base, a shoulder and an elbow place its wrist, and a spherical wrist (the forearm's
 * twist, a bend, the tool's roll) points the tool any way at all. Its IK is the textbook one: the wrist's centre from
 * where the tool is and which way it points, the shoulder and elbow to put it there (elbow up), then the wrist's three
 * to turn the tool. A tool target may say how far the tool leans out of the arm's plane (`aside`); the drives don't,
 * so driving the whole arm keeps the tool in its plane (the twist at 0, or a half turn with the bend the other way,
 * whichever is nearer), and the twist is for turning by hand. Procedural, in industrial orange.
 */
import * as THREE from 'three'
import type { Box, Stand } from '../blocks'
import { col, dot, ID, mulR, mulTV, nest, rotY, rotZ, type Frame } from '../frames'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W, type GripBox, type V3 } from '../grasp'
import { holdAboveFloor, lowestOf, type ArmKind, type Pose } from '../kin'
import { FLOOR_CLEAR, type ToolTarget } from '../kinematics'
import { headingFor } from '../layout'
import { boxOfShape, type Placed } from '../look'
import type { ArmModel, JointSpec } from '../model'
import { boxOf, fingerBoxes, FINGER_Y, GRASP_PAST_ROLL } from '../serial'
import { accent, disposeModel, dress, plateLabel, stuffOf } from '../shapes3d'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

export const SIX_JOINTS: JointSpec[] = [
  { key: 'base', name: 'Base', min: -170, max: 170, home: 0, vmax: 70, amax: 220, unit: '°' },
  { key: 'shoulder', name: 'Shoulder', min: -80, max: 110, home: 5, vmax: 55, amax: 160, unit: '°' },
  { key: 'elbow', name: 'Elbow', min: -140, max: 150, home: 80, vmax: 70, amax: 220, unit: '°' },
  { key: 'twist', name: 'Twist', min: -180, max: 180, home: 0, vmax: 120, amax: 400, unit: '°' },
  { key: 'wrist', name: 'Wrist bend', min: -120, max: 120, home: 65, vmax: 120, amax: 400, unit: '°' },
  { key: 'roll', name: 'Tool roll', min: -270, max: 270, home: 0, vmax: 180, amax: 600, unit: '°' },
  { key: 'gripper', name: 'Gripper', min: 0, max: 1, home: 1, vmax: 1.4, amax: 6, unit: '' },
]

/** The turntable's height, the shoulder's, the upper arm, the elbow to the wrist's bend (the twist this far along it), the bend to the grasp. */
const DECK = 0.12
const H0 = 0.45
const L1 = 0.55
const L2 = 0.5
const TW = 0.12
const LT = 0.21
const ROLL_AT = LT - GRASP_PAST_ROLL

type Group = 'root' | 'yaw' | 'shoulder' | 'elbow' | 'twist' | 'wrist' | 'roll'
const MOVING: readonly Group[] = ['shoulder', 'elbow', 'twist', 'wrist', 'roll']
export type SixPose = { yaw: number; shoulder: number; elbow: number; twist: number; wrist: number; roll: number }
const KEYS = ['yaw', 'shoulder', 'elbow', 'twist', 'wrist', 'roll'] as const

export const SIX_LOOK: readonly Placed<Group>[] = [
  ['root', { cyl: [0.24, 0.27, 0.12], axis: 'y', at: [0, 0.06, 0], stuff: 'dark' }],
  ['yaw', { cyl: [0.17, 0.2, 0.16], axis: 'y', at: [0, 0.08, 0], stuff: 'shell' }],
  ['yaw', { box: [0.24, 0.2, 0.26], at: [0, H0 - DECK - 0.02, 0], stuff: 'shell' }],
  ['yaw', { ring: [0.2, 0.012], axis: 'y', at: [0, 0.01, 0], joint: 0 }],
  ['shoulder', { cyl: [0.11, 0.11, 0.3], axis: 'z', at: [0, 0, 0], stuff: 'dark' }],
  ['shoulder', { box: [0.13, L1, 0.15], at: [0, L1 / 2, 0], stuff: 'shell' }],
  ['shoulder', { ring: [0.12, 0.012], axis: 'z', at: [0, 0, 0.16], joint: 1 }],
  ['elbow', { cyl: [0.09, 0.09, 0.24], axis: 'z', at: [0, 0, 0], stuff: 'dark' }],
  ['elbow', { box: [0.14, 0.14, 0.15], at: [0, 0.05, 0], stuff: 'shell' }],
  ['elbow', { ring: [0.1, 0.012], axis: 'z', at: [0, 0, 0.13], joint: 2 }],
  ['twist', { cyl: [0.055, 0.065, L2 - TW], axis: 'y', at: [0, (L2 - TW) / 2, 0], stuff: 'shell' }],
  ['twist', { ring: [0.075, 0.01], axis: 'y', at: [0, 0.01, 0], joint: 3 }],
  ['wrist', { cyl: [0.055, 0.055, 0.14], axis: 'z', at: [0, 0, 0], stuff: 'dark' }],
  ['wrist', { cyl: [0.045, 0.045, 0.06], axis: 'y', at: [0, 0.05, 0], stuff: 'metal' }],
  ['wrist', { ring: [0.065, 0.01], axis: 'z', at: [0, 0, 0.075], joint: 4 }],
  ['roll', { box: [0.14, 0.035, 0.07], at: [0, 0.03, 0], stuff: 'dark' }],
  ['roll', { ring: [0.05, 0.008], axis: 'y', at: [0, 0, 0], joint: 5 }],
  ['roll', { ring: [0.03, 0.008], axis: 'y', at: [0, 0.05, 0], joint: 6 }],
]

/** The arm's joints' frames in the world, nested as its model nests them. */
export function sixFrames(s: Stand, p: SixPose): Record<Group | 'grasp', Frame> {
  const root: Frame = { R: rotY(s.turn), t: [s.x, 0, s.z] }
  const yaw = nest(root, rotY(p.yaw * D2R), [0, DECK, 0])
  const shoulder = nest(yaw, rotZ(p.shoulder * D2R), [0, H0 - DECK, 0])
  const elbow = nest(shoulder, rotZ(p.elbow * D2R), [0, L1, 0])
  const twist = nest(elbow, rotY(p.twist * D2R), [0, TW, 0])
  const wrist = nest(twist, rotZ(p.wrist * D2R), [0, L2 - TW, 0])
  const roll = nest(wrist, rotY(p.roll * D2R), [0, ROLL_AT, 0])
  const grasp = nest(roll, ID, [0, LT - ROLL_AT, 0])
  return { root, yaw, shoulder, elbow, twist, wrist, roll, grasp }
}

function sixParts(s: Stand, p: SixPose, open: number, held?: Box | null, only: readonly Group[] = MOVING): Box[] {
  const f = sixFrames(s, p)
  const out: Box[] = []
  for (const [g, sh] of SIX_LOOK) if (only.includes(g)) out.push(boxOfShape(f[g], sh))
  out.push(...fingerBoxes(f.roll, open))
  if (held) out.push(boxOf(f.grasp, held))
  return out
}
const FINGERS: [number, number] = [SIX_LOOK.filter(([g]) => MOVING.includes(g)).length, SIX_LOOK.filter(([g]) => MOVING.includes(g)).length + 1]
const HERE: Stand = { x: 0, z: 0, turn: 0 }

/** The tool's heading, reach, height, pitch (unwrapped near the bends' sum), roll and how far it leans out of the arm's plane. */
export function sixForward(p: SixPose): ToolTarget & { aside: number } {
  const g = sixFrames(HERE, p).grasp
  const P = g.t, d = col(g.R, 1)
  const psi = Math.atan2(P[2], -P[0])
  const f: V3 = [-Math.cos(psi), 0, Math.sin(psi)], l: V3 = [Math.sin(psi), 0, Math.cos(psi)]
  const raw = Math.atan2(dot(d, f), d[1]) * R2D
  const est = p.shoulder + p.elbow + p.wrist
  return {
    yaw: psi * R2D, reach: Math.hypot(P[0], P[2]), height: P[1],
    pitch: raw + 360 * Math.round((est - raw) / 360), roll: p.roll, aside: Math.asin(Math.max(-1, Math.min(1, dot(d, l)))) * R2D,
  }
}

/** How far below the tool point the wrist and gripper reach at a tool angle, holding `held` (fingers wide open). */
function sixDrop(pitch: number, roll: number, held?: GripBox | null): number {
  const p: SixPose = { yaw: 0, shoulder: 0, elbow: 0, twist: 0, wrist: pitch, roll }
  const g = sixFrames(HERE, p).grasp
  return g.t[1] - lowestOf(sixParts(HERE, p, 1, held, ['wrist', 'roll']))
}
export const sixToolFloor = (pitch: number, roll: number, held?: GripBox | null) => FLOOR_CLEAR + sixDrop(pitch, roll, held)

/**
 * The pose for a tool target (degrees, metres, in the arm's own terms), holding `held`, the wrist's twist nearest
 * `near`'s where there's a choice. A place out of reach is pulled back to the edge of the workspace (`reached` false).
 */
export function sixInverse(t: ToolTarget & { aside?: number }, held?: GripBox | null, near?: Partial<SixPose>): { pose: SixPose; reached: boolean } {
  const psi = t.yaw * D2R, phi = t.pitch * D2R, al = (t.aside ?? 0) * D2R
  const f: V3 = [-Math.cos(psi), 0, Math.sin(psi)], u: V3 = [0, 1, 0], l: V3 = [Math.sin(psi), 0, Math.cos(psi)]
  const d: V3 = [0, 1, 2].map((i) => Math.cos(al) * (Math.sin(phi) * f[i] + Math.cos(phi) * u[i]) + Math.sin(al) * l[i]) as V3
  const h = Math.max(t.height, sixToolFloor(t.pitch, t.roll, held))
  const P: V3 = [-t.reach * Math.cos(psi), h, t.reach * Math.sin(psi)]
  const W: V3 = [P[0] - LT * d[0], P[1] - LT * d[1], P[2] - LT * d[2]]
  // The base faces the wrist's centre (turned from the target's heading as far as the tool leans aside).
  const wf = dot(W, f), wl = dot(W, l)
  const yaw = t.yaw + (Math.abs(wf) > 1e-9 ? Math.atan(wl / wf) * R2D : 0)
  const f1: V3 = [-Math.cos(yaw * D2R), 0, Math.sin(yaw * D2R)]
  let du = dot(W, f1), dv = W[1] - H0
  let dd = Math.hypot(du, dv)
  const min = Math.abs(L1 - L2) + 0.02 * (L1 + L2), max = (L1 + L2) * 0.999
  const reached = dd >= min && dd <= max
  if (!reached) { const k = (dd < min ? min : max) / Math.max(1e-6, dd); du *= k; dv *= k; dd = Math.hypot(du, dv) }
  const e = Math.acos(Math.min(1, Math.max(-1, (dd * dd - L1 * L1 - L2 * L2) / (2 * L1 * L2))))
  const sh = Math.atan2(du, dv) - Math.atan2(L2 * Math.sin(e), L1 + L2 * Math.cos(e))
  // The wrist: the tool's direction in the forearm's frame gives the twist and the bend.
  const RE = mulR(rotY(yaw * D2R), rotZ(sh + e))
  const dE = mulTV(RE, d)
  const bend = Math.acos(Math.max(-1, Math.min(1, dE[1])))
  const was = near?.twist ?? 0
  let twist: number, wrist: number
  if (Math.sin(bend) < 1e-4) { twist = was; wrist = bend * R2D } else {
    const a1 = Math.atan2(dE[2], -dE[0]) * R2D, a2 = Math.atan2(-dE[2], dE[0]) * R2D
    const off = (a: number) => Math.abs(a + 360 * Math.round((was - a) / 360) - was)
    const [tw, b] = off(a1) <= off(a2) ? [a1, bend * R2D] : [a2, -bend * R2D]
    twist = tw + 360 * Math.round((was - tw) / 360)
    wrist = b
  }
  return { pose: { yaw, shoulder: sh * R2D, elbow: e * R2D, twist, wrist, roll: t.roll }, reached }
}

const low = (p: SixPose, held?: GripBox | null) => lowestOf(sixParts(HERE, p, 1, held))
const asSix = (p: Pose) => p as SixPose

/** The model: its groups nested as its frames are, its parts from its look, the gripper, and a number plate. */
function buildSix(n: number, stuff: ReturnType<typeof stuffOf>): ArmModel {
  const root = new THREE.Group()
  const at = (parent: THREE.Object3D, y: number) => { const g = new THREE.Group(); g.position.y = y; parent.add(g); return g }
  const yaw = at(root, DECK)
  const shoulder = at(yaw, H0 - DECK)
  const elbow = at(shoulder, L1)
  const twist = at(elbow, TW)
  const wrist = at(twist, L2 - TW)
  const roll = at(wrist, ROLL_AT)
  const grasp = at(roll, LT - ROLL_AT)
  const rings = dress(SIX_LOOK, { root, yaw, shoulder, elbow, twist, wrist, roll }, stuff, 7)
  const plate = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.01, 12, 96), accent())
  plate.rotation.x = Math.PI / 2
  plate.position.y = 0.012
  root.add(plate)
  const label = plateLabel(n)
  label.position.set(0.38, 0.12, 0)
  root.add(label)
  const fingerGeo = new THREE.BoxGeometry(FINGER_W, 0.1, 0.055)
  const fingers = [new THREE.Mesh(fingerGeo, stuff.metal), new THREE.Mesh(fingerGeo, stuff.metal)]
  for (const m of fingers) { m.position.y = FINGER_Y; roll.add(m) }
  const apply = [
    (v: number) => { yaw.rotation.y = v * D2R },
    (v: number) => { shoulder.rotation.z = v * D2R },
    (v: number) => { elbow.rotation.z = v * D2R },
    (v: number) => { twist.rotation.y = v * D2R },
    (v: number) => { wrist.rotation.z = v * D2R },
    (v: number) => { roll.rotation.y = v * D2R },
    (v: number) => { const x = FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL * v; fingers[0].position.x = -x; fingers[1].position.x = x },
  ]
  return { root, apply, rings, plate, grasp, dispose: () => disposeModel(root, Object.values(stuff)) }
}

export const six: ArmKind = {
  id: 'six',
  kin: {
    keys: KEYS,
    joints: SIX_JOINTS,
    forward: (p) => sixForward(asSix(p)),
    inverse: (t, held, near) => { const r = sixInverse(t, held, near && asSix(near)); return { pose: r.pose, reached: r.reached } },
    heading: (want, near) => headingFor(want, near.yaw, SIX_JOINTS[0].min, SIX_JOINTS[0].max),
    yawRange: [SIX_JOINTS[0].min, SIX_JOINTS[0].max],
    pitchRange: [20, 200],
    rollRange: [SIX_JOINTS[5].min, SIX_JOINTS[5].max],
    pitches: [180, 170, 160, 150, 140, 130, 120],
    toolFloor: sixToolFloor,
    lowest: (p, held) => low(asSix(p), held),
    stepAboveFloor: (was, next, following, held) => holdAboveFloor(['shoulder', 'elbow', 'twist', 'wrist', 'roll'], (p) => low(asSix(p), held), was, next, following, FLOOR_CLEAR,
      { key: 'shoulder', by: (p, d) => ({ ...p, shoulder: Math.max(SIX_JOINTS[1].min, p.shoulder - d) }), most: 45 }),
    parts: (s, p, open, held) => sixParts(s, asSix(p), open, held),
    fingers: FINGERS,
    grasp: (s, p) => sixFrames(s, asSix(p)).grasp,
    posts: [{ x: 0, z: 0, r: 0.27, y0: 0, y1: 0.12 }, { x: 0, z: 0, r: 0.2, y0: 0.12, y1: 0.55 }],
  },
  build: (n, mats) => buildSix(n, stuffOf(mats, '#e07a2f')),
  cell: { stand: 0.9, fence: 2.05, blocks: [0.22, 0.34], camera: [2.2, 2.1, 3.1], look: 0.35 },
  drive: { reach: [0.25, 1.2], height: [0.06, 1.45], hover: [0.2, 0.08, 0.8], scale: 1.5 },
  hardware: false,
}

