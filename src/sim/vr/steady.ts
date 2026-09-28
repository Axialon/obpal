import { Euler, Quaternion, Vector3 } from 'three'
import { angleDelta } from './control-frame'

export interface CameraPose { p: Vector3; q: Quaternion }

/** Keep a seated workspace's horizontal coverage on a portrait screen. XR supplies its own projection. */
export function viewFov(aspect: number, workspace: boolean) {
  return workspace && aspect < 1 ? 360 / Math.PI * Math.atan(Math.tan(75 * Math.PI / 360) / Math.max(0.25, aspect)) : 75
}

/** Remove camera roll, including at the vertical approach of a wrist or beam. */
export function upright(q: Quaternion, level = false) {
  const e = new Euler().setFromQuaternion(q, 'YXZ')
  return new Quaternion().setFromEuler(new Euler(level ? 0 : e.x, e.y, 0, 'YXZ'))
}

/** Exponential filters have the same response at desktop and headset frame rates. */
export class SteadyPose {
  private pose: CameraPose | null = null
  reset() { this.pose = null }
  step(target: CameraPose, dt: number, positionRate = 18, turnRate = 12): CameraPose {
    if (!this.pose || this.pose.p.distanceTo(target.p) > 4) this.pose = { p: target.p.clone(), q: target.q.clone() }
    else {
      const t = Math.max(0, Math.min(dt, 0.1))
      this.pose.p.lerp(target.p, 1 - Math.exp(-positionRate * t))
      this.pose.q.slerp(target.q, 1 - Math.exp(-turnRate * t))
    }
    return { p: this.pose.p.clone(), q: this.pose.q.clone() }
  }
}

/** Drag look is temporary for a driver; snap turns and physical head pose remain deliberate offsets. */
export class RideLook {
  yaw = 0
  pitch = 0
  turn = 0
  held = false
  viewpoint = 0
  recenter() { this.yaw = this.pitch = this.turn = 0 }
  switch(count: number) { this.viewpoint = (this.viewpoint + 1) % Math.max(1, count); this.recenter() }
  snap(direction: number, degrees: number) { this.turn -= direction * degrees * Math.PI / 180 }
  step(dt: number, follows: boolean, moving: boolean) {
    if (follows && (!this.held || moving)) {
      const k = Math.exp(-Math.max(0, dt) * (moving ? 7 : 3))
      this.yaw = angleDelta(0, this.yaw) * k; this.pitch *= k
    }
  }
}
