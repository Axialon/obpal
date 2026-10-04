import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import { HandGesture, emptyPad, type Vec3 } from '@obpal/core'
import type { Frame } from '@obpal/host'
import { BALL_RADIUS, OctopusLogic } from '../src/sim/devices/octopus'
import { HAND, HandControl, fingerCurls } from '../src/sim/devices/octopus-hand'
import { ArmRod, FREE, ROD_SEGMENTS } from '../src/sim/continuum/rod'
import { restInput, type DeviceInput } from '../src/sim/devices/types'

type Hand = NonNullable<Frame['hand']>
type Arm = { index: number; rod: ArmRod; role: string; pair: number; lifted: boolean }
type Run = { arms: Arm[]; grab: string; pinchGrab: boolean }
const runOf = (logic: OctopusLogic) => (logic as unknown as { run: Run[] }).run[0]

/**
 * A synthetic camera hand: the 21 landmarks with each finger bent evenly at its three joints, so that its measured curl
 * is the one asked for. Index to little, from the wrist at the origin, the palm facing the camera (+z).
 */
function hand(curls: readonly number[], { gestures = 0, tracked = true, confidence = 0.95, gen = 1 } = {}): Hand {
  const points: Vec3[] = Array.from({ length: 21 }, () => [0, 0, 0])
  for (let k = 1; k <= 4; k++) points[k] = [-0.03 * k, 0.02 * k, 0.005 * k]
  ;[5, 9, 13, 17].forEach((base, i) => {
    const knuckle = new Vector3(0.03 - i * 0.02, 0.09, 0), along = knuckle.clone().normalize()
    const axis = new Vector3().crossVectors(along, new Vector3(0, 0, 1)).normalize(), bend = (curls[i] * 2.6) / 3
    let at = knuckle.clone()
    points[base] = at.toArray() as Vec3
    ;[0.04, 0.025, 0.02].forEach((length, k) => {
      const bone = along.clone().applyQuaternion(new Quaternion().setFromAxisAngle(axis, -bend * (k + 1))).multiplyScalar(length)
      at = at.clone().add(bone)
      points[base + k + 1] = at.toArray() as Vec3
    })
  })
  return { tracked, gen, t: 0, handedness: 'right', confidence, gestures, p: [0, 0, -0.45], landmarks: points }
}
const OPEN = [0, 0, 0, 0]
const by = (h: Hand | null, presses: string[] = []): DeviceInput => ({ ...restInput(), hand: h, presses })
const tip = (arm: Arm) => arm.rod.position[ROD_SEGMENTS * 3 + 1]
const run = (logic: OctopusLogic, frames: number, input: () => DeviceInput) => { for (let f = 0; f < frames; f++) logic.step([input()], 1 / 60) }

