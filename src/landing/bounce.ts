/**
 * The hero's marbles as physics: glass marbles that roll and bounce on a floor and on raised letters. Pure (no
 * three.js), unit-tested in node. Units are the letters' em: the floor is the x-z plane, y is up. A letter is a
 * footprint (outline polygons with holes, from its glyph) raised to its height; a marble is a ball with a position, a
 * velocity, a radius and some weight: it never bounces by itself.
 *
 * It moves in fixed steps (H: 240 a second, whatever the frame rate), each solved as a whole. Everything a marble
 * touches, or will reach within the step, is a contact: the floor, a letter's top, its sides, the rounded rim of its
 * top edge, a step's edge, the edges of the screen, another marble. All of them are solved together (impulses, each
 * started from what it took the step before), so a marble held by two things at once (the rim of a counter all round,
 * the edges of two letters either side of a gap narrower than itself, a corner) rests on both at once instead of being
 * pushed off one into the other. A contact it will reach within the step stops it exactly at the surface (so nothing
 * is passed through, however fast), and whatever overlap is left is eased out (within a hair, SLOP, it's left alone,
 * so a resting marble never trembles).
 *
 * - Steered, it rolls after its target on a damped spring; in the air it mostly keeps its momentum. Tilted, it's
 *   pushed along like a marble on a tray.
 * - Tossed (a phone flicked upward, a click), it leaves the surface at that speed. A toss that comes while it's still
 *   in the air waits a moment for it to touch down, the way a tray can only throw a ball that's on it.
 * - Given a route, it hops from spot to spot back to back: each hop leaves with exactly the sideways speed that lands
 *   it on the next spot, flies untouched by any tilt or steering (clear of the letters on its way up, and high enough
 *   to pass over any raised thing on the way, or, where that would take a leap, onto the first one, to go on from
 *   there), and stops dead there (no sliding on past it).
 * - It lands on a letter where it comes down over one, rolls over an edge (a top edge is round to it: it touches it
 *   along its rim) and bumps off a side. A contact bounces only when it's struck: slower than a knock, it just holds,
 *   so a marble pressed against a side, into a corner or onto a rim rests there. A knock is reported once, when a
 *   contact begins, with its moment within the step, where and how hard: resting or rolling against something is
 *   silent.
 * - Left alone, each bounce is lower than the last and the surface's grip takes some of its sideways speed, until it
 *   stops. Rolling has a little resistance, more to start from still than to keep going, so a marble comes to rest,
 *   and then it sleeps: nothing moves and nothing needs drawing, until something moves it (a tilt or a pull that what
 *   holds it can't hold against, a knock, a toss).
 * - A counter narrower than a marble (the holes in o, p, e), or a gap between two letters, is a cup: the marble sits on
 *   its rim, settles in the lowest place, and sleeps there. A counter wider than a marble (O) is a pit, the floor at
 *   its bottom. Rolling slowly across a letter, a marble can settle into one; fast, it rolls on over.
 * - A step (a button: a footprint marked as one, or one no taller than StepOptions.climb) stops a marble rolled into
 *   it. Lower than the marble's middle, its edge takes the marble on its rim (fast enough, it rides up over it); taller,
 *   it's a block, and a marble knocks off its side. Steered onto it, or pushed into it by a clear tilt held a moment
 *   (LIFT_PER_EM a em of its height), it's helped up and over, as a hand would: its weight carried, and what pushes it
 *   into the step turned up along it, up the side and over the edge. Out of a cup the same: steered out, or a clear
 *   tilt held a moment (BREAK), helps it up over the rim. It rolls up and over, never jumps. A letter's outside, from
 *   the floor, is a wall. Rolling off an edge, it tips over and drops.
 * - Given walls (the planes through the camera and the edges of what's on screen), it's kept inside them as it's
 *   drawn: its outline, a little bigger the higher it is, just touches the edge of the screen, and a knock against one
 *   is reported like any other.
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
  /**
   * A step (a button): a marble can be helped up onto it, however tall it is. Left out, it's a step if it's no taller
   * than StepOptions.climb.
   */
  step?: boolean
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
  /** In the air on a precise hop: no steering or tilt, and it stops dead where it lands. */
  flying: boolean
  /** Where the precise hop in the air is headed. */
  aim?: { x: number; z: number } | null
  /** A toss waiting for it to touch down: the speed it leaves at, and how much longer it waits (s). */
  toss: { vy: number; ttl: number } | null
  /** Asleep: at rest where what it touches holds it; nothing moves until something wakes it. */
  resting: boolean
  /** Held up by edges alone (the rim of a counter, the edges of a gap between two letters), as of its last step. */
  held?: boolean
  /** What the physics carries from one step to the next (its own). */
  mem?: Mem
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
  /**
   * Footprints this low or lower are steps, with an edge a marble can be helped over (0, the default: none; a footprint
   * can say it's a step itself, Footprint.step).
   */
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
/** The fixed step (s): the physics moves 240 times a second, whatever the frame rate. */
export const H = 1 / 240
/**
 * How much of its speed into a surface a bounce keeps: coming down on one (glass on a hard surface; not from a small
 * fall, one it would leave slower than REST_VY), running into a side (from LEAN), two marbles (from CLINK_V). A step's
 * edge doesn't bounce: rolled into, it's climbed or it's not.
 */
const SETTLE = 0.55
const REST_VY = 0.9
const BUMP = 0.55
const LEAN = 0.3
const CLINK = 0.9
const CLINK_V = 0.05
/** Coming down faster than this (em/s) onto something is landing on it; slower, it has rolled into it. */
const FALLING = 0.3
/**
 * Dropped into a cup (caught by two edges or more at once), it hops straight up with CATCH of the speed it came down at
 * (if that's more than CATCH_V), a small clink of a bounce, and settles.
 */
const CATCH = 0.3
const CATCH_V = 0.35
/** A real bounce keeps this much of its sideways speed (the surface's grip). */
const GRIP = 0.6
/**
 * Rolling slows by this factor per second when nothing steers it; in a cup, much sooner: it settles. And it rolls
 * against a little resistance, as a share of its weight: ROLL to keep rolling, STICK to start from still (about 1.5°
 * of a phone's tilt past its dead zone).
 */
