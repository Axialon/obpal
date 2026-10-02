/** Window behaviour in real Chromium; evidence is opt-in and always outside the checkout. */
import { tempScope } from './lib/temp.mjs'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkFrost, setSurface } from './lib/frost.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'

const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sizes = [[1280, 800], [1920, 1080], [844, 390], [390, 844]]
const sims = [['ptz', '/sim/device/?d=ptz'], ['gimbal', '/sim/device/?d=gimbal'], ['slotcars', '/sim/device/?d=slotcars'], ['arm', '/sim/arm/'], ['studio', '/sim/device/?d=studio'], ['arena', '/sim/arena/']]
const panel = (page, id = 'controls') => page.locator(`.sim-window[data-panel="${id}"]`)
const toggle = (page, id = 'controls') => page.locator(`[data-panel-toggle="${id}"]`)
const box = locator => locator.evaluate(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })
async function dockClick(page, id) { const b = toggle(page, id); await b.focus(); await b.click() }
async function open(page, id = 'controls') { if (!(await panel(page, id).isVisible())) await dockClick(page, id) }
async function foldPairing(page) {
  const chip = page.locator('.obpal-chip .pill[aria-expanded="true"]')
  // A phone's primary click now opens its scanner. Escape dismisses the already-open QR on every screen.
  if (await chip.count()) { await chip.focus(); await chip.press('Escape') }
}
async function reset(page) { const b = page.getByRole('button', { name: 'Reset layout', exact: true }); await b.focus(); await b.click() }
async function drag(page, locator, dx, dy) {
  const b = await box(locator), x = b.x + b.width / 2, y = b.y + b.height / 2
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 12 }); await page.mouse.up()
  await settle(page)
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
async function ready(page) {
  await page.waitForFunction(() => !!window.__obpal?.pairingUrl && !!document.querySelector('.panel-dock'), { timeout: 25000 })
  await foldPairing(page)
}
async function geometry(page) {
  return page.locator('.sim-window:not([hidden])').evaluateAll(windows => windows.map(el => {
    const r = el.getBoundingClientRect(); return { id: el.dataset.panel, x: r.x, y: r.y, w: r.width, h: r.height }
  }))
}
function inside(rects, w, h) {
  for (const r of rects) assert(r.x >= 0 && r.y >= 64 && r.x + r.w <= w + 1 && r.y + r.h <= h + 1, `offscreen ${JSON.stringify(r)} on ${w}x${h}`)
}

