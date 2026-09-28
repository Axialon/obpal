import { expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { fitFingers, fingerPenetration } from '../src/sim/devices/claw-fingers'
import { CLAW, ClawLogic, type Prize } from '../src/sim/devices/claw'
import { createView } from '../src/sim/devices/claw.view'
import type { Stage } from '../src/sim/devices/stage'

vi.mock('../src/sim/devices/view', async original => ({
  ...await original<typeof import('../src/sim/devices/view')>(),
  plate: () => new THREE.Mesh(new THREE.PlaneGeometry(.1, .1)),
}))

it.each(['orb', 'cube'] as const)('stops all three fingers at a held %s instead of closing through it', kind => {
  const root = new THREE.Group(), hub = new THREE.Group(); hub.position.y = .9; root.add(hub)
  const fingers = Array.from({ length: 3 }, (_, k) => {
    const pivot = new THREE.Group(); pivot.rotation.y = k * Math.PI * 2 / 3; hub.add(pivot)
    const f = new THREE.Group(); f.position.set(.028, -.02, 0); pivot.add(f)
    for (const [height, y, angle] of [[.06, -.03, .35], [.055, -.075, -.35]]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(.012, height, .016)); mesh.position.set(.012, y, 0); mesh.rotation.z = angle; f.add(mesh)
    }
    f.rotation.z = -.2
    return f
  })
  const prizes: Prize[] = [{ x: 0, y: .9 - CLAW.reach - .011, z: 0, r: .055, kind, color: '#fff', held: true, won: 0 }]
  expect(fingerPenetration(fingers, root, prizes)).toBeGreaterThan(.01)
  fitFingers(fingers, root, prizes, 1)
  expect(fingerPenetration(fingers, root, prizes)).toBeLessThanOrEqual(.00011)
  expect(fingers[0].rotation.z).toBeLessThan(.75)
})

it('keeps an empty closing claw above the pit for the whole drop and lift', () => {
  const logic = new ClawLogic(1), c = logic.claws[0]
  c.phase = 'drop'
  for (let n = 0; n < 500; n++) {
    logic.step([null], 1 / 60)
    expect(c.y - .124 - CLAW.floor).toBeGreaterThanOrEqual(.0009999)
  }
  expect(c.phase).toBe('idle')
})

it('clears neighbouring prizes through a complete drop, grip and carry in the rendered cabinet', () => {
  const logic = new ClawLogic(1), scene = new THREE.Scene()
  const view = createView({ scene, theme: { light: false } } as Stage, logic)
  const c = logic.claws[0], prize = logic.prizes[0].find(p => Math.abs(p.x) < .1 && Math.abs(p.z) < .1)!
  c.x = prize.x; c.z = prize.z; c.phase = 'drop'
  const fingers = [0, 1, 2].map(k => scene.getObjectByName(`claw-0-finger-${k}`)!)
  const root = fingers[0].parent!.parent!.parent!
  for (let n = 0; n < 480; n++) {
    logic.step([null], 1 / 60); view.update([null], n / 60, 1 / 60)
    expect(fingerPenetration(fingers, root, logic.prizes[0]), `frame ${n}: ${c.phase}`).toBeLessThanOrEqual(.002)
  }
  expect(c.won).toBe(1)
}, 15000)
