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
        const errors = []
        const elsewhere = []
        page.on('pageerror', (e) => errors.push(e.message))
        page.on('request', (r) => { if (!r.url().startsWith(worker.origin) && !/^(data|blob):/.test(r.url())) elsewhere.push(r.url()) })
        const seen = cspViolations.length
        const res = await page.goto(worker.origin + path, { waitUntil: 'load' })
        const headers = res.headers()
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
        if (cspViolations.length > seen) throw new Error(`violations: ${JSON.stringify(cspViolations.slice(seen, seen + 2))}`)
        if (!/script-src 'self'/.test(found.meta) || !/object-src 'none'/.test(found.meta)) throw new Error(`no page policy: "${found.meta.slice(0, 80)}"`)
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
