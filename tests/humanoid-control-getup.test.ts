import { describe, expect, it } from 'vitest'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { GETUP, GetupController, getupSupportAngles, fallDetected, fallPosture, getupFacing, loadedFloorContacts, settled, supportedBy } from '../src/sim/humanoid/physics/getup'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, targetsFromAngles, type PhysicalHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { angleBetween, clampCone, conjugate, fromRotationVector, multiply, rotate, type Quat, type Vec3 } from '../src/sim/physics/math'
import { STEP, type ContactSample } from '../src/sim/physics/schema'

// Synthetic state-machine fixtures only. Physical acceptance is in the separate Rapier pilot suite.
const model = buildHumanoid('keel-v1'), rest = { x: 0, z: 0, yaw: 0, manual: false }
function state(tick = 0, form = model): Observation {
  return { ...observe(form, form.scene.bodies.map(b => ({ ...b, sleeping: false })), [], 1, tick), floorContacts: [] }
}
function prone(tick = 0, form = model) {
  const o = state(tick, form), q = fromRotationVector({ x: -Math.PI / 2, y: 0, z: 0 })
  for (const b of o.bodies) { b.rotation = q; b.position.y = .2 }
  o.com.y = .2; return o
}
function supine() {
  const o = prone(), q = fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 })
  for (const b of o.bodies) b.rotation = q
  return o
}
function physicalTarget(form: PhysicalHumanoid, targets: Record<string, Quat>, part: string) {
  const j = form.scene.joints.find(j => j.child === form.parts[part].bodyId)!
  return multiply(multiply(j.frameParent, targets[j.id]), conjugate(j.frameChild))
}
function foldForearms(o: Observation, form = model) {
  const targets = targetsFromAngles(form, { 'left.arm.elbow': GETUP.foldedElbowRad, 'right.arm.elbow': GETUP.foldedElbowRad, 'left.leg.knee': GETUP.tuckedKneeRad, 'right.leg.knee': GETUP.tuckedKneeRad })
  for (const side of ['left', 'right']) {
    const id = form.scene.joints.find(j => j.child === form.parts[`${side}_forearm`].bodyId)!.id
    o.joints.find(j => j.id === id)!.rotation = targets[id]
    const knee = form.scene.joints.find(j => j.child === form.parts[`${side}_shin`].bodyId)!.id
    o.joints.find(j => j.id === knee)!.rotation = targets[knee]
  }
}
function pressUpperArms(o: Observation, form = model) {
  const targets = targetsFromAngles(form, { 'left.arm.pitch': GETUP.pressShoulderPitchRad, 'right.arm.pitch': GETUP.pressShoulderPitchRad,
    'left.arm.roll': GETUP.handShoulderRollRad, 'right.arm.roll': GETUP.handShoulderRollRad })
  for (const side of ['left', 'right']) {
    const id = form.scene.joints.find(j => j.child === form.parts[`${side}_upper_arm`].bodyId)!.id
    o.joints.find(j => j.id === id)!.rotation = targets[id]
  }
}
function handFixture(controller: GetupController, sample: Observation, form = model) {
  const d = controller.diagnostics()
  if (d.phase === 'hands') {
    foldForearms(sample, form)
    if (d.handStage === 'fold') sample.floorContacts = sample.floorContacts?.filter(c =>
      !['left', 'right'].some(side => [c.a, c.b].includes(form.parts[`${side}_hand`].bodyId)))
  }
  if (d.phase === 'all-fours' && d.allFoursStage === 'press') pressUpperArms(sample, form)
  return sample
}
function readyKneel() {
  const controller = new GetupController(model, 1), o = prone()
  o.bodies.find(b => b.id === model.root)!.position.y = GETUP.minimumPelvisM
  o.bodies.find(b => b.id === model.root)!.rotation = fromRotationVector({ x: -.9, y: 0, z: 0 })
  o.floorContacts = [...hands(), ...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId))]
  let tick = 0
  while (controller.diagnostics().phase !== 'kneel' && tick < 1200) controller.step(handFixture(controller, at(o, tick++)), { ...rest, command: 'getup' })
  expect(controller.diagnostics().phase).toBe('kneel')
  return { controller, o, tick }
}
function supportKnees(o: Observation) {
  o.bodies.find(b => b.id === model.root)!.rotation = { x: 0, y: 0, z: 0, w: 1 }
  o.com = { x: 0, y: .4, z: 0 }
  o.floorContacts = ['left_shin', 'right_shin'].flatMap(part => square.map(p => contact(model.parts[part].bodyId, p)))
}
function readyHalfKneel() {
  const trial = readyKneel(); supportKnees(trial.o)
  while (trial.controller.diagnostics().phase !== 'half-kneel' && trial.tick < 1800) trial.controller.step(at(trial.o, trial.tick++), rest)
  expect(trial.controller.diagnostics().phase).toBe('half-kneel')
  return trial
}
function supportFront(o: Observation) {
  supportKnees(o)
  const foot = o.bodies.find(b => b.id === model.feet[0])!
  foot.rotation = { x: 0, y: 0, z: 0, w: 1 }
  o.com = { ...foot.position }
  o.floorContacts!.push(...square.map(p => contact(foot.id, { x: p.x + foot.position.x, y: 0, z: p.z + foot.position.z })))
  const measured = o.feet.find(f => f.id === foot.id)!; measured.normalImpulseNs = 1; measured.minSoleY = 0; measured.centreOfPressure = { ...foot.position }
}
function at(o: Observation, tick: number): Observation { return { ...structuredClone(o), stateTick: tick, timeS: tick * STEP } }
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
  it('preserves toe-ward yaw through pitch beyond 90 degrees during prone transitions', () => {
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
  it('tucks the knees before allowing planted hands to start the arm press', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick <= 240; tick++) controller.step(handFixture(controller, at(o, tick)), intent)
    o.floorContacts = hands(); foldForearms(o)
    const knee = model.scene.joints.find(j => j.child === model.parts.right_shin.bodyId)!.id
    o.joints.find(j => j.id === knee)!.rotation = { x: 0, y: 0, z: 0, w: 1 }
    for (let tick = 241; tick <= 310; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().phase).toBe('hands')
    foldForearms(o); controller.step(at(o, 311), intent)
    expect(controller.diagnostics().phase).toBe('all-fours')
  })
  it('requires an upright supported kneel with light hands before moving one knee', () => {
    const { controller, o, tick: start } = readyKneel()
    let tick = start
    while (tick * STEP - controller.diagnostics().phaseStartedS < GETUP.kneelEaseS + STEP) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('kneel')
    supportKnees(o); o.floorContacts!.push(...hands().map(c => ({ ...c, impulse: 10 })))
    for (let n = 0; n < 25; n++) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('kneel')
    supportKnees(o)
    for (let n = 0; n < 12; n++) controller.step(at(o, tick++), rest)
    const missing = at(o, tick++); delete missing.floorContacts; controller.step(missing, rest)
    expect(controller.diagnostics().phase).toBe('kneel')
    for (let n = 0; n <= Math.round(GETUP.supportHoldS / STEP); n++) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('half-kneel')
  })
  it('requires the front-foot diamond, its real pressure and the rear knee before rising', () => {
    const { controller, o, tick: start } = readyHalfKneel()
    let tick = start
    while (tick * STEP - controller.diagnostics().phaseStartedS < GETUP.kneelEaseS + STEP) controller.step(at(o, tick++), rest)
    supportFront(o); o.com.x += .3
    for (let n = 0; n < 25; n++) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('half-kneel')
    supportFront(o); o.feet[0].normalImpulseNs = 0; controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('half-kneel')
    supportFront(o); o.floorContacts = o.floorContacts!.filter(c => c.b !== model.parts.right_shin.bodyId)
    controller.step(at(o, tick++), rest); expect(controller.diagnostics().phase).toBe('half-kneel')
    supportFront(o)
    for (let n = 0; n <= Math.round(GETUP.supportHoldS / STEP); n++) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('rise')
  })
  it.each([
    { name: 'duplicate points', points: [[0, 0], [0, 0], [0, 0]] },
    { name: 'collinear points', points: [[0, -.02], [0, 0], [0, .02]] },
    { name: 'a measured hull outside the COM', points: [[.04, -.02], [.06, -.02], [.05, .02]] },
  ])('retains half kneel with $name even while the COM is inside the sole diamond', ({ points }) => {
    const { controller, o, tick: start } = readyHalfKneel()
    let tick = start
    while (tick * STEP - controller.diagnostics().phaseStartedS < GETUP.kneelEaseS + STEP) controller.step(at(o, tick++), rest)
    supportFront(o)
    const id = model.feet[0], foot = o.bodies.find(body => body.id === id)!
    o.floorContacts = o.floorContacts!.filter(c => c.b !== id)
    o.floorContacts.push(...points.map(([x, z]) => contact(id, { x: foot.position.x + x, y: 0, z: foot.position.z + z })))
    for (let n = 0; n <= Math.round(GETUP.supportHoldS / STEP); n++) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('half-kneel')
    supportFront(o)
    for (let n = 0; n <= Math.round(GETUP.supportHoldS / STEP); n++) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe('rise')
  })
  it('times out a kneel whose support never arrives instead of manufacturing a successful phase', () => {
    const { controller, o, tick: start } = readyKneel()
    let tick = start; o.floorContacts = []
    while (controller.diagnostics().failures === 0) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().reason).toContain('kneel post-condition timed out')
    expect(controller.diagnostics().failures).toBe(1)
    expect(controller.done(at(o, tick), rest)).toBe(false)
  })
  it.each(ALL_PHYSICAL_PROFILES)('%s kneel requests retain all joint cones, the slew gate and an unpinned pelvis', profileId => {
    const form = buildHumanoid(profileId), gate = new ActuationGate(form, 1)
    let tick = 0, previous = gate.targets()
    for (const phase of ['all-fours', 'kneel', 'half-kneel'] as const) {
      const targets = targetsFromAngles(form, getupSupportAngles(form, phase))
      for (let n = 0; n < 120; n++, tick++) {
        const accepted = gate.accept({ schema_version: 1, profileId, actorId: form.actorId, generation: 1, tick, source: 'classical', targets })
        expect(accepted.targets).not.toHaveProperty(form.root)
        for (const j of form.scene.joints) {
          expect(angleBetween(previous[j.id], accepted.targets[j.id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
          expect(angleBetween(clampCone(accepted.targets[j.id], j.cone), accepted.targets[j.id])).toBeCloseTo(0, 10)
        }
        previous = accepted.targets
      }
    }
    expect(form.scene.bodies.find(b => b.id === form.root)!.fixed).toBe(false)
  })
  it.each([{ axis: 'x' as const, value: NaN }, { axis: 'y' as const, value: Infinity }, { axis: 'z' as const, value: -Infinity }])(
    'rejects non-finite joint angular velocity on $axis atomically and accepts the corrected tick', ({ axis, value }) => {
      const controller = new GetupController(model, 1), o = prone()
      controller.step(o, rest)
      const before = controller.diagnostics(), malformed = at(o, 1)
      malformed.joints[0].angularVelocity[axis] = value
      expect(() => controller.step(malformed, rest)).toThrow(RangeError)
      expect(controller.diagnostics()).toEqual(before)
      expect(() => controller.step(at(o, 1), rest)).not.toThrow()
    })
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
  it('cannot skip folding from height, existing hand loads, missing manifolds or a single loaded hand', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick <= 120; tick++) controller.step(at(o, tick), intent)
    const missing = at(o, 121); delete missing.floorContacts; controller.step(missing, intent)
    expect(controller.diagnostics().contactsAvailable).toBe(false); expect(controller.diagnostics().phase).toBe('hands')
    const one = at(o, 122); one.floorContacts = hands().slice(0, 1); controller.step(one, intent)
    expect(controller.diagnostics().phase).toBe('hands')
    const both = at(o, 123); both.floorContacts = hands()
    for (let tick = 123; tick <= 240; tick++) controller.step(at(both, tick), intent)
    expect(controller.diagnostics().handStage).toBe('fold')
    foldForearms(both); controller.step(at(both, 241), intent)
    expect(controller.diagnostics().handStage).toBe('fold')
    both.floorContacts = hands().slice(0, 1); controller.step(at(both, 242), intent)
    expect(controller.diagnostics().handStage).toBe('fold')
    both.floorContacts = []; controller.step(at(both, 243), intent)
    expect(controller.diagnostics().handStage).toBe('plant')
    const unavailable = at(both, 244); delete unavailable.floorContacts; controller.step(unavailable, intent)
    both.floorContacts = hands().slice(0, 1); controller.step(at(both, 245), intent)
    expect(controller.diagnostics().phase).toBe('hands')
    both.floorContacts = hands()
    for (let tick = 246; tick < 291; tick++) controller.step(at(both, tick), intent)
    expect(controller.diagnostics().phase).toBe('hands')
    controller.step(at(both, 291), intent)
    expect(controller.diagnostics().phase).toBe('all-fours')
    expect(controller.diagnostics().allFoursStage).toBe('press')
  })
  it('keeps the original hand and all-fours deadlines across internal stages and retries only once', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    foldForearms(o)
    for (let tick = 0; tick < 360; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().handStage).toBe('plant'); expect(controller.diagnostics().failures).toBe(0)
    controller.step(at(o, 360), intent); expect(controller.diagnostics().failures).toBe(1)
    expect(controller.diagnostics().reason).toContain('hands')
    for (let tick = 361; tick < 721; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().phase).toBe('hands')
    controller.step(at(o, 721), intent)
    expect(controller.diagnostics().phase).toBe('down'); expect(controller.diagnostics().failures).toBe(2)
    expect(controller.diagnostics().handStage).toBeNull()
    const press = new GetupController(model, 1), loaded = prone()
    loaded.floorContacts = [...hands(), contact(model.parts.head.bodyId)]
    for (let tick = 0; tick < 648; tick++) press.step(handFixture(press, at(loaded, tick)), intent)
    expect(press.diagnostics().allFoursStage).toBe('press'); expect(press.diagnostics().failures).toBe(0)
    press.step(at(loaded, 648), intent); expect(press.diagnostics().failures).toBe(1)
    expect(press.diagnostics().reason).toContain('all-fours')
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
  it('loads the push arm only from genuine floor contact after easing and clearing the other hand and feet', () => {
    const controller = new GetupController(model, 1), o = supine(), intent = { ...rest, command: 'getup' as const }
    o.floorContacts = [contact(model.parts.left_forearm.bodyId)]
    for (let tick = 0; tick < 216; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().rollStage).toBe('load')
    const missing = at(o, 216); delete missing.floorContacts; controller.step(missing, intent)
    expect(controller.diagnostics().rollStage).toBe('load')
    o.floorContacts = [contact(model.parts.left_forearm.bodyId, undefined, 0)]
    controller.step(at(o, 217), intent); expect(controller.diagnostics().rollStage).toBe('load')
    o.floorContacts = [contact(model.parts.right_forearm.bodyId)]
    controller.step(at(o, 218), intent); expect(controller.diagnostics().rollStage).toBe('load')
    o.floorContacts = [contact(model.parts.left_forearm.bodyId), contact(model.feet[0])]
    controller.step(at(o, 219), intent); expect(controller.diagnostics().rollStage).toBe('load')
    o.floorContacts = [contact(model.parts.left_forearm.bodyId), contact(model.parts.right_hand.bodyId)]
    controller.step(at(o, 220), intent); expect(controller.diagnostics().rollStage).toBe('load')
    o.floorContacts = [contact(model.parts.left_forearm.bodyId)]
    controller.step(at(o, 221), intent)
    expect(controller.diagnostics().rollStage).toBe('push'); expect(controller.diagnostics().phaseStartedS).toBe(.5)
  })
  it('withdraws the pushing arm only after a measured side roll with torso load and retains the original prone gate', () => {
    const controller = new GetupController(model, 1), o = supine(), intent = { ...rest, command: 'getup' as const }
    o.floorContacts = [contact(model.parts.left_hand.bodyId)]
    for (let tick = 0; tick <= 312; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().rollStage).toBe('push')
    o.bodies.find(b => b.id === model.parts.thorax.bodyId)!.rotation = fromRotationVector({ x: 0, y: 0, z: 0 })
    o.floorContacts.push(contact(model.root))
    controller.step(at(o, 313), intent); expect(controller.diagnostics().rollStage).toBe('push')
    o.bodies.find(b => b.id === model.root)!.rotation = multiply(fromRotationVector({ x: 0, y: 0, z: -Math.PI / 2 - .01 }),
      fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 }))
    o.floorContacts = [contact(model.parts.left_hand.bodyId)]
    controller.step(at(o, 314), intent); expect(controller.diagnostics().rollStage).toBe('push')
    o.floorContacts.push(contact(model.root))
    controller.step(at(o, 315), intent); expect(controller.diagnostics().rollStage).toBe('finish')
    o.bodies.find(b => b.id === model.parts.thorax.bodyId)!.rotation = fromRotationVector({ x: -Math.asin(.4), y: 0, z: 0 })
    controller.step(at(o, 316), intent); expect(controller.diagnostics().phase).toBe('roll')
    o.bodies.find(b => b.id === model.parts.thorax.bodyId)!.rotation = fromRotationVector({ x: -Math.PI / 2, y: 0, z: 0 })
    controller.step(at(o, 317), intent)
    expect(controller.diagnostics().phase).toBe('hands'); expect(controller.diagnostics().rollStage).toBeNull()
  })
  it('mirrors floor-reaching arms, crossed hips and supine yaw across the opposite-side retry without loosening the gate', () => {
    const controller = new GetupController(model, 1), gate = new ActuationGate(model, 1), o = supine()
    const captured = new Map<number, Record<string, Quat>>()
    let previous = gate.targets()
    for (let tick = 0; tick <= 793; tick++) {
      o.floorContacts = tick >= 217 && tick <= 313 ? [contact(model.parts.left_forearm.bodyId)] :
        tick >= 697 ? [contact(model.parts.right_forearm.bodyId)] : []
      const frame = controller.step(at(o, tick), { ...rest, command: 'getup' })
      if ([216, 313, 696, 793].includes(tick)) captured.set(tick, frame.targets)
      const accepted = gate.accept(frame)
      for (const j of model.scene.joints) expect(angleBetween(previous[j.id], accepted.targets[j.id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
      previous = accepted.targets
    }
    expect(controller.diagnostics().rollSide).toBe(-1); expect(controller.diagnostics().rollStage).toBe('push')
    for (const [rightTick, leftTick] of [[216, 696], [313, 793]]) {
      const right = captured.get(rightTick)!, left = captured.get(leftTick)!
      expect(Object.keys(right)).toHaveLength(model.scene.joints.length); expect(right).not.toHaveProperty(model.root)
      for (const [a, b] of [['left_upper_arm', 'right_upper_arm'], ['right_upper_arm', 'left_upper_arm'],
        ['left_thigh', 'right_thigh'], ['right_thigh', 'left_thigh']]) {
        const r = rotate(physicalTarget(model, right, a), { x: 0, y: -1, z: 0 })
        const l = rotate(physicalTarget(model, left, b), { x: 0, y: -1, z: 0 })
        expect(r.x).toBeCloseTo(-l.x, 10); expect(r.y).toBeCloseTo(l.y, 10); expect(r.z).toBeCloseTo(l.z, 10)
      }
    }
    const load = captured.get(216)!, pushed = captured.get(313)!, mirrored = captured.get(793)!
    const supineRotation = fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 })
    expect(rotate(multiply(supineRotation, physicalTarget(model, load, 'left_upper_arm')), { x: 0, y: -1, z: 0 }).y).toBeLessThan(0)
    expect(rotate(multiply(supineRotation, physicalTarget(model, load, 'right_upper_arm')), { x: 0, y: -1, z: 0 }).y).toBeGreaterThan(0)
    for (const part of ['left_thigh', 'right_thigh']) expect(rotate(physicalTarget(model, load, part), { x: 0, y: -1, z: 0 }).x).toBeGreaterThan(0)
    const rightFace = rotate(multiply(supineRotation, physicalTarget(model, pushed, 'head')), { x: 0, y: 0, z: -1 })
    const leftFace = rotate(multiply(supineRotation, physicalTarget(model, mirrored, 'head')), { x: 0, y: 0, z: -1 })
    expect(rightFace.x).toBeGreaterThan(0); expect(leftFace.x).toBeCloseTo(-rightFace.x, 10)
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
    for (let tick = 0; tick < 2400; tick++) {
      const phase = controller.diagnostics().phase
      const sample = phase === 'rise' || ['stance', 'complete'].includes(phase) ? state(tick) : at(o, tick)
      if (['all-fours', 'kneel', 'half-kneel'].includes(phase)) sample.bodies.find(b => b.id === model.root)!.rotation = { x: 0, y: 0, z: 0, w: 1 }
      sample.bodies.find(b => b.id === model.root)!.position.y = model.scene.bodies.find(b => b.id === model.root)!.position.y
      sample.floorContacts = [...hands(), ...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId)),
        ...model.feet.flatMap(id => square.map(p => contact(id, p)))]
      sample.support.polygon = square; sample.support.marginM = .1
      for (const foot of sample.feet) { foot.normalImpulseNs = 1; foot.centreOfPressure = { x: 0, y: 0, z: 0 } }
      if (phase === 'kneel') supportKnees(sample)
      if (phase === 'half-kneel') supportFront(sample)
      controller.step(handFixture(controller, sample), intent); lastTick = tick
      if (controller.diagnostics().phase === 'complete') break
    }
    expect(controller.diagnostics().phase).toBe('complete')
    expect(controller.done(state(lastTick + 1), rest)).toBe(true)
    expect(controller.canEnter(state(lastTick + 1), rest)).toBe(false)
    controller.step(prone(lastTick + 100), rest)
    expect(controller.diagnostics().phase).toBe('settle'); expect(controller.diagnostics().failures).toBe(0)
    expect(controller.done(prone(lastTick + 101), rest)).toBe(false)
  })
})
