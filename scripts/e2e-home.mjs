/**
 * The home page end to end, from this checkout's build on the local stand-in (extension/e2e/local.mjs, signaling
 * through this checkout's own worker, fresh for the run):
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
 *   - A knock against the edge of the screen is heard with the frame that shows it: foreseen and started ahead, the
 *     speakers' own lag made up (nothing of ours in between otherwise); leaning on it is quiet.
 *   - On a phone, tilted up from below the buttons (clearly: past the 13° a raised thing takes), the marble rolls up
 *     onto them, across and off.
 *   - The raised things (the buttons, the hint, the sound control, the three steps' icons) are blocks 0.3 em tall
 *     (three times the first ones), each drawn as tall as the field sees it: the icons have a side, a glass top and a
 *     shadow like the sound control's, on a phone and a computer.
 *   - On a phone in a noisy hand (a tremble, stray readings), a marble in the o and in the p rests dead still, with
 *     no jumps; so does one across the narrow gap between the r and the full stop.
 *   - A marble in a letter's counter rests there without a tremor, and leaves when pointed away.
 *   - On a phone, a card's scene plays under a held finger; a flick on it scrolls the page, even when the page is busy
 *     as the finger lands (the events carry their own times, as a phone's do); a long press selects nothing.
 *   - No cue or switch covers a scene's drawing, on phones (upright and sideways), a tablet and computers; the cue
 *     fades where it is once you've played.
 *   - The Move card switches between Motion and Drag, with a mouse and on a phone. In Motion the hand follows the
 *     mouse over the card, or the phone's tilt (its first tap turns the tilt on, and the card says so), and a click or
 *     tap works the clamp, moving nothing. In Drag a drag moves the hand, a click or tap sends it there, and a double
 *     one works the clamp once it's there. A whole pick and place in each; arrow keys change it and the visit keeps it.
 *   - The Play card's ball stays in play, alone or with the mouse pushing it into the corners.
 * What the marbles do is waited for on their own clock (window.__home.sim(): their physics' fixed steps), not the
 * wall clock: on a machine busy with other work the page draws fewer frames, and the marbles get less of their time
 * in the same wall-clock second.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { cspCheck } from './csp-watch.mjs'
import sharp from 'sharp'
import { startLocal } from '../extension/e2e/local.mjs'
import { trayReading } from './lib/orientation.mjs'
import { runWarmup } from './e2e-warmup.mjs'

const HEADED = process.argv.includes('--headed')
// The environment form also works through e2e:all, preserving its Desktop guard for an isolated check.
const ONLY = process.argv.find((arg) => arg.startsWith('--only='))?.slice(7) || process.env.OBPAL_E2E_HOME_ONLY || ''
const ONLY_DONE = Symbol('only test finished')
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
// Software WebGL for the hero's 3D field in headless runs.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
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
/**
 * The marbles' own clock (s of their physics' fixed steps) and whether the hero's loop runs. The hero's checks wait on
 * it, not on the wall clock: on a machine busy with other work the page draws fewer frames, each at most 0.05 s of
 * the marbles' time, so a wall-clock wait gives them less time to do what's checked.
 */
