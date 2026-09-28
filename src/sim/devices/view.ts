/**
 * What every device's look shares (three.js): the view's shape, the family's materials (the arms' pale metal and dark
 * trim), a light that wears its holder's colour, a soft shadow under each unit, number plates, and the preview the
 * catalogue shows on a device's card.
 */
import * as THREE from 'three'
import * as kit from '../kit'
export { box } from '../kit'
import type { Theme } from '../../ui/themes'
import type { DeviceLogic } from './types'
import type { Framing, Stage } from './stage'
import type { SimScene } from '../scene'

export interface DeviceView {
  /** Optional live service (audio, for example), attached once the shared scene is ready. */
  connect?(sim: SimScene): void
  framing: Framing
  /** The whole playground, one tap from the closer play view. */
  overview?: Framing
  /** Follow the unit being driven without changing the visitor's orbit or zoom. */
  follow?(unit: number): THREE.Vector3
  /** A close look at one unit, without changing what any phone controls. */
  inspect?(): Framing
  /** The height of the floor a pointing phone drives on (DeviceInput.spot), for a device that has one. */
  pickY?: number
  /** Draw a frame: each unit's holder's colour (null: nobody holds it). */
  update(colors: readonly (string | null)[], t: number, dt: number): void
  /** Where a unit is, for pointing at it (the lamps: point at one and press A to take it). */
  anchor?(unit: number): THREE.Vector3
  /**
   * What aiming straight at the screen points at, for a unit whose floor is small (a claw's pit): its holder's pointer
   * moves from there rather than from the middle of the screen.
   */
  pointFrom?(unit: number): THREE.Vector3
  /** Drawn over the stage once it's rendered (a camera's picture-in-picture). */
  afterRender?(): void
  /** The visitor picked another surface (light or dark). */
  setTheme?(t: Theme): void
}

/** A device's card on the catalogue: a small scene of its own that plays by itself. */
export interface Preview {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  step(t: number, dt: number): void
}

export interface ViewModule {
  createView(stage: Stage, logic: DeviceLogic): DeviceView
  preview(): Preview
}

/** Where nobody holds a unit, its lights rest in this grey. */
export const IDLE = '#5b6472'

export const mats = {
  body: () => kit.plastic(),
  metal: () => kit.metal,
  dark: () => kit.plastic(kit.palette.carbon),
  rubber: () => kit.rubber,
  glass: () => kit.glass,
  /** A light that wears a colour: dim grey at rest, bright in its holder's colour. */
  glow: (c = IDLE) => new THREE.MeshStandardMaterial({ color: '#0b0f14', emissive: c, emissiveIntensity: 0.9, metalness: 0.2, roughness: 0.4 }),
}

/** Set a glow material to its holder's colour (brighter), or back to rest. */
export function wear(m: THREE.MeshStandardMaterial, color: string | null, rest = 0.6, lit = 2.2) {
  m.emissive.set(color ?? IDLE)
  m.emissiveIntensity = color ? lit : rest
}

let shadowTex: THREE.Texture | null = null
/** A soft round shadow on the floor, `r` metres across its dark middle. */
export function blobShadow(r: number, opacity = 0.5): THREE.Mesh {
  if (!shadowTex) {
    const pixels = new Uint8Array(128 * 128 * 4)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const radius = Math.hypot(x + .5 - 64, y + .5 - 64) / 64
      pixels[(y * 128 + x) * 4 + 3] = Math.round(255 * Math.max(0, radius < .5 ? 1 - radius * .9 : 1.1 * (1 - radius)))
    }
    shadowTex = new THREE.DataTexture(pixels, 128, 128)
    shadowTex.magFilter = shadowTex.minFilter = THREE.LinearFilter; shadowTex.needsUpdate = true
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(r * 2.4, r * 2.4), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity, depthWrite: false }))
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.002
  m.renderOrder = 1
  return m
}

/** A number plate (so people can tell units apart), as the arms have. */
export function plate(n: number, size = 0.1): THREE.Mesh {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.fillStyle = '#e6ebf2'
  g.beginPath()
  g.roundRect(8, 8, 112, 112, 26)
  g.fill()
  g.fillStyle = '#10141c'
  g.font = '800 84px "Plus Jakarta Sans", Inter, system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(String(n), 64, 70)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true }))
}

/** A ring on the floor where a pointing phone aims, in its colour. */
export function spotRing(): THREE.Group {
  const g = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthWrite: false })
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 48), mat)
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.035, 24), mat)
  ring.rotation.x = dot.rotation.x = -Math.PI / 2
  g.add(ring, dot)
  g.renderOrder = 3
  return g
}

/** The lights a preview scene needs (the stage has its own). */
export function previewScene(): THREE.Scene {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight('#ffffff', '#1d1840', 1.4))
  const key = new THREE.DirectionalLight('#ffffff', 1.8)
  key.position.set(-3, 6, 4)
  scene.add(key)
  return scene
}
