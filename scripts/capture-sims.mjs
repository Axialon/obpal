/**
 * Evidence for the sims' panels on the glass kit: screenshots from this checkout's build, served by the local stand-in
 * on the lane's ports, into artifacts/ui-system-2/ (git ignores it), with an offline viewer, index.html.
 *
 *   node scripts/capture-sims.mjs            ten sims at 1920x1080, 1440x900, 390x844 and 844x390 (on a phone, also
 *                                            with the controls window open), and the dock, a camera window and a
 *                                            window being moved
 *   node scripts/capture-sims.mjs --before   the same sims and sizes, as before-*.png, from whatever is built
 *   --only=<sim,...>                         some sims: arm, arena, drone, rover, kart, gimbal, ptz, studio, smarthome,
 *                                            pinball
 *
 * Needs OBPAL_E2E_PORT and OBPAL_E2E_WORKER_PORT (free), a build (vite build), and Playwright's Chromium or
 * OBPAL_E2E_CHROMIUM. Never writes into the repository outside artifacts/.
 */
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { SIMS, SIZES, phone, writeViewer } from './lib/sims-evidence.mjs'

const before = process.argv.includes('--before')
const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean)
const out = 'artifacts/ui-system-2'
const prefix = before ? 'before' : 'after'

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

/** A sim at a size, its pairing card folded so the windows show, settled a moment. */
async function open(path, [width, height]) {
  const small = phone(width, height)
  const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, reducedMotion: 'reduce', deviceScaleFactor: small ? 2 : 1, isMobile: small, hasTouch: small })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${path} ${width}x${height}: ${e.message}`))
  await page.goto(`${local.origin}${path}`)
  await page.waitForFunction(() => !!document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.pill'), null, { timeout: 30000 })
  await page.waitForTimeout(2500)
  await page.evaluate(() => {
    const pill = document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.pill')
    if (pill?.getAttribute('aria-expanded') === 'true') pill.click()
  })
  await page.mouse.move(Math.round(width * 0.6), Math.round(height * 0.5))
  await page.waitForTimeout(600)
  return { page, close: () => context.close() }
}
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) })

try {
  for (const [name, path] of SIMS) {
    if (only.length && !only.includes(name)) continue
    for (const size of SIZES) {
      const tag = `${prefix}-${name}-${size[0]}x${size[1]}`
      let o
      try {
        o = await open(path, size)
        await shot(o.page, tag)
        // A phone starts with its windows docked: open the controls too.
        if (phone(...size)) {
          const toggle = o.page.locator('[data-panel-toggle="controls"]')
          if (await toggle.count()) {
            await o.page.evaluate(() => { document.querySelector('.panel-dock-handle')?.click() })
            await o.page.waitForTimeout(250)
            await toggle.click({ force: true })
            await o.page.waitForTimeout(600)
            await shot(o.page, `${tag}-controls`)
          }
        }
      } catch (e) {
        errors.push(`${tag}: ${e.message.split('\n')[0]}`)
      } finally { await o?.close() }
    }
  }
  if (!before && !only.length) {
    // The dock, open with a tooltip; a camera window enlarged; a window mid-move.
    const o = await open('/sim/device/?d=ptz', [1440, 900])
    const p = o.page
    await p.locator('.panel-dock').hover()
    await p.locator('[data-panel-toggle]').first().hover()
    await p.waitForTimeout(400)
    await shot(p, 'after-dock-1440x900')
    const handle = p.locator('[data-panel="controls"] .panel-handle')
    const b = await handle.boundingBox()
    await p.mouse.move(b.x + 30, b.y + b.height / 2)
    await p.mouse.down()
    await p.mouse.move(b.x + 330, b.y + 140, { steps: 8 })
    await shot(p, 'after-moving-1440x900')
    await p.mouse.up()
    const enlarge = p.getByRole('button', { name: /^Enlarge / }).first()
    if (await enlarge.count()) { await enlarge.click(); await p.waitForTimeout(500); await shot(p, 'after-camera-enlarged-1440x900') }
    await o.close()
  }
} finally {
  await browser.close()
  await local.close()
}

// ---- the viewer (scripts/lib/sims-evidence.mjs) ------------------------------------------------------------------------
const count = await writeViewer(out, errors)
if (errors.length) console.log(`errors:\n  ${errors.join('\n  ')}`)
console.log(`${count} images in ${out}; viewer: ${join(out, 'index.html')}`)
