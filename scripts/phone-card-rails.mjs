/** Real touch swipes through the phone's cards and the phone-sized site; no injected scrolling implementation. */
export const CARD_RAILS = '.sheet:not(.picker), .picker-list, .ctl-tabs, .tray, .kit-sheet-body, .kit-side-body, .kit-listbox, .tiles, .switcher, .themes, .people, .lighting, .quick-themes, .quick-tip, .presence-active .presence-controls, .wii, .music-face, .surface.one-hand .mouse, .ns-list, .bt-log ol, #community-packs pre, .bld-out pre, .embed-code pre, .build-card pre, .embed-panel, .scene-strip, .obpal-chip .seals'

async function swipe(page, box, dx, dy) {
  const cdp = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2, y = box.y + Math.min(box.height / 2, 160)
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    for (let n = 1; n <= 10; n++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * n / 10, y: y + dy * n / 10 }] })
      await page.waitForTimeout(20)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(1000)
  } finally { await cdp.detach() }
}

/** Check both the locked axis and native snap candidates, including clamped end positions. */
export async function guardCardRails(page, state) {
  let measured = 0
  for (const rail of await page.locator(CARD_RAILS).elementHandles()) {
    if (!await rail.evaluate(el => el.isConnected && !el.closest('.out')) || !await rail.isVisible()) continue
    const box = await rail.boundingBox(), size = page.viewportSize()
    if (!box || box.width < 2 || box.height < 2 || box.y >= size.height || box.y + box.height <= 0) continue
    // A backdrop's rail is tested in its own state, when the top sheet cannot intercept the swipe.
    const exposed = await rail.evaluate(el => {
      const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 160)
      let hit = document.elementFromPoint(x, y)
      while (hit?.shadowRoot) {
        const next = hit.shadowRoot.elementFromPoint(x, y)
        if (!next || next === hit) break
        hit = next
      }
      return hit && el.contains(hit)
    })
    if (!exposed) continue
    const axis = await rail.evaluate(el => getComputedStyle(el).overflowX === 'auto' ? 'x' : 'y')
    for (const gesture of axis === 'x' ? [[-90, -24], [0, -70]] : [[-24, -90], [-70, 0]]) {
      const before = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
      const start = await rail.evaluate((el, axis) => axis === 'x' ? el.scrollLeft : el.scrollTop, axis)
      await swipe(page, box, ...gesture)
      const r = await rail.evaluate((el, axis) => {
        const css = getComputedStyle(el), rect = el.getBoundingClientRect()
        const horizontal = axis === 'x', offset = horizontal ? el.scrollLeft : el.scrollTop
        const max = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
        const pad = parseFloat(horizontal ? css.scrollPaddingLeft : css.scrollPaddingTop) || 0
        const candidates = [0, max]
        for (const item of el.querySelectorAll('*')) {
          const itemCss = getComputedStyle(item)
          if (itemCss.scrollSnapAlign === 'none') continue
          const r = item.getBoundingClientRect()
          const margin = parseFloat(horizontal ? itemCss.scrollMarginLeft : itemCss.scrollMarginTop) || 0
          if (r.width && r.height) candidates.push(Math.max(0, Math.min(max, offset + (horizontal ? r.left - rect.left - el.clientLeft : r.top - rect.top - el.clientTop) - pad - margin)))
        }
        const matrix = new DOMMatrixReadOnly(css.transform)
        return { name: el.className || el.tagName, overflow: horizontal ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth,
          locked: horizontal ? el.scrollTop : el.scrollLeft, touch: css.touchAction, overscroll: css.overscrollBehavior,
          snap: css.scrollSnapType, offset, candidates, gap: Math.min(...candidates.map(p => Math.abs(p - offset))), transform: horizontal ? matrix.m42 : matrix.m41 }
      }, axis)
      if (r.overflow > 0 || Math.abs(r.locked) > .5 || Math.abs(r.transform) > .5) throw new Error(`${state}: ${r.name} off its ${axis} rail: ${JSON.stringify(r)}`)
      if (r.touch !== `pan-${axis}` && r.name !== 'ns-list') throw new Error(`${state}: ${r.name} touch ${r.touch}`)
      if (r.overscroll !== 'contain') throw new Error(`${state}: ${r.name} chains scroll`)
      if (r.snap !== 'none' && r.gap > 1.5) throw new Error(`${state}: ${r.name} rests ${r.gap}px from a snap point: ${JSON.stringify(r)}`)
      if ((axis === 'x' ? gesture[0] === 0 : gesture[1] === 0) && Math.abs(r.offset - start) > 1.5) throw new Error(`${state}: perpendicular swipe moved ${r.name} along its rail`)
      const after = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
      if (after.x !== before.x || after.y !== before.y) throw new Error(`${state}: card dragged the page`)
    }
    measured++
  }
  for (const card of await page.locator('.cat-card, .pack-card, .scene-card, .sheet.picker, .kit-sheet').all()) if (await card.isVisible()) {
    if (await card.evaluate(el => el.scrollWidth > el.clientWidth)) throw new Error(`${state}: card content is wider than its card`)
  }
  return measured
}

