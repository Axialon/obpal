/**
 * The meshes for an arm's parts (./look.ts): a box, a cylinder or a joint's ring each, in its group, and the things
 * every arm has (a number plate, its materials). three.js; the kinematics never import this.
 */
import * as THREE from 'three'
import type { Axis, Shape, Stuff } from './look'
import { batch, bolt, box, cable, cylinder, metal, plastic, rubber } from '../kit'
import { carbon, gunmetal, titanium } from '../kit/surfaces'
import { service } from '../kit/precision'

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
      metal: titanium,
      dark: carbon,
      shell: gunmetal,
      black: rubber,
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
  if ('box' in s) m = box(...s.box, stuff[s.stuff])
  else if ('cyl' in s) { m = new THREE.Mesh(new THREE.CylinderGeometry(s.cyl[0], s.cyl[1], s.cyl[2], 32), stuff[s.stuff]); turnTo(m, s.axis, 'y') }
  else { m = new THREE.Mesh(new THREE.TorusGeometry(s.ring[0], s.ring[1] * 0.55, 8, 48), accent()); turnTo(m, s.axis, 'z') }
  m.castShadow = !('ring' in s)
  m.receiveShadow = true
  m.position.set(...s.at)
  return m
}

/** Recessed fasteners, service covers and servo horns stay inside the collision envelope. */
export function machining(parent: THREE.Object3D, s: Shape) {
  const g = new THREE.Group()
  g.userData.static = true
  g.position.set(...s.at)
  if ('ring' in s) {
    const r = s.ring[0]
    const horn = cylinder(r * 0.73, s.ring[1] * 0.8, metal, 24)
    horn.rotation.x = Math.PI / 2
    g.add(horn)
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2
      const b = bolt(r * 0.085); b.rotation.x = Math.PI / 2
      b.position.set(Math.cos(a) * r * 0.52, Math.sin(a) * r * 0.52, s.ring[1] * 0.5)
      g.add(b)
    }
    turnTo(g, s.axis, 'z')
  } else if ('box' in s) {
    const [w, h, d] = s.box
    if (Math.min(w, h, d) < 0.035) return
    const face = service(w * 0.68, h * 0.76)
    face.position.z = d / 2 - 0.002
    g.add(face)
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      const b = bolt(Math.min(w, h) * 0.055); b.rotation.x = Math.PI / 2
      b.position.set(x * w * 0.38, y * h * 0.38, d / 2 - 0.001); g.add(b)
    }
    if (h > w * 1.8) {
      g.add(cable([[w * 0.35, -h * 0.4, d * 0.37], [w * 0.36, 0, d * 0.43], [w * 0.35, h * 0.4, d * 0.37]], Math.min(w, d) * 0.065))
    }
  } else {
    if (s.cyl[0] < 0.06) return
    const r = Math.min(s.cyl[0], s.cyl[1]), h = s.cyl[2]
    const cap = cylinder(r * 0.8, 0.004, plastic('#39434a'), 24)
    cap.position.y = h / 2 - 0.002
    g.add(cap)
    for (let i = 0; i < 4; i++) {
      const a = (i + 0.5) * Math.PI / 2, b = bolt(r * 0.065)
      b.position.set(Math.cos(a) * r * 0.64, h / 2 - 0.002, Math.sin(a) * r * 0.64); g.add(b)
    }
    turnTo(g, s.axis, 'y')
  }
  parent.add(g)
  // Both sides are finished: the opposing arms expose opposite faces to the camera.
  if ('box' in s || ('ring' in s && s.axis === 'z')) {
    const back = g.clone(true)
    back.rotation.y = Math.PI
    if ('ring' in s) back.position.z = -s.at[2]
    parent.add(back)
  }
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
  for (const [name, group] of Object.entries(groups)) (group as THREE.Object3D).name = name
  const rings: THREE.Mesh[] = []
  for (const [g, s] of parts) {
    const group = groups[g]
    if (!group) continue
    const m = meshOf(s, stuff)
    group.add(m)
    machining(group, s)
    if ('ring' in s) rings[s.joint] = m
  }
  for (let i = 0; i < joints; i++) if (!rings[i]) throw new Error(`no ring for joint ${i}`)
  for (const group of Object.values(groups) as THREE.Object3D[]) batch(group, rings)
  return rings
}

/** Free what a model made for itself (its geometry, its rings' and plate's materials), keeping the shared materials. */
export function disposeModel(root: THREE.Object3D, keep: readonly THREE.Material[]) {
  root.removeFromParent()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh && !(o as THREE.Sprite).isSprite) return
    if (m.isMesh && !m.geometry.userData.simShared) m.geometry.dispose()
    const mat = m.material as THREE.Material
    if (!keep.includes(mat) && !mat.userData.simShared) { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose() }
  })
}
