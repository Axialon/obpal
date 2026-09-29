/**
 * The camera in the controller's settings, for e2e:phone. Settings has two cameras: the pairing scanner (Scan a code)
 * and the 3D hand's camera tracking (3D position comes from: Camera). The scanner is Settings' first control, and one tap
 * opens it with its camera started inside that tap; closing it, by its × or by Back, leaves no dead Back step behind.
 * The 3D hand's Camera says when this phone can't follow with its camera, and a camera start that fails can be tried
 * again. Camera frames come from the browser harness (a painted canvas), with no production hook.
 */
import { devices } from 'playwright'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 10000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error(`timed out: ${what}`)
}

/** A camera the page can open, which notes the event it was opened in (a tap's, or none: a timer's). */
function fakeCamera() {
  window.__cameras = []
  navigator.mediaDevices.getUserMedia = async () => {
    window.__cameras.push({ during: window.event?.type ?? '' })
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 64
    canvas.getContext('2d').fillRect(0, 0, 64, 64)
    const stream = canvas.captureStream(10)
    window.__cameras.at(-1).stream = stream
    return stream
  }
  window.BarcodeDetector = class { static async getSupportedFormats() { return ['qr_code'] } async detect() { return [] } }
  for (const k of ['gyro', 'models', 'more', 'point', 'lock', 'track']) try { sessionStorage.setItem(`obpal.hint.${k}`, '1') } catch { /* private */ }
}

/** WebXR as an Android phone with ARCore has it, whose sessions start and then fail to find their space. */
function brokenXr() {
  window.__xrStarts = 0
  class Session extends EventTarget {
    constructor() { super(); this.renderState = { baseLayer: null } }
    updateRenderState(r) { this.renderState = { ...this.renderState, ...r } }
    async requestReferenceSpace() { throw new DOMException('No tracking here', 'NotSupportedError') }
    requestAnimationFrame() { return 0 }
    async end() { window.__xrEnded = (window.__xrEnded ?? 0) + 1; this.dispatchEvent(new Event('end')) }
  }
  Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported: async (m) => m === 'immersive-ar', requestSession: async () => { window.__xrStarts++; return new Session() } } })
  window.XRWebGLLayer = class { constructor() { this.framebuffer = null } }
}

