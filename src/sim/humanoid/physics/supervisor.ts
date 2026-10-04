/** Shared behaviour registry contract; arbitration and upper-body blending belong to the world lane. */
import type { ActuationFrame } from './contract'
import type { Intent } from './intent'
import type { Observation } from './observation'

/** Supervisor priority, highest first: getup, fall, recover, walk, balance, stance. */
export type BehaviourMode = 'getup' | 'fall' | 'recover' | 'walk' | 'balance' | 'stance'
export interface Behaviour {
  readonly mode: BehaviourMode
  canEnter(observation: Observation, intent: Intent): boolean
  /** Returns a complete request for the actor's single ActuationGate. */
  step(observation: Observation, intent: Intent): ActuationFrame
  done(observation: Observation, intent: Intent): boolean
}
export type BehaviourRegistry = ReadonlyMap<BehaviourMode, Behaviour>
