import { describe, expect, it } from 'vitest'
import { readText, runScript } from './devtools-node.mjs'

const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, left: x, right: x + width, top: y, bottom: y + height })

/** Execute the production viewport reader with a real-size unproved swatch and a natural-notice stand-in. */
function clearanceFixture() {
  const state = { active: true, quiet: true, noticeY: 16, obstructClose: false }
  const scope: any = { className: 'sheet settings', getBoundingClientRect: () => rect(16, 72, 288, 652) }
  const button = (label: string, box: ReturnType<typeof rect>, palette = false) => ({
    textContent: label, parentElement: scope, getBoundingClientRect: () => box, getAttribute: () => label,
    closest(selector: string) { return selector === 'button' ? this : null },
    matches: (selector: string) => selector.includes('bb-accent') ? palette : selector.includes('data-offered-stop') ? label === 'Stop' : false,
    querySelector: () => null, querySelectorAll: () => [],
  })
  const stop = button('Stop', rect(28, 140, 264, 100)), close = button('Close', rect(248, 80, 44, 44)), palette = button('Palette', rect(50, 300, 36, 36), true)
  const controls = [stop, close, palette]
  scope.querySelectorAll = () => controls
  scope.querySelector = (selector: string) => selector.includes('data-offered-stop') ? stop : selector.includes('set-close') ? close : null
  const trust = { getBoundingClientRect: () => rect(16, state.noticeY, 288, 48), querySelector: () => state.quiet ? {} : null, closest: () => null }
  const root = { scrollWidth: 320, hasAttribute: () => state.active }
  const document = {
    documentElement: root,
    querySelector: (selector: string) => selector.includes('data-id="trust"') ? state.active ? trust : null : scope,
    querySelectorAll: () => state.active ? [trust] : [],
    elementFromPoint(x: number, y: number) {
      if (state.obstructClose && x > 248 && y < 124) return trust
      const n = trust.getBoundingClientRect()
      if (state.active && y >= n.top && y <= n.bottom) return trust
      return controls.find(el => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom }) ?? null
    },
  }
  const source = readText('scripts/phone-mobile-layout.mjs'), start = source.indexOf('  const measure = '), end = source.indexOf('  const finish = ', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const phone = { evaluate: (fn: (mode: boolean) => unknown, arg: boolean) => fn(arg) }
  const style = (el: unknown) => ({ visibility: 'visible', opacity: '1', overflowX: 'visible', getPropertyValue: () => el === root ? state.active ? '48px' : '0px' : '' })
  const run = new Function('phone', 'document', 'window', 'innerWidth', 'innerHeight', 'getComputedStyle', 'NodeFilter', `${source.slice(start, end)}; return measure`)(phone, document, { __mobileEffectiveHits: [], __mobileTrace: [] }, 320, 740, style, { SHOW_TEXT: 4 })
  return { state, run }
}

describe('phone early notice clearance', () => {
  it('keeps the actual palette module geometry dependency for sampling and restoration', () => {
    const result = runScript('tests/phone-palette-module.mjs', [])
    expect(result.status, result.out).toBe(0)
    expect(JSON.parse(result.out)).toEqual({ realGeometryReads: 4, samplingReached: true, restorationReached: true, browserLaunched: false })
  })

  it('proves the live notice and Stop/Close without claiming unmeasured palette targets', async () => {
    const f = clearanceFixture(), row = await f.run(true)
    expect(row.issues).toEqual([])
    expect(row.clearanceOnly).toBe(true)
    expect(row.notices.trust.quiet).toBe(true)
    expect(row.notices.trust.visible).toBe(true)
    expect(row.notices.reservedHeight).toBe(48)
    expect(row.headerTargets.every((target: { owned: boolean }) => target.owned)).toBe(true)
  })

  it('keeps the full 44px ownership gate after the early observation', async () => {
    const f = clearanceFixture(), row = await f.run(false)
    expect(row.issues).toContain('Palette:44px effective hit ownership unproved')
  })

  it('rejects an expired or nonquiet trust notice rather than accepting an empty stack', async () => {
    for (const field of ['active', 'quiet'] as const) {
      const f = clearanceFixture(); f.state[field] = false
      expect((await f.run(true)).issues).toContain('live quiet trust notice absent')
    }
  })

  it('rejects a live notice covering Stop', async () => {
    const f = clearanceFixture(); f.state.noticeY = 150
    expect((await f.run(true)).issues).toContain('Stop: notice overlaps visible control')
  })

  it('rejects Close whose centre is owned by another layer', async () => {
    const f = clearanceFixture(); f.state.obstructClose = true
    expect((await f.run(true)).issues).toContain('Close: header target not owned')
  })
})

