/**
 * Where the arms stand around the shared floor, which way each faces, and which way its base turns for a target. Pure,
 * unit-tested in node.
 *
 * A base turns through 340°, not all the way round: the 20° it can't turn to is the back of its turntable. Each arm
 * faces the middle of the floor (its base at 0°), so that sector faces out, away from the work and the other arms.
 */
import type { Stand } from './blocks'

/** Arms stand around the middle: left, right, back, front (in multiples of how far out they stand). */
export const SLOTS: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]]
/**
 * How far out the five-axis arms stand (m): two facing each other at home (each reaching 74 cm) keep their grippers
 * apart. Each kind has its own (./kind/).
 */
export const CELL = 0.9

const D2R = Math.PI / 180
const mod = (a: number, n: number) => ((a % n) + n) % n

/** Where arm `n` (1 to 4) stands, `out` from the middle, turned so that it reaches toward the middle with its base at 0°. */
export function placement(n: number, out = CELL): Stand {
  const [x, z] = SLOTS[n - 1]
  return { x: x * out, z: z * out, turn: Math.atan2(-z, x) }
}

/** Which way on the floor (x and z, a unit vector) an arm standing at `s` reaches with its base turned `yaw` degrees. */
export function reachDir(s: Stand, yaw: number): [number, number] {
  const a = s.turn + yaw * D2R
  return [-Math.cos(a), Math.sin(a)]
}

/** The angle between two headings (degrees, 0 to 180), however many turns apart they're written. */
export function turnBetween(a: number, b: number): number {
  const d = mod(a - b, 360)
  return Math.min(d, 360 - d)
}

/** What a degree the base turns weighs against a degree it misses its target by, choosing where it heads. */
const TRAVEL = 0.1

/**
 * Where the base (turning within [min, max] degrees, `current` now) heads for a target heading: of the target itself
 * (where the base can face it) and its two limits, the one that misses the target least, each degree the base would
 * turn to get there counting as a tenth of a degree missed. So a target passing behind the arm holds the base at the
 * limit it's at, all through the back sector and about 13° past it (for a 340° base), rather than swinging it round
 * and back; from the middle of its range, the base heads for the limit nearer the target.
 */
export function headingFor(target: number, current: number, min: number, max: number): number {
  const t = min + mod(target - min, 360)
  const cost = (h: number) => turnBetween(h, t) + TRAVEL * Math.abs(h - current)
  const options = t <= max ? [t, min, max] : [min, max]
  return options.reduce((best, h) => (cost(h) < cost(best) ? h : best))
}
