import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { emptyPad, type PadState } from '@obpal/core'
import { BALL_RADIUS, ELONGATION, OCTOPUS_LIMITS, OctopusLogic } from '../src/sim/devices/octopus'
import { ARM_POINTS, OCTOPUS_PROFILE } from '../src/sim/devices/octopus-types'
import { ArmRod, FLOOR, ROD_SEGMENTS, SOFT_ARM, surfaceRadius } from '../src/sim/continuum/rod'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

type Rod = ArmRod
type Arm = { rod: Rod; role: string; time: number; target: Vector3; bend: { position: number; velocity: number } }
type Run = { arms: Arm[]; velocity: Vector3; route: number; grabbers: number[] }
const runOf = (logic: OctopusLogic) => (logic as unknown as { run: Run[] }).run[0]
const pad = (x: number, y: number, rx = 0): PadState => ({ ...emptyPad(), axes: [x, y, rx, 0] })
const gamepad = (x = 0, y = 0, presses: string[] = [], rx = 0): DeviceInput => ({ ...restInput(), pad: pad(x, y, rx), presses })

describe('the soft arm rod', () => {
  const arm = OCTOPUS_PROFILE.arms[0]
  it('keeps constant volume: the section narrows as the arm elongates and thickens as it shortens', () => {
    for (const f of [0, 0.3, 0.7]) {
      expect(surfaceRadius(arm, f, 1.25)).toBeCloseTo(surfaceRadius(arm, f) / Math.sqrt(1.25), 9)
      expect(surfaceRadius(arm, f, 0.8)).toBeGreaterThan(surfaceRadius(arm, f))
    }
  })

  it('settles under gravity onto the floor without passing through it, and holds stay where they are', () => {
    const rod = new ArmRod(arm), root = new Vector3(0, 0.15, 0), direction = new Vector3(0, -0.15, 1).normalize(), up = new Vector3(0, 1, 0)
    rod.place(root, direction, up)
    // A gentle droop toward the oral side, as the octopus's relaxed arms have.
    rod.bendOral.fill(0.06)
    for (let i = 0; i < 480; i++) rod.step(1 / 120, root, direction, up, 0)
    for (let i = 2; i < rod.count; i++) expect(rod.position[i * 3 + 1]).toBeGreaterThanOrEqual(surfaceRadius(arm, i / ROD_SEGMENTS) * 0.85 - 1e-9)
    expect(rod.contact.reduce((a, b) => a + b, 0)).toBeGreaterThan(5)
    rod.hold(12, FLOOR)
    const held = rod.position.slice(36, 39)
    // Move the root about: the hold does not move and nothing jumps.
    for (let i = 0; i < 240; i++) {
      root.x = 0.15 * Math.sin(i / 30)
      rod.step(1 / 120, root, direction, up, 0)
      expect(Array.from(rod.position.slice(36, 39))).toEqual(Array.from(held))
      expect(rod.speed()).toBeLessThan(0.03)
    }
  })

  it('curves into a hold it is dragged from instead of creasing over it', () => {
    // A rod held along its middle on the floor, its root then carried sideways: the pull swings round the hold.
    const run = (settings: typeof SOFT_ARM) => {
      const rod = new ArmRod(arm, settings), root = new Vector3(0, 0.15, 0), direction = new Vector3(0, -0.2, 1).normalize(), up = new Vector3(0, 1, 0)
      rod.place(root, direction, up)
      for (let i = 0; i < 240; i++) rod.step(1 / 120, root, direction, up, 0)
      for (const i of [9, 10, 11]) rod.hold(i, FLOOR)
      let sharpest = 0
      for (let i = 0; i < 240; i++) {
        root.x = Math.min(0.25, i / 480)
        rod.step(1 / 120, root, direction, up, 0)
        sharpest = Math.max(sharpest, sharpestBend(rod))
      }
      return sharpest
    }
    const limited = run(SOFT_ARM), unlimited = run({ ...SOFT_ARM, maxBend: 0 })
    expect(unlimited).toBeGreaterThan(0.9)
    expect(limited).toBeLessThan(0.75)
  })
})

/** The sharpest joint bend along a rod, radians, leaving out the very tip (which curls tightly by design). */
function sharpestBend(rod: ArmRod) {
  const p = rod.position, a = new Vector3(), b = new Vector3()
  let most = 0
  for (let j = 1; j < ROD_SEGMENTS - 1; j++) {
    a.set(p[j * 3] - p[j * 3 - 3], p[j * 3 + 1] - p[j * 3 - 2], p[j * 3 + 2] - p[j * 3 - 1])
    b.set(p[j * 3 + 3] - p[j * 3], p[j * 3 + 4] - p[j * 3 + 1], p[j * 3 + 5] - p[j * 3 + 2])
    most = Math.max(most, a.angleTo(b))
  }
  return most
}

