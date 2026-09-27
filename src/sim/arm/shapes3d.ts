/**
 * The meshes for an arm's parts (./look.ts): a box, a cylinder or a joint's ring each, in its group, and the things
 * every arm has (a number plate, its materials). three.js; the kinematics never import this.
 */
import * as THREE from 'three'
import type { Axis, Shape, Stuff } from './look'

/** A joint's ring: dark, glowing in its holder's colour (the sim sets the colour and how bright). */
export const accent = (c = '#5b6472') => new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: c, emissiveIntensity: 0.25, metalness: 0.2, roughness: 0.4 })

/** A kind's materials: the sim's metal and dark (shared by every arm), its own colour, and black. */
export type Stuffs = Record<Stuff, THREE.Material>

const made = new WeakMap<THREE.Material, Map<string, Stuffs>>()
/** A kind's materials, from the sim's shared ones and its own colour: made once, so all its arms share them. */
export function stuffOf(mats: { metal: THREE.Material; dark: THREE.Material }, shell: string): Stuffs {
  let byColour = made.get(mats.metal)
  if (!byColour) made.set(mats.metal, (byColour = new Map()))
  let s = byColour.get(shell)
  if (!s) {
    s = {
      metal: mats.metal,
      dark: mats.dark,
      shell: new THREE.MeshStandardMaterial({ color: shell, metalness: 0.12, roughness: 0.42 }),
      black: new THREE.MeshStandardMaterial({ color: '#15181d', metalness: 0.3, roughness: 0.55 }),
    }
    byColour.set(shell, s)
  }
  return s
}

/** Turn a mesh built along y (three.js's cylinders) or about z (its tori) so its axis is `axis`. */
function turnTo(m: THREE.Object3D, axis: Axis, from: 'y' | 'z') {
  if (axis === from) return
  if (from === 'y') { if (axis === 'x') m.rotation.z = Math.PI / 2; else m.rotation.x = Math.PI / 2 }
  else if (axis === 'y') m.rotation.x = Math.PI / 2
  else m.rotation.y = Math.PI / 2
}

/** A part's mesh, placed in its group. A ring gets a material of its own, so it can wear its holder's colour. */
export function meshOf(s: Shape, stuff: Stuffs): THREE.Mesh {
  let m: THREE.Mesh
  if ('box' in s) m = new THREE.Mesh(new THREE.BoxGeometry(...s.box), stuff[s.stuff])
  else if ('cyl' in s) { m = new THREE.Mesh(new THREE.CylinderGeometry(s.cyl[0], s.cyl[1], s.cyl[2], 48), stuff[s.stuff]); turnTo(m, s.axis, 'y') }
  else { m = new THREE.Mesh(new THREE.TorusGeometry(s.ring[0], s.ring[1], 12, 96), accent()); turnTo(m, s.axis, 'z') }
  m.position.set(...s.at)
  return m
}

/** A number plate for an arm, so people can tell the arms apart (none where there's no page to draw it on). */
export function plateLabel(n: number): THREE.Object3D {
  if (typeof document === 'undefined') return new THREE.Object3D()
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#e6ebf2'
  g.font = '800 88px "Plus Jakarta Sans", Inter, system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(String(n), 64, 70)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  m.scale.setScalar(0.16)
  return m
}

/**
 * Build an arm's parts into its groups (by name), and return its joints' rings in joint order. Parts in groups the
 * model doesn't have are skipped.
 */
export function dress<G extends string>(parts: readonly (readonly [G, Shape])[], groups: Partial<Record<G, THREE.Object3D>>, stuff: Stuffs, joints: number): THREE.Mesh[] {
  const rings: THREE.Mesh[] = []
  for (const [g, s] of parts) {
    const group = groups[g]
    if (!group) continue
    const m = meshOf(s, stuff)
    group.add(m)
    if ('ring' in s) rings[s.joint] = m
  }
  for (let i = 0; i < joints; i++) if (!rings[i]) throw new Error(`no ring for joint ${i}`)
  return rings
}

/** Free what a model made for itself (its geometry, its rings' and plate's materials), keeping the shared materials. */
export function disposeModel(root: THREE.Object3D, keep: readonly THREE.Material[]) {
  root.removeFromParent()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh && !(o as THREE.Sprite).isSprite) return
    if (m.isMesh) m.geometry.dispose()
    const mat = m.material as THREE.Material
    if (!keep.includes(mat)) { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose() }
  })
}
