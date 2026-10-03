import { describe, expect, it } from 'vitest'
import { createWorld, DEPTH, ORB_R, type World, type WorldMarble } from '../src/landing/world'
import { TOP } from '../src/landing/letters'
import { H } from '../src/landing/bounce'
import { LAYOUTS } from './harness/world'

const DT = 1 / 60
const JUMP = 18

function scene(width: number, height: number, reduced = false) {
  const world = createWorld(true, true, reduced)
  world.layout(['Your phone.'], width, height, { x: 20, y: 140, w: Math.min(650, width - 40), h: 100 })
  world.play(65, height)
  world.dock({ x: width - 38, y: height - 38 })
  const marble = world.marble('me')
  place(world, marble, width / 2, height * .6)
  return { world, marble }
}

function place(world: World, marble: WorldMarble, x: number, y: number) {
  const at = world.planeAt(x, y, ORB_R)
  Object.assign(marble.orb, { ...at, y: ORB_R, vx: 0, vy: 0, vz: 0, resting: true })
  marble.was = marble.now = marble.shown = [at.x, ORB_R, at.z]
  Object.assign(marble.motion, { x, y, vx: 0, vy: 0 })
}

function point(world: World, marble: WorldMarble) { return world.project(...marble.shown) }
function radius(world: World, marble: WorldMarble) {
  const p = point(world, marble)
  const sphere = ORB_R * (1 + DEPTH * Math.max(0, marble.shown[1] - ORB_R))
  return world.project(marble.shown[0] + sphere, marble.shown[1], marble.shown[2]).x - p.x
}

/** Compare the actual previous drawing, including the final animated frame before returning to physics. */
function monitor(world: World, marble: WorldMarble) {
  let previous = point(world, marble)
  const phases = new Set<string>()
  let landings = 0
  let lastPhase = marble.motion.phase
  return {
    phases,
    get landings() { return landings },
    frame(scroll?: number) {
      if (scroll !== undefined) world.scroll(scroll)
      const result = world.step(DT)
      const current = point(world, marble), phase = marble.motion.phase
      phases.add(phase)
      expect(Number.isFinite(current.x) && Number.isFinite(current.y)).toBe(true)
      const r = radius(world, marble)
      expect(current.x - r).toBeGreaterThanOrEqual(-.1)
      expect(current.x + r).toBeLessThanOrEqual(world.size[0] + .1)
      expect(current.y - r).toBeGreaterThanOrEqual(64.9)
      expect(current.y + r).toBeLessThanOrEqual(world.size[1] + .1)
      if (phase === 'ground') {
        expect(Math.hypot(current.x - previous.x, current.y - previous.y)).toBeLessThanOrEqual(JUMP + .01)
        if (lastPhase === 'land') {
          landings++
          expect(world.free(current.x, current.y, radius(world, marble))).toBe(true)
        }
      }
      previous = current
      lastPhase = phase
      return result
    },
  }
}