describe('phone copy group exposure', () => {
  const run = () => {
    const source = readText('scripts/phone-mobile-layout.mjs'), start = source.indexOf('function scrollSettingsCopy('), end = source.indexOf('\n/** Prove', start)
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    return new Function(`${source.slice(start, end)}; return scrollSettingsCopy`)()
  }
  const fixture = (large = false) => {
    const sheet: any = { scrollTop: 0, getBoundingClientRect: () => rect(16, 56, 288, 668) }
    const nodes = [0, 1, 2].map(i => ({ id: `copy-${i}`, getBoundingClientRect: () => rect(37, 900 + i * (large ? 250 : 80) - sheet.scrollTop, 246, large ? 240 : 70) }))
    sheet.querySelector = (selector: string) => ({ getBoundingClientRect: () => selector.includes('sheet-head') ? rect(17, 57, 286, 171) : rect(17, 642, 286, 81) })
    sheet.contains = (el: unknown) => nodes.includes(el as typeof nodes[number])
    return { sheet, ids: nodes.map(n => n.id), env: { innerHeight: 740, document: { querySelector: () => sheet, getElementById: (id: string) => nodes.find(n => n.id === id) } } }
  }

  it('uses ordinary scrollTop to reveal every grouped row between sticky header and footer', () => {
    const f = fixture(), result = run()({ ids: f.ids, scroll: true }, f.env)
    expect(f.sheet.scrollTop).toBeGreaterThan(0)
    expect(result.fullyVisible).toBe(true)
    expect(result.rows).toHaveLength(3)
    expect(run()({ ids: f.ids, scroll: false }, f.env).to).toBe(f.sheet.scrollTop)
  })

  it('reports a group that cannot fit without resizing or hiding the footer', () => {
    const f = fixture(true), result = run()({ ids: f.ids, scroll: true }, f.env)
    expect(result.hasRoom).toBe(false)
    expect(result.fullyVisible).toBe(false)
    expect(f.sheet.scrollTop).toBe(0)
  })
})

