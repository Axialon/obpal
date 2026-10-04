/**
 * Where the home page's marble field plays, called by the guarded home suite (src/landing/scope.ts):
 *   - On a phone the field plays only in the hero: its canvas scrolls with the page, no lower section or heading is a
 *     collider, the field is asleep (no physics, no drawing) once the hero is out of view, and the marble is where it
 *     was, moving on, when the hero comes back: no jump, no landing ring, never a lift, a landing or a dock.
 *   - The marbles toggle and the sound peg work on a phone, with the hero in view and out of it.
 *   - `?fieldscope=page` gives a phone the whole-page field again; a tablet and a computer always have it.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PHONES = [
  { name: '390x844', viewport: { width: 390, height: 844 } },
  { name: '360x800', viewport: { width: 360, height: 800 } },
  { name: '844x390 sideways', viewport: { width: 844, height: 390 } },
]
const MOBILE = { isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true }

async function until(what, fn, timeout = 20000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}

/** The home page on a phone-sized (or other) screen, its field up and the opening over. */
async function open(browser, local, context, query = '') {
  const ctx = await browser.newContext({ ...context, ignoreHTTPSErrors: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${local.origin}/${query}`)
  await until('the 3D field', () => page.evaluate(() => document.documentElement.classList.contains('field3d') && window.__home?.tips().length))
  await until('the opening to finish', () => page.evaluate(() => !window.__home.sim().busy), 60000)
  return { ctx, page, errors }
}

/** Scroll to `y` over `ms` in real frames (a drag's worth of intermediate offsets), then let the page settle. */
async function scrollThrough(page, y, ms = 700) {
  await page.evaluate(({ y, ms }) => new Promise((resolve) => {
    const from = scrollY, begin = performance.now()
    const step = (t) => {
      const p = Math.min(1, (t - begin) / ms)
      scrollTo(0, from + (y - from) * p)
      if (p < 1) requestAnimationFrame(step); else resolve()
    }
    requestAnimationFrame(step)
  }), { y, ms })
  await sleep(150)
}

/** Record the marble's phase, ring and position each frame until `stop()` is called on the page. */
const watch = (page) => page.evaluate(() => {
  const log = window.__phoneScope = { frames: [], on: true }
  const frame = () => {
    if (!log.on) return
    log.frames.push({ scroll: scrollY, tips: window.__home.tips().map((t) => ({ id: t.id, x: t.x, y: t.y, phase: t.phase, ring: t.ring, h: t.h })) })
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
})
const unwatch = (page) => page.evaluate(() => { window.__phoneScope.on = false; return window.__phoneScope.frames })

const counters = (page) => page.evaluate(() => ({ draws: window.__home.activity().draws, t: window.__home.sim().t, busy: window.__home.sim().busy, scroll: scrollY }))

/** Start the lime marble rolling along the open floor between the headline and the buttons (the hero in view, at the top). */
const roll = (page) => page.evaluate(() => {
  const h1 = document.querySelector('.hero h1').getBoundingClientRect(), cta = document.querySelector('.hero .cta').getBoundingClientRect()
  window.__home.roll(innerWidth * 0.15, (h1.bottom + cta.top) / 2, 320, 0)
})

export async function runHomePhoneScope(browser, local, check) {
  for (const phone of PHONES) {
    await check(`phone field scope ${phone.name}: plays in the hero, sleeps below it, and carries on from where it was when the hero returns`, async () => {
      const { ctx, page, errors } = await open(browser, local, { ...phone, ...MOBILE })
      try {
        const vh = phone.viewport.height
        // The canvas is laid on the page (it scrolls away with the hero), not over every screen of it.
        const position = await page.locator('.hero-stage').evaluate((el) => getComputedStyle(el).position)
        if (position !== 'absolute') throw new Error(`the hero's canvas is ${position}, not on the page`)
        if (!(await page.evaluate(() => document.documentElement.classList.contains('field-hero')))) throw new Error('the field did not take the hero scope on a phone')

        // In the hero the field plays: the marble rolls, the clock runs and frames are drawn.
        await roll(page)
        const playing = await counters(page)
        await until('frames while the marble rolls', async () => { const c = await counters(page); return c.draws > playing.draws + 5 && c.t > playing.t + 0.1 }, 8000)

        // Scrolling the hero out: the marble rolls on, carried by the page like its letters, never lifted, landed or docked.
        await roll(page)
        await watch(page)
        await scrollThrough(page, vh * 1.35)
        const away = await unwatch(page)
        const phases = new Set(away.flatMap((f) => f.tips.map((t) => t.phase)))
        if ([...phases].some((p) => p && p !== 'ground')) throw new Error(`the marble left the ground while scrolling: ${[...phases]}`)
        if (away.some((f) => f.tips.some((t) => t.ring))) throw new Error('a landing ring showed while scrolling')
        const cover = await page.locator('.hero-stage').evaluate((el) => el.getBoundingClientRect().bottom)
        if (cover > 0) throw new Error(`the hero's canvas is still on screen (bottom ${cover})`)

        // Out of view: no physics, no drawing, however long it waits.
        await sleep(400)
        const asleep = await counters(page)
        const parked = await page.evaluate(() => window.__home.tips().map((t) => ({ id: t.id, x: t.x, y: t.y })))
        await sleep(1300)
        const later = await counters(page)
        const still = await page.evaluate(() => window.__home.tips().map((t) => ({ id: t.id, x: t.x, y: t.y })))
        if (later.draws !== asleep.draws) throw new Error(`${later.draws - asleep.draws} frames drawn with the hero out of view`)
        if (later.t !== asleep.t) throw new Error(`the marbles' clock ran ${later.t - asleep.t} s with the hero out of view`)
        if (later.busy) throw new Error('the loop was still running with the hero out of view')
        if (JSON.stringify(parked) !== JSON.stringify(still)) throw new Error(`a marble moved with the hero out of view: ${JSON.stringify(parked)} then ${JSON.stringify(still)}`)

        // No lower section or heading is a collider: the field knows only the hero's own things.
        const owners = await page.evaluate(() => window.__home.contacts().rects.map((r) => r.owner))
        const lower = owners.filter((o) => /scene|build-card|sec-head/.test(o))
        if (lower.length) throw new Error(`lower sections are colliders on a phone: ${lower.join(' | ')}`)
        // (The hero's own: its three buttons, the hint, the three steps' icons, the sound and marbles pegs, the dot, the eyebrow's lines.)
        const lines = owners.length
        if (lines > 16) throw new Error(`${lines} colliders: the page's headings and cards seem to be built`)

        // Back in the hero: the field wakes and the marble goes on from where it was, smoothly.
        await watch(page)
        await scrollThrough(page, 0, 900)
        await until('the field to wake', async () => { const c = await counters(page); return c.draws > later.draws + 3 && c.t > later.t }, 8000)
        await sleep(500)
        const back = await unwatch(page)
        const moving = back.filter((f) => f.scroll < vh - 70)
        if (!moving.length) throw new Error('no frames with the hero in view on the way back')
        let jump = 0
        const first = moving[0].tips.find((t) => t.id === 'me')
        jump = Math.max(jump, Math.hypot(first.x - parked.find((t) => t.id === 'me').x, first.y - parked.find((t) => t.id === 'me').y))
        for (let i = 1; i < moving.length; i++) {
          const a = moving[i - 1].tips.find((t) => t.id === 'me'), b = moving[i].tips.find((t) => t.id === 'me')
          jump = Math.max(jump, Math.hypot(b.x - a.x, b.y - a.y))
        }
        if (jump > 18) throw new Error(`the marble jumped ${jump.toFixed(1)} px coming back`)
        const phasesBack = new Set(back.flatMap((f) => f.tips.map((t) => t.phase)))
        if ([...phasesBack].some((p) => p && p !== 'ground')) throw new Error(`the marble left the ground coming back: ${[...phasesBack]}`)
        if (back.some((f) => f.tips.some((t) => t.ring))) throw new Error('a landing ring burst when the hero came back')
        if (errors.length) throw new Error(errors.join(' | '))
        return `asleep: 0 frames, 0 s; back: max step ${jump.toFixed(1)} px, ground only, no ring; ${lines} colliders`
      } finally { await ctx.close() }
    })
  }

  await check('phone field scope: the marbles toggle and the sound peg work with the hero in view and out of it', async () => {
    const { ctx, page, errors } = await open(browser, local, { viewport: { width: 390, height: 844 }, ...MOBILE })
    try {
      const toggle = page.locator('[data-field-toggle]'), sound = page.locator('[data-sound]')
      await until('the sound peg', () => sound.isVisible())
      for (const y of [0, 1200]) {
        if (y) await scrollThrough(page, y)
        for (const peg of [toggle, sound]) {
          const box = await peg.boundingBox()
          if (!box || box.y < 0 || box.y + box.height > 844) throw new Error(`a peg is off the screen at scroll ${y}: ${JSON.stringify(box)}`)
        }
        // The sound peg changes its state with a tap.
        const was = await sound.getAttribute('data-state')
        await sound.tap()
        await until('the sound peg to answer', async () => (await sound.getAttribute('data-state')) !== was, 4000)
      }
      // Off below the hero, still off back at the top; on again, and the marble is there to play.
      await toggle.tap()
      if ((await toggle.getAttribute('aria-pressed')) !== 'false') throw new Error('the toggle did not switch the marbles off')
      if (await page.locator('.hero-stage').isVisible()) throw new Error('the canvas stayed up after the marbles went off')
      await scrollThrough(page, 0)
      if ((await toggle.getAttribute('aria-pressed')) !== 'false') throw new Error('the marbles came back by themselves')
      await toggle.tap()
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') throw new Error('the toggle did not switch the marbles on')
      await until('the field to draw again', () => page.evaluate(() => window.__home.activity().draws > 0 && document.documentElement.classList.contains('field3d')))
      if (errors.length) throw new Error(errors.join(' | '))
      return 'toggle and sound answer at scroll 0 and below the hero'
    } finally { await ctx.close() }
  })

  await check('phone field scope: a tap in the hero hops the marble to it, a tap below the canvas does not', async () => {
    const { ctx, page } = await open(browser, local, { viewport: { width: 390, height: 844 }, ...MOBILE })
    try {
      // The hero, a little scrolled: a tap on the canvas lands where it is on the page (on the open floor between the
      // headline and the buttons, 290 px down it).
      await scrollThrough(page, 120, 300)
      const at = { x: 200, y: 290 - 120 }
      await page.touchscreen.tap(at.x, at.y)
      const near = await until('the marble to hop onto the tap', () => page.evaluate(({ x, y }) => {
        const t = window.__home.tips().find((m) => m.id === 'me')
        return t && Math.hypot(t.x - x, t.y - (y + scrollY)) < 40
      }, at), 8000).catch(() => false)
      if (!near) throw new Error('the marble did not hop to a tap on the canvas, with the page scrolled')
      // A tap on what's below the canvas (the sections that came up under the hero) is a tap on them.
      await scrollThrough(page, 600, 300)
      await until('the marble to rest', () => page.evaluate(() => !window.__home.sim().busy), 15000)
      // A spot below the canvas that is not a control (a tap on one would be that, not a hop).
      const spot = await page.evaluate(() => {
        for (let y = innerHeight - 12; y > innerHeight / 2; y -= 12) for (let x = 24; x < innerWidth - 24; x += 24) {
          const el = document.elementFromPoint(x, y)
          if (y + scrollY > 900 && el && !el.closest('a, button, input, textarea, select, [contenteditable], .scene-art, .scene, .build-card, .quick-tray')) return { x, y }
        }
        return null
      })
      if (!spot) throw new Error('no plain spot below the canvas to tap')
      const before = await page.evaluate(() => window.__home.tips().find((m) => m.id === 'me'))
      await page.touchscreen.tap(spot.x, spot.y)
      await sleep(600)
      const after = await page.evaluate(() => window.__home.tips().find((m) => m.id === 'me'))
      if (Math.hypot(after.x - before.x, after.y - before.y) > 1) throw new Error('a tap below the canvas moved the marble')
      return 'a tap on the canvas hops it, one below does not'
    } finally { await ctx.close() }
  })

  const wide = [
    { name: 'a phone asked for the whole page (?fieldscope=page)', context: { viewport: { width: 390, height: 844 }, ...MOBILE }, query: '?fieldscope=page' },
    { name: 'a tablet', context: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }, query: '' },
    { name: 'a computer', context: { viewport: { width: 1280, height: 800 } }, query: '' },
    { name: 'a computer asked for the hero (?fieldscope=hero): ignored', context: { viewport: { width: 1280, height: 800 } }, query: '?fieldscope=hero' },
  ]
  for (const w of wide) {
    await check(`phone field scope: ${w.name} keeps the field over the whole page`, async () => {
      const { ctx, page, errors } = await open(browser, local, w.context, w.query)
      try {
        const { position, scoped } = await page.evaluate(() => ({ position: getComputedStyle(document.querySelector('.hero-stage')).position, scoped: document.documentElement.classList.contains('field-hero') }))
        if (position !== 'fixed' || scoped) throw new Error(`the canvas is ${position}${scoped ? ' and scoped to the hero' : ''}`)
        const owners = await page.evaluate(() => window.__home.contacts().rects.map((r) => r.owner))
        if (!owners.some((o) => /scene|build-card/.test(o))) throw new Error('the lower sections are not colliders')
        // Scrolled well past the hero, the field still follows the page.
        await scrollThrough(page, w.context.viewport.height * 1.3)
        await until('the field to follow the scroll', () => page.evaluate(() => window.__home.activity().scroll > 100), 8000)
        const c = await counters(page)
        await page.evaluate(() => window.__home.roll(innerWidth * 0.3, innerHeight * 0.6, 200, 0))
        await until('the field to draw below the hero', async () => (await counters(page)).draws > c.draws + 3, 8000)
        if (errors.length) throw new Error(errors.join(' | '))
        return `fixed canvas, ${owners.length} colliders, follows the scroll`
      } finally { await ctx.close() }
    })
  }
}
