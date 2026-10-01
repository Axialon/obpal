/** Synthetic rows test the decision rule, never used as benchmark evidence. */
import { assert } from './sim-node.mjs'
import { selectEngine } from '../src/sim/physics/decision'
import * as decisions from '../src/sim/physics/decision'
import { candidateFailures, type CandidateResult } from '../src/sim/physics/bench'
import { FIXTURE_NAMES } from '../src/sim/physics/fixtures'
import type { EngineId } from '../src/sim/physics/schema'
function candidate(id: EngineId, cpu = .2, bytes = 1000): CandidateResult {
  return { id, environment: 'browser:synthetic-rule-test', status: 'measured', blocker: null, factoryLoadMs: 1, coldInitMs: 2,
    transfer: { rawBytes: bytes * 2, gzipBytes: bytes, files: 1 }, browserHeapBytes: null,
    lifecycle: ['lifecycle', 'init', 'fault'].map(name => ({ name, passed: true, error: null })),
    fixtures: FIXTURE_NAMES.map(fixture => ({ fixture, status: 'measured', blocker: null, failures: [], repeatFailures: [], repeatabilityMaxDelta: 0,
      sampledFrames: 100, initMs: 1, cpuMs: { p50: cpu, p95: cpu, p99: cpu, samples: 1000, zeroSamples: 0 }, version: 'synthetic', memoryBytes: null,
      capabilities: { contacts: 'synthetic', articulation: 'synthetic', motor: 'bounded-torque', cones: 'synthetic', wheels: 'static-ray-suspension', buoyancy: 'sampled-displacement', unsupported: [] },
      metrics: { simulatedSeconds: 5, penetrationM: 0, constraintErrorM: .001, peakConeErrorRad: .001, finalConeErrorRad: .001,
        finalSpeedMps: 0, finalAngularSpeedRadps: 0, finalRelativeAngularSpeedRadps: 0, finalY: fixture === 'drop' ? .25 : .6,
        targetErrorRad: 0, motorSettlingSeconds: 1, peakMotorTorqueNm: 1, rollingLoadN: 98.1, rollingDistanceM: 2,
        floatingTrimM: 0, displacedVolumeM3: .003, energyDriftRelative: .01, energyRiseJ: 0,
        dampingRatio: .015, dampingExpectedRatio: .015 } })) }
}
export function decisionCases(test: (name: string, run: () => unknown | Promise<unknown>) => unknown) {
  test('decision: missing data, NaN and mixed runtimes cannot select an engine', () => {
    for (const change of [
      (r: CandidateResult) => { r.transfer = null },
      (r: CandidateResult) => { r.fixtures[0].cpuMs.p95 = NaN },
      (r: CandidateResult) => { r.fixtures[0].metrics.constraintErrorM = null },
      (r: CandidateResult) => { r.fixtures[0].initMs = null },
      (r: CandidateResult) => { r.fixtures[0].repeatabilityMaxDelta = null },
    ]) {
      const rows = [candidate('custom'), candidate('rapier'), candidate('physx')]; change(rows[1]); change(rows[2])
      assert.equal(selectEngine(rows).status, 'pending')
    }
    const rows = [candidate('custom'), candidate('rapier'), candidate('physx')]; rows[1].environment = 'node:test'
    assert.equal(selectEngine(rows).status, 'pending'); assert.equal(selectEngine(rows.slice(0, 2)).status, 'pending')
  })
  test('decision: quality outranks CPU, and CPU outranks bytes outside the 10% band', () => {
    const rows = [candidate('custom', .01, 1), candidate('rapier', .2, 100), candidate('physx', .1, 1000)]
    assert.equal(selectEngine(rows).selected, 'physx')
    rows[2].fixtures[0].metrics.constraintErrorM = .01
    assert.equal(selectEngine(rows).selected, 'rapier')
    rows[2] = candidate('physx', .21, 90)
    assert.equal(selectEngine(rows).selected, 'physx')
  })
  test('decision: unsupported/failed fixtures and failed replay never count as passes', () => {
    const rows = [candidate('custom'), candidate('rapier'), candidate('physx')]
    rows[1].fixtures[0].status = 'blocked'; rows[1].fixtures[0].blocker = 'synthetic unsupported fixture'
    rows[2].fixtures[0].repeatabilityMaxDelta = .5
    assert.equal(selectEngine(rows).status, 'pending'); assert.ok(candidateFailures(rows[1]).length > 0)
    rows[2] = candidate('physx'); rows[2].fixtures[0].metrics.penetrationM = 1
    assert.equal(selectEngine(rows).status, 'pending')
  })
  test('decision: browser errors and malformed percentile tables disqualify candidates', () => {
    for (const change of [
      (r: CandidateResult) => { Object.assign(r, { browserErrors: ['native runtime error'] }) },
      (r: CandidateResult) => { r.fixtures[0].cpuMs.p50 = NaN },
      (r: CandidateResult) => { r.fixtures[0].cpuMs.p99 = -1 },
      (r: CandidateResult) => { r.fixtures[0].cpuMs.p50 = r.fixtures[0].cpuMs.p95 + 1 },
    ]) {
      const rows = [candidate('custom'), candidate('rapier'), candidate('physx')]; change(rows[1]); change(rows[2])
      assert.equal(selectEngine(rows).status, 'pending')
    }
  })
  test('decision: cross-profile selection requires both profiles and prioritises the stress profile', () => {
    const choose = (decisions as unknown as { selectAcrossProfiles?: (rows: CandidateResult[]) => { selected: EngineId | null; status: string } }).selectAcrossProfiles
    assert.equal(typeof choose, 'function')
    const rows = ['chromium-native', 'chromium-4x-throttle'].flatMap((profile, n) =>
      [candidate('custom'), candidate('rapier', n ? .2 : .1), candidate('physx', n ? .1 : .2)].map(r => ({ ...r, environment: `browser:${profile}` })))
    assert.equal(choose!(rows).selected, 'physx')
    assert.equal(choose!(rows.slice(0, 3)).status, 'pending')
    rows[2].fixtures[0].metrics.penetrationM = 1
    assert.equal(choose!(rows).selected, 'rapier')
    rows[1].fixtures[0].metrics.penetrationM = 1
    assert.equal(choose!(rows).status, 'pending')
  })

}
