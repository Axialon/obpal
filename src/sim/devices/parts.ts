/** Procedural construction helpers. Static parts share the kit's materials and are batched per rigid body. */
import * as THREE from 'three'
import { batch, box, cylinder, metal, plastic, rubber } from '../kit'
import { previewScene, type Preview } from './view'
import type { Framing } from './stage'
import { contactPart } from '../contact'

export function block(
  parent: THREE.Object3D,
  size: [number, number, number],
  at: [number, number, number],
  mat: THREE.Material = plastic(),
) {
  const mesh = box(...size, mat)
  mesh.castShadow = true
  mesh.position.set(...at)
  parent.add(mesh)
  return mesh
}
export function rod(
  parent: THREE.Object3D,
  from: [number, number, number],
  to: [number, number, number],
  radius = 0.025,
  mat: THREE.Material = metal,
) {
  const a = new THREE.Vector3(...from),
    b = new THREE.Vector3(...to),
    d = b.clone().sub(a)
  const mesh = cylinder(radius, d.length(), mat, 12)
  mesh.castShadow = true
  mesh.position.copy(a.add(b).multiplyScalar(0.5))
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())
  parent.add(mesh)
  return mesh
}
export function disc(
  parent: THREE.Object3D,
  radius: number,
  height: number,
  at: [number, number, number],
  mat: THREE.Material = metal,
) {
  const mesh = cylinder(radius, height, mat, 32)
  mesh.castShadow = true
  mesh.position.set(...at)
  parent.add(mesh)
  return mesh
}
export function wheel(parent: THREE.Object3D, x: number, y: number, z: number, r = 0.2) {
  const g = new THREE.Group()
  g.position.set(x, y, z)
  parent.add(g)
  const tire = disc(g, r, r * 0.7, [0, 0, 0], rubber)
  tire.rotation.z = Math.PI / 2
  for (const side of [-1, 1]) {
    const hub = disc(g, r * 0.62, 0.02, [side * r * 0.36, 0, 0])
    hub.rotation.z = Math.PI / 2
  }
  batch(g)
  contactPart(g, `wheel-${x}-${z}`)
  return g
}
export function tracks(parent: THREE.Object3D, width = 1.2, length = 1.6) {
  for (const s of [-1, 1]) {
    block(parent, [0.28, 0.38, length], [(s * width) / 2, 0.2075, 0], rubber)
    for (let z = -length / 2 + 0.22; z < length / 2; z += 0.3)
      contactPart(wheel(parent, s * (width / 2 + 0.14), 0.215, z, 0.18), `roller-${s}-${z.toFixed(2)}`, { mode: 'clear' }).userData.static = true
    for (let z = -length / 2; z < length / 2; z += 0.1)
      for (const y of [0.0175, 0.415]) {
        const tread = block(parent, [0.3, 0.035, 0.045], [(s * width) / 2, y, z], plastic('#424a50'))
        if (y < .1) contactPart(tread, `tread-${s}-${z.toFixed(2)}`)
      }
  }
}
export function playFrame(
  at: [number, number, number],
  radius: number,
  offset: [number, number, number] = [1, 0.85, 1.5],
): Framing {
  const from = at.map((v, i) => v + offset[i] * radius * 2) as [number, number, number]
  return { target: at, wide: from, tall: from, radius, min: radius * 0.5, max: 80 }
}
export function showcase(
  build: (scene: THREE.Scene) => { step(t: number, dt: number): void },
  at: [number, number, number],
  radius: number,
): Preview {
  const scene = previewScene(),
    model = build(scene)
  const camera = new THREE.PerspectiveCamera(38, 1.6, 0.02, 150)
  const f = playFrame(at, radius)
  camera.position.set(...f.wide)
  camera.lookAt(...at)
  return { scene, camera, step: model.step }
}
