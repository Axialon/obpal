import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { armFrames, armParts, blockBox, FINGERS, gap, restOf, settle, stepAmong, type Base, type Blk, type Box, type Stand } from '../src/sim/arm/blocks'
import { fingerAt, FINGER_IN, FINGER_TRAVEL, FINGER_W, holding, reachAlong } from '../src/sim/arm/grasp'
import { ARM, FLOOR_CLEAR, forward, lowest, stepAboveFloor, type ArmPose } from '../src/sim/arm/kinematics'
import { JOINTS } from '../src/sim/arm/model'
import { reachDown, solveNear } from '../src/sim/arm/reach'

const D = Math.PI / 180
/** An arm at the middle, facing −x: at yaw 0 it reaches that way; turned positive, it swings toward +z. */
const HERE: Stand = { x: 0, z: 0, turn: 0 }
const KEYS = ['yaw', 'shoulder', 'elbow', 'wrist', 'roll'] as const
const cube = (x: number, z: number, yawDeg = 0, y = 0.03): Blk => ({ x, y, z, yaw: yawDeg * D, half: [0.03, 0.03, 0.03] })
/** A spot on the floor the arm reaches at `yawDeg`, `reach` out from its base. */
const spot = (yawDeg: number, reach: number): [number, number] => [-reach * Math.cos(yawDeg * D), reach * Math.sin(yawDeg * D)]
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
/** Overlap this small is touching, in these checks (m). */
const TOUCH = 0.0005
/** A sim arm headed for a pose. */
const SIM = { real: false, following: true, minShoulder: JOINTS[1].min }

/** A seeded random number generator (mulberry32), so a failing sweep can be replayed. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Arm { pose: ArmPose; open: number; vel: number[]; blocks: Blk[]; held: Box | null; grip: number; stopped: number; took: number }

const arm = (pose: ArmPose, open: number, blocks: Blk[]): Arm => ({ pose: { ...pose }, open, vel: [0, 0, 0, 0, 0, 0], blocks: blocks.map((b) => ({ ...b })), held: null, grip: 0, stopped: 0, took: 0 })

/**
 * One frame of main.ts's loop for an arm headed for a pose: each joint heads for its target under its speed and
 * acceleration caps, a held block keeps the gripper from closing further, the floor has its say, then the blocks.
 */
function frame(a: Arm, target: ArmPose, open: number, dt: number, world: { still?: Box[]; bases?: Base[] } = {}, real = false) {
  const was = { ...a.pose }, gripWas = a.open
  const angles = [...KEYS.map((k) => a.pose[k]), a.open]
  const targets = [...KEYS.map((k) => target[k]), open]
  angles.forEach((v0, i) => {
    const j = JOINTS[i]
    const e = targets[i] - v0
    const v = clamp(Math.abs(e) < (j.unit === '°' ? 0.05 : 0.002) ? 0 : e * 6, -j.vmax, j.vmax)
    a.vel[i] += clamp(v - a.vel[i], -j.amax * dt, j.amax * dt)
    angles[i] = clamp(v0 + a.vel[i] * dt, j.min, j.max)
  })
  let pose = Object.fromEntries(KEYS.map((k, i) => [k, angles[i]])) as unknown as ArmPose
  let o = angles[5]
  if (a.held) {
    const h = holding(a.grip, o)
    if (h.release) { a.held = null } else o = h.open
  }
  const f = stepAboveFloor(was, pose, true, JOINTS[1].min, a.held)
  pose = f.pose
  for (const k of f.floored) a.vel[KEYS.indexOf(k)] = 0
  const r = stepAmong(HERE, { pose: was, open: gripWas }, { pose, open: o }, a.held, { blocks: a.blocks, still: world.still ?? [], bases: world.bases ?? [] }, { real, following: true, minShoulder: JOINTS[1].min })
  if (real) { a.pose = pose; a.open = o } else { a.pose = r.pose; a.open = r.open }
  for (const k of r.stopped) a.vel[k === 'grip' ? 5 : KEYS.indexOf(k)] = 0
  if (r.stopped.length) a.stopped++
  a.blocks = r.blocks
  if (r.took) {
    a.held = r.took.box
    a.grip = r.open
    a.blocks = r.blocks.filter((_, i) => i !== r.took!.i)
    a.took++
  }
  return r
}

