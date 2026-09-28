import * as THREE from 'three'
import { contactPart } from '../contact'
import { batch, cable, glass, maker, metal, plastic, rubber } from '../kit'
import { ExcavatorLogic, BOOM, STICK, BUCKET } from './excavator'
import { block, disc, playFrame, rod, showcase, tracks, wheel } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
import { ceramic, darkTitanium, gunmetal } from '../kit/surfaces'
import { pov, tiledDeck } from '../kit/precision'
import { skinSlot, upgradeSkins } from '../kit/skins'
function digger() {
  const root = new THREE.Group(),
    yellow = gunmetal
  root.name = 'excavator'
  tracks(root, 1.35, 1.9)
  disc(root, 0.5, 0.2, [0, 0.58, 0], metal)
  const upper = new THREE.Group()
  upper.position.y = 0.7
  root.add(upper)
  const skin = skinSlot(upper, 'upperSkin', block(upper, [1.35, 0.4, 1.35], [0, 0, 0.2], yellow))
  pov(upper, [-.37, .72, -.28])
  block(upper, [0.62, 0.7, 0.72], [-0.37, 0.53, 0.13], glass)
  for (const x of [-0.7, -0.05]) for (const z of [-0.25, 0.52]) rod(upper, [x, 0.15, z], [x, 0.95, z], 0.035, metal)
  block(skin, [0.74, 0.07, 0.9], [-0.37, 0.98, 0.13], yellow)
  block(upper, [0.32, 0.3, 0.3], [-0.38, 0.35, 0.23], rubber)
  maker(upper, 0.35, 0.21, 0.55, 0.22)
  const boom = new THREE.Group()
  boom.position.set(0, 0.3, 0)
  upper.add(boom)
  const boomSkin = skinSlot(boom, 'boomSkin', block(boom, [0.23, 0.24, BOOM], [0, 0, -BOOM / 2], yellow))
  rod(boom, [0, -0.14, -0.15], [0, -0.14, -1.25], 0.06, metal)
  boom.add(
    cable(
      [
        [0.14, 0.1, 0],
        [0.14, 0.2, -0.7],
        [0.14, 0.1, -1.6],
      ],
      0.025,
    ),
  )
  const stick = new THREE.Group()
  stick.position.z = -BOOM
  boom.add(stick)
  const stickSkin = skinSlot(stick, 'stickSkin', block(stick, [0.2, 0.2, STICK], [0, 0, -STICK / 2], yellow))
  rod(stick, [0, -0.13, -0.1], [0, -0.13, -1.1], 0.055, metal)
  const bucket = new THREE.Group()
  bucket.position.z = -STICK
  stick.add(bucket)
  for (const [n, part] of BUCKET.entries()) block(bucket, part.size, part.at, n < 2 ? plastic('#59636a') : metal)
  contactPart(bucket, 'bucket', { mode: 'clear' })
  const load = block(bucket, [0.5, 0.16, 0.43], [0, -0.12, -0.15], plastic('#d6b479'))
  batch(bucket, [load])
  batch(stick, [bucket])
  batch(boom, [stick])
  batch(upper, [boom])
  batch(root, [upper])
  return { root, upper, boom, stick, bucket, load, skin, boomSkin, stickSkin }
}
function site(scene: THREE.Scene, logic: ExcavatorLogic, live?: () => void) {
  const set = new THREE.Group()
  scene.add(set)
  set.add(tiledDeck(14, 12, 0, 2))
  for (const x of [-6, 6])
    for (let z = -5; z <= 5; z += 2) {
      rod(set, [x, 0, z], [x, 0.8, z], 0.04)
      rod(set, [x, 0.7, z], [x, 0.7, Math.min(5, z + 2)], 0.025)
    }
  const truck = new THREE.Group()
  truck.position.x = 3
  set.add(truck)
  truck.userData.static = true
  block(truck, [1.55, 0.15, 3.7], [0, 0.45, -0.4], metal)
  block(truck, [1.45, 1, 0.9], [0, 1, -1.8], darkTitanium)
  block(truck, [1.2, 0.45, 0.025], [0, 1.25, -2.26], glass)
  for (const x of [-0.72, 0.72]) {
    block(truck, [0.12, 0.55, 2.6], [x, 1.02, 0], darkTitanium)
    block(truck, [.005, .18, 1.8], [x + Math.sign(x)*.061, 1.03, 0], ceramic)
    for (const z of [-1.7, 0.85]) wheel(truck, x, 0.3, z, 0.3).userData.static = true
  }
  block(truck, [1.4, 0.12, 2.6], [0, 0.79, 0], gunmetal)
  batch(set)
  const pile = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), new THREE.MeshStandardMaterial({ color: '#ac9b7d', roughness: .75, flatShading: true }))
  pile.position.set(0, -0.05, -2.5)
  pile.scale.set(1.35, 0.7, 1.35)
  scene.add(pile)
  const filled = block(scene, [1.3, 0.3, 2.3], [3, 1, 0], plastic('#d6b479')),
    m = digger()
  scene.add(m.root)
  if (live) upgradeSkins('excavator', { upperSkin: m.skin, boomSkin: m.boomSkin, stickSkin: m.stickSkin }, live)
  return {
    m,
    step() {
      const u = logic.units[0]
      m.root.position.set(u.x, 0, u.z)
      m.upper.rotation.y = u.swing
      m.boom.rotation.x = u.boom
      m.stick.rotation.x = u.stick
      m.bucket.rotation.x = -(u.boom + u.stick) + u.curl * 0.8
      m.load.visible = u.load > 0
      pile.scale.y = 0.7 * Math.cbrt(logic.sand / 20)
      filled.visible = u.delivered > 0
      filled.scale.y = Math.max(0.01, u.delivered / 10)
    },
  }
}
export function createView(stage: Stage, logic: ExcavatorLogic): DeviceView {
  const w = site(stage.scene, logic, () => stage.view.invalidate())
  return {
    framing: playFrame([0, 1, -0.8], 2, [1.3, 0.65, 1.3]),
    overview: playFrame([0, 0.6, 0], 6),
    inspect: () => playFrame([0, 1, -0.5], 1.45),
    update: () => w.step(),
    // The swing rings the turntable; the boom, stick and bucket ring their hinges.
    partAt: (_n, part) => part === 'swing' ? { object: w.m.upper, axis: 'y', radius: 0.62, at: [0, -0.12, 0] }
      : part === 'boom' ? { object: w.m.boom, axis: 'x', radius: 0.26 }
      : part === 'stick' ? { object: w.m.stick, axis: 'x', radius: 0.24 }
      : part === 'bucket' ? { object: w.m.bucket, axis: 'x', radius: 0.26 }
      : null,
  }
}
export function preview() {
  const l = new ExcavatorLogic()
  return showcase(
    (s) => {
      const w = site(s, l)
      return {
        step(t) {
          l.units[0].swing = Math.sin(t * 0.4) * 0.4
          l.units[0].boom = 0.7 + Math.sin(t) * 0.15
          w.step()
        },
      }
    },
    [0, 1, -0.8],
    2,
  )
}
