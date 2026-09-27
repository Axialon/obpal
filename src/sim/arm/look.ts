/**
 * An arm's parts as its model draws them and as the blocks (./blocks.ts) meet them, from one list, so the two can't
 * disagree: each part is a box, a cylinder or a joint's ring, placed in one of the arm's joint groups. The model
 * (./shapes3d.ts) builds a mesh for each; the kinematics box each (a cylinder or a ring boxed whole). Pure.
 */
import type { V3 } from './grasp'
import { col, place, type Frame } from './frames'
import type { Box } from './blocks'

export type Axis = 'x' | 'y' | 'z'
/** What a part is made of: the arm's metal, its dark joints, its own colour, or its rubber and servos. */
export type Stuff = 'metal' | 'dark' | 'shell' | 'black'

export type Shape =
  /** A box: its size (x, y, z) and where its middle is. */
  | { box: V3; at: V3; stuff: Stuff }
  /** A cylinder along an axis: its radius (and a second radius, for a taper) and length, and where its middle is. */
  | { cyl: [number, number, number]; axis: Axis; at: V3; stuff: Stuff }
  /** A joint's ring (it wears its holder's colour): its radius and tube, about an axis, where its middle is, and whose. */
  | { ring: [number, number]; axis: Axis; at: V3; joint: number }

/** A part in a group of the arm: the group's name (a joint's frame) and the part. */
export type Placed<G extends string> = readonly [G, Shape]

const halfOf = (s: Shape): V3 => {
  if ('box' in s) return [s.box[0] / 2, s.box[1] / 2, s.box[2] / 2]
  const [r, tube] = 'cyl' in s ? [Math.max(s.cyl[0], s.cyl[1]), s.cyl[2] / 2] : [s.ring[0] + s.ring[1], s.ring[1]]
  return s.axis === 'x' ? [tube, r, r] : s.axis === 'y' ? [r, tube, r] : [r, r, tube]
}

/** A part as a box in the world, its group's frame given. */
export function boxOfShape(f: Frame, s: Shape): Box {
  return { c: place(f, s.at), axes: [col(f.R, 0), col(f.R, 1), col(f.R, 2)], half: halfOf(s) }
}

/** The moving parts as boxes in the world: each part in its group's frame, but for those in `fixed` groups. */
export function boxesOf<G extends string>(parts: readonly Placed<G>[], frames: Record<G, Frame>, fixed: readonly G[] = []): Box[] {
  const out: Box[] = []
  for (const [g, s] of parts) if (!fixed.includes(g)) out.push(boxOfShape(frames[g], s))
  return out
}
