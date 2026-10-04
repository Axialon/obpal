/** Behaviour arbitration and upper-body target blending. Native state belongs to the world, never this module. */
import type { ActuationFrame } from './contract'
import type { Intent } from './intent'
import type { Observation } from './observation'
import type { PhysicalHumanoid } from './model'
import type { GaitDiagnostics } from './gait'
import { StanceController } from './stance'
import { STEP } from '../../physics/schema'
import { conjugate, fromRotationVector, multiply, quaternion, rotationVector, scale, type Quat } from '../../physics/math'

/** Supervisor priority, highest first: getup, fall, recover, walk, balance, stance. */
export type BehaviourMode = 'getup' | 'fall' | 'recover' | 'walk' | 'balance' | 'stance'
export interface Behaviour {
  readonly mode: BehaviourMode
  /** The active mode is supplied only while its current behaviour has not finished. */
  canEnter(observation: Observation, intent: Intent, retainedMode?: BehaviourMode): boolean
  /** Returns a complete request for the actor's single ActuationGate. */
  step(observation: Observation, intent: Intent): ActuationFrame
  done(observation: Observation, intent: Intent): boolean
  gaitDiagnostics?(): GaitDiagnostics
}
export type BehaviourRegistry = ReadonlyMap<BehaviourMode, Behaviour>

export const BEHAVIOUR_PRIORITY: readonly BehaviourMode[] = Object.freeze(['getup', 'fall', 'recover', 'walk', 'balance', 'stance'])
export interface UpperBodyBlend {
  /** Partial or complete joint map; lower-body joints are left to the selected behaviour. */
  targets: Record<string, Quat>
  /** Final effective weight, after tracking, mode and margin weights. Dimensionless, in [0, 1]. */
  weight: number
  /** Presets use classical; omitted means BODY. */
  source?: 'body' | 'classical'
}
export interface UpperBodyAdapter {
  step(observation: Observation, intent: Intent, mode: BehaviourMode, frame: ActuationFrame): UpperBodyBlend | null
}
export interface SupervisorDiagnostics {
  mode: BehaviourMode; previousMode: BehaviourMode | null; transitioned: boolean
  upperBodyWeight: number; source: ActuationFrame['source']; tick: number
  gait: GaitDiagnostics | null
}
/** Shortest-arc slerp expressed in the joint frame. The gate still owns cones and slew. */
function blend(a: Quat, b: Quat, weight: number): Quat {
  if (weight === 0) return { ...a }
  if (weight === 1) return quaternion(b)
  return quaternion(multiply(fromRotationVector(scale(rotationVector(multiply(quaternion(b), conjugate(quaternion(a)))), weight)), quaternion(a)))
}

