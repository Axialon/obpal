/** Connection hub coverage for e2e:phone. Camera frames are injected by the browser harness, with no production hook. */
import { devices } from 'playwright'
import { renderSVG } from 'uqr'
import sharp from 'sharp'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(`timed out: ${what}`)
}

function cameraFrames() {
  if (!navigator.mediaDevices) return
  window.__cameras = []
  window.__nativeQr = ''
  window.__torch = false
  let canvas
  window.__cameraFrame = async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#1b2025'; ctx.fillRect(0, 0, 720, 720)
    ctx.drawImage(image, 100, 100, 520, 520)
    // A canvas changes only once here; explicitly deliver that frame even inside captureStream's rate limit.
    window.__cameras.at(-1).getVideoTracks()[0].requestFrame()
  }
  navigator.mediaDevices.getUserMedia = async () => {
    canvas = document.createElement('canvas')
    canvas.width = canvas.height = 720
    // A connected canvas is painted by headless Chromium, publishing later injected frames to captureStream.
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:.01;pointer-events:none'
    canvas.setAttribute('aria-hidden', 'true')
    document.body.append(canvas)
    const source = canvas
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#1b2025'; ctx.fillRect(0, 0, 720, 720)
    const stream = canvas.captureStream(10)
    const track = stream.getVideoTracks()[0]
    const stop = track.stop.bind(track)
    track.stop = () => { stop(); source.remove() }
    track.getCapabilities = () => ({ torch: true })
    track.applyConstraints = async (o) => { window.__torch = o.advanced[0].torch }
    window.__cameras.push(stream)
    return stream
  }
  // Exercise the native branch before exercising real decoded pixels through jsQR.
  window.BarcodeDetector = class {
    static async getSupportedFormats() { return ['qr_code'] }
    async detect() { return window.__nativeQr ? [{ rawValue: window.__nativeQr }] : [] }
  }
}

/** Hold a real write transaction open until the test releases it, as a busy storage process can do. */
function delayedStorage() {
  const transaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args) {
    const tx = transaction.apply(this, args)
    if (args[1] === 'readwrite' && tx.objectStoreNames.contains('connections') && window.__holdConnectionWrites) {
      const end = performance.now() + 10000
      const keep = () => {
        if (window.__holdConnectionWrites && performance.now() < end) tx.objectStore('connections').count().onsuccess = keep
      }
      keep()
    }
    return tx
  }
}

