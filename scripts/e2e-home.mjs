/**
 * The home page end to end, from this checkout's build on the local stand-in (extension/e2e/local.mjs, signaling
 * proxied to production):
 *   - On phone widths the page never scrolls sideways (nothing reaches past the screen's edge).
 *   - On a computer, the hero makes a real code once someone is there; a phone that opens it joins the page.
 *   - The phone's own ribbon follows it (here by its trackpad, as a phone without motion sensors steers).
 *   - When the phone leaves, the page lets its ribbon go.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const HEADED = process.argv.includes('--headed')
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
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
}

const local = await startLocal()
const browsers = []
let profile = ''
try {
  console.log('ob.Pal home e2e')
  const browser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  browsers.push(browser)

  await check('no sideways scroll on phone widths', async () => {
    const seen = []
    for (const name of ['iPhone SE', 'iPhone 13', 'Pixel 7', 'Galaxy S9+']) {
      const ctx = await browser.newContext({ ...devices[name], ignoreHTTPSErrors: true })
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${local.origin}/`)
      await sleep(600)
      for (const y of [0, 1400, 2800, 99999]) {
        await page.evaluate((to) => scrollTo(0, to), y)
        await sleep(150)
        const r = await page.evaluate(() => ({ w: innerWidth, s: document.documentElement.scrollWidth }))
        if (r.s > r.w || r.w > devices[name]?.viewport?.width + 1) throw new Error(`${name}: the page is ${r.s}px wide on a ${r.w}px screen`)
      }
      if (errors.length) throw new Error(`${name}: ${errors[0]}`)
      seen.push(`${name} ${devices[name].viewport.width}px`)
      await ctx.close()
    }
    return seen.join(', ')
  })

  await check('on a phone, one tap switches the tilt on: it moves the ribbon (after the opening stroke), and the scene on screen', async () => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, permissions: ['accelerometer', 'gyroscope', 'magnetometer'] })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    // Let the opening flourish finish, so the ribbon is resting where it ended.
    await sleep(9000)
    const tip = () => page.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
    const tilt = (beta, gamma) => page.evaluate(([b, g]) => dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g })), [beta, gamma])
    // Motion is the visitor's to switch on: one tap on the hint (iOS asks its own question too).
    await page.locator('[data-hint]').tap()
    await sleep(200)
    await tilt(60, 0)
    await sleep(100)
    // A steady hand (small wobbles) doesn't wake it.
    for (const g of [0.4, -0.3, 0.5, 0]) { await tilt(60, g); await sleep(60) }
    const still = await tip()
    await sleep(400)
    const after = await tip()
    if (Math.hypot(after.x - still.x, after.y - still.y) > 2) throw new Error('a steady hand kept the ribbon moving')
    // Tip it left and settle; then right and toward you: it glides over, and down.
    for (let i = 1; i <= 8; i++) { await tilt(60, -i * 2); await sleep(40) }
    await sleep(900)
    const left = await tip()
    for (let i = 1; i <= 16; i++) { await tilt(60 + i, -16 + i * 2.5); await sleep(40) }
    const moved = await until('the ribbon followed the tilt', async () => { const t = await tip(); return t.x - left.x > 60 && t.y - left.y > 20 ? t : null }, 4000)
    // Down the page, the scene on screen follows the tilt too: tipped left, the cursor goes to the far left,
    // where its own loop never takes it.
    await page.evaluate(() => document.querySelector('[data-scene="point"]').scrollIntoView({ block: 'center' }))
    await sleep(700)
    for (let i = 1; i <= 12; i++) { await tilt(76 - i * 2.5, 24 - i * 3.5); await sleep(40) }
    const dot = await until('the cursor followed the tilt', async () => { const c = await page.evaluate(() => { const d = document.querySelector('[data-scene="point"] svg circle[fill="#f4ffd6"]'); return { x: +d.getAttribute('cx'), y: +d.getAttribute('cy') } }); return c.x < 150 ? c : null }, 4000)
    await ctx.close()
    return `stick ${left.x.toFixed(0)},${left.y.toFixed(0)} → ${moved.x.toFixed(0)},${moved.y.toFixed(0)}; pointing scene's cursor at ${dot.x.toFixed(0)},${dot.y.toFixed(0)}`
  })

  await check('on a phone, a scene plays under a held finger, a flick still scrolls, and a long press selects nothing', async () => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    await page.evaluate(() => document.querySelector('[data-scene="arm"]').scrollIntoView({ block: 'center' }))
    await sleep(900)
    const cdp = await ctx.newCDPSession(page)
    const art = await page.locator('[data-scene="arm"]').boundingBox()
    const cx = art.x + art.width / 2, cy = art.y + art.height / 2
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
    const gripper = () => page.evaluate(() => { const l = document.querySelectorAll('[data-scene="arm"] svg line'); const f = [...l].find((e) => e.getAttribute('stroke-width') === '10'); return { x: +f.getAttribute('x2'), y: +f.getAttribute('y2') } })
    // Hold still a moment, then drag up and across: the scene has the finger, the page stays put.
    const y0 = await page.evaluate(() => scrollY)
    const before = await gripper()
    await touch('touchStart', cx, cy)
    await sleep(260)
    const held = await page.evaluate(() => document.querySelector('[data-scene="arm"]').closest('.scene').classList.contains('held'))
    for (let i = 1; i <= 10; i++) { await touch('touchMove', cx - i * 8, cy - i * 9); await sleep(30) }
    await sleep(150)
    const during = await gripper()
    await touch('touchEnd')
    const y1 = await page.evaluate(() => scrollY)
    if (!held) throw new Error('holding a finger on the scene did not hand it the gesture')
    if (Math.abs(y1 - y0) > 2) throw new Error(`the page scrolled ${y1 - y0}px under a held finger`)
    if (Math.hypot(during.x - before.x, during.y - before.y) < 15) throw new Error('the arm did not follow the finger')
    // A flick straight up, no hold: that's a scroll.
    await touch('touchStart', cx, cy + 40)
    for (let i = 1; i <= 6; i++) { await touch('touchMove', cx, cy + 40 - i * 30); await sleep(16) }
    await touch('touchEnd')
    await sleep(500)
    const y2 = await page.evaluate(() => scrollY)
    if (y2 - y1 < 60) throw new Error(`a flick scrolled only ${y2 - y1}px`)
    // A long press: nothing selected.
    await page.evaluate(() => document.querySelector('[data-scene="together"]').scrollIntoView({ block: 'center' }))
    await sleep(600)
    const t = await page.locator('[data-scene="together"]').boundingBox()
    await touch('touchStart', t.x + t.width / 2, t.y + t.height / 2)
    await sleep(900)
    await touch('touchEnd')
    const selected = await page.evaluate(() => getSelection().toString())
    await ctx.close()
    if (selected) throw new Error(`a long press selected "${selected.slice(0, 40)}"`)
    return `arm ${before.x.toFixed(0)},${before.y.toFixed(0)} → ${during.x.toFixed(0)},${during.y.toFixed(0)} with the page still; flick scrolled ${y2 - y1}px`
  })

  const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const screen = await screenCtx.newPage()
  const screenErrors = []
  screen.on('pageerror', (e) => screenErrors.push(e.message))
  await screen.goto(`${local.origin}/`)
  await check('with nobody steering, the light draws one smooth stroke and comes to rest on the full stop', async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
    const path = []
    const end = Date.now() + 9000
    while (Date.now() < end) { path.push(await tip()); await sleep(50) }
    // Where the headline's full stop is, as the page lays it out.
    const dot = await screen.evaluate(() => {
      const h = document.getElementById('hero-h'), r = document.querySelector('.hero').getBoundingClientRect()
      const w = document.createTreeWalker(h, NodeFilter.SHOW_TEXT)
      let last = null
      while (w.nextNode()) if (w.currentNode.data.trim()) last = w.currentNode
      const range = document.createRange()
      const n = last.data.trimEnd().length
      range.setStart(last, n - 1); range.setEnd(last, n)
      const d = range.getBoundingClientRect()
      return { x: d.left - r.left + d.width / 2, y: d.bottom - r.top - d.height * 0.27 }
    })
    const rest = path.at(-1)
    const off = Math.hypot(rest.x - dot.x, rest.y - dot.y)
    if (off > 3) throw new Error(`it rested ${off.toFixed(1)}px from the full stop`)
    // Smooth: between samples 50 ms apart it never turns sharply, and never jumps.
    let turn = 0, jump = 0
    for (let i = 2; i < path.length; i++) {
      const [a, b, c] = [path[i - 2], path[i - 1], path[i]]
      const s1 = Math.hypot(b.x - a.x, b.y - a.y), s2 = Math.hypot(c.x - b.x, c.y - b.y)
      if (s1 > 3 && s2 > 3) {
        let d = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x))
        if (d > Math.PI) d = 2 * Math.PI - d
        turn = Math.max(turn, d)
      }
      jump = Math.max(jump, s2)
    }
    if (turn > 1.2) throw new Error(`a sharp turn (${((turn * 180) / Math.PI).toFixed(0)}° in 50 ms)`)
    if (jump > 120) throw new Error(`a jump of ${jump.toFixed(0)}px in 50 ms`)
    return `rested ${off.toFixed(1)}px from the full stop; sharpest turn ${((turn * 180) / Math.PI).toFixed(0)}° per 50 ms`
  })

  let invite = ''
  await check('a computer shows a code once someone is there', async () => {
    const before = await screen.evaluate(() => !!document.querySelector('.obpal-link'))
    if (before) throw new Error('a code was made before anyone moved')
    await screen.mouse.move(300, 300)
    await screen.mouse.move(420, 260, { steps: 6 })
    invite = await until('the code', () => screen.evaluate(() => document.querySelector('.obpal-link')?.href || ''), 20000)
    return new URL(invite).pathname
  })

  const dir = await mkdtemp(join(tmpdir(), 'obpal-home-'))
  profile = dir
  const phoneCtx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
  browsers.push(phoneCtx)
  const phone = phoneCtx.pages()[0] ?? (await phoneCtx.newPage())

  await check('a phone that opens the code joins, and the hero goes live', async () => {
    await phone.goto(invite)
    await phone.locator('.modes').waitFor({ timeout: 25000 })
    await until('the phone on the page', () => screen.evaluate(() => (window.__obpal?.participants.length ?? 0) === 1), 20000)
    await until('the hero live', () => screen.evaluate(() => document.querySelector('.hero').hasAttribute('data-live')), 5000)
    const hint = await screen.locator('[data-hint-text]').textContent()
    if (!/point your phone/i.test(hint ?? '')) throw new Error(`hint says "${hint}"`)
    return hint
  })

  await check("the phone's ribbon follows it", async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id !== 'me'))
    await until('a ribbon for the phone', tip, 5000)
    const before = await tip()
    // No motion sensors here, so the phone steers with its trackpad, as a real phone without a gyro does.
    const cdp = await phoneCtx.newCDPSession(phone)
    const box = await phone.locator('#pad').boundingBox()
    const x0 = box.x + box.width / 2, y0 = box.y + box.height / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] })
    for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + i * 9, y: y0 - i * 5, id: 1 }] }); await sleep(30) }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const after = await until('the ribbon moved', async () => { const t = await tip(); return Math.hypot(t.x - before.x, t.y - before.y) > 20 ? t : null }, 5000)
    if (after.x <= before.x) throw new Error(`it went left (${before.x.toFixed(0)} → ${after.x.toFixed(0)}) for a swipe right`)
    return `stick ${before.x.toFixed(0)},${before.y.toFixed(0)} → ${after.x.toFixed(0)},${after.y.toFixed(0)}, lit ${after.life.toFixed(2)}`
  })

  await check('a phone that leaves lets its ribbon go', async () => {
    await phone.close()
    await until('nobody on the page', () => screen.evaluate(() => window.__obpal.participants.length === 0), 20000)
    await until('the hero not live', () => screen.evaluate(() => !document.querySelector('.hero').hasAttribute('data-live')), 5000)
    await until('the ribbon gone', () => screen.evaluate(() => window.__home.tips().every((t) => t.id === 'me')), 8000)
  })

  await check('no page errors on the computer', async () => { if (screenErrors.length) throw new Error(screenErrors.join(' | ')) })
} finally {
  for (const b of browsers.reverse()) await b.close().catch(() => {})
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {})
  await local.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
