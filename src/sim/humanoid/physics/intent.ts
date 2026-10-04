/** Shared phone input contract. Velocity and yaw-rate mapping belongs to the gait lane. */
import type { Intent as ControlIntent } from '../controls'

export interface Intent extends ControlIntent {
  /** One-tick requests. Push remains a journalled world disturbance, never an actuation target. */
  command?: 'stand' | 'getup' | 'push'
}
