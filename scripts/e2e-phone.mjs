/**
 * The phone controller's rotation lock and hardware buttons, end to end: the Viewer from this checkout's build (local
 * stand-in, signaling through this checkout's own worker) and an emulated phone with a faked device orientation.
 *   - Turning the gyro on locks rotation; turning the phone to landscape then keeps the portrait controls (the virtual
 *     lock: this run forces it, as on an iPhone), and unlocking brings the landscape layout back.
 *   - Volume up and Enter switch the gyro in Rotate; in Point, volume up is A and volume down holds B.
 *   - Physical buttons with no setup (a fresh session): a presentation clicker's Page Down and Page Up press + and − on
 *     the Wii remote, and a pad with the standard mapping presses A and, with its D-pad, +; the phone says what it found.
 *     A key nothing uses, from a keyboard it knows, is offered a one-tap bind.
 *   - The Buttons sheet: tap B, press Enter, and Enter presses B on the screen (with a badge on B); it says plainly that
 *     a phone's volume and side keys can't reach a browser page; Reset brings Enter back to A.
 *   - The buttons diagnostic (/buttons/, no screen needed): every key is logged, the volume keys are held, and the
 *     page asks whether the volume moved and sums it all up in one line.
 *   - The controller bar and catalogue (./phone-controllers.mjs): ratings for the Viewer and a sim, switching in one
 *     tap, and the layout rules (the edge and the touch size) at three phone sizes, the node strip's at 360 px too.
 *   - The camera in settings (./phone-camera.mjs): the scanner first, one tap away, its camera started inside the tap
 *     and no dead Back step left behind; the 3D hand's camera says what it needs, and a failed start can be retried.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch. OBPAL_SHOTS=<dir> saves screens.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, devices } from 'playwright'
import { checkFrost, setSurface } from './lib/frost.mjs'
import { cspCheck } from './csp-watch.mjs'
import { startLocal } from '../extension/e2e/local.mjs'
import { phoneConnections } from './phone-connections.mjs'
import { phoneControllers } from './phone-controllers.mjs'
import { phoneCamera } from './phone-camera.mjs'

const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OBPAL_SHOTS || ''
const OBPAL_SHOTS_DIR = SHOTS
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 10000, every = 100) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}
const results = []
async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ ok: true })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ ok: false })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
}

// OBPAL_E2E_PORT runs the stand-in elsewhere than its usual 5176, beside another run.
const local = await startLocal({ port: Number(process.env.OBPAL_E2E_PORT) || undefined })
const closers = []
let dir = ''
let exitCode = 0
try {
  console.log('ob.Pal phone lock and hardware buttons e2e')
  const sb = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(sb)

  await check('the buttons diagnostic logs each key, holds the volume keys, asks whether the volume moved, and sums it up', async () => {
    const bctx = await sb.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    try {
      const page = await bctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${local.origin}/buttons/`)
      await page.locator('#sum').waitFor()
      for (const key of ['Enter', 'AudioVolumeUp', 'PageDown', 'AudioVolumeDown']) await page.keyboard.press(key)
      const r = await page.evaluate(() => ({
        sum: document.getElementById('sum').textContent,
        asked: !document.getElementById('ask').hidden,
        last: document.getElementById('last').textContent,
        row: document.querySelector('#log li span')?.textContent ?? '',
      }))
      if (!r.sum.includes('| keys Enter PgDn |') || !r.sum.includes('| volume Vol+ Vol−, holding')) throw new Error(`summary: ${r.sum}`)
      if (!r.asked) throw new Error('it didn’t ask whether the volume moved')
      if (r.last !== 'Vol−' || !r.row.includes('prevented')) throw new Error(`last ${r.last}: ${r.row}`)
      await page.setViewportSize({ width: 320, height: 640 })
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      if (over > 0) throw new Error(`${over}px wider than a 320px screen`)
      if (errors.length) throw new Error(errors[0])
      return r.sum
    } finally {
      await bctx.close()
    }
  })
  const screen = await (await sb.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage()
  await screen.goto(`${local.origin}/view/`)
  const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
  await screen.evaluate(() => { window.__btns = []; window.__obpal.on('button', (e) => window.__btns.push(`${e.id}:${e.ev}`)) })

  dir = await mkdtemp(joinPath(tmpdir(), 'obpal-phone-'))
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(ctx)
  // No native orientation lock in this run (as on an iPhone): the controller must lock by counter-rotating itself.
  await ctx.addInitScript(() => {
    if (screen.orientation) screen.orientation.lock = () => Promise.reject(new DOMException('not here', 'NotSupportedError'))
  })
  const phone = ctx.pages()[0] ?? (await ctx.newPage())
  const cdp = await ctx.newCDPSession(phone)
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  await phone.goto(invite)
  await phone.locator('.modes').waitFor({ timeout: 25000 })
  const clear = () => phone.evaluate(() => document.querySelectorAll('.hint, .bt-notice').forEach((h) => h.remove()))
  const state = () => phone.evaluate(() => ({
    gyro: document.getElementById('gyro')?.getAttribute('aria-pressed') === 'true',
    locked: document.getElementById('lock')?.getAttribute('aria-pressed') === 'true',
    vlock: document.documentElement.classList.contains('vlock'),
    land: document.documentElement.classList.contains('land'),
    rot: getComputedStyle(document.documentElement).getPropertyValue('--ui-rot').trim(),
  }))
  const portrait = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } }
  const landscape = { width: 915, height: 412, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }
  // Screenshots and fullscreen restore Playwright's viewport; keep it in agreement with CDP.
  const metrics = async (m) => {
    await phone.setViewportSize({ width: m.width, height: m.height })
    await cdp.send('Emulation.setDeviceMetricsOverride', m)
  }

  await check('turning the gyro on locks rotation; the phone turning to landscape keeps the portrait controls', async () => {
    await clear()
    await phone.locator('#gyro').click()
    await until('gyro on and locked', async () => { const s = await state(); return s.gyro && s.locked })
    await metrics(landscape)
    const s = await until('counter-rotated portrait layout', async () => { const v = await state(); return v.vlock && !v.land ? v : null })
    if (s.land) throw new Error('the landscape layout took over while locked')
    if (s.rot !== '270deg' && s.rot !== '-90deg') throw new Error(`rotated ${s.rot}`)
    // The controls still fill the (turned) screen: the body is the portrait size.
    const box = await phone.evaluate(() => { const r = document.body.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)] })
    if (SHOTS) await phone.screenshot({ path: joinPath(SHOTS, 'phone-locked-landscape.png') })
    return `UI turned ${s.rot}, body ${box.join('×')} in a 915×412 screen`
  })

  await check('unlocking lets the layout follow the screen again', async () => {
    await clear()
    await phone.locator('#lock').click()
    await metrics(landscape)
    const s = await until('unlocked in landscape', async () => { const v = await state(); return !v.locked && !v.vlock && v.land ? v : null })
    if (!s.land) throw new Error(`no landscape layout after unlocking in landscape: ${JSON.stringify({ ...s, size: await phone.evaluate(() => [innerWidth, innerHeight]) })}`)
    if (SHOTS) await phone.screenshot({ path: joinPath(SHOTS, 'phone-unlocked-landscape.png') })
    await metrics(portrait)
    await until('portrait again', async () => !(await state()).land)
    return 'landscape layout while unlocked'
  })

  await check('volume up and Enter switch the gyro in Rotate', async () => {
    const g0 = (await state()).gyro
    await phone.keyboard.press('AudioVolumeUp')
    await until('gyro switched', async () => (await state()).gyro !== g0, 3000)
    await phone.keyboard.press('Enter')
    await until('gyro switched back', async () => (await state()).gyro === g0, 3000)
    const toast = await phone.evaluate(() => document.getElementById('toast')?.textContent ?? '')
    return `told "${toast}"`
  })

  await check('in Point, volume up is A and volume down holds B', async () => {
    await clear()
    await phone.locator('.modes [data-tab=point]').click()
    await sleep(400)
    await screen.evaluate(() => { window.__btns.length = 0 })
    await phone.keyboard.press('AudioVolumeUp')
    await phone.keyboard.down('AudioVolumeDown')
    await sleep(300)
    await phone.keyboard.up('AudioVolumeDown')
    const btns = await until('buttons at the screen', async () => { const b = await screen.evaluate(() => window.__btns); return b.includes('wii-b:up') ? b : null }, 5000)
    for (const want of ['wii-a:tap', 'wii-b:down', 'wii-b:up']) if (!btns.includes(want)) throw new Error(`screen saw ${JSON.stringify(btns)}`)
    return btns.join(', ')
  })

  /** The screen's button events since the last call. */
  const screenBtns = async (want, timeout = 5000) => until(`${want} at the screen`, async () => { const b = await screen.evaluate(() => window.__btns); return b.includes(want) ? b : null }, timeout)
  const resetBtns = () => screen.evaluate(() => { window.__btns.length = 0 })
  const notice = () => phone.evaluate(() => document.querySelector('.bt-notice')?.textContent?.replace(/\s+/g, ' ').trim() ?? '')

  await check('with no setup, a presentation clicker’s Page Down and Page Up press + and − on the Wii remote, and the phone says it found a clicker', async () => {
    // A fresh session (the page reloads and reconnects): nothing seen from any source yet.
    await phone.reload()
    await phone.locator('.modes').waitFor({ timeout: 25000 })
    await clear()
    await phone.locator('.modes [data-tab=point]').click()
    await sleep(400)
    await resetBtns()
    await phone.keyboard.press('PageDown')
    const said = await until('the clicker notice', async () => { const n = await notice(); return /Clicker found/.test(n) ? n : null }, 3000)
    await phone.keyboard.press('PageUp')
    const btns = await screenBtns('wii-minus:tap')
    if (!btns.includes('wii-plus:tap')) throw new Error(`screen saw ${JSON.stringify(btns)}`)
    return `${said} · screen saw ${btns.join(', ')}`
  })

  await check('with no setup, a pad with the standard mapping presses A, and its D-pad’s right presses +; the phone says it found the pad', async () => {
    await clear()
    await resetBtns()
    await phone.evaluate(() => {
      const mk = (pressed) => ({
        id: 'Test Pad (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, mapping: 'standard', connected: true, timestamp: performance.now(),
        axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: pressed.includes(i), value: pressed.includes(i) ? 1 : 0 })),
      })
      window.__pad = mk([])
      navigator.getGamepads = () => [window.__pad, null, null, null]
      window.__press = (list) => { window.__pad = mk(list) }
      const e = new Event('gamepadconnected')
      Object.defineProperty(e, 'gamepad', { value: window.__pad })
      dispatchEvent(e)
    })
    const tap = async (i) => { await phone.evaluate((b) => window.__press([b]), i); await sleep(120); await phone.evaluate(() => window.__press([])); await sleep(120) }
    await tap(0)
    const said = await until('the pad notice', async () => { const n = await notice(); return /Test Pad found/.test(n) ? n : null }, 3000)
    await tap(15)
    const btns = await screenBtns('wii-plus:tap')
    for (const want of ['wii-a:down', 'wii-a:tap', 'wii-a:up']) if (!btns.includes(want)) throw new Error(`screen saw ${JSON.stringify(btns)}`)
    return `${said} · screen saw ${btns.join(', ')}`
  })

  await check('a key nothing uses, from a keyboard the phone knows, is offered a one-tap bind that works at once', async () => {
    await clear()
    await resetBtns()
    await phone.keyboard.press('KeyQ') // after Page Down and Page Up: a keyboard now, and Q presses nothing
    await phone.keyboard.press('KeyW')
    await phone.locator('.bt-notice .bt-n-pick[data-target="b"]').click({ timeout: 3000 })
    await phone.keyboard.down('KeyW')
    await sleep(200)
    await phone.keyboard.up('KeyW')
    const btns = await screenBtns('wii-b:up')
    if (!btns.includes('wii-b:down')) throw new Error(`screen saw ${JSON.stringify(btns)}`)
    return `W = B · screen saw ${btns.join(', ')}`
  })

  await check('the Buttons sheet: tap B, press Enter, and Enter presses B, with a badge; it says the phone’s own volume and side keys can’t reach a page; Reset brings A back', async () => {
    await clear()
    await phone.locator('#gear').click()
    await phone.locator('#buttons-open').click()
    const sheet = phone.locator('.sheet.btns')
    await sheet.waitFor({ timeout: 3000 })
    const text = (await sheet.textContent()) ?? ''
    if (!text.includes('A phone’s volume and side keys can’t reach any browser page')) throw new Error('no plain word on the volume keys')
    if ((await sheet.locator('a[href="/buttons/"]').count()) !== 1) throw new Error('no Test your buttons link')
    if (OBPAL_SHOTS_DIR) await phone.screenshot({ path: joinPath(OBPAL_SHOTS_DIR, 'phone-buttons-sheet.png') })
    await sheet.locator('.bt-c[data-target="b"]').click()
    await phone.keyboard.press('Enter')
    const line = await until('Enter → B', async () => { const l = (await sheet.locator('.bt-line').textContent()) ?? ''; return /Enter → B/.test(l) ? l : null }, 3000)
    const chip = (await sheet.locator('.bt-c[data-target="b"] .bt-bs').textContent()) ?? ''
    if (!chip.includes('Enter')) throw new Error(`B's chip shows "${chip}"`)
    await sheet.locator('[data-act="done"]').click()
    await until('the sheet closed', () => phone.evaluate(() => !document.querySelector('.sheet.btns')), 3000)
    await resetBtns()
    await phone.keyboard.press('Enter')
    const btns = await screenBtns('wii-b:up')
    if (btns.includes('wii-a:tap')) throw new Error(`Enter still pressed A: ${JSON.stringify(btns)}`)
    const badge = await phone.evaluate(() => document.querySelector('#wii-b .hw-badges')?.textContent ?? '')
    if (!badge.includes('Enter')) throw new Error(`B's badge: "${badge}"`)
    await phone.locator('#gear').click()
    await phone.locator('#buttons-open').click()
    await sheet.waitFor({ timeout: 3000 })
    await sheet.locator('[data-act="reset"]').click()
    await sheet.locator('[data-act="reset"]').click()
    await sheet.locator('[data-act="done"]').click()
    await until('the sheet closed', () => phone.evaluate(() => !document.querySelector('.sheet.btns')), 3000)
    await resetBtns()
    await phone.keyboard.press('Enter')
    await screenBtns('wii-a:tap')
    return `${line.trim()} · badge "${badge}" · Reset: Enter is A again`
  })

  await check('the settings sheet fits the visible screen; a swipe down, Back or its × closes it; Disconnect asks once, then says so', async () => {
    await clear()
    await cdp.send('Emulation.setDeviceMetricsOverride', portrait)
    await sleep(400)
    const open = async () => { await phone.locator('#gear').click(); await phone.locator('.sheet.settings').waitFor({ timeout: 3000 }); await sleep(350) }
    const gone = (how) => until(`${how} closed it`, () => phone.evaluate(() => !document.querySelector('.sheet.settings')), 3000)
    await open()
    const theme = await phone.evaluate(() => document.documentElement.dataset.bbTheme)
    for (const surface of ['carbon', 'light']) {
      await setSurface(phone, surface)
      await checkFrost(phone, '.bar')
      await checkFrost(phone, '.sheet.settings', { text: ['.sheet-k', '.meta', 'label', 'output'] })
      await checkFrost(phone, '.sheet-head', { solid: true })
      await checkFrost(phone, '.sheet .actions', { solid: true })
    }
    await setSurface(phone, theme || 'carbon')
    // Its answer buttons are on the visible screen, however long the sheet.
    const fit = await phone.evaluate(() => ({ bottom: document.getElementById('done').getBoundingClientRect().bottom, vh: innerHeight }))
    if (fit.bottom > fit.vh) throw new Error(`Done is at ${fit.bottom.toFixed(0)}px of a ${fit.vh}px screen`)
    const g = await phone.locator('.sheet.settings .grip').boundingBox()
    const x = g.x + g.width / 2, y = g.y + g.height / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + i * 20, id: 1 }] }); await sleep(16) }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await gone('a swipe down')
    await open()
    await phone.goBack()
    await gone('Back')
    if (!(await phone.locator('.modes').isVisible())) throw new Error('Back left the controller')
    await open()
    await phone.locator('#set-close').click()
    await gone('the ×')
    await open()
    await phone.locator('#disc').click()
    const asked = (await phone.locator('#disc').textContent()) ?? ''
    if (!/again/i.test(asked)) throw new Error(`the first tap said "${asked}"`)
    await phone.locator('#disc').click()
    await sleep(1500)
    const left = await phone.evaluate(() => ({ title: document.querySelector('.msg h1')?.textContent ?? '', back: !!document.getElementById('act') }))
    if (left.title !== 'Disconnected' || !left.back) throw new Error(`after disconnecting: ${JSON.stringify(left)}`)
    return `Done at ${fit.bottom.toFixed(0)} of ${fit.vh}px; swipe, Back and × close it; Disconnect asks, then says so`
  })
  await phoneConnections({ browser: sb, origin: local.origin, check, shots: SHOTS })
  await phoneCamera({ browser: sb, origin: local.origin, check, shots: SHOTS })
  await phoneControllers({ browser: sb, origin: local.origin, check, shots: SHOTS })
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await Promise.allSettled(closers.map((c) => c.close()))
  await local.close()
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)
