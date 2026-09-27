/**
 * The hero's bounce field as physics: glowing orbs that bounce on a floor and on raised letters. Pure (no three.js),
 * unit-tested in node. Units are the letters' em: the floor is the x-z plane, y is up. A letter is a footprint
 * (outline polygons with holes, from its glyph) raised to a height; an orb has a position, a velocity and a radius.
 *
 * - Steered, an orb glides after its target on a damped spring and keeps hopping at a set height.
 * - Given a route, it hops from spot to spot back to back: each hop leaves with exactly the sideways speed that
 *   lands it on the next spot, and it stops dead there (no sliding on past it).
 * - Left alone, each bounce is lower than the last and loses most of its sideways speed to the surface, until it
 *   rests; then nothing moves and nothing needs drawing.
 * - It lands on a letter where it comes down over one, and bumps off a letter's side where it runs into one.
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
  /** Keeps hopping at `hop` height while true; left alone, it settles. */
  active: boolean
  /** At rest on a surface: no motion at all. */
  resting: boolean
}

export interface StepOptions {
  /** Hop height while active. */
  hop: number
  /** Field bounds: minX, minZ, maxX, maxZ. */
  bounds: [number, number, number, number]
  /** Steering spring (rad/s) and damping ratio. */
  omega?: number
  zeta?: number
  /** Extra sideways acceleration (a tilted phone, like a marble on a tray). */
  push?: [number, number]
}

/** Gravity, em/s². */
export const G = 18
/** How much of its speed a bounce keeps when nobody keeps it going, and the speed below which it rests. */
const SETTLE = 0.6
const REST_VY = 0.9
/** Side bumps keep this much of the speed into the letter. */
const BUMP = 0.55
/** Rolling slows by this factor per second once it's resting on its target or has none. */
const FRICTION = 3.2
/** A settling bounce keeps this much of its sideways speed (the surface's grip). */
const GRIP = 0.35
const MAX_SPEED = 14

export function newOrb(x: number, z: number, r: number, surface = 0): Orb {
  return { x, y: surface + r, z, vx: 0, vy: 0, vz: 0, r, target: null, route: [], flying: false, active: false, resting: true }
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
  /** It came down on something this step: a letter's id, or -1 for the floor. */
  landed: number | null
  /** It ran into a letter's side this step (that letter's id). */
  bumped: number | null
  /** Anything moved. */
  moving: boolean
}

/** Advance one orb by dt seconds among the letters. */
export function step(o: Orb, fps: readonly Footprint[], dt: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, moving: false }
  if (o.resting && !o.active && !o.target && !o.route.length && !opts.push) return res
  dt = Math.min(dt, 1 / 30)
  // Small substeps keep a fast orb from passing through a letter's side.
  const n = Math.max(1, Math.ceil((Math.hypot(o.vx, o.vz) * dt) / (o.r * 0.5)))
  const h = dt / n
  for (let s = 0; s < n; s++) {
    const r = sub(o, fps, h, opts)
    if (r.landed !== null) res.landed = r.landed
    if (r.bumped !== null) res.bumped = r.bumped
  }
  res.moving = !o.resting
  return res
}

function sub(o: Orb, fps: readonly Footprint[], h: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, moving: false }
  const base = surfaceAt(fps, o.x, o.z)
  const grounded = o.y - o.r <= base.h + 1e-4 && o.vy <= 0

  // Sideways: steered (a spring that doesn't overshoot), carried through a precise hop, pushed by a tilt, or rolling to a stop.
  if (!o.flying) {
    const w = opts.omega ?? 7, zeta = opts.zeta ?? 0.9
    if (o.target) {
      o.vx += (w * w * (o.target.x - o.x) - 2 * zeta * w * o.vx) * h
      o.vz += (w * w * (o.target.z - o.z) - 2 * zeta * w * o.vz) * h
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

  // The field's edges.
  const [x0, z0, x1, z1] = opts.bounds
  if (o.x < x0 + o.r) { o.x = x0 + o.r; o.vx = Math.abs(o.vx) * BUMP }
  if (o.x > x1 - o.r) { o.x = x1 - o.r; o.vx = -Math.abs(o.vx) * BUMP }
  if (o.z < z0 + o.r) { o.z = z0 + o.r; o.vz = Math.abs(o.vz) * BUMP }
  if (o.z > z1 - o.r) { o.z = z1 - o.r; o.vz = -Math.abs(o.vz) * BUMP }

  // Letters' sides: an orb lower than a letter's top that touches its outline is pushed back out and bounces off.
  for (const fp of fps) {
    if (o.y - o.r >= fp.height - 0.01 || wasBottom >= fp.height - 0.01) continue
    const b = fp.box
    if (o.x < b[0] - o.r || o.x > b[2] + o.r || o.z < b[1] - o.r || o.z > b[3] + o.r) continue
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
    res.bumped = fp.id
  }

  // Coming down on the surface under it: bounce (or settle).
  const under = surfaceAt(fps, o.x, o.z)
  if (o.y - o.r <= under.h && o.vy < 0) {
    o.y = under.h + o.r
    res.landed = under.id
    // Arriving from a precise hop: it's there, exactly (not wherever the step's end happened to be). Stop dead.
    if (o.flying) {
      if (o.aim) { o.x = o.aim.x; o.z = o.aim.z; o.y = surfaceAt(fps, o.x, o.z).h + o.r }
      o.vx = o.vz = 0
      o.flying = false
      o.aim = null
    }
    const next = o.route.shift()
    if (next || o.active) {
      o.vy = Math.sqrt(2 * G * opts.hop)
      o.resting = false
      if (next) {
        // A precise hop: the sideways speed that lands it on the spot as it comes back down (to the spot's surface).
        const t = flightTime(o.vy, o.y - o.r, surfaceAt(fps, next.x, next.z).h)
        o.vx = (next.x - o.x) / t
        o.vz = (next.z - o.z) / t
        o.flying = true
        o.aim = next
      }
    } else {
      // A real bounce (not just resting contact) loses most of its sideways speed to the surface's grip.
      if (-o.vy > REST_VY) { o.vx *= GRIP; o.vz *= GRIP }
      o.vy = -o.vy * SETTLE
      if (o.vy < REST_VY) {
        o.vy = 0
        const pushed = !!opts.push && Math.hypot(opts.push[0], opts.push[1]) > 1e-3
        if (!o.target && !pushed && Math.hypot(o.vx, o.vz) < 0.05) { o.vx = o.vz = 0; o.resting = true }
      } else o.resting = false
    }
  } else if (o.vy !== 0 || Math.hypot(o.vx, o.vz) > 0.001) o.resting = false
  return res
}

/** How long a hop launched upward at vy from height y0 takes to come down to height y1. */
export function flightTime(vy: number, y0: number, y1: number): number {
  // y0 + vy t - G t²/2 = y1  →  the later root.
  const d = vy * vy + 2 * G * (y0 - y1)
  return d <= 0 ? (2 * vy) / G : (vy + Math.sqrt(d)) / G
}
