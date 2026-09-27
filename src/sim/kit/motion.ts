/** Frame-rate independent motion. Seconds in, position and velocity in the caller's units. */
export class Spring {
  velocity = 0
  /** The integral of the last step, useful for spinning a motor without frame-dependent phase drift. */
  travel = 0
  constructor(public value = 0, public response = 0.14) {}

  /** Exact critically damped response to a held target, including arbitrarily long frames. */
  step(target: number, dt: number): number {
    this.travel = 0
    if (!Number.isFinite(target) || !Number.isFinite(dt) || dt <= 0) return this.value
    const w = 2 / Math.max(0.001, this.response), x = this.value - target
    const c = this.velocity + w * x, e = Math.exp(-w * dt)
    this.travel = target * dt + x * (1 - e) / w + c * (1 - e * (1 + w * dt)) / (w * w)
    this.value = target + (x + c * dt) * e
    this.velocity = (this.velocity - w * c * dt) * e
    return this.value
  }

  /** Explicit discontinuities only: a new owner, a reset or authoritative contact. */
  reset(value = 0) { this.value = value; this.velocity = this.travel = 0 }
}

/** Continuous input smoothing; actions and deadman edges must bypass it. */
export class InputSmoother {
  private channels = new Map<string, Spring>()
  sample(key: string, value: number, dt: number, initial = 0) {
    let s = this.channels.get(key)
    if (!s) { s = new Spring(initial, 0.045); this.channels.set(key, s) }
    return s.step(value, dt)
  }
  reset() { this.channels.clear() }
}

export interface ServoLimits { min: number; max: number; vmax: number; amax: number }

/** A critically damped joint with hard speed, acceleration and travel limits, before collision resolution. */
export function servo(position: number, velocity: number, target: number, dt: number, limits: ServoLimits, response = 0.2) {
  if (!Number.isFinite(dt) || dt <= 0) return { position, velocity }
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  target = clamp(target, limits.min, limits.max)
  const w = 2 / response
  // Short bounded steps keep capped acceleration consistent at 30, 60 and 120 fps. A suspended tab cannot jump.
  const count = Math.ceil(Math.min(dt, 0.05) * 240), h = Math.min(dt, 0.05) / count
  for (let i = 0; i < count; i++) {
    const a = clamp(w * w * (target - position) - 2 * w * velocity, -limits.amax, limits.amax)
    velocity = clamp(velocity + a * h, -limits.vmax, limits.vmax)
    position += velocity * h
    if (position < limits.min || position > limits.max) { position = clamp(position, limits.min, limits.max); velocity = 0 }
  }
  return { position, velocity }
}
