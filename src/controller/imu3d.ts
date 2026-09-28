/**
 * 3D from the phone's own sensors (mode 6, no camera), followed the way a Wii remote with MotionPlus is: the gyro
 * knows exactly how the phone turns, and an arm model turns that into where the hand is. The phone sits at the end of
 * an arm, about 45 cm from a pivot behind it (elbow and shoulder together), so swinging it left moves it left and
 * tipping it up raises it, and none of that drifts. Pushing and pulling along where the phone points, which turning
 * can't show, comes from the accelerometer, integrated only while the phone moves and reset whenever it's still.
 *
 * Output is a POSE (./track.ts is the camera-tracked alternative): metres in a y-up frame, orientation device → that
 * frame, origin where the thumb went down.
 */
import { EARTH_TO_VIEW, qMul, qRotate, type Quat, type Vec3 } from '@obpal/core'

/** Earth (x east, y north, z up) to the POSE frame (y up): x stays, up becomes y, north becomes −z. */
export const EARTH_TO_POSE = EARTH_TO_VIEW

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: Vec3) => Math.sqrt(dot(a, a))

export class ImuTracker {
  /** Counts drives: each thumb-down starts a new origin. */
  gen = 0
  /** How far the phone swings from its pivot (m). */
  reach = 0.45
  /** Push and pull from the accelerometer. */
  useAccel = true
  private axis: Vec3 = [0, 0, -1]
  private dir0: Vec3 = [0, 0, -1]
  private push = 0
  private speed = 0
  private stillMs = 0
  private anchored = false

  /** The thumb went down: the phone's pose now is the origin, and whichever way it points is forward. */
  anchor(q: Quat) {
    // Held upright (screen toward the person), the back points; held flat like a remote, the top edge does.
    const normal = qRotate(q, [0, 0, 1])
    this.axis = Math.abs(normal[1]) > 0.7 ? [0, 1, 0] : [0, 0, -1]
    this.dir0 = qRotate(q, this.axis)
    this.push = 0
    this.speed = 0
    this.stillMs = 0
    this.anchored = true
    this.gen = (this.gen + 1) & 0xff
  }

  /**
   * One sample. `q`: device → POSE frame. `accel`: linear acceleration in the POSE frame (m/s², gravity removed), or
   * null. `rate`: the gyro's angular speed (rad/s). `dt`: seconds since the last sample.
   */
  step(q: Quat, accel: Vec3 | null, rate: Vec3 | null, dt: number): Vec3 {
    if (!this.anchored) this.anchor(q)
    const dir = qRotate(q, this.axis)
    if (this.useAccel && accel && dt > 0) {
      // Along where it points. A swing pulls toward the pivot as it turns (ω²r): that isn't a pull, so take it off.
      const w = rate ? len(rate) : 0
      const wAlong = rate ? dot(rate, dir) : 0
      let a = dot(accel, dir) + (w * w - wAlong * wAlong) * this.reach
      if (Math.abs(a) < 0.35) a = 0
      const still = len(accel) < 0.3 && w < 0.4
      this.stillMs = still ? this.stillMs + dt * 1000 : 0
      if (this.stillMs > 60) this.speed = 0
      else this.speed = (this.speed + a * dt) * Math.exp(-1.2 * dt)
      this.push = Math.max(-0.35, Math.min(0.35, this.push + this.speed * dt))
    }
    return [
      this.reach * (dir[0] - this.dir0[0]) + this.push * dir[0],
      this.reach * (dir[1] - this.dir0[1]) + this.push * dir[1],
      this.reach * (dir[2] - this.dir0[2]) + this.push * dir[2],
    ]
  }

  /** The thumb lifted: the next thumb-down starts afresh. */
  release() { this.anchored = false }
}

/** A device-frame vector (the sensors' own axes, in the screen frame) turned into the POSE frame. */
export function toPoseFrame(qEarth: Quat, v: Vec3): Vec3 {
  return qRotate(qMul(EARTH_TO_POSE, qEarth), v)
}
