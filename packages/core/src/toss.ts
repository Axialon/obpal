import type { Vec3 } from './quat'

/** A flick counts once the device went up at least this fast (m/s), and reports at most this. */
const MIN_SPEED = 0.3
const MAX_SPEED = 4
/** Braking this hard (m/s², along up) ends the flick: a ball on a tray would leave it here (a little under 1 g). */
const BRAKE = 7
/** The speed estimate forgets its past over this long (s), so an accelerometer's drift never piles up. */
const LEAK = 0.35
/** A peak speed older than about this (s) no longer counts. */
const PEAK_HOLD = 0.15
/** After a toss, it listens again once this long has passed (s) and the device is no longer going up. */
const COOL = 0.12
const REARM = 0.1
/** How quickly the gravity estimate follows (s), where the device reports no linear acceleration. */
const GRAVITY_LAG = 0.4

/**
 * A toss: the device flicked upward, screen level, the way you'd throw a ball off a tray. Fed the device's motion
 * sample by sample, it reports how fast the device was going up (m/s) at the moment it braked hard, which is when a
 * ball resting on it would have left. A slow lift, a jolt, a drop and the way back down after a toss are not tosses.
 */
export class TossDetector {
  private v = 0
  private peak = 0
  private cool = 0
  private armed = true
  private g: Vec3 | null = null

  /**
   * One sample of acceleration along world up (m/s², gravity removed; + is up) over `dt` seconds. Returns the toss's
   * speed when one happens, else null.
   */
  sample(aUp: number, dt: number): number | null {
    if (!(dt > 0) || !Number.isFinite(aUp)) return null
    dt = Math.min(dt, 0.05)
    this.v = (this.v + aUp * dt) * Math.exp(-dt / LEAK)
    // Once it's no longer going up (braking, or on its way back down), the next flick can count.
    if (!this.armed && this.v <= REARM) this.armed = true
    if (this.cool > 0) { this.cool -= dt; return null }
    if (!this.armed) return null
    this.peak = Math.max(this.peak * Math.exp(-dt / PEAK_HOLD), this.v)
    if (this.peak >= MIN_SPEED && aUp <= -BRAKE) {
      const v = Math.min(this.peak, MAX_SPEED)
      this.peak = 0
      this.cool = COOL
      this.armed = false
      return v
    }
    return null
  }

  /**
   * One motion event's worth, in the device's own frame: `accel` is linear acceleration (gravity removed) and
   * `withGravity` the same with gravity's reaction included (what W3C devicemotion reports as acceleration and
   * accelerationIncludingGravity). Either may be missing; up comes from their difference, or from a slow average of
   * `withGravity` where there's no `accel`.
   */
  motion(accel: Vec3 | null, withGravity: Vec3 | null, dt: number): number | null {
    let up: Vec3, a: Vec3
    if (accel && withGravity) {
      up = [withGravity[0] - accel[0], withGravity[1] - accel[1], withGravity[2] - accel[2]]
      a = accel
    } else if (withGravity) {
      const k = this.g ? 1 - Math.exp(-Math.max(0, dt) / GRAVITY_LAG) : 1
      const g = this.g ?? [0, 0, 0]
      this.g = [g[0] + (withGravity[0] - g[0]) * k, g[1] + (withGravity[1] - g[1]) * k, g[2] + (withGravity[2] - g[2]) * k]
      up = this.g
      a = [withGravity[0] - up[0], withGravity[1] - up[1], withGravity[2] - up[2]]
    } else return null
    const n = Math.hypot(up[0], up[1], up[2])
    if (n < 4) return null // no clear sense of up (free fall, a spin): leave it be
    return this.sample((a[0] * up[0] + a[1] * up[1] + a[2] * up[2]) / n, dt)
  }

  reset() {
    this.v = this.peak = this.cool = 0
    this.armed = true
    this.g = null
  }
}
