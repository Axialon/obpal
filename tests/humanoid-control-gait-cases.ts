/** Native gait measurements. All commands enter the unchanged pilot's ActuationGate; no body writes. */
import { STEP, type BodyState, type ContactSample } from '../src/sim/physics/schema'
import { PHYSICS_SELECTION } from '../src/sim/physics/selection'
import { rotate, rotationVector, norm, angleBetween, clampCone, conjugate, fromRotationVector } from '../src/sim/physics/math'
import { buildHumanoid, type PhysicalHumanoid } from '../src/sim/humanoid/physics/model'
import { HumanoidPilot } from '../src/sim/humanoid/physics/pilot'
import { StanceController } from '../src/sim/humanoid/physics/stance'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { constraintMetrics } from '../src/sim/humanoid/physics/measure'
import { percentile } from '../src/sim/humanoid/physics/acceptance'
import type { Observation } from '../src/sim/humanoid/physics/observation'
import type { Intent } from '../src/sim/humanoid/physics/intent'
import { MAX_TARGET_RATE, type ActuationFrame } from '../src/sim/humanoid/physics/contract'

export const GAIT_TRIALS = ['W1', 'W2', 'W3'] as const
export const GAIT_FALLBACK_TRIALS = ['in-place', 'turn-in-place'] as const
export const GAIT_FALLBACK_RELEASE_TRIALS = ['in-place-stop', 'turn-in-place-stop'] as const
export const GAIT_ROUND_ONE_PROFILES = ['keel-v1', 'morrow-v1'] as const
export type GaitTrial = typeof GAIT_TRIALS[number] | typeof GAIT_FALLBACK_TRIALS[number] | typeof GAIT_FALLBACK_RELEASE_TRIALS[number]
/** Slow-cadence fallback simulation defaults: seconds, metres, radians and cycle counts; not W1-W3 replacements. */
export const GAIT_FALLBACK_ACCEPTANCE = Object.freeze({
  durationS: 30, minimumClearanceM: .01, minimumUnloadedS: .05, minimumCyclesPerFoot: 2,
  maximumTranslationM: .30, minimumTurnRad: .3, maximumHeadingDriftRad: .35,
  reportingWindowS: 10, touchdownLoadedTicks: 2,
})
const SETTLE_S = 2 // s, simulation default: same native stance settling interval as F1a2.
const WALK_BEFORE_RELEASE_S = 5 // s, simulation default: independent W2 walking preparation.
const STOP_DEADLINE_S = 3, STOP_HOLD_S = 10 // s, original W2 return deadline and held-stance duration, also required after fallback release.
const EFFORT_EPSILON = 1e-8 // dimensionless, existing native effort-cap numerical tolerance.
const rest: Intent = { x: 0, z: 0, yaw: 0, manual: false }
const forward: Intent = { x: 0, z: -1, yaw: 0, manual: true }
const turning: Intent = { x: 0, z: -.6, yaw: 1, manual: true }

export function trialTimeFromAbsolute(absoluteTimeS: number | null, trialStartTimeS: number | null): number | null {
  if (absoluteTimeS === null || trialStartTimeS === null) return null
  if (!Number.isFinite(absoluteTimeS) || !Number.isFinite(trialStartTimeS)) throw new Error('Invalid measurement clock')
  return absoluteTimeS - trialStartTimeS
}
/** A touchdown completed on the first falling tick is excluded from pre-fall stepping evidence. */
export function preFallCycleCount(events: readonly { confirmedAtS: number }[], firstFallTimeS: number | null): number {
  return events.filter(event => firstFallTimeS === null || event.confirmedAtS < firstFallTimeS).length
}