describe('the octopus crawl', () => {
  it('replays alike at 30, 60 and 120 Hz', () => {
    const run = (hz: number) => {
      const logic = new OctopusLogic()
      for (let f = 0; f < 4 * hz; f++) logic.step([gamepad(f < 2 * hz ? 0 : 0.7, -1, f === 0 ? ['pulse'] : [])], 1 / hz)
      return logic.units[0]
    }
    const [a, b, c] = [30, 60, 120].map(run)
    for (const other of [b, c]) {
      for (const key of ['x', 'y', 'z', 'h', 'v', 'turn', 'mantle'] as const) expect(Math.abs(other[key] - a[key])).toBeLessThan(1e-6)
      expect(Math.max(...other.arms.map((v, i) => Math.abs(v - a.arms[i])))).toBeLessThan(1e-6)
      expect(other.roles).toEqual(a.roles)
    }
  })

  it('glides by pushing: holding arms elongate as the body moves away, the body never jumps, holds never slide', () => {
    const logic = new OctopusLogic(), u = logic.units[0], run = runOf(logic)
    const anchors = run.arms.map(() => new Map<number, number[]>())
    let fastest = 0, worstChange = 0, least = 8, slid = 0, elongated = 0
    const previous = run.velocity.clone(), lengths = run.arms.map(() => 0)
    const roles = new Set<string>()
    for (let f = 0; f < 600; f++) {
      logic.step([gamepad(f > 300 && f < 420 ? 0.7 : 0, -1)], 1 / 60)
      worstChange = Math.max(worstChange, run.velocity.distanceTo(previous))
      previous.copy(run.velocity)
      let holding = 0
      for (const [i, arm] of run.arms.entries()) {
        fastest = Math.max(fastest, arm.rod.speed())
        roles.add(arm.role)
        const first = Array.from(arm.rod.held).findIndex((h, k) => k > 1 && h === FLOOR)
        if (arm.role === 'plant' && first > 0) {
          holding++
          // Elongation of the arm between root and hold, relative to when it took hold.
          const stretch = arm.rod.stretch[2]
          if (!lengths[i]) lengths[i] = stretch
          elongated = Math.max(elongated, stretch - lengths[i])
        } else lengths[i] = 0
        for (let k = 2; k < ARM_POINTS; k++) {
          const at = Array.from(arm.rod.position.slice(k * 3, k * 3 + 3))
          if (arm.rod.held[k] !== FLOOR) { anchors[i].delete(k); continue }
          const was = anchors[i].get(k)
          if (was) slid = Math.max(slid, Math.hypot(at[0] - was[0], at[2] - was[2]))
          anchors[i].set(k, at)
        }
      }
      if (f > 30) least = Math.min(least, holding)
    }
    // Two frames of acceleration at most: the body eases, it never jumps.
    expect(worstChange).toBeLessThanOrEqual(OCTOPUS_LIMITS.accel * (2 / 60) + 1e-9)
    expect(fastest).toBeLessThan(0.03)
    expect(least).toBeGreaterThanOrEqual(3)
    expect(elongated).toBeGreaterThan(0.15)
    // Holds stay put except for counted sucker slips, each at most 3 cm a step.
    expect(slid).toBeLessThan(0.15)
    expect(logic.slips).toBeLessThan(40)
    expect(Math.hypot(u.x, u.z - 0.9)).toBeGreaterThan(1.2)
    // Several arms at different phases at once.
    expect([...roles].filter((r) => ['plant', 'peel', 'recover', 'reach'].includes(r)).length).toBe(4)
  })

  it('never creases an arm: dragged to the end of its range and peeling, it curves into its hold', () => {
    // Crawl, turn, crawl sideways and back: holding arms are dragged until they peel, again and again.
    const logic = new OctopusLogic(), run = runOf(logic)
    const history = run.arms.map(() => [] as { role: string; sharpest: number }[])
    let sharpest = 0
    for (let f = 0; f < 1500; f++) {
      const input = f < 400 ? gamepad(0, -1) : f < 600 ? gamepad(0.8, -0.6) : f < 900 ? gamepad(0, 0, [], 1) : f < 1200 ? gamepad(-0.9, -1) : gamepad(0, 1)
      logic.step([input], 1 / 60)
      run.arms.forEach((arm, i) => { const s = sharpestBend(arm.rod); history[i].push({ role: arm.role, sharpest: s }); sharpest = Math.max(sharpest, s) })
    }
    // From half a second before each peel to its end.
    let peels = 0, peeling = 0
    for (const h of history) for (let k = 1; k < h.length; k++) if (h[k].role === 'peel' && h[k - 1].role === 'plant') {
      peels++
      for (let m = Math.max(0, k - 30); m < h.length && (m < k || h[m].role === 'peel'); m++) peeling = Math.max(peeling, h[m].sharpest)
    }
    // Before the bend limit and the pivoting hold, both reached 2.39 radians on this script.
    expect(peels).toBeGreaterThan(50)
    expect(peeling).toBeLessThan(0.95)
    expect(sharpest).toBeLessThan(1)
  })

  it('has no fixed rhythm: arms let go at irregular intervals, each when its own hold runs out', () => {
    const logic = new OctopusLogic(), run = runOf(logic), starts: number[][] = run.arms.map(() => [])
    const was = run.arms.map((a) => a.role)
    for (let f = 0; f < 900; f++) {
      logic.step([gamepad(f > 400 && f < 520 ? -0.6 : 0, -1)], 1 / 60)
      run.arms.forEach((arm, i) => { if (arm.role === 'peel' && was[i] !== 'peel') starts[i].push(f); was[i] = arm.role })
    }
    const intervals = starts.flatMap((s) => s.slice(1).map((f, k) => f - s[k]))
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
    const spread = Math.sqrt(intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length) / mean
    expect(intervals.length).toBeGreaterThan(10)
    expect(spread).toBeGreaterThan(0.2)
  })

  it('crawls sideways with its heading unchanged: course and heading are separate', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    for (let f = 0; f < 360; f++) logic.step([gamepad(0, 0, [], 1)], 1 / 60)
    expect(Math.abs(u.h)).toBeLessThan(1e-9)
    expect(u.x - 0).toBeGreaterThan(0.4)
    expect(Math.abs(u.z - 0.9)).toBeLessThan(0.12)
  })

  it('reaches by a bend travelling from base to tip, its speed rising then falling, and holds within centimetres of its target', () => {
    const logic = new OctopusLogic(), run = runOf(logic)
    let watched = -1, done = false
    const front: number[] = []
    const misses: number[] = []
    for (let f = 0; f < 600; f++) {
      logic.step([gamepad(0, -1)], 1 / 60)
      for (const [i, arm] of run.arms.entries()) {
        if (watched < 0 && arm.role === 'reach' && arm.time > 0) watched = i
        // The first whole reach of the first arm seen reaching.
        if (i === watched && !done) { if (arm.role === 'reach') front.push(arm.bend.position); else if (front.length) done = true }
        if (arm.role === 'plant' && arm.time === 0) {
          // Just landed: how far its holds are from where it reached.
          const held = Array.from(arm.rod.held).map((h, k) => h === FLOOR ? k : -1).filter((k) => k >= 0)
          // The hold nearest the target: where the unrolled arm actually took the floor there.
          if (held.length) misses.push(Math.min(...held.map((h) => Math.hypot(arm.rod.position[h * 3] - arm.target.x, arm.rod.position[h * 3 + 2] - arm.target.z))))
        }
      }
    }
    const speeds = front.slice(1).map((p, i) => p - front[i])
    const peak = speeds.indexOf(Math.max(...speeds))
    expect(front.every((p, i) => i === 0 || p >= front[i - 1])).toBe(true)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThan(speeds.length - 1)
    misses.sort((a, b) => a - b)
    expect(misses.length).toBeGreaterThan(5)
    expect(misses[Math.floor(misses.length / 2)]).toBeLessThan(0.05)
    expect(misses[misses.length - 1]).toBeLessThan(0.12)
  })
})

