/** Planar plates, recessed access panels and flush decks in the confirmed family language. */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { carbon, ceramic, darkTitanium, gunmetal } from './surfaces'

export const DETAIL = .0005, HOUSING = .002, SEAM = .0015

/** The chamfer remains inside the envelope; broad faces have independent flat normals. */
export function plateGeometry(w: number, h: number, d: number, edge = HOUSING, taper = 0) {
  const e = Math.min(edge, w / 8, h / 8, d / 3)
  const x = w / 2 - e, y = h / 2 - e, c = Math.min(Math.min(w, h) * .12, .015)
  const shape = new THREE.Shape()
  const points = [[-x+c,-y],[x-c,-y],[x,-y+c],[x,y-c],[x-c,y],[-x+c,y],[-x,y-c],[-x,-y+c]]
  points.forEach(([px, py], i) => { const xx = px * (1 - taper * (py / h + .5)); if (i) shape.lineTo(xx, py); else shape.moveTo(xx, py) })
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: d - 2*e, steps: 1, bevelEnabled: true, bevelThickness: e, bevelSize: e, bevelSegments: 1, curveSegments: 1 })
  geometry.translate(0, 0, -d/2 + e)
  return geometry
}

export function housing(w: number, h: number, d: number, material: THREE.Material = gunmetal, taper = 0) {
  const mesh = new THREE.Mesh(plateGeometry(w, h, d, HOUSING, taper), material)
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

/** A metal rim around a ceramic insert, backed by the recessed Carbon tongue. */
export function service(w: number, h: number) {
  const group = new THREE.Group(); group.userData.static = true
  const rim = Math.min(.004, w / 10, h / 10)
  const backing = new THREE.Mesh(plateGeometry(w, h, .004, DETAIL), carbon)
  backing.position.z = -.004; group.add(backing)
  const shape = new THREE.Shape(), x = w/2, y = h/2
  shape.moveTo(-x,-y); shape.lineTo(x,-y); shape.lineTo(x,y); shape.lineTo(-x,y); shape.closePath()
  const hole = new THREE.Path(), ix = x-rim, iy = y-rim
  hole.moveTo(-ix,-iy); hole.lineTo(-ix,iy); hole.lineTo(ix,iy); hole.lineTo(ix,-iy); hole.closePath(); shape.holes.push(hole)
  const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: .002, bevelEnabled: true, bevelThickness: DETAIL, bevelSize: DETAIL, bevelSegments: 1, steps: 1 }), darkTitanium)
  frame.position.z = -.0025; group.add(frame)
  const insert = new THREE.Mesh(plateGeometry(w-2*(rim+SEAM), h-2*(rim+SEAM), .002, DETAIL), ceramic)
  insert.position.z = -.001; group.add(insert)
  return group
}

/** One merged draw for the tiles, one for the substrate; the requested top is unchanged. */
export function tiledDeck(w: number, d: number, top = 0, module = 1) {
  const group = new THREE.Group(); group.name = 'modular-deck'; group.userData.static = true
  const base = housing(w, .025, d, carbon); base.position.y = top-.0185; group.add(base)
  const cols = Math.max(1, Math.ceil(w/module)), rows = Math.max(1, Math.ceil(d/module))
  const parts: THREE.BufferGeometry[] = []
  for (let x = 0; x < cols; x++) for (let z = 0; z < rows; z++) {
    const g = plateGeometry(w/cols-SEAM, d/rows-SEAM, .008)
    g.rotateX(-Math.PI/2); g.translate(-w/2+(x+.5)*w/cols, top-.004, -d/2+(z+.5)*d/rows); parts.push(g)
  }
  const geometry = mergeGeometries(parts); parts.forEach(g => g.dispose())
  const tiles = new THREE.Mesh(geometry, deckFinish); tiles.receiveShadow = true; group.add(tiles)
  return group
}

const deckFinish = gunmetal.clone(); deckFinish.roughness = .34; deckFinish.userData.simShared = true

/** A camera frame with +Z along the optical axis, attached to its actual moving part. */
export function pov(parent: THREE.Object3D, at: readonly [number, number, number], forward: readonly [number, number, number] = [0, 0, -1], up: readonly [number, number, number] = [0, 1, 0]) {
  const anchor = new THREE.Object3D(); anchor.name = 'pov'; anchor.position.set(...at)
  const direction = new THREE.Vector3(...forward).normalize(), vertical = new THREE.Vector3(...up).normalize()
  // A forward vector alone leaves roll undefined. Keep pitched views upright,
  // with a deterministic screen top for tools looking straight up or down.
  if (Math.abs(direction.dot(vertical)) > .999) vertical.set(0, 0, direction.y < 0 ? 1 : -1)
  anchor.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(direction, new THREE.Vector3(), vertical))
  parent.add(anchor)
  return anchor
}
