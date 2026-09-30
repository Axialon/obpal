/** Recovery uses fresh pages and per-page WebGL failures, never browser graphics settings. */
import { chromium } from 'playwright'
import { failGraphics, GRAPHICS_SCENES } from './lib/graphics-failure.mjs'
import { checkFrost, setSurface } from './lib/frost.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const copy = '3D graphics are unavailable in this browser. Open this scene in a browser or device that supports WebGL.'

async function open(browser, origin, scene, kind, width = 390, search = '') {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  await failGraphics(context, kind)
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    window.__stageContexts = 0
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const result = original.call(this, type, ...args)
      if (this.id === 'stage' && /^webgl/.test(type) && result) window.__stageContexts++
      return result
    }
  })
  const page = await context.newPage()
  const seen = { errors: [], loads: 0 }
  page.on('pageerror', error => seen.errors.push(error.message))
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) seen.loads++ })
  await page.goto(`${origin}/sim/${scene}/${search}`, { waitUntil: 'domcontentloaded' })
  return { context, page, seen }
}

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#stage')?.dataset.simReady === 'true', null, { timeout: 30000 })
}

async function stableError(page, seen) {
  await page.locator('#sim-recovery [role="alert"]').waitFor({ timeout: 15000 })
  assert(await page.locator('#sim-recovery [role="alert"]').textContent() === copy, 'wrong graphics diagnosis')
  assert(await page.locator('#sim-recovery button').count() === 0, 'a graphics failure offers a futile retry')
  assert(!await page.locator('#sim-load').isVisible(), 'the loading status stayed busy')
  assert(!await page.locator('.sim-window:visible, .panel-dock:visible, .obpal-chip:visible, .quick-tray:visible').count(), 'inert scene actions remained visible')
  assert(await page.locator('#sim-recovery h1').textContent(), 'page identity was lost')
  assert(await page.locator('#sim-recovery .sim-lede').textContent(), 'explanatory content was lost')
  assert(seen.errors.length === 0, 'the failed start escaped the page boundary')
}

