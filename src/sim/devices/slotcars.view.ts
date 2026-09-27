import * as THREE from 'three'
import { batch, floorMaterial, glass, maker, metal, plastic, rubber } from '../kit'
import { SlotcarsLogic, laneLength, slotPose } from './slotcars'
import { block, playFrame, rod, showcase, wheel } from './parts'
import type { Stage } from './stage'
import type { DeviceView } from './view'
const COLOURS = ['#e58d78', '#79b9cf', '#ead16b', '#a5c799']
function strip(lane: number, width: number, y: number, material: THREE.Material) {
  const v: number[] = [],
    index: number[] = []
  for (let n = 0; n <= 192; n++) {
    const p = slotPose((n / 192) * laneLength(lane), lane)
    for (const side of [-1, 1])
      v.push(p.x + (Math.cos(p.h) * width * side) / 2, y, p.z - (Math.sin(p.h) * width * side) / 2)
    if (n < 192) {
      const j = n * 2
      index.push(j, j + 1, j + 2, j + 1, j + 3, j + 2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  // Match the kit's position/normal/UV attributes when rails and posts share a material batch.
  g.setAttribute(
    'uv',
    new THREE.Float32BufferAttribute(Array.from({ length: 193 }, (_, n) => [0, n / 192, 1, n / 192]).flat(), 2),
  )
  g.setIndex(index)
  g.computeVertexNormals()
  return new THREE.Mesh(g, material)
}
function car(n: number) {
  const root = new THREE.Group(),
    paint = plastic(COLOURS[n])
  block(root, [0.26, 0.1, 0.62], [0, 0.08, 0], paint)
  block(root, [0.22, 0.1, 0.28], [0, 0.17, 0.02], glass)
  block(root, [0.2, 0.025, 0.19], [0, 0.23, 0.025], paint)
  for (const x of [-0.14, 0.14]) for (const z of [-0.19, 0.19]) wheel(root, x, 0.065, z, 0.064).userData.static = true
  block(root, [0.3, 0.025, 0.1], [0, 0.19, 0.27], rubber)
  for (const x of [-0.08, 0.08]) {
    block(root, [0.04, 0.035, 0.02], [x, 0.1, -0.315], plastic('#fff5c9'))
    block(root, [0.04, 0.025, 0.02], [x, 0.1, 0.315], plastic('#d05c51'))
  }
  block(root, [0.035, 0.012, 0.5], [0, 0.135, 0], metal)
  maker(root, 0, 0.25, 0, 0.06)
  batch(root)
  return root
}
function raceway(scene: THREE.Scene, logic: SlotcarsLogic) {
  const set = new THREE.Group()
  scene.add(set)
  block(set, [21, 0.12, 15], [0, -0.08, 0], floorMaterial('#536451'))
  for (let n = 0; n < 4; n++) {
    set.add(strip(n, 0.44, 0.015, plastic('#424950')), strip(n, 0.017, 0.022, rubber))
    for (const offset of [-0.025, 0.025]) {
      const rail = strip(n, 0.005, 0.023, metal)
      rail.position.z = offset
      set.add(rail)
    }
  }
  for (let n = 0; n < 22; n++)
    block(set, [0.1, 0.012, 0.12], [0, 0.028, 2 + n * 0.075], plastic(n % 2 ? '#e4e7da' : '#242a30'))
  for (const x of [-8.2, 8.2]) {
    block(set, [0.15, 0.45, 10], [x, 0.15, 0], plastic('#768e9a'))
    for (let z = -4; z <= 4; z += 2) rod(set, [x, 0.1, z], [x, 0.8, z], 0.025)
  }
  for (const x of [-1.4, 1.4]) rod(set, [x, 0, 0], [x, 1.4, 0], 0.04)
  block(set, [3.1, 0.3, 0.14], [0, 1.35, 0], plastic('#506675'))
  batch(set)
  const cars = logic.units.map((_, n) => {
    const m = car(n)
    scene.add(m)
    return m
  })
  return {
    step() {
      cars.forEach((m, n) => {
        const u = logic.units[n]
        m.position.set(u.x, u.y, u.z)
        m.rotation.set(u.off ? 0.15 : 0, u.h, u.off ? 0.3 : 0)
      })
    },
  }
}
export function createView(stage: Stage, logic: SlotcarsLogic): DeviceView {
  const w = raceway(stage.scene, logic),
    at = (n: number): [number, number, number] => [logic.units[n].x, 0.17, logic.units[n].z]
  return {
    framing: playFrame(at(0), 0.5),
    overview: playFrame([0, 0, 0], 8.5),
    inspect: () => playFrame(at(0), 0.36),
    follow: (n) => new THREE.Vector3(...at(n)),
    update: () => w.step(),
  }
}
export function preview() {
  const l = new SlotcarsLogic()
  return showcase(
    (s) => {
      const w = raceway(s, l)
      return {
        step(t) {
          l.units.forEach((u, n) => {
            const p = slotPose(3.8 + Math.sin(t * 0.4 + n) * 0.5, n)
            Object.assign(u, p)
          })
          w.step()
        },
      }
    },
    [0, 0.17, 2.7],
    0.85,
  )
}