export class Supervisor {
  private readonly model: PhysicalHumanoid
  private readonly registry = new Map<BehaviourMode, Behaviour>()
  private readonly fallback: Behaviour
  private readonly upperJoints: Set<string>
  private active: Behaviour | null = null
  private upperBody: UpperBodyAdapter | null = null
  private lastDiagnostics: SupervisorDiagnostics | null = null
  constructor(model: PhysicalHumanoid, private readonly generation: number, registry?: BehaviourRegistry) {
    if (!Number.isSafeInteger(generation) || generation < 1) throw new RangeError('Invalid supervisor generation')
    this.model = structuredClone(model)
    const stance = new StanceController(model, generation)
    this.fallback = { mode: 'stance', canEnter: () => true, done: () => true, step: o => stance.step(o).frame }
    this.upperJoints = new Set(model.drives.filter(d => d.axes.every(axis => !axis.includes('.leg.'))).map(d => d.id))
    if (registry) for (const [mode, behaviour] of registry) {
      if (mode !== behaviour.mode) throw new RangeError('Behaviour registry mode mismatch')
      this.register(behaviour)
    }
  }
  get mode(): BehaviourMode { return this.active?.mode ?? 'stance' }
  diagnostics(): SupervisorDiagnostics | null { return this.lastDiagnostics ? structuredClone(this.lastDiagnostics) : null }
  /** Registry is owned by this supervisor; changing the caller's map cannot alter arbitration. */
  register(behaviour: Behaviour): void {
    if (!BEHAVIOUR_PRIORITY.includes(behaviour.mode) || typeof behaviour.canEnter !== 'function' || typeof behaviour.step !== 'function' || typeof behaviour.done !== 'function')
      throw new RangeError('Invalid behaviour')
    this.registry.set(behaviour.mode, behaviour)
  }
  setUpperBody(adapter: UpperBodyAdapter | null): void { this.upperBody = adapter }
  step(observation: Observation, intent: Intent): ActuationFrame {
    const model = this.model
    // 1e-10 s is a numerical timestamp comparison tolerance, not a freshness allowance.
    if (observation.schema_version !== 1 || observation.modelVersion !== model.version || observation.profileId !== model.profileId ||
      observation.actorId !== model.actorId || observation.generation !== this.generation || !Number.isSafeInteger(observation.stateTick) ||
      observation.stateTick < 0 || observation.stateTick === Number.MAX_SAFE_INTEGER || !Number.isFinite(observation.timeS) ||
      Math.abs(observation.timeS - observation.stateTick * STEP) > 1e-10) throw new RangeError('Supervisor observation identity/state mismatch')
    const previous = this.active, retained = previous && !previous.done(observation, intent)
    const limit = retained ? BEHAVIOUR_PRIORITY.indexOf(previous.mode) : BEHAVIOUR_PRIORITY.length
    let selected: Behaviour | null = null
    for (const mode of BEHAVIOUR_PRIORITY.slice(0, limit)) {
      const candidate = this.registry.get(mode)
      if (candidate?.canEnter(observation, intent, retained ? previous.mode : undefined)) { selected = candidate; break }
    }
    selected ??= retained ? previous : this.fallback
    const requested = selected.step(observation, intent)
    const jointIds = model.scene.joints.map(j => j.id)
    if (requested.schema_version !== 1 || requested.profileId !== model.profileId || requested.actorId !== model.actorId ||
      requested.generation !== this.generation || requested.tick !== observation.stateTick ||
      !['classical', 'body', 'policy', 'replay', 'hold'].includes(requested.source) ||
      Object.keys(requested.targets).length !== jointIds.length || jointIds.some(id => !Object.hasOwn(requested.targets, id)))
      throw new RangeError('Behaviour actuation identity/targets mismatch')
    const frame: ActuationFrame = { schema_version: 1, profileId: model.profileId, actorId: model.actorId, generation: this.generation,
      tick: observation.stateTick, source: requested.source, targets: Object.fromEntries(jointIds.map(id => [id, quaternion(requested.targets[id])])) }
    const upper = this.upperBody?.step(observation, intent, selected.mode, structuredClone(frame))
    let weight = 0
    if (upper) {
      weight = upper.weight
      if (!Number.isFinite(weight) || weight < 0 || weight > 1 || (upper.source !== undefined && !['body', 'classical'].includes(upper.source)) ||
        Object.keys(upper.targets).some(id => !jointIds.includes(id))) throw new RangeError('Invalid upper-body blend')
      for (const [id, target] of Object.entries(upper.targets)) if (this.upperJoints.has(id)) frame.targets[id] = blend(frame.targets[id], quaternion(target), weight)
      if (weight >= .5) frame.source = upper.source ?? 'body'
    }
    this.active = selected
    this.lastDiagnostics = { mode: selected.mode, previousMode: previous?.mode ?? null, transitioned: selected !== previous,
      upperBodyWeight: weight, source: frame.source, tick: observation.stateTick, gait: this.registry.get('walk')?.gaitDiagnostics?.() ?? null }
    return frame
  }
}
