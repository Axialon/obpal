/** Local input proofs use the real frame loop and UI; synthetic pads replace only the browser API. */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { measureButtonInk } from './lib/button-ink.mjs'
import { assertButtonInk } from './lib/surface-buttons.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'

const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function until(fn, label, ms = 15000) { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw new Error(`Local controls: ${label}`); await sleep(50) } }
const scenarios = [
  ['drone', '/sim/device/?d=drone', 'w'], ['kart', '/sim/device/?d=kart', 'w'],
  ['so101', '/sim/arm/?kind=so101', 'd'], ['marblerun', '/sim/device/?d=marblerun', 'd'],
  ['pendulum', '/sim/device/?d=pendulum', 'w'], ['humanoid', '/sim/humanoid/?test=humanoid', 'w'],
  ['rover', '/sim/device/?d=rover', 'w'],
  ['arena', '/sim/arena/', 'w'],
]
const sample = page => page.evaluate(() => {
  if (window.__arm) return window.__arm.arms().map(a => a.joints.map(j => j.angle))
  if (window.__humanoid) return window.__humanoid.snapshot().actors.map(a => a.position)
  if (window.__arena) return window.__arena.slots.map(s => [s.pos.x, s.pos.y])
  return (window.__device.logic.units ?? window.__device.logic.rovers ?? window.__device.logic.drones).map(u => Object.fromEntries(['x', 'y', 'z', 'tiltX', 'tiltZ', 'length', 'damping', 'pan', 'angle'].filter(k => typeof u[k] === 'number').map(k => [k, u[k]])))
})
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b)
const clearPoint = page => page.evaluate(() => {
  const canvas = window.__device?.stage.renderer.domElement ?? document.querySelector('canvas')
  for (let y = 140; y < innerHeight - 80; y += 35) for (let x = innerWidth - 80; x > 80; x -= 35) if (document.elementFromPoint(x, y) === canvas) return { x, y }
  throw new Error('no uncovered play surface')
})

