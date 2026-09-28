/** Lazy, shared Blender meshes. The procedural rig stays usable if a download or decoder fails. */
import * as THREE from 'three'
import * as finishes from './surfaces'
import { rubber } from './index'

export type Prototype = 'drone' | 'so101' | 'rover' | 'arm5' | 'six' | 'scara' | 'delta' | 'desk' | 'helicopter' | 'plane'
  | 'kart' | 'boat' | 'tank' | 'forklift' | 'excavator' | 'slotcars' | 'planetary' | 'submarine' | 'vacuum' | 'film-camera' | 'gimbal' | 'ptz' | 'dog' | 'studio'
const pending = new Map<Prototype, Promise<THREE.Group | null>>()

/** Wait until the procedural scene has painted before loading the decoder or model. */
export function loadPrototype(name: Prototype): Promise<THREE.Group | null> {
  let promise = pending.get(name)
  if (!promise) {
    promise = new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      .then(async () => {
        performance.mark(`obpal:${name}:load`)
        const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import('three/addons/loaders/GLTFLoader.js'),
          import('three/addons/libs/meshopt_decoder.module.js'),
        ])
        await MeshoptDecoder.ready
        const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`/models/${name}.glb`)
        gltf.scene.traverse(o => {
          const m = o as THREE.Mesh
          if (!m.isMesh) return
          m.geometry.userData.simShared = true
          const materials = Array.isArray(m.material) ? m.material : [m.material]
          m.castShadow = materials.some(mat => ['ceramic', 'warmShell', 'carbon', 'darkTitanium', 'gunmetal'].includes(mat.name))
          m.receiveShadow = true
        })
        performance.mark(`obpal:${name}:decoded`)
        performance.measure(`obpal:${name}:load`, `obpal:${name}:load`, `obpal:${name}:decoded`)
        return gltf.scene
      }).catch(() => null)
    pending.set(name, promise)
  }
  return promise.then(scene => scene?.clone(true) ?? null)
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
