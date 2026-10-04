import { describe, expect, it } from 'vitest'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { GETUP, GetupController, fallDetected, fallPosture, getupFacing, loadedFloorContacts, settled, supportedBy } from '../src/sim/humanoid/physics/getup'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, targetsFromAngles } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { angleBetween, fromRotationVector, multiply, rotate, type Vec3 } from '../src/sim/physics/math'
import { STEP, type ContactSample } from '../src/sim/physics/schema'

// Synthetic state-machine fixtures only. Physical acceptance is in the separate Rapier pilot suite.
const model = buildHumanoid('keel-v1'), rest = { x: 0, z: 0, yaw: 0, manual: false }
function state(tick = 0): Observation {
  return { ...observe(model, model.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, tick), floorContacts: [] }
}
function prone(tick = 0) {
  const o = state(tick), q = fromRotationVector({ x: -Math.PI / 2, y: 0, z: 0 })
  for (const b of o.bodies) { b.rotation = q; b.position.y = .2 }
  o.com.y = .2; return o
}
const at = (o: Observation, tick: number) => ({ ...structuredClone(o), stateTick: tick, timeS: tick * STEP })
function contact(id: string, point: Vec3 = { x: 0, y: 0, z: 0 }, impulse = 1): ContactSample {
  return { a: 'floor', b: id, pointA: point, pointB: point, normalOnB: { x: 0, y: 1, z: 0 }, distance: 0, impulse }
}
const hands = () => ['left_hand', 'right_hand'].map(part => contact(model.parts[part].bodyId))
const square = [{ x: -.2, y: 0, z: -.2 }, { x: .2, y: 0, z: -.2 }, { x: .2, y: 0, z: .2 }, { x: -.2, y: 0, z: .2 }]

describe('get-up fall and contact conditions', () => {
  it('classifies thorax forward, with prone negative world X and no heading dependence', () => {
    const o = prone(); expect(fallPosture(model, o)).toBe('prone')
    o.bodies.find(b => b.id === model.parts.thorax.bodyId)!.rotation = fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 })
    expect(fallPosture(model, o)).toBe('supine')
    o.bodies.find(b => b.id === model.parts.thorax.bodyId)!.rotation = fromRotationVector({ x: 0, y: 1.3, z: 0 })
    expect(fallPosture(model, o)).toBe('side')
  })
  it('preserves toe-ward yaw through pitch beyond 90 degrees for pike COM feedback', () => {
    const yaw = fromRotationVector({ x: 0, y: .7, z: 0 }), expected = rotate(yaw, { x: 0, y: 0, z: -1 })
    for (const pitch of [-2.2, -Math.PI / 2, 0, 2.2]) {
      const actual = getupFacing(multiply(yaw, fromRotationVector({ x: pitch, y: 0, z: 0 })))
      expect(actual.x).toBeCloseTo(expected.x, 10); expect(actual.z).toBeCloseTo(expected.z, 10)
    }
  })
  it('detects tilted pelvis and low COM only when no step is possible', () => {
    expect(fallDetected(model, prone())).toBe(true)
    const o = state(); o.com.y = .1
    expect(fallDetected(model, o, true)).toBe(false); expect(fallDetected(model, o, false)).toBe(true)
    expect(new GetupController(model, 1, { stepPossible: () => true }).canEnter(o, rest)).toBe(false)
    expect(new GetupController(model, 1).canEnter(o, rest)).toBe(true)
  })
  it('uses non-foot floor impulses for falls, including edge normals, and excludes other actors', () => {
    const o = state(); o.floorContacts = [contact(model.feet[0])]; expect(fallDetected(model, o)).toBe(false)
    o.floorContacts = [contact('seat2_hand')]; expect(fallDetected(model, o)).toBe(false)
    o.floorContacts = [contact(model.parts.thorax.bodyId)]; o.floorContacts[0].normalOnB = { x: 1, y: 0, z: 0 }
    expect(fallDetected(model, o)).toBe(true)
  })
  it('requires COM velocity and every body angular velocity below the settle limits', () => {
    const o = prone(); expect(settled(o)).toBe(true)
    o.comVelocity.x = GETUP.settledSpeedMps; expect(settled(o)).toBe(false)
    o.comVelocity.x = 0; o.bodies.at(-1)!.angularVelocity.x = GETUP.settledAngularSpeedRadS; expect(settled(o)).toBe(false)
  })
  it('distinguishes unavailable contacts from measured zero support', () => {
    const o = state(); delete o.floorContacts; expect(loadedFloorContacts(model, o)).toBeNull()
    o.floorContacts = []; expect(loadedFloorContacts(model, o)?.size).toBe(0)
  })
  it('retains zero-pressure hull points only after positive net load and handles reversed manifolds', () => {
    const o = state(), id = model.parts.left_hand.bodyId
    o.floorContacts = [contact(id, square[0], 0)]; expect(loadedFloorContacts(model, o)?.size).toBe(0)
    o.floorContacts.push(contact(id, square[1]))
    const c = contact(id, square[2]); o.floorContacts.push({ ...c, a: c.b, b: c.a, normalOnB: { x: 0, y: -1, z: 0 } })
    expect(loadedFloorContacts(model, o)?.get(id)).toHaveLength(3)
    o.floorContacts.push({ ...contact(id), distance: .1 }, contact('seat2_hand'))
    expect(loadedFloorContacts(model, o)?.get(id)).toHaveLength(3)
  })
  it('requires a genuine two-dimensional convex support hull containing COM', () => {
    expect(supportedBy(square, { x: 0, y: 2, z: 0 })).toBe(true)
    expect(supportedBy(square, { x: .3, y: 0, z: 0 })).toBe(false)
    expect(supportedBy(square, square[0])).toBe(true)
    expect(supportedBy(square.slice(0, 2), square[0])).toBe(false)
  })
})

