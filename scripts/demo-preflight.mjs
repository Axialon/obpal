/**
 * Is the live site ready to present? The run a presenter makes in the last hour, as a visitor and read only: it opens the
 * home page, issues a pairing code, joins an emulated phone, takes the controller through its modes, loads the Viewer and
 * three flagship sims, opens a watch link, relays a DataChannel through TURN, and fetches what /link/ and Desktop's page
 * offer. It prints one PASS/FAIL table with the time each check took, and keeps screenshots and results.json.
 *   web      the service answers; /link/ offers the store and the manual zip, the zip downloads and matches the latest
 *            release; Desktop's page offers its Windows zip, which downloads (nothing is run)
 *   home     the home page loads and draws its marbles; a pairing QR and code are issued; a phone joins, the controller
 *            takes each of its modes, and a swipe on its trackpad moves the phone's marble
 *   viewer   the Viewer loads with a model, draws a frame, issues a code; a phone joins and takes its modes; TURN offers
 *            a relay, and a DataChannel forced through it opens and echoes
 *   sims     each sim starts (no "could not be loaded" card), draws a frame and issues a code; on the first that does,
 *            a watch link opens as a guest, and a phone joins and a push on its stick reads on the sim
 *
 *   pnpm run demo:preflight [-- --origin <url>] [--sims drone,humanoid,arm] [--only web,home,viewer,sims]
 *                           [--out <dir>] [--budget <seconds>] [--without-beacon]
 * Sims by short name (scripts/lib/preflight.mjs) or by path (sim/kart/). --budget (300): checks past it are skipped.
 * --without-beacon is a diagnostic: it removes Cloudflare's analytics script from the pages the test browser loads, to
 * show what a run would find with that injection off. The default sees the pages as a visitor does.
 *
 * The room service is the live one, so the run opens a handful of ordinary rooms (each lasts until its page closes) and
 * writes nothing else there. Rendering is software (as check:live's): frame rates say that the scene runs, not how fast
 * the presenter's own screen will. The browser: OBPAL_E2E_CHROMIUM, else Playwright's own Chromium. Evidence goes to
 * artifacts/demo-preflight/<time>/ unless --out. No pairing link or watch link is printed or kept: only the masked code.
 *
 * ob.Pal Desktop guard. A test browser must never reach an installed ob.Pal Desktop. As the e2e runner does, the run reads
 * the helper's log (%APPDATA%\obpal\desktop.log, or OBPAL_DESKTOP_LOG), read only, before and after, and says whether it
 * gained a line naming a test browser. Exit codes: 0 ready, 1 not ready, 2 bad arguments, 3 the guard tripped.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'
import sharp from 'sharp'
import { resolveChromium, shortPath } from './lib/browser.mjs'
import { LINK_STORE, LINK_ZIP, latestRelease, linkInstallChecks, linkVersionLabel, releaseChecks, LINK_REPO, shownCode, turnChecks } from './lib/live.mjs'
import { deepText, probeRelay, watchIce } from './lib/live-browser.mjs'
import { brief, beaconInjected, desktopZipHref, drawn, frameLook, guardLine, isZip, parseArgs, seconds, simTarget, stripBeacon, verdict } from './lib/preflight.mjs'
import { formatTable } from './lib/report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
let opts
try {
  opts = parseArgs(process.argv.slice(2), process.env)
} catch (e) {
  console.error(`demo:preflight: ${e.message}`)
  process.exit(2)
}
if (opts.help) {
  console.log('pnpm run demo:preflight [-- --origin <url>] [--sims drone,humanoid,arm] [--only web,home,viewer,sims] [--out <dir>] [--budget <seconds>] [--without-beacon]')
  process.exit(0)
}
const ORIGIN = opts.origin
const sims = opts.sims.map(simTarget)
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const out = resolve(opts.out || join(root, 'artifacts', 'demo-preflight', stamp))
mkdirSync(out, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const t0 = Date.now()
const deadline = t0 + opts.budgetS * 1000

// ---- the helper's log, for the guard -------------------------------------------------------------------------------
const desktopLog = process.env.OBPAL_DESKTOP_LOG || (process.env.APPDATA ? join(process.env.APPDATA, 'obpal', 'desktop.log') : '')
const readLog = () => { try { return readFileSync(desktopLog) } catch { return null } }
const logAtStart = desktopLog ? readLog() : null

// ---- rows ----------------------------------------------------------------------------------------------------------
const GLYPH = { pass: 'pass', FAIL: 'FAIL', WARN: 'warn', skip: 'skip' }
function record(part, check, status, ms, detail) {
  rows.push({ part, check, status, ms, detail })
  console.log(`  ${GLYPH[status].padEnd(4)}  ${seconds(ms).padStart(6)}  ${part} · ${check}${detail ? ` — ${detail}` : ''}`)
}

/**
 * One check. `fn` returns { status?, detail?, ...anything the next check wants }, or throws (a FAIL naming why). Past the
 * budget it isn't run: a check that didn't run says so.
 */
