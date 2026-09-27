import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { blockBox, squeeze, type Blk, type Frame } from '../src/sim/arm/blocks'
import { FINGER_IN, FINGER_TRAVEL, FINGER_W, fingerAt, holding, openingFor, reachAlong, type GripBox, type V3 } from '../src/sim/arm/grasp'
import { ARM, FLOOR_CLEAR, forward, heldDrop, inverse, lowest, stepAboveFloor, toolFloor, type ArmPose } from '../src/sim/arm/kinematics'
import { JOINTS } from '../src/sim/arm/model'

/** A box turned by yaw, pitch and roll (degrees, about the gripper's y, x and z), `half` its half-sizes, at `c`. */
function box(c: V3, turn: V3, half: V3 = [0.03, 0.03, 0.03]): GripBox {
  const [y, p, r] = turn.map((d) => (d * Math.PI) / 180)
  const rot = (v: V3): V3 => {
    // About z (roll), then x (pitch), then y (yaw).
    let [a, b, cc] = v
    ;[a, b] = [a * Math.cos(r) - b * Math.sin(r), a * Math.sin(r) + b * Math.cos(r)]
    ;[b, cc] = [b * Math.cos(p) - cc * Math.sin(p), b * Math.sin(p) + cc * Math.cos(p)]
    ;[a, cc] = [a * Math.cos(y) + cc * Math.sin(y), -a * Math.sin(y) + cc * Math.cos(y)]
    return [a, b, cc]
  }
  return { c: [...c], axes: [rot([1, 0, 0]), rot([0, 1, 0]), rot([0, 0, 1])], half }
}

/** The grasp frame of a gripper pointing straight down at (x, y, z): its fingers close along the world's x. */
const down = (x = 0, y = 0.04, z = 0): Frame => ({ R: [1, 0, 0, 0, -1, 0, 0, 0, -1], t: [x, y, z] })
const blk = (x: number, yawDeg: number, half: V3 = [0.03, 0.03, 0.03]): Blk => ({ x, y: half[1], z: 0.004, yaw: (yawDeg * Math.PI) / 180, half })
/** Half its width along the world's x (the way the fingers close), and how far its middle is from theirs. */
const across = (b: Blk) => reachAlong(blockBox(b), 0)

/**
 * The gripper closing from open at its top speed (main.ts steps its joint, then the blocks), a block between its
 * fingers: the opening it ends at, whether it holds the block, and the most a finger was ever inside it (≤ 0: never).
 */
function close(b: Blk, g = down(), speed = JOINTS[5].vmax, dt = 1 / 60) {
  let open = 1, held = false, inside = -Infinity
  for (let i = 0; i < 400 && !held; i++) {
    const to = Math.max(0, open - speed * dt)
    const s = squeeze(b, g, open, to)
    if (s) { open = s.open; held = s.held; Object.assign(b, s.b) } else open = to
    inside = Math.max(inside, Math.abs(b.x - g.t[0]) + across(b) - fingerAt(open))
  }
  return { open, held, inside }
}

