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
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'

const before = process.argv.includes('--before')
const only = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean)
const out = 'artifacts/ui-system-2'
const prefix = before ? 'before' : 'after'
export const SIMS = [
  ['arm', '/sim/arm/'], ['arena', '/sim/arena/'], ['drone', '/sim/device/?d=drone'], ['rover', '/sim/device/?d=rover'],
  ['kart', '/sim/device/?d=kart'], ['gimbal', '/sim/device/?d=gimbal'], ['ptz', '/sim/device/?d=ptz'],
  ['studio', '/sim/device/?d=studio'], ['smarthome', '/sim/device/?d=smarthome'], ['pinball', '/sim/device/?d=pinball'],
]
export const SIZES = [[1920, 1080], [1440, 900], [390, 844], [844, 390]]
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

// ---- the viewer --------------------------------------------------------------------------------------------------------
const files = (await readdir(out)).filter((f) => f.endsWith('.png')).sort()
const title = (f) => f.replace(/\.png$/, '').replaceAll('-', ' ')
const figure = (f, caption) => files.includes(f) ? `<figure><figcaption>${caption}</figcaption><a href="${f}"><img loading="lazy" src="${f}" alt="${title(f)}"></a></figure>` : ''
const rows = SIMS.map(([name]) => `<section class="sim" id="${name}"><h2>${name}</h2>${SIZES.map(([w, h]) => {
  const s = `${w}x${h}`
  const pairs = [[`before-${name}-${s}.png`, 'Before'], [`after-${name}-${s}.png`, 'After']]
  if (phone(w, h)) pairs.push([`before-${name}-${s}-controls.png`, 'Before, controls open'], [`after-${name}-${s}-controls.png`, 'After, controls open'])
  return `<h3>${s}</h3><div class="pair">${pairs.map(([f, c]) => figure(f, c)).join('')}</div>`
}).join('')}</section>`).join('\n')
const extra = files.filter((f) => /^after-(dock|moving|camera)/.test(f)).map((f) => figure(f, title(f))).join('')
await writeFile(join(out, 'index.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ob.Pal · Sim panels review</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#101316;color:#eef3ec}body{max-width:1680px;margin:auto;padding:28px}h1{font-size:clamp(28px,4vw,48px);letter-spacing:-.04em;margin:8px 0 10px}h1 span{color:#c6ff34}h2{margin:44px 0 6px;font-size:22px;text-transform:capitalize}h3{margin:18px 0 10px;font:600 13px ui-monospace,monospace;color:#c6ff34}p{color:#adb9af;max-width:900px;line-height:1.6}a{color:#c6ff34}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px}figure{margin:0;background:#171d1a;border:1px solid #2c3530;border-radius:16px;overflow:hidden}figure img{display:block;width:100%;height:auto;max-height:640px;object-fit:contain;background:#0a0c0b}figcaption{padding:10px 14px;font-size:13px;color:#c6cec4}nav{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:14px;padding:12px 0;background:#101316ee;border-bottom:1px solid #2c3530;text-transform:capitalize}@media(max-width:700px){body{padding:16px}}
</style>
<small style="color:#c6ff34;letter-spacing:.12em;text-transform:uppercase;font-size:12px">ob.Pal · UI system, phase 2</small>
<h1>Inside the sims: <span>widget cards, not pills</span></h1>
<p>Ten sims before and after at 1920×1080, 1440×900, 390×844 and 844×390; on a phone the windows start docked, so each phone size also shows the controls window open. Then the dock with a tooltip, a window being moved, and a camera window enlarged. Click an image for full size.${errors.length ? ` <b style="color:#fb7185">Capture errors: ${errors.length}</b>` : ''}</p>
<nav>${SIMS.map(([n]) => `<a href="#${n}">${n}</a>`).join('')}${extra ? '<a href="#more">Dock and windows</a>' : ''}</nav>
${rows}
${extra ? `<section id="more"><h2>Dock and windows</h2><div class="pair">${extra}</div></section>` : ''}
</html>\n`)
if (errors.length) console.log(`errors:\n  ${errors.join('\n  ')}`)
console.log(`${files.length} images in ${out}; viewer: ${join(out, 'index.html')}`)
