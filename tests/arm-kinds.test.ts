import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { isControllerId } from '@obpal/core'
import { blockBox, gap, stepAmong, type Blk, type Box, type Stand } from '../src/sim/arm/blocks'
import { col } from '../src/sim/arm/frames'
import { homeOf, reachDown, within, type ArmKind, type Pose } from '../src/sim/arm/kin'
import { FLOOR_CLEAR } from '../src/sim/arm/kinematics'
import { KINDS, kindFrom } from '../src/sim/arm/kind'
import { ARM_KINDS } from '../src/sim/arm/kinds'
import { placement, turnBetween } from '../src/sim/arm/layout'

const HERE: Stand = { x: 0, z: 0, turn: 0 }
const EACH = Object.values(KINDS)
const mats = { metal: new THREE.MeshStandardMaterial(), dark: new THREE.MeshStandardMaterial() }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const cube = (x: number, z: number): Blk => ({ x, y: 0.03, z, yaw: 0, half: [0.03, 0.03, 0.03] })
/** Overlap this small is touching (m). */
const TOUCH = 0.0005

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

/** Where a tool target puts the tool point, in the arm's own terms. */
const pointOf = (t: { yaw: number; reach: number; height: number }) => [-t.reach * Math.cos((t.yaw * Math.PI) / 180), t.height, t.reach * Math.sin((t.yaw * Math.PI) / 180)]

