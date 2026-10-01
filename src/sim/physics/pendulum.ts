/** The lab's one-degree-of-freedom reference solver, not a general rigid-body engine. */
import type { PhysicsAdapter } from './world'

export interface PendulumBody { length: number; damping: number; angle: number; omega: number }
export interface PendulumPose { angle: number; length: number }
const GRAVITY = 9.81, LIMIT = 1.4, MAX_SPEED = 5
const bound = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v))

/** Mechanical energy per kilogram; parameter changes and pushes can add energy deliberately. */
export function pendulumEnergy(u: PendulumBody): number {
  return .5 * (u.length * u.omega) ** 2 + GRAVITY * u.length * (1 - Math.cos(u.angle))
}
function valid(u: PendulumBody) {
  return [u.length, u.damping, u.angle, u.omega].every(Number.isFinite) && u.length >= .55 && u.length <= 2.2 && u.damping >= 0 && u.damping <= 1.2
}

export class PendulumAdapter implements PhysicsAdapter<PendulumPose[]> {
  readonly name = 'pendulum-verlet'
  private readonly quiet: number[]
  private readonly asleep: boolean[]
  constructor(private readonly units: readonly PendulumBody[], private readonly afterStep?: (dt: number) => void) {
    this.validate(); this.quiet = units.map(() => 0); this.asleep = units.map(() => false)
  }
  get bodyCount() { return this.units.length }
  get sleepingCount() { return this.asleep.filter(Boolean).length }

  step(dt: number): void {
    this.validate()
    if (!Number.isFinite(dt) || dt <= 0 || dt > 1 / 120) throw new RangeError('Pendulum step must be in (0, 1/120] seconds')
    this.units.forEach((u, n) => {
      if (this.asleep[n] && u.angle === 0 && u.omega === 0) return
      if (this.asleep[n]) this.wake(n)
      // Split exact viscous damping around velocity Verlet. The stop is a lab constraint, not a material collision.
      const damping = Math.exp(-u.damping * dt / 2)
      u.omega = bound(u.omega, MAX_SPEED) * damping - GRAVITY / u.length * Math.sin(u.angle) * dt / 2
      u.angle += u.omega * dt
      if (Math.abs(u.angle) > LIMIT) { u.angle = bound(u.angle, LIMIT); u.omega *= -.35 }
      u.omega = bound((u.omega - GRAVITY / u.length * Math.sin(u.angle) * dt / 2) * damping, MAX_SPEED)
      this.quiet[n] = Math.abs(u.angle) + Math.abs(u.omega) < .0001 ? this.quiet[n] + dt : 0
      if (this.quiet[n] >= .25) { u.angle = u.omega = 0; this.asleep[n] = true }
    })
    this.afterStep?.(dt)
  }
  wake(n: number): void { this.quiet[n] = 0; this.asleep[n] = false }
  capture(): PendulumPose[] { return this.units.map(u => ({ angle: u.angle, length: u.length })) }
  interpolate(a: PendulumPose[], b: PendulumPose[], t: number): PendulumPose[] {
    return b.map((u, n) => ({ angle: a[n].angle + (u.angle - a[n].angle) * t, length: a[n].length + (u.length - a[n].length) * t }))
  }
  private validate() { if (!this.units.every(valid)) throw new RangeError('Invalid pendulum state') }
}
