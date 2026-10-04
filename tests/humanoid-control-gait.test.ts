import { describe, expect, it } from 'vitest'
import { GaitController, MeasuredSupportStop, GAIT_CONTROL, TURN_CONTROL, advanceGaitState, advanceStoppingGait, walkingGeometry, walkingControl, swingHipFeedback, gaitTargetEstimate, gaitFootSupported, type GaitState } from '../src/sim/humanoid/physics/gait'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { SinkSafeSupport, STEP_MIN_WIDTH_M } from '../src/sim/humanoid/physics/stepping'
import { restIntent } from '../src/sim/humanoid/controls'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, soleCorners, type PhysicalHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { jointFrame, jacobianTransposeTorque } from '../src/sim/humanoid/physics/targets'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { STEP, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { ZERO, angleBetween, clampCone, fromRotationVector, multiply, rotate, norm, sub, type Vec3, type Quat } from '../src/sim/physics/math'

const forward = { ...restIntent(), z: -1, manual: true }
const stop = { velocity: { ...ZERO }, yawRateRadps: 0 }
const lift = (): GaitState => ({ phase: 'lift', swing: 'left', ticks: 0, loadedTicks: 0, steps: 0 })
const startTicks = Math.round(GAIT_CONTROL.startSeconds / STEP)
const liftTicks = Math.round(GAIT_CONTROL.liftSeconds / STEP), strikeTicks = Math.round(GAIT_CONTROL.strikeSeconds / STEP)
// The controller qualifies touchdown at 85% of its lift/strike interpolation, after a real unload.
const recoveryHalfSeconds = .16, recoveryHalfTicks = Math.round(recoveryHalfSeconds / STEP)
const qualifiedTouchdownTick = recoveryHalfTicks + Math.ceil((2 * .85 - 1) * recoveryHalfSeconds / STEP)
/** Synthetic measured support exercises controller contracts, not native stability or walking acceptance. */
function fixture(model: PhysicalHumanoid, tick = 0, load: readonly [number, number] = [0, 1], yaw = 0): Observation {
  const rotation = fromRotationVector({ x: 0, y: yaw, z: 0 })
  const bodies: BodyState[] = model.scene.bodies.map(b => ({ ...b, position: rotate(rotation, b.position),
    rotation: multiply(rotation, b.rotation), sleeping: false }))
  const contacts: ContactSample[] = model.feet.flatMap((id, index) => {
    const spec = model.scene.bodies.find(b => b.id === id)!, state = bodies.find(b => b.id === id)!
    return soleCorners({ ...spec, ...state }).map(p => ({ a: 'floor', b: id, pointA: { ...p, y: 0 }, pointB: { ...p, y: 0 },
      normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: load[index] }))
  })
  return observe(model, bodies, contacts, 1, tick)
}
function atTick(o: Observation, stateTick: number): Observation { return { ...o, stateTick, timeS: stateTick * STEP } }
function transfer(o: Observation): Observation {
  const foot = o.feet[1].centre
  return { ...o, com: { x: o.com.x + .4 * (foot.x - o.com.x), y: o.com.y, z: o.com.z + .4 * (foot.z - o.com.z) } }
}
function vector(actual: Vec3, expected: Vec3) {
  for (const axis of ['x', 'y', 'z'] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 10)
}

describe('SIMBICON phase and feedback laws', () => {
  it('admits a support recenter only after two seconds, two distinct loaded ticks and flat feet', () => {
    const model = buildHumanoid('morrow-v1'), observation = fixture(model, 0, [1, 1])
    const nominal = new StanceController(model, 1).step(observation).frame
    const helper = new MeasuredSupportStop(model, 0, nominal.targets, observation.bodies.find(b => b.id === model.root)!.position.y)
    const support = new SinkSafeSupport(model.scene.bodies, model.feet)
    const step = (o: Observation) => helper.step(o, nominal, ZERO, support.update(o))
    step(observation); step(observation)
    expect(helper.canStop(atTick(observation, 500))).toBe(false)
    step(atTick(observation, 1))
    expect(helper.canStop(atTick(observation, 480))).toBe(false)
    expect(helper.canStop(atTick(observation, 481))).toBe(true)
    const unloaded = atTick(structuredClone(observation), 481); unloaded.feet[0].normalImpulseNs = 0
    expect(helper.canStop(unloaded)).toBe(false)
    step(unloaded); step(unloaded); expect(helper.canStop(unloaded)).toBe(false)
    step(atTick(observation, 482)); step(atTick(observation, 482))
    expect(helper.canStop(atTick(observation, 482))).toBe(false)
    step(atTick(observation, 483)); expect(helper.canStop(atTick(observation, 483))).toBe(true)
    const tilted = atTick(structuredClone(observation), 483)
    tilted.bodies.find(body => body.id === model.feet[0])!.rotation = fromRotationVector({ x: Math.PI / 180, y: 0, z: 0 })
    expect(helper.canStop(tilted)).toBe(false)
    const fast = atTick(structuredClone(observation), 483); fast.comVelocity.x = .100001
    expect(helper.canStop(fast)).toBe(false)
    step(atTick(observation, 500)); step(atTick(observation, 500))
    expect(helper.canStop(atTick(observation, 500))).toBe(false)
  })
  it('holds lift for the configured lift duration at 240 Hz even when the foot is loaded', () => {
    let state = lift()
    for (let tick = 0; tick < liftTicks - 1; tick++) { state = advanceGaitState(state, true, false); expect(state.phase).toBe('lift') }
    state = advanceGaitState(state, true, false)
    expect(state).toMatchObject({ phase: 'strike', swing: 'left', ticks: 0, loadedTicks: 0, steps: 0 })
  })
  it('times out an unloaded strike after the configured strike duration, switching side exactly once', () => {
    let state: GaitState = { ...lift(), phase: 'strike' }
    for (let tick = 0; tick < strikeTicks - 1; tick++) { state = advanceGaitState(state, false, false); expect(state.phase).toBe('strike') }
    state = advanceGaitState(state, false, false)
    expect(state).toMatchObject({ phase: 'lift', swing: 'right', ticks: 0, loadedTicks: 0, steps: 1 })
  })
  it('requires two consecutive loaded strike ticks and clears contact history on unloading', () => {
    let state: GaitState = { ...lift(), phase: 'strike' }
    state = advanceGaitState(state, false, false); expect(state.cleared).toBe(true)
    state = advanceGaitState(state, true, false); expect(state.loadedTicks).toBe(1)
    state = advanceGaitState(state, false, false); expect(state.loadedTicks).toBe(0)
    state = advanceGaitState(state, true, false); expect(state.phase).toBe('strike')
    state = advanceGaitState(state, true, false); expect(state.phase).toBe('lift'); expect(state.swing).toBe('right')
    expect(state.cleared).toBe(false)
  })
  it('does not mistake persistent initial contact for landing and retains the the configured strike duration strike timeout', () => {
    let state = lift()
    for (let tick = 0; tick < liftTicks; tick++) state = advanceGaitState(state, true, false)
    expect(state).toMatchObject({ phase: 'strike', cleared: false, loadedTicks: 0 })
    for (let tick = 0; tick < strikeTicks - 1; tick++) {
      state = advanceGaitState(state, true, false)
      expect(state.phase).toBe('strike'); expect(state.loadedTicks).toBe(0)
    }
    state = advanceGaitState(state, true, false)
    expect(state).toMatchObject({ phase: 'lift', swing: 'right', steps: 1, cleared: false })
  })
  it('remembers a lift-phase unload but starts a fresh consecutive landing count at strike', () => {
    let state = advanceGaitState(lift(), false, false)
    for (let tick = 1; tick < liftTicks; tick++) state = advanceGaitState(state, true, false)
    expect(state).toMatchObject({ phase: 'strike', cleared: true, loadedTicks: 0 })
    state = advanceGaitState(state, true, false)
    expect(state).toMatchObject({ phase: 'strike', loadedTicks: 1 })
    state = advanceGaitState(state, true, false)
    expect(state).toMatchObject({ phase: 'lift', swing: 'right', cleared: false, loadedTicks: 0 })
  })
  it('finishes a lifted foot before stopping and does not mutate the previous state', () => {
    const original = Object.freeze({ ...lift(), ticks: liftTicks - 1 })
    const strike = advanceGaitState(original, false, true)
    expect(strike.phase).toBe('strike'); expect(original.phase).toBe('lift'); expect(original.ticks).toBe(liftTicks - 1)
    const loadedOnce = advanceGaitState(strike, true, true)
    expect(loadedOnce.phase).toBe('strike')
    expect(advanceGaitState(loadedOnce, true, true).phase).toBe('idle')
  })
  it('never invents clearance when touchdown qualification is disabled but actual contact persists', () => {
    let state = lift()
    for (let tick = 0; tick < liftTicks; tick++) state = advanceGaitState(state, true, false, false)
    expect(state).toMatchObject({ phase: 'strike', cleared: false, loadedTicks: 0, steps: 0 })
    state = advanceGaitState(state, true, false, true)
    state = advanceGaitState(state, true, false, true)
    expect(state).toMatchObject({ phase: 'strike', cleared: false, loadedTicks: 0, steps: 0 })
  })
  it('records actual unloading before qualification but counts only consecutive qualified touchdown ticks', () => {
    let state: GaitState = { ...lift(), phase: 'strike' }
    state = advanceGaitState(state, false, false, false)
    expect(state).toMatchObject({ cleared: true, loadedTicks: 0 })
    for (let tick = 0; tick < 4; tick++) state = advanceGaitState(state, true, false, false)
    expect(state).toMatchObject({ phase: 'strike', cleared: true, loadedTicks: 0 })
    state = advanceGaitState(state, true, false, true)
    expect(state.loadedTicks).toBe(1)
    state = advanceGaitState(state, true, false, false)
    expect(state.loadedTicks).toBe(0)
    state = advanceGaitState(state, true, false, true)
    state = advanceGaitState(state, true, false, true)
    expect(state).toMatchObject({ phase: 'lift', swing: 'right', cleared: false, steps: 1 })
  })
  it('places the swing thigh further toe-ward for toe-ward COM displacement or excess speed', () => {
    const nominal = swingHipFeedback('lift', ZERO, ZERO, ZERO, 'left')
    const displaced = swingHipFeedback('lift', { x: 0, y: 0, z: -.2 }, ZERO, ZERO, 'left')
    const fast = swingHipFeedback('lift', ZERO, { x: 0, y: 0, z: -.5 }, ZERO, 'left')
    expect(nominal.sagittal).toBeCloseTo(.4, 12)
    expect(displaced.sagittal - nominal.sagittal).toBeCloseTo(.1, 12)
    expect(fast.sagittal - nominal.sagittal).toBeCloseTo(.1, 12)
    expect(swingHipFeedback('lift', ZERO, { x: 0, y: 0, z: -.5 }, { x: 0, y: 0, z: -.5 }, 'left').sagittal).toBeCloseTo(.4, 12)
    expect(swingHipFeedback('strike', ZERO, ZERO, ZERO, 'left').sagittal).toBe(0)
  })
  it('mirrors abduction and responds rightward to rightward COM error in either swing leg', () => {
    expect(swingHipFeedback('lift', ZERO, ZERO, ZERO, 'left').lateral).toBe(-.05)
    expect(swingHipFeedback('lift', ZERO, ZERO, ZERO, 'right').lateral).toBe(.05)
    for (const side of ['left', 'right'] as const) {
      const base = swingHipFeedback('lift', ZERO, ZERO, ZERO, side)
      const correction = swingHipFeedback('lift', { x: .2, y: 3, z: 0 }, { x: .5, y: 7, z: 0 }, ZERO, side)
      expect(correction.lateral - base.lateral).toBeCloseTo(.2, 12)
      expect(correction.sagittal).toBe(base.sagittal)
    }
  })
})

describe('gait reaction estimate uses the authoritative gate limits', () => {
  it.each(ALL_PHYSICAL_PROFILES)('%s matches gate updates near asymmetric cone boundaries and across quaternion signs', profile => {
    const model = buildHumanoid(profile)
    const seed = Object.fromEntries(model.scene.joints.map(j => [j.id, clampCone(multiply(
      fromRotationVector({ x: 0, y: j.cone.swingY * .7, z: j.cone.swingZ * .7 }),
      fromRotationVector({ x: j.cone.twistMax, y: 0, z: 0 })), j.cone)]))
    const gate = new ActuationGate(model, 1, 0, seed)
    const negative = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: -q.w })
    for (let tick = 0; tick < 24; tick++) {
      const previous = gate.targets()
      const requests = Object.fromEntries(model.scene.joints.map(j => {
        const side = tick % 4 < 2 ? 1 : -1, radius = [1 - 1e-6, 1 + 1e-6, 3][tick % 3]
        const y = side > 0 ? j.cone.swingY : j.cone.swingYMin ?? -j.cone.swingY
        const z = side > 0 ? j.cone.swingZMin ?? -j.cone.swingZ : j.cone.swingZ
        const q = multiply(fromRotationVector({ x: 0, y: y * radius / Math.SQRT2, z: z * radius / Math.SQRT2 }),
          fromRotationVector({ x: (side > 0 ? j.cone.twistMin : j.cone.twistMax) * radius, y: 0, z: 0 }))
        return [j.id, tick % 2 ? negative(q) : q]
      }))
      const snapshot = structuredClone({ previous, requests })
      const accepted = gate.accept({ schema_version: 1, profileId: model.profileId, actorId: model.actorId,
        generation: 1, tick, source: 'classical', targets: requests })
      for (const joint of model.scene.joints) for (const prior of [previous[joint.id], negative(previous[joint.id])]) {
        const estimate = gaitTargetEstimate(joint, prior, requests[joint.id])
        expect(Object.values(estimate).every(Number.isFinite)).toBe(true)
        expect(angleBetween(estimate, accepted.targets[joint.id])).toBeLessThan(1e-10)
        expect(angleBetween(prior, estimate)).toBeLessThanOrEqual(4 * STEP + 1e-9)
        expect(angleBetween(estimate, clampCone(estimate, joint.cone))).toBeLessThan(1e-9)
      }
      expect({ previous, requests }).toEqual(snapshot)
    }
  })
})

