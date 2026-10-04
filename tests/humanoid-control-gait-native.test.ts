/** Native walking and the narrower Round 2 fallback; measured physical failures remain explicit. */
import { it, expect, describe, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, tmpdir, join, emitMeasurement } from './humanoid-physics-node.mjs'
import { GAIT_ROUND_ONE_PROFILES, GAIT_TRIALS, GAIT_FALLBACK_TRIALS, GAIT_FALLBACK_RELEASE_TRIALS, GaitFootCycleMeter,
  measureGaitTrial, colliderFloorMinimum, unwrappedYawDelta, trialTimeFromAbsolute, preFallCycleCount, type GaitTrial } from './humanoid-control-gait-cases'
import { buildHumanoid } from '../src/sim/humanoid/physics/model'
import { fromRotationVector } from '../src/sim/physics/math'

it('gait measurement unwraps actual yaw across both signed pi boundaries', () => {
  expect(unwrappedYawDelta(Math.PI - .1, -Math.PI + .2)).toBeCloseTo(.3, 12)
  expect(unwrappedYawDelta(-Math.PI + .1, Math.PI - .2)).toBeCloseTo(-.3, 12)
  let previous = 0, total = 0
  for (let i = 1; i <= 100; i++) {
    const angle = Math.atan2(Math.sin(i * .1), Math.cos(i * .1))
    total += unwrappedYawDelta(previous, angle); previous = angle
  }
  expect(total).toBeCloseTo(10, 12)
})
it('gait measurement includes the upper face of a tipped foot and non-foot collider extents', () => {
  const model = buildHumanoid('keel-v1')
  for (const id of [model.feet[0], model.root]) {
    const spec = model.scene.bodies.find(body => body.id === id)!
    if (spec.shape.kind !== 'box') throw new Error('Expected native box fixture')
    const state = { ...spec, sleeping: false, position: { x: 0, y: .2, z: 0 }, rotation: fromRotationVector({ x: Math.PI / 2, y: 0, z: 0 }) }
    expect(colliderFloorMinimum(model, state)).toBeCloseTo(.2 - spec.shape.half.z, 12)
    state.rotation = fromRotationVector({ x: Math.PI, y: 0, z: 0 })
    expect(colliderFloorMinimum(model, state)).toBeCloseTo(.2 - spec.shape.half.y, 12)
  }
})
it('gait measurement requires continuous unloading, clearance and stable touchdown for a real cycle', () => {
  const meter = new GaitFootCycleMeter(true)
  let tick = 0
  const sample = (count: number, loaded: boolean, clearanceM: number) => {
    for (let i = 0; i < count; i++) meter.sample(++tick, loaded, clearanceM)
  }
  sample(50, true, .02) // A geometric gap with a reported contact is not an airborne step.
  sample(11, false, .02); sample(2, true, 0)
  sample(12, false, .009); sample(2, true, 0)
  sample(6, false, .02); sample(1, true, 0); sample(6, false, .02); sample(2, true, 0)
  expect(meter.report.qualifiedCycles).toBe(0)
  sample(12, false, .012); sample(1, true, 0)
  expect(meter.report.qualifiedCycles).toBe(0)
  sample(1, true, 0)
  expect(meter.report.qualifiedCycles).toBe(1); expect(meter.report.cyclesPerWindow).toEqual([1, 0, 0])
  expect(meter.report.events[0].unloadedS).toBe(.05); expect(meter.report.events[0].peakClearanceM).toBe(.012)
  expect(() => meter.sample(tick, true, 0)).toThrow(/sample/)
})
it('gait measurement distinguishes absolute fall clocks and excludes cycles confirmed during or after a fall', () => {
  expect(trialTimeFromAbsolute(4.6, 2)).toBeCloseTo(2.6, 12)
  expect(trialTimeFromAbsolute(2.875, 2)).toBe(.875)
  expect(trialTimeFromAbsolute(null, 2)).toBeNull(); expect(trialTimeFromAbsolute(4.6, null)).toBeNull()
  expect(() => trialTimeFromAbsolute(NaN, 2)).toThrow(/clock/)
  const events = [{ confirmedAtS: 1.45 }, { confirmedAtS: 2.6 }, { confirmedAtS: 3.67 }]
  expect(preFallCycleCount(events, 2.6)).toBe(1)
  expect(preFallCycleCount(events, null)).toBe(3)
})