/** How far a block is into a base's column (0: clear). */
function inBase(b: Blk, base: Base) {
  let most = 0
  for (const [r, y0, y1] of [[0.27, 0, 0.1], [0.19, 0.1, 0.26]]) {
    if (b.y + b.half[1] <= y0 || b.y - b.half[1] >= y1) continue
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw), dx = base.x - b.x, dz = base.z - b.z
    const u = clamp(dx * c - dz * s, -b.half[0], b.half[0]), v = clamp(dx * s + dz * c, -b.half[2], b.half[2])
    most = Math.max(most, r - Math.hypot(b.x + u * c + v * s - base.x, b.z - u * s + v * c - base.z))
  }
  return most
}

/**
 * Nothing in anything: the arm's parts (and what it holds) out of every block, the blocks out of each other and the
 * bases, and the arm above the floor.
 */
function expectClear(a: Arm, bases: Base[] = [], what = '') {
  const parts = armParts(HERE, a.pose, a.open, a.held)
  for (const b of a.blocks) {
    const B = blockBox(b)
    for (const p of parts) expect(gap(p, B), what).toBeGreaterThan(-TOUCH)
    for (const base of bases) expect(inBase(b, base), what).toBeLessThan(TOUCH)
    for (const o of a.blocks) if (o !== b && Math.abs(o.y - b.y) < 0.059) expect(gap(blockBox(o), B), what).toBeGreaterThan(-TOUCH)
  }
  // The arm above the floor; holding a block it picked up off the floor, the two of them no lower than it.
  expect(lowest(a.pose, a.held), what).toBeGreaterThan((a.held ? 0 : FLOOR_CLEAR) - 1e-6)
}

describe('the arm as boxes, where ./model.ts puts its parts', () => {
  it('has its grasp and fingers where the model does, standing anywhere', () => {
    const R = rng(3)
    for (let n = 0; n < 20; n++) {
      const s: Stand = { x: (R() - 0.5) * 2, z: (R() - 0.5) * 2, turn: (R() - 0.5) * 7 }
      const p: ArmPose = { yaw: (R() - 0.5) * 300, shoulder: (R() - 0.3) * 120, elbow: R() * 140, wrist: (R() - 0.5) * 200, roll: (R() - 0.5) * 340 }
      const open = R()
      // The model's own nesting, in three.js.
      const link = (parent: THREE.Object3D, y: number) => { const o = new THREE.Group(); o.position.y = y; parent.add(o); return o }
      const root = new THREE.Group()
      root.position.set(s.x, 0, s.z)
      root.rotation.y = s.turn
      const yaw = link(root, 0.1), shoulder = link(yaw, ARM.H0 - 0.1), elbow = link(shoulder, ARM.L1), wrist = link(elbow, ARM.L2)
      const roll = link(wrist, 0.12), grasp = link(roll, ARM.LT - 0.12)
      yaw.rotation.y = p.yaw * D
      shoulder.rotation.z = p.shoulder * D
      elbow.rotation.z = p.elbow * D
      wrist.rotation.z = p.wrist * D
      roll.rotation.y = p.roll * D
      const finger = new THREE.Object3D()
      finger.position.set(FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL * open, 0.095, 0)
      roll.add(finger)
      root.updateMatrixWorld(true)
      const g = armFrames(s, p).grasp
      const at = grasp.getWorldPosition(new THREE.Vector3())
      g.t.forEach((v, i) => expect(v).toBeCloseTo(at.getComponent(i), 9))
      const e = grasp.matrixWorld.elements
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) expect(g.R[r * 3 + c]).toBeCloseTo(e[c * 4 + r], 9)
      const f = armParts(s, p, open)[FINGERS[1]].c
      const fw = finger.getWorldPosition(new THREE.Vector3())
      f.forEach((v, i) => expect(v).toBeCloseTo(fw.getComponent(i), 9))
    }
  })
})

