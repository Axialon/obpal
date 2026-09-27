/**
 * The home page end to end, from this checkout's build on the local stand-in (extension/e2e/local.mjs, signaling
 * proxied to production):
 *   - On phone widths the page never scrolls sideways (nothing reaches past the screen's edge).
 *   - On a computer, the hero makes a real code once someone is there; a phone that opens it joins the page.
 *   - The phone's own marble follows it (here by its trackpad, as a phone without motion sensors steers).
 *   - A click hops the marble onto the letter clicked, where it stays; the phone flicked upward (or its A) tosses its
 *     marble, and on a phone, a flick tosses the page's own marble once motion is on.
 *   - When the phone leaves, the page lets its marble go.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const HEADED = process.argv.includes('--headed')
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
// Software WebGL for the hero's 3D field in headless runs.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
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
/** The lime marble is resting on the headline's full stop (the 3D field is up, the opening is over). */
async function restingOnDot(page) {
  const a = await page.evaluate(() => ({ t: window.__home.tips().find((t) => t.id === 'me'), d: window.__home.dot() }))
  await sleep(250)
  const b = await page.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
  if (!a.t || !a.d || !b) return false
  return Math.hypot(b.x - a.t.x, b.y - a.t.y) < 0.5 && Math.hypot(b.x - a.d.x, b.y - a.d.y) < 6
}
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

  await check('on wide screens the hero spans the page and the headline fits (the built CSS, whatever order it loads in)', async () => {
    const seen = []
    for (const [w, h] of [[1920, 1080], [1440, 900], [1280, 800]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, ignoreHTTPSErrors: true })
      const page = await ctx.newPage()
      await page.goto(`${local.origin}/`)
      await sleep(500)
      const r = await page.evaluate(() => {
        const hero = document.querySelector('.hero').getBoundingClientRect()
        const h1 = document.getElementById('hero-h')
        return { hero: hero.width, vw: document.documentElement.clientWidth, over: h1.scrollWidth > h1.clientWidth + 1, font: parseFloat(getComputedStyle(h1).fontSize) }
      })
      if (Math.abs(r.hero - r.vw) > 2) throw new Error(`${w}px: the hero is ${r.hero.toFixed(0)}px wide`)
      if (r.over) throw new Error(`${w}px: the headline overflows its box`)
      seen.push(`${w}px (${r.font.toFixed(0)}px type)`)
      await ctx.close()
    }
    return seen.join(', ')
  })

  await check('on a phone, one tap switches the tilt on: it rolls the marble like a tray (after the opening), and moves the scene on screen', async () => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, permissions: ['accelerometer', 'gyroscope', 'magnetometer'] })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    const tip = () => page.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
    // Let the opening finish, so the marble is resting on the full stop.
    await until('the marble at rest after the opening', () => restingOnDot(page), 25000, 300)
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
    if (Math.hypot(after.x - still.x, after.y - still.y) > 2) throw new Error('a steady hand kept the marble moving')
    // Tip it left and settle; then right and toward you: it glides over, and down.
    for (let i = 1; i <= 8; i++) { await tilt(60, -i * 2); await sleep(40) }
    await sleep(900)
    const left = await tip()
    for (let i = 1; i <= 16; i++) { await tilt(60 + i, -16 + i * 2.5); await sleep(40) }
    const moved = await until('the marble rolled with the tilt', async () => { const t = await tip(); return t.x - left.x > 60 && t.y - left.y > 20 ? t : null }, 4000)
    // Flicked upward, screen level: the marble jumps (it never bounces by itself).
    const flick = await page.evaluate(async () => {
      const top = () => window.__home.tips().find((t) => t.id === 'me').h
      const at = (a) => dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: a }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + a }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }))
      const wait = () => new Promise((r) => setTimeout(r, 16))
      let peak = 0
      for (const [a, n] of [[0, 6], [15, 5], [-15, 5], [0, 40]]) for (let i = 0; i < n; i++) { at(a); await wait(); peak = Math.max(peak, top()) }
      return peak
    })
    if (!(flick > 0.3)) throw new Error(`a flick upward tossed the marble only ${flick.toFixed(2)} em up`)
    // Down the page, the scene on screen follows the tilt too: tipped left, the cursor goes to the far left,
    // where its own loop never takes it.
    await page.evaluate(() => document.querySelector('[data-scene="point"]').scrollIntoView({ block: 'center' }))
    await sleep(700)
    for (let i = 1; i <= 12; i++) { await tilt(76 - i * 2.5, 24 - i * 3.5); await sleep(40) }
    const dot = await until('the cursor followed the tilt', async () => { const c = await page.evaluate(() => { const d = document.querySelector('[data-scene="point"] svg circle[fill="#f4ffd6"]'); return { x: +d.getAttribute('cx'), y: +d.getAttribute('cy') } }); return c.x < 150 ? c : null }, 4000)
    await ctx.close()
    return `stick ${left.x.toFixed(0)},${left.y.toFixed(0)} → ${moved.x.toFixed(0)},${moved.y.toFixed(0)}; a flick tossed it ${flick.toFixed(2)} em up; pointing scene's cursor at ${dot.x.toFixed(0)},${dot.y.toFixed(0)}`
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
  await check('with nobody steering, the marble drops in, hops along the headline and comes to rest on the full stop', async () => {
    await until('the 3D field', () => screen.evaluate(() => document.documentElement.classList.contains('field3d')), 15000)
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
    const path = []
    const end = Date.now() + 25000
    while (Date.now() < end) {
      path.push(await tip())
      if (path.length > 20 && (await restingOnDot(screen))) break
      await sleep(80)
    }
    const dot = await screen.evaluate(() => window.__home.dot())
    const rest = path.at(-1)
    const off = Math.hypot(rest.x - dot.x, rest.y - dot.y)
    if (off > 4) throw new Error(`it rested ${off.toFixed(1)}px from the full stop`)
    // Along the headline: it crossed most of its width on the way.
    const xs = path.map((p) => p.x)
    const span = Math.max(...xs) - Math.min(...xs)
    const box = await screen.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('hero-h')); const b = r.getBoundingClientRect(); return b.width })
    if (span < box * 0.45) throw new Error(`it only travelled ${span.toFixed(0)}px of a ${box.toFixed(0)}px headline`)
    return `rested ${off.toFixed(1)}px from the full stop, after hopping across ${span.toFixed(0)}px`
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

  await check('a click hops the marble onto the letter clicked, and it stays there while the mouse does', async () => {
    const letters = await screen.evaluate(() => { const r = document.createRange(); const h = document.getElementById('hero-h'); r.selectNodeContents(h); const b = r.getClientRects()[0]; return { x: b.left, y: b.top, w: b.width, h: b.height } })
    // The middle of "phone" (the first line's second word), about halfway up its letters.
    const x = letters.x + letters.w * 0.58, y = letters.y + letters.h * 0.55
    await screen.mouse.move(x, y)
    await screen.mouse.down()
    await screen.mouse.up()
    const on = await until('the marble resting on a letter', async () => { const t = await screen.evaluate(() => window.__home.tips().find((q) => q.id === 'me')); return t.on >= 0 ? t : null }, 8000)
    await sleep(800)
    const later = await screen.evaluate(() => window.__home.tips().find((q) => q.id === 'me'))
    if (later.on !== on.on) throw new Error(`it rolled off letter ${on.on} onto ${later.on}`)
    if (Math.hypot(later.x - x, later.y - y) > 80) throw new Error(`it landed ${Math.hypot(later.x - x, later.y - y).toFixed(0)}px from the click`)
    return `on letter ${on.on}, ${Math.hypot(later.x - x, later.y - y).toFixed(0)}px from the click`
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
    // Playing with a phone brings the sound button (sound itself waits for a click on the page).
    await until('the sound button', () => screen.evaluate(() => !document.querySelector('[data-sound]').hidden), 5000)
    return hint
  })

  await check("the phone's marble follows it", async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id !== 'me'))
    await until('a marble for the phone', tip, 5000)
    const before = await tip()
    // No motion sensors here, so the phone steers with its trackpad, as a real phone without a gyro does.
    const cdp = await phoneCtx.newCDPSession(phone)
    const box = await phone.locator('#pad').boundingBox()
    const x0 = box.x + box.width / 2, y0 = box.y + box.height / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, id: 1 }] })
    for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + i * 9, y: y0 - i * 5, id: 1 }] }); await sleep(30) }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const after = await until('the marble moved', async () => { const t = await tip(); return Math.hypot(t.x - before.x, t.y - before.y) > 20 ? t : null }, 5000)
    if (after.x <= before.x) throw new Error(`it went left (${before.x.toFixed(0)} → ${after.x.toFixed(0)}) for a swipe right`)
    return `stick ${before.x.toFixed(0)},${before.y.toFixed(0)} → ${after.x.toFixed(0)},${after.y.toFixed(0)}, lit ${after.life.toFixed(2)}`
  })

  await check("the phone flicked upward tosses its marble, and so does its A", async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id !== 'me'))
    const high = async (what, go) => {
      await until(`${what}: the marble settled`, async () => (await tip()).h < 0.25, 8000)
      await go()
      return until(what, async () => { const t = await tip(); return t.h > 0.3 ? t.h : null }, 5000)
    }
    // A phone lying flat that jerks upward and stops: the controller sees a toss and sends it.
    const flick = await high('the flick tossed it', () => phone.evaluate(async () => {
      dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: 0 }))
      const at = (a) => dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: a }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + a }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }))
      const wait = () => new Promise((r) => setTimeout(r, 16))
      for (const [a, n] of [[0, 8], [15, 5], [-15, 5], [0, 10]]) for (let i = 0; i < n; i++) { at(a); await wait() }
    }))
    const a = await high('A tossed it', async () => {
      const cdp = await phoneCtx.newCDPSession(phone)
      const b = await phone.locator('#wii-a').boundingBox()
      const p = { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] })
      await sleep(60)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    })
    return `flick ${flick.toFixed(2)} em up, A ${a.toFixed(2)} em up`
  })

  await check('a phone that leaves lets its marble go', async () => {
    await phone.close()
    await until('nobody on the page', () => screen.evaluate(() => window.__obpal.participants.length === 0), 20000)
    await until('the hero not live', () => screen.evaluate(() => !document.querySelector('.hero').hasAttribute('data-live')), 5000)
    await until('the marble gone', () => screen.evaluate(() => window.__home.tips().every((t) => t.id === 'me')), 8000)
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