export async function runLocalControl(local, check, { baseline = false } = {}) {
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }))
  const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT || 'artifacts/local-control', baseline ? 'before' : 'after')
  await mkdir(out, { recursive: true })
  const report = [], errors = []
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500, isMobile: viewport.width < 500, deviceScaleFactor: 1, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      await context.addInitScript(() => {
        window.__localPads = [{ index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }]
        Object.defineProperty(navigator, 'getGamepads', { value: () => window.__localPads })
      })
      try {
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message))
        for (const [id, path, key] of scenarios) {
          if (baseline && id !== 'marblerun') continue
          await page.goto(`${local.origin}${path}`)
          await page.waitForFunction(() => !!window.__obpal?.pairingUrl, { timeout: 30000 })
          await page.evaluate(() => document.fonts.ready)
          if (baseline) { await page.screenshot({ path: join(out, `scene-${viewport.width}.png`) }); continue }
          if (id === 'marblerun') await page.screenshot({ path: join(out, `scene-${viewport.width}.png`) })
          if (!await page.locator('[data-panel="local-control"]').isVisible()) {
            if (viewport.width < 500) await page.locator('.panel-dock-handle').click()
            await page.locator('[data-panel-toggle="local-control"]').click()
          }
          const panel = page.locator('[data-panel="local-control"]')
          await check(`${id} local keyboard drives state at ${viewport.width}`, async () => {
            await panel.locator('[data-source="keyboard"]').click()
            await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
            if (id === 'pendulum') { await page.keyboard.press('h'); await page.waitForTimeout(80) }
            const before = await sample(page)
            if (id === 'drone') await page.keyboard.press('Enter')
            await page.keyboard.down(key)
            if (id === 'drone') await page.keyboard.down('Space')
            await page.waitForTimeout(700)
            await page.keyboard.up(key); if (id === 'drone') await page.keyboard.up('Space')
            const after = await sample(page)
            assert(changed(before, after), 'keyboard did not change state')
            report.push({ id, viewport, source: 'keyboard', before, after })
            await page.keyboard.press('Escape')
          })
          await check(`${id} synthetic standard gamepad drives state at ${viewport.width}`, async () => {
            await panel.locator('[data-source="gamepad"]').click()
            await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
            const before = await sample(page)
            await page.evaluate(id => { const p = window.__localPads[0]; p.axes = [.65, -.65, .5, -.5]; p.buttons[7].value = .8; if (id === 'drone') p.buttons[0].pressed = true }, id)
            await page.waitForTimeout(700)
            const after = await sample(page)
            assert(changed(before, after), 'gamepad did not change state')
            report.push({ id, viewport, source: 'gamepad', before, after })
            await page.evaluate(() => { window.__localPads[0].axes = [0, 0, 0, 0]; window.__localPads[0].buttons.forEach(b => { b.pressed = false; b.value = 0 }) })
            await page.keyboard.press('Escape')
          })
          await check(`${id} focused mouse drag drives state at ${viewport.width}`, async () => {
            await panel.locator('[data-source="keyboard"]').click()
            await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
            if (id === 'pendulum') { await page.keyboard.press('h'); await page.waitForTimeout(80) }
            const before = await sample(page), { x, y } = await clearPoint(page)
            await page.mouse.move(x, y); await page.mouse.down()
            for (let n = 1; n <= 20; n++) { await page.mouse.move(x - n * 8, y + n * 8); await page.waitForTimeout(25) }
            await page.mouse.up()
            const after = await sample(page); assert(changed(before, after), 'mouse drag did not change state')
            report.push({ id, viewport, source: 'mouse', before, after }); await page.keyboard.press('Escape')
          })
          if (id === 'marblerun') {
            await check(`picker and bindings centring guard at ${viewport.width}`, async () => {
              await page.mouse.move(0, 0); await page.screenshot({ path: join(out, `picker-${viewport.width}.png`) })
              await panel.getByRole('button', { name: 'Bindings', exact: true }).click()
              await page.waitForTimeout(200)
              const rows = (await page.evaluate(measureButtonInk, { surfaces: true })).filter(r => r.classes.includes('local-') || r.path?.includes('local-control'))
              // The control window may scroll; measure every visible picker action and binding.
              assert(rows.length > 0, 'no local controls measured')
              await writeFile(join(out, `ink-${viewport.width}.json`), JSON.stringify(rows, null, 2))
              const detail = assertButtonInk(rows)
              await page.screenshot({ path: join(out, `bindings-${viewport.width}.png`) })
              await page.getByRole('button', { name: 'Close bindings', exact: true }).click()
              return detail
            })
            await check(`same-device touch drives the marble board at ${viewport.width}`, async () => {
              await panel.locator('[data-source="keyboard"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
              const before = await sample(page)
              // Dispatch pointer movement on the focused canvas, through the production listeners.
              const cdp = await context.newCDPSession(page)
              const x = viewport.width < 500 ? 150 : 680
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: 200, id: 1 }] })
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 50, y: 170, id: 1 }] })
              await page.waitForTimeout(300)
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach()
              const after = await sample(page); assert(changed(before, after), 'touch did not tilt the board')
              report.push({ id, viewport, source: 'touch', before, after })
            })
            await check(`controller-window option opens and local choice persists at ${viewport.width}`, async () => {
              const popup = page.waitForEvent('popup')
              await panel.locator('[data-source="window"]').click()
              const controller = await popup; await controller.waitForURL(/\/p\//); await controller.close()
              await panel.locator('[data-source="keyboard"]').click()
              await page.reload(); await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
              if (!await page.locator('[data-panel="local-control"]').isVisible()) { if (viewport.width < 500) await page.locator('.panel-dock-handle').click(); await page.locator('[data-panel-toggle="local-control"]').click() }
              assert(await page.locator('[data-source="keyboard"]').getAttribute('aria-pressed') === 'true', 'source not persisted')
              assert(await page.getByRole('button', { name: 'Enable local controls', exact: true }).count() === 1, 'reload rearmed controls')
            })
          }
        }
      } finally { await context.close() }
    }
    if (!baseline) await runLocalSharing(browser, local.origin, check, out)
    if (!baseline) await check('local-control pages have no JavaScript errors', () => { assert(!errors.length, errors.join(' | ')) })
    if (!baseline) await runUniversalFaces(browser, local.origin, check, out)
    await writeFile(join(out, 'state-changes.json'), JSON.stringify(report, null, 2))
  } finally { await browser.close() }
}

