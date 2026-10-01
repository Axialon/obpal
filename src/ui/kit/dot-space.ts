import * as THREE from 'three'
import { DOT_MATERIAL, dotProgress, resolveDotTokens, type DotRole, type DotTimeline, type DotTokens } from './dot-field'
import type { DotPoint } from './dot-field'

/** Normalized flat samples acquire depth, in fractions of the visible height, without changing identity. */
export interface SpaceDot extends DotPoint { z?: number; role?: DotRole; diameter?: number }
export interface DotSpaceOptions { points: readonly SpaceDot[]; routes?: readonly (readonly SpaceDot[])[]; tokens?: DotTokens; decorative?: boolean; fallback?: () => void }

/** One bounded, on-demand 3D context. Instanced satin beads share the portable renderer's points and tokens. */
export class DotSpace {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly group = new THREE.Group()
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 1, 10000)
  private readonly geometry = new THREE.SphereGeometry(1, 12, 8)
  private readonly material = new THREE.MeshStandardMaterial({ roughness: DOT_MATERIAL.roughness, metalness: 0.08 })
  private readonly key = new THREE.DirectionalLight(0xffffed, DOT_MATERIAL.key * 2.2)
  private beads: THREE.InstancedMesh
  private routes: THREE.Line[] = []
  private readonly resizeObserver: ResizeObserver
  private readonly observer: IntersectionObserver
  private readonly themeObserver: MutationObserver
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)')
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private tokens: DotTokens
  private points: readonly SpaceDot[]
  private width = 1
  private height = 1
  private frame = 0
  private visible = true
  private dead = false
  private previous = 0
  private current = { x: 0, y: 0 }
  private target = { x: 0, y: 0 }
  private timeline: DotTimeline | null = null
  private drawCount = 0

  get frames() { return this.drawCount }
  get resolvedTokens() { return this.tokens }

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: DotSpaceOptions) {
    this.tokens = options.tokens ?? resolveDotTokens(canvas, 'display')
    this.points = options.points
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = canvas.closest('[data-bb-theme]')?.getAttribute('data-bb-theme') === 'light' ? 0.68 : 1
    this.key.position.set(-1, 1, 2)
    const rim = new THREE.DirectionalLight(0xffffff, DOT_MATERIAL.rim)
    rim.position.set(1, -0.2, 0.3)
    this.scene.add(this.key, rim, new THREE.AmbientLight(0xffffff, DOT_MATERIAL.fill), this.group)
    this.beads = this.makeBeads()
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(canvas)
    this.observer = new IntersectionObserver(entries => { this.visible = entries.some(e => e.isIntersecting); this.visibility() })
    this.observer.observe(canvas)
    this.themeObserver = new MutationObserver(this.refresh)
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bb-theme', 'data-bb-accent'] })
    this.motion.addEventListener('change', this.motionChanged)
    document.addEventListener('visibilitychange', this.visibility)
    canvas.addEventListener('webglcontextlost', this.lost)
    this.resize()
  }

  private makeBeads() {
    // Meaningful caller samples remain intact. The route generator stays below the mobile ceiling.
    const beads = new THREE.InstancedMesh(this.geometry, this.material, this.points.length)
    beads.frustumCulled = false
    this.group.add(beads)
    return beads
  }

  setPoints(points: readonly SpaceDot[]) {
    if (this.dead) return
    this.points = points
    this.group.remove(this.beads)
    this.beads.dispose()
    this.beads = this.makeBeads()
    this.layout()
    this.request()
  }

  private layout() {
    const colors = new Map<DotRole, THREE.Color>()
    for (const role of ['active', 'light', 'ink', 'muted', 'depth'] as const) colors.set(role, new THREE.Color(this.tokens.colors[role]))
    this.points.forEach((p, i) => {
      this.position.set((p.x - 0.5) * this.width, (0.5 - p.y) * this.height, (p.z ?? 0) * this.height)
      this.scale.setScalar((p.diameter ?? this.tokens.diameter) / 2)
      this.matrix.compose(this.position, this.quaternion, this.scale)
      this.beads.setMatrixAt(i, this.matrix)
      const color = colors.get(p.role ?? 'light')!.clone()
      // Sparse far layers lose contrast; the subject and seal stay sharp at the focal plane.
      if ((p.z ?? 0) < -0.1) color.multiplyScalar(0.3)
      this.beads.setColorAt(i, color)
    })
    this.beads.instanceMatrix.needsUpdate = true
    if (this.beads.instanceColor) this.beads.instanceColor.needsUpdate = true
    for (const route of this.routes) { this.group.remove(route); route.geometry.dispose(); (route.material as THREE.Material).dispose() }
    this.routes = (this.options.routes ?? []).map(points => {
      const geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3((p.x - 0.5) * this.width, (0.5 - p.y) * this.height, (p.z ?? 0) * this.height)))
      const role = points[0]?.role ?? 'light'
      const material = new THREE.LineBasicMaterial({ color: colors.get(role), transparent: true, opacity: role === 'muted' ? 0.2 : 0.6 })
      const line = new THREE.Line(geometry, material)
      this.group.add(line)
      return line
    })
  }

  private resize = () => {
    if (this.dead) return
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height)
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2, Math.sqrt(3e6 / (this.width * this.height))))
    this.renderer.setSize(this.width, this.height, false)
    this.camera.aspect = this.width / this.height
    this.camera.position.z = this.height / (2 * Math.tan(Math.PI / 12))
    this.camera.updateProjectionMatrix()
    this.layout(); this.request()
  }

  refresh = () => {
    if (this.dead) return
    this.tokens = this.options.tokens ?? resolveDotTokens(this.canvas, 'display')
    this.renderer.toneMappingExposure = this.canvas.closest('[data-bb-theme]')?.getAttribute('data-bb-theme') === 'light' ? 0.68 : 1
    this.layout(); this.request()
  }

  /** Already-permitted local input, normalized to ±1. A seal changes light only, never its cell positions. */
  pointer(x: number, y: number) {
    if (this.dead || this.motion.matches || !Number.isFinite(x) || !Number.isFinite(y)) return
    x = Math.max(-1, Math.min(1, x)); y = Math.max(-1, Math.min(1, y))
    if (this.target.x === x && this.target.y === y) return
    this.target = { x, y }
    this.request()
  }

  /** A shared epoch clock for future cross-device effects; this renderer never schedules authentication. */
  syncTimeline(timeline: DotTimeline) { this.timeline = timeline; this.request() }

  private request() {
    if (!this.dead && this.visible && !document.hidden && !this.frame) this.frame = requestAnimationFrame(this.draw)
  }

  private draw = (now: number) => {
    this.frame = 0
    if (this.dead || !this.visible || document.hidden) return
    const mix = this.motion.matches ? 1 : 1 - Math.exp(-Math.min(64, now - (this.previous || now - 16)) / 120)
    this.previous = now
    this.current.x += (this.target.x - this.current.x) * mix
    this.current.y += (this.target.y - this.current.y) * mix
    if (this.options.decorative) {
      const angle = DOT_MATERIAL.parallaxDegrees * Math.PI / 180
      this.group.rotation.set(this.current.y * angle, this.current.x * angle, 0)
      this.group.position.set(this.current.x * 6, -this.current.y * 6, 0)
    } else this.key.position.set(-1 + this.current.x * 0.3, 1 + this.current.y * 0.3, 2)
    if (this.timeline) {
      const progress = this.motion.matches ? 1 : dotProgress(this.timeline, Date.now())
      this.canvas.dataset.dotProgress = progress.toFixed(3)
      if (progress === 1) this.timeline = null
    }
    this.renderer.render(this.scene, this.camera)
    this.drawCount++
    this.canvas.dataset.dotFrames = String(this.drawCount)
    if (this.timeline || Math.abs(this.target.x - this.current.x) + Math.abs(this.target.y - this.current.y) > 0.001) this.request()
  }

  private motionChanged = () => { this.target = this.current = { x: 0, y: 0 }; this.request() }
  private visibility = () => {
    if (!this.visible || document.hidden) { cancelAnimationFrame(this.frame); this.frame = 0; this.previous = 0 }
    else this.request()
  }
  private lost = (event: Event) => { event.preventDefault(); this.destroy(); this.options.fallback?.() }

  destroy() {
    if (this.dead) return
    this.dead = true
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect(); this.observer.disconnect(); this.themeObserver.disconnect()
    this.motion.removeEventListener('change', this.motionChanged)
    document.removeEventListener('visibilitychange', this.visibility)
    this.canvas.removeEventListener('webglcontextlost', this.lost)
    for (const route of this.routes) { route.geometry.dispose(); (route.material as THREE.Material).dispose() }
    this.beads.dispose(); this.geometry.dispose(); this.material.dispose(); this.renderer.dispose()
  }
}
