import { describe, expect, it } from 'vitest'
import { GaitController, IN_PLACE_CONTROL, type GaitVelocity } from '../src/sim/humanoid/physics/gait'
import { restIntent } from '../src/sim/humanoid/controls'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, soleCorners, type PhysicalHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { ActuationGate, MAX_TARGET_RATE, type ActuationFrame } from '../src/sim/humanoid/physics/contract'
import { STEP, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { ZERO, angleBetween, clampCone, conjugate, fromRotationVector, multiply, rotate, type Quat } from '../src/sim/physics/math'

const walking = { velocity: { x: 0, y: 0, z: -.5 }, yawRateRadps: 0 }
const stopped = { velocity: { ...ZERO }, yawRateRadps: 0 }
const p = IN_PLACE_CONTROL
const preparationTicks = Math.round(p.preparationSeconds / STEP)
const transferTicks = Math.round((p.transferSeconds + p.dwellSeconds) / STEP)
const swingTicks = Math.round(p.swingSeconds / STEP)
const stopTicks = Math.round(p.stopSeconds / STEP)
const cycleTicks = transferTicks + swingTicks
const firstSwingTick = preparationTicks + transferTicks
const firstLandingTick = firstSwingTick + swingTicks
const yawOf = (q: Quat) => { const toe = rotate(q, { x: 0, y: 0, z: -1 }); return Math.atan2(-toe.x, -toe.z) }
const angleError = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))

/** Synthetic measured poses test controller contracts only; they make no native gait acceptance claim. */
function fixture(model: PhysicalHumanoid, load: readonly [number, number] = [1, 1], yaw = 0, footYaw?: readonly [number, number]): Observation {
  const rotation = fromRotationVector({ x: 0, y: yaw, z: 0 })
  const bodies: BodyState[] = model.scene.bodies.map(body => ({ ...body, position: rotate(rotation, body.position),
    rotation: multiply(rotation, body.rotation), sleeping: false }))
  if (footYaw) model.feet.forEach((id, index) => { bodies.find(body => body.id === id)!.rotation = fromRotationVector({ x: 0, y: footYaw[index], z: 0 }) })
  const contacts: ContactSample[] = model.feet.flatMap((id, index) => {
    const spec = model.scene.bodies.find(body => body.id === id)!, state = bodies.find(body => body.id === id)!
    return soleCorners({ ...spec, ...state }).map(point => ({ a: 'floor', b: id, pointA: { ...point, y: 0 }, pointB: { ...point, y: 0 },
      normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: load[index] }))
  })
  return observe(model, bodies, contacts, 1, 0)
}
function atTick(o: Observation, stateTick: number): Observation { return { ...o, stateTick, timeS: stateTick * STEP } }
function sequence(model: PhysicalHumanoid, yaw = 0) {
  const both = fixture(model, [1, 1], yaw), left = fixture(model, [0, 1], yaw), right = fixture(model, [1, 0], yaw)
  return (tick: number) => {
    const elapsed = Math.max(0, tick - preparationTicks), index = Math.floor(elapsed / cycleTicks)
    const swinging = tick >= preparationTicks && elapsed % cycleTicks >= transferTicks
    return atTick(swinging ? index % 2 ? right : left : both, tick)
  }
}
function controller(model: PhysicalHumanoid) { return new GaitController(model, 1, { mode: 'in-place' }) }
function run(c: GaitController, measured: (tick: number) => Observation, through: number, command: GaitVelocity = walking, from = 0) {
  let frame!: ActuationFrame
  for (let tick = from; tick <= through; tick++) frame = c.stepVelocity(measured(tick), command)
  return frame
}
function freeze(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.values(value).forEach(freeze); Object.freeze(value)
}

