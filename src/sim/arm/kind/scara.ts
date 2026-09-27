/**
 * A SCARA: a column, and on it an upper arm and a forearm that swing flat (shoulder, elbow), a quill that slides up and
 * down at the forearm's end, and a roll that turns the gripper under it. Its tool always points down. Its IK is the
 * flat two-link one (the elbow the side nearer where it is, within its limits), the quill for the height, and the roll
 * for the gripper's turn. A tool's roll here, as for the other arms, is how far the fingers are turned from closing
 * along the line out from the arm's axis. Procedural, white and dark.
 */
import * as THREE from 'three'
import { rounded } from '../../kit'
import type { Box, Stand } from '../blocks'
import { ID, nest, rotY, type Frame } from '../frames'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W, type GripBox } from '../grasp'
import { holdAboveFloor, lowestOf, type ArmKind, type Pose } from '../kin'
import { FLOOR_CLEAR, type ToolTarget } from '../kinematics'
import { headingFor } from '../layout'
import { boxOfShape, type Placed } from '../look'
import type { ArmModel, JointSpec } from '../model'
import { boxOf, fingerBoxes, FINGER_Y, GRASP_PAST_ROLL } from '../serial'
import { accent, disposeModel, dress, plateLabel, stuffOf } from '../shapes3d'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

export const SCARA_JOINTS: JointSpec[] = [
  { key: 'shoulder', name: 'Shoulder', min: -130, max: 130, home: -60, vmax: 90, amax: 300, unit: '°' },
  { key: 'elbow', name: 'Elbow', min: -145, max: 145, home: 130, vmax: 120, amax: 400, unit: '°' },
  { key: 'z', name: 'Quill', min: 0, max: 0.34, home: 0.12, vmax: 0.4, amax: 1.6, unit: 'm' },
  { key: 'roll', name: 'Tool roll', min: -360, max: 360, home: 0, vmax: 240, amax: 800, unit: '°' },
  { key: 'gripper', name: 'Gripper', min: 0, max: 1, home: 1, vmax: 1.4, amax: 6, unit: '' },
]
const [J1, J2, JZ] = SCARA_JOINTS

/** The upper arm's height, the forearm this far above it, the upper arm and forearm, the quill's foot below the forearm (the quill in). */
const HA = 0.5
const UP = 0.1
const L1 = 0.45
const L2 = 0.4
const Q0 = 0.1
/** How far the gripper's turning group hangs under the quill's foot. */
const HANG = 0.02
/** The tool point's height with the quill in: it goes down as far as the quill slides out. */
export const SCARA_TOP = HA + UP - Q0 - HANG - GRASP_PAST_ROLL
/** How far the quill's shaft reaches up from its foot. */
const SHAFT = JZ.max + 0.2

export type ScaraPose = { shoulder: number; elbow: number; z: number; roll: number }
type Group = 'root' | 'upper' | 'fore' | 'quill' | 'hand'

export const SCARA_LOOK: readonly Placed<Group>[] = [
  ['root', { cyl: [0.18, 0.2, 0.06], axis: 'y', at: [0, 0.03, 0], stuff: 'dark' }],
  ['root', { cyl: [0.11, 0.12, HA - 0.1], axis: 'y', at: [0, 0.06 + (HA - 0.1) / 2, 0], stuff: 'shell' }],
  // The upper arm on the column, the forearm on top of it at the elbow.
  ['upper', { cyl: [0.12, 0.12, 0.1], axis: 'y', at: [0, 0, 0], stuff: 'shell' }],
  ['upper', { box: [L1, 0.09, 0.2], at: [-L1 / 2, 0, 0], stuff: 'shell' }],
  ['upper', { ring: [0.13, 0.012], axis: 'y', at: [0, -0.05, 0], joint: 0 }],
  ['fore', { cyl: [0.1, 0.1, 0.1], axis: 'y', at: [0, 0, 0], stuff: 'dark' }],
  ['fore', { box: [L2, 0.08, 0.16], at: [-L2 / 2, 0, 0], stuff: 'shell' }],
  ['fore', { cyl: [0.075, 0.075, 0.14], axis: 'y', at: [-L2, 0.02, 0], stuff: 'dark' }],
  ['fore', { ring: [0.11, 0.012], axis: 'y', at: [0, 0.055, 0], joint: 1 }],
  // The quill: its shaft, its foot; the roll's servo, and the gripper's palm the fingers hang from (+y down).
  ['quill', { cyl: [0.022, 0.022, SHAFT], axis: 'y', at: [0, SHAFT / 2, 0], stuff: 'metal' }],
  ['quill', { ring: [0.045, 0.008], axis: 'y', at: [0, 0.1, 0], joint: 2 }],
  ['hand', { cyl: [0.045, 0.045, 0.03], axis: 'y', at: [0, -0.005, 0], stuff: 'dark' }],
  ['hand', { box: [0.14, 0.035, 0.07], at: [0, 0.03, 0], stuff: 'shell' }],
  ['hand', { ring: [0.05, 0.008], axis: 'y', at: [0, 0.005, 0], joint: 3 }],
  ['hand', { ring: [0.03, 0.008], axis: 'y', at: [0, 0.05, 0], joint: 4 }],
]
const MOVING: readonly Group[] = ['upper', 'fore', 'quill', 'hand']

