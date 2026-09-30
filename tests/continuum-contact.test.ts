import { Quaternion, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { ContactSurface, Sucker, SupportSolver, peelArm, sealedArea, type CupInput } from '../src/sim/continuum/contact'
import { COVE } from '../src/sim/continuum/profile'

const dt = 1 / 120,
  zero = new Vector3()
function fixture(normal = new Vector3(0, 0, 1), grip = 1, id = 'L1', position = new Vector3()) {
  const orientation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal),
    surface = new ContactSurface('glass', 'plane', new Vector3(2, 2, 1), grip).pose(position, orientation),
    site = { ...COVE.arms[0].cups[0], arm: id },
    cup = new Sucker(site, COVE.suction),
    input: CupInput = { point: position.clone().addScaledVector(normal, 0.001), facing: normal.clone().negate(), velocity: new Vector3(), attach: true }
  for (let i = 0; i < 20; i++) cup.step(input, [surface], dt)
  return { cup, surface, input }
}

describe('finite sucker adhesion', () => {
  it.each([new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0), new Vector3(1, 1, 1).normalize()])(
    'attaches to any surface angle with a full rim seal and dwell', (normal) => {
      const { cup, surface, input } = fixture(normal)
      expect(cup.phase).toBe('attached')
      expect(cup.flatten).toBeGreaterThan(0.95)
      expect(cup.flash).toBeGreaterThan(0)
      expect(cup.anchor.distanceTo(zero)).toBeLessThan(1e-12)
      expect(cup.normal.dot(normal)).toBeCloseTo(1)
      expect(cup.limit).toBeCloseTo(cup.pressure * Math.PI * cup.site.radius ** 2)
      for (let i = 0; i < 600; i++) cup.step(input, [surface], dt)
      expect(cup.phase).toBe('attached')
      expect(cup.anchor.distanceTo(zero)).toBeLessThan(1e-12)
    },
  )
  it('requires contact, facing, a sealable rim and elapsed time instead of attaching from proximity', () => {
    const { surface } = fixture(),
      cup = new Sucker(COVE.arms[0].cups[0], COVE.suction),
      input = { point: new Vector3(0, 0, 0.001), facing: new Vector3(0, 0, -1), velocity: zero, attach: true }
    cup.step({ ...input, point: new Vector3(0, 0, 0.1) }, [surface], dt)
    expect(cup.phase).toBe('free')
    cup.step({ ...input, facing: new Vector3(0, 0, 1) }, [surface], dt)
    expect(cup.phase).toBe('free')
    cup.step({ ...input, point: new Vector3(2.015, 0, 0.001) }, [surface], dt)
    expect(cup.phase).toBe('free')
    for (let i = 0; i < 13; i++) cup.step(input, [surface], dt)
    expect(cup.phase).toBe('sealing')
    expect(cup.force.length()).toBe(0)
    for (let i = 0; i < 2; i++) cup.step(input, [surface], dt)
    expect(cup.phase).toBe('attached')
  })
  it('grades rough stone below glass and does not manufacture a seal on a zero-grip surface', () => {
    const glass = fixture(),
      stone = fixture(new Vector3(0, 0, 1), 0.45),
      none = fixture(new Vector3(0, 0, 1), 0)
    expect(stone.cup.limit / glass.cup.limit).toBeCloseTo(0.45)
    expect(none.cup.phase).toBe('free')
  })
  it('refuses a leaking rim at an edge even when most of the cup touches the surface', () => {
    const { surface } = fixture(),
      cup = new Sucker(COVE.arms[0].cups[0], COVE.suction),
      input = { point: new Vector3(1.995, 0, 0.001), facing: new Vector3(0, 0, -1), velocity: zero, attach: true }
    for (let i = 0; i < 20; i++) cup.step(input, [surface], dt)
    expect(cup.phase).toBe('free')
    expect(cup.limit).toBe(0)
    input.point.x = 1.98
    for (let i = 0; i < 20; i++) cup.step(input, [surface], dt)
    expect(cup.phase).toBe('attached')
  })
  it.each([0, 1])('holds a fixed anchor without drift below pull-off in medium=%i, then releases above it', (water) => {
    const { cup, input, surface } = fixture()
    input.point.z = 0.005
    for (let i = 0; i < 1200; i++) cup.step(input, [surface], dt, water)
    expect(cup.phase).toBe('attached')
    expect(cup.anchor.z).toBe(0)
    expect(cup.force.z).toBeCloseTo(-9)
    input.point.z = 0.02
    cup.step(input, [surface], dt, water)
    expect(cup.phase).toBe('broken')
    expect(cup.force.length()).toBe(0)
    input.point.z = 0.001
    for (let i = 0; i < 100; i++) cup.step(input, [surface], dt, water)
    expect(cup.phase).toBe('broken')
    cup.step({ ...input, attach: false }, [surface], dt)
    for (let i = 0; i < 20; i++) cup.step(input, [surface], dt, water)
    expect(cup.phase).toBe('attached')
  })
  it('caps combined shear and pull, and drops an anchor whose surface disappears', () => {
    const { cup, input, surface } = fixture()
    input.point.x = 0.03
    cup.step(input, [surface], dt)
    expect(cup.phase).toBe('broken')
    const other = fixture()
    other.cup.step(other.input, [], dt)
    expect(other.cup.phase).toBe('broken')
  })
  it('follows a moving rigid surface through its local anchor without a stale world pin', () => {
    const { cup, input, surface } = fixture()
    for (let i = 1; i <= 120; i++) {
      surface.pose(new Vector3(i * 0.0001, 0, 0))
      input.point.x = i * 0.0001
      input.velocity.x = 0.0001 / dt
      cup.step(input, [surface], dt)
      expect(cup.phase).toBe('attached')
      expect(cup.anchor.x).toBeCloseTo(input.point.x, 12)
      expect(Math.abs(cup.force.x)).toBeLessThan(1e-10)
    }
  })
  it('peels progressively from the rim instead of dropping the entire seal in one tick', () => {
    const { cup, input, surface } = fixture(),
      before = cup.limit
    input.point.z = 0
    input.attach = false
    cup.step(input, [surface], dt)
    expect(cup.phase).toBe('peeling')
    expect(cup.limit).toBeGreaterThan(0)
    expect(cup.limit).toBeLessThan(before)
    for (let i = 0; i < 12; i++) cup.step(input, [surface], dt)
    expect(cup.phase).toBe('free')
    expect(cup.limit).toBe(0)
    const values = Array.from({ length: 21 }, (_, i) => sealedArea(i / 20))
    expect(values[0]).toBe(1)
    expect(values[20]).toBe(0)
    expect(values.every((v, i) => i === 0 || v <= values[i - 1])).toBe(true)
  })
  it('releases the tip cups before proximal cups and cancels an unfinished seal cleanly', () => {
    const { surface } = fixture(),
      cups = [0.12, 0.95].map((fraction) => new Sucker({ ...COVE.arms[0].cups[0], fraction }, COVE.suction)),
      input = { point: new Vector3(), facing: new Vector3(0, 0, -1), velocity: zero, attach: true }
    for (let i = 0; i < 20; i++) cups.forEach((cup) => cup.step(input, [surface], dt))
    peelArm(cups, 'L1')
    for (let i = 0; i < 13; i++) cups.forEach((cup) => cup.step(input, [surface], dt))
    expect(cups[0].phase).toBe('peeling')
    expect(cups[1].phase).toBe('free')
    const unfinished = new Sucker(COVE.arms[0].cups[0], COVE.suction)
    unfinished.step(input, [surface], dt)
    unfinished.step({ ...input, attach: false }, [surface], dt)
    expect(unfinished.phase).toBe('free')
    expect(unfinished.force.length()).toBe(0)
  })
  it('seals on pillar curvature and the separate faces near an object edge, but not across a sharp corner', () => {
    const pillar = new ContactSurface('pillar', 'cylinder', new Vector3(0.3, 1, 1), 0.9),
      box = new ContactSurface('step', 'box', new Vector3(0.5, 0.2, 0.5), 0.6),
      cup = new Sucker(COVE.arms[0].cups[0], COVE.suction),
      input = { point: new Vector3(0.301, 0, 0), facing: new Vector3(-1, 0, 0), velocity: zero, attach: true }
    for (let i = 0; i < 20; i++) cup.step(input, [pillar], dt)
    expect(cup.phase).toBe('attached')
    const edge = new Sucker(COVE.arms[0].cups[0], COVE.suction)
    input.point.set(0.475, 0.201, 0)
    input.facing.set(0, -1, 0)
    for (let i = 0; i < 20; i++) edge.step(input, [box], dt)
    expect(edge.phase).toBe('attached')
    const corner = new Sucker(COVE.arms[0].cups[0], COVE.suction)
    input.point.set(0.501, 0.201, 0)
    input.facing.set(-1, -1, 0).normalize()
    for (let i = 0; i < 20; i++) corner.step(input, [box], dt)
    expect(corner.phase).toBe('free')
  })
  it('refuses malformed normals and holds invalid time without changing a finite state', () => {
    const { cup, input, surface } = fixture(),
      before = cup.limit
    cup.step(input, [surface], NaN)
    expect(cup.limit).toBe(before)
    cup.step({ ...input, facing: new Vector3(NaN, 0, 0) }, [surface], dt)
    expect(cup.phase).toBe('broken')
    expect(() => surface.pose(new Vector3(NaN, 0, 0))).toThrow()
    expect(() => new Sucker(cup.site, { ...COVE.suction, friction: 0 })).toThrow()
  })
})

