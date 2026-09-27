/**
 * The stage every device sim stands on: a backdrop and floor in the visitor's surface (light or dark), a soft key light
 * and reflections, and a camera the screen's mouse can orbit, framed beside the panel (above it on a narrow screen). It
 * draws the way every sim does (../view.ts: clean edges at rest, smooth in motion, within what the device can afford),
 * over a transparent canvas so the backdrop shows through. The loop rests while the tab is hidden.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { environment, softKey } from '../kit'
import type { Theme } from '../../ui/themes'
import { simView, type SimView } from '../view'

export type V3 = [number, number, number]

/**
 * Where a device's camera looks from, on a wide screen and on a tall one, and how wide the device is (`radius`: its half
 * width at `target` that must stay in view): on a screen too narrow for it, the camera backs off along the same line.
 */
export interface Framing { target: V3; wide: V3; tall: V3; radius: number; min?: number; max?: number }

export interface Stage {
  renderer: THREE.WebGLRenderer
  /** How it draws (../view.ts); a device that changes what the still check can't see calls its invalidate(). */
  view: SimView
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  /** The floor a device may stand on (a soft disc that fades into the backdrop). */
  ground: THREE.Mesh
  /** The stage's own light, which a device may dim (a room at night). */
  lights: { hemi: THREE.HemisphereLight; key: THREE.DirectionalLight }
  theme: Theme
  /** Look at the device from its framing (again after a resize or the screen's own orbiting). */
  frame(f: Framing): void
  follow(at: THREE.Vector3): void
  setTheme(t: Theme): void
  /** Where a pointer at (x, y) CSS px meets the horizontal plane at height y0, or null (it points above the horizon). */
  pick(x: number, y: number, y0?: number): THREE.Vector3 | null
  /** A world point on the screen, CSS px (behind the camera: null). */
  toScreen(p: THREE.Vector3): { x: number; y: number } | null
  /** Called every frame before rendering: t and dt in seconds. */
  onFrame: ((t: number, dt: number) => void) | null
  /** Called after the scene is drawn (insets draw over it: the stage then draws every frame anew). */
  afterRender: (() => void) | null
  resize(): void
}

/** A soft round floor in `floor`, with a `grid` that fades out toward the rim, so the stage has no edge. */
function groundTexture(floor: string, grid: string) {
  const c = document.createElement('canvas')
  c.width = c.height = 1024
  const g = c.getContext('2d')!
  const fade = g.createRadialGradient(512, 512, 40, 512, 512, 512)
  fade.addColorStop(0, floor)
  fade.addColorStop(0.62, floor)
  fade.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = fade
  g.fillRect(0, 0, 1024, 1024)
  // The grid only where there's floor, fading with it.
  g.globalCompositeOperation = 'source-atop'
  g.strokeStyle = grid
  g.globalAlpha = 0.025
  g.lineWidth = 1
  for (let i = 0; i <= 1024; i += 1024 / 56) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 1024); g.stroke()
    g.beginPath(); g.moveTo(0, i); g.lineTo(1024, i); g.stroke()
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

