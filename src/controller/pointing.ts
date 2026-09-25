/**
 * Wii-style pointing. The phone is a pointer: wherever it aims, the cursor follows. Held like a remote (screen
 * up, or tipped toward you) the top edge points; held upright like a camera, the back does. The grip at recentre
 * decides. Twisting the phone around that axis doesn't move the cursor, as with a Wii remote.
 *
 * Angles are absolute relative to the recentre pose: turning about gravity is left/right, raising and lowering
 * is up/down. The cursor stays where the phone points: it can leave the screen and comes back when you aim back,
 * instead of drifting out of step.
 *
 * Output is continuous (never jumps, even on recentre): an accumulator of the aim angle, sent in STATE's aim
 * fields (yaw + = left, pitch + = up, degrees). Hosts integrate the deltas into the absolute angle since their
 * own recentre and project it: x = cx + tan(yaw) * K.
 */
import { OneEuro, qRotate, type Quat, type Vec3 } from '@obpal/core'

const R2D = 180 / Math.PI
/** Wrap a degree difference into [-180, 180). */
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180
/** Screen normal this close to horizontal (tipped more than 70° from flat) = held upright, pointing with the back. */
const UPRIGHT = 0.34

export class WiiPointer {
  private ready = false
  private axis: Vec3 = [0, 1, 0]
  private az0 = 0
  private el0 = 0
  private prev: [number, number] | null = null
  private f = [new OneEuro(1.2, 0.04, 1), new OneEuro(1.2, 0.04, 1)]
  /** Continuous aim accumulator (degrees): yaw + = left, pitch + = up. */
  readonly acc: [number, number] = [0, 0]
  /** Latest absolute aim relative to the recentre pose (degrees): yaw + = right, pitch + = up. */
  readonly aim: [number, number] = [0, 0]

  get calibrated() { return this.ready }
  /** The phone's own pointing axis: the top edge [0, 1, 0] or the back [0, 0, -1]. */
  get pointingAxis(): Vec3 { return this.axis }

  /** Steadiness 0..1: more smoothing of hand tremor when the phone is still (fast moves stay responsive). */
  setSteadiness(s: number) {
    for (const f of this.f) f.minCutoff = 2.4 - 1.8 * Math.max(0, Math.min(1, s))
  }

  /** Aim here = the centre of the screen. The grip at this moment decides which edge points. */
  recenter(q: Quat) {
    this.axis = Math.abs(qRotate(q, [0, 0, 1])[2]) > UPRIGHT ? [0, 1, 0] : [0, 0, -1]
    const [az, el] = this.angles(q)
    this.az0 = az
    this.el0 = el
    this.ready = true
    this.prev = null
    for (const f of this.f) f.reset()
  }

  /** Feed the latest orientation (screen frame -> Earth, z up); returns the continuous accumulator. */
  update(q: Quat, dt: number): [number, number] {
    if (!this.ready) this.recenter(q)
    const [az, el] = this.angles(q)
    const yaw = wrap(this.az0 - az) // turning right (clockwise seen from above) lowers the azimuth
    const pitch = el - this.el0
    const y = this.f[0].filter(this.prev ? this.aim[0] + wrap(yaw - this.aim[0]) : yaw, dt)
    const p = this.f[1].filter(pitch, dt)
    if (this.prev) {
      this.acc[0] -= y - this.prev[0]
      this.acc[1] += p - this.prev[1]
    }
    this.prev = [y, p]
    this.aim[0] = y
    this.aim[1] = p
    return this.acc
  }

  /** Azimuth (about gravity) and elevation of the pointing axis, in degrees. */
  private angles(q: Quat): [number, number] {
    const F = qRotate(q, this.axis)
    return [Math.atan2(F[1], F[0]) * R2D, Math.atan2(F[2], Math.hypot(F[0], F[1])) * R2D]
  }
}
