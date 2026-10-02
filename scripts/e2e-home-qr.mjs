/** The home-owned pairing frame, shared stroke icons and bottom-right controls at the owner's three widths. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { rawRun } from './lib/distill.mjs'

export async function runHomeQr(browser, local, check) {
  await check('viewport field QR audit: centring, icon row, contrast and toggle placement', async () => {
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'qr-controls')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = []
    for (const [width, height] of [[1920, 1080], [1440, 900], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      const page = await context.newPage()
      try {
        await page.goto(local.origin)
        await page.mouse.move(3, 300)
        await page.waitForFunction(() => document.querySelector('[data-pair-slot] > *')?.shadowRoot?.querySelector('.qr svg'))
        await page.waitForTimeout(1000)
        await mkdir(join(raw, String(width)), { recursive: true })
        for (const theme of ['carbon', 'light']) {
          await page.evaluate(theme => { document.documentElement.dataset.bbTheme = theme; dispatchEvent(new Event('bb-theme')) }, theme)
          await page.waitForTimeout(250)
          await page.locator('[data-pair]').evaluate(el => el.scrollIntoView({ block: 'center' }))
          await page.waitForTimeout(100)
          const measurement = await page.evaluate(() => {
            const pair = document.querySelector('[data-pair]'), box = pair.getBoundingClientRect(), root = document.querySelector('[data-pair-slot] > *').shadowRoot
            const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
            const qr = rect(root.querySelector('.qr'))
            const icons = [...root.querySelectorAll('.pair-icons svg, summary svg')].map(el => ({ ...rect(el), color: getComputedStyle(el).color }))
            return { card: rect(pair), qr, icons, gapLeft: qr.x - box.x, gapRight: box.right - qr.x - qr.w }
          })
          const path = `${width}/${theme}-qr.png`, png = await page.locator('[data-pair]').screenshot({ path: join(raw, path) })
          frames.push({ path, timeMs: 0, failed: false })
          const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
          const icon = measurement.icons[0], x = Math.max(0, Math.floor(icon.x + icon.w / 2 - measurement.card.x)), y = Math.max(0, Math.floor(icon.y - measurement.card.y - 5))
          const pixel = (y * info.width + x) * info.channels, background = [...data.subarray(pixel, pixel + 3)]
          const foreground = icon.color.match(/[\d.]+/g).slice(0, 3).map(Number)
          const luminance = c => c.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0)
          const a = luminance(foreground), b = luminance(background), contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05)
          results.push({ viewport: [width, height], theme, ...measurement, background, foreground, contrast })
          await writeFile(join(out, 'measurements.json'), JSON.stringify(results, null, 2))
          if (!process.env.OBPAL_CONTACT_BASELINE && (Math.abs(measurement.gapLeft - measurement.gapRight) > 1 || measurement.icons.some(i => i.w !== 28 || Math.abs(i.y - icon.y) > 1) || contrast < 3)) throw new Error(`${width}/${theme}: QR centring, icon baseline or contrast failed`)
        }
        await page.evaluate(() => scrollTo(0, 0))
        for (const state of ['on', 'off']) {
          if (state === 'off') await page.locator('[data-field-toggle]').click()
          const path = `${width}/${state}-controls.png`
          await page.screenshot({ path: join(raw, path) })
          frames.push({ path, timeMs: 0, failed: false })
        }
      } finally { await context.close() }
    }
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 1, frames }, null, 2))
    return results.map(r => `${r.viewport[0]}/${r.theme}: gaps ${r.gapLeft.toFixed(1)}/${r.gapRight.toFixed(1)}px, contrast ${r.contrast.toFixed(1)}:1`).join('; ')
  })
}
