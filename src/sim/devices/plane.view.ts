import * as THREE from 'three'
import { batch, maker, metal, plastic, rubber } from '../kit'
import { PlaneLogic, FLIGHT_RINGS } from './plane'
import { block, disc, playFrame, rod, showcase, wheel } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
import { ceramic, darkTitanium, gunmetal, optic } from '../kit/surfaces'
import { housing, pov, service, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
function trainer() {
  const root = new THREE.Group(),
    blue = darkTitanium
  const skin = skinSlot(root, 'airframe')
  const fuselage = housing(2, 2, 2, gunmetal, .3)
  fuselage.scale.set(0.2, 0.22, 0.97)
  fuselage.position.y = 0.15
  skin.add(fuselage)
  block(skin, [2.55, 0.075, 0.43], [0, 0.23, -0.05], gunmetal)
  block(skin, [1.02, 0.045, 0.26], [0, 0.3, 0.77], blue)
  block(skin, [0.05, 0.42, 0.38], [0, 0.45, 0.7], blue)
  for (const x of [-1, 1]) {
    block(skin, [0.16, 0.012, 0.43], [x, 0.275, -0.05], ceramic)
    block(skin, [0.045, 0.012, 0.4], [x * 1.18, 0.275, -0.05], ceramic)
    rod(root, [0, 0, 0], [x * 0.4, -0.12, -0.2], 0.022)
    wheel(root, x * 0.4, -0.12, -0.2, 0.1).userData.static = true
  }
  const canopy = housing(2, 2, 2, optic, .2)
  rod(root, [0, .02, .7], [0, -.16, .7], .018)
  wheel(root, 0, -.16, .7, .06).userData.static = true
  canopy.scale.set(0.16, 0.18, 0.32)
  canopy.position.set(0, 0.31, -0.12)
  skin.add(canopy)
  pov(root, [0, .42, -.46])
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
  return { root, prop, skin }
}
function airfield(scene: THREE.Scene, logic: PlaneLogic, live?: () => void) {
  const set = new THREE.Group()
  scene.add(set)
  set.add(tiledDeck(72, 88, 0, 8))
  const runway = tiledDeck(5, 42, 0, 3); runway.position.z = 3; set.add(runway)
  for (let z = -16; z < 24; z += 3) block(set, [0.16, 0.001, 1.5], [0, .0005, z], plastic('#ece6d8'))
  for (const x of [-2.6, 2.6]) for (let z = -16; z <= 24; z += 4) disc(set, 0.09, 0.06, [x, 0, z], plastic('#bbdbef'))
  block(set, [5, 2.7, 5], [-9, 1.25, 8], darkTitanium)
  const door = service(4, 2.2); door.position.set(-9, 1.02, 10.55); set.add(door)
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
  m.root.name = 'plane'; scene.add(m.root)
  if (live) upgradeSkins('plane', { airframe: m.skin }, live)
  return {
    step() {
      const u = logic.units[0]
      m.root.userData.contactMode = u.y > .231 ? 'clear' : 'touch'
      // Wheel bottoms are -.22 in the model; flight's legacy floor datum is .23.
      m.root.position.set(u.x, u.y - .01, u.z)
      const airborne = Math.min(1, Math.max(0, (u.y - .23) * 2))
      m.root.rotation.set(u.pitch * airborne, u.h, u.bank * airborne, 'YXZ')
      m.prop.rotation.z = u.prop
      rings.forEach((r, n) => r.scale.setScalar(n === u.next ? 1 : 0.92))
    },
  }
}
export function createView(stage: Stage, logic: PlaneLogic): DeviceView {
  stage.ground.visible = false
  const w = airfield(stage.scene, logic, () => stage.view.invalidate()),
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
