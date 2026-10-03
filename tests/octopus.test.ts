import { describe, expect, it } from 'vitest'
import { Vector3 } from 'three'
import { emptyPad, type PadState } from '@obpal/core'
import { BALL_RADIUS, CONTACT, FRONT, OCTOPUS_LIMITS, OctopusLogic, REACH } from '../src/sim/devices/octopus'
import { OCTOPUS_PROFILE, OCTOPUS_SECTIONS, SHAPE_STRIDE, profileYaw, shapeAt } from '../src/sim/devices/octopus-types'
import { ArmSolver, surfaceRadius } from '../src/sim/continuum/solve'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

type Arm = { solver: ArmSolver; role: string; anchor: Vector3; touching: boolean; blend: number }
const armsOf = (logic: OctopusLogic) => (logic as unknown as { run: { arms: Arm[] }[] }).run[0].arms
const pad = (x: number, y: number, buttons = 0): PadState => ({ ...emptyPad(), axes: [x, y, 0, 0], buttons })
const gamepad = (x = 0, y = 0, presses: string[] = []): DeviceInput => ({ ...restInput(), pad: pad(x, y), presses })

/** Where an arm's planted contact site is in the world, against where it was planted. */
function slip(logic: OctopusLogic, arm: Arm) {
  const u = logic.units[0], p = arm.solver.pointAt(CONTACT, new Vector3())
  const yaw = profileYaw(u.h), c = Math.cos(yaw), s = Math.sin(yaw)
  return Math.hypot(c * p.x + s * p.z + u.x - arm.anchor.x, -s * p.x + c * p.z + u.z - arm.anchor.z)
}

describe('the octopus solver', () => {
  it('places a planted contact within a centimetre across the working reach band, from a warm start', () => {
    const arm = OCTOPUS_PROFILE.arms[0], angle = Math.atan2(arm.position.x, arm.position.z), solver = new ArmSolver(arm, 1)
    solver.relax(0, 0.2, 0.12, 0, 0.02); solver.relax(1, 0.1, -0.42, 0, 0.02); solver.relax(2, -0.1, 0.5, 0, 0.02); solver.relax(3, -0.85, 0.45, 0, 0.4)
    solver.floorOffset = -OCTOPUS_LIMITS.crawlHeight
    const goal = solver.goals[0]
    Object.assign(goal, { fraction: CONTACT, weight: 400, active: true })
    const at = (radius: number, bearing: number) =>
      goal.target.set(Math.sin(angle + bearing) * radius, -OCTOPUS_LIMITS.crawlHeight + surfaceRadius(arm, CONTACT) + 0.006, Math.cos(angle + bearing) * radius)
    at(REACH.home, 0)
    for (let i = 0; i < 30; i++) solver.solve(2)
    let worst = 0
    const near = REACH.near + REACH.edge, far = REACH.far - REACH.edge
    for (const radius of [near, (near + REACH.home) / 2, REACH.home, (REACH.home + far) / 2, far]) for (const bearing of [-0.2, 0, 0.2]) {
      // Track there from home, as a planted arm does, then hold.
      for (let k = 1; k <= 30; k++) { at(REACH.home + (radius - REACH.home) * k / 30, bearing * k / 30); solver.solve(1) }
      for (let k = 0; k < 10; k++) solver.solve(1)
      worst = Math.max(worst, solver.residual)
      for (let k = 1; k <= 30; k++) { at(radius + (REACH.home - radius) * k / 30, bearing * (1 - k / 30)); solver.solve(1) }
    }
    expect(worst).toBeLessThan(0.01)
  })

  it('keeps every section within the profile’s bend and strain limits, and the surface on or above the floor', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    for (let f = 0; f < 600; f++) logic.step([gamepad(f < 300 ? 0 : 0.8, -1)], 1 / 60)
    for (let a = 0; a < OCTOPUS_PROFILE.arms.length; a++) for (let s = 0; s < OCTOPUS_SECTIONS; s++) {
      const section = OCTOPUS_PROFILE.arms[a].sections[s], i = shapeAt(a, s)
      const [kx, ky, strain] = u.shapes.slice(i, i + 3)
      expect(Math.hypot(kx, ky) * section.length * (1 + strain)).toBeLessThanOrEqual(section.bend + 1e-9)
      expect(strain).toBeGreaterThanOrEqual(section.strain[0] - 1e-9)
      expect(strain).toBeLessThanOrEqual(section.strain[1] + 1e-9)
    }
    expect(u.shapes.length).toBe(OCTOPUS_PROFILE.arms.length * OCTOPUS_SECTIONS * SHAPE_STRIDE)
  })
})

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
      expect(Math.max(...other.shapes.map((v, i) => Math.abs(v - a.shapes[i])))).toBeLessThan(1e-6)
      expect(other.roles).toEqual(a.roles)
    }
  })

  it('crawls on planted arms: at least four carry it, planted sites hold within 1.5 cm (p95 5 mm), the body stays up', () => {
    const logic = new OctopusLogic(), arms = armsOf(logic), u = logic.units[0], slips: number[] = []
    const planted = arms.map(() => 0)
    let least = 8, lowest = Infinity
    for (let f = 0; f < 900; f++) {
      const t = f / 60
      logic.step([gamepad(t > 5 && t < 8 ? 0.8 : t > 11 ? -0.6 : 0, t < 13 ? -1 : 0)], 1 / 60)
      arms.forEach((arm, i) => {
        planted[i] = arm.role === 'plant' ? planted[i] + 1 : 0
        if (planted[i] > 4 && arm.blend >= 1) slips.push(slip(logic, arm))
      })
      least = Math.min(least, arms.filter((a) => a.role === 'plant').length)
      if (f > 30) lowest = Math.min(lowest, u.y)
    }
    slips.sort((a, b) => a - b)
    expect(least).toBeGreaterThanOrEqual(OCTOPUS_PROFILE.support.minimumArms)
    expect(slips[Math.floor(slips.length * 0.95)]).toBeLessThan(0.005)
    expect(slips[slips.length - 1]).toBeLessThan(0.015)
    expect(lowest).toBeGreaterThan(OCTOPUS_LIMITS.crawlHeight - 0.03)
    expect(Math.hypot(u.x, u.z - 0.9)).toBeGreaterThan(1)
  })

  it('steps by contact, not a clock: standing still it settles and stops stepping', () => {
    const logic = new OctopusLogic(), arms = armsOf(logic)
    for (let f = 0; f < 120; f++) logic.step([gamepad(0, -1)], 1 / 60)
    let steps = 0
    for (let f = 0; f < 120; f++) {
      logic.step([gamepad()], 1 / 60)
      if (f > 60) steps += arms.filter((a) => a.role === 'step').length
    }
    // After the body stops, only the settling steps of arms that were mid-stride remain.
    expect(steps).toBeLessThan(60)
  })
})

