import { describe, expect, it, vi } from 'vitest'
import { Supervisor, BEHAVIOUR_PRIORITY, type Behaviour, type BehaviourMode } from '../src/sim/humanoid/physics/supervisor'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, targetsFromAngles } from '../src/sim/humanoid/physics/model'
import { observe } from '../src/sim/humanoid/physics/observation'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { ActuationGate, MAX_TARGET_RATE, type ActuationFrame } from '../src/sim/humanoid/physics/contract'
import { angleBetween, conjugate, fromRotationVector, multiply, rotationVector, scale } from '../src/sim/physics/math'
import { STEP } from '../src/sim/physics/schema'
import { restIntent } from '../src/sim/humanoid/controls'

const model = buildHumanoid('keel-v1'), intent = restIntent()
const observation = (tick = 0) => observe(model, model.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, tick)
const nominal = (tick = 0): ActuationFrame => ({ schema_version: 1, profileId: model.profileId, actorId: model.actorId,
  generation: 1, tick, source: 'classical', targets: Object.fromEntries(model.scene.joints.map(j => [j.id, { ...j.motor.target }])) })
function behaviour(mode: BehaviourMode, enter = true, done = false): Behaviour {
  return { mode, canEnter: vi.fn(() => enter), done: vi.fn(() => done), step: vi.fn(o => nominal(o.stateTick)) }
}

