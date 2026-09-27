/**
 * The home page end to end, from this checkout's build on the local stand-in (extension/e2e/local.mjs, signaling
 * proxied to production):
 *   - On phone widths the page never scrolls sideways (nothing reaches past the screen's edge).
 *   - On a computer, the hero makes a real code once someone is there; a phone that opens it joins the page.
 *   - The phone's own marble follows it (here by its trackpad, as a phone without motion sensors steers).
 *   - A click hops the marble onto the letter clicked, where it stays; the phone flicked upward (or a tap on its
 *     trackpad) tosses its marble, and on a phone, a flick tosses the page's own marble once motion is on.
 *   - A phone held as a tray (its gyro on) rolls its marble with its tilt, as the phone's own page does.
 *   - When the phone leaves, the page lets its marble go.
 *   - Sound waits for the first click (Chrome's own rule, read without a user gesture: Playwright's evaluate runs as
 *     one and would let it start), then the marble's landing reaches the output (a meter at the end of the chain).
 *   - The marble rolls up onto a button in the hero, lights and presses it, and rolls off it again; the button never
 *     does its own thing.
 *   - Pressed into each edge of what's on screen (tilted on phones, pointed at on computers), the marble's outline as
 *     drawn meets the edge within a pixel, and its rim is there in the screenshot.
 *   - A knock against the edge of the screen is heard; leaning on it is quiet.
 *   - On a phone, tilted up from below the buttons, the marble rolls up onto them, across and off.
 *   - A marble in a letter's counter rests there without a tremor, and leaves when pointed away.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import sharp from 'sharp'
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
const field3d = (page) => until('the 3D field', () => page.evaluate(() => document.documentElement.classList.contains('field3d')), 20000)
const me = (page) => page.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
/** Drive the marble (a tilt, a pointer) until it stops: still within 0.3 px over four looks. */
async function settle(page, drive, timeout = 10000) {
  let prev = null, same = 0
  const end = Date.now() + timeout
  while (Date.now() < end) {
    await drive()
    const t = await me(page)
    if (prev && Math.hypot(t.x - prev.x, t.y - prev.y) < 0.3) { if (++same >= 4) return t } else same = 0
    prev = t
    await sleep(110)
  }
  return me(page)
}
/**
 * A phone's tilt, as seen on its screen: tip(down, right) in degrees from how it was held when the tilt went on. Each
 * reading wobbles a little, so every one is a real change and the tilt stays awake; held sideways, the phone's own
 * axes are turned.
 */
function tilter(page) {
  let angle = 0, k = 0
  const send = (b, g) => page.evaluate(([b, g]) => dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g })), [b, g])
  return {
    async on() { angle = await page.evaluate(() => screen.orientation?.angle ?? 0); await send(40, 0) },
    tip(down, right) {
      k++
      const w = (k % 2) * 4
      const d = right ? down : down + Math.sign(down) * w, r = right ? right + Math.sign(right) * w : right
      return angle === 90 ? send(40 + r, -d) : send(40 + d, r)
    },
  }
}
/**
 * The brightest pixel (luminance 0…255) in the outermost 2 px inside an edge of the play area `a` (hero px), within
 * 14 px of `at` along it: the marble's rim, if it's there; the night sky, if it isn't.
 */