describe('gait foot support eligibility', () => {
  it('keeps a released foot in strike while airborne and hands off after two flat supported observations', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model, 0, [0, 1]), foot = o.feet[0], body = o.bodies.find(b => b.id === foot.id)!
    let state: GaitState = { ...lift(), phase: 'strike' }
    for (let tick = 0; tick < 3 * strikeTicks; tick++) state = advanceStoppingGait(state, foot, body, GAIT_CONTROL.liftSeconds)
    expect(state).toMatchObject({ phase: 'strike', cleared: true, steps: 0 })
    const loaded = fixture(model, 0, [1, 1]).feet[0]
    state = advanceStoppingGait(state, loaded, body, GAIT_CONTROL.liftSeconds)
    expect(state.phase).toBe('strike')
    state = advanceStoppingGait(state, loaded, body, GAIT_CONTROL.liftSeconds)
    expect(state).toMatchObject({ phase: 'idle', swing: 'right', steps: 1 })
  })
  it('hands a persistently loaded tilted landing to conform after 40 ms, but never invents an unload', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model, 0, [1, 1]), foot = o.feet[0]
    const body = { ...o.bodies.find(b => b.id === foot.id)!, rotation: fromRotationVector({ x: .04, y: 0, z: 0 }) }
    let state: GaitState = { ...lift(), phase: 'strike' }
    for (let tick = 0; tick < 100; tick++) state = advanceStoppingGait(state, foot, body, GAIT_CONTROL.liftSeconds)
    expect(state).toMatchObject({ phase: 'strike', cleared: false, steps: 0 })
    state = advanceStoppingGait(state, { ...foot, normalImpulseNs: 0 }, body, GAIT_CONTROL.liftSeconds)
    for (let tick = 0; tick < Math.ceil(.04 / STEP) - 1; tick++) {
      state = advanceStoppingGait(state, foot, body, GAIT_CONTROL.liftSeconds)
      expect(state.phase).toBe('strike')
    }
    expect(advanceStoppingGait(state, foot, body, GAIT_CONTROL.liftSeconds)).toMatchObject({ phase: 'idle', steps: 1 })
  })
  it('requires a two-dimensional footprint rather than duplicate or collinear manifold points', () => {
    expect(gaitFootSupported([])).toBe(false)
    expect(gaitFootSupported([ZERO, { x: .1, y: 0, z: .2 }])).toBe(false)
    expect(gaitFootSupported([ZERO, { ...ZERO }, { ...ZERO }, { x: .1, y: 0, z: .2 }])).toBe(false)
    expect(gaitFootSupported([ZERO, { x: .1, y: 0, z: .2 }, { x: .2, y: 0, z: .4 }])).toBe(false)
    // Vertical manifold offsets cannot give a line a floor footprint.
    expect(gaitFootSupported([ZERO, { x: .1, y: .003, z: .2 }, { x: .2, y: -.001, z: .4 }])).toBe(false)
  })
  it('accepts a triangular floor footprint with native manifold height variation and repeated points', () => {
    const points = [{ x: -.05, y: -.002, z: -.1 }, { x: .05, y: .001, z: -.1 }, { x: 0, y: .003, z: .1 }]
    const before = structuredClone(points)
    expect(gaitFootSupported(points)).toBe(true)
    expect(gaitFootSupported([...points].reverse())).toBe(true)
    expect(gaitFootSupported([points[0], points[0], ...points])).toBe(true)
    expect(points).toEqual(before)
  })
  it('rejects nonfinite manifold coordinates even if too few points could support the foot', () => {
    for (const axis of ['x', 'y', 'z'] as const) for (const value of [NaN, Infinity, -Infinity]) {
      const point = { ...ZERO, [axis]: value }
      expect(() => gaitFootSupported([point])).toThrow('Invalid gait foot manifold')
      expect(() => gaitFootSupported([ZERO, { x: .1, y: 0, z: .1 }, point])).toThrow('Invalid gait foot manifold')
    }
  })
  it('uses zero-moment conform on first loaded contact even with a line manifold or a rotating foot', () => {
    const model = buildHumanoid('keel-v1'), ankle = model.scene.joints.find(j => j.child === model.feet[1])!
    const request = (speed: number, points?: Vec3[]) => {
      const controller = new GaitController(model, 1), o = fixture(model)
      controller.beginRecovery({ x: -.2, y: 0, z: -.3 }, 'left')
      o.bodies.find(b => b.id === model.feet[1])!.angularVelocity = { x: 0, y: speed, z: 0 }
      if (points) o.feet[1].contactPoints = points
      return controller.stepVelocity(o, stop).targets[ankle.id]
    }
    expect(angleBetween(request(0), ankle.motor.target)).toBeLessThan(1e-10)
    expect(angleBetween(request(1), ankle.motor.target)).toBeLessThan(1e-10)
    expect(angleBetween(request(1 + 1e-6), ankle.motor.target)).toBeLessThan(1e-10)
    expect(angleBetween(request(0, [ZERO, ZERO, { x: .1, y: 0, z: .1 }]), ankle.motor.target)).toBeLessThan(1e-10)
  })
})

