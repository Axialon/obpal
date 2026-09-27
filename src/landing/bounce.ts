/**
 * The hero's bounce field as physics: glass marbles that roll and bounce on a floor and on raised letters. Pure (no
 * three.js), unit-tested in node. Units are the letters' em: the floor is the x-z plane, y is up. A letter is a
 * footprint (outline polygons with holes, from its glyph) raised to a height; a marble has a position, a velocity and
 * a radius, and some weight: it never bounces by itself.
 *
 * - Steered, it rolls after its target on a damped spring; in the air it mostly keeps its momentum.
 * - Tossed (a phone flicked upward, a click), it leaves the surface at that speed. A toss that comes while it's still
 *   in the air waits a moment for it to touch down, the way a tray can only throw a ball that's on it.
 * - Given a route, it hops from spot to spot back to back: each hop leaves with exactly the sideways speed that
 *   lands it on the next spot, and it stops dead there (no sliding on past it).
 * - Left alone, each bounce is lower than the last and the surface's grip takes some of its sideways speed, until it
 *   rests; then nothing moves and nothing needs drawing.
 * - It lands on a letter where it comes down over one, bumps off a letter's side where it runs into one, and two
 *   marbles knock into each other.
 * - A low step (a button, raised less than StepOptions.climb) has a rounded top edge instead of a wall: a marble
 *   rolling into it fast enough rides up over the edge onto it, a slower one rolls back, and one steered onto it
 *   (someone pointing at the button) is helped up, as a hand would. Rolling off its edge, it tips over and drops.
 */

export interface Footprint {
  id: number
  /** How tall the letter stands. */
  height: number
  /** Bounding box: minX, minZ, maxX, maxZ. */
  box: [number, number, number, number]
  /** Closed outlines, each as x0, z0, x1, z1, … (outer outlines and holes alike: inside is even-odd). */
  rings: Float64Array[]
  /** The best spot to land: deepest inside the letter, away from its edges and holes. */
  spot: [number, number]
}

export interface Orb {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  r: number
  /** Where it's steered to (null: nowhere). */
  target: { x: number; z: number } | null
  /** Spots to hop to, one per bounce, back to back (the choreography's precise hops). */
  route: { x: number; z: number }[]
  /** In the air on a precise hop: no steering, and it stops dead where it lands. */
  flying: boolean
  /** Where the precise hop in the air is headed. */
  aim?: { x: number; z: number } | null
  /** A toss waiting for it to touch down: the speed it leaves at, and how much longer it waits (s). */
  toss: { vy: number; ttl: number } | null
  /** At rest on a surface: no motion at all. */
  resting: boolean
}

export interface StepOptions {
  /** Hop height while active. */
  hop: number
  /** Field bounds: minX, minZ, maxX, maxZ. */
  bounds: [number, number, number, number]
  /**
   * Where the field's sides are, when it narrows toward the viewer (a camera looking down at a slant sees a wedge of
   * floor, wider far off than near): x of its left and right sides at its far edge (minZ), then at its near edge
   * (maxZ). They run straight in between. Without it, the sides are the bounds'.
   */
  sides?: [number, number, number, number]
  /** Steering spring (rad/s) and damping ratio. */
  omega?: number
  zeta?: number
  /** Extra sideways acceleration (a tilted phone, like a marble on a tray). */
  push?: [number, number]
  /** How much of the steering still acts while it's in the air (0: none, it flies on its momentum; 1: all). */
  air?: number
  /** Footprints this low or lower are steps with a rounded top edge a marble can roll over (0, the default: none). */
  climb?: number
}

/** Gravity, em/s². */
export const G = 18
/** How much of its speed a bounce keeps (glass on a hard surface), and the speed below which it rests. */
const SETTLE = 0.55
const REST_VY = 0.9
/** Side bumps keep this much of the speed into the letter; two marbles, this much of the speed between them. */
const BUMP = 0.55
const CLINK = 0.9
/** Rolling slows by this factor per second when nothing steers it. */
const FRICTION = 1.8
/** A real bounce keeps this much of its sideways speed (the surface's grip). */
const GRIP = 0.6
const MAX_SPEED = 14
/** How long a toss waits for a marble in the air to come down (s). */
const TOSS_WAIT = 0.25
/** Running into a side slower than this (em/s) is leaning on it, not a bump. */
const LEAN = 0.3

