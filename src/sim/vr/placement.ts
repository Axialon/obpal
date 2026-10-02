import { Box3, type BufferGeometry, type Matrix4, type Mesh, type Sphere } from 'three'

const parts = new WeakMap<BufferGeometry, readonly Box3[]>()
/** A render batch can enclose empty space. Retain each solid's bounds rather than filling the whole batch. */
export function preservePlacementBounds(geometry: BufferGeometry, meshes: readonly Mesh[]) {
  const bounds = meshes.flatMap(mesh => {
    mesh.updateMatrix(); if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
    return (parts.get(mesh.geometry) ?? [mesh.geometry.boundingBox!]).map(box => box.clone().applyMatrix4(mesh.matrix))
  })
  parts.set(geometry, bounds)
}
export function placementHit(geometry: BufferGeometry, matrix: Matrix4, sphere: Sphere) {
  if (!geometry.boundingBox) geometry.computeBoundingBox()
  return (parts.get(geometry) ?? [geometry.boundingBox!]).some(part => {
    const box = part.clone().applyMatrix4(matrix)
    return box.max.y - box.min.y > .04 && box.intersectsSphere(sphere)
  })
}
