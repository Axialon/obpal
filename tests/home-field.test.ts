import { describe, expect, it } from 'vitest'
import { createWorld, DEPTH, ORB_R, type WorldMarble } from '../src/landing/world'
import { fieldAwake, nearViewport, obstacleLetter, obstacleRect } from '../src/landing/obstacles'
import { inside } from '../src/landing/bounce'

const rect = { x: 40, y: 1000, w: 220, h: 160, r: 20 }

/** Test placement is the previous drawn frame, not an unrendered teleport from the opening. */
function placed(m: WorldMarble) { m.was = m.now = m.shown = [m.orb.x, m.orb.y, m.orb.z] }

describe('the viewport marble field', () => {
  it('extracts solid content blocks, round pegs and low ramps from rects', () => {
    expect(obstacleRect(rect, 'rail')).toMatchObject({ exclude: true, step: false, height: .3 })
    expect(obstacleRect(rect, 'rail').rings).toBeUndefined()
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
  it('keeps rendered rims outside heading lines at every height and reports the contact for light', () => {
    for (const width of [1920, 390]) for (const height of [ORB_R, ORB_R + .8]) {
      const world = createWorld(true, true)
      world.layout(['Your phone.'], width, 900, { x: 30, y: 140, w: Math.min(650, width - 60), h: 140 })
      world.play(65, 900)
      const heading = { x: 40, y: 460, w: width - 80, h: 48, r: 0, height: .12, text: true, exclude: true, step: false }
      world.setPads([heading])
      const sphere = ORB_R * (1 + DEPTH * Math.max(0, height - ORB_R))
      const drawnRadius = world.project(sphere, height, 0).x - world.project(0, height, 0).x
      const m = world.marble('heading'), at = world.planeAt(width / 2, heading.y - drawnRadius + 1, height)
      Object.assign(m.orb, { ...at, y: height, resting: false })
      placed(m)
      const contacts = []
      for (let i = 0; i < 120; i++) {
        contacts.push(...world.step(1 / 60).hits.filter(h => h.pad === 0))
        const p = world.project(...m.shown)
        const radius = world.project(m.shown[0] + ORB_R * (1 + DEPTH * Math.max(0, m.shown[1] - ORB_R)), m.shown[1], m.shown[2]).x - p.x
        const dx = Math.max(heading.x - p.x, 0, p.x - heading.x - heading.w)
        const dy = Math.max(heading.y - p.y, 0, p.y - heading.y - heading.h)
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(radius - .01)
      }
      expect(contacts[0]).toMatchObject({ kind: 'button', pad: 0, soft: true })
      expect(contacts.filter(h => h.t < .1)).toHaveLength(1)
    }
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
  it('lets passive ledge contacts roll off while the reduced-motion field rests', () => {
    for (const flowing of [false, true]) {
      const world = createWorld(true, flowing)
      world.layout(['Your phone.'], 1440, 900, { x: 100, y: 140, w: 650, h: 140 })
      world.setPads([{ x: 200, y: 450, w: 220, h: 54, r: 27 }])
      const m = world.marble('me'), p = world.planeAt(310, 477, .3 + ORB_R)
      Object.assign(m.orb, { ...p, y: .3 + ORB_R, resting: false })
      for (let i = 0; i < 360; i++) world.step(1 / 60)
      expect(world.surface(m.orb.x, m.orb.z).id >= 1000).toBe(!flowing)
    }
  })
  it('expels layouts appearing beneath a marble and sweeps fast moving cards into sleeping marbles', () => {
    for (const width of [1920, 1440, 390]) {
      const world = createWorld(true, true)
      world.layout(['Your phone.'], width, 900, { x: 30, y: 140, w: Math.min(650, width - 60), h: 140 })
      world.play(65, 900)
      const card = { x: 20, y: 400, w: width - 40, h: 300, r: 30, exclude: true }
      world.setPads([card])
      const m = world.marble('me'), p = world.planeAt(width / 2, 350, ORB_R)
      Object.assign(m.orb, { ...p, y: ORB_R, resting: true })
      placed(m)
      world.step(0)
      const before = world.project(m.orb.x, m.orb.y, m.orb.z)
      world.scroll(650)
      world.step(1 / 60)
      const after = world.project(...m.shown)
      expect(after.y).toBeLessThan(before.y)
      expect(m.orb.resting).toBe(false)
      for (const y of [100, 300, 800, 0]) {
        world.scroll(y)
        for (let i = 0; i < 30; i++) {
          world.step(1 / 60)
          const q = world.project(...m.shown)
          if (m.motion.phase === 'ground') expect(q.x > card.x && q.x < card.x + card.w && q.y > card.y - y && q.y < card.y + card.h - y).toBe(false)
        }
      }
      const at = world.project(m.orb.x, m.orb.y, m.orb.z)
      const newCard = { ...card, x: at.x - 40, y: at.y - 40, w: 80, h: 80 }
      world.setPads([newCard])
      world.step(0)
      const q = world.project(...m.shown)
      if (m.motion.phase === 'ground') expect(q.x > newCard.x && q.x < newCard.x + 80 && q.y > newCard.y && q.y < newCard.y + 80).toBe(false)
      else expect(['lift', 'land', 'dock', 'docked']).toContain(m.motion.phase)
    }
  })
  it('keeps centres outside every border at several angles and speeds, including narrow gutters', () => {
    for (const width of [1920, 1440, 390]) {
      for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
        for (const speed of [.2, 3, 12]) {
          const world = createWorld(true, true)
          world.layout(['Your phone.'], width, 900, { x: 30, y: 140, w: Math.min(650, width - 60), h: 140 })
          world.play(65, 900)
          const cards = [{ x: 20, y: 320, w: (width - 58) / 2, h: 300, r: 30, exclude: true }, { x: (width + 18) / 2, y: 320, w: (width - 58) / 2, h: 300, r: 30, exclude: true }]
          world.setPads(cards)
          const m = world.marble('me'), p = world.planeAt(width / 2, 310, ORB_R)
          Object.assign(m.orb, { ...p, y: ORB_R + .5, vx: Math.cos(angle) * speed, vz: Math.sin(angle) * speed, resting: false })
          let slow = 0
          for (let i = 0; i < 240; i++) {
            world.step(1 / 60)
            const q = world.project(...m.shown)
            for (const b of cards) expect(q.x > b.x && q.x < b.x + b.w && q.y > b.y && q.y < b.y + b.h).toBe(false)
            slow = m.orb.y > ORB_R + .03 && Math.hypot(m.orb.vx, m.orb.vy, m.orb.vz) < .05 ? slow + 1 / 60 : 0
            expect(slow).toBeLessThan(1.5)
          }
        }
      }
    }
  })
  it('bounds moving-collider work after warm-up with 0, 1, 6 and 12 bodies', () => {
    for (const count of [0, 1, 6, 12]) {
      const world = createWorld(true, true)
      world.layout(['Your phone.'], 1920, 1080, { x: 100, y: 140, w: 650, h: 140 })
      world.play(65, 1080)
      const cards = Array.from({ length: count }, (_, i) => ({ x: 100 + (i % 6) * 290, y: 350 + Math.floor(i / 6) * 300, w: 240, h: 220, r: 30, exclude: true }))
      world.setPads(cards)
      for (let i = 0; i < 4; i++) {
        const m = world.marble(String(i)), p = world.planeAt(160 + i * 290, 300, ORB_R)
        Object.assign(m.orb, { ...p, y: ORB_R, resting: true })
      }
      const work: number[] = []
      for (let frame = 0; frame < 600; frame++) {
        const at = performance.now()
        world.movePads(cards.map((card, index) => ({ index, rect: { ...card, y: card.y + 70 * Math.sin(frame / 20) } })), 1 / 60)
        world.step(1 / 60)
        if (frame >= 120) work.push(performance.now() - at)
      }
      work.sort((a, b) => a - b)
      const p95 = work[Math.floor(work.length * .95)]
      console.log(`home moving colliders ${count}: ${work.length} warm samples, median ${work[240].toFixed(3)}ms, p95 ${p95.toFixed(3)}ms, max ${work.at(-1)!.toFixed(3)}ms per 60Hz advance (four fixed steps)`)
      expect(p95).toBeLessThan(4)
    }
  })
  it('uses a soft margin for a played demo without snapping a marble that is already outside', () => {
    const world = createWorld(true, true)
    world.layout(['Your phone.'], 1440, 900, { x: 100, y: 140, w: 650, h: 140 })
    const card = { x: 200, y: 450, w: 400, h: 300, r: 30, exclude: true }
    world.setPads([card])
    const m = world.marble('me'), radius = world.project(ORB_R, ORB_R, 0).x - world.project(0, ORB_R, 0).x
    const at = world.planeAt(400, card.y - radius - 2, ORB_R)
    Object.assign(m.orb, { ...at, y: ORB_R, resting: true })
    const before = world.project(m.orb.x, m.orb.y, m.orb.z)
    world.repel(card)
    expect(world.project(m.orb.x, m.orb.y, m.orb.z)).toEqual(before)
    for (let i = 0; i < 60; i++) world.step(1 / 60)
    expect(world.project(m.orb.x, m.orb.y, m.orb.z).y).toBeLessThan(before.y - 2)
  })
  it('docks instead of getting trapped in a phone gutter narrower than a marble', () => {
    const world = createWorld(true, true)
    world.layout(['Your phone.'], 390, 844, { x: 20, y: 140, w: 350, h: 100 })
    world.play(65, 844)
    const card = { x: 20, y: -100, w: 350, h: 1000, r: 30, exclude: true }
    world.setPads([card])
    const m = world.marble('me'), p = world.planeAt(18, 300, ORB_R)
    Object.assign(m.orb, { ...p, y: ORB_R, vx: 0, vy: 0, vz: 0, resting: false })
    placed(m)
    const start = world.project(m.orb.x, m.orb.y, m.orb.z)
    for (let i = 0; i < 180; i++) {
      world.step(1 / 60)
      const q = world.project(...m.shown)
      if (m.motion.phase === 'ground') expect(q.x > card.x && q.x < card.x + card.w && q.y > card.y && q.y < card.y + card.h).toBe(false)
    }
    expect(world.project(...m.shown).y - start.y).toBeGreaterThan(30)
    expect(m.motion.phase).toBe('docked')
  })
  it('uses the drawn sphere radius at all four exclusion edges, including airborne contacts', () => {
    for (const width of [1920, 1440, 390]) for (const height of [ORB_R, ORB_R + .5]) {
      const world = createWorld(true, true)
      world.layout(['Your phone.'], width, 900, { x: 30, y: 140, w: Math.min(650, width - 60), h: 140 })
      world.play(65, 900)
      const card = { x: width / 2 - 60, y: 400, w: 120, h: 200, r: 30, exclude: true }
      world.setPads([card])
      const sphere = ORB_R * (1 + DEPTH * Math.max(0, height - ORB_R))
      const drawnRadius = world.project(sphere, height, 0).x - world.project(0, height, 0).x
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const m = world.marble(side)
        const x = side === 'left' ? card.x - drawnRadius + 1 : side === 'right' ? card.x + card.w + drawnRadius - 1 : width / 2
        const y = side === 'top' ? card.y - drawnRadius + 1 : side === 'bottom' ? card.y + card.h + drawnRadius - 1 : 500
        Object.assign(m.orb, { ...world.planeAt(x, y, height), y: height, resting: false })
        placed(m)
        world.step(0)
        const p = world.project(...m.shown)
        const edge = world.project(m.shown[0] + ORB_R * (1 + DEPTH * Math.max(0, height - ORB_R)), height, m.shown[2])
        const radius = edge.x - p.x
        const gap = side === 'left' ? card.x - p.x - radius : side === 'right' ? p.x - radius - card.x - card.w
          : side === 'top' ? card.y - p.y - radius : p.y - radius - card.y - card.h
        expect(Math.abs(gap)).toBeLessThanOrEqual(1)
      }
    }
  })
  it('lets a marble meet a round peg diagonally without a square invisible corner', () => {
    const world = createWorld(true, true)
    world.layout(['Your phone.'], 1440, 900, { x: 100, y: 140, w: 650, h: 140 })
    const peg = { x: 1100, y: 700, w: 44, h: 44, r: 22, exclude: true, fixed: true }
    world.setPads([peg])
    const drawnRadius = world.project(ORB_R, ORB_R, 0).x - world.project(0, ORB_R, 0).x
    const diagonal = (22 + drawnRadius - 1) / Math.SQRT2
    const m = world.marble('me'), p = world.planeAt(1122 - diagonal, 722 - diagonal, ORB_R)
    Object.assign(m.orb, { ...p, y: ORB_R, resting: false })
    placed(m)
    world.step(0)
    const q = world.project(...m.shown), radius = world.project(m.shown[0] + ORB_R, ORB_R, m.shown[2]).x - q.x
    expect(Math.abs(Math.hypot(q.x - 1122, q.y - 722) - 22 - radius)).toBeLessThan(1)
  })
})
