/**
 * The five-axis arm's kinematics, in the arm's own plane: the base turns the plane (yaw); shoulder, elbow and wrist bend
 * in it; roll turns the tool about its axis. Angles are degrees. Bends are measured from vertical, forward positive,
 * so a tool pitch of 180 points straight down. Lengths are metres and match the sim's model (./model.ts).
 */
import type { GripBox, V3 } from './grasp'

export interface ArmGeometry { H0: number; L1: number; L2: number; LT: number }

export const ARM: ArmGeometry = {
  /** Shoulder pivot above the floor. */
  H0: 0.36,
  /** Shoulder to elbow. */
  L1: 0.55,
  /** Elbow to wrist pivot. */
  L2: 0.46,
  /** Wrist pivot to the point between the gripper's fingers. */
  LT: 0.23,
}

export type ArmPose = { yaw: number; shoulder: number; elbow: number; wrist: number; roll: number }

/** Where the tool is, in the arm's cylinder: heading, horizontal reach from the base axis, height, tool pitch and roll. */
export interface ToolTarget { yaw: number; reach: number; height: number; pitch: number; roll: number }

const D2R = Math.PI / 180

/** Numerical contact clearance, below the 2 mm visual tolerance (m). */
export const FLOOR_CLEAR = 0.0005

/**
 * The arm's parts past the elbow as the sim builds them (./model.ts), for how low they reach. Rings are circles about
 * a joint in the arm's plane (radius and tube); the rest sit along the tool, measured from the wrist pivot: a barrel
 * (centre, half-length, radius), the roll ring (where, radius), and boxes that turn with the roll (centre, half-length,
 * half-width across the way the fingers open, half-depth). The fingers are counted wide open.
 */
const ELBOW_RING = 0.082 + 0.012
const WRIST_RING = 0.065 + 0.012
const FOREARM_HALF = 0.04
const BARREL = [0.06, 0.05, 0.045] as const
const ROLL_RING = [0.12, 0.052 + 0.012] as const
const BOXES = [[0.15, 0.0175, 0.07, 0.035], [0.215, 0.05, 0.012 + 0.042 + 0.009, 0.0275]] as const

/**
 * How far below the tool point the lowest part of the wrist and gripper is, at a tool angle (pitch, roll: degrees),
 * and of a block the gripper holds (`held`, in the gripper's frame: ./grasp.ts).
 */
export function toolDrop(pitch: number, roll: number, held?: GripBox | null, g: ArmGeometry = ARM): number {
  const a = pitch * D2R, r = roll * D2R
  const c = Math.cos(a), s = Math.abs(Math.sin(a))
  const across = s * Math.abs(Math.cos(r)), deep = s * Math.abs(Math.sin(r))
  // A point `t` along the tool from the wrist pivot is (LT − t)·cos(pitch) below the tool point (negative: above it).
  const below = (t: number) => (g.LT - t) * c
  const drops = [
    below(0) + WRIST_RING,
    below(BARREL[0]) + BARREL[1] * Math.abs(c) + BARREL[2] * s,
    below(ROLL_RING[0]) + ROLL_RING[1] * s,
    ...BOXES.map(([t, half, wide, depth]) => below(t) + half * Math.abs(c) + wide * across + depth * deep),
  ]
  if (held) drops.push(heldDrop(pitch, roll, held))
  return Math.max(...drops)
}

/** How far below the tool point the lowest corner of a held block is (in the gripper's frame), at a tool angle. */
export function heldDrop(pitch: number, roll: number, held: GripBox): number {
  const a = pitch * D2R, r = roll * D2R
  // Up, in the gripper's frame: the way the fingers close, along them to their tips, across them.
  const up: V3 = [Math.cos(r) * Math.sin(a), Math.cos(a), Math.sin(r) * Math.sin(a)]
  const dot = (v: readonly number[]) => v[0] * up[0] + v[1] * up[1] + v[2] * up[2]
  return held.axes.reduce((d, axis, i) => d + held.half[i] * Math.abs(dot(axis)), -dot(held.c))
}

/** The lowest the tool point may go at a tool angle (degrees): the gripper and wrist, and what it holds, clear the floor. */
export const toolFloor = (pitch: number, roll: number, held?: GripBox | null, g: ArmGeometry = ARM) => FLOOR_CLEAR + toolDrop(pitch, roll, held, g)

/** How high above the floor the arm's lowest moving part is (m), in a pose: elbow, forearm, wrist, gripper, what it holds. */
export function lowest(p: ArmPose, held?: GripBox | null, g: ArmGeometry = ARM): number {
  const a1 = p.shoulder * D2R
  const a2 = (p.shoulder + p.elbow) * D2R
  const elbow = g.H0 + g.L1 * Math.cos(a1)
  const wrist = elbow + g.L2 * Math.cos(a2)
  const t = forward(p, g)
  return Math.min(elbow - ELBOW_RING, Math.min(elbow, wrist) - FOREARM_HALF * Math.abs(Math.sin(a2)), t.height - toolDrop(t.pitch, t.roll, held, g))
}

