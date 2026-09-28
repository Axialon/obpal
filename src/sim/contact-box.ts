/** Separating-axis penetration for rigid collision envelopes, in world metres. */
import * as THREE from 'three'
export interface ContactBox { centre: THREE.Vector3; axes: THREE.Vector3[]; half: number[] }

export function geometryBox(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): ContactBox {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  const box = geometry.boundingBox!, half = box.getSize(new THREE.Vector3()).multiplyScalar(.5).toArray()
  const axes = [0, 1, 2].map(i => new THREE.Vector3().setFromMatrixColumn(matrix, i))
  axes.forEach((axis, i) => { half[i] *= axis.length(); axis.normalize() })
  return { centre: box.getCenter(new THREE.Vector3()).applyMatrix4(matrix), half, axes }
}

/** Zero for separated or touching boxes. Includes edge-edge axes, which world AABBs miss. */
export function boxPenetration(a: ContactBox, b: ContactBox) {
  const delta = b.centre.clone().sub(a.centre), axes = [...a.axes, ...b.axes]
  for (const x of a.axes) for (const y of b.axes) { const cross = x.clone().cross(y); if (cross.lengthSq() > 1e-12) axes.push(cross.normalize()) }
  let depth = Infinity
  for (const axis of axes) {
    const extent = (box: ContactBox) => box.axes.reduce((sum, v, i) => sum + box.half[i] * Math.abs(v.dot(axis)), 0)
    const overlap = extent(a) + extent(b) - Math.abs(delta.dot(axis))
    if (overlap <= 0) return 0
    depth = Math.min(depth, overlap)
  }
  return depth
}
