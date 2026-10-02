/** Phone evidence from the current build. Run before and after the change; writes only ignored artifacts/tray/. */
import { distill } from './lib/distill.mjs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startWorker } from './local-worker.mjs'

const out = 'artifacts/tray'
const phase = process.argv.includes('--before') ? 'before' : 'after'
const sizes = [[360, 740], [375, 812], [390, 844], [430, 932], [844, 390]]
const port = Number(process.env.OBPAL_E2E_WORKER_PORT)
if (!port) throw new Error('OBPAL_E2E_WORKER_PORT is required')
await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(port, '127.0.0.1', () => server.close(resolve))
})
await mkdir(out, { recursive: true })
const worker = await startWorker({ port })
let browser
const measurements = []
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true })
  for (const [width, height] of sizes) for (const surface of ['carbon', 'navy', 'light']) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await page.goto(worker.origin + '/')
      await page.locator('.quick-tab').waitFor()
      await page.waitForTimeout(1500)
      await page.locator('.quick-tab').tap()
      await page.locator('[data-quick="theme"]').tap()
      // The baseline's last row can be off screen. Dispatching the same click records that broken state too.
      await page.locator(`.quick-themes [data-bb-theme-id="${surface}"]`).evaluate(el => el.click())
      await page.keyboard.press('Escape')
      if (await page.locator('.quick-tray[data-open="false"]').count()) await page.locator('.quick-tab').tap()
      await page.waitForTimeout(250)
      const name = `${phase}-${width}x${height}-${surface}`
      await page.screenshot({ path: `${out}/${name}-tray.png` })
      await page.locator('[data-quick="theme"]').tap()
      await page.waitForTimeout(250)
      await page.screenshot({ path: `${out}/${name}-theme.png` })
      measurements.push(await page.evaluate(name => {
        const menu = document.querySelector('.quick-themes')
        return { name, rect: menu.getBoundingClientRect().toJSON(), theme: document.documentElement.dataset.theme,
          familyTheme: document.documentElement.dataset.bbTheme, body: getComputedStyle(document.body).backgroundColor,
          frost: getComputedStyle(menu).backgroundColor, bar: getComputedStyle(document.querySelector('.top')).backgroundColor,
          tray: getComputedStyle(document.querySelector('.quick-panel')).backgroundColor,
          accent: getComputedStyle(document.documentElement).getPropertyValue('--bb-accent').trim(), scrollWidth: document.documentElement.scrollWidth }
      }, name))
      console.log(name)
    } finally { await context.close() }
  }
} finally { await browser?.close(); await worker.close() }
await writeFile(`${out}/${phase}.json`, JSON.stringify(measurements, null, 2))
const files = (await readdir(out)).filter(name => /^(before|after)-.*\.png$/.test(name)).sort()
const cellW = 220, cellH = 280, columns = 6
const tiles = await Promise.all(files.map(async (name, i) => {
  const shot = await sharp(`${out}/${name}`).resize(212, 250, { fit: 'contain', background: '#202027' }).png().toBuffer()
  const label = Buffer.from(`<svg width="220" height="24"><text x="4" y="16" fill="white" font-size="10" font-family="sans-serif">${name.replace('.png', '')}</text></svg>`)
  return [{ input: shot, left: (i % columns) * cellW + 4, top: Math.floor(i / columns) * cellH + 24 },
    { input: label, left: (i % columns) * cellW, top: Math.floor(i / columns) * cellH }]
}))
await sharp({ create: { width: columns * cellW, height: Math.ceil(files.length / columns) * cellH, channels: 3, background: '#202027' } })
  .composite(tiles.flat()).png().toFile(`${out}/contact-sheet.png`)

await distill(out, { keepRaw: process.argv.includes("--keep-raw") || process.env.OBPAL_KEEP_RAW === "1" })