const FRICTION = 1.8
const CUP_FRICTION = 8
const ROLL = 0.02
const STICK = 0.045
/** Steered and asleep where it was pointed, it wakes when its target is off by more than a hair (a pull of AIMED × G). */
const AIMED = 0.001
const MAX_SPEED = 14
/** How long a toss waits for a marble in the air to come down (s). */
const TOSS_WAIT = 0.25
/**
 * A precise hop rises higher than StepOptions.hop to pass over a raised thing on the way, but no higher than HOP_OVER
 * (em); where that's not enough (it's right beside one), it hops up onto that one first.
 */
const HOP_OVER = 1.6
/**
 * Being helped up and over: a step takes a push into it of LIFT_PER_EM a em of the step's height (a button 0.3 em
 * high takes 6.6 em/s², a phone tipped about 13°), at least MEANT; a cup's rim, BREAK (a phone tipped 4.5°). A tilt
 * has to be held STRAIN (s), so a hand's tremble or a stray reading doesn't do it; steering helps at once. Once going,
 * it keeps going while the push stays over KEEP of that, pointing within about 60° (TOWARD) of the way over.
 */
const LIFT_PER_EM = 22
/** Helped up a step, it's lifted no faster than this along it (em/s): up a block's side and round its edge, steadily. */
const CLIMB_V = 1
const MEANT = 1
const BREAK = 1.8
const STRAIN = 0.15
const KEEP = 0.6
const TOWARD = 0.5
/**
 * Leaving a cup, its weight is carried (a hand lifting it) while the push rolls it up the rim and over, whichever way;
 * steered out of a gap, when its target is at least CUP_OUT (em) off (then until it's out). (CUP: what it's being helped
 * over, when that's a cup.)
 */
const CUP_OUT = 0.12
const CUP = -3
/**
 * Two things within TOUCH (em) touch. SLOP of overlap is left alone (a resting marble isn't nudged every step), and
 * more is taken out at most MAX_FIX a step (a marble found inside something eases out of it; it never jumps).
 */
const TOUCH = 0.004
const SLOP = 0.001
const MAX_FIX = 0.02
/** Higher than this off the floor (em), a marble touching a letter's edge is up on edges, not beside it on the floor. */
const ABOVE = 0.01
/** Impulse iterations a step. */
const ITERATIONS = 10
/** A marble this slow (em/s) for this long (s), held by what it touches, sleeps. */
const SLEEP_V = 0.01
const SLEEP_T = 0.2
/** What a contact is with, besides a footprint (by its id): the floor, a wall (WALL − its index), another marble (MARBLE − its index). */
export const FLOOR = -1
const WALL = -10
const MARBLE = -1000

/** What a marble keeps from one step to the next. */
export interface Mem {
  /** Where its last step left it: moved from there (by anyone else), what it knew is forgotten. */
  x: number
  y: number
  z: number
  /** What it ended its last step touching: the push each took (a start for the next), and a knock still to bounce. */
  touch: Touch[]
  /** How much held it up (the pushes up of what it stands on, em/s a step), and whether edges alone did, two or more. */
  load: number
  cup: boolean
  /** Held still by static friction, and how long it has been nearly still (s). */
  stuck: boolean
  still: number
  /** How long a clear tilt has pushed it to climb (s), and what it's being helped over (a footprint's id), if anything. */
  strain: number
  climb: number | null
  /** Caught by a cup this step: how fast it came down (em/s), for its small hop once it's in. */
  caught: number
}
interface Touch { id: number; nx: number; ny: number; nz: number; lambda: number; knock: number }

/** A contact being solved. */
interface Contact {
  /** What with: a footprint's id, FLOOR, WALL − i, MARBLE − j. */
  id: number
  /** The marble's index among those stepped, and the other marble's (−1: something fixed). */
  a: number
  b: number
  /** From what it touches toward the marble (a wall's, along the floor). */
  nx: number
  ny: number
  nz: number
  /** How far apart they are (em; overlapping: below 0), and how that changes with the marble's rise (a wall's). */
  gap: number
  gy: number
  /** Where it touches, on what it touches. */
  px: number
  py: number
  pz: number
  /** A step's edge or a cup's rim: how hard a push over it takes (em/s²; 0: it's not one); a step's edge (no bounce). */
  over: number
  step: boolean
  /** The push it has taken this step (em/s), the least speed away from it allowed (em/s), a knock still to bounce. */
  lambda: number
  min: number
  knock: number
  /** How far apart they'll be as the step ends (em), and how fast it came at it as the step began (em/s). */
  end: number
  vn: number
}

/** A marble knocked into something this step. */
export interface Knock {
  /** When, from the start of the step (s). */
  t: number
  /** The marble (its index in what was stepped). */
  i: number
  /** Coming down on something (land), into a side or an edge (bump), a wall, another marble. */
  kind: 'land' | 'bump' | 'wall' | 'marble'
  /** What it struck: a footprint's id or FLOOR; a wall's index; the other marble's index. */
  id: number
  /** How fast it came in (em/s), where it touched and which way (from what it struck, toward the marble). */
  speed: number
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  /** A precise hop coming down. */
  hop?: boolean
}

export function newOrb(x: number, z: number, r: number, surface = 0): Orb {
  return { x, y: surface + r, z, vx: 0, vy: 0, vz: 0, r, target: null, route: [], flying: false, toss: null, resting: true }
}

/** Whether it's on something (as of its last step): held up by the floor, a top, a step's edge or a rim. */
function standing(o: Orb, fps: readonly Footprint[]): boolean {
  const m = o.mem
  if (m && m.x === o.x && m.y === o.y && m.z === o.z) return m.load > 0
  return o.y - o.r - surfaceAt(fps, o.x, o.z).h < 0.02
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
  if (standing(o, fps) && o.vy <= 0.5) {
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
 * back, most of it (glass on glass). Returns how hard they met (em/s), 0 if they didn't. (tick() does this within its
 * step for the marbles it steps together; this is for a pair on their own.)
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
  /** Every knock, in order, with its moment from the start of this step (s). */
  knocks: Knock[]
}

