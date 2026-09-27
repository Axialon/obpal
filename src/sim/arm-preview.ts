/**
 * A kind of robot arm's card on the sim catalogue: its own pick and place (./arm/preview.ts) on a table, side on, its
 * rings lit, framed for its size.
 */
import * as THREE from 'three'
import { floorMaterial } from './kit'
import type { ArmKindInfo } from './arm/kinds'
import { previewScene, type Preview } from './devices/view'

export async function armPreview(kind: ArmKindInfo): Promise<Preview> {
  const arm = await kind.preview()
  const scene = previewScene()
  // Side on, reaching left across the card; its joints' rings glow in the site's lime.
  arm.object.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.isMesh && m.geometry.type === 'TorusGeometry') (m.material as THREE.MeshStandardMaterial).emissive.set('#c6ff34')
  })
  scene.add(arm.object)
  const { height: h, reach: r } = arm.size
  // A table under the arm and both of its spots.
  const table = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.72 + 0.25, r * 0.72 + 0.25, 0.04, 96), floorMaterial())
  table.position.set(-r * 0.45, -0.02, 0)
  scene.add(table)
  // From in front, a little to the right and above: the arm, its reach and its spots in the card, however tall it is.
  const camera = new THREE.PerspectiveCamera(36, 16 / 10, 0.05, 60)
  const look = new THREE.Vector3(-r * 0.4, h * 0.45, 0)
  camera.position.copy(look).addScaledVector(new THREE.Vector3(0.3, 0.34, 1).normalize(), Math.max(h * 1.05, r * 1.5) * 2)
  camera.lookAt(look)
  return { scene, camera, step: (t) => arm.step(t) }
}
