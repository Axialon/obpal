import { afterEach, describe, expect, it, vi } from 'vitest'
import { readText } from './devtools-node.mjs'

/** Only markup rendering is stubbed; the production hint owns positioning, queue, clocks and dismissal. */
async function fixture() {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  const win = new EventTarget(), doc = new EventTarget(), frames: FrameRequestCallback[] = []
  let active: Surface | null = null, notices = 0, noticeChanged = () => {}
  class Surface extends EventTarget {
    className = ''; textContent = ''; hidden = false; parentElement: Surface | null = null; children: Surface[] = []
    attributes = new Map<string, string>(); onclick: ((event: Event) => void) | null = null
    style = { left: '', top: '', setProperty: vi.fn() }
    constructor(readonly tagName: string) { super() }
    get id() { return this.getAttribute('id') ?? '' }
    set id(value: string) { this.setAttribute('id', value) }
    get offsetParent(): Surface | null { return this.hidden ? null : this.parentElement }
    classList = {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
      add: (name: string) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' ') },
      remove: (name: string) => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' ') },
      toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name) },
    }
    getAttribute(name: string) { return this.attributes.get(name) ?? null }
    setAttribute(name: string, value: string) { this.attributes.set(name, value) }
    removeAttribute(name: string) { this.attributes.delete(name) }
    appendChild(child: Surface) { child.parentElement = this; this.children.push(child); return child }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
    contains(node: Surface): boolean { return this === node || this.children.some(child => child.contains(node)) }
    querySelector(selector: string) { return this.children.find(child => selector === 'button' ? child.tagName === 'BUTTON' : child.classList.contains(selector.slice(1))) ?? null }
    getBoundingClientRect() { return this.tagName === 'BUTTON' ? { left: 529, top: 186, width: 67, height: 52 } : { left: 0, top: 0, width: 202, height: 52 } }
    focus() { active = this }
  }
  const body = new Surface('BODY'), model = body.appendChild(new Surface('BUTTON')), scene = body.appendChild(new Surface('BUTTON'))
  const child = model.appendChild(new Surface('SPAN')), seen = new Map<string, string>()
  Object.assign(doc, { body, createElement: (tag: string) => new Surface(tag.toUpperCase()) })
  Object.defineProperty(doc, 'activeElement', { get: () => active })
  vi.stubGlobal('window', Object.assign(win, { setTimeout, clearTimeout })); vi.stubGlobal('document', doc)
  vi.stubGlobal('Node', Surface); vi.stubGlobal('innerWidth', 667); vi.stubGlobal('innerHeight', 375)
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => seen.get(key) ?? null, setItem: (key: string, value: string) => seen.set(key, value) })
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win)); vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win))
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => { frames.push(frame); return frames.length })
  vi.doMock('../src/ui/kit/notice', () => ({ noticeCount: () => notices, onNoticesChange: (callback: () => void) => { noticeChanged = callback } }))
  vi.doMock('../src/ui/markup', async () => ({ ...await vi.importActual<typeof import('../src/ui/markup')>('../src/ui/markup'), setMarkup: (element: Surface) => {
    element.appendChild(new Surface('SPAN')).className = 'hint-text'
    element.appendChild(new Surface('BUTTON')).className = 'hint-x'
  } }))
  const hints = await import('../src/ui/hints')
  let anchor: Surface | null = model, custom: any = { left: 141, top: 186, side: 'left', arrow: 26, detached: true }
  const advance = (ms: number) => { vi.advanceTimersByTime(ms); for (const frame of frames.splice(0)) frame(performance.now()) }
  const show = () => { hints.hint('models', () => anchor as unknown as Element | null, 'Browse the catalogue', { place: 'top', delay: 9000, position: () => custom }); advance(9000) }
  const card = () => body.children.find(el => el.classList.contains('hint') && el.classList.contains('in'))!
  const press = (target: Surface) => { const event = new Event('pointerdown'); Object.defineProperty(event, 'target', { value: target }); doc.dispatchEvent(event) }
  return { ...hints, model, scene, child, seen, card, show, advance, press, active: () => active,
    anchor: (value: Surface | null) => { anchor = value }, custom: (value: unknown) => { custom = value },
    notice: (value: number) => { notices = value; noticeChanged() } }
}

afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  vi.doUnmock('../src/ui/markup'); vi.doUnmock('../src/ui/kit/notice'); vi.resetModules()
})