describe('the robot arm among the blocks: nothing passes through anything', () => {
  it('pushes a block it sweeps into along the floor, and turns one it catches at an end', () => {
    // The closed gripper low, swung across a block square in its way, then across one it catches at an end.
    const turned = [0, 0.025].map((off) => {
      const [x, z] = spot(0, 0.7)
      const a = arm(reachDown(-12, 0.7, 0.045)!.pose, 0, [cube(x + off, z)])
      const to = reachDown(12, 0.7, 0.045)!.pose
      for (let i = 0; i < 90; i++) { frame(a, to, 0, 1 / 60); expectClear(a) }
      const b = a.blocks[0]
      expect(b.z - z).toBeGreaterThan(0.05)
      // Pushed, not in the way: the arm got where it was going.
      expect(a.pose.yaw).toBeCloseTo(to.yaw, 1)
      return Math.abs(b.yaw)
    })
    // (Swung on an arc, the fingers turn as they go, and a block pushed square turns a little with them.)
    expect(turned[1]).toBeGreaterThan(turned[0] + 0.1)
  })

  it('sweeps through a row of blocks, pushing them into each other without any in another', () => {
    const blocks = [0, 1, 2, 3].map((i) => { const [x, z] = spot(-4 + i * 5.2, 0.7); return cube(x, z, 7 * i) })
    const a = arm(reachDown(-16, 0.7, 0.045)!.pose, 0, blocks)
    const to = reachDown(40, 0.7, 0.045)!.pose
    for (let i = 0; i < 150; i++) { frame(a, to, 0, 1 / 60); expectClear(a) }
    a.blocks.forEach((b, i) => expect(Math.hypot(b.x - blocks[i].x, b.z - blocks[i].z)).toBeGreaterThan(0.02))
  })

  it('pushes a block it sweeps across in one long frame just as far as in many short ones, rather than jumping past it', () => {
    const [x, z] = spot(0, 0.7)
    const from = reachDown(-15, 0.7, 0.045)!.pose, to = reachDown(15, 0.7, 0.045)!.pose
    // The fingers move about 0.36 m in this one step.
    const r = stepAmong(HERE, { pose: from, open: 0 }, { pose: to, open: 0 }, null, { blocks: [cube(x, z)], still: [], bases: [] }, SIM)
    expect(r.stopped).toEqual([])
    for (const p of armParts(HERE, r.pose, 0)) expect(gap(p, blockBox(r.blocks[0]))).toBeGreaterThan(-TOUCH)
    // The same swing in 60 short steps.
    let blocks = [cube(x, z)]
    const at = (f: number) => Object.fromEntries(KEYS.map((k) => [k, from[k] + (to[k] - from[k]) * f])) as unknown as ArmPose
    for (let i = 0; i < 60; i++) blocks = stepAmong(HERE, { pose: at(i / 60), open: 0 }, { pose: at((i + 1) / 60), open: 0 }, null, { blocks, still: [], bases: [] }, SIM).blocks
    // Pushed the way the fingers swing, most of the way it goes in short steps (it slides and turns on its own way
    // along the fingers' ends, so not to the millimetre).
    const [one, many] = [r.blocks[0], blocks[0]]
    expect(many.z - z).toBeGreaterThan(0.15)
    expect(one.z - z).toBeGreaterThan(0.6 * (many.z - z))
  })

  it('comes down on a block and stops on its top, as on the floor, leaving it where it was', () => {
    const [x, z] = spot(0, 0.7)
    for (const open of [0, 0.15]) {
      const block = cube(x, z, 10)
      const a = arm(reachDown(0, 0.7, 0.25)!.pose, open, [block])
      // Headed for the floor, right through it.
      const to = reachDown(0, 0.7, 0.02)!.pose
      for (let i = 0; i < 120; i++) { frame(a, to, open, 1 / 60); expectClear(a) }
      expect(a.stopped).toBeGreaterThan(0)
      const b = a.blocks[0]
      expect(Math.hypot(b.x - block.x, b.z - block.z)).toBeLessThan(1e-9)
      expect(b.yaw).toBeCloseTo(block.yaw, 12)
      // Resting on it: the fingertips at its top, a hair above at most.
      const fingers = armParts(HERE, a.pose, a.open).filter((_, i) => (FINGERS as readonly number[]).includes(i))
      const touch = Math.min(...fingers.map((f) => gap(f, blockBox(b))))
      expect(touch).toBeGreaterThan(-TOUCH)
      expect(touch).toBeLessThan(0.001)
      expect(forward(a.pose).height).toBeGreaterThan(0.06 + 0.03)
    }
  })

  it('stops at a block that can’t be pushed (pinned against a base), going no further into it', () => {
    const [x, z] = spot(0, 0.7)
    const a = arm(reachDown(-10, 0.7, 0.045)!.pose, 0, [cube(x, z), cube(...spot(0, 0.62), 0), cube(...spot(0, 0.78), 0)])
    // Blocks each side of it: pinned, the middle one can't be pushed along, so the swing stops at it.
    a.blocks[1].z = a.blocks[0].z + 0.061
    a.blocks[1].x = a.blocks[0].x
    a.blocks[2].z = a.blocks[1].z + 0.061
    a.blocks[2].x = a.blocks[0].x
    const bases: Base[] = [{ x: a.blocks[0].x, z: a.blocks[2].z + 0.03 + 0.27 + 0.001 }]
    const to = reachDown(20, 0.7, 0.045)!.pose
    for (let i = 0; i < 90; i++) { frame(a, to, 0, 1 / 60, { bases }); expectClear(a, bases) }
    expect(a.stopped).toBeGreaterThan(0)
    expect(a.pose.yaw).toBeLessThan(0)
  })

  it('closes on a turned block square between the fingers, and holds it at its width', () => {
    const [x, z] = spot(0, 0.7)
    for (const turn of [0, 12, 30, 44.9, 45, 70]) {
      const a = arm(reachDown(0, 0.7, 0.04)!.pose, 1, [cube(x + 0.006, z, turn)])
      const pose = { ...a.pose }
      for (let i = 0; i < 90 && !a.took; i++) { frame(a, pose, 0, 1 / 60); expectClear(a) }
      expect(a.took, `${turn}°`).toBe(1)
      expect(2 * fingerAt(a.open)).toBeCloseTo(0.06, 6)
      // Square between the fingers, in their middle.
      const h = a.held!
      expect(Math.abs(h.c[0])).toBeLessThan(1e-9)
      expect(Math.max(Math.abs(h.axes[0][0]), Math.abs(h.axes[2][0]))).toBeCloseTo(1, 9)
      // Carried: lifted and swung, it comes along, the gripper still at its width however hard it's told to close.
      const up = reachDown(30, 0.6, 0.3)!.pose
      for (let i = 0; i < 90; i++) { frame(a, up, 0, 1 / 60); expectClear(a) }
      expect(a.held).toBe(h)
      expect(2 * fingerAt(a.open)).toBeCloseTo(0.06, 6)
    }
  })

  it('coming straight down over a block, as the claw does, closes around it and picks it up, square or turned', () => {
    for (const reach of [0.4, 0.7, 1.0]) {
      for (const turn of [0, 25, 45]) {
        const [x, z] = spot(10, reach)
        const a = arm(reachDown(10, reach, 0.2)!.pose, 1, [cube(x, z, turn)])
        // Down a little further each frame (the claw's 0.3 m/s), then closed.
        for (let h = 0.2, i = 0; i < 150 && !a.took; i++) {
          h = Math.max(0.035, h - 0.3 / 60)
          frame(a, reachDown(10, reach, h)!.pose, h > 0.035 || i < 60 ? 1 : 0, 1 / 60)
          expectClear(a)
        }
        expect(a.took, `${reach} m, ${turn}°`).toBe(1)
        // The gap is its width along the grip: 6 cm, square (a hair more if the gripper isn't quite plumb).
        expect(2 * fingerAt(a.open)).toBeCloseTo(2 * reachAlong(a.held!, 0), 9)
        expect(Math.abs(2 * fingerAt(a.open) - 0.06)).toBeLessThan(0.0005)
      }
    }
  })

  it('puts a held block down on another, and on the floor, no lower', () => {
    const [x, z] = spot(0, 0.7)
    const a = arm(reachDown(0, 0.7, 0.04)!.pose, 1, [cube(x, z)])
    for (let i = 0; i < 90 && !a.took; i++) frame(a, a.pose, 0, 1 / 60)
    expect(a.took).toBe(1)
    // Over another block, and down.
    const [x2, z2] = spot(25, 0.7)
    a.blocks.push(cube(x2, z2))
    for (let i = 0; i < 120; i++) { frame(a, reachDown(25, 0.7, 0.3)!.pose, 0, 1 / 60); expectClear(a) }
    for (let i = 0; i < 150; i++) { frame(a, reachDown(25, 0.7, 0.02)!.pose, 0, 1 / 60); expectClear(a) }
    // Stopped with the held block on the other's top.
    const held = armParts(HERE, a.pose, a.open, a.held).at(-1)!
    expect(gap(held, blockBox(a.blocks[0]))).toBeLessThan(0.001)
    expect(held.c[1]).toBeGreaterThan(0.06 + 0.03 - 0.001)
  })

  it('over many random sweeps: no part in a block, no block in another or in a base, the arm above the floor', { timeout: 30000 }, () => {
    const R = rng(11)
    let frames = 0, moved = 0, stops = 0
    const bases: Base[] = [{ x: 0, z: 0 }, { x: -1.56, z: 0 }]
    for (let run = 0; run < 36; run++) {
      const blocks: Blk[] = []
      while (blocks.length < 5) {
        const [x, z] = spot((R() - 0.5) * 120, 0.4 + R() * 0.6)
        const b = cube(x, z, R() * 90)
        if (blocks.every((o) => Math.hypot(o.x - b.x, o.z - b.z) > 0.1) && inBase(b, bases[1]) === 0) blocks.push(b)
      }
      // Stack one now and then.
      if (R() < 0.3) blocks.push({ ...blocks[0], y: 0.09, yaw: blocks[0].yaw + 0.3 })
      const start = reachDown((R() - 0.5) * 120, 0.4 + R() * 0.6, 0.3)!.pose
      const a = arm(start, R(), blocks)
      if (armParts(HERE, start, a.open).some((p) => blocks.some((b) => gap(p, blockBox(b)) < 0))) continue
      const before = blocks.map((b) => ({ ...b }))
      // Down low somewhere, then swung low across to somewhere else, the gripper at any angle and opening and closing.
      for (let leg = 0; leg < 3; leg++) {
        const t = solveNear({ yaw: (R() - 0.5) * 120, reach: 0.35 + R() * 0.75, height: 0.02 + R() * 0.1, pitch: 110 + R() * 80, roll: (R() - 0.5) * 120 })
        if (!t) continue
        const open = R() < 0.5 ? 0 : 1
        for (let i = 0; i < 70; i++) {
          frame(a, t.pose, open, 1 / 120 + R() * (1 / 20 - 1 / 120), { bases })
          expectClear(a, bases, `run ${run} leg ${leg} frame ${i}`)
          frames++
        }
      }
      moved += a.blocks.filter((b, i) => i < before.length && Math.hypot(b.x - before[i].x, b.z - before[i].z) > 0.005).length
      stops += a.stopped
    }
    // They did get in each other's way.
    expect(frames).toBeGreaterThan(5000)
    expect(moved).toBeGreaterThan(15)
    expect(stops).toBeGreaterThan(15)
  })
})

