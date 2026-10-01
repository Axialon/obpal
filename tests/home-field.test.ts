import { describe, expect, it } from 'vitest'
import { createWorld, DEPTH, ORB_R } from '../src/landing/world'
import { fieldAwake, nearViewport, obstacleLetter, obstacleRect } from '../src/landing/obstacles'
import { inside } from '../src/landing/bounce'

const rect = { x: 40, y: 1000, w: 220, h: 160, r: 20 }

describe('the viewport marble field', () => {
  it('extracts hollow card rails, round pegs and low ramps from rects', () => {
    expect(obstacleRect(rect, 'rail').rings).toHaveLength(2)
    expect(obstacleRect(rect, 'peg')).toMatchObject({ x: 70, w: 160, h: 160, r: 80 })
    expect(obstacleRect(rect, 'ramp').height).toBeLessThan(ORB_R)
    expect(obstacleRect({ ...rect, w: 0 }, 'block').w).toBe(0)
  })
  it('retains the holes of raised heading letters', () => {
    const letter = obstacleLetter('o', rect)!
    const world = createWorld(true)
    world.layout(['Your phone.'], 1280, 800, { x: 60, y: 160, w: 600, h: 140 })
    world.setPads([letter])
    const centre = world.planeAt(rect.x + rect.w / 2, rect.y + rect.h / 2, letter.height!)
    expect(letter.rings!.length).toBeGreaterThan(1)
    expect(inside(world.pads[0], centre.x, centre.z)).toBe(false)
    expect(obstacleLetter(' ', rect)).toBeNull()
  })
  it('culls distant obstacles and reuses the exact footprints through fast scrolls', () => {
    const world = createWorld(true)
    world.layout(['Your phone.'], 1280, 800, { x: 60, y: 160, w: 600, h: 140 })
    world.setPads(Array.from({ length: 100 }, (_, i) => ({ ...rect, y: 1000 + i * 300 })))
    const footprints = [...world.pads]
    for (const y of [0, 2000, 9000, 26000, 0]) {
      world.scroll(y)
      expect(world.active).toBeLessThan(20)
      expect(world.pads.every((p, i) => p === footprints[i])).toBe(true)
    }
    expect(nearViewport(rect, 900, 800)).toBe(true)
    expect(nearViewport(rect, 2000, 800)).toBe(false)
  })
  it('carries every marble within the viewport through flings, reversal and resizes', () => {
    const world = createWorld(true)
    world.layout(['Your phone.'], 1280, 800, { x: 60, y: 160, w: 600, h: 140 })
    world.play(65, 800)
    for (let i = 0; i < 4; i++) {
      const o = world.marble(String(i)).orb, p = world.planeAt(i % 2 ? 1260 : 20, i < 2 ? 85 : 780, o.y)
      o.x = p.x; o.z = p.z
      o.vz = 12; o.resting = false
    }
    for (const y of [100, 2000, 3300, 12000, 800, 0]) {
      world.scroll(y)
      for (let frame = 0; frame < 30; frame++) {
        world.step(1 / 60)
        for (const m of world.marbles()) {
          const [x, h, z] = m.shown, p = world.project(x, h, z)
          const edge = world.project(x + ORB_R * (1 + DEPTH * Math.max(0, h - ORB_R)), h, z)
          const radius = edge.x - p.x
          expect(p.x - radius).toBeGreaterThanOrEqual(-0.2)
          expect(p.x + radius).toBeLessThanOrEqual(1280.2)
          expect(p.y - radius).toBeGreaterThanOrEqual(64.8)
          expect(p.y + radius).toBeLessThanOrEqual(800.2)
        }
      }
    }
    world.layout(['Your phone.'], 390, 844, { x: 20, y: 150, w: 350, h: 80 })
    world.play(65, 844)
    for (const m of world.marbles()) {
      const p = world.project(...m.shown)
      expect(p.x).toBeGreaterThan(0)
      expect(p.x).toBeLessThan(390)
      expect(p.y).toBeGreaterThan(65)
      expect(p.y).toBeLessThan(844)
    }
  })
  it('sleeps with no input and pauses regardless of motion when disabled or hidden', () => {
    expect(fieldAwake(true, false, false, 0, 3000)).toBe(false)
    expect(fieldAwake(true, false, true, 0, 3000)).toBe(true)
    expect(fieldAwake(false, false, true, 3000, 3000)).toBe(false)
    expect(fieldAwake(true, true, true, 3000, 3000)).toBe(false)
    const world = createWorld(true)
    world.layout(['Your phone.'], 1280, 800, { x: 60, y: 160, w: 600, h: 140 })
    const o = world.marble('me').orb
    o.x = world.floorAt(1000, 600).x; o.z = world.floorAt(1000, 600).z; o.y = ORB_R; o.resting = false
    for (let i = 0; i < 240; i++) world.step(1 / 60)
    expect(o.resting).toBe(true)
    expect(world.step(1 / 60).moving).toBe(false)
  })
})
