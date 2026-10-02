/** The sim button audit shares its traversal and font measurements with the before/after evidence script. */
import { tempScope } from './lib/temp.mjs'
import { chromium } from 'playwright'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buttonRoutes, BUTTON_SIZES, PHONE_BUTTON_ROUTES, visitButtonStates, visitNodeButtons } from './lib/sim-buttons.mjs'
import { measureButtonInk, inkError, inkSummary } from './lib/button-ink.mjs'

export async function runSimButtons(local, check) {
  const runCheck = check
  check = (name, run) => process.env.OBPAL_E2E_BUTTONS_ONLY && !new RegExp(process.env.OBPAL_E2E_BUTTONS_ONLY).test(name) ? undefined : runCheck(name, run)
  const temps = tempScope()
  try {
  const launch = () => chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM }))
  let browser = await launch()
  const out = await temps.make(join(tmpdir(), 'obpal-button-ink-')), rows = []
  try {
    await check('button ink: a late SVG receives its spacing without a resize', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      try {
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/rover/`)
        await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
        await page.evaluate(() => document.fonts.ready)
        await page.waitForTimeout(700)
        await page.locator('#reset svg').evaluate(svg => {
          const fresh = svg.cloneNode(true)
          fresh.removeAttribute('style')
          svg.replaceWith(fresh)
        })
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
        const button = (await page.evaluate(measureButtonInk)).find(row => row.id === 'reset')
        if (!button || inkError(button) > .5) throw new Error(`Late SVG: ${JSON.stringify(button?.groupOffset)}`)
        return `${inkError(button).toFixed(3)}px without a resize or panel interaction`
      } finally { await context.close() }
    })
    await check('button ink fallback and regression detection', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/arm/`)
        await page.locator('#add-arm .kit-ink').waitFor()
        await page.evaluate(() => document.fonts.ready)
        await page.waitForFunction(() => document.querySelector('#home-all')?.getAttribute('data-tip') === 'Home' && document.querySelector('.tip'))
        // Scrolling an action into view dismisses tips; let that scroll finish before starting the hover delay.
        await page.locator('#home-all').scrollIntoViewIfNeeded()
        await page.mouse.move(0, 0)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await page.locator('#home-all').hover()
        await page.getByRole('tooltip', { name: 'Home', exact: true }).waitFor()
        await page.mouse.move(0, 0)
        await page.addStyleTag({ content: '.kit-ink { text-box: normal !important; line-height: 1 !important; margin-block: var(--ink-top, 0px) var(--ink-bottom, 0px) !important; }' })
        await page.waitForTimeout(100)
        const fallback = await page.evaluate(measureButtonInk)
        const bad = fallback.filter(r => inkError(r) > .5)
        if (bad.length) throw new Error(`Fallback: ${bad.map(r => `${r.name} ${JSON.stringify(r.groupOffset)}`).join('; ')}`)
        await page.locator('#add-arm .kit-ink').evaluate(el => { el.style.transform = 'translateY(3px)' })
        const shifted = (await page.evaluate(measureButtonInk)).find(r => r.id === 'add-arm')
        if (!shifted || inkError(shifted) <= .5) throw new Error('The audit missed a deliberately shifted label')
        await page.locator('#home-all').evaluate(el => { el.removeAttribute('aria-label'); el.removeAttribute('title') })
        const unnamed = (await page.evaluate(measureButtonInk)).find(r => r.id === 'home-all')
        if (!unnamed?.iconOnly || unnamed.name) throw new Error('The audit missed a deliberately unnamed icon action')
        return `${fallback.length} controls without text-box; deliberate alignment and naming regressions detected`
      } finally { await context.close() }
    })
    // Bound GPU browser lifetime; software keeps its original reuse and every assertion stays.
    for (const [width, height] of BUTTON_SIZES) {
      if (process.env.OBPAL_E2E_GPU === '1') { await browser.close(); browser = await launch() }
      console.log(`  Button ink: viewport ${width}x${height}`)
      for (const [name, path] of await buttonRoutes()) {
        const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 900, isMobile: width < 900, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
        try {
          await check(`${name} buttons at ${width}x${height}: ink within 0.5px and every icon action named`, async () => {
            const page = await context.newPage(), seen = []
            await visitButtonStates(page, local.origin, path, async (state, measured) => seen.push(...measured.map(r => ({ page: name, size: `${width}x${height}`, state, ...r }))))
            rows.push(...seen)
            if (!seen.length) throw new Error('No visible controls were measured')
            const unnamed = seen.filter(r => r.iconOnly && !r.name)
            if (unnamed.length) throw new Error(`Unnamed icon buttons: ${unnamed.map(r => r.id || r.classes).join(', ')}`)
            const lostIcons = seen.filter(r => r.classes.split(' ').includes('kit-icon-action') && !r.iconOnly)
            if (lostIcons.length) throw new Error(`Icon actions lost their glyph: ${lostIcons.map(r => r.name).join(', ')}`)
            const hiddenActions = seen.filter(r => r.state === 'first-person' && /(?:^| )(presence-enter|presence-secondary)(?: |$)/.test(r.classes))
            if (hiddenActions.length) throw new Error(`Collapsed viewpoint actions are visible: ${hiddenActions.map(r => r.name).join(', ')}`)
            const bad = seen.filter(r => inkError(r) > .5).sort((a, b) => inkError(b) - inkError(a))
            if (bad.length) throw new Error(`${bad.length} off-centre: ${bad.slice(0, 5).map(r => `${r.name} ${JSON.stringify(r.groupOffset)}`).join('; ')}`)
            const summary = inkSummary(seen)
            return `${summary.measured} controls; worst ${summary.worst.toFixed(3)}px, p95 ${summary.p95.toFixed(3)}px`
          })
        } finally { await context.close() }
      }
    }
    if (process.env.OBPAL_E2E_GPU === '1') { await browser.close(); browser = await launch() }
    console.log('  Button ink: node strips')
    for (const name of PHONE_BUTTON_ROUTES) await check(`${name} node strip and tray: centred and named at all three sizes`, async () => {
      const seen = []
      await visitNodeButtons(browser, local.origin, name, async (_page, size, state, measured) => seen.push(...measured.map(r => ({ page: `node-${name}`, size, state, ...r }))))
      rows.push(...seen)
      const bad = seen.filter(r => inkError(r) > .5 || (r.iconOnly && !r.name) || (r.classes.split(' ').includes('kit-icon-action') && !r.iconOnly))
      if (bad.length) throw new Error(bad.slice(0, 5).map(r => `${r.size} ${r.name}: ${JSON.stringify(r.groupOffset)}`).join('; '))
      return `${seen.length} controls`
    })
  } finally {
    await browser.close()
    await writeFile(join(out, 'measurements.json'), JSON.stringify({ summary: inkSummary(rows), rows }, null, 2))
    console.log(`Button ink measurements: ${out}`)
  }

  } finally { await temps.cleanup() }
}
