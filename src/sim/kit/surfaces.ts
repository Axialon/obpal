/** The prototype finishes and curved plates. Opt in per model; the rest of the sim family keeps its materials. */
import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

export const ceramic = new THREE.MeshPhysicalMaterial({ color: '#e9e8e0', metalness: 0.12, roughness: 0.26, clearcoat: 0.8, clearcoatRoughness: 0.19 })
export const warmShell = new THREE.MeshPhysicalMaterial({ color: '#a9aaa3', metalness: 0.22, roughness: 0.3, clearcoat: 0.65 })
export const titanium = new THREE.MeshStandardMaterial({ color: '#8a9499', metalness: 0.94, roughness: 0.31 })
export const darkTitanium = new THREE.MeshStandardMaterial({ color: '#68767d', metalness: 0.88, roughness: 0.21 })
export const gunmetal = new THREE.MeshStandardMaterial({ color: '#3d484f', metalness: 0.90, roughness: 0.24 })
export const polished = new THREE.MeshStandardMaterial({ color: '#c2cbcd', metalness: 0.97, roughness: 0.17 })
export const carbon = new THREE.MeshStandardMaterial({ color: '#202729', metalness: 0.32, roughness: 0.48 })
export const optic = new THREE.MeshPhysicalMaterial({ color: '#17272b', metalness: 0.6, roughness: 0.12, clearcoat: 1 })
export const lime = new THREE.MeshStandardMaterial({ color: '#a4ce35', emissive: '#c6ff34', emissiveIntensity: 0.7, roughness: 0.3 })
for (const m of [ceramic, warmShell, titanium, darkTitanium, gunmetal, polished, carbon, optic, lime]) m.userData.simShared = true

/** A crowned plate, tapering toward both ends of its local y axis, inside the requested envelope. */
export function shell(w: number, h: number, d: number, material: THREE.Material = ceramic, taper = 0.22) {
  const g = new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h, d) * 0.32)
  const p = g.attributes.position, normals = g.attributes.normal, normal = new THREE.Vector3()
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i) / (h / 2)
    const k = 1 - taper * y * y, l = 1 - taper * .5 * y * y
    // Transform the rounded box's smooth normals with the deformation's inverse transpose.
    const nx = normals.getX(i) / k, nz = normals.getZ(i) / l
    normal.set(nx, normals.getY(i) + x * 4 * taper * y / h * nx + z * 2 * taper * y / h * nz, nz).normalize()
    normals.setXYZ(i, normal.x, normal.y, normal.z)
    p.setXYZ(i, x * k, p.getY(i), z * l)
  }
  const mesh = new THREE.Mesh(g, material)
  mesh.castShadow = mesh.receiveShadow = true
  return mesh
}

/** A turned, hollow turbine casing: broad machined walls with rounded lips, open through the centre. */
export function duct(radius: number, height: number) {
  const section = [[.87, -.5], [.96, -.5], [1, -.38], [1, .28], [.97, .48], [.91, .5], [.87, .38], [.87, -.5]]
  return new THREE.Mesh(new THREE.LatheGeometry(section.map(([r, y]) => new THREE.Vector2(r * radius, y * height)), 48), titanium)
}

/** A fine ring around a bearing; its axis is z. */
export function ring(radius: number, tube: number, material: THREE.Material = polished) {
  return new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 40), material)
}
