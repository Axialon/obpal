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
 *   rolling into it fast enough rides up over the edge onto it, a slower one rolls back, and one steered or tilted onto
 *   it (someone pointing at the button, a phone tipped toward it) is helped up, as a hand would. Rolling off its edge,
 *   it tips over and drops.
 * - A letter's counters (the holes in o, p, e) are narrower than a marble: one that finds itself in one sits on the
 *   counter's rim, held by all the rim's points it touches at once, and comes to rest there. Steered or tilted toward
 *   a side, it rides up over the rim and out. Rolling across the letter's top, or coming down on it, a marble stays out
 *   of its counters unless it's steered or tilted into one. (A counter wider than a marble, as in O, is a pit it can
 *   drop into, and leave the same way.)
 * - Given walls (the planes through the camera and the edges of what's on screen), it's kept inside them as it's
 *   drawn: its outline, a little bigger the higher it is, just touches the edge of the screen, and a knock against one
 *   is reported for its sound.
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
  /** Held up by a counter's rim (as of the last step): it rolls there as on any surface. */
  held?: boolean
  /** In a letter's counter (on its rim, or down in its pit), and how long a clear tilt has been pulling it out (s). */
  cup?: boolean
  strain?: number
}

/**
 * A plane the marble stays inside of, as drawn: n·p + d ≥ its drawn radius (n points inward). The hero's are the planes
 * through the camera and the four edges of what's on screen.
 */
export interface Wall { n: [number, number, number]; d: number }

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
  /**
   * The walls to keep it inside, in place of the bounds (which then only matter to whoever draws the field), and how
   * much bigger it's drawn per em it rises (its drawn radius is r · (1 + grow · (y − r))).
   */
  walls?: readonly Wall[]
  grow?: number
}

/** Gravity, em/s². */
export const G = 18
/** How much of its speed a bounce keeps (glass on a hard surface), and the speed below which it rests. */
const SETTLE = 0.55
const REST_VY = 0.9
/** Side bumps keep this much of the speed into the letter; two marbles, this much of the speed between them. */
const BUMP = 0.55
const CLINK = 0.9
/** Rolling slows by this factor per second when nothing steers it; on a counter's rim, much sooner (it settles). */
const FRICTION = 1.8
const RIM_FRICTION = 8
/** A real bounce keeps this much of its sideways speed (the surface's grip). */
const GRIP = 0.6
const MAX_SPEED = 14
/** How long a toss waits for a marble in the air to come down (s). */
const TOSS_WAIT = 0.25
/** Running into a side slower than this (em/s) is leaning on it, not a bump. */
const LEAN = 0.3
/**
 * A tilt pushing this hard (em/s², about 2° of a phone's tilt), within about 65° of the way to a step's edge or out of a
 * counter, is someone meaning to go there: the marble is helped up and over.
 */
const MEANT = 1
const TOWARD = 0.42
/**
 * A step's edge, and how hard a tilt must push into it to help the marble up: this much per em of the step's height
 * (a button 0.1 em high takes 4.4 em/s², a phone tipped about 9°; a gentler tilt bumps it against the edge).
 */
const LIFT_PER_EM = 44
/**
 * In a counter, a tilt pulls the marble out only past this (em/s², a phone tipped about 5°) and held this long (s): a
 * hand's tremble and stray readings don't, and a marble that stops there sleeps.
 */
const BREAK = 2.2
const BREAK_TIME = 0.25

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
  if ((o.held || o.y - o.r - surfaceAt(fps, o.x, o.z).h < 0.02) && o.vy <= 0.5) {
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
  /** It knocked against a wall this step (the wall's index in StepOptions.walls), and how hard (em/s into it). */
  wall: number | null
  wallImpact: number
  /** Anything moved. */
  moving: boolean
}

