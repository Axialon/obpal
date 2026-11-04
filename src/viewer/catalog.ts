import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

export interface Category {
  id: string
  name: string
  blurb: string
}

export interface CatalogItem {
  id: string
  name: string
  category: string
  subtitle: string
  /** GLB path, or a procedural builder. */
  src?: string
  make?: () => THREE.Object3D
  /** Local folder items (./local-folder.ts): read and parse the file on each pick, uncached. */
  load?: () => Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }>
  /** Thumbnail image, or a coloured glyph when no image exists. */
  icon?: string
  color?: string
  glyph?: string
}

/** Local folder catalogue: filled from a folder the user connects (./local-folder.ts), empty until then. */
export const LOCAL_CATEGORY = 'local'

export const CATEGORIES: Category[] = [
  { id: 'studio', name: 'Studio', blurb: 'References for checking orientation' },
  { id: LOCAL_CATEGORY, name: 'Local', blurb: '3D files from a folder on this device' },
]

/** Visual identity per collection, shared with the rail and its public catalogue projection. */
export const CATEGORY_ART: Record<string, { color: string; icon?: string; image?: string }> = {
  studio: { color: '#a78bfa', icon: 'cube' },
  [LOCAL_CATEGORY]: { color: '#93c5fd', icon: 'folder' },
}


export const CATALOG: CatalogItem[] = [
  { id: 'cube', name: 'Orientation cube', category: 'studio', subtitle: 'Front ring, top dot, right bar', color: '#a78bfa', glyph: '▢', make: orientationCube },
  { id: 'knot', name: 'Knot', category: 'studio', subtitle: 'Torus knot, iridescent', color: '#a78bfa', glyph: '∞', make: knot },
  { id: 'gem', name: 'Gem', category: 'studio', subtitle: 'Faceted icosahedron', color: '#22d3ee', glyph: '◇', make: gem },
]

export const DEFAULT_ITEM = "cube"

/** Replace one collection's items in place: CATALOG is shared by the viewer, its keyboard stepping and the phone's picker. Used by the Local folder. */
export function setCategoryItems(category: string, items: CatalogItem[]) {
  for (let i = CATALOG.length - 1; i >= 0; i--) if (CATALOG[i].category === category) CATALOG.splice(i, 1)
  CATALOG.push(...items)
}

function faceMark(color: string, pos: THREE.Vector3, normal: THREE.Vector3, shape: 'ring' | 'dot' | 'bar') {
  const geo = shape === 'ring' ? new THREE.RingGeometry(0.2, 0.3, 48) : shape === 'dot' ? new THREE.CircleGeometry(0.16, 40) : new THREE.PlaneGeometry(0.6, 0.12)
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, toneMapped: false }))
  m.position.copy(pos)
  m.lookAt(pos.clone().add(normal))
  return m
}

function orientationCube() {
  const g = new THREE.Group()
  g.add(new THREE.Mesh(new RoundedBoxGeometry(1.8, 1.8, 1.8, 6, 0.2), new THREE.MeshPhysicalMaterial({ color: '#111a2b', metalness: 0.55, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.25 })))
  g.add(faceMark('#a78bfa', new THREE.Vector3(0, 0, 0.905), new THREE.Vector3(0, 0, 1), 'ring'))
  g.add(faceMark('#22d3ee', new THREE.Vector3(0, 0.905, 0), new THREE.Vector3(0, 1, 0), 'dot'))
  g.add(faceMark('#fcd34d', new THREE.Vector3(0.905, 0, 0), new THREE.Vector3(1, 0, 0), 'bar'))
  return g
}

function knot() {
  return new THREE.Mesh(new THREE.TorusKnotGeometry(0.78, 0.27, 240, 36), new THREE.MeshPhysicalMaterial({ color: '#a78bfa', metalness: 0.25, roughness: 0.22, clearcoat: 0.6, iridescence: 0.5 }))
}

function gem() {
  return new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 0), new THREE.MeshStandardMaterial({ color: '#22d3ee', metalness: 0.15, roughness: 0.3, flatShading: true }))
}