/** Counts genuine unload/clear/reload cycles; an elevated but loaded foot and a phase counter do not count. */
export class GaitFootCycleMeter {
  private wasLoaded: boolean
  private hadLoad: boolean
  private airborneStart: number | null = null
  private airborneTicks = 0
  private airbornePeakM = 0
  private loadedTicks = 0
  private pending: { liftoffTick: number; airborneTicks: number; peakClearanceM: number } | null = null
  readonly report = { samples: 0, maxClearanceM: 0, unloadedTicks: 0, loadOnsets: 0, unloadEvents: 0,
    qualifiedCycles: 0, preFallQualifiedCycles: 0, cyclesPerWindow: [0, 0, 0],
    events: [] as { liftoffS: number; touchdownS: number; confirmedAtS: number; unloadedS: number; peakClearanceM: number }[] }
  constructor(initiallyLoaded: boolean) { this.wasLoaded = initiallyLoaded; this.hadLoad = initiallyLoaded }
  sample(tick: number, loaded: boolean, clearanceM: number) {
    if (!Number.isSafeInteger(tick) || tick !== this.report.samples + 1 || !Number.isFinite(clearanceM)) throw new Error('Invalid foot cycle sample')
    this.report.samples++; this.report.maxClearanceM = Math.max(this.report.maxClearanceM, clearanceM)
    if (loaded) {
      this.hadLoad = true
      if (!this.wasLoaded) this.report.loadOnsets++
      if (this.airborneStart !== null) {
        this.pending = { liftoffTick: this.airborneStart, airborneTicks: this.airborneTicks, peakClearanceM: this.airbornePeakM }
        this.airborneStart = null; this.airborneTicks = 0; this.airbornePeakM = 0; this.loadedTicks = 0
      }
      this.loadedTicks++
      if (this.loadedTicks === GAIT_FALLBACK_ACCEPTANCE.touchdownLoadedTicks && this.pending) {
        const p = this.pending
        if (p.airborneTicks * STEP >= GAIT_FALLBACK_ACCEPTANCE.minimumUnloadedS && p.peakClearanceM >= GAIT_FALLBACK_ACCEPTANCE.minimumClearanceM) {
          this.report.qualifiedCycles++
          const window = Math.floor((tick - 1) * STEP / GAIT_FALLBACK_ACCEPTANCE.reportingWindowS)
          if (window < this.report.cyclesPerWindow.length) this.report.cyclesPerWindow[window]++
          this.report.events.push({ liftoffS: (p.liftoffTick - 1) * STEP, touchdownS: (tick - 1) * STEP, confirmedAtS: tick * STEP,
            unloadedS: p.airborneTicks * STEP, peakClearanceM: p.peakClearanceM })
        }
        this.pending = null
      }
    } else {
      this.report.unloadedTicks++; this.loadedTicks = 0; this.pending = null
      if (this.wasLoaded) this.report.unloadEvents++
      if (this.hadLoad) {
        this.airborneStart ??= tick; this.airborneTicks++; this.airbornePeakM = Math.max(this.airbornePeakM, clearanceM)
      }
    }
    this.wasLoaded = loaded
  }
}