/** Advance one orb by dt seconds among the letters. */
export function step(o: Orb, fps: readonly Footprint[], dt: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, impact: 0, wall: null, wallImpact: 0, moving: false }
  // In a counter, a tilt has to mean it: a hand's tremble, a slight lean or a stray reading doesn't shift it (static
  // friction); only a clear tilt, held a moment, does.
  let push = opts.push
  if (o.cup && push) {
    o.strain = Math.hypot(push[0], push[1]) > BREAK ? (o.strain ?? 0) + Math.min(dt, 1 / 30) : 0
    if (o.strain < BREAK_TIME) push = undefined
  } else o.strain = 0
  if (o.resting && !o.target && !o.route.length && !o.toss && !push) return res
  if (push !== opts.push) opts = { ...opts, push }
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
    if (r.wall !== null && r.wallImpact > res.wallImpact) { res.wall = r.wall; res.wallImpact = r.wallImpact }
  }
  res.moving = !o.resting
  return res
}

function sub(o: Orb, fps: readonly Footprint[], h: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, impact: 0, wall: null, wallImpact: 0, moving: false }
  const base = surfaceAt(fps, o.x, o.z)
  const climb = opts.climb ?? 0
  const wasHeld = !!o.held
  // On the ground, on a low step's edge (rolling up onto it, or off it), or held by a counter's rim: steering and
  // rolling friction hold there.
  const grounded = (o.y - o.r <= base.h + 1e-3 && o.vy <= 0) || (climb > 0 && onEdge(o, fps, climb)) || !!o.held

  // Sideways: steered (a spring that doesn't overshoot; in the air, only as much as `air`), carried through a precise
  // hop, pushed by a tilt, or rolling to a stop.
  if (!o.flying) {
    const w = opts.omega ?? 7, zeta = opts.zeta ?? 0.9
    if (o.target) {
      const k = grounded ? 1 : opts.air ?? 1
      o.vx += k * (w * w * (o.target.x - o.x) - 2 * zeta * w * o.vx) * h
      o.vz += k * (w * w * (o.target.z - o.z) - 2 * zeta * w * o.vz) * h
    } else if (grounded) {
      // (Settling on a counter's rim, it grips: nothing's tilting it on.)
      const k = Math.exp(-(wasHeld && !opts.push ? RIM_FRICTION : FRICTION) * h)
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

  // The field's edges: the walls where it has them (as it's drawn, so it stays wholly on screen), else the bounds: far
  // and near, then the sides where it is.
  let touched = 0
  if (opts.walls) touched = walls(o, opts.walls, opts.grow ?? 0, res)
  else {
    const [, z0, , z1] = opts.bounds
    if (o.z < z0 + o.r) { o.z = z0 + o.r; o.vz = Math.abs(o.vz) * BUMP }
    if (o.z > z1 - o.r) { o.z = z1 - o.r; o.vz = -Math.abs(o.vz) * BUMP }
    const [x0, x1] = sidesAt(opts, o.z)
    if (o.x < x0 + o.r) { o.x = x0 + o.r; o.vx = Math.abs(o.vx) * BUMP }
    if (o.x > x1 - o.r) { o.x = x1 - o.r; o.vx = -Math.abs(o.vx) * BUMP }
  }

  // Letters' sides: an orb lower than a letter's top that touches its outline is pushed back out and bounces off. (A
  // precise hop on its way up is clear of them: it left from beside one and is over it a moment later.) A low step
  // has a rounded edge instead, and a counter its rim. Touching several at once (between two letters, say), it's set
  // clear of all of them together: a few passes, each from where the last left it, so none of them shoves it back
  // into another.
  o.held = false
  o.cup = false
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const fp of fps) {
      if (o.flying && o.vy > 0) break
      const b = fp.box
      if (o.x < b[0] - o.r || o.x > b[2] + o.r || o.z < b[1] - o.r || o.z > b[3] + o.r) continue
      if (fp.height <= climb) { if (pass === 0) edge(o, fp, res, opts.push); continue }
      // In a counter: its rim holds it (a precise hop is on its way to a spot on the letter itself, and lands there).
      const hole = o.flying ? null : counterOf(fp, o.x, o.z)
      if (hole) { if (pass === 0) counter(o, fp, hole, wasBottom, wasHeld, res, opts); continue }
      if (o.y - o.r >= fp.height - 0.01 || wasBottom >= fp.height - 0.01) continue
      const inLetter = inside(fp, o.x, o.z)
      const e = nearest(fp, o.x, o.z)
      if (!inLetter && e.d >= o.r - 1e-9) continue
      // Out of the letter, along the way it came in.
      const nx = inLetter ? -e.nx : e.nx, nz = inLetter ? -e.nz : e.nz
      const push = inLetter ? e.d + o.r : o.r - e.d
      o.x += nx * push
      o.z += nz * push
      moved = true
      const vn = o.vx * nx + o.vz * nz
      if (vn < 0) { o.vx -= (1 + BUMP) * vn * nx; o.vz -= (1 + BUMP) * vn * nz }
      // Knocked off course: the route is off.
      if (o.flying) { o.flying = false; o.aim = null; o.route = [] }
      if (pass === 0 && vn < -LEAN) { res.bumped = fp.id; res.impact = Math.max(res.impact, -vn) }
    }
    if (!moved) break
  }

  // Coming down on the surface under it: bounce (or settle). On a counter's rim, the rim has done that; a hop or a
  // toss leaves from there all the same.
  const under = surfaceAt(fps, o.x, o.z)
  const rim = !!o.held
  if (rim || (o.y - o.r <= under.h && o.vy < 0)) {
    const vin = rim ? 0 : -o.vy
    if (!rim) o.y = under.h + o.r
    // Rolling along a surface touches it every step; only coming down on it is a landing.
    if (!rim && (vin > REST_VY * 0.5 || o.flying)) { res.landed = under.id; res.impact = Math.max(res.impact, vin) }
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
    } else if (!rim) {
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
  // Against a wall this step: once more now the surface has set its height, so it touches it exactly.
  if (opts.walls && touched) walls(o, opts.walls, opts.grow ?? 0, res, touched)
  return res
}