export async function runUniversalFaces(browser, origin, check, out) {
  if (out) await mkdir(out, { recursive: true })
  for (const [id, path, faces] of [
    ['marblerun', '/sim/device/?d=marblerun', ['face.wheel', 'face.mouse', 'face.keys']],
    ['kart', '/sim/device/?d=kart', ['face.trackpad', 'face.mouse', 'face.keys']],
    ['so101', '/sim/arm/?kind=so101', ['face.wheel', 'face.mouse', 'face.keys']],
  ]) {
    const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    try {
      await phone.addInitScript(() => { for (const key of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${key}`, '1') })
      const screen = await host.newPage(), page = await phone.newPage(), cdp = await phone.newCDPSession(page)
      await screen.goto(`${origin}${path}`)
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 70, gamma: 0 })
      await page.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await page.locator('.modes').waitFor({ state: 'attached', timeout: 30000 })
      const notice = page.getByRole('button', { name: 'Dismiss connection notice', exact: true })
      if (await notice.isVisible()) await notice.click()
      await page.addLocatorHandler(page.locator('.hint.in'), hint => hint.getByRole('button', { name: 'Dismiss hint' }).click())
      if (id === 'so101') {
        await page.locator('.scene-btn').click(); await page.locator('.pick').filter({ hasText: 'Whole arm' }).first().click()
        await screen.locator('#people .allow').first().click()
        await page.locator('.scene-btn').click(); await page.locator('.pick').filter({ hasText: 'Whole arm' }).first().click()
      }
      const position = page.locator('[data-id="control.position"]')
      if (await position.isVisible()) await position.click()
      for (const face of faces) await check(`${id} phone non-recommended ${face} changes real state`, async () => {
        await page.getByRole('button', { name: 'All controllers', exact: true }).filter({ visible: true }).click()
        const choices = page.locator('.ctl-card[data-c]')
        assert(await choices.count() === 9, 'not every catalogue face is offered')
        assert(await choices.evaluateAll(buttons => buttons.every(b => b.getAttribute('aria-disabled') === 'false')), 'a face is still gated')
        await page.locator(`.ctl-card[data-c="${face}"]`).click()
        await page.locator('.ctl-wrap').waitFor({ state: 'detached' })
        await until(() => screen.evaluate(face => window.__obpal.participants.some(p => p.controller === face), face), 'face switch reached host')
        await page.waitForTimeout(250)
        if (await position.isVisible()) await position.click()
        const before = await sample(screen)
        if (face === 'face.keys') {
          for (let n = 0; n < 8; n++) {
            await page.locator('.tone-key').nth(1).click()
            if (id === 'marblerun' && n === 0) await screen.waitForFunction(() => window.__device.logic.units.some(u => Math.abs(u.tiltX) + Math.abs(u.tiltZ) > .001))
            await page.waitForTimeout(70)
          }
        } else {
          const target = page.locator(face === 'face.wheel' ? '.gp-trig[data-trig="1"]' : face === 'face.mouse' ? '#mouse-left' : '#pad')
          await target.scrollIntoViewIfNeeded()
          const box = await target.boundingBox(); assert(box, 'face surface missing')
          const x = box.x + box.width / 2, y = box.y + box.height / 2
          const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[id]')?.id, { x, y })
          const cover = await page.evaluate(({x,y}) => document.elementFromPoint(x,y)?.outerHTML.slice(0,180), {x,y})
          assert(await target.evaluate((el, {x, y}) => el.contains(document.elementFromPoint(x, y)), {x, y}), `touch surface covered by ${hit}; ${cover}; ${JSON.stringify(box)}`)
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
          for (let n = 1; n <= 12; n++) {
            if (face === 'face.mouse' || face === 'face.wheel') await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: n * 2, beta: 70 + n, gamma: -n })
            else await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.min(60, box.width * .25) * n / 12, y: y - Math.min(60, box.height * .25) * n / 12, id: 1 }] })
            await page.evaluate(() => dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })))
            await page.waitForTimeout(45)
          }
          if (out) await writeFile(join(out, `held-${id}-${face.slice(5)}.json`), JSON.stringify(await screen.evaluate(() => {
            const r = window.__obpal, s = window.__sim, p = r.participants[0]
            return { person: p.controller, claims: s.claims.snapshot(), scope: s.control.scope(p.id), awaiting: s.control.awaitingPosition(p.id), pad: r.padOf(p.id), aim: s.control.aim(p.id), seen: window.__device?.seen[p.id], arm: window.__arm?.arms() }
          }), null, 2))
          if (id === 'marblerun') {
            const during = await sample(screen)
            assert(during.some((u, n) => u.tiltX !== before[n].tiltX || u.tiltZ !== before[n].tiltZ), 'held face did not tilt the board')
          }
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        }
        await screen.waitForTimeout(250)
        const after = await sample(screen)
        assert(changed(before, after), `${face} did not change state`)
        if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, `phone-${id}-${face.slice(5)}.json`), JSON.stringify({ id, face, before, after }, null, 2)); await page.screenshot({ path: join(out, `phone-${id}-${face.slice(5)}.png`) }) }
      })
    } finally { await host.close(); await phone.close() }
  }
}

async function runLocalSharing(browser, origin, check, out) {
  const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ignoreHTTPSErrors: true })
  try {
    await host.addInitScript(() => {
      window.__localPads = [0, 1].map(index => ({ index, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) }))
      Object.defineProperty(navigator, 'getGamepads', { value: () => window.__localPads })
    })
    const page = await host.newPage()
    await page.goto(`${origin}/sim/device/?d=rover`); await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
    await page.locator('[data-panel-toggle="local-control"]').click()
    const panel = page.locator('[data-panel="local-control"]')
    await check('two standard pads drive distinct rover units, unplug releases input', async () => {
      await panel.locator('[data-source="gamepad"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
      const before = await sample(page)
      await page.evaluate(() => window.__localPads.forEach((p, n) => { p.axes = [.3, n ? .8 : -.8, 0, 0] }))
      await page.waitForTimeout(750)
      const after = await sample(page)
      assert(changed(before[0], after[0]) && changed(before[1], after[1]), 'separate pads did not move both units')
      assert(await page.locator('#dev-units small').filter({hasText:'Local gamepad'}).count() === 2, 'local sources missing from seat list')
      assert(!changed(before[2], after[2]), 'a third unassigned unit moved')
      await reportSharing(before, after)
      await page.evaluate(() => { window.__localPads = [] })
      await until(() => panel.getByRole('button', { name: 'Enable local controls', exact: true }).isVisible(), 'unplug releases local enable')
      assert(!await panel.locator('[data-source="gamepad"]').isVisible(), 'gamepad detection was stale')
    })
    await check('phone owns its claimed rover while another local pad keeps driving', async () => {
      await page.evaluate(() => { window.__localPads = [0, 1].map(index => ({ index, connected: true, mapping: 'standard', axes: [0, -.8, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) })) })
      await panel.locator('[data-source="gamepad"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
      const controller = await phone.newPage(); await controller.goto(await page.evaluate(() => window.__obpal.pairingUrl))
      await until(() => panel.locator('.local-status').textContent().then(s => s.includes('Phone active')), 'phone priority status')
      const before = await sample(page); await page.waitForTimeout(750); const after = await sample(page)
      assert(changed(before[1], after[1]), 'phone stopped the other local player')
      const speeds = await page.evaluate(() => window.__device.logic.rovers.map(r => Math.abs(r.v)))
      assert(speeds[0] < speeds[1], 'claimed phone did not override the held local throttle')
      await writeFile(join(out, 'multi-unit.json'), JSON.stringify({ before, after, speeds }, null, 2))
      await controller.close()
      await until(() => page.evaluate(() => !window.__sim.claims.holder('rover1')), 'phone released its claim')
    })
    await check('Tab, forms, modified shortcuts and explicit pointer lock keep their normal behaviour', async () => {
      await panel.locator('[data-source="keyboard"]').click(); await panel.getByRole('button', { name: 'Enable local controls', exact: true }).click()
      await page.keyboard.press('Tab'); assert(await page.evaluate(() => document.activeElement?.tagName !== 'CANVAS'), 'Tab trapped focus')
      await page.evaluate(() => { const input = document.createElement('input'); input.id = 'local-form-proof'; document.body.append(input); input.focus() })
      await page.keyboard.type('wasd qe'); assert(await page.locator('#local-form-proof').inputValue() === 'wasd qe', 'play keys intercepted typing')
      await page.evaluate(() => { document.getElementById('local-form-proof').remove(); document.querySelector('canvas').focus(); window.__shortcutPrevented = null; window.addEventListener('keydown', e => { if (e.ctrlKey && e.code === 'KeyQ') window.__shortcutPrevented = e.defaultPrevented }, { once: true }) })
      await page.keyboard.press('Control+q'); assert(await page.evaluate(() => !window.__shortcutPrevented), 'modified shortcut was intercepted')
      assert(await page.evaluate(() => !document.pointerLockElement), 'mouse locked implicitly')
      await panel.getByRole('button', { name: 'Lock mouse · Esc releases', exact: true }).click()
      await page.waitForFunction(() => !!document.pointerLockElement)
      await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.pointerLockElement)
    })
    await check('focused local mouse wheel changes PTZ zoom through its normal pad consumer', async () => {
      await page.goto(`${origin}/sim/device/?d=ptz`); await page.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await page.locator('[data-panel-toggle="local-control"]').click()
      const controls = page.locator('[data-panel="local-control"]')
      await controls.locator('[data-source="keyboard"]').click(); await controls.getByRole('button', {name:'Enable local controls',exact:true}).click()
      const before = await page.evaluate(() => window.__device.logic.cams[0].zoom)
      const {x,y} = await clearPoint(page); await page.mouse.move(x,y); await page.mouse.wheel(0,-120); await page.waitForTimeout(100)
      const after = await page.evaluate(() => window.__device.logic.cams[0].zoom)
      assert(after > before, 'wheel did not zoom')
      await writeFile(join(out,'wheel-zoom.json'), JSON.stringify({before,after},null,2))
    })
    async function reportSharing(before, after) { await writeFile(join(out, 'pads.json'), JSON.stringify({ before, after }, null, 2)) }
  } finally { await host.close(); await phone.close() }
}
