/**
 * The sim catalogue end to end: the catalogue page (/sim/) with its cards, previews and filter, and each device sim
 * (/sim/device/?d=<id>) driven by an emulated phone that joins by invite: through the controller that suits it, the
 * Buttons layer (a key the device binds), the tray, and Home or the phone's recentre. Served from this checkout's build
 * by the local stand-in (extension/e2e/local.mjs, on OBPAL_E2E_PORT) with the room service in production, or this
 * checkout's own worker with --local-worker (scripts/local-worker.mjs, on OBPAL_E2E_WORKER_PORT), or from
 * OBPAL_E2E_ORIGIN (a dev server) when that's set.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch. OBPAL_SHOTS=<dir> saves
 * screens. --only=<name,name> runs some: catalogue, rover, drone, maze, ptz, lamp, claw.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, devices } from 'playwright'
import { cspCheck } from './csp-watch.mjs'
import { startLocal } from '../extension/e2e/local.mjs'
import { startWorker } from './local-worker.mjs'
import { deviceExercises, exerciseDevice } from './lib/catalogue-devices.mjs'

const HEADED = process.argv.includes('--headed')
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean)
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
const wanted = (id) => !ONLY.length || ONLY.includes(id)

const worker = process.argv.includes('--local-worker') && !process.env.OBPAL_E2E_ORIGIN ? await startWorker({ port: Number(process.env.OBPAL_E2E_WORKER_PORT) || 5179 }) : null
const local = process.env.OBPAL_E2E_ORIGIN ? null : await startLocal(worker ? { upstream: worker.origin } : {})
const ORIGIN = process.env.OBPAL_E2E_ORIGIN || local.origin
const closers = []
const profiles = []
let exitCode = 0

/** A page's console errors and uncaught exceptions (a WebGL driver's shader warnings aren't errors). */
function watch(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  return errors
}

async function screenAt(path, { width = 1280, height = 800 } = {}) {
  const b = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(b)
  const context = await b.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const errors = watch(page)
  await page.goto(`${ORIGIN}${path}`)
  const invite = await until('invite link', () => page.evaluate(() => window.__obpal?.pairingUrl || ''), 20000).catch(error => {
    throw new Error(`${path}: ${error.message}; page errors: ${errors.join(' | ') || 'none'}`)
  })
  await until('device ready', () => page.evaluate(() => !!window.__device), 10000)
  return { page, invite, errors, close: () => b.close() }
}

async function phone(invite, { landscape = false } = {}) {
  const dir = await mkdtemp(joinPath(tmpdir(), 'obpal-cat-'))
  profiles.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, { ...devices[landscape ? 'Pixel 7 landscape' : 'Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(ctx)
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  const errors = watch(page)
  const cdp = await ctx.newCDPSession(page)
  // A phone held like a remote, top edge toward the screen.
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  await page.goto(invite)
  // Connected: the controller is up (the gamepad covers the tabs when the screen suggests it first).
  await page.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
  const touches = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) })
  const clear = () => page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  const centre = async (selector) => { const b = await page.locator(selector).first().boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
  /** Put a finger down on `selector`, move it by (dx, dy) over `steps`, hold it there `ms`, and lift it. */
  const drag = async (selector, dx, dy, ms = 0, steps = 12) => {
    await clear()
    const [x, y] = await centre(selector)
    await touches('touchStart', [[x, y]])
    for (let i = 1; i <= steps; i++) { await touches('touchMove', [[x + (dx * i) / steps, y + (dy * i) / steps]]); await sleep(16) }
    const end = Date.now() + ms
    // Keep the finger alive: small moves back and forth, as a real thumb makes.
    for (let k = 0; Date.now() < end; k++) { await touches('touchMove', [[x + dx + (k % 2), y + dy]]); await sleep(40) }
    await touches('touchEnd', [])
  }
  /** Press and hold `selector` with a finger for `ms`. */
  const hold = async (selector, ms) => {
    await clear()
    const at = await centre(selector)
    await touches('touchStart', [at])
    await sleep(ms)
    await touches('touchEnd', [])
  }
  const tab = async (name) => {
    await clear()
    // Leaving the gamepad shows the tabs again.
    const exit = page.locator('.gp:not([hidden]) [data-act=exit]')
    if (name !== 'gamepad' && await exit.count() && await exit.isVisible()) await exit.click()
    await page.locator(`.modes [data-tab=${name}]`).click()
  }
  const tapTray = async (label) => {
    await clear()
    const b = page.locator(`.tray-btn[aria-label="${label}"]`)
    if (!(await b.count())) throw new Error(`no "${label}" in the tray: ${JSON.stringify(await page.locator('.tray-btn').evaluateAll((l) => l.map((x) => x.getAttribute('aria-label'))))}`)
    await b.click({ timeout: 5000 })
  }
  return { page, cdp, errors, touches, drag, hold, tab, tapTray, close: () => ctx.close() }
}