/**
 * A low step's rounded top edge, for a marble beside it (over it, its top is simply the surface). Steered onto the
 * step, or tilted into its edge, the edge is a ramp: the marble rides up it at the edge's height under it, as a hand
 * would lift it. Otherwise it rolls on the edge: pushed out along the line from the edge to its centre, and it loses
 * its speed into the edge; fast enough, what's left carries it up and over, else gravity rolls it back. Off the step's
 * side, it tips over the edge the same way.
 */
function edge(o: Orb, fp: Footprint, res: StepResult, tilt?: [number, number]) {
  if (inside(fp, o.x, o.z)) return
  const e = nearest(fp, o.x, o.z)
  if (e.d >= o.r) return
  const up = o.y - fp.height
  const dist = Math.hypot(e.d, up)
  if (dist >= o.r) return
  // Tilted into the edge: the tilt's part toward the step (e.n points from the edge out to the marble).
  const tilted = !!tilt && -(tilt[0] * e.nx + tilt[1] * e.nz) > Math.max(MEANT, LIFT_PER_EM * fp.height, TOWARD * Math.hypot(tilt[0], tilt[1]))
  if (tilted || (o.target && inside(fp, o.target.x, o.target.z))) {
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

/** Is (x, z) inside this one outline (even-odd)? */
function inRing(ring: Float64Array, x: number, z: number): boolean {
  let c = false
  const n = ring.length / 2
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], zi = ring[i * 2 + 1], xj = ring[j * 2], zj = ring[j * 2 + 1]
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

/** The counter (hole) of a letter that (x, z) is in, if any: inside an even number of its outlines, the innermost. */
export function counterOf(fp: Footprint, x: number, z: number): Float64Array | null {
  if (x < fp.box[0] || x > fp.box[2] || z < fp.box[1] || z > fp.box[3]) return null
  let count = 0, hole: Float64Array | null = null, least = Infinity
  for (const ring of fp.rings) {
    if (!inRing(ring, x, z)) continue
    count++
    // The innermost is the smallest (by its box).
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
    for (let i = 0; i < ring.length; i += 2) { x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]); z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]) }
    const a = (x1 - x0) * (z1 - z0)
    if (a < least) { least = a; hole = ring }
  }
  return count >= 2 && count % 2 === 0 ? hole : null
}