/** The sims suite covers all affected entries, slow models, failed models/imports and bounded session-safe retry. */
export async function runGraphicsRecovery(local, check) {
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--ignore-certificate-errors'] })
  try {
    for (const scene of GRAPHICS_SCENES) for (const width of [390, 1280]) await check(`graphics recovery: ${scene} at ${width}px`, async () => {
      const { context, page, seen } = await open(browser, local.origin, scene, 'context', width)
      try {
        await stableError(page, seen)
        if (width === 390) { await sleep(16000); await stableError(page, seen) }
        assert(seen.loads === 1, 'graphics failure reloaded itself')
        const exit = page.getByRole('link', { name: 'Back to sims', exact: true })
        assert(await exit.evaluate(el => el === document.activeElement), 'focus did not reach the escape')
        await page.keyboard.press('Enter')
        await page.waitForURL('**/sim/')
      } finally { await context.close() }
    })

    for (const scene of ['drone', 'studio', 'lamp']) await check(`graphics recovery: ${scene} still initializes normally`, async () => {
      const { context, page, seen } = await open(browser, local.origin, scene, 'normal', 1280)
      try {
        await ready(page)
        await page.waitForFunction(() => !!window.__obpal?.pairingUrl, null, { timeout: 25000 })
        assert(await page.locator('#dev-units li, #dev-units .sim-window').count() > 0, 'units are absent')
        assert(await page.locator('#dev-faces button').count() > 0 && !!await page.locator('#dev-how').textContent(), 'controller guidance is absent')
        assert(!await page.locator('#sim-recovery').count(), 'normal graphics were labelled as failed')
        assert(seen.errors.length === 0, 'normal initialization threw')
      } finally { await context.close() }
    })

    for (const kind of ['slow', 'model', 'import']) for (const width of [390, 1280]) await check(`graphics recovery: ${kind} asset at ${width}px`, async () => {
      const { context, page, seen } = await open(browser, local.origin, 'drone', kind, width)
      try {
        if (kind === 'slow') {
          await sleep(1200)
          assert(await page.locator('#sim-load').isVisible(), 'slow download did not show progress')
          assert(!await page.locator('#sim-recovery').count(), 'slow download was called a failure')
          await ready(page)
          await page.waitForFunction(() => performance.getEntriesByName('obpal:drone:visible').length > 0, null, { timeout: 30000 })
          assert(!await page.locator('#sim-recovery').count(), 'slow download ended in recovery')
        } else {
          await page.locator(`#sim-recovery[data-kind="${kind === 'model' ? 'model' : 'scene'}"]`).waitFor({ timeout: 20000 })
          if (kind === 'model') {
            await ready(page)
            assert(await page.locator('#dev-faces button').count() > 0, 'usable fallback lost its controls')
          } else {
            // Existing deploy recovery may reload once; the new build must settle in an actionable state.
            await sleep(4000)
            assert(!await page.locator('#sim-load').isVisible(), 'failed import stayed busy')
            assert(!await page.locator('.sim-window:visible, .quick-tray:visible').count(), 'failed import left live-looking actions')
          }
          assert(!(await page.locator('#sim-recovery').textContent()).includes('WebGL'), 'asset failure was labelled unsupported graphics')
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow')
      } finally { await context.close() }
    })

    await check('graphics recovery: a failed model retries once, with a fresh page and no stacked renderers', async () => {
      const { context, page, seen } = await open(browser, local.origin, 'drone', 'model', 1280)
      try {
        await ready(page)
        const retry = page.getByRole('button', { name: 'Reload scene' })
        await retry.waitFor()
        assert(await page.evaluate(() => window.__stageContexts) === 1, 'initial page started multiple renderers')
        await retry.click()
        await page.waitForFunction(() => document.querySelector('#sim-recovery button')?.disabled, null, { timeout: 20000 })
        await ready(page)
        await sleep(1500)
        assert(seen.loads === 2, `retry made ${seen.loads} page loads`)
        assert(await page.locator('#stage').count() === 1, 'multiple stage canvases')
        assert(await page.evaluate(() => window.__stageContexts) === 1, 'replacement page started multiple renderers')
        const before = await page.evaluate(() => window.__gfx?.().calls)
        await retry.evaluate(el => el.click())
        await sleep(1000)
        assert(seen.loads === 2, 'disabled retry made another page')
        assert(before !== undefined, 'the replacement scene did not draw')
      } finally { await context.close() }
    })

    await check('graphics recovery: model retry preserves a pairing in progress or an active phone', async () => {
      const { context, page, seen } = await open(browser, local.origin, 'drone', 'model', 1280)
      try {
        await ready(page)
        await page.waitForFunction(() => !!window.__obpal)
        for (const status of ['connecting', 'connected']) {
          await page.evaluate(status => { window.__obpal.status = status }, status)
          await page.waitForFunction(() => document.querySelector('#sim-recovery button')?.disabled)
          await page.locator('#sim-recovery button').evaluate(el => el.click())
          await sleep(600)
          assert(seen.loads === 1, `retry replaced a ${status} session`)
        }
      } finally { await context.close() }
    })

    await check('graphics recovery: failed imports cannot reload a shared visitor', async () => {
      const { context, page, seen } = await open(browser, local.origin, 'drone', 'import', 390, '?join=1')
      try {
        await page.locator('#sim-recovery[data-kind="scene"]').waitFor({ timeout: 20000 })
        await sleep(4000)
        assert(seen.loads === 1, 'shared visitor reloaded automatically')
        assert(await page.locator('#sim-recovery button').isDisabled(), 'shared visitor offers a destructive reload')
      } finally { await context.close() }
    })
    await check('graphics recovery: arena insignia failure keeps the procedural scene usable', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
      try {
        await context.route('**/models/cvc/*.glb', route => route.abort())
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/arena/`)
        await page.locator('#sim-recovery[data-kind="model"]').waitFor({ timeout: 20000 })
        await ready(page)
        assert(await page.evaluate(() => window.__arena.slots.length) === 4, 'failed insignia removed the player slots')
        assert(!(await page.locator('#sim-recovery').textContent()).includes('WebGL'), 'insignia failure was called a graphics failure')
      } finally { await context.close() }
    })
  } finally { await browser.close() }
}

/** Pages exercises the accessible recovery surface at the narrow and desktop widths in every existing theme. */
export async function runGraphicsRecoveryLayouts(browser, origin, check) {
  for (const width of [320, 390, 1280]) await check(`graphics recovery: keyboard, themes and reduced motion at ${width}px`, async () => {
    const { context, page, seen } = await open(browser, origin, 'drone', 'context', width)
    try {
      await stableError(page, seen)
      for (const theme of ['carbon', 'navy', 'violet', 'wine', 'onyx', 'light']) {
        await setSurface(page, theme)
        const layout = await page.locator('#sim-recovery').evaluate(el => {
          const rect = el.getBoundingClientRect(), exit = el.querySelector('a').getBoundingClientRect()
          return { inside: rect.left >= 0 && rect.right <= innerWidth && exit.bottom <= innerHeight, overflow: el.scrollWidth > el.clientWidth,
            motion: getComputedStyle(document.querySelector('#stage')).transitionDuration, color: getComputedStyle(el).color }
        })
        assert(layout.inside && !layout.overflow, `${theme}: recovery does not fit`)
        // The site's existing reduced-motion rule uses 0.01 ms so transition completion still fires.
        assert(layout.motion.split(',').every(duration => parseFloat(duration) <= .00002), `${theme}: reduced motion was ignored (${layout.motion})`)
        assert(layout.color, `${theme}: theme tokens missing`)
        await checkFrost(page, '#sim-recovery', { text: ['h1', 'p', 'a'] })
      }
      const exit = page.getByRole('link', { name: 'Back to sims', exact: true })
      await exit.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
      assert(await exit.evaluate(el => el === document.activeElement), 'keyboard cannot reach the exit')
      await page.keyboard.press('Enter'); await page.waitForURL('**/sim/')
    } finally { await context.close() }
  })
  for (const width of [320, 390, 1280]) for (const kind of ['slow', 'model', 'import']) await check(`graphics recovery: ${kind} layout at ${width}px`, async () => {
    const { context, page } = await open(browser, origin, 'drone', kind, width)
    try {
      if (kind === 'slow') { await ready(page); assert(!await page.locator('#sim-recovery').count(), 'slow asset was mislabelled') }
      else {
        const card = page.locator('#sim-recovery')
        await card.waitFor({ timeout: 20000 })
        if (kind === 'model') await ready(page)
        else await sleep(4000)
        const usable = await card.evaluate(el => {
          const box = el.getBoundingClientRect(), exit = el.querySelector('a').getBoundingClientRect()
          return box.left >= 0 && box.right <= innerWidth && exit.bottom <= innerHeight && el.scrollWidth <= el.clientWidth
        })
        assert(usable, 'asset recovery does not fit')
        const exit = page.getByRole('link', { name: 'Back to sims', exact: true })
        await exit.focus(); await page.keyboard.press('Enter'); await page.waitForURL('**/sim/')
      }
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'page overflow')
    } finally { await context.close() }
  })
}