describe('a real arm among the blocks, which aren’t really there', () => {
  it('is never stopped or moved by one: coming down on it or closing on it, it pushes it out of its way', () => {
    const [x, z] = spot(0, 0.7)
    const a = arm(reachDown(0, 0.7, 0.25)!.pose, 1, [cube(x, z, 20)])
    const down = reachDown(0, 0.7, 0.02)!.pose
    for (let i = 0; i < 150; i++) {
      const r = frame(a, down, i < 45 ? 1 : 0, 1 / 60, {}, true)
      expectClear(a)
      // It went just where its joints took it, as a real arm would.
      expect(r.stopped).toEqual([])
      expect(r.took).toBeNull()
      KEYS.forEach((k) => expect(r.pose[k]).toBeCloseTo(a.pose[k], 9))
      expect(r.open).toBeCloseTo(a.open, 9)
    }
    expect(forward(a.pose).height).toBeLessThan(0.06)
    expect(a.open).toBeLessThan(0.01)
  })
})

describe('the blocks by themselves', () => {
  it('push a row along, the first shoving the next, and keep out of the bases', () => {
    const row = [0, 1, 2].map((i) => cube(-0.5 - i * 0.065, 0))
    // A part pushed 3 cm into the first one, from the arm's side.
    const pusher: Box = { c: [-0.5 + 0.03 + 0.009 - 0.03, 0.05, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], half: [0.009, 0.05, 0.0275] }
    expect(settle(row, [pusher], [], [])).toBe('ok')
    for (let i = 0; i < 3; i++) {
      expect(gap(pusher, blockBox(row[i]))).toBeGreaterThan(-0.0003)
      if (i) expect(gap(blockBox(row[i - 1]), blockBox(row[i]))).toBeGreaterThan(-0.0003)
    }
    expect(row[2].x).toBeLessThan(-0.5 - 2 * 0.065)
    // Pushed through their middles, they slide straight; a block pushed at one end turns.
    for (const b of row) expect(b.yaw).toBeCloseTo(0, 9)
    const end = [cube(-0.5, 0)]
    expect(settle(end, [{ ...pusher, c: [pusher.c[0], 0.05, 0.03] }], [], [])).toBe('ok')
    expect(Math.abs(end[0].yaw)).toBeGreaterThan(0.05)
    // With a base right behind the row, it can't go: pinned.
    const row2 = [0, 1, 2].map((i) => cube(-0.5 - i * 0.065, 0))
    expect(settle(row2, [pusher], [], [{ x: -0.5 - 2 * 0.065 - 0.03 - 0.27 - 0.001, z: 0 }])).toBe('pinned')
  })

  it('come to rest on a block they sit on, and slide off one their middle is past the edge of', () => {
    const under = cube(0, 0)
    expect(restOf({ ...cube(0.02, 0.01, 30), y: 0.5 }, [under])).toEqual({ x: 0.02, y: 0.09, z: 0.01 })
    const off = restOf({ ...cube(0.045, 0), y: 0.5 }, [under])
    expect(off.y).toBeCloseTo(0.03, 12)
    expect(off.x).toBeGreaterThanOrEqual(0.06)
    expect(restOf(cube(0.2, 0), [under])).toEqual({ x: 0.2, y: 0.03, z: 0 })
  })
})
