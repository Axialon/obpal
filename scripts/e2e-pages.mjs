/**
 * Every page of the site, as its own policies and fonts leave it: this checkout's build and worker (`wrangler dev` on
 * OBPAL_E2E_WORKER_PORT, default 5179: scripts/local-worker.mjs, so public/_headers applies too). Each page opens
 * (a computer, and a phone for the controller), scrolls to its end, and:
 *   - breaks no Content Security Policy directive (scripts/csp-watch.mjs) and throws no error;
 *   - has its policy: the page's own <meta> one and the headers' frame-ancestors one;
 *   - takes its fonts from this origin, never from a font service, and they load.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { chromium, devices } from 'playwright'
import { cspCheck, cspViolations } from './csp-watch.mjs'
import { startWorker } from './local-worker.mjs'
import { checkFrost, setSurface } from './lib/frost.mjs'

const PORT = Number(process.env.OBPAL_E2E_WORKER_PORT) || 5179
const HEADED = process.argv.includes('--headed')
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const PAGES = ['/', '/p/', '/view/', '/sim/', '/sim/arm/', '/sim/arena/', '/sim/device/', '/embed/', '/link/', '/catalogue/', '/buttons/', '/sponsor/', '/donate/', '/privacy/']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ ok: true })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ ok: false })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
}

let worker = null
let browser = null
let exitCode = 0
try {
  worker = await startWorker({ port: PORT })
  console.log(`ob.Pal pages e2e (${worker.origin})`)
  browser = await chromium.launch({ executablePath, headless: !HEADED })
  for (const path of PAGES) {
    await check(`${path} keeps to its policy, and its fonts come from here`, async () => {
      const ctx = await browser.newContext(path === '/p/' ? { ...devices['Pixel 7'] } : { viewport: { width: 1280, height: 800 } })
      try {
        const page = await ctx.newPage()
        const hostileName = '<img src=x onerror="window.templateInjection=true"> & "phone"'
        if (path === '/donate/') await page.route('**/api/donations/live', (route) => route.fulfill({ json: {
          status: 'ok', totalUsd: 10, backerCount: 1, recent: [{ donorName: hostileName, amountUsd: 10 }],
        } }))
        const errors = []
        const elsewhere = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('request', (r) => { if (!r.url().startsWith(worker.origin) && !/^(data|blob):/.test(r.url())) elsewhere.push(r.url()) })
        const seen = cspViolations.length
        const res = await page.goto(worker.origin + path, { waitUntil: 'load' })
        const headers = res.headers()
        if (path === '/p/' && !/camera=\(self\)/.test(headers['permissions-policy'] ?? '')) throw new Error('the phone camera is blocked by Permissions-Policy')
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await sleep(1500)
        await page.evaluate(() => window.scrollTo(0, 0))
        const found = await page.evaluate(async () => {
          await document.fonts.ready
          const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''))
          const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? ''
          const fonts = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.woff2(\?|$)/.test(n))
          return { loaded: [...new Set(loaded)], meta, fonts }
        })
        if (errors.length) throw new Error(`page errors: ${errors.slice(0, 2).join(' | ')}`)
        if (path === '/donate/') {
          const recent = page.locator('#recent')
          if (!(await recent.textContent()).includes(hostileName) || await recent.locator('img').count()) throw new Error('network text was parsed as markup')
        }
        if (cspViolations.length > seen) throw new Error(`violations: ${JSON.stringify(cspViolations.slice(seen, seen + 2))}`)
        if (!/script-src 'self'/.test(found.meta) || !/object-src 'none'/.test(found.meta)) throw new Error(`no page policy: "${found.meta.slice(0, 80)}"`)
        if (!/require-trusted-types-for 'script'(;|$)/.test(found.meta) || !/trusted-types obpal-templates(;|$)/.test(found.meta)) throw new Error('Trusted Types must be enforced with only the site template policy')
        if (!/frame-ancestors 'self'/.test(headers['content-security-policy'] ?? '')) throw new Error(`no frame-ancestors header: ${headers['content-security-policy']}`)
        if (elsewhere.length) throw new Error(`requests elsewhere: ${elsewhere.slice(0, 3).join(', ')}`)
        if (found.fonts.some((f) => !f.startsWith(`${worker.origin}/fonts/`))) throw new Error(`fonts from elsewhere: ${found.fonts.join(', ')}`)
        if (!found.loaded.includes('Inter')) throw new Error(`Inter didn't load (${found.loaded.join(', ') || 'no fonts'})`)
        return `${found.loaded.join(', ')}; ${found.fonts.length} font file${found.fonts.length === 1 ? '' : 's'}`
      } finally {
        await ctx.close()
      }
    })
  }
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await check(`/sim/ has compact, readable frost at ${viewport.width}x${viewport.height}`, async () => {
      const ctx = await browser.newContext({ viewport, reducedMotion: 'reduce' })
      try {
        const page = await ctx.newPage()
        await page.goto(worker.origin + '/sim/')
        await page.waitForFunction(() => window.__sims?.cards().length)
        await page.evaluate(() => scrollTo(0, 1050))
        const phone = viewport.width < 600
        for (const theme of ['carbon', 'light']) {
          await setSurface(page, theme)
          await checkFrost(page, '.top', { text: ['.top-nav a'] })
          // A computer browses from the sidebar; a phone has its search bar over the cards.
          if (phone) await checkFrost(page, '.sims-bar', { maxHeight: 64, text: ['#search', '.sims-filters'] })
          else await checkFrost(page, '.sims-side', { text: ['.kit-side-text', '.kit-side-label', '#search', '.kit-select-v'] })
          const layout = await page.evaluate((phone) => ({
            top: document.querySelector('.top').getBoundingClientRect().bottom,
            under: document.querySelector(phone ? '.sims-bar' : '.sims-side').getBoundingClientRect().top,
            overflow: document.documentElement.scrollWidth - innerWidth,
          }), phone)
          const gap = layout.under - layout.top
          if (gap < 0 || gap > 16 || layout.overflow > 0) throw new Error(`sticky layout: ${JSON.stringify(layout)}`)
        }
        return `${phone ? 'search bar at most 64px' : 'the sidebar'} held under the bar; both themes; AA over black and white`
      } finally { await ctx.close() }
    })
  }
  await check('frost has an opaque fallback when backdrop filters are unavailable', async () => {
    const ctx = await browser.newContext()
    try {
      const page = await ctx.newPage()
      let replaced = false
      await page.route('**/*.css', async route => {
        const response = await route.fetch()
        const css = await response.text()
        const body = css.replace(/\((?:-webkit-)?backdrop-filter:/g, () => { replaced = true; return '(obpal-unsupported-backdrop-filter:' })
        await route.fulfill({ response, body })
      })
      await page.goto(worker.origin + '/sim/')
      await page.waitForFunction(() => window.__sims?.cards().length)
      if (!replaced) throw new Error('no backdrop support query was exercised')
      await checkFrost(page, '.top', { solid: true })
      await checkFrost(page, '.sims-side', { solid: true })
      await page.goto(worker.origin + '/')
      await page.locator('.cta-alt').hover()
      await checkFrost(page, '.cta-alt', { solid: true })
    } finally { await ctx.close() }
  })
  for (const [path, surfaces] of [
    ['/', ['.top', '.pair']],
    ['/link/', ['.top']],
    ['/catalogue/', ['.top', '.bld-out']],
    ['/sim/device/', ['.sim-top', '.sim-panel']],
    ['/sim/arm/', ['.sim-top', '.sim-panel']],
    ['/sim/arena/', ['.sim-top', '.sim-panel']],
    ['/embed/', ['.sim-top', '.sim-panel']],
    ['/view/', ['.topbar', '.catalog', '.presence-floating', '.obpal-chip .pill', '.obpal-chip .card']],
    ['/p/', ['.msg-card']],
  ]) {
    await check(`${path} overlays keep their frost and AA text in both themes`, async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })
      try {
        const page = await ctx.newPage()
        await page.goto(worker.origin + path)
        for (const theme of ['carbon', 'light']) {
          await setSurface(page, theme)
          for (const selector of surfaces) await checkFrost(page, selector, { text: ['p', 'small', 'label', 'h1', 'h2', '.top-nav a', '.presence-controls button', '.k', '.status'] })
          if (path === '/') {
            await page.locator('.cta-alt').hover()
            await checkFrost(page, '.cta-alt')
          }
          if (path === '/view/') {
            const overlap = await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().bottom - document.querySelector('.presence-floating').getBoundingClientRect().top)
            if (overlap > 0) throw new Error(`viewpoint toolbar overlaps the header by ${overlap}px`)
            await page.locator('#t-theme').click()
            await page.locator(`[data-bb-theme-id="${theme}"]`).click()
            await checkFrost(page, '#themes', { text: ['.bb-label', '.bb-theme'] })
            await page.keyboard.press('Escape')
          }
        }
        if (path === '/view/') {
          for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 })
            await checkFrost(page, '.presence-floating', { maxHeight: 64, text: ['button', 'select'] })
            const overlap = await page.evaluate(() => document.querySelector('.presence-floating').getBoundingClientRect().bottom - document.querySelector('.catalog').getBoundingClientRect().top)
            if (overlap > 0) throw new Error(`${width}px: viewpoint toolbar covers the catalogue by ${overlap}px`)
          }
        }
      } finally { await ctx.close() }
    })
  }
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await worker?.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(failed || exitCode ? `FAILED ${failed}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed || exitCode ? 1 : 0)