describe('the gripper closing on a block: its fingers stop on its faces, the block square between them', () => {
  const turns = [0, 10, 20, 30, 44.9, 45, 60, 75, 89]
  const sizes: V3[] = [[0.03, 0.03, 0.03], [0.02, 0.03, 0.035], [0.035, 0.02, 0.03]]

  it('closes until both fingers touch it, turning it square: the gap is then its width along the grip, at any turn, of any size', () => {
    let gripped = 0
    for (const half of sizes) {
      for (const turn of turns) {
        for (const off of [0, 0.006, -0.011]) {
          const b = blk(off, turn, half)
          if (across(b) + Math.abs(off) > fingerAt(1)) continue
          const r = close(b)
          expect(r.held, JSON.stringify({ half, turn, off })).toBe(true)
          // Square: one of its sides along the grip.
          expect(Math.min(Math.abs(Math.sin(b.yaw)), Math.abs(Math.cos(b.yaw)))).toBeLessThan(1e-6)
          // The gap is its width that way, it's in their middle, and no finger was ever inside it.
          expect(2 * fingerAt(r.open)).toBeCloseTo(2 * across(b), 9)
          expect(b.x).toBeCloseTo(0, 9)
          expect(r.inside).toBeLessThanOrEqual(1e-9)
          gripped++
        }
      }
    }
    // (Turned far enough, a long block is wider than the open fingers and isn't tried.)
    expect(gripped).toBeGreaterThan(40)
  })

  it('turns it the short way to square, just as far as the fingers make it', () => {
    // At 30°, the short way is back to 0°; at 60°, on to 90°.
    for (const [turn, square] of [[30, 0], [60, 90], [-20, 0], [-70, -90]]) {
      const b = blk(0, turn)
      close(b)
      expect((b.yaw * 180) / Math.PI).toBeCloseTo(square, 6)
    }
    // Part of the way: 8.2 cm across at 30°, the fingers at 7 cm turn it until it's 7 cm across.
    const b = blk(0, 30)
    const s = squeeze(b, down(), 1, openingFor(0.035))!
    expect(s.held).toBe(false)
    expect(2 * across(s.b)).toBeCloseTo(0.07, 9)
    expect((s.b.yaw * 180) / Math.PI).toBeGreaterThan(0)
    expect((s.b.yaw * 180) / Math.PI).toBeLessThan(30)
  })

  it('holds it at that width while it is carried, however hard it is closed', () => {
    const { open: grip } = close(blk(0, 30))
    let open = grip
    for (let i = 0; i < 300; i++) {
      // Told to close all the way, every frame.
      const h = holding(grip, Math.max(0, open - JOINTS[5].vmax / 60))
      expect(h.release).toBe(false)
      open = h.open
      expect(open).toBe(grip)
    }
  })

  it('lets it go when it opens, not on a tremble', () => {
    const grip = 0.64
    expect(holding(grip, grip + 0.004)).toEqual({ open: grip + 0.004, release: false })
    expect(holding(grip, grip + 0.05).release).toBe(true)
  })

  it('closes all the way on nothing: a block beside the fingers, past their tips or across them is not between them', () => {
    for (const [x, y, z] of [[0.2, 0.03, 0], [0, 0.03, 0.2], [0.07, 0.03, 0]]) {
      const b: Blk = { x, y, z, yaw: 0, half: [0.03, 0.03, 0.03] }
      expect(squeeze(b, down(), 1, 0.5)).toBeNull()
      expect(squeeze(b, down(0, 0.4), 1, 0.5)).toBeNull()
    }
  })

  it('leaves a block to the pushing when the fingers close too steeply for it to turn on the floor', () => {
    // Fingers closing straight down onto it (the gripper on its side, rolled 90°).
    const steep: Frame = { R: [0, 1, 0, 1, 0, 0, 0, 0, -1], t: [0, 0.03, 0] }
    expect(squeeze(blk(0, 20), steep, 1, 0.5)).toBeNull()
  })
})

/** The arm's joints as ./model.ts builds them (no meshes), out to the grasp: the point between the fingers. */
function chain(p: ArmPose) {
  const D = Math.PI / 180
  const link = (parent: THREE.Object3D, y: number) => { const o = new THREE.Group(); o.position.y = y; parent.add(o); return o }
  const root = new THREE.Group()
  const yaw = link(root, 0.1), shoulder = link(yaw, ARM.H0 - 0.1), elbow = link(shoulder, ARM.L1), wrist = link(elbow, ARM.L2)
  const roll = link(wrist, 0.12), grasp = link(roll, ARM.LT - 0.12)
  yaw.rotation.y = p.yaw * D
  shoulder.rotation.z = p.shoulder * D
  elbow.rotation.z = p.elbow * D
  wrist.rotation.z = p.wrist * D
  roll.rotation.y = p.roll * D
  return { root, grasp }
}