async function rimAt(page, wall, at, a) {
  const top = await page.evaluate(() => document.querySelector('.hero').getBoundingClientRect().top)
  const clip = wall === 'left' ? { x: a.left, y: top + at - 14, width: 2, height: 28 }
    : wall === 'right' ? { x: a.right - 2, y: top + at - 14, width: 2, height: 28 }
    : wall === 'top' ? { x: at - 14, y: top + a.top, width: 28, height: 2 }
    : { x: at - 14, y: top + a.bottom - 2, width: 28, height: 2 }
  const { data, info } = await sharp(await page.screenshot({ clip })).raw().toBuffer({ resolveWithObject: true })
  let best = 0
  for (let i = 0; i < data.length; i += info.channels) best = Math.max(best, 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
  return best
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

// OBPAL_E2E_PORT runs the stand-in elsewhere than its usual 5176, beside another run.
const local = await startLocal({ port: Number(process.env.OBPAL_E2E_PORT) || undefined })
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

  await check('sound waits for the first click (the browser\'s rule), then the marble\'s landing reaches the output', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    // Read over CDP without a user gesture: Playwright's evaluate runs as one, and would let sound start by itself.
    const cdp = await ctx.newCDPSession(page)
    const read = async (expression) => (await cdp.send('Runtime.evaluate', { expression, userGesture: false, returnByValue: true, awaitPromise: true })).result.value
    await page.goto(`${local.origin}/?debug=audio`)
    await until('the 3D field', () => read(`document.documentElement.classList.contains('field3d')`), 15000)
    // (Silence is -Infinity dBFS, which JSON can't carry: read as -999.)
    const audio = () => read(`(() => { const a = window.__home.audio(); const b = document.querySelector('[data-sound]'); return { ...a, peakDb: Number.isFinite(a.peakDb) ? a.peakDb : -999, pill: b.hidden ? 'hidden' : b.dataset.state, label: b.textContent.trim() } })()`)
    // The opening's landings come before anyone has clicked: not heard, and the sound button says it waits for a click.
    const before = await until('a landing before any click', async () => { const a = await audio(); return a.skipped > 0 ? a : null }, 25000, 200)
    if (before.state !== 'blocked' || before.played !== 0 || before.pill !== 'blocked') throw new Error(`before a click: ${JSON.stringify(before)}`)
    // A click on the headline hops the marble onto a letter: its landing is heard.
    const r = await read(`(() => { const g = document.createRange(); g.selectNodeContents(document.getElementById('hero-h')); const b = g.getClientRects()[0]; return { x: b.left + b.width * 0.3, y: b.top + b.height * 0.55 } })()`)
    await page.mouse.click(r.x, r.y)
    const after = await until('sound at the output', async () => { const a = await audio(); return a.played > 0 && a.peakDb > -40 ? a : null }, 10000, 100)
    if (after.state !== 'on' || after.pill !== 'on') throw new Error(`after a click: ${JSON.stringify(after)}`)
    await ctx.close()
    return `before: "${before.label}", ${before.skipped} landing(s) not heard; after one click: ${after.played} heard, peak ${after.peakDb} dBFS at the output`
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
    // Tip it left and settle; then right and toward you: it glides over, and down. (Over as far as the screen's edge,
    // which it doesn't roll past: from the full stop that's under 60px.)
    for (let i = 1; i <= 8; i++) { await tilt(60, -i * 2); await sleep(40) }
    await sleep(900)
    const left = await tip()
    for (let i = 1; i <= 16; i++) { await tilt(60 + i, -16 + i * 2.5); await sleep(40) }
    const width = await page.evaluate(() => innerWidth)
    const moved = await until('the marble rolled with the tilt', async () => { const t = await tip(); return t.x - left.x > 30 && t.y - left.y > 20 ? t : null }, 4000)
    if (moved.x > width) throw new Error(`the marble rolled off the screen: x ${moved.x.toFixed(0)} on a ${width}px screen`)
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

  await check("pressed into each edge of what's on screen, the marble's outline meets it (within a pixel), on phones and computers", async () => {
    const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
    const sizes = [
      { name: '390x844', viewport: { width: 390, height: 844 }, ...PHONE },
      { name: '360x800', viewport: { width: 360, height: 800 }, ...PHONE },
      { name: '412x915', viewport: { width: 412, height: 915 }, ...PHONE },
      { name: '844x390 sideways', viewport: { width: 844, height: 390 }, ...PHONE },
      { name: '1366x768', viewport: { width: 1366, height: 768 } },
      { name: '1920x1080', viewport: { width: 1920, height: 1080 } },
    ]
    const seen = []
    for (const { name, ...size } of sizes) {
      const ctx = await browser.newContext({ ...size, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await page.goto(`${local.origin}/?quality=low`)
      await field3d(page)
      await sleep(600)
      const worst = { gap: 0, wall: '' }
      const measure = async (wall) => {
        const o = await page.evaluate(() => window.__home.outline('me'))
        const a = o.area
        const off = { left: o.left - a.left, right: a.right - o.right, top: o.top - a.top, bottom: a.bottom - o.bottom }[wall]
        if (Math.abs(off) > 1) throw new Error(`${name}, ${wall}: the outline is ${off.toFixed(2)} px ${off > 0 ? 'short of' : 'past'} the edge (${JSON.stringify(o)})`)
        if (Math.abs(off) >= Math.abs(worst.gap)) Object.assign(worst, { gap: off, wall })
        // And it's drawn there: its rim is in the outermost 2 px of the screenshot, next to where it touches.
        const t = await me(page)
        const rim = await rimAt(page, wall, wall === 'left' || wall === 'right' ? t.y : t.x, a)
        if (rim < 110) throw new Error(`${name}, ${wall}: no rim at the edge in the screenshot (brightest ${rim.toFixed(0)})`)
      }
      if (size.hasTouch) {
        const tilt = tilter(page)
        await page.locator('[data-hint]').tap()
        // (Tapping the hint may have scrolled it into view: the page back at its top.)
        await page.evaluate(() => scrollTo(0, 0))
        await tilt.on()
        await sleep(250)
        // Hopped onto open floor (a tap there), then tipped into each side and toward you.
        const open = await page.evaluate(() => { const q = document.querySelector('.quick li')?.getBoundingClientRect(); return q && q.bottom < innerHeight - 30 ? { x: q.right + 40, y: q.top + q.height / 2 } : { x: innerWidth * 0.78, y: innerHeight * 0.6 } })
        await page.touchscreen.tap(open.x, open.y)
        await sleep(1400)
        // (Sideways, a little toward you too: along the bottom, clear of the headline.)
        for (const [wall, down, right] of [['left', 6, -16], ['right', 6, 16], ['bottom', 14, 0]]) {
          await settle(page, () => tilt.tip(down, right))
          await measure(wall)
          await tilt.tip(0, 0)
        }
        // The top: onto the headline's first letter, a short hop to the line above it, and tipped away from you.
        const first = await page.evaluate(() => { const r = document.createRange(); const h = document.getElementById('hero-h'); r.setStart(h.firstChild, 0); r.setEnd(h.firstChild, 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height * 0.6 } })
        await page.touchscreen.tap(first.x, first.y)
        await sleep(1400)
        const line = await page.evaluate(() => { const e = document.querySelector('.hero .eyebrow').getBoundingClientRect(); return { x: e.left + 40, y: e.top + e.height / 2 } })
        await page.touchscreen.tap(line.x, line.y)
        await sleep(1400)
        await settle(page, () => tilt.tip(-14, 0))
        await measure('top')
      } else {
        // Pointed at each edge: at the sides, at the bottom of what's on screen, and just under the bar at the top.
        const a = (await page.evaluate(() => window.__home.outline('me'))).area
        for (const [wall, x, y] of [['left', 2, a.bottom * 0.62], ['right', a.right - 2, a.bottom * 0.62], ['bottom', a.right * 0.72, a.bottom - 2], ['top', a.right * 0.72, a.top + 3]]) {
          await settle(page, () => page.mouse.move(x + Math.random(), y))
          await measure(wall)
        }
      }
      seen.push(`${name} ${worst.gap >= 0 ? '' : '+'}${Math.abs(worst.gap).toFixed(2)} px`)
      await ctx.close()
    }
    return `the farthest from its edge: ${seen.join(', ')}`
  })

  await check('on a phone, a knock against the edge of the screen is heard, and leaning on it is quiet', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    const cdp = await ctx.newCDPSession(page)
    const audio = async () => (await cdp.send('Runtime.evaluate', { expression: `(() => { const a = window.__home.audio(); return { ...a, peakDb: Number.isFinite(a.peakDb) ? a.peakDb : -999 } })()`, returnByValue: true })).result.value
    await page.goto(`${local.origin}/?debug=audio&quality=low`)
    await field3d(page)
    await sleep(600)
    const tilt = tilter(page)
    // The tap that switches the tilt on starts the sound too.
    await page.locator('[data-hint]').tap()
    await page.evaluate(() => scrollTo(0, 0))
    await tilt.on()
    await sleep(250)
    const open = await page.evaluate(() => { const q = document.querySelector('.quick li').getBoundingClientRect(); return { x: q.right + 40, y: q.top + q.height / 2 } })
    await page.touchscreen.tap(open.x, open.y)
    await sleep(1600)
    const before = await audio()
    // Tipped hard to the right: across, and a knock against the side.
    const knock = await until('a knock heard', async () => { await tilt.tip(0, 20); const a = await audio(); return a.kinds.wall > before.kinds.wall && a.peakDb > -30 ? a : null }, 8000, 90)
    // Leaning on it, and rolling along it: no more knocks.
    await settle(page, () => tilt.tip(0, 20))
    const leaning = (await audio()).kinds.wall
    const end = Date.now() + 1500
    while (Date.now() < end) { await tilt.tip(8, 18); await sleep(90) }
    const after = await audio()
    await ctx.close()
    if (knock.state !== 'on') throw new Error(`sound is ${knock.state}`)
    if (after.kinds.wall !== leaning) throw new Error(`${after.kinds.wall - leaning} knock(s) while leaning on the side`)
    return `${knock.kinds.wall - before.kinds.wall} knock(s) heard, peak ${knock.peakDb} dBFS; none while leaning on it and rolling along it`
  })

  await check('on a phone, tilted up from below the buttons, the marble rolls up onto them, across, and off; they do nothing', async () => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/?quality=low`)
    await field3d(page)
    await sleep(600)
    await page.evaluate(() => { window.__acted = 0; document.addEventListener('click', (e) => { if (e.target.closest?.('.cta a, .cta button')) window.__acted++ }, true) })
    const tilt = tilter(page)
    await page.locator('[data-hint]').tap()
    await page.evaluate(() => scrollTo(0, 0))
    await tilt.on()
    await sleep(250)
    const pads = await page.evaluate(() => window.__home.pads())
    const send = 1000 + pads.findIndex((p) => /send it/i.test(p)), see = 1000 + pads.findIndex((p) => /see what/i.test(p))
    const open = await page.evaluate(() => { const q = document.querySelector('.quick li').getBoundingClientRect(); return { x: q.right + 40, y: q.top + q.height / 2 } })
    await page.touchscreen.tap(open.x, open.y)
    await sleep(1600)
    const top = await page.evaluate(() => document.querySelector('[data-send]').getBoundingClientRect().top)
    const path = []
    const end = Date.now() + 7000
    while (Date.now() < end) {
      await tilt.tip(-10, 0)
      const t = await me(page)
      if (path.at(-1) !== t.on) path.push(t.on)
      if (t.y < top - 30 && path.includes(send)) break
      await sleep(90)
    }
    const acted = await page.evaluate(() => window.__acted)
    await ctx.close()
    const onSee = path.indexOf(see), onSend = path.indexOf(send)
    if (onSee < 0 || onSend < onSee) throw new Error(`it went ${path.join(' → ')} (the buttons are ${see} and ${send})`)
    if (path.at(-1) !== -1 && path.at(-1) !== -2) throw new Error(`it ended on ${path.at(-1)}`)
    if (acted) throw new Error(`a button acted ${acted} time(s)`)
    return `floor → "${pads[see - 1000]}" → "${pads[send - 1000]}" → floor above them; no button acted`
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
    const before = await screen.evaluate(() => !!document.querySelector('.obpal-chip'))
    if (before) throw new Error('a code was made before anyone moved')
    await screen.mouse.move(300, 300)
    await screen.mouse.move(420, 260, { steps: 6 })
    // The pairing chip, as a panel in the hero's card: its QR code, and its link for this device.
    invite = await until('the code', () => screen.evaluate(() => {
      const root = document.querySelector('[data-pair-slot] .obpal-chip')?.shadowRoot
      return root?.querySelector('.qr svg') ? root.querySelector('.here')?.href || '' : ''
    }), 20000)
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

  await check("in a letter's counter the marble rests without a tremor, and leaves when pointed away", async () => {
    // The o of "Your": a click hops the marble onto it; pointed at the middle of its counter, it goes in.
    const o = await screen.evaluate(() => { const r = document.createRange(); const h = document.getElementById('hero-h'); r.setStart(h.firstChild, 1); r.setEnd(h.firstChild, 2); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height * 0.62, w: b.width } })
    await screen.mouse.click(o.x - o.w * 0.3, o.y)
    await sleep(1200)
    await until('the marble in the counter', async () => { await screen.mouse.move(o.x + Math.random() * 0.5, o.y); return (await me(screen)).held }, 8000, 150)
    // Left there (the mouse still): it settles, and stays in the counter.
    await sleep(3200)
    const held = await me(screen)
    if (!held.held) throw new Error(`it didn't stay in the counter: ${JSON.stringify(held)}`)
    // Still: its position read every frame for a second and a half.
    const most = await screen.evaluate(() => new Promise((done) => {
      const first = window.__home.tips().find((t) => t.id === 'me')
      let prev = first, max = 0
      const end = performance.now() + 1500
      const frame = () => {
        const t = window.__home.tips().find((q) => q.id === 'me')
        max = Math.max(max, Math.hypot(t.x - prev.x, t.y - prev.y))
        prev = t
        if (performance.now() < end) requestAnimationFrame(frame); else done(max)
      }
      requestAnimationFrame(frame)
    }))
    if (most > 0.1) throw new Error(`it moved ${most.toFixed(3)} px in a frame while resting in the counter`)
    // Pointed off to the right, past the letter: out over the rim, and away.
    await settle(screen, () => screen.mouse.move(o.x + o.w * 2 + Math.random(), o.y))
    const out = await me(screen)
    if (out.held || out.x < o.x + o.w * 0.6) throw new Error(`still in the counter: ${JSON.stringify(out)}`)
    return `in it at ${held.x.toFixed(0)},${held.y.toFixed(0)}, moving at most ${most.toFixed(3)} px a frame; out to ${out.x.toFixed(0)},${out.y.toFixed(0)}`
  })

  await check('the marble rolls up onto a button, lights and presses it, and rolls off it again; the button does nothing', async () => {
    await screen.evaluate(() => { window.__acted = 0; document.addEventListener('click', (e) => { if (e.target.closest?.('a, button')) window.__acted++ }, true); addEventListener('hashchange', () => window.__acted++) })
    const url = screen.url()
    const pads = await screen.evaluate(() => window.__home.pads())
    const i = pads.findIndex((p) => /see what it does/i.test(p))
    if (i < 0) throw new Error(`no "See what it does" among the buttons: ${pads.join(', ')}`)
    const b = await screen.locator('.cta-alt').boundingBox()
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
    // From the open floor beside it (a click hops the marble there: rolling, it can't get past the headline's letters)...
    const beside = { x: b.x + b.width + 130, y: b.y + b.height / 2 }
    await screen.mouse.click(beside.x, beside.y)
    await until('the marble beside the button', async () => { const t = await tip(); return t.on === -1 && Math.hypot(t.x - beside.x, t.y - beside.y) < 40 ? t : null }, 10000, 200)
    // ...pointing at the button (not clicking): the marble rolls over and is helped up onto it.
    const at = { x: b.x + b.width * 0.6, y: b.y + b.height / 2 }
    await screen.mouse.move(at.x, at.y, { steps: 10 })
    const on = await until('the marble on the button', async () => { await screen.mouse.move(at.x + Math.random(), at.y); const t = await tip(); return t.on === 1000 + i ? t : null }, 12000, 200)
    const lit = await until('the button lit under it', () => screen.evaluate(() => { const s = document.querySelector('.cta-alt').style; const g = parseFloat(s.getPropertyValue('--orb-glow') || '0'); return g > 0.5 ? { glow: g, press: s.translate } : null }), 4000)
    if (on.x < b.x || on.x > b.x + b.width || on.y < b.y - 25 || on.y > b.y + b.height) throw new Error(`the marble is at ${on.x.toFixed(0)},${on.y.toFixed(0)}, not over the button`)
    // Pointing below it: the marble rolls off its edge and drops to the floor.
    const below = b.y + b.height + 110
    await screen.mouse.move(at.x, below, { steps: 6 })
    const off = await until('the marble back on the floor', async () => { await screen.mouse.move(at.x + Math.random(), below); const t = await tip(); return t.on === -1 && t.y > b.y + b.height ? t : null }, 12000, 200)
    const acted = await screen.evaluate(() => window.__acted)
    if (acted || screen.url() !== url) throw new Error(`the button acted: ${acted} clicks, now at ${screen.url()}`)
    return `on "${pads[i]}" at ${on.x.toFixed(0)},${on.y.toFixed(0)} (lit ${lit.glow}, pressed ${lit.press || 'none'}), then off to ${off.x.toFixed(0)},${off.y.toFixed(0)}; no click, no navigation`
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
    if (!/tilt your phone/i.test(hint ?? '')) throw new Error(`hint says "${hint}"`)
    // The sound button is there to switch the marbles' sound (it starts with a click on the page).
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

  await check("the phone flicked upward tosses its marble, and so does a tap on its trackpad", async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id !== 'me'))
    const high = async (what, go) => {
      // Settled: low and staying there (a marble still bouncing dips under 0.25 em too, and a toss that comes while
      // it's in the air only waits a moment for it to land).
      await until(`${what}: the marble settled`, async () => { const a = await tip(); await sleep(150); const b = await tip(); return a.h < 0.25 && Math.abs(a.h - b.h) < 0.01 }, 8000)
      await go()
      // (What it did instead, if it doesn't: the highest it went, and where it was.)
      let seen = null
      try {
        return await until(what, async () => { const t = await tip(); if (!seen || t.h > seen.h) seen = t; return t.h > 0.3 ? t.h : null }, 5000)
      } catch (e) {
        throw new Error(`${e.message} (at most ${seen?.h.toFixed(2)} em up, on ${seen?.on} at ${seen?.x.toFixed(0)},${seen?.y.toFixed(0)})`)
      }
    }
    // A phone lying flat that jerks upward and stops: the controller sees a toss and sends it.
    const flick = await high('the flick tossed it', () => phone.evaluate(async () => {
      dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: 0 }))
      const at = (a) => dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: a }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 + a }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }))
      const wait = () => new Promise((r) => setTimeout(r, 16))
      for (const [a, n] of [[0, 8], [15, 5], [-15, 5], [0, 10]]) for (let i = 0; i < n; i++) { at(a); await wait() }
    }))
    const a = await high('a tap tossed it', async () => {
      const cdp = await phoneCtx.newCDPSession(phone)
      const b = await phone.locator('#pad').boundingBox()
      const p = { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] })
      await sleep(60)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    })
    return `flick ${flick.toFixed(2)} em up, tap ${a.toFixed(2)} em up`
  })

  await check('the phone held as a tray (its gyro on) rolls its marble with its tilt', async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id !== 'me'))
    // Level to start with; the phone sees its motion, then its gyro goes on (the tray's level is how it's held).
    await phone.evaluate(() => {
      const m = (window.__tray = { beta: 0, gamma: 0 })
      setInterval(() => {
        dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: m.beta, gamma: m.gamma }))
        dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 0, z: 9.81 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }))
      }, 16)
    })
    await phone.locator('#gyro').waitFor({ state: 'visible', timeout: 5000 })
    await sleep(1200)
    const cdp = await phoneCtx.newCDPSession(phone)
    const g = await phone.locator('#gyro').boundingBox()
    const at = { x: g.x + g.width / 2, y: g.y + g.height / 2, id: 1 }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
    await sleep(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await until('the gyro on', () => phone.evaluate(() => document.getElementById('gyro').getAttribute('aria-pressed') === 'true'), 5000)
    await until('the marble settled', async () => (await tip()).h < 0.25, 8000)
    const before = await tip()
    // Tipped to the right: the marble rolls right.
    await phone.evaluate(() => { window.__tray.gamma = 22 })
    const after = await until('the marble rolled right', async () => { const t = await tip(); return t.x - before.x > 40 ? t : null }, 6000)
    await phone.evaluate(() => { window.__tray.gamma = 0 })
    return `${before.x.toFixed(0)} → ${after.x.toFixed(0)}px`
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