/** What the marbles are kept inside: walls, and how much bigger a marble is drawn per em it rises. */
export interface Env { walls: readonly Wall[]; grow: number }

/**
 * The bounds (and their sides) as walls, for a field without the camera's: far and near, and each side, the marble's
 * own radius from each, measured across x at the sides (as sidesAt() gives them).
 */
export function boundsWalls(opts: Pick<StepOptions, 'bounds' | 'sides'>): Wall[] {
  const [x0, z0, x1, z1] = opts.bounds
  const s = opts.sides ?? [x0, x1, x0, x1]
  // Each side as x = its x at the far edge + its slope × the depth from there: n·p + d is the distance across x.
  const dz = z1 - z0 || 1
  const bl = (s[2] - s[0]) / dz, br = (s[3] - s[1]) / dz
  return [
    { n: [0, 0, 1], d: -z0 },
    { n: [0, 0, -1], d: z1 },
    { n: [1, 0, -bl], d: bl * z0 - s[0] },
    { n: [-1, 0, br], d: s[1] - br * z0 },
  ]
}

/**
 * Advance one orb by dt seconds among the letters: in even steps of at most H, each solved whole. (The field steps its
 * marbles together, H at a time, with tick().)
 */
export function step(o: Orb, fps: readonly Footprint[], dt: number, opts: StepOptions): StepResult {
  const res: StepResult = { landed: null, bumped: null, impact: 0, wall: null, wallImpact: 0, moving: false, knocks: [] }
  dt = Math.min(dt, 0.1)
  const n = Math.max(1, Math.ceil(dt / H - 1e-9))
  const h = dt / n
  const env: Env = opts.walls ? { walls: opts.walls, grow: opts.grow ?? 0 } : { walls: boundsWalls(opts), grow: 0 }
  const bodies = [{ o, opts }]
  for (let s = 0; s < n; s++) {
    for (const k of tick(bodies, fps, h, env)) {
      k.t += s * h
      res.knocks.push(k)
      if (k.kind === 'wall') { if (k.speed > res.wallImpact) { res.wall = k.id; res.wallImpact = k.speed } }
      else if (k.kind === 'land' && (k.speed > REST_VY * 0.5 || k.hop)) { res.landed = k.id; res.impact = Math.max(res.impact, k.speed) }
      else if (k.kind === 'bump' && k.speed > LEAN) { res.bumped = k.id; res.impact = Math.max(res.impact, k.speed) }
    }
  }
  res.moving = !o.resting
  return res
}

/** One marble to step, with what moves it (its steering, the tilt, its hops). */
export interface Body { o: Orb; opts: StepOptions }

/**
 * One fixed step, h seconds (H, or less), for every marble at once: forces, contacts (all at once, marble on marble
 * too), the solve, and the knocks it made, each with its moment within the step. A marble asleep stays put, and costs
 * next to nothing, unless something would move it.
 */
