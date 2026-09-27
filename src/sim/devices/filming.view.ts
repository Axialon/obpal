/** A small procedural set and a reusable pan/tilt camera body for the two filming devices. */
import * as THREE from 'three'
import { batch, floorMaterial, metal, plastic, rubber } from '../kit'
import { block, disc, rod } from './parts'
import { caption, part } from './optics.view'

export function filmSet(scene: THREE.Scene, width = 10, centre = 0) {
  const set = part(scene, 'studio-set')
  block(set, [width, 0.12, 11], [centre, -0.08, -1], floorMaterial('#465965'))
  block(set, [8, 3.8, 0.15], [0, 1.9, -5.3], plastic('#a9b8b9'))
  for (const x of [-3.3, 3.3]) {
    rod(set, [x, 0, -3.1], [x, 3, -3.1], 0.036)
    for (const z of [-0.35, 0.35]) rod(set, [x, 0.5, -3.1], [x + z, 0, -2.9], 0.025)
    block(set, [0.65, 0.95, 0.12], [x, 2.7, -3.1], plastic('#eee4c9'))
  }
  disc(set, 0.95, 0.18, [0, 0.1, -3.5], plastic('#728a95'))
  block(set, [0.65, 0.8, 0.65], [-1.2, 0.4, -3.9], plastic('#8095ac'))
  disc(set, 0.4, 1.25, [1.2, 0.62, -4.1], plastic('#b6a182')); batch(set)
  const subject = part(scene, 'filming-subject'); subject.position.set(0, 1.1, -3.5)
  const sculpture = new THREE.Mesh(new THREE.TorusKnotGeometry(0.48, 0.13, 80, 12), plastic('#d89970')); sculpture.castShadow = true; subject.add(sculpture)
  rod(scene, [0, 0.2, -3.5], [0, 0.7, -3.5], 0.055, metal)
  const title = caption('STUDY IN MOTION', '#e6e6ce', 2.2); title.position.set(0, 2.9, -5.15); scene.add(title)
  return { step(t: number) { subject.rotation.y = t * 0.2 } }
}

export function filmCamera(parent: THREE.Object3D) {
  const pan = part(parent, 'head-pan')
  disc(pan, 0.16, 0.12, [0, 0, 0], metal)
  block(pan, [0.09, 0.38, 0.15], [0.26, 0.17, 0], metal)
  const tilt = part(pan, 'head-tilt'); tilt.position.y = 0.3
  block(tilt, [0.48, 0.31, 0.3], [0, 0, 0], plastic('#303b42'))
  block(tilt, [0.38, 0.21, 0.025], [0, 0, 0.16], plastic('#6a929f'))
  block(tilt, [0.25, 0.045, 0.1], [0, 0.21, 0], rubber)
  for (const [r, z] of [[0.14, -0.22], [0.16, -0.32], [0.12, -0.39]]) { const lens = disc(tilt, r, 0.09, [0, 0, z], z === -0.39 ? plastic('#426d78') : rubber); lens.rotation.x = Math.PI / 2 }
  const eye = new THREE.PerspectiveCamera(50, 1.6, 0.04, 70); eye.position.z = -0.46; tilt.add(eye)
  batch(tilt); batch(pan, [tilt])
  return { pan, tilt, eye }
}
