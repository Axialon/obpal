/** Sphere contacts on authored channels, integrated by the engine-neutral fixed clock. */
import type { Marble } from '../devices/marblerun'
import type { PhysicsAdapter } from './world'
import { advanceStart, releaseTime, type MarbleStart } from '../devices/marblerun.start'

export const CUP = { x: -1.16, inner: .16, outer: .21, stiffness: 16 }
/** A shallow concave floor with a rounded lip. The same profile supplies mesh height and gravity. */
export function cupSurface(x: number, z: number) {
  const dx = x - CUP.x, r = Math.hypot(dx, z), k = CUP.stiffness / 9.81
  let height = 0, slope = 0
  if (r <= CUP.inner) { height = .5 * k * r * r; slope = k * r }
  else if (r < CUP.outer - 1e-12) {
    const width = CUP.outer - CUP.inner, t = (r - CUP.inner) / width
    const y = .5 * k * CUP.inner ** 2, d = k * CUP.inner * width
    height = (2 * t ** 3 - 3 * t ** 2 + 1) * y + (t ** 3 - 2 * t ** 2 + t) * d
    slope = ((6 * t * t - 6 * t) * y + (3 * t * t - 4 * t + 1) * d) / width
  }
  return { height, gx: r ? slope * dx / r : 0, gz: r ? slope * z / r : 0 }
}
interface Board extends Marble { marbles: Marble[]; tiltX: number; tiltZ: number; start: MarbleStart }
export interface MarblePose { x: number; z: number; radius: number; rollX: number; rollZ: number }
export interface BoardPose { tiltX: number; tiltZ: number; marbles: MarblePose[] }
export interface MarbleContact { board: number; source: string; a: Marble; b?: Marble; speed: number }

/** Restitution falls continuously with closing speed, avoiding small bounces in a resting queue. */
export function collideMarbles(a: Marble, b: Marble, nx: number, nz: number) {
  const speed = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz
  if (speed <= 0) return 0
  const restitution = .78 * Math.min(1, speed / .06)
  const impulse = (1 + restitution) * speed / (1 / a.mass + 1 / b.mass)
  a.vx -= impulse * nx / a.mass; a.vz -= impulse * nz / a.mass
  b.vx += impulse * nx / b.mass; b.vz += impulse * nz / b.mass
  return speed
}