async function step(part, check, fn) {
  if (Date.now() > deadline) { record(part, check, 'skip', 0, `over the ${opts.budgetS} s budget`); return { status: 'skip' } }
  const s = Date.now()
  let r
  try { r = (await fn()) ?? {} } catch (e) { r = { status: 'FAIL', detail: brief(e) } }
  record(part, check, r.status ?? 'pass', Date.now() - s, r.detail ?? '')
  return { status: 'pass', ...r }
}
const skip = (part, check, why) => record(part, check, 'skip', 0, why)
/** Whether a check held (a warning holds), for the checks that hang on it. */
const ok = (r) => r?.status === 'pass' || r?.status === 'WARN'

// ---- plain requests (the web part) ---------------------------------------------------------------------------------
const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml' }
const get = (url, init = {}) => fetch(url, { signal: AbortSignal.timeout(20_000), ...init })

/** The start of a file and its size, without keeping the rest: for a download that should be a zip. */
async function peek(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 30_000)
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] } })
    if (!res.ok) return { status: res.status }
    const reader = res.body.getReader()
    const first = (await reader.read()).value ?? new Uint8Array()
    await reader.cancel().catch(() => {})
    return { status: res.status, zip: isZip(first), size: Number(res.headers.get('content-length')) || 0 }
  } finally { clearTimeout(timer) }
}
const mb = (n) => (n ? `${(n / 1e6).toFixed(1)} MB` : 'size not given')

