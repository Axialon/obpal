/**
 * The five-axis arm's kinematics, in the arm's own plane: the base turns the plane (yaw); shoulder, elbow and wrist bend
 * in it; roll turns the tool about its axis. Angles are degrees. Bends are measured from vertical, forward positive,
 * so a tool pitch of 180 points straight down. Lengths are metres and match the sim's model (./model.ts).
 */
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

export interface ArmPose { yaw: number; shoulder: number; elbow: number; wrist: number; roll: number }

/** Where the tool is, in the arm's cylinder: heading, horizontal reach from the base axis, height, tool pitch and roll. */
export interface ToolTarget { yaw: number; reach: number; height: number; pitch: number; roll: number }

const D2R = Math.PI / 180

export function forward(p: ArmPose, g: ArmGeometry = ARM): ToolTarget {
  const a1 = p.shoulder * D2R
  const a2 = (p.shoulder + p.elbow) * D2R
  const a3 = (p.shoulder + p.elbow + p.wrist) * D2R
  const reach = g.L1 * Math.sin(a1) + g.L2 * Math.sin(a2) + g.LT * Math.sin(a3)
  const height = g.H0 + g.L1 * Math.cos(a1) + g.L2 * Math.cos(a2) + g.LT * Math.cos(a3)
  return { yaw: p.yaw, reach, height, pitch: p.shoulder + p.elbow + p.wrist, roll: p.roll }
}

/**
 * The pose that puts the tool at `t` (elbow up). A target out of reach is pulled back to the edge of the workspace, so
 * following a phone never jumps; `reached` says whether it had to.
 */
export function inverse(t: ToolTarget, g: ArmGeometry = ARM): { pose: ArmPose; reached: boolean } {
  const phi = t.pitch * D2R
  let du = t.reach - g.LT * Math.sin(phi)
  let dv = t.height - g.LT * Math.cos(phi) - g.H0
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