describe('ARM_KINDS: the kinds for pages that list them (the sims catalogue)', () => {
  it('each has an id the sim knows, a name, a line, the controllers it suits (known ids), its page and a preview', () => {
    expect(ARM_KINDS.map((k) => k.id).sort()).toEqual(Object.keys(KINDS).sort())
    for (const k of ARM_KINDS) {
      expect(k.name.length).toBeGreaterThan(2)
      expect(k.blurb.length).toBeGreaterThan(20)
      expect(k.blurb.length).toBeLessThan(120)
      expect(k.href).toBe(`/sim/arm/?kind=${k.id}`)
      expect(k.controllers.length).toBeGreaterThan(0)
      for (const c of k.controllers) expect(isControllerId(c), `${k.id}: ${c}`).toBe(true)
      expect(new Set(k.controllers).size).toBe(k.controllers.length)
      expect(typeof k.preview).toBe('function')
    }
  })

  it('?kind= picks the kind, and anything else is the five-axis arm', () => {
    for (const k of EACH) expect(kindFrom(k.id)).toBe(k)
    for (const x of [null, undefined, '', 'toString', 'nope']) expect(kindFrom(x).id).toBe('arm5')
  })

  it('a preview builds its arm, moves it through a pick and place, carrying the block, and lets it go', async () => {
    for (const k of ARM_KINDS) {
      const p = await k.preview()
      expect(p.size.height).toBeGreaterThan(0.3)
      const block = p.object.children.find((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type === 'BoxGeometry')!
      const seen: number[] = []
      for (let t = 0; t < 14; t += 0.1) { p.step(t); seen.push(block.position.y) }
      // It lifted the block off the floor and put it down again.
      expect(Math.max(...seen), k.id).toBeGreaterThan(0.12)
      expect(Math.min(...seen), k.id).toBeCloseTo(0.03, 6)
      p.dispose()
      expect(p.object.parent).toBeNull()
    }
  })
})

describe.each(EACH.map((k) => [k.id, k] as const))('%s', (id, kind: ArmKind) => {
  const kin = kind.kin
  const home = homeOf(kin)

  it('has its joints, then the gripper; its home within its limits and above the floor; its model with a ring for each', () => {
    expect(kin.joints.length).toBe(kin.keys.length + 1)
    expect(kin.joints.at(-1)!.key).toBe('gripper')
    expect(new Set(kin.joints.map((j) => j.key)).size).toBe(kin.joints.length)
    expect(within(kin, home)).toBe(true)
    expect(kin.lowest(home)).toBeGreaterThan(FLOOR_CLEAR)
    const m = kind.build(1, mats)
    expect(m.apply.length).toBe(kin.joints.length)
    expect(m.rings.length).toBe(kin.joints.length)
    expect(m.rings.every(Boolean)).toBe(true)
    m.dispose()
  })

  it('goes where it is sent: the pose for a place puts the tool there, turned as asked (its IK and its forward kinematics agree)', () => {
    const R = rng(id.length * 97)
    let solved = 0
    for (let i = 0; i < 400; i++) {
      const pitch = kin.pitchRange[0] === kin.pitchRange[1] ? 180 : 130 + 50 * R(), roll = -90 + 180 * R()
      // Not so low that the gripper, tipped, would be raised off the floor (the IK does that, rightly).
      const t = { yaw: -120 + 240 * R(), reach: kind.drive.reach[0] + (kind.drive.reach[1] - kind.drive.reach[0]) * R(), height: kin.toolFloor(pitch, roll) + 0.01 + 0.4 * R(), pitch, roll }
      const { pose, reached } = kin.inverse(t, null, home)
      if (!reached || !within(kin, pose)) continue
      solved++
      const f = kin.forward(pose)
      const [a, b] = [pointOf(t), pointOf(f)]
      for (let k = 0; k < 3; k++) expect(b[k], `${JSON.stringify(t)} → ${JSON.stringify(pose)}`).toBeCloseTo(a[k], 6)
      expect(turnBetween(f.pitch, t.pitch)).toBeLessThan(1e-6)
      expect(turnBetween(f.roll, t.roll)).toBeLessThan(1e-6)
    }
    // Most of the places asked for are within its reach and limits.
    expect(solved).toBeGreaterThan(120)
  })

  it('draws where it moves: the model\'s grasp is where the kinematics put it, turned the same way', () => {
    const R = rng(id.length * 31)
    const m = kind.build(1, mats)
    for (let i = 0; i < 60; i++) {
      const t = { yaw: -100 + 200 * R(), reach: kind.drive.reach[0] + (kind.drive.reach[1] - kind.drive.reach[0]) * R(), height: 0.1 + 0.3 * R(), pitch: 180, roll: -90 + 180 * R() }
      const { pose, reached } = kin.inverse(t, null, home)
      if (!reached || !within(kin, pose)) continue
      kin.keys.forEach((k, j) => m.apply[j](pose[k]))
      m.root.updateMatrixWorld(true)
      const g = kin.grasp(HERE, pose)
      const at = m.grasp.getWorldPosition(new THREE.Vector3())
      expect(at.distanceTo(new THREE.Vector3(...g.t)), JSON.stringify(pose)).toBeLessThan(1e-9)
      const along = new THREE.Vector3(0, 1, 0).applyQuaternion(m.grasp.getWorldQuaternion(new THREE.Quaternion()))
      const y = col(g.R, 1), x = col(g.R, 0)
      expect(along.distanceTo(new THREE.Vector3(...y))).toBeLessThan(1e-9)
      const across = new THREE.Vector3(1, 0, 0).applyQuaternion(m.grasp.getWorldQuaternion(new THREE.Quaternion()))
      expect(across.distanceTo(new THREE.Vector3(...x))).toBeLessThan(1e-9)
    }
    m.dispose()
  })

  it('never goes below the floor, however its joints are moved, headed for a pose or by hand', () => {
    const R = rng(id.length * 13 + 5)
    for (const following of [false, true]) {
      let pose: Pose = { ...home }
      for (let i = 0; i < 1500; i++) {
        const next: Pose = { ...pose }
        kin.keys.forEach((k, j) => {
          const s = kin.joints[j]
          const step = (s.max - s.min) * 0.04
          next[k] = clamp(pose[k] + (R() - 0.45) * step, s.min, s.max)
        })
        const was = kin.lowest(pose)
        pose = kin.stepAboveFloor(pose, next, following).pose
        expect(kin.lowest(pose), `step ${i}`).toBeGreaterThanOrEqual(Math.min(FLOOR_CLEAR, was) - 1e-6)
      }
    }
  })

  it('points: over any spot in its reach, the gripper hangs straight over it, just above the floor', () => {
    const R = rng(id.length * 7)
    let hits = 0
    for (let i = 0; i < 80; i++) {
      const yaw = -90 + 180 * R(), reach = kind.drive.reach[0] + 0.05 + (kind.cell.stand - kind.drive.reach[0]) * R()
      const r = reachDown(kin, yaw, reach, 0.035, 0, null, home)
      if (!r?.exact) continue
      hits++
      const g = kin.grasp(HERE, r.pose)
      const [x, , z] = pointOf({ yaw, reach, height: 0 })
      expect(Math.hypot(g.t[0] - x, g.t[2] - z)).toBeLessThan(1e-6)
      expect(kin.lowest(r.pose)).toBeGreaterThanOrEqual(FLOOR_CLEAR - 1e-6)
      expect(g.t[1]).toBeLessThan(0.06)
    }
    expect(hits).toBeGreaterThan(50)
  })

  it('picks up a block from the floor, carries it, and never pushes into it or the floor on the way', () => {
    const reach = clamp(kind.cell.stand * 0.7, kind.drive.reach[0] + 0.08, kind.drive.reach[1] * 0.8)
    let blocks = [cube(-reach, 0)]
    let pose = homeOf(kin), open = 1, held: Box | null = null
    const go = (to: Pose, o: number, steps = 12) => {
      const from = pose, oFrom = open
      for (let i = 1; i <= steps; i++) {
        const want: Pose = {}
        for (const k of kin.keys) want[k] = from[k] + (to[k] - from[k]) * (i / steps)
        const was = pose
        const next = kin.stepAboveFloor(was, want, true, held).pose
        const r = stepAmong(kin, HERE, { pose: was, open }, { pose: next, open: oFrom + (o - oFrom) * (i / steps) }, held, { blocks, still: [], bases: [] }, { real: false, following: true })
        pose = r.pose
        open = r.open
        blocks = r.blocks
        if (r.took) { held = r.took.box; blocks = blocks.filter((_, j) => j !== r.took!.i) }
        for (const b of blocks) for (const p of kin.parts(HERE, pose, open, held)) expect(gap(p, blockBox(b))).toBeGreaterThan(-TOUCH)
        // Nothing below the floor (a block just taken still stands on it).
        expect(kin.lowest(pose, held)).toBeGreaterThanOrEqual(held ? -1e-9 : FLOOR_CLEAR - 1e-6)
      }
    }
    const over = (h: number) => reachDown(kin, 0, reach, h, 0, held, pose)!.pose
    go(over(0.22), 1, 30)
    // Straight down, a centimetre at a time, as the claw goes; then the fingers close.
    for (let h = 0.2; h >= 0.035; h -= 0.01) go(over(h), 1, 3)
    go(over(0.035), 0, 20)
    expect(held, 'took it').not.toBeNull()
    for (let h = 0.05; h <= 0.25; h += 0.02) go(over(h), open, 3)
    // Up with the gripper, off the floor.
    const g = kin.grasp(HERE, pose)
    const at = [0, 1, 2].map((k) => g.t[k] + g.R[k * 3] * held!.c[0] + g.R[k * 3 + 1] * held!.c[1] + g.R[k * 3 + 2] * held!.c[2])
    expect(at[1]).toBeGreaterThan(0.15)
  })

  it('in its cell: the middle and every block are within some arm\'s reach, and arms at home keep clear of one another', () => {
    const stands = [1, 2, 3, 4].map((n) => placement(n, kind.cell.stand))
    const local = (s: Stand, x: number, z: number) => {
      const dx = x - s.x, dz = z - s.z, c = Math.cos(s.turn), n = Math.sin(s.turn)
      return { x: c * dx - n * dz, z: n * dx + c * dz }
    }
    const reaches = (s: Stand, x: number, z: number) => {
      const p = local(s, x, z)
      return !!reachDown(kin, Math.atan2(p.z, -p.x) * (180 / Math.PI), Math.hypot(p.x, p.z), 0.035, 0, null, home)?.exact
    }
    expect(reaches(stands[0], 0, 0)).toBe(true)
    // The six blocks the cell starts with, reached by one of the two arms it starts with.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.5, r = kind.cell.blocks[i % 2]
      const [x, z] = [Math.cos(a) * r, Math.sin(a) * r]
      expect(reaches(stands[0], x, z) || reaches(stands[1], x, z), `block ${i}`).toBe(true)
    }
    for (let count = 2; count <= 4; count++) {
      const parts = stands.slice(0, count).map((s) => kin.parts(s, home, 1))
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const least = Math.min(...parts[i].flatMap((a) => parts[j].map((b) => gap(a, b))))
        expect(least, `${count} arms: ${i + 1} and ${j + 1}`).toBeGreaterThan(0.03)
      }
    }
    // Everything it works on is inside the fence.
    expect(kind.cell.fence).toBeGreaterThan(kind.cell.stand + 0.3)
  })
})
