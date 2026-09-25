import * as THREE from 'three'
import { boxemCore } from './boxem-core'
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
  { id: 'cvc', name: 'Club V Crew', blurb: 'Brand insignia in polished metal and crystal' },
  { id: 'engines', name: 'Blackboxes engines', blurb: 'Core matrices from the Blackboxes ecosystem' },
  { id: 'pillars', name: "Box'em pillars", blurb: 'The four planning constraints' },
  { id: 'industries', name: "Box'em industries", blurb: 'Constraint matrices by sector' },
  { id: 'studio', name: 'Studio', blurb: 'References for checking orientation' },
  { id: LOCAL_CATEGORY, name: 'Local', blurb: '3D files from a folder on this device' },
]

const cvc = (id: string, name: string, file: string, icon: string, subtitle: string): CatalogItem =>
  ({ id, name, category: 'cvc', subtitle, src: `/models/cvc/${file}.glb`, icon: `/models/cvc/icons/${icon}.svg` })
const engine = (id: string, name: string, file: string, color: string, subtitle: string): CatalogItem =>
  ({ id, name, category: 'engines', subtitle, src: `/models/blackboxes/${file}.glb`, color, glyph: name[0] })
const box = (id: string, category: string, name: string, file: string, subtitle: string, glyph: string): CatalogItem =>
  ({ id, name, category, subtitle, src: `/models/blackboxes/boxem_${file}.glb`, color: '#38bdf8', glyph })

export const CATALOG: CatalogItem[] = [
  cvc('cvc-insignia', 'CVC insignia', 'CVC_insignia', 'CVC_flat', 'Neutral metal with tri-colour cuts'),
  cvc('cvc-wordmark', 'CVC wordmark', 'CVC_wordmark', 'CVC_flat_wordmark', 'Insignia with acronym'),
  cvc('mmc-insignia', 'MMC insignia', 'MMC_insignia', 'MMC_flat', 'Cyan moon and cat'),
  cvc('mmc-wordmark', 'MMC wordmark', 'MMC_wordmark', 'MMC_flat_wordmark', 'Insignia with acronym'),
  cvc('k9c-insignia', 'K9C insignia', 'K9C_insignia', 'K9C_flat', 'Amber sun and dog'),
  cvc('k9c-wordmark', 'K9C wordmark', 'K9C_wordmark', 'K9C_flat_wordmark', 'Insignia with acronym'),
  cvc('cc-insignia', 'CC insignia', 'CC_insignia', 'CC_flat', 'Amethyst crystal'),
  cvc('cc-wordmark', 'CC wordmark', 'CC_wordmark', 'CC_flat_wordmark', 'Insignia with acronym'),
  cvc('factions', 'Faction markers', 'Faction_Area_Markers_Demo', 'CVC_flat', 'All four markers, hovering'),

  { id: 'boxem', name: "Box'em core", category: 'engines', subtitle: 'Time, budget, quality and scope', color: '#38bdf8', glyph: 'B', make: boxemCore },
  engine('orbitem', "Orbit'em core", 'orbit_em_core_matrix', '#22d3ee', 'Cloud architecture and cost'),
  engine('pulseem', "Pulse'em core", 'pulse_em_core_matrix', '#fb7185', 'Training, recovery and fuelling'),
  engine('capem', "Cap'em core", 'cap_em_core_matrix', '#fcd34d', 'Startup ownership and runway'),
  engine('synthem', "Synth'em core", 'synth_em_core_matrix', '#f0abfc', 'Sound design'),
  engine('balancem', "Balanc'em core", 'balanc_em_core_matrix', '#6ee7b7', 'Combat and resource tuning'),

  box('cost', 'pillars', 'Cost', 'coin_gem', 'Coin gem', '$'),
  box('quality', 'pillars', 'Quality', 'diamond_core', 'Diamond core', '◆'),
  box('scope', 'pillars', 'Scope', 'cube_matrix', 'Cube matrix', '▣'),
  box('time', 'pillars', 'Time', 'clock_crystal', 'Clock crystal', '◷'),

  box('aerospace', 'industries', 'Aerospace', 'aerospace_flight_deck', 'Flight deck', 'A'),
  box('architecture', 'industries', 'Architecture', 'architectural_bim_matrix', 'BIM matrix', 'B'),
  box('biomedical', 'industries', 'Biomedical', 'biomedical_device_matrix', 'Device matrix', 'M'),
  box('vfx', 'industries', 'Cinematic VFX', 'cinematic_vfx_pipeline', 'Pipeline', 'V'),
  box('software', 'industries', 'Software', 'software_architecture_core', 'Architecture core', 'S'),

  { id: 'cube', name: 'Orientation cube', category: 'studio', subtitle: 'Front ring, top dot, right bar', color: '#a78bfa', glyph: '▢', make: orientationCube },
  { id: 'knot', name: 'Knot', category: 'studio', subtitle: 'Torus knot, iridescent', color: '#a78bfa', glyph: '∞', make: knot },
  { id: 'gem', name: 'Gem', category: 'studio', subtitle: 'Faceted icosahedron', color: '#22d3ee', glyph: '◇', make: gem },
]

export const DEFAULT_ITEM = 'cvc-insignia'

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
