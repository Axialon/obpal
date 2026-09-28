import { expect, it } from 'vitest'
import { ForkliftLogic, forkLoad, FORKS } from '../src/sim/devices/forklift'
import * as THREE from 'three'
import { restInput } from '../src/sim/devices/types'
it('maps two sticks to independent driving, lifting and tilt, with hard stops', () => {
  const l = new ForkliftLogic(),
    i = restInput()
  i.pad = { axes: [0, -1, 1, -1], triggers: [0, 0], buttons: 0, flags: 0, seq: 0, t: 0 }
  for (let n = 0; n < 500; n++) l.step([i], 0.05)
  const u = l.units[0]
  expect(u.lift).toBe(2.1)
  expect(u.tilt).toBe(0.25)
  expect(u.z).toBeGreaterThanOrEqual(-4.6)
  l.step([null], 0.05)
  expect(u.lift).toBe(2.1)
})
it('carries a pallet on the fork bearing plane through lift, tilt and heading changes', () => {
  const logic = new ForkliftLogic(), u = logic.units[0]
  u.load = 0
  for (let n = 0; n < 80; n++) {
    u.h = n * .2; u.tilt = -.17 + n / 79 * .42; u.lift = .08
    logic.step([null], 1 / 60)
    const load = forkLoad(u), frame = new THREE.Object3D()
    frame.position.set(u.x, 0, u.z); frame.rotation.y = u.h
    const mast = new THREE.Object3D(); mast.position.z = FORKS.mastZ; mast.rotation.x = u.tilt; frame.add(mast)
    frame.updateWorldMatrix(true, true)
    const bearing = new THREE.Vector3(0, u.lift + FORKS.top, FORKS.loadZ).applyMatrix4(mast.matrixWorld)
    const pallet = new THREE.Object3D(); pallet.position.set(load.x, load.y, load.z); pallet.rotation.set(u.tilt, u.h, 0, 'YXZ'); pallet.updateMatrixWorld()
    const underside = new THREE.Vector3(0, FORKS.deckBottom, 0).applyMatrix4(pallet.matrixWorld)
    expect(bearing.distanceTo(underside)).toBeLessThan(1e-10)
    for (const z of [-FORKS.halfDepth, FORKS.halfDepth]) expect(new THREE.Vector3(0, -FORKS.runnerDepth, z).applyMatrix4(pallet.matrixWorld).y).toBeGreaterThanOrEqual(-1e-10)
  }
})
it('requires low forks to pick up, and stores a pallet only on a matching shelf', () => {
  const l = new ForkliftLogic(),
    u = l.units[0],
    i = restInput()
  u.z = 1.15
  u.lift = 1
  i.presses = ['load']
  l.step([i], 1 / 60)
  expect(u.load).toBe(-1)
  u.lift = 0.12
  l.step([i], 1 / 60)
  expect(u.load).toBe(0)
  i.presses = []
  u.x = 3
  u.z = -1.95
  u.lift = 1.4
  l.step([i], 1 / 60)
  i.presses = ['load']
  l.step([i], 1 / 60)
  expect(u.delivered).toBe(1)
  expect(l.pallets[0].stored).toBe(true)
  l.home()
  expect(u.z).toBe(2)
})
it('maps trackpad lift and twist and lets an over-tipped load fall', () => {
  const l = new ForkliftLogic(),
    u = l.units[0],
    i = restInput('face.trackpad')
  u.load = 0
  u.lift = 1
  i.pan = [0, -50]
  i.twist = -50
  l.step([i], 1 / 60)
  expect(u.lift).toBe(1.4)
  expect(u.load).toBe(-1)
  for (let n = 0; n < 120; n++) l.step([null], 1 / 60)
  expect(l.pallets[0].y).toBe(0.12)
})
