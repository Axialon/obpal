/** Engine-neutral clock. Only simulations which construct a world opt in. */
export interface PhysicsAdapter<S> {
  readonly name: string
  readonly bodyCount: number
  readonly sleepingCount: number
  /** A fixed step in seconds. Do not read wall time or input queues here. */
  step(dt: number, tick: number): void
  /** Return an owned snapshot, not live engine storage. */
  capture(): S
  /** Return render-only state. Never write it back into the engine. */
  interpolate(previous: S, current: S, alpha: number): S
  dispose?(): void
}

export interface PhysicsBudget {
  step: number
  maxSteps: number
  maxFrame: number
  maxBodies: number
}
export interface PhysicsDiagnostics {
  backend: string
  bodies: number
  sleeping: number
  tick: number
  steps: number
  alpha: number
  droppedSeconds: number
  invalidFrames: number
}
const DEFAULTS: Readonly<PhysicsBudget> = Object.freeze({ step: 1 / 240, maxSteps: 12, maxFrame: .05, maxBodies: 64 })

/** Count budgets, rather than CPU deadlines, keep identical tick streams repeatable. */
export class FixedWorld<S> {
  readonly budget: Readonly<PhysicsBudget>
  private previous: S
  private current: S
  private remainder = 0
  private tick = 0
  private steps = 0
  private dropped = 0
  private invalid = 0
  private disposed = false

  constructor(private readonly adapter: PhysicsAdapter<S>, budget: Partial<PhysicsBudget> = {}) {
    const b = { ...DEFAULTS, ...budget }
    if (!Number.isFinite(b.step) || b.step <= 0 || b.step > .05 ||
        !Number.isFinite(b.maxFrame) || b.maxFrame < b.step || b.maxFrame > 1 ||
        !Number.isInteger(b.maxSteps) || b.maxSteps < 1 || b.maxSteps > 240 ||
        !Number.isInteger(b.maxBodies) || b.maxBodies < 1 || b.maxBodies > 10000) throw new RangeError('Invalid physics budget')
    this.budget = Object.freeze(b)
    this.checkBodies()
    this.previous = adapter.capture(); this.current = adapter.capture()
  }

  advance(seconds: number): void {
    this.alive(); this.checkBodies(); this.steps = 0
    if (!Number.isFinite(seconds) || seconds < 0) { this.invalid++; return }
    const accepted = Math.min(seconds, this.budget.maxFrame)
    this.dropped += seconds - accepted
    this.remainder += accepted
    // The tolerance is far smaller than a tick; it only repairs floating-point summation at boundaries.
    const due = Math.floor(this.remainder / this.budget.step + 1e-10)
    const count = Math.min(due, this.budget.maxSteps)
    for (let i = 0; i < count; i++) {
      this.previous = this.current
      this.adapter.step(this.budget.step, this.tick)
      this.current = this.adapter.capture(); this.tick++; this.steps++
    }
    this.remainder = Math.max(0, this.remainder - due * this.budget.step)
    this.dropped += (due - count) * this.budget.step
  }

  /** One fixed tick of visual latency, with no extrapolation through contacts. */
  render(): S {
    this.alive()
    return this.adapter.interpolate(this.previous, this.current, this.alpha)
  }

  /** A deliberate teleport (Home) has no visual sweep from the old location. Keep the shared clock. */
  snap(): void { this.alive(); this.previous = this.adapter.capture(); this.current = this.adapter.capture() }

  diagnostics(): PhysicsDiagnostics {
    return { backend: this.adapter.name, bodies: this.adapter.bodyCount, sleeping: this.adapter.sleepingCount,
      tick: this.tick, steps: this.steps, alpha: this.alpha, droppedSeconds: this.dropped, invalidFrames: this.invalid }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.adapter.dispose?.()
  }

  private get alpha() { return Math.min(1, this.remainder / this.budget.step) }
  private alive() { if (this.disposed) throw new Error('Physics world is disposed') }
  private checkBodies() {
    if (!Number.isInteger(this.adapter.bodyCount) || this.adapter.bodyCount < 0 || this.adapter.bodyCount > this.budget.maxBodies)
      throw new RangeError('Physics body budget exceeded')
  }
}
