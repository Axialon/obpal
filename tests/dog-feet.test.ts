import { expect, it } from 'vitest'
import { DogLogic } from '../src/sim/devices/dog'
import { DOG_LEG, DOG_PAD, dogGround, footPlant, hipAt, legForward, legIK, stepFeet, soleHeight } from '../src/sim/devices/dog-feet'
import * as THREE from 'three'
import { plateGeometry } from '../src/sim/kit/precision'
import { contactPart, contactProbe, contactSurface } from '../src/sim/contact'
import { restInput } from '../src/sim/devices/types'

it('solves three-dimensional foot IK across reachable slopes and turns', () => {
  for (const x of [-.12, 0, .12]) for (const y of [-.62, -.45]) for (const z of [-.2, 0, .2]) {
    const ik = legIK(x, y, z), got = legForward(ik)
    expect(ik.reached).toBe(true)
    expect(Math.hypot(got.x - x, got.y - y, got.z - z)).toBeLessThan(1e-9)
  }
  const far = legIK(0, -2, 0)
  expect(far.reached).toBe(false)
  expect(Object.values(legForward(far)).every(Number.isFinite)).toBe(true)
})

it.each([1 / 60, 1 / 30, 1 / 20])('plants stance feet while walking, reversing, turning, stopping and sitting at %s second steps', dt => {
  const logic = new DogLogic(), input = restInput(), u = logic.units[0]
  for (let frame = 0; frame < 900; frame++) {
    const mode = Math.floor(frame / 150)
    input.pad = { axes: [mode === 1 || mode === 4 ? .8 : 0, mode < 3 ? -1 : mode === 3 ? 1 : 0, 0, 0], triggers: [0, 0], buttons: 0, flags: 0, seq: frame, t: frame }
    const before = u.legs.map(l => ({ stance: l.stance, foot: { ...l.foot } }))
    if (mode === 5) input.presses = ['sit']
    logic.step([input], dt)
    for (const [k, leg] of u.legs.entries()) {
      if (before[k].stance && leg.stance) expect(leg.foot).toEqual(before[k].foot)
      if (leg.stance) expect(leg.foot.y).toBe(soleHeight(leg.foot.x, leg.foot.z, leg.heading))
      const ankle = legForward(leg), hip = hipAt(k), c = Math.cos(u.h), s = Math.sin(u.h)
      const world = { x: u.x + c * (hip.x + ankle.x) + s * (hip.z + ankle.z), y: u.y + ankle.y - DOG_LEG.sole / 2, z: u.z - s * (hip.x + ankle.x) + c * (hip.z + ankle.z) }
      expect(Math.hypot(world.x - leg.foot.x, world.y - leg.foot.y, world.z - leg.foot.z), JSON.stringify({ frame, k, stance: leg.stance, body: [u.x, u.y, u.z, u.h], foot: leg.foot, world })).toBeLessThan(.00001)
      expect(world.y).toBeGreaterThanOrEqual(dogGround(world.x, world.z) - .002)
    }
  }
})

it('sets body height from support and leg reach on uneven terrain deterministically', () => {
  const a = new DogLogic(), b = new DogLogic(), terrain = (x: number, z: number) => .04 * x + .02 * z
  for (let i = 0; i < 120; i++) {
    for (const logic of [a, b]) { const u = logic.units[0]; u.v = 1; u.z -= 1 / 60; stepFeet(u, 1 / 60, terrain) }
    expect(a.units).toEqual(b.units)
  }
})

it('lands complete soles around the visible charging-pad chamfers, including diagonal approaches', () => {
  const scene = new THREE.Scene(), foot = contactPart(new THREE.Mesh(plateGeometry(DOG_LEG.width, DOG_LEG.sole, DOG_LEG.depth)), 'sole', { slope: true })
  const pad = contactSurface(new THREE.Mesh(plateGeometry(DOG_PAD.width, DOG_PAD.height, DOG_PAD.depth)))
  pad.position.set(DOG_PAD.x[1], 0, DOG_PAD.z)
  const floor = contactSurface(new THREE.Mesh(new THREE.PlaneGeometry(10, 10))); floor.rotation.x = -Math.PI / 2
  scene.add(foot, pad, floor)
  const probe = contactProbe(scene)
  for (const heading of [0, .3, .8, 1.2]) for (let edge = -.15; edge <= .15; edge += .01) for (const z of [DOG_PAD.z, DOG_PAD.z + DOG_PAD.depth / 2]) {
    const p = footPlant({ x: DOG_PAD.x[1] + DOG_PAD.width / 2 + edge, z }, heading)
    foot.position.set(p.x, p.y + DOG_LEG.sole / 2, p.z); foot.rotation.y = heading
    expect(Math.abs(probe.sample()[0].gapMm!)).toBeLessThan(.001)
  }
  probe.dispose()
})
