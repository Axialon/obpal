/** Share draws between copies of the same articulated model, while keeping their pivots independent. */
import * as THREE from 'three'

export function instanceCopies(scene: THREE.Scene) {
  const groups: { mesh: THREE.InstancedMesh; sources: THREE.Mesh[]; previous: THREE.Matrix4[] }[] = []
  let roots: readonly THREE.Object3D[] = []
  const clear = () => {
    for (const g of groups) { for (const s of g.sources) s.visible = true; g.mesh.removeFromParent(); g.mesh.dispose() }
    groups.length = 0
  }
  return {
    /** All roots must come from the same builder. Materials that vary per joint stay separate. */
    set(copies: readonly THREE.Object3D[]) {
      clear(); roots = copies
      const buckets = new Map<string, THREE.Mesh[]>()
      const visit = (o: THREE.Object3D, path: string) => {
        const m = o as THREE.Mesh
        if (m.isMesh && !m.userData.pickable && !Array.isArray(m.material) && !m.material.transparent && m.visible) {
          const key = `${path}:${m.material.uuid}`
          const list = buckets.get(key) ?? []; list.push(m); buckets.set(key, list)
        }
        o.children.forEach((c, i) => visit(c, `${path}/${i}`))
      }
      copies.forEach(root => visit(root, ''))
      for (const sources of buckets.values()) {
        if (sources.length < 2) continue
        const first = sources[0]
        const mesh = new THREE.InstancedMesh(first.geometry, first.material, sources.length)
        mesh.castShadow = first.castShadow; mesh.receiveShadow = first.receiveShadow
        mesh.frustumCulled = false
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        sources.forEach(s => { s.visible = false })
        scene.add(mesh)
        groups.push({ mesh, sources, previous: sources.map(() => new THREE.Matrix4().makeScale(0, 0, 0)) })
      }
      this.update()
    },
    update() {
      roots.forEach(r => r.updateMatrixWorld(true))
      for (const g of groups) g.sources.forEach((source, i) => {
        if (source.matrixWorld.equals(g.previous[i])) return
        g.previous[i].copy(source.matrixWorld)
        g.mesh.setMatrixAt(i, source.matrixWorld)
        g.mesh.instanceMatrix.needsUpdate = true
      })
    },
    clear,
  }
}