describe('detached hint association and lifecycle', () => {
  it('identifies the actual anchor with matching emphasis and a text-only accessible description without moving focus', async () => {
    const f = await fixture(); f.scene.focus(); f.model.setAttribute('aria-describedby', 'existing-help'); f.show()
    const card = f.card(), text = card.querySelector('.hint-text')!
    expect(card.classList.contains('hint-detached')).toBe(true)
    expect(f.model.classList.contains('hint-anchor')).toBe(true); expect(f.scene.classList.contains('hint-anchor')).toBe(false)
    expect(text.id).not.toBe(''); expect(text.textContent).toBe('Browse the catalogue')
    expect(f.model.getAttribute('aria-describedby')?.split(' ')).toEqual(['existing-help', text.id])
    expect(f.active()).toBe(f.scene)
    expect(card.style.left).toBe('141px'); expect(card.style.top).toBe('186px')
  })

  it.each([null, { left: 10, top: 20, side: 'bottom', arrow: 30 }])('leaves fallback and ordinary custom hints unchanged for %j', async position => {
    const f = await fixture(); f.custom(position); f.show()
    expect(f.card().classList.contains('hint-detached')).toBe(false)
    expect(f.model.classList.contains('hint-anchor')).toBe(false)
    expect(f.model.getAttribute('aria-describedby')).toBeNull(); expect(f.card().querySelector('.hint-text')!.id).toBe('')
    f.dismissHint('models')
  })

  it('keeps ordinary hints without a custom placement free of emphasis or new ARIA state', async () => {
    const f = await fixture(); f.hint('ordinary', () => f.model as unknown as Element, 'Ordinary hint'); f.advance(0)
    expect(f.card().className).toBe('hint hint-bottom in'); expect(f.model.attributes.size).toBe(0)
    expect(f.card().querySelector('.hint-text')!.id).toBe('')
  })

  it('clears the old anchor on reposition and clears the new one on legacy fallback while preserving other descriptions', async () => {
    const f = await fixture(); f.model.setAttribute('aria-describedby', 'model-help'); f.scene.setAttribute('aria-describedby', 'scene-help'); f.show()
    const id = f.card().querySelector('.hint-text')!.id
    f.anchor(f.scene); f.repositionHints()
    expect(f.model.classList.contains('hint-anchor')).toBe(false); expect(f.model.getAttribute('aria-describedby')).toBe('model-help')
    expect(f.scene.getAttribute('aria-describedby')).toBe(`scene-help ${id}`)
    f.custom(null); f.repositionHints()
    expect(f.scene.classList.contains('hint-anchor')).toBe(false); expect(f.scene.getAttribute('aria-describedby')).toBe('scene-help')
    expect(f.card().classList.contains('hint-detached')).toBe(false); expect(f.card().classList.contains('hint-top')).toBe(true)
    expect(f.card().querySelector('.hint-text')!.id).toBe('')
    expect(f.card().style.left).toBe('453px'); expect(f.card().style.top).toBe('122px')
  })

  it('clears emphasis when the anchor hides and reapplies it only when the hint returns', async () => {
    const f = await fixture(); f.show(); const card = f.card()
    expect(f.model.classList.contains('hint-anchor')).toBe(true)
    f.model.hidden = true; f.repositionHints()
    expect(card.classList.contains('away')).toBe(true); expect(f.model.classList.contains('hint-anchor')).toBe(false)
    expect(f.model.getAttribute('aria-describedby')).toBeNull()
    f.model.hidden = false; f.repositionHints()
    expect(card.classList.contains('away')).toBe(false); expect(f.model.classList.contains('hint-anchor')).toBe(true)
    expect(f.model.getAttribute('aria-describedby')).toBe(card.querySelector('.hint-text')!.id)
  })

  it('clears the previous control when a redraw removes the anchor', async () => {
    const f = await fixture(); f.show(); const card = f.card(); f.anchor(null); f.repositionHints()
    expect(card.classList.contains('away')).toBe(true); expect(f.model.classList.contains('hint-anchor')).toBe(false)
    expect(f.model.getAttribute('aria-describedby')).toBeNull(); expect(card.querySelector('.hint-text')!.id).toBe('')
  })

  it.each(['close', 'timer', 'anchor'])('removes owned state immediately on %s dismissal and keeps the original session lesson', async reason => {
    const f = await fixture(); f.show(); const card = f.card()
    expect(f.model.classList.contains('hint-anchor')).toBe(true)
    if (reason === 'close') card.querySelector('button')!.onclick!(new Event('click'))
    if (reason === 'timer') f.advance(8000)
    if (reason === 'anchor') { f.press(f.scene); expect(f.model.classList.contains('hint-anchor')).toBe(true); f.press(f.child) }
    expect(f.model.classList.contains('hint-anchor')).toBe(false); expect(f.model.getAttribute('aria-describedby')).toBeNull()
    expect(card.querySelector('.hint-text')!.id).toBe(''); expect(card.classList.contains('hint-detached')).toBe(true)
    expect(card.parentElement).not.toBeNull(); expect(f.seen.get('obpal.hint.models')).toBe('1')
    f.advance(260); expect(card.parentElement).toBeNull()
  })

  it('removes only its own description token and emphasis, preserving unrelated edits and pre-existing emphasis', async () => {
    const f = await fixture(); f.model.classList.add('hint-anchor'); f.model.setAttribute('aria-describedby', 'before'); f.show()
    const id = f.card().querySelector('.hint-text')!.id
    f.model.setAttribute('aria-describedby', `external ${id} later`); f.model.classList.add('external')
    f.dismissHint('models'); f.repositionHints(); f.dismissHint('models')
    expect(f.model.getAttribute('aria-describedby')).toBe('external later')
    expect(f.model.classList.contains('hint-anchor')).toBe(true); expect(f.model.classList.contains('external')).toBe(true)
  })

  it('does not remove a pre-existing description token it did not add', async () => {
    const f = await fixture(); f.model.setAttribute('aria-describedby', 'existing obpal-hint-models'); f.show()
    f.dismissHint('models'); expect(f.model.getAttribute('aria-describedby')).toBe('existing obpal-hint-models')
    expect(f.model.classList.contains('hint-anchor')).toBe(false)
  })

  it('waits for notices before applying anchor state and preserves notice/focus clock holds', async () => {
    const f = await fixture(); f.notice(1); f.show()
    expect(f.model.classList.contains('hint-anchor')).toBe(false)
    f.notice(0); f.advance(0); const card = f.card()
    card.dispatchEvent(new Event('focusin')); f.advance(9000); expect(card.classList.contains('in')).toBe(true)
    card.dispatchEvent(new Event('focusout')); f.notice(1); f.advance(9000); expect(card.classList.contains('in')).toBe(true)
    f.notice(0); f.advance(7999); expect(f.model.classList.contains('hint-anchor')).toBe(true)
    f.advance(1); expect(f.model.classList.contains('hint-anchor')).toBe(false)
  })

  it('applies emphasis only after the original queued hint yields, retaining the 700ms handoff and shorter next clock', async () => {
    const f = await fixture(); f.hint('ordinary', () => f.scene as unknown as Element, 'First lesson'); f.advance(0)
    f.hint('models', () => f.model as unknown as Element, 'Browse the catalogue', { position: () => ({ left: 141, top: 186, side: 'left', arrow: 26, detached: true }) })
    f.advance(0); expect(f.model.classList.contains('hint-anchor')).toBe(false)
    f.dismissHint('ordinary'); f.advance(699); expect(f.model.classList.contains('hint-anchor')).toBe(false)
    f.advance(1); expect(f.model.classList.contains('hint-anchor')).toBe(true)
    f.advance(3999); expect(f.model.classList.contains('hint-anchor')).toBe(true)
    f.advance(1); expect(f.model.classList.contains('hint-anchor')).toBe(false)
  })

  it('uses existing accent tokens for an inset anchor ring and suppresses only the detached decorative arrow', () => {
    const base = readText('src/styles/base.css'), controller = readText('src/styles/controller.css')
    expect(base).toMatch(/\.hint\.hint-detached::before\s*\{\s*display:\s*none;/)
    expect(controller).toMatch(/\.tray-btn\.select\.hint-anchor\s*\{[^}]*inset 0 0 0 2px rgb\(var\(--accent-rgb\)\)/)
  })

  it('wins the actual later important select-border rule only while the cue owns its anchor class', () => {
    const css = readText('src/styles/controller.css')
    // These class-only rules are the real border candidates for this control, including the later active-control layer.
    const rules = [...css.matchAll(/(\.tray-btn\.select(?:\.hint-anchor)?)\s*\{([^}]+)\}/g)].flatMap((match, order) => {
      const declaration = /(?:^|;)\s*border-color\s*:\s*([^;]+)/.exec(match[2])?.[1]
      if (!declaration) return []
      const classes = match[1].slice(1).split('.')
      return [{ classes, order, important: /!important\s*$/.test(declaration), color: declaration.replace(/\s*!important\s*$/, '').replace(/\s+/g, '') }]
    })
    const winner = (cue: boolean) => rules.filter(rule => cue || !rule.classes.includes('hint-anchor'))
      .sort((a, b) => Number(a.important) - Number(b.important) || a.classes.length - b.classes.length || a.order - b.order).at(-1)!
    const later = rules.find(rule => rule.important && rule.classes.length === 2)!, cue = rules.find(rule => rule.classes.includes('hint-anchor'))!
    expect(later.order).toBeGreaterThan(cue.order)
    expect(winner(false).color).toBe('rgb(var(--accent-rgb)/0.4)')
    expect(winner(true).color).toBe('rgb(var(--accent-rgb))')
    expect(winner(true).classes).toEqual(['tray-btn', 'select', 'hint-anchor'])
  })
})
