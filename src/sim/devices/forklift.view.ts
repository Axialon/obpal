import * as THREE from 'three'
import { batch, cable, maker, metal, plastic, rubber } from '../kit'
import { ForkliftLogic, RACKS } from './forklift'
import { block, playFrame, rod, showcase, wheel } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, service, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
function forklift() {
  const root = new THREE.Group(),
    yellow = gunmetal
  const skin = skinSlot(root, 'chassisSkin')
  pov(root, [0, 1.45, -.48])
  block(skin, [1, 0.4, 1.55], [0, 0.48, 0], yellow)
  block(skin, [1.04, 0.6, 0.5], [0, 0.68, 0.55], yellow)
  for (const x of [-0.52, 0.52]) for (const z of [-0.5, 0.5]) wheel(root, x, 0.25, z, 0.24).userData.static = true
  for (const x of [-0.45, 0.45]) for (const z of [-0.45, 0.45]) rod(root, [x, 0.62, z], [x, 1.8, z], 0.04)
  block(skin, [1.02, 0.08, 1.08], [0, 1.82, 0], yellow)
  for (let z = -0.4; z <= 0.4; z += 0.16) block(root, [0.85, 0.025, 0.06], [0, 1.88, z], rubber)
  block(root, [0.45, 0.18, 0.43], [0, 0.87, 0.2], rubber)
  block(root, [0.45, 0.4, 0.1], [0, 1.07, 0.38], rubber)
  rod(root, [0, 0.72, -0.25], [0, 1.12, -0.4], 0.035)
  const steering = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 8, 24), rubber)
  steering.position.set(0, 1.12, -0.4)
  steering.rotation.x = -0.4
  root.add(steering)
  const mast = new THREE.Group()
  mast.position.set(0, 0, -0.79)
  root.add(mast)
  for (const x of [-0.35, 0.35]) {
    block(mast, [0.1, 2.3, 0.13], [x, 1.2, 0], metal)
    rod(mast, [x, 0.3, 0.1], [x, 1.8, 0.1], 0.027, rubber)
  }
  block(mast, [0.8, 0.13, 0.13], [0, 2.3, 0], metal)
  const forks = new THREE.Group()
  mast.add(forks)
  block(forks, [0.82, 0.65, 0.09], [0, 0.33, -0.08], metal)
  for (const x of [-0.24, 0.24]) block(forks, [0.12, 0.06, 0.95], [x, 0, -0.5], metal)
  mast.add(
    cable(
      [
        [0, 0.3, 0.1],
        [0.12, 1.1, 0.2],
        [0, 2.1, 0.1],
      ],
      0.018,
    ),
  )
  maker(root, 0, 0.995, 0.57, 0.2)
  batch(forks)
  batch(mast, [forks])
  batch(root, [mast])
  return { root, mast, forks, skin }
}
function warehouse(scene: THREE.Scene, logic: ForkliftLogic, live?: () => void) {
  const set = new THREE.Group()
  scene.add(set)
  set.add(tiledDeck(12, 11, -.01, 1.5))
  block(set, [12, 3, 0.12], [0, 1.5, -5.5], darkTitanium)
  for (const x of [-4, 0, 4]) { const panel = service(1.8, 1.2); panel.position.set(x, 1.5, -5.435); set.add(panel) }
  for (const x of RACKS) {
    for (const s of [-1, 1])
      for (const z of [-3.9, -2.3]) {
        block(set, [0.12, 3, 0.12], [x + s, 1.5, z], darkTitanium)
        rod(set, [x + s, 0, z], [x + s, 2.8, z === -3.9 ? -2.3 : -3.9], 0.018)
      }
    for (const y of [0.25, 1.34, 2.6]) {
      block(set, [2.15, 0.12, 1.7], [x, y, -3.1], gunmetal)
      for (const s of [-1, 1]) block(set, [2.3, 0.1, 0.06], [x, y + 0.06, -3.1 + s * 0.8], ceramic)
    }
  }
  for (const x of [-1.35, 1.35]) block(set, [0.05, 0.008, 10], [x, 0.003, 0], ceramic)
  batch(set)
  const m = forklift()
  scene.add(m.root)
  if (live) upgradeSkins('forklift', { chassisSkin: m.skin }, live)
  const pallets = logic.pallets.map(() => {
    const g = new THREE.Group()
    scene.add(g)
    for (let n = 0; n < 5; n++) block(g, [0.85, 0.055, 0.14], [0, 0.04, (n - 2) * 0.18], darkTitanium)
    for (const x of [-0.32, 0.32]) block(g, [0.13, 0.12, 0.85], [x, -0.04, 0], gunmetal)
    block(g, [0.72, 0.7, 0.75], [0, 0.42, 0], ceramic)
    for (const x of [-0.25, 0.25]) block(g, [0.035, 0.72, 0.76], [x, 0.43, 0], plastic('#555d61'))
    batch(g)
    return g
  })
  return {
    step() {
      const u = logic.units[0]
      m.root.position.set(u.x, 0, u.z)
      m.root.rotation.y = u.h
      m.mast.rotation.x = u.tilt
      m.forks.position.y = u.lift
      pallets.forEach((g, n) => {
        const p = logic.pallets[n]
        g.position.set(p.x, p.y, p.z)
        g.rotation.y = n === u.load ? u.h : 0
      })
    },
  }
}
export function createView(stage: Stage, logic: ForkliftLogic): DeviceView {
  const w = warehouse(stage.scene, logic, () => stage.view.invalidate()),
    at = (): [number, number, number] => [logic.units[0].x, 1, logic.units[0].z - 0.3]
  return {
    framing: playFrame(at(), 1.15, [0.25, 1.05, -1.5]),
    overview: playFrame([0, 0.8, 0], 6),
    inspect: () => playFrame(at(), 0.95, [0.25, 1.05, -1.5]),
    follow: () => new THREE.Vector3(...at()),
    update: () => w.step(),
  }
}
export function preview() {
  const l = new ForkliftLogic()
  return showcase(
    (s) => {
      const w = warehouse(s, l)
      return {
        step(t) {
          l.units[0].lift = 0.35 + 0.3 * Math.sin(t)
          w.step()
        },
      }
    },
    [0, 1, 1.7],
    1.4,
  )
}