export function tick(bodies: readonly Body[], fps: readonly Footprint[], h: number, env: Env): Knock[] {
  const knocks: Knock[] = []
  const n = bodies.length
  const awake: boolean[] = []
  // Each marble's memory, as the step begins (moved since, it's started over).
  const mems = bodies.map((b) => memOf(b.o))
  for (let i = 0; i < n; i++) {
    const { o, opts } = bodies[i]
    if (o.toss && (o.toss.ttl -= h) <= 0) o.toss = null
    awake.push(!o.resting || wake(o, opts, fps, env, h))
  }
  // A marble asleep that another comes at wakes too.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (!awake[i] || awake[j] || i === j) continue
      const a = bodies[i].o, b = bodies[j].o
      const reach = Math.hypot(a.vx, a.vy, a.vz) * h * 1.5 + TOUCH
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - a.r - b.r < reach) awake[j] = true
    }
  }
  const contacts: Contact[] = []
  const v0: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    const { o, opts } = bodies[i]
    v0.push([o.vx, o.vy, o.vz])
    if (!awake[i]) continue
    const m = mems[i]
    // Woken: it has to be still a while again before it sleeps.
    if (o.resting) m.still = 0
    o.resting = false
    // In the cup it was dropped into: its small hop (or none, from a small drop), and it loses most of its sideways speed.
    if (m.caught > 0 && m.load > 0) {
      if (CATCH * m.caught > CATCH_V) o.vy = Math.max(o.vy, CATCH * m.caught)
      o.vx *= GRIP * 0.5; o.vz *= GRIP * 0.5
      m.caught = 0
    }
    // Leaving: the next precise hop, or the toss that was waiting, from wherever it's standing.
    if (m.load > 0 && !o.flying) {
      const next = o.route.length ? o.route[0] : null
      if (next) {
        o.route.shift()
        const hop = launch(o, next, fps, opts)
        // (Onto a raised thing on the way first: then on to where it was going.)
        if (hop.to !== next) o.route.unshift(next)
        o.vy = hop.vy
        const t = flightTime(o.vy, o.y - o.r, surfaceAt(fps, hop.to.x, hop.to.z).h)
        o.vx = (hop.to.x - o.x) / t
        o.vz = (hop.to.z - o.z) / t
        o.flying = true
        o.aim = hop.to
      } else if (o.toss) {
        o.vy = Math.max(o.vy, o.toss.vy)
        o.toss = null
      }
    }
    // On a precise hop, still headed for its spot: its sideways speed kept to what lands it there (a wall that kept it
    // on screen as it rose has nudged it, say). Hopping up onto a raised thing from right beside it, it goes straight up
    // until it's over its top, then over.
    if (o.flying && o.aim) {
      const s = surfaceAt(fps, o.aim.x, o.aim.z)
      const t = flightTime(o.vy, o.y - o.r, s.h)
      const onto = s.id === FLOOR ? undefined : fps.find((f) => f.id === s.id)
      const beside = !!onto && o.vy > 0 && o.y - o.r < s.h + 0.02 && !inside(onto, o.x, o.z) && nearest(onto, o.x, o.z).d < o.r + 0.05
      if (beside) { o.vx = 0; o.vz = 0 } else if (t > h) { o.vx = (o.aim.x - o.x) / t; o.vz = (o.aim.z - o.z) / t }
    }
    v0[i] = [o.vx, o.vy, o.vz]
    // What it touches, or will reach within the step; then what moves it.
    const first = contacts.length
    gather(o, i, fps, env, Math.hypot(o.vx, o.vy, o.vz) * h * 1.5 + (G + 20) * h * h + TOUCH, opts.climb ?? 0, contacts)
    forces(o, opts, contacts, first, m, fps, h)
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!awake[i] && !awake[j]) continue
      const a = bodies[i].o, b = bodies[j].o
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
      const d = Math.hypot(dx, dy, dz)
      if (d < 1e-9 || d - a.r - b.r >= Math.hypot(a.vx - b.vx, a.vy - b.vy, a.vz - b.vz) * h * 1.5 + TOUCH) continue
      const c = contact(MARBLE - j, i, dx / d, dy / d, dz / d, d - a.r - b.r, b.x + (dx / d) * b.r, b.y + (dy / d) * b.r, b.z + (dz / d) * b.r, 0, false)
      c.b = j
      contacts.push(c)
    }
  }
  // Each contact's start. New, and closing within the step, it's a knock (at the moment it touches), bounced once it
  // touches. Caught by two edges or more at once (dropped into a cup), a marble doesn't bounce off them: it settles,
  // after a small hop straight up (once it's in).
  const caught = new Set<number>()
  const rims = new Map<number, number>()
  for (const c of contacts) {
    const vn = normalSpeed(bodies, c)
    c.vn = vn
    const t = touchOf(bodies[c.a].o, c)
    c.knock = t ? t.knock : 0
    if (!t && vn < 0 && c.gap + vn * h <= TOUCH) {
      const speed = -vn
      knocks.push(knockOf(bodies, c, speed, c.gap > 0 ? Math.min(h, c.gap / speed) : 0))
      c.knock = speed
      if (c.b < 0 && c.id >= 0 && c.ny > 0.5 && c.ny < 0.9999) rims.set(c.a, (rims.get(c.a) ?? 0) + 1)
    }
  }
  for (const [i, k] of rims) {
    if (k < 2) continue
    caught.add(i)
    const o = bodies[i].o
    if (!o.flying) mems[i].caught = Math.max(mems[i].caught, -o.vy)
  }
  // The least speed away from each: any gap left closes within the step, never more; a knock bounces once it touches.
  for (const c of contacts) {
    if (caught.has(c.a) && c.b < 0) c.knock = 0
    c.min = -Math.max(0, c.gap) / h
    if (c.gap <= TOUCH && c.knock > 0) { c.min = Math.max(c.min, bounce(bodies, c, c.knock)); c.knock = 0 }
  }
  // Each starts from what it took last step.
  for (const c of contacts) {
    const t = touchOf(bodies[c.a].o, c)
    if (!t || t.lambda <= 0) continue
    c.lambda = t.lambda * 0.85
    impulse(bodies, c, c.lambda)
  }
  // The solve: every contact pushes only away, and only as much as it must.
  for (let it = 0; it < ITERATIONS; it++) {
    for (const c of contacts) {
      const next = Math.max(0, c.lambda + (c.min - normalSpeed(bodies, c)) * (c.b >= 0 ? 0.5 : 1))
      const dl = next - c.lambda
      if (dl === 0) continue
      c.lambda = next
      impulse(bodies, c, dl)
    }
  }
  for (const c of contacts) c.end = c.gap + normalSpeed(bodies, c) * h
  // Rolling on what holds it up; then it moves: free in the air along its exact arc, else as the solve left it.
  for (let i = 0; i < n; i++) {
    if (!awake[i]) continue
    const o = bodies[i].o
    const m = mems[i]
    let sx = 0, sy = 0, sz = 0, edges = 0, faces = 0, bounced = false, pushed = false, arrive = h
    // Knocked off course: a knock this step against a side, a wall or another marble (not a wall it's only kept in by;
    // nor the side of the raised thing it's hopping up onto, which it rises along).
    const onto = o.flying && o.aim ? surfaceAt(fps, o.aim.x, o.aim.z).id : FLOOR
    const off = o.flying && knocks.some((k) => (k.i === i && k.kind !== 'land' && !(k.kind === 'bump' && k.id === onto && k.id !== FLOOR)) || (k.kind === 'marble' && k.id === i))
    for (const c of contacts) {
      if ((c.a !== i && c.b !== i) || c.lambda <= 0) continue
      pushed = true
      const s = c.a === i ? 1 : -1
      const ny = s * c.ny
      if (ny <= 0.2) continue
      sx += s * c.nx * c.lambda; sy += ny * c.lambda; sz += s * c.nz * c.lambda
      if (c.min > 0) bounced = true
      // (When within the step it reached what's under it: a precise hop comes down exactly there.)
      if (c.b < 0 && c.vn < 0) arrive = Math.min(arrive, Math.max(0, c.gap) / -c.vn)
      if (ny > 0.9999 || c.b >= 0) faces++; else edges++
    }
    const landing = o.flying && sy > 0
    // (A precise hop's landing doesn't bounce, now or once it touches.)
    if (landing) { o.flying = false; o.aim = null; for (const c of contacts) if (c.a === i && c.b < 0) c.knock = 0 }
    // Knocked off course: the route is off.
    else if (off) { o.flying = false; o.aim = null; o.route = [] }
    const load = Math.hypot(sx, sy, sz)
    m.load = sy > 0.2 * G * h ? sy : 0
    m.cup = m.load > 0 && faces === 0 && edges >= 2
    o.held = m.cup
    if (m.load > 0 && !landing) {
      const ux = sx / load, uy = sy / load, uz = sz / load
      const vn = o.vx * ux + o.vy * uy + o.vz * uz
      let tx = o.vx - vn * ux, ty = o.vy - vn * uy, tz = o.vz - vn * uz
      let t = Math.hypot(tx, ty, tz)
      // A real bounce loses some of its sideways speed to the surface's grip.
      if (bounced) { tx *= GRIP; ty *= GRIP; tz *= GRIP; t *= GRIP }
      // (Steered, its spring and its damping are all there is: it goes exactly where it's pointed.)
      const stick = o.target ? 0 : STICK, roll = o.target ? 0 : ROLL
      if (m.stuck && t <= stick * m.load) { tx = ty = tz = 0 }
      else {
        m.stuck = false
        const k = t > 1e-12 ? Math.max(0, t - roll * m.load) / t : 0
        if (k === 0) m.stuck = true
        // Rolling to a stop when nothing steers it (in a cup, soon, unless it's leaving).
        const f = o.target ? 1 : Math.exp(-(m.cup && m.climb !== CUP ? CUP_FRICTION : FRICTION) * h)
        tx *= k * f; ty *= k * f; tz *= k * f
      }
      o.vx = vn * ux + tx; o.vy = vn * uy + ty; o.vz = vn * uz + tz
    } else if (m.load === 0) m.stuck = false
    // (A precise hop flies as fast as its spot needs, however far.)
    const sp = Math.hypot(o.vx, o.vz)
    if (sp > MAX_SPEED && !o.flying) { o.vx *= MAX_SPEED / sp; o.vz *= MAX_SPEED / sp }
    const [ax, ay, az] = v0[i]
    if (landing) {
      // A precise hop comes down dead where it lands: on its arc, at the moment it touches (its spot, exactly).
      o.x += ax * arrive; o.z += az * arrive; o.y += o.vy * h
      o.vx = o.vy = o.vz = 0
    } else if (!pushed) { o.x += ((ax + o.vx) / 2) * h; o.y += ((ay + o.vy) / 2) * h; o.z += ((az + o.vz) / 2) * h }
    else { o.x += o.vx * h; o.y += o.vy * h; o.z += o.vz * h }
  }
  // What overlap is left, taken out: the least move that clears everything, eased (at most MAX_FIX a step).
  for (let i = 0; i < n; i++) if (awake[i]) settle(bodies[i].o, i, fps, env, bodies[i].opts.climb ?? 0)
  for (const c of contacts) {
    if (c.b < 0) continue
    const a = bodies[c.a].o, b = bodies[c.b].o
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
    const d = Math.hypot(dx, dy, dz), over = a.r + b.r - d - SLOP
    if (over <= 0 || d < 1e-9) continue
    const k = Math.min(over, MAX_FIX) / 2 / d
    a.x += dx * k; a.y += dy * k; a.z += dz * k
    b.x -= dx * k; b.y -= dy * k; b.z -= dz * k
  }
  // What each touches now, for the next step; asleep, once it's been still and held a moment.
  for (let i = 0; i < n; i++) {
    if (!awake[i]) continue
    const o = bodies[i].o
    const m = mems[i]
    const touch: Touch[] = []
    for (const c of contacts) {
      if (c.a !== i && c.b !== i) continue
      if (c.end > TOUCH && c.knock === 0) continue
      // (Two marbles each keep it, each its own way round.)
      const s = c.a === i ? 1 : -1
      touch.push({ id: c.a === i ? c.id : MARBLE - c.a, nx: s * c.nx, ny: s * c.ny, nz: s * c.nz, lambda: c.lambda, knock: c.a === i ? c.knock : 0 })
    }
    m.touch = touch
    const slow = Math.hypot(o.vx, o.vy, o.vz) < SLEEP_V
    m.still = slow && m.load > 0 && !o.flying && !o.route.length && !o.toss && m.climb === null ? m.still + h : 0
    if (m.still >= SLEEP_T) { o.vx = o.vy = o.vz = 0; o.resting = true; m.stuck = true }
    m.x = o.x; m.y = o.y; m.z = o.z
  }
  knocks.sort((p, q) => p.t - q.t)
  return knocks
}