export function createStage(canvas: HTMLCanvasElement, theme: Theme): Stage {
  const view = simView(canvas, { onResize: () => { stage.resize(); stage.frame(framing) }, params: { alpha: true } })
  const renderer = view.renderer
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0x000000, 0)
  const scene = new THREE.Scene()
  scene.environment = environment(renderer)
  scene.environmentIntensity = 0.8
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 80)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.maxPolarAngle = Math.PI * 0.48
  controls.enablePan = false

  const hemi = new THREE.HemisphereLight('#ffffff', '#20242c', 1.1)
  scene.add(hemi)
  const key = softKey(scene, 10)

  const ground = new THREE.Mesh(new THREE.CircleGeometry(14, 96), new THREE.MeshStandardMaterial({ transparent: true, roughness: 0.95, metalness: 0, depthWrite: false }))
  ground.receiveShadow = true
  ground.rotation.x = -Math.PI / 2
  // Just under the devices' own floors (at 0), which it would otherwise draw over: it's transparent, so it comes last.
  ground.position.y = -0.03
  ground.renderOrder = -1
  scene.add(ground)

  let framing: Framing = { target: [0, 0, 0], wide: [0, 4, 6], tall: [0, 6, 9], radius: 1 }
  /** The part of the screen the panel leaves the stage (CSS px). */
  let free = { w: innerWidth, h: innerHeight }
  const raycaster = new THREE.Raycaster()
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const ndc = new THREE.Vector2()

  const stage: Stage = {
    renderer, view, scene, camera, controls, ground, theme, lights: { hemi, key },
    follow(at) {
      const delta = at.clone().sub(controls.target)
      camera.position.add(delta)
      controls.target.copy(at)
      framing = { ...framing, target: at.toArray() as V3, wide: new THREE.Vector3(...framing.wide).add(delta).toArray() as V3, tall: new THREE.Vector3(...framing.tall).add(delta).toArray() as V3 }
    },
    frame(f) {
      framing = f
      const radius = Math.max(5, f.radius * 1.2)
      Object.assign(key.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius })
      key.shadow.camera.updateProjectionMatrix()
      const tall = innerWidth < innerHeight
      const from = new THREE.Vector3(...(tall ? f.tall : f.wide))
      const target = new THREE.Vector3(...f.target)
      // Far enough that the device's width fits what the panel leaves free.
      const need = f.radius / (Math.tan((camera.fov * Math.PI) / 360) * Math.max(0.2, Math.min(free.w, free.h) / innerHeight))
      const dir = from.clone().sub(target)
      if (dir.length() < need) from.copy(target).addScaledVector(dir.normalize(), need)
      camera.position.copy(from)
      controls.target.copy(target)
      controls.minDistance = f.min ?? 1
      controls.maxDistance = Math.max(f.max ?? 30, need * 1.5)
      camera.far = Math.max(80, controls.maxDistance * 3)
      camera.updateProjectionMatrix()
      const distance = from.distanceTo(target)
      scene.fog = new THREE.Fog(stage.theme.scene[1], Math.max(24, distance + f.radius), Math.max(60, distance + f.radius * 6))
      controls.update()
    },
    setTheme(t) {
      stage.theme = t
      const [a, b, c] = t.scene
      const root = document.documentElement.style
      root.setProperty('--stage-a', a)
      root.setProperty('--stage-b', b)
      root.setProperty('--stage-c', c)
      const m = ground.material as THREE.MeshStandardMaterial
      m.map?.dispose()
      m.map = groundTexture(t.light ? '#f6f8fb' : '#111820', t.grid)
      m.needsUpdate = true
      hemi.color.set(t.light ? '#ffffff' : '#e8ecff')
      hemi.groundColor.set(t.light ? '#c9d1dc' : '#171a22')
      hemi.intensity = t.light ? 1.5 : 1.1
      scene.fog = new THREE.Fog(b, 16, 40)
      // Light and a floor's picture aren't in what the still check compares: draw anew.
      view.invalidate()
    },
    pick(x, y, y0 = 0) {
      ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      plane.constant = -y0
      return raycaster.ray.intersectPlane(plane, new THREE.Vector3())
    },
    toScreen(p) {
      const v = p.clone().project(camera)
      if (v.z > 1) return null
      return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight }
    },
    onFrame: null,
    afterRender: null,
    resize() {
      const w = view.width
      const h = view.height
      camera.aspect = w / h
      // The device sits in the middle of what the panel leaves free: beside it, or above it on a narrow screen.
      const panel = document.querySelector('.sim-panel')?.getBoundingClientRect()
      const top = 64
      if (panel && w > 860) { camera.setViewOffset(w, h, -panel.right / 2, 0, w, h); free = { w: w - panel.right, h: h - top } }
      else if (panel) { camera.setViewOffset(w, h, 0, (h - panel.top) / 2, w, h); free = { w, h: panel.top - top } }
      else { camera.clearViewOffset(); free = { w, h } }
      camera.updateProjectionMatrix()
    },
  }
  stage.setTheme(theme)
  // The panel's place changes with the page's width (beside the stage, or under it): framed again when it moves.
  addEventListener('resize', () => { stage.resize(); stage.frame(framing) })
  stage.resize()

  let last = 0
  const loop = (now: number) => {
    requestAnimationFrame(loop)
    if (document.hidden) { last = 0; return }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
    last = now
    stage.onFrame?.(now / 1000, dt)
    controls.update()
    // Insets drawn over the stage need it drawn under them each frame, not kept as a still picture.
    if (stage.afterRender) view.invalidate()
    view.draw(scene, camera, dt)
    stage.afterRender?.()
  }
  requestAnimationFrame(loop)
  return stage
}
