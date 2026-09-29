/** Lazy, shared Blender meshes. The procedural rig stays usable if a download or decoder fails. */
import * as THREE from 'three'
import * as finishes from './surfaces'
import { rubber } from './index'
import { downloadPrototype, type Prototype } from './models'

export type { Prototype }

/**
 * The mesh for this caller: a clone of the shared scene, whose download and decoder began the moment the page first
 * asked for the mesh (./models.ts; the page's early script asks before anything is drawn). Null where it could not be had.
 */
export function loadPrototype(name: Prototype): Promise<THREE.Group | null> {
  return downloadPrototype(name).then(scene => scene?.clone(true) ?? null)
}

/** Map named export materials to the live kit and the device's independently animated accents. */
export function finishPrototype(scene: THREE.Group, dynamic: Record<string, THREE.Material> = {}) {
  scene.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    const map = (material: THREE.Material) => {
      const shared = finishes[material.name as keyof typeof finishes]
      const replacement = dynamic[material.name] ?? (material.name === 'rubber' ? rubber : shared instanceof THREE.Material ? shared : null)
      if (!replacement) throw new Error(`Unknown prototype material: ${material.name}`)
      return replacement
    }
    m.material = Array.isArray(m.material) ? m.material.map(map) : map(m.material)
  })
}

/** Validate the complete rig before changing a live model. */
export function prototypeNodes<T extends string>(scene: THREE.Group, names: readonly T[]): Record<T, THREE.Object3D> {
  return Object.fromEntries(names.map(name => {
    const node = scene.getObjectByName(name)
    if (!node) throw new Error(`Missing prototype pivot: ${name}`)
    return [name, node]
  })) as Record<T, THREE.Object3D>
}

/** Release only the replaced procedural geometry. Its live materials are reused by the Blender meshes. */
export function retirePrototype(root: THREE.Object3D) {
  root.removeFromParent()
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh && !m.geometry.userData.simShared) m.geometry.dispose()
  })
}
