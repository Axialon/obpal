/** The view supplies this small value to pure device logic. No rendering objects enter the simulation. */
export interface InputFrame { yaw: number; heading: number; immersive: boolean }

/** Screen x/right and z/toward the viewer, expressed in world or body coordinates. */
export function planar(frame: InputFrame | undefined, x: number, z: number, body = false): [number, number] {
  if (!frame || body && frame.immersive) return [x, z]
  const a = frame.yaw - (body ? frame.heading : 0), c = Math.cos(a), s = Math.sin(a)
  return [c * x + s * z, -s * x + c * z]
}

/** A steering vehicle turns toward a screen direction in overview. Pedals and immersive driving stay mechanical. */
export function driving(frame: InputFrame | undefined, steer: number, power: number, mechanical = false, ackermann = false): [number, number] {
  if (!frame || frame.immersive || mechanical) return [steer, power]
  const [x, z] = planar(frame, steer, -power, true), magnitude = Math.min(1, Math.hypot(x, z))
  if (magnitude < 1e-6) return [0, 0]
  const reverse = z > 0 ? -1 : 1
  const turn = Math.max(-1, Math.min(1, Math.atan2(x, Math.abs(z)) * 1.5))
  const alignment = Math.abs(z) / Math.hypot(x, z)
  // A differential body can face its destination before translating, avoiding an initial move across the wrong screen axis.
  const throttle = ackermann ? Math.max(0.25, alignment) : alignment > 0.85 ? alignment : 0
  // Wheel steering already changes yaw sign in reverse; differential steering does not.
  return [turn * (ackermann ? 1 : reverse), reverse * magnitude * throttle]
}

/** A single physical rail cannot strafe. Its positive direction follows its projection onto screen right. */
export function rail(frame: InputFrame | undefined, x = 1, z = 0) {
  if (!frame) return 1
  const projection = Math.cos(frame.yaw) * x - Math.sin(frame.yaw) * z
  return Math.abs(projection) < 0.05 ? 1 : Math.sign(projection)
}

/** The screen projection of the lens's pan tangent, also used by a separately aimed turret. */
export const panSign = (frame: InputFrame | undefined, heading: number) => rail(frame, Math.cos(heading), -Math.sin(heading))
