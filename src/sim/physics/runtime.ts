/** Fail-closed lifecycle around one engine instance. Physics faults never trigger a hidden backend substitution. */
import { FixedWorld, type PhysicsAdapter } from './world'
import { validateScene, validateLimits, vector, STEP, type Backend, type BackendFactory, type BodyState, type Limits, type Scene, type SceneInput, type Quat, type Vec3 } from './schema'
import { ZERO, add, sub, scale, cross, norm, quaternion, clampCone } from './math'
import { accumulate, actuatorForces, type Wrench, type ForceDiagnostics } from './forces'
export type PhysicsStatus = 'idle' | 'loading' | 'ready' | 'faulted' | 'disposed'
const copyState = (s: BodyState): BodyState => ({ ...s, position: { ...s.position }, rotation: { ...s.rotation }, velocity: { ...s.velocity }, angularVelocity: { ...s.angularVelocity } })

export class Simulation {
  private readonly definition: Scene
  readonly limits: Readonly<Limits>
  status: PhysicsStatus = 'idle'
  fault: string | null = null
  private readonly internalForces: number
  private readonly factory: BackendFactory
  private backend: Backend | null = null
  private clock: FixedWorld<BodyState[]> | null = null
  private pending: Promise<void> | null = null
  private epoch = 0
  private lastGood: BodyState[] = []
  private commands: { id: string; force: Vec3; torque: Vec3 }[] = []
  private targets = new Map<string, Quat>()
  private beforeTick: ((tick: number) => void) | undefined
  private advancing = false
  private forces: ForceDiagnostics = { wheelLoads: {}, displacedVolumes: {}, motorTorques: {} }