describe('climbing support foundation', () => {
  it('balances force and torque with unequal seals and asymmetric anchors in a rotated frame', () => {
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 2, 3).normalize(), 0.73),
      centre = new Vector3(1.2, -0.4, 0.8),
      normal = new Vector3(0, 0, 1).applyQuaternion(rotation),
      positions = [[-0.3, -0.2, 0], [0.25, -0.12, 0.03], [-0.18, 0.28, -0.02], [0.22, 0.2, 0.01]],
      cups = positions.map(([x, y, z], i) => fixture(normal, 0.65 + i * 0.1, `arm${i}`,
        new Vector3(x, y, z).applyQuaternion(rotation).add(centre)).cup),
      load = new Vector3(2, 3, 4).applyQuaternion(rotation),
      moment = new Vector3(0.15, -0.12, 0.09).applyQuaternion(rotation),
      solver = new SupportSolver(cups, COVE.support),
      total = new Vector3(),
      torque = new Vector3()
    expect(solver.solve(centre, load, moment).stable).toBe(true)
    solver.forces.forEach((force, i) => {
      total.add(force)
      torque.add(cups[i].anchor.clone().sub(centre).cross(force))
    })
    expect(total.distanceTo(load)).toBeLessThan(1e-8)
    expect(torque.distanceTo(moment)).toBeLessThan(1e-8)
  })
  it.each([new Vector3(0, 0, 1), new Vector3(0, -1, 0)])('supports a wall or overhang only with sufficient distinct arms and a bounded wrench', (normal) => {
    const orientation = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal),
      fixtures = [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]].map(([x, y], i) =>
        fixture(normal, 1, `arm${i}`, new Vector3(x, y, 0).applyQuaternion(orientation))),
      cups = fixtures.map((f) => f.cup),
      solver = new SupportSolver(cups, COVE.support),
      centre = normal.clone().multiplyScalar(0.15),
      load = new Vector3(0, 10, 0)
    const stable = solver.solve(centre, load, zero)
    expect(stable.stable).toBe(true)
    expect(stable.arms).toBe(4)
    expect(stable.residual).toBeLessThan(1e-8)
    expect(solver.forces.reduce((sum, force) => sum.add(force), new Vector3()).distanceTo(load)).toBeLessThan(1e-8)
    expect(solver.solve(centre, new Vector3(0, 1000, 0), zero).stable).toBe(false)
    expect(solver.forces.every((force) => force.length() === 0)).toBe(true)
    cups[0].peel()
    for (let i = 0; i < 12; i++) cups[0].step({ ...fixtures[0].input, attach: false }, [fixtures[0].surface], dt)
    expect(solver.solve(centre, load, zero).stable).toBe(false)
  })
  it('rejects many cups on one arm, coincident anchors and a torque beyond the seal limits', () => {
    const cups = [0, 1, 2, 3].map(() => fixture().cup),
      solver = new SupportSolver(cups, COVE.support)
    expect(solver.solve(zero, new Vector3(0, 10, 0), zero).stable).toBe(false)
    cups.forEach((cup, i) => cup.anchor.set(i % 2 ? 0.2 : -0.2, i > 1 ? 0.2 : -0.2, 0))
    expect(solver.solve(zero, new Vector3(0, 10, 0), zero).arms).toBe(1)
    expect(solver.solve(zero, zero, new Vector3(10000, 0, 0)).stable).toBe(false)
  })
})