describe('phone settled copy capture', () => {
  /** Replay the saved lower-group reflow through the actual capture and scroll functions. */
  const fixture = (laterGrowth = 0, moving = false) => {
    const source = readText('scripts/phone-mobile-layout.mjs'), state = { fitted: false, reads: 0, clock: 0, scroll: 168 }
    const frames: any[] = []
    const initial = [[3064.734375, 58], [3138.734375, 70.796875], [3225.53125, 107.484375]]
    const settled = [[3072.71875, 65], [3153.71875, 80.78125], [3250.5, 117.46875]]
    const sheet: any = { getBoundingClientRect: () => rect(16, 56, 288, 668) }
    Object.defineProperty(sheet, 'scrollTop', { get: () => state.scroll, set: value => { state.scroll = Math.round(value) } })
    const nodes = initial.map((_, i) => ({ id: `lower-${i}`, getBoundingClientRect: () => {
      const [top, height] = (state.fitted ? settled : initial)[i]
      const growth = i === 2 && state.fitted ? moving ? state.reads * 2 : state.reads >= 3 ? laterGrowth : 0 : 0
      return rect(37, top - state.scroll, 246, height + growth)
    } }))
    sheet.querySelector = (selector: string) => ({ getBoundingClientRect: () => selector.includes('sheet-head') ? rect(17, 139, 286, 171.59375) : rect(17, 642, 286, 81) })
    sheet.contains = (el: unknown) => nodes.includes(el as typeof nodes[number])
    const env = { innerHeight: 740, document: { querySelector: () => sheet, getElementById: (id: string) => nodes.find(n => n.id === id) } }
    const phone = { evaluate: async (fn: (args: unknown, env: unknown) => unknown, args: unknown) => {
      state.reads++
      const row = fn(args, env); state.fitted = true
      return row
    } }
    const untilStart = source.indexOf('async function until('), untilEnd = source.indexOf('\n}', untilStart) + 2
    const scrollStart = source.indexOf('function scrollSettingsCopy('), scrollEnd = source.indexOf('\n/** Prove', scrollStart)
    const captureStart = source.indexOf('  const copyView = '), captureEnd = source.indexOf('  const closeLayers = ', captureStart)
    expect(untilStart).toBeGreaterThan(0); expect(scrollEnd).toBeGreaterThan(scrollStart); expect(captureEnd).toBeGreaterThan(captureStart)
    const run = new Function('sleep', 'Date', 'stableBox', 'phone', 'measure', 'capture', `${source.slice(untilStart, untilEnd)}\n${source.slice(scrollStart, scrollEnd)}\n${source.slice(captureStart, captureEnd)}; return copyView`)(
      async (ms: number) => { state.clock += ms }, { now: () => state.clock }, async () => {}, phone,
      async () => ({ issues: [] }), async (_: string, row: unknown) => { frames.push(row) },
    )
    return { state, frames, run: () => run('saved-lower-group', nodes.map(n => n.id)) }
  }

  it('recentres the settled saved group once while retaining strict before and after exposure', async () => {
    const f = fixture(); await f.run()
    expect(f.frames).toHaveLength(1)
    const row = f.frames[0]
    expect(row.copyScroll.rows.at(-1).bottom).toBeCloseTo(610.015625)
    expect(row.copySettled.rows.at(-1).bottom).toBeCloseTo(644.96875)
    expect(row.copyRecenter.to).toBe(2744)
    expect(row.copyExposure.before.fullyVisible).toBe(true)
    expect(row.copyExposure.after.fullyVisible).toBe(true)
    expect(row.issues).toEqual([])
  })

  it('waits for later rows to settle even when the first row position stays still', async () => {
    const f = fixture(32); await f.run()
    expect(f.frames[0].copySettled.rows.at(-1).height).toBeCloseTo(149.46875)
    expect(f.frames[0].copyExposure.before.fullyVisible).toBe(true)
    expect(f.frames[0].copyExposure.after.fullyVisible).toBe(true)
  })

  it('fails within the existing bound when whole-group geometry keeps changing', async () => {
    const f = fixture(0, true)
    await expect(f.run()).rejects.toThrow('timed out: Settings copy group geometry')
    expect(f.frames).toHaveLength(0)
    expect(f.state.clock).toBe(1500)
  })
})

