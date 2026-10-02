/** Simulation-only v1 targets; deliberately separate from BODY packets, driver arming and watchdogs. */
import { STEP } from '../../physics/schema'
import { clampCone, quaternion, angleBetween, rotationVector, multiply, conjugate, fromRotationVector, scale, type Quat } from '../../physics/math'
import type { PhysicalHumanoid } from './model'
export const MAX_TARGET_RATE = 4 // rad/s: original simulation-default slew limit, not a hardware rating.
export type ActionSource = 'classical' | 'body' | 'policy' | 'replay' | 'hold'
export interface ActuationFrame {
  schema_version: 1; profileId: string; actorId: string; generation: number; tick: number
  source: ActionSource; targets: Record<string, Quat>
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new RangeError('Expected a plain record')
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string') || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d)))
    throw new RangeError('Accessor or symbol properties are not allowed')
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value)
  if (actual.length !== expected.length || actual.some(k => !expected.includes(k))) throw new RangeError('Invalid actuation fields')
}
/** No queue or wall clock. Reordered, partial and stale frames reject before any accepted target changes. */
export class ActuationGate {
  private next: number
  private previous: Record<string, Quat>
  private readonly model: PhysicalHumanoid
  constructor(model: PhysicalHumanoid, readonly generation: number, startTick = 0, initial?: Record<string, Quat>) {
    if (!Number.isSafeInteger(generation) || generation < 1 || !Number.isSafeInteger(startTick) || startTick < 0) throw new RangeError('Invalid generation/tick')
    this.model = structuredClone(model); this.next = startTick
    this.previous = Object.fromEntries(model.scene.joints.map(j => [j.id, clampCone(quaternion(initial?.[j.id] ?? j.motor.target), j.cone)]))
  }
  targets(): Record<string, Quat> { return structuredClone(this.previous) }
  accept(value: unknown): ActuationFrame {
    record(value); keys(value, ['schema_version', 'profileId', 'actorId', 'generation', 'tick', 'source', 'targets'])
    if (value.schema_version !== 1 || value.profileId !== this.model.profileId || value.actorId !== this.model.actorId || value.generation !== this.generation)
      throw new RangeError('Actuation identity/generation mismatch')
    if (value.tick !== this.next || !Number.isSafeInteger(value.tick) || this.next === Number.MAX_SAFE_INTEGER) throw new RangeError('Actuation tick is stale or reordered')
    if (!['classical', 'body', 'policy', 'replay', 'hold'].includes(value.source as string)) throw new RangeError('Invalid action source')
    record(value.targets); const targets = value.targets
    keys(targets, this.model.scene.joints.map(j => j.id))
    const out = Object.fromEntries(this.model.scene.joints.map(j => {
      const input = targets[j.id]; record(input); keys(input, ['x', 'y', 'z', 'w'])
      const requested = clampCone(quaternion(input as unknown as Quat), j.cone), previous = this.previous[j.id]
      const delta = rotationVector(multiply(requested, conjugate(previous))), length = Math.hypot(delta.x, delta.y, delta.z)
      let fraction = Math.min(1, MAX_TARGET_RATE * STEP / Math.max(length, 1e-30)), next = previous
      // The asymmetric swing ellipse is not assumed geodesically convex. Back off if projection increases slew.
      for (let attempt = 0; attempt < 16; attempt++, fraction /= 2) {
        const candidate = clampCone(multiply(fromRotationVector(scale(delta, fraction)), previous), j.cone)
        if (angleBetween(previous, candidate) <= MAX_TARGET_RATE * STEP + 1e-10) { next = candidate; break }
      }
      return [j.id, { ...next }]
    }))
    this.previous = out; this.next++
    return { schema_version: 1, profileId: this.model.profileId, actorId: this.model.actorId, generation: this.generation,
      tick: value.tick as number, source: value.source as ActionSource, targets: structuredClone(out) }
  }
}
