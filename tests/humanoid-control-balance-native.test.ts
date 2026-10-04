/** Native quiet-stance acceptance uses the unchanged F1a2 gates and a free Rapier actor. */
import { describe, expect, it, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, tmpdir, join, emitMeasurement } from './humanoid-physics-node.mjs'
import { ALL_PHYSICAL_PROFILES, buildHumanoid } from '../src/sim/humanoid/physics/model'
import { HumanoidPilot } from '../src/sim/humanoid/physics/pilot'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { constraintMetrics } from '../src/sim/humanoid/physics/measure'
import { STANCE_SECONDS, SETTLE_SECONDS, percentile, stancePass, type StanceRow } from '../src/sim/humanoid/physics/acceptance'
import { STEP } from '../src/sim/physics/schema'
import { rotate } from '../src/sim/physics/math'
import type { Observation } from '../src/sim/humanoid/physics/observation'

const folder = mkdtempSync(join(tmpdir(), 'obpal-hc-balance-native-'))
const controllerKind = 'capture-balance'
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

function captureMetrics(observation: Observation, gravityMps2: number) {
  const polygon = observation.support.polygon, impulse = observation.feet.reduce((sum, foot) => sum + foot.normalImpulseNs, 0)
  if (polygon.length < 3 || impulse <= 0) return null
  const copY = observation.feet.reduce((sum, foot) => sum + (foot.centreOfPressure?.y ?? 0) * foot.normalImpulseNs, 0) / impulse
  const height = observation.com.y - copY
  if (!(height > 0)) return null
  const omega = Math.sqrt(gravityMps2 / height)
  const capture = { x: observation.com.x + observation.comVelocity.x / omega, z: observation.com.z + observation.comVelocity.z / omega }
  let area2 = 0, x = 0, z = 0
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length], cross = a.x * b.z - b.x * a.z
    area2 += cross; x += (a.x + b.x) * cross; z += (a.z + b.z) * cross
  }
  if (area2 === 0) return null
  return { centroidDistanceM: Math.hypot(capture.x - x / (3 * area2), capture.z - z / (3 * area2)),
    marginM: Math.min(...polygon.map((a, i) => {
      const b = polygon[(i + 1) % polygon.length]
      return Math.sign(area2) * ((b.x - a.x) * (capture.z - a.z) - (b.z - a.z) * (capture.x - a.x)) / Math.hypot(b.x - a.x, b.z - a.z)
    })) }
}

async function measure(profileId: string) {
  const model = buildHumanoid(profileId)
  const stance: StanceRow = { completedTicks: 0, expectedTicks: STANCE_SECONDS / STEP, maxPenetrationMm: 0, maxHoverMm: 0, slipMm: 0,
    minPelvisHeightM: Infinity, standingHeightM: model.scene.bodies.find(body => body.id === model.root)!.position.y,
    minUp: 1, supportedSamples: 0, settledSamples: 0, maxAnchorErrorMm: 0, maxLimitSurfaceErrorMm: 0, maxConeErrorRad: 0,
    maxEffortRatio: 0, p95TickWallMs: NaN, p99TickWallMs: NaN, droppedSeconds: 0, invalidFrames: 0, error: null }
  const control = { sampledTicks: 0, phases: {} as Record<string, number>, quietFrameMismatches: 0,
    captureSamples: 0, minCaptureMarginM: Infinity, minCaptureCentroidDistanceM: Infinity, maxCaptureCentroidDistanceM: 0, maxHorizontalSpeedMps: 0 }
  const timings: number[] = [], planted = new Map<string, { x: number; z: number }>()
  let pilot: HumanoidPilot | undefined, metadata: ReturnType<HumanoidPilot['metadata']> | null = null
  try {
    pilot = await HumanoidPilot.create(model)
    metadata = pilot.metadata()
    const controller = new BalanceController(model, pilot.generation), reference = new StanceController(model, pilot.generation)
    for (let tick = 0; tick < stance.expectedTicks; tick++) {
      const start = performance.now()
      pilot.advance(STEP, observation => {
        const result = controller.step(observation), phase: string = result.diagnostics.phase
        control.sampledTicks++; control.phases[phase] = (control.phases[phase] ?? 0) + 1
        if (phase === 'quiet' && JSON.stringify(result.frame) !== JSON.stringify(reference.step(observation).frame)) control.quietFrameMismatches++
        const capture = captureMetrics(observation, -model.scene.gravity.y)
        if (capture) {
          control.captureSamples++
          control.minCaptureMarginM = Math.min(control.minCaptureMarginM, capture.marginM)
          control.minCaptureCentroidDistanceM = Math.min(control.minCaptureCentroidDistanceM, capture.centroidDistanceM)
          control.maxCaptureCentroidDistanceM = Math.max(control.maxCaptureCentroidDistanceM, capture.centroidDistanceM)
        }
        control.maxHorizontalSpeedMps = Math.max(control.maxHorizontalSpeedMps, Math.hypot(observation.comVelocity.x, observation.comVelocity.z))
        return result.frame
      })
      timings.push(performance.now() - start)
      const observation = pilot.observation(), diagnostics = pilot.diagnostics(), root = observation.bodies.find(body => body.id === model.root)!
      const metrics = constraintMetrics(model, observation)
      stance.completedTicks = diagnostics.tick
      stance.minPelvisHeightM = Math.min(stance.minPelvisHeightM, root.position.y)
      stance.minUp = Math.min(stance.minUp, rotate(root.rotation, { x: 0, y: 1, z: 0 }).y)
      stance.maxAnchorErrorMm = Math.max(stance.maxAnchorErrorMm, metrics.anchorMm)
      stance.maxLimitSurfaceErrorMm = Math.max(stance.maxLimitSurfaceErrorMm, metrics.surfaceMm)
      stance.maxConeErrorRad = Math.max(stance.maxConeErrorRad, metrics.coneRad)
      for (const joint of model.scene.joints) {
        const torque = diagnostics.forces.motorTorques[joint.id]
        if (!Number.isFinite(torque)) throw new Error(`Missing or invalid effort for ${joint.id}`)
        stance.maxEffortRatio = Math.max(stance.maxEffortRatio, Math.abs(torque) / joint.motor.maxTorque)
      }
      for (const foot of observation.feet) {
        stance.maxPenetrationMm = Math.max(stance.maxPenetrationMm, -foot.minSoleY * 1000)
        stance.maxHoverMm = Math.max(stance.maxHoverMm, foot.maxSoleY * 1000)
        if (tick >= SETTLE_SECONDS / STEP) {
          if (!planted.has(foot.id)) planted.set(foot.id, { x: foot.centre.x, z: foot.centre.z })
          const start = planted.get(foot.id)!
          stance.slipMm = Math.max(stance.slipMm, Math.hypot(foot.centre.x - start.x, foot.centre.z - start.z) * 1000)
        }
      }
      if (tick >= SETTLE_SECONDS / STEP) {
        stance.settledSamples++
        if (observation.support.normalImpulseNs > 0 && observation.support.marginM !== null && observation.support.marginM >= 0) stance.supportedSamples++
      }
    }
  } catch (error) { stance.error = message(error) }
  finally {
    if (pilot) {
      const diagnostics = pilot.diagnostics()
      stance.droppedSeconds = diagnostics.droppedSeconds; stance.invalidFrames = diagnostics.invalidFrames
      try { pilot.dispose() } catch (error) { stance.error = `${stance.error ?? ''} disposal: ${message(error)}`.trim() }
    }
    stance.p95TickWallMs = percentile(timings, .95); stance.p99TickWallMs = percentile(timings, .99)
  }
  return { schema_version: 1, kind: 'humanoid-control-quiet-stance', controller: controllerKind, profileId, modelVersion: model.version,
    stance, control, quietDelegationExercised: (control.phases.quiet ?? 0) > 0, metadata,
    timingNote: 'Full-run fixed-tick wall time includes input validation, observations and journaling; not warm browser frame work or a frame-budget claim.',
    pass: stancePass(stance) && control.quietFrameMismatches === 0 }
}