export function newOrb(x: number, z: number, r: number, surface = 0): Orb {
  return { x, y: surface + r, z, vx: 0, vy: 0, vz: 0, r, target: null, route: [], flying: false, toss: null, resting: true }
}

/**
 * Toss it up at `vy` (em/s): now if it's on a surface, else as soon as it touches down (within TOSS_WAIT). The player
 * takes over from any choreography. Returns whether it left now.
 */
export function toss(o: Orb, vy: number, fps: readonly Footprint[]): boolean {
  o.route = []
  o.flying = false
  o.aim = null
  o.resting = false
  if (o.y - o.r - surfaceAt(fps, o.x, o.z).h < 0.02 && o.vy <= 0.5) {
    o.vy = Math.max(o.vy, vy)
    o.toss = null
    return true
  }
  o.toss = { vy, ttl: TOSS_WAIT }
  return false
}

/** A precise hop to a spot: it leaves as soon as it's on a surface and lands exactly there. */
export function hopTo(o: Orb, spot: { x: number; z: number }) {
  o.route = [spot]
  o.toss = null
  o.resting = false
}

/**
 * Two marbles that meet knock into each other (they weigh the same): pushed apart, and the speed between them bounces
 * back, most of it (glass on glass). Returns how hard they met (em/s), 0 if they didn't.
 */
export function collide(a: Orb, b: Orb): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
  const d = Math.hypot(dx, dy, dz), min = a.r + b.r
  if (d >= min || d < 1e-9) return 0
  const nx = dx / d, ny = dy / d, nz = dz / d
  const apart = (min - d) / 2
  a.x -= nx * apart; a.y -= ny * apart; a.z -= nz * apart
  b.x += nx * apart; b.y += ny * apart; b.z += nz * apart
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny + (b.vz - a.vz) * nz
  for (const o of [a, b]) o.resting = false
  if (vn >= 0) return 0
  const j = (-(1 + CLINK) * vn) / 2
  a.vx -= j * nx; a.vy -= j * ny; a.vz -= j * nz
  b.vx += j * nx; b.vy += j * ny; b.vz += j * nz
  // Knocked off course: any route is off.
  for (const o of [a, b]) if (o.flying) { o.flying = false; o.aim = null; o.route = [] }
  return -vn
}

/** Even-odd: is (x, z) inside the letter (not in a hole)? */
export function inside(fp: Footprint, x: number, z: number): boolean {
  if (x < fp.box[0] || x > fp.box[2] || z < fp.box[1] || z > fp.box[3]) return false
  let c = false
  for (const ring of fp.rings) {
    const n = ring.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1]
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
    }
  }
  return c
}

/** The nearest point of the letter's outline to (x, z): distance and the unit direction from it to (x, z). */
export function nearest(fp: Footprint, x: number, z: number): { d: number; nx: number; nz: number } {
  let best = Infinity, bx = x, bz = z
  for (const ring of fp.rings) {
    const n = ring.length / 2
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = ring[j * 2], az = ring[j * 2 + 1], ex = ring[i * 2] - ax, ez = ring[i * 2 + 1] - az
      const l2 = ex * ex + ez * ez || 1e-12
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2))
      const px = ax + ex * t, pz = az + ez * t
      const d2 = (x - px) ** 2 + (z - pz) ** 2
      if (d2 < best) { best = d2; bx = px; bz = pz }
    }
  }
  const d = Math.sqrt(best)
  return d > 1e-9 ? { d, nx: (x - bx) / d, nz: (z - bz) / d } : { d: 0, nx: 0, nz: -1 }
}

/** The surface under (x, z): the tallest letter there, else the floor (id -1). */
export function surfaceAt(fps: readonly Footprint[], x: number, z: number): { h: number; id: number } {
  let h = 0, id = -1
  for (const fp of fps) if (fp.height > h && inside(fp, x, z)) { h = fp.height; id = fp.id }
  return { h, id }
}