/** The arm's groups' frames in the world. The hand's is turned over: its y points down, along the fingers. */
export function scaraFrames(s: Stand, p: ScaraPose): Record<Group | 'grasp', Frame> {
  const root: Frame = { R: rotY(s.turn), t: [s.x, 0, s.z] }
  const upper = nest(root, rotY(p.shoulder * D2R), [0, HA, 0])
  const fore = nest(upper, rotY(p.elbow * D2R), [-L1, UP, 0])
  const quill = nest(fore, ID, [-L2, -Q0 - p.z, 0])
  const hand = nest(quill, turnedOver(p.roll), [0, -HANG, 0])
  const grasp = nest(hand, ID, [0, GRASP_PAST_ROLL, 0])
  return { root, upper, fore, quill, hand, grasp }
}
/** The hand's turn: the roll about the vertical, then a half turn over (about z), so that its y points down. */
export function turnedOver(roll: number): number[] {
  const c = Math.cos(roll * D2R), s = Math.sin(roll * D2R)
  // rotY(roll) · rotZ(π)
  return [-c, 0, s, 0, -1, 0, s, 0, c]
}

function scaraParts(s: Stand, p: ScaraPose, open: number, held?: Box | null, only: readonly Group[] = MOVING): Box[] {
  const f = scaraFrames(s, p)
  const out: Box[] = []
  for (const [g, sh] of SCARA_LOOK) if (only.includes(g)) out.push(boxOfShape(f[g], sh))
  out.push(...fingerBoxes(f.hand, open))
  if (held) out.push(boxOf(f.grasp, held))
  return out
}
const FINGERS: [number, number] = [SCARA_LOOK.filter(([g]) => MOVING.includes(g)).length, SCARA_LOOK.filter(([g]) => MOVING.includes(g)).length + 1]
const HERE: Stand = { x: 0, z: 0, turn: 0 }
const wrap = (a: number) => a - 360 * Math.round(a / 360)
const near360 = (a: number, to: number) => a + 360 * Math.round((to - a) / 360)

/** Where the quill is, flat: its heading and reach about the column (degrees, metres). */
function flat(shoulder: number, elbow: number) {
  const a1 = shoulder * D2R, a2 = (shoulder + elbow) * D2R
  const x = -L1 * Math.cos(a1) - L2 * Math.cos(a2), z = L1 * Math.sin(a1) + L2 * Math.sin(a2)
  return { yaw: Math.atan2(z, -x) * R2D, reach: Math.hypot(x, z) }
}
/** How far the quill's heading is from the upper arm's, with the elbow bent `elbow` degrees. */
const bendOff = (elbow: number) => Math.atan2(L2 * Math.sin(elbow * D2R), L1 + L2 * Math.cos(elbow * D2R)) * R2D

export function scaraForward(p: ScaraPose): ToolTarget {
  const { yaw, reach } = flat(p.shoulder, p.elbow)
  return { yaw, reach, height: SCARA_TOP - p.z, pitch: 180, roll: wrap(p.shoulder + p.elbow + p.roll - yaw) }
}

/** How far below the tool point the gripper, and what it holds, reach (the fingers wide open). */
function drop(roll: number, held?: GripBox | null): number {
  const p: ScaraPose = { shoulder: 0, elbow: 0, z: 0, roll }
  return scaraFrames(HERE, p).grasp.t[1] - lowestOf(scaraParts(HERE, p, 1, held, ['hand']))
}
export const scaraToolFloor = (roll: number, held?: GripBox | null) => FLOOR_CLEAR + drop(roll, held)

/** The nearest reach the elbow allows, and the farthest. */
const RMIN = Math.hypot(L1 + L2 * Math.cos(J2.max * D2R), L2 * Math.sin(J2.max * D2R))
const RMAX = (L1 + L2) * 0.999

/**
 * The pose for a tool target, holding `held`: the elbow bent the way that keeps the shoulder within its limits and
 * nearer `near`'s, the quill for the height, the roll for the gripper's turn. A place out of reach (too near the
 * column, too far, too high or too low) is pulled back to where it reaches, and `reached` says so.
 */
export function scaraInverse(t: ToolTarget, held?: GripBox | null, near?: Partial<ScaraPose>): { pose: ScaraPose; reached: boolean } {
  let reached = true
  let r = t.reach
  if (r < RMIN) { r = RMIN; reached = false } else if (r > RMAX) { r = RMAX; reached = false }
  const b = Math.acos(Math.max(-1, Math.min(1, (r * r - L1 * L1 - L2 * L2) / (2 * L1 * L2)))) * R2D
  const was = { shoulder: near?.shoulder ?? J1.home, elbow: near?.elbow ?? J2.home }
  const options = [b, -b].map((elbow) => ({ elbow, shoulder: near360(t.yaw - bendOff(elbow), was.shoulder) }))
  const ok = (o: { shoulder: number; elbow: number }) => o.shoulder >= J1.min && o.shoulder <= J1.max
  const cost = (o: { shoulder: number; elbow: number }) => (ok(o) ? 0 : 1e6) + Math.abs(o.shoulder - was.shoulder) + Math.abs(o.elbow - was.elbow)
  const { shoulder, elbow } = cost(options[0]) <= cost(options[1]) ? options[0] : options[1]
  let z = SCARA_TOP - Math.max(t.height, scaraToolFloor(t.roll, held))
  if (z < JZ.min) { z = JZ.min; reached = false } else if (z > JZ.max) { z = JZ.max; reached = false }
  const roll = near360(t.roll + t.yaw - shoulder - elbow, near?.roll ?? 0)
  return { pose: { shoulder, elbow, z, roll }, reached }
}

