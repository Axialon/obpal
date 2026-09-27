/**
 * The gripper's fingers, and a block it holds: where the fingers are at an opening, which blocks are by them, and how
 * a held block keeps them at its width until they open again (./blocks.ts closes them on one). Pure, in the gripper's
 * own frame (./model.ts): from the point between the fingers, x the way they close, y along them toward their tips, z
 * across them. Metres, and the gripper's opening from 0 (closed) to 1 (open).
 */
export type V3 = [number, number, number]

/** Each finger's inner face is this far from the middle closed, and this much further fully open. */
export const FINGER_IN = 0.003
export const FINGER_TRAVEL = 0.042
/** A finger's thickness, how far the fingers reach along themselves (from the point between them), and across. */
export const FINGER_W = 0.018
export const FINGER_SPAN: readonly [number, number] = [-0.065, 0.035]
export const FINGER_DEPTH = 0.0275
/** Held, the fingers open this much past the block before it goes (so a hand's tremble doesn't drop it): 0.4 mm. */
const RELEASE = 0.01

/** How far each finger's inner face is from the middle at an opening. */
export const fingerAt = (open: number) => FINGER_IN + FINGER_TRAVEL * open
/** The opening that puts each finger's inner face `half` from the middle. */
export const openingFor = (half: number) => (half - FINGER_IN) / FINGER_TRAVEL

/** A box in the gripper's frame: its centre, its axes (unit vectors in that frame) and its half-sizes along them. */
export interface GripBox { c: V3; axes: [V3, V3, V3]; half: V3 }

/** How far a box reaches from its centre along the gripper's axis `k` (0 x, 1 y, 2 z). */
export const reachAlong = (b: GripBox, k: 0 | 1 | 2) => b.axes.reduce((s, a, i) => s + b.half[i] * Math.abs(a[k]), 0)

/**
 * A box by the fingers (within their reach along them and across them): where its middle is along the grip, and half
 * its width there. Null when it's clear of them.
 */
export function byFingers(b: GripBox): { x: number; half: number } | null {
  const along = reachAlong(b, 1), across = reachAlong(b, 2), half = reachAlong(b, 0)
  if (b.c[1] + along <= FINGER_SPAN[0] || b.c[1] - along >= FINGER_SPAN[1] || Math.abs(b.c[2]) - across >= FINGER_DEPTH) return null
  if (Math.abs(b.c[0]) - half >= fingerAt(1) + FINGER_W) return null
  return { x: b.c[0], half }
}

/** Holding a box the fingers closed on at opening `grip`: they close no further, and opening past it lets it go. */
export function holding(grip: number, to: number): { open: number; release: boolean } {
  return to > grip + RELEASE ? { open: to, release: true } : { open: Math.max(grip, to), release: false }
}