async function webPart() {
  await step('web', 'service answers', async () => {
    const r = await get(`${ORIGIN}/api/health`)
    const body = await r.json().catch(() => null)
    if (r.status !== 200 || body?.service !== 'obpal') throw new Error(`/api/health gave HTTP ${r.status}`)
    return { detail: `/api/health, protocol ${body.proto}` }
  })
  await step('web', 'Cloudflare beacon', async () => {
    const html = await (await get(`${ORIGIN}/sim/drone/`, { headers: BROWSER_HEADERS })).text()
    return beaconInjected(html)
      ? { status: 'WARN', detail: 'injected into pages and blocked by our policy (a console error); a sim that reads the block as a failed start shows "could not be loaded"' }
      : { detail: 'no analytics script added to sim pages' }
  })
  let linkHtml = ''
  await step('web', '/link/ install links', async () => {
    const r = await get(`${ORIGIN}/link/`)
    if (r.status !== 200) throw new Error(`/link/ gave HTTP ${r.status}`)
    linkHtml = await r.text()
    const bad = linkInstallChecks(linkHtml).filter((c) => c.status !== 'pass')
    if (bad.length) throw new Error(`${bad.map((c) => c.check).join(', ')} missing`)
    return { detail: `store and manual zip links, version ${linkVersionLabel(linkHtml) ?? 'not shown'}` }
  })
  await step('web', 'Link zip downloads', async () => {
    const f = await peek(LINK_ZIP)
    if (f.status !== 200 || !f.zip) throw new Error(`the manual zip gave HTTP ${f.status}${f.status === 200 ? ' and is no zip' : ''}`)
    return { detail: `HTTP 200, a zip, ${mb(f.size)}` }
  })
  await step('web', 'Link version matches its release', async () => {
    const api = await get(`https://api.github.com/repos/${LINK_REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'obpal-demo-preflight' } })
    if (!api.ok) return { status: 'WARN', detail: `GitHub gave HTTP ${api.status}; the page's version was not compared` }
    const release = latestRelease(await api.json().catch(() => null))
    const found = releaseChecks({ label: linkVersionLabel(linkHtml), release, http: api.status })
    const bad = found.find((c) => c.status === 'FAIL')
    if (bad) throw new Error(`${bad.check}: ${bad.detail}`)
    return { detail: found.map((c) => c.detail).join('; ') }
  })
  await step('web', 'Chrome Web Store listing', async () => {
    const r = await get(LINK_STORE, { headers: BROWSER_HEADERS, redirect: 'follow' })
    if (r.status === 404) throw new Error('the store listing gave HTTP 404')
    return r.status === 200 ? { detail: 'HTTP 200' } : { status: 'WARN', detail: `HTTP ${r.status} (a store may refuse a script; open the listing by hand)` }
  })
  await step('web', '/link/try/ demo page', async () => {
    const r = await get(`${ORIGIN}/link/try/`)
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`)
    return { detail: 'the dot demo Link drives loads' }
  })
  await step('web', 'Desktop page and zip', async () => {
    const r = await get(`${ORIGIN}/link/desktop/`)
    if (r.status !== 200) throw new Error(`/link/desktop/ gave HTTP ${r.status}`)
    const href = desktopZipHref(await r.text())
    if (!href) throw new Error('no Windows zip link on the page')
    const f = await peek(href)
    if (f.status !== 200 || !f.zip) throw new Error(`the Windows zip gave HTTP ${f.status}${f.status === 200 ? ' and is no zip' : ''}`)
    return { detail: `page loads; the Windows zip downloads (${mb(f.size)}); not run here` }
  })
}

// ---- the browser parts ---------------------------------------------------------------------------------------------
/** Screenshots of the canvases alone: everything else on the page is hidden for the capture. */
const CANVAS_ONLY = 'html *{visibility:hidden !important} html canvas{visibility:visible !important}'

async function look(page) {
  try {
    const png = await page.screenshot({ style: CANVAS_ONLY, timeout: 15_000 })
    const { data } = await sharp(png).resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
    return frameLook(data)
  } catch { return null }
}

/** Waits until the canvases hold a picture. Throws what it saw if not in time. */
async function waitDrawn(page, timeoutMs, label = 'the scene') {
  const start = Date.now()
  let seen = null
  while (Date.now() - start < timeoutMs) {
    seen = await look(page)
    if (seen && drawn(seen)) return { ms: Date.now() - start, look: seen }
    await sleep(350)
  }
  throw new Error(`${label} drew nothing in ${seconds(timeoutMs)}${seen ? ` (${seen.colours} colours, spread ${seen.spread})` : ''}`)
}

/** What a sim that failed to start shows (src/sim/kit/recovery.ts), or null. `beacon`: the page holds Cloudflare's script. */
const startFailure = (page) => page.evaluate(() => {
  const card = document.getElementById('sim-recovery')
  if (!card) return null
  return { kind: card.dataset.kind, text: card.querySelector('[role=alert],[role=status]')?.textContent ?? '', beacon: !!document.querySelector('script[src*="cloudflareinsights"]') }
}).catch(() => null)

/** Page errors a page threw (its own, not a blocked script's console line), for the check that loaded it. */
function trackErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 100)))
  return errors
}

async function shot(page, name, locator) {
  try {
    const path = join(out, `${name}.jpg`)
    if (locator) await locator.screenshot({ path, type: 'jpeg', quality: 72, timeout: 10_000 })
    else await page.screenshot({ path, type: 'jpeg', quality: 72, timeout: 10_000 })
  } catch { /* evidence only */ }
}

/** True once the page has a pairing link. The link is never read out: it carries a secret. */
const hasCode = (page, timeout) => page.waitForFunction(() => !!window.__obpal?.pairingUrl, null, { timeout }).then(() => true, () => false)

let browser, found
/** A browser context; `strip` removes Cloudflare's script from the pages it loads when --without-beacon asks. */
async function context(options) {
  const ctx = await browser.newContext(options)
  if (opts.withoutBeacon) {
    // Pages are the addresses without a file name (/sim/drone/); everything else goes through untouched.
    await ctx.route((url) => url.origin === ORIGIN && !/\.[a-z0-9]{2,5}$/i.test(url.pathname), async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue()
      const res = await route.fetch()
      await route.fulfill({ response: res, body: stripBeacon(await res.text()) })
    })
  }
  return ctx
}

/** An emulated phone (a Pixel 7) on a pairing link, its controls up. The link goes nowhere but the page's address bar. */
async function joinPhone(invite, label) {
  const ctx = await context({ ...devices['Pixel 7'] })
  const page = await ctx.newPage()
  const errors = trackErrors(page)
  const cdp = await ctx.newCDPSession(page)
  const start = Date.now()
  await page.goto(invite, { waitUntil: 'load', timeout: 40_000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.modes, .gp-stick')].some((e) => e.getClientRects().length), null, { timeout: 40_000 })
  return { ctx, page, cdp, errors, ms: Date.now() - start, label }
}

/**
 * Where `selector` is on the phone once it has stopped moving: a controller settles for a moment after it joins (a banner
 * folds away and the controls move up), and a touch aimed at where a control was lands on whatever took its place.
 */
async function stableBox(phone, selector, timeout = 8000) {
  const target = phone.page.locator(selector).first()
  const end = Date.now() + timeout
  let last = null
  while (Date.now() < end) {
    const b = await target.boundingBox()
    if (b && last && Math.abs(b.x - last.x) < 1 && Math.abs(b.y - last.y) < 1) return b
    last = b
    await sleep(300)
  }
  if (last) return last
  throw new Error(`nothing to drag at ${selector}`)
}

/**
 * A one-finger drag across `selector` on the phone, as a finger makes it (touch events through the browser's input),
 * then the finger stays down for `holdMs`: a screen that draws a few times a second sees a held stick, not a flick.
 */
async function drag(phone, selector, dx, dy, holdMs = 0) {
  const box = await stableBox(phone, selector)
  const x = box.x + box.width / 2 - dx / 2, y = box.y + box.height / 2 - dy / 2
  await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
  for (let i = 1; i <= 12; i++) {
    await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (dx * i) / 12, y: y + (dy * i) / 12, id: 1 }] })
    await sleep(24)
  }
  if (holdMs) await sleep(holdMs)
  await phone.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/**
 * Pushes the phone's left stick by (dx, dy) pixels and holds it for `holdMs`. The stick floats: it centres where the
 * thumb lands. The events are made in the page, in one task with the stick's own position read, so a controller that is
 * still settling cannot move it from under the touch (a thumb would not mind; a script's coordinates do).
 */
async function pushStick(phone, dx, dy, holdMs) {
  await stableBox(phone, '.gp-stick .gp-base')
  await phone.page.evaluate(({ dx, dy }) => {
    const zone = document.querySelector('.gp-stick')
    const b = zone.querySelector('.gp-base').getBoundingClientRect()
    const x = b.x + b.width / 2, y = b.y + b.height / 2
    const send = (type, px, py) => zone.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 71, pointerType: 'touch', isPrimary: true, clientX: px, clientY: py }))
    window.__release = () => send('pointerup', x + dx, y + dy)
    send('pointerdown', x, y)
    send('pointermove', x + dx, y + dy)
  }, { dx, dy })
  await sleep(holdMs)
  await phone.page.evaluate(() => window.__release())
}

/**
 * Counts the host's mode changes from now on, and the furthest any gamepad axis has been pushed, in `window.__pf`.
 * (Counting packets would say little: a phone streams its state at rest.)
 */
const countInput = (page) => page.evaluate(() => {
  window.__pf = { modes: 0, axis: 0 }
  window.__obpal.on('mode', () => window.__pf.modes++)
  setInterval(() => {
    const who = window.__obpal.participants.find((p) => p.capability !== 'watch')
    const pad = who && window.__obpal.padOf(who.id)
    if (pad) window.__pf.axis = Math.max(window.__pf.axis, ...pad.axes.map(Math.abs))
  }, 25)
})
const counted = (page) => page.evaluate(() => window.__pf)

/** Clears what floats over a phone's controls (first-use hints, notices) and keeps its toast from catching a touch. */
const quiet = (page) => page.evaluate(() => {
  document.querySelectorAll('.hint, .bt-notice').forEach((h) => h.remove())
  document.querySelectorAll('#toast').forEach((t) => { t.style.pointerEvents = 'none' })
}).catch(() => {})

/** The phone's controller bar: every tab, and which of them is a camera mode. */
const tabsOf = (phone) => phone.page.evaluate(() => [...document.querySelectorAll('.modes [data-tab]')].filter((b) => !b.hidden)
  .map((b) => ({ tab: b.dataset.tab, name: (b.getAttribute('aria-label') || b.textContent || '').trim(), camera: b.dataset.tab.startsWith('camera') })))

async function homePart() {
  const ctx = await context({ viewport: { width: 1440, height: 900 } })
  let phone = null
  try {
    const home = await ctx.newPage()
    const errors = trackErrors(home)
    const loaded = await step('home', 'home page loads, marbles drawn', async () => {
      const res = await home.goto(`${ORIGIN}/`, { waitUntil: 'load', timeout: 40_000 })
      if (res?.status() !== 200) throw new Error(`HTTP ${res?.status()}`)
      const h1 = ((await home.locator('h1').first().textContent({ timeout: 5000 })) ?? '').trim()
      if (!h1) throw new Error('no heading')
      const d = await waitDrawn(home, 20_000, 'the marbles')
      await shot(home, 'home')
      if (errors.length) throw new Error(`page error: ${errors[0]}`)
      return { detail: `HTTP 200, "${h1.slice(0, 40)}", canvas drawn after ${seconds(d.ms)}` }
    })
    if (!ok(loaded)) {
      for (const c of ['pairing QR and code issued', 'phone joins', 'controller modes', 'trackpad moves a marble']) skip('home', c, 'the home page did not load')
      return
    }
    // A real code is made on the first sign that someone is here (src/landing/main.ts), so give it one.
    const issued = await step('home', 'pairing QR and code issued', async () => {
      const start = Date.now()
      await home.mouse.move(400, 300)
      await home.mouse.move(720, 520, { steps: 6 })
      if (!(await hasCode(home, 25_000))) throw new Error('no pairing link in 25 s')
      let code = null
      while (!code && Date.now() - start < 30_000) { code = shownCode(await home.evaluate(deepText, '[data-pair]')); if (!code) await sleep(300) }
      if (!code) throw new Error('the pairing card shows no code')
      const qr = await home.evaluate(() => {
        const find = (n) => !!n.querySelector?.('svg, canvas, img') || [...(n.querySelectorAll?.('*') ?? [])].some((e) => e.shadowRoot && find(e.shadowRoot))
        return find(document.querySelector('[data-pair]') ?? document.body)
      })
      if (!qr) throw new Error('no QR drawn')
      await shot(home, 'home-pairing', home.locator('[data-pair]'))
      return { detail: `QR drawn and code ${code} shown after ${seconds(Date.now() - start)}` }
    })
    if (!ok(issued)) {
      for (const c of ['phone joins', 'controller modes', 'trackpad moves a marble']) skip('home', c, 'no pairing code')
      return
    }
    await countInput(home)
    const joined = await step('home', 'phone joins', async () => {
      phone = await joinPhone(await home.evaluate(() => window.__obpal.pairingUrl), 'home')
      await home.waitForFunction(() => window.__obpal.participants.length >= 1, null, { timeout: 15_000 })
      await shot(phone.page, 'home-phone')
      await shot(home, 'home-with-phone')
      if (phone.errors.length) throw new Error(`phone page error: ${phone.errors[0]}`)
      return { detail: `controls up after ${seconds(phone.ms)}; the screen counts ${await home.evaluate(() => window.__obpal.participants.length)} phone` }
    })
    if (!ok(joined)) {
      for (const c of ['controller modes', 'trackpad moves a marble']) skip('home', c, 'no phone joined')
      return
    }
    await step('home', 'controller modes', async () => {
      const tabs = await tabsOf(phone)
      const modes = tabs.filter((t) => !t.camera)
      if (modes.length < 2) throw new Error(`${modes.length} controller tab${modes.length === 1 ? '' : 's'} (${tabs.map((t) => t.name).join(', ') || 'none'})`)
      for (const m of modes) {
        await quiet(phone.page)
        await phone.page.locator(`.modes [data-tab="${m.tab}"]`).click({ timeout: 5000 })
        await phone.page.waitForFunction((tab) => document.querySelector(`.modes [data-tab="${tab}"]`)?.getAttribute('aria-selected') === 'true', m.tab, { timeout: 5000 })
        await sleep(300)
      }
      const seen = (await counted(home)).modes
      if (!seen) throw new Error('the screen was told of no mode change')
      const cams = tabs.filter((t) => t.camera).map((t) => t.name)
      return { detail: `${modes.map((m) => m.name).join(', ')} selected in turn, the screen told ${seen} times${cams.length ? `; camera modes offered: ${cams.join(', ')}` : ''}` }
    })
    await step('home', 'trackpad moves a marble', async () => {
      // The phone's marble (scripts/e2e-home.mjs reads it the same way). A phone that just joined wakes the field and the
      // marble settles; a swipe is read from a marble at rest.
      const tip = () => home.evaluate(() => window.__home.tips().find((t) => t.id !== 'me') ?? null)
      const start = Date.now()
      let before = null
      while (!before && Date.now() - start < 15_000) { before = await tip(); if (!before) await sleep(250) }
      if (!before) throw new Error('the page drew no marble for the phone')
      while (Date.now() - start < 30_000 && (await home.evaluate(() => !!window.__home.sim().busy))) await sleep(300)
      await sleep(1500)
      before = (await tip()) ?? before
      await quiet(phone.page)
      await phone.page.locator('.modes [data-tab="rotate"]').click({ timeout: 5000 }).catch(() => {})
      await sleep(400)
      await drag(phone, '#pad', 108, -60)
      let moved = 0
      const swiped = Date.now()
      while (Date.now() - swiped < 6000 && moved < 20) {
        await sleep(150)
        const now = await tip()
        if (now) moved = Math.hypot(now.x - before.x, now.y - before.y)
      }
      if (moved < 20) throw new Error(`the marble moved ${moved.toFixed(0)} px after a swipe`)
      await shot(home, 'home-marble-moved')
      return { detail: `one swipe moved the phone's marble ${moved.toFixed(0)} px in ${seconds(Date.now() - swiped)}` }
    })
  } finally {
    await phone?.ctx.close().catch(() => {})
    await ctx.close().catch(() => {})
  }
}