const folder = mkdtempSync(join(tmpdir(), 'obpal-hc-gait-native-'))
const reports = new Map<string, Promise<Awaited<ReturnType<typeof measureGaitTrial>>>>()
function measured(profileId: string, trial: GaitTrial) {
  const key = `${profileId}-${trial}`
  if (!reports.has(key)) reports.set(key, measureGaitTrial(profileId, trial).then(report => {
    writeFileSync(join(folder, `${key}.json`), JSON.stringify(report))
    emitMeasurement(report) // Emit every measured failure before any physical assertion.
    return report
  }))
  return reports.get(key)!
}
/** Contact v3 walking: only complete unchanged physical gates become ordinary passing tests.
 * Runtime/finite/protocol checks remain ordinary tests.
 * Keel W1: 5.000 m in 16.529 s, last-3-m speed 0.369 m/s, no fall; 3.517 mm penetration.
 * Keel W2: stance in 1.071 s, held 10 s, no fall; 3.624 mm over the walking/stopping trial.
 * Keel W3: 4.272 rad in 10 s, no fall; 3.566 mm penetration.
 * Morrow W1: 5.001 m in 17.988 s, last-3-m speed 0.327 m/s, no fall; 3.562 mm penetration.
 * Morrow W2: support recenter reaches stance in 2.883 s, holds 10 s; 4.172 mm penetration, six starts pass.
 * Morrow W3: 4.006 rad in 10 s, no fall; 3.586 mm penetration, six starts pass.
 * Contact v3 Keel fallback: 30 s, two real cycles per foot, no falls; 3.670/3.776 mm in-place/turn.
 * Actual Keel turn is 0.327 rad; both release rows return to balance in 2.008 s and hold 10 s.
 * Contact v3 Morrow fallback: 30 s, two real cycles per foot, no falls; 3.518/3.077 mm in-place/turn.
 * Actual Morrow turn is 0.343 rad; release rows reach stance in 2.008/2.350 s and hold 10 s, six starts pass.
 * Expected failures must become ordinary passing assertions when their complete physical gates are met.
 */
