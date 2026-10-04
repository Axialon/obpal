/** Short native predictor checks, not walking or penetration acceptance. */
import { beforeAll, describe, expect, it } from 'vitest'
import { emitMeasurement } from './humanoid-physics-node.mjs'
import { buildHumanoid } from '../src/sim/humanoid/physics/model'
import { HumanoidPilot } from '../src/sim/humanoid/physics/pilot'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { ActuationGate, MAX_TARGET_RATE } from '../src/sim/humanoid/physics/contract'
import { gaitTargetEstimate, predictGaitCoupled, withGaitPredictions } from '../src/sim/humanoid/physics/gait'
import { observe } from '../src/sim/humanoid/physics/observation'
import { coupledServo } from '../src/sim/physics/coupled-servo'
import { PHYSICS_SELECTION } from '../src/sim/physics/selection'
import { STEP, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { angleBetween, fromRotationVector, multiply, norm, rotate, sub, type Vec3 } from '../src/sim/physics/math'

const settleTicks = 240, sampleTicks = 12
const torqueError = (a: ReadonlyMap<string, Vec3>, b: ReadonlyMap<string, Vec3>) =>
  Math.max(...[...a].map(([id, value]) => norm(sub(value, b.get(id)!))))

async function measure(profileId: string) {
  const model = buildHumanoid(profileId), nativeFactory = await PHYSICS_SELECTION.load()
  let contacts: ContactSample[] = [], readNative: (() => BodyState[]) | undefined
  const pilot = await HumanoidPilot.create(model, { factory: async (scene, limits) => {
    const backend = await nativeFactory(scene, limits), nativeContacts = backend.contacts!
    readNative = () => scene.bodies.map(body => backend.read(body.id))
    backend.contacts = () => {
      const samples = nativeContacts.call(backend)
      contacts = structuredClone(samples)
      return samples
    }
    return backend
  } })
  const gate = new ActuationGate(model, pilot.generation), stance = new StanceController(model, pilot.generation)
  const fixed: BodyState[] = model.scene.bodies.filter(body => body.fixed).map(body => ({ ...body, sleeping: true }))
  const hipCapNm = model.scene.joints.find(joint => joint.child === model.parts.left_thigh.bodyId)!.motor.maxTorque
  const report = { profileId, backend: pilot.metadata().id, samples: 0, rawContactSamples: 0, supportedSamples: 0,
    nativeContactSources: 0, reconstructedContactSources: 0, matchingContactRows: 0, immutableSamples: 0, memoExactSamples: 0,
    maxNativeContactErrorNm: 0, maxReconstructedErrorNm: 0, maxReconstructedHipCapFraction: 0,
    maxSameOrderErrorNm: 0, maxNativeAppliedErrorNm: 0, hipCapNm,
    maxGateErrorRad: 0, maxGateStepRad: 0, slewLimitedSamples: 0, minUp: 1 }
  try {
    for (let tick = 0; tick < settleTicks + sampleTicks; tick++) {
      let nativePrediction: ReturnType<typeof coupledServo> | undefined
      pilot.advance(STEP, observation => {
        const request = stance.step(observation).frame
        if (tick >= settleTicks) {
          const hip = model.scene.joints.find(joint => joint.child === model.parts.left_thigh.bodyId)!
          const sign = tick < settleTicks + sampleTicks / 2 ? 1 : -1
          request.targets[hip.id] = multiply(fromRotationVector({ x: 0, y: .08 * sign, z: .04 * sign }), request.targets[hip.id])
        }
        const previous = gate.targets(), accepted = gate.accept(request)
        if (tick < settleTicks) return request
        const targets = new Map(Object.entries(accepted.targets)), raw = structuredClone(contacts)
        const withContacts = { ...observation, floorContacts: raw }
        const before = structuredClone({ model, observation, withContacts, targets, previous, request })
        const reference = coupledServo(model.scene, [...fixed, ...observation.bodies], targets, raw, STEP)
        const predicted = predictGaitCoupled(model, withContacts, targets)
        const reconstructed = predictGaitCoupled(model, observation, targets)
        // The second request changes torque targets while preserving the measured constraint state.
        const alternate = new Map(targets), hip = model.scene.joints.find(joint => joint.child === model.parts.left_thigh.bodyId)!
        alternate.set(hip.id, multiply(fromRotationVector({ x: .02, y: 0, z: 0 }), alternate.get(hip.id)!))
        for (const input of [withContacts, observation]) {
          const expected = [predictGaitCoupled(model, input, targets), predictGaitCoupled(model, input, alternate)]
          const actual = withGaitPredictions(model, input, predict => [predict(targets), predict(alternate)])
          expect(actual).toEqual(expected)
        }
        report.memoExactSamples++
        // This reconstruction groups foot points; support.points separately preserves native inter-foot order.
        const footOrder = (contact: ContactSample) => model.feet.indexOf(contact.a === 'floor' ? contact.b : contact.a)
        const sameOrder = coupledServo(model.scene, [...fixed, ...observation.bodies], targets,
          [...raw].sort((a, b) => footOrder(a) - footOrder(b)), STEP)
        nativePrediction = coupledServo(model.scene, readNative!(), targets, raw, STEP)
        report.samples++
        if (raw.some(contact => contact.impulse > 0)) report.rawContactSamples++
        if (observation.feet.every(foot => foot.normalImpulseNs > 0 && foot.contactPoints.length >= 3)) report.supportedSamples++
        if (predicted.contactSource === 'native-floor') report.nativeContactSources++
        if (reconstructed.contactSource === 'observed-foot-rows') report.reconstructedContactSources++
        if (reference.diagnostics.contactRows === reconstructed.diagnostics.contactRows) report.matchingContactRows++
        report.maxNativeContactErrorNm = Math.max(report.maxNativeContactErrorNm, torqueError(reference.torques, predicted.torques))
        report.maxReconstructedErrorNm = Math.max(report.maxReconstructedErrorNm, torqueError(reference.torques, reconstructed.torques))
        report.maxReconstructedHipCapFraction = report.maxReconstructedErrorNm / hipCapNm
        report.maxSameOrderErrorNm = Math.max(report.maxSameOrderErrorNm, torqueError(sameOrder.torques, reconstructed.torques))
        report.minUp = Math.min(report.minUp, rotate(observation.bodies.find(body => body.id === model.root)!.rotation, { x: 0, y: 1, z: 0 }).y)
        for (const joint of model.scene.joints) {
          const estimate = gaitTargetEstimate(joint, previous[joint.id], request.targets[joint.id])
          report.maxGateErrorRad = Math.max(report.maxGateErrorRad, angleBetween(estimate, accepted.targets[joint.id]))
          report.maxGateStepRad = Math.max(report.maxGateStepRad, angleBetween(estimate, previous[joint.id]))
          if (angleBetween(request.targets[joint.id], accepted.targets[joint.id]) > 1e-4) report.slewLimitedSamples++
        }
        // Compare Maps as Maps: JSON.stringify alone would miss target-map mutations.
        expect({ model, observation, withContacts, targets, previous, request }).toEqual(before)
        report.immutableSamples++
        return request
      })
      if (nativePrediction) for (const [id, torque] of nativePrediction.torques)
        report.maxNativeAppliedErrorNm = Math.max(report.maxNativeAppliedErrorNm,
          Math.abs(norm(torque) - pilot.diagnostics().forces.motorTorques[id]))
    }
    emitMeasurement({ schema_version: 1, kind: 'humanoid-gait-coupled-prediction', ...report })
    return report
  } finally { pilot.dispose() }
}

for (const profile of ['keel-v1', 'morrow-v1']) describe(`native gait prediction: ${profile}`, () => {
  let report: Awaited<ReturnType<typeof measure>>
  beforeAll(async () => { report = await measure(profile) }, 30_000)
  it('uses true native contact samples and matches the coupled kernel and dispatched joint magnitudes', () => {
    expect(report.backend).toBe('rapier')
    expect(report.samples).toBe(sampleTicks)
    expect(report.rawContactSamples).toBe(sampleTicks)
    expect(report.nativeContactSources).toBe(sampleTicks)
    expect(report.memoExactSamples).toBe(sampleTicks)
    expect(report.maxNativeContactErrorNm).toBeLessThan(1e-10)
    expect(report.maxNativeAppliedErrorNm).toBeLessThan(1e-9)
  })
  it('reconstructs loaded-foot rows with a measured approximation bound during supported upright motion', () => {
    expect(report.supportedSamples).toBe(sampleTicks)
    expect(report.minUp).toBeGreaterThan(.999)
    expect(report.reconstructedContactSources).toBe(sampleTicks)
    expect(report.matchingContactRows).toBe(sampleTicks)
    expect(report.maxSameOrderErrorNm).toBeLessThan(1e-10)
    // support.points retains native order, but this predictor groups rows by foot. An ordered prototype
    // changes fallback motion and is not adopted. Near dependent rows are order-sensitive; 5% of the hip
    // cap is an explicit approximation regression bound for these supported samples.
    // This does not change motor caps, physical acceptance gates, or claim accuracy during impacts.
    expect(report.maxReconstructedHipCapFraction).toBeLessThan(.05)
  })
  it('previews the real gate including exercised slew limits without changing any input', () => {
    expect(report.slewLimitedSamples).toBeGreaterThan(0)
    expect(report.maxGateErrorRad).toBeLessThan(1e-10)
    expect(report.maxGateStepRad).toBeLessThanOrEqual(MAX_TARGET_RATE * STEP + 1e-10)
    expect(report.immutableSamples).toBe(sampleTicks)
  })
})

describe('coupled gait prediction input contract', () => {
  const model = buildHumanoid('keel-v1')
  const observation = observe(model, model.scene.bodies.map(body => ({ ...body, sleeping: body.fixed })), [], 1, 0)
  const targets = new Map(model.scene.joints.map(joint => [joint.id, joint.motor.target]))
  it.each(['actorId', 'profileId', 'modelVersion'] as const)('rejects mismatched %s before solving', field => {
    expect(() => predictGaitCoupled(model, { ...observation, [field]: 'mismatched' }, targets)).toThrow(/identity or target mismatch/)
  })
  it.each(['missing', 'extra', 'replaced'] as const)('rejects a %s target set rather than silently using nominal targets', kind => {
    const invalid = new Map(targets), first = model.scene.joints[0]
    if (kind !== 'extra') invalid.delete(first.id)
    if (kind !== 'missing') invalid.set('unknown_joint', first.motor.target)
    expect(() => predictGaitCoupled(model, observation, invalid)).toThrow(/identity or target mismatch/)
  })
})