describe('catalogue live hint evidence', () => {
  const fixture = () => {
    const state = { present: true, oldPosition: false, extension: true, detached: true, arrowPainted: false, emphasized: true, ringPainted: true, described: true }
    const modelRect = rect(529.6875, 186.09375, 66.6875, 52), stopRect = rect(371, 186.09375, 76, 52), modeRect = rect(426, 119.09375, 44, 48)
    const control = (id: string, r: typeof modelRect, area: string) => ({ id, dataset: { id }, tagName: 'BUTTON', parentElement: null, getBoundingClientRect: () => r, closest(selector: string) { return selector === `.${area}` || selector.startsWith('button') ? this : null }, contains(node: unknown) { return node === this }, matches: () => id === 'model' || id === 'mobile-stop' })
    const model = control('model', modelRect, 'tray'), stop = control('mobile-stop', stopRect, 'tray'), mode = control('mode', modeRect, 'modes')
    Object.assign(model, { classList: { contains: (name: string) => name === 'hint-anchor' && state.emphasized }, getAttribute: () => state.described ? 'existing obpal-hint-models' : 'existing' })
    const controls = [model, stop, mode, control('center', rect(602, 308, 44, 46), 'dock'), control('settings', rect(600, 21, 44, 44), 'bar')]
    const pad = { id: 'pad', offsetParent: {}, getBoundingClientRect: () => rect(16, 16, 339, 343), querySelectorAll: () => [], closest(selector: string) { return selector === '#pad' ? this : null } }, legend = { id: 'gestures', getBoundingClientRect: () => rect(42, 284, 286, 59), closest: () => null }
    const bubble = () => state.oldPosition ? rect(452.640625, 122.09375, 202.359375, 52) : rect(141, 186.09375, 202, 52)
    const close = { id: 'hint-x', getBoundingClientRect: () => { const r = bubble(); return rect(r.x + r.width - 45, r.y + 12, 28, 28) }, contains(node: unknown) { return node === this }, closest() { return this } }
    const hint = { getBoundingClientRect: bubble, classList: { contains: (s: string) => s === 'hint-detached' ? state.detached : s === (state.oldPosition ? 'hint-top' : 'hint-left') }, querySelector: (s: string) => s === '.hint-text' ? { textContent: 'Browse the catalogue', id: 'obpal-hint-models' } : close, contains: (node: unknown) => node === close }
    const document = {
      querySelectorAll: (s: string) => s.startsWith('.hint') ? state.present ? [hint] : [] : s.startsWith('#surface') ? controls : [legend],
      querySelector: (s: string) => s === '#pad' ? pad : s === '#gestures' ? legend : s === '#app' || s === '#pad-part' ? null : model,
      elementFromPoint: (x: number, y: number) => {
        const c = close.getBoundingClientRect()
        const inset = state.extension ? 8 : 0
        if (state.present && x >= c.left - inset && x <= c.right + inset && y >= c.top - inset && y <= c.bottom + inset) return close
        return controls.find(el => { const r = el.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom }) ?? pad
      },
    }
    const source = readText('scripts/phone-mobile-layout.mjs'), start = source.indexOf('function catalogueHintState()'), end = source.indexOf('\n/** Prove', start)
    const style = (el: unknown, pseudo?: string) => pseudo ? el === hint ? { content: '""', display: state.arrowPainted ? 'block' : 'none' } : { content: '""', position: 'absolute', left: '-8px', top: '-8px', right: '-8px', bottom: '-8px', width: '44px', height: '44px', borderRadius: '0px', pointerEvents: 'auto' } : { opacity: '1', visibility: 'visible', pointerEvents: 'none', overflowX: 'visible', overflowY: 'visible', borderColor: 'rgb(49, 184, 224)', boxShadow: state.ringPainted ? 'rgb(49, 184, 224) 0px 0px 0px 2px inset' : 'none', getPropertyValue: (name: string) => name === '--accent-rgb' ? '49 184 224' : state.oldPosition ? '110.390625px' : '26px' }
    const run = new Function('document', 'getComputedStyle', 'innerWidth', 'innerHeight', 'matchMedia', `${source.slice(start, end)}; return catalogueHintState`)(document, style, 667, 375, () => ({ matches: true }))
    return { state, run }
  }

  it('requires a genuine positive hint with owned Models/Stop and clear paint/effective-close envelopes', () => {
    const row = fixture().run()
    expect(row.hint.positive).toBe(true); expect(row.issues).toEqual([])
    expect(row.controls).toHaveLength(5); expect(row.controls.every((c: { owned: boolean }) => c.owned)).toBe(true)
  })

  it('measures the suppressed decorative arrow, painted brand ring and accessible note on the actual Models anchor', () => {
    const row = fixture().run()
    expect(row.hint.cue).toMatchObject({ detached: true, arrowHidden: true, anchorEmphasized: true, anchorRingPainted: true, described: true, noteId: 'obpal-hint-models' })
    expect(row.hint.caret.painted).toBe(false)
  })

  it.each(['detached', 'emphasized', 'ringPainted', 'described'] as const)('rejects missing actual cue evidence: %s', key => {
    const f = fixture(); f.state[key] = false
    expect(f.run().issues).toContain('detached catalogue cue not associated with actual Models')
  })

  it('rejects a decorative arrow that still paints despite the detached class', () => {
    const f = fixture(); f.state.arrowPainted = true
    expect(f.run().issues).toContain('detached catalogue hint still paints a decorative arrow')
  })

  it('rejects an empty hint state instead of accepting the fresh-case timing gap', () => {
    const f = fixture(); f.state.present = false
    expect(f.run().issues).toContain('genuine visible catalogue hint absent')
  })

  it('rejects a declared44px close box when its real extension does not own the sampled points', () => {
    const f = fixture(); f.state.extension = false
    const row = f.run()
    expect(row.hint.close.owned).toBe(true)
    expect(row.hint.close.effective.width).toBe(44)
    expect(row.hint.close.samples.some((sample: { owned: boolean }) => !sample.owned)).toBe(true)
    expect(row.issues).toContain('catalogue hint close44px extension ownership unproved')
  })

  it('rejects the saved top-position paint overlap even though the body passes pointer input through', () => {
    const f = fixture(); f.state.oldPosition = true; f.state.detached = false; f.state.arrowPainted = true
    const row = f.run()
    expect(row.controls.find((c: { id: string }) => c.id === 'mode').owned).toBe(true)
    expect(row.issues).toContain('mode: catalogue hint covers exposed control')
    expect(row.issues).toContain('catalogue hint uses legacy placement in affected trackpad case')
    expect(row.hint.caret).toMatchObject({ axis: 'x', coordinate: 563.03125, matches: true })
    expect(row.issues).not.toContain('catalogue caret axis misses actual Models anchor')
  })

  it('retains the actual case after-snapshot through the production shallow capture shape', async () => {
    const source = readText('scripts/phone-mobile-layout.mjs'), start = source.indexOf("    await checked('mobile: genuine catalogue hint"), end = source.indexOf("    await checked('mobile: the phone and actual viewer", start)
    const saved: any[] = [], options: any[] = []
    let reads = 0
    function catalogueHintState() {}
    const phone = { setViewportSize: async () => {}, emulateMedia: async () => {}, bringToFront: async () => {}, mouse: { move: async () => {} },
      waitForFunction: async (_: unknown, __: unknown, opts: unknown) => { options.push(opts) }, evaluate: async (fn: unknown) => fn === catalogueHintState ? { at: ++reads, issues: [], hint: { positive: true } } : 0 }
    const run = new Function('checked', 'proof', 'closeLayers', 'phone', 'offer', 'capture', 'catalogueHintState', `return (async () => {${source.slice(start, end)}})()`)
    await run(async (_: string, fn: () => Promise<unknown>) => fn(), { expect: async () => {} }, async () => {}, phone, async () => {}, async (name: string, row: object, opts: unknown) => { saved.push({ name, ...row }); options.push(opts) }, catalogueHintState)
    const retained = JSON.parse(JSON.stringify(saved[0]))
    expect(retained.hintCapture.after).toMatchObject({ at: 2, hint: { positive: true } })
    expect(options).toContainEqual({ timeout: 25000 }); expect(options).toContainEqual({ animations: 'allow' })
  })
})

