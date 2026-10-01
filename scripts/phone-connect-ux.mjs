/** Connection layout and scan zoom through real canvas camera frames; no production test hooks. */
import { renderSVG } from 'uqr'
import sharp from 'sharp'
import { setSurface } from './lib/frost.mjs'
import { readButtonInk, inkError } from './lib/button-ink.mjs'

export async function seedScreens(page) {
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await page.locator('.connection-list[aria-busy="false"]').waitFor()
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('obpal')
    request.onerror = reject
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('connections', 'readwrite')
      for (const [i, name, kind] of [[1, 'Desk viewer', 'viewer'], [2, 'Living room PC', 'pc'], [3, 'Studio controller with a longer name', 'sim']]) tx.objectStore('connections').put({ id: `fixture-${i}`, name, kind, at: Date.now() - i * 60000 })
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = reject
    }
  }))
  await page.reload()
  await page.getByRole('button', { name: 'Connections', exact: true }).click()
  await page.locator('.connection-row').nth(2).waitFor()
}

function zoomCamera() {
  let canvas, settings = { deviceId: 'fixture-camera', zoom: 1 }, constraints = {}, hardware = false
  window.__cameraFrames = 0
  window.__cameraHardware = value => { hardware = value }
  window.__paintPreview = () => {
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#b8bfc6'; ctx.fillRect(0, 0, 720, 720)
    ctx.strokeStyle = '#929ba4'; ctx.lineWidth = 2
    for (let n = 0; n <= 720; n += 60) { ctx.beginPath(); ctx.moveTo(n, 0); ctx.lineTo(n, 720); ctx.moveTo(0, n); ctx.lineTo(720, n); ctx.stroke() }
    ctx.fillStyle = '#242a32'; ctx.fillRect(260, 280, 200, 144)
    ctx.fillStyle = '#e7ecef'; ctx.fillRect(272, 292, 176, 112)
    ctx.fillStyle = '#242a32'; ctx.fillRect(348, 424, 24, 24); ctx.fillRect(316, 446, 88, 8)
    canvas.captureTrack.requestFrame()
  }
  window.__paintQr = async url => {
    const image = new Image(); image.src = url; await image.decode()
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 720, 720)
    ctx.drawImage(image, 296, 296, 128, 128)
    canvas.captureTrack.requestFrame()
  }
  navigator.mediaDevices.getUserMedia = async () => {
    canvas = document.createElement('canvas'); canvas.width = canvas.height = 720
    canvas.style.cssText = 'position:fixed;width:2px;height:2px;opacity:.01;pointer-events:none'
    document.body.append(canvas)
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 720, 720)
    const stream = canvas.captureStream(10), track = stream.getVideoTracks()[0]
    canvas.captureTrack = track
    const stop = track.stop.bind(track)
    track.stop = () => { stop(); canvas.remove() }
    track.getCapabilities = () => ({ torch: true, focusMode: ['single-shot'], pointsOfInterest: true, ...(hardware ? { zoom: { min: 1, max: 2, step: .1 } } : {}) })
    track.getSettings = () => settings
    track.getConstraints = () => constraints
    track.applyConstraints = async next => { constraints = next; Object.assign(settings, ...next.advanced ?? []); window.__cameraConstraints = settings }
    return stream
  }
  Object.defineProperty(globalThis, 'BarcodeDetector', { configurable: true, value: undefined })
  const NativeWorker = Worker
  window.Worker = class extends NativeWorker {
    constructor(...args) {
      super(...args)
      if (/qr-worker/.test(String(args[0]))) this.addEventListener('message', () => { window.__cameraFrames++ })
    }
  }
  sessionStorage.setItem('obpal.hint.camera.scan', '1')
}