export async function phoneCamera({ browser, origin, check, shots }) {
  const screens = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const phones = []
  const join = async (init) => {
    const screen = await screens.newPage()
    await screen.goto(`${origin}/view/`)
    const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl), 20000)
    const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    phones.push(ctx)
    await ctx.addInitScript(fakeCamera)
    if (init) await ctx.addInitScript(init)
    const phone = await ctx.newPage()
    await phone.goto(invite)
    await phone.locator('.modes').waitFor({ timeout: 25000 })
    return phone
  }
  const settings = async (phone) => {
    await phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    await phone.locator('#gear').click()
    await phone.locator('.sheet.settings').waitFor({ timeout: 3000 })
    await sleep(300)
  }
  const shut = (phone, what) => until(`${what} closed`, () => phone.evaluate(() => !document.querySelector('dialog[open], .sheet.settings')), 4000)
  const step = (phone) => phone.evaluate(() => (history.state && typeof history.state === 'object' && 'obpalSheet' in history.state ? 'a sheet’s' : ''))
  /** Close whatever a check before left open (Esc closes a sheet as Back does). */
  const calm = async (phone) => {
    for (let n = 0; n < 3 && await phone.evaluate(() => !!document.querySelector('dialog[open], .sheet-wrap')); n++) { await phone.keyboard.press('Escape'); await sleep(350) }
  }
  try {
    const phone = await join()

    await check('Settings’ camera is its first control: one tap opens the scanner, its camera started inside the tap', async () => {
      await settings(phone)
      const first = await phone.evaluate(() => {
        const sheet = document.querySelector('.sheet.settings')
        const top = sheet.getBoundingClientRect().top
        const c = [...sheet.querySelectorAll('button, input, a, select')].find((e) => !e.closest('.sheet-head') && e.offsetParent)
        const label = c?.getAttribute('aria-label') || c?.closest('label')?.querySelector('span')?.textContent || c?.querySelector('span')?.firstChild?.textContent || c?.textContent || ''
        return { id: c?.id ?? '', label: label.trim().replace(/\s+/g, ' ').slice(0, 40), at: c ? c.getBoundingClientRect().top - top : -1 }
      })
      if (first.id !== 'scan-open') throw new Error(`Settings opens on "${first.label}", not the camera`)
      if (shots) await phone.screenshot({ path: `${shots}/settings-camera-390x844.png` })
      await phone.locator('#scan-open').click()
      await phone.locator('.obpal-camera[data-mode="scan"]').waitFor()
      const cam = await until('the camera', () => phone.evaluate(() => window.__cameras.at(-1) && { during: window.__cameras.at(-1).during, live: window.__cameras.at(-1).stream?.getVideoTracks()[0]?.readyState }))
      if (cam.during !== 'click') throw new Error(`the camera started ${cam.during ? `in a ${cam.during}` : 'from a timer, after the tap'}`)
      if (cam.live !== 'live') throw new Error(`camera ${cam.live}`)
      return `"${first.label}" ${first.at.toFixed(0)} px from the top; the camera opened in the tap`
    })

    await check('closing the scanner by Back or its ×, or Settings by its ×, leaves no dead Back step behind', async () => {
      if (!(await phone.locator('.obpal-camera[open]').count())) { await calm(phone); await settings(phone); await phone.locator('#scan-open').click() }
      await phone.locator('.obpal-camera[open]').waitFor()
      await phone.goBack()
      await shut(phone, 'Back')
      if (await step(phone)) throw new Error('after Back from the scanner, Back lands on a closed sheet’s step')
      await settings(phone)
      await phone.locator('#scan-open').click()
      await phone.locator('.obpal-camera[open]').waitFor()
      await phone.locator('[data-camera-close]').click()
      await shut(phone, 'the scanner’s ×')
      if (await step(phone)) throw new Error('after the scanner’s ×, Back lands on a closed sheet’s step')
      const stopped = await phone.evaluate(() => window.__cameras.every((c) => c.stream.getTracks().every((t) => t.readyState === 'ended')))
      if (!stopped) throw new Error('the camera kept running')
      await settings(phone)
      await phone.locator('#set-close').click()
      await shut(phone, 'Settings’ ×')
      if (await step(phone)) throw new Error('after Settings’ ×, Back lands on a closed sheet’s step')
      return 'Back and each × took their own step off; the camera stopped'
    })

    await check('without WebXR AR, the 3D hand’s Camera is not taken silently: it says what it needs, and Motion stays', async () => {
      await calm(phone)
      await settings(phone)
      // Marked unavailable, it still answers a tap (with what it needs).
      const xr = phone.locator('.track3d [data-way="xr"]')
      await xr.click({ force: true })
      await sleep(250)
      const way = await phone.evaluate(() => ({
        chosen: document.querySelector('.track3d [aria-checked="true"]')?.getAttribute('data-way') ?? '',
        off: document.querySelector('.track3d [data-way="xr"]')?.getAttribute('aria-disabled') === 'true',
        said: (document.querySelector('.track3d .way-why')?.textContent ?? '') + (document.getElementById('toast')?.textContent ?? ''),
      }))
      if (way.chosen === 'xr') throw new Error('Camera shows as chosen on a phone that can’t follow with its camera')
      if (!way.off || !/AR|Android/i.test(way.said)) throw new Error(`Camera gave no reason: ${JSON.stringify(way)}`)
      await phone.locator('#set-close').click()
      await shut(phone, 'Settings')
      return `Motion stays chosen; Camera says "${way.said.trim().slice(0, 60)}"`
    })

    const ar = await join(brokenXr)
    await check('a 3D camera start that fails ends its session and can be tried again', async () => {
      await settings(ar)
      await ar.locator('.track3d [data-way="xr"]').click()
      await until('Camera chosen', () => ar.evaluate(() => document.querySelector('.track3d [aria-checked="true"]')?.getAttribute('data-way') === 'xr'))
      await ar.locator('#set-close').click()
      await shut(ar, 'Settings')
      await ar.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
      await ar.locator('[data-tab="track"]').click()
      const start = ar.locator('#track-start')
      await start.waitFor({ timeout: 4000 })
      await start.click()
      await until('the first start failed', () => ar.evaluate(() => /didn’t start/.test(document.getElementById('toast')?.textContent ?? '')))
      await start.waitFor({ timeout: 3000 }).catch(() => { throw new Error('after a failed start, Start 3D is gone: the next tap can’t try again') })
      const ended = await ar.evaluate(() => window.__xrEnded ?? 0)
      await start.click()
      await until('a second try', () => ar.evaluate(() => window.__xrStarts >= 2), 4000)
      return `the failed session ended (${ended}); a second tap tried again`
    })
  } finally {
    await Promise.allSettled([...phones.map((c) => c.close()), screens.close()])
  }
}
