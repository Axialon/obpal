import { describe, expect, it } from 'vitest'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { GETUP, GetupController, fallDetected, fallPosture, getupFacing, loadedFloorContacts, settled, supportedBy } from '../src/sim/humanoid/physics/getup'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, targetsFromAngles, type PhysicalHumanoid } from '../src/sim/humanoid/physics/model'
import { observe, type Observation } from '../src/sim/humanoid/physics/observation'
import { TORQUE_TARGET_FRACTION } from '../src/sim/humanoid/physics/targets'
import { angleBetween, clampCone, conjugate, fromRotationVector, multiply, norm, rotate, rotationVector, scale, sub, type Quat, type Vec3 } from '../src/sim/physics/math'
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
  const targets = targetsFromAngles(form, { 'left.arm.elbow': GETUP.foldedElbowRad, 'right.arm.elbow': GETUP.foldedElbowRad })
  for (const side of ['left', 'right']) {
    const id = form.scene.joints.find(j => j.child === form.parts[`${side}_forearm`].bodyId)!.id
    o.joints.find(j => j.id === id)!.rotation = targets[id]
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
function readyToes(yawRad = 0) {
  const controller = new GetupController(model, 1), o = prone(), yaw = fromRotationVector({ x: 0, y: yawRad, z: 0 })
  for (const b of o.bodies) { b.position = rotate(yaw, b.position); b.rotation = multiply(yaw, b.rotation) }
  o.bodies.find(b => b.id === model.root)!.position.y = GETUP.minimumPelvisM
  o.com = rotate(yaw, { x: .6, y: .2, z: 0 })
  o.floorContacts = [...hands(), ...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId))]
  let tick = 0
  while (controller.diagnostics().phase !== 'toes' && tick < 1000) controller.step(handFixture(controller, at(o, tick++)), { ...rest, command: 'getup' })
  expect(controller.diagnostics().phase).toBe('toes')
  return { controller, o, tick, yaw }
}
function readyPike(yawRad = 0, finishEase = true) {
  const trial = readyToes(yawRad), { controller, o, yaw } = trial
  o.com = rotate(yaw, { x: .2, y: .2, z: 0 })
  const handPoints = square.map(p => rotate(yaw, scale(p, 2))), footPoints = square.map(p => rotate(yaw, scale(p, .25)))
  o.floorContacts = ['left_hand', 'right_hand'].flatMap(part => handPoints.map(p => contact(model.parts[part].bodyId, p)))
  o.floorContacts.push(...model.feet.flatMap(id => footPoints.map(p => contact(id, p))))
  for (const [i, foot] of o.feet.entries()) {
    foot.centre = rotate(yaw, { x: i ? .05 : -.05, y: 0, z: 0 })
    foot.normalImpulseNs = 1; foot.centreOfPressure = { ...foot.centre }
  }
  expect(supportedBy([...handPoints, ...footPoints], o.com)).toBe(true)
  expect(supportedBy(footPoints, o.com)).toBe(false)
  let tick = trial.tick, entryTargets: Record<string, Quat> = {}
  while (controller.diagnostics().phase !== 'pike' && tick < 1200) entryTargets = controller.step(at(o, tick++), rest).targets
  expect(controller.diagnostics().phase).toBe('pike')
  const entryTick = tick - 1
  if (finishEase) while ((tick - entryTick) * STEP <= GETUP.keyframeEaseS + 1e-10) controller.step(at(o, tick++), rest)
  expect(controller.diagnostics().phase).toBe('pike')
  return { controller, o, tick, yaw, entryTick, entryTargets }
}
function loadFeet(o: Observation, impulses = [1, 1]) {
  o.floorContacts = [...hands(), ...model.feet.map(id => contact(id))]
  for (const [i, foot] of o.feet.entries()) {
    foot.normalImpulseNs = impulses[i]; foot.centreOfPressure = { ...foot.centre }
  }
}
function hipSpringWorld(o: Observation, targets: Record<string, Quat>, side: string) {
  const hip = model.scene.joints.find(j => j.child === model.parts[`${side}_thigh`].bodyId)!, measured = o.joints.find(j => j.id === hip.id)!
  const spring = scale(rotationVector(multiply(targets[hip.id], conjugate(measured.rotation))), hip.motor.stiffness)
  const local = sub(spring, scale(measured.angularVelocity, hip.motor.damping))
  return rotate(multiply(o.bodies.find(b => b.id === hip.parent)!.rotation, hip.frameParent), local)
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
  it('requires both shins and pelvis height before toes, then feet support before pike and rise', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    for (let tick = 0; tick <= 120; tick++) controller.step(at(o, tick), intent)
    const loaded = at(o, 121); foldForearms(loaded)
    for (let tick = 121; tick <= 240; tick++) controller.step(at(loaded, tick), intent)
    loaded.floorContacts = hands()
    for (let tick = 241; tick <= 480; tick++) controller.step(handFixture(controller, at(loaded, tick)), intent)
    expect(controller.diagnostics().phase).toBe('all-fours'); expect(controller.diagnostics().allFoursStage).toBe('extend')
    loaded.floorContacts.push(...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId)))
    controller.step(at(loaded, 481), intent); expect(controller.diagnostics().phase).toBe('all-fours')
    loaded.bodies.find(b => b.id === model.root)!.position.y = .35
    controller.step(at(loaded, 482), intent)
    expect(controller.diagnostics().phase).toBe('toes')
    loaded.floorContacts = [...hands(), ...model.feet.flatMap(id => square.map(p => contact(id, p)))]
    for (let tick = 483; tick <= 602; tick++) controller.step(at(loaded, tick), intent)
    expect(controller.diagnostics().phase).toBe('pike')
    loaded.com.x = .3
    for (let tick = 603; tick <= 722; tick++) controller.step(at(loaded, tick), intent)
    expect(controller.diagnostics().phase).toBe('pike')
    loaded.com.x = 0
    for (let tick = 723; tick < 747; tick++) controller.step(at(loaded, tick), intent)
    expect(controller.diagnostics().phase).toBe('pike')
    controller.step(at(loaded, 747), intent); expect(controller.diagnostics().phase).toBe('rise')
    expect(controller.done(at(loaded, 748), intent)).toBe(false)
  })
  it.each(['toes', 'pike'] as const)('%s requires continuous contact and COM support after easing, resetting on lost or unavailable support', phase => {
    const trial = phase === 'toes' ? readyToes() : readyPike(), { controller, o } = trial
    let tick = trial.tick
    while (tick * STEP - controller.diagnostics().phaseStartedS < GETUP.keyframeEaseS + STEP) controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe(phase)
    const supporting = [...hands(), ...model.feet.flatMap(id => square.map(p => contact(id, p)))]
    o.com = { x: 0, y: .2, z: 0 }; o.floorContacts = supporting
    const holdTicks = Math.round(GETUP.supportHoldS / STEP), briefTicks = Math.floor(holdTicks / 2)
    const briefSupport = () => {
      for (let n = 0; n < briefTicks; n++) {
        controller.step(at(o, tick++), rest)
        expect(controller.diagnostics().phase).toBe(phase)
      }
    }
    briefSupport()
    o.floorContacts = supporting.filter(c => c.b !== model.feet[1])
    controller.step(at(o, tick++), rest); expect(controller.diagnostics().phase).toBe(phase)
    o.floorContacts = supporting; briefSupport()
    const missing = at(o, tick++); delete missing.floorContacts
    controller.step(missing, rest); expect(controller.diagnostics().contactsAvailable).toBe(false)
    expect(controller.diagnostics().phase).toBe(phase)
    briefSupport()
    o.com.x = 1; controller.step(at(o, tick++), rest)
    expect(controller.diagnostics().phase).toBe(phase)
    o.com.x = 0
    for (let n = 0; n < holdTicks; n++) {
      controller.step(at(o, tick++), rest)
      expect(controller.diagnostics().phase).toBe(phase)
    }
    controller.step(at(o, tick), rest)
    expect(controller.diagnostics().phase).toBe(phase === 'toes' ? 'pike' : 'rise')
    expect(controller.diagnostics().failures).toBe(0)
  })
  it('requires both measured forearm folds, holds entry legs through planting and lifts the legs during short-lever pressing', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    const entry = targetsFromAngles(model, { 'left.leg.pitch': .4, 'right.leg.pitch': .4, 'left.leg.knee': .6, 'right.leg.knee': .6,
      'left.leg.ankle.pitch': .1, 'right.leg.ankle.pitch': .1 })
    const legs = model.drives.filter(d => d.axes.some(a => a.includes('.leg.'))).map(d => d.id)
    for (const id of legs) o.joints.find(j => j.id === id)!.rotation = entry[id]
    let frame = controller.step(at(o, 0), intent)
    for (let tick = 1; tick <= 239; tick++) frame = controller.step(at(o, tick), intent)
    expect(controller.diagnostics().handStage).toBe('fold')
    for (const id of legs) expect(frame.targets[id]).toEqual(entry[id])
    expect(rotate(physicalTarget(model, frame.targets, 'left_upper_arm'), { x: 0, y: -1, z: 0 }).z).toBeGreaterThan(0)
    foldForearms(o)
    const rightForearm = o.joints.find(j => j.id === model.scene.joints.find(j => j.child === model.parts.right_forearm.bodyId)!.id)!
    rightForearm.rotation = fromRotationVector({ x: GETUP.foldedElbowRad - .4, y: 0, z: 0 })
    controller.step(at(o, 240), intent); expect(controller.diagnostics().handStage).toBe('fold')
    rightForearm.rotation = fromRotationVector({ x: GETUP.foldedElbowRad - .34, y: 0, z: 0 })
    controller.step(at(o, 241), intent); expect(controller.diagnostics().handStage).toBe('plant')
    for (const id of legs) o.joints.find(j => j.id === id)!.rotation = fromRotationVector({ x: 0, y: 0, z: 0 })
    for (let tick = 242; tick <= 289; tick++) frame = controller.step(at(o, tick), intent)
    for (const id of legs) expect(frame.targets[id]).toEqual(entry[id])
    expect(controller.diagnostics().phaseStartedS).toBe(.5)
    o.floorContacts = hands(); controller.step(at(o, 290), intent)
    expect(controller.diagnostics().allFoursStage).toBe('press')
    o.floorContacts.push(contact(model.parts.head.bodyId))
    for (let tick = 291; tick <= 362; tick++) frame = controller.step(at(o, tick), intent)
    expect(controller.diagnostics().allFoursStage).toBe('press')
    const raised = targetsFromAngles(model, { 'left.leg.pitch': 1.5, 'right.leg.pitch': 1.5, 'left.leg.knee': 1.6, 'right.leg.knee': 1.6 })
    for (const id of legs) expect(angleBetween(frame.targets[id], raised[id])).toBeCloseTo(0, 10)
    expect(rotationVector(physicalTarget(model, frame.targets, 'left_forearm')).x).toBeCloseTo(GETUP.foldedElbowRad, 10)
    o.floorContacts = hands(); pressUpperArms(o); controller.step(at(o, 363), intent)
    expect(controller.diagnostics().allFoursStage).toBe('extend')
    expect(controller.diagnostics().phaseStartedS).toBe(290 * STEP)
  })
  it('extends only after both measured shoulders reach press and loaded hands lift the head and thorax, then completes the extension ease', () => {
    const controller = new GetupController(model, 1), o = prone(), intent = { ...rest, command: 'getup' as const }
    o.bodies.find(b => b.id === model.root)!.position.y = GETUP.minimumPelvisM
    const shins = ['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId))
    o.floorContacts = [...hands(), ...shins, contact(model.parts.head.bodyId), contact(model.parts.thorax.bodyId)]
    for (let tick = 0; tick <= 360; tick++) controller.step(handFixture(controller, at(o, tick)), intent)
    expect(controller.diagnostics().phase).toBe('all-fours'); expect(controller.diagnostics().allFoursStage).toBe('press')
    const missing = at(o, 361); delete missing.floorContacts; controller.step(missing, intent)
    o.floorContacts = [...hands(), ...shins, contact(model.parts.thorax.bodyId)]
    controller.step(at(o, 362), intent); expect(controller.diagnostics().allFoursStage).toBe('press')
    o.floorContacts = [...hands().slice(0, 1), ...shins]
    controller.step(at(o, 363), intent); expect(controller.diagnostics().allFoursStage).toBe('press')
    o.floorContacts = [...hands(), ...shins]
    const wrong = targetsFromAngles(model, { 'left.arm.pitch': -.95, 'right.arm.pitch': -.95,
      'left.arm.roll': GETUP.handShoulderRollRad, 'right.arm.roll': GETUP.handShoulderRollRad })
    const upperArms = ['left', 'right'].map(side => o.joints.find(j => j.id === model.scene.joints.find(j => j.child === model.parts[`${side}_upper_arm`].bodyId)!.id)!)
    for (const j of upperArms) j.rotation = wrong[j.id]
    controller.step(at(o, 364), intent); expect(controller.diagnostics().allFoursStage).toBe('press')
    const oldRight = upperArms[1].rotation; pressUpperArms(o); const pressedRight = upperArms[1].rotation
    upperArms[1].rotation = oldRight
    controller.step(at(o, 365), intent); expect(controller.diagnostics().allFoursStage).toBe('press')
    upperArms[1].rotation = multiply(fromRotationVector({ x: .4, y: 0, z: 0 }), pressedRight)
    controller.step(at(o, 366), intent); expect(controller.diagnostics().allFoursStage).toBe('press')
    upperArms[1].rotation = multiply(fromRotationVector({ x: .34, y: 0, z: 0 }), pressedRight)
    controller.step(at(o, 367), intent); expect(controller.diagnostics().allFoursStage).toBe('extend')
    for (let tick = 368; tick < 487; tick++) controller.step(at(o, tick), intent)
    expect(controller.diagnostics().phase).toBe('all-fours')
    controller.step(at(o, 487), intent); expect(controller.diagnostics().phase).toBe('toes')
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
    for (let tick = 0; tick < 1500; tick++) {
      const sample = controller.diagnostics().phase === 'rise' || ['stance', 'complete'].includes(controller.diagnostics().phase) ? state(tick) : at(o, tick)
      sample.bodies.find(b => b.id === model.root)!.position.y = model.scene.bodies.find(b => b.id === model.root)!.position.y
      sample.floorContacts = [...hands(), ...['left_shin', 'right_shin'].map(part => contact(model.parts[part].bodyId)),
        ...model.feet.flatMap(id => square.map(p => contact(id, p)))]
      sample.support.polygon = square; sample.support.marginM = .1
      for (const foot of sample.feet) { foot.normalImpulseNs = 1; foot.centreOfPressure = { x: 0, y: 0, z: 0 } }
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
  it.each(ALL_PHYSICAL_PROFILES)('%s actual unloaded toes and COM-biased pike keyframes preserve free pelvis and at least 60 degrees forward', profileId => {
    const form = buildHumanoid(profileId), intent = { ...rest, command: 'getup' as const }
    for (const displacementM of [-.2, .2]) {
      const controller = new GetupController(form, 1), o = prone(0, form)
      o.bodies.find(b => b.id === form.root)!.position.y = GETUP.minimumPelvisM
      o.com.x = 0; o.com.z = displacementM
      for (const [i, foot] of o.feet.entries()) foot.centre = { x: i ? .05 : -.05, y: 0, z: 0 }
      o.floorContacts = ['left_hand', 'right_hand'].flatMap(part => square.map(p => contact(form.parts[part].bodyId, { ...p, x: p.x * 2, z: p.z * 2 })))
      o.floorContacts.push(...['left_shin', 'right_shin'].map(part => contact(form.parts[part].bodyId)))
      let tick = 0
      while (controller.diagnostics().phase !== 'toes' && tick < 1000) controller.step(handFixture(controller, at(o, tick++), form), intent)
      expect(controller.diagnostics().phase).toBe('toes')
      let toes = controller.step(at(o, tick++), intent)
      for (let n = 0; n < 120; n++) toes = controller.step(at(o, tick++), intent)
      expect(controller.diagnostics().phase).toBe('toes')
      o.floorContacts.push(...form.feet.flatMap(id => square.map(p => contact(id, { ...p, x: p.x / 4, z: p.z / 4 }))))
      for (let n = 0; n <= Math.round(GETUP.supportHoldS / STEP); n++) controller.step(at(o, tick++), intent)
      expect(controller.diagnostics().phase).toBe('pike')
      let pike = controller.step(at(o, tick++), intent)
      for (let n = 0; n < 120; n++) pike = controller.step(at(o, tick++), intent)
      expect(controller.diagnostics().phase).toBe('pike')
      for (const frame of [toes, pike]) {
        expect(frame.targets).not.toHaveProperty(form.root); expect(form.scene.bodies.find(b => b.id === form.root)!.fixed).toBe(false)
        for (const side of ['left', 'right']) {
          const hip = rotationVector(physicalTarget(form, frame.targets, `${side}_thigh`)).x
          const knee = -rotationVector(physicalTarget(form, frame.targets, `${side}_shin`)).x
          const ankle = rotationVector(physicalTarget(form, frame.targets, `${side}_foot`)).x
          // Flat-foot sagittal kinematics pin actual requested geometry, not native reachability.
          const pitch = knee - hip - ankle
          expect(-pitch).toBeGreaterThanOrEqual(GETUP.pikeTrunkRad - 1e-10)
          expect(rotate(fromRotationVector({ x: pitch, y: 0, z: 0 }), { x: 0, y: 1, z: 0 }).z).toBeLessThan(0)
        }
      }
    }
  })
})

describe('get-up loaded-hip torso requests', () => {
  it('blends from the measured pike entry through the keyframe to the torque goal over the unchanged half-second ease', () => {
    const loaded = readyPike(0, false), unloaded = readyPike(0, false), hips = model.scene.joints.filter(j =>
      ['left_thigh', 'right_thigh'].some(part => j.child === model.parts[part].bodyId))
    expect(loaded.entryTick).toBe(unloaded.entryTick)
    for (const trial of [loaded, unloaded]) {
      trial.o.bodies.find(b => b.id === model.root)!.rotation = fromRotationVector({ x: -GETUP.pikeTrunkRad + .1, y: 0, z: 0 })
      for (const hip of hips) {
        const measured = trial.o.joints.find(j => j.id === hip.id)!
        expect(angleBetween(trial.entryTargets[hip.id], measured.rotation)).toBeCloseTo(0, 10)
        measured.rotation = fromRotationVector({ x: 0, y: 0, z: 0 }); measured.angularVelocity = { x: 0, y: 0, z: 0 }
      }
    }
    loadFeet(loaded.o, [1, 3]); loadFeet(unloaded.o, [0, 0])
    const midpointTick = loaded.entryTick + Math.round(GETUP.keyframeEaseS / (2 * STEP))
    const finalTick = loaded.entryTick + Math.round(GETUP.keyframeEaseS / STEP)
    const midpoint: Record<string, Quat>[] = [], endpoint: Record<string, Quat>[] = []
    for (let tick = loaded.tick; tick <= finalTick; tick++) {
      const loadedFrame = loaded.controller.step(at(loaded.o, tick), rest), unloadedFrame = unloaded.controller.step(at(unloaded.o, tick), rest)
      if (tick === midpointTick) midpoint.push(loadedFrame.targets, unloadedFrame.targets)
      if (tick === finalTick) endpoint.push(loadedFrame.targets, unloadedFrame.targets)
    }
    expect(loaded.controller.diagnostics().phase).toBe('pike')
    for (const hip of hips) {
      const remaining = angleBetween(midpoint[1][hip.id], endpoint[0][hip.id])
      expect(remaining).toBeGreaterThan(.5)
      expect(angleBetween(midpoint[1][hip.id], midpoint[0][hip.id])).toBeCloseTo(remaining / 2, 9)
    }
    expect(hipSpringWorld(loaded.o, endpoint[0], 'left').x).toBeCloseTo(7.5, 8)
    expect(hipSpringWorld(loaded.o, endpoint[0], 'right').x).toBeCloseTo(22.5, 8)
  })
  it('keeps inverted pelvis feedback unavailable, preserves the loaded contact keyframe and retains gate limits', () => {
    for (const yawRad of [0, .73]) {
      const loaded = readyPike(yawRad), unloaded = readyPike(yawRad), gate = new ActuationGate(model, 1, loaded.tick)
      loadFeet(loaded.o); loadFeet(unloaded.o, [0, 0])
      let previous = gate.targets()
      for (let n = 0; n < 24; n++) {
        for (const trial of [loaded, unloaded]) {
          const root = trial.o.bodies.find(b => b.id === model.root)!
          root.rotation = multiply(trial.yaw, fromRotationVector({ x: n % 2 ? Math.PI : Math.PI - GETUP.pikeTrunkRad, y: 0, z: 0 }))
          root.angularVelocity = rotate(trial.yaw, { x: n % 2 ? -20 : 20, y: 0, z: 0 })
          expect(rotate(root.rotation, { x: 0, y: 1, z: 0 }).y).toBeLessThan(0)
        }
        const frame = loaded.controller.step(at(loaded.o, loaded.tick + n), rest)
        const keyframe = unloaded.controller.step(at(unloaded.o, unloaded.tick + n), rest)
        expect(Object.keys(frame.targets)).toHaveLength(model.scene.joints.length)
        for (const j of model.scene.joints) expect(angleBetween(frame.targets[j.id], keyframe.targets[j.id])).toBeCloseTo(0, 10)
        for (const side of ['left', 'right']) {
          const hip = rotationVector(physicalTarget(model, frame.targets, `${side}_thigh`)).x
          const knee = -rotationVector(physicalTarget(model, frame.targets, `${side}_shin`)).x
          const ankle = rotationVector(physicalTarget(model, frame.targets, `${side}_foot`)).x
          expect(hip + ankle - knee).toBeGreaterThanOrEqual(GETUP.pikeTrunkRad - 1e-10)
        }
        expect(loaded.controller.diagnostics().phase).toBe('pike')
        const accepted = gate.accept(frame)
        for (const j of model.scene.joints) {
          expect(angleBetween(previous[j.id], accepted.targets[j.id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
          expect(angleBetween(clampCone(accepted.targets[j.id], j.cone), accepted.targets[j.id])).toBeCloseTo(0, 10)
        }
        previous = accepted.targets
      }
    }
  })
  it('requests the opposite thigh moment so loaded hips react toward the 60 degree world pike, weighted by foot load', () => {
    const { controller, o, tick } = readyPike()
    loadFeet(o, [1, 3])
    o.bodies.find(b => b.id === model.root)!.rotation = fromRotationVector({ x: -GETUP.pikeTrunkRad + .1, y: 0, z: 0 })
    for (const side of ['left', 'right']) {
      const j = o.joints.find(j => j.id === model.scene.joints.find(j => j.child === model.parts[`${side}_thigh`].bodyId)!.id)!
      j.rotation = fromRotationVector({ x: 0, y: 0, z: 0 }); j.angularVelocity = { x: 0, y: 0, z: 0 }
    }
    const frame = controller.step(at(o, tick), rest), left = hipSpringWorld(o, frame.targets, 'left'), right = hipSpringWorld(o, frame.targets, 'right')
    expect(left.x).toBeCloseTo(7.5, 8); expect(right.x).toBeCloseTo(22.5, 8)
    expect(left.y).toBeCloseTo(0, 8); expect(left.z).toBeCloseTo(0, 8)
    expect(right.y).toBeCloseTo(0, 8); expect(right.z).toBeCloseTo(0, 8)
    expect(-left.x - right.x).toBeCloseTo(-GETUP.pikeTiltStiffnessNmRad * .1, 8)
    expect(frame.targets).not.toHaveProperty(model.root)
  })
  it('damps root rotation at the pike orientation while compensating measured relative hip velocity', () => {
    const { controller, o, tick } = readyPike()
    loadFeet(o)
    const root = o.bodies.find(b => b.id === model.root)!
    root.rotation = fromRotationVector({ x: -GETUP.pikeTrunkRad, y: 0, z: 0 }); root.angularVelocity = { x: .2, y: 0, z: 0 }
    for (const side of ['left', 'right']) {
      const j = o.joints.find(j => j.id === model.scene.joints.find(j => j.child === model.parts[`${side}_thigh`].bodyId)!.id)!
      j.angularVelocity = { x: .01, y: .02, z: .03 }
    }
    const frame = controller.step(at(o, tick), rest)
    for (const side of ['left', 'right']) {
      const moment = hipSpringWorld(o, frame.targets, side)
      expect(moment.x).toBeCloseTo(GETUP.pikeTiltDampingNmsRad * .2 / 2, 8)
      expect(moment.y).toBeCloseTo(0, 8); expect(moment.z).toBeCloseTo(0, 8)
    }
  })
  it('keeps the keyframe when contacts are unavailable, absent, one-sided or the measured foot load is zero', () => {
    const frames: Record<string, Quat>[] = []
    for (const kind of ['absent', 'unavailable', 'one-sided', 'zero-load']) {
      const { controller, o, tick } = readyPike()
      loadFeet(o)
      if (kind === 'unavailable') delete o.floorContacts
      else if (kind === 'absent') o.floorContacts = hands()
      else if (kind === 'one-sided') o.floorContacts = [...hands(), contact(model.feet[0])]
      else for (const foot of o.feet) foot.normalImpulseNs = 0
      frames.push(controller.step(at(o, tick), rest).targets)
    }
    for (const targets of frames.slice(1)) for (const j of model.scene.joints) expect(angleBetween(targets[j.id], frames[0][j.id])).toBeCloseTo(0, 10)
  })
  it('caps requested hip spring offsets and keeps complete frames inside existing cone and slew gates', () => {
    const { controller, o, tick } = readyPike(), gate = new ActuationGate(model, 1, tick)
    loadFeet(o)
    for (const side of ['left', 'right']) {
      const j = o.joints.find(j => j.id === model.scene.joints.find(j => j.child === model.parts[`${side}_thigh`].bodyId)!.id)!
      j.rotation = fromRotationVector({ x: 0, y: 0, z: 0 }); j.angularVelocity = { x: 0, y: 0, z: 0 }
    }
    let previous = gate.targets()
    for (let n = 0; n < 24; n++) {
      const root = o.bodies.find(b => b.id === model.root)!
      root.rotation = fromRotationVector({ x: n % 2 ? -.6 : .6, y: 0, z: 0 }); root.angularVelocity.x = n % 2 ? -20 : 20
      const frame = controller.step(at(o, tick + n), rest)
      expect(Object.keys(frame.targets)).toHaveLength(model.scene.joints.length)
      for (const side of ['left', 'right']) {
        const hip = model.scene.joints.find(j => j.child === model.parts[`${side}_thigh`].bodyId)!
        expect(norm(hipSpringWorld(o, frame.targets, side))).toBeLessThanOrEqual(TORQUE_TARGET_FRACTION * hip.motor.maxTorque + 1e-8)
      }
      const accepted = gate.accept(frame)
      for (const j of model.scene.joints) {
        expect(angleBetween(previous[j.id], accepted.targets[j.id])).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
        expect(angleBetween(clampCone(accepted.targets[j.id], j.cone), accepted.targets[j.id])).toBeCloseTo(0, 10)
      }
      previous = accepted.targets
    }
  })
  it('preserves joint-frame requests under a yawed recovery episode and rotates the requested world reaction with it', () => {
    const frames: Record<string, Quat>[] = [], moments: Vec3[] = []
    const yawRad = .73
    for (const yaw of [0, yawRad]) {
      const { controller, o, tick, yaw: heading } = readyPike(yaw)
      loadFeet(o, [1, 3])
      const root = o.bodies.find(b => b.id === model.root)!
      root.rotation = multiply(heading, multiply(fromRotationVector({ x: -.6, y: 0, z: 0 }), fromRotationVector({ x: 0, y: 0, z: .2 })))
      root.angularVelocity = rotate(heading, { x: .1, y: .03, z: -.04 })
      for (const side of ['left', 'right']) o.joints.find(j => j.id === model.scene.joints.find(j => j.child === model.parts[`${side}_thigh`].bodyId)!.id)!.angularVelocity = { x: .03, y: -.02, z: .01 }
      const frame = controller.step(at(o, tick), rest)
      frames.push(frame.targets); moments.push(hipSpringWorld(o, frame.targets, 'left'))
    }
    for (const j of model.scene.joints) expect(angleBetween(frames[0][j.id], frames[1][j.id])).toBeCloseTo(0, 8)
    const rotated = rotate(fromRotationVector({ x: 0, y: yawRad, z: 0 }), moments[0])
    expect(moments[1].x).toBeCloseTo(rotated.x, 8); expect(moments[1].y).toBeCloseTo(rotated.y, 8); expect(moments[1].z).toBeCloseTo(rotated.z, 8)
  })
})
