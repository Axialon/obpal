import { describe, expect, it } from 'vitest'
import { ActorControl, HEADING_RATE, restIntent } from '../src/sim/humanoid/controls'
import { HEADING_LIMIT } from '../src/sim/humanoid/retarget'
import { KEEL, MORROW, neutral, rad, type Angles } from '../src/sim/humanoid/profile'
import { capture, personResult, playback, replay, standing, noise, type Rendered, type Recording } from './humanoid-body-trace'
import trace from './fixtures/body-turn-trace.json'

const deg = (n: number) => (n * 180) / Math.PI
const recording = () => trace as Recording
/** The largest change of any rendered joint between consecutive rendered frames. */
function worstStep(frames: readonly Rendered[], ids?: readonly string[]) {
  let worst = { value: 0, joint: '', at: 0 }
  for (let i = 1; i < frames.length; i++)
    for (const id of ids ?? Object.keys(frames[i].pose)) {
      const value = Math.abs(frames[i].pose[id] - frames[i - 1].pose[id])
      if (value > worst.value) worst = { value, joint: id, at: frames[i].at }
    }
  return worst
}
const legs = ['left.leg.yaw', 'right.leg.yaw'],
  arms = ['left.arm.yaw', 'right.arm.yaw'],
  axial = [...legs, ...arms]
/** Straight legs must hold their rest twist; arms bent 20° may follow their partly observed elbow plane. */
const twisted = (f: Rendered) => [...legs.map((id) => [id, 3] as const), ...arms.map((id) => [id, 12] as const)].filter(([id, most]) => Math.abs(deg(f.pose[id])) >= most)
const tracked = (frames: readonly Rendered[]) => frames.filter((f) => f.retargeted.tracked)
const scene = (person: (ms: number) => { q: Angles; heading: number } | null, camera = {}, seed = 3) => {
  const random = noise(seed)
  return (ms: number) => {
    const p = person(ms)
    return p && personResult(p, { jitter: 0.008, depth: 0.03, ...camera }, random)
  }
}

describe('BODY heading and axial stability from a recorded camera trace', () => {
  const frames = replay(playback(recording()))
  it('replays real BODY packets through the host input', () => {
    expect(recording().frames.length).toBeGreaterThan(200)
    expect(tracked(frames).length).toBeGreaterThan(frames.length * 0.9)
  })
  it('keeps straight limbs from spinning about their own axis under landmark noise', () => {
    // On the previous retargeting, centimetre noise swung straight hips through their full ±35° every few frames.
    for (const f of tracked(frames)) expect(twisted(f), `at ${f.at}`).toEqual([])
    expect(deg(worstStep(frames).value)).toBeLessThan(12)
  })
  it('turns the root with the calibrated pelvis, bounded, continuous across the half turn, and back to zero', () => {
    const facing = frames.map((f) => f.facing)
    for (const n of facing) expect(Math.abs(n)).toBeLessThanOrEqual(HEADING_LIMIT + 1e-9)
    for (let i = 1; i < facing.length; i++) expect(Math.abs(facing[i] - facing[i - 1])).toBeLessThanOrEqual(HEADING_RATE / 30 + 1e-9)
    // Mirror on: turning to your left turns the robot to its right, like a reflection.
    const sideOn = frames.filter((f) => f.at > 2600 && f.at < 3100)
    for (const f of sideOn) expect(deg(f.facing)).toBeLessThan(-55)
    const halfTurn = frames.filter((f) => f.at > 4100 && f.at < 4500)
    for (const f of halfTurn) expect(deg(f.facing)).toBeLessThan(-55)
    const back = frames.filter((f) => f.at > 6800)
    for (const f of back) expect(Math.abs(deg(f.facing))).toBeLessThan(5)
  })
})

