/** Loaded only by the explicit browser-test hook. Mesh ray parity checks solids, not the empty space in merged bounds. */
import { DoubleSide, Mesh, Object3D, Raycaster, Vector3, type Camera, type Material } from 'three'

export function inspectView(scene: Object3D, camera: Camera, omit: Object3D[]) {
  scene.updateMatrixWorld(true)
  const p = camera.getWorldPosition(new Vector3()), q = camera.getWorldQuaternion(camera.quaternion.clone())
  const inside: string[] = [], directions = [new Vector3(1, 0.13, 0.21).normalize(), new Vector3(0.17, 1, 0.31).normalize(), new Vector3(0.23, 0.19, 1).normalize()]
  let clearance = Infinity
  const ray = new Raycaster(), size = new Vector3()
  scene.traverse(o => {
    if (!(o instanceof Mesh)) return
    for (let parent: Object3D | null = o; parent; parent = parent.parent) if (!parent.visible || omit.includes(parent)) return
    const materials: Material[] = Array.isArray(o.material) ? o.material : [o.material]
    if (materials.every(m => m.transparent && m.opacity < 0.98)) return
    o.geometry.computeBoundingBox()
    const box = o.geometry.boundingBox
    if (!box || Math.min(...box.getSize(size).toArray()) < 0.002) return
    const sides = materials.map(m => m.side)
    materials.forEach(m => { m.side = DoubleSide })
    try {
      const counts = directions.map(direction => {
        ray.set(p, direction)
        const hits = ray.intersectObject(o, false).map(h => h.distance).filter((d, n, all) => !n || d - all[n - 1] > 0.00001)
        clearance = Math.min(clearance, hits[0] ?? Infinity)
        return hits.length
      })
      if (box.containsPoint(o.worldToLocal(p.clone())) && counts.every(n => n % 2 === 1)) inside.push(o.name || o.geometry.type)
    } finally { materials.forEach((m, n) => { m.side = sides[n] }) }
  })
  return { inside, clearance, rightY: new Vector3(1, 0, 0).applyQuaternion(q).y, position: p.toArray() }
}
