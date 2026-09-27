/**
 * The home page's robot arm (the Move scene, ./scenes.ts) as geometry and motion. Pure, unit-tested in node, so it
 * can be held to its rule: no part of the arm ever goes below the table. The arm is a turntable with two links, seen
 * from the side, like the robot arms sim's (a base that turns, a shoulder and an elbow that bend). It reaches the other
 * side of the table by turning its base, its elbow always up, never by folding down through the table. Units are the
 * scene's, y down.
 */

export interface Point { x: number; y: number }

/** The table's top. */
export const TABLE = 222
/** The turntable, standing on the table, and the shoulder on top of it, where the upper arm bends. */
export const PLATE = { x: 176, y: TABLE - 12, w: 56, h: 12 }
export const SHOULDER: Point = { x: 204, y: 206 }
/** Upper arm (shoulder to elbow) and forearm (elbow to wrist). */
export const L1 = 86
export const L2 = 76
/** As drawn: the links' widths (upper arm, forearm; round ends), the joints' radii (shoulder, elbow, wrist), their rims. */
export const LINK_W = [13, 10] as const
export const JOINT_R = [9, 7.5, 6] as const
export const RIM = 2.2
/** The gripper's fingers hang from this far below the wrist to this far, this wide (round ends). */
export const FINGER = { from: 2, to: 16, w: 4 } as const
/** How close to the table any part of the arm comes. */
export const CLEAR = 2
/** The lowest the wrist goes: the fingertips clear the table. */
export const LOW = TABLE - CLEAR - FINGER.to - FINGER.w / 2
/** A block's size, and where a held one's centre is below the wrist: gripped at the lowest, it rests on the table. */
export const BLOCK = 20
export const HOLD = TABLE - BLOCK / 2 - LOW

/** The farthest the hand reaches from the shoulder (nearly straight), and the nearest (folded, but not tight). */
const FAR = L1 + L2 - 0.5
const NEAR = 34
/** Right over the base (this close, either side) the arm keeps facing the way it does, rather than turning to and fro. */
const OVER = 8
/** How quickly the hand and the base follow where the arm is headed (per second, as the scenes ease). */
const REACH_RATE = 10
const TURN_RATE = 6

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const smooth = (t: number) => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c) }

/** Where the arm is: its hand (the wrist), as how far out from the turntable's axis and how high, and how far the base has turned (0 facing right … π facing left). */
export interface Arm { r: number; y: number; turn: number }

/** The arm as drawn: its joints, and which way it faces as seen from the side (1 right … −1 left). */
export interface Pose { shoulder: Point; elbow: Point; wrist: Point; facing: number }

/** The nearest hand position the arm can take: above the table (fingers clear), in reach, and not folded tight. */
export function reachable(r: number, y: number): { r: number; y: number } {
  let h = clamp(SHOULDER.y - y, SHOULDER.y - LOW, FAR)
  r = clamp(r, 0, Math.sqrt(FAR * FAR - h * h))
  const d = Math.hypot(r, h)
  if (d < NEAR) { r *= NEAR / d; h *= NEAR / d }
  return { r, y: SHOULDER.y - h }
}

/** The arm's joints with its hand at `a` (made reachable): the elbow up, above the line from shoulder to hand. */
export function pose(a: Arm): Pose {
  const { r, y } = reachable(a.r, a.y)
  const h = SHOULDER.y - y
  const d = Math.hypot(r, h)
  // The upper arm's angle above level: the hand's, plus the triangle's angle at the shoulder.
  const up = Math.atan2(h, r) + Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1))
  const facing = Math.cos(a.turn)
  return {
    shoulder: SHOULDER,
    elbow: { x: SHOULDER.x + L1 * Math.cos(up) * facing, y: SHOULDER.y - L1 * Math.sin(up) },
    wrist: { x: SHOULDER.x + r * facing, y },
    facing,
  }
}

/** How low the drawn arm reaches: the largest y of any of its parts (links, joints and their rims, fingertips). */
export function lowest(p: Pose): number {
  return Math.max(
    p.shoulder.y + JOINT_R[0] + RIM / 2, p.elbow.y + JOINT_R[1] + RIM / 2, p.wrist.y + JOINT_R[2] + RIM / 2,
    Math.max(p.shoulder.y, p.elbow.y) + LINK_W[0] / 2, Math.max(p.elbow.y, p.wrist.y) + LINK_W[1] / 2,
    p.wrist.y + FINGER.to + FINGER.w / 2,
  )
}

/** Where the arm heads to put its hand at `p` (a pointer, a finger, a tilt): facing p's side of the base, reaching to it. */
export function aim(p: Point, turn: number): Arm {
  const dx = p.x - SHOULDER.x
  const face = Math.abs(dx) < OVER ? (turn < Math.PI / 2 ? 1 : -1) : Math.sign(dx)
  return { ...reachable(dx * face, p.y), turn: face > 0 ? 0 : Math.PI }
}

/** A step of `dt` seconds toward `to`: the hand eases there, and the base turns. */
export function follow(a: Arm, to: Arm, dt: number): Arm {
  const k = 1 - Math.exp(-dt * REACH_RATE)
  return { r: a.r + (to.r - a.r) * k, y: a.y + (to.y - a.y) * k, turn: a.turn + (to.turn - a.turn) * (1 - Math.exp(-dt * TURN_RATE)) }
}

/** The block's two places on the table, right and left of the base, and how the arm reaches each. */
export const PADS = [{ x: 318, turn: 0 }, { x: 96, turn: Math.PI }].map((p) => ({ ...p, r: Math.abs(p.x - SHOULDER.x) }))
/** How high the hand goes over a pad. */
const HOVER = 150

type Pad = (typeof PADS)[number]
type Leg = [turn: number, r: number, y: number, grip: number, seconds: number]
// Over the block, down, grip, up, turn across, down, let go, up; then back the other way.
const legs = (from: Pad, to: Pad): Leg[] => [
  [from.turn, from.r, HOVER, 0, 1.1], [from.turn, from.r, LOW, 0, 0.6], [from.turn, from.r, LOW, 1, 0.3], [from.turn, from.r, HOVER - 10, 1, 0.6],
  [to.turn, to.r, HOVER - 10, 1, 1.3], [to.turn, to.r, LOW, 1, 0.6], [to.turn, to.r, LOW, 0, 0.3], [to.turn, to.r, HOVER, 0, 0.6],
]
const STORY = [...legs(PADS[0], PADS[1]), ...legs(PADS[1], PADS[0])]
/** How long the story takes, once round (s). */
export const STORY_S = STORY.reduce((s, l) => s + l[4], 0)

/** The pick and place the arm plays by itself: where it's headed at time `t` (s), and its grip (0 open … 1 closed). */
export function story(t: number): { arm: Arm; grip: number } {
  let tt = ((t % STORY_S) + STORY_S) % STORY_S
  let prev = STORY[STORY.length - 1]
  for (const l of STORY) {
    if (tt <= l[4]) {
      const k = smooth(tt / l[4])
      const at = (i: number) => prev[i] + (l[i] - prev[i]) * k
      return { arm: { turn: at(0), r: at(1), y: at(2) }, grip: at(3) }
    }
    tt -= l[4]
    prev = l
  }
  return { arm: { turn: STORY[0][0], r: STORY[0][1], y: STORY[0][2] }, grip: 0 }
}