describe('gait target controller', () => {
  it('derives walking defaults from physical geometry independently of profile names and spawn translation', () => {
    for (const profile of ALL_PHYSICAL_PROFILES) {
      const model = buildHumanoid(profile), before = structuredClone(model), defaults = walkingGeometry(model)
      const translated = structuredClone(model); translated.profileId = 'renamed' as typeof translated.profileId
      for (const body of translated.scene.bodies) { body.position.x += 12; body.position.z -= 7 }
      expect(walkingGeometry(translated)).toEqual(defaults)
      expect(defaults.liftSeconds + defaults.strikeSeconds).toBeGreaterThanOrEqual(.63)
      expect(defaults.liftSeconds + defaults.strikeSeconds).toBeLessThanOrEqual(.70)
      expect(model).toEqual(before)
    }
    expect(walkingGeometry(buildHumanoid('keel-v1'))).toMatchObject({ liftSeconds: .27, strikeSeconds: .36, terminalVelocityFactor: 1 })
    expect(walkingGeometry(buildHumanoid('morrow-v1'))).toMatchObject({ liftSeconds: .30, strikeSeconds: .40, terminalVelocityFactor: 1.30 })
  })
  it('preserves straight walking and the long-leg endpoint while blending symmetric compact-leg turns', () => {
    for (const profile of ALL_PHYSICAL_PROFILES) {
      const geometry = walkingGeometry(buildHumanoid(profile)), straight = walkingControl(geometry, 0), fullTurn = walkingControl(geometry, 1)
      expect(straight).toEqual({ liftSeconds: geometry.liftSeconds, strikeSeconds: geometry.strikeSeconds,
        lateralReferenceM: geometry.lateralReferenceM, captureHorizonSeconds: GAIT_CONTROL.captureHorizonSeconds,
        swingClearanceM: GAIT_CONTROL.swingClearanceM, velocityForceGain: GAIT_CONTROL.velocityForceGain,
        periodicWidthM: STEP_MIN_WIDTH_M, momentumRetention: 0 })
      for (const yaw of [.01, .5, 1, 2]) {
        const turn = walkingControl(geometry, yaw)
        expect(walkingControl(geometry, -yaw)).toEqual(turn)
        if (geometry.legLengthM >= .84) expect(turn).toEqual(straight)
        for (const key of Object.keys(turn) as (keyof typeof turn)[]) {
          expect(turn[key]).toBeGreaterThanOrEqual(Math.min(straight[key], fullTurn[key]) - 1e-12)
          expect(turn[key]).toBeLessThanOrEqual(Math.max(straight[key], fullTurn[key]) + 1e-12)
        }
      }
    }
    const compact = walkingGeometry(buildHumanoid('morrow-v1'))
    expect(walkingControl(compact, 1)).toEqual(TURN_CONTROL)
    expect(walkingControl(compact, 2)).toEqual(TURN_CONTROL)
    // Periodic width controls angular momentum, not the physical non-crossing landing constraint.
    expect(TURN_CONTROL.periodicWidthM).toBeLessThan(STEP_MIN_WIDTH_M)
    expect(STEP_MIN_WIDTH_M).toBe(.20)
  })
  it.each(ALL_PHYSICAL_PROFILES)('%s emits complete finite gate frames through starts, both swings and stops', profile => {
    const model = buildHumanoid(profile), controller = new GaitController(model, 1), gate = new ActuationGate(model, 1)
    const nominal = Object.fromEntries(model.scene.joints.map(j => [j.id, j.motor.target]))
    const upper = model.scene.joints.filter(j => !/_(thigh|shin|foot)$/.test(j.child)), phases = new Set<string>(), swings = new Set<string>()
    const walkTicks = startTicks + liftTicks + strikeTicks
    const totalTicks = walkTicks + liftTicks + strikeTicks + Math.ceil(2 / STEP) + 4
    for (let tick = 0; tick < totalTicks; tick++) {
      const swing = controller.diagnostics().swing
      const strike = controller.diagnostics().phase === 'strike'
      const stopped = tick >= walkTicks && controller.diagnostics().phase === 'idle'
      const support: [number, number] = strike || stopped ? [1, 1] : swing === 'left' ? [0, 1] : [1, 0]
      const measured = fixture(model, tick, support), o = tick ? transfer(measured) : measured
      const request = controller.step(o, tick < walkTicks ? forward : restIntent())
      const previous = gate.targets(), accepted = gate.accept(request), diagnostics = controller.diagnostics()
      phases.add(diagnostics.phase); if (diagnostics.phase === 'lift') swings.add(diagnostics.swing)
      expect(Object.keys(request.targets).sort()).toEqual(Object.keys(nominal).sort())
      expect(accepted).toMatchObject({ schema_version: 1, profileId: profile, actorId: 'seat1', generation: 1, tick, source: 'classical' })
      for (const joint of model.scene.joints) {
        const target = accepted.targets[joint.id]
        expect(Object.values(request.targets[joint.id]).every(Number.isFinite)).toBe(true)
        expect(Math.hypot(target.x, target.y, target.z, target.w)).toBeCloseTo(1, 10)
        expect(angleBetween(target, clampCone(target, joint.cone))).toBeLessThan(1e-8)
        expect(angleBetween(previous[joint.id], target)).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-9)
      }
      for (const joint of upper) expect(request.targets[joint.id]).toEqual(nominal[joint.id])
    }
    expect([...phases].sort()).toEqual(['idle', 'lift', 'start', 'strike'])
    expect([...swings].sort()).toEqual(['left', 'right'])
    expect(controller.done(fixture(model, totalTicks), restIntent())).toBe(true)
  })
  it('hands idle zero motion to the existing balance controller', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), balance = new BalanceController(model, 1)
    for (let tick = 0; tick < 4; tick++) {
      const o = fixture(model, tick, [1, 1]); o.comVelocity = { x: .03, y: 0, z: -.02 }
      expect(controller.step(o, restIntent())).toEqual(balance.step(o).frame)
      expect(controller.diagnostics().phase).toBe('idle')
    }
  })
  it('requires a measured 40% COM transfer at start and selects the less loaded swing foot', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    const balanced = fixture(model, 0, [1, 1])
    for (let tick = 0; tick < startTicks; tick++) controller.step(atTick(balanced, tick), forward)
    expect(controller.diagnostics().phase).toBe('start')
    controller.step(fixture(model, startTicks, [0, 1]), forward)
    expect(controller.diagnostics().phase).toBe('start')
    controller.step(transfer(fixture(model, startTicks + 1, [0, 1])), forward)
    // This frame completes transfer; the following frame emits the first lift request.
    controller.step(transfer(fixture(model, startTicks + 2, [0, 1])), forward)
    expect(controller.diagnostics()).toMatchObject({ phase: 'lift', swing: 'left' })
    const right = new GaitController(model, 1)
    right.step(fixture(model, 0, [1, 0]), forward)
    expect(right.diagnostics().swing).toBe('right')
  })
  it('retains the minimum start duration even when the COM transfer is already measured', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    controller.step(fixture(model), forward)
    for (let tick = 1; tick < startTicks - 1; tick++) {
      controller.step(transfer(fixture(model, tick)), forward)
      expect(controller.diagnostics().phase).toBe('start')
    }
    controller.step(transfer(fixture(model, startTicks - 1)), forward)
    expect(controller.diagnostics().phase).toBe('start')
    controller.step(transfer(fixture(model, startTicks)), forward)
    expect(controller.diagnostics().phase).toBe('lift')
  })
  it('does not confuse turning the desired heading with completing the physical start transfer', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), o = fixture(model, 0, [1, 1])
    for (let tick = 0; tick < 480; tick++) {
      controller.step(atTick(o, tick), { ...restIntent(), yaw: 1, manual: true })
      expect(controller.diagnostics().phase).toBe('start')
    }
    expect(controller.diagnostics().headingRad).toBeCloseTo(GAIT_CONTROL.maxHeadingLeadRad, 10)
  })
  it('plants the final foot at strike, then balances until measured speed falls below 0.1 m/s', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    for (let tick = 0; tick <= startTicks; tick++) controller.step(tick ? transfer(fixture(model, tick)) : fixture(model, tick), forward)
    expect(controller.diagnostics().phase).toBe('lift')
    const measured = (tick: number, speed: number) => {
      const d = controller.diagnostics(), load: [number, number] = d.phase === 'strike' ? [1, 1] : d.swing === 'left' ? [0, 1] : [1, 0]
      const o = transfer(fixture(model, tick, load)); o.comVelocity = { x: speed, y: 0, z: 0 }; return o
    }
    const nextSwingTick = startTicks + liftTicks + strikeTicks
    for (let tick = startTicks + 1; tick < nextSwingTick; tick++) controller.stepVelocity(measured(tick, .1), stop)
    expect(controller.done(measured(nextSwingTick, .1), restIntent())).toBe(false)
    expect(controller.diagnostics().phase).toBe('idle')
    const o = measured(nextSwingTick, .1)
    expect(controller.stepVelocity(o, stop)).toEqual(new BalanceController(model, 1).step(o).frame)
    expect(controller.done(o, restIntent())).toBe(false)
    const slow = measured(nextSwingTick + 1, .099)
    controller.stepVelocity(slow, stop)
    expect(controller.done(slow, restIntent())).toBe(true)
  })
  it('starts from measured yaw and integrates turning once per tick while the pelvis follows', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), startYaw = .7
    for (let tick = 0; tick < 240; tick++) controller.stepVelocity(fixture(model, tick, [0, 1], startYaw + tick * STEP), { velocity: ZERO, yawRateRadps: 1 })
    expect(controller.diagnostics().headingRad).toBeCloseTo(startYaw + 1, 10)
    vector(controller.diagnostics().desiredVelocity, ZERO)
  })
  it('ramps the mapped velocity command at the declared acceleration in a fixed measured heading', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), yaw = .7
    let previous: Vec3 = { ...ZERO }
    for (let tick = 0; tick < 240; tick++) {
      controller.step(fixture(model, tick, [0, 1], yaw), forward)
      const velocity = controller.diagnostics().desiredVelocity
      expect(norm(sub(velocity, previous))).toBeLessThanOrEqual(GAIT_CONTROL.velocityAccelerationMps2 * STEP + 1e-12)
      previous = velocity
    }
    vector(previous, rotate(fromRotationVector({ x: 0, y: yaw, z: 0 }),
      { x: 0, y: 0, z: -Math.min(.5, GAIT_CONTROL.velocityAccelerationMps2) }))
  })
  it('brakes a released velocity command at the declared deceleration without reversing it', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    for (let tick = 0; tick < 120; tick++) controller.step(fixture(model, tick), forward)
    const initialSpeed = norm(controller.diagnostics().desiredVelocity)
    const brakingTicks = Math.ceil(initialSpeed / (GAIT_CONTROL.velocityDecelerationMps2 * STEP))
    let previous = initialSpeed
    for (let tick = 120; tick < 120 + brakingTicks + 1; tick++) {
      controller.stepVelocity(fixture(model, tick), stop)
      const velocity = controller.diagnostics().desiredVelocity, speed = norm(velocity)
      expect(speed).toBeLessThanOrEqual(previous + 1e-12)
      expect(previous - speed).toBeLessThanOrEqual(GAIT_CONTROL.velocityDecelerationMps2 * STEP + 1e-12)
      expect(velocity.z).toBeLessThanOrEqual(0)
      previous = speed
    }
    vector(controller.diagnostics().desiredVelocity, ZERO)
  })
  it('keeps unloaded thigh requests heading-equivariant and below 3 rad/s with authored joint bases', () => {
    const model = buildHumanoid('keel-v1')
    const controller = new GaitController(model, 1), straight = new GaitController(model, 1), yaw = .8
    controller.beginRecovery(rotate(fromRotationVector({ x: 0, y: yaw, z: 0 }), { x: -.2, y: 0, z: -.35 }), 'left')
    straight.beginRecovery({ x: -.2, y: 0, z: -.35 }, 'left')
    const joint = model.scene.joints.find(j => j.child === model.parts.left_thigh.bodyId)!
    let previous = fixture(model).joints.find(j => j.id === joint.id)!.rotation
    for (let tick = 0; tick < recoveryHalfTicks; tick++) {
      const frame = controller.stepVelocity(fixture(model, tick, [0, 1], yaw), stop)
      const reference = straight.stepVelocity(fixture(model, tick, [0, 1]), stop)
      expect(angleBetween(frame.targets[joint.id], reference.targets[joint.id])).toBeLessThan(1e-7)
      expect(angleBetween(previous, frame.targets[joint.id])).toBeLessThanOrEqual(.75 * MAX_TARGET_RATE * STEP + 1e-10)
      previous = frame.targets[joint.id]
    }
  })
  it('bounds the torso heading error and counteracts its requested yaw moment through the hips', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    let o = fixture(model, 0, [0, 1])
    for (let tick = 0; tick < startTicks + 48; tick++) {
      o = tick ? transfer(fixture(model, tick, [0, 1])) : fixture(model, tick, [0, 1])
      controller.stepVelocity(o, { velocity: { ...ZERO }, yawRateRadps: 1 })
    }
    const d = controller.diagnostics()
    expect(d.torsoTorqueNm.y).toBeCloseTo(GAIT_CONTROL.torsoStiffness * GAIT_CONTROL.maxHeadingLeadRad, 10)
    const hip = model.scene.joints.find(j => j.child === model.parts.right_thigh.bodyId)!, root = o.bodies.find(b => b.id === model.root)!
    const virtual = jacobianTransposeTorque(jointFrame(hip, root).position, o.com, d.stanceForceN, 'foot')
    // Requested estimates include the horizontal support moment; gravity has no world-y moment.
    expect(d.stanceHipTorqueNm.y + d.swingHipTorqueNm.y).toBeCloseTo(virtual.y - d.torsoTorqueNm.y, 10)
  })
  it('does not mutate the model, observation, command or previously returned diagnostics', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), o = fixture(model), command = structuredClone(forward)
    const before = structuredClone({ model, o, command }), diagnostics = controller.diagnostics(), previous = structuredClone(diagnostics)
    controller.step(o, command)
    expect({ model, o, command }).toEqual(before); expect(diagnostics).toEqual(previous)
    const output = controller.diagnostics(); output.desiredVelocity.x = 100
    expect(controller.diagnostics().desiredVelocity.x).not.toBe(100)
  })
  it('rejects stale ticks, identities, malformed observations and non-horizontal/nonfinite commands', () => {
    const model = buildHumanoid('keel-v1'), o = fixture(model), controller = new GaitController(model, 1)
    controller.step(o, forward)
    expect(() => controller.step(o, forward)).toThrow('tick must increase')
    for (const override of [{ actorId: 'seat2' }, { generation: 2 }, { profileId: 'morrow-v1' }, { modelVersion: 'unknown' },
      { schema_version: 2 }, { stateTick: 1, timeS: 0 }, { stateTick: .5 }, { comVelocity: { x: NaN, y: 0, z: 0 } }])
      expect(() => new GaitController(model, 1).step({ ...o, ...override } as Observation, forward)).toThrow()
    const duplicate = structuredClone(o); duplicate.joints.push(structuredClone(duplicate.joints[0]))
    expect(() => new GaitController(model, 1).step(duplicate, forward)).toThrow()
    const missing = structuredClone(o); missing.joints.pop()
    expect(() => new GaitController(model, 1).step(missing, forward)).toThrow()
    const malformed = structuredClone(o); malformed.joints[0].rotation.w = NaN
    expect(() => new GaitController(model, 1).step(malformed, restIntent())).toThrow()
    const angular = structuredClone(o); angular.bodies[0].angularVelocity.x = Infinity
    expect(() => new GaitController(model, 1).step(angular, forward)).toThrow()
    const linear = structuredClone(o); linear.bodies[0].velocity.z = NaN
    const validated = new GaitController(model, 1)
    expect(() => validated.step(linear, restIntent())).toThrow()
    expect(validated.step(o, restIntent()).tick).toBe(0)
    for (const velocity of [{ x: NaN, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: Infinity }])
      expect(() => new GaitController(model, 1).stepVelocity(o, { velocity, yawRateRadps: 0 })).toThrow('Invalid gait velocity')
    expect(() => new GaitController(model, 1).stepVelocity(o, { velocity: ZERO, yawRateRadps: NaN })).toThrow('Invalid gait velocity')
  })
  it('re-enters from measured support and heading after another behaviour consumed ticks', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    const nextTick = startTicks + 8, resumeTick = nextTick + 20
    for (let tick = 0; tick < nextTick; tick++) controller.step(tick ? transfer(fixture(model, tick)) : fixture(model, tick), forward)
    expect(controller.diagnostics().phase).toBe('lift')
    const invalid = fixture(model, resumeTick, [1, 0], -.4), before = controller.diagnostics()
    invalid.bodies[0].velocity.z = NaN
    expect(() => controller.step(invalid, forward)).toThrow()
    expect(controller.diagnostics()).toEqual(before)
    controller.step(transfer(fixture(model, nextTick)), forward)
    expect(controller.diagnostics().phase).toBe('lift')
    controller.step(fixture(model, resumeTick, [1, 0], -.4), forward)
    expect(controller.diagnostics()).toMatchObject({ phase: 'start', swing: 'right' })
    expect(controller.diagnostics().headingRad).toBeCloseTo(-.4, 10)
    vector(controller.diagnostics().desiredVelocity, rotate(fromRotationVector({ x: 0, y: -.4, z: 0 }),
      { x: 0, y: 0, z: -GAIT_CONTROL.velocityAccelerationMps2 * STEP }))
  })
  it('holds measured joints after a fall without automatically restarting, then resets after a tick gap', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), gate = new ActuationGate(model, 1)
    const hip = model.scene.joints.find(j => j.child === model.parts.left_thigh.bodyId)!
    controller.beginRecovery({ x: -.2, y: 0, z: -.35 }, 'left')
    for (let tick = 0; tick < 2; tick++) {
      const o = fixture(model, tick, [1, 1])
      if (!tick) o.bodies.find(b => b.id === model.root)!.rotation = fromRotationVector({ x: 1, y: 0, z: 0 })
      o.joints.find(j => j.id === hip.id)!.rotation = fromRotationVector({ x: 0, y: -.2 + tick * .05, z: 0 })
      const frame = controller.step(o, forward), previous = gate.targets(), accepted = gate.accept(frame)
      expect(frame.source).toBe('hold')
      expect(frame.targets).toEqual(Object.fromEntries(o.joints.map(j => [j.id, j.rotation])))
      expect(controller.diagnostics().phase).toBe('idle')
      for (const joint of model.scene.joints) {
        expect(Object.values(accepted.targets[joint.id]).every(Number.isFinite)).toBe(true)
        expect(angleBetween(previous[joint.id], accepted.targets[joint.id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
      }
    }
    const resumed = controller.step(fixture(model, 3, [1, 0], -.4), forward)
    expect(resumed.source).toBe('classical')
    expect(controller.diagnostics()).toMatchObject({ phase: 'start', swing: 'right', recoveryExit: null })
    expect(controller.diagnostics().headingRad).toBeCloseTo(-.4, 10)
    vector(controller.diagnostics().desiredVelocity, rotate(fromRotationVector({ x: 0, y: -.4, z: 0 }),
      { x: 0, y: 0, z: -GAIT_CONTROL.velocityAccelerationMps2 * STEP }))
  })
  it('only enters walking within the upright identity envelope and with requested motion', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), o = fixture(model)
    expect(controller.canEnter(o, forward)).toBe(true); expect(controller.canEnter(o, restIntent())).toBe(false)
    expect(controller.canEnter({ ...o, actorId: 'seat2' }, forward)).toBe(false)
    expect(controller.canEnter({ ...o, generation: 2 }, forward)).toBe(false)
    expect(controller.canEnter({ ...o, profileId: 'wrong-form' }, forward)).toBe(false)
    expect(controller.canEnter({ ...o, modelVersion: 'wrong-model' }, forward)).toBe(false)
    const fallen = structuredClone(o); fallen.bodies.find(b => b.id === model.root)!.rotation = fromRotationVector({ x: 1, y: 0, z: 0 })
    expect(controller.canEnter(fallen, forward)).toBe(false)
  })
  it('aims a recovery swing toward a copied landing without adding root displacement or forward intent', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), o = fixture(model)
    const landing = { x: -.2, y: 0, z: -.35 }
    controller.beginRecovery(landing, 'left'); landing.z = 10
    const frame = controller.stepVelocity(o, { velocity: { x: 0, y: 0, z: -.5 }, yawRateRadps: 1 }), diagnostics = controller.diagnostics()
    expect(diagnostics.phase).toBe('lift'); expect(diagnostics.swingHipRad.sagittal).toBeGreaterThan(0)
    vector(diagnostics.desiredVelocity, ZERO)
    expect(Object.keys(frame.targets).sort()).toEqual(model.scene.joints.map(j => j.id).sort())
    expect(() => controller.beginRecovery({ x: NaN, y: 0, z: 0 }, 'left')).toThrow('Invalid recovery landing')
  })

  it('cancels a measured support recenter before admitting fresh walking intent', () => {
    const model = buildHumanoid('morrow-v1'), controller = new GaitController(model, 1)
    const releaseTick = startTicks + liftTicks + strikeTicks
    let restartTick = -1
    for (let tick = 0; tick < releaseTick + 240; tick++) {
      const phase = controller.diagnostics().phase, swing = controller.diagnostics().swing
      const loads: [number, number] = phase === 'strike' || (tick >= releaseTick && phase === 'idle') ? [1, 1] : swing === 'left' ? [0, 1] : [1, 0]
      const measured = fixture(model, tick, loads), o = tick ? transfer(measured) : measured
      controller.step(o, tick < releaseTick ? forward : restIntent())
      if (tick >= releaseTick && controller.diagnostics().phase === 'idle' && !controller.done(o, restIntent())) {
        restartTick = tick + 1; break
      }
    }
    expect(restartTick).toBeGreaterThan(releaseTick)
    const restart = transfer(fixture(model, restartTick, [1, 1]))
    controller.step(restart, forward)
    expect(controller.diagnostics().phase).toBe('start')
    expect(controller.done(restart, forward)).toBe(false)
    const transferred = structuredClone(restart), stance = restart.feet[controller.diagnostics().swing === 'left' ? 1 : 0]
    transferred.com.x += GAIT_CONTROL.startShiftFraction * (stance.centre.x - transferred.com.x)
    for (let tick = restartTick + 1; tick <= restartTick + startTicks; tick++)
      controller.step(atTick(transferred, tick), forward)
    expect(controller.diagnostics().phase).toBe('lift')
  })
  it('starts a recovery after a completed walking stop instead of retaining the stop balance frame', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    let tick = 0
    for (; tick < startTicks + 2; tick++) controller.step(tick ? transfer(fixture(model, tick)) : fixture(model, tick), forward)
    expect(controller.diagnostics().phase).toBe('lift')
    controller.stepVelocity(fixture(model, tick++, [0, 1]), stop)
    for (let contact = 0; contact < 3; contact++) controller.stepVelocity(fixture(model, tick++, [1, 1]), stop)
    expect(controller.diagnostics()).toMatchObject({ phase: 'idle', steps: 1 })

    controller.beginRecovery({ x: .25, y: 0, z: -.35 }, 'right')
    const observation = fixture(model, tick, [1, 0])
    controller.stepVelocity(observation, stop)
    expect(controller.diagnostics()).toMatchObject({ phase: 'lift', swing: 'right', steps: 1, recoveryExit: null })
    expect(controller.done(observation, restIntent())).toBe(false)
  })
  it.each(['touchdown', 'timeout'] as const)('returns a single recovery attempt at qualified %s for the step planner to reassess', exit => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1), balance = new BalanceController(model, 1)
    controller.beginRecovery({ x: -.2, y: 0, z: -.35 }, 'left')
    const count = exit === 'touchdown' ? qualifiedTouchdownTick + 2 : 2 * recoveryHalfTicks
    const measured = (tick: number): Observation => {
      const o = fixture(model, tick, exit === 'touchdown' && tick >= recoveryHalfTicks ? [1, 1] : [0, 1])
      o.comVelocity = { x: .4, y: 0, z: -.5 }; return o
    }
    for (let tick = 0; tick < count; tick++) {
      const o = measured(tick)
      controller.stepVelocity(o, stop)
      expect(controller.done(o, restIntent())).toBe(tick === count - 1)
    }
    expect(controller.diagnostics().recoveryExit).toBe(exit)
    for (let tick = count; tick < count + 5; tick++) {
      const o = measured(tick), frame = controller.stepVelocity(o, stop)
      expect(frame).toEqual(balance.step(o).frame)
      expect(controller.diagnostics()).toMatchObject({ phase: 'idle', steps: 1, recoveryExit: exit })
      expect(controller.done(o, restIntent())).toBe(true)
    }
    controller.beginRecovery({ x: .25, y: 0, z: -.6 }, 'right')
    expect(controller.diagnostics().recoveryExit).toBeNull()
    controller.stepVelocity(measured(count + 5), stop)
    expect(controller.diagnostics()).toMatchObject({ phase: 'lift', swing: 'right', steps: 1, recoveryExit: null })
    expect(controller.done(measured(count + 5), restIntent())).toBe(false)
  })
  it('does not turn continuously loaded recovery contact into an early touchdown', () => {
    const model = buildHumanoid('keel-v1'), controller = new GaitController(model, 1)
    controller.beginRecovery({ x: -.2, y: 0, z: -.35 }, 'left')
    const totalTicks = 2 * recoveryHalfTicks
    for (let tick = 0; tick < totalTicks; tick++) {
      const o = fixture(model, tick, [1, 1])
      controller.stepVelocity(o, stop)
      expect(controller.done(o, restIntent())).toBe(tick === totalTicks - 1)
    }
    expect(controller.diagnostics().recoveryExit).toBe('timeout')
    controller.stepVelocity(fixture(model, totalTicks, [1, 1]), stop)
    expect(controller.diagnostics()).toMatchObject({ phase: 'idle', recoveryExit: 'timeout', steps: 1 })
  })
})
