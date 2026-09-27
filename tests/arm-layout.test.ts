import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { armFrames, armParts, gap } from '../src/sim/arm/blocks'
import { headingFor, placement, reachDir, SLOTS, turnBetween } from '../src/sim/arm/layout'
import { JOINTS } from '../src/sim/arm/model'

const D = Math.PI / 180
const { min, max } = JOINTS[0]
const HOME = { yaw: 0, shoulder: JOINTS[1].home, elbow: JOINTS[2].home, wrist: JOINTS[3].home, roll: JOINTS[4].home }
/** Which way from an arm's base the middle of the floor is (a unit vector, x and z). */
const toMiddle = (n: number): [number, number] => { const s = placement(n); const l = Math.hypot(s.x, s.z); return [-s.x / l, -s.z / l] }
const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1]

describe('the arms around the floor: each faces the middle, the sector its base cannot turn to faces out', () => {
  it('at 0° every arm reaches for the middle, and its back sector (past either limit) points away from it', () => {
    for (let n = 1; n <= SLOTS.length; n++) {
      const s = placement(n)
      expect(dot(reachDir(s, 0), toMiddle(n)), `arm ${n} at 0°`).toBeCloseTo(1, 12)
      // The whole back sector, from one limit round to the other, faces away from the middle.
      for (let yaw = max; yaw <= min + 360; yaw += 1) expect(dot(reachDir(s, yaw), toMiddle(n)), `arm ${n} at ${yaw}°`).toBeLessThan(-0.98)
      // At its limits, it reaches out behind itself, 10° either side of straight back.
      expect(dot(reachDir(s, max), toMiddle(n))).toBeCloseTo(-Math.cos(10 * D), 12)
      expect(dot(reachDir(s, min), toMiddle(n))).toBeCloseTo(-Math.cos(10 * D), 12)
    }
  })

  it('as the scene draws it: the base turned 0° points the gripper at the middle, turned to a limit it points out', () => {
    for (let n = 1; n <= SLOTS.length; n++) {
      const s = placement(n)
      // Built as ./model.ts builds it: the root turned, the base turned on it, the arm reaching along −x.
      const root = new THREE.Group()
      root.position.set(s.x, 0, s.z)
      root.rotation.y = s.turn
      const base = new THREE.Group()
      root.add(base)
      const tip = new THREE.Object3D()
      tip.position.set(-1, 0, 0)
      base.add(tip)
      for (const yaw of [0, 45, -90, max, min]) {
        base.rotation.y = yaw * D
        root.updateMatrixWorld(true)
        const p = tip.getWorldPosition(new THREE.Vector3())
        const [x, z] = reachDir(s, yaw)
        expect(p.x - s.x).toBeCloseTo(x, 12)
        expect(p.z - s.z).toBeCloseTo(z, 12)
      }
      // And the kinematics the blocks use (./blocks.ts): at home, the gripper is nearer the middle than the base.
      const grasp = armFrames(s, HOME).grasp.t
      expect(Math.hypot(grasp[0], grasp[2]), `arm ${n}`).toBeLessThan(Math.hypot(s.x, s.z) - 0.6)
      const back = armFrames(s, { ...HOME, yaw: max }).grasp.t
      expect(Math.hypot(back[0], back[2]), `arm ${n} at its limit`).toBeGreaterThan(Math.hypot(s.x, s.z) + 0.6)
    }
  })

  it('facing each other at home, however many there are, the arms keep clear of one another', () => {
    for (let count = 2; count <= SLOTS.length; count++) {
      const parts = Array.from({ length: count }, (_, i) => armParts(placement(i + 1), HOME, 1))
      for (let i = 0; i < count; i++) {
        for (let j = i + 1; j < count; j++) {
          const least = Math.min(...parts[i].flatMap((a) => parts[j].map((b) => gap(a, b))))
          expect(least, `${count} arms: arm ${i + 1} and arm ${j + 1}`).toBeGreaterThan(0.05)
        }
      }
    }
  })
})

describe('the base heads for a target without swinging round its back', () => {
  /** A base following targets at its speed cap, 60 frames a second: the headings it took, and where it was. */
  function follow(targets: number[], start: number) {
    let at = start
    return targets.map((t) => {
      const h = headingFor(t, at, min, max)
      at += Math.max(-JOINTS[0].vmax / 60, Math.min(JOINTS[0].vmax / 60, h - at))
      return { t, h, at }
    })
  }

  it('faces a target it can face, however it is written', () => {
    expect([turnBetween(max, min), turnBetween(10, 370), turnBetween(-90, 90), turnBetween(0, -30)]).toEqual([20, 0, 180, 30])
    for (const t of [0, 30, -90, 169.5, -169.5]) {
      for (const at of [min, -40, 0, 60, max]) {
        const h = headingFor(t, at, min, max)
        // Within half a turn of the base (further, it may hold at a limit: below).
        if (Math.abs(t - at) <= 180) expect(h).toBeCloseTo(t, 9)
        expect(headingFor(t + 360, at, min, max)).toBeCloseTo(h, 9)
        expect(headingFor(t - 720, at, min, max)).toBeCloseTo(h, 9)
      }
    }
  })

  it('holds at the limit it is at while a target passes behind the arm, both ways, and turns back with it', () => {
    // From 150° round through the back (180°) to 12° past the far limit (−158°, written 202°), and back again.
    const out = Array.from({ length: 105 }, (_, i) => 150 + i * 0.5)
    const path = follow([...out, ...out.slice().reverse()], 150)
    for (const { t, h } of path) {
      if (t >= max) expect(h, `target ${t}°`).toBe(max)
      else expect(h).toBeCloseTo(t, 9)
    }
    expect(Math.max(...path.map((p) => p.at))).toBeCloseTo(max, 9)
    // The same from the other side.
    const mirrored = follow([...out, ...out.slice().reverse()].map((t) => -t), -150)
    for (const { t, h } of mirrored) if (t <= min) expect(h, `target ${t}°`).toBe(min)
  })

  it('goes the long way round (the only way it can) to a target well past its far limit, and keeps going', () => {
    const path = follow(Array.from({ length: 400 }, () => -120), max)
    expect(path[0].h).toBe(-120)
    // Never turning back on the way: 290° at 70°/s.
    for (let i = 1; i < path.length; i++) expect(path[i].at).toBeLessThanOrEqual(path[i - 1].at + 1e-9)
    expect(path.at(-1)!.at).toBeCloseTo(-120, 6)
  })

  it('from the middle of its range, heads for the limit nearer a target behind the arm', () => {
    expect(headingFor(175, 0, min, max)).toBe(max)
    expect(headingFor(-175, 0, min, max)).toBe(min)
    expect(headingFor(185, 20, min, max)).toBe(min)
    // Near one limit, a target just past the other is missed at the near one (it'd take most of a turn to face).
    expect(headingFor(-165, 160, min, max)).toBe(max)
  })

  it('a target wobbling just past its far limit leaves the base be; one wobbling well past it gets the base there, once', () => {
    const wobble = (c: number) => Array.from({ length: 600 }, (_, i) => c + 3 * Math.sin(i * 0.7) + 2 * Math.sin(i * 2.3))
    for (const p of follow(wobble(-165), max)) expect(p.at).toBe(max)
    const far = follow(wobble(-140), max)
    const there = far.findIndex((p) => p.at < -130)
    expect(there).toBeGreaterThan(0)
    for (let i = 1; i < there; i++) expect(far[i].at).toBeLessThanOrEqual(far[i - 1].at + 1e-9)
    for (const p of far.slice(there)) expect(p.at).toBeLessThan(-125)
  })
})
