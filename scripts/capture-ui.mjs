/**
 * Evidence for the glass kit and the sim catalogue (/sim/): screenshots from this checkout's build, served by the local
 * stand-in on the lane's ports, into artifacts/ui-system/ (git ignores it), with an offline viewer, index.html.
 *
 *   node scripts/capture-ui.mjs            the catalogue at five sizes, its states (the list open, the rail, the
 *                                          drawer, the sheet), the components sheet and the platform's other selects
 *   node scripts/capture-ui.mjs --before   the catalogue at five sizes, as before-*.png, from whatever is built
 *   --only=<name,...>                      some shots: sizes, states, kit, picker, sweep
 *
 * Needs OBPAL_E2E_PORT and OBPAL_E2E_WORKER_PORT (free), a build (vite build), and Playwright's Chromium or
 * OBPAL_E2E_CHROMIUM. Never writes into the repository outside artifacts/.
 */
import { distill } from './lib/distill.mjs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'

const before = process.argv.includes('--before')
const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean)
const wanted = (name) => !only.length || only.includes(name)
const out = 'artifacts/ui-system'
export const SIZES = [[1920, 1080], [1440, 900], [1024, 768], [390, 844], [844, 390]]
const phone = (w, h) => w <= 700 || h <= 500

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

/** A page at a size, phones as phones (touch, a phone's pixel ratio), reduced motion so shots don't catch a slide. */
async function open(path, [width, height], { motion = 'reduce' } = {}) {
  const small = phone(width, height)
  const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, reducedMotion: motion, deviceScaleFactor: small ? 2 : 1, isMobile: small, hasTouch: small })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(`${path} ${width}x${height}: ${e.message}`))
  await page.goto(`${local.origin}${path}`)
  return { page, close: () => context.close() }
}
async function catalogue(size, query = '') {
  const o = await open(`/sim/${query}`, size)
  await o.page.waitForSelector('.dcard-stage.live')
  await o.page.evaluate(() => document.fonts.ready)
  await o.page.waitForTimeout(700)
  return o
}
const shot = (page, name, opts = {}) => page.screenshot({ path: join(out, `${name}.png`), ...opts })

