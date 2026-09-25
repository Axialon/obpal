/**
 * Box'em core: the flagship Blackboxes trade-off (time, budget, quality, scope) built in code, in the same shape
 * the exported engine models use, so the live trade-off controller drives it unchanged: gem nodes tagged with
 * pillarKey/isNode on fixed axes, bare label anchors further out, unit-height link tubes tagged k1/k2, and a
 * hull with one vertex per pillar at a fixed share of its radius.
 */
import * as THREE from 'three'

const R = 1.5 // authored radius at the canonical defaults
const HULL = 1 / 1.2 // Box'em's hull share (Blackboxes radialProfile, index surface)
const ANCHOR = 1.36

// A regular tetrahedron: time at the apex, the others around the base (budget toward the viewer).
const PILLARS: { key: string; dir: THREE.Vector3; color: string }[] = [
  { key: 'time', dir: new THREE.Vector3(0, 1, 0), color: '#38bdf8' },
  { key: 'cost', dir: new THREE.Vector3(0, -1 / 3, Math.sqrt(8 / 9)), color: '#34d399' },
  { key: 'quality', dir: new THREE.Vector3(-Math.sqrt(2 / 3), -1 / 3, -Math.sqrt(2 / 9)), color: '#a78bfa' },
  { key: 'scope', dir: new THREE.Vector3(Math.sqrt(2 / 3), -1 / 3, -Math.sqrt(2 / 9)), color: '#fbbf24' },
]

export function boxemCore(): THREE.Object3D {
  const root = new THREE.Group()
  root.name = "Box'em core"
  for (const p of PILLARS) {
    const node = new THREE.Group()
    node.name = `node-${p.key}`
    node.userData = { pillarKey: p.key, isNode: true }
    node.position.copy(p.dir).multiplyScalar(R)
    const c = new THREE.Color(p.color)
    const gem = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({ color: c.clone().multiplyScalar(0.55), emissive: c, emissiveIntensity: 0.55, metalness: 0.7, roughness: 0.12, flatShading: true }),
    )
    gem.add(new THREE.LineSegments(new THREE.EdgesGeometry(gem.geometry), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6 })))
    const jewel = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0), new THREE.MeshBasicMaterial({ color: '#ffffff' }))
    const hit = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 8), new THREE.MeshBasicMaterial({ visible: false }))
    hit.userData = { pillarKey: p.key, isHitSphere: true }
    node.add(gem, jewel, hit)
    root.add(node)
    const anchor = new THREE.Object3D()
    anchor.position.copy(p.dir).multiplyScalar(R * ANCHOR)
    root.add(anchor)
  }

  const links = new THREE.Group()
  const tube = new THREE.CylinderGeometry(0.008, 0.008, 1, 8, 1)
  const linkMat = new THREE.MeshBasicMaterial({ color: '#bae6fd', transparent: true, opacity: 0.55 })
  for (let i = 0; i < PILLARS.length; i++) {
    for (let j = i + 1; j < PILLARS.length; j++) {
      const l = new THREE.Mesh(tube, linkMat)
      l.userData = { k1: PILLARS[i].key, k2: PILLARS[j].key }
      links.add(l) // placed by the trade-off controller
    }
  }
  root.add(links)

  // Hull: four faces, twelve vertices, each on its pillar's axis at the hull share.
  const faces = [[0, 1, 3], [0, 2, 1], [0, 3, 2], [1, 2, 3]]
  const v: number[] = []
  for (const f of faces) for (const i of f) v.push(...PILLARS[i].dir.clone().multiplyScalar(R * HULL).toArray())
  const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(v, 3))
  geo.computeVertexNormals()
  const hull = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    color: '#38bdf8', emissive: '#0c4a6e', emissiveIntensity: 0.35, metalness: 0.1, roughness: 0.08,
    transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1,
  }))
  hull.renderOrder = -1
  root.add(hull)
  return root
}
