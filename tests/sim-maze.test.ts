import { describe, expect, it } from 'vitest'
import { Mode, PadButton, qAxisAngle, qIdentity, qMul } from '@obpal/core'
import { DragStick } from '../src/sim/devices/input'
import { makeMaze, MAZE, MazeLogic, mazeTilt, stepBoard, type Board } from '../src/sim/devices/maze'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

const pad = (axes: [number, number, number, number]) => ({ flags: 0, seq: 0, t: 0, buttons: 0, axes, triggers: [0, 0] as [number, number] })
const at = (over: Partial<DeviceInput>): DeviceInput => ({ ...restInput('face.trackpad', Mode.tilt), ...over })
const board = (m = makeMaze()): Board => ({ tx: 0, tz: 0, mx: m.start[0], mz: m.start[1], vx: 0, vz: 0, falling: 0, won: 0, running: false, time: 0, best: null, level: null })
const D2R = Math.PI / 180

describe('marble maze: the maze', () => {
  it('has more room while its passages remain wider than the marble', () => {
    expect(MAZE.size ** 2).toBeGreaterThan(2)
    expect(MAZE.size / MAZE.cells - MAZE.wall).toBeGreaterThan(MAZE.ball * 2)
  })

  it('is the same for every board (seeded), with holes off the way from start to goal', () => {
    const a = makeMaze(7), b = makeMaze(7)
    expect(a).toEqual(b)
    expect(a.holes.length).toBeGreaterThan(0)
    for (const h of a.holes) expect(Math.hypot(h[0] - a.start[0], h[1] - a.start[1])).toBeGreaterThan(0.05)
    // A perfect maze has one fewer passage than cells.
    expect(a.walls.length).toBe(2 * MAZE.cells * (MAZE.cells - 1) - (MAZE.cells ** 2 - 1) + 4)
  })
})

describe('marble maze: each controller tilts the board', () => {
  it('trackpad, Tilt: the phone’s tilt tips the board as far as its stop', () => {
    const b = board()
    const [x, z] = mazeTilt(at({ tilt: [1, -0.5] }), b, new DragStick())
    expect(x).toBeCloseTo(MAZE.maxTilt)
    expect(z).toBeCloseTo(-0.5 * MAZE.maxTilt)
  })

  it('trackpad, 1:1: the board turns as the phone does, and Level makes the way it’s held flat', () => {
    const b = board()
    const s = new DragStick()
    // The gyro comes on (the turn is where it started), then the phone rolls 8° to the right.
    mazeTilt(at({ mode: Mode.hold, hold: qIdentity() }), b, s)
    const right = qAxisAngle(0, 0, 1, -8 * D2R)
    const [x] = mazeTilt(at({ mode: Mode.hold, hold: right }), b, s)
    expect(x / D2R).toBeCloseTo(8, 0)
    // Level here: now that's flat, and a further 4° reads as 4°.
    const [x0, z0] = mazeTilt(at({ mode: Mode.hold, hold: right, recentred: true }), b, s)
    expect(Math.abs(x0) + Math.abs(z0)).toBeLessThan(1e-6)
    const [x1] = mazeTilt(at({ mode: Mode.hold, hold: qMul(qAxisAngle(0, 0, 1, -4 * D2R), right) }), b, s)
    expect(x1 / D2R).toBeCloseTo(4, 0)
  })

  it('gamepad: the left stick tips it; A starts again', () => {
    const logic = new MazeLogic(1)
    const [x, z] = mazeTilt(at({ face: 'face.gamepad', mode: Mode.gamepad, pad: pad([0, 1, 0, 0]) }), logic.boards[0], new DragStick())
    expect(x).toBe(0)
    expect(z).toBeCloseTo(MAZE.maxTilt)
    logic.boards[0].mx = 0.3
    logic.step([at({ face: 'face.gamepad', mode: Mode.gamepad, pad: pad([0, 0, 0, 0]), padPressed: 1 << PadButton.A })], 1 / 60)
    expect(logic.boards[0].mx).toBe(logic.maze.start[0])
  })

  it('trackpad without the gyro: a thumb dragged tips it that way', () => {
    const [x] = mazeTilt(at({ touching: true, drag: [70, 0] }), board(), new DragStick(70))
    expect(x).toBeCloseTo(MAZE.maxTilt)
  })
})