/**
 * A rounded rectangle's outline (a button's, in screen pixels) as points x0, y0, x1, y1, …, clockwise on screen from
 * its top-left corner's arc: `n` points on each corner's quarter circle (the radius is held to half the short side).
 */
export function roundedRect(x: number, y: number, w: number, h: number, r: number, n = 5): number[] {
  const k = Math.max(0, Math.min(r, w / 2, h / 2))
  const corners: [number, number, number][] = [[x + k, y + k, Math.PI], [x + w - k, y + k, Math.PI * 1.5], [x + w - k, y + h - k, 0], [x + k, y + h - k, Math.PI / 2]]
  const out: number[] = []
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i < n; i++) {
      const a = a0 + (Math.PI / 2) * (n > 1 ? i / (n - 1) : 0.5)
      out.push(cx + Math.cos(a) * k, cy + Math.sin(a) * k)
    }
  }
  return out
}

/** The spot deepest inside a letter (the centre of its widest part), found on a grid over its box. */
export function landingSpot(rings: Float64Array[], box: [number, number, number, number]): [number, number] {
  const fp: Footprint = { id: 0, height: 1, box, rings, spot: [0, 0] }
  let best = -1, sx = (box[0] + box[2]) / 2, sz = (box[1] + box[3]) / 2
  const steps = 24
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = box[0] + ((box[2] - box[0]) * i) / steps, z = box[1] + ((box[3] - box[1]) * j) / steps
      if (!inside(fp, x, z)) continue
      const d = nearest(fp, x, z).d
      if (d > best) { best = d; sx = x; sz = z }
    }
  }
  return [sx, sz]
}

export interface StepResult {
  /** It came down on something this step (a real landing, not rolling along it): a letter's id, or -1 for the floor. */
  landed: number | null
  /** It ran into a letter's side this step (that letter's id). */
  bumped: number | null
  /** How hard the hardest of those was: its speed into the surface, em/s (0 if none). */
  impact: number
  /** Anything moved. */
  moving: boolean
}

/** Advance one orb by dt seconds among the letters. */
export function step(o: Orb, fps: readonly Footprint[], dt: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, impact: 0, moving: false }
  if (o.resting && !o.target && !o.route.length && !o.toss && !opts.push) return res
  dt = Math.min(dt, 1 / 30)
  if (o.toss && (o.toss.ttl -= dt) <= 0) o.toss = null
  // Small substeps keep a fast orb from passing through a letter's side.
  const n = Math.max(1, Math.ceil((Math.hypot(o.vx, o.vz) * dt) / (o.r * 0.5)))
  const h = dt / n
  for (let s = 0; s < n; s++) {
    const r = sub(o, fps, h, opts)
    if (r.landed !== null) res.landed = r.landed
    if (r.bumped !== null) res.bumped = r.bumped
    res.impact = Math.max(res.impact, r.impact)
  }
  res.moving = !o.resting
  return res
}