/** A marble's memory: made, or started over if it was moved since. */
function memOf(o: Orb): Mem {
  const m = o.mem
  if (m && m.x === o.x && m.y === o.y && m.z === o.z) return m
  const fresh: Mem = { x: o.x, y: o.y, z: o.z, touch: [], load: 0, cup: false, stuck: false, still: 0, strain: 0, climb: null, caught: 0 }
  o.mem = fresh
  return fresh
}

/** What it touched last step that's this contact (the same thing, facing much the same way). */
function touchOf(o: Orb, c: Contact): Touch | undefined {
  return o.mem?.touch.find((t) => t.id === c.id && t.nx * c.nx + t.ny * c.ny + t.nz * c.nz > 0.9)
}

/**
 * Asleep: should it wake? When it has somewhere to go (a route, a toss), a climb it's pushed into (steering, or a tilt
 * held STRAIN), or when what it touches can't hold it against what pushes it now (its weight, the tilt, its steering):
 * a step tried from still, against the contacts it rests on, that static friction doesn't hold.
 */
function wake(o: Orb, opts: StepOptions, fps: readonly Footprint[], env: Env, h: number): boolean {
  if (o.route.length || o.toss) return true
  const m = memOf(o)
  if (!m.load || !m.touch.length) return true
  const [ax, az] = pull(o, opts, true)
  if (ax || az || o.target) {
    const cs: Contact[] = []
    gather(o, 0, fps, env, TOUCH, opts.climb ?? 0, cs)
    if (meant(o, opts, cs, 0, fps, m)) {
      if (o.target) return true
      m.strain += h
      if (m.strain >= STRAIN) return true
    } else m.strain = 0
  }
  // A step from still: its weight and the pushes, against what it rests on (each pushing only away, as in the solve).
  let vx = ax * h, vy = -G * h, vz = az * h
  const lambda = m.touch.map(() => 0)
  for (let it = 0; it < ITERATIONS; it++) {
    m.touch.forEach((t, k) => {
      const next = Math.max(0, lambda[k] - (vx * t.nx + vy * t.ny + vz * t.nz))
      const dl = next - lambda[k]
      lambda[k] = next
      vx += dl * t.nx; vy += dl * t.ny; vz += dl * t.nz
    })
  }
  return Math.hypot(vx, vy, vz) > (o.target ? AIMED : STICK) * G * h
}