async function viewerPart() {
  const ctx = await context({ viewport: { width: 1440, height: 900 } })
  let phone = null
  try {
    const view = await ctx.newPage()
    const errors = trackErrors(view)
    const ice = watchIce(view)
    const loaded = await step('viewer', 'Viewer loads with a model', async () => {
      const res = await view.goto(`${ORIGIN}/view/`, { waitUntil: 'load', timeout: 40_000 })
      if (res?.status() !== 200) throw new Error(`HTTP ${res?.status()}`)
      await view.waitForFunction(() => window.__viewer?.holder.children.length === 1, null, { timeout: 45_000 })
      const d = await waitDrawn(view, 30_000, 'the Viewer')
      await shot(view, 'viewer')
      if (errors.length) throw new Error(`page error: ${errors[0]}`)
      return { detail: `HTTP 200, a model on stage, frame drawn after ${seconds(d.ms)}` }
    })
    const issued = ok(loaded) && await step('viewer', 'pairing code issued', async () => {
      const start = Date.now()
      if (!(await hasCode(view, 30_000))) throw new Error('no pairing link in 30 s')
      let code = null
      while (!code && Date.now() - start < 20_000) { code = shownCode(await view.evaluate(deepText)); if (!code) await sleep(300) }
      if (!code) throw new Error('the Viewer shows no code')
      return { detail: `code ${code} shown after ${seconds(Date.now() - start)}` }
    })
    if (!ok(loaded)) skip('viewer', 'pairing code issued', 'the Viewer did not load')
    if (ok(issued)) {
      await step('viewer', 'phone joins, controller modes', async () => {
        // Not a drag on the model: the Viewer reads a swipe only from frames close together, and software rendering draws
        // its scene a few times a second, so a swipe would prove the test machine's speed and not the site.
        await countInput(view)
        phone = await joinPhone(await view.evaluate(() => window.__obpal.pairingUrl), 'viewer')
        await view.waitForFunction(() => window.__obpal.participants.length >= 1, null, { timeout: 15_000 })
        await quiet(phone.page)
        await shot(phone.page, 'viewer-phone')
        const tabs = await tabsOf(phone)
        const modes = tabs.filter((t) => !t.camera)
        if (modes.length < 3) throw new Error(`${modes.length} controller tab${modes.length === 1 ? '' : 's'} (${tabs.map((t) => t.name).join(', ') || 'none'})`)
        // The tabs that need nothing from the phone but a tap; the 3D hand wants the camera or an AR session.
        const tried = []
        for (const m of modes.filter((t) => ['rotate', 'point', 'gamepad'].includes(t.tab))) {
          await quiet(phone.page)
          await phone.page.locator(`.modes [data-tab="${m.tab}"]`).click({ timeout: 5000 })
          await phone.page.waitForFunction((tab) => document.querySelector(`.modes [data-tab="${tab}"]`)?.getAttribute('aria-selected') === 'true', m.tab, { timeout: 5000 })
          tried.push(m.name)
          await sleep(300)
        }
        if (tried.length < 2) throw new Error(`only ${tried.length} of the Trackpad, Wii remote and Gamepad tabs could be selected`)
        const cams = tabs.filter((t) => t.camera).map((t) => t.name)
        return { detail: `joined in ${seconds(phone.ms)}; ${tried.join(', ')} selected in turn; also offered: ${[...modes.filter((m) => !tried.includes(m.name)).map((m) => m.name), ...cams].join(', ') || 'nothing else'}` }
      })
    } else skip('viewer', 'phone joins, controller modes', 'no pairing code')
    // TURN through the Viewer's own room, as check:live does.
    const start = Date.now()
    try {
      for (let i = 0; i < 60 && !ice.room; i++) await sleep(500)
      const { check, relay } = await probeRelay(view, ice.room)
      for (const r of turnChecks({ hostTurn: ice.hostTurn, check, relay })) record('turn', r.check, r.status, Date.now() - start, r.detail)
    } catch (e) {
      record('turn', 'TURN relay', 'FAIL', Date.now() - start, brief(e))
    }
  } finally {
    await phone?.ctx.close().catch(() => {})
    await ctx.close().catch(() => {})
  }
}