for (const profile of GAIT_ROUND_ONE_PROFILES) for (const trial of [...GAIT_TRIALS, ...GAIT_FALLBACK_TRIALS, ...GAIT_FALLBACK_RELEASE_TRIALS]) describe(`humanoid gait pilot ${profile} ${trial}`, () => {
  let report: Awaited<ReturnType<typeof measureGaitTrial>>
  beforeAll(async () => { report = await measured(profile, trial) }, 600_000)
  it('native trial reaches a declared endpoint with finite samples and preserved JSON before acceptance', () => {
    expect(JSON.parse(readFileSync(join(folder, `${profile}-${trial}.json`), 'utf8'))).toEqual(report)
    expect(report.error).toBeNull(); expect(report.completed).toBe(true)
    expect(report.settleTicks).toBe(480); expect(report.baseline.samples).toBe(480)
    expect(report.completedTicks).toBeGreaterThan(0); expect(report.completedTicks).toBe(report.safety.samples)
    expect(report.completedTicks).toBeLessThanOrEqual(report.maximumTicks)
    if (report.terminationReason === 'first-fall') {
      expect(report.stopAtFirstFall).toBe(true); expect(report.pass).toBe(false); expect(report.horizonCompleted).toBe(false)
      expect(report.safety.noFall).toBe(false); expect(report.firstFallTimeS).not.toBeNull()
      expect(report.safety.firstFallTick).toBe(report.settleTicks + report.completedTicks)
      expect(report.firstFallTimeS!).toBeCloseTo(report.simulatedS, 10)
    } else if (report.terminationReason === 'full-horizon') {
      expect(report.completedTicks).toBe(report.maximumTicks); expect(report.horizonCompleted).toBe(true)
    } else if (report.terminationReason === 'distance') {
      expect(trial).toBe('W1'); expect(report.distance5mAtS).not.toBeNull()
    } else {
      expect(report.terminationReason).toBe('stop-hold'); expect(report.releaseAtS).not.toBeNull()
      expect(report.balanceStartedAtS).not.toBeNull(); expect(report.balanceStartedAtS!).toBeLessThanOrEqual(3)
      expect(report.returnedToStanceAtS).not.toBeNull(); expect(report.returnedToStanceAtS!).toBeLessThanOrEqual(3)
      expect(report.stanceHeldTicks).toBeGreaterThanOrEqual(2400); expect(report.stanceHoldBroken).toBe(false)
    }
    expect(report.droppedSeconds).toBe(0); expect(report.invalidFrames).toBe(0)
    expect(report.safety.finite).toBe(true); expect(report.trace.length).toBeGreaterThan(0)
    expect(Number.isFinite(report.preFallForwardDistanceM)).toBe(true); expect(Number.isFinite(report.preFallUnwrappedYawRad)).toBe(true)
    if (report.firstFallTimeS === null) {
      expect(report.preFallForwardDistanceM).toBe(report.forwardDistanceM); expect(report.preFallUnwrappedYawRad).toBe(report.unwrappedYawRad)
    } else expect(report.preFallSimulatedS).toBeLessThan(report.firstFallTimeS)
    expect(report.balanceAppliedTicks).toBe(report.phases.balance ?? 0)
    if (report.balanceAppliedTicks > 0) {
      expect(report.balanceStartedAtS).not.toBeNull(); expect(report.balanceStartedAtS!).toBeGreaterThan(0)
      expect(report.balanceAppliedTicks).toBeGreaterThanOrEqual(report.stanceHeldTicks)
    }
    if (trial === 'in-place-stop' || trial === 'turn-in-place-stop') {
      expect(report.releaseAtS).toBe(30)
      if (report.completedTicks >= 7200) {
        const release = report.releaseSnapshot
        expect(release).not.toBeNull(); expect(release!.completedTicks).toBe(7200); expect(release!.simulatedS).toBe(30)
        expect(Number.isFinite(release!.unwrappedYawRad)).toBe(true)
        expect(release!.maxTranslationM).toBeLessThanOrEqual(report.maxTranslationM)
        expect(release!.maximumHeadingDriftRad).toBeLessThanOrEqual(report.maximumHeadingDriftRad)
        expect(Object.keys(release!.footCycles)).toHaveLength(2)
        for (const [id, foot] of Object.entries(release!.footCycles)) {
          expect(foot.samples).toBe(7200); expect(foot.events).toHaveLength(foot.qualifiedCycles)
          expect(foot.events.every(event => event.confirmedAtS <= 30)).toBe(true)
          expect(foot.qualifiedCycles).toBeLessThanOrEqual(report.footCycles[id].qualifiedCycles)
        }
      } else { expect(report.releaseSnapshot).toBeNull(); expect(report.releaseMotionQualified).toBe(false) }
    }
    expect(report.wallMs).toBeGreaterThan(0); expect(report.p99TickWallMs).toBeGreaterThanOrEqual(report.p95TickWallMs)
  })
  it(`${trial} measured physical acceptance with native non-foot floor impulses`, () => {
    expect(report.pass, JSON.stringify({ profile, trial, preFallForwardDistanceM: report.preFallForwardDistanceM,
      speedMps: report.last3mMeanSpeedMps, preFallUnwrappedYawRad: report.preFallUnwrappedYawRad, stopS: report.returnedToStanceAtS,
      releaseMotionQualified: report.releaseMotionQualified, balanceStartedAtS: report.balanceStartedAtS,
      releaseYawRad: report.releaseSnapshot?.unwrappedYawRad,
      releaseCycles: report.releaseSnapshot && Object.fromEntries(Object.entries(report.releaseSnapshot.footCycles).map(([id, foot]) => [id, foot.preFallQualifiedCycles])),
      heldTicks: report.stanceHeldTicks, footCycles: report.footCycles, maxTranslationM: report.maxTranslationM,
      firstViolation: report.safety.firstViolation })).toBe(true)
  })
})
it('prints the required six-trial table and refuses missing Keel/Morrow W1-W3 trials', async () => {
  const rows = []
  for (const profile of GAIT_ROUND_ONE_PROFILES) for (const trial of GAIT_TRIALS) rows.push(await measured(profile, trial))
  const table = rows.map(row => ({ profileId: row.profileId, trial: row.trial, pass: row.pass, error: row.error,
    completed: row.completed, terminationReason: row.terminationReason, horizonCompleted: row.horizonCompleted,
    completedTicks: row.completedTicks, simulatedS: row.simulatedS, wallMs: row.wallMs,
    firstFallTimeS: row.firstFallTimeS, firstViolationTimeS: row.firstViolationTimeS,
    preFallForwardDistanceM: row.preFallForwardDistanceM, preFallUnwrappedYawRad: row.preFallUnwrappedYawRad, preFallSimulatedS: row.preFallSimulatedS,
    preFallCycles: Object.fromEntries(Object.entries(row.footCycles).map(([id, foot]) => [id, foot.preFallQualifiedCycles])),
    distanceM: row.forwardDistanceM, distance5mAtS: row.distance5mAtS, last3mMeanSpeedMps: row.last3mMeanSpeedMps,
    actualYawRad: row.unwrappedYawRad, releaseSpeedMps: row.releaseSpeedMps, returnedToStanceAtS: row.returnedToStanceAtS,
    stanceHeldTicks: row.stanceHeldTicks, safety: row.safety }))
  emitMeasurement({ schema_version: 1, kind: 'humanoid-control-gait-round-one-table',
    acceptanceScope: 'Unchanged pilot and selected Rapier backend with copied native contacts. W1 excludes phone soft wall for the required straight 5 m track.',
    clock: 'Top-level firstFallTimeS and firstViolationTimeS are trial-relative; nested safety timestamps are absolute and include the 2 s settle.', table })
  writeFileSync(join(folder, 'table.json'), JSON.stringify(table, null, 2))
  expect(table).toHaveLength(6); expect(new Set(table.map(row => `${row.profileId}/${row.trial}`)).size).toBe(6)
  expect(table.every(row => row.completedTicks > 0 && !row.error)).toBe(true)
}, 600_000)
it('prints the four-row fallback-release table without borrowing cycles or turning from after release', async () => {
  const rows = []
  for (const profile of GAIT_ROUND_ONE_PROFILES) for (const trial of GAIT_FALLBACK_RELEASE_TRIALS) rows.push(await measured(profile, trial))
  const table = rows.map(row => ({ profileId: row.profileId, trial: row.trial, pass: row.pass, error: row.error,
    completed: row.completed, terminationReason: row.terminationReason, horizonCompleted: row.horizonCompleted,
    completedTicks: row.completedTicks, simulatedS: row.simulatedS, wallMs: row.wallMs,
    releaseAtS: row.releaseAtS, releaseSnapshot: row.releaseSnapshot, releaseMotionQualified: row.releaseMotionQualified,
    balanceStartedAtS: row.balanceStartedAtS, balanceAppliedTicks: row.balanceAppliedTicks,
    returnedToStanceAtS: row.returnedToStanceAtS, stanceHeldTicks: row.stanceHeldTicks, stanceHoldBroken: row.stanceHoldBroken,
    firstFallTimeS: row.firstFallTimeS, firstViolationTimeS: row.firstViolationTimeS,
    preFallForwardDistanceM: row.preFallForwardDistanceM, preFallUnwrappedYawRad: row.preFallUnwrappedYawRad,
    maxTranslationM: row.maxTranslationM, maximumHeadingDriftRad: row.maximumHeadingDriftRad, safety: row.safety }))
  emitMeasurement({ schema_version: 1, kind: 'humanoid-control-gait-fallback-release-table',
    acceptanceScope: 'Command fallback for 30 s; freeze its genuine cycles, actual yaw and displacement before releasing. Require actual BalanceController actuation and the original stance envelope within 3 s, held 10 s. No walking-speed prerequisite. No-fall, 5 mm penetration, effort caps and fallback drift limits cover the entire trial.',
    clock: 'Release is at trial time 30 s. balanceStartedAtS and returnedToStanceAtS are release-relative; top-level fall/violation times are trial-relative; nested safety times include the 2 s settle.', table })
  writeFileSync(join(folder, 'fallback-release-table.json'), JSON.stringify(table, null, 2))
  expect(table).toHaveLength(4); expect(new Set(table.map(row => `${row.profileId}/${row.trial}`)).size).toBe(4)
  expect(table.every(row => row.completed && !row.error && row.completedTicks > 0
    && ['full-horizon', 'stop-hold', 'first-fall'].includes(row.terminationReason!))).toBe(true)
}, 600_000)
it('prints all four fallback trials with planned 30-second horizons, contact cycles and actual heading', async () => {
  const rows = []
  for (const profile of GAIT_ROUND_ONE_PROFILES) for (const trial of GAIT_FALLBACK_TRIALS) rows.push(await measured(profile, trial))
  const table = rows.map(row => ({ profileId: row.profileId, trial: row.trial, pass: row.pass, error: row.error,
    completed: row.completed, terminationReason: row.terminationReason, horizonCompleted: row.horizonCompleted,
    completedTicks: row.completedTicks, simulatedS: row.simulatedS, wallMs: row.wallMs, safety: row.safety,
    firstFallTimeS: row.firstFallTimeS, firstViolationTimeS: row.firstViolationTimeS,
    preFallForwardDistanceM: row.preFallForwardDistanceM, preFallUnwrappedYawRad: row.preFallUnwrappedYawRad, preFallSimulatedS: row.preFallSimulatedS,
    actualYawRad: row.unwrappedYawRad, maximumHeadingDriftRad: row.maximumHeadingDriftRad,
    netTranslationM: row.netTranslationM, maxTranslationM: row.maxTranslationM, reportedControllerSteps: row.reportedControllerSteps,
    footCycles: row.footCycles, simulationDefaults: row.fallbackDefaults }))
  emitMeasurement({ schema_version: 1, kind: 'humanoid-control-gait-fallback-table',
    acceptanceScope: 'Slow-cadence fallback simulation defaults require 30 s, two qualified cycles per foot and actual signed turning >=0.3 rad for turn-in-place. Per-window counts remain measurements only. No-fall, 5 mm penetration, effort caps, cycle clearance/unload/touchdown and maximum 0.30 m drift are unchanged. This does not establish W1-W3 walking acceptance, whose W3 turn threshold remains 3 rad.',
    clock: 'Top-level firstFallTimeS and firstViolationTimeS are trial-relative; nested safety timestamps are absolute and include the 2 s settle.', table })
  writeFileSync(join(folder, 'fallback-table.json'), JSON.stringify(table, null, 2))
  expect(table).toHaveLength(4); expect(new Set(table.map(row => `${row.profileId}/${row.trial}`)).size).toBe(4)
  expect(table.every(row => row.completed && !row.error && (row.terminationReason === 'full-horizon'
    ? row.completedTicks === 7200 && row.horizonCompleted
    : row.terminationReason === 'first-fall' && !row.horizonCompleted && !row.pass && row.firstFallTimeS !== null))).toBe(true)
}, 600_000)
