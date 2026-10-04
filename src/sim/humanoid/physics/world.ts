/** One free-body Rapier arena. Actor inputs leave only through their own ActuationGate. */
import { Simulation } from '../../physics/runtime'
import { PHYSICS_SELECTION } from '../../physics/selection'
import { STEP, validateScene, type BackendFactory, type BodyState } from '../../physics/schema'
import { add, sub, rotate, multiply, quaternion, fromRotationVector, localPoint, type Vec3 } from '../../physics/math'
import { restIntent } from '../controls'
import { ActuationGate, type ActuationFrame } from './contract'
import { buildHumanoid, framesFromBodies, type PhysicalHumanoid } from './model'
import { observe, type Observation } from './observation'
import { Supervisor, type BehaviourRegistry, type BehaviourMode, type Behaviour } from './supervisor'
import { BalanceController } from './balance'
import { GaitController } from './gait'
import type { Intent } from './intent'

export type ActorId = 'seat1' | 'seat2'
export interface Spawn { x: number; z: number; yaw: number; posture?: 'upright' | 'prone' | 'supine' }
export interface ActorSpec { actorId: ActorId; profileId: string; spawn?: Spawn }
export interface WorldOptions { actors?: readonly ActorSpec[]; factory?: BackendFactory; journalCapacity?: number; gaitMode?: 'walk' | 'in-place' }
export interface Disturbance { kind: 'push'; forceN: Vec3 }
export interface WorldTickRecord { observation: Observation; intent: Intent; action: ActuationFrame; disturbances: Disturbance[] }
export type WorldJournal = Partial<Record<ActorId, readonly WorldTickRecord[]>>
export type WorldInput = (observation: Observation, intent: Intent) => ActuationFrame
export type PushClass = 'A' | 'B' | 'C' | 'D'
export type PushDirection = 'toe' | 'heel' | 'lateral' | 'diagonal'
export const PUSH_SECONDS = .1 // s: SIMBICON disturbance protocol, 24 fixed ticks.
const PUSH_IMPULSES: Record<PushClass, Record<PushDirection, number>> = {
  A: { toe: 10, heel: 5, lateral: 10, diagonal: 5 }, B: { toe: 18, heel: 9, lateral: 18, diagonal: 9 },
  C: { toe: 40, heel: 20, lateral: 30, diagonal: 20 }, D: { toe: 150, heel: 150, lateral: 150, diagonal: 150 },
}
interface Actor {
  model: PhysicalHumanoid; generation: number; gate: ActuationGate; validationGate: ActuationGate; supervisor: Supervisor; intent: Intent
  hold: ActuationFrame['targets'] | null; journal: WorldTickRecord[]; pushes: { forceN: Vec3; ticks: number }[]
}
function supervisor(model: PhysicalHumanoid, generation: number, gaitMode: 'walk' | 'in-place'): Supervisor {
  const nominal = buildHumanoid(model.profileId, model.actorId), balance = new BalanceController(nominal, generation)
  return new Supervisor(nominal, generation, new Map<BehaviourMode, Behaviour>([['walk', new GaitController(nominal, generation, { mode: gaitMode })], ['balance', {
    mode: 'balance', canEnter: () => true, done: () => true, step: o => balance.step(o).frame,
  }]]))
}
/** Rigid initialisation only; joints and motor targets retain their authored relative frames. */
function spawned(model: PhysicalHumanoid, spawn: Spawn): PhysicalHumanoid {
  if (![spawn.x, spawn.z, spawn.yaw].every(Number.isFinite) || Math.hypot(spawn.x, spawn.z) > 100 ||
    !['upright', 'prone', 'supine'].includes(spawn.posture ?? 'upright')) throw new RangeError('Invalid actor spawn')
  const out = structuredClone(model), pivot = out.scene.bodies.find(b => b.id === out.root)!.position
  const tilt = spawn.posture === 'prone' ? -Math.PI / 2 : spawn.posture === 'supine' ? Math.PI / 2 : 0
  const rotation = multiply(fromRotationVector({ x: 0, y: spawn.yaw, z: 0 }), fromRotationVector({ x: tilt, y: 0, z: 0 }))
  const dynamic = out.scene.bodies.filter(b => !b.fixed)
  for (const b of dynamic) {
    b.position = add(pivot, rotate(rotation, sub(b.position, pivot)))
    b.position.x += spawn.x; b.position.z += spawn.z
    b.rotation = quaternion(multiply(rotation, b.rotation))
  }
  const minimum = Math.min(...dynamic.flatMap(b => {
    if (b.shape.kind !== 'box') throw new RangeError('Humanoid fixture requires box links')
    const h = b.shape.half
    return [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => localPoint(b.position, b.rotation, { x: x * h.x, y: y * h.y, z: z * h.z }).y)))
  }))
  const shift = .002 - minimum // m: simulation default initial release gap; never a resting-height correction.
  for (const b of dynamic) b.position.y += shift
  return out
}
export class HumanoidWorld {
  private readonly actors = new Map<ActorId, Actor>()
  private readonly actorBodies: ReadonlySet<string>
  private advancing = false
  private resetting = false
  private disposed = false
  private constructor(private readonly simulation: Simulation, models: PhysicalHumanoid[], private readonly capacity: number, private readonly gaitMode: 'walk' | 'in-place') {
    for (const model of models) this.actors.set(model.actorId as ActorId, {
      model, generation: 1, gate: new ActuationGate(model, 1), validationGate: new ActuationGate(model, 1), supervisor: supervisor(model, 1, gaitMode),
      intent: restIntent(), hold: null, journal: [], pushes: [],
    })
    this.actorBodies = new Set(models.flatMap(m => m.scene.bodies.filter(b => !b.fixed).map(b => b.id)))
  }
  static async create(options: WorldOptions = {}): Promise<HumanoidWorld> {
    if (options.gaitMode !== undefined && !['walk', 'in-place'].includes(options.gaitMode)) throw new RangeError('Invalid world gait mode')
    const specs = options.actors ?? [
      { actorId: 'seat1', profileId: 'keel-v1', spawn: { x: -1, z: 0, yaw: 0 } },
      { actorId: 'seat2', profileId: 'keel-v1', spawn: { x: 1, z: 0, yaw: 0 } },
    ]
    if (specs.length < 1 || specs.length > 2 || new Set(specs.map(s => s.actorId)).size !== specs.length ||
      specs.some(s => !['seat1', 'seat2'].includes(s.actorId))) throw new RangeError('World requires one or two distinct seats')
    const capacity = options.journalCapacity ?? 240 // ticks: simulation default bounded journal, one second.
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 7200) throw new RangeError('Journal capacity must be 1..7200 ticks')
    const models = specs.map(s => spawned(buildHumanoid(s.profileId, s.actorId), s.spawn ?? { x: s.actorId === 'seat1' ? -1 : 1, z: 0, yaw: 0 }))
    const scene = validateScene({ ...models[0].scene,
      bodies: [models[0].scene.bodies.find(b => b.id === 'floor')!, ...models.flatMap(m => m.scene.bodies.filter(b => !b.fixed))],
      joints: models.flatMap(m => m.scene.joints),
    })
    const simulation = new Simulation(scene, options.factory ?? await PHYSICS_SELECTION.load())
    try {
      await simulation.init()
      const world = new HumanoidWorld(simulation, models, capacity, options.gaitMode ?? 'walk')
      world.observations()
      return world
    } catch (error) { simulation.dispose(); throw error }
  }
  private actor(id: ActorId): Actor { const a = this.actors.get(id); if (!a) throw new RangeError('Unknown world actor'); return a }
  private mutable(): void { if (this.advancing || this.resetting || this.disposed) throw new Error('World is advancing, resetting or disposed') }
  get actorIds(): ActorId[] { return [...this.actors.keys()] }
  generation(id: ActorId): number { return this.actor(id).generation }
  definition(id: ActorId): PhysicalHumanoid { return structuredClone(this.actor(id).model) }
  targets(id: ActorId) { return this.actor(id).gate.targets() }
  supervisor(id: ActorId): Supervisor { return this.actor(id).supervisor }
  register(id: ActorId, registry: BehaviourRegistry): void {
    this.mutable(); for (const behaviour of registry.values()) this.actor(id).supervisor.register(behaviour)
  }
  diagnostics() { return { ...this.simulation.diagnostics(), actors: Object.fromEntries([...this.actors].map(([id, a]) => [id, {
    generation: a.generation, journalTicks: a.journal.length, ...a.supervisor.diagnostics(),
  }])) } }
  metadata() { return this.simulation.metadata() }
  snapshot(): BodyState[] { return this.simulation.snapshot() }
  renderFrames() { const states = this.simulation.render(); return Object.fromEntries([...this.actors].map(([id, a]) => [id, framesFromBodies(a.model, states)])) }
  observations(): Record<ActorId, Observation> {
    const states = this.simulation.snapshot(), contacts = this.simulation.contactsCached(), tick = this.simulation.diagnostics().tick
    return Object.fromEntries([...this.actors].map(([id, a]) => [id, observe(a.model, states, contacts, a.generation, tick, this.actorBodies)])) as Record<ActorId, Observation>
  }
  observation(id: ActorId): Observation { this.actor(id); return this.observations()[id] }
  journal(id: ActorId): WorldTickRecord[] { return structuredClone(this.actor(id).journal) }
  setIntent(id: ActorId, intent: Intent): void {
    this.mutable()
    if (![intent.x, intent.z, intent.yaw].every(n => Number.isFinite(n) && Math.abs(n) <= 1) || typeof intent.manual !== 'boolean' ||
      intent.command && !['stand', 'getup', 'push'].includes(intent.command)) throw new RangeError('Invalid world intent')
    this.actor(id).intent = structuredClone(intent)
  }
  /** Explicit test disturbance. Facing is sampled at request time, not integrated from phone input. */
  push(id: ActorId, magnitude: PushClass | Vec3 = 'C', direction: PushDirection = 'toe'): void {
    this.mutable(); const a = this.actor(id)
    let impulse: Vec3
    if (typeof magnitude === 'string') {
      const ns = PUSH_IMPULSES[magnitude]?.[direction]
      if (!Number.isFinite(ns)) throw new RangeError('Invalid push class/direction')
      const local = direction === 'toe' ? { x: 0, y: 0, z: -ns } : direction === 'heel' ? { x: 0, y: 0, z: ns } :
        direction === 'lateral' ? { x: ns, y: 0, z: 0 } : { x: ns / Math.SQRT2, y: 0, z: -ns / Math.SQRT2 }
      const pelvis = this.observation(id).bodies.find(b => b.id === a.model.root)!
      // Horizontal facing avoids turning a test push into lift when the actor has fallen.
      const forward = rotate(pelvis.rotation, { x: 0, y: 0, z: -1 }), yaw = Math.atan2(-forward.x, -forward.z)
      impulse = rotate(fromRotationVector({ x: 0, y: yaw, z: 0 }), local)
    } else impulse = { ...magnitude }
    const forceN = { x: impulse.x / PUSH_SECONDS, y: impulse.y / PUSH_SECONDS, z: impulse.z / PUSH_SECONDS }
    if (![forceN.x, forceN.y, forceN.z].every(Number.isFinite) || Math.hypot(forceN.x, forceN.y, forceN.z) > this.simulation.limits.maxForce)
      throw new RangeError('Invalid push impulse')
    a.pushes.push({ forceN, ticks: Math.round(PUSH_SECONDS / STEP) })
  }
  advance(seconds: number, input?: WorldInput): void { this.run(seconds, input) }
  /** Replay accepted actions and per-tick forces, retaining the gate and fixed-tick integrator. */
  replay(seconds: number, journal: WorldJournal): void { this.run(seconds, undefined, journal) }
  private run(seconds: number, input?: WorldInput, replay?: WorldJournal): void {
    this.mutable(); this.advancing = true
    const pending = new Map<ActorId, WorldTickRecord[]>(this.actorIds.map(id => [id, []]))
    try {
      const external = !!input || !!replay
      if (external) for (const a of this.actors.values()) a.validationGate = new ActuationGate(a.model, a.generation,
        this.simulation.diagnostics().tick, a.gate.targets())
      this.simulation.advance(seconds, tick => {
        const observations = this.observations(), requests: { id: ActorId; intent: Intent; request: ActuationFrame; disturbances: Disturbance[] }[] = []
        for (const [id, a] of this.actors) {
          const o = observations[id], recorded = replay?.[id]?.find(r => r.action.tick === tick)
          if (replay && !recorded) throw new RangeError('Missing replay tick/actor')
          const intent = recorded ? structuredClone(recorded.intent) : structuredClone(a.intent)
          const request = recorded ? { ...structuredClone(recorded.action), source: 'replay' as const } : input ? input(structuredClone(o), intent) : a.hold ? {
            schema_version: 1 as const, profileId: a.model.profileId, actorId: id, generation: a.generation, tick, source: 'hold' as const, targets: a.hold,
          } : a.supervisor.step(structuredClone(o), intent)
          const disturbances = recorded ? structuredClone(recorded.disturbances) : a.pushes.map(p => ({ kind: 'push' as const, forceN: { ...p.forceN } }))
          for (const d of disturbances) if (d.kind !== 'push' || ![d.forceN.x, d.forceN.y, d.forceN.z].every(Number.isFinite) ||
            Math.hypot(d.forceN.x, d.forceN.y, d.forceN.z) > this.simulation.limits.maxForce) throw new RangeError('Invalid replay disturbance')
          requests.push({ id, intent, request, disturbances })
        }
        // Supervisor requests have all been validated before any gate changes. External callback/replay frames
        // use persistent staging gates so a wrong-actor request cannot consume the other actor's tick.
        const staged = requests.map(r => {
          const a = this.actor(r.id)
          return { ...r, action: (external ? a.validationGate : a.gate).accept(r.request) }
        })
        this.simulation.setMotorTargets(Object.assign({}, ...staged.map(r => r.action.targets)))
        for (const r of staged) {
          const a = this.actor(r.id); if (external) a.gate.accept(r.request)
          for (const d of r.disturbances) this.simulation.applyForce(a.model.parts.thorax.bodyId, d.forceN)
          pending.get(r.id)!.push({ observation: observations[r.id], intent: r.intent, action: r.action, disturbances: r.disturbances })
          if (!replay) { for (const p of a.pushes) p.ticks--; a.pushes = a.pushes.filter(p => p.ticks > 0); delete a.intent.command }
        }
      })
    } finally {
      const completed = this.simulation.diagnostics().tick
      for (const [id, records] of pending) { const a = this.actor(id); a.journal.push(...records.filter(r => r.action.tick < completed));
        if (a.journal.length > this.capacity) a.journal.splice(0, a.journal.length - this.capacity) }
      this.advancing = false
    }
  }
  /** Input loss returns intent to rest while physics control keeps balancing. */
  loss(id: ActorId): number { this.mutable(); const a = this.actor(id); a.intent = restIntent(); return this.renew(id, false) }
  /** Only an explicit Stop uses measured hold targets. It cannot stop gravity or contacts. */
  quiet(id: ActorId): number { this.mutable(); return this.renew(id, true) }
  private renew(id: ActorId, quiet: boolean): number {
    const a = this.actor(id), observation = this.observation(id)
    if (a.generation === Number.MAX_SAFE_INTEGER) throw new RangeError('Input generation exhausted')
    a.generation++; const previous = a.gate.targets()
    a.gate = new ActuationGate(a.model, a.generation, observation.stateTick, previous)
    a.validationGate = new ActuationGate(a.model, a.generation, observation.stateTick, previous)
    a.supervisor = supervisor(a.model, a.generation, this.gaitMode)
    a.hold = quiet ? Object.fromEntries(observation.joints.map(j => [j.id, { ...j.rotation }])) : null
    return a.generation
  }
  async reset(): Promise<void> {
    this.mutable()
    if ([...this.actors.values()].some(a => a.generation === Number.MAX_SAFE_INTEGER)) throw new RangeError('Input generation exhausted')
    this.resetting = true
    try {
      await this.simulation.reset()
      for (const a of this.actors.values()) { a.generation++; a.gate = new ActuationGate(a.model, a.generation); a.validationGate = new ActuationGate(a.model, a.generation);
        a.supervisor = supervisor(a.model, a.generation, this.gaitMode); a.intent = restIntent(); a.hold = null; a.journal = []; a.pushes = [] }
    } finally { this.resetting = false }
  }
  dispose(): void { this.mutable(); this.simulation.dispose(); this.disposed = true; for (const a of this.actors.values()) { a.journal = []; a.pushes = [] } }
}
