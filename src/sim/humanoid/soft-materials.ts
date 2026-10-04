/** Original low-gloss soft-cover tiers. Phone finishes retain colour and roughness without sheen or microdetail. */
import * as THREE from 'three'

const linear = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace)
// Linear albedo, calibrated under the live ACES stage toward each concept's
// torso tone (bone, ash and neutral charcoal); humanoids_soft.py uses the same values.
const definitions = {
  cairnCover: [linear(.213, .168, .146), .02, .86],
  rillCover: [linear(.054, .052, .056), .01, .94],
  hushCover: [linear(.024, .023, .024), .01, .94],
  rillPanel: [linear(.020, .021, .024), .02, .92],
  rillHelmet: [linear(.09, .087, .09), .05, .55],
  softCore: [linear(.012, .017, .018), .02, .92],
  softGraphite: [linear(.026, .030, .032), .50, .54],
  softGlass: [linear(.010, .021, .024), .18, .30],
  // The v3 knit suits: one skinned mesh whose vertex colours carry the base tone and
  // its panels or inserts (humanoid_skin.py TONES), so the material itself is white.
  cairnSuit: [linear(1, 1, 1), .02, .86],
  rillSuit: [linear(1, 1, 1), .01, .94],
  hushSuit: [linear(1, 1, 1), .01, .94],
} as const
/** Knit covers carry courses along each part's own long axis; elastomer keeps a fine grain only. */
const knit = new Set(['rillCover', 'hushCover', 'rillPanel', 'rillSuit', 'hushSuit'])
export function softMaterials(phone: boolean) {
  const materials: Record<string, THREE.Material> = {}
  for (const [name, [color, metalness, roughness]] of Object.entries(definitions)) {
    const suit = name.endsWith('Suit')
    const textile = name.endsWith('Cover') || name === 'rillPanel' || suit
    // A suit's sheen keeps its cover's tone; its albedo comes from the vertex colours.
    const sheenColor = suit ? definitions[name.replace('Suit', 'Cover') as 'rillCover'][0] : color
    const material = phone
      ? new THREE.MeshStandardMaterial({ color, metalness, roughness, vertexColors: suit })
      : new THREE.MeshPhysicalMaterial({ color, metalness, roughness, clearcoat: 0, sheen: textile ? (name.startsWith('cairn') ? .06 : .18) : 0, sheenRoughness: .85, sheenColor, vertexColors: suit })
    if (textile && !phone) {
      const ribbed = knit.has(name)
      // The weave sits on the rest-pose surface; on a suit its courses follow the skinned limb.
      const along = suit ? '\n#ifdef USE_SKINNING\nvSoftAlong = normalize(normalMatrix * (mat3(skinMatrix) * vec3(0.0, 1.0, 0.0)));\n#endif' : ''
      material.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSoftPosition;\nvarying vec3 vSoftAlong;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>\nvSoftPosition = position;\nvSoftAlong = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));${along}`)
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSoftPosition;\nvarying vec3 vSoftAlong;')
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            vec3 weave = vSoftPosition * ${name.startsWith('cairn') ? '1600.0' : '1000.0'};
            vec3 fibre = sin(weave);
            float detail = 0.025 / (1.0 + dot(fwidth(weave), vec3(1.0)));
            normal = normalize(normal + detail * (fibre - normal * dot(fibre, normal)));
            ${ribbed ? `float course = vSoftPosition.y * 1150.0;
            float rib = 0.09 * cos(course) / (1.0 + 4.0 * fwidth(course));
            normal = normalize(normal + rib * (vSoftAlong - normal * dot(vSoftAlong, normal)));` : ''}`)
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