/** A perpendicular first move stays locked even if the gesture later changes direction; cancellation never dismisses. */
async function guardSheetPull(page) {
  const sheet = page.locator('.sheet').last()
  await sheet.evaluate(el => {
    const touch = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y })
      el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' || type === 'touchcancel' ? [] : [t], changedTouches: [t] }))
    }
    el.scrollTop = 0
    touch('touchstart', 100, 100); touch('touchmove', 125, 104); touch('touchmove', 130, 140); touch('touchend', 130, 140)
    if (el.style.transform) throw new Error('Perpendicular gesture pulled the sheet')
    touch('touchstart', 100, 100); touch('touchmove', 102, 125); touch('touchmove', 120, 115); touch('touchcancel', 120, 115)
  })
  await page.waitForTimeout(400)
  const settled = await sheet.evaluate(el => ({ inline: el.style.transform, offset: new DOMMatrixReadOnly(getComputedStyle(el).transform).m42, connected: el.isConnected }))
  if (!await sheet.isVisible() || Math.abs(settled.offset) > .5) throw new Error(`Cancelled pull did not settle to zero: ${JSON.stringify(settled)}`)
}

export async function phoneCardRails({ browser, origin, check }) {
  for (const width of [360, 390, 430]) await check(`card rails at ${width}px: diagonal, perpendicular, snap, containment and cancelled pull`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    try {
      await context.addInitScript(() => {
        for (const name of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more', 'camera.scan']) sessionStorage.setItem(`obpal.hint.${name}`, '1')
        navigator.mediaDevices.getUserMedia = async () => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64
          const stream = canvas.captureStream(10), track = stream.getVideoTracks()[0]
          track.getCapabilities = () => ({})
          track.getSettings = () => ({ width: 64, height: 64 })
          return stream
        }
        window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code'] } async detect() { return [] } }
      })
      const page = await context.newPage(), screen = await context.newPage()
      const orientation = await context.newCDPSession(page)
      await orientation.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
      await screen.setViewportSize({ width: 1280, height: 800 })
      await screen.goto(origin + '/view/')
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await page.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await page.waitForFunction(() => document.body.classList.contains('live'))
      await page.bringToFront()
      let count = 0
      const test = async state => { count += await guardCardRails(page, state) }
      const close = async () => { await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
      await screen.setViewportSize({ width, height: 844 })
      await screen.bringToFront()
      await screen.locator('.obpal-chip .seal-peer').first().evaluate(el => el.click())
      count += await guardCardRails(screen, 'pairing comparison card')
      await screen.setViewportSize({ width: 1280, height: 800 })
      await page.bringToFront()
      await test('phone live')
      await page.locator('.trust-shares').evaluate(el => el.click())
      await page.locator('.shares-sheet p span').first().evaluate(el => { el.textContent = 'LongToken'.repeat(40) })
      await test('What this shares'); await close()
      await page.getByRole('button', { name: 'Connections', exact: true }).click()
      await page.locator('.connection-list[aria-busy="false"]').waitFor()
      await page.locator('.connection-label b').evaluateAll(nodes => nodes.forEach(el => { el.textContent = 'Screen'.repeat(40) }))
      await test('connections'); await guardSheetPull(page); await close()
      await page.locator('#ctl-more').evaluate(el => el.click())
      await test('controller picker'); await close()
      for (const face of ['wii', 'mouse', 'wheel', 'trackpad']) {
        await page.locator('#ctl-more').evaluate(el => el.click())
        await page.locator(`.ctl-wrap:not(.out) .ctl-card[data-c="face.${face}"]`).evaluate(el => el.click())
        await page.locator('.ctl-wrap').waitFor({ state: 'detached' })
        await test(face)
      }
      for (const selector of ['.scene-btn', '.tray-btn.select:not(.scene-btn)']) {
        await page.locator(selector).first().evaluate(el => el.click())
        await page.locator('.picker-list .pick-name').first().evaluate(el => { el.textContent = 'Model'.repeat(40) })
        await test(selector); await close()
      }
      await page.locator('#gear').evaluate(el => el.click())
      await test('settings')
      for (const motion of ['no-preference', 'reduce']) {
        await page.emulateMedia({ reducedMotion: motion })
        await guardSheetPull(page)
      }
      await page.locator('#buttons-open').evaluate(el => el.click())
      await test('bindings'); await close()
      await page.locator('#gear').evaluate(el => el.click())
      await page.locator('#scan-open').evaluate(el => el.click())
      const scanner = page.locator('.obpal-camera[open]')
      await scanner.waitFor()
      const scannerBox = await scanner.boundingBox()
      await swipe(page, scannerBox, -60, -30)
      await swipe(page, scannerBox, 0, -60)
      const camera = await scanner.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop, wide: el.scrollWidth > el.clientWidth, tall: el.scrollHeight > el.clientHeight, transform: getComputedStyle(el).transform }))
      if (camera.x || camera.y || camera.wide || camera.tall || camera.transform !== 'none') throw new Error(`Scanner moved: ${JSON.stringify(camera)}`)
      await scanner.locator('[data-camera-close]').evaluate(el => el.click())
      await page.locator('#gear').evaluate(el => el.click())
      await page.locator('#connection-details').evaluate(el => el.click())
      await page.locator('.link-sheet').waitFor()
      await test('connection details')
      await guardSheetPull(page)
      await close()
      await page.locator('#ctl-more').evaluate(el => el.click())
      await page.locator('.ctl-wrap:not(.out) .ctl-card[data-c="face.gamepad"]').evaluate(el => el.click())
      await page.locator('.ctl-wrap').waitFor({ state: 'detached' })
      await page.locator('.gp:not([hidden]) [data-act="profile"]').evaluate(el => el.click())
      await test('packs and profiles'); await close()
      await screen.goto(origin + '/sim/device/?d=studio')
      await screen.waitForFunction(() => !!window.__obpal?.pairingUrl)
      await page.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
      await page.waitForFunction(() => document.body.classList.contains('live'))
      await page.bringToFront()
      for (const face of ['drums', 'keys']) {
        await page.locator('#ctl-more').evaluate(el => el.click())
        await page.locator(`.ctl-wrap:not(.out) .ctl-card[data-c="face.${face}"]`).evaluate(el => el.click())
        await page.locator('.ctl-wrap').waitFor({ state: 'detached' })
        await test(face)
      }
      await screen.close()
      for (const route of ['/', '/catalogue/', '/embed/', '/view/', '/sim/']) {
        await page.goto(origin + route)
        await page.waitForTimeout(700)
        await page.locator('details').evaluateAll(nodes => nodes.forEach(el => el.open = true))
        if (route === '/sim/') {
          await page.locator('#filters-open').evaluate(el => el.click())
          await test('filters sheet')
          const handle = page.locator('.sims-sheet-head'), handleBox = await handle.boundingBox()
          await swipe(page, handleBox, -60, -10)
          await swipe(page, handleBox, -10, -30)
          const pulled = await handle.evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el.parentElement).transform).m42)
          if (Math.abs(pulled) > .5) throw new Error(`Filters handle rests ${pulled}px away`)
          await close()
        }
        // Make every site's reading rail visible to the touch dispatcher.
        for (const rail of await page.locator(CARD_RAILS).all()) if (await rail.isVisible()) {
          await rail.scrollIntoViewIfNeeded()
          await test(route)
        }
        if (route === '/view/') {
          await page.locator('#rail-toggle').evaluate(el => el.click())
          await test('viewer catalogue')
        }
        const shortcuts = page.getByRole('button', { name: 'Shortcuts', exact: true })
        if (await shortcuts.isVisible()) {
          await shortcuts.evaluate(el => el.click())
          await page.locator('[data-quick="theme"]').evaluate(el => el.click())
          await test('theme picker'); await close()
        }
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${route} wider than ${width}px`)
      }
      if (count < 15) throw new Error(`Only ${count} card states measured`)
      return `${count} exposed rails, two gestures each; script axis lock and cancel settle`
    } finally { await context.close() }
  })
}
