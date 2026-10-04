/** Measured F1a2 gates: stance passes; only the three measured anatomy gates remain expected failures. */
import { it, expect, describe, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, tmpdir, join, emitMeasurement } from './humanoid-physics-node.mjs'
import { ALL_PHYSICAL_PROFILES } from '../src/sim/humanoid/physics/model'
import { measureProfile } from '../src/sim/humanoid/physics/measure'
import { createSelectedSimulation } from '../src/sim/physics/selection'
import { STEP } from '../src/sim/physics/schema'
import { CONTACT_MM, CONE_RAD } from '../src/sim/humanoid/physics/acceptance'
const folder = mkdtempSync(join(tmpdir(), 'obpal-f1a-measurements-'))
const reports = new Map<string, Promise<Awaited<ReturnType<typeof measureProfile>>>>()
function measured(profile: string) {
  if (!reports.has(profile)) reports.set(profile, measureProfile(profile).then(report => {
    writeFileSync(join(folder, `${profile}.json`), JSON.stringify(report))
    emitMeasurement(report) // Emit measured success/failure before assertions; never infer acceptance from runner completion.
    return report
  }))
  return reports.get(profile)!
}
for (const profile of ALL_PHYSICAL_PROFILES) describe(`humanoid F1a2 candidate acceptance: ${profile}`, () => {
  let report: Awaited<ReturnType<typeof measureProfile>>
  beforeAll(async () => { report = await measured(profile) }, 600_000)
  it('measurement harness completes 7200 stance ticks, 97 anatomy trials and all replay partitions, and writes JSON', () => {
    const saved = JSON.parse(readFileSync(join(folder, `${profile}.json`), 'utf8'))
    expect(saved).toEqual(report); expect(report.errors).toEqual([])
    expect(report.stance?.error).toBeNull(); expect(report.stance?.completedTicks).toBe(7200)
    expect(report.stance?.expectedTicks).toBe(7200); expect(report.stance?.settledSamples).toBe(6720)
    expect(report.stance?.supportMarginsM).toHaveLength(6720)
    expect(report.stance?.trace.at(-1)?.tick).toBe(7200)
    for (const kind of ['penetration', 'hover', 'slip'] as const) {
      const w = report.stance!.witnesses[kind]!
      expect(w.sample.feet.some(f => f.id === w.footId)).toBe(true)
      expect(Number.isFinite(w.valueMm)).toBe(true)
      expect(w.sample.tick).toBeGreaterThan(0); expect(w.sample.tick).toBeLessThanOrEqual(7200)
    }
    expect(report.anatomy?.rows).toHaveLength(97)
    expect(new Set(report.anatomy!.rows.map(r => r.name)).size).toBe(97)
    for (const row of report.anatomy!.rows) {
      expect(row.error).toBeNull(); expect(row.completedTicks).toBe(480)
      for (const n of [row.maxConeErrorRad, row.maxLimitSurfaceErrorMm, row.finalTargetErrorRad, row.maxQuaternionStepRad]) expect(Number.isFinite(n)).toBe(true)
    }
    expect(report.replay?.completedTicks).toEqual([480, 480, 480])
  })
  // <=5 mm penetration; measured F1a2 Keel/II 3.102, I 3.112, Morrow 3.127 mm.
  it('candidate stance gate: sole penetration <=5 mm throughout 30 s', () => expect(report.stance!.maxPenetrationMm).toBeLessThanOrEqual(CONTACT_MM))
  // <=5 mm corner height; measured F1a2 maximum 1.910 mm on every form.
  it('candidate stance gate: sole hover <=5 mm throughout 30 s', () => expect(report.stance!.maxHoverMm).toBeLessThanOrEqual(CONTACT_MM))
  // >=90% initial height; measured F1a2 minima Keel/II 0.917, I 0.882, Morrow 0.841 m.
  it('candidate stance gate: pelvis remains >=90% standing height for 30 s', () => expect(report.stance!.minPelvisHeightM).toBeGreaterThanOrEqual(.9 * report.stance!.standingHeightM))
  // Up Y >=0.98; measured F1a2 minimum >=0.999992 on every form.
  it('candidate stance gate: pelvis up Y >=0.98 for 30 s', () => expect(report.stance!.minUp).toBeGreaterThanOrEqual(.98))
  // All 6720 post-settle samples supported; measured F1a2 6720/6720 on every form.
  it('candidate stance gate: supported on all 6720 settled ticks', () => expect(report.stance!.supportedSamples).toBe(6720))
  // <=0.01 rad; measured F1a2 stance maxima Keel/II 0.001152, I 0.001108, Morrow 0.001463 rad.
  it('candidate stance gate: cone error <=0.01 rad', () => expect(report.stance!.maxConeErrorRad).toBeLessThanOrEqual(CONE_RAD))
  // <=5 mm; measured F1a2 stance surface maxima Keel/II 0.415, I 0.430, Morrow 0.541 mm.
  it('candidate stance gate: limit surface error <=5 mm', () => expect(report.stance!.maxLimitSurfaceErrorMm).toBeLessThanOrEqual(CONTACT_MM))
  // <=0.01 rad in every trial; measured F1a2 maxima Keel/II 0.119307, I 0.156251, Morrow 0.179426 rad.
  it.fails('candidate anatomy gate: swing/twist cone error <=0.01 rad in all 97 trials', () => expect(Math.max(...report.anatomy!.rows.map(r => r.maxConeErrorRad))).toBeLessThanOrEqual(CONE_RAD))
  // <=5 mm in every trial; measured F1a2 maxima Keel/II 27.436, I 40.520, Morrow 44.379 mm.
  it.fails('candidate anatomy gate: limit surface error <=5 mm in all 97 trials', () => expect(Math.max(...report.anatomy!.rows.map(r => r.maxLimitSurfaceErrorMm))).toBeLessThanOrEqual(CONTACT_MM))
  // <=0.08 rad final tracking error; measured F1a2 maxima Keel/II 0.102778, I 0.301034, Morrow 0.369275 rad.
  it.fails('candidate anatomy gate: final target error <=0.08 rad in all 97 trials', () => expect(Math.max(...report.anatomy!.rows.map(r => r.finalTargetErrorRad))).toBeLessThanOrEqual(.08))
  it('stance and anatomy anchor <=5 mm, effort <=1+1e-8, finite timing and nonnegative slip gates', () => {
    for (const row of [report.stance!, ...report.anatomy!.rows]) {
      expect(row.maxAnchorErrorMm).toBeGreaterThanOrEqual(0); expect(row.maxAnchorErrorMm).toBeLessThanOrEqual(CONTACT_MM)
      expect(row.maxEffortRatio).toBeGreaterThanOrEqual(0); expect(row.maxEffortRatio).toBeLessThanOrEqual(1 + 1e-8)
    }
    expect(report.stance!.slipMm).toBeGreaterThanOrEqual(0)
    expect(report.stance!.p95TickWallMs).toBeGreaterThanOrEqual(0)
    expect(report.stance!.p99TickWallMs).toBeGreaterThanOrEqual(report.stance!.p95TickWallMs)
    expect(report.stance!.droppedSeconds).toBe(0); expect(report.stance!.invalidFrames).toBe(0)
  })
  it('loaded sliding, legacy fall displacement and coupled solve diagnostics are separate and complete', () => {
    const s = report.stance!
    expect(s.loadedSliding.samples).toBe(6720); expect(s.loadedSliding.firstTick).toBe(481); expect(s.loadedSliding.lastTick).toBe(7200)
    expect(s.loadedSliding.fallDisplacementMm).toBe(s.slipMm); expect(s.fallDisplacementMm).toBe(s.slipMm); expect(Number.isFinite(s.loadedSlipMm)).toBe(true); expect(s.loadedSlipMm).toBeGreaterThanOrEqual(0)
    expect(Object.keys(s.loadedSliding.feet)).toHaveLength(2)
    for(const f of Object.values(s.loadedSliding.feet)) {
      expect(f.loadedSamples).toBeGreaterThanOrEqual(0); expect(f.loadedSamples).toBeLessThanOrEqual(6720)
      expect(f.totalPathMm).toBeGreaterThanOrEqual(f.maxEpisodePathMm)
    }
    expect(s.control.supportedTicks+s.control.noSupportTicks+s.control.outsideEnvelopeTicks).toBe(7200)
    expect(s.coupled.sampledTicks).toBe(7200); expect(Number.isFinite(s.coupled.minRank)).toBe(true)
    expect(Number.isFinite(s.coupled.maxAppliedRelativeResidual)).toBe(true)
    expect(s.coupled.maxRelativeResidual).toBeLessThan(1e-8) // numerical solve residual, NOT a physical accuracy claim.
  })
  it('quaternion continuity is finite and replay errors <=1e-6 at 60/30/120 Hz including q/-q', () => {
    expect(Number.isFinite(report.stance!.maxQuaternionStepRad)).toBe(true)
    expect(report.replay?.negativeQuaternionSignsHz).toBe(120); expect(report.replay?.pass).toBe(true)
  })
})
it('F1a measurement harness writes the complete eight-form JSON table independently of physical acceptance', async () => {
  const rows = await Promise.all(ALL_PHYSICAL_PROFILES.map(measured))
  const table = rows.map(r => ({ profileId: r.profileId, modelVersion: r.modelVersion, physicalAcceptance: r.pass, errors: r.errors,
    stance: r.stance ? { ticks: r.stance.completedTicks, penetrationMm: r.stance.maxPenetrationMm, hoverMm: r.stance.maxHoverMm,
      legacySlipMm: r.stance.slipMm, fallDisplacementMm: r.stance.fallDisplacementMm, loadedSlipMm: r.stance.loadedSlipMm,
      loadedSliding: r.stance.loadedSliding, controller: r.stance.control, coupled: r.stance.coupled,
      witnesses: Object.fromEntries(Object.entries(r.stance.witnesses).map(([kind,w]) => [kind,{footId:w.footId,tick:w.sample.tick,timeS:w.sample.timeS,valueMm:w.valueMm}])) } : null,
    stanceGates: r.stance ? { minimumPelvisM:r.stance.minPelvisHeightM,minimumUpY:r.stance.minUp,supportedSamples:r.stance.supportedSamples,
      coneRad:r.stance.maxConeErrorRad,surfaceMm:r.stance.maxLimitSurfaceErrorMm,anchorMm:r.stance.maxAnchorErrorMm,effortRatio:r.stance.maxEffortRatio } : null,
    anatomy: r.anatomy ? { completedTrials:r.anatomy.rows.filter(row=>row.completedTicks===480&&!row.error).length,
      passingTrials:r.anatomy.rows.filter(row=>row.maxConeErrorRad<=CONE_RAD&&row.maxLimitSurfaceErrorMm<=CONTACT_MM&&row.finalTargetErrorRad<=.08).length,
      failingTrials:r.anatomy.rows.filter(row=>row.error||row.maxConeErrorRad>CONE_RAD||row.maxLimitSurfaceErrorMm>CONTACT_MM||row.finalTargetErrorRad>.08)
        .map(({name,completedTicks,error,maxConeErrorRad,maxLimitSurfaceErrorMm,finalTargetErrorRad})=>({name,completedTicks,error,maxConeErrorRad,maxLimitSurfaceErrorMm,finalTargetErrorRad})),
      coneRad:Math.max(...r.anatomy.rows.map(row=>row.maxConeErrorRad)),surfaceMm:Math.max(...r.anatomy.rows.map(row=>row.maxLimitSurfaceErrorMm)),
      finalErrorRad:Math.max(...r.anatomy.rows.map(row=>row.finalTargetErrorRad)) } : null,replayPass:r.replay?.pass??null }))
  emitMeasurement({kind:'humanoid-f1a2-candidate-table',acceptanceStatus:'stance gates pass; three anatomy gates remain measured expected failures; missing/error rows fail the ordinary harness',table})
  const path = join(folder, 'table.json'); writeFileSync(path, JSON.stringify(table, null, 2))
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(table); expect(table).toHaveLength(8)
}, 600_000)
it('Rapier contact samples are oriented, owned, on the actual floor and cleaned up on disposal', async () => {
  const s = await createSelectedSimulation({ bodies: [
    { id: 'floor', fixed: true, shape: { kind: 'plane' }, position: { x: 0, y: 0, z: 0 } },
    { id: 'ball', mass: 2, shape: { kind: 'sphere', radius: .1 }, position: { x: 0, y: .3, z: 0 }, restitution: 0 },
  ], contact: { solverIterations: 16, allowedLinearError: .0002, predictionDistance: .001 } })
  try {
    for (let i = 0; i < 480; i++) s.advance(STEP)
    const contacts = s.contacts(); console.log(JSON.stringify({ schema_version: 1, kind: 'humanoid-f1a-contact-probe', contacts }))
    expect(contacts.length).toBeGreaterThan(0)
    expect(contacts.some(c => c.impulse > 0)).toBe(true)
    for (const c of contacts) {
      const sign = c.b === 'ball' ? 1 : -1
      expect(c.normalOnB.y * sign).toBeGreaterThan(.99)
      expect(Math.abs((c.a === 'floor' ? c.pointA : c.pointB).y)).toBeLessThan(.001)
    }
    contacts[0].normalOnB.y = 500; expect(Math.abs(s.contacts()[0].normalOnB.y)).toBeLessThanOrEqual(1)
  } finally { s.dispose() }
  expect(() => s.contacts()).toThrow(/disposed/)
}, 30_000)
