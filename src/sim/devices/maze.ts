/**
 * Marble maze: a board per phone, all with the same maze, racing a glass marble from its start to the lit hole. The
 * trackpad suits it best: with the gyro on, in its Tilt style the phone's tilt tilts the board, and in 1:1 the board
 * turns exactly as the phone does (Level makes the way it's held now flat). The gamepad's left stick tilts it too.
 *
 * The marble rolls as a solid ball does on a slope (5/7 g sin θ), slowed a little by the board, knocks off the walls,
 * and drops through a hole it rolls over: back to the start. The board tilts at a servo's speed, and never more than
 * its stop.
 */
import { Controller, Mode, PadButton, qConj, qMul, type Quat } from '@obpal/core'
import { axis, clamp, DragStick, padStick, readable, slopeOf } from './input'
import type { DeviceEvent, DeviceInput, DeviceLogic, DeviceSpec } from './types'

export const MAZE_SPEC: DeviceSpec = {
  id: 'maze',
  name: 'Marble maze',
  unit: 'Board',
  units: 4,
  kind: 'Game',
  blurb: 'Tilt your phone to roll a glass marble through the maze, round the holes.',
  teaches: 'Tilt and 1:1: the board tilts as the phone does; Level sets flat',
  controllers: [Controller.trackpad, Controller.gamepad],
  how: {
    'face.trackpad': 'Gyro on: tilt the phone and the board tilts · Level: flat here',
    'face.gamepad': 'Left stick tilts the board · A starts again',
  },
  tray: [],
  // R starts again, on every controller.
  buttons: { 'key:KeyR': 'tray:home' },
}

/** Metres, seconds, radians. */
export const MAZE = {
  /** The board's side, and its cells across. */
  size: 1.5,
  cells: 9,
  wall: 0.014,
  ball: 0.028,
  hole: 0.042,
  /** The board's stop, and how fast it tilts. */
  maxTilt: (10 * Math.PI) / 180,
  holdTilt: (16 * Math.PI) / 180,
  tiltRate: (110 * Math.PI) / 180,
  /** Rolling resistance (m/s²) and a little air. */
  roll: 0.05,
  drag: 0.15,
  bounce: 0.45,
  g: 9.81,
}

/** A wall as a box on the board: its middle and its half sizes, in metres (x right, z toward the person). */
export interface Wall { x: number; z: number; hx: number; hz: number }
export interface Maze { walls: Wall[]; holes: [number, number][]; start: [number, number]; goal: [number, number] }

/** A small seeded random number generator (mulberry32), so every board gets the same maze. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A maze of `n` × `n` cells (a depth-first carve), its walls as boxes, a start in the far left corner and the goal in
 * the near right, and holes in dead ends off the way between them.
 */
export function makeMaze(seed = 7, n = MAZE.cells, holes = 5): Maze {
  const rnd = seeded(seed)
  const S = MAZE.size / n
  const open = new Set<string>() // "a|b" for a passage between cells a and b (a < b)
  const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const seen = new Set([0])
  const stack = [0]
  while (stack.length) {
    const c = stack[stack.length - 1]
    const x = c % n, z = Math.floor(c / n)
    const next = [[x - 1, z], [x + 1, z], [x, z - 1], [x, z + 1]].filter(([a, b]) => a >= 0 && b >= 0 && a < n && b < n && !seen.has(b * n + a))
    if (!next.length) { stack.pop(); continue }
    const [a, b] = next[Math.floor(rnd() * next.length)]
    const d = b * n + a
    open.add(key(c, d))
    seen.add(d)
    stack.push(d)
  }
  const at = (i: number): [number, number] => [-MAZE.size / 2 + S * ((i % n) + 0.5), -MAZE.size / 2 + S * (Math.floor(i / n) + 0.5)]
  const walls: Wall[] = []
  const t = MAZE.wall / 2
  const h = MAZE.size / 2
  // The rim, then each cell's wall to its right and toward the person, where there's no passage.
  walls.push({ x: 0, z: -h, hx: h + t, hz: t }, { x: 0, z: h, hx: h + t, hz: t }, { x: -h, z: 0, hx: t, hz: h + t }, { x: h, z: 0, hx: t, hz: h + t })
  for (let i = 0; i < n * n; i++) {
    const x = i % n, z = Math.floor(i / n)
    const [cx, cz] = at(i)
    if (x < n - 1 && !open.has(key(i, i + 1))) walls.push({ x: cx + S / 2, z: cz, hx: t, hz: S / 2 + t })
    if (z < n - 1 && !open.has(key(i, i + n))) walls.push({ x: cx, z: cz + S / 2, hx: S / 2 + t, hz: t })
  }
  // The way from start to goal, so the holes stay off it.
  const goal = n * n - 1
  const from = new Map<number, number>([[0, -1]])
  const queue = [0]
  while (queue.length) {
    const c = queue.shift()!
    for (const d of [c - 1, c + 1, c - n, c + n]) {
      if (d < 0 || d >= n * n || from.has(d) || !open.has(key(c, d))) continue
      if ((d === c - 1 || d === c + 1) && Math.floor(d / n) !== Math.floor(c / n)) continue
      from.set(d, c)
      queue.push(d)
    }
  }
  const way = new Set<number>()
  for (let c = goal; c !== -1; c = from.get(c)!) way.add(c)
  const degree = (c: number) => [c - 1, c + 1, c - n, c + n].filter((d) => d >= 0 && d < n * n && open.has(key(c, d)) && !((d === c - 1 || d === c + 1) && Math.floor(d / n) !== Math.floor(c / n))).length
  const ends = [...Array(n * n).keys()].filter((c) => !way.has(c) && degree(c) === 1)
  const picked: number[] = []
  while (picked.length < holes && ends.length) picked.push(ends.splice(Math.floor(rnd() * ends.length), 1)[0])
  return { walls, holes: picked.map(at), start: at(0), goal: at(goal) }
}