/**
 * Whether it's meant to go over this step's edge, and how much (0: not). Steered, when its target is past the edge, that
 * way: always, however near the target. Tilted, when the tilt presses it into the edge past the step's threshold (once
 * going, KEEP of it), within about 60° of the way over.
 */
function drive(o: Orb, c: Contact, push: readonly [number, number] | undefined, going: boolean): number {
  if (!c.over || !c.step) return 0
  const hl = Math.hypot(c.nx, c.nz)
  if (hl < 1e-6) return 0
  const ux = -c.nx / hl, uz = -c.nz / hl
  if (o.target) {
    const tx = o.target.x - o.x, tz = o.target.z - o.z
    const along = tx * ux + tz * uz
    const edge = (c.px - o.x) * ux + (c.pz - o.z) * uz
    return along >= edge && along >= TOWARD * Math.hypot(tx, tz) ? c.over + along : 0
  }
  if (!push) return 0
  const along = push[0] * ux + push[1] * uz
  return along >= (going ? c.over * KEEP : c.over) && along >= TOWARD * Math.hypot(push[0], push[1]) ? along : 0
}

/**
 * What it's meant to be helped over now: a step's edge (that contact), or the cup it's in, or nothing. A cup: a counter
 * it's in (on its rim, or down in its pit), or edges holding it up from both sides, as in a gap between two letters
 * (or, once it's leaving, any edge still under it). It's meant to leave one steered somewhere else (CUP_OUT off, and
 * not elsewhere in the same counter: pointing always gets it out), or tilted past BREAK (KEEP of it once going) any
 * way at all: the rim turns it up and over.
 */
function meant(o: Orb, opts: StepOptions, cs: readonly Contact[], from: number, fps: readonly Footprint[], m: Mem): { edge?: Contact; cup?: true } | null {
  let best: Contact | null = null, most = 0, rim: Contact | null = null
  for (let k = from; k < cs.length; k++) {
    const c = cs[k]
    if (c.gap > TOUCH * 2 || !c.over) continue
    if (c.step) { const d = drive(o, c, opts.push, m.climb === c.id); if (d > most) { best = c; most = d } }
    else rim = c
  }
  if (best) return { edge: best }
  if (!rim) return null
  const id = rim.id
  const letter = fps.find((f) => f.id === id)
  const hole = letter ? counterOf(letter, o.x, o.z) : null
  if (!hole && !m.cup && m.climb !== CUP) return null
  if (o.target) {
    // Out of a counter: steered anywhere not over it. Out of a gap: steered far enough off to mean it.
    if (hole && letter) return counterOf(letter, o.target.x, o.target.z) === hole ? null : { cup: true }
    return Math.hypot(o.target.x - o.x, o.target.z - o.z) >= (m.climb === CUP ? CUP_OUT * 0.2 : CUP_OUT) ? { cup: true } : null
  }
  const push = opts.push ? Math.hypot(opts.push[0], opts.push[1]) : 0
  return push >= (m.climb === CUP ? BREAK * KEEP : BREAK) ? { cup: true } : null
}

/**
 * A precise hop to `to`: how fast it leaves upward (em/s), and where it's headed first. It passes over any raised thing
 * on the way (a step it doesn't leave from or land on), its bottom over the top everywhere it's within its radius of
 * it: rising higher than StepOptions.hop where it must, up to HOP_OVER. Where even that doesn't clear one (it's right
 * beside it), it hops up onto the first one in the way instead, to go on from there.
 */
function launch(o: Orb, to: { x: number; z: number }, fps: readonly Footprint[], opts: StepOptions): { vy: number; to: { x: number; z: number } } {
  const base = Math.sqrt(2 * G * opts.hop), most = Math.sqrt(2 * G * Math.max(opts.hop, HOP_OVER))
  const dx = to.x - o.x, dz = to.z - o.z, d = Math.hypot(dx, dz)
  const climb = opts.climb ?? 0
  const steps = fps.filter((fp) => (fp.step ?? fp.height <= climb) && !inside(fp, o.x, o.z) && !inside(fp, to.x, to.z) &&
    fp.box[0] - o.r <= Math.max(o.x, to.x) && fp.box[2] + o.r >= Math.min(o.x, to.x) && fp.box[1] - o.r <= Math.max(o.z, to.z) && fp.box[3] + o.r >= Math.min(o.z, to.z))
  if (!steps.length || d < 1e-6) return { vy: base, to }
  const y1 = surfaceAt(fps, to.x, to.z).h
  /** Along the way, every third of a radius: where it is (em along), and over which of them, if any, it's too low. */
  const clears = (vy: number) => {
    const t1 = flightTime(vy, o.y - o.r, y1)
    for (let s = 0; s <= d; s += o.r / 3) {
      const t = (s / d) * t1
      const bottom = o.y - o.r + vy * t - (G * t * t) / 2
      const px = o.x + (dx * s) / d, pz = o.z + (dz * s) / d
      for (const fp of steps) if (bottom < fp.height + 0.02 && (inside(fp, px, pz) || nearest(fp, px, pz).d < o.r)) return false
    }
    return true
  }
  for (let vy = base; vy <= most + 1e-9; vy += 0.25) if (clears(vy)) return { vy, to }
  // Onto the first one in the way: a radius and a bit inside its edge, along the way (or its middle, if it's narrower).
  for (let s = 0; s <= d; s += o.r / 6) {
    const px = o.x + (dx * s) / d, pz = o.z + (dz * s) / d
    const fp = steps.find((f) => inside(f, px, pz))
    if (!fp) continue
    const k = s + o.r + 0.05
    const qx = o.x + (dx * k) / d, qz = o.z + (dz * k) / d
    return { vy: base, to: inside(fp, qx, qz) && nearest(fp, qx, qz).d > o.r * 0.5 ? { x: qx, z: qz } : { x: fp.spot[0], z: fp.spot[1] } }
  }
  return { vy: most, to }
}