export class MarblerunAdapter implements PhysicsAdapter<BoardPose[]> {
  readonly name = 'analytic-marblerun'
  private clock = 0
  private pairs = new Set<string>()
  private hits = new Map<string, number>()
  constructor(private readonly boards: Board[], private readonly inside: (n: number, x: number, z: number, radius: number) => boolean,
    private readonly contact: (event: MarbleContact) => void, private readonly afterStep: (dt: number) => void) {}
  get bodyCount() { return this.boards.reduce((n, u) => n + 1 + u.marbles.length, 0) }
  get sleepingCount() { return this.boards.reduce((n, u) => n + [u, ...u.marbles].filter(m => m.vx === 0 && m.vz === 0 && m.spinX === 0 && m.spinZ === 0).length, 0) }
  reset(n: number) {
    for (const key of this.pairs) if (key.startsWith(`${n}:`)) this.pairs.delete(key)
    for (const key of this.hits.keys()) if (key.startsWith(`${n}:`)) this.hits.delete(key)
  }
  private hit(board: number, source: string, a: Marble, speed: number, b?: Marble) {
    const key = `${board}:${source}`
    if (speed > (b ? .12 : .15) && this.clock - (this.hits.get(key) ?? -Infinity) > .09) {
      this.hits.set(key, this.clock); this.contact({ board, source, a, b, speed })
    }
  }
  step(dt: number) {
    this.boards.forEach((u, n) => {
      const bodies = [u, ...u.marbles]
      const starting = u.start.phase === 'feeding' || u.start.phase === 'settling'
      // Sleep a settled cup as a contact island. An impulse or tilt wakes it immediately.
      if (!starting && !u.tiltX && !u.tiltZ && bodies.every(m => !m.vx && !m.vz && !m.spinX && !m.spinZ)) return
      // A sphere travels at most a fraction of its radius between contact tests, including fast test inputs.
      const speed = Math.max(...bodies.map(m => Math.hypot(m.vx, m.vz)))
      const count = Math.max(1, Math.min(128, Math.ceil(speed * dt / (Math.min(...bodies.map(m => m.radius)) * .35))))
      const h = dt / count
      for (let s = 0; s < count; s++) {
        for (const m of bodies) {
          if (starting && u.start.elapsed < releaseTime(m.id)) continue
          const surface = cupSurface(m.x, m.z), v = Math.hypot(m.vx, m.vz)
          const inCup = Math.hypot(m.x - CUP.x, m.z) < CUP.inner
          const damping = Math.exp(-(.75 + .8 * Math.exp(-((v / .06) ** 2)) + .16 * v + (starting && inCup ? 8 : 0)) * h / 2)
          m.vx *= damping; m.vz *= damping; m.spinX *= damping; m.spinZ *= damping
          m.vx += (u.tiltX * 3 - 9.81 * surface.gx) * h / 2
          m.vz += (u.tiltZ * 3 - 9.81 * surface.gz) * h / 2
          if (starting && !inCup) m.vx -= 6 * h
          m.normalForce = m.mass * 9.81 * Math.cos(Math.hypot(u.tiltX, u.tiltZ) * .08)
          for (const axis of ['x', 'z'] as const) {
            const velocity = axis === 'x' ? m.vx : m.vz, travel = velocity * h
            const accepted = (t: number) => this.inside(n, m.x + (axis === 'x' ? travel * t : 0), m.z + (axis === 'z' ? travel * t : 0), m.radius)
            let t = 1
            if (!accepted(1)) {
              let low = 0, high = 1
              for (let j = 0; j < 20; j++) { const mid = (low + high) / 2; if (accepted(mid)) low = mid; else high = mid }
              t = low
              const restitution = .78 * Math.min(1, Math.abs(velocity) / .06)
              if (axis === 'x') m.vx = -velocity * restitution; else m.vz = -velocity * restitution
              m.normalForce += m.mass * Math.abs(velocity) * (1 + restitution) / h
              this.hit(n, `rail:${m.id}:${axis}`, m, Math.abs(velocity))
            }
            if (axis === 'x') m.x += travel * t; else m.z += travel * t
          }
          const next = cupSurface(m.x, m.z)
          m.vx += (u.tiltX * 3 - 9.81 * next.gx) * h / 2
          m.vz += (u.tiltZ * 3 - 9.81 * next.gz) * h / 2
          // Solid-sphere inertia divides friction between translation and surface spin; slip loses energy.
          const friction = 1 - Math.exp(-5 * h)
          for (const [velocity, spin] of [['vx', 'spinX'], ['vz', 'spinZ']] as const) {
            const slip = (m[velocity] - m[spin]) * friction
            m[velocity] -= 2 / 7 * slip; m[spin] += 5 / 7 * slip
            m[velocity] *= damping; m[spin] *= damping
          }
        }
        for (let a = 0; a < bodies.length; a++) for (let b = a + 1; b < bodies.length; b++) {
          const p = bodies[a], q = bodies[b], dx = q.x - p.x, dz = q.z - p.z, distance = Math.hypot(dx, dz), radius = p.radius + q.radius
          if (starting && (u.start.elapsed < releaseTime(p.id) || u.start.elapsed < releaseTime(q.id))) continue
          const source = `pair:${p.id}:${q.id}`, key = `${n}:${source}`
          if (distance > radius + .012) { this.pairs.delete(key); continue }
          if (distance > radius) continue
          const nx = distance > 1e-8 ? dx / distance : 1, nz = distance > 1e-8 ? dz / distance : 0
          const closing = collideMarbles(p, q, nx, nz)
          if (closing && !this.pairs.has(key)) this.hit(n, source, p, closing, q)
          this.pairs.add(key)
          const overlap = Math.max(0, radius - distance)
          for (const [m, sign, fraction] of [[p, -1, q.mass / (p.mass + q.mass)], [q, 1, p.mass / (p.mass + q.mass)]] as const) {
            const x = m.x + sign * nx * overlap * fraction, z = m.z + sign * nz * overlap * fraction
            if (this.inside(n, x, z, m.radius)) { m.x = x; m.z = z }
            m.normalForce += m.mass * closing / h
          }
        }
        for (const m of bodies) {
          m.slip = Math.hypot(m.vx - m.spinX, m.vz - m.spinZ)
          m.rollX += m.spinZ / m.radius * h; m.rollZ -= m.spinX / m.radius * h
        }
      }
      const resting = bodies.every(m => Math.hypot(m.x - CUP.x, m.z) < CUP.inner && Math.hypot(m.vx, m.vz, m.spinX, m.spinZ) < .012)
      advanceStart(u.start, dt, resting && Math.hypot(u.tiltX, u.tiltZ) < .001)
      if (starting && u.start.phase === 'settled') bodies.forEach(m => { m.vx = m.vz = m.spinX = m.spinZ = m.slip = 0 })
    })
    this.clock += dt; this.afterStep(dt)
  }
  capture(): BoardPose[] {
    return this.boards.map(u => ({ tiltX: u.tiltX, tiltZ: u.tiltZ,
      marbles: [u, ...u.marbles].map(m => ({ x: m.x, z: m.z, radius: m.radius, rollX: m.rollX, rollZ: m.rollZ })) }))
  }
  interpolate(previous: BoardPose[], current: BoardPose[], alpha: number): BoardPose[] {
    const mix = (a: number, b: number) => a + (b - a) * alpha
    return current.map((u, n) => ({ tiltX: mix(previous[n].tiltX, u.tiltX), tiltZ: mix(previous[n].tiltZ, u.tiltZ), marbles: u.marbles.map((m, j) => {
      const p = previous[n].marbles[j] ?? m
      return { x: mix(p.x, m.x), z: mix(p.z, m.z), radius: m.radius, rollX: mix(p.rollX, m.rollX), rollZ: mix(p.rollZ, m.rollZ) }
    }) }))
  }
}
