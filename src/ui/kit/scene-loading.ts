import * as THREE from 'three'
import { dotBeads } from './dot-space'
import { dotLoaderClock, dotLoaderFrame, resolveDotTokens } from './dot-field'

/** Three satin beads live in the caller's scene and use its render loop, depth and lighting. */
export class SceneDotLoader {
  readonly beads = dotBeads(3)
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()
  private readonly identity = new THREE.Quaternion()
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)')
  private readonly observer: IntersectionObserver
  private readonly resize: ResizeObserver
  private readonly theme: MutationObserver
  private stop = () => {}
  private visible = true
  private active = false
  private size = 0.01
  private anchor = new THREE.Vector3()
  private ending = 0
  private paused = false

  constructor(private readonly canvas: HTMLCanvasElement, private readonly scene: THREE.Scene, private readonly camera: THREE.PerspectiveCamera | (() => THREE.PerspectiveCamera)) {
    this.beads.visible = false
    scene.add(this.beads)
    this.observer = new IntersectionObserver(entries => { this.visible = entries.some(e => e.isIntersecting); this.sync() })
    this.observer.observe(canvas)
    this.resize = new ResizeObserver(this.project)
    this.resize.observe(canvas)
    this.theme = new MutationObserver(this.refresh)
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bb-theme', 'data-bb-accent'] })
    this.motion.addEventListener('change', this.sync)
    document.addEventListener('visibilitychange', this.sync)
    this.refresh()
  }

  /** The anchor stays in world space in XR; it never follows the headset. */
  private project = () => {
    const camera = typeof this.camera === 'function' ? this.camera() : this.camera
    const height = Math.max(1, this.canvas.clientHeight)
    const distance = 1.5
    this.size = 2 * distance / camera.projectionMatrix.elements[5] / height * 7.68
    camera.updateMatrixWorld()
    this.anchor.set(0, 0, -distance).applyMatrix4(camera.matrixWorld)
    this.beads.position.copy(this.anchor)
    this.beads.quaternion.copy(camera.getWorldQuaternion(this.rotation))
    this.draw(performance.now())
  }

  private refresh = () => {
    const tokens = resolveDotTokens(this.canvas, 'beacon')
    ;(this.beads.material as THREE.MeshStandardMaterial).color.set(tokens.colors.ink)
    this.project()
  }

  set loading(value: boolean) {
    if (value === this.active) return
    this.active = value
    this.ending = 0
    ;(this.beads.material as THREE.MeshStandardMaterial).opacity = 1
    this.beads.visible = value
    if (value) this.project()
    this.sync()
  }

  /** Hidden warm-up compiles a static mesh without competing with the visible flat loader. */
  set suspended(value: boolean) { if (value !== this.paused) { this.paused = value; this.sync() } }
  reframe() { if (this.active) this.project() }

  /** A short, bounded handoff shares the scene reveal rather than flashing another complete frame. */
  finish() {
    if (!this.active || this.ending) return
    if (this.motion.matches || !this.visible || document.hidden) { this.loading = false; return }
    this.ending = performance.now()
    this.sync()
  }

  private draw = (now: number) => {
    for (let i = 0; i < 3; i++) {
      const frame = this.motion.matches ? { lift: 0, scale: 1 } : dotLoaderFrame(now, i)
      this.position.set((i - 1) * this.size * 1.75, frame.lift * this.size, 0)
      this.scale.setScalar(this.size * .5 * frame.scale)
      this.matrix.compose(this.position, this.identity, this.scale)
      this.beads.setMatrixAt(i, this.matrix)
    }
    this.beads.instanceMatrix.needsUpdate = true
    if (this.ending) {
      const t = Math.min(1, (now - this.ending) / 120)
      ;(this.beads.material as THREE.MeshStandardMaterial).opacity = 1 - t
      if (t === 1) this.loading = false
    }
  }

  private sync = () => {
    this.stop()
    if (this.ending && (this.motion.matches || !this.visible || document.hidden)) { this.loading = false; return }
    this.draw(performance.now())
    if (!this.active || this.paused || !this.visible || document.hidden || this.motion.matches) return
    this.stop = dotLoaderClock(now => { this.draw(now); return this.active }, document, !!this.ending)
  }

  destroy() {
    this.stop(); this.observer.disconnect(); this.resize.disconnect(); this.theme.disconnect()
    this.motion.removeEventListener('change', this.sync)
    document.removeEventListener('visibilitychange', this.sync)
    this.scene.remove(this.beads)
    this.beads.geometry.dispose(); (this.beads.material as THREE.Material).dispose(); this.beads.dispose()
  }
}
