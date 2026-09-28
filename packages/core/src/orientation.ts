/** Phone orientation in a fixed camera frame. All rotations are Hamilton quaternions, never Euler differences. */
import { qAxisAngle, qConj, qIdentity, qMul, qRotate, qSlerp, relativeInView, viewFrameAt, type Quat, type Vec3 } from './quat'

/** Earth (z up) to the tracking frame (y up, north along -z). */
export const EARTH_TO_VIEW = qAxisAngle(1, 0, 0, -Math.PI / 2)

/** The browser's screen frame, including the older iOS orientation property. */
export function deviceScreenAngle(): number {
  const angle = globalThis.screen?.orientation?.angle ?? (globalThis as { orientation?: number }).orientation ?? 0
  return ((angle % 360) + 360) % 360
}

/** A camera frame in y-up tracking space, with the same grip convention as W3C orientation. */
export function poseViewFrame(q: Quat): Quat {
  return qMul(EARTH_TO_VIEW, viewFrameAt(qMul(qConj(EARTH_TO_VIEW), q)))
}

/** A tracked phone's turn, expressed about camera right, up and toward the viewer. */
export function poseRelativeInView(q0: Quat, q: Quat): Quat {
  return relativeInView(q0, q, poseViewFrame(q0))
}

/** A tracking-space displacement about the same right, up and toward-viewer axes as a tracked phone's turn. */
export function poseVectorInView(q0: Quat, v: Vec3): Vec3 {
  return qRotate(qConj(poseViewFrame(q0)), v)
}

/**
 * A fixed view at engagement: right, gravity up, toward the person. Absolute and startup-relative alpha give the
 * same result. A screen change re-expresses the neutral in the new screen axes; it is not a physical turn or recenter.
 */
export class OrientationReference {
  private zero: Quat | null = null
  private view = qIdentity()
  private value = qIdentity()
  private screen = 0

  capture(q: Quat, screen = 0) { this.zero = [...q]; this.view = viewFrameAt(q); this.screen = screen; this.value = qIdentity() }
  reset() { this.zero = null; this.value = qIdentity() }

  /** Freeze the last output while the phone steers something else, without changing the original camera frame. */
  hold(q: Quat, screen = this.screen) {
    if (!this.zero) { this.capture(q, screen); return }
    this.zero = qMul(qMul(qMul(this.view, qConj(this.value)), qConj(this.view)), q)
    this.screen = screen
  }

  relative(q: Quat, screen = this.screen): Quat {
    if (!this.zero) this.capture(q, screen)
    if (screen !== this.screen) {
      this.zero = qMul(this.zero!, qAxisAngle(0, 0, 1, (this.screen - screen) * Math.PI / 180))
      this.screen = screen
    }
    const relative = relativeInView(this.zero!, q, this.view)
    // STATE's dial consumers expect the shortest turn, not a spurious 360 degrees from an antipodal sensor sample.
    this.value = relative[3] < 0 ? relative.map(v => -v) as Quat : relative
    return [...this.value]
  }
}

/**
 * Optional quaternion smoothing: one scalar weight along the shortest arc, with no axis-dependent distortion.
 * Zero seconds is exact sensor following. A positive time constant has an exponential, non-overshooting response.
 */
export class OrientationSmoother {
  private value: Quat | null = null
  constructor(public seconds = 0) {}
  reset() { this.value = null }
  filter(q: Quat, dt: number): Quat {
    this.value = !this.value || this.seconds <= 0 ? [...q] : qSlerp(this.value, q, -Math.expm1(-Math.max(0, dt) / this.seconds))
    return [...this.value]
  }
}

/** Gravity-based tray angles: right edge down is +x, top edge toward the person is +y. Heading cannot steer a tray. */
export function phoneTiltAngles(q0: Quat, q: Quat): [number, number] {
  const u0 = qRotate(qConj(q0), [0, 0, 1]), up = qRotate(qConj(q), [0, 0, 1])
  const right = qRotate(qConj(q0), qRotate(viewFrameAt(q0), [1, 0, 0]))
  const forward: Vec3 = [u0[1] * right[2] - u0[2] * right[1], u0[2] * right[0] - u0[0] * right[2], u0[0] * right[1] - u0[1] * right[0]]
  const dot = (a: Vec3, b: Vec3) => a.reduce((s, v, i) => s + v * b[i], 0)
  const c = dot(up, u0), d = 180 / Math.PI
  return [Math.atan2(-dot(up, right), c) * d, Math.atan2(dot(up, forward), c) * d]
}
