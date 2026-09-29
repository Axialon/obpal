/**
 * How every sim draws (./arena.ts, ./arm/main.ts, and any to come): clean edges at rest, smooth ones in motion, within
 * what the device can afford.
 *   - The canvas's drawing buffer has exactly its device pixels (device-pixel-content-box, where the browser reports
 *     it), so the browser never stretches it; or more, where the GPU has room: the quality governor's ladder
 *     (../landing/governor.ts), climbing on the GPU's own time per frame (Chrome, Edge) up to twice the screen's
 *     pixels, within a 3840 x 2160 budget. A phone draws no more than twice its CSS pixels.
 *   - Moving (the camera, or anything in the scene), each frame is drawn once, multisampled.
 *   - Still, the scene is drawn again frame after frame, each time shifted by a fraction of a pixel (a Halton
 *     sequence), and the picture shown is the average of them all: after 32 it's supersampled, edges, thin lines and
 *     highlights alike. Then nothing more is drawn until something moves: the screen keeps the picture.
 * Still means nothing a frame would show has changed: the camera, and each shown object's place, size, colours and
 * opacity. A sim that changes something else a frame shows (a texture) calls invalidate().
 * ?quality=super|native|low (or a step's number) holds a step; ?debug=gfx shows how it draws.
 */
import {
  ACESFilmicToneMapping, SRGBColorSpace, ConstantAlphaFactor, CustomBlending, FramebufferTexture, Mesh, NearestFilter, OneMinusConstantAlphaFactor, OrthographicCamera,
  PlaneGeometry, Scene, ShaderMaterial, WebGLRenderer, WebGLRenderTarget, type Camera, type Color, type Material, type Object3D,
  type WebGLRendererParameters, type Light, type InstancedMesh,
} from 'three'
import { Governor, pickPixels, pixelLadder, type GpuSample, type Step } from '../landing/governor'
import type { Experience } from './vr/experience'
import { listenFrom } from './audio/context'
import { contactRecorder } from './contact'
import { recordFrame } from './kit/reveal'

/** Frames averaged into the still picture. */
export const STILL_FRAMES = 32
/** A change this small from one frame to the next (in any of a frame's numbers) is no change; nor this much since the still picture began. */
const EPS_FRAME = 1e-5
const EPS_TOTAL = 2e-4

/** What a frame would show, as numbers: the camera, and each shown object's place and size, colours and opacity. */
export function signature(scene: Object3D, camera: Camera, out: number[] = []): number[] {
  out.length = 0
  camera.updateMatrixWorld()
  out.push(...camera.matrixWorld.elements, ...camera.projectionMatrix.elements)
  scene.updateMatrixWorld()
  scene.traverseVisible((o) => {
    out.push(...o.matrixWorld.elements)
    const m = (o as Mesh).material as Material | Material[] | undefined
    if (m) for (const x of Array.isArray(m) ? m : [m]) look(out, x)
    const light = o as Light
    if (light.isLight) out.push(light.intensity, light.color.r, light.color.g, light.color.b)
    const instances = o as InstancedMesh
    if (instances.isInstancedMesh) out.push(instances.instanceMatrix.version)
  })
  const bg = (scene as Scene).background as Color | null
  if (bg && bg.isColor) out.push(bg.r, bg.g, bg.b)
  return out
}
function look(out: number[], m: Material) {
  const c = m as Material & { color?: Color; emissive?: Color; emissiveIntensity?: number }
  out.push(m.opacity, m.visible ? 1 : 0)
  if (c.color) out.push(c.color.r, c.color.g, c.color.b)
  if (c.emissive) out.push(c.emissive.r, c.emissive.g, c.emissive.b, c.emissiveIntensity ?? 1)
}

/** Whether two frames' numbers differ by more than `eps` anywhere. */
export function changed(a: readonly number[], b: readonly number[], eps: number): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > eps) return true
  return false
}

/** The `i`th number of the Halton sequence in `base` (0 < h < 1): points that fill a pixel evenly, however many are taken. */
export function halton(i: number, base: number): number {
  let f = 1, r = 0
  for (let n = i; n > 0; n = Math.floor(n / base)) { f /= base; r += f * (n % base) }
  return r
}

/** Where the still picture's `k`th frame is drawn, in pixels from where the camera sees (the first exactly there). */
export function jitterOf(k: number): [number, number] {
  return k === 0 ? [0, 0] : [halton(k, 2) - 0.5, halton(k, 3) - 0.5]
}

export interface SimGfx {
  /** Scene submissions including camera insets, excluding still-picture compositing quads. */
  triangles: number
  calls: number
  renderMs: number
  css: [number, number]
  buffer: [number, number]
  pr: number
  dpr: number
  level: number
  steps: Step[]
  pinned: boolean
  samples: number
  gpuMs: number | null
  /** Frames averaged into the still picture so far (0: moving). */
  still: number
}

