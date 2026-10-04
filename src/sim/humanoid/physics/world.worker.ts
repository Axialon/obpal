/** The page sends elapsed time and tracked upper-body angles; only this worker owns Rapier. */
import { HumanoidWorld, type ActorId, type PushClass, type PushDirection } from './world'
import { STEP } from '../../physics/schema'
import { rotate, angleBetween, type Quat } from '../../physics/math'
import type { Retargeted } from '../retarget'
import type { Angles } from '../profile'
import type { WorldFrame } from './model'
import { UpperBodyController } from './upper-body'

export interface PhysicsActorStatus {
  actorId: ActorId; generation: number; upY: number; pelvisHeight: number; nominalPelvisHeight: number
  support: 'double' | 'single' | 'none'; effortRatio: number; bodyWeight: number; mode: string; source: string
  loadedFeet: string[]
  joints: ReturnType<HumanoidWorld['observation']>['joints']; fallen: boolean; upperBodyMovementRad: number; disturbances: number
}
export interface PhysicsState {
  kind: 'state'; request: number; frames: Record<string, Record<string, WorldFrame>>; actors: PhysicsActorStatus[]
  tick: number; droppedSeconds: number; tickTimesMs: number[]; workerWorkMs: number; advancedSeconds: number
}
export type PhysicsCommand =
  | { kind: 'init'; request: number; count: 1 | 2 }
  | { kind: 'reset'; request: number }
  | { kind: 'push'; request: number; actorId: ActorId; magnitude: PushClass; direction: PushDirection }
  | { kind: 'stance' | 'loss'; request: number; actorId: ActorId }
  | { kind: 'advance'; request: number; seconds: number; inputs: Partial<Record<ActorId, { body: Retargeted | null; preset: Angles | null }>> }

