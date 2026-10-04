/** Round 1 standing BODY trials on the selected Rapier pilot. World/gait/push coverage belongs to Round 2. */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, tmpdir, join, emitMeasurement } from './humanoid-physics-node.mjs'
import { STEP } from '../src/sim/physics/schema'
import { angleBetween, rotate } from '../src/sim/physics/math'
import { neutral, rad } from '../src/sim/humanoid/profile'
import type { Retargeted } from '../src/sim/humanoid/retarget'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, profileFor, targetsFromAngles } from '../src/sim/humanoid/physics/model'
import { percentile } from '../src/sim/humanoid/physics/acceptance'
import { HumanoidPilot } from '../src/sim/humanoid/physics/pilot'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { UpperBodyController } from '../src/sim/humanoid/physics/upper-body'

const folder = mkdtempSync(join(tmpdir(), 'obpal-hc-body-'))
const TRIAL = Object.freeze({ holdS: 2, traceS: 4, afterLossS: 1, medianRad: .15, p95Rad: .35 }) // Original simulation defaults, s and rad.
async function measure(profileId: string, actorId: string) {
  const model = buildHumanoid(profileId, actorId), profile = profileFor(profileId)
  const expectedTicks = Math.round((TRIAL.holdS + TRIAL.traceS + TRIAL.afterLossS) / STEP), holdTicks = Math.round(TRIAL.holdS / STEP)
  const traceTicks = Math.round(TRIAL.traceS / STEP), lossTicks = Math.round(.25 / STEP), errorSamples: number[] = []
  const row = { profileId, actorId, expectedTicks, completedTicks: 0, expectedTraceTicks: traceTicks, traceTicks: 0, expectedErrorSamples: 0, errorSamples: 0,
    medianErrorRad: NaN, p95ErrorRad: NaN, minUpY: 1, minPelvisHeightM: Infinity,
    standingHeightM: model.scene.bodies.find(b => b.id === model.root)!.position.y,
    maxPenetrationMm: 0, maxHoverMm: 0, maxEffortRatio: 0, supportedTraceTicks: 0, maxFootUnloadedS: 0,
    lossWeightAt250ms: NaN, maxTargetStepRad: 0, faults: 0, error: null as string | null }
  let instance: HumanoidPilot | null = null, metadata: ReturnType<HumanoidPilot['metadata']> | null = null
  const upperDrives = model.drives.filter(d => d.axes.some(n => n.includes('.arm.') || n.startsWith('head.') || n === 'spine.yaw'))
  row.expectedErrorSamples = traceTicks * upperDrives.length
  let previousTargets = Object.fromEntries(model.scene.joints.map(j => [j.id, j.motor.target])), unloaded = [0, 0]
  try {
    const pilot = await HumanoidPilot.create(model, { journalCapacity: 1 }); instance = pilot
    const stance = new StanceController(model, pilot.generation), upper = new UpperBodyController(model, pilot.generation)
    metadata = pilot.metadata()
    for (let tick = 0; tick < expectedTicks; tick++) {
      const elapsed = (tick - holdTicks) * STEP, inTrace = elapsed >= 0 && elapsed < TRIAL.traceS
      const q = neutral(profile), phase = elapsed * Math.PI / 2
      for (const [side, sign] of [['left', 1], ['right', -1]] as const) {
        q[`${side}.arm.roll`] = rad(20) + .12 * Math.sin(phase * .7)
        q[`${side}.arm.pitch`] = .3 + .2 * Math.sin(phase * .8 + sign * .2)
        q[`${side}.arm.yaw`] = sign * .1 * Math.sin(phase * .6)
        q[`${side}.arm.elbow`] = .45 + .15 * Math.sin(phase + sign * .3)
        q[`${side}.arm.wrist.pitch`] = .1 * Math.sin(phase)
        q[`${side}.arm.wrist.roll`] = sign * .1 * Math.sin(phase * .8)
      }
      q['head.yaw'] = .15 * Math.sin(phase * .7); q['head.pitch'] = .1 * Math.sin(phase * .8)
      q['spine.yaw'] = .1 * Math.sin(phase * .5)
      // Nonzero leg input proves BODY never overwrites the stance controller's targets.
      q['left.leg.pitch'] = .8; q['right.leg.knee'] = 1.1; q.pelvis = 1
      const trace: Retargeted | null = inTrace ? { q, raw: q, tracked: true, valid: new Set(Object.keys(q)),
        calibrating: false, generation: 4, residual: 0, limited: false, heading: .6 * Math.sin(phase) } : null
      const desired = inTrace ? targetsFromAngles(model, { ...q, pelvis: 0 }) : null
      let weight = NaN
      pilot.advance(STEP, o => {
        const legs = stance.step(o).frame, result = upper.step(o, legs, { mode: 'stance', body: trace })
        weight = result.diagnostics.trackWeight
        for (const drive of model.drives.filter(d => d.axes.some(n => n.includes('.leg.'))))
          if (JSON.stringify(result.frame.targets[drive.id]) !== JSON.stringify(legs.targets[drive.id])) throw new Error('BODY changed a leg target')
        return result.frame
      })
      const o = pilot.observation(), root = o.bodies.find(b => b.id === model.root)!, diagnostics = pilot.diagnostics()
      row.completedTicks = o.stateTick
      if (diagnostics.status === 'faulted' || diagnostics.fault !== null) row.faults++
      if (o.stateTick !== tick + 1 || diagnostics.status !== 'ready') throw new Error('BODY pilot failed to complete the requested tick')
      row.minUpY = Math.min(row.minUpY, rotate(root.rotation, { x: 0, y: 1, z: 0 }).y)
      row.minPelvisHeightM = Math.min(row.minPelvisHeightM, root.position.y)
      for (const [id, torque] of Object.entries(diagnostics.forces.motorTorques))
        row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / model.scene.joints.find(j => j.id === id)!.motor.maxTorque)
      const accepted = pilot.journal().at(-1)!.action.targets
      for (const id of Object.keys(accepted)) row.maxTargetStepRad = Math.max(row.maxTargetStepRad, angleBetween(previousTargets[id], accepted[id]))
      previousTargets = accepted
      for (const [index, foot] of o.feet.entries()) {
        row.maxPenetrationMm = Math.max(row.maxPenetrationMm, -foot.minSoleY * 1000)
        row.maxHoverMm = Math.max(row.maxHoverMm, foot.maxSoleY * 1000)
        if (tick >= holdTicks) { unloaded[index] = foot.normalImpulseNs > 0 ? 0 : unloaded[index] + STEP; row.maxFootUnloadedS = Math.max(row.maxFootUnloadedS, unloaded[index]) }
      }
      if (inTrace) {
        row.traceTicks++
        if (o.feet.every(f => f.normalImpulseNs > 0) && o.support.polygon.length >= 3) row.supportedTraceTicks++
        for (const drive of upperDrives) errorSamples.push(angleBetween(o.joints.find(j => j.id === drive.id)!.rotation, desired![drive.id]))
      }
      if (tick === holdTicks + traceTicks + lossTicks - 1) row.lossWeightAt250ms = weight
    }
  } catch (error) { row.error = error instanceof Error ? error.message : String(error) }
  finally { instance?.dispose() }
  row.errorSamples = errorSamples.length; row.medianErrorRad = percentile(errorSamples, .5); row.p95ErrorRad = percentile(errorSamples, .95)
  return { ...row, metadata }
}
for (const profile of ALL_PHYSICAL_PROFILES) describe(`BODY standing acceptance: ${profile}`, () => {
  let rows: Awaited<ReturnType<typeof measure>>[]
  beforeAll(async () => {
    rows = []
    for (const actor of ['seat1', 'seat2']) rows.push(await measure(profile, actor))
    const report = { kind: 'humanoid-control-body-standing', profileId: profile, thresholds: TRIAL, rows,
      scope: 'Two sequential independent pilots; coupled-world seat isolation is not measured here.' }
    writeFileSync(join(folder, `${profile}.json`), JSON.stringify(report, null, 2)); emitMeasurement(report)
  }, 180_000)
  it('completes both seats and every requested trace/error sample without faults', () => {
    expect(rows.map(r => r.actorId)).toEqual(['seat1', 'seat2'])
    for (const row of rows) {
      expect(row.error).toBeNull(); expect(row.faults).toBe(0)
      expect(row.completedTicks).toBe(row.expectedTicks); expect(row.traceTicks).toBe(row.expectedTraceTicks)
      expect(row.errorSamples).toBe(row.expectedErrorSamples)
    }
  })
  it('tracks the synthetic upper body within median 0.15 and p95 0.35 rad', () => {
    for (const row of rows) { expect(row.medianErrorRad).toBeLessThanOrEqual(TRIAL.medianRad); expect(row.p95ErrorRad).toBeLessThanOrEqual(TRIAL.p95Rad) }
  })
  it('holds the stance envelope throughout and support throughout the trace', () => {
    for (const row of rows) {
      expect(row.minUpY).toBeGreaterThanOrEqual(.98); expect(row.minPelvisHeightM).toBeGreaterThanOrEqual(.9 * row.standingHeightM)
      expect(row.maxPenetrationMm).toBeLessThanOrEqual(5); expect(row.maxHoverMm).toBeLessThanOrEqual(5)
      expect(row.supportedTraceTicks).toBe(row.expectedTraceTicks)
    }
  })
  it('respects effort and slew caps and fades to zero in 250 ms', () => {
    for (const row of rows) {
      expect(row.maxEffortRatio).toBeLessThanOrEqual(1 + 1e-8); expect(row.maxTargetStepRad).toBeLessThanOrEqual(4 * STEP + 1e-10)
      expect(row.lossWeightAt250ms).toBe(0)
    }
  })
})