export interface SimView {
  presence: Experience | null
  /** The rendered camera, including the XR array camera, for listeners such as spatial audio. */
  readonly activeCamera: Camera | null
  onCameraChange(listener: (camera: Camera) => void): () => void
  readonly renderer: WebGLRenderer
  /** The canvas's size (CSS px), for the camera. */
  readonly width: number
  readonly height: number
  /** Draw a frame, `dt` seconds after the one before. */
  draw(scene: Scene, camera: Camera, dt: number): void
  /** Draw a camera inset and include its scene submission in the frame's budget. */
  drawInset(scene: Scene, camera: Camera): void
  /** Something a frame shows changed that the still check can't see (a texture): the next frame is drawn anew. */
  invalidate(): void
  gfx(): SimGfx
}

const QUAD_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
const QUAD_FRAG = 'uniform sampler2D tMap; varying vec2 vUv; void main() { gl_FragColor = texture2D(tMap, vUv); }'

/**
 * The drawing for a sim's canvas. `onResize` hears whenever the canvas's size (CSS px) changes, for the camera's aspect
 * and view; before the first frame, the sim sets them up from `width` and `height`.
 */
export function simView(canvas: HTMLCanvasElement, opts: { onResize(w: number, h: number): void; params?: WebGLRendererParameters }): SimView {
  const contactTest = new URLSearchParams(location.search).get('test') === 'contact'
  const loadTest = new URLSearchParams(location.search).get('test') === 'load'
  let recordContacts: (() => void) | undefined
  const renderer = new WebGLRenderer({ canvas, antialias: true, ...opts.params })
  let triangles = 0, calls = 0, renderMs = 0
  let insetTriangles = 0, insetCalls = 0, insetMs = 0
  const renderScene = (scene: Scene, camera: Camera) => {
    const start = performance.now()
    renderer.render(scene, camera)
    renderMs = performance.now() - start
    triangles = renderer.info.render.triangles
    calls = renderer.info.render.calls
  }
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  const coarse = matchMedia('(pointer: coarse)').matches
  const gl = renderer.getContext() as WebGL2RenderingContext
  let W = canvas.clientWidth || innerWidth, H = canvas.clientHeight || innerHeight
  /** The canvas in device pixels, exactly, where the browser says. */
  let device: [number, number] | null = null
  let steps = pixelLadder(devicePixelRatio || 1, coarse, { w: W, h: H })
  const quality = new URLSearchParams(location.search).get('quality')
  const pin = () => { const at = quality === null ? -1 : pickPixels(steps, quality, devicePixelRatio || 1, coarse); return at < 0 ? null : at }
  let pinned = pin()
  let governor = new Governor(steps, { level: Math.max(0, pickPixels(steps, 'native', devicePixelRatio || 1, coarse)) })
  let step: Step = steps[pinned ?? governor.level]

  // The still picture: each frame's copy, and their average.
  const quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const quad = new PlaneGeometry(2, 2)
  const blend = new ShaderMaterial({
    uniforms: { tMap: { value: null } }, vertexShader: QUAD_VERT, fragmentShader: QUAD_FRAG, depthTest: false, depthWrite: false,
    blending: CustomBlending, blendSrc: ConstantAlphaFactor, blendDst: OneMinusConstantAlphaFactor,
  })
  const show = new ShaderMaterial({ uniforms: { tMap: { value: null } }, vertexShader: QUAD_VERT, fragmentShader: QUAD_FRAG, depthTest: false, depthWrite: false })
  const blendScene = new Scene().add(new Mesh(quad, blend))
  const showScene = new Scene().add(new Mesh(quad, show))
  let sample: FramebufferTexture | null = null
  let accum: WebGLRenderTarget | null = null
  /** The still picture can't be made here (the copy failed once): moving frames only. */
  let noStill = false
  let still = 0
  let force = true
  let sig: number[] = [], prev: number[] = [], ref: number[] = []

  // The GPU's time per frame, where the browser can measure it: the governor's best guide.
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2')
  const timing: { q: WebGLQuery; level: number }[] = []
  let gpuLast: GpuSample | null = null
  let gpuFresh = false
  let samples = 0
  function pollTiming() {
    if (!timer) return
    while (timing.length) {
      const t = timing[0]
      if (!gl.getQueryParameter(t.q, gl.QUERY_RESULT_AVAILABLE)) break
      const ns = gl.getQueryParameter(t.q, gl.QUERY_RESULT) as number
      if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) { gpuLast = { ms: ns / 1e6, level: t.level }; gpuFresh = true }
      gl.deleteQuery(t.q)
      timing.shift()
    }
  }

  /** The drawing buffer at the step's density, counted from the device pixels so that at the screen's own density it matches them exactly. */
  function size() {
    if (renderer.xr.isPresenting) return
    const dpr = devicePixelRatio || 1
    const exact = device && Math.abs(device[0] - W * dpr) < 1.5 && Math.abs(device[1] - H * dpr) < 1.5 ? device : null
    const [dw, dh] = exact ?? [Math.round(W * dpr), Math.round(H * dpr)]
    const k = step.pr / dpr
    const bw = Math.max(1, Math.round(dw * k)), bh = Math.max(1, Math.round(dh * k))
    renderer.setPixelRatio(1)
    renderer.setSize(bw, bh, false)
    if (!accum || accum.width !== bw || accum.height !== bh) {
      accum?.dispose()
      sample?.dispose()
      accum = new WebGLRenderTarget(bw, bh, { depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter })
      sample = new FramebufferTexture(bw, bh)
    }
    force = true
  }

  /** The canvas's size or density changed: a ladder for it, the same kind of step on it, and the governor learns it again. */
  function rescale() {
    const dpr = devicePixelRatio || 1
    const next = pixelLadder(dpr, coarse, { w: W, h: H })
    if (JSON.stringify(next) !== JSON.stringify(steps)) {
      const was = steps[governor.level]
      steps = next
      const at = steps.findIndex((s) => s.pr <= was.pr)
      governor = new Governor(steps, { level: at < 0 ? steps.length - 1 : at })
      pinned = pin()
    } else governor.reset()
    step = steps[pinned ?? governor.level]
    size()
    opts.onResize(W, H)
  }

  new ResizeObserver(([e]) => {
    const b = e.contentBoxSize?.[0]
    const w = b ? b.inlineSize : canvas.clientWidth, h = b ? b.blockSize : canvas.clientHeight
    if (!w || !h || (w === W && h === H)) return
    W = w; H = h
    rescale()
  }).observe(canvas)
  try {
    new ResizeObserver(([e]) => {
      const d = e.devicePixelContentBoxSize?.[0]
      if (!d || (device && device[0] === d.inlineSize && device[1] === d.blockSize)) return
      device = [d.inlineSize, d.blockSize]
      rescale()
    }).observe(canvas, { box: 'device-pixel-content-box' })
  } catch { /* Safari: worked out from the CSS size */ }
  size()

  /** Draw with the camera shifted by (x, y) of the drawing buffer's pixels. */
  function drawShifted(scene: Scene, camera: Camera, x: number, y: number) {
    const cam = camera as Camera & {
      view?: { enabled: boolean; offsetX: number; offsetY: number; width: number; height: number } | null
      aspect?: number; setViewOffset?: (...a: number[]) => void; clearViewOffset?: () => void; updateProjectionMatrix?: () => void
    }
    const bw = accum!.width, bh = accum!.height
    if (!x && !y) { renderScene(scene, camera); return }
    const v = cam.view
    if (v?.enabled) {
      const ox = v.offsetX, oy = v.offsetY
      // The view's own units: its width spans the drawing buffer's.
      v.offsetX += (x * v.width) / bw
      v.offsetY += (y * v.height) / bh
      cam.updateProjectionMatrix?.()
      renderScene(scene, camera)
      v.offsetX = ox
      v.offsetY = oy
      cam.updateProjectionMatrix?.()
    } else if (cam.setViewOffset && cam.clearViewOffset) {
      // (A view offset sets a perspective camera's aspect to its own: put the camera's back after.)
      const aspect = cam.aspect
      cam.setViewOffset(bw, bh, x, y, bw, bh)
      renderScene(scene, camera)
      cam.clearViewOffset()
      if (aspect !== undefined) { cam.aspect = aspect; cam.updateProjectionMatrix?.() }
    } else renderScene(scene, camera)
  }

  let activeCamera: Camera | null = null
  const cameraListeners = new Set<(camera: Camera) => void>()
  const view: SimView = {
    presence: null,
    get activeCamera() { return view.presence?.activeCamera ?? activeCamera },
    onCameraChange(listener) { cameraListeners.add(listener); return () => cameraListeners.delete(listener) },
    renderer,
    get width() { return W },
    get height() { return H },
    invalidate() { force = true },
    drawInset(scene, camera) {
      if (view.presence?.immersive) return
      const start = performance.now()
      renderer.render(scene, camera)
      insetMs += performance.now() - start
      insetTriangles += renderer.info.render.triangles
      insetCalls += renderer.info.render.calls
    },
    draw(scene, camera, dt) {
      if (contactTest) { recordContacts ??= contactRecorder(scene, camera); recordContacts() }
      if (loadTest) recordFrame()
      view.presence?.update(dt, performance.now())
      if (view.presence?.immersive) camera = view.presence.camera
      const current = view.presence?.activeCamera ?? camera
      if (current !== activeCamera) { activeCamera = current; for (const listener of cameraListeners) listener(current) }
      current.updateMatrixWorld(); listenFrom(current.matrixWorld.elements)
      if (renderer.xr.isPresenting) {
        still = 0; force = true
        renderer.shadowMap.autoUpdate = true
        renderScene(scene, camera)
        return
      }
      insetTriangles = insetCalls = insetMs = 0
      signature(scene, camera, sig)
      const moving = force || changed(sig, prev, EPS_FRAME) || changed(sig, ref, EPS_TOTAL)
      ;[prev, sig] = [sig, prev]
      if (moving || noStill) {
        // One shadow update for the scene; jitter and PTZ inset passes reuse it.
        renderer.shadowMap.autoUpdate = false
        renderer.shadowMap.needsUpdate = true
        force = false
        still = 0
        ref = [...prev]
        pollTiming()
        const q = timer && timing.length < 4 ? gl.createQuery() : null
        if (q) gl.beginQuery(timer!.TIME_ELAPSED_EXT, q)
        renderScene(scene, camera)
        if (q) { gl.endQuery(timer!.TIME_ELAPSED_EXT); timing.push({ q, level: governor.level }) }
        if (!samples) samples = gl.getParameter(gl.SAMPLES) as number
        if (pinned === null) {
          const before = governor.level
          pollTiming()
          const gpu = gpuFresh ? gpuLast : null
          gpuFresh = false
          if (governor.frame(dt, gpu) !== before) { step = steps[governor.level]; size() }
        }
        return
      }
      // Still: one more frame into the average, until it has them all (then the screen keeps it).
      if (still >= STILL_FRAMES) return
      const [x, y] = jitterOf(still)
      drawShifted(scene, camera, x, y)
      renderer.copyFramebufferToTexture(sample!)
      if (still === 0 && gl.getError() !== gl.NO_ERROR) { noStill = true; force = true; return }
      blend.uniforms.tMap.value = sample
      blend.blendAlpha = 1 / (still + 1)
      const auto = renderer.autoClear
      renderer.autoClear = false
      renderer.setRenderTarget(accum)
      renderer.render(blendScene, quadCam)
      renderer.setRenderTarget(null)
      renderer.autoClear = auto
      show.uniforms.tMap.value = accum!.texture
      renderer.render(showScene, quadCam)
      still++
    },
    gfx: () => ({
      triangles: triangles + insetTriangles, calls: calls + insetCalls, renderMs: renderMs + insetMs,
      css: [W, H], buffer: [accum?.width ?? 0, accum?.height ?? 0], pr: step.pr, dpr: devicePixelRatio || 1, level: pinned ?? governor.level,
      steps, pinned: pinned !== null, samples, gpuMs: gpuLast?.ms ?? null, still,
    }),
  }
  Object.assign(window, { __gfx: () => view.gfx() })
  if (new URLSearchParams(location.search).get('debug')?.split(',').includes('gfx')) readout(view)
  return view
}