describe('marble maze: physics within its limits', () => {
  it('the marble rolls downhill as a solid ball (5/7 g sin θ) and the board never tips past its stop', () => {
    const m = makeMaze()
    const b = board(m)
    b.tx = 10 * D2R
    const v0 = b.vx
    stepBoard(b, { ...m, walls: [], holes: [] }, [10 * D2R, 0], 0.1)
    expect(b.vx - v0).toBeCloseTo((5 / 7) * 9.81 * Math.sin(10 * D2R) * 0.1, 1)
    for (let i = 0; i < 100; i++) stepBoard(b, m, [1, -1], 1 / 60)
    expect(Math.abs(b.tx)).toBeLessThanOrEqual(MAZE.holdTilt + 1e-9)
    expect(Math.abs(b.tz)).toBeLessThanOrEqual(MAZE.holdTilt + 1e-9)
  })

  it('never leaves the board or passes through a wall, however hard it’s tipped', () => {
    const m = makeMaze()
    const b = board(m)
    for (let i = 0; i < 1200; i++) {
      const t = i / 60
      stepBoard(b, m, [Math.sign(Math.sin(t * 1.3)) * MAZE.holdTilt, Math.sign(Math.cos(t * 0.9)) * MAZE.holdTilt], 1 / 60)
      if (b.falling || b.won) Object.assign(b, { mx: m.start[0], mz: m.start[1], vx: 0, vz: 0, falling: 0, won: 0 })
      expect(Math.abs(b.mx)).toBeLessThan(MAZE.size / 2)
      expect(Math.abs(b.mz)).toBeLessThan(MAZE.size / 2)
      for (const w of m.walls) {
        const cx = Math.max(w.x - w.hx, Math.min(w.x + w.hx, b.mx))
        const cz = Math.max(w.z - w.hz, Math.min(w.z + w.hz, b.mz))
        expect(Math.hypot(b.mx - cx, b.mz - cz)).toBeGreaterThan(MAZE.ball * 0.9)
      }
    }
  })

  it('drops through a hole it rolls over (back to the start) and is home in the goal, with its time', () => {
    const logic = new MazeLogic(1)
    const b = logic.boards[0]
    const [hx, hz] = logic.maze.holes[0]
    Object.assign(b, { mx: hx + 0.001, mz: hz })
    logic.step([at({})], 1 / 60)
    expect(b.falling).toBeGreaterThan(0)
    expect(logic.drain()[0]).toMatchObject({ kind: 'fall' })
    for (let i = 0; i < 70; i++) logic.step([at({})], 1 / 60)
    expect([b.mx, b.mz]).toEqual(logic.maze.start)
    Object.assign(b, { mx: logic.maze.goal[0], mz: logic.maze.goal[1] - 0.001, running: true, time: 12.34 })
    logic.step([at({})], 1 / 60)
    const e = logic.drain()[0]
    expect(e.kind).toBe('score')
    expect(e.text).toMatch(/^Home in 12\.4 s: your best$/)
    expect(b.best).toBeCloseTo(12.34 + 1 / 60, 6)
  })

  it('Home puts the marble back and the board flat', () => {
    const logic = new MazeLogic(1)
    const b = logic.boards[0]
    Object.assign(b, { mx: 0.2, mz: 0.1, tx: 0.1, tz: -0.1, time: 5, running: true })
    logic.home(0)
    expect([b.mx, b.mz, b.tx, b.tz, b.time, b.running]).toEqual([...logic.maze.start, 0, 0, 0, false])
    expect(logic.readout(0)).toBe('Ready')
  })
})
