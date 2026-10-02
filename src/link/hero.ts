import * as THREE from 'three'
import { DOT_MATERIAL, dotLoaderClock, resolveDotTokens, type DotTokens } from '../ui/kit/dot-field'
import { dotBeads } from '../ui/kit/dot-space'
import { heroFrame, heroPhases, heroPoints, type HeroPart, type HeroState } from './hero-points'
import { contrast, parseColor } from '../../packages/host/src/color'

/** The journey owns one finite effect. Flat circles and satin beads use identical samples and phases. */
export class LinkHero {
  private readonly points = heroPoints()
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
  private readonly beads = dotBeads(this.points.length)
  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly scale = new THREE.Vector3()
  private readonly rotation = new THREE.Quaternion()
  private readonly alpha = new THREE.InstancedBufferAttribute(new Float32Array(this.points.length), 1)
  private renderer?: THREE.WebGLRenderer
  private gpuReady = false
  private compiled = false
  private completionStatus = 0
  private handoff = 0
  private flat?: CanvasRenderingContext2D
  private tokens: DotTokens
  private routeInk = ''
  private state: HeroState = 'idle'
  private pc = false
  private width = 1
  private height = 1
  private dpr = 1
  private visible = false
  private dead = false
  private frames = 0
  private stop = () => {}
  private pointerX = 0
  private pointerY = 0
  private previousX = 0
  private previousY = 0
  private initial: boolean
  private readonly sample = { x: 0, y: 0, opacity: 1 }
  private pointerPart: HeroPart | null = null
  private running = false
  private readonly motion = matchMedia('(prefers-reduced-motion: reduce)')
  private readonly resize: ResizeObserver
  private readonly intersection: IntersectionObserver
  private readonly theme: MutationObserver