try {
  if (wanted('sizes')) {
    for (const size of SIZES) {
      const { page, close } = await catalogue(size)
      await shot(page, `${before ? 'before' : 'after'}-sim-${size[0]}x${size[1]}`)
      await close()
    }
  }
  if (!before && wanted('states')) {
    // The glass select open, on a filtered view, at the owner's size.
    {
      const { page, close } = await catalogue([1920, 1080], '?category=robotics')
      await page.locator('#controller-filter').click()
      await page.waitForTimeout(250)
      await shot(page, 'after-select-open-1920x1080')
      await page.keyboard.type('tr')
      await page.waitForTimeout(150)
      await shot(page, 'after-select-typeahead-1920x1080', { clip: { x: 0, y: 0, width: 960, height: 1080 } })
      await page.keyboard.press('Enter')
      await page.waitForTimeout(300)
      await shot(page, 'after-select-chosen-1920x1080')
      await close()
    }
    // The rail, and its list beside it.
    {
      const { page, close } = await catalogue([1440, 900], '?face=wii')
      await page.locator('#side-toggle').click()
      await page.waitForTimeout(400)
      await shot(page, 'after-sidebar-collapsed-1440x900')
      await page.locator('#controller-filter').click()
      await page.waitForTimeout(250)
      await shot(page, 'after-rail-select-1440x900')
      await page.keyboard.press('Escape')
      await page.locator('#side-toggle').click()
      await close()
    }
    // A tablet's drawer.
    {
      const { page, close } = await catalogue([1024, 768], '?category=vehicles')
      await shot(page, 'after-tablet-rail-1024x768')
      await page.locator('#side-toggle').click()
      await page.waitForTimeout(400)
      await shot(page, 'after-tablet-drawer-1024x768')
      await close()
    }
    // A phone's sheet, upright and sideways.
    for (const size of [[390, 844], [844, 390]]) {
      const { page, close } = await catalogue(size, '?face=gamepad')
      await page.locator('#filters-open').click()
      await page.waitForTimeout(450)
      await shot(page, `after-phone-sheet-${size[0]}x${size[1]}`)
      await close()
    }
  }
  if (!before && wanted('sweep')) {
    for (const [name, path, size, pick] of [
      ['arm', '/sim/arm/', [1440, 900], '.arm-kind .kit-select'],
      ['catalogue-builder', '/catalogue/#build', [1440, 900], '#base + .kit-select, .kit-select-for'],
      ['view-phone', '/view/', [390, 844], null],
      ['device-studio', '/sim/device/?d=studio', [1440, 900], null],
    ]) {
      const { page, close } = await open(path, size)
      await page.waitForTimeout(3500)
      await shot(page, `after-${name}-${size[0]}x${size[1]}`)
      if (pick) {
        const b = page.locator(pick).first()
        if (await b.count()) {
          await b.scrollIntoViewIfNeeded()
          await b.click()
          await page.waitForTimeout(300)
          await shot(page, `after-${name}-open-${size[0]}x${size[1]}`)
        }
      }
      await close()
    }
  }
  if (!before && wanted('picker')) {
    // The surface and accent picker: each surface previews the accent in effect, each accent the surface in effect.
    for (const [surface, accent] of [['carbon', 'product'], ['navy', 'rose'], ['light', 'sky']]) {
      const { page, close } = await open('/sim/device/?d=lamp', [1440, 900])
      await page.waitForFunction(() => window.BlackboxesFamily)
      await page.evaluate(([s, a]) => { window.BlackboxesFamily.setTheme(s); window.BlackboxesFamily.setAccent(a) }, [surface, accent])
      await page.waitForTimeout(2500)
      await page.locator('#t-theme').click()
      await page.waitForTimeout(400)
      const menu = await page.locator('#themes').boundingBox()
      await shot(page, `after-picker-${surface}-${accent}`, { clip: { x: Math.max(0, menu.x - 16), y: Math.max(0, menu.y - 16), width: menu.width + 32, height: menu.height + 32 } })
      await page.evaluate(() => { window.BlackboxesFamily.setTheme('carbon'); window.BlackboxesFamily.setAccent('product') })
      await close()
    }
  }
  if (!before && wanted('kit')) {
    const { page, close } = await open('/sim/?kit=sheet', [1440, 1500], { motion: 'no-preference' })
    await page.waitForSelector('html[data-kit-sheet="ready"]')
    await page.waitForTimeout(900)
    await shot(page, 'after-components-sheet', { fullPage: true })
    await close()
  }
} finally {
  await browser.close()
  await local.close()
}