async function simsPart() {
  let watched = false
  for (const sim of sims) {
    const ctx = await context({ viewport: { width: 1280, height: 800 } })
    let guest = null, phone = null
    try {
      const page = await ctx.newPage()
      const errors = trackErrors(page)
      const loaded = await step('sims', `${sim.name} starts, draws a frame`, async () => {
        const res = await page.goto(`${ORIGIN}${sim.path}`, { waitUntil: 'load', timeout: 40_000 })
        if (res?.status() !== 200) throw new Error(`HTTP ${res?.status()}`)
        const start = Date.now()
        let d = null
        while (!d) {
          const failure = await startFailure(page)
          if (failure) {
            await shot(page, `sim-${sim.key.replace(/\W+/g, '-')}-failed`)
            throw new Error(`shows "${failure.text.split('.')[0]}"${failure.beacon ? ' with Cloudflare\'s blocked analytics script on the page (see web · Cloudflare beacon)' : ''}`)
          }
          const seen = await look(page)
          if (seen && drawn(seen)) d = { ms: Date.now() - start, look: seen }
          else if (Date.now() - start > 45_000) throw new Error(`drew nothing in 45 s${seen ? ` (${seen.colours} colours, spread ${seen.spread})` : ''}`)
          else await sleep(350)
        }
        const codeAt = Date.now()
        if (!(await hasCode(page, 25_000))) throw new Error('drawn, but no pairing link in 25 s')
        // Frames the page itself drew in a second: the loop is alive (software rendering, so the number is no promise).
        const fps = await page.evaluate(async () => { let n = 0; const end = performance.now() + 1000; await new Promise((r) => { const f = () => { n++; performance.now() < end ? requestAnimationFrame(f) : r() }; requestAnimationFrame(f) }); return n })
        await shot(page, `sim-${sim.key.replace(/\W+/g, '-')}`)
        if (errors.length) throw new Error(`page error: ${errors[0]}`)
        return { detail: `frame drawn after ${seconds(d.ms)}, pairing code after ${seconds(Date.now() - codeAt)}, ${fps} frames/s in software rendering` }
      })
      if (!ok(loaded) || watched) continue
      watched = true
      await step('sims', `watch link (${sim.name})`, async () => {
        const url = await page.evaluate(() => window.__obpal.shortShareUrl('watch'))
        if (!url) throw new Error('the scene offers no watch link')
        const start = Date.now()
        const g = await context({ viewport: { width: 1000, height: 640 } })
        guest = g
        const gp = await g.newPage()
        const gErrors = trackErrors(gp)
        await gp.goto(url, { waitUntil: 'load', timeout: 40_000 })
        await gp.getByRole('status').filter({ hasText: /Watching/ }).first().waitFor({ timeout: 45_000 })
        await page.waitForFunction(() => window.__obpal.participants.some((p) => p.capability === 'watch'), null, { timeout: 30_000 })
        await shot(gp, 'watch-guest')
        if (gErrors.length) throw new Error(`guest page error: ${gErrors[0]}`)
        return { detail: `the link opened, the guest shows Watching and the screen counts the watcher, ${seconds(Date.now() - start)}` }
      })
      await guest?.close().catch(() => {})
      guest = null
      await step('sims', `phone drives ${sim.name}`, async () => {
        await countInput(page)
        phone = await joinPhone(await page.evaluate(() => window.__obpal.pairingUrl), sim.key)
        await page.waitForFunction(() => window.__obpal.participants.some((p) => p.capability !== 'watch'), null, { timeout: 15_000 })
        await quiet(phone.page)
        if (phone.errors.length) throw new Error(`phone page error: ${phone.errors[0]}`)
        // A gamepad face has sticks: push one and the screen should read an axis. Another face is only seen to be up.
        if (!(await phone.page.locator('.gp-stick').count())) return { detail: `controls up after ${seconds(phone.ms)}; the screen counts the phone (this sim's controller has no stick to push)` }
        // A phone that has only just joined may still be finishing its handshake, and input before that is dropped: push again.
        let axis = 0, tries = 0
        while (axis < 0.3 && tries < 3) {
          tries++
          const start = Date.now()
          await pushStick(phone, 40, -50, 900)
          while (Date.now() - start < 2500 && (axis = (await counted(page)).axis) < 0.3) await sleep(100)
        }
        if (axis < 0.3) {
          const seen = await page.evaluate(() => {
            const who = window.__obpal.participants.filter((p) => p.capability !== 'watch')
            return `${who.length} player${who.length === 1 ? '' : 's'} on the screen, ${who.length && window.__obpal.padOf(who[0].id) ? 'sending gamepad state' : 'no gamepad state from them'}`
          })
          throw new Error(`a stick pushed on the phone ${tries} times read ${axis.toFixed(2)} on the screen (${seen})`)
        }
        // After the push: a screenshot of an emulated phone resets its viewport, and touches are placed by that.
        await shot(phone.page, `sim-${sim.key.replace(/\W+/g, '-')}-phone`)
        return { detail: `controls up after ${seconds(phone.ms)}; a push on the stick read ${axis.toFixed(2)} on the screen${tries > 1 ? ` (on try ${tries})` : ''}` }
      })
    } finally {
      await phone?.ctx.close().catch(() => {})
      await guest?.close().catch(() => {})
      await ctx.close().catch(() => {})
    }
  }
  if (!watched) {
    skip('sims', 'watch link', 'no sim started')
    skip('sims', 'phone drives a sim', 'no sim started')
  }
}