describe('phone mobile fixture routing', () => {
  /** Run the actual connection fixture prelude without a browser or storage clock. */
  const route = (phoneOnly?: string, failure?: Error) => {
    const source = readText('scripts/phone-connections.mjs')
    const start = source.indexOf("    await phone.locator('.modes').waitFor({ timeout: 25000 }).catch(async error => {")
    const end = source.indexOf("    await check('the in-app scanner", start)
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const events: string[] = []
    const phone = { locator: () => ({ waitFor: async () => { events.push('ready') } }) }
    const record = (event: string) => async () => { events.push(event) }
    const mobile = async () => { events.push('mobile'); if (failure) throw failure }
    const run = new Function('phone', 'open', 'rename', 'close', 'mobileLayoutEvidence', 'process', 'a', 'check', 'proof', `return (async () => {${source.slice(start, end)}})()`)
    return { events, done: run(phone, record('open'), record('rename'), record('close'), mobile, { env: { OBPAL_E2E_PHONE_ONLY: phoneOnly } }, {}, {}, {}) }
  }

  it('observes mobile evidence before restoring the unique saved-screen identity', async () => {
    const f = route('mobile'); await f.done
    expect(f.events).toEqual(['ready', 'mobile', 'open', 'rename', 'close'])
  })

  it.each(['connections', undefined])('preserves saved-screen preparation for the normal %s route', async phoneOnly => {
    const f = route(phoneOnly); await f.done
    expect(f.events).toEqual(['ready', 'open', 'rename', 'close'])
  })

  it('preserves a mobile evidence failure without entering rename work', async () => {
    const failure = new Error('live quiet trust notice absent'), f = route('mobile', failure)
    await expect(f.done).rejects.toBe(failure)
    expect(f.events).toEqual(['ready', 'mobile'])
  })

  it('loads the shared recovery document and clock before filterable cases', async () => {
    const source = readText('scripts/phone-connections.mjs')
    const owner = source.indexOf('async function pendingRecovery(')
    const start = source.indexOf('  try {', owner) + '  try {'.length
    const end = source.indexOf("    await check('pending pairing stays", start)
    expect(owner).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const events: string[] = []
    const page = { goto: async (url: string) => { events.push(url) }, clock: { install: async () => { events.push('clock installed') } } }
    const run = new Function('page', 'origin', `return (async () => {${source.slice(start, end)}})()`)
    await run(page, 'https://example.test')
    expect(events).toEqual(['https://example.test/p/', 'clock installed'])
  })
})

