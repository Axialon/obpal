/**
 * Serial arms (./kinds.ts): a base that turns, then a shoulder, an elbow and a wrist that bend in the arm's plane,
 * then a roll, as ./kinematics.ts has them. Each is a spec (its lengths, where its groups sit, its parts) from which
 * come its joints' frames, its parts as boxes for the blocks (./blocks.ts) and its Kin (./kin.ts). The five-axis arm
 * the sim began with is one; the SO-101 and the desk arm are others. Pure, unit-tested in node.
 */
import { FINGER_W, fingerAt, type GripBox, type V3 } from './grasp'
import { col, ID, mulV, nest, place, rotY, rotZ, type Frame } from './frames'
import { FLOOR_CLEAR, forward, inverse, type ArmGeometry, type ArmPose } from './kinematics'
import { holdAboveFloor, lowestOf, type Kin, type Pose, type Post } from './kin'
import { headingFor } from './layout'
import { boxOfShape, type Placed } from './look'
import type { JointSpec } from './model'
import type { Box, Stand } from './blocks'

const D2R = Math.PI / 180

/** A serial arm's groups, as its model nests them: the base (fixed), the turntable, then a group per joint. */
export type SerialGroup = 'root' | 'yaw' | 'shoulder' | 'elbow' | 'wrist' | 'roll'
const MOVING: readonly SerialGroup[] = ['shoulder', 'elbow', 'wrist', 'roll']

export interface SerialSpec {
  geo: ArmGeometry
  /** How high the turntable (the base's turning group) is, and how far past the wrist's pivot the roll's group. */
  deck: number
  rollAt: number
  /** Its parts, each in a group. The base's and the turntable's are its posts for the blocks; the rest move. */
  look: readonly Placed<SerialGroup>[]
  posts: readonly Post[]
}

/** The gripper every serial arm has (./grasp.ts): a finger's half-sizes, and where along the roll's group it sits. */
const FINGER: V3 = [FINGER_W / 2, 0.05, 0.0275]
export const FINGER_Y = 0.095
/** From the roll's group to the point between the fingers. */
export const GRASP_PAST_ROLL = 0.11

/** An arm's joints' frames in the world, nested as its model nests them. */
export function serialFrames(spec: SerialSpec, s: Stand, p: ArmPose): Record<SerialGroup | 'grasp', Frame> {
  const g = spec.geo
  const root: Frame = { R: rotY(s.turn), t: [s.x, 0, s.z] }
  const yaw = nest(root, rotY(p.yaw * D2R), [0, spec.deck, 0])
  const shoulder = nest(yaw, rotZ(p.shoulder * D2R), [0, g.H0 - spec.deck, 0])
  const elbow = nest(shoulder, rotZ(p.elbow * D2R), [0, g.L1, 0])
  const wrist = nest(elbow, rotZ(p.wrist * D2R), [0, g.L2, 0])
  const roll = nest(wrist, rotY(p.roll * D2R), [0, spec.rollAt, 0])
  const grasp = nest(roll, ID, [0, g.LT - spec.rollAt, 0])
  return { root, yaw, shoulder, elbow, wrist, roll, grasp }
}

const boxIn = (f: Frame, c: V3, half: V3): Box => ({ c: place(f, c), axes: [col(f.R, 0), col(f.R, 1), col(f.R, 2)], half })
/** A box given in a frame's own terms (a held block in the gripper's), in the world. */
export const boxOf = (f: Frame, b: Box): Box => ({ c: place(f, b.c), axes: [mulV(f.R, b.axes[0]), mulV(f.R, b.axes[1]), mulV(f.R, b.axes[2])], half: b.half })

/** The gripper's two fingers at an opening, as boxes in the world, from the frame they hang in. */
export function fingerBoxes(hand: Frame, open: number, along = FINGER_Y): [Box, Box] {
  const x = fingerAt(open) + FINGER_W / 2
  return [boxIn(hand, [-x, along, 0], FINGER), boxIn(hand, [x, along, 0], FINGER)]
}

/** The parts of a look in its moving groups, as boxes in the world. */
function movingParts(spec: SerialSpec, f: Record<SerialGroup, Frame>, only: readonly SerialGroup[] = MOVING): Box[] {
  const out: Box[] = []
  for (const [g, s] of spec.look) if (only.includes(g)) out.push(boxOfShape(f[g], s))
  return out
}

/** An arm's parts in the world, at a pose and an opening, with the block it holds (in its grasp frame). */
export function serialParts(spec: SerialSpec, s: Stand, p: ArmPose, open: number, held?: Box | null): Box[] {
  const f = serialFrames(spec, s, p)
  const out = movingParts(spec, f)
  out.push(...fingerBoxes(f.roll, open))
  if (held) out.push(boxOf(f.grasp, held))
  return out
}
/** How many of a spec's parts come before the fingers in `serialParts`. */
const partsBeforeFingers = (spec: SerialSpec) => spec.look.filter(([g]) => MOVING.includes(g)).length

const KEYS = ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const
const LOWERING = ['shoulder', 'elbow', 'wrist', 'roll'] as const
const HERE: Stand = { x: 0, z: 0, turn: 0 }
const asArm = (p: Pose) => p as ArmPose
const asPose = (p: ArmPose): Pose => p