const heldBy = (screen, unit) => screen.page.evaluate((u) => window.__sim.claims.holder(u) ?? null, unit)
const at = (screen, js) => screen.page.evaluate(js)

/** A device page and a phone that joined it; the phone is given a unit at once. */
async function device(id, phoneOpts) {
  const s = await screenAt(`/sim/device/?d=${id}`)
  const p = await phone(s.invite, phoneOpts)
  await until(`${id} unit held`, () => heldBy(s, `${id}1`), 15000)
  const face = await until('controller named', () => s.page.evaluate(() => window.__obpal.participants[0]?.controller), 8000)
  return { s, p, face }
}
/** No console errors or uncaught exceptions on the screen or the phone. */
async function clean(name, ...pages) {
  await check(`${name}: no errors on the screen or the phone`, async () => {
    const errors = pages.flatMap((x) => x.errors)
    if (errors.length) throw new Error(errors.join(' | '))
  })
}
/** The phone turns (its heading, degrees) in steps, as a hand turns it. */
async function turn(p, from, to, steps = 10) {
  for (let i = 1; i <= steps; i++) { await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: from + ((to - from) * i) / steps, beta: 70, gamma: 0 }); await sleep(40) }
}

try {
  console.log('ob.Pal sim catalogue e2e')

  // ---- the catalogue page ----
  if (wanted('catalogue')) {
    const b = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
    closers.push(b)
    const page = await (await b.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })).newPage()
    const pageErrors = watch(page)
    await check('catalogue: every sim has a card, and their previews come alive', async () => {
      await page.goto(`${ORIGIN}/sim/`)
      const cards = await until('cards', () => page.evaluate(() => window.__sims?.cards().length), 10000)
      if (cards < 41) throw new Error(`only ${cards} cards`)
      await until('a live preview', () => page.evaluate(() => document.querySelectorAll('.dcard-stage.live').length), 15000)
      const live = await page.evaluate(() => document.querySelectorAll('.dcard-stage.live').length)
      return `${cards} cards, ${live} previews live`
    })
    await check('catalogue: every new device has a live preview on the shared renderer', async () => {
      for (const id of ['boat', 'studio', ...deviceExercises.map(e => e.id)]) {
        const card = page.locator(`.dcard[data-id="${id}"]`)
        await card.scrollIntoViewIfNeeded()
        await until(`${id} preview`, () => card.locator('.dcard-stage.live').count(), 15000)
        if (await card.locator('.dcard-go').getAttribute('href') !== `/sim/device/?d=${id}`) throw new Error(`${id} link`)
      }
      await page.locator('.sims-chip[data-face=""]').scrollIntoViewIfNeeded()
    })
    await check('catalogue: a controller filters the cards, and the address keeps it', async () => {
      await page.locator('.sims-chip[data-face="face.keyboard"]').click()
      const only = await page.evaluate(() => window.__sims.cards())
      if (only.join() !== 'lamp') throw new Error(`the keyboard shows ${only}`)
      if (!page.url().endsWith('?face=keyboard')) throw new Error(page.url())
      await page.locator('.sims-chip[data-face="face.wii"]').click()
      const wii = await page.evaluate(() => window.__sims.cards())
      if (wii.includes('maze') || !wii.includes('ptz')) throw new Error(`the Wii remote shows ${wii}`)
      await page.goto(`${ORIGIN}/sim/?face=hand`)
      const hand = await until('filtered on load', () => page.evaluate(() => window.__sims?.cards()), 8000)
      if (hand.includes('rover') || !hand.includes('drone')) throw new Error(`the 3D hand shows ${hand}`)
      await page.locator('.sims-chip[data-face=""]').click()
      return `keyboard: ${only}; Wii: ${wii.length} sims; 3D hand: ${hand.join(', ')}`
    })
    await check('catalogue: category, search and controller combine in shareable URLs and browser history', async () => {
      await page.goto(`${ORIGIN}/sim/?category=vehicles&face=wheel&q=harbour`)
      await until('the shared search', () => page.evaluate(() => window.__sims?.cards().join() === 'boat'))
      if (await page.locator('#search').inputValue() !== 'harbour') throw new Error('search was not restored')
      await page.locator('#search').fill('rudder')
      await until('search in URL', () => page.url().includes('q=rudder')).catch(e => { throw new Error(`${e.message}: ${page.url()}`) })
      if ((await page.evaluate(() => window.__sims.cards())).join() !== 'boat') throw new Error('activity search did not intersect')
      await page.locator('[data-category="home"]').click()
      if (await page.evaluate(() => window.__sims.cards().length)) throw new Error('category did not combine')
      if (!(await page.locator('#none').isVisible())) throw new Error('empty view missing')
      await page.goBack()
      await until('back to the boat', () => page.evaluate(() => window.__sims.cards().join() === 'boat'))
      if (await page.locator('[data-category="vehicles"]').getAttribute('aria-pressed') !== 'true') throw new Error('category did not restore')
      await page.goForward()
      await until('forward to the empty view', () => page.locator('#none').isVisible())
      await page.locator('#clear-filters').click()
      if (new URL(page.url()).search) throw new Error('clear left URL filters')
    })
    await check('catalogue: the studio is in Music, Featured and New, with searchable Drums and Keys filters', async () => {
      await page.goto(`${ORIGIN}/sim/?q=drums`)
      await until('drums finds the studio', () => page.evaluate(() => window.__sims?.cards().join() === 'studio'))
      const card = page.locator('.dcard[data-id="studio"]')
      if (!(await card.textContent()).includes('Music studio')) throw new Error('studio card missing its name')
      await until('studio preview', () => card.locator('.dcard-stage.live').count())
      for (const category of ['music', 'featured', 'new']) {
        await page.locator(`[data-category="${category}"]`).click()
        for (const face of ['drums', 'keys']) {
          await page.locator(`.sims-chip[data-face="face.${face}"]`).click()
          await until('studio filters applied', () => page.evaluate(() => window.__sims.cards().join() === 'studio'))
          const params = new URL(page.url()).searchParams
          if (params.get('category') !== category || params.get('face') !== face || params.get('q') !== 'drums') throw new Error('studio filter URL lost state')
        }
      }
      await page.reload()
      await until('studio filters restored', () => page.evaluate(() => window.__sims?.cards().join() === 'studio'))
      if (await page.locator('#search').inputValue() !== 'drums') throw new Error('studio search was not restored')
      if (await page.locator('.sims-chip[data-face="face.keys"]').getAttribute('aria-pressed') !== 'true') throw new Error('Keys filter was not restored')
      await page.locator('#clear-filters').click()
      await page.locator('[data-category="music"]').click()
      if ((await page.evaluate(() => window.__sims.cards())).join() !== 'studio') throw new Error('Music category did not show the studio')
    })
    await check('catalogue: wave 4b is searchable within its categories and controllers', async () => {
      const rows = [['football', 'games', 'gamepad', 'Table football'], ['marblerun', 'games', 'trackpad', 'Marble run'], ['planetary', 'space-science', 'gamepad', 'Planetary rover'], ['telescope', 'space-science', 'wii', 'Telescope mount'], ['pendulum', 'space-science', 'trackpad', 'Pendulum lab'], ['trebuchet', 'space-science', 'trackpad', 'Trebuchet'], ['slider', 'camera-stage', 'trackpad', 'Camera slider'], ['jib', 'camera-stage', 'gamepad', 'Jib crane']]
      for (const [id, category, face, q] of rows) {
        await page.goto(`${ORIGIN}/sim/?${new URLSearchParams({ category, face, q })}`)
        await until(`${id} filtered card`, () => page.evaluate(id => window.__sims?.cards().join() === id, id))
        await until(`${id} filtered preview`, () => page.locator(`.dcard[data-id="${id}"] .dcard-stage.live`).count())
      }
    })
    await check('catalogue: one renderer, only visible previews, at most 30 fps, and resizable reduced-motion stills', async () => {
      await page.goto(`${ORIGIN}/sim/`)
      await page.waitForSelector('.dcard-stage.live')
      await page.evaluate(() => scrollTo(0, 0))
      await page.waitForTimeout(300)
      const stats = () => page.evaluate(() => window.__sims.previews())
      const before = await stats()
      if (before.renderers !== 1) throw new Error(`${before.renderers} renderers`)
      const start = Date.now()
      await page.waitForTimeout(1000)
      const after = await stats(), max = Math.ceil((Date.now() - start) * 30 / 1000) + 1
      for (const a of after.cards) {
        const b = before.cards.find(c => c.id === a.id)
        if (a.frames - b.frames > max) throw new Error(`${a.id} exceeded 30 fps`)
        if (!a.visible && !b.visible && a.frames !== b.frames) throw new Error(`${a.id} drew offscreen`)
      }
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(150)
      const still = await stats()
      await page.waitForTimeout(250)
      if (JSON.stringify((await stats()).cards.map(c => c.frames)) !== JSON.stringify(still.cards.map(c => c.frames))) throw new Error('stills animated')
      await page.setViewportSize({ width: 390, height: 844 })
      await until('resized still', async () => (await stats()).cards.some(c => c.visible && c.frames > still.cards.find(b => b.id === c.id).frames))
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('mobile horizontal overflow')
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.emulateMedia({ reducedMotion: 'no-preference' })
    })
    await check('catalogue: each controller\'s count is the cards it shows; each kind of arm has a card, and its Try it opens the arm sim as that kind', async () => {
      // Every chip's number is how many cards it leaves showing.
      const chips = await page.evaluate(() => [...document.querySelectorAll('.sims-chip')].map((b) => ({ face: b.dataset.face, n: Number(b.querySelector('i').textContent) })))
      for (const c of chips) {
        await page.evaluate((f) => window.__sims.setFace(f || null), c.face)
        const shown = (await page.evaluate(() => window.__sims.cards())).length
        if (shown !== c.n) throw new Error(`${c.face || 'All'} says ${c.n}, shows ${shown}`)
      }
      await page.evaluate(() => window.__sims.setFace(null))
      const arms = (await page.evaluate(() => window.__sims.cards())).filter((id) => id.startsWith('arm-'))
      if (arms.length !== 6) throw new Error(`arm cards: ${arms}`)
      // The arm cards' previews play (each one as it scrolls into view).
      await page.locator('.dcard[data-id="arm-delta"]').scrollIntoViewIfNeeded()
      await until('the arm previews live', () => page.evaluate(() => [...document.querySelectorAll('.dcard[data-id^="arm-"] .dcard-stage.live')].length >= 2), 15000)
      const href = await page.locator('.dcard[data-id="arm-scara"] .dcard-go').getAttribute('href')
      await page.locator('.dcard[data-id="arm-scara"] .dcard-go').click()
      await page.waitForURL(/\/sim\/arm\/\?kind=scara/)
      const kind = await until('the arm sim', () => page.evaluate(() => window.__arm?.kind?.().id), 15000)
      if (kind !== 'scara') throw new Error(`opened ${kind}`)
      await page.goBack()
      await until('the catalogue again', () => page.evaluate(() => window.__sims?.cards().length), 10000)
      return `${chips.map((c) => `${c.face ? c.face.slice(5) : 'all'} ${c.n}`).join(', ')}; ${arms.join(', ')}; Try it: ${href}`
    })
    await check('catalogue: Try it opens the sim, its pairing chip waiting for a phone', async () => {
      await page.locator('.dcard[data-id="rover"] .dcard-go').click()
      await page.waitForURL(/\/sim\/device\/\?d=rover/)
      await until('pairing', () => page.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
      return page.url().replace(ORIGIN, '')
    })
    await check('catalogue: no errors', async () => { if (pageErrors.length) throw new Error(pageErrors.join(' | ')) })
    await b.close()
  }

  // ---- rover: the steering wheel, the trackpad, the tray and a keyboard's H ----
  if (wanted('rover')) {
    const { s, p, face } = await device('rover')
    const rover = () => at(s, () => { const r = window.__device.logic.rovers[0]; return { x: r.x, z: r.z, h: r.h, v: r.v } })
    await check('rover: a phone that joins drives a free rover at once, on the steering wheel', async () => {
      if (face !== 'face.wheel') throw new Error(`opened on ${face}`)
      return `holds rover1, on ${face}`
    })
    await check('rover, steering wheel: holding RT drives forward, and it coasts to a stop', async () => {
      const before = await rover()
      await p.hold('.gp-trig[data-trig="1"]', 800)
      const after = await rover()
      const went = Math.hypot(after.x - before.x, after.z - before.z)
      if (went < 0.3 || after.z > before.z) throw new Error(`moved ${went.toFixed(2)} m: ${JSON.stringify({ before, after })}`)
      await until('stopped', async () => Math.abs((await rover()).v) < 0.05, 6000)
      return `${went.toFixed(2)} m forward while held, then stopped`
    })
    await check('rover, steering wheel: Driving switches Steer on, and tilting the phone steers', async () => {
      const lit = await p.page.getAttribute('.gp-chip[data-chip="motion.steer"]', 'aria-pressed')
      if (lit !== 'true') throw new Error(`the Steer chip reads ${lit}`)
      const steer = () => at(s, () => window.__device.logic.rovers[0].steer)
      const rest = await steer()
      if (Math.abs(rest) > 0.01) throw new Error(`steering ${rest.toFixed(3)} rad with the phone held still`)
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 20 })
      const right = await until('wheels turned right', async () => { const v = await steer(); return v > 0.05 ? v : null }, 4000)
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: -20 })
      const left = await until('wheels turned left', async () => { const v = await steer(); return v < -0.05 ? v : null }, 4000)
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
      await until('straight again', async () => Math.abs(await steer()) < 0.01, 4000)
      return `wheels ${right.toFixed(2)} and ${left.toFixed(2)} rad for the phone tilted 20° each way`
    })
    await check('rover, trackpad: a thumb dragged forward drives, dragged aside steers', async () => {
      await p.tab('rotate')
      await p.tapTray('Home')
      await sleep(300)
      const before = await rover()
      await p.drag('#pad', 60, -80, 1400)
      const after = await rover()
      const went = Math.hypot(after.x - before.x, after.z - before.z)
      if (went < 0.5) throw new Error(`moved ${went.toFixed(2)} m; the screen saw ${JSON.stringify(await at(s, () => window.__device.seen))}`)
      if (!(after.h < before.h - 0.1)) throw new Error(`didn't turn right: heading ${before.h.toFixed(2)} → ${after.h.toFixed(2)}`)
      return `${went.toFixed(2)} m, heading ${before.h.toFixed(2)} → ${after.h.toFixed(2)} rad`
    })
    await check('rover, Buttons: a keyboard’s H honks (key:KeyH → tray:horn), and Home parks it', async () => {
      await p.page.keyboard.press('KeyH')
      await until('honk', () => at(s, () => window.__device.logic.rovers[0].honk > 0), 3000)
      await p.tapTray('Home')
      await until('parked', async () => { const r = await rover(); return Math.hypot(r.x - -2.25, r.z - 1.7) < 0.01 }, 3000)
      return 'honked, parked'
    })
    await check('rover: a second phone gets the next rover, and the screen shows who drives which with what', async () => {
      const q = await phone(s.invite)
      await until('rover 2 held', () => heldBy(s, 'rover2'), 15000)
      const rows = await until('two held rows', () => at(s, () => { const r = [...document.querySelectorAll('#dev-units li.held')]; return r.length === 2 && r.map((li) => li.querySelector('small').textContent) }), 5000)
      await q.close()
      await until('rover 2 free again', async () => !(await heldBy(s, 'rover2')), 8000)
      return rows.join(' · ')
    })
    if (SHOTS) await s.page.screenshot({ path: joinPath(SHOTS, 'e2e-rover.png') })
    await clean('rover', s, p)
    await p.close()
    await s.close()
  }

  // ---- drone: the gamepad (A takes off, the right stick flies, Guide flies it home) ----
  if (wanted('drone')) {
    const { s, p, face } = await device('drone', { landscape: true })
    const drone = () => at(s, () => { const d = window.__device.logic.drones[0]; return { x: d.x, y: d.y, z: d.z, phase: d.phase } })
    await check('drone, gamepad: A takes off to a hover', async () => {
      if (face !== 'face.gamepad') throw new Error(`opened on ${face}`)
      await p.hold('.gp-f[data-k="a"]', 150)
      await until('flying', async () => (await drone()).phase === 'flying', 6000)
      return `hovering at ${(await drone()).y.toFixed(2)} m`
    })
    await check('drone, gamepad: Flight switches Steer on, and tipping the phone forward flies it forward', async () => {
      const lit = await p.page.getAttribute('.gp-chip[data-chip="motion.steer"]', 'aria-pressed')
      if (lit !== 'true') throw new Error(`the Steer chip reads ${lit}`)
      const before = await drone()
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 90, gamma: 0 })
      await sleep(900)
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
      const after = await drone()
      if (!(after.z < before.z - 0.3)) throw new Error(`z ${before.z.toFixed(2)} → ${after.z.toFixed(2)}`)
      await sleep(600)
      return `${(before.z - after.z).toFixed(2)} m forward`
    })
    await check('drone, gamepad: the right stick pushed up flies it forward', async () => {
      const before = await drone()
      await p.drag('.gp-stick[data-stick="1"]', 0, -60, 900)
      const after = await drone()
      if (!(after.z < before.z - 0.4)) throw new Error(`z ${before.z.toFixed(2)} → ${after.z.toFixed(2)}`)
      return `${(before.z - after.z).toFixed(2)} m forward`
    })
    await check('drone, 3D hand: with a thumb on the pad, swinging the phone left flies it left', async () => {
      await p.tab('track')
      if (await p.page.locator('#track-start').isVisible()) throw new Error('3D from the phone’s own motion shouldn’t need a start')
      const before = await drone()
      const box = await p.page.locator('#pad').boundingBox()
      await p.touches('touchStart', [[box.x + box.width / 2, box.y + box.height / 2]])
      await sleep(300)
      await turn(p, 10, 40, 10)
      await sleep(1500)
      const after = await drone()
      await p.touches('touchEnd', [])
      await turn(p, 40, 10, 4)
      if (!(after.x < before.x - 0.3)) throw new Error(`x ${before.x.toFixed(2)} → ${after.x.toFixed(2)}; the screen saw ${JSON.stringify(await at(s, () => window.__device.seen))}`)
      return `phone swung 30° left → drone ${(before.x - after.x).toFixed(2)} m left`
    })
    await check('drone: Guide flies it home and it lands on its pad', async () => {
      await p.tab('gamepad')
      await p.hold('.gp-guide', 150)
      await until('going home', async () => ['home', 'landing'].includes((await drone()).phase), 3000)
      await until('landed', async () => (await drone()).phase === 'landed', 15000)
      const d = await drone()
      const home = await at(s, () => window.__device.logic.drones[0].home)
      if (Math.hypot(d.x - home[0], d.z - home[1]) > 0.2) throw new Error(`landed at ${d.x.toFixed(2)}, ${d.z.toFixed(2)}`)
      return 'landed on its pad'
    })
    if (SHOTS) await s.page.screenshot({ path: joinPath(SHOTS, 'e2e-drone.png') })
    await clean('drone', s, p)
    await p.close()
    await s.close()
  }

  // ---- maze: the trackpad tips the board ----
  if (wanted('maze')) {
    const { s, p, face } = await device('maze')
    const board = () => at(s, () => { const b = window.__device.logic.boards[0]; return { tx: b.tx, mx: b.mx, mz: b.mz } })
    await check('maze, trackpad: a thumb dragged right tips the board, and the marble rolls right', async () => {
      if (face !== 'face.trackpad') throw new Error(`opened on ${face}`)
      const before = await board()
      let tipped = 0
      const dragging = p.drag('#pad', 70, 0, 1500)
      for (let i = 0; i < 5; i++) { await sleep(250); tipped = Math.max(tipped, (await board()).tx) }
      await dragging
      const after = await board()
      if (tipped < 0.05) throw new Error(`the board tipped ${tipped.toFixed(3)} rad`)
      if (!(after.mx > before.mx + 0.02)) throw new Error(`marble x ${before.mx.toFixed(3)} → ${after.mx.toFixed(3)}`)
      return `tipped ${(tipped * 57.3).toFixed(1)}°, the marble rolled ${((after.mx - before.mx) * 100).toFixed(1)} cm`
    })
    await check('maze: Home puts the marble back at the start, the board flat', async () => {
      await p.tapTray('Home')
      const start = await at(s, () => window.__device.logic.maze.start)
      await until('reset', async () => { const b = await board(); return Math.abs(b.mx - start[0]) < 1e-6 && Math.abs(b.mz - start[1]) < 1e-6 }, 3000)
      return 'back at the start'
    })
    if (SHOTS) await s.page.screenshot({ path: joinPath(SHOTS, 'e2e-maze.png') })
    await clean('maze', s, p)
    await p.close()
    await s.close()
  }

  // ---- PTZ camera: the Wii remote points it, A takes a picture, ⌂ centres it ----
  if (wanted('ptz')) {
    const { s, p, face } = await device('ptz')
    const cam = () => at(s, () => { const c = window.__device.logic.cams[0]; return { pan: c.pan, home: c.home[0], shots: c.shots } })
    await check('PTZ, Wii remote: turning the phone left turns the camera left', async () => {
      if (face !== 'face.wii') throw new Error(`opened on ${face}`)
      await sleep(600)
      const before = await cam()
      await turn(p, 10, 30)
      await sleep(1200)
      const after = await cam()
      if (!(after.pan > before.pan + 0.15)) throw new Error(`pan ${before.pan.toFixed(3)} → ${after.pan.toFixed(3)}; the screen saw ${JSON.stringify(await at(s, () => window.__device.seen))}`)
      return `phone 20° left → camera ${((after.pan - before.pan) * 57.3).toFixed(1)}° left`
    })
    await check('PTZ: A takes a picture, and ⌂ brings the camera back to the middle', async () => {
      await p.page.locator('#wii-a').click()
      await until('a picture', async () => (await cam()).shots === 1, 3000)
      await p.page.locator('#wii-home').click()
      await until('centred', async () => { const c = await cam(); return Math.abs(c.pan - c.home) < 0.02 }, 4000)
      return 'one picture, then centred'
    })
    if (SHOTS) await s.page.screenshot({ path: joinPath(SHOTS, 'e2e-ptz.png') })
    await clean('PTZ', s, p)
    await p.close()
    await s.close()
  }

  // ---- lamps: the trackpad colours one, a tap switches it, the keyboard types a colour ----
  if (wanted('lamp')) {
    const { s, p, face } = await device('lamp')
    const lamp = () => at(s, () => { const l = window.__device.logic.lamps[0]; return { h: l.h, on: l.on, v: l.v } })
    await check('lamps, trackpad: dragging across turns the colour, a tap switches it off', async () => {
      if (face !== 'face.trackpad') throw new Error(`opened on ${face}`)
      const before = await lamp()
      await p.drag('#pad', 120, 0, 200)
      const after = await lamp()
      const turned = (after.h - before.h + 360) % 360
      if (turned < 20) throw new Error(`hue ${before.h.toFixed(0)} → ${after.h.toFixed(0)}`)
      await p.hold('#pad', 60)
      await until('off', async () => !(await lamp()).on, 3000)
      return `hue +${turned.toFixed(0)}°, then off`
    })
    await check('lamps, keyboard: "teal" shows on the lamp as it’s typed, and Enter makes it teal (and on)', async () => {
      await p.tapTray('Keyboard')
      await p.page.locator('#kbd-text').waitFor({ state: 'visible', timeout: 4000 })
      await p.page.locator('#kbd-text').pressSequentially('teal', { delay: 60 })
      await until('shown as typed', () => at(s, () => document.querySelector('.lamp-typing:not([hidden])')?.textContent === 'teal'), 3000)
      await p.page.keyboard.press('Enter')
      await until('teal', async () => { const l = await lamp(); return l.on && Math.abs(l.h - 174) < 1 }, 3000)
      return 'teal'
    })
    await check('lamps, air mouse: pointing at another lamp and pressing Left takes it (CATALOGUE §5), the wheel dims it', async () => {
      await p.page.keyboard.press('Escape')
      await p.tab('point')
      await p.page.locator('#mouse-left').waitFor({ state: 'visible', timeout: 4000 })
      await p.page.locator('#mouse-home').click()
      await sleep(400)
      // Aim at the pendant: the pointer is where the phone points, x = cx + tan(yaw)·K (CATALOGUE §4).
      const aim = await at(s, () => {
        const q = window.__device.anchorOnScreen(2)
        const K = innerWidth / 2 / Math.tan((16 * Math.PI) / 180)
        return { yaw: (Math.atan((q.x - innerWidth / 2) / K) * 180) / Math.PI, pitch: (Math.atan((innerHeight / 2 - q.y) / K) * 180) / Math.PI }
      })
      for (let i = 1; i <= 8; i++) { await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10 - (aim.yaw * i) / 8, beta: 70 + (aim.pitch * i) / 8, gamma: 0 }); await sleep(40) }
      await sleep(600)
      await p.hold('#mouse-left', 120)
      await until('pendant taken', async () => (await heldBy(s, 'lamp3')) !== null, 4000).catch(async (e) => {
        throw new Error(`${e.message}: aimed ${aim.yaw.toFixed(1)}°, ${aim.pitch.toFixed(1)}°; the screen saw ${JSON.stringify(await at(s, () => window.__device.seen))}`)
      })
      const v0 = await at(s, () => window.__device.logic.lamps[2].v)
      const w = await p.page.locator('#mouse-wheel').boundingBox()
      await p.touches('touchStart', [[w.x + w.width / 2, w.y + w.height / 2]])
      for (let i = 1; i <= 10; i++) { await p.touches('touchMove', [[w.x + w.width / 2, w.y + w.height / 2 + i * 6]]); await sleep(24) }
      await p.touches('touchEnd', [])
      await sleep(600)
      const v1 = await at(s, () => window.__device.logic.lamps[2].v)
      if (!(Math.abs(v1 - v0) > 0.05)) throw new Error(`brightness ${v0.toFixed(2)} → ${v1.toFixed(2)}`)
      return `took the pendant; the wheel set it ${Math.round(v0 * 100)}% → ${Math.round(v1 * 100)}%`
    })
    if (SHOTS) await s.page.screenshot({ path: joinPath(SHOTS, 'e2e-lamp.png') })
    await clean('lamps', s, p)
    await p.close()
    await s.close()
  }

  // ---- claw machine: the Wii remote moves the claw, A drops it ----
  if (wanted('claw')) {
    const { s, p, face } = await device('claw')
    const claw = () => at(s, () => { const c = window.__device.logic.claws[0]; return { x: c.x, z: c.z, phase: c.phase } })
    await check('claw, Wii remote: pointing moves the claw over the pit', async () => {
      if (face !== 'face.wii') throw new Error(`opened on ${face}`)
      await sleep(800)
      const before = await claw()
      await turn(p, 10, 22, 8)
      await sleep(1500)
      const after = await claw()
      const moved = Math.hypot(after.x - before.x, after.z - before.z)
      if (moved < 0.05) throw new Error(`moved ${moved.toFixed(3)} m; the screen saw ${JSON.stringify(await at(s, () => window.__device.seen))}`)
      return `${(moved * 100).toFixed(0)} cm`
    })
    await check('claw: A drops it; it closes, lifts and comes back ready', async () => {
      await p.page.locator('#wii-a').click()
      await until('dropping', async () => (await claw()).phase === 'drop', 3000)
      await until('ready again', async () => (await claw()).phase === 'idle', 15000)
      return await at(s, () => window.__device.logic.readout(0))
    })
    if (SHOTS) await s.page.screenshot({ path: joinPath(SHOTS, 'e2e-claw.png') })
    await clean('claw', s, p)
    await p.close()
    await s.close()
  }
  if (wanted('boat')) {
    const { s, p, face } = await device('boat')
    const state = () => at(s, () => window.__device.logic.units[0])
    await check('boat: the wheel powers the launch through the harbour', async () => {
      if (face !== 'face.wheel') throw new Error(`opened on ${face}`)
      const before = await state()
      await p.hold('.gp-trig[data-trig="1"]', 1000)
      if ((await state()).z >= before.z - 0.25) throw new Error('the launch did not move forward')
    })
    await check('boat: H sounds the horn and Guide returns to the dock', async () => {
      await p.page.keyboard.press('KeyH')
      await until('horn', async () => (await state()).horn > 0)
      await p.hold('.gp-guide', 100)
      await until('docked', async () => Math.abs((await state()).z - 1) < 0.02)
    })
    await clean('boat', s, p)
    await p.close(); await s.close()
  }
  for (const e of deviceExercises) if (wanted(e.id)) await exerciseDevice(e, { device, phone, heldBy, check, at, until, turn, clean })
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await Promise.allSettled(closers.map((c) => c.close()))
  await local?.close()
  await worker?.close()
  await Promise.allSettled(profiles.map((d) => rm(d, { recursive: true, force: true })))
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)
