/** Whole-page field proofs, called by the guarded home suite. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareHomeSmoothness, measureHomeSmoothness } from './lib/smoothness-home.mjs'

export async function runHomeField(functionalBrowser, local, check) {
  const only = process.env.OBPAL_E2E_HOME_ONLY || process.argv.find(arg => arg.startsWith('--only='))?.slice(7)
  if (only && !only.includes('viewport field')) return
  // Software WebGL remains in the legacy physics checks. Pacing measures the default GPU path separately.
  const browser = await functionalBrowser.browserType().launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--ignore-certificate-errors'] })
  try {
  const out = process.env.OBPAL_E2E_EVIDENCE_ROOT
  const save = async (name, data) => {
    if (!out) return
    const dir = join(out, 'home-marble-field')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), JSON.stringify(data, null, 2))
  }
  for (const width of [1280, 390]) {
    await check(`viewport field ${width}px: full-page scroll, first clicks, cached obstacles and CLS`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 844 }, deviceScaleFactor: 1, isMobile: width === 390, hasTouch: width === 390, ignoreHTTPSErrors: true })
      await prepareHomeSmoothness(context)
      const page = await context.newPage()
      try {
        await page.goto(local.origin)
        await page.waitForFunction(() => window.__home?.tips().length)
        await page.mouse.move(5, 300)
        await page.waitForTimeout(6000)
        const result = await measureHomeSmoothness(page)
        await save(`scroll-${width}.json`, { ...result, gpu: 'default ANGLE', cpuRate: 1, viewport: [width, 844], dpr: 1, seconds: 10 })
        if (result.escapes.length) throw new Error(`marble left the viewport: ${JSON.stringify(result.escapes[0])}`)
        if (result.frames.some(f => !f.tips.length)) throw new Error('marble disappeared during scroll')
        if (result.layoutReads || result.layoutsDuringScroll) throw new Error(`${result.layoutReads} frame layout reads, ${result.layoutsDuringScroll} scroll layouts`)
        if (result.longTasks.length) throw new Error(`scroll long tasks: ${result.longTasks.map(t => t.duration.toFixed(1)).join(', ')}ms`)
        // Chromium quantises rAF timestamps; retain the raw value and allow 0.2ms at the 60Hz boundary.
        if (result.p95 > 16.7 + 0.2) throw new Error(`raw p95 ${result.p95.toFixed(1)}ms exceeds the desktop budget plus clock tolerance`)
        if (result.cls !== 0) throw new Error(`CLS ${result.cls}`)
        // Navigation and controls receive the original first click. The fixed canvas ignores every pointer event.
        await page.locator('.hero a[href="#see"]')[width === 390 ? 'tap' : 'click']()
        await page.waitForFunction(() => location.hash === '#see')
        await page.locator('[data-field-toggle]')[width === 390 ? 'tap' : 'click']()
        if (await page.locator('[data-field-toggle]').getAttribute('aria-pressed') !== 'false') throw new Error('first click did not switch the field off')
        await page.locator('.closer a[href="/sim/"]').click()
        await page.waitForURL('**/sim/')
        return `${result.samples} frames, raw p95 ${result.p95.toFixed(1)}ms (16.7ms target; 0.2ms clock tolerance), long tasks 0, layout reads 0, CLS 0`
      } finally { await context.close() }
    })
  }
  await check('viewport field: reduced motion rests, off preference persists, no redraws at rest or hidden', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', ignoreHTTPSErrors: true })
    const page = await context.newPage()
    try {
      await page.goto(local.origin)
      await page.waitForFunction(() => window.__home?.tips().length)
      await page.waitForTimeout(5000)
      const before = await page.evaluate(() => ({ activity: window.__home.activity(), tips: window.__home.tips() }))
      await page.waitForTimeout(1200)
      const after = await page.evaluate(() => ({ activity: window.__home.activity(), tips: window.__home.tips() }))
      if (after.activity.draws !== before.activity.draws) throw new Error('field redrew at rest')
      if (JSON.stringify(after.tips) !== JSON.stringify(before.tips)) throw new Error('reduced-motion marbles did not rest')
      if (await page.locator('.hero-stage').getAttribute('aria-hidden') !== 'true') throw new Error('canvas exposed to screen readers')
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        document.dispatchEvent(new Event('visibilitychange'))
        dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 300, pointerType: 'mouse', bubbles: true }))
      })
      await page.waitForTimeout(800)
      if ((await page.evaluate(() => window.__home.activity())).draws !== after.activity.draws) throw new Error('hidden field redrew')
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')) })
      await page.locator('[data-field-toggle]').click()
      await page.reload()
      await page.waitForTimeout(1000)
      if (await page.locator('[data-field-toggle]').getAttribute('aria-pressed') !== 'false') throw new Error('off preference was lost')
      if (await page.locator('.hero-stage').isVisible()) throw new Error('off field is still visible')
      if ((await page.evaluate(() => window.__home.activity())).draws) throw new Error('off field drew')
      await page.locator('[data-field-toggle]').press('Tab')
      if (await page.locator('[data-field-toggle]').evaluate(el => el === document.activeElement)) throw new Error('keyboard trapped')
      return 'rest 0 redraws; hidden 0 redraws; off survives reload'
    } finally { await context.close() }
  })
  await check('viewport field: native GPU pacing under 4x CPU throttle', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    await prepareHomeSmoothness(context)
    const page = await context.newPage()
    try {
      await page.goto(local.origin)
      await page.waitForFunction(() => window.__home?.tips().length)
      await page.mouse.move(5, 300)
      await page.waitForTimeout(6000)
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      const result = await measureHomeSmoothness(page)
      await save('cpu-4x.json', { ...result, gpu: 'default ANGLE', cpuRate: 4, viewport: [1280, 844], dpr: 1, seconds: 10 })
      if (result.p95 > 20) throw new Error(`4x CPU p95 ${result.p95.toFixed(1)}ms >20ms`)
      if (result.longTasks.length || result.layoutReads || result.escapes.length || result.cls) throw new Error('4x CPU scroll violated long-task, layout or containment budget')
      return `${result.samples} frames, p95 ${result.p95.toFixed(1)}ms, maximum ${result.max.toFixed(1)}ms, long tasks 0`
    } finally { await context.close() }
  })
  } finally { await browser.close() }

}
