/** Reproducible catalogue and device evidence, using only the assigned local ports and Playwright browser. */
import { distill } from './lib/distill.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { stageActivity } from './lib/wave4b-evidence.mjs'

const before = process.argv.includes('--before')
const out = 'artifacts/codex-wave4b'
const ids = ['football', 'marblerun', 'planetary', 'telescope', 'pendulum', 'trebuchet', 'slider', 'jib']
const sizes = [[1280, 800], [390, 844], [844, 390]]
for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  const port = Number(process.env[key])
  if (!port) throw new Error(`${key} is required`)
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
await mkdir(out, { recursive: true })
const local = await startLocal()
let browser
const shots = [], budgets = []
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true })
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  const shot = async (name) => { await page.screenshot({ path: `${out}/${name}.png` }); shots.push(name) }
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height })
    await page.goto(`${local.origin}/sim/`)
    await page.waitForSelector('.dcard-stage.live')
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(350)
    await shot(`${before ? 'before' : 'after'}-catalogue-${width}x${height}`)
  }
  if (!before) {
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${local.origin}/sim/?category=new`)
    await page.waitForSelector('.dcard-stage.live')
    await page.waitForTimeout(350)
    await shot('after-catalogue-new')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    for (const id of ids) {
      for (const [width, height] of sizes) {
        await page.setViewportSize({ width, height })
        await page.goto(`${local.origin}/sim/device/?d=${id}`)
        await page.waitForFunction(() => window.__device && window.__gfx?.().triangles > 0)
        const pairing = page.getByRole('button', { name: 'Scan to control', exact: true })
        await pairing.waitFor()
        if (await pairing.getAttribute('aria-expanded') === 'true') await pairing.click()
        await page.mouse.move(5, 5)
        await page.waitForTimeout(750)
        await shot(`${id}-${width}x${height}`)
        const measured = await page.evaluate(async () => {
          const times = [], submissions = [], frameTimes = []
          let last = performance.now()
          for (let n = 0; n < 90; n++) {
            // Force a render to measure every scene, including tables resting between players.
            window.__device.stage.view.invalidate()
            await new Promise(requestAnimationFrame)
            const now = performance.now(), gfx = window.__gfx()
            if (n > 9) { frameTimes.push(now - last); times.push(gfx.renderMs); submissions.push(gfx) }
            last = now
          }
          times.sort((a, b) => a - b)
          return {
            triangles: Math.max(...submissions.map(g => g.triangles)), calls: Math.max(...submissions.map(g => g.calls)),
            renderMsP95: Number(times[Math.floor(times.length * .95)].toFixed(2)),
            frameHz: Number((1000 / (frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length)).toFixed(1)),
          }
        })
        budgets.push({ id, view: 'play', viewport: `${width}x${height}`, ...measured })
        if (measured.triangles > 250000 || measured.calls > 150) throw new Error(`${id} exceeds its rendering budget`)
        if (width === 1280) {
          const inspect = page.getByRole('button', { name: /inspect/i })
          if (await inspect.count()) await inspect.click()
          else await page.evaluate(() => { const s = window.__device.stage; s.controls.dollyIn(1.25); s.controls.update() })
          await page.waitForTimeout(350)
          await shot(`${id}-close`)
          await page.getByRole('button', { name: 'Overview', exact: true }).click()
          await page.waitForTimeout(350)
          await shot(`${id}-overview`)
          const gfx = await page.evaluate(() => window.__gfx())
          budgets.push({ id, view: 'overview', viewport: `${width}x${height}`, triangles: gfx.triangles, calls: gfx.calls })
          if (gfx.triangles > 250000 || gfx.calls > 150) throw new Error(`${id} Overview exceeds its rendering budget`)
          await stageActivity(page, id)
          if (!['marblerun', 'trebuchet'].includes(id)) await page.getByRole('button', { name: 'Reset view', exact: true }).click()
          await page.waitForTimeout(500)
          await shot(`${id}-active`)
          const active = await page.evaluate(() => window.__gfx())
          budgets.push({ id, view: 'active', viewport: `${width}x${height}`, triangles: active.triangles, calls: active.calls })
          if (active.triangles > 250000 || active.calls > 150) throw new Error(`${id} activity exceeds its rendering budget`)
        }
      }
    }
    await writeFile(`${out}/budgets.json`, JSON.stringify(budgets, null, 2) + '\n')
  }
  if (errors.length) throw new Error(errors.join('\n'))
  await writeFile(`${out}/${before ? 'before' : 'after'}-shots.json`, JSON.stringify(shots, null, 2) + '\n')
  console.log(`Captured ${shots.length} images; no page errors.`)
} finally {
  await browser?.close()
  await local.close()
}

await distill(out, { keepRaw: process.argv.includes("--keep-raw") || process.env.OBPAL_KEEP_RAW === "1" })
