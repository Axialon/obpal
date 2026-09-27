/**
 * Point and go (CATALOGUE §7): a pose that puts the gripper above a spot on the floor, pointing down where it can.
 * Tries the tool straight down first, then tipped toward the spot as far as 60°, and pulls the spot in (or out) until
 * the arm reaches it within its joint limits. `exact` is false when it had to.
 */
import { JOINTS } from './model'
import { inverse, type ArmPose, type ToolTarget } from './kinematics'

const KEYS = ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const
export const withinLimits = (p: ArmPose) => KEYS.every((k, i) => p[k] >= JOINTS[i].min && p[k] <= JOINTS[i].max)

const PITCHES = [180, 170, 160, 150, 140, 130, 120]

function solve(yaw: number, reach: number, height: number, roll: number): ArmPose | null {
  for (const pitch of PITCHES) {
    const { pose, reached } = inverse({ yaw, reach, height, pitch, roll })
    if (reached && withinLimits(pose)) return pose
  }
  return null
}

/**
 * Following a hand, where it goes matters more than how the gripper is angled: the pose for `t`, or failing that the
 * nearest tool angle (up to `tilt` degrees off) that puts the gripper there within the joint limits.
 */
export function solveNear(t: ToolTarget, tilt = 60): { pose: ArmPose; exact: boolean } | null {
  for (let off = 0; off <= tilt; off += 5) {
    for (const s of off ? [1, -1] : [1]) {
      const { pose, reached } = inverse({ ...t, pitch: t.pitch + s * off })
      if (reached && withinLimits(pose)) return { pose, exact: off === 0 }
    }
  }
  return null
}

export function reachDown(yaw: number, reach: number, height: number, roll = 0): { pose: ArmPose; exact: boolean } | null {
  const y = Math.max(JOINTS[0].min, Math.min(JOINTS[0].max, yaw))
  const exact = solve(y, reach, height, roll)
  if (exact) return { pose: exact, exact: y === yaw }
  // Out of reach: come in (or go out) toward the arm's workspace, 2 cm at a time.
  const dir = reach > 0.6 ? -1 : 1
  for (let r = reach + dir * 0.02, i = 0; i < 60 && r > 0.05; r += dir * 0.02, i++) {
    const pose = solve(y, r, height, roll)
    if (pose) return { pose, exact: false }
  }
  return null
}
