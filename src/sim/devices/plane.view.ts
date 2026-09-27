import * as THREE from 'three'
import { batch, floorMaterial, glass, maker, metal, plastic, rubber } from '../kit'
import { PlaneLogic, FLIGHT_RINGS } from './plane'
import { block, disc, playFrame, rod, showcase, wheel } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
function trainer() {
  const root = new THREE.Group(),
    blue = plastic('#4b8aa8')
  const fuselage = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), plastic('#edeada'))
  fuselage.scale.set(0.2, 0.22, 0.97)
  fuselage.position.y = 0.15
  root.add(fuselage)
  block(root, [2.55, 0.075, 0.43], [0, 0.23, -0.05])
  block(root, [1.02, 0.045, 0.26], [0, 0.3, 0.77], blue)
  block(root, [0.05, 0.42, 0.38], [0, 0.45, 0.7], blue)
  for (const x of [-1, 1]) {
    block(root, [0.16, 0.012, 0.43], [x, 0.275, -0.05], blue)
    block(root, [0.045, 0.012, 0.4], [x * 1.18, 0.275, -0.05], plastic('#ed9866'))
    rod(root, [0, 0, 0], [x * 0.4, -0.12, -0.2], 0.022)
    wheel(root, x * 0.4, -0.12, -0.2, 0.1).userData.static = true
  }
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), glass)
  canopy.scale.set(0.16, 0.18, 0.32)
  canopy.position.set(0, 0.31, -0.12)
  root.add(canopy)
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.23, 24), blue)
  spinner.rotation.x = -Math.PI / 2
  spinner.position.set(0, 0.15, -1.04)
  root.add(spinner)
  const prop = new THREE.Group()
  prop.position.set(0, 0.15, -1.03)
  root.add(prop)
  block(prop, [0.72, 0.065, 0.035], [0, 0, 0], rubber)
  disc(prop, 0.08, 0.04, [0, 0, 0], metal)
  maker(root, 0.55, 0.275, -0.05, 0.16)
  batch(prop)
  batch(root, [prop])
  return { root, prop }
}
function airfield(scene: THREE.Scene, logic: PlaneLogic) {
  const set = new THREE.Group()
  scene.add(set)
  block(set, [72, 0.1, 88], [0, -0.14, 0], floorMaterial('#708260'))
  block(set, [5, 0.05, 42], [0, -0.06, 3], floorMaterial('#4d5860'))
  for (let z = -16; z < 24; z += 3) block(set, [0.16, 0.012, 1.5], [0, -0.025, z], plastic('#ece6d8'))
  for (const x of [-2.6, 2.6]) for (let z = -16; z <= 24; z += 4) disc(set, 0.09, 0.06, [x, 0, z], plastic('#bbdbef'))
  block(set, [5, 2.7, 5], [-9, 1.25, 8], plastic('#a6b3af'))
  block(set, [4, 2.2, 0.08], [-9, 1.02, 10.55], plastic('#65777e'))
  block(set, [5.5, 0.14, 5.5], [-9, 2.65, 8], metal)
  rod(set, [7, 0, 6], [7, 3, 6], 0.045)
  const sock = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 1.2, 16, 1, true), plastic('#e69b6c'))
  sock.rotation.z = Math.PI / 2
  sock.position.set(7.6, 3, 6)
  set.add(sock)
  batch(set)
  const rings = FLIGHT_RINGS.map(([x, y, z]) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.055, 10, 64), plastic('#e9c878'))
    m.position.set(x, y, z)
    scene.add(m)
    return m
  })
  const m = trainer()
  scene.add(m.root)
  return {
    step() {
      const u = logic.units[0]
      m.root.position.set(u.x, u.y, u.z)
      m.root.rotation.set(u.pitch, u.h, u.bank, 'YXZ')
      m.prop.rotation.z = u.prop
      rings.forEach((r, n) => r.scale.setScalar(n === u.next ? 1 : 0.92))
    },
  }
}
export function createView(stage: Stage, logic: PlaneLogic): DeviceView {
  stage.ground.visible = false
  const w = airfield(stage.scene, logic),
    at = (): [number, number, number] => [logic.units[0].x, logic.units[0].y + 0.2, logic.units[0].z]
  return {
    framing: playFrame(at(), 1.3, [1, 0.65, 1.3]),
    overview: playFrame([0, 2, 0], 32),
    inspect: () => playFrame(at(), 1.1),
    follow: () => new THREE.Vector3(...at()),
    update: () => w.step(),
  }
}
export function preview() {
  const l = new PlaneLogic()
  return showcase(
    (s) => {
      const w = airfield(s, l)
      return {
        step(t) {
          l.units[0].y = 1
          l.units[0].bank = Math.sin(t) * 0.2
          l.units[0].prop = t * 30
          w.step()
        },
      }
    },
    [0, 1.2, 8],
    1.4,
  )
}