function sub(o: Orb, fps: readonly Footprint[], h: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, impact: 0, moving: false }
  const base = surfaceAt(fps, o.x, o.z)
  const climb = opts.climb ?? 0
  // On the ground, or on a low step's edge (rolling up onto it, or off it): steering and rolling friction hold there.
  const grounded = (o.y - o.r <= base.h + 1e-3 && o.vy <= 0) || (climb > 0 && onEdge(o, fps, climb))

  // Sideways: steered (a spring that doesn't overshoot; in the air, only as much as `air`), carried through a precise
  // hop, pushed by a tilt, or rolling to a stop.
  if (!o.flying) {
    const w = opts.omega ?? 7, zeta = opts.zeta ?? 0.9
    if (o.target) {
      const k = grounded ? 1 : opts.air ?? 1
      o.vx += k * (w * w * (o.target.x - o.x) - 2 * zeta * w * o.vx) * h
      o.vz += k * (w * w * (o.target.z - o.z) - 2 * zeta * w * o.vz) * h
    } else if (grounded) {
      const k = Math.exp(-FRICTION * h)
      o.vx *= k; o.vz *= k
    }
  }
  if (opts.push) { o.vx += opts.push[0] * h; o.vz += opts.push[1] * h }
  const sp = Math.hypot(o.vx, o.vz)
  if (sp > MAX_SPEED) { o.vx *= MAX_SPEED / sp; o.vz *= MAX_SPEED / sp }

  // Up and down. (Where it was a moment ago tells a landing on a letter's top from running into its side.)
  const wasBottom = o.y - o.r
  o.vy -= G * h
  o.x += o.vx * h
  o.z += o.vz * h
  o.y += o.vy * h

  // The field's edges: far and near, then the sides where it is.
  const [, z0, , z1] = opts.bounds
  if (o.z < z0 + o.r) { o.z = z0 + o.r; o.vz = Math.abs(o.vz) * BUMP }
  if (o.z > z1 - o.r) { o.z = z1 - o.r; o.vz = -Math.abs(o.vz) * BUMP }
  const [x0, x1] = sidesAt(opts, o.z)
  if (o.x < x0 + o.r) { o.x = x0 + o.r; o.vx = Math.abs(o.vx) * BUMP }
  if (o.x > x1 - o.r) { o.x = x1 - o.r; o.vx = -Math.abs(o.vx) * BUMP }

  // Letters' sides: an orb lower than a letter's top that touches its outline is pushed back out and bounces off. (A
  // precise hop on its way up is clear of them: it left from beside one and is over it a moment later.) A low step
  // has a rounded edge instead.
  for (const fp of fps) {
    if (o.flying && o.vy > 0) break
    const b = fp.box
    if (o.x < b[0] - o.r || o.x > b[2] + o.r || o.z < b[1] - o.r || o.z > b[3] + o.r) continue
    if (fp.height <= climb) { edge(o, fp, res); continue }
    if (o.y - o.r >= fp.height - 0.01 || wasBottom >= fp.height - 0.01) continue
    const inLetter = inside(fp, o.x, o.z)
    const e = nearest(fp, o.x, o.z)
    if (!inLetter && e.d >= o.r) continue
    // Out of the letter, along the way it came in.
    const nx = inLetter ? -e.nx : e.nx, nz = inLetter ? -e.nz : e.nz
    const push = inLetter ? e.d + o.r : o.r - e.d
    o.x += nx * push
    o.z += nz * push
    const vn = o.vx * nx + o.vz * nz
    if (vn < 0) { o.vx -= (1 + BUMP) * vn * nx; o.vz -= (1 + BUMP) * vn * nz }
    // Knocked off course: the route is off.
    if (o.flying) { o.flying = false; o.aim = null; o.route = [] }
    if (vn < -LEAN) { res.bumped = fp.id; res.impact = Math.max(res.impact, -vn) }
  }

  // Coming down on the surface under it: bounce (or settle).
  const under = surfaceAt(fps, o.x, o.z)
  if (o.y - o.r <= under.h && o.vy < 0) {
    const vin = -o.vy
    o.y = under.h + o.r
    // Rolling along a surface touches it every step; only coming down on it is a landing.
    if (vin > REST_VY * 0.5 || o.flying) { res.landed = under.id; res.impact = Math.max(res.impact, vin) }
    // Arriving from a precise hop: it's there, exactly (not wherever the step's end happened to be). Stop dead.
    if (o.flying) {
      if (o.aim) { o.x = o.aim.x; o.z = o.aim.z; o.y = surfaceAt(fps, o.x, o.z).h + o.r }
      o.vx = o.vz = 0
      o.flying = false
      o.aim = null
    }
    const next = o.route.shift()
    if (next) {
      // A precise hop: the sideways speed that lands it on the spot as it comes back down (to the spot's surface).
      o.vy = Math.sqrt(2 * G * opts.hop)
      o.resting = false
      const t = flightTime(o.vy, o.y - o.r, surfaceAt(fps, next.x, next.z).h)
      o.vx = (next.x - o.x) / t
      o.vz = (next.z - o.z) / t
      o.flying = true
      o.aim = next
    } else if (o.toss) {
      // The toss that was waiting for it.
      o.vy = Math.max(o.toss.vy, vin * SETTLE)
      o.toss = null
      o.resting = false
    } else {
      // A real bounce (not just resting contact) loses some of its sideways speed to the surface's grip.
      if (vin > REST_VY) { o.vx *= GRIP; o.vz *= GRIP }
      o.vy = vin * SETTLE
      if (o.vy < REST_VY) {
        o.vy = 0
        const pushed = !!opts.push && Math.hypot(opts.push[0], opts.push[1]) > 1e-3
        if (!o.target && !pushed && Math.hypot(o.vx, o.vz) < 0.05) { o.vx = o.vz = 0; o.resting = true }
      } else o.resting = false
    }
  } else if (o.vy !== 0 || Math.hypot(o.vx, o.vz) > 0.001) o.resting = false
  return res
}

