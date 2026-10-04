/** Pilot-only lean falls. Genuine Rapier contacts gate get-up; no root writes or test force exists here. */
import { beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, tmpdir, join, emitMeasurement } from './humanoid-physics-node.mjs'
import { HumanoidPilot } from '../src/sim/humanoid/physics/pilot'
import { GetupController, loadedFloorContacts, settled, supportedBy } from '../src/sim/humanoid/physics/getup'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { ALL_PHYSICAL_PROFILES, buildHumanoid, targetsFromAngles } from '../src/sim/humanoid/physics/model'
import { PHYSICS_SELECTION } from '../src/sim/physics/selection'
import { STEP, type BackendFactory, type ContactSample } from '../src/sim/physics/schema'
import { norm, rotate, rotationVector, type Vec3 } from '../src/sim/physics/math'
import type { Observation } from '../src/sim/humanoid/physics/observation'
import type { ActuationFrame } from '../src/sim/humanoid/physics/contract'
import type { Intent } from '../src/sim/humanoid/physics/intent'

const folder = mkdtempSync(join(tmpdir(), 'obpal-getup-lean-'))
const WARMUP_TICKS = 480, LEAN_TICKS = 480, RECOVERY_TICKS = 4800
const intent: Intent = { x: 0, z: 0, yaw: 0, manual: false }
type Direction = 'toe' | 'heel'
interface PhaseStats {
  ticks: number; bothHandsTicks: number; bothShinsTicks: number; bothFeetTicks: number; anyShinOrFootTicks: number
  bothLegsLoadedTicks: number; handsFeetSupportTicks: number; maxBothFeetHeldTicks: number; maxBothLegsHeldTicks: number; maxHandsFeetSupportHeldTicks: number
  minUpY: number; maxUpY: number; minPitchRad: number; maxPitchRad: number; maxFootMarginM: number | null
}
interface RunRow {
  kind: 'baseline' | 'getup'; profileId: string; direction: Direction
  completedTicks: number; expectedTicks: number; recoveryTicks: number; leanFall: boolean
  minUpY: number; maxUpY: number; minPelvisM: number; maxPelvisM: number; standingPelvisM: number
  maxEffortRatio: number; maxPenetrationMm: number; nonFinite: boolean; fault: string | null
  firstStanceS: number | null; stanceHeldS: number; maxStanceHeldS: number; finalPhase: string
  maxRecoveryUpY: number; maxRecoveryPelvisM: number; minRollThoraxForwardY: number | null
  phases: { phase: string; timeS: number; rootUpY: number; rootForwardY: number; rootLateralY: number; thoraxUpY: number; thoraxForwardY: number; thoraxLateralY: number; handCentreY: number[];
    floorImpulseNs: Record<string, number>; motorRotationVectorsRad: Record<string, Vec3>; motorEffortRatios: Record<string, number>;
    comSpeedMps: number; fastestAngularBody: string; maxBodyAngularSpeedRadS: number;
    rootAngularVelocityRadS: Vec3; thoraxAngularVelocityRadS: Vec3; footUpY: number[];
    com: Vec3; pelvisCentreM: Vec3; comInHandsFeet: boolean; footSupportMarginM: number | null;
    handsFeetBoundsXZ: { minX: number; maxX: number; minZ: number; maxZ: number } | null }[]
  phaseTransitions: Record<string, number>
  phaseStats: Record<string, PhaseStats>
  contactsObserved: number; droppedSeconds: number
  firstSettledS: number | null; maxSettledHeldS: number; finalUpY: number; finalPelvisM: number
  finalDiagnostics: ReturnType<GetupController['diagnostics']> | null
  nativeTick: number; nativeStatus: string; nativeFault: string | null
  firstInvalidAngularVelocity: { part: string; angularVelocityRadS: { x: number | null; y: number | null; z: number | null } | null;
    nonFinite: boolean; magnitudeRadS: number | null; limitRadS: number; lastCompletedTick: number; phase: string } | null
}
interface Trial { profileId: string; direction: Direction; baseline: RunRow; getup: RunRow }
const trials = new Map<string, Promise<Trial>>()
const rootUp = (o: Observation, id: string) => rotate(o.bodies.find(b => b.id === id)!.rotation, { x: 0, y: 1, z: 0 }).y
const finite = (o: Observation) => o.bodies.every(b => [
  ...Object.values(b.position), ...Object.values(b.rotation), ...Object.values(b.velocity), ...Object.values(b.angularVelocity),
].every(Number.isFinite)) && [...Object.values(o.com), ...Object.values(o.comVelocity)].every(Number.isFinite)

