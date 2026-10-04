/** Scoped reuse preserves the mechanical response while targets change between coupled solves. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { constraintResponse, withConstraintResponseMemo } from '../src/sim/physics/constraint-response'
import { coupledServo } from '../src/sim/physics/coupled-servo'
import * as servo from '../src/sim/physics/servo'
import { fromRotationVector } from '../src/sim/physics/math'
import { STEP, validateScene, type ContactSample } from '../src/sim/physics/schema'
import { bodyStates, rodInput } from './humanoid-balance-cases'

function fixture(loaded = false) {
  const scene = validateScene(rodInput()), states = bodyStates(scene)
  const contacts: ContactSample[] = loaded ? [{ a: 'base', b: 'rod', pointA: { x: 0, y: -2, z: 0 },
    pointB: { x: 0, y: -2, z: 0 }, normalOnB: { x: 0, y: 1, z: 0 }, distance: .0005, impulse: 1 }] : []
  return { scene, states, contacts }
}
afterEach(() => vi.restoreAllMocks())

describe('scoped constraint response reuse', () => {
  it('assembles once for identical inputs inside the scope, while ordinary calls remain independent', () => {
    const { scene, states, contacts } = fixture(), inertia = vi.spyOn(servo, 'bodyInertia')
    withConstraintResponseMemo(scene, states, contacts, () => {
      const first = constraintResponse(scene, states, contacts), second = constraintResponse(scene, states, contacts)
      expect(first).toEqual(second)
      expect(first.matrix[0][0]).toBeCloseTo(1 / 4.04, 12) // Independently calculated anchored rod inertia.
      expect(inertia).toHaveBeenCalledTimes(1)
    })
    constraintResponse(scene, states, contacts); constraintResponse(scene, states, contacts)
    expect(inertia).toHaveBeenCalledTimes(3)
  })

  it.each([false, true])('keeps two different target solves exactly equal to uncached solves (loaded=%s)', loaded => {
    const { scene, states, contacts } = fixture(loaded)
    const targets = [.08, -.2].map(x => new Map([['hinge', fromRotationVector({ x, y: .03, z: -.04 })]]))
    const reference = targets.map(target => coupledServo(scene, states, target, contacts, STEP))
    const before = structuredClone({ scene, states, contacts, targets })
    const actual = withConstraintResponseMemo(scene, states, contacts,
      () => targets.map(target => coupledServo(scene, states, target, contacts, STEP)))
    expect(actual).toEqual(reference)
    expect(actual[0].torques).not.toEqual(actual[1].torques)
    expect({ scene, states, contacts, targets }).toEqual(before)
  })

  it('does not let a caller poison cached matrix, gravity or diagnostics through returned arrays', () => {
    const { scene, states, contacts } = fixture(), reference = constraintResponse(scene, states, contacts)
    withConstraintResponseMemo(scene, states, contacts, () => {
      const first = constraintResponse(scene, states, contacts)
      first.matrix[0][0] = 1e20; first.matrix[1].push(7); first.gravityAcceleration[0] = 123; first.constraintRank = -1
      const second = constraintResponse(scene, states, contacts)
      expect(second).toEqual(reference)
      second.matrix.length = 0; second.gravityAcceleration.length = 0
      expect(constraintResponse(scene, states, contacts)).toEqual(reference)
    })
  })

  it('requires all three argument identities, and mismatched calls do not replace the scoped entry', () => {
    const { scene, states, contacts } = fixture(), inertia = vi.spyOn(servo, 'bodyInertia')
    withConstraintResponseMemo(scene, states, contacts, () => {
      const reference = constraintResponse(scene, states, contacts)
      expect(constraintResponse({ ...scene }, states, contacts)).toEqual(reference)
      expect(constraintResponse(scene, [...states], contacts)).toEqual(reference)
      expect(constraintResponse(scene, states, [...contacts])).toEqual(reference)
      expect(constraintResponse(scene, states, contacts)).toEqual(reference)
      expect(inertia).toHaveBeenCalledTimes(4)
    })
  })

  it('restores an outer memo after nesting and clears the current memo after exceptions', () => {
    const outer = fixture(), inner = fixture(true), inertia = vi.spyOn(servo, 'bodyInertia')
    withConstraintResponseMemo(outer.scene, outer.states, outer.contacts, () => {
      const reference = constraintResponse(outer.scene, outer.states, outer.contacts)
      expect(() => withConstraintResponseMemo(inner.scene, inner.states, inner.contacts, () => {
        constraintResponse(inner.scene, inner.states, inner.contacts)
        throw new Error('nested failure')
      })).toThrow('nested failure')
      expect(constraintResponse(outer.scene, outer.states, outer.contacts)).toEqual(reference)
      expect(inertia).toHaveBeenCalledTimes(2)
    })
    expect(() => withConstraintResponseMemo(outer.scene, outer.states, outer.contacts, () => {
      constraintResponse(outer.scene, outer.states, outer.contacts)
      throw new Error('outer failure')
    })).toThrow('outer failure')
    constraintResponse(outer.scene, outer.states, outer.contacts)
    expect(inertia).toHaveBeenCalledTimes(4)
  })

  it('rejects a promise result and leaves no memo active afterwards', () => {
    const { scene, states, contacts } = fixture(), inertia = vi.spyOn(servo, 'bodyInertia')
    expect(() => withConstraintResponseMemo(scene, states, contacts, () => {
      constraintResponse(scene, states, contacts)
      return Promise.resolve()
    })).toThrow(/synchronous/)
    constraintResponse(scene, states, contacts)
    expect(inertia).toHaveBeenCalledTimes(2)
  })

  const changes: [string, boolean, (f: ReturnType<typeof fixture>) => void][] = [
    ['mass', false, f => { f.scene.bodies[1].mass *= 2 }],
    ['declared inertia', false, f => { f.scene.bodies[1].inertia = { x: .5, y: .6, z: .7 } }],
    ['uniform shape', false, f => { if (f.scene.bodies[1].shape.kind === 'box') f.scene.bodies[1].shape.half.y = .8 }],
    ['gravity', false, f => { f.scene.gravity.x = 3 }],
    ['body position against a fixed contact point', true, f => { f.states[1].position.x = .2 }],
    ['body rotation', false, f => { f.states[1].rotation = fromRotationVector({ x: .1, y: 0, z: .2 }) }],
    ['joint anchor', false, f => { f.scene.joints[0].anchorChild.y = .8 }],
    ['separating velocity', true, f => { f.states[1].velocity.y = .03 }],
    ['sliding angular velocity', true, f => { f.states[1].angularVelocity.x = .03 }],
    ['contact load', true, f => { f.contacts[0].impulse = 0 }],
    ['contact prediction threshold', true, f => {
      f.scene.contact = { solverIterations: 16, allowedLinearError: .001, predictionDistance: .0001 }
    }],
    ['support friction', true, f => { f.scene.bodies[0].friction = 0 }],
  ]
  it.each(changes)('invalidates same-object changes to %s', (_name, loaded, change) => {
    const f = fixture(loaded)
    withConstraintResponseMemo(f.scene, f.states, f.contacts, () => {
      const before = constraintResponse(f.scene, f.states, f.contacts)
      change(f)
      const actual = constraintResponse(f.scene, f.states, f.contacts)
      const uncached = constraintResponse(f.scene, [...f.states], f.contacts)
      expect(actual).toEqual(uncached)
      expect(actual).not.toEqual(before)
    })
  })

  it('revalidates invalid mutations instead of serving the previous valid result', () => {
    const { scene, states, contacts } = fixture(true)
    withConstraintResponseMemo(scene, states, contacts, () => {
      const before = constraintResponse(scene, states, contacts)
      states[1].velocity.x = NaN
      expect(() => constraintResponse(scene, states, contacts)).toThrow(/body state/)
      states[1].velocity.x = 0; contacts[0].impulse = -1
      expect(() => constraintResponse(scene, states, contacts)).toThrow(/contact sample/)
      contacts[0].impulse = 1
      expect(constraintResponse(scene, states, contacts)).toEqual(before)
    })
  })
})