/** The joints that can take the arm lower (the base only turns it), and every set of them, fewest first. */
const LOWERING = ['shoulder', 'elbow', 'wrist', 'roll'] as const
export type Lowering = (typeof LOWERING)[number]
const HOLDS: Lowering[][] = Array.from({ length: 15 }, (_, m) => LOWERING.filter((_, i) => ((m + 1) >> i) & 1))
  .sort((a, b) => a.length - b.length)

/**
 * The floor, for one step of the joints from `was` to `next`, holding `held` if anything (./grasp.ts). Each joint moves
 * at its own pace, so even a move between two poses clear of the floor can dip through it on the way. A clear step is
 * taken as it is. Otherwise, joints headed for a pose (`following`: the whole arm, home, the claw) go on, and the
 * shoulder leans back just enough, so the arm rides along the floor while they catch up; joints turned by hand stop
 * where they were, as at a limit. Either way no part of the arm, nor what it holds, goes below the floor (or, were it
 * somehow under it already, any lower). Returns the pose to take and the joints the floor stopped or moved.
 */
export function stepAboveFloor(was: ArmPose, next: ArmPose, following: boolean, minShoulder: number, held?: GripBox | null, g: ArmGeometry = ARM): { pose: ArmPose; floored: Lowering[] } {
  const low = (p: ArmPose) => lowest(p, held, g)
  const floor = Math.min(FLOOR_CLEAR, low(was)) - 1e-9
  if (low(next) >= floor) return { pose: next, floored: [] }
  if (following) {
    const back = (d: number): ArmPose => ({ ...next, shoulder: Math.max(minShoulder, next.shoulder - d) })
    let lo = 0, hi = 45
    if (low(back(hi)) >= floor) {
      for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (low(back(mid)) >= floor) hi = mid; else lo = mid }
      return { pose: back(hi), floored: ['shoulder'] }
    }
  }
  for (const hold of HOLDS) {
    const p = { ...next }
    for (const k of hold) p[k] = was[k]
    if (low(p) >= floor) return { pose: p, floored: hold }
  }
  const p = { ...next }
  for (const k of LOWERING) p[k] = was[k]
  return { pose: p, floored: [...LOWERING] }
}

export function forward(p: ArmPose, g: ArmGeometry = ARM): ToolTarget {
  const a1 = p.shoulder * D2R
  const a2 = (p.shoulder + p.elbow) * D2R
  const a3 = (p.shoulder + p.elbow + p.wrist) * D2R
  const reach = g.L1 * Math.sin(a1) + g.L2 * Math.sin(a2) + g.LT * Math.sin(a3)
  const height = g.H0 + g.L1 * Math.cos(a1) + g.L2 * Math.cos(a2) + g.LT * Math.cos(a3)
  return { yaw: p.yaw, reach, height, pitch: p.shoulder + p.elbow + p.wrist, roll: p.roll }
}

/**
 * The pose that puts the tool at `t` (elbow up). A target lower than the gripper can go at its angle, holding `held` if
 * anything, is raised to just above the floor (toolFloor, or `floor` for an arm with a gripper of its own), so no part
 * of the arm, nor what it holds, goes through it. A target out of reach is pulled back to the edge of the workspace, so
 * following a phone never jumps; `reached` says whether it had to.
 */
export function inverse(t: ToolTarget, held?: GripBox | null, g: ArmGeometry = ARM, floor = toolFloor(t.pitch, t.roll, held, g)): { pose: ArmPose; reached: boolean } {
  const phi = t.pitch * D2R
  let du = t.reach - g.LT * Math.sin(phi)
  let dv = Math.max(t.height, floor) - g.LT * Math.cos(phi) - g.H0
  let d = Math.hypot(du, dv)
  const min = Math.abs(g.L1 - g.L2) + 0.02 * (g.L1 + g.L2)
  const max = (g.L1 + g.L2) * 0.999
  const reached = d >= min && d <= max
  if (!reached) {
    const k = (d < min ? min : max) / Math.max(1e-6, d)
    du *= k
    dv *= k
    d = Math.hypot(du, dv)
  }
  const c = Math.min(1, Math.max(-1, (d * d - g.L1 * g.L1 - g.L2 * g.L2) / (2 * g.L1 * g.L2)))
  const e = Math.acos(c)
  const s = Math.atan2(du, dv) - Math.atan2(g.L2 * Math.sin(e), g.L1 + g.L2 * Math.cos(e))
  const shoulder = s / D2R
  const elbow = e / D2R
  return { pose: { yaw: t.yaw, shoulder, elbow, wrist: t.pitch - shoulder - elbow, roll: t.roll }, reached }
}
