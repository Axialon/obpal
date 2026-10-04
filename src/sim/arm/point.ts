/**
 * Point and go's one truth (CATALOGUE §7): the spot on the floor the gripper really goes to for a spot the phone aims
 * at. The mark drawn on the floor, the spot B sends the gripper over and the spot A's claw comes down on all come from
 * it, so that the mark is where the arm grabs. An arm doesn't reach the whole floor: past its reach, inside its least
 * reach, behind it (where its base holds at a limit) or too far out to come down on, it goes to the nearest spot it
 * does reach, and that is the spot to draw. Pure, unit-tested in node.
 */
import type { GripBox } from './grasp'
import { poseAt, reachDown, type Kin, type Pose } from './kin'
import { turnBetween } from './layout'

const D2R = Math.PI / 180
const R2D = 180 / Math.PI

/** A spot on the floor in an arm's own terms: the tool's heading and reach about the base axis, as x and z (./kinematics.ts). */
export interface Spot { x: number; z: number }

/** The spot at a heading (degrees) and a reach (m). */
export const spotAt = (yaw: number, reach: number): Spot => ({ x: -reach * Math.cos(yaw * D2R), z: reach * Math.sin(yaw * D2R) })

/** The heading (degrees) and reach (m) of a spot. */
export const headingOf = (s: Spot) => ({ yaw: Math.atan2(s.z, -s.x) * R2D, reach: Math.hypot(s.x, s.z) })

/** How close the gripper must already be to a spot for it to be that spot: its heading (degrees) and reach (m). */
const SAME = { yaw: 1e-4, reach: 1e-4 }
/** How far inside the edge of its reach a pulled spot is put (m), and the step reachDown searches by. */
const EDGE = 0.001
const STEP = 0.02

/**
 * The spot the gripper goes to for `want`, and whether it's `want` itself. The gripper goes over the spot at the
 * first of `heights` and comes straight down it to the last (and back), so the spot is one the arm reaches at every
 * height, from pose `near` and holding `held`: where it can't, the nearest it can on the same heading (./kin.ts:
 * reachDown, then its edge found to a tenth of a millimetre), then the same again at each other height until one spot
 * holds at them all. `range` is the reach the tool keeps within (the kind's drive), which the search starts from, so
 * that a spot far past the arm costs no more than one just past it. Null when the arm reaches no spot on that heading.
 */
export function reachableSpot(kin: Kin, want: Spot, heights: readonly number[], roll: number, held: GripBox | null | undefined, near: Pose, range?: readonly [number, number]): { spot: Spot; exact: boolean } | null {
  const asked = headingOf(want)
  let { yaw, reach } = asked
  if (range) reach = Math.min(range[1], Math.max(range[0], reach))
  const sought = reach
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    for (const height of heights) {
      const r = reachDown(kin, yaw, reach, height, roll, held, near)
      if (!r) return null
      const tool = kin.forward(r.pose)
      if (Math.abs(tool.reach - reach) > SAME.reach || turnBetween(tool.yaw, yaw) > SAME.yaw) { yaw = tool.yaw; reach = tool.reach; changed = true }
    }
    if (!changed) break
  }
  if (Math.abs(reach - sought) > 1e-9) {
    // The search steps a centimetre or two at a time: find the edge itself, between the spot it found and the step toward the one sought, so
    // that the spot holds still while the phone points further out and doesn't step as it moves.
    const toward = Math.sign(sought - reach)
    let ok = reach, bad = reach + toward * STEP
    for (let i = 0; i < 8; i++) {
      const mid = (ok + bad) / 2
      if (heights.every((height) => poseAt(kin, yaw, mid, height, roll, held, near))) ok = mid; else bad = mid
    }
    reach = ok
  }
  // A spot pulled in or out lies on the edge of the reach (the arm's, or the drive's, which an arm can end at too), where a rounding in the trip through the world can leave it out: a millimetre further inside.
  if (Math.abs(reach - asked.reach) > 1e-9) reach -= Math.sign(asked.reach - reach) * EDGE
  const spot = spotAt(yaw, reach)
  return { spot, exact: Math.hypot(spot.x - want.x, spot.z - want.z) < 1e-3 }
}