describe('humanoid supervisor', () => {
  it.each(ALL_PHYSICAL_PROFILES)('%s preserves the default stance request and produces a gate-compatible complete frame', profile => {
    const form = buildHumanoid(profile), o = observe(form, form.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, 0)
    const before = structuredClone({ form, o, intent }), supervisor = new Supervisor(form, 1)
    const frame = supervisor.step(o, intent)
    expect(frame).toEqual(new StanceController(form, 1).step(o).frame)
    expect(new ActuationGate(form, 1).accept(frame).source).toBe('classical')
    expect(supervisor.mode).toBe('stance')
    expect({ form, o, intent }).toEqual(before)
  })
  it('chooses every priority ahead of lower eligible modes, regardless of registration order', () => {
    for (let first = 0; first < BEHAVIOUR_PRIORITY.length; first++) {
      const candidates = BEHAVIOUR_PRIORITY.map((mode, i) => behaviour(mode, i >= first))
      const registry = new Map(candidates.slice().reverse().map(b => [b.mode, b]))
      const supervisor = new Supervisor(model, 1, registry)
      supervisor.step(observation(), intent)
      expect(supervisor.mode).toBe(BEHAVIOUR_PRIORITY[first])
      expect(candidates[first].step).toHaveBeenCalledTimes(1)
      candidates.filter((_, i) => i !== first).forEach(b => expect(b.step).not.toHaveBeenCalled())
    }
  })
  it('hands supported quiet stance to the unchanged controller, including its feedback biases', () => {
    const o = observation(), cop = { x: 0, y: 0, z: 0 }
    o.support.polygon = [{ x: -.25, y: 0, z: -.2 }, { x: .25, y: 0, z: -.2 }, { x: .25, y: 0, z: .2 }, { x: -.25, y: 0, z: .2 }]
    o.com.x = .01; o.comVelocity.z = .01
    for (const foot of o.feet) { foot.normalImpulseNs = 1; foot.centreOfPressure = { ...cop } }
    const controller = new StanceController(model, 1).step(o), actual = new Supervisor(model, 1).step(o, intent)
    expect(controller.diagnostics.phase).toBe('supported')
    expect(controller.diagnostics.maxAnkleBiasRad).toBeGreaterThan(0)
    for (const joint of model.scene.joints) expect(angleBetween(actual.targets[joint.id], controller.frame.targets[joint.id])).toBeLessThan(1e-12)
  })
  it('retains a behaviour until done even when its entry condition stops, then returns to stance', () => {
    const walk = behaviour('walk'), balance = behaviour('balance'), supervisor = new Supervisor(model, 1, new Map([['walk', walk], ['balance', balance]]))
    supervisor.step(observation(), intent)
    walk.canEnter = () => false
    supervisor.step(observation(1), intent)
    expect(supervisor.mode).toBe('walk')
    expect(balance.step).not.toHaveBeenCalled()
    walk.done = () => true
    supervisor.step(observation(2), intent)
    expect(supervisor.mode).toBe('balance')
    balance.done = () => true; balance.canEnter = () => false
    supervisor.step(observation(3), intent)
    expect(supervisor.mode).toBe('stance')
  })
  it('allows higher-priority preemption before the active behaviour is done', () => {
    const walk = behaviour('walk'), fall = behaviour('fall', false), supervisor = new Supervisor(model, 1, new Map([['walk', walk], ['fall', fall]]))
    supervisor.step(observation(), intent)
    fall.canEnter = () => true
    supervisor.step(observation(1), intent)
    expect(supervisor.mode).toBe('fall')
    expect(supervisor.diagnostics()).toMatchObject({ mode: 'fall', previousMode: 'walk', transitioned: true, tick: 1 })
    supervisor.step(observation(2), intent)
    expect(supervisor.diagnostics()?.transitioned).toBe(false)
    const diagnostics = supervisor.diagnostics()!; diagnostics.mode = 'walk'
    expect(supervisor.diagnostics()?.mode).toBe('fall')
  })
  it('owns the registry map and accepts later registrations without disturbing an active behaviour', () => {
    const walk = behaviour('walk'), registry = new Map<BehaviourMode, Behaviour>([['walk', walk]])
    const supervisor = new Supervisor(model, 1, registry)
    registry.clear()
    supervisor.step(observation(), intent)
    expect(supervisor.mode).toBe('walk')
    supervisor.register(behaviour('getup'))
    supervisor.step(observation(1), intent)
    expect(supervisor.mode).toBe('getup')
    expect(() => new Supervisor(model, 1, new Map([['fall', walk]]))).toThrow('mode mismatch')
  })
  it('rejects wrong observations before calling behaviours and wrong or partial frames before returning', () => {
    const walk = behaviour('walk'), supervisor = new Supervisor(model, 1, new Map([['walk', walk]]))
    for (const invalid of [{ actorId: 'seat2' }, { generation: 2 }, { modelVersion: 'other' }, { stateTick: -1 }, { timeS: .1 }])
      expect(() => supervisor.step({ ...observation(), ...invalid }, intent)).toThrow('observation identity')
    expect(walk.canEnter).not.toHaveBeenCalled()
    for (const invalid of [{ actorId: 'seat2' }, { generation: 2 }, { tick: 1 }, { targets: {} }]) {
      walk.step = () => ({ ...nominal(), ...invalid })
      expect(() => supervisor.step(observation(), intent)).toThrow('actuation identity')
    }
    expect(() => new Supervisor(model, 0)).toThrow('generation')
  })
  it('slerps upper joints only, gives BODY source at 0.5, and keeps the gate responsible for slew', () => {
    const supervisor = new Supervisor(model, 1), targets = targetsFromAngles(model, { 'left.arm.pitch': 1, 'spine.yaw': .3, 'left.leg.pitch': 1 })
    const arm = 'seat1_joint_left_upper_arm', leg = 'seat1_joint_left_thigh', base = nominal(), weight = .5
    supervisor.setUpperBody({ step: () => ({ targets, weight }) })
    const frame = supervisor.step(observation(), intent)
    const relative = rotationVector(multiply(targets[arm], conjugate(base.targets[arm])))
    const expected = multiply(fromRotationVector(scale(relative, weight)), base.targets[arm])
    expect(angleBetween(frame.targets[arm], expected)).toBeLessThan(1e-12)
    expect(frame.targets[leg]).toEqual(base.targets[leg])
    expect(frame.source).toBe('body')
    const gate = new ActuationGate(model, 1), accepted = gate.accept(frame)
    expect(angleBetween(accepted.targets[arm], base.targets[arm])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
    expect(angleBetween(frame.targets[arm], base.targets[arm])).toBeGreaterThan(MAX_TARGET_RATE * STEP)
    expect(Object.keys(frame)).toEqual(['schema_version', 'profileId', 'actorId', 'generation', 'tick', 'source', 'targets'])
  })
  it('blends the shortest arc for antipodal quaternions and copies the adapter frame', () => {
    const supervisor = new Supervisor(model, 1), base = nominal(), id = 'seat1_joint_head', q = base.targets[id]
    supervisor.setUpperBody({ step: (_o, _i, _mode, frame) => {
      frame.targets[id] = fromRotationVector({ x: 1, y: 0, z: 0 })
      return { targets: { [id]: { x: -q.x, y: -q.y, z: -q.z, w: -q.w } }, weight: .5 }
    } })
    expect(angleBetween(supervisor.step(observation(), intent).targets[id], q)).toBeLessThan(1e-12)
  })
  it('preserves presets and the lower BODY source threshold, removes adapters, and rejects root targets', () => {
    const supervisor = new Supervisor(model, 1), targets = nominal().targets
    supervisor.setUpperBody({ step: () => ({ targets, weight: .499 }) })
    expect(supervisor.step(observation(), intent).source).toBe('classical')
    supervisor.setUpperBody({ step: () => ({ targets, weight: 1, source: 'classical' }) })
    expect(supervisor.step(observation(1), intent).source).toBe('classical')
    supervisor.setUpperBody(null)
    expect(supervisor.step(observation(2), intent)).toEqual(new StanceController(model, 1).step(observation(2)).frame)
    for (const weight of [-1, 1.1, NaN]) {
      supervisor.setUpperBody({ step: () => ({ targets, weight }) })
      expect(() => supervisor.step(observation(3), intent)).toThrow('upper-body')
    }
    supervisor.setUpperBody({ step: () => ({ targets: { [model.root]: targets['seat1_joint_head'] }, weight: 1 }) })
    expect(() => supervisor.step(observation(3), intent)).toThrow('upper-body')
  })
})