/** The headings its tool takes, at the reach it's at: the shoulder's limits, and as far again as the elbow's bend turns it. */
function headingRange(p: ScaraPose): [number, number] {
  const off = Math.abs(bendOff(p.elbow))
  return [J1.min - off, J1.max + off]
}

const low = (p: ScaraPose, held?: GripBox | null) => lowestOf(scaraParts(HERE, p, 1, held))
const asScara = (p: Pose) => p as ScaraPose

function buildScara(n: number, stuff: ReturnType<typeof stuffOf>): ArmModel {
  const root = new THREE.Group()
  const upper = new THREE.Group()
  upper.position.y = HA
  root.add(upper)
  const fore = new THREE.Group()
  fore.position.set(-L1, UP, 0)
  upper.add(fore)
  const quill = new THREE.Group()
  quill.position.set(-L2, -Q0, 0)
  fore.add(quill)
  const turn = new THREE.Group()
  turn.position.y = -HANG
  quill.add(turn)
  const hand = new THREE.Group()
  hand.rotation.z = Math.PI
  turn.add(hand)
  const grasp = new THREE.Object3D()
  grasp.position.y = GRASP_PAST_ROLL
  hand.add(grasp)
  const rings = dress(SCARA_LOOK, { root, upper, fore, quill, hand }, stuff, 5)
  const plate = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.01, 8, 48), accent())
  plate.rotation.x = Math.PI / 2
  plate.position.y = 0.012
  root.add(plate)
  const label = plateLabel(n)
  label.position.set(0.3, 0.1, 0)
  root.add(label)
  const fingerGeo = rounded(FINGER_W, 0.1, 0.055)
  const fingers = [new THREE.Mesh(fingerGeo, stuff.metal), new THREE.Mesh(fingerGeo, stuff.metal)]
  for (const m of fingers) { m.position.y = FINGER_Y; hand.add(m) }
  const apply = [
    (v: number) => { upper.rotation.y = v * D2R },
    (v: number) => { fore.rotation.y = v * D2R },
    (v: number) => { quill.position.y = -Q0 - v },
    (v: number) => { turn.rotation.y = v * D2R },
    (v: number) => { const x = FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL * v; fingers[0].position.x = -x; fingers[1].position.x = x },
  ]
  return { root, apply, rings, plate, grasp, dispose: () => disposeModel(root, Object.values(stuff)) }
}

export const scara: ArmKind = {
  id: 'scara',
  kin: {
    keys: ['shoulder', 'elbow', 'z', 'roll'],
    joints: SCARA_JOINTS,
    forward: (p) => scaraForward(asScara(p)),
    inverse: (t, held, near) => { const r = scaraInverse(t, held, near && asScara(near)); return { pose: r.pose, reached: r.reached } },
    heading: (want, near) => { const p = asScara(near); const [lo, hi] = headingRange(p); return headingFor(want, flat(p.shoulder, p.elbow).yaw, lo, hi) },
    yawRange: [J1.min, J1.max],
    pitchRange: [180, 180],
    rollRange: [-180, 180],
    pitches: [180],
    toolFloor: (_pitch, roll, held) => scaraToolFloor(roll, held),
    lowest: (p, held) => low(asScara(p), held),
    stepAboveFloor: (was, next, following, held) => holdAboveFloor(['z'], (p) => low(asScara(p), held), was, next, following, FLOOR_CLEAR,
      { key: 'z', by: (p, d) => ({ ...p, z: Math.max(JZ.min, p.z - d) }), most: JZ.max }),
    parts: (s, p, open, held) => scaraParts(s, asScara(p), open, held),
    fingers: FINGERS,
    grasp: (s, p) => scaraFrames(s, asScara(p)).grasp,
    posts: [{ x: 0, z: 0, r: 0.2, y0: 0, y1: 0.06 }, { x: 0, z: 0, r: 0.12, y0: 0.06, y1: HA - 0.05 }],
  },
  build: (n, mats) => buildScara(n, stuffOf(mats, '#dfe4ea')),
  cell: { stand: 0.62, fence: 1.5, blocks: [0.12, 0.2], camera: [1.65, 1.45, 2.3], look: 0.22 },
  drive: { reach: [RMIN, RMAX], height: [0.06, SCARA_TOP], hover: [0.15, 0.06, 0.35], scale: 1 },
  hardware: false,
}

