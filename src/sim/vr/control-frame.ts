import { Quaternion, Vector3 } from 'three'

/** Screen right, world up, and away from the viewer, in world metres. Pitch never shortens a ground-plane move. */
export class ControlFrame {
  readonly right = new Vector3(1, 0, 0)
  readonly forward = new Vector3(0, 0, -1)
  yaw = 0
  set(q: Quaternion) {
    // Using screen right also gives a stable heading when a wrist looks straight down.
    this.right.set(1, 0, 0).applyQuaternion(q); this.right.y = 0
    if (this.right.lengthSq() > 1e-8) this.right.normalize()
    else this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    this.forward.set(this.right.z, 0, -this.right.x)
    this.yaw = Math.atan2(-this.right.z, this.right.x)
    return this
  }
  move(right: number, up: number, forward: number, out = new Vector3()) {
    return out.copy(this.right).multiplyScalar(right).addScaledVector(this.forward, forward).setY(up)
  }
  /** Convert screen right/down on a ground plane to a device's x/z axes. */
  planar(x: number, z: number, heading = 0): [number, number] {
    const a = this.yaw - heading, c = Math.cos(a), s = Math.sin(a)
    return [c * x + s * z, -s * x + c * z]
  }
}

/** Keep the shortest turn at the -pi/pi seam. */
export const angleDelta = (from: number, to: number) => Math.atan2(Math.sin(to - from), Math.cos(to - from))

/** A constrained axis keeps its magnitude and takes the sign that points right on screen. */
export function screenAxis(frame: ControlFrame, x: number, z = 0) {
  const projection = frame.right.x * x + frame.right.z * z
  return Math.abs(projection) < 0.05 ? 1 : Math.sign(projection)
}