/**
 * A marble whose centre is over a letter's counter. The counter's rim (its outline, at the letter's height) holds it
 * up: every point of the rim at once, which comes to the nearest one holding it highest. So it sits on the rim, lower
 * the deeper into the counter it is, and moves on it as on any surface (with more grip: it settles quickly). A
 * counter wider than the marble lets it drop through to the floor, and the rim is a wall to it there (a pit, as in O).
 * Meaning to leave (steered to somewhere outside the counter, or tilted toward a side), it rides up over the rim that
 * way, as a hand would lift it. Rolling across the letter's top, it doesn't drop in unless it's meant to: it stays on
 * the rim's edge. (`wasBottom` is where its bottom was before this step; `wasHeld`, whether the rim held it then.)
 */
function counter(o: Orb, fp: Footprint, hole: Float64Array, wasBottom: number, wasHeld: boolean, res: StepResult, opts: StepOptions) {
  const top = fp.height
  const n = hole.length / 2
  // The rim's nearest point, and the way into the counter from it.
  let bd = Infinity, bx = 0, bz = 0
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = hole[j * 2], az = hole[j * 2 + 1], ex = hole[i * 2] - ax, ez = hole[i * 2 + 1] - az
    const t = Math.max(0, Math.min(1, ((o.x - ax) * ex + (o.z - az) * ez) / (ex * ex + ez * ez || 1e-12)))
    const d = Math.hypot(o.x - ax - ex * t, o.z - az - ez * t)
    if (d < bd) { bd = d; bx = ax + ex * t; bz = az + ez * t }
  }
  const inX = bd > 1e-9 ? (o.x - bx) / bd : 0, inZ = bd > 1e-9 ? (o.z - bz) / bd : 0
  // Where it's meant to go: to its target, or the way it's tilted.
  const push = opts.push && Math.hypot(opts.push[0], opts.push[1]) > MEANT ? opts.push : null
  let ix = 0, iz = 0
  if (o.target) { ix = o.target.x - o.x; iz = o.target.z - o.z } else if (push) { ix = push[0]; iz = push[1] }
  const il = Math.hypot(ix, iz)
  if (il > 1e-6) { ix /= il; iz /= il }
  const stay = !!o.target && inRing(hole, o.target.x, o.target.z)
  // Rolling on the letter's top (not coming down from above) and not meant to go in or across: it stays on the rim's
  // edge, and rolls back from it.
  const enter = stay || (il > 1e-6 && ix * inX + iz * inZ > TOWARD)
  if (!wasHeld && Math.abs(wasBottom - top) < 0.01 && o.y - o.r < top && !enter) {
    o.x = bx - inX * 1e-4
    o.z = bz - inZ * 1e-4
    const vn = o.vx * inX + o.vz * inZ
    if (vn > 0) { o.vx -= (1 + BUMP) * vn * inX; o.vz -= (1 + BUMP) * vn * inZ }
    return
  }
  o.cup = true
  // How high the rim holds it here (nowhere, if the rim is out of its reach: it's over the middle of a pit).
  const rim = bd < o.r ? top + Math.sqrt(o.r * o.r - bd * bd) : -Infinity
  if (rim > o.r + 1e-6 && (wasHeld || wasBottom + o.r >= rim - 0.02)) {
    // On the rim (or coming down onto it): held there.
    if (o.y <= rim) {
      const vin = -o.vy
      o.y = rim
      if (o.vy < 0) o.vy = 0
      if (!wasHeld && vin > REST_VY * 0.5) {
        res.landed = fp.id
        res.impact = Math.max(res.impact, vin)
        o.vx *= GRIP; o.vz *= GRIP
      }
      o.held = true
      // Settled, with nobody steering or tilting it anywhere: at rest.
      const pushed = !!opts.push && Math.hypot(opts.push[0], opts.push[1]) > 1e-3
      if (!o.target && !pushed && !o.route.length && !o.toss && Math.hypot(o.vx, o.vz) < 0.05) { o.vx = o.vz = 0; o.resting = true }
    }
    return
  }
  // Down in a pit, on its floor: the rim is a wall, unless it's meant to leave this way (then up and over it).
  const reach = Math.sqrt(Math.max(0, o.r * o.r - (o.y - top) ** 2))
  if (bd >= reach) return
  if (il > 1e-6 && !stay && -(inX * ix + inZ * iz) > TOWARD) {
    if (rim > o.y) { o.y = rim; if (o.vy < 0) o.vy = 0; o.held = true }
    return
  }
  const p = reach - bd
  o.x += inX * p
  o.z += inZ * p
  const vn = o.vx * inX + o.vz * inZ
  if (vn < 0) {
    o.vx -= (1 + BUMP) * vn * inX; o.vz -= (1 + BUMP) * vn * inZ
    if (vn < -LEAN) { res.bumped = fp.id; res.impact = Math.max(res.impact, -vn) }
  }
}