/** Simulation defaults: dimensionless Down hints; these do not alter any actuation or acceptance gate. */
const DOWN = { upY: .8, nominalHeightRatio: .65 }
let world: HumanoidWorld | null = null, remainder = 0
const latest = new Map<ActorId, { body: Retargeted | null; preset: Angles | null }>()
const bodyWeights = new Map<ActorId, number>()
const originalJoints = new Map<ActorId, Record<string, Quat>>()
const disturbances = new Map<ActorId, number>()
// The world registers balance for each generation. Capture is attached to that same supervisor.
function register(ids = world!.actorIds, resetEvidence = false) {
  for (const id of ids) {
    const model = world!.definition(id), upper = new UpperBodyController(model, world!.generation(id)),
      nominalHeight = model.scene.bodies.find(b => b.id === model.root)!.position.y
    world!.supervisor(id).setUpperBody({ step(observation, _intent, mode, frame) {
      const body = latest.get(id), root = observation.bodies.find(b => b.id === model.root)!,
        thorax = observation.bodies.find(b => b.id === model.parts.thorax.bodyId)!,
        fallen = rotate(thorax.rotation, { x: 0, y: 1, z: 0 }).y < DOWN.upY || root.position.y < DOWN.nominalHeightRatio * nominalHeight
      const result = upper.step(observation, frame, { mode: fallen ? 'fall' : mode, body: body?.body, preset: body?.preset })
      bodyWeights.set(id, result.diagnostics.bodyWeight)
      // Arms, head and spine yaw follow. Torso pitch/roll offsets await a balance-controller interface.
      // The module already blends per joint; the supervisor must not attenuate those targets a second time.
      return { targets: result.frame.targets, weight: 1, source: result.frame.source === 'body' ? 'body' : 'classical' }
    } })
    bodyWeights.set(id, 0)
    if (resetEvidence) {
      originalJoints.set(id, Object.fromEntries(world!.observation(id).joints.map(j => [j.id, j.rotation])))
      disturbances.set(id, 0)
    }
  }
}
function state(request: number, tickTimesMs: number[] = [], workerWorkMs = 0, advancedSeconds = 0): PhysicsState {
  const w = world!, observations = w.observations(), diagnostics = w.diagnostics()
  return { kind: 'state', request, frames: w.renderFrames(), tick: diagnostics.tick, droppedSeconds: diagnostics.droppedSeconds,
    tickTimesMs, workerWorkMs, advancedSeconds, actors: w.actorIds.map(actorId => {
      const model = w.definition(actorId), o = observations[actorId], root = o.bodies.find(b => b.id === model.root)!,
        thorax = o.bodies.find(b => b.id === model.parts.thorax.bodyId)!, upY = rotate(thorax.rotation, { x: 0, y: 1, z: 0 }).y,
        loaded = o.feet.filter(f => f.normalImpulseNs > 0).length, supervisor = w.supervisor(actorId).diagnostics()
      const effortRatio = Math.max(0, ...model.scene.joints.map(j => (diagnostics.forces.motorTorques[j.id] ?? 0) / j.motor.maxTorque))
      return { actorId, generation: w.generation(actorId), upY, pelvisHeight: root.position.y,
        nominalPelvisHeight: model.scene.bodies.find(b => b.id === model.root)!.position.y,
        support: loaded === 2 ? 'double' : loaded === 1 ? 'single' : 'none', loadedFeet: o.feet.filter(f => f.normalImpulseNs > 0).map(f => f.id),
        effortRatio, bodyWeight: bodyWeights.get(actorId) ?? 0,
        mode: supervisor?.mode ?? 'stance', source: supervisor?.source ?? 'classical', joints: o.joints,
        upperBodyMovementRad: Math.max(0, ...model.drives.filter(d => d.axes.some(n => n.includes('.arm.'))).map(d =>
          angleBetween(originalJoints.get(actorId)![d.id], o.joints.find(j => j.id === d.id)!.rotation))), disturbances: disturbances.get(actorId) ?? 0,
        fallen: upY < DOWN.upY || root.position.y < DOWN.nominalHeightRatio * model.scene.bodies.find(b => b.id === model.root)!.position.y }
    }) }
}
async function command(c: PhysicsCommand) {
  if (c.kind === 'init') {
    world?.dispose(); latest.clear(); remainder = 0
    world = await HumanoidWorld.create({ actors: Array.from({ length: c.count }, (_, i) => ({
      actorId: i ? 'seat2' : 'seat1', profileId: 'keel-v1', spawn: { x: c.count === 1 ? 0 : i ? 1 : -1, z: 0, yaw: 0 },
    })), journalCapacity: 240 })
    register(world.actorIds, true)
  } else if (!world) throw new Error('Physics world is not ready')
  else if (c.kind === 'reset') { await world.reset(); latest.clear(); remainder = 0; register(world.actorIds, true) }
  else if (c.kind === 'push') { world.push(c.actorId, c.magnitude, c.direction); disturbances.set(c.actorId, (disturbances.get(c.actorId) ?? 0) + 1) }
  else if (c.kind === 'stance') { latest.delete(c.actorId); world.setIntent(c.actorId, { x: 0, z: 0, yaw: 0, manual: false, command: 'stand' }) }
  else if (c.kind === 'loss') { latest.delete(c.actorId); world.loss(c.actorId); register([c.actorId]) }
  else if (c.kind === 'advance') {
    const begin = performance.now(), tickTimesMs: number[] = []
    for (const id of world.actorIds) latest.set(id, c.inputs[id] ?? { body: null, preset: null })
    remainder += c.seconds
    let advancedSeconds = 0
    while (remainder + 1e-10 >= STEP) {
      const tickBegin = performance.now(); world.advance(STEP); tickTimesMs.push(performance.now() - tickBegin)
      remainder -= STEP; advancedSeconds += STEP
    }
    const result = state(c.request, tickTimesMs, 0, advancedSeconds)
    result.workerWorkMs = performance.now() - begin
    return result
  }
  return state(c.request)
}
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<PhysicsCommand>) => {
  queue = queue.then(async () => {
    try { self.postMessage(await command(event.data)) }
    catch (error) { self.postMessage({ kind: 'error', request: event.data.request, message: error instanceof Error ? error.message : String(error) }) }
  })
}