describe('the octopus controls', () => {
  it('grabs the ball with the pair nearest it, carries it and scores in the ring', () => {
    const logic = new OctopusLogic(), u = logic.units[0], run = runOf(logic)
    Object.assign(u.ball, { x: u.x + 0.6, z: u.z, y: BALL_RADIUS })
    logic.step([gamepad(0, 0, ['grab'])], 1 / 60)
    for (let f = 0; f < 150 && !u.ball.held; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.held).toBe(true)
    expect(run.grabbers.every((i) => u.roles[i] === 'hold')).toBe(true)
    for (let f = 0; f < 60; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.y).toBeGreaterThan(BALL_RADIUS + 0.03)
    // Carry it over the ring and let go.
    const dx = u.ball.x - u.x, dz = u.ball.z - u.z
    Object.assign(u, { x: u.den[0] - dx, z: u.den[1] - dz })
    Object.assign(u.ball, { x: u.den[0], z: u.den[1] })
    for (let f = 0; f < 30; f++) logic.step([gamepad()], 1 / 60)
    logic.drain()
    logic.step([gamepad(0, 0, ['grab'])], 1 / 60)
    for (let f = 0; f < 120; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.held).toBe(false)
    expect(u.score).toBe(1)
    expect(logic.drain().some((e) => e.kind === 'score')).toBe(true)
  })

  it('reaches instead when the ball is out of reach', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    logic.step([gamepad(0, 0, ['grab'])], 1 / 60)
    expect(logic.drain().map((e) => e.text)).toContain('Reaching')
    for (let f = 0; f < 200; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.held).toBe(false)
  })

  it('curls onto its arms and rests, then reaches back down and holds again', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    logic.step([gamepad(0, 0, ['curl'])], 1 / 60)
    for (let f = 0; f < 120; f++) logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.mode).toBe('curl')
    expect(u.roles.every((r) => r === 'free')).toBe(true)
    expect(Math.hypot(u.x, u.z - 0.9)).toBeLessThan(0.05)
    expect(u.y).toBeLessThan(OCTOPUS_LIMITS.crawlHeight - 0.03)
    logic.step([gamepad(0, 0, ['curl'])], 1 / 60)
    for (let f = 0; f < 150; f++) logic.step([gamepad()], 1 / 60)
    expect(u.mode).toBe('crawl')
    expect(u.roles.filter((r) => r === 'plant').length).toBeGreaterThanOrEqual(4)
    expect(u.y).toBeGreaterThan(OCTOPUS_LIMITS.crawlHeight - 0.02)
  })

  it('pulses the mantle through the jet cycle and pushes off on its holding arms', () => {
    const logic = new OctopusLogic(), u = logic.units[0], z = u.z
    logic.step([gamepad(0, 0, ['pulse'])], 1 / 60)
    let least = 1
    for (let f = 0; f < 30; f++) { logic.step([gamepad()], 1 / 60); least = Math.min(least, u.mantle) }
    expect(least).toBeLessThan(0.75)
    for (let f = 0; f < 90; f++) logic.step([gamepad()], 1 / 60)
    expect(u.mantle).toBeGreaterThan(0.97)
    expect(z - u.z).toBeGreaterThan(0.08)
  })

  it('Stop holds everything until a fresh command; held stick input does not restart it', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    for (let f = 0; f < 60; f++) logic.step([gamepad(0, -1)], 1 / 60)
    logic.step([gamepad(0, -1, ['stop'])], 1 / 60)
    const at = [u.x, u.z, ...u.arms]
    for (let f = 0; f < 60; f++) logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.stopped).toBe(true)
    expect([u.x, u.z, ...u.arms]).toEqual(at)
    expect(logic.readout(0)).toMatch(/^Stopped/)
    logic.step([gamepad()], 1 / 60)
    logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.stopped).toBe(false)
    for (let f = 0; f < 60; f++) logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.z).toBeLessThan(at[1])
  })

  it('falls safely when its support goes, settling onto its arms and web, never below them', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    logic.step([gamepad(0, 0, ['curl'])], 1 / 60)
    u.y = 0.6
    let lowest = Infinity
    for (let f = 0; f < 120; f++) { logic.step([gamepad()], 1 / 60); lowest = Math.min(lowest, u.y) }
    expect(u.y).toBeLessThan(0.2)
    expect(lowest).toBeGreaterThanOrEqual(OCTOPUS_LIMITS.restHeight - 1e-9)
  })

  it('shows itself when nobody holds it: wraps the ball, carries it into the ring, without scoring or events', () => {
    const logic = new OctopusLogic(), u = logic.units[0], run = runOf(logic)
    let held = false
    for (let f = 0; f < 60 * 45 && !run.route; f++) { logic.step([null], 1 / 60); held ||= u.ball.held }
    expect(u.showing).toBe(true)
    expect(held).toBe(true)
    expect(run.route).toBe(1)
    expect(u.score).toBe(0)
    expect(logic.drain()).toEqual([])
    logic.step([gamepad()], 1 / 60)
    expect(u.showing).toBe(false)
  })

  it('stays finite under repeated controls, quiet input and bad frame times, and Home restores it', () => {
    const logic = new OctopusLogic(), u = logic.units[0], input = restInput()
    input.drag = [400, -400]; input.touching = true; input.presses = ['grab', 'curl', 'pulse']
    for (let n = 0; n < 100; n++) logic.step([input], 2)
    input.quiet = true
    for (const dt of [NaN, Infinity, -1, 0, 0.05]) logic.step([input], dt)
    expect(logic.readout(0)).not.toMatch(/NaN|Infinity/)
    expect([u.x, u.y, u.z, u.h, ...u.arms, ...u.cups].every(Number.isFinite)).toBe(true)
    logic.home(0)
    expect([u.x, u.z, u.h, u.mode]).toEqual([0, 0.9, 0, 'crawl'])
    expect(ELONGATION.shortest).toBeLessThan(1)
  })
})
