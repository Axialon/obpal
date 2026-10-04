/** Native standing push table. Disturbances enter through world.push; control stays behind the world's gate. */
import { HumanoidWorld, PUSH_SECONDS, type PushClass, type PushDirection } from '../src/sim/humanoid/physics/world'
import { BalanceController } from '../src/sim/humanoid/physics/balance'
import { STEP } from '../src/sim/physics/schema'
import { rotate } from '../src/sim/physics/math'
import { colliderFloorMinimum, GaitFootCycleMeter, preFallCycleCount } from './humanoid-control-gait-cases'

export const PUSH_PILOTS = ['keel-v1', 'morrow-v1'] as const
export const PUSH_CLASSES = ['A', 'B', 'C'] as const
export const PUSH_DIRECTIONS: readonly PushDirection[] = ['toe', 'heel', 'lateral', 'diagonal']
export const PUSH_TABLE_NS = {
  A: { toe: 10, heel: 5, lateral: 10, diagonal: 5 },
  B: { toe: 18, heel: 9, lateral: 18, diagonal: 9 },
  C: { toe: 40, heel: 20, lateral: 30, diagonal: 20 },
} as const
const SETTLE_S = 2, OBSERVE_S = 6 // s: simulation defaults; C's four-second return plus two-second hold.
const HOLD_TICKS = 2 / STEP // ticks: unchanged push B/C stance hold.
export interface PushTrialOptions {
  controller?: 'world' | 'balance-only'; sourceLabel?: string
  /** Deterministic robustness fixture, m and rad; the nominal table starts at the origin facing forward. */
  spawn?: { x: number; z: number; yaw: number }
}