describe('the octopus controls', () => {
  it('grabs the ball with the front pair, carries it and scores in the ring', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    // Put the ball just ahead of the mouth.
    const yaw = profileYaw(u.h)
    Object.assign(u.ball, { x: u.x + Math.sin(yaw) * 0.6, z: u.z + Math.cos(yaw) * 0.6, y: BALL_RADIUS })
    logic.step([gamepad(0, 0, ['grab'])], 1 / 60)
    for (let f = 0; f < 70; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.held).toBe(true)
    expect(u.roles.filter((r, i) => FRONT.includes(i) && r === 'hold')).toHaveLength(2)
    expect(u.ball.y).toBeGreaterThan(BALL_RADIUS + 0.05)
    // Carry it over the ring and let go.
    Object.assign(u, { x: u.den[0] - Math.sin(yaw) * 0.46, z: u.den[1] - Math.cos(yaw) * 0.46 })
    for (let f = 0; f < 60; f++) logic.step([gamepad()], 1 / 60)
    logic.drain()
    logic.step([gamepad(0, 0, ['grab'])], 1 / 60)
    for (let f = 0; f < 90; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.held).toBe(false)
    expect(u.score).toBe(1)
    expect(logic.drain().some((e) => e.kind === 'score')).toBe(true)
    expect(u.roles.every((r) => r === 'plant' || r === 'step')).toBe(true)
  })

  it('reaches instead when the ball is out of reach, and keeps crawling on the other arms', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    logic.step([gamepad(0, 0, ['grab'])], 1 / 60)
    expect(logic.drain().map((e) => e.text)).toContain('Reaching')
    for (let f = 0; f < 30; f++) logic.step([gamepad()], 1 / 60)
    expect(FRONT.every((i) => u.roles[i] === 'reach')).toBe(true)
    for (let f = 0; f < 120; f++) logic.step([gamepad()], 1 / 60)
    expect(u.ball.held).toBe(false)
    expect(FRONT.every((i) => u.roles[i] !== 'reach')).toBe(true)
  })

  it('curls onto its arms and rests on the floor, then plants again', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    logic.step([gamepad(0, 0, ['curl'])], 1 / 60)
    for (let f = 0; f < 120; f++) logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.mode).toBe('curl')
    expect(u.roles.every((r) => r === 'free')).toBe(true)
    // It cannot crawl while curled, and it rests rather than hovering at crawl height.
    expect(Math.hypot(u.x, u.z - 0.9)).toBeLessThan(0.05)
    expect(u.y).toBeLessThan(OCTOPUS_LIMITS.crawlHeight - 0.03)
    expect(u.y).toBeGreaterThan(0)
    logic.step([gamepad(0, 0, ['curl'])], 1 / 60)
    for (let f = 0; f < 120; f++) logic.step([gamepad()], 1 / 60)
    expect(u.mode).toBe('crawl')
    expect(u.y).toBeGreaterThan(OCTOPUS_LIMITS.crawlHeight - 0.02)
  })

  it('pulses the mantle through the jet cycle and pushes off on its arms', () => {
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
    const at = [u.x, u.z, ...u.shapes]
    for (let f = 0; f < 60; f++) logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.stopped).toBe(true)
    expect([u.x, u.z, ...u.shapes]).toEqual(at)
    expect(logic.readout(0)).toMatch(/^Stopped/)
    // Back to neutral, then a fresh push resumes.
    logic.step([gamepad()], 1 / 60)
    logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.stopped).toBe(false)
    for (let f = 0; f < 60; f++) logic.step([gamepad(0, -1)], 1 / 60)
    expect(u.z).toBeLessThan(at[1])
  })

  it('falls safely when its support goes: down onto what touches the floor, never through it', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    logic.step([gamepad(0, 0, ['curl'])], 1 / 60)
    u.y = 0.6
    let lowest = Infinity
    for (let f = 0; f < 120; f++) { logic.step([gamepad()], 1 / 60); lowest = Math.min(lowest, u.y) }
    expect(u.y).toBeLessThan(0.2)
    expect(lowest).toBeGreaterThan(0.04)
  })

  it('shows itself when nobody holds it: wraps the ball, carries it into the ring, without scoring or events', () => {
    const logic = new OctopusLogic(), u = logic.units[0], run = (logic as unknown as { run: { route: number }[] }).run[0]
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
    expect([u.x, u.y, u.z, u.h, ...u.shapes, ...u.cups].every(Number.isFinite)).toBe(true)
    logic.home(0)
    expect([u.x, u.z, u.h, u.mode]).toEqual([0, 0.9, 0, 'crawl'])
  })
})
