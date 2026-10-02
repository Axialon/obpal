/** One-actor F1a session. No balance/gait controller, renderer writes, BODY transport or hardware driver. */
import { Simulation } from '../../physics/runtime'
import { PHYSICS_SELECTION } from '../../physics/selection'
import { validateScene, type BackendFactory, type BodyState } from '../../physics/schema'
import { ActuationGate, type ActuationFrame } from './contract'
import { buildHumanoid, framesFromBodies, type PhysicalHumanoid } from './model'
import { observe, type Observation } from './observation'
export interface TickRecord { observation: Observation; action: ActuationFrame }
export type TickInput = (observation: Observation) => ActuationFrame
export class HumanoidPilot {
  private readonly model: PhysicalHumanoid
  private readonly simulation: Simulation
  private gate: ActuationGate
  private records: TickRecord[] = []
  private hold: ActuationFrame['targets']
  private sourceGeneration = 1
  private advancing = false
  private resetting = false
  private constructor(model: PhysicalHumanoid, simulation: Simulation, private readonly capacity: number) {
    this.model = structuredClone(model); this.simulation = simulation; this.gate = new ActuationGate(model, this.sourceGeneration)
    this.hold = this.gate.targets()
  }
  /** Explicit factory injection exists for orchestration tests. Production uses the single selected Rapier factory. */
  static async create(model: PhysicalHumanoid, options: { factory?: BackendFactory; journalCapacity?: number } = {}) {
    const capacity = options.journalCapacity ?? 240 // ticks: one second by default; bounded in-memory journal, no storage/UI.
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 7200) throw new RangeError('Journal capacity must be 1..7200 ticks')
    // Reconstruct the declared profile rather than accepting a hidden pinned root or changed effort in a model argument.
    const expected = buildHumanoid(model.profileId, model.actorId)
    if (JSON.stringify(model) !== JSON.stringify(expected)) throw new RangeError('Pilot model differs from its versioned profile')
    const definition = validateScene(expected.scene)
    const simulation = new Simulation(definition, options.factory ?? await PHYSICS_SELECTION.load())
    try {
      await simulation.init()
      const pilot = new HumanoidPilot(expected, simulation, capacity)
      pilot.observation() // Explicitly require native contact observation; never silently substitute empty samples.
      return pilot
    } catch (error) { simulation.dispose(); throw error }
  }
  get generation() { return this.sourceGeneration }
  definition(): PhysicalHumanoid { return structuredClone(this.model) }
  diagnostics() { return { ...this.simulation.diagnostics(), inputGeneration: this.sourceGeneration, journalTicks: this.records.length } }
  metadata() { return this.simulation.metadata() }
  snapshot(): BodyState[] { return this.simulation.snapshot() }
  renderFrames() { return framesFromBodies(this.model, this.simulation.render()) }
  observation(): Observation { return observe(this.model, this.simulation.snapshot(), this.simulation.contacts(), this.sourceGeneration, this.simulation.diagnostics().tick) }
  journal(): TickRecord[] { return structuredClone(this.records) }
  /** Target callbacks cannot outlive this advance. No wall-time queue exists to replay a stale BODY frame. */
  advance(seconds: number, input?: TickInput): void {
    if (this.advancing || this.resetting) throw new Error('Pilot is already advancing or resetting')
    const pending: TickRecord[] = []; this.advancing = true
    try {
      this.simulation.advance(seconds, tick => {
        const observation = this.observation()
        const request = input ? input(structuredClone(observation)) : {
          schema_version: 1 as const, profileId: this.model.profileId, actorId: this.model.actorId,
          generation: this.sourceGeneration, tick, source: 'hold' as const, targets: this.hold,
        }
        const action = this.gate.accept(request)
        this.simulation.setMotorTargets(action.targets)
        pending.push({ observation, action })
      })
    } finally {
      // A backend or callback fault may occur part-way through a multi-tick frame. Retain completed ticks ONLY.
      const completed = this.simulation.diagnostics().tick
      this.records.push(...pending.filter(r => r.action.tick < completed))
      if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity)
      this.advancing = false
    }
  }
  /** Quiet is a software hold at measured joint rotations, NOT sleep/stop/arming. Gravity and contacts continue. */
  quiet(): number {
    if (this.advancing || this.resetting) throw new Error('Cannot quiet during a pilot step/reset')
    const observation = this.observation(), previous = this.gate.targets()
    if (this.sourceGeneration === Number.MAX_SAFE_INTEGER) throw new RangeError('Input generation exhausted')
    this.sourceGeneration++
    this.hold = Object.fromEntries(observation.joints.map(j => [j.id, { ...j.rotation }]))
    this.gate = new ActuationGate(this.model, this.sourceGeneration, observation.stateTick, previous)
    return this.sourceGeneration
  }
  async reset(): Promise<void> {
    if (this.advancing || this.resetting) throw new Error('Cannot reset during a pilot step/reset')
    if (this.sourceGeneration === Number.MAX_SAFE_INTEGER) throw new RangeError('Input generation exhausted')
    this.resetting = true; this.sourceGeneration++; this.records = []
    try {
      await this.simulation.reset()
      this.gate = new ActuationGate(this.model, this.sourceGeneration); this.hold = this.gate.targets()
    } finally { this.resetting = false }
  }
  dispose(): void { if (this.advancing) throw new Error('Cannot dispose during a pilot step'); this.simulation.dispose(); this.records = [] }
}