export async function measurePushTrial(profileId: string, pushClass: Exclude<PushClass, 'D'>, direction: PushDirection, options: PushTrialOptions = {}) {
  const spawn = { x: 0, z: 0, yaw: 0, ...options.spawn }
  const world = await HumanoidWorld.create({ actors: [{ actorId: 'seat1', profileId, spawn }], journalCapacity: 1 })
  const model = world.definition('seat1'), standingHeightM = model.scene.bodies.find(b => b.id === model.root)!.position.y
  const balance = options.controller === 'balance-only' ? new BalanceController(model, world.generation('seat1')) : null
  const settleTicks = Math.round(SETTLE_S / STEP), maximumTicks = Math.round(OBSERVE_S / STEP)
  const row = { schema_version: 1, kind: 'humanoid-control-standing-push', profileId, pushClass, direction,
    controller: options.controller ?? 'world', sourceLabel: options.sourceLabel ?? model.version, spawn,
    impulseNs: PUSH_TABLE_NS[pushClass][direction], pushSeconds: PUSH_SECONDS, settleTicks: 0, completedTicks: 0, maximumTicks,
    standingHeightM, minPelvisHeightM: standingHeightM, minUpY: 1, maxPenetrationMm: 0, maxNonFootPenetrationMm: 0,
    maxEffortRatio: 0, finite: true, noFall: true, firstFallS: null as number | null,
    firstViolation: null as { timeS: number; reason: string } | null, nonFootFloorImpulseNs: 0,
    maxFootUnloadedS: 0, steps: 0, recoveryAtS: null as number | null, maxStanceHeldS: 0,
    disturbedTicks: 0, appliedImpulseNs: { x: 0, y: 0, z: 0 }, firstPushForceN: null as { x: number; y: number; z: number } | null,
    modes: {} as Record<string, number>, footCycles: [] as { id: string; report: GaitFootCycleMeter['report'] }[],
    finalPelvisHeightM: standingHeightM, finalUpY: 1, finalBothFeetLoaded: false,
    droppedSeconds: 0, invalidFrames: 0, error: null as string | null, nativeFault: null as string | null,
    terminationReason: 'full-horizon' as 'full-horizon' | 'first-fall' | 'error', pass: false,
    trace: [] as { timeS: number; pelvisM: number; upY: number; penetrationMm: number; loadsN: number[]; mode: string }[],
    measurement: {
      clock: 'Push onset is time zero after two seconds of balance. Recovery must begin after the 0.1-second force ends and hold continuously for two seconds.',
      penetration: 'Exact world minimum of every dynamic primitive collider, on every tick including initial settle and the first falling tick.',
      steps: 'Existing gait-cycle observer: at least 50 ms continuously unloaded, 10 mm whole-collider clearance, then two loaded touchdown ticks. Only cycles confirmed before a fall count; raw unload/load transitions are also reported.',
      endpoint: 'Stop on the first non-foot floor impulse or pelvis below 80% initial height. An early fall is physical failure, never a completed horizon.',
    },
  }
  const unloaded = new Map(model.feet.map(id => [id, 0])), cycles = new Map<string, GaitFootCycleMeter>()
  let stanceTicks = 0
  const violate = (timeS: number, reason: string) => { row.firstViolation ??= { timeS, reason } }
  try {
    for (let tick = 0; tick < settleTicks + maximumTicks; tick++) {
      if (tick === settleTicks) {
        for (const foot of world.observation('seat1').feet) cycles.set(foot.id, new GaitFootCycleMeter(foot.normalImpulseNs > 0))
        world.push('seat1', pushClass, direction)
      }
      world.advance(STEP, balance ? observation => balance.step(observation).frame : undefined)
      const o = world.observation('seat1'), diagnostics = world.diagnostics(), timeS = (tick + 1 - settleTicks) * STEP
      const root = o.bodies.find(b => b.id === model.root)!, upY = rotate(root.rotation, { x: 0, y: 1, z: 0 }).y
      const penetrationMm = Math.max(0, ...o.bodies.map(b => -colliderFloorMinimum(model, b) * 1000))
      const nonFootPenetrationMm = Math.max(0, ...o.bodies.filter(b => !model.feet.includes(b.id)).map(b => -colliderFloorMinimum(model, b) * 1000))
      const mode = balance ? 'balance-only' : world.supervisor('seat1').mode
      row.modes[mode] = (row.modes[mode] ?? 0) + 1
      row.minPelvisHeightM = Math.min(row.minPelvisHeightM, root.position.y); row.minUpY = Math.min(row.minUpY, upY)
      row.maxPenetrationMm = Math.max(row.maxPenetrationMm, penetrationMm)
      row.maxNonFootPenetrationMm = Math.max(row.maxNonFootPenetrationMm, nonFootPenetrationMm)
      row.finite &&= o.bodies.every(b => [ ...Object.values(b.position), ...Object.values(b.rotation), ...Object.values(b.velocity),
        ...Object.values(b.angularVelocity)].every(Number.isFinite)) && [...Object.values(o.com), ...Object.values(o.comVelocity)].every(Number.isFinite)
      for (const [id, torque] of Object.entries(diagnostics.forces.motorTorques)) {
        const joint = model.scene.joints.find(j => j.id === id)
        if (!joint) throw new Error('Unknown push-trial motor')
        row.maxEffortRatio = Math.max(row.maxEffortRatio, torque / joint.motor.maxTorque)
      }
      if (!o.floorContacts) throw new Error('World push trial requires floor-contact observations')
      for (const contact of o.floorContacts) {
        const bodyId = contact.a === 'floor' ? contact.b : contact.a
        if (!model.feet.includes(bodyId) && contact.impulse > 0) row.nonFootFloorImpulseNs += contact.impulse
      }
      const bothLoaded = o.feet.every(f => f.normalImpulseNs > 0)
      for (const foot of o.feet) {
        const count = foot.normalImpulseNs > 0 ? 0 : unloaded.get(foot.id)! + 1
        unloaded.set(foot.id, count); row.maxFootUnloadedS = Math.max(row.maxFootUnloadedS, count * STEP)
        if (tick >= settleTicks) cycles.get(foot.id)!.sample(tick + 1 - settleTicks, foot.normalImpulseNs > 0,
          colliderFloorMinimum(model, o.bodies.find(b => b.id === foot.id)!))
      }
      if (tick < settleTicks) row.settleTicks++
      else {
        row.completedTicks++
        if (tick < settleTicks + Math.round(PUSH_SECONDS / STEP)) {
          const record = world.journal('seat1')[0]
          if (record.disturbances.length) row.disturbedTicks++
          for (const disturbance of record.disturbances) {
            row.firstPushForceN ??= { ...disturbance.forceN }
            for (const axis of ['x', 'y', 'z'] as const) row.appliedImpulseNs[axis] += disturbance.forceN[axis] * STEP
          }
        }
        const stance = upY >= .98 && root.position.y >= .9 * standingHeightM && bothLoaded && penetrationMm <= 5
        stanceTicks = timeS >= PUSH_SECONDS && stance ? stanceTicks + 1 : 0
        row.maxStanceHeldS = Math.max(row.maxStanceHeldS, stanceTicks * STEP)
        if (stanceTicks >= HOLD_TICKS && row.recoveryAtS === null) row.recoveryAtS = timeS - (stanceTicks - 1) * STEP
      }
      row.finalPelvisHeightM = root.position.y; row.finalUpY = upY; row.finalBothFeetLoaded = bothLoaded
      if (penetrationMm > 5) violate(timeS, 'dynamic collider penetration exceeds 5 mm')
      if (row.maxEffortRatio > 1 + 1e-8) violate(timeS, 'joint effort exceeds cap')
      if (!row.finite) throw new Error('Non-finite push-trial observation')
      if (pushClass === 'A' && (upY < .98 || root.position.y < .9 * standingHeightM || row.maxFootUnloadedS > .1))
        violate(timeS, 'class A stance envelope or 0.1-second unloading limit')
      const fell = root.position.y < .8 * standingHeightM || row.nonFootFloorImpulseNs > 0
      if (fell) {
        row.noFall = false; row.firstFallS = timeS; row.terminationReason = 'first-fall'; violate(timeS, 'pelvis below 80% or non-foot floor impulse')
      }
      if (tick % 24 === 0 || fell) row.trace.push({ timeS, pelvisM: root.position.y, upY, penetrationMm, loadsN: o.feet.map(f => f.normalImpulseNs / STEP), mode })
      if (fell) break
    }
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); row.terminationReason = 'error' }
  finally {
    const diagnostics = world.diagnostics()
    row.nativeFault = diagnostics.fault; row.droppedSeconds = diagnostics.droppedSeconds; row.invalidFrames = diagnostics.invalidFrames
    for (const [id, meter] of cycles) {
      meter.report.preFallQualifiedCycles = preFallCycleCount(meter.report.events, row.firstFallS)
      row.steps += meter.report.preFallQualifiedCycles; row.footCycles.push({ id, report: structuredClone(meter.report) })
    }
    world.dispose()
  }
  const common = !row.error && !row.nativeFault && row.finite && row.noFall && row.settleTicks === settleTicks && row.completedTicks === maximumTicks &&
    row.maxPenetrationMm <= 5 && row.maxEffortRatio <= 1 + 1e-8 && row.droppedSeconds === 0 && row.invalidFrames === 0 && row.disturbedTicks === 24
  row.pass = common && (pushClass === 'A' ? row.minUpY >= .98 && row.minPelvisHeightM >= .9 * standingHeightM && row.maxFootUnloadedS <= .1 :
    row.recoveryAtS !== null && row.recoveryAtS <= (pushClass === 'B' ? 2 : 4) && row.maxStanceHeldS >= 2 && (pushClass !== 'C' || row.steps <= 3))
  return row
}