describe.each([[390, 844], [360, 740]])('phone scroll choreography at %i by %i', (width, height) => {
  it('carries a resting marble with its page during a slow drag', () => {
    const { world, marble } = scene(width, height)
    const pageY = point(world, marble).y
    const frames = monitor(world, marble)
    for (let frame = 1; frame <= 30; frame++) {
      frames.frame(frame * 2)
      expect(marble.motion.phase).toBe('ground')
      expect(point(world, marble).y + frame * 2).toBeCloseTo(pageY, 1)
    }
  })

  it('counts several scroll callbacks as one rendered frame', () => {
    const { world, marble } = scene(width, height)
    const before = point(world, marble)
    const frames = monitor(world, marble)
    world.scroll(12)
    world.scroll(24)
    frames.frame()
    expect(marble.motion.phase).toBe('ground')
    expect(before.y - point(world, marble).y).toBeCloseTo(JUMP, 6)
    for (let frame = 0; frame < 120; frame++) expect(frames.frame().hits.some(hit => hit.scrollLanding)).toBe(false)
  })

  it('lets a fast tray slip beneath a visible marble without lifting or changing its velocity', () => {
    const { world, marble } = scene(width, height)
    const before = point(world, marble)
    marble.orb.vx = 12
    marble.orb.resting = false
    world.scroll(80)
    expect(marble.motion.phase).toBe('ground')
    expect(marble.orb.vx).toBe(12)
    expect(before.y - point(world, marble).y).toBeCloseTo(JUMP, 6)
    expect(world.step(DT).hits.some(hit => hit.scrollLanding)).toBe(false)
  })

  it('counts only carry against the correction limit while fast rolling stays physical', () => {
    const { world, marble } = scene(width, height)
    marble.orb.vx = 12
    marble.orb.resting = false
    const before = point(world, marble)
    world.scroll(18)
    const result = world.step(DT)
    const after = point(world, marble)
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(JUMP)
    expect(marble.motion.phase).toBe('ground')
    expect(result.hits.some(hit => hit.scrollLanding)).toBe(false)
  })

  it('lifts on a fling, waits for quiet, then lands in free space with a soft impact', () => {
    const { world, marble } = scene(width, height)
    const frames = monitor(world, marble)
    frames.frame(600)
    expect(marble.motion.phase).toBe('lift')
    for (let frame = 0; frame < 7; frame++) {
      frames.frame()
      expect(marble.motion.phase).toBe('lift')
    }
    const hits = []
    for (let frame = 0; frame < 180; frame++) hits.push(...frames.frame().hits)
    expect(frames.phases.has('land')).toBe(true)
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
    expect(hits.some(hit => hit.kind === 'floor' && hit.landed && hit.speed > 0 && hit.speed <= 1)).toBe(true)
  })

  it('keeps flings, reversals and rolling scrolls free of unanimated jumps', () => {
    const { world, marble } = scene(width, height)
    const cards = [900, 1550, 2200].map(y => ({ x: 20, y, w: width - 40, h: 500, r: 24, exclude: true }))
    world.setPads(cards)
    marble.orb.vx = 2
    marble.orb.vz = 1
    marble.orb.resting = false
    const frames = monitor(world, marble)
    let scroll = 0
    for (const delta of [3, 12, 70, -4, -85, 5, 0]) {
      for (let frame = 0; frame < 24; frame++) {
        scroll = Math.max(0, scroll + delta)
        frames.frame(scroll)
        if (marble.motion.phase === 'ground') {
          const p = point(world, marble)
          for (const card of cards) expect(p.x > card.x && p.x < card.x + card.w && p.y + scroll > card.y && p.y + scroll < card.y + card.h).toBe(false)
        }
      }
    }
    for (let frame = 0; frame < 180; frame++) frames.frame()
    expect(frames.phases.has('lift')).toBe(true)
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
  })

  it('docks when a full viewport has no free spot and releases when space returns', () => {
    const { world, marble } = scene(width, height)
    const frames = monitor(world, marble)
    world.setPads([{ x: 0, y: -100, w: width, h: height + 200, r: 0, exclude: true }])
    for (let frame = 0; frame < 240; frame++) frames.frame()
    expect(frames.phases.has('dock')).toBe(true)
    expect(marble.motion.phase).toBe('docked')
    expect(point(world, marble).x).toBeCloseTo(width - 38, 1)
    expect(point(world, marble).y).toBeCloseTo(height - 38, 1)
    expect(world.release()).toBe(true)
    expect(marble.motion.phase).toBe('lift')
    world.setPads([])
    for (let frame = 0; frame < 240; frame++) frames.frame()
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
  })

  it('interrupts a landing safely when scrolling resumes', () => {
    const { world, marble } = scene(width, height)
    const frames = monitor(world, marble)
    frames.frame(500)
    for (let frame = 0; frame < 180 && marble.motion.phase !== 'land'; frame++) frames.frame()
    expect(marble.motion.phase).toBe('land')
    frames.frame(900)
    expect(marble.motion.phase).toBe('lift')
    for (let frame = 0; frame < 180; frame++) frames.frame()
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
  })

  it('leaves the dock automatically when open page space returns', () => {
    const { world, marble } = scene(width, height)
    const frames = monitor(world, marble)
    world.setPads([{ x: 0, y: 0, w: width, h: height, r: 0, exclude: true }])
    for (let frame = 0; frame < 240; frame++) frames.frame()
    expect(marble.motion.phase).toBe('docked')
    world.setPads([])
    for (let frame = 0; frame < 240; frame++) frames.frame()
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
  })

  it('keeps the ticker awake after a final scroll opens space beside a held marble', () => {
    const { world, marble } = scene(width, height)
    world.setPads([{ x: 0, y: 0, w: width, h: height, r: 0, exclude: true }])
    for (let frame = 0; frame < 240; frame++) world.step(DT)
    expect(marble.motion.phase).toBe('docked')
    world.scroll(height)
    // The production ticker stops as soon as physics reports no work; no extra frames may rescue a missed retry.
    for (let frame = 0; frame < 240; frame++) if (!world.step(DT).moving) break
    expect(marble.motion.phase).toBe('ground')
    const p = point(world, marble)
    expect(world.free(p.x, p.y, radius(world, marble))).toBe(true)
  })
})