  constructor(scene: SceneInput, factory: BackendFactory, limits: Partial<Limits> = {}) {
    this.limits = validateLimits(limits); this.definition = validateScene(scene, this.limits); this.factory = factory
    this.internalForces = this.definition.joints.length * 2 + this.definition.wheels.length * 2 + this.definition.buoys.reduce((n, b) => n + b.samples.length, 0)
  }
  get scene(): Scene { return validateScene(this.definition, this.limits) }
  init(): Promise<void> {
    if (this.status === 'disposed') return Promise.reject(new Error('Physics session is disposed'))
    if (this.status === 'ready') return Promise.resolve()
    if (this.pending) return this.pending
    if (this.status === 'faulted') { try { this.releaseBackend() } catch (error) { return Promise.reject(error) } }
    const epoch = ++this.epoch; this.status = 'loading'; this.fault = null
    // Defer even a synchronous factory throw, and retain one promise for concurrent callers.
    this.pending = Promise.resolve().then(() => this.factory(validateScene(this.definition, this.limits), this.limits)).then(backend => {
      if (epoch !== this.epoch || this.status === 'disposed') { backend.dispose(); throw new Error('Physics init cancelled') }
      this.backend = backend
      this.lastGood = this.readChecked()
      const adapter: PhysicsAdapter<BodyState[]> = {
        name: backend.id, bodyCount: this.definition.bodies.length,
        get sleepingCount() { return 0 },
        step: (dt, tick) => this.tick(dt, tick), capture: () => this.snapshot(),
        interpolate: (a, b, t) => b.map((s, n) => {
          const p = a[n] ?? s, dot = p.rotation.x * s.rotation.x + p.rotation.y * s.rotation.y + p.rotation.z * s.rotation.z + p.rotation.w * s.rotation.w
          const sign = dot < 0 ? -1 : 1
          return { ...copyState(s), position: add(p.position, scale(sub(s.position, p.position), t)),
            rotation: quaternion({ x: p.rotation.x * (1 - t) + s.rotation.x * sign * t, y: p.rotation.y * (1 - t) + s.rotation.y * sign * t,
              z: p.rotation.z * (1 - t) + s.rotation.z * sign * t, w: p.rotation.w * (1 - t) + s.rotation.w * sign * t }) }
        }),
      }
      this.clock = new FixedWorld(adapter, { step: STEP, maxSteps: this.limits.maxSteps, maxFrame: this.limits.maxFrame, maxBodies: this.limits.maxBodies })
      this.status = 'ready'
    }).catch(error => {
      if (epoch === this.epoch && this.status !== 'disposed') {
        this.status = 'faulted'; this.fault = String(error?.message ?? error)
        try { this.releaseBackend() } catch (releaseError) { this.fault += `; disposal: ${String(releaseError)}` }
      }
      throw error
    }).finally(() => { if (epoch === this.epoch) this.pending = null })
    return this.pending
  }
  async reset(): Promise<void> {
    if (this.status === 'disposed') throw new Error('Physics session is disposed')
    if (this.advancing) throw new Error('Cannot reset during a physics tick')
    ++this.epoch; this.pending = null; this.releaseBackend(); this.commands = []; this.targets.clear()
    this.forces = { wheelLoads: {}, displacedVolumes: {}, motorTorques: {} }; this.status = 'idle'
    await this.init()
  }
  /** Input is sampled synchronously exactly once before each fixed integration step; tick is zero-based. */
  advance(seconds: number, beforeTick?: (tick: number) => void): void {
    this.ready()
    if (this.advancing) throw new Error('Recursive physics advancement is not supported')
    this.advancing = true; this.beforeTick = beforeTick
    try { this.clock!.advance(seconds) } finally { this.advancing = false; this.beforeTick = undefined }
  }
  contacts() {
    this.ready()
    if (!this.backend!.contacts) throw new Error('This backend does not support contact sampling')
    try {
      const samples = this.backend!.contacts!()
      if (samples.length > 256) throw new RangeError('Contact sample budget exceeded')
      return samples.map(c => {
        this.body(c.a); this.body(c.b)
        if (c.a === c.b || !Number.isFinite(c.distance) || !Number.isFinite(c.impulse) || c.impulse < 0)
          throw new RangeError('Invalid backend contact')
        const normalOnB = vector(c.normalOnB, 1.0001, 'contact normal')
        if (norm(normalOnB) < .9999) throw new RangeError('Invalid contact normal length')
        return { a: c.a, b: c.b, distance: c.distance, impulse: c.impulse, normalOnB,
          pointA: vector(c.pointA, this.limits.maxPosition, 'contact point'), pointB: vector(c.pointB, this.limits.maxPosition, 'contact point') }
      })
    } catch (error) { this.fail(error); throw error }
  }
  snapshot(): BodyState[] { return this.lastGood.map(copyState) }
  render(): BodyState[] { this.ready(); return this.clock!.render() }
  diagnostics() {
    return { ...(this.clock?.diagnostics() ?? { backend: 'uninitialised', bodies: this.definition.bodies.length, sleeping: 0, tick: 0, steps: 0, alpha: 0, droppedSeconds: 0, invalidFrames: 0 }),
      sleeping: this.lastGood.filter(s => s.sleeping).length, status: this.status, fault: this.fault, generation: this.epoch,
      forces: { wheelLoads: { ...this.forces.wheelLoads }, displacedVolumes: { ...this.forces.displacedVolumes }, motorTorques: { ...this.forces.motorTorques } } }
  }
  metadata() { this.ready(); return { id: this.backend!.id, version: this.backend!.version, capabilities: { ...this.backend!.capabilities, unsupported: [...this.backend!.capabilities.unsupported] }, memoryBytes: this.backend!.memoryBytes() } }
  applyForce(id: string, force: Vec3, at?: Vec3): void {
    this.ready(); const s = this.body(id)
    const f = vector(force, this.limits.maxForce, 'force'), p = at ? vector(at, this.limits.maxPosition, 'force point') : s.position
    const torque = vector(cross(sub(p, s.position), f), this.limits.maxTorque, 'force lever torque')
    this.enqueue(id, f, torque)
  }
  applyTorque(id: string, torque: Vec3): void { this.ready(); this.body(id); this.enqueue(id, ZERO, vector(torque, this.limits.maxTorque, 'torque')) }
  setMotorTarget(id: string, target: Quat): Quat {
    return this.setMotorTargets({ [id]: target })[id]
  }
  /** Atomic validation; updating controls must not snap the render interpolation clock. */
  setMotorTargets(targets: Readonly<Record<string, Quat>>): Record<string, Quat> {
    this.ready()
    if (!targets || Object.keys(targets).length > this.definition.joints.length) throw new RangeError('Invalid motor target batch')
    const entries = Object.entries(targets).map(([id, target]) => {
      const joint = this.definition.joints.find(j => j.id === id)
      if (!joint) throw new RangeError('Unknown motor identifier')
      return { joint, target: clampCone(quaternion(target), joint.cone) }
    })
    try {
      // Wake the connected articulation, including low-mass distal links, without changing state snapshots.
      const island = new Set(entries.flatMap(e => [e.joint.child, e.joint.parent]))
      for (let n = 0; n < this.definition.joints.length; n++) for (const j of this.definition.joints)
        if (island.has(j.parent) || island.has(j.child)) { island.add(j.parent); island.add(j.child) }
      for (const id of island) this.backend!.sleep(id, false)
      for (const e of entries) this.targets.set(e.joint.id, e.target)
      return Object.fromEntries(entries.map(e => [e.joint.id, { ...e.target }]))
    } catch (error) { this.fail(error); throw error }
  }
  sleep(id: string): void { this.setSleep(id, true) }
  wake(id: string): void { this.setSleep(id, false) }
  dispose(): void { if (this.advancing) throw new Error('Cannot dispose during a physics tick'); if (this.status === 'disposed') return; ++this.epoch; this.status = 'disposed'; this.pending = null; this.commands = []; this.releaseBackend() }
  private ready() { if (this.status !== 'ready' || !this.backend) throw new Error(`Physics session is ${this.status}`) }
  private body(id: string): BodyState {
    const b = this.lastGood.find(b => b.id === id)
    if (!b) throw new RangeError('Unknown body identifier')
    return b
  }
  private enqueue(id: string, force: Vec3, torque: Vec3) {
    if (this.commands.length + this.internalForces >= this.limits.maxForces) throw new RangeError('External force budget exceeded')
    this.commands.push({ id, force: { ...force }, torque: { ...torque } })
  }
  private setSleep(id: string, sleeping: boolean) {
    this.ready(); this.body(id)
    const island = new Set([id])
    for (let n = 0; n < this.definition.joints.length; n++) for (const j of this.definition.joints)
      if (island.has(j.parent) || island.has(j.child)) { island.add(j.parent); island.add(j.child) }
    try {
      for (const key of island) this.backend!.sleep(key, sleeping)
      this.lastGood = this.readChecked(); this.clock!.snap()
    } catch (error) { this.fail(error); throw error }
  }
  private tick(dt: number, tick: number) {
    try {
      this.beforeTick?.(tick)
      const out = new Map<string, Wrench>(), backend = this.backend!
      for (const c of this.commands) { backend.sleep(c.id, false); accumulate(out, c.id, c.force, c.torque) }
      this.commands = []
      this.forces = actuatorForces(this.definition, backend, this.targets, this.limits, out)
      for (const [id, w] of out) {
        const b = this.definition.bodies.find(b => b.id === id)!
        if (b.fixed) continue
        // Combined per-body wrench bounds, in addition to count limits on external/internal work.
        const force = scale(w.force, Math.min(1, this.limits.maxForce / Math.max(norm(w.force), 1e-30)))
        const torque = scale(w.torque, Math.min(1, this.limits.maxTorque / Math.max(norm(w.torque), 1e-30)))
        backend.force(id, force, backend.read(id).position); backend.torque(id, torque)
      }
      backend.step(dt)
      this.lastGood = this.readChecked()
    } catch (error) { this.fail(error); throw error }
  }
  private readChecked(): BodyState[] {
    return this.definition.bodies.map(b => {
      const s = this.backend!.read(b.id)
      if (s.id !== b.id || typeof s.sleeping !== 'boolean') throw new Error('Invalid backend state identity')
      return { id: b.id, sleeping: s.sleeping, position: vector(s.position, this.limits.maxPosition, 'backend position'), rotation: quaternion(s.rotation),
        velocity: vector(s.velocity, this.limits.maxSpeed, 'backend velocity'), angularVelocity: vector(s.angularVelocity, this.limits.maxAngularSpeed, 'backend angular velocity') }
    })
  }
  private fail(error: unknown) { this.status = 'faulted'; this.fault = error instanceof Error ? error.message : String(error); this.commands = [] }
  private releaseBackend() {
    this.clock?.dispose(); this.clock = null
    const backend = this.backend; this.backend = null
    backend?.dispose()
  }
}