function rootOf(model: PhysicalHumanoid, observation: Observation) {
  const root = observation.bodies.find(body => body.id === model.root)
  if (!root) throw new Error('Missing measured pelvis')
  return root
}
/** Exact lowest point of each primitive collider, including the upper faces of a tipped foot. */
export function colliderFloorMinimum(model: PhysicalHumanoid, body: BodyState): number {
  const spec = model.scene.bodies.find(b => b.id === body.id)
  if (!spec || spec.fixed) throw new Error('Missing dynamic collider')
  if (spec.shape.kind === 'sphere') return body.position.y - spec.shape.radius
  if (spec.shape.kind !== 'box') throw new Error('Unsupported dynamic collider')
  const half = spec.shape.half
  return body.position.y - Math.abs(rotate(body.rotation, { x: half.x, y: 0, z: 0 }).y)
    - Math.abs(rotate(body.rotation, { x: 0, y: half.y, z: 0 }).y)
    - Math.abs(rotate(body.rotation, { x: 0, y: 0, z: half.z }).y)
}
function safetyRow(standingHeightM: number) {
  return { samples: 0, minPelvisHeightM: standingHeightM, minUpY: 1, maxPenetrationM: 0, maxNonFootPenetrationM: 0,
    maxEffortRatio: 0, maxAnchorErrorMm: 0, maxConeErrorRad: 0, maxLimitSurfaceErrorMm: 0,
    nonFootFloorImpulseNs: 0, floorContactSamples: 0, finite: true, noFall: true,
    firstFallTick: null as number | null, firstFallTimeS: null as number | null,
    firstViolation: null as null | { tick: number; timeS: number; reason: string; bodyId?: string } }
}
type SafetyRow = ReturnType<typeof safetyRow>
function sampleSafety(model: PhysicalHumanoid, pilot: HumanoidPilot, o: Observation, row: SafetyRow, standingHeightM: number, contacts: ContactSample[]) {
  row.samples++
  const root = rootOf(model, o), upY = rotate(root.rotation, { x: 0, y: 1, z: 0 }).y
  row.minPelvisHeightM = Math.min(row.minPelvisHeightM, root.position.y); row.minUpY = Math.min(row.minUpY, upY)
  const violation = (reason: string, bodyId?: string) => { row.firstViolation ??= { tick: o.stateTick, timeS: o.timeS, reason, ...(bodyId ? { bodyId } : {}) } }
  const fall = (reason: string, bodyId?: string) => {
    row.noFall = false; row.firstFallTick ??= o.stateTick; row.firstFallTimeS ??= o.timeS; violation(reason, bodyId)
  }
  if (root.position.y < .8 * standingHeightM || upY < .8) fall('pelvis below 80% initial height or up Y below 0.8')
  for (const body of o.bodies) {
    if (![...Object.values(body.position), ...Object.values(body.rotation), ...Object.values(body.velocity), ...Object.values(body.angularVelocity)].every(Number.isFinite)) {
      row.finite = false; violation('non-finite body state', body.id)
    }
    const minimum = colliderFloorMinimum(model, body), penetration = Math.max(0, -minimum)
    row.maxPenetrationM = Math.max(row.maxPenetrationM, penetration)
    if (penetration > .005) violation('collider floor penetration exceeds 5 mm', body.id)
    if (!model.feet.includes(body.id)) {
      row.maxNonFootPenetrationM = Math.max(row.maxNonFootPenetrationM, penetration)
    }
  }
  row.floorContactSamples++
  for (const contact of contacts) {
    const id = contact.a === 'floor' ? contact.b : contact.b === 'floor' ? contact.a : null
    if (id && !model.feet.includes(id) && contact.impulse > 0) {
      row.nonFootFloorImpulseNs += contact.impulse; fall('non-foot floor impulse', id)
    }
  }
  const torques = pilot.diagnostics().forces.motorTorques
  if (Object.keys(torques).length !== model.scene.joints.length) throw new Error('Missing per-joint effort diagnostics')
  for (const joint of model.scene.joints) {
    const torque = torques[joint.id]
    if (!Number.isFinite(torque) || torque < 0) throw new Error('Invalid per-joint effort diagnostics')
    row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / joint.motor.maxTorque)
    if (torque / joint.motor.maxTorque > 1 + EFFORT_EPSILON) violation('effort exceeds joint cap', joint.id)
  }
  const constraints = constraintMetrics(model, o)
  row.maxAnchorErrorMm = Math.max(row.maxAnchorErrorMm, constraints.anchorMm)
  row.maxConeErrorRad = Math.max(row.maxConeErrorRad, constraints.coneRad)
  row.maxLimitSurfaceErrorMm = Math.max(row.maxLimitSurfaceErrorMm, constraints.surfaceMm)
}
const safe = (row: SafetyRow) => row.samples > 0 && row.floorContactSamples === row.samples && row.finite && row.noFall && row.maxPenetrationM <= .005 && row.maxEffortRatio <= 1 + EFFORT_EPSILON
function yawOf(body: BodyState) { const f = rotate(body.rotation, { x: 0, y: 0, z: -1 }); return Math.atan2(-f.x, -f.z) }
export function unwrappedYawDelta(previous: number, current: number) { return Math.atan2(Math.sin(current - previous), Math.cos(current - previous)) }
function stanceEnvelope(model: PhysicalHumanoid, o: Observation, standingHeightM: number) {
  const root = rootOf(model, o), constraints = constraintMetrics(model, o)
  return root.position.y >= .9 * standingHeightM && rotate(root.rotation, { x: 0, y: 1, z: 0 }).y >= .98
    && o.feet.every(f => f.normalImpulseNs > 0 && f.maxSoleY <= .005) && o.support.marginM !== null && o.support.marginM >= 0
    && o.bodies.every(body => colliderFloorMinimum(model, body) >= -.005)
    && constraints.coneRad <= .01 && constraints.surfaceMm <= 5 && constraints.anchorMm <= 5
    && Math.hypot(o.comVelocity.x, o.comVelocity.z) < .1
}

