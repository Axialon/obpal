import * as THREE from 'three'

/** Free a model's owned GPU resources once, including resources shared by its parts. */
export function disposeModel(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  const skeletons = new Set<THREE.Skeleton>()
  const texture = (value: unknown) => {
    if (value instanceof THREE.Texture) textures.add(value)
    else if (Array.isArray(value)) value.forEach(texture)
  }
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    const skeleton = (o as THREE.SkinnedMesh).skeleton
    if (skeleton) skeletons.add(skeleton)
    for (const material of Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []) materials.add(material)
  })
  for (const material of materials) {
    Object.values(material).forEach(texture)
    const uniforms = (material as THREE.ShaderMaterial).uniforms
    if (uniforms) for (const uniform of Object.values(uniforms)) texture(uniform.value)
  }
  geometries.forEach((g) => g.dispose())
  textures.forEach((t) => t.dispose())
  materials.forEach((m) => m.dispose())
  skeletons.forEach((s) => s.dispose())
}