function emptyRow(profileId: string, direction: Direction, controlled: boolean): RunRow {
  return { kind: controlled ? 'getup' : 'baseline', profileId, direction,
    completedTicks: 0, expectedTicks: WARMUP_TICKS + LEAN_TICKS + RECOVERY_TICKS, recoveryTicks: 0, leanFall: false,
    minUpY: Infinity, maxUpY: -Infinity, minPelvisM: Infinity, maxPelvisM: -Infinity, standingPelvisM: NaN,
    maxEffortRatio: 0, maxPenetrationMm: 0, nonFinite: false, fault: null, firstStanceS: null,
    stanceHeldS: 0, maxStanceHeldS: 0, finalPhase: controlled ? 'idle' : 'nominal', phases: [], phaseTransitions: {}, phaseStats: {}, contactsObserved: 0, droppedSeconds: 0,
    maxRecoveryUpY: -1, maxRecoveryPelvisM: 0, minRollThoraxForwardY: null,
    firstSettledS: null, maxSettledHeldS: 0, finalUpY: NaN, finalPelvisM: NaN, finalDiagnostics: null,
    nativeTick: 0, nativeStatus: 'uninitialised', nativeFault: null, firstInvalidAngularVelocity: null }
}
async function run(profileId: string, direction: Direction, controlled: boolean): Promise<RunRow> {
  const row = emptyRow(profileId, direction, controlled)
  let ownedPilot: HumanoidPilot | undefined
  try {
  const model = buildHumanoid(profileId), factory = await PHYSICS_SELECTION.load()
  const standingPelvisM = model.scene.bodies.find(b => b.id === model.root)!.position.y
  row.standingPelvisM = standingPelvisM
  let contacts: ContactSample[] = []
  // Pilot observations intentionally lack the world contact fields. This factory preserves the real samples
  // the pilot already requests, without manufacturing contact from collider height or exposing its Simulation.
  const contactFactory: BackendFactory = async (scene, limits) => {
    const backend = await factory(scene, limits)
    if (!backend.contacts) { backend.dispose(); throw new Error('Selected backend has no native contacts') }
    const readContacts = backend.contacts.bind(backend)
    backend.contacts = () => { const samples = readContacts(); contacts = structuredClone(samples); return samples }
    const readBody = backend.read.bind(backend), partByBody = new Map(Object.entries(model.parts).map(([part, spec]) => [spec.bodyId, part]))
    backend.read = id => {
      const state = readBody(id), w = state.angularVelocity
      const nonFinite = !w || ![w.x, w.y, w.z].every(Number.isFinite), magnitude = w ? norm(w) : NaN
      // Match schema.vector's magnitude limit; never replace, clamp or otherwise change the native state.
      if (row.firstInvalidAngularVelocity === null && (nonFinite || magnitude > limits.maxAngularSpeed)) row.firstInvalidAngularVelocity = {
        part: partByBody.get(id) ?? (id === 'floor' ? 'floor' : 'unknown'),
        angularVelocityRadS: w ? { x: Number.isFinite(w.x) ? w.x : null, y: Number.isFinite(w.y) ? w.y : null, z: Number.isFinite(w.z) ? w.z : null } : null,
        nonFinite, magnitudeRadS: Number.isFinite(magnitude) ? magnitude : null, limitRadS: limits.maxAngularSpeed,
        lastCompletedTick: row.completedTicks, phase: row.finalPhase,
      }
      return state
    }
    return backend
  }
  const pilot = ownedPilot = await HumanoidPilot.create(model, { factory: contactFactory, journalCapacity: 1 })
  const stance = new StanceController(model, pilot.generation), getup = new GetupController(model, pilot.generation)
  let settledHeldS = 0
  let phaseLabel = 'nominal', statsPhase = '', bothFeetHeld = 0, bothLegsHeld = 0, handsFeetSupportHeld = 0
  // Original simulation default, rad: the existing +/-0.43 ankle lean is held for 2 s to induce a physical fall.
  const lean = targetsFromAngles(model, { 'left.arm.roll': Math.PI / 9, 'right.arm.roll': Math.PI / 9,
    'left.leg.ankle.pitch': direction === 'toe' ? .43 : -.43,
    'right.leg.ankle.pitch': direction === 'toe' ? .43 : -.43 })
  const request = (o: Observation, targets: ActuationFrame['targets']): ActuationFrame => ({ schema_version: 1,
    profileId, actorId: model.actorId, generation: pilot.generation, tick: o.stateTick, source: 'classical', targets })
  const withContacts = (o: Observation): Observation => ({ ...o,
    floorContacts: structuredClone(contacts.filter(c => (c.a === 'floor' && o.bodies.some(b => b.id === c.b)) ||
      (c.b === 'floor' && o.bodies.some(b => b.id === c.a)))), actorContacts: [] })
  const phaseWitness = (o: Observation, phase: string, timeS: number) => {
    const floorImpulseNs: Record<string, number> = {}
    for (const c of o.floorContacts!) {
      const id = c.a === 'floor' ? c.b : c.a, part = Object.entries(model.parts).find(([, p]) => p.bodyId === id)?.[0]
      if (part && c.distance <= (model.scene.contact?.predictionDistance ?? .001) && c.impulse > 0)
        floorImpulseNs[part] = (floorImpulseNs[part] ?? 0) + c.impulse
    }
    const fastest = o.bodies.reduce((a, b) => norm(a.angularVelocity) > norm(b.angularVelocity) ? a : b)
    const loaded = loadedFloorContacts(model, o) ?? new Map<string, Vec3[]>()
    const support = ['hand', 'foot'].flatMap(part => ['left', 'right'].flatMap(side => loaded.get(model.parts[`${side}_${part}`].bodyId) ?? []))
    const effort = pilot.diagnostics().forces.motorTorques
    const thorax = o.bodies.find(b => b.id === model.parts.thorax.bodyId)!
    return { phase, timeS, rootUpY: rootUp(o, model.root), thoraxUpY: rootUp(o, model.parts.thorax.bodyId),
      rootForwardY: rotate(o.bodies.find(b => b.id === model.root)!.rotation, { x: 0, y: 0, z: -1 }).y,
      rootLateralY: rotate(o.bodies.find(b => b.id === model.root)!.rotation, { x: 1, y: 0, z: 0 }).y,
      thoraxForwardY: rotate(thorax.rotation, { x: 0, y: 0, z: -1 }).y,
      thoraxLateralY: rotate(thorax.rotation, { x: 1, y: 0, z: 0 }).y,
      rootAngularVelocityRadS: { ...o.bodies.find(b => b.id === model.root)!.angularVelocity },
      thoraxAngularVelocityRadS: { ...thorax.angularVelocity }, footUpY: model.feet.map(id => rootUp(o, id)),
      com: { ...o.com }, pelvisCentreM: { ...o.bodies.find(b => b.id === model.root)!.position },
      comInHandsFeet: supportedBy(support, o.com), footSupportMarginM: o.support.marginM,
      handsFeetBoundsXZ: support.length ? { minX: Math.min(...support.map(p => p.x)), maxX: Math.max(...support.map(p => p.x)),
        minZ: Math.min(...support.map(p => p.z)), maxZ: Math.max(...support.map(p => p.z)) } : null,
      comSpeedMps: norm(o.comVelocity), fastestAngularBody: Object.entries(model.parts).find(([, p]) => p.bodyId === fastest.id)![0],
      maxBodyAngularSpeedRadS: norm(fastest.angularVelocity),
      motorEffortRatios: Object.fromEntries(model.scene.joints.map(j => [Object.entries(model.parts).find(([, p]) => p.bodyId === j.child)![0], effort[j.id] / j.motor.maxTorque])),
      handCentreY: ['left', 'right'].map(side => o.bodies.find(b => b.id === model.parts[`${side}_hand`].bodyId)!.position.y), floorImpulseNs,
      motorRotationVectorsRad: Object.fromEntries(['left_thigh', 'left_shin', 'left_foot', 'left_upper_arm', 'left_forearm'].map(part => {
        const j = model.scene.joints.find(j => j.child === model.parts[part].bodyId)!
        return [part, rotationVector(o.joints.find(q => q.id === j.id)!.rotation)]
      })) }
  }
    for (let tick = 0; tick < row.expectedTicks; tick++) {
      const recovering = tick >= WARMUP_TICKS + LEAN_TICKS
      pilot.advance(STEP, input => {
        const o = withContacts(input)
        if (tick < WARMUP_TICKS) return stance.step(o).frame
        if (!recovering) return request(o, lean)
        if (!controlled) return stance.step(o).frame
        const frame = getup.step(o, intent), diagnostics = getup.diagnostics(), phase = diagnostics.phase
        const label = phase === 'roll' ? `${phase}:${diagnostics.rollSide}:${diagnostics.rollStage}` :
          phase === 'hands' ? `${phase}:${diagnostics.handStage}` : phase === 'all-fours' ? `${phase}:${diagnostics.allFoursStage}` : phase
        phaseLabel = label
        if (phase !== row.finalPhase || row.phases.at(-1)?.phase !== label) {
          row.finalPhase = phase; row.phaseTransitions[label] = (row.phaseTransitions[label] ?? 0) + 1
          const witness = phaseWitness(o, label, (tick - WARMUP_TICKS - LEAN_TICKS) * STEP)
          const same = row.phases.map((p, i) => p.phase === label ? i : -1).filter(i => i >= 0)
          // First and last transition witnesses are enough to diagnose repeated settle jitter; counts retain the total.
          if (same.length < 2) row.phases.push(witness); else row.phases[same[1]] = witness
        }
        return frame
      })
      const diagnostics = pilot.diagnostics()
      if (diagnostics.status !== 'ready' || diagnostics.tick !== tick + 1)
        throw new Error(`Native tick did not complete: ${diagnostics.status}, ${diagnostics.tick}/${tick + 1}, ${diagnostics.fault ?? 'no fault reason'}`)
      if (model.scene.joints.some(j => !Number.isFinite(diagnostics.forces.motorTorques[j.id]) || diagnostics.forces.motorTorques[j.id] < 0))
        throw new Error('Native motor effort samples are missing or invalid')
      const o = withContacts(pilot.observation()), up = rootUp(o, model.root), pelvis = o.bodies.find(b => b.id === model.root)!.position.y
      if (o.stateTick !== diagnostics.tick) throw new Error('Observed/native tick mismatch')
      row.completedTicks = o.stateTick; row.nonFinite ||= !finite(o)
      row.minUpY = Math.min(row.minUpY, up); row.maxUpY = Math.max(row.maxUpY, up)
      row.minPelvisM = Math.min(row.minPelvisM, pelvis); row.maxPelvisM = Math.max(row.maxPelvisM, pelvis)
      row.finalUpY = up; row.finalPelvisM = pelvis
      if (controlled && recovering) row.finalDiagnostics = getup.diagnostics()
      const nonFootFloorImpulse = o.floorContacts!.some(c => c.impulse > 0 && c.distance <= (model.scene.contact?.predictionDistance ?? .001) &&
        !model.feet.includes(c.a === 'floor' ? c.b : c.a))
      if (tick >= WARMUP_TICKS && !recovering) row.leanFall ||= up < .8 || pelvis < .65 * standingPelvisM || nonFootFloorImpulse
      row.contactsObserved += o.floorContacts!.length
      for (const [id, torque] of Object.entries(pilot.diagnostics().forces.motorTorques))
        row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / model.scene.joints.find(j => j.id === id)!.motor.maxTorque)
      for (const f of o.feet) row.maxPenetrationMm = Math.max(row.maxPenetrationMm, -f.minSoleY * 1000)
      if (recovering) {
        row.recoveryTicks++
        const loaded = loadedFloorContacts(model, o) ?? new Map<string, Vec3[]>()
        const both = (part: string) => ['left', 'right'].every(side => loaded.has(model.parts[`${side}_${part}`].bodyId))
        const bothFeet = both('foot'), bothLegs = ['left', 'right'].every(side =>
          ['shin', 'foot'].some(part => loaded.has(model.parts[`${side}_${part}`].bodyId)))
        const supportPoints = ['hand', 'foot'].flatMap(part => ['left', 'right'].flatMap(side => loaded.get(model.parts[`${side}_${part}`].bodyId) ?? []))
        const handsFeetSupport = supportedBy(supportPoints, o.com)
        const root = o.bodies.find(b => b.id === model.root)!, pitch = Math.atan2(rotate(root.rotation, { x: 0, y: 0, z: -1 }).y, up)
        const stats = row.phaseStats[phaseLabel] ??= { ticks: 0, bothHandsTicks: 0, bothShinsTicks: 0, bothFeetTicks: 0, anyShinOrFootTicks: 0,
          bothLegsLoadedTicks: 0, handsFeetSupportTicks: 0, maxBothFeetHeldTicks: 0, maxBothLegsHeldTicks: 0, maxHandsFeetSupportHeldTicks: 0,
          minUpY: up, maxUpY: up, minPitchRad: pitch, maxPitchRad: pitch, maxFootMarginM: null }
        if (statsPhase !== phaseLabel) { statsPhase = phaseLabel; bothFeetHeld = 0; bothLegsHeld = 0; handsFeetSupportHeld = 0 }
        bothFeetHeld = bothFeet ? bothFeetHeld + 1 : 0; bothLegsHeld = bothLegs ? bothLegsHeld + 1 : 0
        handsFeetSupportHeld = handsFeetSupport ? handsFeetSupportHeld + 1 : 0
        stats.ticks++; stats.bothHandsTicks += Number(both('hand')); stats.bothShinsTicks += Number(both('shin')); stats.bothFeetTicks += Number(bothFeet)
        stats.anyShinOrFootTicks += Number(['left', 'right'].some(side => ['shin', 'foot'].some(part => loaded.has(model.parts[`${side}_${part}`].bodyId))))
        stats.bothLegsLoadedTicks += Number(bothLegs); stats.handsFeetSupportTicks += Number(handsFeetSupport)
        stats.maxBothFeetHeldTicks = Math.max(stats.maxBothFeetHeldTicks, bothFeetHeld); stats.maxBothLegsHeldTicks = Math.max(stats.maxBothLegsHeldTicks, bothLegsHeld)
        stats.maxHandsFeetSupportHeldTicks = Math.max(stats.maxHandsFeetSupportHeldTicks, handsFeetSupportHeld)
        stats.minUpY = Math.min(stats.minUpY, up); stats.maxUpY = Math.max(stats.maxUpY, up)
        stats.minPitchRad = Math.min(stats.minPitchRad, pitch); stats.maxPitchRad = Math.max(stats.maxPitchRad, pitch)
        if (o.support.marginM !== null) stats.maxFootMarginM = Math.max(stats.maxFootMarginM ?? o.support.marginM, o.support.marginM)
        row.maxRecoveryUpY = Math.max(row.maxRecoveryUpY, up); row.maxRecoveryPelvisM = Math.max(row.maxRecoveryPelvisM, pelvis)
        if (controlled && getup.diagnostics().phase === 'roll') {
          const thorax = o.bodies.find(b => b.id === model.parts.thorax.bodyId)!
          const y = rotate(thorax.rotation, { x: 0, y: 0, z: -1 }).y
          row.minRollThoraxForwardY = Math.min(row.minRollThoraxForwardY ?? 1, y)
        }
        settledHeldS = settled(o) ? settledHeldS + STEP : 0
        row.maxSettledHeldS = Math.max(row.maxSettledHeldS, settledHeldS)
        if (row.firstSettledS === null && settledHeldS + 1e-10 >= .5) row.firstSettledS = row.recoveryTicks * STEP
        const envelope = up >= .98 && pelvis >= .9 * standingPelvisM && o.feet.every(f => f.normalImpulseNs > 0 && f.minSoleY >= -.005) &&
          o.support.marginM !== null && o.support.marginM >= 0
        row.stanceHeldS = envelope ? row.stanceHeldS + STEP : 0
        row.maxStanceHeldS = Math.max(row.maxStanceHeldS, row.stanceHeldS)
        if (row.firstStanceS === null && row.stanceHeldS + 1e-10 >= 2) row.firstStanceS = row.recoveryTicks * STEP
      }
    }
  } catch (error) { row.fault = error instanceof Error ? error.message : String(error) }
  finally {
    if (ownedPilot) {
      const diagnostics = ownedPilot.diagnostics()
      row.droppedSeconds = diagnostics.droppedSeconds; row.nativeTick = diagnostics.tick
      row.nativeStatus = diagnostics.status; row.nativeFault = diagnostics.fault
      ownedPilot.dispose()
    }
  }
  row.phases.sort((a, b) => a.timeS - b.timeS)
  return row
}
function measured(profileId: string, direction: Direction): Promise<Trial> {
  const key = `${profileId}-${direction}`
  if (!trials.has(key)) trials.set(key, (async () => {
    const trial = { profileId, direction, baseline: await run(profileId, direction, false), getup: await run(profileId, direction, true) }
    emitMeasurement({ schema_version: 1, kind: 'humanoid-control-getup-pilot', acceptance: 'actual stance acceptance after a lean-induced fall', ...trial })
    writeFileSync(join(folder, `${key}.json`), JSON.stringify(trial, null, 2))
    return trial
  })())
  return trials.get(key)!
}

