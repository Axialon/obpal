import { describe, expect, it } from 'vitest'
import { forward, inverse, type ArmPose } from '../src/sim/arm/kinematics'

const HOME: ArmPose = { yaw: 0, shoulder: 18, elbow: 72, wrist: 62, roll: 0 }

describe('robot arm kinematics (the whole-arm node follows a tool target)', () => {
  it('puts the tool where forward kinematics says the home pose has it', () => {
    const t = forward(HOME)
    expect(t.reach).toBeCloseTo(0.738, 2)
    expect(t.height).toBeCloseTo(0.680, 2)
    expect(t.pitch).toBe(152)
  })

  it('round-trips poses across the workspace', () => {
    for (const p of [HOME, { yaw: 40, shoulder: 5, elbow: 95, wrist: 70, roll: 30 }, { yaw: -90, shoulder: 35, elbow: 60, wrist: 85, roll: -45 }]) {
      const { pose, reached } = inverse(forward(p))
      expect(reached).toBe(true)
      for (const k of ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const) expect(pose[k]).toBeCloseTo(p[k], 4)
    }
  })

  it('pulls an out-of-reach target back to the edge instead of failing', () => {
    const { pose, reached } = inverse({ yaw: 0, reach: 3, height: 0.5, pitch: 180, roll: 0 })
    expect(reached).toBe(false)
    const t = forward(pose)
    expect(Number.isFinite(t.reach)).toBe(true)
    expect(t.reach).toBeGreaterThan(0.9)
    expect(t.reach).toBeLessThan(1.3)
  })
})

import { reachDown } from '../src/sim/arm/reach'

describe('point and go: the gripper above a spot on the floor', () => {
  it('points straight down over a spot in reach', () => {
    const r = reachDown(30, 0.6, 0.2)!
    expect(r.exact).toBe(true)
    const t = forward(r.pose)
    expect(t.reach).toBeCloseTo(0.6, 3)
    expect(t.height).toBeCloseTo(0.2, 3)
    expect(t.pitch).toBeCloseTo(180, 3)
    expect(r.pose.yaw).toBe(30)
  })

  it('tips the tool toward a far spot, and pulls in a spot out of reach', () => {
    const far = reachDown(0, 1.05, 0.12)!
    expect(far.exact).toBe(true)
    expect(forward(far.pose).pitch).toBeLessThan(180)
    const beyond = reachDown(0, 2, 0.12)!
    expect(beyond.exact).toBe(false)
    expect(forward(beyond.pose).reach).toBeLessThan(1.25)
  })
})

import { solveNear } from '../src/sim/arm/reach'

describe('following a hand: position first', () => {
  it('tips the gripper when its angle can’t be kept, so the gripper still gets there', () => {
    // Pointing straight down this high and far out needs the wrist past its limit.
    const t = { yaw: 0, reach: 0.78, height: 0.42, pitch: 180, roll: 0 }
    const r = solveNear(t)!
    const got = forward(r.pose)
    expect(got.reach).toBeCloseTo(0.78, 3)
    expect(got.height).toBeCloseTo(0.42, 3)
  })
})
