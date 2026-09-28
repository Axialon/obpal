import { handMove, headingOf } from '@obpal/host'
import { Quaternion } from 'three'
import type { DeviceInput, DeviceLogic } from '../devices/types'
import { ControlFrame } from './control-frame'
import { deviceState } from './rigs'
import type { Experience } from './experience'
import { planar, type InputFrame } from './intent'
import { mapDeviceSpace } from '../devices/control-space'

/** Ratchet hand movement in the current view frame. Orbiting or switching seats cannot rotate an old displacement. */
export class HandFrame {
  private previous: number[] | null = null
  private position: [number, number, number] = [0, 0, 0]
  private heading = 0
  private orientation = new Quaternion()
  private generation = -1
  reset() { this.previous = null }
  map(pose: NonNullable<DeviceInput['pose']>, frame: InputFrame, recentred = false, relativeOrientation = true): NonNullable<DeviceInput['pose']> {
    if (!pose.tracked || !pose.touching || recentred) this.reset()
    if (!this.previous || pose.gen !== this.generation) {
      this.previous = [...pose.p]; this.position = [0, 0, 0]; this.heading = headingOf(pose.q); this.generation = pose.gen; this.orientation.set(...pose.q).invert()
    }
    const m = handMove([pose.p[0] - this.previous[0], pose.p[1] - this.previous[1], pose.p[2] - this.previous[2]], this.heading)
    const [x, z] = planar(frame, m.right, -m.forward)
    this.position = [this.position[0] + x, this.position[1] + m.up, this.position[2] + z]
    this.previous = [...pose.p]
    const align = new Quaternion(0, Math.sin((frame.yaw - this.heading) / 2), 0, Math.cos((frame.yaw - this.heading) / 2))
    const q = align.clone().multiply(new Quaternion(...pose.q))
    if (relativeOrientation) q.multiply(this.orientation)
    q.multiply(align.invert())
    return { ...pose, p: [...this.position], q: q.toArray() }
  }
}

/** The only render-to-logic hook. Device readers apply the frame to resolved intent, never to buttons or gain. */
export class ViewInputs {
  private hands = new Map<number, HandFrame>()
  constructor(private logic: DeviceLogic, private experience: Experience) {}
  map(input: DeviceInput, n: number, head?: readonly number[]): DeviceInput {
    const u = deviceState(this.logic, n), e = this.experience
    const immersive = !!head || e.immersive
    const yaw = head ? new ControlFrame().set(new Quaternion(...head)).yaw : e.controlFrame.yaw
    const frame: InputFrame = { yaw, heading: u.h ?? u.yaw ?? 0, immersive }
    const mapped = { ...input, controlFrame: frame }
    e.motionControl(!input.quiet && (!!input.space?.active || input.mode === 3 || !!input.hold || !!input.pose?.touching))
    if (['drone', 'claw', 'excavator', 'painter'].includes(this.logic.spec.id)) {
      let hand = this.hands.get(n)
      if (!hand) { hand = new HandFrame(); this.hands.set(n, hand) }
      if (input.pose && !(input.space && this.logic.spec.id === 'excavator')) mapped.pose = hand.map(input.pose, frame, input.recentred || input.positioned, ['drone', 'claw'].includes(this.logic.spec.id))
      else hand.reset()
    }
    return mapDeviceSpace(this.logic.spec.id, mapped, n)
  }
}