describe('the octopus by the Hand camera: reading the hand', () => {
  it('measures each finger’s curl from the 21 landmarks', () => {
    const curls = fingerCurls(hand([0, 0.5, 0.9, 0.2]).landmarks)!
    ;[0, 0.5, 0.9, 0.2].forEach((c, i) => expect(curls[i]).toBeCloseTo(c, 3))
    expect(fingerCurls(hand(OPEN).landmarks.slice(0, 20))).toBeNull()
    expect(fingerCurls(hand(OPEN).landmarks.map(() => [0, 0, 0]))).toBeNull()
    expect(fingerCurls(hand(OPEN).landmarks.map((p, i) => (i === 7 ? [NaN, 0, 0] : p)))).toBeNull()
  })

  it('smooths the curls, debounces the pinch and reports a loss once', () => {
    const control = new HandControl()
    control.step(hand([1, 0, 0, 0]), 1 / 60)
    expect(control.curls[0]).toBeGreaterThan(0)
    expect(control.curls[0]).toBeLessThan(0.5)
    expect(control.step(hand(OPEN, { gestures: HandGesture.pinch }), 1 / 60)).toEqual({ lost: false, pinch: true, unpinch: false })
    // The index bends as it pinches: its curl holds while the pinch is on, the other fingers still follow.
    const index = control.curls[0]
    control.step(hand([0.9, 0.9, 0, 0], { gestures: HandGesture.pinch }), 0.5)
    expect(control.curls[0]).toBe(index)
    expect(control.curls[1]).toBeGreaterThan(0.8)
    // A frame or two without the pinch is not letting go; a quarter second is.
    expect(control.step(hand(OPEN), 2 / 60).unpinch).toBe(false)
    expect(control.step(hand(OPEN, { gestures: HandGesture.pinch }), 1 / 60).pinch).toBe(false)
    let unpinch = false
    for (let f = 0; f < 20 && !unpinch; f++) unpinch = control.step(hand(OPEN), 1 / 60).unpinch
    expect(unpinch).toBe(true)
    // Unsure, untracked or gone: lost once, curls back to zero.
    control.step(hand([1, 1, 1, 1]), 1)
    expect(control.step(hand([1, 1, 1, 1], { confidence: HAND.confidence - 0.1 }), 1 / 60)).toEqual({ lost: true, pinch: false, unpinch: false })
    expect(control.curls).toEqual([0, 0, 0, 0])
    expect(control.step(null, 1 / 60).lost).toBe(false)
    control.step(hand(OPEN), 1 / 60)
    expect(control.step(hand(OPEN, { tracked: false }), 1 / 60).lost).toBe(true)
  })
})