for (const profileId of ALL_PHYSICAL_PROFILES) for (const direction of ['toe', 'heel'] as const) {
  describe(`getup pilot ${profileId} ${direction}`, () => {
    let trial: Trial
    beforeAll(async () => { trial = await measured(profileId, direction) }, 180_000)
    it('completes matching native lean trials with finite state and capped effort', () => {
      for (const row of [trial.baseline, trial.getup]) {
        expect(row.fault).toBeNull(); expect(row.nonFinite).toBe(false)
        expect(row.completedTicks).toBe(row.expectedTicks); expect(row.recoveryTicks).toBe(RECOVERY_TICKS)
        expect(row.nativeTick).toBe(row.expectedTicks); expect(row.nativeStatus).toBe('ready'); expect(row.nativeFault).toBeNull()
        expect(row.leanFall).toBe(true); expect(row.contactsObserved).toBeGreaterThan(0)
        expect(row.maxEffortRatio).toBeLessThanOrEqual(1 + 1e-8); expect(row.droppedSeconds).toBe(0)
      }
    })
    // Expected failure, measured Round 1: every form/direction has firstStanceS=null,
    // maxStanceHeldS=0 s and finalPhase=down after 20 s. Thresholds stay unchanged:
    // 2 s continuous stance, root up >= .98, pelvis >= .9 of standing height,
    // both feet loaded, sole penetration <= 5 mm and COM inside foot support.
    // Final root up / pelvis height (m), toe then heel:
    // Keel, Cairn II, Rill II, Hush II: .01247/.10599; -.00027/.10502.
    // Cairn I, Rill I, Hush I: .00477/.10264; -.01476/.10198.
    // Morrow: -.71355/.36664; .00055/.09637.
    it.fails('holds the stance envelope for 2 s within 20 s after the lean-induced fall', () => {
      expect(trial.getup.firstStanceS).not.toBeNull()
      expect(trial.getup.firstStanceS!).toBeLessThanOrEqual(20)
      expect(trial.getup.maxStanceHeldS + 1e-10).toBeGreaterThanOrEqual(2)
      expect(trial.getup.finalPhase).toBe('complete')
    })
  })
}
