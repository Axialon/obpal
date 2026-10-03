/** Classic scrollbar contacts, measured in the canvas's actual visible border box. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { tempScope } from './lib/temp.mjs'
import { rawRun } from './lib/distill.mjs'

export async function runHomeMatrix(_browser, local, check) {
  await check('viewport field alignment matrix', async () => {
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'matrix')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = [], sizing = [], temps = tempScope()
    const extension = await temps.make(join(tmpdir(), 'obpal-zoom-extension-'))
    await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Home zoom fixture', version: '1.0', permissions: ['tabs'], background: { service_worker: 'worker.js' } }))
    await writeFile(join(extension, 'worker.js'), 'chrome.runtime.onInstalled.addListener(() => {})')
    try {
      for (const [width, height] of [[1920, 1080], [1440, 900]]) for (const dpr of [1, 1.25, 1.5]) {
        const profile = await temps.make(join(tmpdir(), 'obpal-zoom-profile-'))
        const context = await chromium.launchPersistentContext(profile, e2eBrowserOptions({
          executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true,
          viewport: null, ignoreHTTPSErrors: true,
          ignoreDefaultArgs: ['--hide-scrollbars'],
          args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--force-device-scale-factor=${dpr}`, `--window-size=${width},${height}`, '--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        }))
        try {
          await context.addInitScript(() => {
            const request = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window), pending = new Map()
            let next = 0
            window.__matrixFrames = { frozen: false }
            window.requestAnimationFrame = callback => {
              const id = ++next
              const run = time => {
                if (window.__matrixFrames.frozen) pending.set(id, request(run))
                else { pending.delete(id); callback(time) }
              }
              pending.set(id, request(run))
              return id
            }
            window.cancelAnimationFrame = id => { const scheduled = pending.get(id); if (scheduled !== undefined) cancel(scheduled); pending.delete(id) }
          })
          const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker')
          const page = context.pages()[0] || await context.newPage()
          await page.goto(`${local.origin}/?debug=colliders`)
          const scrollbarFixture = await classicScrollbar(page)
          await page.mouse.move(3, 300)
          await page.waitForFunction(() => document.querySelector('[data-pair-slot] > *')?.shadowRoot?.querySelector('.qr svg'))
          // Keep native zoom effective: device-metric emulation would pin the CSS viewport and DPR.
          const cdp = await context.newCDPSession(page)
          const { windowId } = await cdp.send('Browser.getWindowForTarget')
          // Set the content area directly: outer-window rounding otherwise leaves a few pixels at fractional DPR.
          const attempts = []
          sizing.push({ viewport: [width, height], dpr, attempts })
          let requestedWidth = width, requestedHeight = height
          for (let attempt = 0; attempt < 8; attempt++) {
            await cdp.send('Browser.setContentsSize', { windowId, width: requestedWidth, height: requestedHeight })
            await page.waitForTimeout(150)
            const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
            attempts.push({ requested: [requestedWidth, requestedHeight], observed: [size.width, size.height] })
            // Native window borders quantize at fractional DPR. One CSS pixel stays inside the final zoom gate.
            if (Math.abs(size.width - width) <= 1 && Math.abs(size.height - height) <= 1) break
            requestedWidth += width - size.width
            requestedHeight += height - size.height
          }
          console.log(`  native content ${width}x${height} DPR ${dpr}: ${JSON.stringify(attempts)}`)
          for (const zoom of [1, .9, 1.25]) {
            const actualZoom = await worker.evaluate(async ({ origin, zoom }) => {
              const tab = (await chrome.tabs.query({})).find(tab => tab.url?.startsWith(origin))
              await chrome.tabs.setZoom(tab.id, zoom)
              return chrome.tabs.getZoom(tab.id)
            }, { origin: local.origin, zoom })
            await page.evaluate(() => scrollTo(0, 0))
            await page.waitForFunction(() => window.__home?.contacts().rects.length > 20)
            await page.waitForTimeout(500)
            const environment = await page.evaluate(() => ({ innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, dpr: devicePixelRatio, visualViewport: { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop }, gfx: window.__home.gfx() }))
            const name = `${width}x${height}-dpr${dpr}-zoom${zoom}`
            const row = { viewport: [width, height], baseDpr: dpr, zoom, actualZoom, scrollbarFixture, environment, contacts: [] }
            results.push(row)
            const cards = await page.locator('main .pair, main .scene, main .build-card').count()
            for (let card = 0; card < cards; card++) {
              const beforeScroll = await page.locator('main .pair, main .scene, main .build-card').nth(card).evaluate(el => {
                const draws = window.__home.activity().draws, previous = scrollY, r = el.getBoundingClientRect()
                scrollTo(0, scrollY + r.y + r.height / 2 - innerHeight / 2)
                return { draws, changed: scrollY !== previous }
              })
              // Scroll enters physics in the shared drawing frame. Do not freeze between DOM scroll and that frame.
              if (beforeScroll.changed) await page.waitForFunction(({ draws }) => window.__home.activity().draws > draws, beforeScroll)
              await page.waitForTimeout(180)
              await page.evaluate(() => { window.__matrixFrames.frozen = true })
              for (const side of ['left', 'right', 'top', 'bottom']) {
                const contact = await page.evaluate(({ card, side }) => {
                  const el = document.querySelectorAll('main .pair, main .scene, main .build-card')[card]
                  const r = el.getBoundingClientRect(), canvas = document.querySelector('.hero-stage'), c = canvas.getBoundingClientRect()
                  window.__home.clearSeeds()
                  window.__home.seed(side, side === 'left' ? r.left : side === 'right' ? r.right : r.x + r.width / 2, side === 'top' ? r.top : side === 'bottom' ? r.bottom : r.y + r.height / 2)
                  const sphere = window.__home.outline(`proof-${side}`), seedRadius = (sphere.right - sphere.left) / 2
                  const seedX = side === 'left' ? r.left - seedRadius + 1 : side === 'right' ? r.right + seedRadius - 1 : r.x + r.width / 2
                  const seedY = side === 'top' ? r.top - seedRadius + 1 : side === 'bottom' ? r.bottom + seedRadius - 1 : r.y + r.height / 2
                  window.__home.seed(side, seedX, seedY)
                  window.__home.showSeeds()
                  const o = window.__home.outline(`proof-${side}`), [W, H] = window.__home.gfx().css
                  const drawn = { left: c.x + o.left * c.width / W, right: c.x + o.right * c.width / W, top: c.y + o.top * c.height / H, bottom: c.y + o.bottom * c.height / H }
                  const gap = side === 'left' ? r.left - drawn.right : side === 'right' ? drawn.left - r.right : side === 'top' ? r.top - drawn.bottom : drawn.top - r.bottom
                  const radius = (drawn.right - drawn.left) / 2
                  const cx = side === 'left' ? r.left - radius : side === 'right' ? r.right + radius : r.x + r.width / 2
                  const cy = side === 'top' ? r.top - radius : side === 'bottom' ? r.bottom + radius : r.y + r.height / 2
                  const blockers = window.__home.contacts().rects.filter(b => {
                    if (!b.rect.exclude) return false
                    const q = b.rect, y = q.y - (q.fixed ? 0 : scrollY)
                    if (b.owner === el.className && Math.abs(q.x - r.x) + Math.abs(y - r.y) < 2) return false
                    const dx = Math.max(q.x - cx, 0, cx - q.x - q.w), dy = Math.max(y - cy, 0, cy - y - q.h)
                    return Math.hypot(dx, dy) < radius - 1
                  }).map(b => b.owner)
                  if (cx - radius < 0 || cx + radius > c.right || cy - radius < o.area.top || cy + radius > o.area.bottom) blockers.push('viewport edge')
                  return { card, owner: el.className, scrollY, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, canvas: { x: c.x, y: c.y, width: c.width, height: c.height }, contacts: [{ side, gap, drawn, blockers }], png: canvas.toDataURL() }
                }, { card, side })
                const png = Buffer.from(contact.png.split(',')[1], 'base64')
                const pixels = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
                delete contact.png
                for (const sample of contact.contacts) sample.raster = rasterContact(pixels, contact, sample)
                row.contacts.push(contact)
                if (card === 0 && ['left', 'right'].includes(side)) {
                  const path = `${name}-${side}.png`
                  // CDP clips use pre-zoom DIP; the DOM viewport reports CSS pixels after browser zoom.
                  const cssClip = await page.evaluate(() => ({ x: scrollX, y: scrollY, width: innerWidth, height: innerHeight }))
                  const clip = { x: cssClip.x * actualZoom, y: cssClip.y * actualZoom, width: cssClip.width * actualZoom, height: cssClip.height * actualZoom, scale: 1 }
                  const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false, clip })
                  const overlay = Buffer.from(capture.data, 'base64')
                  await writeFile(join(raw, path), overlay)
                  const overlaySize = await sharp(overlay).metadata()
                  contact.capture = { method: 'Page.captureScreenshot CSS viewport converted to pre-zoom DIP', cssClip, protocolClip: clip, actualZoom, bitmap: [overlaySize.width, overlaySize.height] }
                  const blocked = contact.contacts.flatMap(c => c.blockers)
                  frames.push({ path, blocked, failed: blocked.length ? undefined : contact.contacts.some(c => Math.abs(c.gap) > 1) })
                  const canvasPath = `${name}-${side}-canvas.png`
                  await writeFile(join(raw, canvasPath), png)
                  frames.push({ path: canvasPath, blocked, failed: blocked.length ? undefined : contact.contacts.some(c => !c.raster || Math.abs(c.raster.gap) > 2) })
                }
              }
              await page.evaluate(() => { window.__home.clearSeeds(); window.__matrixFrames.frozen = false })
            }
            console.log(`  matrix ${name}: gutter=${environment.innerWidth - environment.clientWidth}; observed DPR=${environment.dpr}; zoom=${actualZoom}; maximum=${Math.max(...row.contacts.flatMap(c => c.contacts.filter(s => !s.blockers.length).map(s => Math.abs(s.gap)))).toFixed(2)}px`)
          }
        } finally { await context.close() }
      }
    } finally {
      await writeFile(join(out, 'measurements.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), zoomMethod: 'chrome.tabs.setZoom', captureTiming: 'Test RAF gate freezes the measured contact through its canvas and overlay captures; resumed between cards.', raster: { minimumAlpha: 64, minimumChannel: 220, toleranceCssPx: 2 }, sizing, results }, null, 2))
      const summary = results.map(row => {
        const all = row.contacts.flatMap(c => c.contacts), tested = all.filter(c => !c.blockers.length)
        const qr = row.contacts.filter(c => c.card === 0).flatMap(c => c.contacts)
        return { viewport: row.viewport, baseDpr: row.baseDpr, zoom: row.zoom, scrollbarFixture: row.scrollbarFixture, observedDpr: row.environment.dpr, layoutWidth: row.environment.innerWidth, gutter: row.environment.innerWidth - row.environment.clientWidth, qr: Object.fromEntries(qr.filter(c => ['left', 'right'].includes(c.side)).map(c => [c.side, { projected: c.gap, raster: c.raster?.gap ?? null }])), maximumProjected: Math.max(...tested.map(c => Math.abs(c.gap))), maximumRaster: Math.max(...tested.map(c => c.raster ? Math.abs(c.raster.gap) : Infinity)), tested: tested.length, blocked: all.length - tested.length, rasterMissing: tested.filter(c => !c.raster).length }
      })
      await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2))
      await writeFile(join(out, 'summary.md'), ['| Viewport | DPR | Zoom | CSS width / gutter | QR left / right | Max projection / raster | Tested / blocked |', '|---|---:|---:|---:|---:|---:|---:|', ...summary.map(r => `| ${r.viewport.join('×')} | ${r.baseDpr} | ${r.zoom * 100}% | ${r.layoutWidth} / ${r.gutter} | ${r.qr.left?.projected.toFixed(2)} / ${r.qr.right?.projected.toFixed(2)} | ${r.maximumProjected.toFixed(2)} / ${r.maximumRaster.toFixed(2)} | ${r.tested} / ${r.blocked} |`)].join('\n') + '\n')
      await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 72, frames }, null, 2))
      await temps.cleanup()
    }
    if (results.length !== 18 || results.some(r => r.environment.innerWidth <= r.environment.clientWidth || Math.abs(r.actualZoom - r.zoom) > .001 || Math.abs(r.environment.innerWidth - r.viewport[0] / r.zoom) > 2 || Math.abs(r.environment.innerHeight - r.viewport[1] / r.zoom) > 2 || Math.abs(r.environment.dpr - r.baseDpr * r.zoom) > .01)) throw new Error('matrix environment missing classic scrollbar or effective native zoom')
    const samples = results.flatMap(r => r.contacts.flatMap(c => c.contacts)).filter(c => !c.blockers.length)
    const cards = [...new Set(results.flatMap(r => r.contacts.map(c => c.card)))]
    if (results.some(r => new Set(r.contacts.filter(c => c.contacts.some(s => !s.blockers.length)).map(c => c.card)).size < Math.ceil(cards.length / 2)) || cards.some(card => !results.some(r => r.contacts.some(c => c.card === card && c.contacts.some(s => !s.blockers.length))))) throw new Error('insufficient accessible matrix contacts')
    if (!process.env.OBPAL_CONTACT_BASELINE && samples.some(c => Math.abs(c.gap) > 1 || !c.raster || Math.abs(c.raster.gap) > 2)) throw new Error('rendered contact exceeds 1px projection or 2px raster tolerance')
    return `${results.length} environments; ${samples.length} rendered contacts`
  })
}

/** A native gutter is preferred; a page-only classic track is the fallback on overlay-scrollbar hosts. */
async function classicScrollbar(page) {
  if (await page.evaluate(() => innerWidth > document.documentElement.clientWidth)) return false
  await page.addStyleTag({ content: 'html { overflow-y: scroll !important; } ::-webkit-scrollbar { width: 15px; height: 15px; }' })
  await page.waitForTimeout(100)
  return true
}