describe('get-up contact-gated phase graph', () => {
  it('holds for 0.5 s of continuous settling and honours the explicit get-up request', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick < 120; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().phase).toBe('settle')
    controller.step(at(o, 120), intent); expect(controller.diagnostics().phase).toBe('hands')
  })
  it('starts automatically after 1.5 s and a stable settle', () => {
    const controller = new GetupController(model, 1), o = prone()
    for (let tick = 0; tick < 360; tick++) controller.step(at(o, tick), rest)
    expect(controller.diagnostics().phase).toBe('settle')
    controller.step(at(o, 360), rest); expect(controller.diagnostics().phase).toBe('hands')
  })
  it('resets the settle hold when any body exceeds the angular speed limit', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick < 100; tick++) controller.step(at(o, tick), intent)
    const moving = at(o, 100); moving.bodies[0].angularVelocity.z = 1; controller.step(moving, intent)
    for (let tick = 101; tick < 221; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().phase).toBe('settle')
    controller.step(at(o, 221), intent); expect(controller.diagnostics().phase).toBe('hands')
  })
  it('cannot advance hands from height, missing manifolds or a single loaded hand', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick <= 120; tick++) controller.step(at(o, tick), intent)
    const missing = at(o, 121); delete missing.floorContacts; controller.step(missing, intent)
    expect(controller.diagnostics().contactsAvailable).toBe(false); expect(controller.diagnostics().phase).toBe('hands')
    const one = at(o, 122); one.floorContacts = hands().slice(0, 1); controller.step(one, intent)
    expect(controller.diagnostics().phase).toBe('hands')
    const both = at(o, 123); both.floorContacts = hands()
    for (let tick = 123; tick <= 240; tick++) controller.step(at(both, tick), intent)
    expect(controller.diagnostics().phase).toBe('all-fours')
  })
  it('requires both shins and pelvis height before toes, then feet support before pike and rise', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick <= 120; tick++) controller.step(at(o, tick), intent)
    const loaded = at(o, 121); loaded.floorContacts = hands()
    for (let tick = 121; tick <= 240; tick++) controller.step(at(loaded, tick), intent)
    loaded.floorContacts.push(...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId)))
    controller.step(at(loaded, 241), intent); expect(controller.diagnostics().phase).toBe('all-fours')
    loaded.bodies.find(b => b.id === model.root)!.position.y = .35
    for (let tick = 242; tick <= 360; tick++) controller.step(at(loaded, tick), intent)
    expect(controller.diagnostics().phase).toBe('toes')
    loaded.floorContacts = [...hands(), ...model.feet.flatMap(id => square.map(p => contact(id, p)))]
    for (let tick = 361; tick <= 480; tick++) controller.step(at(loaded, tick), intent)
    expect(controller.diagnostics().phase).toBe('pike')
    loaded.com.x = .3
    for (let tick = 481; tick <= 600; tick++) controller.step(at(loaded, tick), intent)
    expect(controller.diagnostics().phase).toBe('pike')
    loaded.com.x = 0; controller.step(at(loaded, 601), intent); expect(controller.diagnostics().phase).toBe('rise')
    expect(controller.done(at(loaded, 602), intent)).toBe(false)
  })
  it('retries a failed roll on the other side once and ends Down after two failed attempts', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    o.bodies.find(b => b.id === model.parts.thorax.bodyId)!.rotation = fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 })
    const sides: number[] = []
    let previousStart = -1
    for (let tick = 0; tick <= 2300; tick++) {
      controller.step(at(o, tick), intent)
      const d = controller.diagnostics(); if (d.phase === 'roll' && previousStart !== d.phaseStartedS) sides.push(d.rollSide)
      previousStart = d.phaseStartedS
    }
    expect(sides).toEqual([1, -1]); expect(controller.diagnostics().phase).toBe('down')
    expect(controller.diagnostics().failures).toBe(2)
    expect(controller.done(at(o, 2301), intent)).toBe(false); expect(controller.canEnter(at(o, 2301), intent)).toBe(true)
    const held = controller.step(at(o, 2301), intent)
    expect(held.targets).toEqual(Object.fromEntries(o.joints.map(j => [j.id, j.rotation])))
  })
  it('never treats elapsed time as missing contact success and keeps every request complete through the gate', () => {
    const controller = new GetupController(model, 1), gate = new ActuationGate(model, 1), o = prone()
    let previous = gate.targets()
    for (let tick = 0; tick < 1300; tick++) {
      const accepted = gate.accept(controller.step(at(o, tick), { ...rest, command: 'getup' }))
      expect(Object.keys(accepted.targets)).toHaveLength(model.scene.joints.length)
      for (const j of model.scene.joints) expect(angleBetween(previous[j.id], accepted.targets[j.id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
      previous = accepted.targets
    }
    expect(controller.diagnostics().phase).toBe('down'); expect(controller.diagnostics().reason).toContain('hands')
  })
  it('rejects wrong identities, stale/reordered ticks and non-finite bodies before consuming the tick', () => {
    const controller = new GetupController(model, 1), o = prone()
    expect(() => controller.step({ ...o, actorId: 'seat2' }, rest)).toThrow('identity')
    const invalid = structuredClone(o); invalid.bodies[0].rotation.x = NaN
    expect(() => controller.step(invalid, rest)).toThrow('body')
    controller.step(o, rest)
    expect(() => controller.step(o, rest)).toThrow('stale')
    expect(() => controller.step(at(o, 2), rest)).toThrow('reordered')
    expect(() => controller.step(at(o, 1), rest)).not.toThrow()
  })
  it('can be idle outside the supervisor and enter a later fall without replaying skipped ticks', () => {
    const controller = new GetupController(model, 1)
    controller.step(state(), rest)
    expect(controller.canEnter(prone(100), rest)).toBe(true)
    controller.step(prone(100), rest)
    expect(controller.diagnostics().phase).toBe('settle')
    expect(() => controller.step(prone(102), rest)).toThrow('reordered')
  })
  it('rejects missing feet, invalid support and another actor body without consuming a valid tick', () => {
    const controller = new GetupController(model, 1), o = state()
    expect(() => controller.step({ ...o, feet: [] }, rest)).toThrow()
    const invalid = structuredClone(o); invalid.support.polygon = [{ x: NaN, y: 0, z: 0 }]
    expect(() => controller.step(invalid, rest)).toThrow()
    expect(() => controller.step({ ...o, bodies: [...o.bodies, { ...o.bodies[0], id: 'seat2_pelvis' }] }, rest)).toThrow('body')
    expect(() => controller.step(o, rest)).not.toThrow()
  })
  it('completes only after a continuous stance hold and can re-enter after the supervisor releases it', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    let lastTick = 0
    for (let tick = 0; tick < 1500; tick++) {
      const sample = controller.diagnostics().phase === 'rise' || ['stance', 'complete'].includes(controller.diagnostics().phase) ? state(tick) : at(o, tick)
      sample.bodies.find(b => b.id === model.root)!.position.y = model.scene.bodies.find(b => b.id === model.root)!.position.y
      sample.floorContacts = [...hands(), ...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId)),
        ...model.feet.flatMap(id => square.map(p => contact(id, p)))]
      sample.support.polygon = square; sample.support.marginM = .1
      for (const foot of sample.feet) { foot.normalImpulseNs = 1; foot.centreOfPressure = { x: 0, y: 0, z: 0 } }
      controller.step(sample, intent); lastTick = tick
      if (controller.diagnostics().phase === 'complete') break
    }
    expect(controller.diagnostics().phase).toBe('complete')
    expect(controller.done(state(lastTick + 1), rest)).toBe(true)
    expect(controller.canEnter(state(lastTick + 1), rest)).toBe(false)
    controller.step(prone(lastTick + 100), rest)
    expect(controller.diagnostics().phase).toBe('settle'); expect(controller.diagnostics().failures).toBe(0)
    expect(controller.done(prone(lastTick + 101), rest)).toBe(false)
  })
  it.each(ALL_PHYSICAL_PROFILES)('%s crouched pike requests preserve free pelvis and imply at least 60 degrees forward', profileId => {
    const form = buildHumanoid(profileId), pike = targetsFromAngles(form, {
      'left.leg.pitch': 1.74, 'right.leg.pitch': 1.74, 'left.leg.knee': 1.1, 'right.leg.knee': 1.1,
      'left.leg.ankle.pitch': .43, 'right.leg.ankle.pitch': .43,
    })
    expect(pike).not.toHaveProperty(form.root); expect(form.scene.bodies.find(b => b.id === form.root)!.fixed).toBe(false)
    // Flat-foot sagittal kinematics: pelvis = knee - hip - ankle. This pins target geometry, not native reachability.
    const pitch = 1.1 - 1.74 - .43
    expect(-pitch).toBeGreaterThanOrEqual(GETUP.pikeTrunkRad)
    expect(rotate(fromRotationVector({ x: pitch, y: 0, z: 0 }), { x: 0, y: 1, z: 0 }).z).toBeLessThan(0)
  })
})
