/**
 * Live previews on the sim catalogue's cards. One WebGL renderer draws each card's small scene in turn and copies it
 * into the card's own canvas, so the page holds one GPU context however many cards it shows. Only cards on screen draw,
 * at up to 30 frames a second (a card under the pointer at the screen's full rate); under reduced motion each draws one
 * still frame; nothing draws while the tab is hidden. three.js loads once the first card comes into view.
 */
import type { Preview } from './devices/view'

export interface PreviewSlot {
  canvas: HTMLCanvasElement
  load: () => Promise<Preview>
  /** Under the pointer: draws every frame. */
  hot?: boolean
}

interface Live { slot: PreviewSlot; preview: Preview | null; loading: boolean; visible: boolean; drawn: boolean; ctx: CanvasRenderingContext2D | null }

const MAX_DPR = 2
/** The slowest a visible preview updates, and the most it may fall behind in one step (s). */
const FRAME_MS = 1000 / 30
const MAX_DT = 0.05

export function mountPreviews(slots: readonly PreviewSlot[]): { stop(): void } {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const lives: Live[] = slots.map((slot) => ({ slot, preview: null, loading: false, visible: false, drawn: false, ctx: slot.canvas.getContext('2d') }))
  let three: typeof import('three') | null = null
  let renderer: import('three').WebGLRenderer | null = null
  let env: import('three').Texture | null = null
  let starting: Promise<void> | null = null
  let failed = false
  let raf = 0
  let last = 0
  let lastDraw = 0

  /** three.js, one renderer and the reflections every preview shares. */
  const start = () => (starting ??= (async () => {
    try {
      const [T, { RoomEnvironment }] = await Promise.all([import('three'), import('three/addons/environments/RoomEnvironment.js')])
      three = T
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
      renderer.toneMapping = T.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1
      renderer.outputColorSpace = T.SRGBColorSpace
      renderer.setClearColor(0x000000, 0)
      const pmrem = new T.PMREMGenerator(renderer), room = new RoomEnvironment()
      env = pmrem.fromScene(room, 0.04).texture
      room.dispose(); pmrem.dispose()
    } catch {
      failed = true
    }
  })())

  /** Each canvas at its size on the page, in device pixels. */
  const size = (l: Live) => {
    const c = l.slot.canvas
    const dpr = Math.min(MAX_DPR, devicePixelRatio || 1)
    const w = Math.max(1, Math.round(c.clientWidth * dpr))
    const h = Math.max(1, Math.round(c.clientHeight * dpr))
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; l.drawn = false }
  }

  const draw = (l: Live, t: number, dt: number) => {
    if (!renderer || !three || !l.preview || !l.ctx) return
    const c = l.slot.canvas
    const cam = l.preview.camera
    const buf = renderer.getSize(new three.Vector2())
    if (buf.x < c.width || buf.y < c.height) renderer.setSize(Math.max(buf.x, c.width), Math.max(buf.y, c.height), false)
    const full = renderer.getSize(new three.Vector2())
    l.preview.step(t, dt)
    cam.aspect = c.width / c.height
    cam.updateProjectionMatrix()
    renderer.setViewport(0, 0, c.width, c.height)
    renderer.clear()
    renderer.render(l.preview.scene, cam)
    // The viewport sits at the bottom left of the drawing buffer (GL's origin), the top left of a 2D canvas's.
    l.ctx.clearRect(0, 0, c.width, c.height)
    l.ctx.drawImage(renderer.domElement, 0, full.y - c.height, c.width, c.height, 0, 0, c.width, c.height)
    if (!l.drawn) { l.drawn = true; c.closest('.dcard-stage')?.classList.add('live') }
  }

  const frame = (now: number) => {
    raf = 0
    if (document.hidden || failed) return
    const dt = last ? Math.min(MAX_DT, (now - last) / 1000) : 1 / 30
    last = now
    const due = now - lastDraw >= FRAME_MS - 2
    if (due) lastDraw = now
    const t = now / 1000
    for (const l of lives) {
      if (!l.visible || !l.preview) continue
      if (reduce) { if (!l.drawn) { size(l); draw(l, 4, 0) } continue }
      if (!due && !l.slot.hot) continue
      size(l)
      draw(l, t, due ? Math.max(dt, FRAME_MS / 1000) : dt)
    }
    if (!reduce && lives.some((l) => l.visible && l.preview)) raf = requestAnimationFrame(frame)
  }
  const wake = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(frame) }

  const load = async (l: Live) => {
    if (l.preview || l.loading) return
    l.loading = true
    await start()
    if (failed || !three) return
    try {
      l.preview = await l.slot.load()
      l.preview.scene.environment = env
      wake()
    } catch {
      // A preview that doesn't load leaves its card's still picture.
    }
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const l = lives.find((x) => x.slot.canvas === e.target)
      if (!l) continue
      l.visible = e.isIntersecting
      if (l.visible) void load(l)
    }
    wake()
  }, { rootMargin: '160px 0px' })
  for (const l of lives) io.observe(l.slot.canvas)
  const onVisibility = () => { last = 0; wake() }
  document.addEventListener('visibilitychange', onVisibility)
  addEventListener('resize', wake)

  return {
    stop() {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      removeEventListener('resize', wake)
      if (raf) cancelAnimationFrame(raf)
      renderer?.dispose()
      env?.dispose()
    },
  }
}