describe('BODY scenarios on the kinematic practice path', () => {
  it('holds a side-on stance without twisting the legs or the torso', () => {
    const frames = replay(capture(scene((ms) => ({ q: standing(), heading: ms < 1200 ? 0 : rad(Math.min(90, (ms - 1200) / 8)) })), 5000))
    const settled = tracked(frames).filter((f) => f.at > 2500)
    expect(settled.length).toBeGreaterThan(60)
    for (const f of settled) {
      expect(twisted(f)).toEqual([])
      expect(Math.abs(deg(f.pose['spine.yaw']))).toBeLessThan(6)
      expect(deg(f.facing)).toBeCloseTo(-60, 0)
    }
    expect(deg(worstStep(frames).value)).toBeLessThan(10)
  })
  it('never accumulates heading over two full turns and returns to the calibrated front', () => {
    const frames = replay(
      capture(scene((ms) => ({ q: standing(), heading: ms < 1200 ? 0 : rad(Math.min(720, (ms - 1200) / 4)) - (ms > 4200 ? rad(Math.min(720, (ms - 4200) / 4)) : 0) })), 8200),
      { mirror: false },
    )
    for (const f of frames) expect(Math.abs(f.facing)).toBeLessThanOrEqual(HEADING_LIMIT + 1e-9)
    expect(Math.max(...frames.filter((f) => f.at > 1600 && f.at < 4200).map((f) => deg(f.facing)))).toBeGreaterThan(55)
    for (const f of frames.filter((f) => f.at > 7700)) expect(Math.abs(deg(f.facing))).toBeLessThan(5)
    expect(deg(worstStep(frames, axial).value)).toBeLessThan(10)
  })
  it('a mirrored camera picture equals switching the mirror: sides and turn both swap', () => {
    const person = (ms: number) => ({ q: { ...standing(), 'left.arm.pitch': rad(Math.min(80, ms / 15)), 'spine.yaw': rad(ms > 1500 ? 20 : 0) }, heading: ms > 1500 ? rad(30) : 0 })
    const plain = replay(capture(scene(person), 2600), { mirror: false }).at(-1)!
    const mirrored = replay(capture(scene(person, { mirrored: true }), 2600), { mirror: true }).at(-1)!
    expect(deg(plain.pose['left.arm.pitch'])).toBeGreaterThan(70)
    expect(deg(mirrored.pose['left.arm.pitch'])).toBeGreaterThan(70)
    expect(deg(plain.facing)).toBeCloseTo(30, -1)
    expect(deg(mirrored.facing)).toBeCloseTo(30, -1)
    expect(deg(plain.pose['spine.yaw'])).toBeCloseTo(20, -1)
    const swapped = replay(capture(scene(person, { mirrored: true }), 2600), { mirror: false }).at(-1)!
    expect(deg(swapped.pose['right.arm.pitch'])).toBeGreaterThan(70)
    expect(deg(swapped.facing)).toBeCloseTo(-30, -1)
  })
  it('goes quiet when the person is lost, and a returning person keeps the camera calibration', () => {
    const person = (ms: number) => (ms > 1500 && ms < 2400 ? null : { q: { ...standing(), 'left.arm.pitch': rad(ms < 1500 ? 70 : 10) }, heading: ms < 1500 ? rad(40) * Math.min(1, Math.max(0, ms - 1000) / 400) : rad(70) })
    const frames = replay(capture(scene(person), 4000), { mirror: false })
    const before = frames.filter((f) => f.at > 1450 && f.at < 1600).at(0)!
    expect(deg(before.facing)).toBeGreaterThan(30)
    const quiet = frames.filter((f) => f.at > 2300 && f.at < 2450)
    for (const f of quiet) {
      expect(f.retargeted.tracked).toBe(false)
      expect(Math.abs(deg(f.facing))).toBeLessThan(8)
      expect(deg(f.retargeted.q['right.arm.pitch'] + f.retargeted.q['left.arm.pitch'])).toBeLessThan(10)
    }
    const back = frames.filter((f) => f.retargeted.tracked && f.at > 2400)
    expect(back[0].retargeted.calibrating).toBe(true)
    expect(back[0].retargeted.generation).toBeGreaterThan(before.retargeted.generation)
    // Limbs and proportions restart, but the camera has not moved: the turned person turns the robot again, eased in.
    expect(Math.abs(deg(back[0].facing))).toBeLessThanOrEqual(deg(HEADING_RATE / 30) + 8)
    for (const f of back.filter((f) => f.at > 3200)) expect(deg(f.facing)).toBeCloseTo(60, 0)
    for (let i = 1; i < frames.length; i++) expect(Math.abs(frames[i].facing - frames[i - 1].facing)).toBeLessThanOrEqual(HEADING_RATE / 30 + 1e-9)
    // Reacquisition shows the new pose at once; the sim tendons bound how far a joint moves in one frame.
    expect(deg(worstStep(frames).value)).toBeLessThan(15)
  })
  it('calibrates a pitched camera so standing is upright and leaning still reads', () => {
    const frames = replay(capture(scene((ms) => ({ q: { ...standing(), 'spine.pitch': rad(ms > 1800 ? -15 : 0) }, heading: 0 }), { pitch: rad(15) }), 2800), { mirror: false })
    const upright = frames.filter((f) => f.at > 1200 && f.at < 1700)
    for (const f of upright) {
      expect(Math.abs(deg(f.pose['spine.pitch']))).toBeLessThan(4)
      for (const id of ['left.leg.pitch', 'right.leg.pitch']) expect(Math.abs(deg(f.pose[id]))).toBeLessThan(5)
    }
    expect(deg(frames.at(-1)!.pose['spine.pitch'])).toBeLessThan(-8)
  })
  // The previous Euler extraction pinned these at their roll limits (110° and −25°) once the swing passed 90°.
  it.each([
    ['arm forward overhead', 'left.arm.pitch', 'left.arm.roll', 10],
    ['high kick', 'left.leg.pitch', 'left.leg.roll', 15],
  ] as const)('%s passes 90° without wrapping into a sideways fling', (_, swing, roll, most) => {
    const limit = KEEL.joints.find((j) => j.id === swing)!.limits[1]
    const frames = replay(capture(scene((ms) => ({ q: { ...neutral(KEEL), [swing]: Math.min(limit - rad(5), rad(ms / 18)) }, heading: 0 }), { jitter: 0.005, depth: 0.015 }, 5), 3200), { mirror: false })
    expect(deg(frames.at(-1)!.retargeted.q[swing])).toBeGreaterThan(deg(limit) - 20)
    for (const f of tracked(frames)) expect(Math.abs(deg(f.retargeted.q[roll])), `${roll} at ${f.at}`).toBeLessThan(most)
  })
  it('Morrow follows the same trace with its own proportions', () => {
    const frames = replay(playback(recording()), { profile: MORROW })
    for (const f of tracked(frames)) expect(twisted(f), `at ${f.at}`).toEqual([])
    expect(Math.max(...frames.map((f) => Math.abs(f.facing)))).toBeLessThanOrEqual(HEADING_LIMIT + 1e-9)
  })
})

