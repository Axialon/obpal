/** Recovery strategy contracts use observed fixtures; native push rows establish physical acceptance separately. */
import { describe, expect, it } from 'vitest'
import { RecoveryController, RECOVERY_CONTROL, recoveryAnkleCapacity, recoveryStepSeconds } from '../src/sim/humanoid/physics/gait'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { buildHumanoid, soleCorners } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { landingTarget } from '../src/sim/humanoid/physics/stepping'
import { Supervisor, type Behaviour, type BehaviourMode } from '../src/sim/humanoid/physics/supervisor'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { restIntent } from '../src/sim/humanoid/controls'
import { STEP, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { ZERO, add, angleBetween, fromRotationVector, rotate, type Vec3 } from '../src/sim/physics/math'

const p = (x: number, z: number, y = 0): Vec3 => ({ x, y, z })
const rectangle = [p(-.2, -.1), p(.2, -.1), p(.2, .1), p(-.2, .1)]
function fixture(tick: number, velocity = ZERO): Observation {
  const model = buildHumanoid('keel-v1'), bodies: BodyState[] = model.scene.bodies.map(body => ({ ...body, sleeping: false }))
  const contacts: ContactSample[] = model.feet.flatMap(id => {
    const foot = model.scene.bodies.find(body => body.id === id)!
    return soleCorners(foot).map(point => ({ a: 'floor', b: id, pointA: { ...point, y: 0 }, pointB: { ...point, y: 0 },
      normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: 59.5 * 9.81 * STEP / 8 }))
  })
  const o = observe(model, bodies, contacts, 1, tick)
  o.comVelocity = { ...velocity }
  return o
}

describe('standing recovery capacity and timing', () => {
  it('uses directional margin and the 20 mm reserve in m omega margin', () => {
    const row = recoveryAnkleCapacity(rectangle, p(.05, 0, 1), p(.3, 0), 3, 60)
    expect(row.marginM).toBeCloseTo(.15, 12); expect(row.momentumNs).toBeCloseTo(18, 12)
    expect(row.capacityNs).toBeCloseTo(60 * 3 * (.15 - .02), 12)
    expect(recoveryAnkleCapacity(rectangle, p(.25, 0, 1), p(.3, 0), 3, 60).capacityNs).toBe(0)
  })
  it('preserves capacity under yaw, translation, reversed winding and duplicate points', () => {
    const q = fromRotationVector({ x: 0, y: .71, z: 0 }), shift = p(3, -2), transform = (point: Vec3) => add(shift, rotate(q, point))
    const row = recoveryAnkleCapacity([...rectangle, rectangle[0]].reverse().map(transform), transform(p(.05, 0, 1)), rotate(q, p(.3, 0)), 3, 60)
    expect(row.marginM).toBeCloseTo(.15, 12); expect(row.capacityNs).toBeCloseTo(23.4, 12)
  })
  it('shortens contact time for a larger capture excess without leaving 0.25–0.45 s', () => {
    expect(recoveryStepSeconds(0)).toBe(.32)
    expect(recoveryStepSeconds(.05)).toBeLessThan(recoveryStepSeconds(0))
    expect(recoveryStepSeconds(1)).toBe(.25)
    for (const error of [-1, NaN, Infinity]) expect(() => recoveryStepSeconds(error)).toThrow()
  })
  it('uses the adaptive contact time in exponential landing prediction and retains the default', () => {
    const input = { capturePoint: p(-.1, -.1), cop: ZERO, omega: 3, stanceAnkle: p(.1, 0), swing: 'left' as const,
      yawRad: 0, hipHeightM: 1, exitDirection: p(0, -1) }
    const nominal = landingTarget(input), fast = landingTarget({ ...input, stepTimeS: .25 })
    expect(nominal.predicted.z).toBeCloseTo(-.1 * Math.exp(3 * .32) - .03, 12)
    expect(fast.predicted.z).toBeCloseTo(-.1 * Math.exp(3 * .25) - .03, 12)
    for (const stepTimeS of [0, -1, NaN, Infinity]) expect(() => landingTarget({ ...input, stepTimeS })).toThrow()
  })
})

describe('standing recovery behaviour', () => {
  it('leaves supported class-A-sized momentum to exact balance targets and never preempts a walk command', () => {
    const model = buildHumanoid('keel-v1'), recovery = new RecoveryController(model, 1), balance = new BalanceController(model, 1)
    const o = fixture(0, p(0, -10 / 59.5))
    expect(recovery.canEnter(o, restIntent())).toBe(false)
    expect(recovery.step(o, restIntent())).toEqual(balance.step(o).frame)
    expect(recovery.canEnter(fixture(1, p(0, -1)), { ...restIntent(), z: -1, manual: true })).toBe(false)
  })
  it.each([{ x: .01 }, { yaw: .01 }, { x: .03, z: .03 }])('treats stick deadzone input %j as standing', axes => {
    const recovery = new RecoveryController(buildHumanoid('keel-v1'), 1)
    expect(recovery.canEnter(fixture(0, p(0, -.8)), { ...restIntent(), ...axes, manual: true })).toBe(true)
  })
  it('honours stand even when the previous movement axes remain set', () => {
    const recovery = new RecoveryController(buildHumanoid('keel-v1'), 1)
    expect(recovery.canEnter(fixture(0, p(0, -.8)), { ...restIntent(), x: 1, z: -1, yaw: 1, manual: true, command: 'stand' })).toBe(true)
  })
  it('retains an unfinished released walk and admits recovery after its handoff', () => {
    const model = buildHumanoid('keel-v1'), recovery = new RecoveryController(model, 1), balance = new BalanceController(model, 1)
    let walkDone = false
    const walk: Behaviour = { mode: 'walk', canEnter: () => true, done: () => walkDone, step: o => balance.step(o).frame }
    const supervisor = new Supervisor(model, 1, new Map<BehaviourMode, Behaviour>([['recover', recovery], ['walk', walk]]))
    supervisor.step(fixture(0), { ...restIntent(), z: -1, manual: true })
    expect(supervisor.mode).toBe('walk')
    supervisor.step(fixture(1, p(0, -.8)), restIntent())
    expect(supervisor.mode).toBe('walk')
    expect(recovery.diagnostics().active).toBe(false)
    walkDone = true
    supervisor.step(fixture(2, p(0, -.8)), restIntent())
    expect(supervisor.mode).toBe('recover')
    expect(recovery.diagnostics()).toMatchObject({ strategy: 'hip', active: true })
  })
  it.each(['balance', 'stance'] as const)('still preempts retained %s when standing capture needs recovery', mode => {
    const model = buildHumanoid('keel-v1'), recovery = new RecoveryController(model, 1), balance = new BalanceController(model, 1)
    const previous: Behaviour = { mode, canEnter: () => true, done: () => false, step: o => balance.step(o).frame }
    const supervisor = new Supervisor(model, 1, new Map<BehaviourMode, Behaviour>([['recover', recovery], [mode, previous]]))
    supervisor.step(fixture(0), restIntent())
    expect(supervisor.mode).toBe(mode)
    supervisor.step(fixture(1, p(0, -.8)), restIntent())
    expect(supervisor.mode).toBe('recover')
  })
  it('tries hip balance before a finite gated capture step and repeated reads do not advance time', () => {
    const model = buildHumanoid('keel-v1'), recovery = new RecoveryController(model, 1), gate = new ActuationGate(model, 1)
    const first = fixture(0, p(0, -.8))
    expect(recovery.canEnter(first, restIntent())).toBe(true)
    recovery.canEnter(first, restIntent()); recovery.done(first, restIntent())
    const before = gate.targets(), frame = recovery.step(first, restIntent()), accepted = gate.accept(frame)
    expect(recovery.diagnostics().strategy).toBe('hip')
    for (const id of Object.keys(before)) expect(angleBetween(before[id], accepted.targets[id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-9)
    for (let tick = 1; tick <= Math.ceil(RECOVERY_CONTROL.hipSeconds / STEP); tick++) {
      const o = fixture(tick, p(0, -.8)), previous = gate.targets()
      recovery.done(o, restIntent()); const result = gate.accept(recovery.step(o, restIntent()))
      for (const id of Object.keys(previous)) expect(angleBetween(previous[id], result.targets[id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-9)
    }
    expect(recovery.diagnostics()).toMatchObject({ strategy: 'step', plannedSteps: 1, completedSteps: 0, lastExit: null })
    expect(Object.values(recovery.diagnostics().landing!).every(Number.isFinite)).toBe(true)
  })
  it('does not enter from a fallen fixture or non-foot floor impulse and rejects stale identity', () => {
    const model = buildHumanoid('keel-v1'), recovery = new RecoveryController(model, 1), o = fixture(0, p(0, -1))
    o.bodies.find(body => body.id === model.root)!.position.y *= .7
    expect(recovery.canEnter(o, restIntent())).toBe(false)
    const hand = fixture(1, p(0, -1))
    hand.floorContacts = [{ a: 'floor', b: model.parts.thorax.bodyId, pointA: ZERO, pointB: ZERO, normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: .01 }]
    expect(recovery.canEnter(hand, restIntent())).toBe(false)
    expect(() => recovery.canEnter({ ...fixture(2), generation: 2 }, restIntent())).toThrow(/identity/)
  })
})
