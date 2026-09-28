/** Rigid support geometry shared by suspension, landing gear and dimension tests. Units are metres. */
import * as THREE from 'three'

/** Cache vertices in the part's frame. Recreate this after replacing an authored skin. */
export function supportVertices(part: THREE.Object3D): THREE.Vector3[] {
  const points: THREE.Vector3[] = [], unique = new Set<string>()
  const visit = (o: THREE.Object3D, matrix: THREE.Matrix4) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh) {
      const p = mesh.geometry.getAttribute('position')
      for (let i = 0; p && i < p.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(matrix)
        const key = `${v.x.toFixed(6)},${v.y.toFixed(6)},${v.z.toFixed(6)}`
        if (!unique.has(key)) { unique.add(key); points.push(v) }
      }
    }
    for (const child of o.children) { child.updateMatrix(); visit(child, matrix.clone().multiply(child.matrix)) }
  }
  visit(part, new THREE.Matrix4())
  return points
}

/** Vertical translation that seats the actual rigid surface on a height field, including rotation and scale. */
export function supportGap(points: readonly THREE.Vector3[], matrix: THREE.Matrix4, height: (x: number, z: number) => number): number {
  const v = new THREE.Vector3()
  let gap = Infinity
  for (const point of points) { v.copy(point).applyMatrix4(matrix); gap = Math.min(gap, v.y - height(v.x, v.z)) }
  return gap
}

/** Keep the caller's horizontal pose and suspension frame; adjust only world height. */
export function seat(part: THREE.Object3D, points: readonly THREE.Vector3[], height: (x: number, z: number) => number, clearance = 0) {
  part.updateWorldMatrix(true, false)
  const gap = supportGap(points, part.matrixWorld, height)
  if (!Number.isFinite(gap)) return
  const position = part.getWorldPosition(new THREE.Vector3()); position.y += clearance - gap
  part.position.copy(part.parent ? part.parent.worldToLocal(position) : position)
  part.updateWorldMatrix(false, true)
}
