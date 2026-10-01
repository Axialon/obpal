import { afterEach, expect, it, vi } from 'vitest'
import { DotLoader } from '../packages/host/src/dot-field'

class Element extends EventTarget {
  className = ''
  isConnected = true
  style: Record<string, string | ((key: string, value: string) => void)> = { setProperty: (key, value) => { this.style[key] = value } }
  attributes = new Map<string, string>()
  children: Element[] = []
  setAttribute(key: string, value: string) { this.attributes.set(key, value) }
  append(...children: Element[]) { this.children.push(...children) }
  getClientRects() { throw new Error('A loader frame must not measure layout') }
}

function environment(reduced = false) {
  const frames = new Map<number, FrameRequestCallback>(), doc = new EventTarget() as Document
  const media = Object.assign(new EventTarget(), { matches: reduced })
  let id = 0, intersect = (_visible: boolean) => {}, disconnected = false
  Object.defineProperty(doc, 'hidden', { value: false, writable: true })
  Object.defineProperty(doc, 'createElement', { value: () => new Element() })
  Object.defineProperty(doc, 'defaultView', { value: {
    requestAnimationFrame: (frame: FrameRequestCallback) => { frames.set(++id, frame); return id },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  } })
  vi.stubGlobal('document', doc)
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { intersect = visible => callback([{ isIntersecting: visible }]) }
    observe() {}
    disconnect() { disconnected = true }
  })
  return { doc, media, frames, intersect: (visible: boolean) => intersect(visible), disconnected: () => disconnected,
    step(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame(now)) } }
}

afterEach(() => vi.unstubAllGlobals())

it('starts idempotently on the shared absolute phase, writes no layout, and ends busy work', () => {
  const e = environment(), loader = new DotLoader({ size: 16, label: 'Making a QR code' })
  loader.start(); loader.start()
  expect(e.frames.size).toBe(1)
  e.step(1000)
  const dots = (loader.el as unknown as Element).children
  const phase = dots.map(dot => dot.style.transform)
  loader.start(); e.step(1000)
  expect(dots.map(dot => dot.style.transform)).toEqual(phase)
  expect((loader.el as unknown as Element).attributes.get('aria-busy')).toBe('true')
  loader.finish()
  expect(e.frames.size).toBe(0)
  expect((loader.el as unknown as Element).attributes.get('aria-busy')).toBe('false')
  loader.destroy()
  expect(e.disconnected()).toBe(true)
})

it('keeps a static reduced frame and releases offscreen subscriptions', () => {
  const e = environment(true), loader = new DotLoader({ size: 240 })
  expect(e.frames.size).toBe(0)
  expect((loader.el as unknown as Element).children.every(dot => dot.style.transform === 'none' && dot.style.opacity === '1')).toBe(true)
  e.media.matches = false; e.media.dispatchEvent(new Event('change'))
  expect(e.frames.size).toBe(1)
  e.intersect(false)
  expect(e.frames.size).toBe(0)
  e.intersect(true); e.step(1600)
  expect(e.frames.size).toBe(1)
  loader.destroy()
  expect(e.frames.size).toBe(0)
})