/** Locate the glass rim, including its white reflection, while excluding the faint pool and halo. */
export function rasterContact({ data, info }, { canvas, rect }, { side, drawn }) {
  const sx = info.width / canvas.width, sy = info.height / canvas.height
  const x0 = Math.max(0, Math.floor((drawn.left - canvas.x - 3) * sx)), x1 = Math.min(info.width, Math.ceil((drawn.right - canvas.x + 3) * sx))
  const y0 = Math.max(0, Math.floor((drawn.top - canvas.y - 3) * sy)), y1 = Math.min(info.height, Math.ceil((drawn.bottom - canvas.y + 3) * sy))
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, count = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const at = (y * info.width + x) * 4
    if (data[at + 3] < 64 || Math.max(data[at], data[at + 1], data[at + 2]) < 220) continue
    left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1); count++
  }
  if (!count) return null
  const rim = side === 'left' ? canvas.x + right / sx : side === 'right' ? canvas.x + left / sx : side === 'top' ? canvas.y + bottom / sy : canvas.y + top / sy
  return { gap: side === 'left' ? rect.x - rim : side === 'right' ? rim - rect.x - rect.width : side === 'top' ? rect.y - rim : rim - rect.y - rect.height, rim, pixels: count, pixelCssSize: [1 / sx, 1 / sy] }
}