const reports = new Map<string, Promise<Awaited<ReturnType<typeof measure>>>>()
function measured(profileId: string) {
  if (!reports.has(profileId)) reports.set(profileId, measure(profileId).then(report => {
    emitMeasurement(report)
    writeFileSync(join(folder, `${profileId}.json`), JSON.stringify(report))
    return report
  }))
  return reports.get(profileId)!
}

for (const profileId of ALL_PHYSICAL_PROFILES) describe(`humanoid balance quiet stance: ${profileId}`, () => {
  let report: Awaited<ReturnType<typeof measure>>
  beforeAll(async () => { report = await measured(profileId) }, 120_000)
  it('completes and prints every native tick before testing the unchanged stance envelope', () => {
    expect(JSON.parse(readFileSync(join(folder, `${profileId}.json`), 'utf8'))).toEqual(report)
    expect(report.metadata?.id).toBe('rapier')
    expect(report.stance.error).toBeNull()
    expect(report.stance.completedTicks).toBe(7200)
    expect(report.stance.expectedTicks).toBe(7200)
    expect(report.control.sampledTicks).toBe(7200)
    expect(Object.values(report.control.phases).reduce((sum, count) => sum + count, 0)).toBe(7200)
    expect(report.control.captureSamples).toBeGreaterThan(0)
    expect(Number.isFinite(report.control.minCaptureMarginM)).toBe(true)
    expect(Number.isFinite(report.control.minCaptureCentroidDistanceM)).toBe(true)
  })
  it('retains all 30 s F1a2 stance gates without a root force or body write', () => {
    expect(stancePass(report.stance), JSON.stringify(report.stance)).toBe(true)
  })
  it('matches StanceController on any quiet-selected tick (phase counts report coverage)', () => {
    expect(report.control.quietFrameMismatches).toBe(0)
  })
})

it('prints a complete eight-form native balance table and rejects missing trials', async () => {
  const rows = await Promise.all(ALL_PHYSICAL_PROFILES.map(measured))
  emitMeasurement({ schema_version: 1, kind: 'humanoid-control-quiet-stance-table', controller: controllerKind, rows })
  expect(rows).toHaveLength(8)
  expect(new Set(rows.map(row => row.profileId)).size).toBe(8)
  expect(rows.map(row => row.profileId)).toEqual([...ALL_PHYSICAL_PROFILES])
  expect(rows.every(row => row.stance.completedTicks === 7200 && row.control.sampledTicks === 7200 && row.stance.error === null)).toBe(true)
}, 600_000)
