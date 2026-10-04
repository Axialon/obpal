/** Phone intent becomes desired motion only. The gait still actuates exclusively through joint targets. */
import type { Intent as ControlIntent } from '../controls'
import type { Vec3 } from '../../physics/math'
import type { DeviceInput } from '../../devices/types'
import { classical, restIntent } from '../controls'

export interface Intent extends ControlIntent {
  /** One-tick requests. Push remains a journalled world disturbance, never an actuation target. */
  command?: 'stand' | 'getup' | 'push'
}

export interface LocomotionIntent {
  /** Desired world velocity in m/s; vertical motion is never requested. */
  velocity: Vec3
  yawRateRadps: number
  command?: Intent['command']
  preset?: Intent['preset']
}

/** Simulation defaults: stick deadzone is dimensionless; speeds are m/s; yaw rate is rad/s. */
export const INTENT_DEFAULTS = Object.freeze({ deadzone: .05, forwardMps: .5, backwardMps: .25,
  sidewaysMps: .25, yawRateRadps: 1,
  /** Simulation defaults, m: arena half-width and the outward-velocity taper before its edge. */
  wallM: 3.3, wallTaperM: .3 })

const clampAxis = (value: number) => Math.max(-1, Math.min(1, value))
/** The left stick drives forward/back and turn; trackpad/local controls share the same mapping. */
export function walkingIntent(input: DeviceInput | undefined): Intent {
  if (input?.quiet) return restIntent()
  const value = classical(input)
  return { ...value, x: 0, yaw: clampAxis(value.x + value.yaw), manual: Math.hypot(value.z, value.x + value.yaw) > INTENT_DEFAULTS.deadzone }
}
function wallVelocity(velocity: number, position: number): number {
  if (velocity * position <= 0) return velocity
  const remaining = INTENT_DEFAULTS.wallM - Math.abs(position)
  return velocity * Math.max(0, Math.min(1, remaining / INTENT_DEFAULTS.wallTaperM))
}

/** Negative stick Z is toe-ward (-Z at yaw zero). Translation and yaw have independent deadzones.
 * The soft wall reduces only outward desired velocity; it never clamps or writes the actor position.
 * Missing input rests without disabling balance; stand also cancels the upper-body preset request.
 */
export function mapIntent(intent: Intent | undefined, headingRad: number, position: Pick<Vec3, 'x' | 'z'>): LocomotionIntent {
  if (![headingRad, position.x, position.z].every(Number.isFinite)) throw new RangeError('Invalid intent heading or position')
  if (intent && ![intent.x, intent.z, intent.yaw].every(Number.isFinite)) throw new RangeError('Invalid intent axes')
  if (!intent || intent.command === 'stand') return { velocity: { x: 0, y: 0, z: 0 }, yawRateRadps: 0, command: intent?.command }
  let x = clampAxis(intent.x), z = clampAxis(intent.z)
  const radius = Math.hypot(x, z)
  if (radius <= INTENT_DEFAULTS.deadzone) { x = 0; z = 0 }
  else if (radius > 1) { x /= radius; z /= radius }
  x *= INTENT_DEFAULTS.sidewaysMps
  z *= z < 0 ? INTENT_DEFAULTS.forwardMps : INTENT_DEFAULTS.backwardMps
  const c = Math.cos(headingRad), s = Math.sin(headingRad), yaw = clampAxis(intent.yaw)
  return { velocity: { x: wallVelocity(c * x + s * z, position.x), y: 0,
    z: wallVelocity(-s * x + c * z, position.z) },
    yawRateRadps: Math.abs(yaw) <= INTENT_DEFAULTS.deadzone ? 0 : yaw * INTENT_DEFAULTS.yawRateRadps,
    command: intent.command, preset: intent.preset }
}