describe('scroll choreography outside the phone path', () => {
  it.each([390, 1440])('does not lift an unsqueezed marble when the headline layout shifts at %ipx', width => {
    const { world, marble } = scene(width, 900)
    world.layout(['Your phone.'], width, 900, { x: 120, y: 140, w: Math.min(650, width - 40), h: 100 })
    expect(marble.motion.phase).toBe('ground')
    expect(world.step(DT).hits.some(hit => hit.scrollLanding)).toBe(false)
  })

  describe.each([1920, 1440])('desktop free motion at %i pixels', width => {
    it.each(['chase', 'flick', 'bounce'])('keeps %s motion continuous without scroll animations', mode => {
      const actual = scene(width, 1080), reference = scene(width, 1080)
      for (const { world, marble } of [actual, reference]) {
        // An unrelated page exclusion enables the old guard, even in this open part of the page.
        world.setPads([{ x: 20, y: 300, w: 100, h: 40, r: 0, exclude: true }])
        place(world, marble, mode === 'bounce' ? width - 80 : width / 2, 750)
        if (mode !== 'chase') { marble.orb.vx = 25; marble.orb.resting = false }
      }
      const speed = () => {
        const { world, marble: { orb } } = reference
        const a = world.project(orb.x, orb.y, orb.z), b = world.project(orb.x + orb.vx, orb.y + orb.vy, orb.z + orb.vz)
        return Math.hypot(b.x - a.x, b.y - a.y)
      }
      let previous = point(actual.world, actual.marble), previousSpeed = speed(), fastFrames = 0, bounces = 0
      for (let frame = 0; frame < 120; frame++) {
        if (frame % 20 === 0) for (const { world, marble } of [actual, reference]) {
          if (mode === 'chase') marble.orb.target = world.planeAt(frame % 40 ? 80 : width - 80, 750, ORB_R)
          if (mode === 'flick') { marble.orb.vx = frame % 40 ? -25 : 25; marble.orb.resting = false }
        }
        const steps = frame % 12 === 0 ? 20 : 4, dt = steps * H
        let maxSpeed = Math.max(previousSpeed, speed())
        // The small-step reference measures the actual velocity envelope, including steering and impacts.
        for (let step = 0; step < steps; step++) {
          reference.world.step(H)
          maxSpeed = Math.max(maxSpeed, speed())
        }
        const result = actual.world.step(dt), current = point(actual.world, actual.marble)
        expect(actual.marble.motion.phase, `${mode}, frame ${frame}`).toBe('ground')
        expect(result.hits.some(hit => hit.scrollLanding)).toBe(false)
        const distance = Math.hypot(current.x - previous.x, current.y - previous.y)
        expect(distance).toBeLessThanOrEqual(maxSpeed * dt + .1)
        const expected = point(reference.world, reference.marble)
        expect(current.x).toBeCloseTo(expected.x, 5)
        expect(current.y).toBeCloseTo(expected.y, 5)
        if (distance > JUMP) fastFrames++
        bounces += result.hits.filter(hit => hit.kind === 'wall').length
        previous = current
        previousSpeed = speed()
      }
      expect(fastFrames, mode).toBeGreaterThan(0)
      if (mode === 'bounce') expect(bounces).toBeGreaterThan(0)
    })
  })

  it.each(['desk-1280x800', 'phone-390x844'])('lets the complete opening tour settle on its full stop beside page colliders: %s', name => {
    const layout = LAYOUTS[name], world = createWorld(true, true)
    world.layout(layout.lines, layout.W, layout.H, layout.box)
    world.play(65, layout.H)
    // Like the eyebrow above the real headline, this is a page exclusion the opening can brush while airborne.
    world.setPads([{ x: layout.box.x, y: layout.box.y - 36, w: layout.box.w, h: 15, r: 0, height: .12, text: true, exclude: true, step: false }])
    const stops = world.tour(), marble = world.marble('opening'), first = stops[0]
    expect(stops.length).toBeGreaterThan(2)
    Object.assign(marble.orb, { x: first.x, z: first.z, y: 2.4, vx: 0, vy: 0, vz: 0, target: null,
      route: stops.slice(1), flying: false, toss: null, resting: false })
    marble.was = marble.now = marble.shown = [marble.orb.x, marble.orb.y, marble.orb.z]
    let frames = 0
    // Slower drawing makes long natural hops exercise the same frame guard that protects page scrolling.
    for (; frames < 600 && !marble.orb.resting; frames++) {
      world.step(1 / 30)
      expect(marble.motion.phase).toBe('ground')
    }
    const stop = stops.at(-1)!
    expect(frames).toBeLessThan(600)
    expect(marble.orb.route).toEqual([])
    expect(marble.orb.flying).toBe(false)
    expect(marble.orb.resting).toBe(true)
    expect(Math.hypot(marble.orb.x - stop.x, marble.orb.z - stop.z)).toBeLessThan(.05)
    expect(marble.orb.y).toBeCloseTo(TOP + ORB_R, 6)
  })

  it('replans a drop when a grounded marble enters its reserved landing spot', () => {
    const { world, marble } = scene(390, 844)
    world.scroll(600)
    for (let frame = 0; frame < 180; frame++) {
      world.step(DT)
      if (marble.motion.phase === 'land' && marble.motion.drop && marble.motion.age >= .1) break
    }
    expect(marble.motion.phase).toBe('land')
    expect(marble.motion.drop).toBe(true)
    expect(marble.motion.contact).toBe(false)
    const other = world.marble('late arrival')
    place(world, other, marble.motion.x, marble.motion.y)
    const retry = world.step(DT)
    expect(marble.motion.drop).toBe(false)
    expect(marble.motion.contact).toBe(false)
    expect(retry.hits.some(hit => hit.orb === marble.id && hit.scrollLanding)).toBe(false)
    let landed = false
    for (let frame = 0; frame < 240; frame++) {
      for (const hit of world.step(DT).hits) if (hit.orb === marble.id && hit.scrollLanding) {
        const at = world.project(hit.x, hit.y, hit.z), occupied = point(world, other)
        expect(Math.hypot(at.x - occupied.x, at.y - occupied.y)).toBeGreaterThanOrEqual(radius(world, marble) + radius(world, other) - .1)
        landed = true
      }
      if (marble.motion.phase === 'ground') break
    }
    expect(landed).toBe(true)
    expect(marble.motion.phase).toBe('ground')
    const a = point(world, marble), b = point(world, other)
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(radius(world, marble) + radius(world, other) - .1)
  })

  it('attributes physical collisions to the grounded marble while another is lifted', () => {
    const { world, marble } = scene(390, 844)
    marble.motion.phase = 'lift'
    const grounded = world.marble('rolling')
    place(world, grounded, 310, 600)
    grounded.orb.y = ORB_R + .03
    grounded.orb.vy = -1
    grounded.orb.resting = false
    grounded.was = grounded.now = grounded.shown = [grounded.orb.x, grounded.orb.y, grounded.orb.z]
    const hits = []
    for (let frame = 0; frame < 6; frame++) hits.push(...world.step(DT).hits)
    const floors = hits.filter(hit => hit.kind === 'floor' && hit.landed)
    expect(floors.length).toBeGreaterThan(0)
    expect(floors.every(hit => hit.orb === 'rolling')).toBe(true)
  })

  it('gives marbles leaving the same dock separate landing spots', () => {
    const { world, marble } = scene(390, 844)
    const other = world.marble('other')
    place(world, other, 280, 500)
    world.setPads([{ x: 0, y: 0, w: 390, h: 844, r: 0, exclude: true }])
    for (let frame = 0; frame < 240; frame++) world.step(DT)
    expect(marble.motion.phase).toBe('docked')
    expect(other.motion.phase).toBe('docked')
    world.setPads([])
    for (let frame = 0; frame < 240; frame++) {
      world.step(DT)
      if (marble.motion.phase === 'ground' && other.motion.phase === 'ground') {
        const a = point(world, marble), b = point(world, other)
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(radius(world, marble) + radius(world, other) - .1)
      }
    }
    expect(marble.motion.phase).toBe('ground')
    expect(other.motion.phase).toBe('ground')
  })

  it('keeps desktop physics grounded during ordinary scrolls but lifts when squeezed', () => {
    const { world, marble } = scene(1440, 900)
    const frames = monitor(world, marble)
    for (let frame = 1; frame <= 20; frame++) {
      frames.frame(frame * 2)
      expect(marble.motion.phase).toBe('ground')
    }
    const p = point(world, marble)
    world.setPads([{ x: p.x - 100, y: p.y + 40 - 100, w: 200, h: 200, r: 0, exclude: true }])
    frames.frame()
    expect(marble.motion.phase).toBe('lift')
    for (let frame = 0; frame < 240; frame++) frames.frame()
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
  })

  it('uses no raised lift or bounce with reduced motion', () => {
    const { world, marble } = scene(390, 844, true)
    const frames = monitor(world, marble)
    frames.frame(600)
    for (let frame = 0; frame < 240; frame++) {
      frames.frame()
      expect(marble.motion.height).toBe(0)
    }
    expect(frames.landings).toBeGreaterThan(0)
    expect(marble.motion.phase).toBe('ground')
  })
})
