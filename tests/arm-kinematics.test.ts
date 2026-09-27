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

import { solveNear, withinLimits } from '../src/sim/arm/reach'

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

import { FLOOR_CLEAR, lowest, stepAboveFloor, toolFloor } from '../src/sim/arm/kinematics'
import { JOINTS } from '../src/sim/arm/model'

const KEYS = ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const
const asPose = (a: number[]): ArmPose => ({ yaw: a[0], shoulder: a[1], elbow: a[2], wrist: a[3], roll: a[4] })
/** Elbow up: in the arm's plane, the elbow is above the line from the shoulder to the wrist. */
function elbowUp(p: ArmPose) {
  const r = (d: number) => (d * Math.PI) / 180
  const e = [0.55 * Math.sin(r(p.shoulder)), 0.55 * Math.cos(r(p.shoulder))]
  const w = [e[0] + 0.46 * Math.sin(r(p.shoulder + p.elbow)), e[1] + 0.46 * Math.cos(r(p.shoulder + p.elbow))]
  return w[0] * e[1] - w[1] * e[0] >= -1e-9
}
/**
 * The sim's joint follower (main.ts stepArm), headed for `to(t)`: each joint approaches its target under its own
 * speed and acceleration caps, then the floor has its say. The lowest the arm got, and whether it arrived.
 */
function travel(from: ArmPose, to: (t: number) => ArmPose, seconds: number) {
  const dt = 1 / 60
  const ang = KEYS.map((k) => from[k]), vel = KEYS.map(() => 0)
  let least = Infinity, target = ang.slice()
  for (let t = 0; t < seconds; t += dt) {
    const p = to(t)
    target = KEYS.map((k) => p[k])
    const was = asPose(ang)
    KEYS.forEach((_, i) => {
      const j = JOINTS[i], e = target[i] - ang[i]
      const v = Math.max(-j.vmax, Math.min(j.vmax, Math.abs(e) < 0.05 ? 0 : e * 6))
      vel[i] += Math.max(-j.amax * dt, Math.min(j.amax * dt, v - vel[i]))
      ang[i] = Math.max(j.min, Math.min(j.max, ang[i] + vel[i] * dt))
    })
    const { pose, floored } = stepAboveFloor(was, asPose(ang), true, JOINTS[1].min)
    for (const k of floored) { const i = KEYS.indexOf(k); ang[i] = pose[k]; vel[i] = 0 }
    least = Math.min(least, lowest(asPose(ang)))
  }
  return { least, arrived: KEYS.every((_, i) => Math.abs(target[i] - ang[i]) < 1) }
}

describe('the floor: no part of the arm goes below it, whatever it is asked', () => {
  it('stops a target under the floor on it, at any angle of the gripper, elbow up', () => {
    let tried = 0
    for (let reach = 0.2; reach <= 1.2; reach += 0.05) {
      for (let height = -0.3; height <= 0.45; height += 0.05) {
        for (let pitch = 20; pitch <= 200; pitch += 10) {
          for (const roll of [-135, -90, -45, 0, 45, 90, 135]) {
            const { pose, reached } = inverse({ yaw: 0, reach, height, pitch, roll })
            if (!reached || !withinLimits(pose)) continue
            tried++
            expect(lowest(pose), JSON.stringify({ reach, height, pitch, roll })).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
            expect(elbowUp(pose)).toBe(true)
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(5000)
  })

  it('puts the gripper exactly where asked when that is above the floor', () => {
    for (const t of [{ yaw: 10, reach: 0.7, height: 0.3, pitch: 150, roll: 20 }, { yaw: 0, reach: 0.6, height: 0.04, pitch: 180, roll: 0 }]) {
      expect(t.height).toBeGreaterThanOrEqual(toolFloor(t.pitch, t.roll))
      const got = forward(inverse(t).pose)
      expect(got.reach).toBeCloseTo(t.reach, 6)
      expect(got.height).toBeCloseTo(t.height, 6)
    }
  })

  it('keeps Point, the claw and 3D above the floor, and the claw still reaches a block lying on it', () => {
    for (let reach = 0.25; reach <= 1.25; reach += 0.05) {
      for (const roll of [0, 45, 90]) {
        const claw = reachDown(0, reach, 0.035, roll)
        if (claw) expect(lowest(claw.pose)).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
        for (let pitch = 20; pitch <= 200; pitch += 10) {
          const hand = solveNear({ yaw: 0, reach, height: 0.035, pitch, roll })
          if (hand) expect(lowest(hand.pose), JSON.stringify({ reach, pitch, roll })).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
        }
      }
    }
    // Straight down over a block (6 cm, lying on the floor), the gripper closes within reach of its middle.
    const t = forward(reachDown(0, 0.6, 0.035)!.pose)
    expect(t.height - 0.03).toBeLessThan(0.02)
  })

  it('moving between poses, the joints never dip the arm through the floor, and still get there', () => {
    const home: ArmPose = { yaw: 0, shoulder: 18, elbow: 72, wrist: 62, roll: 0 }
    const starts = [home, reachDown(0, 1.1, 0.3)!.pose, reachDown(0, 0.4, 0.5)!.pose]
    let moves = 0
    for (let reach = 0.3; reach <= 1.2; reach += 0.1) {
      // The claw going down to the floor from its hover.
      const up = reachDown(0, reach, 0.2)?.pose, down = reachDown(0, reach, 0.035)?.pose
      if (up && down) {
        const r = travel(up, () => down, 5)
        expect(r.least).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
        expect(r.arrived).toBe(true)
        moves++
      }
      // A hand that lets go high and takes the arm again low, the gripper at any angle.
      for (let pitch = 30; pitch <= 200; pitch += 10) {
        const low = solveNear({ yaw: 0, reach, height: 0.035, pitch, roll: 0 })?.pose
        if (!low) continue
        for (const from of starts) {
          const r = travel(from, () => low, 5)
          expect(r.least, JSON.stringify({ reach, pitch, from })).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
          expect(r.arrived, JSON.stringify({ reach, pitch, from })).toBe(true)
          moves++
        }
      }
    }
    // And a hand swept to and fro along the floor.
    for (const pitch of [120, 150, 180]) {
      const r = travel(home, (t) => solveNear({ yaw: 0, reach: 0.75 + 0.4 * Math.sin(t * 2), height: 0.035, pitch, roll: 0 })?.pose ?? home, 8)
      expect(r.least).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
    }
    expect(moves).toBeGreaterThan(200)
  })

  it('stops a joint turned by hand at the floor, as at a limit', () => {
    const low = reachDown(0, 0.7, 0.035)!.pose
    // The wrist turned by hand, tipping the fingers down into the floor.
    const next = { ...low, wrist: low.wrist + 4 }
    expect(lowest(next)).toBeLessThan(FLOOR_CLEAR)
    const { pose, floored } = stepAboveFloor(low, next, false, JOINTS[1].min)
    expect(floored).toEqual(['wrist'])
    expect(pose.wrist).toBe(low.wrist)
    expect(lowest(pose)).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
  })
})