/** How far below the tool point a serial arm's wrist and gripper reach at a tool angle, holding `held` (fingers wide open). */
export function serialDrop(spec: SerialSpec, pitch: number, roll: number, held?: GripBox | null): number {
  // Upper arm and forearm straight up, the wrist bent to the pitch: only the parts from the wrist on count.
  const f = serialFrames(spec, HERE, { yaw: 0, shoulder: 0, elbow: 0, wrist: pitch, roll })
  const parts = movingParts(spec, f, ['wrist', 'roll'])
  parts.push(...fingerBoxes(f.roll, 1))
  if (held) parts.push(boxOf(f.grasp, held))
  return f.grasp.t[1] - lowestOf(parts)
}

/**
 * A serial arm's Kin, from its spec and joints (base, shoulder, elbow, wrist, roll, then the gripper). The base heads
 * for a target by ./layout.ts's rule; the arm keeps above the floor by the shape of its parts, and headed for a pose
 * it rides along the floor by leaning its shoulder back.
 */
export function serialKin(spec: SerialSpec, joints: readonly JointSpec[], pitches: readonly number[] = [180, 170, 160, 150, 140, 130, 120]): Kin {
  const [base, shoulder, , , roll] = joints
  const low = (p: ArmPose, held?: GripBox | null) => lowestOf(serialParts(spec, HERE, p, 1, held))
  const floorAt = (pitch: number, r: number, held?: GripBox | null) => FLOOR_CLEAR + serialDrop(spec, pitch, r, held)
  const n = partsBeforeFingers(spec)
  return {
    keys: KEYS,
    joints,
    forward: (p) => forward(asArm(p), spec.geo),
    inverse: (t, held) => { const r = inverse(t, held, spec.geo, floorAt(t.pitch, t.roll, held)); return { pose: asPose(r.pose), reached: r.reached } },
    heading: (want, near) => headingFor(want, near.yaw, base.min, base.max),
    yawRange: [base.min, base.max],
    pitchRange: pitches.length > 1 ? [20, 200] : [180, 180],
    rollRange: [roll.min, roll.max],
    pitches,
    toolFloor: floorAt,
    lowest: (p, held) => low(asArm(p), held),
    stepAboveFloor: (was, next, following, held) => holdAboveFloor(LOWERING, (p) => low(asArm(p), held), was, next, following, FLOOR_CLEAR,
      { key: 'shoulder', by: (p, d) => ({ ...p, shoulder: Math.max(shoulder.min, p.shoulder - d) }), most: 45 }),
    parts: (s, p, open, held) => serialParts(spec, s, asArm(p), open, held),
    fingers: [n, n + 1],
    grasp: (s, p) => serialFrames(spec, s, asArm(p)).grasp,
    posts: spec.posts,
  }
}

/** The wrist a level arm takes: whatever keeps its tool pointing straight down. */
export const levelWrist = (shoulder: number, elbow: number) => 180 - shoulder - elbow

/**
 * An arm whose tool always points straight down (a parallelogram holds it: the desk arm), from a serial spec: its
 * pose is base, shoulder, elbow and roll (then the gripper), and its wrist takes whatever keeps the tool vertical.
 */
export function levelKin(spec: SerialSpec, joints: readonly JointSpec[]): Kin {
  const wrist: JointSpec = { key: 'wrist', name: 'Wrist', min: -360, max: 360, home: 0, vmax: 999, amax: 9999, unit: '°' }
  const full = serialKin(spec, [joints[0], joints[1], joints[2], wrist, joints[3]], [180])
  const chain = (p: Pose): Pose => ({ yaw: p.yaw, shoulder: p.shoulder, elbow: p.elbow, wrist: levelWrist(p.shoulder, p.elbow), roll: p.roll })
  const own = (p: Pose): Pose => ({ yaw: p.yaw, shoulder: p.shoulder, elbow: p.elbow, roll: p.roll })
  const shoulder = joints[1]
  const low = (p: Pose, held?: GripBox | null) => full.lowest(chain(p), held)
  return {
    keys: ['yaw', 'shoulder', 'elbow', 'roll'],
    joints,
    forward: (p) => full.forward(chain(p)),
    inverse: (t, held) => { const r = full.inverse({ ...t, pitch: 180 }, held); return { pose: own(r.pose), reached: r.reached } },
    heading: (want, near) => full.heading(want, chain(near)),
    yawRange: full.yawRange,
    pitchRange: [180, 180],
    rollRange: [joints[3].min, joints[3].max],
    pitches: [180],
    toolFloor: (_pitch, roll, held) => full.toolFloor(180, roll, held),
    lowest: low,
    stepAboveFloor: (was, next, following, held) => holdAboveFloor(['shoulder', 'elbow', 'roll'], (p) => low(p, held), was, next, following, FLOOR_CLEAR,
      { key: 'shoulder', by: (p, d) => ({ ...p, shoulder: Math.max(shoulder.min, p.shoulder - d) }), most: 45 }),
    parts: (s, p, open, held) => full.parts(s, chain(p), open, held),
    fingers: full.fingers,
    grasp: (s, p) => full.grasp(s, chain(p)),
    posts: spec.posts,
  }
}
