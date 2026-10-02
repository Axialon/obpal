/**
 * Live previews on the sim catalogue's cards. One WebGL renderer draws each card's small scene in turn and copies it
 * into the card's own canvas, so the page holds one GPU context however many cards it shows. Only cards on screen draw,
 * at up to 30 frames a second; under reduced motion each draws one
 * still frame; nothing draws while the tab is hidden. three.js loads once the first card comes into view.
 */
import { dotLoading } from '../ui/kit/loading'
import type { Preview } from './devices/view'

export interface PreviewSlot {
  canvas: HTMLCanvasElement
  load: () => Promise<Preview>
}

interface Live { slot: PreviewSlot; preview: Preview | null; loading: boolean; visible: boolean; drawn: boolean; frames: number; time: number; ctx: CanvasRenderingContext2D | null }

const MAX_DPR = 2
/** The slowest a visible preview updates, and the most it may fall behind in one step (s). */
const FRAME_MS = 1000 / 30
const MAX_DT = 0.05

export function mountPreviews(slots: readonly PreviewSlot[]) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  const lives: Live[] = slots.map((slot) => ({ slot, preview: null, loading: false, visible: false, drawn: false, frames: 0, time: 0, ctx: slot.canvas.getContext('2d') }))
  let three: typeof import('three') | null = null
  let renderer: import('three').WebGLRenderer | null = null
  let env: import('three').Texture | null = null
  let starting: Promise<void> | null = null
  let failed = false
  let raf = 0
  let stopped = false

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
    l.frames++
    if (!l.drawn) { l.drawn = true; const host = c.closest<HTMLElement>('.dcard-stage'); host?.classList.add('live'); if (host) dotLoading(host, false) }
  }

  const frame = (now: number) => {
    raf = 0
    if (document.hidden || failed || stopped) return
    const t = now / 1000
    for (const l of lives) {
      if (!l.visible || !l.preview || !onScreen(l)) continue
      size(l)
      if (motion.matches) { if (!l.drawn) draw(l, 4, 0); continue }
      if (now - l.time < FRAME_MS) continue
      draw(l, t, l.time ? Math.min(MAX_DT, (now - l.time) / 1000) : 1 / 30)
      l.time = now
    }
    if (!motion.matches && lives.some((l) => l.visible && l.preview && onScreen(l))) raf = requestAnimationFrame(frame)
  }
  const wake = () => { if (!raf && !document.hidden && !stopped) raf = requestAnimationFrame(frame) }
  const onScreen = (l: Live) => {
    const r = l.slot.canvas.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth
  }

  const load = async (l: Live) => {
    if (l.preview || l.loading) return
    l.loading = true
    const host = l.slot.canvas.closest<HTMLElement>('.dcard-stage')
    if (host) dotLoading(host, true, 'Preparing preview', 32)
    await start()
    if (failed || !three || stopped) { if (host) dotLoading(host, false); return }
    try {
      l.preview = await l.slot.load()
      l.preview.scene.environment = env
      wake()
    } catch {
      if (host) dotLoading(host, false)
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
  })
  for (const l of lives) io.observe(l.slot.canvas)
  const refresh = () => {
    for (const l of lives) {
      l.visible = onScreen(l)
      if (l.visible) void load(l)
    }
    wake()
  }
  const onVisibility = () => { lives.forEach(l => { l.time = 0 }); refresh() }
  const resized = new ResizeObserver(() => { lives.forEach(size); refresh() })
  for (const l of lives) resized.observe(l.slot.canvas)
  document.addEventListener('visibilitychange', onVisibility)
  motion.addEventListener('change', wake)

  return {
    refresh,
    stats: () => ({ renderers: renderer ? 1 : 0, cards: lives.map(l => ({ id: l.slot.canvas.closest<HTMLElement>('.dcard')?.dataset.id, visible: l.visible && onScreen(l), loaded: !!l.preview, frames: l.frames })) }),
    stop() {
      stopped = true
      lives.forEach(l => { const host = l.slot.canvas.closest<HTMLElement>('.dcard-stage'); if (host) dotLoading(host, false) })
      io.disconnect()
      resized.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      motion.removeEventListener('change', wake)
      if (raf) cancelAnimationFrame(raf)
      renderer?.dispose()
      env?.dispose()
    },
  }
}
