/**
 * The hero's marbles and what they move among, without drawing anything (./field.ts draws it): the headline's letters
 * laid out as the page wraps them, the camera fitted so they fill the headline's place on the page, the edges of what's
 * on screen as walls, the page's raised things (its buttons, the hint, the sound control, the steps' icons) as steps,
 * and the marbles, moved in the physics' fixed steps (./bounce.ts) whatever the frame rate, with what they struck and
 * the moment each happened. Drawn, a marble is where it was between its last two steps, as far between them as the
 * frame is (so its motion is smooth at any frame rate, a step behind at most). Three.js math only: the physics
 * harness (tests/harness) runs exactly this.
 */
import { OrthographicCamera, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three'
import { counterOf, FLOOR, H, inside, nearest, newOrb, roundedRect, surfaceAt, tick, toss, withinWalls, type Body, type Env, type Footprint, type Knock, type Orb, type StepOptions, type Wall } from './bounce'
import { layoutLetters, TOP, tourStops, type LaidLetter } from './letters'

/** A marble's size, in em. */
export const ORB_R = 0.2
/** The height of a precise hop (a tap, a click, the opening). */
export const HOP = 0.8
/** The camera: its field of view, and how steeply it looks down (degrees above the horizon). */
export const FOV = 30
export const ELEVATION = 56
/** How much bigger a marble looks per em it rises (it's nearer the eye): the overhead view's depth. */
export const DEPTH = 0.3
/** A marble has weight: it follows its steering on a soft spring, and in the air mostly keeps its momentum. */
const STEER = { omega: 4.6, zeta: 0.78, air: 0.3 }
/**
 * The page's raised things are blocks this high (em: half as tall again as a marble's radius, and taller than the
 * letters): a marble knocks off one's side, and needs a clear tilt, about 13°, or a point, to be helped up onto it. They
 * are steps (./bounce.ts Footprint.step) whatever their height; the letters never are (a marble hops onto a letter).
 */
export const PAD_H = 0.3
/** A raised thing's footprint id is this plus its index (letters count from 0). */
export const PAD_ID = 1000
/** Hits slower than this (em/s) aren't reported at all. */
const REPORT = 0.05
/**
 * A marble's knocks on one thing within this long of the first (s) are one impact: a marble dropped onto a rim touches
 * it in two places, within a step or two. It's heard once.
 */
const ONE_KNOCK = 0.012
/**
 * Knocks slower than this (em/s) are silent; knocks between marbles from MARBLE_MIN. A knock against the edge of the
 * screen from WALL_MIN: a phone tipped 3° rolls a marble into an edge at about 0.5 em/s, 2.5° at 0.4. (Rolling along
 * it or leaning on it isn't a knock at all: only a contact that begins is.)
 */
export const HIT_MIN = 0.6
export const WALL_MIN = 0.3
const MARBLE_MIN = HIT_MIN * 0.6
/**
 * A knock foreseen is started ahead (./glass.ts) only this much over what's heard: one nearer may come a little softer
 * and not be heard at all, and it's quiet enough to be heard as it comes.
 */
const SURE = 1.25
/** A frame longer than this (s: a tab come back, a long stall) is caught up only this far. */
const CATCH_UP = 0.12

export type HitKind = 'letter' | 'floor' | 'marble' | 'button' | 'wall'
/**
 * A marble hit something: what (a letter, a button: which; the floor; the edge of the screen: a wall; another marble),
 * how fast it came in (em/s), whether it came down on it (a landing) or ran into it, where it touched and which way
 * (from what it struck toward the marble), and when (s on the world's clock: the moment within its step).
 */
export interface WorldHit {
  orb: string
  other?: string
  kind: HitKind
  letter?: number
  pad?: number
  wall?: number
  speed: number
  landed: boolean
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  t: number
  /** Arriving on a raised thing without a knock (rolled up onto it): a soft tap as it takes the marble's weight. */
  soft?: boolean
}

/** How fast a knock must come in to be heard (em/s). */
const hearing = (h: WorldHit) => (h.kind === 'wall' ? WALL_MIN : h.kind === 'marble' ? MARBLE_MIN : HIT_MIN)
/** Whether a hit is heard: a knock hard enough, or a soft arrival on a raised thing (heard as a soft tap). */
export const heard = (h: WorldHit) => !!h.soft || h.speed > hearing(h)
/** Whether a knock foreseen is sure enough of being heard to start ahead: well over what's heard. */
export const foreseeable = (h: WorldHit) => !h.soft && h.speed > SURE * hearing(h)
/** A hit's name: the marble and what it struck (the same for a knock foreseen and the knock itself). */
export const keyOf = (h: WorldHit) => `${h.orb}|${h.kind}|${h.letter ?? h.pad ?? h.wall ?? h.other ?? ''}`

/** A button in the hero, as the marbles' world sees it: its box on the canvas (CSS px) and its corners' radius. */
export interface PadRect { x: number; y: number; w: number; h: number; r: number; height?: number; rings?: number[][]; step?: boolean }

export interface WorldMarble {
  id: string
  orb: Orb
  /** The tilt pushing it, if any (em/s²): set every frame. Its steering is orb.target. */
  push: [number, number] | null
  /** Where its last two steps left it (em), and where it's drawn: between them, as far as the frame is. */
  was: [number, number, number]
  now: [number, number, number]
  shown: [number, number, number]
  /** What it last stood on (a surface's id), so arriving on a button is noticed. */
  on: number
}

export interface World {
  readonly camera: PerspectiveCamera | OrthographicCamera
  /** The canvas's size (CSS px). */
  readonly size: [number, number]
  /** The letters as laid out (their shapes, for drawing), their footprints, and the raised things'. */
  readonly laid: LaidLetter[]
  readonly footprints: Footprint[]
  readonly pads: Footprint[]
  /** What the camera sees of the floor (for the dots), and the walls the marbles keep inside. */
  readonly bounds: [number, number, number, number]
  readonly walls: Wall[]
  /** The world's clock (s): its steps so far, and how far into the next step the frame is (0…1). */
  readonly clock: number
  readonly alpha: number
  /** How far the view is shifted to set the letters where the headline is (canvas px), and how far off it looks down. */
  readonly view: { x: number; y: number; dist: number }
  /** Lay the headline out as the page wraps it (lines of text), fitted into `box` (px, within the canvas). Returns whether the letters changed. */
  layout(lines: string[], W: number, H: number, box: { x: number; y: number; w: number; h: number }): boolean
  /** The raised things, where they are now (canvas px; an empty box: not there). Returns whether they moved. */
  setPads(rects: PadRect[]): boolean
  /** Move the cached page through a viewport field, carrying marbles and giving a bounded scroll impulse. */
  scroll(y: number, impulse?: boolean): void
  readonly active: number
  /** What of the canvas the marbles may use, top to bottom (canvas px). */
  play(top: number, bottom: number): void
  /** The floor point under a canvas point, kept inside the walls for a marble resting there. */
  floorAt(sx: number, sy: number): { x: number; z: number }
  /** The point `h` em above the floor under a canvas point. */
  planeAt(sx: number, sy: number, h: number): { x: number; z: number }
  /** What's under a canvas point: a letter's top where it's over one (that letter), a raised thing's top, else the floor (-1). */
  pointAt(sx: number, sy: number): { x: number; z: number; letter: number }
  /** Where a hop aimed at a canvas point lands: on the letter under it or right by it, at its landing spot; else there. */
  spotAt(sx: number, sy: number): { x: number; z: number }
  /** A world point on the canvas (px). */
  project(x: number, y: number, z: number): { x: number; y: number }
  /** The letters in reading order, with where to land on each and which word each is in; the opening's route. */
  letters(): { ch: string; spot: [number, number]; word: number }[]
  /** Each letter's counters: the deepest point of each (the middle of the widest circle in it), and how wide that is. */
  counters(): { letter: number; x: number; z: number; a: number }[]
  /** The gaps between two letters narrower than `width` (em): the middle of each where it's narrowest, and how wide. */
  gaps(width: number): { a: number; b: number; x: number; z: number; w: number }[]
  tour(): { x: number; z: number }[]
  /** What's under a floor point: a letter (its index), a raised thing (PAD_ID + its index) or the floor (-1), and its top. */
  surface(x: number, z: number): { id: number; h: number }
  /** A marble (made on first use, resting on the full stop), the marbles, and one gone. */
  marble(id: string): WorldMarble
  marbles(): WorldMarble[]
  remove(id: string): void
  /** Toss a marble up at `vy` (em/s): now if it's on something, else as soon as it touches down. */
  toss(m: WorldMarble, vy: number): void
  /** Wake every marble (something about the world changed). */
  wake(): void
  /** Advance by dt (s): whole steps, each H; returns what was struck, in order, and whether anything still moves. */
  step(dt: number): { hits: WorldHit[]; moving: boolean }
  /** The moment on the world's clock that's drawn now (a step behind the last at most). */
  shownAt(): number
  /**
   * What the marbles will strike within `horizon` s if nothing changes (what moves them now held as it is): stepped on
   * copies of them, from where they are. So a knock can be heard the moment it's seen, on speakers further behind than
   * the screen.
   */
  foresee(horizon: number): WorldHit[]
}

export function createWorld(viewport = true): World {
  // Parallel projection keeps page footprints and marble sizes constant all the way down the document.
  const camera = viewport ? new OrthographicCamera(-1, 1, 1, -1, -20000, 20000) : new PerspectiveCamera(FOV, 1, 0.1, 200)
  const ray = new Raycaster()
  const planes = new Map<number, Plane>()
  const plane = (h: number) => { let p = planes.get(h); if (!p) planes.set(h, (p = new Plane(new Vector3(0, 1, 0), -h))); return p }
  let W = 1, Hc = 1
  let laid: LaidLetter[] = []
  let footprints: Footprint[] = []
  let padRects: PadRect[] = []
  let pads: Footprint[] = []
  let solid: Footprint[] = []
  let bounds: [number, number, number, number] = [-10, -10, 10, 10]
  let walls: Wall[] = []
  let playTop = 0, playBottom = Infinity
  let lastLines = ''
  const view = { x: 0, y: 0, dist: 10 }
  let scroll = 0, baseViewY = 0
  let clock = 0, acc = 0
  const map = new Map<string, WorldMarble>()
  /** Each marble's last knock on each thing, by name (keyOf): when (s on the world's clock). */
  const knocked = new Map<string, number>()
  const env: Env = { walls, grow: DEPTH }

  function rawFloorAt(sx: number, sy: number, h = 0) {
    ray.setFromCamera(new Vector2((sx / W) * 2 - 1, -(sy / Hc) * 2 + 1), camera)
    if (camera instanceof OrthographicCamera) {
      const t = (h - ray.ray.origin.y) / ray.ray.direction.y
      return { x: ray.ray.origin.x + ray.ray.direction.x * t, z: ray.ray.origin.z + ray.ray.direction.z * t }
    }
    const hit = new Vector3()
    return ray.ray.intersectPlane(plane(h), hit) ? { x: hit.x, z: hit.z } : { x: 0, z: 0 }
  }
  /** The way the camera looks through a point on the canvas (px). */
  function lookThrough(sx: number, sy: number): Vector3 {
    ray.setFromCamera(new Vector2((sx / W) * 2 - 1, -(sy / Hc) * 2 + 1), camera)
    return ray.ray.direction.clone()
  }

  function fit(box: { x: number; y: number; w: number; h: number }) {
    const el = (ELEVATION * Math.PI) / 180
    const lb = footprints.reduce((b, f) => [Math.min(b[0], f.box[0]), Math.min(b[1], f.box[1]), Math.max(b[2], f.box[2]), Math.max(b[3], f.box[3])], [Infinity, Infinity, -Infinity, -Infinity])
    const cx = (lb[0] + lb[2]) / 2, cz = (lb[1] + lb[3]) / 2
    if (camera instanceof PerspectiveCamera) camera.aspect = W / Hc
    camera.clearViewOffset()
    // Distance so the block's width fills the box's width (at the block's centre), then the view is shifted so the
    // block's centre lands on the box's centre.
    const tanV = Math.tan(((FOV / 2) * Math.PI) / 180)
    const visW = ((lb[2] - lb[0]) * W) / Math.max(40, box.w)
    const dist = visW / (2 * tanV * (W / Hc))
    if (camera instanceof OrthographicCamera) {
      camera.left = -visW / 2; camera.right = visW / 2
      camera.top = visW * Hc / W / 2; camera.bottom = -camera.top
    }
    camera.position.set(cx, Math.sin(el) * dist, cz + Math.cos(el) * dist)
    camera.lookAt(cx, 0, cz)
    view.x = W / 2 - (box.x + box.w / 2)
    baseViewY = Hc / 2 - (box.y + box.h / 2)
    view.y = baseViewY + scroll
    view.dist = dist
    camera.setViewOffset(W, Hc, view.x, view.y, W, Hc)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
    // What the camera sees of the floor.
    const pts = [[0, 0], [W, 0], [0, Hc], [W, Hc]].map(([sx, sy]) => rawFloorAt(sx, sy))
    bounds = [Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.z)), Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.z))]
    buildWalls()
    buildPads()
  }

  // The edges of the play area, as walls: each is the plane through the camera and one edge of it on the canvas; a
  // sphere touching that plane looks, on screen, like a circle touching that edge.
  function buildWalls() {
    const top = Math.max(0, Math.min(Hc, playTop)), bottom = Math.max(top + 1, Math.min(Hc, playBottom))
    const mid = lookThrough(W / 2, (top + bottom) / 2)
    const eye = camera.position
    const edge = (a: [number, number], b: [number, number]): Wall => {
      let n: Vector3
      let origin = eye
      if (camera instanceof OrthographicCamera) {
        ray.setFromCamera(new Vector2(a[0] / W * 2 - 1, 1 - a[1] / Hc * 2), camera)
        origin = ray.ray.origin.clone()
        ray.setFromCamera(new Vector2(b[0] / W * 2 - 1, 1 - b[1] / Hc * 2), camera)
        n = new Vector3().crossVectors(ray.ray.origin.clone().sub(origin), ray.ray.direction).normalize()
      } else n = new Vector3().crossVectors(lookThrough(a[0], a[1]), lookThrough(b[0], b[1])).normalize()
      if (camera instanceof OrthographicCamera) {
        const centre = rawFloorAt(W / 2, (top + bottom) / 2)
        if (n.dot(new Vector3(centre.x, 0, centre.z).sub(origin)) < 0) n.negate()
      } else if (n.dot(mid) < 0) n.negate()
      return { n: [n.x, n.y, n.z], d: -n.dot(origin) }
    }
    walls = [edge([0, top], [0, bottom]), edge([W, top], [W, bottom]), edge([0, top], [W, top]), edge([0, bottom], [W, bottom])]
    env.walls = walls
  }

  // The raised things as steps: each one's top is its box on screen, found on the plane at its height.
  function buildPads() {
    pads = padRects.flatMap((b, i): Footprint[] => {
      if (b.w <= 0 || b.h <= 0) return []
      const height = b.height ?? PAD_H
      const outlines = b.rings ?? [roundedRect(b.x, b.y, b.w, b.h, b.r, 4)]
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity
      const rings = outlines.map((pts) => {
        const ring = new Float64Array(pts.length)
        for (let k = 0; k < pts.length; k += 2) {
          const p = rawFloorAt(pts[k], pts[k + 1] - scroll, height)
          ring[k] = p.x; ring[k + 1] = p.z
          x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z)
        }
        return ring
      })
      const c = rawFloorAt(b.x + b.w / 2, b.y + b.h / 2 - scroll, height)
      return [{ id: PAD_ID + i, height, box: [x0, z0, x1, z1], rings, spot: [c.x, c.z], step: b.step ?? true }]
    })
    cull()
  }

  function cull() {
    if (!viewport) { solid = [...footprints, ...pads]; return }
    const margin = 100
    solid = [...footprints.filter((fp) => {
      const p = project(fp.spot[0], fp.height, fp.spot[1])
      return p.y > -margin && p.y < Hc + margin
    }), ...pads.filter((fp) => {
      const b = padRects[fp.id - PAD_ID]
      return b.y + b.h >= scroll - margin && b.y <= scroll + Hc + margin
    })]
  }

  function contain() {
    for (const m of map.values()) {
      const o = m.orb
      const p = withinWalls(walls, o.x, o.y, o.z, o.r * (1 + DEPTH * Math.max(0, o.y - o.r)))
      o.x = p.x; o.z = p.z
      m.was = m.now = m.shown = [o.x, o.y, o.z]
    }
  }

  const project = (x: number, y: number, z: number) => {
    const v = new Vector3(x, y, z).project(camera)
    return { x: ((v.x + 1) / 2) * W, y: ((1 - v.y) / 2) * Hc }
  }
  const lerp3 = (a: [number, number, number], b: [number, number, number], k: number): [number, number, number] => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

  const world: World = {
    camera,
    get size() { return [W, Hc] as [number, number] },
    get laid() { return laid },
    get footprints() { return footprints },
    get pads() { return pads },
    get bounds() { return bounds },
    get walls() { return walls },
    get clock() { return clock },
    get alpha() { return acc / H },
    view,
    get active() { return solid.length },
    scroll(y, impulse = true) {
      if (!viewport || y === scroll) return
      const old = scroll
      const positions = [...map.values()].map((m) => ({ m, p: project(m.orb.x, m.orb.y, m.orb.z) }))
      scroll = y
      view.y = baseViewY + scroll
      camera.setViewOffset(W, Hc, view.x, view.y, W, Hc)
      camera.updateProjectionMatrix(); camera.updateMatrixWorld()
      buildWalls(); cull()
      for (const { m, p } of positions) {
        const o = m.orb, at = rawFloorAt(p.x, p.y, o.y)
        o.x = at.x; o.z = at.z
        o.route = []; o.flying = false; o.aim = null; o.target = null
        if (impulse) { o.vz += Math.max(-1.2, Math.min(1.2, (scroll - old) * -0.002)); o.resting = false }
        delete o.mem
      }
      contain()
    },
    layout(lines, w, h, box) {
      W = Math.max(1, w); Hc = Math.max(1, h)
      const k = lines.join('\n')
      const changed = k !== lastLines
      if (changed) {
        laid = layoutLetters(lines)
        footprints = laid.map((l) => l.fp)
        lastLines = k
      }
      fit(box)
      // Marbles stay where they were, on whatever is under them now (inside a letter now, they ease out onto it).
      contain()
      world.wake()
      return changed
    },
    setPads(rects) {
      const same = rects.length === padRects.length && rects.every((r, i) => {
        const q = padRects[i]
        return Math.abs(r.x - q.x) + Math.abs(r.y - q.y) + Math.abs(r.w - q.w) + Math.abs(r.h - q.h) + Math.abs(r.r - q.r) < 0.5 && r.height === q.height && r.rings === q.rings
      })
      if (same) return false
      padRects = rects.map((r) => ({ ...r }))
      buildPads()
      // A marble on a raised thing that moved (or went), or by one, is free to roll, or fall, again.
      for (const m of map.values()) if (m.on >= PAD_ID || pads.some((p) => Math.abs(m.orb.x - (p.box[0] + p.box[2]) / 2) < (p.box[2] - p.box[0]) / 2 + 1 && Math.abs(m.orb.z - (p.box[1] + p.box[3]) / 2) < (p.box[3] - p.box[1]) / 2 + 1)) m.orb.resting = false
      return true
    },
    play(top, bottom) {
      if (top === playTop && bottom === playBottom) return
      playTop = top
      playBottom = bottom
      buildWalls()
      contain()
      world.wake()
    },
    floorAt(sx, sy) {
      // Where a marble resting on the floor there would be, kept inside the walls (so a target at the very edge is
      // where it stops, its outline touching the edge).
      const p = rawFloorAt(sx, sy)
      return withinWalls(walls, p.x, ORB_R, p.z, ORB_R)
    },
    planeAt: (sx, sy, h) => rawFloorAt(sx, sy, h),
    pointAt(sx, sy) {
      const t = rawFloorAt(sx, sy, TOP)
      const s = surfaceAt(footprints, t.x, t.z)
      if (s.id >= 0) return { x: t.x, z: t.z, letter: s.id }
      // Over a letter's counter, its opening (a marble can't reach the floor far below it).
      if (footprints.some((fp) => counterOf(fp, t.x, t.z))) return { x: t.x, z: t.z, letter: -1 }
      // A raised thing's top, where it's over one.
      const p = rawFloorAt(sx, sy, PAD_H)
      return surfaceAt(pads, p.x, p.z).id >= 0 ? { x: p.x, z: p.z, letter: -1 } : { ...world.floorAt(sx, sy), letter: -1 }
    },
    spotAt(sx, sy) {
      const p = world.pointAt(sx, sy)
      let best = p.letter, near = ORB_R * 1.2
      if (best < 0) {
        for (const fp of footprints) {
          const b = fp.box
          if (p.x < b[0] - near || p.x > b[2] + near || p.z < b[1] - near || p.z > b[3] + near) continue
          const d = inside(fp, p.x, p.z) ? 0 : nearest(fp, p.x, p.z).d
          if (d < near) { near = d; best = fp.id }
        }
      }
      return best >= 0 ? { x: footprints[best].spot[0], z: footprints[best].spot[1] } : { x: p.x, z: p.z }
    },
    project,
    letters: () => laid.map((l) => ({ ch: l.ch, spot: l.fp.spot, word: l.word })),
    counters() {
      // On a grid over each letter: the point in each of its holes farthest from the hole's outline.
      const out: { letter: number; x: number; z: number; a: number }[] = []
      footprints.forEach((fp, i) => {
        const found = new Map<Float64Array, { x: number; z: number; a: number }>()
        const b = fp.box, n = 60
        for (let u = 0; u <= n; u++) {
          for (let v = 0; v <= n; v++) {
            const x = b[0] + ((b[2] - b[0]) * u) / n, z = b[1] + ((b[3] - b[1]) * v) / n
            const hole = counterOf(fp, x, z)
            if (!hole) continue
            const a = nearest({ ...fp, rings: [hole] }, x, z).d
            const best = found.get(hole)
            if (!best || a > best.a) found.set(hole, { x, z, a })
          }
        }
        for (const c of found.values()) out.push({ letter: i, ...c })
      })
      return out
    },
    gaps(width) {
      // The closest approach of each two letters' outlines: one's outline sampled against the other.
      const out: { a: number; b: number; x: number; z: number; w: number }[] = []
      for (let i = 0; i < footprints.length; i++) {
        for (let j = i + 1; j < footprints.length; j++) {
          const A = footprints[i], B = footprints[j]
          if (A.box[0] > B.box[2] + width || B.box[0] > A.box[2] + width || A.box[1] > B.box[3] + width || B.box[1] > A.box[3] + width) continue
          let best = Infinity, bx = 0, bz = 0
          for (const ring of A.rings) {
            for (let k = 0; k < ring.length; k += 2) {
              const e = nearest(B, ring[k], ring[k + 1])
              if (e.d < best && !inside(B, ring[k], ring[k + 1])) { best = e.d; bx = ring[k] - (e.nx * e.d) / 2; bz = ring[k + 1] - (e.nz * e.d) / 2 }
            }
          }
          if (best < width) out.push({ a: i, b: j, x: bx, z: bz, w: best })
        }
      }
      return out
    },
    tour: () => tourStops(world.letters()),
    surface: (x, z) => surfaceAt(solid, x, z),
    marble(id) {
      let m = map.get(id)
      if (m) return m
      const start = footprints.length ? footprints[footprints.length - 1].spot : [0, 0]
      const orb = newOrb(start[0], start[1], ORB_R, surfaceAt(footprints, start[0], start[1]).h)
      const p: [number, number, number] = [orb.x, orb.y, orb.z]
      m = { id, orb, push: null, was: p, now: [...p], shown: [...p], on: -1 }
      map.set(id, m)
      return m
    },
    marbles: () => [...map.values()],
    remove(id) { map.delete(id) },
    toss(m, vy) { toss(m.orb, vy, solid) },
    wake() { for (const m of map.values()) m.orb.resting = false },
    step(dt) {
      const hits: WorldHit[] = []
      const all = [...map.values()]
      const bodies = bodiesOf(all)
      // Moved by someone else since its last step (dropped in for the opening, set down on the full stop): drawn there
      // at once, not slid there.
      for (const m of all) {
        const o = m.orb
        if (o.x !== m.now[0] || o.y !== m.now[1] || o.z !== m.now[2]) { m.now = [o.x, o.y, o.z]; m.was = [...m.now] }
      }
      acc += Math.min(Math.max(0, dt), CATCH_UP)
      while (acc >= H - 1e-9) {
        acc -= H
        for (const m of all) m.was = m.now
        const knocks = tick(bodies, solid, H, env)
        for (const m of all) m.now = [m.orb.x, m.orb.y, m.orb.z]
        report(all, knocks, hits, clock, knocked)
        arrivals(all, hits)
        clock += H
      }
      acc = Math.max(0, acc)
      if (knocked.size > 256) for (const [key, t] of knocked) if (t < clock - 1) knocked.delete(key)
      const k = acc / H
      let moving = false
      for (const m of all) {
        m.shown = lerp3(m.was, m.now, k)
        if (viewport) {
          const [x, y, z] = m.shown
          const p = withinWalls(walls, x, y, z, m.orb.r * (1 + DEPTH * Math.max(0, y - m.orb.r)))
          m.shown = [p.x, y, p.z]
        }
        moving = moving || !m.orb.resting || m.was[0] !== m.now[0] || m.was[1] !== m.now[1] || m.was[2] !== m.now[2]
      }
      return { hits, moving }
    },
    shownAt: () => clock - H + acc,
    foresee(horizon) {
      const all = [...map.values()]
      if (horizon <= 0 || all.every((m) => m.orb.resting)) return []
      // Copies, down to what each remembers from its last step.
      const copies = all.map((m) => ({ ...m, orb: copyOrb(m.orb) }))
      const bodies = bodiesOf(copies)
      const hits: WorldHit[] = []
      const seen = new Map(knocked)
      for (let t = clock, end = clock + horizon; t < end - 1e-9; t += H) report(copies, tick(bodies, solid, H, env), hits, t, seen)
      return hits
    },
  }

  /** The marbles as the physics steps them, with what moves each. */
  const bodiesOf = (all: WorldMarble[]): Body[] => all.map((m) => ({ o: m.orb, opts: { hop: HOP, bounds, ...STEER, push: m.push ?? undefined } as StepOptions }))
  /** A marble's copy, to step without it (its memory too). */
  const copyOrb = (o: Orb): Orb => ({
    ...o, target: o.target && { ...o.target }, route: o.route.map((p) => ({ ...p })), aim: o.aim && { ...o.aim }, toss: o.toss && { ...o.toss },
    mem: o.mem && { ...o.mem, touch: o.mem.touch.map((t) => ({ ...t })) },
  })

  /**
   * A step's knocks as hits: what was struck, and when. One impact is one hit (a marble dropped onto a rim touches it
   * in two places, within a step or two): the hardest of its knocks, at the moment the first touched; heard in an
   * earlier frame, it isn't again. `knocked`: each marble's last knock on each thing (read, and kept up).
   */
  function report(all: WorldMarble[], knocks: Knock[], hits: WorldHit[], at: number, knocked: Map<string, number>) {
    for (const k of knocks) {
      if (k.speed < REPORT) continue
      const m = all[k.i]
      const kind: HitKind = k.kind === 'marble' ? 'marble' : k.kind === 'wall' ? 'wall' : k.id >= PAD_ID ? 'button' : k.id >= 0 ? 'letter' : 'floor'
      const hit: WorldHit = { orb: m.id, kind, speed: k.speed, landed: k.kind === 'land' || !!k.hop, x: k.x, y: k.y, z: k.z, nx: k.nx, ny: k.ny, nz: k.nz, t: at + k.t }
      if (kind === 'marble') hit.other = all[k.id].id
      else if (kind === 'wall') hit.wall = k.id
      else if (kind === 'button') hit.pad = k.id - PAD_ID
      else if (kind === 'letter') hit.letter = k.id
      const key = keyOf(hit)
      const last = knocked.get(key)
      if (last !== undefined && Math.abs(hit.t - last) < ONE_KNOCK) {
        const same = hits.find((q) => q.t === last && keyOf(q) === key)
        if (same) { same.speed = Math.max(same.speed, hit.speed); same.landed ||= hit.landed }
        continue
      }
      knocked.set(key, hit.t)
      hits.push(hit)
    }
  }

  /**
   * Arriving on a raised thing without a knock (rolled up onto it, or set down softly): it takes the marble's weight
   * with a soft tap, as it rolls on.
   */
  function arrivals(all: WorldMarble[], hits: WorldHit[]) {
    for (const m of all) {
      const o = m.orb
      if (o.resting) continue
      const s = surfaceAt(solid, o.x, o.z)
      if (o.y - o.r - s.h > 0.01) continue
      if (s.id >= PAD_ID && m.on !== s.id && !hits.some((q) => q.orb === m.id && q.pad === s.id - PAD_ID)) {
        hits.push({ orb: m.id, kind: 'button', pad: s.id - PAD_ID, speed: 0.4 + Math.hypot(o.vx, o.vz), landed: true, x: o.x, y: s.h, z: o.z, nx: 0, ny: 1, nz: 0, t: clock + H, soft: true })
      }
      m.on = s.id === FLOOR ? -1 : s.id
    }
  }

  return world
}
