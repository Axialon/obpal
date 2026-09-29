/** Optional HAND curls compose with BODY at its wrist; they never reposition the arm. */
import type { BodyFrame, Frame } from '@obpal/host'
import { Vector3 } from 'three'
import { clamp } from './profile'

export type Grip = { left: number; right: number }
export class FingerInput {
  private identity = ''
  private barrier: [number, number] | null = null

  step(body: BodyFrame | null, hand: Frame['hand'], mirror: boolean, source = ''): Grip {
    const rest = { left: 0, right: 0 }
    if (
      !body?.tracked ||
      !hand?.tracked ||
      hand.t === undefined ||
      hand.confidence < 0.65 ||
      hand.handedness === 'unknown' ||
      Math.abs((hand.t - body.t) | 0) > 50_000
    ) {
      this.identity = ''
      return rest
    }
    const identity = `${source}/${body.gen}/${hand.gen}/${hand.handedness}/${mirror}`
    if (identity !== this.identity) {
      this.identity = identity
      this.barrier = [body.t, hand.t]
      return rest
    }
    // A generation change needs a fresh observation from both producers.
    if (this.barrier && (body.t === this.barrier[0] || hand.t === this.barrier[1])) return rest
    this.barrier = null
    const points = hand.landmarks
    if (points.length !== 21 || !points.every((p) => p.every(Number.isFinite))) return rest
    let bend = 0
    for (const base of [5, 9, 13, 17]) {
      const ids = [0, base, base + 1, base + 2, base + 3]
      const vectors = ids.slice(1).map((id, i) => new Vector3(...points[id]).sub(new Vector3(...points[ids[i]])))
      if (vectors.some((v) => v.lengthSq() < 1e-8)) return rest
      bend += vectors.slice(1).reduce((sum, v, i) => sum + v.angleTo(vectors[i]), 0) / 2.6
    }
    const side = mirror ? (hand.handedness === 'left' ? 'right' : 'left') : hand.handedness
    rest[side] = clamp(bend / 4, 0, 1)
    return rest
  }
}