export async function phoneConnectUx({ browser, origin, check, sample }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, reducedMotion: 'reduce', ignoreHTTPSErrors: true })
  try {
    await ctx.addInitScript(zoomCamera)
    const page = await ctx.newPage()
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${origin}/p/`)
    await seedScreens(page)
    await check('connection sheet: 18 layouts fit, rows share one grid, no empty band over 16px, ink centred within 0.5px', async () => {
      let worst = 0
      for (const theme of ['carbon', 'light', 'navy']) for (const width of [360, 390, 430]) for (const landscape of [false, true]) {
        await page.setViewportSize(landscape ? { width: 844, height: width } : { width, height: 844 })
        await setSurface(page, theme)
        const layout = await page.locator('.connection-sheet').evaluate(el => {
          const box = e => e.getBoundingClientRect(), card = box(el)
          const rows = [...el.querySelectorAll('.connection-row')].map(e => ({ row: box(e).toJSON(), use: box(e.querySelector('.connection-use')).toJSON(), manage: box(e.querySelector('.connection-manage')).toJSON() }))
          const children = [...el.querySelector('.connection-body').children].map(box)
          const portrait = innerHeight > innerWidth
          return { overflow: el.scrollWidth - el.clientWidth, scrolling: el.scrollHeight - el.clientHeight, rows, card: card.toJSON(), gap: portrait ? Math.max(...children.slice(1).map((r, i) => r.top - children[i].bottom)) : children[2].top - children[1].bottom, padding: parseFloat(getComputedStyle(el).paddingLeft) }
        })
        if (layout.overflow > 0 || layout.scrolling > 1 || layout.card.left < 0 || layout.card.right > page.viewportSize().width) throw new Error(`${theme}/${width}/${landscape}: overflow ${JSON.stringify(layout)}`)
        if (layout.gap > 16 || layout.padding !== 16 || layout.rows.some(r => r.row.height > 90)) throw new Error(`Empty bands or padding: ${JSON.stringify(layout)}`)
        for (const row of layout.rows) if (Math.abs(row.use.x - layout.rows[0].use.x) > .5 || Math.abs(row.manage.x - layout.rows[0].manage.x) > .5) throw new Error('Rows do not share a grid')
        const ink = (await readButtonInk(page, { surfaces: true })).filter(r => /connection-|icon-btn|btn|kit-select/.test(r.classes) && !r.occluded)
        worst = Math.max(worst, ...ink.map(inkError))
        if (ink.some(r => inkError(r) > .5)) throw new Error(`Centring: ${JSON.stringify(ink.filter(r => inkError(r) > .5).map(r => ({ name: r.name, offset: r.groupOffset })))}`)
      }
      return `18 states; worst ink offset ${worst.toFixed(3)}px`
    })
    await page.setViewportSize({ width: 390, height: 844 })
    const openScan = async () => {
      if (!await page.locator('.connection-wrap[open]').count()) await page.getByRole('button', { name: 'Connections', exact: true }).click()
      await page.getByRole('button', { name: 'Scan another code', exact: true }).click()
      await page.locator('.obpal-camera[data-state="scanning"]').waitFor()
      await page.waitForFunction(() => window.__cameraFrames > 0)
      await page.evaluate(() => window.__paintPreview())
      await page.locator('.camera-video.has-frame').waitFor()
    }
    const level = () => page.locator('.obpal-camera').getAttribute('data-zoom').then(Number)
    const cdp = await ctx.newCDPSession(page)
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 2, radiusY: 2 })) })
    const tap = async () => { await touch('touchStart', [[1, 195, 350]]); await touch('touchEnd', []) }
    await check('scan camera: pinch, bottom slider and double-tap zoom while jsQR keeps decoding a small QR', async () => {
      await openScan()
      await sample?.(page, 'Default framing · 1×')
      await touch('touchStart', [[1, 165, 350], [2, 225, 350]])
      await touch('touchMove', [[1, 135, 350], [2, 255, 350]])
      await touch('touchEnd', [])
      if (Math.abs(await level() - 2) > .1) throw new Error(`Pinch zoom ${await level()}`)
      await sample?.(page, 'Pinch · 2×')
      const slider = page.getByRole('slider', { name: 'Camera zoom', exact: true })
      await slider.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight')
      if (Math.abs(await level() - 1.05) > .01) throw new Error(`Slider zoom ${await level()}`)
      await sample?.(page, 'Slider · 1.05×')
      await page.waitForTimeout(350); await tap(); await page.waitForTimeout(80); await tap()
      if (Math.abs(await level() - 2) > .01) throw new Error(`Double-tap zoom ${await level()}`)
      await sample?.(page, 'Double-tap · 2×')
      const ink = (await readButtonInk(page, { surfaces: true })).filter(r => r.classes.includes('camera-') && !r.occluded)
      if (ink.some(r => inkError(r) > .5)) throw new Error(`Camera control centring ${JSON.stringify(ink.filter(r => inkError(r) > .5).map(r => ({ name: r.name, offset: r.groupOffset })))}`)
      await page.getByRole('button', { name: 'Focus camera', exact: true }).click()
      await page.getByRole('button', { name: 'Toggle torch', exact: true }).click()
      await page.waitForFunction(() => window.__cameraConstraints?.torch && window.__cameraConstraints?.focusMode === 'single-shot')
      const before = await page.evaluate(() => window.__cameraFrames)
      await page.waitForFunction(before => window.__cameraFrames > before + 2, before)
      const qr = await sharp(Buffer.from(renderSVG('1234567890', { ecc: 'M', border: 4 }))).png().toBuffer()
      await page.evaluate(url => window.__paintQr(url), `data:image/png;base64,${qr.toString('base64')}`)
      await page.getByRole('textbox', { name: 'Code from your screen' }).waitFor({ timeout: 12000 })
      const digits = await page.getByRole('textbox', { name: 'Code from your screen' }).inputValue()
      if (digits.replaceAll(' ', '') !== '1234567890') throw new Error(`Decoded ${digits}`)
      return '128px QR in a 720px frame; focus and torch reached from bottom controls'
    })
    await check('scan camera: remembers this device zoom and mixes constrained zoom with digital range', async () => {
      await page.getByRole('button', { name: 'Close connections', exact: true }).click()
      await page.evaluate(() => window.__cameraHardware(true))
      await openScan()
      if (await level() !== 2) throw new Error('Device zoom was not remembered')
      await page.getByRole('slider', { name: 'Camera zoom', exact: true }).focus(); await page.keyboard.press('End')
      await page.waitForFunction(() => window.__cameraConstraints?.zoom === 2)
      await page.waitForFunction(() => document.querySelector('.camera-video').style.getPropertyValue('--scan-zoom') === '1.5')
      const before = await page.evaluate(() => window.__cameraFrames)
      await page.waitForFunction(before => window.__cameraFrames > before + 2, before)
      await page.getByRole('button', { name: 'Close camera', exact: true }).click()
      if (errors.length) throw new Error(errors[0])
      return '3× = 2× track constraint + 1.5× digital; decoder remains active'
    })
  } finally { await ctx.close() }
}