describe('in-place gait target contracts', () => {
  it.each(ALL_PHYSICAL_PROFILES)('%s keeps complete finite frames inside the unchanged gate through both scheduled swings', profile => {
    const model = buildHumanoid(profile), c = controller(model), gate = new ActuationGate(model, 1), measured = sequence(model)
    const balance = new BalanceController(model, 1), phases = new Set<string>(), swings = new Set<string>()
    const upper = model.scene.joints.filter(joint => !/_(thigh|shin|foot)$/.test(joint.child))
    const finalTick = preparationTicks + 2 * cycleTicks
    for (let tick = 0; tick <= finalTick; tick++) {
      const o = measured(tick), previous = gate.targets(), frame = c.stepVelocity(o, walking), accepted = gate.accept(frame)
      const diagnostics = c.diagnostics(); phases.add(diagnostics.phase)
      if (diagnostics.phase === 'lift') swings.add(diagnostics.swing)
      if (tick % 120 === 0 || tick === finalTick) {
        expect(frame).toMatchObject({ schema_version: 1, profileId: profile, actorId: model.actorId, generation: 1, tick, source: 'classical' })
        expect(Object.keys(frame.targets).sort()).toEqual(model.scene.joints.map(joint => joint.id).sort())
        expect(diagnostics.desiredVelocity).toEqual(ZERO)
        for (const joint of model.scene.joints) {
          const target = accepted.targets[joint.id]
          expect(Object.values(frame.targets[joint.id]).every(Number.isFinite)).toBe(true)
          expect(angleBetween(target, clampCone(target, joint.cone))).toBeLessThan(1e-8)
          expect(angleBetween(previous[joint.id], target)).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-9)
        }
        const balanced = balance.step(o).frame
        for (const joint of upper) expect(frame.targets[joint.id]).toEqual(balanced.targets[joint.id])
      }
    }
    expect([...phases].sort()).toEqual(['lift', 'start', 'strike'])
    expect([...swings].sort()).toEqual(['left', 'right'])
    const releaseTick = finalTick + 1
    for (let tick = releaseTick; tick < releaseTick + stopTicks; tick++) {
      gate.accept(c.stepVelocity(measured(tick), stopped))
      expect(c.done(measured(tick), restIntent())).toBe(false)
    }
    const stoppedObservation = measured(releaseTick + stopTicks)
    const stoppedFrame = c.stepVelocity(stoppedObservation, stopped)
    expect(stoppedFrame).toEqual(balance.step(stoppedObservation).frame)
    gate.accept(stoppedFrame)
    expect(c.done(stoppedObservation, restIntent())).toBe(true)
  }, 20_000) // Test wall-time budget, ms: thousands of fixed ticks share CPU with the native suites.

  it('preserves relative requests when the entire measured scene is rotated near either side of pi', () => {
    const model = buildHumanoid('keel-v1'), headings = [0, Math.PI - .003, -Math.PI + .003]
    const controllers = headings.map(() => controller(model)), observations = headings.map(yaw => sequence(model, yaw))
    for (let tick = 0; tick <= firstSwingTick + swingTicks / 2; tick++) {
      const frames = controllers.map((c, i) => c.stepVelocity(observations[i](tick), walking))
      if (tick % 120 !== 0) continue
      for (let i = 1; i < frames.length; i++) {
        expect(angleError(controllers[i].diagnostics().headingRad, headings[i])).toBeCloseTo(0, 10)
        for (const joint of model.scene.joints) expect(angleBetween(frames[0].targets[joint.id], frames[i].targets[joint.id])).toBeLessThan(1e-7)
      }
    }
  })

  it.each([-1, 1])('unwraps feet around a root heading on side %s of pi', sign => {
    const model = buildHumanoid('keel-v1'), c = controller(model)
    const o = fixture(model, [1, 1], sign * (Math.PI - .005), [Math.PI - .001, -Math.PI + .001])
    c.stepVelocity(o, walking)
    const d = c.diagnostics()
    expect(Math.abs(angleError(d.headingRad, sign * Math.PI))).toBeLessThan(1e-10)
    expect(Math.abs(d.torsoTorqueNm.y)).toBeLessThan(2)
  })

  it.each([-1, 1])('turns the airborne foot and torso in commanded direction %s across the yaw wrap', direction => {
    const model = buildHumanoid('keel-v1'), c = controller(model), initialYaw = direction * (Math.PI - .005)
    const measured = sequence(model, initialYaw), command = { velocity: { ...ZERO }, yawRateRadps: direction }
    run(c, measured, firstSwingTick - 1, command)
    expect(angleError(c.diagnostics().headingRad, initialYaw)).toBeCloseTo(0, 10)
    const tick = firstSwingTick + swingTicks / 2, frame = run(c, measured, tick, command, firstSwingTick)
    expect(direction * angleError(c.diagnostics().headingRad, initialYaw)).toBeGreaterThan(0)
    expect(direction * c.diagnostics().torsoTorqueNm.y).toBeGreaterThan(0)
    const ankle = model.scene.joints.find(joint => joint.child === model.parts.left_foot.bodyId)!, parent = measured(tick).bodies.find(body => body.id === ankle.parent)!
    const world = multiply(multiply(multiply(parent.rotation, ankle.frameParent), frame.targets[ankle.id]), conjugate(ankle.frameChild))
    expect(direction * angleError(yawOf(world), initialYaw)).toBeGreaterThan(0)
    expect(Math.abs(angleError(yawOf(world), initialYaw))).toBeLessThan(.2)
  })

  it('looks up observed feet by identity when their array order changes', () => {
    const model = buildHumanoid('morrow-v1'), ordered = controller(model), reversed = controller(model), measured = sequence(model)
    for (let tick = 0; tick <= firstLandingTick + 1; tick++) {
      const o = measured(tick), expected = ordered.stepVelocity(o, walking)
      const actual = reversed.stepVelocity({ ...o, feet: [...o.feet].reverse() }, walking)
      if (tick % 120 === 0 || tick === firstLandingTick + 1) {
        expect({ ...actual, targets: undefined }).toEqual({ ...expected, targets: undefined })
        for (const joint of model.scene.joints) expect(angleBetween(actual.targets[joint.id], expected.targets[joint.id])).toBeLessThan(1e-10)
        const a = reversed.diagnostics(), b = ordered.diagnostics()
        expect([a.phase, a.swing, a.steps]).toEqual([b.phase, b.swing, b.steps])
        expect(a.headingRad).toBeCloseTo(b.headingRad, 12)
        for (const field of ['torsoTorqueNm', 'stanceHipTorqueNm', 'swingHipTorqueNm'] as const)
          for (const axis of ['x', 'y', 'z'] as const) expect(a[field][axis]).toBeCloseTo(b[field][axis], 9)
      }
    }
  })

  it('finishes a released arc, confirms touchdown and recenters before Balance handoff', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), measured = sequence(model), balance = new BalanceController(model, 1)
    const releaseTick = firstSwingTick + Math.floor(swingTicks / 4)
    run(c, measured, releaseTick - 1)
    expect(c.diagnostics().phase).toBe('lift')
    const phases = new Set<string>()
    for (let tick = releaseTick; tick < firstLandingTick; tick++) {
      c.stepVelocity(measured(tick), stopped); phases.add(c.diagnostics().phase)
      expect(c.done(measured(tick), restIntent())).toBe(false)
    }
    expect([...phases].sort()).toEqual(['lift', 'strike'])
    const unloaded = fixture(model, [0, 1]), loaded = fixture(model)
    let tick = firstLandingTick
    for (let delay = 0; delay < 5; delay++, tick++) {
      const o = atTick(unloaded, tick)
      c.stepVelocity(o, stopped)
      expect(c.diagnostics()).toMatchObject({ phase: 'strike', swing: 'left', steps: 0 })
      expect(c.done(o, restIntent())).toBe(false)
    }
    // A single contact followed by unloading must not qualify the handoff.
    c.stepVelocity(atTick(loaded, tick++), stopped)
    expect(c.diagnostics().phase).toBe('strike')
    c.stepVelocity(atTick(unloaded, tick++), stopped)
    expect(c.diagnostics().phase).toBe('strike')
    c.stepVelocity(atTick(loaded, tick++), stopped)
    expect(c.diagnostics().phase).toBe('strike')
    const landed = atTick(loaded, tick)
    c.stepVelocity(landed, stopped)
    expect(c.diagnostics()).toMatchObject({ phase: 'start', phaseSeconds: 0 })
    expect(c.done(landed, restIntent())).toBe(false)
    const recenterTick = tick
    for (tick++; tick < recenterTick + stopTicks; tick++) {
      const o = atTick(loaded, tick)
      c.stepVelocity(o, stopped)
      expect(c.diagnostics().phaseSeconds).toBeCloseTo((tick - recenterTick) * STEP, 12)
      expect(c.done(o, restIntent())).toBe(false)
    }
    const centered = atTick(loaded, tick)
    expect(c.stepVelocity(centered, stopped)).toEqual(balance.step(centered).frame)
    expect(c.diagnostics().phase).toBe('idle')
    expect(c.done(centered, restIntent())).toBe(true)
    const next = atTick(loaded, tick + 1)
    expect(c.stepVelocity(next, walking)).toEqual(controller(model).stepVelocity(next, walking))
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0 })
  })

  it('recenters a released preparation or transfer and requires loaded feet and stop speed at handoff', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), o = fixture(model), balance = new BalanceController(model, 1)
    c.stepVelocity(atTick(o, 0), walking); c.stepVelocity(atTick(o, 1), walking)
    for (let tick = 2; tick < 2 + stopTicks; tick++) {
      const measured = atTick(o, tick)
      c.stepVelocity(measured, stopped)
      expect(c.diagnostics().phase).toBe('start')
      expect(c.done(measured, restIntent())).toBe(false)
    }
    let tick = 2 + stopTicks
    const moving = atTick({ ...o, comVelocity: { x: .2, y: 0, z: 0 } }, tick++)
    c.stepVelocity(moving, stopped)
    expect(c.done(moving, restIntent())).toBe(false)
    c.stepVelocity(atTick(fixture(model, [0, 1]), tick++), stopped)
    c.stepVelocity(atTick(o, tick++), stopped)
    expect(c.diagnostics().phase).toBe('start')
    const supported = atTick(o, tick)
    expect(c.stepVelocity(supported, stopped)).toEqual(balance.step(supported).frame)
    expect(c.done(supported, restIntent())).toBe(true)
  })

  it('restarts from the current measured pose when movement interrupts recentering', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), measured = sequence(model)
    run(c, measured, firstLandingTick + 1)
    const releaseTick = firstLandingTick + 2
    run(c, measured, releaseTick + Math.floor(stopTicks / 2), stopped, releaseTick)
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 1 })
    expect(c.diagnostics().phaseSeconds).toBeCloseTo(p.stopSeconds / 2, 12)
    const resumeTick = releaseTick + Math.floor(stopTicks / 2) + 1
    const resumed = atTick(fixture(model, [1, 1], -.9), resumeTick)
    expect(c.stepVelocity(resumed, walking)).toEqual(controller(model).stepVelocity(resumed, walking))
    expect(c.diagnostics()).toMatchObject({ phase: 'start', phaseSeconds: 0, steps: 0 })
    expect(c.diagnostics().headingRad).toBeCloseTo(-.9, 10)
    for (let tick = resumeTick + 1; tick <= resumeTick + firstSwingTick; tick++)
      c.stepVelocity(atTick(fixture(model, [0, 1], -.9), tick), walking)
    expect(c.diagnostics()).toMatchObject({ phase: 'lift', swing: 'left', steps: 0 })
  })

  it('preserves the standing-height reference through successive interrupted stops', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), standing = fixture(model)
    let tick = 0
    for (; tick <= preparationTicks; tick++) c.stepVelocity(atTick(standing, tick), walking)
    for (const fraction of [.5, .75, .25]) {
      const crouched = fixture(model)
      crouched.bodies.find(body => body.id === model.root)!.position.y -= p.crouchM * fraction
      const releaseTick = tick
      for (; tick <= releaseTick + stopTicks / 2; tick++) c.stepVelocity(atTick(crouched, tick), stopped)
      const resumeTick = tick
      const initialFrame = c.stepVelocity(atTick(crouched, tick++), walking)
      // Restart begins at the measured height instead of jumping to the saved standing height.
      expect(initialFrame.targets).toEqual(controller(model).stepVelocity(atTick(crouched, resumeTick), walking).targets)
      let prepared!: ActuationFrame
      for (; tick <= resumeTick + preparationTicks; tick++) prepared = c.stepVelocity(atTick(crouched, tick), walking)
      const reference = controller(model)
      reference.stepVelocity(standing, walking)
      let expected!: ActuationFrame
      for (let sample = 1; sample <= preparationTicks; sample++) expected = reference.stepVelocity(atTick(crouched, sample), walking)
      // The same original standing height gives the same final leg requests; crouch must not accumulate.
      for (const joint of model.scene.joints)
        expect(angleBetween(prepared.targets[joint.id], expected.targets[joint.id])).toBeLessThan(1e-10)
    }
  })

  it('waits for measured stance support before lift without rewinding an already active swing', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model)
    const unsupported = fixture(model, [1, 0]), supported = fixture(model, [0, 1])
    let tick = 0
    for (; tick <= firstSwingTick + 5; tick++) {
      c.stepVelocity(atTick(unsupported, tick), walking)
      expect(c.diagnostics()).toMatchObject({ phase: 'start', swing: 'left', steps: 0 })
    }
    c.stepVelocity(atTick(supported, tick++), walking)
    expect(c.diagnostics().phase).toBe('start')
    c.stepVelocity(atTick(unsupported, tick++), walking)
    c.stepVelocity(atTick(supported, tick++), walking)
    expect(c.diagnostics().phase).toBe('start')
    c.stepVelocity(atTick(supported, tick++), walking)
    expect(c.diagnostics().phase).toBe('lift')
    const startedAt = c.diagnostics().phaseSeconds
    c.stepVelocity(atTick(unsupported, tick), walking)
    expect(c.diagnostics().phase).toBe('lift')
    expect(c.diagnostics().phaseSeconds).toBeGreaterThan(startedAt)
  })

  it('rejects malformed support before consuming a tick or poisoning cached foot references', () => {
    const model = buildHumanoid('keel-v1'), base = fixture(model)
    const corruptions: ((o: Observation) => void)[] = [
      o => { o.feet[1].centre.x = NaN },
      o => { o.feet[1].centreOfPressure!.z = Infinity },
      o => { o.feet[1].contactPoints[0].y = NaN },
      o => { o.feet[1].contactPoints = [] },
      o => { o.feet[1].normalImpulseNs = -1 },
      o => { o.feet[1].id = o.feet[0].id },
      o => { o.feet[1].id = 'unknown-foot' },
      o => { o.support.points[0].x = NaN },
      o => { o.support.polygon[0].z = Infinity },
      o => { o.floorContacts = [{ a: 'floor', b: model.feet[0], pointA: { ...ZERO }, pointB: { x: NaN, y: 0, z: 0 }, normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse: 1 }] },
    ]
    for (const corrupt of corruptions) {
      const c = controller(model), invalid = structuredClone(base), before = c.diagnostics(); corrupt(invalid)
      expect(() => c.stepVelocity(invalid, walking)).toThrow()
      expect(c.diagnostics()).toEqual(before)
      expect(c.stepVelocity(base, walking)).toEqual(controller(model).stepVelocity(base, walking))
      expect(() => c.stepVelocity(atTick(base, 1), walking)).not.toThrow()
    }
  })

  it('restarts from measured heading after a tick gap and does not reset on an invalid gap observation', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), measured = sequence(model)
    const lastTick = firstSwingTick + 10
    run(c, measured, lastTick)
    const resumeTick = lastTick + 20, resumed = atTick(fixture(model, [1, 1], -.9), resumeTick)
    const invalid = structuredClone(resumed); invalid.bodies[0].velocity.x = NaN
    const before = c.diagnostics()
    expect(() => c.stepVelocity(invalid, walking)).toThrow()
    expect(c.diagnostics()).toEqual(before)
    c.stepVelocity(measured(lastTick + 1), walking)
    expect(c.diagnostics().phase).toBe('lift')
    expect(c.stepVelocity(resumed, walking)).toEqual(controller(model).stepVelocity(resumed, walking))
    expect(c.diagnostics()).toMatchObject({ phase: 'start', steps: 0 })
    expect(c.diagnostics().headingRad).toBeCloseTo(-.9, 10)
  })

  it('does not mutate model, measurements, command or returned values while entering the swing', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), o = fixture(model, [0, 1]), command = structuredClone(walking)
    const before = structuredClone({ model, o, command }); freeze(model); freeze(o); freeze(command)
    let oldFrame!: ActuationFrame
    for (let tick = 0; tick <= firstSwingTick; tick++) oldFrame = c.stepVelocity(atTick(o, tick), command)
    const oldDiagnostics = c.diagnostics(), returnedBefore = structuredClone({ oldFrame, oldDiagnostics })
    c.stepVelocity(atTick(o, firstSwingTick + 1), command)
    expect({ model, o, command }).toEqual(before)
    expect({ oldFrame, oldDiagnostics }).toEqual(returnedBefore)
    oldDiagnostics.headingRad = 99
    expect(c.diagnostics().headingRad).not.toBe(99)
  })

  it('latches a measured-joint hold after falling and clears it only after a tick gap', () => {
    const model = buildHumanoid('keel-v1'), c = controller(model), gate = new ActuationGate(model, 1)
    const fallen = fixture(model); fallen.bodies.find(body => body.id === model.root)!.rotation = fromRotationVector({ x: 1, y: 0, z: 0 })
    for (let tick = 0; tick < 2; tick++) {
      const o = tick ? atTick(fixture(model), tick) : fallen, frame = c.stepVelocity(o, walking)
      expect(frame.source).toBe('hold')
      expect(frame.targets).toEqual(Object.fromEntries(o.joints.map(joint => [joint.id, joint.rotation])))
      expect(c.diagnostics().phase).toBe('idle'); gate.accept(frame)
    }
    const resumed = atTick(fixture(model, [1, 1], .6), 3)
    expect(c.stepVelocity(resumed, walking)).toEqual(controller(model).stepVelocity(resumed, walking))
    expect(c.diagnostics().phase).toBe('start')
    expect(c.diagnostics().headingRad).toBeCloseTo(.6, 10)
  })
})