// ---- the run -------------------------------------------------------------------------------------------------------
console.log(`demo:preflight ${ORIGIN}: ${opts.only.join(', ')}${opts.only.includes('sims') ? ` (${sims.map((s) => s.name).join(', ')})` : ''}`)
if (opts.withoutBeacon) console.log("  diagnostic: Cloudflare's analytics script is removed from the pages loaded, as if its injection were off")
const needsBrowser = opts.only.some((p) => p !== 'web')
if (needsBrowser) {
  found = await resolveChromium().catch((e) => { console.error(`demo:preflight: ${e.message}`); process.exit(2) })
  console.log(`  browser: ${found.from} ${shortPath(found.path)}`)
}
console.log(`  evidence: ${out}`)
console.log(`  ob.Pal Desktop log: ${logAtStart ? 'watched' : desktopLog ? 'none here (not installed)' : 'none (not Windows)'}\n`)

process.on('SIGINT', () => { void browser?.close().finally(() => process.exit(130)) })
try {
  if (opts.only.includes('web')) await webPart()
  if (needsBrowser) {
    // WebRtcHideLocalIpsWithMdns off: the emulated phone and the screen share this machine, so they meet on loopback.
    browser = await chromium.launch({ executablePath: found.path || undefined, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-features=WebRtcHideLocalIpsWithMdns'] })
    if (opts.only.includes('home')) await homePart()
    if (opts.only.includes('viewer')) await viewerPart()
    if (opts.only.includes('sims')) await simsPart()
  }
} catch (e) {
  record('run', 'preflight stopped', 'FAIL', Date.now() - t0, brief(e))
} finally {
  await browser?.close().catch(() => {})
}

// ---- the summary ---------------------------------------------------------------------------------------------------
const markers = found?.path && !/ms-playwright/i.test(found.path) ? [found.path] : []
const guard = desktopLog ? guardLine(logAtStart, readLog(), markers) : { reached: [], line: 'ob.Pal Desktop guard: no new sessions (not Windows)' }
const end = verdict(rows)
const table = formatTable(['part', 'check', 'result', 'time', 'detail'], rows.map((r) => [r.part, r.check, r.status, seconds(r.ms), r.detail]))
const report = `${table}\n\n${end.line} in ${seconds(Date.now() - t0)}\n${guard.line}\n`
console.log(`\n${report}evidence: ${out}`)
writeFileSync(join(out, 'report.txt'), report)
writeFileSync(join(out, 'results.json'), JSON.stringify({ origin: ORIGIN, startedAt: new Date(t0).toISOString(), elapsedMs: Date.now() - t0, only: opts.only, sims: sims.map((s) => s.path), withoutBeacon: opts.withoutBeacon, browser: found?.from ?? null, verdict: end, guard: guard.reached.length ? guard : 'no new sessions', rows }, null, 2) + '\n')
if (guard.reached.length) {
  console.error(`\nA TEST BROWSER REACHED THE INSTALLED ob.Pal Desktop. Its log (read only) gained:\n  ${guard.reached.slice(0, 5).map((l) => l.slice(0, 150)).join('\n  ')}`)
  process.exit(3)
}
process.exit(end.ready ? 0 : 1)