describe('BODY heading and classical control', () => {
  it('eases a bounded BODY turn, returns it without BODY and leaves the classical yaw alone', () => {
    const a = new ActorControl(KEEL),
      body = neutral(KEEL)
    for (let i = 0; i < 60; i++) a.step(1 / 60, restIntent(), body, rad(170))
    expect(a.heading).toBeCloseTo(HEADING_LIMIT, 3)
    expect(a.yaw).toBe(0)
    a.step(1 / 60, { x: 0, z: 0, yaw: 1, manual: true }, body, rad(170))
    expect(a.yaw).toBeGreaterThan(0)
    expect(a.facing).toBeCloseTo(a.yaw + a.heading)
    const before = a.heading
    a.step(1 / 60, restIntent(), null)
    expect(before - a.heading).toBeLessThanOrEqual(HEADING_RATE / 60 + 1e-9)
    for (let i = 0; i < 90; i++) a.step(1 / 60, restIntent(), null)
    expect(Math.abs(a.heading)).toBeLessThan(1e-3)
  })
  it('Stop freezes the BODY turn with the joints', () => {
    const a = new ActorControl(KEEL)
    for (let i = 0; i < 10; i++) a.step(1 / 60, restIntent(), neutral(KEEL), rad(40))
    a.stop()
    const held = a.heading
    a.step(1 / 60, restIntent(), null)
    expect(a.heading).toBe(held)
  })
})
