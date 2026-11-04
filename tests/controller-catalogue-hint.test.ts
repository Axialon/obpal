import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogueHintPosition, placeCatalogueHint } from '../src/controller/catalogue-hint'
import { setUiRotation, uiRect, uiSize } from '../src/controller/uiframe'
import { readText } from './devtools-node.mjs'

const target = { left: 529.6875, top: 186.09375, width: 66.6875, height: 52 }
const bubble = { left: 0, top: 0, width: 202, height: 52 }
// Saved control geometry and a conservative free-band fixture; native evidence must measure the actual pad.
const frame = () => ({ size: { w: 667, h: 375 }, pad: { left: 16, top: 16, width: 339, height: 343 }, part: null as typeof target | null, gestures: { left: 42, top: 284, width: 286, height: 59 }, blocked: [] as typeof target[] })
const overlaps = (a: typeof target, b: typeof target) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top

afterEach(() => { setUiRotation(0); vi.unstubAllGlobals() })

describe('controller catalogue coaching hint', () => {
  it('keeps the caret and full float excursion clear of saved Stop, modes and pad legend', () => {
    const f = frame(), p = catalogueHintPosition(target, bubble, f)!
    expect(p).toEqual({ left: 141, top: 186.09375, side: 'left', arrow: 26, detached: true })
    const envelope = { left: p.left - 8, top: p.top - 4, width: bubble.width + 16, height: bubble.height + 4 }
    const stop = { left: 371, top: 186.09375, width: 76, height: 52 }
    const modes = { left: 378, top: 119.09375, width: 266, height: 48 }
    expect([stop, modes, target, f.gestures].some(r => overlaps(envelope, r))).toBe(false)
    expect(envelope.left + envelope.width).toBeLessThan(f.pad.left + f.pad.width)
  })

  it('points from the mirrored trackpad band toward the actual catalogue button', () => {
    const f = frame(); f.pad.left = 312
    expect(catalogueHintPosition({ ...target, left: 70.625 }, bubble, f))
      .toEqual({ left: 324, top: 186.09375, side: 'right', arrow: 26, detached: true })
  })

  it('uses UI-frame geometry while the physical viewport is counter-rotated', () => {
    vi.stubGlobal('innerWidth', 375); vi.stubGlobal('innerHeight', 667); setUiRotation(90)
    const rotated = (r: typeof target) => ({ getBoundingClientRect: () => ({ left: 375 - r.top - r.height, top: r.left, right: 375 - r.top, bottom: r.left + r.width }) }) as unknown as Element
    const f = frame(); f.size = uiSize(); f.pad = uiRect(rotated(f.pad))
    const p = catalogueHintPosition(uiRect(rotated(target)), bubble, f)!
    expect(p.left).toBeCloseTo(141); expect(p.top).toBeCloseTo(186.09375); expect(p.side).toBe('left')
  })

  it('retains legacy placement outside compact landscape trackpad geometry', () => {
    const f = frame(); f.size = { w: 390, h: 844 }
    expect(catalogueHintPosition(target, bubble, f)).toBeNull()
    expect(catalogueHintPosition(target, bubble, { ...frame(), pad: null })).toBeNull()
  })

  it('reports an occupied or undersized band as legacy fallback rather than a clearance claim', () => {
    const f = frame(); f.blocked = [{ left: 180, top: 190, width: 60, height: 40 }]
    expect(catalogueHintPosition(target, bubble, f)).toBeNull()
    f.blocked = []; f.part = { left: 30, top: 150, width: 200, height: 70 }
    expect(catalogueHintPosition(target, bubble, f)).toBeNull()
  })

  it.each([{ top: 306, height: 52 }, { top: 0, height: 20 }])('retains legacy placement when the caret cannot point at the real anchor %j', change => {
    expect(catalogueHintPosition({ ...target, ...change }, bubble, frame())).toBeNull()
  })

  it.each(['nstrip', 'ns-tag'])('excludes the actual visible %s wrapper and ignores its hidden state', id => {
    class ElementFixture {
      id = ''; offsetParent = {}; hidden = false; opacity = 1; pointerEvents = 'auto'; entering = false; children: Record<string, ElementFixture> = {}
      classList = { contains: (name: string) => name === 'in' && this.entering }
      constructor(readonly r: typeof target) {}
      closest() { return this.hidden ? this : null }
      getBoundingClientRect() { return { ...this.r, right: this.r.left + this.r.width, bottom: this.r.top + this.r.height } }
      querySelectorAll(selector: string) { return Object.entries(this.children).filter(([key]) => selector.includes(`#${key}`)).map(([, value]) => value) }
    }
    const f = frame(), pad = new ElementFixture(f.pad), legend = new ElementFixture(f.gestures), wrapper = new ElementFixture({ left: 180, top: 190, width: 60, height: 40 })
    wrapper.id = id
    wrapper.pointerEvents = id === 'ns-tag' ? 'none' : 'auto'
    pad.children[id] = wrapper
    vi.stubGlobal('HTMLElement', ElementFixture); vi.stubGlobal('innerWidth', 667); vi.stubGlobal('innerHeight', 375)
    vi.stubGlobal('document', { getElementById: (key: string) => key === 'pad' ? pad : key === 'gestures' ? legend : null })
    vi.stubGlobal('getComputedStyle', (el: ElementFixture) => ({ opacity: String(el.opacity), pointerEvents: el.pointerEvents }))
    expect(placeCatalogueHint(target, bubble)).toBeNull()
    wrapper.hidden = true
    expect(placeCatalogueHint(target, bubble)).not.toBeNull()
    wrapper.hidden = false; wrapper.opacity = 0
    if (id === 'ns-tag') {
      expect(placeCatalogueHint(target, bubble)).not.toBeNull()
      wrapper.pointerEvents = 'auto'
      expect(placeCatalogueHint(target, bubble)).toBeNull()
      wrapper.pointerEvents = 'none'
      wrapper.entering = true
      expect(placeCatalogueHint(target, bubble)).toBeNull()
      wrapper.entering = false; wrapper.opacity = .2
      expect(placeCatalogueHint(target, bubble)).toBeNull()
    } else expect(placeCatalogueHint(target, bubble)).toBeNull()
  })

  it('registers the genuine Models anchor with the unchanged message, delay and body mount', () => {
    const source = readText('src/controller/main.ts'), start = source.indexOf("    hint('models'"), end = source.indexOf('\n', start)
    const model = {}, scene = {}, position = () => null
    let captured: any
    new Function('document', 'hint', 'placeCatalogueHint', source.slice(start, end))({ querySelector: (selector: string) => selector.includes('[data-id="model"]') ? model : scene }, (id: string, anchor: () => unknown, text: string, opts: unknown) => { captured = { id, target: anchor(), text, opts } }, position)
    expect(captured.target).toBe(model)
    expect(captured).toMatchObject({ id: 'models', text: 'Browse the catalogue', opts: { delay: 9000, place: 'top', position } })
    expect(captured.opts.mount).toBeUndefined()
  })

  it('does not teach the catalogue lesson by opening an unrelated tray select', () => {
    const line = readText('src/controller/main.ts').split('\n').find(l => l.includes("if (c.type === 'select') {") && l.includes('openPicker(c)'))!
    const dismissed: string[] = [], opened: string[] = []
    const run = new Function('c', 'dismissHint', 'openPicker', line)
    for (const id of ['lighting', 'model']) run({ id, type: 'select' }, (value: string) => dismissed.push(value), (c: { id: string }) => opened.push(c.id))
    expect(opened).toEqual(['lighting', 'model']); expect(dismissed).toEqual(['models'])
  })
})
