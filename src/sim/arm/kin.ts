/**
 * How an arm of any kind moves (./kind/ has the kinds), as the sim, the blocks (./blocks.ts) and the drives use it:
 * where its tool is for a pose, and the pose for a place (its inverse kinematics); which way it heads for a target;
 * how it keeps above the floor; and its moving parts as boxes. A pose is the arm's joints by name, the gripper not
 * among them: degrees, or metres for a joint that slides. Pure, unit-tested in node.
 *
 * Where the tool is (a ToolTarget, ./kinematics.ts) is the same for every kind: its heading and reach about the arm's
 * own axis, its height, how far it's tipped (180: straight down) and how far the gripper is turned about itself.
 */
import type { Material } from 'three'
import type { Box, Stand } from './blocks'
import type { Frame } from './frames'
import type { GripBox } from './grasp'
import type { ToolTarget } from './kinematics'
import { turnBetween } from './layout'
import type { ArmModel, JointSpec } from './model'

export type Pose = Record<string, number>

/** A post of an arm's base standing on the floor, which blocks keep out of: where (in the arm's own terms), radius, bottom and top (m). */
export interface Post { x: number; z: number; r: number; y0: number; y1: number }

export interface Kin {
  /** The pose's joints, in the arm's order: `joints` has them first, then the gripper. */
  readonly keys: readonly string[]
  readonly joints: readonly JointSpec[]
  /** Where the tool is. */
  forward(p: Pose): ToolTarget
  /**
   * The pose that puts the tool at `t`, holding `held`; where there's a choice (an elbow left or right, a wrist one
   * way or the other), the one nearest `near`. A place out of its reach is pulled back to where it reaches, and
   * `reached` says so. Joint limits are the caller's to check (`within`).
   */
  inverse(t: ToolTarget, held?: GripBox | null, near?: Pose): { pose: Pose; reached: boolean }
  /** The heading to take for a target's heading `want`, from pose `near`: the target's, or a limit it holds at (./layout.ts). */
  heading(want: number, near: Pose): number
  /** The headings, tool pitches and rolls that driving the whole arm keeps its tool within (degrees). */
  readonly yawRange: readonly [number, number]
  readonly pitchRange: readonly [number, number]
  readonly rollRange: readonly [number, number]
  /** The tool pitches Point tries, straightest down first. */
  readonly pitches: readonly number[]
  /** The lowest the tool point may go at a tool angle, holding `held`: its gripper, and what it holds, clear the floor. */
  toolFloor(pitch: number, roll: number, held?: GripBox | null): number
  /** How high the arm's lowest moving part is in a pose, with what it holds (the fingers counted wide open); -Infinity where the pose can't be. */
  lowest(p: Pose, held?: GripBox | null): number
  /** One step of the joints from `was` toward `next`, kept above the floor (./kinematics.ts has the rule). */
  stepAboveFloor(was: Pose, next: Pose, following: boolean, held?: GripBox | null): { pose: Pose; floored: string[] }
  /** Its moving parts as boxes in the world, at a gripper opening, with what it holds (in its grasp frame). */
  parts(s: Stand, p: Pose, open: number, held?: Box | null): Box[]
  /** Which of `parts` are the two fingers. */
  readonly fingers: readonly [number, number]
  /** The frame at the point between the fingers, in the world. */
  grasp(s: Stand, p: Pose): Frame
  /** Its base, which never moves. */
  readonly posts: readonly Post[]
}

/** The materials every arm shares (the sim's metal, and its dark joints). */
export interface ArmMaterials { metal: Material; dark: Material }

/** A kind of arm in the sim (./kind/index.ts has them all): how it moves, how it looks, and the cell it works in. */
export interface ArmKind {
  id: string
  kin: Kin
  /** Arm `n`'s model (its number on its plate). */
  build(n: number, mats: ArmMaterials): ArmModel
  /**
   * The cell, in metres: how far out from the middle its arms stand, the fence (the arms work inside it), the blocks'
   * two rings about the middle, and where the camera starts and what it looks at (the height of a point over the
   * middle).
   */
  cell: { stand: number; fence: number; blocks: readonly [number, number]; camera: readonly [number, number, number]; look: number }
  /** Driving the whole arm: the reach and heights the tool keeps within, its hover over the floor (usual, lowest, highest) and the 3D scale. */
  drive: { reach: readonly [number, number]; height: readonly [number, number]; hover: readonly [number, number, number]; scale: number }
  /** Whether it can be a real arm's twin (./drivers.ts: base, shoulder, elbow, wrist, roll and the gripper). */
  hardware: boolean
}

/** Whether a pose is within its joints' limits. */
export function within(k: Kin, p: Pose): boolean {
  return k.keys.every((key, i) => p[key] >= k.joints[i].min - 1e-9 && p[key] <= k.joints[i].max + 1e-9)
}

/** The arm's joints' values (in `keys` order) as a pose. */
export function poseFrom(k: Kin, values: readonly number[]): Pose {
  const p: Pose = {}
  k.keys.forEach((key, i) => { p[key] = values[i] })
  return p
}

/** A joint's home, for each of the pose's joints. */
export const homeOf = (k: Kin): Pose => poseFrom(k, k.joints.map((j) => j.home))