  constructor(private readonly canvas: HTMLCanvasElement, private readonly fallback: HTMLCanvasElement, private readonly autoplay = true) {
    this.initial = autoplay
    canvas.dataset.dotState = 'idle'; canvas.dataset.dotPc = 'false'
    this.tokens = resolveDotTokens(canvas, 'display')
    this.camera.position.z = 10
    this.beads.name = 'link-device-dots'
    this.beads.geometry.setAttribute('dotOpacity', this.alpha)
    this.beads.material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float dotOpacity; varying float vDotOpacity;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvDotOpacity = dotOpacity;')
      shader.fragmentShader = 'varying float vDotOpacity;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vDotOpacity;')
    }
    this.beads.material.customProgramCacheKey = () => 'link-dot-opacity'
    const key = new THREE.DirectionalLight(0xffffed, DOT_MATERIAL.key * 2.2)
    key.position.set(-1, 1, 2)
    const rim = new THREE.DirectionalLight(0xffffff, DOT_MATERIAL.rim)
    rim.position.set(1, -0.2, 0.3)
    this.scene.add(this.beads, key, rim, new THREE.AmbientLight(0xffffff, DOT_MATERIAL.fill))
    try {
      // A fallback retained by history must not construct another renderer on its lost context.
      if (canvas.hidden && !fallback.hidden) this.useFlat()
      else {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
        this.renderer.outputColorSpace = THREE.SRGBColorSpace
        this.renderer.setClearColor(0, 0)
        if (this.renderer.getContext().isContextLost()) this.useFlat()
        else {
          this.flat = fallback.getContext('2d') ?? undefined
          fallback.hidden = false; canvas.style.opacity = '0'; canvas.style.zIndex = '1'
          canvas.dataset.dotRenderer = 'pending'
        }
      }
    } catch { this.useFlat() }
    this.resize = new ResizeObserver(this.layout)
    this.resize.observe(canvas.parentElement!)
    this.intersection = new IntersectionObserver(entries => {
      this.visible = entries.some(entry => entry.isIntersecting)
      this.visibility()
    })
    this.intersection.observe(canvas.parentElement!)
    this.theme = new MutationObserver(() => { this.tokens = resolveDotTokens(canvas, 'display'); this.colors(); this.paint(null, 1) })
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-bb-theme', 'data-bb-accent'] })
    canvas.addEventListener('webglcontextlost', this.lost)
    document.addEventListener('visibilitychange', this.visibility)
    this.motion.addEventListener('change', this.visibility)
    this.layout()
  }

  private useFlat() {
    this.renderer?.dispose(); this.renderer = undefined
    this.gpuReady = false; this.compiled = false; this.handoff = 0
    this.canvas.style.removeProperty('opacity'); this.fallback.style.removeProperty('opacity'); this.canvas.style.removeProperty('z-index')
    this.canvas.dataset.dotRenderer = 'flat'
    this.canvas.hidden = true; this.fallback.hidden = false
    this.flat = this.fallback.getContext('2d') ?? undefined
  }

  private colors() {
    const active = parseColor(this.tokens.colors.active), surface = parseColor(this.tokens.surface)
    // Seal contrast headroom covers raster edges and the travelling opacity phase on Light.
    this.routeInk = active && surface && contrast(active, surface) >= 10 ? this.tokens.colors.active : this.tokens.colors.ink
    this.points.forEach((dot, i) => {
      // Full family ink keeps device outlines legible. Only permitted, connected edges acquire seal colour.
      const active = this.state === 'connected' && (dot.part === 'link' || (dot.part === 'pc-link' && this.pc))
      this.beads.setColorAt(i, new THREE.Color(active ? this.routeInk : this.tokens.colors.ink))
    })
    if (this.beads.instanceColor) this.beads.instanceColor.needsUpdate = true
  }

  private layout = () => {
    if (this.dead) return
    const rect = this.canvas.parentElement!.getBoundingClientRect()
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height)
    this.dpr = Math.min(devicePixelRatio || 1, 2)
    this.renderer?.setPixelRatio(this.dpr)
    this.renderer?.setSize(this.width, this.height, false)
    const flatWidth = Math.round(this.width * this.dpr), flatHeight = Math.round(this.height * this.dpr)
    if (this.fallback.width !== flatWidth) this.fallback.width = flatWidth
    if (this.fallback.height !== flatHeight) this.fallback.height = flatHeight
    this.camera.left = -this.width / 2; this.camera.right = this.width / 2
    this.camera.top = this.height / 2; this.camera.bottom = -this.height / 2
    this.camera.updateProjectionMatrix()
    this.colors(); this.paint(null, 1)
  }

  private paint(part: HeroPart | null, progress: number) {
    if (this.dead || document.hidden || !this.visible) return
    const fit = this.width / 576
    const radius = Math.max(2.2, Math.min(4.2, 4.2 * fit)) / 2
    const flat = this.fallback.hidden ? undefined : this.flat
    flat?.setTransform(this.fallback.width / this.width, 0, 0, this.fallback.height / this.height, 0, 0)
    flat?.clearRect(0, 0, this.width, this.height)
    this.points.forEach((dot, i) => {
      const frame = heroFrame(dot, part, progress, this.state, this.pc, this.pointerX, this.pointerY, this.sample)
      const x = (frame.x - 288) * fit, y = (120 - frame.y) * fit
      this.position.set(x, y, 0); this.scale.setScalar(radius)
      this.matrix.compose(this.position, this.rotation, this.scale)
      this.beads.setMatrixAt(i, this.matrix); this.alpha.setX(i, frame.opacity)
      if (flat && frame.opacity) {
        const active = this.state === 'connected' && (dot.part === 'link' || (dot.part === 'pc-link' && this.pc))
        flat.fillStyle = active ? this.routeInk : this.tokens.colors.ink
        flat.globalAlpha = frame.opacity
        flat.beginPath(); flat.arc(x + this.width / 2, this.height / 2 - y, radius, 0, Math.PI * 2); flat.fill()
      }
    })
    this.beads.instanceMatrix.needsUpdate = true; this.alpha.needsUpdate = true
    if (this.gpuReady) this.renderer?.render(this.scene, this.camera)
    this.canvas.dataset.dotFrames = String(++this.frames)
    this.canvas.dataset.dotPart = part ?? 'rest'
  }

  /** Compile without blocking the first paint or adding a second polling clock. */
  private prepare() {
    if (!this.renderer || this.gpuReady || !this.visible || document.hidden || this.dead) return false
    this.stop(); this.paint(null, 1)
    const renderer = this.renderer, gl = renderer.getContext()
    if (!this.compiled) {
      const parallel = gl.getExtension('KHR_parallel_shader_compile')
      if (!parallel) { this.useFlat(); this.paint(null, 1); return false }
      this.completionStatus = parallel.COMPLETION_STATUS_KHR
      renderer.compile(this.scene, this.camera); this.compiled = true
    }
    let pollingStarted = 0
    this.stop = dotLoaderClock(now => {
      if (!pollingStarted) pollingStarted = now
      if (now - pollingStarted > 4000) { this.useFlat(); this.paint(null, 1); return false }
      if (this.dead || !this.visible || document.hidden || !this.renderer) return false
      if (!this.gpuReady) {
        if (gl.isContextLost()) { this.useFlat(); this.paint(null, 1); return false }
        if (renderer.info.programs?.some(program => !gl.getProgramParameter(program.program as WebGLProgram, this.completionStatus))) return true
        this.gpuReady = true; this.handoff = now
        this.paint(null, 1)
      }
      const progress = this.motion.matches || !this.autoplay ? 1 : Math.min(1, (now - this.handoff) / 120)
      this.canvas.style.opacity = String(progress); this.fallback.style.opacity = String(1 - progress)
      if (progress < 1) return true
      this.handoff = 0; this.fallback.hidden = true
      this.canvas.style.removeProperty('opacity'); this.fallback.style.removeProperty('opacity'); this.canvas.dataset.dotRenderer = 'beads'
      queueMicrotask(() => { if (!this.dead) this.visibility() })
      return false
    })
    return true
  }

  setState(state: HeroState, pc = this.pc, replay = true) {
    if (this.dead) return
    this.state = state; this.pc = pc
    this.canvas.dataset.dotState = state; this.canvas.dataset.dotPc = String(pc)
    this.colors()
    if (replay) this.play()
    else { this.stop(); this.initial = false; this.running = false; if (!this.prepare()) this.paint(null, 1) }
  }

  private play(only?: HeroPart) {
    this.stop()
    this.pointerPart = only ?? null; this.running = false
    if (this.handoff) { this.handoff = 0; this.fallback.hidden = true; this.canvas.style.removeProperty('opacity'); this.fallback.style.removeProperty('opacity'); this.canvas.dataset.dotRenderer = 'beads' }
    if (this.renderer && !this.gpuReady) { this.initial = true; if (this.prepare()) return }
    if (this.dead || !this.visible || document.hidden || this.motion.matches) { this.paint(null, 1); return }
    this.running = true
    const phases = only ? [{ part: only, duration: 700 }] : heroPhases(this.state, this.pc)
    let started = 0, index = 0
    this.stop = dotLoaderClock(now => {
      if (!started) started = now
      const phase = phases[index]
      const progress = Math.min(1, (now - started) / phase.duration)
      this.paint(phase.part, progress)
      if (progress < 1) return true
      if (++index < phases.length) { started = now; return true }
      this.running = false; this.paint(null, 1); return false
    })
  }

  pointer(x: number, y: number, part: HeroPart = 'phone') {
    if (this.dead || this.motion.matches || !Number.isFinite(x) || !Number.isFinite(y)) return
    x = Math.max(-1, Math.min(1, x)); y = Math.max(-1, Math.min(1, y))
    if (x === this.previousX && y === this.previousY) return
    this.previousX = this.pointerX = x; this.previousY = this.pointerY = y
    if (!this.running || this.pointerPart !== part) this.play(part)
  }

  private visibility = () => {
    this.stop(); this.running = false
    if (this.prepare()) return
    if (this.handoff) {
      this.handoff = 0; this.fallback.hidden = true
      this.canvas.style.removeProperty('opacity'); this.fallback.style.removeProperty('opacity'); this.canvas.dataset.dotRenderer = 'beads'
    }
    if (this.initial && this.visible && !document.hidden) { this.initial = false; this.play(); return }
    // Resume the current composition without replaying an offscreen preview.
    this.paint(null, 1)
  }
  private lost = (event: Event) => { event.preventDefault(); this.stop(); this.useFlat(); this.layout() }

  destroy() {
    if (this.dead) return
    this.dead = true; this.stop()
    this.resize.disconnect(); this.intersection.disconnect(); this.theme.disconnect()
    document.removeEventListener('visibilitychange', this.visibility)
    this.motion.removeEventListener('change', this.visibility)
    this.canvas.removeEventListener('webglcontextlost', this.lost)
    this.beads.dispose(); this.beads.geometry.dispose(); this.beads.material.dispose(); this.renderer?.dispose()
  }
}