describe('a held block clears the floor with the arm', () => {
  const poses: ArmPose[] = [
    { yaw: 0, shoulder: 40, elbow: 90, wrist: 50, roll: 0 },
    { yaw: 35, shoulder: 60, elbow: 70, wrist: 30, roll: 40 },
    { yaw: -80, shoulder: 20, elbow: 110, wrist: -20, roll: -75 },
    { yaw: 120, shoulder: 75, elbow: 60, wrist: 60, roll: 160 },
  ]
  const held = [box([0, 0.01, 0], [0, 0, 0]), box([0.004, 0.05, -0.01], [25, 10, -5]), box([0, -0.02, 0.012], [-40, 0, 30], [0.02, 0.035, 0.025])]

  it('knows where its lowest corner is, at any angle of the gripper (checked against the model’s own joints)', () => {
    for (const p of poses) {
      const { root, grasp } = chain(p)
      const tool = forward(p)
      // The model and the kinematics agree on where the grasp is.
      const at = grasp.getWorldPosition(new THREE.Vector3())
      expect(at.y).toBeCloseTo(tool.height, 9)
      expect(Math.hypot(at.x, at.z)).toBeCloseTo(Math.abs(tool.reach), 9)
      for (const h of held) {
        // The block as a child of the grasp, as the sim holds it: its corners, in the world.
        const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...h.axes[0]), new THREE.Vector3(...h.axes[1]), new THREE.Vector3(...h.axes[2]))
        const b = new THREE.Object3D()
        b.quaternion.setFromRotationMatrix(m)
        b.position.set(...h.c)
        grasp.add(b)
        root.updateMatrixWorld(true)
        let bottom = Infinity
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
          bottom = Math.min(bottom, b.localToWorld(new THREE.Vector3(sx * h.half[0], sy * h.half[1], sz * h.half[2])).y)
        }
        grasp.remove(b)
        expect(tool.height - heldDrop(tool.pitch, tool.roll, h)).toBeCloseTo(bottom, 9)
      }
    }
  })

  it('knows where the gripper’s own lowest corner is too: its fingers wide open and its palm (the model’s boxes)', () => {
    for (const p of [...poses, { yaw: 10, shoulder: 45, elbow: 95, wrist: 40, roll: 0 }, { yaw: 0, shoulder: 50, elbow: 80, wrist: 30, roll: 90 }]) {
      const { root, grasp } = chain(p)
      // The roll joint's frame is the grasp's parent; the fingers and palm sit in it as ./model.ts places them.
      const roll = grasp.parent!
      const x = FINGER_IN + FINGER_W / 2 + FINGER_TRAVEL
      const boxes: [V3, V3][] = [[[-x, 0.095, 0], [FINGER_W / 2, 0.05, 0.0275]], [[x, 0.095, 0], [FINGER_W / 2, 0.05, 0.0275]], [[0, 0.03, 0], [0.07, 0.0175, 0.035]]]
      root.updateMatrixWorld(true)
      let bottom = Infinity
      for (const [c, h] of boxes) {
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
          bottom = Math.min(bottom, roll.localToWorld(new THREE.Vector3(c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2])).y)
        }
      }
      // The kinematics count these and more (the wrist's rings and barrel), so never less low than they are.
      expect(bottom).toBeGreaterThanOrEqual(lowest(p) - 1e-9)
      // Pointing down, the fingertips are the lowest of all.
      if (forward(p).pitch > 170) expect(bottom).toBeCloseTo(lowest(p), 9)
    }
  })

  it('stops the gripper high enough that what it holds rests on the floor, not in it', () => {
    // A block gripped near the fingertips, well past them: the arm comes down until the block is just clear.
    const h = box([0, 0.06, 0], [0, 0, 0])
    const r = inverse({ yaw: 0, reach: 0.7, height: 0, pitch: 180, roll: 0 }, h)
    expect(forward(r.pose).height).toBeCloseTo(toolFloor(180, 0, h), 9)
    expect(lowest(r.pose, h)).toBeCloseTo(FLOOR_CLEAR, 9)
    expect(forward(r.pose).height - heldDrop(180, 0, h)).toBeCloseTo(FLOOR_CLEAR, 9)
    // And a step down from there is held back.
    const next = { ...r.pose, shoulder: r.pose.shoulder + 3 }
    expect(lowest(next, h)).toBeLessThan(FLOOR_CLEAR)
    expect(lowest(stepAboveFloor(r.pose, next, true, JOINTS[1].min, h).pose, h)).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
  })
})
