/** Real selected-engine evidence. Reports completed work/errors; a blocked or failed metric is never filled with a zero pass. */
import { STEP, validateScene } from '../../physics/schema'
import { createSelectedSimulation } from '../../physics/selection'
import { angleBetween, clampCone, norm, sub, rotate, fromRotationVector, swingTwist } from '../../physics/math'
import { HumanoidPilot } from './pilot'
import { StanceController, STANCE_CONTROL } from './stance'
import { LoadedSlipMeter } from './slip'
import { CONSTRAINT_DEFAULTS } from '../../physics/constraint-response'
import { observe, type Observation } from './observation'
import { ActuationGate, type ActuationFrame } from './contract'
import { buildHumanoid, canonicalPoses, targetsFromAngles, soleCorners, type PhysicalHumanoid } from './model'
import { STANCE_SECONDS, SETTLE_SECONDS, stancePass, anatomyPass, percentile, type StanceRow, type AnatomyRow } from './acceptance'
const message = (e: unknown) => e instanceof Error ? e.message : String(e)
/** A world-space witness, including the actual local lower face when a foot tips during a fall. */
export function stanceSample(model: PhysicalHumanoid, observation: Observation) {
  const root = observation.bodies.find(b => b.id === model.root)!
  return { tick: observation.stateTick, timeS: observation.timeS, bodies: observation.bodies,
    com: observation.com, comVelocity: observation.comVelocity, rootHeightM: root.position.y, rootUpY: rotate(root.rotation, { x: 0, y: 1, z: 0 }).y, support: observation.support,
    feet: observation.feet.map(f => {
      const spec = model.scene.bodies.find(b => b.id === f.id)!, body = observation.bodies.find(b => b.id === f.id)!
      if (spec.shape.kind !== 'box') throw new Error('Sole witness requires the actual foot box')
      return { ...f, localSoleOffsetM: { x: 0, y: -spec.shape.half.y, z: 0 },
        soleWorldCorners: soleCorners({ ...spec, ...body }) }
    }) }
}
export function constraintMetrics(model: PhysicalHumanoid, observation: Observation) {
  let coneRad = 0, surfaceMm = 0, anchorMm = 0
  for (const j of observation.joints) {
    const spec = model.scene.joints.find(s => s.id === j.id)!, b = model.scene.bodies.find(b => b.id === spec.child)!
    const error = angleBetween(j.rotation, clampCone(j.rotation, spec.cone))
    // Conservative rigid collider lever arm. This is NOT an authored/skinned-mesh exterior-crossing test.
    const radius = norm(spec.anchorChild) + (b.shape.kind === 'box' ? norm(b.shape.half) : b.shape.kind === 'sphere' ? b.shape.radius : 0)
    coneRad = Math.max(coneRad, error); surfaceMm = Math.max(surfaceMm, error * radius * 1000); anchorMm = Math.max(anchorMm, j.anchorErrorM * 1000)
  }
  return { coneRad, surfaceMm, anchorMm }
}
export async function measureStance(profileId: string) {
  const model = buildHumanoid(profileId), start = performance.now(), pilot = await HumanoidPilot.create(model)
  const row: StanceRow = { completedTicks: 0, expectedTicks: STANCE_SECONDS / STEP, maxPenetrationMm: 0, maxHoverMm: 0, slipMm: 0,
    minPelvisHeightM: Infinity, standingHeightM: model.scene.bodies.find(b => b.id === model.root)!.position.y, minUp: 1,
    supportedSamples: 0, settledSamples: 0, maxAnchorErrorMm: 0, maxLimitSurfaceErrorMm: 0, maxConeErrorRad: 0, maxEffortRatio: 0,
    p95TickWallMs: NaN, p99TickWallMs: NaN, droppedSeconds: 0, invalidFrames: 0, error: null }
  const controller = new StanceController(model, pilot.generation), sliding = new LoadedSlipMeter(model, pilot.generation)
  const control = { version: STANCE_CONTROL.version, supportedTicks: 0, noSupportTicks: 0, outsideEnvelopeTicks: 0, maxAnkleBiasRad: 0, maxHipBiasRad: 0 }
  const coupled = { sampledTicks: 0, minRank: Infinity, maxRank: 0, maxContactRows: 0, saturatedJointTicks: 0, maxRelativeResidual: 0, maxAppliedRelativeResidual: 0 }
  const timings: number[] = [], planted = new Map<string, { x: number; z: number }>()
  const supportMarginsM: (number | null)[] = []
  let previous = pilot.observation(), maxQuaternionStepRad = 0
  const trace = [stanceSample(model, previous)]
  const witnesses: Partial<Record<'penetration' | 'hover' | 'slip', { footId: string; valueMm: number; sample: ReturnType<typeof stanceSample> }>> = {}
  const witness = (kind: keyof typeof witnesses, footId: string, valueMm: number, observation: Observation) => {
    if (!witnesses[kind] || valueMm > witnesses[kind]!.valueMm) witnesses[kind] = { footId, valueMm, sample: stanceSample(model, observation) }
  }
  const metadata = pilot.metadata(), coldInitMs = performance.now() - start
  try {
    for (let tick = 0; tick < row.expectedTicks; tick++) {
      const before = performance.now()
      pilot.advance(STEP, observation => {
        const request = controller.step(observation), d = request.diagnostics
        if(d.phase === 'supported') control.supportedTicks++
        else if(d.phase === 'no-support') control.noSupportTicks++
        else control.outsideEnvelopeTicks++
        control.maxAnkleBiasRad = Math.max(control.maxAnkleBiasRad, d.maxAnkleBiasRad)
        control.maxHipBiasRad = Math.max(control.maxHipBiasRad, d.maxHipBiasRad)
        return request.frame
      })
      timings.push(performance.now() - before)
      const solve = pilot.diagnostics().forces.coupled
      if(!solve) throw new Error('Missing coupled servo diagnostics')
      coupled.sampledTicks++; coupled.minRank = Math.min(coupled.minRank, solve.constraintRank); coupled.maxRank = Math.max(coupled.maxRank, solve.constraintRank)
      coupled.maxContactRows = Math.max(coupled.maxContactRows, solve.contactRows); coupled.saturatedJointTicks += solve.saturatedJoints
      coupled.maxRelativeResidual = Math.max(coupled.maxRelativeResidual, solve.relativeResidual)
      coupled.maxAppliedRelativeResidual = Math.max(coupled.maxAppliedRelativeResidual, solve.appliedRelativeResidual)
      const observation = pilot.observation(), root = observation.bodies.find(b => b.id === model.root)!, metrics = constraintMetrics(model, observation)
      for (let i = 0; i < observation.bodies.length; i++) maxQuaternionStepRad = Math.max(maxQuaternionStepRad,
        angleBetween(observation.bodies[i].rotation, previous.bodies[i].rotation))
      previous = observation
      if ((tick + 1) % 240 === 0 && (tick < 1200 || (tick + 1) % 1200 === 0)) trace.push(stanceSample(model, observation))
      row.completedTicks = tick + 1
      row.minPelvisHeightM = Math.min(row.minPelvisHeightM, root.position.y)
      row.minUp = Math.min(row.minUp, rotate(root.rotation, { x: 0, y: 1, z: 0 }).y)
      row.maxAnchorErrorMm = Math.max(row.maxAnchorErrorMm, metrics.anchorMm)
      row.maxLimitSurfaceErrorMm = Math.max(row.maxLimitSurfaceErrorMm, metrics.surfaceMm); row.maxConeErrorRad = Math.max(row.maxConeErrorRad, metrics.coneRad)
      for (const [id, torque] of Object.entries(pilot.diagnostics().forces.motorTorques)) row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / model.scene.joints.find(j => j.id === id)!.motor.maxTorque)
      for (const f of observation.feet) {
        witness('penetration', f.id, Math.max(0, -f.minSoleY * 1000), observation)
        witness('hover', f.id, Math.max(0, f.maxSoleY * 1000), observation)
        row.maxPenetrationMm = Math.max(row.maxPenetrationMm, -f.minSoleY * 1000)
        row.maxHoverMm = Math.max(row.maxHoverMm, f.maxSoleY * 1000)
        if (tick >= SETTLE_SECONDS / STEP) {
          if (!planted.has(f.id)) planted.set(f.id, { x: f.centre.x, z: f.centre.z })
          const p = planted.get(f.id)!
          const displacement = Math.hypot(f.centre.x - p.x, f.centre.z - p.z) * 1000
          witness('slip', f.id, displacement, observation); row.slipMm = Math.max(row.slipMm, displacement)
        }
      }
      if (tick >= SETTLE_SECONDS / STEP) {
        sliding.sample(observation)
        row.settledSamples++; supportMarginsM.push(observation.support.marginM)
        if (observation.support.normalImpulseNs > 0 && observation.support.marginM !== null && observation.support.marginM >= 0) row.supportedSamples++
      }
    }
  } catch (e) { row.error = message(e) }
  finally {
    const d = pilot.diagnostics(); row.droppedSeconds = d.droppedSeconds; row.invalidFrames = d.invalidFrames
    row.p95TickWallMs = percentile(timings, .95); row.p99TickWallMs = percentile(timings, .99); pilot.dispose()
  }
  const loadedSliding = sliding.report()
  const loadedSlipMm = loadedSliding.samples ? Math.max(0, ...Object.values(loadedSliding.feet).map(f => f.totalPathMm)) : null
  return { ...row, pass: stancePass(row), loadedSlipMm, fallDisplacementMm: loadedSliding.samples ? row.slipMm : null, loadedSliding, control, coupled, metadata, coldInitMs, maxQuaternionStepRad, supportMarginsM, trace, witnesses,
    measurement: { floorWorldY: 0, sole: 'Four collider corners on local y=-half.y, transformed by foot-body rotation/translation into world space; both feet, all 7200 ticks including a fall.',
      hover: 'Maximum corner height, not a flat-foot air gap or a selected swing-foot measurement.',
      slip: 'Deprecated slipMm and slip witness are the unchanged all-state foot-origin displacement, now also named fallDisplacementMm. Neither is loaded sliding or a fall classifier.',
      loadedSlip: 'loadedSlipMm is the largest per-foot cumulative material-point tangential path after tick 481, trapezoid sampled only across consecutive positive-load ticks. Per-foot episodes reset on load loss; airborne paths, initial touchdown and zero-pressure-only manifolds add no distance. Weighted by upward native normal impulse; rolling is not origin sliding. No new slip threshold is invented.',
      slipReferenceTick: 481, slipReferenceTimeS: 481 * STEP, slipReferences: Object.fromEntries(planted) },
    timingNote: 'Wall time of a fixed tick including input validation, contact observations and bounded journaling; not process CPU time.' }
}
/** Zero gravity isolates ROM from the not-yet-implemented F1b balance controller. Root remains fully dynamic. */
export async function measureAnatomy(profileId: string) {
  const model = buildHumanoid(profileId), rows: (AnatomyRow & { fixtureKind: string; fixtureBodies: number; maxQuaternionStepRad: number; extrema: Record<string, { twistMin: number; twistMax: number; swingYMin: number; swingYMax: number; swingZMin: number; swingZMax: number; maxTargetErrorRad: number }> })[] = []
  const scenarios: [string, ActuationFrame['targets']][] = Object.entries(canonicalPoses(profileId)).map(([name, angles]) => [`pose:${name}`, targetsFromAngles(model, angles)])
  for (const selected of model.scene.joints) for (const face of ['swingY-', 'swingY+', 'swingZ-', 'swingZ+', 'twist-', 'twist+']) scenarios.push([`limit:${selected.id}:${face}`, Object.fromEntries(model.scene.joints.map(j => {
    if (j.id !== selected.id) return [j.id, j.motor.target]
    const c = j.cone, target = face === 'swingY-' ? { x: 0, y: c.swingYMin ?? -c.swingY, z: 0 } : face === 'swingY+' ? { x: 0, y: c.swingY, z: 0 } :
      face === 'swingZ-' ? { x: 0, y: 0, z: c.swingZMin ?? -c.swingZ } : face === 'swingZ+' ? { x: 0, y: 0, z: c.swingZ } :
      { x: face === 'twist-' ? c.twistMin : c.twistMax, y: 0, z: 0 }
    return [j.id, fromRotationVector(target)]
  }))])
  for (const [name, targets] of scenarios) {
    const selected = name.startsWith('limit:') ? model.scene.joints.find(j => j.id === name.split(':')[1]) : undefined
    // Independent ROM is measured on the SAME native link parameters, unobstructed by the other limbs.
    // Only this mechanical fixture fixes its parent. The 30 s actor and seven simultaneous poses keep a free pelvis.
    const trial: PhysicalHumanoid = selected ? { ...model, feet: [], scene: validateScene({ gravity: { x: 0, y: 0, z: 0 },
      bodies: model.scene.bodies.filter(b => b.id === selected.parent || b.id === selected.child).map(b => ({ ...b, fixed: b.id === selected.parent })),
      joints: [selected], contact: model.scene.contact }) } : model
    const trialTargets = selected ? { [selected.id]: targets[selected.id] } : targets
    const row: typeof rows[number] = { name, fixtureKind: selected ? 'isolated-joint-fixed-parent' : 'whole-humanoid-free-pelvis', fixtureBodies: trial.scene.bodies.length, completedTicks: 0, expectedTicks: 480, maxConeErrorRad: 0, maxLimitSurfaceErrorMm: 0, maxAnchorErrorMm: 0, maxEffortRatio: 0, finalTargetErrorRad: Infinity, maxQuaternionStepRad: 0, error: null, extrema: {} }
    let simulation: Awaited<ReturnType<typeof createSelectedSimulation>> | undefined
    try {
      simulation = await createSelectedSimulation({ ...trial.scene, gravity: { x: 0, y: 0, z: 0 } })
      const gate = new ActuationGate(trial, 1)
      let previous = simulation.snapshot()
      for (let tick = 0; tick < row.expectedTicks; tick++) {
        const action = gate.accept({ schema_version: 1, profileId, actorId: model.actorId, generation: 1, tick, source: 'classical', targets: trialTargets })
        simulation.setMotorTargets(action.targets); simulation.advance(STEP); row.completedTicks++
        const snapshot = simulation.snapshot()
        for (let i = 0; i < snapshot.length; i++) row.maxQuaternionStepRad = Math.max(row.maxQuaternionStepRad,
          angleBetween(snapshot[i].rotation, previous[i].rotation))
        previous = snapshot
        const observation = observe(trial, snapshot, simulation.contacts(), 1, tick + 1), metrics = constraintMetrics(trial, observation)
        row.maxConeErrorRad = Math.max(row.maxConeErrorRad, metrics.coneRad); row.maxLimitSurfaceErrorMm = Math.max(row.maxLimitSurfaceErrorMm, metrics.surfaceMm)
        row.maxAnchorErrorMm = Math.max(row.maxAnchorErrorMm, metrics.anchorMm)
        for (const [id, torque] of Object.entries(simulation.diagnostics().forces.motorTorques)) row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / model.scene.joints.find(j => j.id === id)!.motor.maxTorque)
        if (tick === row.expectedTicks - 1) row.finalTargetErrorRad = Math.max(...observation.joints.map(j => angleBetween(j.rotation, trialTargets[j.id])))
        for (const j of observation.joints) {
          if (name.startsWith('limit:') && !name.includes(`:${j.id}:`)) continue
          const s = swingTwist(j.rotation), e = row.extrema[j.id] ??= { twistMin: Infinity, twistMax: -Infinity, swingYMin: Infinity, swingYMax: -Infinity, swingZMin: Infinity, swingZMax: -Infinity, maxTargetErrorRad: 0 }
          e.twistMin = Math.min(e.twistMin, s.twist); e.twistMax = Math.max(e.twistMax, s.twist)
          e.swingYMin = Math.min(e.swingYMin, s.swingY); e.swingYMax = Math.max(e.swingYMax, s.swingY)
          e.swingZMin = Math.min(e.swingZMin, s.swingZ); e.swingZMax = Math.max(e.swingZMax, s.swingZ)
          e.maxTargetErrorRad = Math.max(e.maxTargetErrorRad, angleBetween(j.rotation, action.targets[j.id]))
        }
      }
    } catch (e) { row.error = message(e) }
    finally { simulation?.dispose(); rows.push(row) }
  }
  return { rows, pass: anatomyPass({ rows }), note: '97 zero-gravity trials: seven whole-humanoid simultaneous poses with free pelvis, and six signed endpoints per native profile joint in an unobstructed two-body fixed-parent fixture. Two seconds each. No pilot body is fixed by these fixture setup choices. Adjacent-only collision exclusions retained. Measured extrema are not commanded angles or mesh-crossing proof.' }
}
export async function measureReplay(profileId: string) {
  const model = buildHumanoid(profileId), captures: { hz: number; states: ReturnType<HumanoidPilot['snapshot']>; frames: ActuationFrame[]; completedTicks: number; droppedSeconds: number }[] = []
  for (const hz of [60, 30, 120]) {
    const pilot = await HumanoidPilot.create(model, { journalCapacity: 480 })
    try {
      const targets = targetsFromAngles(model, canonicalPoses(profileId).t)
      for (let n = 0; n < 2 * hz; n++) pilot.advance(1 / hz, o => {
        if (!captures.length) return { schema_version: 1, profileId, actorId: model.actorId, generation: o.generation, tick: o.stateTick, source: 'policy', targets }
        const saved = captures[0].frames[o.stateTick]
        // 120 Hz also replays the equivalent negative quaternion signs through the real actuation path.
        return { ...saved, source: 'replay', targets: hz === 120 ? Object.fromEntries(Object.entries(saved.targets).map(([id, q]) =>
          [id, { x: -q.x, y: -q.y, z: -q.z, w: -q.w }])) : saved.targets }
      })
      captures.push({ hz, states: pilot.snapshot(), frames: pilot.journal().map(r => r.action), completedTicks: pilot.diagnostics().tick, droppedSeconds: pilot.diagnostics().droppedSeconds })
    } finally { pilot.dispose() }
  }
  let maxPositionErrorM = 0, maxRotationErrorRad = 0, maxVelocityErrorMps = 0, maxAngularVelocityErrorRadps = 0
  for (const capture of captures.slice(1)) for (let i = 0; i < capture.states.length; i++) {
    const a = captures[0].states[i], b = capture.states[i]
    maxPositionErrorM = Math.max(maxPositionErrorM, norm(sub(a.position, b.position))); maxRotationErrorRad = Math.max(maxRotationErrorRad, angleBetween(a.rotation, b.rotation))
    maxVelocityErrorMps = Math.max(maxVelocityErrorMps, norm(sub(a.velocity, b.velocity))); maxAngularVelocityErrorRadps = Math.max(maxAngularVelocityErrorRadps, norm(sub(a.angularVelocity, b.angularVelocity)))
  }
  const errors = [maxPositionErrorM, maxRotationErrorRad, maxVelocityErrorMps, maxAngularVelocityErrorRadps]
  return { pass: captures.every(c => c.completedTicks === 480 && c.frames.length === 480 && c.droppedSeconds === 0) && errors.every(n => Number.isFinite(n) && n <= 1e-6),
    partitionsHz: captures.map(c => c.hz), negativeQuaternionSignsHz: 120, completedTicks: captures.map(c => c.completedTicks), maxPositionErrorM, maxRotationErrorRad, maxVelocityErrorMps, maxAngularVelocityErrorRadps,
    tolerance: '1e-6 in each reported SI quantity, same engine/runtime only; no cross-platform bit-identity claim.' }
}
export async function measureProfile(profileId: string) {
  const report: { schema_version: number; kind: string; profileId: string; pass: boolean; stance?: Awaited<ReturnType<typeof measureStance>>;
    anatomy?: Awaited<ReturnType<typeof measureAnatomy>>; replay?: Awaited<ReturnType<typeof measureReplay>>; errors: string[] } =
    { schema_version: 1, kind: 'humanoid-f1a2-native', profileId, pass: false, errors: [] }
  try { report.stance = await measureStance(profileId) } catch (e) { report.errors.push(`stance: ${message(e)}`) }
  try { report.anatomy = await measureAnatomy(profileId) } catch (e) { report.errors.push(`anatomy: ${message(e)}`) }
  try { report.replay = await measureReplay(profileId) } catch (e) { report.errors.push(`replay: ${message(e)}`) }
  report.pass = !!report.stance?.pass && !!report.anatomy?.pass && !!report.replay?.pass && !report.errors.length
  const model = buildHumanoid(profileId)
  return { ...report, modelVersion: model.version, parameters: {
    provenance: 'Original uncalibrated simulation defaults; existing ob.Pal primitive dimensions and independent axis limits, not hardware specifications.',
    controller: STANCE_CONTROL, constraintResponse: CONSTRAINT_DEFAULTS,
    units: { mass: 'kg', localInertia: 'kg m^2', positions: 'm', rotations: 'quaternion x/y/z/w', limits: 'rad',
      maxTorque: 'N m', stiffness: 'N m/rad', damping: 'N m s/rad', timestep: 's' },
    timestep: STEP, root: model.root, parts: model.parts, scene: model.scene,
  } }
}