/**
 * A low step's rounded top edge, for a marble beside it (over it, its top is simply the surface). Steered onto the
 * step, the edge is a ramp: the marble rides up it at the edge's height under it, as a hand would lift it. Otherwise
 * it rolls on the edge: pushed out along the line from the edge to its centre, and it loses its speed into the edge;
 * fast enough, what's left carries it up and over, else gravity rolls it back. Off the step's side, it tips over the
 * edge the same way.
 */
function edge(o: Orb, fp: Footprint, res: StepResult) {
  if (inside(fp, o.x, o.z)) return
  const e = nearest(fp, o.x, o.z)
  if (e.d >= o.r) return
  const up = o.y - fp.height
  const dist = Math.hypot(e.d, up)
  if (dist >= o.r) return
  if (o.target && inside(fp, o.target.x, o.target.z)) {
    o.y = fp.height + Math.sqrt(o.r * o.r - e.d * e.d)
    if (o.vy < 0) o.vy = 0
    return
  }
  const nx = dist > 1e-9 ? (e.nx * e.d) / dist : 0, ny = dist > 1e-9 ? up / dist : 1, nz = dist > 1e-9 ? (e.nz * e.d) / dist : 0
  const push = o.r - dist
  o.x += nx * push
  o.y += ny * push
  o.z += nz * push
  const vn = o.vx * nx + o.vy * ny + o.vz * nz
  if (vn < 0) { o.vx -= vn * nx; o.vy -= vn * ny; o.vz -= vn * nz }
  if (o.flying) { o.flying = false; o.aim = null; o.route = [] }
  if (vn < -LEAN) { res.bumped = fp.id; res.impact = Math.max(res.impact, -vn) }
}

/** Is the marble touching a low step's edge (beside the step, resting on or rolling over its rounded top edge)? */
function onEdge(o: Orb, fps: readonly Footprint[], climb: number): boolean {
  for (const fp of fps) {
    if (fp.height > climb) continue
    const b = fp.box
    if (o.x < b[0] - o.r || o.x > b[2] + o.r || o.z < b[1] - o.r || o.z > b[3] + o.r || inside(fp, o.x, o.z)) continue
    const e = nearest(fp, o.x, o.z)
    if (e.d < o.r && Math.hypot(e.d, o.y - fp.height) <= o.r + 1e-3) return true
  }
  return false
}

/** The field's left and right sides at depth z (StepOptions.sides, else the bounds'). */
export function sidesAt(opts: Pick<StepOptions, 'bounds' | 'sides'>, z: number): [number, number] {
  const [x0, z0, x1, z1] = opts.bounds
  const s = opts.sides
  if (!s) return [x0, x1]
  const k = Math.max(0, Math.min(1, (z - z0) / (z1 - z0 || 1)))
  return [s[0] + (s[2] - s[0]) * k, s[1] + (s[3] - s[1]) * k]
}

/** How long a hop launched upward at vy from height y0 takes to come down to height y1. */
export function flightTime(vy: number, y0: number, y1: number): number {
  // y0 + vy t - G t²/2 = y1  →  the later root.
  const d = vy * vy + 2 * G * (y0 - y1)
  return d <= 0 ? (2 * vy) / G : (vy + Math.sqrt(d)) / G
}