/**
 * The walls: the marble, as drawn (r · (1 + grow · (y − r)), bigger the higher it is), stays inside each, set back
 * along the floor if it's gone past one (the rest of its motion goes on) and bouncing off it. A few passes, for a
 * corner. The hardest knock is reported, and which wall. Returns the walls it touched (a bit each). `touching` sets
 * it back exactly against those walls, closer or further (after its height has changed: an edge of the screen
 * leans, so its height moves it on screen), with no bounce.
 */
function walls(o: Orb, ws: readonly Wall[], grow: number, res: StepResult, touching = 0): number {
  const rho = o.r * (1 + grow * Math.max(0, o.y - o.r))
  let touched = 0
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    ws.forEach((w, i) => {
      const s = w.n[0] * o.x + w.n[1] * o.y + w.n[2] * o.z + w.d
      const exact = (touching >> i) & 1
      if (s >= rho && !(exact && s > rho + 1e-9)) return
      const hl = Math.hypot(w.n[0], w.n[2])
      if (hl < 1e-6) return
      const nx = w.n[0] / hl, nz = w.n[2] / hl
      const p = (rho - s) / hl
      o.x += nx * p
      o.z += nz * p
      moved = true
      touched |= 1 << i
      if (exact) return
      const vn = o.vx * nx + o.vz * nz
      if (vn < 0) {
        o.vx -= (1 + BUMP) * vn * nx
        o.vz -= (1 + BUMP) * vn * nz
        if (-vn > res.wallImpact) { res.wall = i; res.wallImpact = -vn }
      }
      if (o.flying) { o.flying = false; o.aim = null; o.route = [] }
    })
    if (!moved) break
  }
  return touched
}

/** Where (x, z) must move to, on the floor plan, for a sphere of drawn radius rho at height y to be inside the walls. */
export function withinWalls(ws: readonly Wall[], x: number, y: number, z: number, rho: number): { x: number; z: number } {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false
    for (const w of ws) {
      const s = w.n[0] * x + w.n[1] * y + w.n[2] * z + w.d
      if (s >= rho - 1e-9) continue
      const hl = Math.hypot(w.n[0], w.n[2])
      if (hl < 1e-6) continue
      const p = (rho - s) / hl
      x += (w.n[0] / hl) * p
      z += (w.n[2] / hl) * p
      moved = true
    }
    if (!moved) break
  }
  return { x, z }
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
