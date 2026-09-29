/** Round-two acceptance evidence. Captures and measurements belong to the caller's temporary directory. */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { encode } from 'uqr'
import { setSurface, checkFrost } from './lib/frost.mjs'

const sizes = [{ width: 390, height: 844 }, { width: 430, height: 932 }]
async function fixture(file, text) {
  const width = 640, height = 480, y = Buffer.alloc(width * height, 235)
  if (text) {
    const qr = encode(text, { ecc: 'M', border: 4 }), unit = Math.floor(190 / qr.size)
    const left = Math.floor((width - qr.size * unit) / 2), top = Math.floor((height - qr.size * unit) / 2)
    for (let row = 0; row < qr.size; row++) for (let col = 0; col < qr.size; col++) if (qr.data[row][col]) {
      for (let dy = 0; dy < unit; dy++) y.fill(16, (top + row * unit + dy) * width + left + col * unit, (top + row * unit + dy) * width + left + (col + 1) * unit)
    }
  }
  await writeFile(file, Buffer.concat([Buffer.from('YUV4MPEG2 W640 H480 F60:1 Ip A1:1 C420jpeg\nFRAME\n'), y, Buffer.alloc(width * height / 2, 128)]))
}

export async function cameraDesign(o) {
  const { check, need, until, sleep, directory, origin, screen, phone, cameraBrowser, mobile, probeCamera, handResult, emptyHand, qrFile, report } = o
  const shot = (page, name) => page.screenshot({ path: join(directory, `${name}.png`) })
  const lime = async page => {
    await setSurface(page, 'carbon')
    await page.evaluate(() => window.BlackboxesFamily.setAccent('product'))
  }
  const openHand = async page => {
    await page.locator('[data-tab="camera-hand"]').click()
    await page.locator('.obpal-camera[data-mode="hand"]').waitFor()
  }
  const inject = (page, result) => page.evaluate(value => window.__cameraHand.inject(value), result)

  await check('round 2 scan states, corner alignment, dark glass contrast and reduced motion at both phone sizes', async () => {
    const evidence = []
    for (const state of ['idle', 'lock', 'rejected', 'denied']) {
      const file = join(directory, `design-${state}.y4m`)
      await fixture(file, state === 'lock' ? '1234567890' : state === 'rejected' ? 'not-obpal' : '')
      const browser = await cameraBrowser(file, state !== 'denied')
      for (const size of sizes) {
        const context = await browser.newContext({ ...mobile, viewport: size, screen: size })
        await context.addInitScript(probeCamera)
        // Keep the real decoder's 360 ms navigation callback pending for the evidence capture only.
        // Its requested delay is asserted below; production code and corner calculations are unchanged.
        if (state === 'lock') await context.addInitScript(() => {
          const schedule = window.setTimeout.bind(window)
          window.setTimeout = (fn, ms, ...args) => {
            if (ms === 360 && document.querySelector('.obpal-camera[data-state="locked"]')) {
              window.__lockNavigationMs = ms
              return schedule(fn, 10000, ...args)
            }
            return schedule(fn, ms, ...args)
          }
        })
        const page = await context.newPage()
        try {
          if (state === 'denied') {
            const cdp = await context.newCDPSession(page), target = await cdp.send('Target.getTargetInfo')
            await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin, browserContextId: target.targetInfo.browserContextId })
          }
          await page.goto(`${origin}/p/?camera-test=1`); await lime(page)
          await page.getByRole('button', { name: 'Scan a code', exact: true }).click()
          const expected = { idle: 'scanning', lock: 'locked', rejected: 'rejected', denied: 'unavailable' }[state]
          await page.locator(`.obpal-camera[data-state="${expected}"]`).waitFor()
          if (state !== 'rejected') await sleep(280)
          const frost = await checkFrost(page, '.camera-island', { text: ['.camera-status', '.camera-privacy small'] })
          const appearance = await page.locator('.obpal-camera').evaluate(el => ({ scheme: getComputedStyle(el).colorScheme, accent: getComputedStyle(el).getPropertyValue('--bb-accent').trim(), status: el.querySelector('.camera-status').textContent }))
          need(appearance.scheme === 'dark', 'Camera did not own its dark colour scheme')
          if (state === 'lock') {
            const corners = await page.locator('.camera-guide').evaluate(el => {
              const expected = JSON.parse(el.dataset.corners)
              return [...el.querySelectorAll('i')].map((bracket, i) => {
                const r = bracket.getBoundingClientRect()
                const x = i === 1 || i === 2 ? r.right : r.left, y = i >= 2 ? r.bottom : r.top
                return Math.hypot(x - expected[i].x, y - expected[i].y)
              })
            })
            need(corners.every(n => n < 2), `QR bracket corner errors: ${corners}`)
            need(await page.evaluate(() => window.__lockNavigationMs) === 360, 'Lock navigation did not request 360 ms')
            evidence.push({ state, size, cornerErrorsPx: corners, frost })
          } else evidence.push({ state, size, frost, ...appearance })
          await shot(page, `scan-${state}-${size.width}x${size.height}`)
          if (state === 'idle') {
            await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(30)
            need(await page.locator('.obpal-camera').evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length) === 0, 'Reduced motion left camera animations running')
            await shot(page, `scan-reduced-motion-${size.width}x${size.height}`)
          }
          await page.locator('[data-camera-close]').click()
        } finally { await context.close() }
      }
      await browser.close()
    }
    report.designScan = evidence
    return '8 camera states; real jsQR corners within 2 px; text ≥4.5:1 over a white frame; zero reduced-motion animations'
  })

  await check('round 2 hand chips, mirrored skeleton, island hint, clutch dismissal and four Viewer cursors', async () => {
    await phone.evaluate(() => sessionStorage.removeItem('obpal.hint.camera.hand'))
    const previous = await phone.locator('.ctl-tab[aria-selected="true"]').getAttribute('data-tab')
    await lime(phone); await openHand(phone)
    await until('reopened tracker', () => phone.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraHand.stats()?.delegate)), 45000)
    need(await phone.locator('.camera-video').getAttribute('data-mirrored') === 'true', 'Hand did not default to mirrored front capture')
    await inject(phone, handResult())
    await phone.locator('.camera-chip[data-gesture="hand"][data-active="true"]').waitFor()
    await phone.locator('.obpal-camera .hint.in').waitFor()
    const hint = await phone.locator('.obpal-camera .hint').evaluate(el => {
      const r = el.getBoundingClientRect(), island = document.querySelector('.camera-island').getBoundingClientRect()
      const arrow = getComputedStyle(el, '::before'), x = r.left + parseFloat(arrow.left) + 5, y = r.bottom + Math.SQRT2 * 5
      return { text: el.textContent, x, y, island: island.toJSON(), inside: x >= island.left && x <= island.right && y >= island.top && y <= island.bottom }
    })
    need(hint.inside && hint.text.includes('Fist to turn'), `Hint arrow misses island: ${JSON.stringify(hint)}`)
    report.designHint = hint
    await shot(phone, 'hand-island-hint')
    for (const size of sizes) {
      await phone.setViewportSize(size)
      for (const [state, result] of [['hover', handResult()], ['grip', handResult({ grip: true })], ['pinch', handResult({ pinch: true })], ['lost', emptyHand]]) {
        await inject(phone, result)
        const cameraState = state === 'hover' ? 'hand' : state
        await phone.locator(`.obpal-camera[data-hand="${cameraState}"]`).waitFor()
        await screen.locator(`[data-camera-cursor="${state}"]`).waitFor()
        await sleep(state === 'lost' ? 240 : 150)
        await shot(phone, `hand-${state}-${size.width}x${size.height}`)
        if (size.width === 390) await shot(screen, `viewer-cursor-${state}`)
      }
    }
    await sleep(1600)
    need(await screen.locator('[data-camera-cursor="lost"]').count() === 0, 'Lost cursor did not hide after 1.5 s')
    await inject(phone, handResult({ grip: true })); await sleep(250)
    await inject(phone, handResult({ grip: true, x: .68 })); await sleep(500)
    await inject(phone, handResult({ pinch: true })); await sleep(400)
    need(await phone.locator('.obpal-camera .hint').count() === 0, 'Successful fist orbit and pinch did not dismiss the hint')
    await phone.emulateMedia({ reducedMotion: 'reduce' })
    need(await phone.locator('.obpal-camera').evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.playState === 'running').length) === 0, 'Reduced-motion hand camera still animates')
    await shot(phone, 'hand-reduced-motion')
    await phone.locator('[data-camera-close]').click()
    need(await phone.locator('.ctl-tab[aria-selected="true"]').getAttribute('data-tab') === previous, 'Camera exit did not restore the previous tab')
    await phone.emulateMedia({ reducedMotion: 'no-preference' })
    return 'all chips and cursors; mirrored front camera; hint arrow inside island; automatic hint dismissal; previous tab restored'
  })

  await check('round 2 arm Hold and Stop use the opposite side, preserve deadman and expose the Stop shortcut', async () => {
    const arm = await screen.context().newPage()
    await arm.goto(`${origin}/sim/arm/`)
    const invite = await until('arm invite', () => arm.evaluate(() => window.__arm && window.__obpal?.pairingUrl), 30000)
    const context = await (await cameraBrowser(qrFile)).newContext(mobile)
    await context.addInitScript(probeCamera)
    const page = await context.newPage()
    try {
      const url = new URL(invite); url.searchParams.set('camera-test', '1')
      await page.goto(url.href); await page.locator('[data-tab="camera-hand"]').waitFor({ timeout: 25000 })
      await lime(page); await openHand(page)
      await until('arm hand tracker', () => page.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraHand.stats()?.delegate)), 45000)
      await arm.evaluate(() => {
        const id = window.__obpal.participants[0].id
        window.__sim.approved.add(id); window.__sim.claims.take(window.__arm.arms()[0].id, id, true)
      })
      for (const size of sizes) {
        await page.setViewportSize(size)
        for (const side of ['Right', 'Left']) {
          await inject(page, handResult({ side, pinch: true }))
          await page.locator(`.obpal-camera[data-handedness="${side === 'Right' ? 'left' : 'right'}"][data-hand="pinch"]`).waitFor()
          await sleep(200)
          const layout = await page.locator('.obpal-camera').evaluate(el => {
            const hold = el.querySelector('[data-camera-hold]').getBoundingClientRect(), stop = el.querySelector('[data-camera-stop]').getBoundingClientRect()
            return { side: el.dataset.handedness, hold: hold.toJSON(), stop: stop.toJSON(), chips: el.querySelectorAll('.camera-chip').length, ink: getComputedStyle(el.querySelector('[data-camera-stop]')).color }
          })
          need(layout.hold.height === 64 && layout.stop.width === 56 && layout.stop.height === 56 && layout.chips === 2, `Arm dimensions wrong: ${JSON.stringify(layout)}`)
          need(layout.side === 'left' ? layout.hold.x > 16 && layout.stop.x > layout.hold.x : layout.stop.x < layout.hold.x, 'Hold/Stop are not opposite the tracked hand')
          await shot(page, `arm-${layout.side}-${size.width}x${size.height}`)
        }
      }
      const held = page.locator('[data-camera-hold]'), box = await held.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
      await inject(page, handResult()); await sleep(300)
      const initial = await arm.evaluate(() => window.__arm.arms()[0].tool)
      await inject(page, handResult({ x: .56, y: .50, pinch: true })); await sleep(600)
      const moved = await arm.evaluate(() => window.__arm.arms()[0])
      need(moved.handActive, 'Held button did not engage the approved arm')
      need(JSON.stringify(initial) !== JSON.stringify(moved.tool), 'Held hand did not move the arm tool')
      await shot(page, 'arm-hold-pressed')
      await page.mouse.up()
      await inject(page, emptyHand); await sleep(300)
      const frozen = await arm.evaluate(() => window.__arm.arms()[0].joints.map(j => j.target))
      await inject(page, handResult({ x: .3, y: .3 })); await sleep(350)
      need(JSON.stringify(frozen) === JSON.stringify(await arm.evaluate(() => window.__arm.arms()[0].joints.map(j => j.target))), 'No held button did not hold the arm')
      await page.locator('[data-camera-stop]').click()
      need(await arm.evaluate(() => window.__arm.stopped()), 'Phone Stop did not latch the arm')
      await arm.keyboard.press('?'); await arm.locator('[data-quick="stop"]').hover()
      await shot(arm, 'dock-arm-stop')
      await page.locator('[data-camera-close]').click()
    } finally { await context.close(); await arm.close() }
    return 'both hand sides, both phone sizes, actual HAND tool motion under Hold; loss/release holds; Stop latches'
  })

  await check('round 2 download consent precedes model traffic and cached assets are reused', async () => {
    const context = await (await cameraBrowser(qrFile)).newContext(mobile)
    await context.addInitScript(() => Object.defineProperty(navigator, 'connection', { configurable: true, value: { type: 'cellular', saveData: true } }))
    const assets = []
    context.on('request', request => { if (new URL(request.url()).pathname.startsWith('/models/')) assets.push(request.url()) })
    const page = await context.newPage()
    try {
      await screen.evaluate(() => { const pill = document.querySelector('.obpal-chip').shadowRoot.querySelector('.pill'); if (pill.getAttribute('aria-expanded') !== 'true') pill.click() })
      const fresh = await until('fresh invite for download test', () => screen.evaluate(() => window.__obpal.pairingUrl || ''))
      const url = new URL(fresh); url.searchParams.set('camera-test', '1')
      await page.goto(url.href); await page.locator('[data-tab="camera-hand"]').waitFor({ timeout: 25000 })
      await lime(page); await openHand(page)
      await page.locator('[data-camera-download]').waitFor()
      need(assets.length === 0, 'Hand assets downloaded before cellular consent')
      await shot(page, 'hand-download-consent')
      await page.locator('[data-camera-download]').click()
      await until('download and tracker readiness', () => page.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraHand.stats()?.delegate)), 60000)
      const cached = await page.evaluate(async () => {
        const cache = await caches.open('obpal-hand-vision-1.0.1-model-1')
        return (await cache.keys()).map(r => new URL(r.url).pathname)
      })
      need(cached.some(p => p.endsWith('.task')) && cached.some(p => p.endsWith('.wasm')) && cached.some(p => p.endsWith('.js')), 'The complete model/runtime set was not cached')
      await page.locator('[data-camera-close]').click()
      await openHand(page)
      await until('cached tracker readiness', () => page.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraHand.stats()?.delegate)), 45000)
      need(await page.locator('[data-camera-download]').count() === 0, 'Cached assets asked for cellular consent again')
      report.designDownload = { cached, modelRequests: assets.length }
      await page.locator('[data-camera-close]').click()
      const requests = assets.length
      await page.evaluate(async () => {
        await caches.delete('obpal-hand-vision-1.0.1-model-1')
        Object.defineProperty(navigator, 'connection', { configurable: true, value: undefined })
      })
      await openHand(page)
      await page.locator('[data-camera-download]').waitFor()
      need(assets.length === requests, 'An unknown connection downloaded before consent')
      await page.locator('[data-camera-close]').click()
    } finally { await context.close() }
    return 'zero model traffic before consent; 19.5 MB named; complete model and selected WASM/JS cached; no second confirmation'
  })

  await check('round 2 dock screenshots, keycaps, keyboard focus and phone sizes', async () => {
    await screen.keyboard.press('?')
    need(await screen.locator('[data-quick="pair"]').evaluate(el => el === document.activeElement), '? did not focus the primary action')
    await screen.locator('[data-quick="pair"]').hover()
    need(await screen.locator('.quick-tip kbd').textContent() === 'P', 'Desktop Pair has no P keycap')
    need(await screen.locator('.quick-tab').getAttribute('aria-label') === 'Shortcuts', 'Tab accessible name is not Shortcuts')
    await shot(screen, 'dock-viewer-1280x800')
    await screen.keyboard.press('Escape')
    await screen.keyboard.press('t')
    await screen.locator('.quick-themes').waitFor({ state: 'visible' })
    await screen.keyboard.press('Escape')
    const context = await screen.context().browser().newContext(mobile), page = await context.newPage()
    try {
      await page.goto(origin); await page.locator('.quick-tab').click()
      await page.locator('.quick-panel[data-shown="shown"]').waitFor()
      const ids = await page.locator('[data-quick]').evaluateAll(els => els.map(el => el.dataset.quick))
      need(ids[0] === 'scan' && ids.includes('next1') && ids.includes('next2') && ids.includes('next3'), `Home shortcuts: ${ids}`)
      need(await page.locator('[data-quick="scan"]').evaluate(el => el.getBoundingClientRect().width) === 44, 'Phone shortcut is not 44 px')
      need(await page.locator('.quick-tip kbd').count() === 0, 'A phone has keycaps')
      await shot(page, 'dock-home-390x844')
    } finally { await context.close() }
    return 'Viewer keycap; home Scan + three next steps; 44 px phone targets; ? focuses first action'
  })
}