export interface Board {
  /** The board's tilt now: + x side down, + near side down (rad). */
  tx: number
  tz: number
  /** The marble on the board. */
  mx: number
  mz: number
  vx: number
  vz: number
  /** Seconds since it dropped through a hole, or reached the goal (0: neither). */
  falling: number
  won: number
  /** The run: when it started (s of board time), and the best so far. */
  running: boolean
  time: number
  best: number | null
  /** 1:1: the phone's turn that counts as flat (Level). */
  level: Quat | null
}

const fresh = (m: Maze): Board => ({ tx: 0, tz: 0, mx: m.start[0], mz: m.start[1], vx: 0, vz: 0, falling: 0, won: 0, running: false, time: 0, best: null, level: null })

/** The tilt a player asks for, [x side down, near side down] in radians, by the controller in use. */
export function mazeTilt(inp: DeviceInput, b: Board, stick: DragStick): [number, number] {
  const M = MAZE
  if (inp.pad) {
    const [x, y] = padStick(inp.pad, 'left', 0.08)
    return [x * M.maxTilt, y * M.maxTilt]
  }
  if (inp.hold) {
    // 1:1: the board turns as the phone does, from however it was held when Level was pressed.
    if (inp.recentred || !b.level) b.level = inp.hold
    const [sx, sz] = slopeOf(qMul(inp.hold, qConj(b.level)))
    return [clamp(Math.asin(clamp(sx, -1, 1)), -M.holdTilt, M.holdTilt), clamp(Math.asin(clamp(sz, -1, 1)), -M.holdTilt, M.holdTilt)]
  }
  b.level = null
  if (inp.mode === Mode.tilt && (inp.tilt[0] || inp.tilt[1])) return [inp.tilt[0] * M.maxTilt, inp.tilt[1] * M.maxTilt]
  // No gyro: a thumb dragged on the trackpad tips the board that way.
  const [sx, sy] = stick.update(inp.touching, inp.drag)
  return [axis(sx, 0.05) * M.maxTilt, axis(sy, 0.05) * M.maxTilt]
}

/** Push a marble out of a wall it's in, bouncing off it; returns how hard it hit (m/s into the wall). */
function hitWall(b: Board, w: Wall, r: number): number {
  const cx = clamp(b.mx, w.x - w.hx, w.x + w.hx)
  const cz = clamp(b.mz, w.z - w.hz, w.z + w.hz)
  let nx = b.mx - cx, nz = b.mz - cz
  const d = Math.hypot(nx, nz)
  if (d >= r) return 0
  if (d > 1e-9) {
    nx /= d
    nz /= d
    b.mx = cx + nx * r
    b.mz = cz + nz * r
  } else if (w.hx - Math.abs(b.mx - w.x) < w.hz - Math.abs(b.mz - w.z)) {
    // Its middle got inside the wall: out through the nearest side.
    nx = Math.sign(b.mx - w.x) || 1
    nz = 0
    b.mx = w.x + nx * (w.hx + r)
  } else {
    nx = 0
    nz = Math.sign(b.mz - w.z) || 1
    b.mz = w.z + nz * (w.hz + r)
  }
  const into = b.vx * nx + b.vz * nz
  if (into >= 0) return 0
  b.vx -= (1 + MAZE.bounce) * into * nx
  b.vz -= (1 + MAZE.bounce) * into * nz
  return -into
}

