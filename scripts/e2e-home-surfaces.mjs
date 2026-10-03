/** Border, light and text proof, using the home runner's browser lease and helper guard. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { rawRun } from './lib/distill.mjs'

export async function runHomeSurfaces(browser, local, check) {
  await check('viewport field surface audit: borders, round controls, light and headings', async () => {
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'surfaces')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = [], strips = []
    const capture = async (page, group, phase, clip) => {
      await mkdir(join(raw, group), { recursive: true })
      const path = `${group}/${phase}.png`
      const png = await page.screenshot({ path: join(raw, path), ...(clip ? { clip } : {}) })
      frames.push({ path, phase, failed: false })
      return png
    }
    try {
      for (const [width, height, dpr] of [[1920, 1080, 1], [1440, 900, 2], [390, 844, 3]]) {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, ignoreHTTPSErrors: true })
        const page = await context.newPage()
        try {
          await page.goto(`${local.origin}/?debug=colliders`)
          await page.waitForFunction(() => window.__home?.contacts().rects.length > 20)
          const audit = async phase => {
            const rows = await page.evaluate(() => {
              const contacts = window.__home.contacts().rects
              return [...document.querySelectorAll('main .pair, main .scene, main .build-card, main a, main button, main .qi, main .live-dot, [data-hint], .field-controls button')].flatMap(el => {
                if (!el.matches('.pair, .scene, .build-card') && el.closest('.pair, .scene, .build-card')) return []
                const r = el.getBoundingClientRect(), css = getComputedStyle(el)
                if (!r.width || !r.height || el.hidden || el.classList.contains('gone')) return []
                const matches = contacts.filter(b => b.owner === el.className)
                const b = matches.sort((a, b) => Math.abs(a.rect.x - r.x) + Math.abs(a.rect.y - (a.rect.fixed ? 0 : scrollY) - r.y) - Math.abs(b.rect.x - r.x) - Math.abs(b.rect.y - (b.rect.fixed ? 0 : scrollY) - r.y))[0]?.rect
                if (!b) return [{ owner: el.className, missing: true }]
                const y = b.y - (b.fixed ? 0 : scrollY)
                const overlay = document.querySelector(`[data-collider="${matches[0].id}"]`)
                const drawn = overlay ? ['x', 'y', 'width', 'height'].map(name => Number(overlay.getAttribute(name))) : null
                return [{ owner: el.className, edges: [b.x - r.left, b.x + b.w - r.right, y - r.top, y + b.h - r.bottom], overlayDelta: drawn ? Math.max(Math.abs(drawn[0] - b.x), Math.abs(drawn[1] - y), Math.abs(drawn[2] - b.w), Math.abs(drawn[3] - b.h)) : null, radius: b.r, visibleRadius: css.borderTopLeftRadius, exclude: !!b.exclude, fixed: !!b.fixed }]
              })
            })
            results.push({ viewport: [width, height], dpr, phase, rows })
          }
          await audit('before QR')
          await page.mouse.move(3, 300)
          await page.waitForFunction(() => document.querySelector('[data-pair-slot] > *')?.shadowRoot?.querySelector('.qr svg'))
          await page.waitForTimeout(1200)
          await audit('loaded QR')
          if (!process.env.OBPAL_CONTACT_BASELINE) await page.waitForSelector('[data-collider-debug] rect')
          await capture(page, `${width}-overlay`, 0)
          await page.evaluate(() => { const overlay = document.querySelector('[data-collider-debug]'); if (overlay) overlay.style.visibility = 'hidden' })
          // Exercise press scaling while the original pointer event still reaches the button.
          for (const selector of ['.cta .btn', '[data-field-toggle]', '[data-sound]']) {
            await page.locator(selector).first().hover()
            await page.mouse.down()
            await page.waitForTimeout(60)
            await audit(`pressed ${selector}`)
            await page.mouse.move(3, 300)
            await page.mouse.up()
            await page.waitForTimeout(250)
            await audit(`released ${selector}`)
          }
          const controls = await page.evaluate(() => {
            const [a, b] = [...document.querySelectorAll('.field-controls button')].map(el => el.getBoundingClientRect())
            const tab = document.querySelector('.quick-tab')?.getBoundingClientRect()
            const pegs = window.__home.contacts().rects.filter(b => b.rect.fixed)
            return { gap: b.top - a.bottom, pegs: pegs.map(b => ({ exclude: !!b.rect.exclude, r: b.rect.r, w: b.rect.w })), tabClear: !tab || [a, b].every(r => r.right <= tab.left || r.left >= tab.right || r.bottom <= tab.top || r.top >= tab.bottom) }
          })
          results.push({ viewport: [width, height], phase: 'controls', ...controls })
          // Seed a drawn sphere against each straight card edge, before any wall-clock movement.
          const contacts = await page.evaluate(() => {
            const el = document.querySelector('.pair'), r = el.getBoundingClientRect()
            return ['left', 'right', 'top', 'bottom'].map(side => {
              window.__home.clearSeeds()
              const x = side === 'left' ? r.left : side === 'right' ? r.right : r.x + r.width / 2
              const y = side === 'top' ? r.top : side === 'bottom' ? r.bottom : r.y + r.height / 2
              window.__home.seed(side, x, y)
              const sphere = window.__home.outline(`proof-${side}`), radius = (sphere.right - sphere.left) / 2
              const contactX = side === 'left' ? x - radius + 1 : side === 'right' ? x + radius - 1 : x
              const contactY = side === 'top' ? y - radius + 1 : side === 'bottom' ? y + radius - 1 : y
              window.__home.seed(side, contactX, contactY)
              window.__home.showSeeds()
              const o = window.__home.outline(`proof-${side}`)
              const gap = side === 'left' ? r.left - o.right : side === 'right' ? o.left - r.right : side === 'top' ? r.top - o.bottom : o.top - r.bottom
              return { side, gap, outline: o }
            })
          })
          results.push({ viewport: [width, height], phase: 'card contact', contacts })
          if (width > 390) {
            const light = await page.evaluate(() => {
              window.__home.clearSeeds()
              const r = document.querySelector('.pair').getBoundingClientRect()
              window.__home.seed('card-light', r.left, r.y + r.height / 2)
              const sphere = window.__home.outline('proof-card-light')
              window.__home.seed('card-light', r.left - (sphere.right - sphere.left) / 2 + 1, r.y + r.height / 2)
              window.__home.showSeeds()
              return { png: document.querySelector('.hero-stage').toDataURL(), x: r.x + 12, y: r.y + r.height / 2 - 35, w: 50, h: 70, cssWidth: innerWidth }
            })
            const { data, info } = await sharp(Buffer.from(light.png.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
            const scale = info.width / light.cssWidth
            let brightPixels = 0, maximumAlpha = 0
            for (let y = Math.max(0, Math.floor(light.y * scale)); y < Math.min(info.height, (light.y + light.h) * scale); y++) {
              for (let x = Math.max(0, Math.floor(light.x * scale)); x < Math.min(info.width, (light.x + light.w) * scale); x++) {
                const at = (y * info.width + x) * 4, alpha = data[at + 3]
                maximumAlpha = Math.max(maximumAlpha, alpha)
                if (data[at + 1] > 128 && alpha > 96) brightPixels++
              }
            }
            results.push({ viewport: [width, height], phase: 'card interior light', brightPixels, maximumAlpha })
          }
          await page.evaluate(() => window.__home.clearSeeds())
          await page.setViewportSize({ width: width - 10, height })
          await page.waitForTimeout(300)
          await audit('resized')
          await page.setViewportSize({ width, height })
          await page.waitForTimeout(300)
          const boundaries = await page.evaluate(() => [...document.querySelectorAll('.hero, .sec-head, .build, .closer, .site-foot')].flatMap((el, i) => {
            const r = el.getBoundingClientRect()
            return [{ name: `${i}-${el.classList[0]}-top`, y: r.top + scrollY }, { name: `${i}-${el.classList[0]}-bottom`, y: r.bottom + scrollY }]
          }).filter(b => b.y > 200 && b.y < document.documentElement.scrollHeight - 200))
          for (const boundary of boundaries) {
            await page.evaluate(y => scrollTo(0, y - innerHeight / 2), boundary.y)
            await page.waitForTimeout(150)
            results.push({ viewport: [width, height], phase: `light masks ${boundary.name}`, masks: await page.evaluate(() => window.__home.gfx().surfaceMasks) })
            const images = []
            for (const [phase, offset] of [-44, -22, 0, 22, 44].entries()) {
              await page.evaluate(({ y, offset }) => { window.__home.clearSeeds(); window.__home.seed('boundary', innerWidth / 2, y - scrollY + offset); window.__home.showSeeds() }, { y: boundary.y, offset })
              const clip = { x: Math.max(0, width / 2 - 220), y: Math.max(0, Math.min(height - 180, boundary.y - await page.evaluate(() => scrollY) - 90)), width: Math.min(440, width), height: 180 }
              if (clip.x + clip.width > width) clip.x = 0
              images.push(await capture(page, `${width}-${boundary.name}`, phase, clip))
            }
            const tiles = await Promise.all(images.map(png => sharp(png).resize(440, 180, { fit: 'contain', background: '#111' }).png().toBuffer()))
            const name = `strip-${width}-${boundary.name}.webp`
            await sharp({ create: { width: 2200, height: 180, channels: 3, background: '#111' } }).composite(tiles.map((input, i) => ({ input, left: i * 440, top: 0 }))).webp().toFile(join(out, name))
            strips.push(name)
          }
          const lighting = await page.evaluate(() => {
            window.__home.clearSeeds()
            return { transparentMasks: window.__home.contacts().rects.filter(b => /sec-head|site-foot/.test(b.owner)).length, headingMasks: window.__home.contacts().rects.filter(b => b.rect.rings).length }
          })
          results.push({ viewport: [width, height], phase: 'light and text', ...lighting })
        } finally { await context.close() }
      }
    } finally {
      await writeFile(join(out, 'measurements.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), scenarios: 'seeded card edges, press transform, QR layout, resize, five phases at each section boundary', results, strips }, null, 2))
      await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 25, frames }, null, 2))
    }
    if (!process.env.OBPAL_CONTACT_BASELINE) {
      const borders = results.flatMap(r => r.rows || [])
      const maximum = Math.max(...borders.flatMap(r => r.edges?.map(Math.abs) || [Infinity]))
      if (maximum > 1) throw new Error(`collider edge delta ${maximum.toFixed(2)}px >1px`)
      if (borders.some(r => r.overlayDelta === null || r.overlayDelta > 1)) throw new Error('debug outlines disagree with cached colliders')
      if (results.filter(r => r.phase === 'controls').some(r => r.gap < 24 || !r.tabClear || r.pegs.some(p => !p.exclude || Math.abs(p.r - p.w / 2) > 1))) throw new Error('controls lack separated round exclusion pegs')
      if (results.filter(r => r.phase === 'light and text').some(r => r.transparentMasks || r.headingMasks)) throw new Error('transparent containers or heading text still mask the marble light')
      if (results.some(r => r.masks?.overflow)) throw new Error('visible surfaces exceed the ground-light mask budget')
      if (results.some(r => r.phase === 'card interior light' && r.brightPixels)) throw new Error('bright ground light is drawn inside the QR card')
      if (results.filter(r => r.phase === 'card contact' && r.viewport[0] > 390).some(r => r.contacts.some(c => Math.abs(c.gap) > 1))) throw new Error('drawn marble rim does not meet the card edge within 1px')
    }
    return `${results.length} measurements; ${strips.length} boundary strips`
  })
}