describe('phone Options arrival boundary', () => {
  /** Execute the shared arrival waits while a connection handover replaces its closing chooser. */
  const arrive = (duplicate = false) => {
    const source = readText('scripts/phone-connections.mjs'), owner = source.indexOf('async function enterController(')
    const start = source.indexOf('  try {', owner) + '  try {'.length
    const end = source.indexOf("    if (await page.locator('#surface')", start)
    expect(owner).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const events: string[] = [], waits: unknown[] = [], selectors: string[] = []
    let closing = 0
    const document = { querySelector: (selector: string) => { selectors.push(selector); return closing-- > 0 ? {} : null } }
    const failure = new Error('strict mode: two active Options sheets')
    const page = {
      locator: (selector: string) => ({ waitFor: async (options: unknown) => {
        events.push(selector); waits.push(options)
        if (selector === 'dialog.connection-wrap[open]') closing = 1
        else if (duplicate) throw failure
      } }),
      waitForFunction: async (predicate: () => boolean, _arg: unknown, options: unknown) => {
        events.push('closing chooser removal'); waits.push(options)
        for (let i = 0; i < 3; i++) if (predicate()) return
        throw new Error('closing chooser remained attached')
      },
    }
    const run = new Function('page', 'document', `return (async () => {${source.slice(start, end)}})()`)
    return { events, waits, selectors, failure, done: run(page, document) }
  }

  it('settles connection handover and removed choosers before requiring one visible entry', async () => {
    const f = arrive(); await f.done
    expect(f.events).toEqual(['dialog.connection-wrap[open]', 'closing chooser removal', '.ctl-sheet[data-controller-entry]'])
    expect(f.waits).toEqual([{ state: 'hidden', timeout: 5000 }, { timeout: 5000 }, { timeout: 25000 }])
    expect(f.selectors).toEqual(['.ctl-wrap.out', '.ctl-wrap.out'])
  })

  it('preserves strict failure when two active choosers remain after handover', async () => {
    const f = arrive(true)
    await expect(f.done).rejects.toBe(f.failure)
    expect(f.events).toEqual(['dialog.connection-wrap[open]', 'closing chooser removal', '.ctl-sheet[data-controller-entry]'])
  })
})
