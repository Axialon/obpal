/** Standing push acceptance retains measured red rows; native safety and disturbance protocol are ordinary checks. */
import { beforeAll, describe, expect, it } from 'vitest'
import { measurePushTrial, PUSH_CLASSES, PUSH_DIRECTIONS, PUSH_PILOTS } from './humanoid-control-push-cases'
import { emitMeasurement, join, mkdtempSync, readFileSync, tmpdir, writeFileSync } from './humanoid-physics-node.mjs'

const folder = mkdtempSync(join(tmpdir(), 'obpal-hc-push-native-'))
function emitTrial(row: Awaited<ReturnType<typeof measurePushTrial>>) {
  const { trace: _trace, measurement: _measurement, footCycles, ...summary } = row
  emitMeasurement({ ...summary, footCycles: footCycles.map(({ id, report }) => ({ id,
    maxClearanceM: report.maxClearanceM, qualifiedCycles: report.qualifiedCycles, preFallQualifiedCycles: report.preFallQualifiedCycles })) })
}
/** Current native measurements at the unchanged 5 mm gate. All rows below fall; finite/cap checks stay ordinary. */
const redRows: Readonly<Record<string, { peakMm: number; fallS: number }>> = {
  'keel-v1-B-lateral': { peakMm: 5.077, fallS: 1.521 },
  'morrow-v1-B-lateral': { peakMm: 3.753, fallS: 1.350 },
  'keel-v1-C-toe': { peakMm: 3.202, fallS: .838 },
  'keel-v1-C-heel': { peakMm: 4.190, fallS: 1.050 },
  'keel-v1-C-lateral': { peakMm: 3.701, fallS: .892 },
  'keel-v1-C-diagonal': { peakMm: 3.686, fallS: 2.479 },
  'morrow-v1-C-toe': { peakMm: 2.868, fallS: .733 },
  'morrow-v1-C-heel': { peakMm: 4.089, fallS: .938 },
  'morrow-v1-C-lateral': { peakMm: 4.287, fallS: 1.092 },
}
/** Simulation-default robustness fixtures, m and rad; separate from the original nominal push table. */
const robustnessStarts = [
  { x: 0, z: 0, yaw: .02 }, { x: 0, z: 0, yaw: -.02 },
  { x: .003, z: -.004, yaw: .01 }, { x: -.003, z: .004, yaw: -.01 }, { x: .005, z: 0, yaw: 0 },
]
/** Final native check: 39 ordinary assertions pass and 10 expected failures remain.
 * A passes 8/8, B 6/8, nominal C 1/8. Morrow C diagonal reaches 3.366 mm; two of five perturbed starts fall.
 */
for (const profileId of PUSH_PILOTS) for (const pushClass of PUSH_CLASSES) for (const direction of PUSH_DIRECTIONS)
  describe(`standing push ${profileId} ${pushClass} ${direction}`, () => {
    let row: Awaited<ReturnType<typeof measurePushTrial>>
    const perturbations: Awaited<ReturnType<typeof measurePushTrial>>[] = []
    const name = `${profileId}-${pushClass}-${direction}.json`
    const probeRobustness = profileId === 'morrow-v1' && pushClass === 'C' && direction === 'diagonal'
    beforeAll(async () => {
      row = await measurePushTrial(profileId, pushClass, direction)
      writeFileSync(join(folder, name), JSON.stringify(row)); emitTrial(row)
      if (probeRobustness) for (const spawn of robustnessStarts) {
        const result = await measurePushTrial(profileId, pushClass, direction, { spawn })
        writeFileSync(join(folder, `perturbed-${perturbations.length}-${name}`), JSON.stringify(result))
        emitTrial(result); perturbations.push(result)
      }
    }, 120_000)
    it('preserves finite native state, effort caps and the documented thorax disturbance', () => {
      expect(JSON.parse(readFileSync(join(folder, name), 'utf8'))).toEqual(row)
      expect(perturbations).toHaveLength(probeRobustness ? 5 : 0)
      for (const trial of [row, ...perturbations]) {
        expect(trial.error).toBeNull(); expect(trial.nativeFault).toBeNull(); expect(trial.finite).toBe(true)
        expect(trial.settleTicks).toBe(480); expect(trial.completedTicks).toBeGreaterThan(0)
        expect(trial.droppedSeconds).toBe(0); expect(trial.invalidFrames).toBe(0)
        expect(trial.maxEffortRatio).toBeLessThanOrEqual(1 + 1e-8)
        expect(trial.disturbedTicks).toBe(24)
        expect(Math.hypot(...Object.values(trial.appliedImpulseNs))).toBeCloseTo(trial.impulseNs, 10)
        expect(trial.firstPushForceN).not.toBeNull(); expect(trial.footCycles).toHaveLength(2)
        if (trial.terminationReason === 'first-fall') {
          expect(trial.noFall).toBe(false); expect(trial.firstFallS).not.toBeNull(); expect(trial.pass).toBe(false)
          expect(trial.completedTicks).toBeLessThan(trial.maximumTicks)
        } else { expect(trial.terminationReason).toBe('full-horizon'); expect(trial.completedTicks).toBe(trial.maximumTicks) }
      }
    })
    const measured = redRows[`${profileId}-${pushClass}-${direction}`], physical = measured ? it.fails : it
    physical(`meets the unchanged push-table stance or recovery gate at no more than 5 mm penetration${measured ?
      ` (measured ${measured.peakMm} mm, fall ${measured.fallS} s)` : ''}`, () => {
      expect(row.pass).toBe(true)
    })
    if (probeRobustness) it.fails('also passes five perturbed starts (2/5 fall at 1.963–1.979 s, peaks 4.875–4.894 mm)', () => {
      expect(perturbations).toHaveLength(5)
      for (const trial of perturbations) expect(trial.pass).toBe(true)
    })
  })
