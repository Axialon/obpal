/**
 * Every page of the site, as its own policies and fonts leave it: this checkout's build and worker (`wrangler dev` on
 * OBPAL_E2E_WORKER_PORT, default 5179: scripts/local-worker.mjs, so public/_headers applies too). Each page opens
 * (a computer, and a phone for the controller), scrolls to its end, and:
 *   - breaks no Content Security Policy directive (scripts/csp-watch.mjs) and throws no error;
 *   - has its policy: the page's own <meta> one and the headers' frame-ancestors one;
 *   - takes its fonts from this origin, never from a font service, and they load.
 * Then the quick-actions tray on each kind of page (scripts/e2e-quick.mjs), and the Viewer open across a deploy
 * (src/ui/recover.ts): its lazy QR chunk is asked for after a pretend deploy (scripts/lib/deploy-sim.mjs) has
 * removed the old build's chunks, and the page reloads once into the new build; it doesn't when the chunks are kept,
 * and it never reloads twice.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'
import { cspCheck, cspViolations } from './csp-watch.mjs'
import { startWorker } from './local-worker.mjs'
import { checkFrost, setSurface } from './lib/frost.mjs'
import { runQuick } from './e2e-quick.mjs'
import { nextBuild } from './lib/deploy-sim.mjs'

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
  await check('robots, sitemap and agent digest are served', async () => {
    const [robots, sitemap, llms, full] = await Promise.all(['/robots.txt', '/sitemap.xml', '/llms.txt', '/llms-full.txt'].map(p => fetch(worker.origin + p)))
    for (const r of [robots, sitemap, llms, full]) if (!r.ok) throw new Error(`${r.url}: ${r.status}`)
    const rules = await robots.text()
    if (!rules.includes('search=yes, ai-input=yes, ai-train=yes') || !rules.includes('Sitemap: https://obpal.blackboxes.net/sitemap.xml') || rules.includes('Disallow:')) throw new Error('robots rules')
    if (!(await llms.text()).includes('ob.Pal Link') || !(await full.text()).includes('WebRTC')) throw new Error('agent digest')
    const xml = await sitemap.text()
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1])
    if (urls.length < 40 || urls.some(u => u.includes('/sim/device/'))) throw new Error(`${urls.length} sitemap URLs`)
    for (const canonical of urls) {
      const response = await fetch(worker.origin + new URL(canonical).pathname)
      if (!response.ok) throw new Error(`${canonical}: ${response.status}`)
      const html = await response.text()
      if (!html.includes(`<link rel="canonical" href="${canonical}"`)) throw new Error(`${canonical}: canonical`)
      const scripts = [...html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)]
      if (!scripts.length) throw new Error(`${canonical}: JSON-LD missing`)
      for (const script of scripts) JSON.parse(script[1])
    }
    return `${urls.length} canonical pages with JSON-LD`
  })
  await check('controller is noindexed and old device URLs name the clean canonical', async () => {
    const phone = await (await fetch(worker.origin + '/p/')).text()
    if (!phone.includes('name="robots" content="noindex, follow"')) throw new Error('/p/ indexable')
    const old = await fetch(worker.origin + '/sim/device/?d=rover')
    if (!old.ok || !(await old.text()).includes('href="https://obpal.blackboxes.net/sim/rover/"')) throw new Error('old device URL')
  })
  await check('catalogue and device descriptions show without JavaScript', async () => {
    const ctx = await browser.newContext({ javaScriptEnabled: false })
    try {
      const page = await ctx.newPage()
      await page.goto(worker.origin + '/sim/')
      if (await page.locator('#seo-list li').count() < 41 || !await page.getByRole('link', { name: 'Rover', exact: true }).count()) throw new Error('catalogue text')
      await page.goto(worker.origin + '/sim/rover/')
      if (!await page.getByRole('heading', { name: 'Rover' }).count() || !await page.locator('#seo-device').getByText('Steering wheel').count()) throw new Error('device text and controls')
      await page.goto(worker.origin + '/')
      if (!await page.getByRole('heading', { name: /Your phone is the controller/ }).count() || !await page.getByText('Robot arms follow your hand', { exact: false }).count()) throw new Error('home text')
    } finally { await ctx.close() }
  })
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
    ['/sim/device/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/sim/arm/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
    ['/sim/arena/', ['.sim-top', '.sim-window[data-panel="controls"]', '.panel-dock']],
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
  // The quick-actions tray on each kind of page (scripts/e2e-quick.mjs).
  await runQuick(browser, worker.origin, check)
  // The Viewer opened before a deploy. Its lazy QR chunk is asked for only after the deploy, which serves the next build
  // from memory (scripts/lib/deploy-sim.mjs): `kept`, the old build's chunks are still there (scripts/keep-assets.mjs);
  // otherwise they are gone; `stuck`, the next build's QR chunk is missing as well.
  const next = await nextBuild(fileURLToPath(new URL('../dist/client', import.meta.url)))
  const RELOAD_KEY = 'obpal:deploy-reload'
  const isQr = (path) => /^\/assets\/qr-/.test(path)
  async function viewerAcrossDeploy({ kept = false, stuck = false }, run) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    try {
      const page = await ctx.newPage()
      const seen = { loads: 0, errors: [] }
      page.on('load', () => { seen.loads++ })
      page.on('pageerror', (e) => seen.errors.push(e.message))
      let deployed = false
      let deploy = () => {}
      const after = new Promise((r) => { deploy = r })
      let asked = () => {}
      const qrAsked = new Promise((r) => { asked = r })
      await ctx.route(`${worker.origin}/**`, async (route) => {
        const path = new URL(route.request().url()).pathname
        if (!deployed && next.gone.has(path) && isQr(path)) { asked(); await after }
        if (!deployed) return route.continue()
        const removed = (next.gone.has(path) && !kept) || (stuck && isQr(path))
        if (removed) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'removed by the deploy' })
        const file = next.files.get(path)
        if (file) return route.fulfill({ status: 200, contentType: file.type, body: file.body, headers: { 'cache-control': 'no-store' } })
        return route.continue()
      })
      await page.goto(`${worker.origin}/view/`)
      await Promise.race([qrAsked, sleep(15000).then(() => { throw new Error('the pairing chip never asked for its QR chunk') })])
      deployed = true
      deploy()
      const qr = page.locator('.obpal-chip .qr svg')
      const drawn = async () => { await qr.first().waitFor({ timeout: 15000 }).catch(() => {}); return await qr.count() > 0 }
      const record = () => page.evaluate((k) => sessionStorage.getItem(k), RELOAD_KEY)
      return await run({ seen, drawn, record })
    } finally { await ctx.close() }
  }
  await check('a Viewer open across a deploy that removed the QR chunk reloads once, into the new build, and draws the code', async () => {
    return await viewerAcrossDeploy({}, async ({ seen, drawn, record }) => {
      if (!(await drawn())) throw new Error(`no QR code drawn; ${seen.loads} loads; ${seen.errors.join(' | ')}`)
      if (seen.loads !== 2) throw new Error(`${seen.loads} page loads (want the first and one reload)`)
      if (!seen.errors.some((e) => /dynamically imported module/.test(e))) throw new Error(`the chunk did not fail: ${seen.errors.join(' | ') || 'no errors'}`)
      if (!(await record())) throw new Error('the reload left no guard in sessionStorage')
      return 'the old chunk 404ed, one reload, the QR drawn from the new build'
    })
  })
  await check('the same deploy with the old chunks kept needs no reload', async () => {
    return await viewerAcrossDeploy({ kept: true }, async ({ seen, drawn, record }) => {
      if (!(await drawn())) throw new Error(`no QR code drawn; ${seen.errors.join(' | ')}`)
      await sleep(1500)
      if (seen.loads !== 1 || seen.errors.length || await record()) throw new Error(`${seen.loads} loads, ${seen.errors.length} errors, guard ${await record()}`)
      return 'the old chunk still served: no error, no reload'
    })
  })
  await check('a chunk missing from the new build too is reloaded for once, never again', async () => {
    return await viewerAcrossDeploy({ stuck: true }, async ({ seen, record }) => {
      const end = Date.now() + 15000
      while (seen.loads < 2 && Date.now() < end) await sleep(100)
      await sleep(3000)
      if (seen.loads !== 2) throw new Error(`${seen.loads} page loads (want the first and one reload)`)
      if (!(await record())) throw new Error('no guard in sessionStorage')
      return `${seen.loads} loads, ${seen.errors.length} errors, and it stopped`
    })
  })
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