/** One step of a board and its marble; returns what happened. */
export function stepBoard(b: Board, m: Maze, target: [number, number] | null, dt: number): 'fell' | 'won' | 'knock' | null {
  const M = MAZE
  const [gx, gz] = target ?? [0, 0]
  const move = (cur: number, to: number) => cur + clamp(to - cur, -M.tiltRate * dt, M.tiltRate * dt)
  b.tx = clamp(move(b.tx, gx), -M.holdTilt, M.holdTilt)
  b.tz = clamp(move(b.tz, gz), -M.holdTilt, M.holdTilt)
  if (b.falling || b.won) return null
  let knock = 0
  // Substeps, so a fast marble never passes through a wall.
  const steps = 4
  const h = dt / steps
  for (let s = 0; s < steps; s++) {
    const k = (5 / 7) * M.g
    b.vx += k * Math.sin(b.tx) * h
    b.vz += k * Math.sin(b.tz) * h
    const sp = Math.hypot(b.vx, b.vz)
    if (sp > 0) {
      const slow = Math.min(sp, (M.roll + M.drag * sp) * h)
      b.vx -= (b.vx / sp) * slow
      b.vz -= (b.vz / sp) * slow
    }
    b.mx += b.vx * h
    b.mz += b.vz * h
    for (const w of m.walls) knock = Math.max(knock, hitWall(b, w, M.ball))
  }
  if (!b.running && Math.hypot(b.mx - m.start[0], b.mz - m.start[1]) > 0.03) b.running = true
  if (b.running) b.time += dt
  // Over a hole, it drops through; over the goal, it's home.
  if (Math.hypot(b.mx - m.goal[0], b.mz - m.goal[1]) < M.hole - M.ball * 0.3) { b.won = 1e-6; b.vx = b.vz = 0; return 'won' }
  for (const [x, z] of m.holes) {
    if (Math.hypot(b.mx - x, b.mz - z) < M.hole - M.ball * 0.3) { b.falling = 1e-6; b.vx = b.vz = 0; b.mx = x; b.mz = z; return 'fell' }
  }
  return knock > 0.15 ? 'knock' : null
}

export class MazeLogic implements DeviceLogic {
  readonly spec = MAZE_SPEC
  readonly maze: Maze
  readonly boards: Board[]
  private sticks: DragStick[]
  private events: DeviceEvent[] = []

  constructor(count = MAZE_SPEC.units, seed = 7) {
    this.maze = makeMaze(seed)
    this.boards = Array.from({ length: count }, () => fresh(this.maze))
    this.sticks = this.boards.map(() => new DragStick(70))
  }

  step(inputs: readonly (DeviceInput | null)[], dt: number) {
    this.boards.forEach((b, n) => {
      const inp = inputs[n]
      if (inp && (inp.padPressed >>> PadButton.A) & 1) { this.home(n); return }
      const target = inp ? mazeTilt(inp, b, this.sticks[n]) : null
      if (!inp) this.sticks[n].update(false, [0, 0])
      // A marble that dropped comes back to the start; one that got home starts again after a moment.
      if (b.falling) { b.falling += dt; if (b.falling > 0.9) this.restart(b) }
      if (b.won) { b.won += dt; if (b.won > 2.2) this.restart(b) }
      const r = stepBoard(b, this.maze, target, dt)
      if (r === 'fell') this.events.push({ unit: n, kind: 'fall', text: 'Down a hole: back to the start' })
      if (r === 'won') {
        const t = b.time
        const best = b.best === null || t < b.best
        if (best) b.best = t
        this.events.push({ unit: n, kind: 'score', text: `Home in ${readable(t)} s${best ? ': your best' : ''}` })
      }
      if (r === 'knock') this.events.push({ unit: n, kind: 'bump', strength: 0.35 })
    })
  }

  private restart(b: Board) {
    Object.assign(b, { mx: this.maze.start[0], mz: this.maze.start[1], vx: 0, vz: 0, falling: 0, won: 0, running: false, time: 0 })
  }

  /** Home: the marble back to the start, the board flat, the clock at zero. */
  home(n: number) {
    const b = this.boards[n]
    this.restart(b)
    b.tx = b.tz = 0
    this.sticks[n].update(false, [0, 0])
  }

  readout(n: number) {
    const b = this.boards[n]
    const best = b.best !== null ? ` · best ${readable(b.best)} s` : ''
    return b.running || b.won ? `${readable(b.time)} s${best}` : best ? best.slice(3) : 'Ready'
  }

  drain() { const e = this.events; this.events = []; return e }
}