export async function phoneConnections({ browser, origin, check, shots }) {
  const screens = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
  await ctx.addInitScript(cameraFrames)
  await ctx.addInitScript(delayedStorage)
  const errors = []
  ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)))
  screens.on('page', (p) => p.on('pageerror', (e) => errors.push(`screen: ${e.message}`)))
  let phone = await ctx.newPage()
  const cdp = await ctx.newCDPSession(phone)
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  const shot = async (name) => { if (shots) await phone.screenshot({ path: join(shots, `${name}.png`), animations: 'disabled' }) }
  const clear = () => phone.evaluate(() => document.querySelectorAll('.hint, .bt-notice').forEach((h) => h.remove()))
  const stopped = () => phone.evaluate(() => window.__cameras.every((s) => s.getTracks().every((t) => t.readyState === 'ended')))
  const saved = (page = phone) => page.locator('.connection-list[aria-busy="false"]').waitFor()
  const open = async () => { await clear(); await phone.getByRole('button', { name: 'Connections', exact: true }).click(); await saved() }
  const close = () => phone.getByRole('button', { name: 'Close connections' }).click()
  const row = (name) => phone.locator('.connection-row').filter({ has: phone.getByText(name, { exact: true }) })
  const rename = async (from, to) => {
    await row(from).getByRole('button', { name: `Rename ${from}`, exact: true }).click()
    await phone.getByRole('textbox', { name: 'Screen name' }).fill(to)
    await phone.evaluate(() => { window.__holdConnectionWrites = true })
    await phone.getByRole('button', { name: 'Save', exact: true }).click()
    try {
      await phone.getByRole('status').filter({ hasText: /^Saving…$/ }).waitFor()
      if (!(await phone.getByRole('button', { name: 'Save', exact: true }).isDisabled())) throw new Error('rename confirmed before storage committed')
    } finally { await phone.evaluate(() => { window.__holdConnectionWrites = false }) }
    await phone.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor()
    await saved()
  }
  try {
    const a = await screens.newPage(), b = await screens.newPage()
    await a.goto(`${origin}/view/`); await b.goto(`${origin}/view/`)
    const inviteA = await until('first screen', () => a.evaluate(() => window.__obpal?.pairingUrl))
    const inviteB = await until('second screen', () => b.evaluate(() => window.__obpal?.pairingUrl))
    for (const page of [a, b]) await page.evaluate(() => {
      window.__buttons = []; window.__inputs = 0
      window.__obpal.on('button', (m) => window.__buttons.push(m))
      window.__obpal.on('input', () => window.__inputs++)
    })
    await phone.goto(inviteA)
    await phone.locator('.modes').waitFor({ timeout: 25000 }).catch(async error => {
      const state = await phone.evaluate(() => ({ text: document.body.innerText.slice(0, 800), visibility: document.visibilityState,
        marks: performance.getEntriesByType('mark').filter(m => m.name.startsWith('obpal:')).map(m => m.name) }))
      const host = await a.evaluate(() => ({ status: window.__obpal?.status, peers: window.__obpal?.participants.length ?? 0 }))
      throw new Error(`${error.message}; phone: ${JSON.stringify(state)}; screen: ${JSON.stringify(host)}; page errors: ${errors.join(' | ') || 'none'}`)
    })
    await open(); await rename('ob.Pal Viewer', 'Desk viewer'); await close()

    await check('the in-app scanner rejects foreign QR codes, offers a torch, and stops its camera on close', async () => {
      await open(); await phone.getByRole('button', { name: 'Scan another code', exact: true }).click()
      await phone.getByRole('button', { name: 'Toggle torch' }).waitFor()
      await phone.getByRole('button', { name: 'Toggle torch' }).click()
      await until('torch', () => phone.evaluate(() => window.__torch))
      await phone.evaluate(() => { window.__nativeQr = 'https://not-obpal.example/p/#1.not.a.pairing' })
      await until('refusal', async () => (await phone.locator('.connection-say').textContent()).includes('isn’t an ob.Pal code'))
      if (!phone.url().startsWith(`${origin}/p/`)) throw new Error('a scan navigated away')
      await shot('refused-390x844')
      await close()
      if (!(await stopped())) throw new Error('camera survived closing')
      return 'refused in place; torch toggled; every track ended'
    })

    await check('real injected camera pixels decode with the lazy fallback and pair a second screen', async () => {
      const fallbackBefore = await phone.evaluate(() => performance.getEntriesByType('resource').filter((r) => /jsQR|jsqr/.test(r.name)).length)
      if (fallbackBefore) throw new Error('fallback was loaded before it was needed')
      await phone.evaluate(() => { window.BarcodeDetector = undefined; window.__nativeQr = '' })
      await open(); await phone.getByRole('button', { name: 'Scan another code', exact: true }).click()
      await phone.getByRole('button', { name: 'Toggle torch' }).waitFor()
      await shot('scanner-390x844')
      await phone.setViewportSize({ width: 844, height: 390 })
      await phone.bringToFront()
      await until('camera has a frame', () => phone.locator('video').evaluate(video => video.readyState >= 2 && !video.paused))
      await shot('scanner-844x390')
      const png = await sharp(Buffer.from(renderSVG(inviteB, { ecc: 'M', border: 4 }))).resize(520, 520).png().toBuffer()
      await phone.evaluate((data) => window.__cameraFrame(data), `data:image/png;base64,${png.toString('base64')}`)
      await until('second active', async () => (await phone.locator('.host-name').textContent()) === 'ob.Pal Viewer').catch(async error => {
        throw new Error(`${error.message}; scanner: ${await phone.locator('.connection-say').allTextContents()}; page errors: ${errors.join(' | ') || 'none'}`)
      })
      if (!(await stopped())) throw new Error('camera survived pairing')
      await until('first paused', () => a.evaluate(() => window.__obpal.participants[0]?.paused))
      await open(); await rename('ob.Pal Viewer', 'Living room')
      if (await phone.locator('.connection-row').count() !== 2) throw new Error('the previous connection was lost')
      await shot('connections-844x390')
      await phone.setViewportSize({ width: 390, height: 844 })
      await shot('connections-390x844')
      await close()
      return 'jsQR decoded the image; both screens stayed connected'
    })

    await check('switching releases held input and routes touch, hardware and motion only to the active screen', async () => {
      await phone.locator('[data-tab=point]').click(); await clear()
      await phone.keyboard.down('AudioVolumeDown')
      await until('held B on second', () => b.evaluate(() => window.__buttons.some((m) => m.id === 'wii-b' && m.ev === 'down')))
      await open()
      await row('Desk viewer').locator('.connection-use').click()
      await phone.keyboard.up('AudioVolumeDown')
      await until('first resumed, second paused', async () => !(await a.evaluate(() => window.__obpal.participants[0]?.paused)) && await b.evaluate(() => window.__obpal.participants[0]?.paused))
      if (!(await b.evaluate(() => window.__buttons.some((m) => m.id === 'wii-b' && m.ev === 'up')))) throw new Error('held button did not release')
      await phone.locator('[data-tab=point]').click(); await clear()
      for (const page of [a, b]) await page.evaluate(() => { window.__buttons = []; window.__inputs = 0 })
      await phone.locator('#wii-plus').click()
      await phone.keyboard.press('PageDown')
      await until('input on first', () => a.evaluate(() => window.__buttons.filter((m) => m.id === 'wii-plus').length >= 2 && window.__inputs > 0))
      await sleep(300)
      const idle = await b.evaluate(() => [window.__buttons.length, window.__inputs])
      if (idle.some(Boolean)) throw new Error(`background got input: ${idle}`)
      await shot('switch-390x844')
      await phone.setViewportSize({ width: 844, height: 390 }); await shot('switch-844x390')
      await phone.setViewportSize({ width: 390, height: 844 })
      return 'held B released; background received zero buttons and zero input packets'
    })

    await check('names and keys persist across a reload; forgetting removes the entry and it stays forgotten', async () => {
      await open(); await close()
      await phone.reload()
      await phone.locator('.modes').waitFor({ timeout: 25000 })
      await open()
      if (await phone.locator('.connection-row').count() !== 2) throw new Error('list did not persist')
      await row('Living room').locator('.connection-use').click()
      await until('remembered screen reconnected', async () => (await phone.locator('.host-name').textContent()) === 'Living room')
      await open(); await row('Desk viewer').getByRole('button', { name: 'Forget Desk viewer', exact: true }).click()
      await until('forgotten', async () => await phone.locator('.connection-row').count() === 1)
      await close(); await phone.reload()
      await phone.locator('.modes').waitFor({ timeout: 25000 }); await open()
      if (await phone.locator('.connection-row').count() !== 1 || await row('Desk viewer').count()) throw new Error('forgotten entry returned')
      const stored = await phone.evaluate(() => new Promise((resolve, reject) => {
        const request = indexedDB.open('obpal')
        request.onerror = reject
        request.onsuccess = () => {
          const db = request.result, get = db.transaction('connections').objectStore('connections').getAll()
          get.onsuccess = () => { resolve(get.result.map((r) => ({ name: r.name, key: r.invite?.key instanceof CryptoKey, extractable: r.invite?.key.extractable, secret: r.invite?.secret }))); db.close() }
        }
      }))
      if (stored.length !== 1 || !stored[0].key || stored[0].extractable || stored[0].secret) throw new Error('invite not stored as a non-extractable key')
      await close()
      return 'one remembered screen; invite is a non-extractable CryptoKey'
    })

    await check('a new tab has the remembered list; camera-to-code and Back both stop the camera', async () => {
      await phone.close()
      phone = await ctx.newPage()
      await phone.goto(`${origin}/p/`)
      await phone.getByRole('button', { name: 'Connections', exact: true }).click()
      await saved()
      if (await row('Living room').count() !== 1) throw new Error('a new tab lost the list')
      await phone.locator('dialog').getByRole('button', { name: 'Scan another code', exact: true }).click()
      await phone.getByRole('button', { name: 'Toggle torch' }).waitFor()
      await phone.getByRole('button', { name: 'Enter a code', exact: true }).click()
      if (!(await stopped())) throw new Error('code entry left camera running')
      await phone.getByRole('button', { name: 'Scan instead', exact: true }).click()
      await phone.getByRole('button', { name: 'Toggle torch' }).waitFor()
      await phone.goBack()
      await until('Back closed scanner', async () => await phone.locator('dialog[open]').count() === 0)
      if (!(await stopped())) throw new Error('Back left camera running')
      if (errors.length) throw new Error(errors.join(' | '))
      return 'list survives a new tab; camera ends on code entry and Back'
    })

    await check('Enter a code inside the scanner pairs through the existing short-code exchange', async () => {
      await b.evaluate(() => { window.__stopCode = window.__obpal.wantCode() })
      const code = await until('short code', () => b.evaluate(() => window.__obpal.code))
      await phone.getByRole('button', { name: 'Scan a code', exact: true }).click()
      await phone.getByRole('button', { name: 'Toggle torch' }).waitFor()
      await phone.getByRole('button', { name: 'Enter a code', exact: true }).click()
      await phone.locator('dialog').getByRole('textbox', { name: 'Code from your screen' }).fill(code)
      await phone.locator('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
      await phone.locator('.modes').waitFor({ timeout: 25000 })
      await until('correct screen active', async () => (await phone.locator('.host-name').textContent()) === 'Living room')
      if (!(await stopped())) throw new Error('camera survived code entry')
      await b.evaluate(() => window.__stopCode())
      return 'ten digits verified by CPace; local name preserved'
    })

    await check('a version-one remembered PC migrates in IndexedDB and forgetting removes its original key', async () => {
      const legacy = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
      try {
        const page = await legacy.newPage()
        await page.goto(`${origin}/buttons/`)
        await page.evaluate(async () => {
          const key = await crypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits', 'deriveKey'])
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('obpal', 1)
            request.onupgradeneeded = () => { request.result.createObjectStore('certs'); request.result.createObjectStore('pairs', { keyPath: 'id' }) }
            request.onerror = reject
            request.onsuccess = () => {
              const db = request.result, tx = db.transaction('pairs', 'readwrite')
              tx.objectStore('pairs').put({ id: 'AAAAAAAAAAAAAAAAAAAAAA', key, peerFp: new Uint8Array(32), peerName: 'Desk PC', at: Date.now() - 60000 })
              tx.oncomplete = () => { db.close(); resolve() }
              tx.onabort = reject
            }
          })
        })
        await page.goto(`${origin}/p/`)
        await page.getByRole('button', { name: 'Connections', exact: true }).click()
        await page.locator('.connection-row').getByText('Desk PC', { exact: true }).waitFor()
        const keyKept = await page.evaluate(() => new Promise((resolve) => {
          const request = indexedDB.open('obpal')
          request.onsuccess = () => {
            const db = request.result, get = db.transaction('pairs').objectStore('pairs').get('AAAAAAAAAAAAAAAAAAAAAA')
            get.onsuccess = () => { resolve(db.version === 2 && get.result.key instanceof CryptoKey && !get.result.key.extractable); db.close() }
          }
        }))
        if (!keyKept) throw new Error('migration lost the original key')
        await page.getByRole('button', { name: 'Rename Desk PC', exact: true }).click()
        await page.getByRole('textbox', { name: 'Screen name' }).fill('Studio PC')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.getByRole('status').filter({ hasText: /^Saved$/ }).waitFor()
        await saved(page)
        await page.getByRole('button', { name: 'Close connections' }).click()
        await page.reload()
        await page.getByRole('button', { name: 'Connections', exact: true }).click()
        await page.locator('.connection-row').getByText('Studio PC', { exact: true }).waitFor()
        await page.getByRole('button', { name: 'Forget Studio PC', exact: true }).click()
        await until('old PC forgotten', async () => await page.locator('.connection-row').count() === 0)
        await page.reload()
        await page.getByRole('button', { name: 'Connections', exact: true }).click()
        await page.getByText('Your screens will appear here.', { exact: true }).waitFor()
        return 'schema 1 → 2; key kept, rename persisted, forgotten PC did not migrate back'
      } finally { await legacy.close() }
    })

    await check('a browser requiring a motion gesture can scan before granting motion permission', async () => {
      const apple = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true })
      await apple.addInitScript(cameraFrames)
      await apple.addInitScript(() => {
        DeviceMotionEvent.requestPermission = DeviceOrientationEvent.requestPermission = async () => {
          if (!navigator.userActivation.isActive) throw new DOMException('A gesture is needed', 'NotAllowedError')
          return 'granted'
        }
      })
      try {
        const page = await apple.newPage()
        await page.goto(`${origin}/p/`)
        if (await page.locator('#gate').count()) throw new Error('motion prompt covered pairing')
        await page.getByRole('button', { name: 'Scan a code', exact: true }).click()
        await page.getByRole('button', { name: 'Toggle torch' }).waitFor()
        const invite = await a.evaluate(() => window.__obpal.pairingUrl)
        await page.evaluate((text) => { window.__nativeQr = text }, invite)
        await page.getByRole('button', { name: 'Start', exact: true }).click()
        await page.locator('.modes').waitFor({ timeout: 25000 })
        if (!(await page.evaluate(() => window.__cameras.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))))) throw new Error('camera survived motion prompt')
        return 'pairing remains reachable; motion asks only once a screen is connected'
      } finally { await apple.close() }
    })
  } finally { await ctx.close(); await screens.close() }
}