/** The pose that puts the gripper `height` over the spot `reach` out at heading `yaw`, tool straight down or tipped as far as the kind tips it (the first that's within its joint limits); null where there's none. */
export function poseAt(k: Kin, yaw: number, reach: number, height: number, roll: number, held: GripBox | null | undefined, near: Pose): Pose | null {
  for (const pitch of k.pitches) {
    const { pose, reached } = k.inverse({ yaw, reach, height, pitch, roll }, held, near)
    if (reached && within(k, pose)) return pose
  }
  return null
}

/**
 * Point and go (CATALOGUE §7): a pose that puts the gripper `height` over a spot on the floor, `reach` out at heading
 * `want`, from pose `near`. It tries the tool straight down first, then tipped toward the spot as far as the kind tips
 * it, and failing that the nearest spot on the same heading that the arm reaches within its joint limits. `exact` is
 * false when it had to, or when it can't face the spot. Holding a block, the gripper stays high enough that the block
 * clears the floor too.
 */
export function reachDown(k: Kin, want: number, reach: number, height: number, roll: number, held: GripBox | null | undefined, near: Pose): { pose: Pose; exact: boolean } | null {
  const yaw = k.heading(want, near)
  const solve = (r: number) => poseAt(k, yaw, r, height, roll, held, near)
  const exact = solve(reach)
  if (exact) return { pose: exact, exact: turnBetween(yaw, want) < 1e-6 }
  // Out of reach: the nearest spot it reaches, in or out, 2 cm at a time.
  for (let i = 1; i <= 80; i++) {
    for (const r of [reach - i * 0.02, reach + i * 0.02]) {
      const pose = r > 0.01 ? solve(r) : null
      if (pose) return { pose, exact: false }
    }
  }
  return null
}

/**
 * Following a hand, where it goes matters more than how the gripper is angled: the pose for `t`, or failing that the
 * nearest tool pitch (up to `tilt` degrees off, where the kind tips its tool) that puts the gripper there within the
 * joint limits.
 */
export function solveNear(k: Kin, t: ToolTarget, tilt: number, held: GripBox | null | undefined, near: Pose): { pose: Pose; exact: boolean } | null {
  const tips = k.pitchRange[1] > k.pitchRange[0] ? tilt : 0
  for (let off = 0; off <= tips; off += 5) {
    for (const s of off ? [1, -1] : [1]) {
      const { pose, reached } = k.inverse({ ...t, pitch: t.pitch + s * off }, held, near)
      if (reached && within(k, pose)) return { pose, exact: off === 0 }
    }
  }
  return null
}

/** How high the lowest corner of any of these boxes is. */
export function lowestOf(boxes: readonly Box[]): number {
  let y = Infinity
  for (const b of boxes) y = Math.min(y, b.c[1] - (b.half[0] * Math.abs(b.axes[0][1]) + b.half[1] * Math.abs(b.axes[1][1]) + b.half[2] * Math.abs(b.axes[2][1])))
  return y
}

/** Every set of `keys`, fewest first (and, among as many, in the order the keys come). */
const setsOf = new Map<string, string[][]>()
export function subsets(keys: readonly string[]): string[][] {
  const id = keys.join()
  let out = setsOf.get(id)
  if (!out) {
    out = Array.from({ length: 2 ** keys.length - 1 }, (_, m) => keys.filter((_, i) => ((m + 1) >> i) & 1)).sort((a, b) => a.length - b.length)
    setsOf.set(id, out)
  }
  return out
}

/** How an arm headed for a pose rises clear of the floor: the joint that does it, and the pose moved `d` that way (up to `most`). */
export interface Lift { key: string; by(p: Pose, d: number): Pose; most: number }

/**
 * The floor, for one step of the joints from `was` to `next`: `low` says how high a pose's lowest part is, `lowering`
 * which joints can take it lower. A clear step is taken as it is. Otherwise, joints headed for a pose (`following`)
 * go on, and the arm rises just enough (`lift`) to ride along the floor while they catch up; joints moved by hand stop
 * where they were, as at a limit: the fewest that keep it clear. Either way no part goes below `clear` above the floor
 * (or, were it somehow under it already, any lower). Returns the pose to take and the joints the floor stopped or moved.
 */
export function holdAboveFloor(lowering: readonly string[], low: (p: Pose) => number, was: Pose, next: Pose, following: boolean, clear: number, lift?: Lift): { pose: Pose; floored: string[] } {
  const floor = Math.min(clear, low(was)) - 1e-9
  if (low(next) >= floor) return { pose: next, floored: [] }
  if (following && lift) {
    const up = (d: number) => lift.by(next, d)
    let lo = 0, hi = lift.most
    if (low(up(hi)) >= floor) {
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (low(up(mid)) >= floor) hi = mid; else lo = mid }
      return { pose: up(hi), floored: [lift.key] }
    }
  }
  for (const hold of subsets(lowering)) {
    const p = { ...next }
    for (const k of hold) p[k] = was[k]
    if (low(p) >= floor) return { pose: p, floored: hold }
  }
  const p = { ...next }
  for (const k of lowering) p[k] = was[k]
  return { pose: p, floored: [...lowering] }
}
