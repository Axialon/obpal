import { Quaternion, Vector3, type Camera, type Object3D } from 'three'
import { HandGesture } from '@obpal/core'
import { CameraHandMotion, type CameraHand } from '../ui/hand-control'

/** The camera and the participant's own selected part, or the shared model for the lead. */
export interface ViewerHandContext {
  controls: {
    rotate(azimuth: number, polar: number, smooth?: boolean): unknown
    dolly(distance: number, smooth?: boolean): unknown
    readonly distance: number
  }
  camera: Camera
  target: Object3D | null
  orbit: boolean
  /** A live value takes a drag instead of moving its object. Returns whether its value changed. */
  live?: { width: number; height: number; move(dx: number, dy: number): boolean }
}

/** Hover until a clutch is held. A fist turns the world; a pinch takes the part under the cursor. */
export class ViewerHandInput {
  private motion = new CameraHandMotion()
  private drag = [0, 0]
  private pending = [0, 0, 0]
  private depth = 0
  private dollyDepth = 0
  private at = 0

  reset() { this.motion.reset(); this.drag = [0, 0]; this.pending = [0, 0, 0]; this.depth = this.dollyDepth = 0; this.at = 0 }

  step(hand: CameraHand | null, ctx: ViewerHandContext, now = performance.now()): boolean {
    const fist = !!hand && !!(hand.gestures & HandGesture.grip)
    const grab = !!hand && !fist && !!(hand.gestures & HandGesture.pinch)
    const key = fist && ctx.orbit ? 'orbit' : grab && ctx.target ? `grab:${ctx.target.uuid}` : null
    const move = this.motion.step(hand, key)
    if (!move) { this.reset(); return false }
    if (move.started) { this.drag = [0, 0]; this.pending = [0, 0, 0]; this.depth = this.dollyDepth = 0; this.at = now }
    const [x, y, z] = move.delta
    if (!grab) {
      this.depth += z
      const depth = Math.sign(this.depth) * Math.max(0, Math.abs(this.depth) - .015)
      this.pending[0] += -x * 7; this.pending[1] += y * 7; this.pending[2] += depth - this.dollyDepth
      this.dollyDepth = depth
      const alpha = 1 - Math.exp(-Math.max(0, now - this.at) / 45)
      const step = this.pending.map(n => n * alpha)
      this.pending = this.pending.map((n, i) => n - step[i]); this.at = now
      if (Math.abs(step[0]) + Math.abs(step[1]) > 1e-8) void ctx.controls.rotate(step[0], step[1], false)
      if (Math.abs(step[2]) > 1e-8) void ctx.controls.dolly(ctx.controls.distance * (1 - Math.exp(-step[2] * 2.5)), false)
      return true
    }
    const target = ctx.target!
    const camera = ctx.camera.getWorldQuaternion(new Quaternion())
    const before = target.getWorldPosition(new Vector3())
    const after = before.clone().add(new Vector3(x, y, z).multiplyScalar(ctx.controls.distance * 1.2).applyQuaternion(camera))
    if (ctx.live) {
      const a = before.project(ctx.camera), b = after.project(ctx.camera)
      this.drag[0] += (b.x - a.x) * ctx.live.width / 2
      this.drag[1] += (a.y - b.y) * ctx.live.height / 2
      if (ctx.live.move(this.drag[0], this.drag[1])) this.drag = [0, 0]
    } else {
      const world = new Quaternion(...move.turn).premultiply(camera).multiply(camera.clone().invert()).multiply(target.getWorldQuaternion(new Quaternion()))
      target.position.copy(target.parent ? target.parent.worldToLocal(after) : after)
      target.quaternion.copy(target.parent ? target.parent.getWorldQuaternion(new Quaternion()).invert().multiply(world) : world)
    }
    return true
  }
}