/** What pulls it sideways now (em/s²): the tilt, and its steering (a spring toward its target, damped). */
function pull(o: Orb, opts: StepOptions, grounded: boolean): [number, number] {
  if (o.flying) return [0, 0]
  let ax = 0, az = 0
  if (o.target) {
    const w = opts.omega ?? 7, zeta = opts.zeta ?? 0.9
    const k = grounded ? 1 : opts.air ?? 1
    ax += k * (w * w * (o.target.x - o.x) - 2 * zeta * w * o.vx)
    az += k * (w * w * (o.target.z - o.z) - 2 * zeta * w * o.vz)
  }
  if (opts.push) { ax += opts.push[0]; az += opts.push[1] }
  return [ax, az]
}

/**
 * Its forces for a step: its weight, the tilt and its steering (none on a precise hop), and, when it's meant to go over
 * something (meant()), a hand's help once the tilt has been held STRAIN (steering, and a climb under way, at once): up
 * a step, square to where it touches it (up its side, then round its edge and over), as much as its weight pulls it
 * back down that way, and what pushes it into the step turned that way too (the step would only take it: against a
 * block's side, that's all that lifts it); out of a cup, its weight carried while the push rolls it up the rim and over
 * (once it's out, it drops back onto whatever's there).
 */
function forces(o: Orb, opts: StepOptions, cs: Contact[], first: number, m: Mem, fps: readonly Footprint[], h: number) {
  const [ax, az] = pull(o, opts, m.load > 0)
  let fx = ax, fy = -G, fz = az
  const want = meant(o, opts, cs, first, fps, m)
  if (want) {
    const id = want.edge ? want.edge.id : CUP
    m.strain = o.target || m.climb === id ? STRAIN : m.strain + h
    if (m.strain >= STRAIN) {
      m.climb = id
      const e = want.edge
      if (e) {
        // Up along the step, square to the contact: its weight's pull back down that way taken off, and what pushes it
        // into the step turned that way.
        let tx = -e.ny * e.nx, ty = 1 - e.ny * e.ny, tz = -e.ny * e.nz
        const tl = Math.hypot(tx, ty, tz), hl = Math.hypot(e.nx, e.nz)
        if (tl > 1e-9 && hl > 1e-9) {
          tx /= tl; ty /= tl; tz /= tl
          // (The push, only as far as it lifts it no faster than CLIMB_V along the step: it rolls over the edge,
          // rather than flying off it.)
          const into = Math.max(0, -(ax * e.nx + az * e.nz) / hl) * Math.max(0, 1 - (o.vx * tx + o.vy * ty + o.vz * tz) / CLIMB_V)
          const lift = (G + into) * ty
          fx += lift * tx; fy += lift * ty; fz += lift * tz
        }
      } else fy += G
    }
  } else { m.strain = 0; m.climb = null }
  o.vx += fx * h
  o.vy += fy * h
  o.vz += fz * h
}

/** How fast the marble moves away from what it touches, along the contact (negative: toward it). */
function normalSpeed(bodies: readonly Body[], c: Contact): number {
  const a = bodies[c.a].o
  let vx = a.vx, vy = a.vy, vz = a.vz
  if (c.b >= 0) { const b = bodies[c.b].o; vx -= b.vx; vy -= b.vy; vz -= b.vz }
  return vx * c.nx + vy * c.ny + vz * c.nz + c.gy * vy
}

function impulse(bodies: readonly Body[], c: Contact, dl: number) {
  const a = bodies[c.a].o
  a.vx += dl * c.nx; a.vy += dl * c.ny; a.vz += dl * c.nz
  if (c.b >= 0) { const b = bodies[c.b].o; b.vx -= dl * c.nx; b.vy -= dl * c.ny; b.vz -= dl * c.nz }
}

/**
 * The speed a struck contact leaves at: coming down on something, SETTLE of it (none from a small fall; on an edge,
 * less the more it glances off it); into a side (a step's too) or a wall, BUMP of it from LEAN; a step's edge, none;
 * two marbles, CLINK. A precise hop doesn't bounce.
 */
function bounce(bodies: readonly Body[], c: Contact, speed: number): number {
  const o = bodies[c.a].o
  if (c.b >= 0) return speed > CLINK_V ? CLINK * speed : 0
  if (c.ny > 0.5) {
    const e = SETTLE * c.ny * c.ny
    return o.flying || speed * e < REST_VY ? 0 : e * speed
  }
  return (c.step && c.ny > 1e-6) || speed <= LEAN ? 0 : BUMP * speed
}

function knockOf(bodies: readonly Body[], c: Contact, speed: number, t: number): Knock {
  const o = bodies[c.a].o
  // Coming down on it (falling onto it, not rolled into it from the side) is a landing.
  const down = c.ny > 0.5 && o.vy < -FALLING
  const kind: Knock['kind'] = c.b >= 0 ? 'marble' : c.id <= WALL ? 'wall' : down ? 'land' : 'bump'
  const id = c.b >= 0 ? c.b : kind === 'wall' ? WALL - c.id : c.id
  const k: Knock = { t, i: c.a, kind, id, speed, x: c.px, y: c.py, z: c.pz, nx: c.nx, ny: c.ny, nz: c.nz }
  if (o.flying && kind === 'land') k.hop = true
  return k
}

function contact(id: number, a: number, nx: number, ny: number, nz: number, gap: number, px: number, py: number, pz: number, over: number, step: boolean): Contact {
  return { id, a, b: -1, nx, ny, nz, gap, gy: 0, px, py, pz, over, step, lambda: 0, min: 0, knock: 0, end: gap, vn: 0 }
}

/**
 * Everything within `reach` of the marble's surface: the floor; each footprint (its top, where the marble is over it;
 * else its sides below the top and the rim of its top edge, every place near enough that faces the marble, one for
 * each way they face); and the walls. Footprints `climb` high or lower, or marked as steps, are steps. A precise hop on
 * its way up is clear of the letters' sides: it left from beside one and is over it a moment later (a raised thing's
 * sides it isn't: it was launched to pass over them).
 */
