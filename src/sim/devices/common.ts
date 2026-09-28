/** Input and event plumbing for the catalogue's small machines. Physics stays in each device. */
import { Mode, PadButton } from '@obpal/core'
import { axis, clamp, DragStick } from './input'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'
import { driving } from '../vr/intent'

export abstract class Machine implements DeviceLogic {
  abstract readonly spec: DeviceSpec
  protected events: DeviceEvent[] = []
  abstract step(inputs: readonly (DeviceInput | null)[], dt: number): void
  abstract home(n: number): void
  abstract readout(n: number): string
  drain() {
    return this.events.splice(0)
  }
}

export const timestep = (dt: number) => (Number.isFinite(dt) ? clamp(dt, 0, 0.05) : 0)
export const action = (i: DeviceInput | null, id: string) =>
  !!i &&
  (i.presses.includes(id) ||
    i.presses.some((p) => ['wii-a', 'mouse-left', 'pad'].includes(p)) ||
    !!(i.padPressed & (1 << PadButton.A)))

/** Triggers are pedals; a gamepad's left stick or a trackpad's floating stick also drives. */
export function drive(i: DeviceInput | null, drag: DragStick, ackermann = false): [number, number] {
  if (!i) {
    drag.update(false, [0, 0])
    return [0, 0]
  }
  if (i.pad)
    return driving(i.controlFrame,
      axis(i.pad.axes[0]),
      Math.abs(i.pad.triggers[1] - i.pad.triggers[0]) > 0.02
        ? i.pad.triggers[1] - i.pad.triggers[0]
        : -axis(i.pad.axes[1]),
      i.face === 'face.wheel' || Math.abs(i.pad.triggers[1] - i.pad.triggers[0]) > 0.02, ackermann)
  const [x, y] = drag.update(i.touching, i.drag)
  return driving(i.controlFrame,
    clamp(x + (i.mode === Mode.tilt ? i.tilt[0] : 0), -1, 1),
    clamp(-y - (i.mode === Mode.tilt ? i.tilt[1] : 0), -1, 1),
    false, ackermann)
}

/** A circular body against a rectangular furnishing, with sliding along its outside. */
export function blocked(
  x: number,
  z: number,
  radius: number,
  boxes: readonly { x: number; z: number; w: number; d: number }[],
) {
  return boxes.some(
    (b) => Math.hypot(x - clamp(x, b.x - b.w / 2, b.x + b.w / 2), z - clamp(z, b.z - b.d / 2, b.z + b.d / 2)) < radius,
  )
}
