/**
 * The phone controller's rotation lock and hardware buttons, end to end: the Viewer from this checkout's build (local
 * stand-in, signaling proxied to production) and an emulated phone with a faked device orientation.
 *   - Turning the gyro on locks rotation; turning the phone to landscape then keeps the portrait controls (the virtual
 *     lock: this run forces it, as on an iPhone), and unlocking brings the landscape layout back.
 *   - Volume up and Enter switch the gyro in Rotate; in Point, volume up is A and volume down holds B.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch. OBPAL_SHOTS=<dir> saves screens.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OBPAL_SHOTS || ''
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

const local = await startLocal()
const closers = []
let dir = ''
let exitCode = 0
try {
  console.log('ob.Pal phone lock and hardware buttons e2e')
  const sb = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(sb)
  const screen = await (await sb.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage()
  await screen.goto(`${local.origin}/view/`)
  const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
  await screen.evaluate(() => { window.__btns = []; window.__obpal.on('button', (e) => window.__btns.push(`${e.id}:${e.ev}`)) })

  dir = await mkdtemp(joinPath(tmpdir(), 'obpal-phone-'))
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(ctx)
  // No native orientation lock in this run (as on an iPhone): the controller must lock by counter-rotating itself.
  await ctx.addInitScript(() => { if (screen.orientation) screen.orientation.lock = () => Promise.reject(new DOMException('not here', 'NotSupportedError')) })
  const phone = ctx.pages()[0] ?? (await ctx.newPage())
  const cdp = await ctx.newCDPSession(phone)
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  await phone.goto(invite)
  await phone.locator('.modes').waitFor({ timeout: 25000 })
  const clear = () => phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  const state = () => phone.evaluate(() => ({
    gyro: document.getElementById('gyro')?.getAttribute('aria-pressed') === 'true',
    locked: document.getElementById('lock')?.getAttribute('aria-pressed') === 'true',
    vlock: document.documentElement.classList.contains('vlock'),
    land: document.documentElement.classList.contains('land'),
    rot: getComputedStyle(document.documentElement).getPropertyValue('--ui-rot').trim(),
  }))
  const portrait = { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } }
  const landscape = { width: 915, height: 412, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } }

  await check('turning the gyro on locks rotation; the phone turning to landscape keeps the portrait controls', async () => {
    await clear()
    await phone.locator('#gyro').click()
    await until('gyro on and locked', async () => { const s = await state(); return s.gyro && s.locked })
    await cdp.send('Emulation.setDeviceMetricsOverride', landscape)
    const s = await until('counter-rotated', async () => { const v = await state(); return v.vlock ? v : null })
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
    const s = await until('unlocked', async () => { const v = await state(); return !v.locked && !v.vlock ? v : null })
    if (!s.land) throw new Error(`no landscape layout after unlocking in landscape: ${JSON.stringify({ ...s, size: await phone.evaluate(() => [innerWidth, innerHeight]) })}`)
    if (SHOTS) await phone.screenshot({ path: joinPath(SHOTS, 'phone-unlocked-landscape.png') })
    await cdp.send('Emulation.setDeviceMetricsOverride', portrait)
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

  await check('the settings sheet fits the visible screen; a swipe down, Back or its × closes it; Disconnect asks once, then says so', async () => {
    await clear()
    await cdp.send('Emulation.setDeviceMetricsOverride', portrait)
    await sleep(400)
    const open = async () => { await phone.locator('#gear').click(); await phone.locator('.sheet.settings').waitFor({ timeout: 3000 }); await sleep(350) }
    const gone = (how) => until(`${how} closed it`, () => phone.evaluate(() => !document.querySelector('.sheet.settings')), 3000)
    await open()
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