function gather(o: Orb, i: number, fps: readonly Footprint[], env: Env, reach: number, climb: number, out: Contact[]) {
  const { x, y, z, r } = o
  const far = r + reach
  if (y - r < reach) out.push(contact(FLOOR, i, 0, 1, 0, y - r, x, 0, z, 0, false))
  const rising = o.flying && o.vy > 0
  for (const fp of fps) {
    const b = fp.box, top = fp.height
    if (x < b[0] - far || x > b[2] + far || z < b[1] - far || z > b[3] + far || y - r - top >= reach) continue
    if (inside(fp, x, z)) {
      // Over it: its top (found somehow inside it, it's lifted back out onto it).
      out.push(contact(fp.id, i, 0, 1, 0, y - top - r, x, top, z, 0, false))
      continue
    }
    const step = fp.step ?? top <= climb
    if (rising && !step) continue
    // Something it can be helped over: a step, from beside it (its side, or its edge); a cup's rim (a counter's; or any
    // letter's edge while the marble is up off the floor on edges, as in a gap between two letters). A letter's
    // outside, from the floor, is a wall.
    const over = step ? Math.max(MEANT, LIFT_PER_EM * top) : counterOf(fp, x, z) || y - r > ABOVE ? BREAK : 0
    const from = out.length
    for (const ring of fp.rings) {
      const m = ring.length / 2
      for (let k = 0, j = m - 1; k < m; j = k++) {
        const ax = ring[j * 2], az = ring[j * 2 + 1], ex = ring[k * 2] - ax, ez = ring[k * 2 + 1] - az
        const l2 = ex * ex + ez * ez || 1e-12
        const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2))
        const qx = ax + ex * t, qz = az + ez * t
        const dx = x - qx, dz = z - qz
        const s = Math.hypot(dx, dz)
        const above = Math.max(0, y - top)
        const d = Math.hypot(s, above)
        if (d - r >= reach) continue
        // The way from the outline out to the marble; a stretch whose outside faces away (seen through the letter,
        // from across a stroke) isn't touched.
        let hx: number, hz: number
        if (s > 1e-9) { hx = dx / s; hz = dz / s } else {
          const el = Math.sqrt(l2)
          hx = ez / el; hz = -ex / el
          if (inside(fp, qx + hx * 1e-4, qz + hz * 1e-4)) { hx = -hx; hz = -hz }
        }
        if (inside(fp, qx + hx * 1e-4, qz + hz * 1e-4)) continue
        const c = d > 1e-9
          ? contact(fp.id, i, (hx * s) / d, above / d, (hz * s) / d, d - r, qx, Math.min(y, top), qz, y > top || step ? over : 0, step)
          : contact(fp.id, i, 0, 1, 0, -r, qx, top, qz, over, step)
        // One contact for each way it faces: a curved outline is many short stretches, several near enough.
        let dup = false
        for (let q = from; q < out.length; q++) {
          const p = out[q]
          if (p.nx * c.nx + p.ny * c.ny + p.nz * c.nz > 0.966 && Math.hypot(p.px - c.px, p.pz - c.pz) < 0.35 * r) {
            if (c.gap < p.gap) out[q] = c
            dup = true
            break
          }
        }
        if (!dup) out.push(c)
      }
    }
    // The nearest few at most.
    if (out.length - from > 8) out.push(...out.splice(from).sort((p, q) => p.gap - q.gap).slice(0, 8))
  }
  // The walls: the marble as drawn (bigger the higher it is) against each, set back along the floor.
  const lift = Math.max(0, y - r)
  const rho = r * (1 + env.grow * lift)
  env.walls.forEach((w, k) => {
    const hl = Math.hypot(w.n[0], w.n[2])
    if (hl < 1e-6) return
    const gap = (w.n[0] * x + w.n[1] * y + w.n[2] * z + w.d - rho) / hl
    if (gap >= reach) return
    const nx = w.n[0] / hl, nz = w.n[2] / hl
    const c = contact(WALL - k, i, nx, 0, nz, gap, x - nx * (gap + rho), y, z - nz * (gap + rho), 0, false)
    // Rising, the plane's lean and the marble's growth close or open the gap too.
    c.gy = (w.n[1] - (y > r ? r * env.grow : 0)) / hl
    out.push(c)
  })
}

/**
 * Overlap left after a step, taken out: the least move of the marble that clears everything it overlaps (within SLOP
 * it's left be), at most MAX_FIX a step, found again after each move (edges are round). Whatever speed it had into
 * them is gone.
 */
function settle(o: Orb, i: number, fps: readonly Footprint[], env: Env, climb: number) {
  for (let pass = 0; pass < 3; pass++) {
    const cs: Contact[] = []
    gather(o, i, fps, env, 0, climb, cs)
    const over = cs.filter((c) => c.gap < -SLOP)
    if (!over.length) return
    // The least move d with n·d ≥ −(gap + SLOP) for each: one constraint at a time, round and round (Hildreth).
    const mu = over.map(() => 0)
    let dx = 0, dy = 0, dz = 0
    for (let it = 0; it < 40; it++) {
      let change = 0
      over.forEach((c, k) => {
        const need = -(c.gap + SLOP) - (c.nx * dx + c.ny * dy + c.nz * dz)
        const d = Math.max(-mu[k], need)
        if (d === 0) return
        mu[k] += d
        dx += d * c.nx; dy += d * c.ny; dz += d * c.nz
        change = Math.max(change, Math.abs(d))
      })
      if (change < 1e-9) break
    }
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-12) return
    const k = Math.min(1, MAX_FIX / len)
    o.x += dx * k; o.y += dy * k; o.z += dz * k
    for (const c of over) {
      const vn = o.vx * c.nx + o.vy * c.ny + o.vz * c.nz
      if (vn < 0) { o.vx -= vn * c.nx; o.vy -= vn * c.ny; o.vz -= vn * c.nz }
    }
    if (k < 1) return
  }
}