export async function runPanels(local, check) {
  const temps = tempScope()
  try {
  const out = process.env.OBPAL_PANEL_EVIDENCE || await temps.make(join(tmpdir(), 'obpal-panels-'))
  const rel = relative(resolve('.'), resolve(out))
  if (!isAbsolute(rel) && !rel.startsWith('..')) throw new Error('Panel evidence must go to a temporary folder')
  await mkdir(out, { recursive: true })
  const captures = []
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM, args: ['--ignore-certificate-errors'] }))
  try {
    for (const [name, route] of sims) for (const [width, height] of sizes) {
      await check(`panels: ${name} move, resize, minimise, close, reopen, reload and reset at ${width}x${height}`, async () => {
        const video = width === 1280
        const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 1000, isMobile: width < 600, ignoreHTTPSErrors: true, reducedMotion: 'reduce', ...(video ? { recordVideo: { dir: out, size: { width, height } } } : {}) })
        const errors = [], page = await context.newPage(), prefix = `${name}-${width}x${height}`
        page.on('pageerror', e => errors.push(e.message))
        try {
          await page.goto(local.origin + route); await ready(page)
          await page.screenshot({ path: join(out, `${prefix}-default.png`) })
          if (width < 1000) assert(await page.locator('.sim-window:not([hidden])').count() === 0, 'phone defaults should be docked')
          await open(page)
          const p = panel(page), handle = p.locator('.panel-handle')
          await checkFrost(page, '.sim-window[data-panel="controls"]', { text: ['.panel-handle'] })
          await handle.focus()
          for (let i = 0; i < 8; i++) await handle.press('Shift+ArrowLeft')
          for (let i = 0; i < 12; i++) await handle.press('Shift+ArrowUp')
          const before = await box(p)
          await drag(page, handle, 38, -32)
          const moved = await box(p); assert(Math.abs(moved.x - before.x) > 20, 'header drag did not move the window')
          await drag(page, p.locator('[data-edge="se"]'), 34, 28)
          const resized = await box(p); assert(resized.width > moved.width + 20 && resized.height > moved.height + 15, 'corner did not resize')
          await handle.focus(); await handle.press('ArrowDown'); await handle.press('Shift+ArrowDown')
          await settle(page)
          const arranged = await box(p)
          const measured = await p.evaluate(el => ({ style: el.getAttribute('style'), transition: getComputedStyle(el).transition, animations: el.getAnimations().map(a => a.effect.getKeyframes()) }))
          await page.screenshot({ path: join(out, `${prefix}-arranged.png`) })
          await p.getByRole('button', { name: /^Minimise / }).click(); assert(!(await p.isVisible()), 'minimise failed')
          await dockClick(page); assert(await p.isVisible(), 'reopen minimised failed')
          await p.getByRole('button', { name: /^Close / }).click(); assert(!(await p.isVisible()), 'close failed')
          await page.reload(); await ready(page); assert(!(await panel(page).isVisible()), 'closed state lost on reload')
          await dockClick(page)
          await settle(page)
          const restored = await box(panel(page)); assert(JSON.stringify(restored) === JSON.stringify(arranged), `geometry lost on reload: ${JSON.stringify({ restored, arranged, measured })}`)
          await panel(page).locator('.panel-handle').press('Escape'); assert(!(await panel(page).isVisible()), 'Escape did not close')
          assert(await toggle(page).evaluate(el => el === document.activeElement), 'focus did not return to the dock')
          await reset(page)
          await settle(page)
          if (width < 1000) assert(!(await panel(page).isVisible()), 'reset should restore phone docking')
          else { const r = await box(panel(page)); assert(r.x === 64 && r.y === 84 && r.width === (width >= 1600 ? 352 : 336), `reset did not restore default geometry: ${JSON.stringify(r)}`) }
          inside(await geometry(page), width, height)
          assert(!errors.length, errors.join(' | ')); captures.push(prefix)
        } finally {
          await context.close()
          if (video) await page.video().saveAs(join(out, `${prefix}.webm`))
        }
      })
    }
    await check('panels: live cameras enlarge, restore, stack, signal activity and keep rendering', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true, recordVideo: { dir: out, size: { width: 1280, height: 800 } } })
      let page
      try {
        page = await context.newPage(); await page.goto(`${local.origin}/sim/device/?d=ptz`); await ready(page)
        const p = panel(page, 'camera-1'), canvas = p.locator('canvas')
        await canvas.waitFor()
        await page.waitForFunction(() => {
          const c = document.querySelector('[data-panel="camera-1"] canvas'); return c?.width > 200
        })
        const before = await box(p)
        await p.getByRole('button', { name: 'Enlarge Camera 1' }).click()
        assert((await box(p)).width > 1100, 'camera cannot approach full screen')
        await page.screenshot({ path: join(out, 'camera-enlarged.png') })
        await p.getByRole('button', { name: 'Restore Camera 1' }).click()
        assert(JSON.stringify(await box(p)) === JSON.stringify(before), 'camera restore lost its rectangle')
        // Dropped a few pixels short of the control window's right edge and its gutter, it snaps there.
        const controls = await box(panel(page)), beside = controls.x + controls.width + 12
        await drag(page, p.locator('.panel-handle'), beside + 4 - before.x, 0)
        assert((await box(p)).x === beside, 'camera did not snap beside the control window')
        await drag(page, p.locator('.panel-handle'), -100, 120)
        await panel(page).locator('.panel-handle').click()
        assert(await page.evaluate(() => document.elementFromPoint(340, 260)?.closest('[data-panel]')?.getAttribute('data-panel')) === 'controls', 'control focus did not raise it above the camera')
        // The title handle hugs its ink; click its exposed end above the overlapping control window.
        const cameraHandle = p.locator('.panel-handle')
        await cameraHandle.click({ position: { x: (await box(cameraHandle)).width - 8, y: 18 } })
        assert(await page.evaluate(() => document.elementFromPoint(340, 260)?.closest('[data-panel]')?.getAttribute('data-panel')) === 'camera-1', 'camera focus did not raise it above controls')
        await page.screenshot({ path: join(out, 'camera-overlap.png') })
        const pixels = await canvas.evaluate(c => [...c.getContext('2d').getImageData(0, 0, c.width, c.height).data].filter((_, i) => i % 4 !== 3))
        assert(Math.max(...pixels.slice(0, 60000)) > 60, 'camera canvas is blank')
        await p.getByRole('button', { name: 'Minimise Camera 1' }).click()
        await page.evaluate(() => { window.__device.logic.cams[0].flash = 0.0001 })
        await page.waitForFunction(() => document.querySelector('[data-panel-toggle="camera-1"]').dataset.activity === 'true')
        await dockClick(page, 'camera-1'); assert(await toggle(page, 'camera-1').getAttribute('data-activity') === null, 'activity did not clear')
        await setSurface(page, 'light'); await checkFrost(page, '[data-panel="camera-1"]', { text: ['.panel-handle'] }); await checkFrost(page, '.panel-dock')
        await page.screenshot({ path: join(out, 'camera-light.png') })
      } finally { await context.close(); if (page) await page.video().saveAs(join(out, 'camera-arrangement.webm')) }
    })
    await check('panels: rotation remembers each class, touch and pen drag, viewport shrink clamps', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage(); await page.goto(`${local.origin}/sim/device/?d=gimbal`); await ready(page)
        await page.getByRole('button', { name: 'Show window dock' }).tap(); await toggle(page, 'camera').tap()
        const p = panel(page, 'camera'), handle = p.locator('.panel-handle'), cdp = await context.newCDPSession(page)
        await p.waitFor({ state: 'visible' }); await settle(page)
        const before = await box(p), b = await box(handle), x = b.x + 70, y = b.y + 18
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 60, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await settle(page)
        const moved = await box(p); assert(moved.y < before.y - 40, 'touch drag failed')
        const grip = await box(p.locator('[data-edge="se"]')), gx = grip.x + grip.width / 2, gy = grip.y + grip.height / 2
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: gx, y: gy, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: gx - 35, y: gy + 30, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(page)
        const touched = await box(p); assert(touched.width < moved.width - 20 && touched.height > moved.height + 20, 'touch resize failed')
        await page.setViewportSize({ width: 844, height: 390 }); await settle(page); await open(page, 'camera'); await settle(page); inside(await geometry(page), 844, 390)
        const pen = await box(handle)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pen.x + 50, y: pen.y + 20, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pen.x - 30, y: pen.y + 40, button: 'left', buttons: 1, pointerType: 'pen' })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pen.x - 30, y: pen.y + 40, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' })
        await settle(page); assert((await box(p)).x < pen.x - 40, 'pen drag failed')
        await page.setViewportSize({ width: 390, height: 844 }); await settle(page); assert(JSON.stringify(await box(p)) === JSON.stringify(touched), 'portrait layout lost after rotation')
        await page.setViewportSize({ width: 340, height: 620 }); await settle(page); inside(await geometry(page), 340, 620)
      } finally { await context.close() }
    })
    await check('panels: blocked storage, every studio station, and dynamically added arm cards', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message))
        await page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied') } }) })
        await page.goto(`${local.origin}/sim/device/?d=studio`); await ready(page)
        assert(await page.locator('[data-panel-toggle^="station-"]').count() === 8, 'studio stations are missing')
        await open(page, 'station-8'); await drag(page, panel(page, 'station-8').locator('.panel-handle'), -350, -240)
        await page.screenshot({ path: join(out, 'studio-stations.png') }); await reset(page)
        await page.goto(`${local.origin}/sim/arm/`); await ready(page)
        const count = await page.locator('[data-panel^="arm-a"]').count()
        await page.locator('#add-arm').click(); assert(await page.locator('[data-panel^="arm-a"]').count() === count + 1, 'new arm not registered')
        await open(page, `arm-a${count + 1}`); await drag(page, panel(page, `arm-a${count + 1}`).locator('.panel-handle'), -350, -320)
        await page.screenshot({ path: join(out, 'arm-joints.png') })
        assert(!errors.length, errors.join(' | '))
      } finally { await context.close() }
    })
    await check('panels: jib, slider, telescope and planetary monitors are live adjustable windows', async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message))
        for (const id of ['jib', 'slider', 'telescope', 'planetary']) {
          await page.goto(`${local.origin}/sim/device/?d=${id}`); await ready(page)
          await page.waitForFunction(() => document.querySelector('[data-panel="camera"] canvas')?.width > 200)
          const p = panel(page, 'camera'), before = await box(p)
          await p.locator('.panel-handle').press('Shift+ArrowDown'); await settle(page)
          assert((await box(p)).height > before.height, `${id} cannot resize`)
          await p.getByRole('button', { name: /^Close / }).click(); await open(page, 'camera')
          await page.screenshot({ path: join(out, `${id}-monitor.png`) })
        }
        assert(!errors.length, errors.join(' | '))
      } finally { await context.close() }
    })
    console.log(`  panel evidence: ${out}`)
    await writeFile(join(out, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sim window evidence</title><style>body{margin:32px auto;max-width:1400px;padding:0 24px;background:#151719;color:#f2f3f5;font:15px/1.5 system-ui}section{margin:30px 0}img{width:48%;vertical-align:top}video{max-width:100%;max-height:600px}a{color:#c6ff34}</style><h1>Adjustable sim windows</h1><p>Actual Chromium screenshots and pointer captures. Six sims at four screen sizes. Default layout and arranged layout are side by side.</p>${captures.map(p => `<section><h2>${p}</h2><a href="${p}-default.png"><img alt="${p} default" src="${p}-default.png" loading="lazy"></a> <a href="${p}-arranged.png"><img alt="${p} arranged" src="${p}-arranged.png" loading="lazy"></a>${p.endsWith('1280x800') ? `<details><summary>Arrangement capture</summary><video controls preload="none" src="${p}.webm"></video></details>` : ''}</section>`).join('')}<section><h2>Camera enlargement and light theme</h2><img alt="Enlarged camera" src="camera-enlarged.png"><img alt="Light theme" src="camera-light.png"></section></html>`)
  } finally { await browser.close() }

  } finally { await temps.cleanup() }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { startLocal } = await import('../extension/e2e/local.mjs')
  const local = await startLocal(); let failed = 0, total = 0
  const filter = process.argv[process.argv.indexOf('--filter') + 1]
  try { await runPanels(local, async (name, fn) => { if (process.argv.includes('--filter') && !name.includes(filter)) return; total++; try { await fn(); console.log(`  ✓ ${name}`) } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.stack}`) } }) }
  finally { await local.close() }
  console.log(failed ? `FAILED ${failed}/${total}` : `passed ${total}/${total}`); process.exitCode = failed ? 1 : 0
}