/** `stance`/`balance` ignore walking commands: before-change comparisons, never evidence of actual stepping. */
export async function measureGaitTrial(profileId: string, trial: GaitTrial,
  options: { controller?: 'gait' | 'stance' | 'balance'; stopAtFirstFall?: boolean } = {}) {
  const started = performance.now(), model = buildHumanoid(profileId), controllerKind = options.controller ?? 'gait'
  const fallbackRelease = trial === 'in-place-stop' || trial === 'turn-in-place-stop'
  const fallback = fallbackRelease || trial === 'in-place' || trial === 'turn-in-place'
  const fallbackTurning = trial === 'turn-in-place' || trial === 'turn-in-place-stop'
  const releaseAtS = fallbackRelease ? GAIT_FALLBACK_ACCEPTANCE.durationS : trial === 'W2' ? WALK_BEFORE_RELEASE_S : null
  const standingHeightM = model.scene.bodies.find(b => b.id === model.root)!.position.y
  const row = { schema_version: 1, kind: 'humanoid-control-gait-native', profileId, trial, controller: controllerKind,
    pass: false, completed: false, horizonCompleted: false, stopAtFirstFall: options.stopAtFirstFall ?? true,
    terminationReason: null as 'full-horizon' | 'distance' | 'stop-hold' | 'first-fall' | null,
    error: null as string | null, standingHeightM, settleTicks: 0, completedTicks: 0,
    maximumTicks: Math.round((releaseAtS !== null ? releaseAtS + STOP_DEADLINE_S + STOP_HOLD_S
      : fallback ? GAIT_FALLBACK_ACCEPTANCE.durationS : trial === 'W1' ? 20 : 10) / STEP),
    baseline: safetyRow(standingHeightM), safety: safetyRow(standingHeightM), simulatedS: 0, wallMs: 0, coldInitMs: 0,
    trialStartTimeS: null as number | null, firstFallTimeS: null as number | null, firstViolationTimeS: null as number | null,
    p95TickWallMs: 0, p99TickWallMs: 0, droppedSeconds: 0, invalidFrames: 0, metadata: null as unknown,
    forwardDistanceM: 0, maxForwardDistanceM: 0, distance2mAtS: null as number | null, distance5mAtS: null as number | null,
    preFallForwardDistanceM: 0, preFallUnwrappedYawRad: 0, preFallSimulatedS: 0,
    netTranslationM: 0, maxTranslationM: 0, maximumHeadingDriftRad: 0, reportedControllerSteps: 0,
    footCycles: {} as Record<string, GaitFootCycleMeter['report']>, fallbackDefaults: fallback ? GAIT_FALLBACK_ACCEPTANCE : null,
    last3mMeanSpeedMps: null as number | null, unwrappedYawRad: 0, releaseSpeedMps: null as number | null,
    releaseAtS, balanceStartedAtS: null as number | null, balanceAppliedTicks: 0, releaseMotionQualified: false,
    releaseSnapshot: null as { simulatedS: number; completedTicks: number; unwrappedYawRad: number;
      maximumHeadingDriftRad: number; netTranslationM: number; maxTranslationM: number;
      noFall: boolean; maxPenetrationM: number; maxEffortRatio: number;
      footCycles: Record<string, GaitFootCycleMeter['report']> } | null,
    releasePhases: null as Record<string, number> | null,
    releaseForwardDistanceM: null as number | null, returnedToStanceAtS: null as number | null, stanceHeldTicks: 0, stanceAttempts: 0,
    stanceHoldBroken: false, phases: {} as Record<string, number>, trace: [] as unknown[],
    measurement: {
      noFall: 'Pelvis >=80% initial height, pelvis up Y >=0.8, and no non-foot floor impulse. A factory wrapper copies actual selected Rapier backend contact samples as the unchanged pilot reads them; no contacts are substituted or modified. Safety first-fall ticks and times are absolute simulation timestamps, including the initial 2 s stance baseline.',
      clock: 'Top-level firstFallTimeS and firstViolationTimeS, trace times and foot-cycle event times are trial-relative. trialStartTimeS and all safety timestamps are absolute simulator times. preFallQualifiedCycles excludes cycles whose second loaded touchdown tick occurs on or after the first fall; total qualifiedCycles also includes any later fallen motion.',
      preFallMotion: 'preFallForwardDistanceM and preFallUnwrappedYawRad are measured at the last completed observation strictly before the first fall, at preFallSimulatedS on the trial clock. They freeze thereafter, excluding falling, tumbling and later recovery motion. With no fall they equal the final measured distance and heading.',
      termination: 'By default the first observed fall is a terminal physical failure: completed means the declared protocol terminated normally, not that the full planned horizon ran. first-fall always has pass=false and horizonCompleted=false. Actual completedTicks and simulatedS describe the measured prefix. Set stopAtFirstFall=false only for a separately labelled continuation probe; backend faults remain errors.',
      penetration: 'Lowest world-space point of every dynamic primitive collider against the unchanged floor y=0, every tick. No visual mesh claim.',
      W1: 'Straight native track uses the full-stick equivalent world velocity (0,0,-0.5) m/s via stepVelocity. This deliberately excludes the phone soft wall at +/-3.3 m, incompatible with a straight 5 m traversal from spawn.',
      W2: 'Five seconds full forward phone intent, then release; controller done hands targets to BalanceController. A walking preparation requires lift and strike phases and release speed >=0.1 m/s, the documented stopping-speed boundary. Stance (up >=0.98, pelvis >=90%, both feet loaded, COM supported, sole hover/anchor/surface and every collider floor penetration <=5 mm, cone error <=0.01 rad and speed <0.1 m/s) must begin within 3 s and persist 10 s of actual BalanceController actuation.',
      W3: 'Forward phone intent 0.6 with yaw 1.0; signed pelvis heading increments are unwrapped at every 240 Hz tick. Desired heading is never counted as actual turning.',
      fallback: 'Slow-cadence fallback simulation defaults: 30 s after the same 2 s stance baseline. In-place mode receives full forward velocity intent while suppressing desired translation; turn-in-place receives zero velocity and yaw rate 1 rad/s. Each foot must complete at least two measured cycles over 30 s: >=0.05 s continuously unloaded with peak whole-collider clearance >=10 mm, then two loaded touchdown ticks. Counts per 10 s window are reported without a per-window acceptance minimum. Maximum COM displacement <=0.30 m; plain stepping heading drift <=0.35 rad, or signed actual turning >=0.3 rad. Turning sums unwrapped measured pelvis-heading increments, not requested heading or controller phase. No-fall, 5 mm penetration and effort caps remain unchanged. These smaller fallback defaults do not replace W1-W3; W3 still requires >=3 rad.',
      fallbackRelease: 'The separate in-place-stop and turn-in-place-stop trials command the same fallback for 30 s, freeze its measured cycles/yaw/drift in releaseSnapshot, then apply zero intent. Only ticks actually actuated by BalanceController count towards returned stance: the original stance envelope, including every collider staying within 5 mm floor penetration on every held tick, must begin within 3 s of release and hold for 10 s. No walking-speed prerequisite is imposed. No-fall, 5 mm penetration and effort gates cover the whole trial; maximum 0.30 m displacement and plain-step 0.35 rad heading drift also cover stopping. Later foot motion or turning cannot qualify the preceding 30 s. balanceStartedAtS and returnedToStanceAtS are release-relative seconds.',
      trace: 'Root pitch/roll are heading-relative up-vector tilts. Hip target discrepancies compare the request and cone-projected request with the actually accepted target from a two-tick pilot journal; the journal is copied only on trace samples. Applied motor torque magnitudes come from native runtime diagnostics.',
      timing: 'Wall time includes target callback, gate, Rapier solve, contact observation and safety measurements. Native only; no browser or frame-budget claim.',
    } }
  let pilot: HumanoidPilot | undefined
  let contacts: ContactSample[] = []
  const timings: number[] = []
  try {
    const factory = await PHYSICS_SELECTION.load()
    pilot = await HumanoidPilot.create(model, { journalCapacity: 2, factory: async (scene, limits) => {
      const backend = await factory(scene, limits), readContacts = backend.contacts
      if (!readContacts) { backend.dispose(); throw new Error('Selected backend lacks native contacts') }
      backend.contacts = () => { const samples = readContacts.call(backend); contacts = structuredClone(samples); return samples }
      return backend
    } })
    row.metadata = pilot.metadata(); row.coldInitMs = performance.now() - started
    const stance = new StanceController(model, pilot.generation), balance = new BalanceController(model, pilot.generation)
    const baselineControl = controllerKind === 'balance' ? balance : stance
    for (let tick = 0; tick < Math.round(SETTLE_S / STEP); tick++) {
      pilot.advance(STEP, o => baselineControl.step(o).frame); row.settleTicks++
      sampleSafety(model, pilot, pilot.observation(), row.baseline, standingHeightM, contacts)
    }
    const gait = controllerKind === 'gait' ? new (await import('../src/sim/humanoid/physics/gait')).GaitController(model, pilot.generation, { mode: fallback ? 'in-place' : 'walk' }) : null
    const initial = pilot.observation(), originZ = initial.com.z, originX = initial.com.x
    row.trialStartTimeS = initial.timeS
    const feet = new Map(initial.feet.map(foot => [foot.id, new GaitFootCycleMeter(foot.normalImpulseNs > 0)]))
    for (const [id, meter] of feet) row.footCycles[id] = meter.report
    let requestedFrame: ActuationFrame | null = null
    let previousYaw = yawOf(rootOf(model, initial)), previousDistance = 0, handToBalance = false, stanceStartTick: number | null = null
    const releaseTicks = releaseAtS === null ? null : Math.round(releaseAtS / STEP)
    const record = (o: Observation, timeS: number, phase: unknown, diagnostics?: unknown) => {
      const joint = (side: string, part: string) => o.joints.find(observed => observed.id === model.scene.joints.find(spec => spec.child === model.parts[`${side}_${part}`].bodyId)!.id)!
      const root = rootOf(model, o), heading = yawOf(root), up = rotate(root.rotation, { x: 0, y: 1, z: 0 })
      const localUp = rotate(conjugate(fromRotationVector({ x: 0, y: heading, z: 0 })), up)
      const journal = pilot!.journal(), accepted = journal.at(-1)?.action, previous = journal.at(-2)?.action
      const torques = pilot!.diagnostics().forces.motorTorques
      row.trace.push({ timeS, tick: o.stateTick,
        com: o.com, comVelocity: o.comVelocity, pelvisHeightM: rootOf(model, o).position.y,
        upY: rotate(rootOf(model, o).rotation, { x: 0, y: 1, z: 0 }).y, phase, ...(diagnostics ? { diagnostics } : {}),
        rootPitchTiltRad: Math.atan2(localUp.z, localUp.y), rootRollTiltRad: Math.atan2(-localUp.x, localUp.y), actualYawRad: row.unwrappedYawRad,
        hipTargets: ['left', 'right'].map(side => {
          const measured = joint(side, 'thigh'), spec = model.scene.joints.find(j => j.id === measured.id)!, target = accepted?.targets[measured.id]
          const requested = requestedFrame?.targets[measured.id], before = previous?.targets[measured.id]
          const slewErrorRad = requested && target ? angleBetween(clampCone(requested, spec.cone), target) : null
          return { side, requestedVsAcceptedRad: requested && target ? angleBetween(requested, target) : null,
            coneProjectedVsAcceptedRad: slewErrorRad,
            slewBinding: slewErrorRad !== null && slewErrorRad > 1e-8, // rad: numerical trace comparison, not a physical gate.
            acceptedStepRad: before && target ? angleBetween(before, target) : null, gateStepLimitRad: MAX_TARGET_RATE * STEP,
            measuredVsAcceptedRad: target ? angleBetween(measured.rotation, target) : null,
            motorTorqueNm: torques[measured.id], capNm: spec.motor.maxTorque, effortRatio: torques[measured.id] / spec.motor.maxTorque,
            atEffortCap: torques[measured.id] >= spec.motor.maxTorque * (1 - EFFORT_EPSILON) }
        }),
        measuredLegs: ['left', 'right'].map(side => ({ side, kneeFlexionRad: rotationVector(joint(side, 'shin').rotation).x,
          hipRelativeFlexionRad: -rotationVector(joint(side, 'thigh').rotation).y })),
        feet: o.feet.map(f => ({ id: f.id, centre: f.centre, normalImpulseNs: f.normalImpulseNs, minSoleY: f.minSoleY,
          maxSoleY: f.maxSoleY, angularSpeedRadps: norm(o.bodies.find(body => body.id === f.id)!.angularVelocity) })) })
    }
    record(initial, 0, 'settled')
    for (let tick = 0; tick < row.maximumTicks; tick++) {
      const before = performance.now(), releasing = releaseTicks !== null && tick >= releaseTicks
      pilot.advance(STEP, o => {
        requestedFrame = handToBalance ? balance.step(o).frame : !gait ? baselineControl.step(o).frame
          : releasing ? gait.step(o, rest)
            : trial === 'W1' || (fallback && !fallbackTurning) ? gait.stepVelocity(o, { velocity: { x: 0, y: 0, z: -.5 }, yawRateRadps: 0 })
              : fallbackTurning ? gait.stepVelocity(o, { velocity: { x: 0, y: 0, z: 0 }, yawRateRadps: 1 })
                : gait.step(o, trial === 'W3' ? turning : forward)
        return requestedFrame
      })
      const o = pilot.observation(), timeS = (tick + 1) * STEP, distance = originZ - o.com.z
      row.completedTicks++; row.simulatedS = timeS; row.forwardDistanceM = distance
      row.maxForwardDistanceM = Math.max(row.maxForwardDistanceM, distance)
      row.netTranslationM = Math.hypot(o.com.x - originX, o.com.z - originZ)
      row.maxTranslationM = Math.max(row.maxTranslationM, row.netTranslationM)
      for (const foot of o.feet) feet.get(foot.id)!.sample(tick + 1, foot.normalImpulseNs > 0,
        colliderFloorMinimum(model, o.bodies.find(body => body.id === foot.id)!))
      sampleSafety(model, pilot, o, row.safety, standingHeightM, contacts)
      const phase = handToBalance ? 'balance' : gait?.diagnostics().phase ?? `baseline-${controllerKind}`
      row.phases[phase] = (row.phases[phase] ?? 0) + 1
      if (phase === 'balance') { row.balanceAppliedTicks++; row.balanceStartedAtS ??= timeS - releaseAtS! }
      const yaw = yawOf(rootOf(model, o)); row.unwrappedYawRad += unwrappedYawDelta(previousYaw, yaw); previousYaw = yaw
      if (row.safety.firstFallTick === null) {
        row.preFallForwardDistanceM = distance; row.preFallUnwrappedYawRad = row.unwrappedYawRad; row.preFallSimulatedS = timeS
      }
      row.maximumHeadingDriftRad = Math.max(row.maximumHeadingDriftRad, Math.abs(row.unwrappedYawRad))
      row.reportedControllerSteps = gait?.diagnostics().steps ?? 0
      for (const mark of [2, 5] as const) if (previousDistance < mark && distance >= mark) {
        const crossingS = tick * STEP + STEP * (mark - previousDistance) / (distance - previousDistance)
        if (mark === 2) row.distance2mAtS ??= crossingS
        else row.distance5mAtS ??= crossingS
      }
      previousDistance = distance
      if (releaseTicks !== null) {
        if (tick + 1 === releaseTicks) {
          row.releaseSpeedMps = Math.hypot(o.comVelocity.x, o.comVelocity.z); row.releaseForwardDistanceM = distance
          row.releasePhases = { ...row.phases }
          if (fallbackRelease) {
            const footCycles = structuredClone(row.footCycles)
            const fallTime = trialTimeFromAbsolute(row.safety.firstFallTimeS, row.trialStartTimeS)
            for (const foot of Object.values(footCycles)) foot.preFallQualifiedCycles = preFallCycleCount(foot.events, fallTime)
            row.releaseSnapshot = { simulatedS: timeS, completedTicks: row.completedTicks, unwrappedYawRad: row.unwrappedYawRad,
              maximumHeadingDriftRad: row.maximumHeadingDriftRad, netTranslationM: row.netTranslationM, maxTranslationM: row.maxTranslationM,
              noFall: row.safety.noFall, maxPenetrationM: row.safety.maxPenetrationM, maxEffortRatio: row.safety.maxEffortRatio, footCycles }
          }
        }
        if (releasing) {
          if (gait?.done(o, rest)) handToBalance = true
          const inStance = phase === 'balance' && stanceEnvelope(model, o, standingHeightM)
          if (stanceStartTick === null && inStance && tick + 1 - releaseTicks <= Math.round(STOP_DEADLINE_S / STEP)) {
            stanceStartTick = tick + 1; row.returnedToStanceAtS = (tick + 1 - releaseTicks) * STEP
            row.stanceAttempts++; row.stanceHoldBroken = false
          } else if (stanceStartTick !== null) {
            if (!inStance) {
              row.stanceHoldBroken = true; row.stanceHeldTicks = 0; row.returnedToStanceAtS = null; stanceStartTick = null
            } else row.stanceHeldTicks = tick + 1 - stanceStartTick
          }
        }
      }
      if (((timeS <= 3 || (releasing && timeS <= releaseAtS! + STOP_DEADLINE_S)) && (tick + 1) % 24 === 0)
        || (tick + 1) % 240 === 0 || row.safety.firstViolation?.tick === o.stateTick || row.safety.firstFallTick === o.stateTick)
        record(o, timeS, phase, gait?.diagnostics())
      timings.push(performance.now() - before)
      if (row.stopAtFirstFall && row.safety.firstFallTick !== null) { row.terminationReason = 'first-fall'; break }
      if (trial === 'W1' && row.distance5mAtS !== null) { row.terminationReason = 'distance'; break }
      if (releaseTicks !== null && row.stanceHeldTicks >= Math.round(STOP_HOLD_S / STEP)) { row.terminationReason = 'stop-hold'; break }
    }
    row.completed = true; row.terminationReason ??= 'full-horizon'
    row.horizonCompleted = row.terminationReason !== 'first-fall' && row.completedTicks === row.maximumTicks
    if (row.distance2mAtS !== null && row.distance5mAtS !== null) row.last3mMeanSpeedMps = 3 / (row.distance5mAtS - row.distance2mAtS)
  } catch (error) { row.error = error instanceof Error ? error.message : String(error) }
  finally {
    if (pilot) {
      const d = pilot.diagnostics(); row.droppedSeconds = d.droppedSeconds; row.invalidFrames = d.invalidFrames
      try { pilot.dispose() } catch (error) { row.error = `disposal: ${String(error)}` }
    }
    row.wallMs = performance.now() - started
    row.p95TickWallMs = timings.length ? percentile(timings, .95) : 0; row.p99TickWallMs = timings.length ? percentile(timings, .99) : 0
  }
  const healthy = row.completed && !row.error && row.settleTicks === Math.round(SETTLE_S / STEP)
    && row.completedTicks === row.safety.samples && safe(row.baseline) && safe(row.safety) && row.droppedSeconds === 0 && row.invalidFrames === 0
  row.firstFallTimeS = trialTimeFromAbsolute(row.safety.firstFallTimeS, row.trialStartTimeS)
  row.firstViolationTimeS = trialTimeFromAbsolute(row.safety.firstViolation?.timeS ?? null, row.trialStartTimeS)
  for (const foot of Object.values(row.footCycles)) foot.preFallQualifiedCycles = preFallCycleCount(foot.events, row.firstFallTimeS)
  const cyclic = model.feet.every(id => row.footCycles[id]?.qualifiedCycles >= GAIT_FALLBACK_ACCEPTANCE.minimumCyclesPerFoot)
  const stopped = row.balanceStartedAtS !== null && row.balanceStartedAtS <= STOP_DEADLINE_S
    && row.returnedToStanceAtS !== null && row.returnedToStanceAtS <= STOP_DEADLINE_S
    && row.stanceHeldTicks >= Math.round(STOP_HOLD_S / STEP) && !row.stanceHoldBroken
  const released = row.releaseSnapshot
  row.releaseMotionQualified = !!released && released.completedTicks === Math.round(GAIT_FALLBACK_ACCEPTANCE.durationS / STEP)
    && released.noFall && model.feet.every(id => released.footCycles[id]?.preFallQualifiedCycles >= GAIT_FALLBACK_ACCEPTANCE.minimumCyclesPerFoot)
    && released.maxTranslationM <= GAIT_FALLBACK_ACCEPTANCE.maximumTranslationM
    && (fallbackTurning ? released.unwrappedYawRad >= GAIT_FALLBACK_ACCEPTANCE.minimumTurnRad
      : released.maximumHeadingDriftRad <= GAIT_FALLBACK_ACCEPTANCE.maximumHeadingDriftRad)
  row.pass = healthy && (fallbackRelease ? row.releaseMotionQualified && stopped
    && row.maxTranslationM <= GAIT_FALLBACK_ACCEPTANCE.maximumTranslationM
    && (fallbackTurning || row.maximumHeadingDriftRad <= GAIT_FALLBACK_ACCEPTANCE.maximumHeadingDriftRad)
    : fallback ? row.completedTicks === Math.round(GAIT_FALLBACK_ACCEPTANCE.durationS / STEP) && cyclic
    && row.maxTranslationM <= GAIT_FALLBACK_ACCEPTANCE.maximumTranslationM
    && (trial === 'in-place' ? row.maximumHeadingDriftRad <= GAIT_FALLBACK_ACCEPTANCE.maximumHeadingDriftRad : row.unwrappedYawRad >= GAIT_FALLBACK_ACCEPTANCE.minimumTurnRad)
    : trial === 'W1' ? row.distance5mAtS !== null && row.distance5mAtS <= 20
    && row.last3mMeanSpeedMps !== null && row.last3mMeanSpeedMps >= .3 && row.last3mMeanSpeedMps <= .6
    : trial === 'W2' ? row.releaseSpeedMps !== null && row.releaseSpeedMps >= .1 && row.releaseForwardDistanceM !== null && row.releaseForwardDistanceM > 0
      && (row.releasePhases?.lift ?? 0) > 0 && (row.releasePhases?.strike ?? 0) > 0
      && stopped
      : row.completedTicks === Math.round(10 / STEP) && row.unwrappedYawRad >= 3)
  return row
}
