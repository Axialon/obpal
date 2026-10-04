import { describe, expect, it } from 'vitest'
import { GaitController, IN_PLACE_CONTROL, type GaitVelocity } from '../src/sim/humanoid/physics/gait'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { restIntent } from '../src/sim/humanoid/controls'
import { buildHumanoid, soleCorners, type PhysicalHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { STEP, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { ZERO, angleBetween, fromRotationVector } from '../src/sim/physics/math'
import type { ActuationFrame } from '../src/sim/humanoid/physics/contract'

const forward: GaitVelocity = { velocity: { x: 0, y: 0, z: -.5 }, yawRateRadps: 0 }
const stopped: GaitVelocity = { velocity: { ...ZERO }, yawRateRadps: 0 }
const turn = (yawRateRadps = 1): GaitVelocity => ({ velocity: { ...ZERO }, yawRateRadps })
const preparationTicks = Math.round(IN_PLACE_CONTROL.preparationSeconds / STEP)
const stopTicks = Math.round(IN_PLACE_CONTROL.stopSeconds / STEP)
const firstSwingTicks = Math.round((IN_PLACE_CONTROL.preparationSeconds + IN_PLACE_CONTROL.transferSeconds + IN_PLACE_CONTROL.dwellSeconds) / STEP)
const turnTick = 16, balanceTick = turnTick + stopTicks, restartTick = balanceTick + preparationTicks

/** Fixed measured support tests lifecycle contracts only; it does not simulate or prove a physical step. */
function fixture(model: PhysicalHumanoid): Observation {
  const bodies: BodyState[] = model.scene.bodies.map(body => ({ ...body, sleeping: false }))
  const contacts: ContactSample[] = model.feet.flatMap(id => soleCorners(model.scene.bodies.find(body => body.id === id)!)
    .map(point => ({ a: 'floor', b: id, pointA: { ...point, y: 0 }, pointB: { ...point, y: 0 },
      normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: 1 })))
  return observe(model, bodies, contacts, 1, 0)
}
const atTick = (o: Observation, stateTick: number): Observation => ({ ...o, stateTick, timeS: stateTick * STEP })
const controller = (model: PhysicalHumanoid) => new GaitController(model, 1, { mode: 'in-place' })
function run(c: GaitController, o: Observation, from: number, through: number, command: GaitVelocity): ActuationFrame {
  let frame!: ActuationFrame
  for (let tick = from; tick <= through; tick++) frame = c.stepVelocity(atTick(o, tick), command)
  return frame
}
function pending(model: PhysicalHumanoid, o: Observation, through = balanceTick) {
  const c = controller(model)
  run(c, o, 0, turnTick - 1, forward)
  run(c, o, turnTick, through, turn())
  return c
}

describe('in-place forward-to-turn lifecycle', () => {
  it('starts an initial pure turn on the ordinary preparation and transfer schedule', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), c = controller(model)
    run(c, o, 0, firstSwingTicks - 1, turn())
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0 })
    c.stepVelocity(atTick(o, firstSwingTicks), turn())
    expect(c.diagnostics()).toMatchObject({ phase: 'lift', swing: 'left', steps: 0, phaseSeconds: 0 })
    c.stepVelocity(atTick(o, firstSwingTicks + 1), turn())
    expect(c.diagnostics().headingRad).toBeGreaterThan(0)
  })

  it.each([turnTick + 30, balanceTick + 30])('release at tick %s cancels a pending turn and hands off without starting it', releaseTick => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), c = pending(model, o, releaseTick - 1)
    const endTick = Math.max(balanceTick, releaseTick), balance = new BalanceController(model, 1)
    for (let tick = 0; tick < releaseTick; tick++) balance.step(atTick(o, tick))
    for (let tick = releaseTick; tick <= endTick; tick++) {
      const measured = atTick(o, tick), frame = c.stepVelocity(measured, stopped), expected = balance.step(measured).frame
      expect(c.diagnostics().headingRad).toBe(0)
      expect(c.done(measured, restIntent())).toBe(tick === endTick)
      if (tick === endTick) expect(frame).toEqual(expected)
    }
    expect(c.diagnostics().phase).toBe('idle')
    c.stepVelocity(atTick(o, endTick + 1), turn(-1))
    c.stepVelocity(atTick(o, endTick + 2), turn(-1))
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0, phaseSeconds: STEP })
  })

  it('returning to straight motion cancels the old wait and a later turn receives a fresh Balance interval', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), cancelTick = balanceTick + preparationTicks / 2
    const c = pending(model, o, cancelTick - 1)
    c.stepVelocity(atTick(o, cancelTick), forward)
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0, phaseSeconds: 0 })
    const nextTurnTick = cancelTick + 1, nextBalanceTick = nextTurnTick + stopTicks
    run(c, o, nextTurnTick, nextBalanceTick + 1, turn(-1))
    // The earlier wait must not let this new transition restart as soon as its recenter finishes.
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0, phaseSeconds: 0 })
    run(c, o, nextBalanceTick + 2, nextBalanceTick + preparationTicks + 1, turn(-1))
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0, phaseSeconds: STEP })
  })

  it('uses the latest signed turn command after recentering instead of the original turn request', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), c = pending(model, o, balanceTick)
    const before = structuredClone(o)
    const halfSwing = Math.round(IN_PLACE_CONTROL.swingSeconds / (2 * STEP))
    run(c, o, balanceTick + 1, restartTick + firstSwingTicks + halfSwing, turn(-.8))
    expect(c.diagnostics().phase).toBe('strike')
    expect(c.diagnostics().headingRad).toBeCloseTo(-.8 * IN_PLACE_CONTROL.turnStepRad / 4, 10)
    expect(o).toEqual(before)
  })

  it.each(['gap', 'fall'] as const)('%s discards the pending turn before a fresh measured-pose entry', reason => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), c = pending(model, o, balanceTick + 1)
    let tick = balanceTick + 2
    if (reason === 'fall') {
      const fallen = structuredClone(o)
      fallen.bodies.find(body => body.id === model.root)!.rotation = fromRotationVector({ x: 1, y: 0, z: 0 })
      for (const measured of [fallen, o]) {
        const frame = c.stepVelocity(atTick(measured, tick++), turn())
        expect(frame.source).toBe('hold')
        expect(frame.targets).toEqual(Object.fromEntries(measured.joints.map(joint => [joint.id, joint.rotation])))
      }
    }
    const resumed = atTick(o, tick + 1), fresh = controller(model)
    expect(c.stepVelocity(resumed, turn(-1))).toEqual(fresh.stepVelocity(resumed, turn(-1)))
    expect(c.stepVelocity(atTick(o, tick + 2), turn(-1))).toEqual(fresh.stepVelocity(atTick(o, tick + 2), turn(-1)))
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0, phaseSeconds: STEP })
  })

  it('an explicit recovery request replaces the pending turn with the requested recovery swing', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), c = pending(model, o, balanceTick + 1)
    c.beginRecovery({ ...o.feet[1].centre, z: o.feet[1].centre.z - .1 }, 'right', .32)
    c.stepVelocity(atTick(o, balanceTick + 2), turn(-1))
    expect(c.diagnostics()).toMatchObject({ phase: 'lift', swing: 'right', steps: 0, desiredVelocity: ZERO, recoveryExit: null })
    expect(c.diagnostics().phaseSeconds).toBe(0)
    c.stepVelocity(atTick(o, balanceTick + 3), turn(-1))
    expect(c.diagnostics().phaseSeconds).toBe(STEP)
  })

  it.each(['keel-v1', 'morrow-v1'] as const)('%s retains the original standing height when a pending turn starts from a lower measured pose', profile => {
    const model = buildHumanoid(profile), standing = fixture(model), crouched = structuredClone(standing)
    crouched.bodies.find(body => body.id === model.root)!.position.y -= IN_PLACE_CONTROL.crouchM * .75
    const c = controller(model)
    run(c, standing, 0, turnTick - 1, forward)
    const before = structuredClone(crouched)
    const result = run(c, crouched, turnTick, restartTick + preparationTicks, turn())
    const reference = controller(model)
    reference.stepVelocity(standing, turn())
    const expected = run(reference, crouched, 1, preparationTicks, turn())
    // Both paths request the same original-height crouch; the lower observation must not become another crouch offset.
    for (const joint of model.scene.joints.filter(joint => /_(thigh|shin|foot)$/.test(joint.child)))
      expect(angleBetween(result.targets[joint.id], expected.targets[joint.id])).toBeLessThan(1e-10)
    expect(crouched).toEqual(before)
  })
})
