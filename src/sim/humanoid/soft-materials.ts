/** Original low-gloss soft-cover tiers. Phone finishes retain colour and roughness without sheen or microdetail. */
import * as THREE from 'three'

const linear = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace)
const definitions = {
  cairnCover: [linear(.43, .40, .34), .02, .86],
  rillCover: [linear(.18, .195, .20), .01, .94],
  hushCover: [linear(.035, .043, .045), .01, .94],
  softCore: [linear(.012, .017, .018), .02, .92],
  softGraphite: [linear(.026, .030, .032), .50, .54],
  softGlass: [linear(.010, .021, .024), .18, .30],
} as const
export function softMaterials(phone: boolean) {
  const materials: Record<string, THREE.Material> = {}
  for (const [name, [color, metalness, roughness]] of Object.entries(definitions)) {
    const cover = name.endsWith('Cover')
    const material = phone
      ? new THREE.MeshStandardMaterial({ color, metalness, roughness })
      : new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 0, sheen: cover ? (name === 'cairnCover' ? .06 : .18) : 0, sheenRoughness: .85, sheenColor: color })
    if (cover && !phone) {
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSoftPosition;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSoftPosition = position;')
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSoftPosition;')
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            vec3 weave = vSoftPosition * ${name === 'cairnCover' ? '1600.0' : '1000.0'};
            vec3 fibre = sin(weave);
            float detail = 0.025 / (1.0 + dot(fwidth(weave), vec3(1.0)));
            normal = normalize(normal + detail * (fibre - normal * dot(fibre, normal)));`)
      }
      material.customProgramCacheKey = () => `soft-cover:${name}`
    }
    material.name = name
    material.userData.simShared = true
    materials[name] = material
  }
  const accent = new THREE.MeshStandardMaterial({ color: '#c6ff34', emissive: '#c6ff34', emissiveIntensity: .6, roughness: .65 })
  accent.userData.simShared = true
  materials.softAccent = accent
  return materials
}
export const softDesktop = softMaterials(false)
export const softPhone = softMaterials(true)