/** ?debug=gfx: a small readout in the corner of how the sim draws, to check a real device. */
function readout(view: SimView) {
  const box = document.createElement('pre')
  box.setAttribute('aria-hidden', 'true')
  Object.assign(box.style, {
    position: 'fixed', left: '10px', bottom: '10px', zIndex: '90', margin: '0', padding: '8px 10px', borderRadius: '10px',
    background: 'rgb(4 2 14 / 0.82)', border: '1px solid rgb(179 164 255 / 0.3)', color: '#e9e4ff',
    font: '500 11.5px/1.45 ui-monospace, "JetBrains Mono", monospace', whiteSpace: 'pre-wrap', pointerEvents: 'none',
  })
  document.body.appendChild(box)
  setInterval(() => {
    const g = view.gfx()
    box.textContent = [
      `gfx    step ${g.level + 1}/${g.steps.length}${g.pinned ? ' (held)' : ''}: ${g.pr}x pixels`,
      `       canvas ${g.css.map((v) => Math.round(v)).join('x')} css, buffer ${g.buffer.join('x')} (dpr ${g.dpr})`,
      `       msaa ${g.samples}, gpu ${g.gpuMs === null ? 'n/a' : `${g.gpuMs.toFixed(2)} ms`}, still ${g.still}/${STILL_FRAMES}`,
    ].join('\n')
  }, 200)
}