// ---- the viewer --------------------------------------------------------------------------------------------------------
const files = (await readdir(out)).filter((f) => f.endsWith('.png')).sort()
const group = (f) => f.startsWith('before-') ? 'before' : /components/.test(f) ? 'kit' : /picker/.test(f) ? 'picker' : /-(arm|catalogue-builder|view-phone|device-studio)-/.test(f) ? 'sweep' : /sim-\d/.test(f) ? 'after' : 'states'
const title = (f) => f.replace(/\.png$/, '').replaceAll('-', ' ')
const pairs = SIZES.map(([w, h]) => `${w}x${h}`).map((s) => `<section class="pair"><h3>${s}</h3><div><figure><figcaption>Before</figcaption><a href="before-sim-${s}.png"><img loading="lazy" src="before-sim-${s}.png" alt="Before, ${s}"></a></figure><figure><figcaption>After</figcaption><a href="after-sim-${s}.png"><img loading="lazy" src="after-sim-${s}.png" alt="After, ${s}"></a></figure></div></section>`).join('\n')
const figures = (g) => files.filter((f) => group(f) === g).map((f) => `<figure><a href="${f}"><img loading="lazy" src="${f}" alt="${title(f)}"></a><figcaption>${title(f)}</figcaption></figure>`).join('\n')
// The platform's other pages, before and after, where both were captured.
const swept = files.filter((f) => f.startsWith('before-') && !/^before-(sim|owner)-/.test(f) && files.includes(f.replace(/^before-/, 'after-')))
const sweepPairs = swept.map((f) => `<section class="pair"><h3>${title(f.replace(/^before-/, ''))}</h3><div><figure><figcaption>Before</figcaption><a href="${f}"><img loading="lazy" src="${f}" alt="Before, ${title(f)}"></a></figure><figure><figcaption>After</figcaption><a href="${f.replace(/^before-/, 'after-')}"><img loading="lazy" src="${f.replace(/^before-/, 'after-')}" alt="After, ${title(f)}"></a></figure></div></section>`).join('\n')
await writeFile(join(out, 'index.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal · Glass kit review</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#101316;color:#eef3ec}body{max-width:1600px;margin:auto;padding:28px}h1{font-size:clamp(28px,4vw,48px);letter-spacing:-.04em;margin:8px 0 10px}h1 span{color:#c6ff34}h2{margin:44px 0 14px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#97a39b}h3{margin:0 0 10px;font:600 13px ui-monospace,monospace;color:#c6ff34}p{color:#adb9af;max-width:900px;line-height:1.6}a{color:#c6ff34}.pair{margin:0 0 26px}.pair>div{display:grid;grid-template-columns:1fr 1fr;gap:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr));gap:16px}figure{margin:0;background:#171d1a;border:1px solid #2c3530;border-radius:16px;overflow:hidden}figure img{display:block;width:100%;height:auto;max-height:640px;object-fit:contain;background:#0a0c0b}figcaption{padding:10px 14px;font-size:13px;color:#c6cec4}nav{position:sticky;top:0;z-index:2;display:flex;gap:18px;padding:12px 0;background:#101316ee;border-bottom:1px solid #2c3530}@media(max-width:700px){body{padding:16px}.pair>div{grid-template-columns:1fr}}
</style>
<small style="color:#c6ff34;letter-spacing:.12em;text-transform:uppercase;font-size:12px">ob.Pal · UI system, phase 1</small>
<h1>The glass kit, and <span>/sim/ for every screen</span></h1>
<p>Before and after at 1920×1080, 1440×900, 1024×768 (tablet), 390×844 and 844×390 (a phone upright and sideways), then the new states: the glass select open and typing ahead, the sidebar folded to its rail, the tablet's drawer, the phone's bottom sheet, the components sheet, and the platform's other selects on the kit. Click an image for full size.${errors.length ? ` <b style="color:#fb7185">Page errors: ${errors.length}</b>` : ''}</p>
<nav><a href="#compare">Before / after</a><a href="#states">States</a><a href="#kit">Components</a><a href="#picker">Theme picker</a><a href="#sweep">Across the platform</a></nav>
<h2 id="compare">Before and after</h2>
${pairs}
<section class="pair"><h3>The owner's report: the system list, and the category lane's scrollbar</h3><div><figure><figcaption>Before (live, 1920 wide)</figcaption><a href="before-owner-select-open-1920.png"><img loading="lazy" src="before-owner-select-open-1920.png" alt="Before: the system's list open over the catalogue"></a></figure><figure><figcaption>After: the glass select, no lane</figcaption><a href="after-select-open-1920x1080.png"><img loading="lazy" src="after-select-open-1920x1080.png" alt="After: the glass select open in the sidebar"></a></figure></div></section>
<h2 id="states">States</h2><div class="grid">${figures('states')}</div>
<h2 id="kit">Components</h2><div class="grid">${figures('kit')}</div>
<h2 id="picker">Theme picker</h2><p>Each surface previews the accent in effect, and each accent previews on the surface in effect: carbon with ob.Pal lime, navy with rose, light with sky.</p><div class="grid">${figures('picker')}</div>
<h2 id="sweep">Across the platform</h2>${sweepPairs}<div class="grid">${figures('sweep')}</div>
</html>\n`)
if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`)
console.log(`${files.length} images in ${out}; viewer: ${join(out, 'index.html')}`)

await distill(out, { keepRaw: process.argv.includes("--keep-raw") || process.env.OBPAL_KEEP_RAW === "1" })
