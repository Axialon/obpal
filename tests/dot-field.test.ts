import { afterEach, describe, expect, it, vi } from 'vitest'
import { DotField } from '../packages/host/src/dot-field'
import { glyphDots } from '../packages/core/src/seal-glyphs'

// The recording context observes pixels and pending frames without requiring a browser or a GPU.
function surface(width = 100, height = 60, reduced = false) {
  let now = 0, seq = 0
  const raf = new Map<number, FrameRequestCallback>()
  const document = new EventTarget() as Document
  Object.defineProperty(document, 'hidden', { value: false, writable: true })
  const media = Object.assign(new EventTarget(), { matches: reduced })
  const tokens: Record<string, string> = { '--bb-accent': '#87c4ef', '--bb-surface': '#16202b' }
  const shapes: { x: number; y: number; radius: number; square: boolean; alpha: number; color: string }[] = []
  const backgrounds: string[] = []
  const path: { x: number; y: number; radius: number; square: boolean }[] = []
  const context = {
    globalAlpha: 1, fillStyle: '',
    clearRect() { shapes.length = 0 },
    fillRect() { backgrounds.push(context.fillStyle) }, setTransform() {},
    beginPath() { path.length = 0 },
    moveTo() {},
    arc(x: number, y: number, radius: number) { path.push({ x, y, radius, square: false }) },
    rect(x: number, y: number, size: number) { path.push({ x: x + size / 2, y: y + size / 2, radius: size / 2, square: true }) },
    fill() { shapes.push(...path.map(p => ({ ...p, alpha: context.globalAlpha, color: context.fillStyle }))) },
  }
  const animation = { pause: vi.fn(), play: vi.fn(), cancel: vi.fn() }
  const canvas = Object.assign(new EventTarget(), {
    width: 0, height: 0, ownerDocument: document,
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
    getContext: () => context,
    animate: vi.fn(() => animation),
  }) as unknown as HTMLCanvasElement
  let resize = () => {}, intersect = (_on: boolean) => {}
  let resizeDisconnected = false, intersectionDisconnected = false
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('devicePixelRatio', 2)
  vi.stubGlobal('document', document)
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('getComputedStyle', () => ({ color: '#eeeeee', getPropertyValue: (name: string) => tokens[name] ?? '' }))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = ++seq; raf.set(id, cb); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => raf.delete(id))
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: ResizeObserverCallback) { resize = () => cb([], this as unknown as ResizeObserver) }
    observe() {}
    disconnect() { resizeDisconnected = true }
  })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: IntersectionObserverCallback) { intersect = on => cb([{ isIntersecting: on } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    observe() {}
    disconnect() { intersectionDisconnected = true }
  })
  return {
    canvas, shapes, backgrounds, tokens, raf, animation, media,
    resize(w: number, h: number) { width = w; height = h; resize() },
    intersect(on: boolean) { intersect(on) },
    hidden(value: boolean) { Object.defineProperty(document, 'hidden', { value, writable: true }); document.dispatchEvent(new Event('visibilitychange')) },
    step(time: number) { now = time; const pending = [...raf.values()]; raf.clear(); pending.forEach(cb => cb(now)) },
    disconnected: () => resizeDisconnected && intersectionDisconnected,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('the shared round dot field', () => {
  it('centres a repeatable grid, respects its dot limit and sizes pixels for the display', () => {
    const s = surface(100, 60)
    const field = new DotField(s.canvas, { spacing: 20, maxDots: 10 })
    expect(field.dotCount).toBeGreaterThan(0)
    expect(field.dotCount).toBeLessThanOrEqual(10)
    expect(s.canvas.width).toBe(200)
    expect(s.canvas.height).toBe(120)
    expect(s.shapes.every(p => !p.square && p.radius > 0 && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 60)).toBe(true)
    const positions = s.shapes.map(p => [p.x, p.y])
    field.draw(1000)
    expect(s.shapes.map(p => [p.x, p.y])).toEqual(positions)
    expect(s.raf.size).toBe(0)
    field.destroy()
  })

  it('relayouts normalized glyphs after resizing and releases its observers', () => {
    const s = surface()
    const field = new DotField(s.canvas, { points: [{ x: 0.25, y: 0.5 }, { x: 0.75, y: 0.5 }] })
    expect(s.shapes.map(p => p.x).sort((a, b) => a - b)).toEqual([25, 75])
    s.resize(200, 80)
    expect(s.shapes.map(p => [p.x, p.y]).sort((a, b) => a[0] - b[0])).toEqual([[50, 40], [150, 40]])
    field.effect('ripple', 200)
    expect(s.raf.size).toBe(1)
    field.destroy()
    expect(s.raf.size).toBe(0)
    expect(s.disconnected()).toBe(true)
    const frames = field.frames
    s.resize(500, 500)
    field.effect('assemble')
    expect(field.frames).toBe(frames)
  })

  it('preserves separate round glyph cells at 28 pixels and caps the radius at 64 pixels', () => {
    const s = surface(28, 28)
    const field = new DotField(s.canvas, { points: glyphDots(26), idle: false })
    expect(s.shapes.length).toBe(glyphDots(26).length)
    expect(s.shapes.every(p => p.radius > 0.99 && p.radius < 1)).toBe(true)
    for (const a of s.shapes) for (const b of s.shapes) {
      if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.radius + b.radius)
    }
    s.resize(64, 64)
    expect(s.shapes.every(p => p.radius === 2.1)).toBe(true)
    field.destroy()
  })

  it('ends finite effects without idle redraws and pauses work while offscreen or hidden', () => {
    const s = surface()
    const field = new DotField(s.canvas)
    field.effect('shimmer', 200)
    s.step(100)
    expect(s.raf.size).toBe(1)
    s.intersect(false)
    expect(s.raf.size).toBe(0)
    const frames = field.frames
    field.pointer(50, 30)
    expect(field.frames).toBe(frames)
    s.step(300)
    s.intersect(true)
    expect(s.raf.size).toBe(0)
    field.effect('assemble', 200)
    s.hidden(true)
    expect(s.raf.size).toBe(0)
    s.step(600)
    s.hidden(false)
    expect(s.raf.size).toBe(0)
    expect(s.animation.pause).toHaveBeenCalled()
    field.destroy()
  })

  it('parts and brightens nearby dots once per input while resting without RAF work', () => {
    const s = surface(100, 60)
    const field = new DotField(s.canvas, { points: [{ x: 0.4, y: 0.5 }, { x: 0.9, y: 0.5 }] })
    const near = s.shapes.find(p => p.x === 40)!
    field.pointer(45, 30)
    const parted = s.shapes.find(p => p.x < 40)!
    expect(parted.alpha).toBeGreaterThan(near.alpha)
    expect(s.raf.size).toBe(0)
    field.pointer(null)
    expect(s.shapes.some(p => p.x === 40)).toBe(true)
    field.destroy()
  })

  it('refreshes theme tokens and falls back to the shadow chip accent', () => {
    const s = surface()
    const field = new DotField(s.canvas)
    expect(s.shapes.every(p => p.color === '#87c4ef')).toBe(true)
    delete s.tokens['--bb-accent']
    s.tokens['--a'] = '#f5b253'
    field.refresh()
    expect(s.shapes.every(p => p.color === '#f5b253')).toBe(true)
    field.destroy()
  })

  it('uses a chip accent override ahead of inherited family tokens', () => {
    const s = surface()
    s.tokens['--a'] = '#f5b253'
    const field = new DotField(s.canvas)
    expect(s.shapes.length).toBeGreaterThan(0)
    expect(s.shapes.every(p => p.color === '#f5b253')).toBe(true)
    field.destroy()
  })

  it('uses the chip glass colour as its surface and preserves transparent overlays', () => {
    const s = surface()
    s.tokens['--glass'] = 'rgb(23 32 43 / .8)'
    const field = new DotField(s.canvas)
    expect(s.backgrounds.at(-1)).toBe('rgb(23 32 43 / .8)')
    field.destroy()
    s.backgrounds.length = 0
    const overlay = new DotField(s.canvas, { surface: 'transparent' })
    expect(s.backgrounds).toEqual([])
    overlay.destroy()
  })

  it('uses the readable family accent role while preserving an explicit chip override', () => {
    const s = surface()
    s.tokens['--bb-accent-text'] = '#426b0d'
    const field = new DotField(s.canvas)
    expect(s.shapes.every(p => p.color === '#426b0d')).toBe(true)
    s.tokens['--a'] = '#f5b253'
    field.refresh()
    expect(s.shapes.every(p => p.color === '#f5b253')).toBe(true)
    field.destroy()
  })

  it('finishes every finite effect and remains idle after its last frame', () => {
    for (const kind of ['assemble', 'ripple', 'shimmer', 'handshake'] as const) {
      const s = surface()
      const field = new DotField(s.canvas)
      field.effect(kind, 120)
      s.step(60)
      expect(s.raf.size).toBe(1)
      s.step(120)
      expect(s.raf.size).toBe(0)
      const frames = field.frames
      s.step(1000)
      expect(field.frames).toBe(frames)
      field.destroy()
    }
  })

  it('keeps malformed, empty and oversized input inside the visible canvas and dot budget', () => {
    const s = surface()
    const field = new DotField(s.canvas, { points: [{ x: -1, y: 2 }, { x: NaN, y: 0 }, { x: 0.5, y: Infinity }] })
    expect(s.shapes.map(p => [p.x, p.y])).toEqual([[0, 60]])
    field.setPoints(Array.from({ length: 1000 }, (_, i) => ({ x: i / 1000, y: 0.5 })))
    expect(field.dotCount).toBe(300)
    field.setPoints([])
    expect(s.shapes).toEqual([])
    field.setPoints()
    expect(field.dotCount).toBeGreaterThan(0)
    expect(field.dotCount).toBeLessThanOrEqual(300)
    field.destroy()
  })

  it('does not start a render loop when Canvas 2D is unavailable', () => {
    const s = surface()
    vi.spyOn(s.canvas, 'getContext').mockReturnValue(null)
    const field = new DotField(s.canvas)
    field.effect('ripple')
    expect(s.raf.size).toBe(0)
    field.destroy()
  })

  it('stops an active effect immediately when reduced motion is enabled', () => {
    const s = surface()
    const field = new DotField(s.canvas)
    field.effect('ripple')
    expect(s.raf.size).toBe(1)
    s.media.matches = true
    s.media.dispatchEvent(new Event('change'))
    expect(s.raf.size).toBe(0)
    const frames = field.frames
    field.pointer(10, 10)
    field.tilt(1, 1)
    expect(field.frames).toBe(frames)
    field.destroy()
  })

  it('draws square source modules, one ribbon and final round glyphs on the same canvas without scheduling', () => {
    const s = surface(100, 60)
    const field = new DotField(s.canvas, { points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }], idle: false })
    field.setSource([{ x: 0.3, y: 0.2 }, { x: 0.7, y: 0.8 }])
    field.handshake(0)
    expect(s.shapes.every(p => p.square)).toBe(true)
    expect(s.shapes.map(p => [p.x, p.y])).toEqual([[30, 12], [70, 48]])
    field.handshake(0.42)
    expect(s.shapes.every(p => !p.square && Math.abs(p.y - 30) < 3)).toBe(true)
    field.handshake(1)
    expect(s.shapes.map(p => [p.x, p.y])).toEqual([[20, 30], [80, 30]])
    expect(s.raf.size).toBe(0)
    field.destroy()
  })

  it('preserves a bounded whole QR source and fades its surplus modules before the glyph settles', () => {
    const s = surface(100, 60)
    const targets = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }]
    const field = new DotField(s.canvas, { points: targets, idle: false })
    field.setSource(Array.from({ length: 5000 }, (_, i) => ({ x: ((i % 100) + 0.5) / 100, y: (Math.floor(i / 100) + 0.5) / 50 })))
    field.handshake(0)
    expect(s.shapes.length).toBe(4096)
    expect(field.dotCount).toBe(2)
    expect(s.shapes.every(p => p.square)).toBe(true)
    field.handshake(0.7)
    expect(s.shapes.length).toBe(2)
    field.handshake(1)
    expect(s.shapes.map(p => [p.x, p.y])).toEqual([[20, 30], [80, 30]])
    expect(s.shapes.every(p => p.alpha < 0.8)).toBe(true)
    field.destroy()
  })

  it('uses a final static field and one fade with reduced motion, ignoring pointer and tilt motion', () => {
    const s = surface(100, 60, true)
    const field = new DotField(s.canvas, { points: [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }] })
    const before = s.shapes.map(p => [p.x, p.y, p.alpha])
    field.pointer(20, 30)
    field.tilt(1, -1)
    expect(s.shapes.map(p => [p.x, p.y, p.alpha])).toEqual(before)
    field.handshake(0)
    expect(s.shapes.every(p => !p.square)).toBe(true)
    field.effect('assemble')
    expect(s.raf.size).toBe(0)
    const options = (s.canvas.animate as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1]
    expect(options.iterations ?? 1).toBe(1)
    expect(options.duration).toBeLessThanOrEqual(250)
    field.destroy()
  })
})
