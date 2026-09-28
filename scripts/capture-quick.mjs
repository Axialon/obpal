/**
 * Evidence for the quick-actions tray (src/ui/quick.ts): screenshots and recordings from this checkout's build, served
 * by the local stand-in on the lane's ports, into artifacts/ui-system-2/ (git ignores it), in the evidence viewer's
 * Phase 3 section (scripts/lib/sims-evidence.mjs).
 *
 *   node scripts/capture-quick.mjs            home, the sims hub, a sim and the viewer at 1920x1080, 1440x900, 390x844
 *                                             and 844x390, with the tray closed and open; its actions in use on the
 *                                             sim; and recordings of it opening and working, on a computer and a phone
 *   node scripts/capture-quick.mjs --before   the same pages and sizes, as phase3-before-*.png, from whatever is built
 *
 * Needs OBPAL_E2E_PORT and OBPAL_E2E_WORKER_PORT (free), a build (vite build), and Playwright's Chromium or
 * OBPAL_E2E_CHROMIUM. Never writes into the repository outside artifacts/.
 */
import { mkdir, rename } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { SIZES, TRAY_PAGES, phone, writeViewer } from './lib/sims-evidence.mjs'

const before = process.argv.includes('--before')
const out = 'artifacts/ui-system-2'
const prefix = before ? 'phase3-before' : 'phase3-after'

for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  const port = Number(process.env[key])
  if (!port) throw new Error(`${key} is required`)
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`port ${port} (${key}) is in use`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
await mkdir(out, { recursive: true })
const local = await startLocal()
const browser = await chromium.launch({ headless: true, executablePath: (await resolveChromium()).path || undefined })
const errors = []

/** A page at a size, its pairing card folded, settled a moment; optionally recording. */
async function open(path, [width, height], video = null) {
  const small = phone(width, height)
  const context = await browser.newContext({
    viewport: { width, height }, ignoreHTTPSErrors: true, reducedMotion: video ? 'no-preference' : 'reduce', deviceScaleFactor: small ? 2 : 1, isMobile: small, hasTouch: small,
    ...(video ? { recordVideo: { dir: join(out, 'video-tmp'), size: { width, height } } } : {}),
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${path} ${width}x${height}: ${e.message}`))
  await page.goto(`${local.origin}${path}`)
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(2500)
  await page.evaluate(() => {
    const pill = document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.pill')
    if (pill?.getAttribute('aria-expanded') === 'true') pill.click()
  })
  await page.mouse.move(Math.round(width * 0.45), Math.round(height * 0.55))
  await page.waitForTimeout(500)
  return { page, context }
}
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) })
const tab = (page) => page.locator('.quick-tab')

try {
  for (const [name, path] of TRAY_PAGES) {
    for (const size of SIZES) {
      const tag = `${prefix}-${name}-${size[0]}x${size[1]}`
      let o
      try {
        o = await open(path, size)
        await shot(o.page, tag)
        if (!before && await tab(o.page).count()) {
          await tab(o.page).click()
          await o.page.waitForTimeout(500)
          await shot(o.page, `${tag}-open`)
        }
      } catch (e) {
        errors.push(`${tag}: ${e.message.split('\n')[0]}`)
      } finally { await o?.context.close() }
    }
  }
  if (!before) {
    // Its actions in use on a sim, one picture each: the tooltip, the camera's next view, the picker, the pairing card.
    const o = await open('/sim/drone/', [1440, 900])
    const p = o.page
    await tab(p).click(); await p.waitForTimeout(400)
    const action = (id) => p.locator(`.quick-tray [data-quick="${id}"]`)
    await action('camera').hover(); await p.waitForTimeout(300)
    await shot(p, 'phase3-action-tooltip-1440x900')
    await action('camera').click(); await p.waitForTimeout(900)
    await shot(p, 'phase3-action-camera-1440x900')
    await action('theme').click(); await p.waitForTimeout(400)
    await shot(p, 'phase3-action-theme-1440x900')
    await p.keyboard.press('Escape'); await p.waitForTimeout(200)
    if (!(await p.locator('.quick-tray[data-open="true"]').count())) { await tab(p).click(); await p.waitForTimeout(300) }
    await action('pair').click(); await p.waitForTimeout(700)
    await shot(p, 'phase3-action-pair-1440x900')
    await o.context.close()
    // Recordings: the tray opening and its actions in use, on a computer and on a phone.
    for (const [size, name] of [[[1440, 900], 'computer'], [[390, 844], 'phone']]) {
      const r = await open('/sim/drone/', size, true)
      const q = r.page
      await tab(q).click(); await q.waitForTimeout(700)
      for (const id of ['camera', 'camera', 'sound', 'theme']) {
        const b = q.locator(`.quick-tray [data-quick="${id}"]`)
        if (!(await b.count())) continue
        if (!(await q.locator('.quick-tray[data-open="true"]').count())) { await tab(q).click(); await q.waitForTimeout(500) }
        await b.hover().catch(() => {}); await q.waitForTimeout(400)
        await b.click(); await q.waitForTimeout(1100)
        if (id === 'theme') { await q.keyboard.press('Escape'); await q.waitForTimeout(500) }
      }
      if (await q.locator('.quick-tray[data-open="true"]').count()) { await q.keyboard.press('Escape'); await q.waitForTimeout(700) }
      const video = q.video()
      await r.context.close()
      await rename(await video.path(), join(out, `phase3-tray-${name}.webm`))
    }
  }
} finally {
  await browser.close()
  await local.close()
}

const count = await writeViewer(out, errors)
if (errors.length) console.log(`errors:\n  ${errors.join('\n  ')}`)
console.log(`${count} images in ${out}; viewer: ${join(out, 'index.html')}`)