describe('the octopus by the Hand camera: driving it', () => {
  it('pairs the arms mirrored, front to back, one finger each', () => {
    const arms = runOf(new OctopusLogic()).arms
    for (let pair = 0; pair < 4; pair++) {
      const members = arms.filter((a) => a.pair === pair)
      expect(members).toHaveLength(2)
      expect(members.map((a) => a.index).sort()).toEqual([pair, pair + 4])
    }
  })

  it('a curled finger lifts its pair off the floor and curls it; opened, the pair reaches back down and holds', () => {
    const logic = new OctopusLogic(), arms = runOf(logic).arms, front = arms.filter((a) => a.pair === 0), rest = arms.filter((a) => a.pair !== 0)
    run(logic, 90, () => by(hand([0.95, 0, 0, 0])))
    for (const arm of front) {
      expect(arm.role).toBe('lift')
      expect(Array.from(arm.rod.held).every((h) => h === FREE)).toBe(true)
      expect(tip(arm)).toBeGreaterThan(0.12)
    }
    expect(rest.every((a) => a.role === 'plant' || a.role === 'peel' || a.role === 'recover' || a.role === 'reach')).toBe(true)
    expect(rest.filter((a) => a.role === 'plant').length).toBeGreaterThanOrEqual(4)
    // The middle finger joins: the second pair lifts too, and the first stays up.
    run(logic, 60, () => by(hand([0.95, 0.95, 0, 0])))
    expect(arms.filter((a) => a.role === 'lift').map((a) => a.pair).sort()).toEqual([0, 0, 1, 1])
    // Opened: they reach back down and hold the floor again.
    run(logic, 240, () => by(hand(OPEN)))
    expect(arms.some((a) => a.role === 'lift' || a.lifted)).toBe(false)
    for (const arm of front) expect(Array.from(arm.rod.held).some((h) => h !== FREE)).toBe(true)
  })

  it('a pinch grabs the ball, a missed frame keeps it, and opening the pinch lets go', () => {
    const logic = new OctopusLogic(), u = logic.units[0]
    Object.assign(u.ball, { x: u.x + 0.6, z: u.z, y: BALL_RADIUS })
    const pinching = () => by(hand([0.3, 0, 0, 0], { gestures: HandGesture.pinch }))
    for (let f = 0; f < 150 && !u.ball.held; f++) logic.step([pinching()], 1 / 60)
    expect(u.ball.held).toBe(true)
    run(logic, 30, pinching)
    logic.step([by(hand([0.3, 0, 0, 0]))], 1 / 60)
    run(logic, 10, pinching)
    expect(u.ball.held).toBe(true)
    run(logic, 30, () => by(hand([0.3, 0, 0, 0])))
    expect(u.ball.held).toBe(false)
  })

  it('losing the hand lets lifted arms down, cancels a pinch’s reach and keeps a ball already held', () => {
    const logic = new OctopusLogic(), u = logic.units[0], r = runOf(logic)
    run(logic, 90, () => by(hand([0.95, 0.95, 0, 0])))
    expect(r.arms.filter((a) => a.role === 'lift')).toHaveLength(4)
    logic.drain()
    run(logic, 1, () => by(hand([0.95, 0.95, 0, 0], { tracked: false })))
    expect(logic.drain().some((e) => e.text === 'Hand lost · arms down')).toBe(true)
    run(logic, 240, () => by(null))
    expect(r.arms.some((a) => a.role === 'lift' || a.lifted)).toBe(false)
    expect(r.arms.filter((a) => a.role === 'plant' && Array.from(a.rod.held).some((h) => h !== FREE)).length).toBeGreaterThanOrEqual(6)

    // A pinch's reach under way is cancelled when the hand goes.
    Object.assign(u.ball, { x: u.x + 0.6, z: u.z, y: BALL_RADIUS })
    run(logic, 6, () => by(hand(OPEN, { gestures: HandGesture.pinch })))
    expect(r.grab).toBe('reach')
    run(logic, 1, () => by(null))
    expect(r.grab).toBe('none')
    run(logic, 120, () => by(null))
    expect(u.ball.held).toBe(false)

    // A ball already held is kept, not dropped; a later pinch lets it go.
    Object.assign(u.ball, { x: u.x + 0.6, z: u.z, y: BALL_RADIUS })
    for (let f = 0; f < 150 && !u.ball.held; f++) logic.step([by(hand(OPEN, { gestures: HandGesture.pinch }))], 1 / 60)
    expect(u.ball.held).toBe(true)
    run(logic, 60, () => by(null))
    expect(u.ball.held).toBe(true)
    run(logic, 5, () => by(hand(OPEN)))
    run(logic, 5, () => by(hand(OPEN, { gestures: HandGesture.pinch })))
    run(logic, 5, () => by(hand(OPEN)))
    expect(u.ball.held).toBe(false)
  })

  it('Stop still works under the hand: everything holds and the hand’s gestures cannot start it again', () => {
    const logic = new OctopusLogic(), u = logic.units[0], r = runOf(logic)
    Object.assign(u.ball, { x: u.x + 0.6, z: u.z, y: BALL_RADIUS })
    run(logic, 30, () => by(hand([0.95, 0, 0, 0])))
    logic.step([by(hand([0.95, 0, 0, 0]), ['stop'])], 1 / 60)
    expect(u.stopped).toBe(true)
    const still = [...u.arms]
    // A fist, then a pinch, then a lost hand: nothing moves and nothing grabs.
    run(logic, 60, () => by(hand([1, 1, 1, 1])))
    run(logic, 60, () => by(hand(OPEN, { gestures: HandGesture.pinch })))
    run(logic, 30, () => by(null))
    expect(u.stopped).toBe(true)
    expect(u.arms).toEqual(still)
    expect(r.grab).toBe('none')
    expect(u.ball.held).toBe(false)
    // A fresh stick, after it has rested, starts it again as before.
    logic.step([{ ...restInput(), pad: { ...emptyPad(), axes: [0, 0, 0, 0] } }], 1 / 60)
    logic.step([{ ...restInput(), pad: { ...emptyPad(), axes: [0, -1, 0, 0] } }], 1 / 60)
    expect(u.stopped).toBe(false)
  })
})