const sim = (page) => page.evaluate(() => window.__home.sim())
/** Wait `s` s of the marbles' time, or until the loop has run and stopped (nothing moves any more). */
async function simWait(page, s, wall = 45000) {
  const t0 = (await sim(page)).t, end = Date.now() + wall
  for (;;) {
    const q = await sim(page)
    if (q.t - t0 >= s || (!q.busy && q.t > t0) || Date.now() > end) return
    await sleep(40)
  }
}
/** Until `fn` gives something, within `s` s of the marbles' time (and a wall-clock backstop). */
async function simUntil(page, what, fn, s, every = 100, wall = 90000) {
  const t0 = (await sim(page)).t, end = Date.now() + wall
  for (;;) {
    const v = await fn()
    if (v) return v
    if ((await sim(page)).t - t0 > s || Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}
/**
 * Drive the marble (a tilt, a pointer) until it stops: within 0.3 px over the last 0.4 s of the marbles' time, having
 * been driven at least `least` s of it.
 */
async function settle(page, drive, least = 1.5, wall = 45000) {
  const t0 = (await sim(page)).t, end = Date.now() + wall
  const seen = []
  while (Date.now() < end) {
    await drive()
    const { t, q } = await page.evaluate(() => ({ t: window.__home.tips().find((m) => m.id === 'me'), q: window.__home.sim() }))
    seen.push({ x: t.x, y: t.y, at: q.t })
    const recent = seen.filter((p) => p.at >= q.t - 0.45)
    if (q.t - t0 >= least && q.t - recent[0].at >= 0.4 && recent.every((p) => Math.hypot(p.x - t.x, p.y - t.y) < 0.3)) return t
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
  const send = (down, right) => page.evaluate(r => dispatchEvent(new DeviceOrientationEvent('deviceorientation', r)), trayReading(down, right, angle))
  return {
    async on() { angle = await page.evaluate(() => screen.orientation?.angle ?? 0); await send(0, 0) },
    tip(down, right) {
      k++
      const w = (k % 2) * 4
      const d = right ? down : down + Math.sign(down) * w, r = right ? right + Math.sign(right) * w : right
      return send(d, r)
    },
  }
}
/**
 * The brightest pixel (luminance 0…255) in the outermost 2 px inside an edge of the play area `a` (hero px), within
 * 14 px of `at` along it: the marble's rim, if it's there; the night sky, if it isn't.
 */
async function rimAt(page, wall, at, a) {
  const [top, vw, vh] = await page.evaluate(() => [document.querySelector('.hero').getBoundingClientRect().top, innerWidth, innerHeight])
  const clip = wall === 'left' ? { x: a.left, y: top + at - 14, width: 2, height: 28 }
    : wall === 'right' ? { x: a.right - 2, y: top + at - 14, width: 2, height: 28 }
    : wall === 'top' ? { x: at - 14, y: top + a.top, width: 28, height: 2 }
    : { x: at - 14, y: top + a.bottom - 2, width: 28, height: 2 }
  // (Within the screen: near a corner, the stretch beside it runs off it.)
  const x0 = Math.max(0, clip.x), y0 = Math.max(0, clip.y)
  Object.assign(clip, { x: x0, y: y0, width: Math.min(vw, clip.x + clip.width) - x0, height: Math.min(vh, clip.y + clip.height) - y0 })
  // (The quick-actions tray's glass tab sits over the right edge, and the marble rolls on under it: the tray is out of
  // the picture while it's taken, as the rim is the hero's own drawing.)
  await page.evaluate(() => document.querySelector('.quick-tray')?.style.setProperty('display', 'none'))
  const png = await page.screenshot({ clip })
  await page.evaluate(() => document.querySelector('.quick-tray')?.style.removeProperty('display'))
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  let best = 0
  for (let i = 0; i < data.length; i += info.channels) best = Math.max(best, 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
  return best
}
async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return
  try {
    const detail = await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ name, ok: false })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
  if (ONLY) throw ONLY_DONE
}

// OBPAL_E2E_PORT runs the stand-in elsewhere than its usual 5176, beside another run.
const local = await startLocal({ port: Number(process.env.OBPAL_E2E_PORT) || undefined })
const browsers = []
let profile = ''
try {
  console.log('ob.Pal home e2e')
  const browser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  browsers.push(browser)

  if (!ONLY || ONLY === 'warm-up') await runWarmup(local, check, { home: true })

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
    const tilt = (beta, gamma) => page.evaluate(r => dispatchEvent(new DeviceOrientationEvent('deviceorientation', r)), trayReading(beta - 60, gamma, 0, 60))
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
    await simWait(page, 0.9)
    const left = await tip()
    for (let i = 1; i <= 16; i++) { await tilt(60 + i, -16 + i * 2.5); await sleep(40) }
    const width = await page.evaluate(() => innerWidth)
    const moved = await simUntil(page, 'the marble rolled with the tilt', async () => { const t = await tip(); return t.x - left.x > 30 && t.y - left.y > 20 ? t : null }, 4)
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

  /** Scroll a scene's card to the middle of the screen, and wait for it to finish arriving (it rises as it comes into view). */
  const cardInView = async (page, scene) => {
    await page.evaluate((s) => document.querySelector(`[data-scene="${s}"]`).scrollIntoView({ block: 'center' }), scene)
    await until(`the ${scene} card in place`, () => page.evaluate((s) => document.querySelector(`[data-scene="${s}"]`).closest('.scene').classList.contains('in'), scene), 8000)
    await until(`the ${scene} card still`, () => page.evaluate((s) => document.querySelector(`[data-scene="${s}"]`).closest('.scene').getAnimations({ subtree: true }).length === 0, scene), 8000)
    const art = await page.locator(`[data-scene="${scene}"]`).boundingBox()
    return { art, at: (x, y) => [art.x + (x / 400) * art.width, art.y + (y / 260) * art.height], k: art.width / 400 }
  }

  await check('on a phone, a scene plays under a held finger, a flick still scrolls (even as the page is busy), and a long press selects nothing', async () => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    const { art, at } = await cardInView(page, 'point')
    const cdp = await ctx.newCDPSession(page)
    const [cx, cy] = at(200, 130)
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
    /**
     * A flick straight up from (x, y) on a card, no hold: that's a scroll. The events carry their own times, as a
     * phone's do, the first move 10 ms after the landing: however late the page hears it, it's a flick. With `busy`,
     * the page is busy for 400 ms just after it hears the finger land, so it hears that move after its hold is up.
     * Returns how far the page scrolled.
     */
    const flick = async (x, y, busy) => {
      const from = await page.evaluate(() => scrollY)
      const at = Date.now() / 1000
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }], timestamp: at })
      if (busy) cdp.send('Runtime.evaluate', { expression: '(() => { const t = performance.now(); while (performance.now() - t < 400) {} })()' }).catch(() => {})
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 30, id: 1 }], timestamp: at + 0.01 })
      for (let i = 2; i <= 6; i++) { await sleep(16); await touch('touchMove', x, y - i * 30) }
      await touch('touchEnd')
      await until('the page scrolled', async () => (await page.evaluate(() => scrollY)) - from >= 60, 3000).catch(() => {})
      await sleep(500)
      return (await page.evaluate(() => scrollY)) - from
    }
    // The Point card's cursor, as drawn (viewBox units).
    const cursor = () => page.evaluate(() => { const d = document.querySelector('[data-scene="point"] svg circle[fill="#f4ffd6"]'); return { x: +d.getAttribute('cx'), y: +d.getAttribute('cy') } })
    const lit = () => page.evaluate(() => document.querySelector('[data-scene="point"]').closest('.scene').classList.contains('held'))
    // Hold still till the card lights up, then drag up and across: the scene has the finger (its cursor goes where the
    // finger goes), and the page stays put.
    const y0 = await page.evaluate(() => scrollY)
    await touch('touchStart', cx, cy)
    const held = await until('the card lit under the finger', lit, 3000).catch(() => false)
    for (let i = 1; i <= 10; i++) { await touch('touchMove', cx + i * 6, cy - i * 5); await sleep(30) }
    const finger = { x: ((cx + 60 - art.x) / art.width) * 400, y: ((cy - 50 - art.y) / art.height) * 260 }
    const during = await until('the cursor under the finger', async () => { const d = await cursor(); return Math.hypot(d.x - finger.x, d.y - finger.y) < 4 ? d : null }, 3000).catch(() => null)
    await touch('touchEnd')
    const y1 = await page.evaluate(() => scrollY)
    if (!held) throw new Error('holding a finger on the scene did not hand it the gesture')
    if (Math.abs(y1 - y0) > 2) throw new Error(`the page scrolled ${y1 - y0}px under a held finger`)
    if (!during) throw new Error(`the scene didn't follow the finger: its cursor at ${JSON.stringify(await cursor())}, the finger at ${JSON.stringify(finger)}`)
    const flicked = await flick(cx, cy + 40, false)
    if (flicked < 60) throw new Error(`a flick scrolled only ${flicked}px`)
    // Again, the card back in the middle, the page busy as the finger lands (a phone busy loading, say): still a scroll.
    await page.evaluate(() => document.querySelector('[data-scene="point"]').scrollIntoView({ block: 'center' }))
    await sleep(300)
    const again = await page.locator('[data-scene="point"]').boundingBox()
    const busy = await flick(again.x + again.width / 2, again.y + again.height / 2 + 40, true)
    if (busy < 60) throw new Error(`a flick on a busy page scrolled only ${busy}px`)
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
    return `the cursor under the finger at ${during.x.toFixed(0)},${during.y.toFixed(0)} with the page still; a flick scrolled ${flicked}px, ${busy}px on a busy page`
  })

  await check("no cue or switch covers a scene's drawing, on phones, tablets and computers; the cue fades where it is once you've played", async () => {
    const PHONE = { isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
    const sizes = [
      { name: '360x800', viewport: { width: 360, height: 800 }, ...PHONE },
      { name: '390x844', viewport: { width: 390, height: 844 }, ...PHONE },
      { name: '412x915', viewport: { width: 412, height: 915 }, ...PHONE },
      { name: '844x390 sideways', viewport: { width: 844, height: 390 }, ...PHONE },
      { name: '768x1024 tablet', viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
      { name: '1280x800', viewport: { width: 1280, height: 800 } },
      { name: '1920x1080', viewport: { width: 1920, height: 1080 } },
    ]
    /** Each card: whether it has a cue, a switch and a line on what to do, and those of them on its drawing. */
    const cards = (page) => page.evaluate(() => {
      const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } }
      const meet = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      return [...document.querySelectorAll('[data-scene]')].map((host) => {
        const card = host.closest('.scene'), art = box(host)
        const parts = [...card.querySelectorAll('.play-cue, .scene-modes, .scene-tip')]
        return {
          scene: host.dataset.scene, cue: !!card.querySelector('.play-cue'), modes: !!card.querySelector('.scene-modes'), tip: !!card.querySelector('.scene-tip'),
          over: parts.filter((e) => e.getBoundingClientRect().width > 0 && meet(box(e), art)).map((e) => e.className),
        }
      })
    })
    const seen = []
    for (const { name, ...size } of sizes) {
      const ctx = await browser.newContext({ ...size, ignoreHTTPSErrors: true })
      const page = await ctx.newPage()
      await page.goto(`${local.origin}/`)
      await until('the scenes drawn', () => page.evaluate(() => document.querySelectorAll('[data-scene] svg').length === 6), 8000)
      const all = await cards(page)
      for (const c of all) {
        if (c.over.length) throw new Error(`${name}: on the ${c.scene} card, ${c.over.join(' and ')} covers the drawing`)
        const arm = c.scene === 'arm'
        if (arm && !(c.modes && c.tip)) throw new Error(`${name}: the Move card has no switch, or no line on what to do`)
        if (!arm && c.cue !== !!size.hasTouch) throw new Error(`${name}: the ${c.scene} card ${c.cue ? 'has a cue without a touch screen' : 'has no cue on a touch screen'}`)
      }
      seen.push(name)
      await ctx.close()
    }
    // Once you've played (a finger held on a scene), the cues fade where they are: nothing on the page moves.
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    const { at } = await cardInView(page, 'turn')
    const layout = () => page.evaluate(() => [...document.querySelectorAll('.scene h3')].map((h) => Math.round(h.getBoundingClientRect().top + scrollY)).join(','))
    const cueShown = () => page.evaluate(() => getComputedStyle(document.querySelector('.play-cue')).opacity)
    const before = await layout(), shown = await cueShown()
    const cdp = await ctx.newCDPSession(page)
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
    await touch('touchStart', ...at(200, 130))
    await until('played', () => page.evaluate(() => document.documentElement.classList.contains('played')), 3000)
    await touch('touchEnd')
    await sleep(700)
    const after = await layout(), faded = await cueShown()
    await ctx.close()
    if (shown !== '1' || faded !== '0') throw new Error(`the cue's opacity was ${shown} before playing and ${faded} after`)
    if (after !== before) throw new Error(`the cards moved when the cues faded: headings at ${before}, then ${after}`)
    return `${seen.join(', ')}; the cue faded in place`
  })

  /**
   * The Move card's arm, as drawn (viewBox units): where its hand is, the block, whether the arm holds it and whether
   * closing now would take it, and how far apart its fingers are.
   */
  const armState = (page) => page.evaluate(() => {
    const svg = document.querySelector('[data-scene="arm"] svg')
    const f = [...svg.querySelectorAll('line')].find((e) => e.getAttribute('stroke-width') === '10')
    const fingers = [...svg.querySelectorAll('line')].filter((e) => e.getAttribute('stroke') === '#e9e4ff').map((e) => +e.getAttribute('x1'))
    const b = svg.querySelector('[data-block]')
    return {
      x: +f.getAttribute('x2'), y: +f.getAttribute('y2'), bx: +b.getAttribute('x') + 10, by: +b.getAttribute('y') + 10,
      held: b.getAttribute('data-held') === '1', ready: b.getAttribute('data-ready') === '1', span: Math.abs(fingers[1] - fingers[0]),
    }
  })
  /** The Move card, its switch's choice, and its line on what to do. */
  const ARM = 'article.scene:has([data-scene="arm"])'
  const modeOf = (page) => page.evaluate((c) => document.querySelector(`${c} .scene-modes [aria-checked="true"]`)?.dataset.mode, ARM)
  const lineOf = (page) => page.evaluate((c) => document.querySelector(`${c} .scene-tip > [data-on]`)?.textContent, ARM)
  // The block rests on the table with its middle this high; the hand is over it, low enough to take it, this high.
  const REST = 212, LOW_HAND = 202
  /** The hand at (x, y) (viewBox units), once it's got there. */
  const handAt = (page, x, y) => until(`the hand at ${x.toFixed(0)},${y.toFixed(0)}`, async () => { const s = await armState(page); return Math.hypot(s.x - x, s.y - y) < 1 ? s : null }, 6000)
  /**
   * A click or tap in Motion, anywhere: it works the clamp (the fingers close, or open again, `shut`) and moves nothing,
   * the hand staying put to a pixel. Returns how far the hand went.
   */
  const clampClick = async (page, click, shut) => {
    // (From a hand at rest: easing on to where it was sent isn't the click's doing.)
    const s0 = await until('the hand at rest', async () => { const a = await armState(page); await sleep(150); const b = await armState(page); return Math.hypot(b.x - a.x, b.y - a.y) < 0.05 ? b : null }, 4000)
    await click()
    let s1 = s0, off = 0
    for (const end = Date.now() + 1000; Date.now() < end;) { s1 = await armState(page); off = Math.max(off, Math.hypot(s1.x - s0.x, s1.y - s0.y)); await sleep(40) }
    if (off > 1) throw new Error(`a click or tap in Motion moved the hand ${off.toFixed(2)}: ${JSON.stringify({ s0, s1 })}`)
    if (shut ? s1.span > 12 : s1.span < 30) throw new Error(`the clamp didn't ${shut ? 'close' : 'open'}: ${JSON.stringify({ s0, s1 })}`)
    return off
  }
  /** The story may have been carrying the block when the hand was taken: a click (in Motion) lets it go, where it is. */
  const letGo = async (page, click) => {
    if (!(await armState(page)).held) return
    await click()
    await until('let go', async () => !(await armState(page)).held, 4000)
    await sleep(700)
  }
  /**
   * A pick and place in Motion, by `steer` (puts the hand at a point: the mouse over the card, or the phone's tilt) and
   * `click` (a click or tap, anywhere): the hand over the block, low, a click takes it; up, across to the other pad
   * and down, the block comes along; a click lets it go, onto the pad. The clicks never move the hand. Returns where
   * the block went.
   */
  const motionPlace = async (page, steer, click) => {
    await steer(200, 120)
    await letGo(page, click)
    let s = await armState(page)
    const from = s.bx
    const pad = Math.abs(from - 318) > Math.abs(from - 96) ? 318 : 96
    await steer(from, 150)
    await steer(from, LOW_HAND)
    s = await armState(page)
    if (!s.ready) throw new Error(`over the block, it isn't ready to take it: ${JSON.stringify(s)}`)
    await click()
    await until('held', async () => (await armState(page)).held, 4000)
    await sleep(300)
    const took = await armState(page)
    if (Math.hypot(took.x - s.x, took.y - s.y) > 1) throw new Error(`the hand moved when it clamped: ${JSON.stringify({ s, took })}`)
    await steer(from, 150)
    await steer(pad, 150)
    s = await armState(page)
    if (!s.held || Math.abs(s.bx - pad) > 3) throw new Error(`the block didn't come along: ${JSON.stringify(s)}`)
    await steer(pad, LOW_HAND)
    const over = await armState(page)
    await click()
    await until('let go', async () => !(await armState(page)).held, 4000)
    await sleep(700)
    const put = await armState(page)
    if (Math.hypot(put.x - over.x, put.y - over.y) > 1) throw new Error(`the hand moved when it let go: ${JSON.stringify({ over, put })}`)
    if (Math.abs(put.bx - pad) > 3 || Math.abs(put.by - REST) > 0.5) throw new Error(`the block isn't on the pad: ${JSON.stringify(put)}`)
    return `${Math.round(from)} → ${Math.round(put.bx)}`
  }
  /**
   * Drag's clamp and a pick and place in Drag, by `click` (a click or tap at a point, viewBox units) and `double` (a
   * double one): a double click on the block sends the hand to it and takes it, and another there lets it go; then a
   * double click on the block takes it again, a click over the other pad carries it there, and a double click on the
   * pad puts it down. Returns where the block went.
   */
  const dragPlace = async (page, click, double) => {
    let s = await armState(page)
    // The story may have been carrying the block: let it go first, where it is.
    if (s.held) { await double(s.x, s.y); await until('let go', async () => !(await armState(page)).held, 5000); await sleep(700) }
    s = await armState(page)
    const from = s.bx
    const pad = Math.abs(from - 318) > Math.abs(from - 96) ? 318 : 96
    await double(from, REST)
    await until('held after a double click on the block', async () => (await armState(page)).held, 5000)
    await double(from, REST)
    await until('let go after another', async () => !(await armState(page)).held, 5000)
    await sleep(500)
    await double(from, REST)
    await until('held again', async () => (await armState(page)).held, 5000)
    await click(pad, 150)
    s = await handAt(page, pad, 150)
    if (!s.held || Math.abs(s.bx - pad) > 3) throw new Error(`the block didn't come along: ${JSON.stringify(s)}`)
    await double(pad, REST)
    await until('let go on the pad', async () => !(await armState(page)).held, 5000)
    await sleep(700)
    const put = await armState(page)
    if (Math.abs(put.bx - pad) > 3 || Math.abs(put.by - REST) > 0.5) throw new Error(`the block isn't on the pad: ${JSON.stringify(put)}`)
    return `${Math.round(from)} → ${Math.round(put.bx)}`
  }

  await check('the Move card with a mouse: in Motion the hand follows the mouse over the card and a click works the clamp, moving nothing; in Drag a drag moves the hand, a click sends it there and a double click works the clamp there; a whole pick and place in each; arrows and the visit keep the choice', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    const { at } = await cardInView(page, 'arm')
    const radios = await page.locator(`${ARM} .scene-modes [role="radio"]`).count()
    if (radios !== 2) throw new Error(`the switch has ${radios} choices`)
    if ((await modeOf(page)) !== 'motion') throw new Error(`it opened in ${await modeOf(page)}`)
    const tips = await page.evaluate((c) => [...document.querySelectorAll(`${c} .scene-modes button`)].map((b) => b.title), ARM)
    const choose = async (m) => { await page.locator(`${ARM} .scene-modes [data-mode="${m}"]`).click(); await until(`${m} picked`, async () => (await modeOf(page)) === m, 3000) }
    // Motion: the hand goes where the mouse is over the card; a click, where the mouse is, works the clamp.
    const line = await lineOf(page)
    const steer = async (x, y) => { await page.mouse.move(...at(x, y), { steps: 10 }); await handAt(page, x, y) }
    const click = async () => { await page.mouse.down(); await page.mouse.up() }
    await steer(150, 110)
    await letGo(page, click)
    const shut = await clampClick(page, click, true)
    const opened = await clampClick(page, click, false)
    const motion = await motionPlace(page, steer, click)
    // Drag: the mouse passing over moves nothing; a drag moves the hand by as much as the mouse moves; a click sends it
    // there.
    await choose('drag')
    const d0 = await armState(page)
    await page.mouse.move(...at(60, 200), { steps: 8 })
    await page.mouse.move(...at(330, 60), { steps: 8 })
    await sleep(600)
    const d1 = await armState(page)
    if (Math.hypot(d1.x - d0.x, d1.y - d0.y) > 1) throw new Error(`the mouse passing over in Drag moved the hand: ${JSON.stringify({ d0, d1 })}`)
    await page.mouse.click(...at(150, 100))
    await handAt(page, 150, 100)
    await page.mouse.move(...at(260, 60))
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) { await page.mouse.move(...at(260 + (40 * i) / 12, 60 + (30 * i) / 12)); await sleep(25) }
    await page.mouse.up()
    await handAt(page, 190, 130)
    const drag = await dragPlace(page, (x, y) => page.mouse.click(...at(x, y)), (x, y) => page.mouse.dblclick(...at(x, y)))
    // The keyboard moves between the choices, and the choice lasts the visit.
    await page.locator(`${ARM} .scene-modes [aria-checked="true"]`).focus()
    await page.keyboard.press('ArrowRight')
    const focused = await page.evaluate(() => document.activeElement?.dataset?.mode)
    if ((await modeOf(page)) !== 'motion' || focused !== 'motion') throw new Error(`an arrow key left it at ${await modeOf(page)} (focus on ${focused})`)
    await page.keyboard.press('ArrowRight')
    await page.reload({ waitUntil: 'load' })
    await until('the switch again', () => modeOf(page).catch(() => null), 8000)
    const kept = await modeOf(page)
    await ctx.close()
    if (kept !== 'drag') throw new Error(`after a reload it was ${kept}`)
    return `tips "${tips.join('", "')}"; Motion's line "${line}"; clicks: hand ${Math.max(shut, opened).toFixed(2)} off, closed and opened; block ${motion} in Motion, ${drag} in Drag; arrows and reload kept it`
  })

  await check('the Move card on a phone: in Motion the first tap turns the tilt on and says so, then the hand follows the tilt and a tap works the clamp, moving nothing; in Drag a held finger drags the hand, a tap sends it there and a double tap works the clamp there; a whole pick and place in each', async () => {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    // The hero's opening over first: when it ends, however the phone's held becomes level for the tilt.
    await until('the marble at rest after the opening', () => restingOnDot(page), 25000, 300)
    const { at, k } = await cardInView(page, 'arm')
    const cdp = await ctx.newCDPSession(page)
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] })
    // Both halves of a tap at once: sent one after the other, a busy page can see them far enough apart to be a long press.
    const tapAt = (x, y) => Promise.all([touch('touchStart', x, y), touch('touchEnd')])
    // A double tap's events carry their own times, as a phone's do (the second tap 150 ms after the first), so
    // however late a busy page hears them, they're a double tap.
    const doubleAt = (x, y) => {
      const t = Date.now() / 1000 - 0.25
      const send = (type, dt) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }], timestamp: t + dt })
      return Promise.all([send('touchStart', 0), send('touchEnd', 0.04), send('touchStart', 0.15), send('touchEnd', 0.19)])
    }
    const choose = async (m) => {
      const b = await page.locator(`${ARM} .scene-modes [data-mode="${m}"]`).boundingBox()
      await tapAt(b.x + b.width / 2, b.y + b.height / 2)
      await until(`${m} picked by a tap`, async () => (await modeOf(page)) === m, 3000)
    }
    const tap = () => tapAt(...at(40, 40))
    // Motion: before the tilt's on, the card says a tap turns it on; the first tap does, and the card says so.
    const asked = await lineOf(page)
    await tap()
    await until('the tilt on', () => page.evaluate(() => document.documentElement.classList.contains('tilting')), 3000)
    const told = await until('the card saying so', async () => { const l = await lineOf(page); return l !== asked ? l : null }, 3000)
    // The phone's tilt, from how it's held when the tilt starts (the middle of its first readings): turned so the
    // scene's tilt point is at (x, y) (viewBox units) by the page's own mapping (24 degrees past a 1.2 degree dead zone
    // reach 0.42 of the width, and 0.4 of the height, from the middle), smoothly, as a hand turns it, and held there.
    const send = (b, g) => page.evaluate(r => dispatchEvent(new DeviceOrientationEvent('deviceorientation', r)), trayReading(b - 40, g))
    for (let i = 0; i < 8; i++) { await send(40, 0); await sleep(10) }
    let now = { b: 40, g: 0 }
    const deg = (v) => (v ? Math.sign(v) * (Math.abs(v) + 1.2) : 0)
    const tiltTo = async (x, y) => {
      const to = { b: 40 + deg(((y - 130) / (260 * 0.4)) * 24), g: deg(((x - 200) / (400 * 0.42)) * 24) }
      for (let i = 1; i <= 12; i++) { await send(now.b + ((to.b - now.b) * i) / 12, now.g + ((to.g - now.g) * i) / 12); await sleep(30) }
      for (let i = 0; i < 3; i++) { await send(to.b, to.g); await sleep(30) }
      now = to
    }
    const steer = async (x, y) => { await tiltTo(x, y); await handAt(page, x, y) }
    await steer(150, 110)
    await letGo(page, tap)
    const shut = await clampClick(page, tap, true)
    const opened = await clampClick(page, tap, false)
    const motion = await motionPlace(page, steer, tap)
    // Drag: a finger held still a moment takes the hand, and drags it by as much as the finger moves; a tap sends it
    // there.
    await choose('drag')
    await tapAt(...at(150, 100))
    await handAt(page, 150, 100)
    const [x0, y0] = at(260, 110)
    await touch('touchStart', x0, y0)
    await until('the finger taken', () => page.evaluate((c) => document.querySelector(c).classList.contains('held'), ARM), 3000)
    // A phone sends no moves until the finger has gone a little way (its touch slop): up and out of it first, then to
    // where the drag ends (40 across and 30 down from where it was held, in the scene's units).
    for (let i = 1; i <= 3; i++) { await touch('touchMove', x0, y0 - 10 * i); await sleep(30) }
    for (let i = 1; i <= 12; i++) { await touch('touchMove', x0 + (40 * k * i) / 12, y0 - 30 + ((30 * k + 30) * i) / 12); await sleep(30) }
    // The last move heard before the finger lifts.
    await sleep(120)
    await touch('touchEnd')
    await handAt(page, 190, 130)
    const drag = await dragPlace(page, (x, y) => tapAt(...at(x, y)), (x, y) => doubleAt(...at(x, y)))
    await ctx.close()
    return `"${asked}", then "${told}"; taps: hand ${Math.max(shut, opened).toFixed(2)} off, closed and opened; block ${motion} in Motion, ${drag} in Drag`
  })

  await check('the Play card keeps its ball in play: never still for 2 s, alone or with the mouse pushing it into the corners', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/`)
    await page.evaluate(() => document.querySelector('[data-scene="play"]').scrollIntoView({ block: 'center' }))
    await sleep(900)
    const art = await page.locator('[data-scene="play"]').boundingBox()
    const toPage = (x, y) => [art.x + (x / 400) * art.width, art.y + (y / 260) * art.height]
    const ball = () => page.evaluate(() => { const c = [...document.querySelectorAll('[data-scene="play"] svg circle')].find((e) => e.getAttribute('fill') === '#f4ffd6'); return { x: +c.getAttribute('cx'), y: +c.getAttribute('cy') } })
    /** Watch the ball for `ms`: the longest it stayed within 18 units of one spot (s). */
    const watch = async (ms, each) => {
      const seen = []
      let worst = 0
      const t0 = Date.now()
      for (let t = 0; t < ms; t = Date.now() - t0) {
        await each(seen.at(-1))
        const b = await ball()
        seen.push({ t, ...b })
        let k = seen.length - 1
        while (k > 0 && Math.hypot(seen[k - 1].x - b.x, seen[k - 1].y - b.y) < 18) k--
        worst = Math.max(worst, (t - seen[k].t) / 1000)
        await sleep(100)
      }
      return worst
    }
    const corners = [[70, 34], [330, 34], [70, 226], [330, 226]]
    const pushed = await watch(12000, async (b) => {
      if (!b) { await page.mouse.move(...toPage(200, 130)); return }
      const [cx, cy] = corners.reduce((m, c) => (Math.hypot(c[0] - b.x, c[1] - b.y) < Math.hypot(m[0] - b.x, m[1] - b.y) ? c : m))
      const d = Math.hypot(cx - b.x, cy - b.y) || 1
      await page.mouse.move(...toPage(b.x - ((cx - b.x) / d) * 10, b.y - ((cy - b.y) / d) * 10))
    })
    // Alone (the mouse off the card; reading down the page keeps a scene in view playing).
    await page.mouse.move(5, 5)
    let n = 0
    const alone = await watch(10000, async () => { if (++n % 20 === 0) await page.mouse.wheel(0, 1) })
    await ctx.close()
    if (pushed >= 2 || alone >= 2) throw new Error(`the ball stayed put ${pushed.toFixed(1)} s pushed into corners, ${alone.toFixed(1)} s alone`)
    return `longest in one spot: ${pushed.toFixed(1)} s pushed into corners, ${alone.toFixed(1)} s alone`
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
        // Before each press, hopped onto open floor (a tap there) with a clear way to that side, and tipped straight
        // into it, harder than it takes to climb a raised thing: along the lowest row clear right across the screen
        // (below the headline, clear of the raised things and their sides), and down the column clear from there to
        // the bottom nearest the middle.
        const ways = await page.evaluate(() => {
          const blocks = [...document.querySelectorAll('.hero .cta .btn, .hero [data-hint], .hero [data-sound], .hero .quick .qi, #hero-h')]
            .map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0).map((r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom + 16 }))
          const m = 16
          const free = (l, t, r, b) => blocks.every((q) => q.r < l || q.l > r || q.b < t || q.t > b)
          let row = NaN, col = NaN, down = NaN
          for (let y = innerHeight - 30; y >= 90 && Number.isNaN(row); y -= 1) if (free(0, y - m, innerWidth, y + m)) row = y
          // The column down to the bottom: nearest the middle, starting as high up as it's clear.
          for (let k = 0; k < innerWidth / 2 && Number.isNaN(col); k += 2) {
            for (const x of [innerWidth / 2 + k, innerWidth / 2 - k]) {
              if (!Number.isNaN(col) || x < m || x > innerWidth - m) continue
              for (let y = 90; y <= innerHeight - 40; y += 1) if (free(x - m, y - m, x + m, innerHeight)) { col = x; down = y; break }
            }
          }
          // Start the downward press on the same open row: higher taps can land among the step labels and their raised icons.
          return [['left', innerWidth / 2, row, 0, -16], ['right', innerWidth / 2, row, 0, 16], ['bottom', col, Math.max(down, row), 16, 0]]
        })
        if (ways.some((w) => Number.isNaN(w[1]) || Number.isNaN(w[2]))) throw new Error(`${name}: no clear way to an edge: ${JSON.stringify(ways)}`)
        for (const [wall, x, y, down, right] of ways) {
          await page.touchscreen.tap(x, y)
          await simWait(page, 1.4)
          await settle(page, () => tilt.tip(down, right))
          await measure(wall)
          await tilt.tip(0, 0)
        }
        // The top: onto the headline's first letter, a short hop to the line above it, and tipped away from you.
        const first = await page.evaluate(() => { const r = document.createRange(); const h = document.getElementById('hero-h'); r.setStart(h.firstChild, 0); r.setEnd(h.firstChild, 1); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height * 0.6 } })
        await page.touchscreen.tap(first.x, first.y)
        await simWait(page, 1.6)
        const line = await page.evaluate(() => { const e = document.querySelector('.hero .eyebrow').getBoundingClientRect(); return { x: e.left + 40, y: e.top + e.height / 2 } })
        await page.touchscreen.tap(line.x, line.y)
        await simWait(page, 1.4)
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
    // Hopped onto open floor (below the steps' icons, clear of everything raised).
    const open = await page.evaluate(() => { const q = document.querySelector('.quick').getBoundingClientRect(), h = document.querySelector('[data-hint]').getBoundingClientRect(); return { x: innerWidth / 2, y: (q.bottom + h.top) / 2 } })
    await page.evaluate(() => {
      window.__knockFrames = []
      let last = performance.now()
      const frame = (now) => { window.__knockFrames.push(now - last); last = now; requestAnimationFrame(frame) }
      requestAnimationFrame(frame)
    })
    const samples = []
    // The first trip warms the physics, audio clock and voice allocation. Use the median of later trips so one
    // delayed browser frame cannot turn an on-time knock into a failed product timing check.
    for (let trip = 0; trip < 4; trip++) {
      await tilt.tip(0, 0)
      await page.touchscreen.tap(open.x, open.y)
      await simWait(page, 1.6)
      const before = await audio()
      const framesAt = await page.evaluate(() => window.__knockFrames.length)
      // Tipped hard to the right: across, and a knock against the side.
      const knock = await simUntil(page, 'a knock heard', async () => { await tilt.tip(0, 20); const a = await audio(); return a.kinds.wall > before.kinds.wall && a.peakDb > -30 ? a : null }, 6, 90)
      const gaps = await page.evaluate((at) => window.__knockFrames.slice(at), framesAt)
      if (trip) samples.push({ knock, met: knock.foreseen.met - before.foreseen.met, frameGapMs: Math.round(Math.max(0, ...gaps) * 10) / 10 })
    }
    const knock = samples.at(-1).knock
    // Leaning on it, and rolling along it: no more knocks.
    await settle(page, () => tilt.tip(0, 20))
    const leaning = (await audio()).kinds.wall
    const t0 = (await sim(page)).t
    while ((await sim(page)).t - t0 < 1.5) { await tilt.tip(8, 18); await sleep(90) }
    const after = await audio()
    await ctx.close()
    if (knock.state !== 'on') throw new Error(`sound is ${knock.state}`)
    if (after.kinds.wall !== leaning) throw new Error(`${after.kinds.wall - leaning} knock(s) while leaning on the side`)
    // Started the moment it happened: nothing of ours in between (what's left is the output's own latency, and the
    // frame it was found in).
    const oursMs = median(samples.map((s) => s.knock.oursMs))
    const behindMs = samples.every((s) => s.knock.behindMs !== null) ? median(samples.map((s) => s.knock.behindMs)) : null
    const frameGapMs = median(samples.map((s) => s.frameGapMs))
    if (!(oursMs <= 10)) throw new Error(`the knock waited ${oursMs} ms on our side (median; frame gap ${frameGapMs} ms)`)
    if (behindMs !== null && behindMs > knock.baseMs + knock.outputMs + 25) throw new Error(`the knock reached the speakers ${behindMs} ms after it happened (median; latency ${knock.baseMs} + ${knock.outputMs} ms; frame gap ${frameGapMs} ms)`)
    // Where the speakers lag the screen, it was foreseen and started ahead: heard with the frame that shows it (20 ms
    // after its moment, and a frame at most).
    const met = samples.filter((s) => s.met > 0).length
    if (knock.baseMs + knock.outputMs > 30 && !(met >= 2 && behindMs !== null && behindMs <= 37)) throw new Error(`the knock wasn't heard on time: ${met}/${samples.length} foreseen, at the speakers ${behindMs} ms after it happened (median; frame gap ${frameGapMs} ms; samples ${JSON.stringify(samples.map((s) => ({ behindMs: s.knock.behindMs, met: s.met, frameGapMs: s.frameGapMs })))})`)
    return `${samples.length} knocks heard, peak ${knock.peakDb} dBFS, median start ${oursMs} ms on our side, median at the speakers ${behindMs} ms after it happened (output latency ${knock.baseMs} + ${knock.outputMs} ms; ${met}/${samples.length} foreseen; median worst frame gap ${frameGapMs} ms); none while leaning on it and rolling along it`
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
    const send = 1000 + pads.findIndex((p) => /scan a code/i.test(p)), see = 1000 + pads.findIndex((p) => /see what/i.test(p))
    // Hopped onto open floor below the buttons (below the steps' icons, clear of everything raised).
    const open = await page.evaluate(() => { const q = document.querySelector('.quick').getBoundingClientRect(), h = document.querySelector('[data-hint]').getBoundingClientRect(); return { x: innerWidth / 2, y: (q.bottom + h.top) / 2 } })
    await page.touchscreen.tap(open.x, open.y)
    await simWait(page, 1.6)
    const top = await page.evaluate(() => document.querySelector('[data-scan]').getBoundingClientRect().top)
    const path = []
    const t0 = (await sim(page)).t, end = Date.now() + 60000
    // (A clear tilt, 16°: a raised thing takes more than 13° to climb.)
    let atop = NaN
    while ((await sim(page)).t - t0 < 9 && Date.now() < end) {
      await tilt.tip(-16, 0)
      const t = await me(page)
      if (path.at(-1) !== t.on) path.push(t.on)
      if (t.on === see && Number.isNaN(atop)) atop = t.h
      if (t.y < top - 30 && path.includes(send)) break
      await sleep(90)
    }
    const acted = await page.evaluate(() => window.__acted)
    await ctx.close()
    const onSee = path.indexOf(see), onSend = path.indexOf(send)
    if (onSee < 0 || onSend < onSee) throw new Error(`it went ${path.join(' → ')} (the buttons are ${see} and ${send})`)
    if (path.at(-1) !== -1 && path.at(-1) !== -2) throw new Error(`it ended on ${path.at(-1)}`)
    if (acted) throw new Error(`a button acted ${acted} time(s)`)
    // Up on a block 0.3 em tall.
    if (!(Math.abs(atop - 0.3) < 0.02)) throw new Error(`on "${pads[see - 1000]}" it was ${atop} em up, not 0.3`)
    return `floor → "${pads[see - 1000]}" (${atop.toFixed(2)} em up) → "${pads[send - 1000]}" → floor above them; no button acted`
  })

  await check('on a phone in a noisy hand, a marble in the o, in the p, and across the r and the full stop rests dead still, with no jumps', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    await page.goto(`${local.origin}/?quality=low`)
    await field3d(page)
    await sleep(600)
    await page.locator('[data-hint]').tap()
    await page.evaluate(() => scrollTo(0, 0))
    // The raised things: the buttons, the hint, the sound control and the three steps' icons.
    const pads = await page.evaluate(() => window.__home.pads())
    if (pads.length !== 9 || pads.filter((t) => t === '').length !== 3 || !pads.includes('Scan a code') || !pads.includes('Share viewer link') || !pads.some((t) => /sound/i.test(t))) throw new Error(`raised things: ${JSON.stringify(pads)}`)
    // A hand holding the phone: 60 readings a second, each a little off (±1°), and now and then a stray one (6° off).
    await page.evaluate(() => {
      let seed = 7
      const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
      window.__hand = setInterval(() => {
        const spike = rand() < 1 / 40 ? (rand() - 0.5) * 12 : 0
        dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 40 + (rand() - 0.5) * 2 + spike, gamma: (rand() - 0.5) * 2 }))
      }, 16)
    })
    await sleep(400)
    /** Its largest move in a frame (px) over `ms`, as drawn (a jump would show here), and what holds it at the end. */
    const watch = (ms) => page.evaluate((ms) => new Promise((done) => {
      let prev = window.__home.tips().find((t) => t.id === 'me'), most = 0
      const end = performance.now() + ms
      const frame = () => {
        const t = window.__home.tips().find((q) => q.id === 'me')
        most = Math.max(most, Math.hypot(t.x - prev.x, t.y - prev.y))
        prev = t
        if (performance.now() < end) requestAnimationFrame(frame); else done({ most, held: t.held, on: t.on })
      }
      requestAnimationFrame(frame)
    }), ms)
    const seen = []
    const counters = await page.evaluate(() => window.__home.counters())
    const letters = await page.evaluate(() => { const h = document.getElementById('hero-h'); return [...h.textContent.replace(/\s+/g, '')] })
    for (const [what, i] of [['o', 1], ['p', 4]]) {
      if (letters[i] !== what) throw new Error(`letter ${i} is "${letters[i]}", not "${what}"`)
      const c = counters.find((q) => q.letter === i)
      await page.evaluate(([x, y]) => window.__home.drop(x, y), [c.x, c.y])
      await simWait(page, 3)
      const w = await watch(3000)
      if (!w.held) throw new Error(`the marble isn't sitting in the ${what}: ${JSON.stringify(w)}`)
      if (w.most > 0.1) throw new Error(`in the ${what}, it moved ${w.most.toFixed(3)} px in a frame`)
      seen.push(`${what} ${w.most.toFixed(3)} px`)
    }
    // Into the narrow gap between the r and the full stop, where it's narrowest.
    const last = letters.length - 1
    if (letters[last] !== '.' || letters[last - 1] !== 'r') throw new Error(`the headline ends "${letters.slice(-2).join('')}", not "r."`)
    const gap = (await page.evaluate(() => window.__home.gaps())).find((q) => q.a === last - 1 && q.b === last)
    if (!gap) throw new Error('no gap narrower than a marble between the r and the full stop')
    await page.evaluate(([x, y]) => window.__home.drop(x, y), [gap.x, gap.y])
    await simWait(page, 3)
    const w = await watch(3000)
    if (w.most > 0.1) throw new Error(`between the r and the full stop, it moved ${w.most.toFixed(3)} px in a frame (${JSON.stringify(w)})`)
    seen.push(`r|. ${w.most.toFixed(3)} px (${w.held ? 'held across the gap' : w.on === -1 ? 'on the floor between them' : `on raised thing or letter ${w.on}`})`)
    await page.evaluate(() => clearInterval(window.__hand))
    await ctx.close()
    return `the most it moved in a frame: ${seen.join(', ')}`
  })

  await check('the raised things are blocks 0.3 em tall, drawn as tall as the field sees them; the steps\' icons have a side, a glass top and a shadow like the sound control', async () => {
    const seen = []
    for (const [name, size] of [['390x844', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }], ['1280x800', { viewport: { width: 1280, height: 800 } }]]) {
      const ctx = await browser.newContext({ ...size, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      const page = await ctx.newPage()
      await page.goto(`${local.origin}/?quality=low`)
      await field3d(page)
      await until('the raised things drawn', () => page.evaluate(() => window.__home.steps().some((s) => s.drawn.dy > 0)), 10000)
      await sleep(300)
      const steps = await page.evaluate(() => window.__home.steps())
      const shown = steps.filter((s) => s.side)
      if (shown.length < 6) throw new Error(`${name}: ${shown.length} raised things: ${JSON.stringify(steps)}`)
      for (const s of shown) {
        // Three times the first ones (0.1 em), and drawn as the field sees them, to the half pixel.
        if (Math.abs(s.height - 0.3) > 1e-9) throw new Error(`${name}: "${s.text}" is ${s.height} em tall`)
        if (Math.abs(s.drawn.dx - s.side.dx) > 0.5 || Math.abs(s.drawn.dy - s.side.dy) > 0.5) throw new Error(`${name}: "${s.text}" drawn ${JSON.stringify(s.drawn)}, seen ${JSON.stringify(s.side)}`)
        if (s.drawn.dy < (name === '390x844' ? 3.5 : 7)) throw new Error(`${name}: "${s.text}" is drawn only ${s.drawn.dy} px tall`)
      }
      // The icons and the sound control: a glass top, and a side lighter than the floor's shadow below it.
      const look = await page.evaluate(() => [...document.querySelectorAll('.hero .quick .qi, .hero [data-sound]')].map((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el)
        const alpha = (cs.backgroundColor.match(/[\d.]+/g) ?? []).map(Number)[3] ?? 1
        return { sound: el.matches('[data-sound]'), x: r.left, y: r.top, w: r.width, h: r.height, alpha, dy: parseFloat(el.style.getPropertyValue('--pad-dy')) || 0, dx: parseFloat(el.style.getPropertyValue('--pad-dx')) || 0, shadow: cs.boxShadow }
      }))
      const shot = await page.screenshot()
      const dpr = size.deviceScaleFactor ?? 1
      const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
      const lum = (x0, y0, x1, y1) => {
        let sum = 0, n = 0
        for (let y = Math.round(y0 * dpr); y < Math.round(y1 * dpr); y++) for (let x = Math.round(x0 * dpr); x < Math.round(x1 * dpr); x++) {
          const k = (y * info.width + x) * info.channels
          sum += 0.2126 * data[k] + 0.7152 * data[k + 1] + 0.0722 * data[k + 2]; n++
        }
        return n ? sum / n : 0
      }
      const sides = []
      for (const q of look) {
        if (!q.sound && q.alpha < 0.3) throw new Error(`${name}: an icon's top is clear glass (alpha ${q.alpha})`)
        if (!/px \d/.test(q.shadow) || q.shadow === 'none') throw new Error(`${name}: no side drawn: ${q.shadow}`)
        // Its side: the band under its middle, as tall as it's drawn (leaning with it); the floor's shadow just under that.
        const mx = q.x + q.w * 0.3 + q.dx * 0.5, bw = q.w * 0.4
        const side = lum(mx, q.y + q.h + 1, mx + bw, q.y + q.h + q.dy - 1)
        const floor = lum(mx + q.dx * 0.5, q.y + q.h + q.dy + 3, mx + q.dx * 0.5 + bw, q.y + q.h + q.dy + 7)
        if (!(side > floor + 6)) throw new Error(`${name}: ${q.sound ? 'the sound control' : 'an icon'} shows no side (side ${side.toFixed(1)}, floor ${floor.toFixed(1)})`)
        sides.push(`${q.sound ? 'sound' : 'icon'} ${side.toFixed(0)}/${floor.toFixed(0)}`)
      }
      seen.push(`${name}: ${shown.length} blocks 0.3 em, drawn ${Math.min(...shown.map((s) => s.drawn.dy))}–${Math.max(...shown.map((s) => s.drawn.dy))} px tall; sides over floor ${sides.join(', ')}`)
      await ctx.close()
    }
    return seen.join('; ')
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
    const t0 = (await sim(screen)).t, end = Date.now() + 90000
    while ((await sim(screen)).t - t0 < 25 && Date.now() < end) {
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
    const on = await simUntil(screen, 'the marble resting on a letter', async () => { const t = await screen.evaluate(() => window.__home.tips().find((q) => q.id === 'me')); return t.on >= 0 ? t : null }, 8)
    await simWait(screen, 0.8)
    const later = await screen.evaluate(() => window.__home.tips().find((q) => q.id === 'me'))
    if (later.on !== on.on) throw new Error(`it rolled off letter ${on.on} onto ${later.on}`)
    if (Math.hypot(later.x - x, later.y - y) > 80) throw new Error(`it landed ${Math.hypot(later.x - x, later.y - y).toFixed(0)}px from the click`)
    return `on letter ${on.on}, ${Math.hypot(later.x - x, later.y - y).toFixed(0)}px from the click`
  })

  await check("in a letter's counter the marble rests without a tremor, and leaves when pointed away", async () => {
    // The o of "Your": a click hops the marble onto it; pointed at the middle of its counter, it goes in.
    const o = await screen.evaluate(() => { const r = document.createRange(); const h = document.getElementById('hero-h'); r.setStart(h.firstChild, 1); r.setEnd(h.firstChild, 2); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height * 0.62, w: b.width } })
    await screen.mouse.click(o.x - o.w * 0.3, o.y)
    await simWait(screen, 1.2)
    await simUntil(screen, 'the marble in the counter', async () => { await screen.mouse.move(o.x + Math.random() * 0.5, o.y); return (await me(screen)).held }, 8, 150)
    // Left there (the mouse still): it settles, and stays in the counter.
    await simWait(screen, 3.2)
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
    await field3d(screen)
    await until('the local marble', () => me(screen))
    await screen.evaluate(() => { window.__acted = 0; document.addEventListener('click', (e) => { if (e.target.closest?.('a, button')) window.__acted++ }, true); addEventListener('hashchange', () => window.__acted++) })
    const url = screen.url()
    const pads = await screen.evaluate(() => window.__home.pads())
    const i = pads.findIndex((p) => /see what it does/i.test(p))
    if (i < 0) throw new Error(`no "See what it does" among the buttons: ${pads.join(', ')}`)
    const b = await screen.locator('.cta-alt[href="#see"]').boundingBox()
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id === 'me'))
    // From the open floor beside it (a click hops the marble there: rolling, it can't get past the headline's letters)...
    const beside = { x: b.x + b.width + 130, y: b.y + b.height / 2 }
    await screen.mouse.click(beside.x, beside.y)
    await simUntil(screen, 'the marble beside the button', async () => { const t = await tip(); return t.on === -1 && Math.hypot(t.x - beside.x, t.y - beside.y) < 40 ? t : null }, 10, 200)
    // ...pointing at the button (not clicking): the marble rolls over, is helped up onto it, and comes to where it's
    // pointed (it's on it from the moment its middle is over the edge: waited for, over the button).
    const at = { x: b.x + b.width * 0.6, y: b.y + b.height / 2 }
    await screen.mouse.move(at.x, at.y, { steps: 10 })
    let last = null
    const on = await simUntil(screen, 'the marble on the button', async () => {
      await screen.mouse.move(at.x + Math.random(), at.y)
      const t = (last = await tip())
      return t.on === 1000 + i && t.x > b.x + 4 && t.x < b.x + b.width - 4 && t.y > b.y - 25 && t.y < b.y + b.height ? t : null
    }, 12, 200).catch((e) => { throw new Error(`${e.message}: the marble is at ${last?.x.toFixed(0)},${last?.y.toFixed(0)} on ${last?.on}`) })
    const lit = await until('the button lit under it', () => screen.evaluate(() => { const s = document.querySelector('.cta-alt[href="#see"]').style; const g = parseFloat(s.getPropertyValue('--orb-glow') || '0'); return g > 0.5 ? { glow: g, press: s.translate } : null }), 4000)
    const up = await simUntil(screen, 'the marble resting on its top', async () => { const t = await tip(); return t.on === 1000 + i && Math.abs(t.h - 0.3) < 0.02 ? t : null }, 4, 100)
    // Pointing below it: the marble rolls off its edge and drops to the floor.
    const below = b.y + b.height + 110
    await screen.mouse.move(at.x, below, { steps: 6 })
    const off = await simUntil(screen, 'the marble back on the floor', async () => { await screen.mouse.move(at.x + Math.random(), below); const t = await tip(); return t.on === -1 && t.y > b.y + b.height ? t : null }, 12, 200)
    const acted = await screen.evaluate(() => window.__acted)
    if (acted || screen.url() !== url) throw new Error(`the button acted: ${acted} clicks, now at ${screen.url()}`)
    return `on "${pads[i]}" at ${on.x.toFixed(0)},${on.y.toFixed(0)}, ${up.h.toFixed(2)} em up (lit ${lit.glow}, pressed ${lit.press || 'none'}), then off to ${off.x.toFixed(0)},${off.y.toFixed(0)}; no click, no navigation`
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
    const after = await simUntil(screen, 'the marble moved', async () => { const t = await tip(); return Math.hypot(t.x - before.x, t.y - before.y) > 20 ? t : null }, 5)
    if (after.x <= before.x) throw new Error(`it went left (${before.x.toFixed(0)} → ${after.x.toFixed(0)}) for a swipe right`)
    return `stick ${before.x.toFixed(0)},${before.y.toFixed(0)} → ${after.x.toFixed(0)},${after.y.toFixed(0)}, lit ${after.life.toFixed(2)}`
  })

  await check("the phone flicked upward tosses its marble, and so does a tap on its trackpad", async () => {
    const tip = () => screen.evaluate(() => window.__home.tips().find((t) => t.id !== 'me'))
    const high = async (what, go) => {
      // Settled: low and staying there (a marble still bouncing dips under 0.25 em too, and a toss that comes while
      // it's in the air only waits a moment for it to land).
      await simUntil(screen, `${what}: the marble settled`, async () => { const a = await tip(); await sleep(150); const b = await tip(); return a.h < 0.25 && Math.abs(a.h - b.h) < 0.01 }, 8)
      await go()
      // (What it did instead, if it doesn't: the highest it went, and where it was.)
      let seen = null
      try {
        return await simUntil(screen, what, async () => { const t = await tip(); if (!seen || t.h > seen.h) seen = t; return t.h > 0.3 ? t.h : null }, 5, 50)
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
    await simUntil(screen, 'the marble settled', async () => (await tip()).h < 0.25, 8)
    const before = await tip()
    // Tipped to the right: the marble rolls right.
    await phone.evaluate(() => { window.__tray.gamma = 22 })
    const after = await simUntil(screen, 'the marble rolled right', async () => { const t = await tip(); return t.x - before.x > 40 ? t : null }, 6)
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
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  if (e !== ONLY_DONE) throw e
} finally {
  for (const b of browsers.reverse()) await b.close().catch(() => {})
  if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {})
  await local.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`)
process.exit(failed ? 1 : 0)
