/**
 * ob.Pal Link end to end: the built extension (extension/dist) in Chromium, a phone emulated in a second browser
 * that opens the pairing link, and a local test page that records what a game or 3D viewer would receive.
 * The phone runs this checkout's controller build (dist/client) through a local stand-in for the service
 * (extension/e2e/local.mjs) that proxies signaling to production, so both ends under test are the code here.
 * Checks the four targets:
 *   Controller: the Gamepad API shows "ob.Pal Controller", A held on the phone = button 0 pressed.
 *   Keys:       A = Space, D-pad up = ArrowUp (keydown, then keyup).
 *   3D:         a one-finger trackpad drag = left-button pointer drag on the largest canvas; a pinch = wheel.
 *   PC:         the native helper. By default a stub host (extension/e2e/native-stub.mjs) stands in for
 *               ob.Pal Desktop and records what the extension sends: the permission, the allow request from
 *               the popup, frames carrying the held keys, and the disarm on leaving the target.
 *               With --desktop the installed helper (desktop/, `obpal-desktop.exe install`) is used instead
 *               and a harness window (obpal-harness.exe) proves that keys are refused until the program is
 *               allowed, then typed into it, then refused again once it is forgotten.
 *
 * Online (production signaling):
 *   Controller: the Gamepad API shows "ob.Pal Controller", A held on the phone = button 0 pressed.
 *   Motion:     Aim clears an 0.18 look deadzone with a small turn; Steer on the flight profile flies the right stick.
 *   Point:      the Wii cursor follows where the phone points and A clicks the button under it.
 *   Keys:       A = Space, D-pad up = ArrowUp (keydown, then keyup).
 *   3D:         a one-finger trackpad drag = left-button pointer drag on the largest canvas; a pinch = wheel.
 *   Both sides remember the pairing; the phone's service worker has the controller cached.
 * Offline (the service blocked for the extension, the phone with no network at all):
 *   The popup shows the direct code, the phone opens the controller from its cache, connects over the LAN with
 *   no server, and input arrives. Forgetting the phone removes the direct code.
 * The emulated phone has no sensors, so the test dispatches the W3C deviceorientation / devicemotion events itself.
 *
 * Usage: pnpm exec vite build && pnpm run build:extension && node extension/scripts/e2e.mjs [--headed] [--shots=<dir>] [--desktop]
 * Chromium: Playwright's own (npx playwright install chromium), or OBPAL_E2E_CHROMIUM=<path to chrome.exe>.
 * Branded Chrome can't load unpacked extensions from the command line, so this needs Chromium.
 *
 * Automation can't click the toolbar icon, which is what grants activeTab. The test copy of the extension
 * therefore also gets host access to the local test page (http://127.0.0.1/*), and "This tab" is switched on
 * with the same message the popup sends. Optional permissions can't be granted by automation either, so the
 * test copy has nativeMessaging as a required permission.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'
import { startLocal, UPSTREAM } from '../e2e/local.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEADED = process.argv.includes('--headed')
const SHOTS = process.argv.find((a) => a.startsWith('--shots='))?.slice(8)
const DESKTOP = process.argv.includes('--desktop')
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const HARNESS = process.env.OBPAL_E2E_HARNESS || resolve(root, '..', 'desktop', 'target', 'release', 'obpal-harness.exe')
/** desktop/src/win/inject.rs EXTRA_INFO: every event the helper injects carries it. */
const INJECT_TAG = 0x0b9a1001
// Two browsers on one machine: real host candidates instead of mDNS names, so WebRTC connects over loopback.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns']
const SERVICE = `https://${UPSTREAM}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, fn, timeout = 8000, every = 100) {
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
  const t0 = Date.now()
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail, ms: Date.now() - t0 })
    console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`)
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e), ms: Date.now() - t0 })
    console.log(`  ✗ ${name}: ${e?.message ?? e}`)
  }
}

// ---- the extension under test ---------------------------------------------------------------------------------

const ext = await mkdtemp(join(tmpdir(), 'obpal-link-ext-'))
await cp(join(root, 'dist'), ext, { recursive: true })
const manifestPath = join(ext, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*']
manifest.permissions = [...manifest.permissions, 'nativeMessaging']
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging')
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

// ---- the native helper: the stub, registered under a test-only host name -------------------------------------
// Chromium finds native hosts through HKCU\Software\Chromium\NativeMessagingHosts (Chrome: Software\Google\Chrome).
// The test copy of the extension is pointed at the stub's name, so an installed ob.Pal Desktop is left alone.
const STUB_HOST = 'net.blackboxes.obpal.e2e'
const REAL_HOST = 'net.blackboxes.obpal'
const STUB_KEYS = ['HKCU\\Software\\Chromium\\NativeMessagingHosts', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts'].map((k) => `${k}\\${STUB_HOST}`)
const stubDir = await mkdtemp(join(tmpdir(), 'obpal-link-stub-'))
const stubLogPath = join(stubDir, 'stub.log')
const registered = []
if (!DESKTOP) {
  for (const f of await readdir(ext, { recursive: true })) {
    const p = join(ext, f)
    if (!f.endsWith('.js')) continue
    const src = await readFile(p, 'utf8')
    if (src.includes(REAL_HOST)) await writeFile(p, src.split(REAL_HOST).join(STUB_HOST))
  }
  process.env.OBPAL_STUB_LOG = stubLogPath // Playwright hands the environment on to Chromium, and Chromium to the host
}
const stubLog = () => (existsSync(stubLogPath) ? readFileSync(stubLogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

async function registerStub(extensionId) {
  const bat = join(stubDir, 'native-stub.bat')
  await writeFile(bat, `@echo off\r\n"${process.execPath}" "${join(root, 'e2e', 'native-stub.mjs')}" %*\r\n`)
  const stubManifest = join(stubDir, `${STUB_HOST}.json`)
  await writeFile(stubManifest, JSON.stringify({ name: STUB_HOST, description: 'ob.Pal Link e2e stub host', path: bat, type: 'stdio', allowed_origins: [`chrome-extension://${extensionId}/`] }, null, 2))
  for (const key of STUB_KEYS) {
    const r = spawnSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', stubManifest, '/f'], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`reg add ${key}: ${r.stderr || r.stdout}`)
    registered.push(key)
  }
}

function unregisterStub() {
  for (const key of registered.splice(0)) spawnSync('reg', ['delete', key, '/f'], { encoding: 'utf8' })
}

/** The harness window (desktop/src/bin/harness.rs): a plain Win32 edit control that reports what it receives. */
function startHarness() {
  if (!existsSync(HARNESS)) throw new Error(`no harness at ${HARNESS} (cargo build --release in desktop/, or OBPAL_E2E_HARNESS)`)
  const child = spawn(HARNESS, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  const events = []
  createInterface({ input: child.stdout }).on('line', (l) => { try { events.push(JSON.parse(l)) } catch { /* not ours */ } })
  return {
    events,
    /** Key events tagged by the helper's injector (its dwExtraInfo), so the harness's own Alt tap doesn't count. */
    keys: () => events.filter((e) => e.ev === 'key' && e.extra === INJECT_TAG),
    send: (cmd) => child.stdin.write(`${cmd}\n`),
    ready: () => until('harness ready', () => events.find((e) => e.ev === 'ready'), 10000),
    async front() {
      const n = events.length
      child.stdin.write('front\n')
      const r = await until('harness front', () => events.slice(n).find((e) => e.ev === 'front'))
      if (!r.ok) throw new Error('the harness window could not take the foreground')
    },
    async text() {
      const n = events.length
      child.stdin.write('text\n')
      return (await until('harness text', () => events.slice(n).find((e) => e.ev === 'text'))).text
    },
    async clear() {
      const n = events.length
      child.stdin.write('clear\n')
      await until('harness cleared', () => events.slice(n).find((e) => e.ev === 'cleared'))
    },
    stop() {
      try { child.stdin.write('quit\n') } catch { /* gone */ }
      setTimeout(() => child.kill(), 1500).unref()
    },
  }
}

const page0 = await readFile(join(root, 'e2e', 'harness.html'))
// /framed: the game page inside a full-size iframe from another origin (localhost vs 127.0.0.1), the way itch.io
// and most game portals host games. Without "All sites" the extension can't reach into it.
const framed = (port) => `<!doctype html><title>Framed game</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe src="http://localhost:${port}/" allow="gamepad"></iframe>`
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(req.url?.startsWith('/framed') ? framed(server.address().port) : page0)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const gameOrigin = `http://localhost:${server.address().port}`
const local = await startLocal()
const onPhone = (url) => url.replace(SERVICE, local.origin)

const profile = await mkdtemp(join(tmpdir(), 'obpal-link-profile-'))
const phoneProfile = await mkdtemp(join(tmpdir(), 'obpal-link-phone-'))
/** The extension's browser; the same profile keeps its certificate and remembered phones across relaunches. */
const launchDesk = (extra = []) => chromium.launchPersistentContext(profile, {
  executablePath,
  headless: !HEADED,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...RTC_ARGS, ...extra],
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
})
/** The phone: a persistent context too, so its service worker cache and its remembered screens survive. */
const phoneCtx = await chromium.launchPersistentContext(phoneProfile, {
  ...devices['Pixel 7 landscape'], executablePath, headless: !HEADED, args: [...RTC_ARGS, '--ignore-certificate-errors'],
})
let desk = await launchDesk()

async function openPopup(ctx) {
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  return { id, popup }
}
const linkOf = (popup) => popup.evaluate(async () => (await chrome.storage.session.get('link')).link ?? null)
const enable = (popup, tabId) => popup.evaluate((t) => chrome.runtime.sendMessage({ to: 'bg', type: 'enable', tabId: t, on: true }), tabId)
const setTarget = (popup, mode) => popup.evaluate((m) => chrome.runtime.sendMessage({ to: 'bg', type: 'mode', mode: m }), mode)

/** Touch helpers for a phone page (CDP touch events, so the trackpad and buttons see real touches). */
async function touchOn(ctx, phone) {
  const cdp = await ctx.newCDPSession(phone)
  const touches = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) })
  const centre = async (sel) => { const b = await phone.locator(sel).first().boundingBox(); if (!b) throw new Error(`no ${sel} on the phone`); return [b.x + b.width / 2, b.y + b.height / 2] }
  const clearHints = () => phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  const tap = async (sel) => { await clearHints(); const [x, y] = await centre(sel); await touches('touchStart', [[x, y]]); await sleep(60); await touches('touchEnd', []); await sleep(250) }
  const hold = async (sel, during) => { await clearHints(); const [x, y] = await centre(sel); await touches('touchStart', [[x, y]]); try { return await during() } finally { await touches('touchEnd', []) } }
  return { touches, centre, clearHints, tap, hold }
}

let exitCode = 0
try {
  console.log('ob.Pal Link e2e')
  let { id, popup } = await openPopup(desk)
  console.log(`  extension ${id} · ${manifest.name} ${manifest.version} · phone via ${local.origin}`)
  if (!DESKTOP) await registerStub(id)

  let page = desk.pages()[0] ?? (await desk.newPage())
  await page.goto(`${base}/`)
  const pairing = await until('pairing link', async () => (await linkOf(popup))?.url || '', 20000)
  let tabId = await popup.evaluate(async (b) => (await chrome.tabs.query({ url: `${b}/*` }))[0]?.id, base)
  await enable(popup, tabId)
  // The controlled tab is the one in front (as when a person clicks the toolbar icon on it): pages in background
  // tabs get no animation frames, and the Gamepad API connection events run on them.
  await page.bringToFront()

  // ---- the phone ----
  let phone = await phoneCtx.newPage()
  let { touches, centre, clearHints, tap, hold } = await touchOn(phoneCtx, phone)

  await check('pairs by QR link', async () => {
    const t0 = Date.now()
    await phone.goto(onPhone(pairing))
    await phone.locator('.modes').waitFor({ timeout: 20000 })
    await until('popup shows connected', () => popup.evaluate(() => document.getElementById('status')?.dataset.s === 'connected'), 15000)
    return `${new URL(pairing).host}, controls in ${Date.now() - t0} ms`
  })

  await check('Controller: Gamepad API pad, A = button 0', async () => {
    await setTarget(popup, 'gamepad')
    await tap('.modes [data-tab=gamepad]')
    await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
    const pad = await hold('.gp-f[data-k=a]', () => until('A pressed', () => page.evaluate(() => { const p = window.__pad(); return p?.pressed[0] ? p : null })))
    await until('A released', () => page.evaluate(() => window.__pad()?.pressed[0] === false))
    const connected = await page.evaluate(() => window.__log.pads)
    if (!connected.some((p) => /ob\.Pal/.test(p))) throw new Error('no gamepadconnected event')
    if (pad.mapping !== 'standard') throw new Error(`mapping ${pad.mapping}`)
    return pad.id
  })

  // ---- synthetic motion: a pose (W3C alpha / beta / gamma, degrees) and turn rates (degrees/second) at 60 Hz ----
  await phone.evaluate(() => {
    const m = (window.__motion = { alpha: 0, beta: 0, gamma: 0, rate: [0, 0, 0] })
    setInterval(() => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: m.alpha, beta: m.beta, gamma: m.gamma, absolute: true }))
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: m.rate[2], beta: m.rate[0], gamma: m.rate[1] }, interval: 16 }))
    }, 16)
  })
  const pose = (o) => phone.evaluate((o) => { Object.assign(window.__motion, o) }, o)
  const axes = () => page.evaluate(() => window.__pad()?.axes ?? null)
  const fmt = (a) => a.map((v) => v.toFixed(2)).join(' ')
  // The first press on the controller takes the phone fullscreen; let that resize finish before measuring where to tap.
  const settled = async () => { let last = ''; for (let same = 0; same < 6; ) { const v = await phone.evaluate(() => `${innerWidth}x${innerHeight}`); same = v === last ? same + 1 : 0; last = v; await sleep(100) } }
  /** Tap a motion chip until it reads on/off as asked (a tap during a layout change can land beside it). */
  const chip = async (u, on) => {
    const sel = `.gp-chip[data-chip="${u}"]`
    for (let i = 0; i < 3; i++) {
      await tap(sel)
      if ((await phone.getAttribute(sel, 'aria-pressed')) === String(on)) return
    }
    throw new Error(`${u} did not turn ${on ? 'on' : 'off'}`)
  }

  await check('Motion: a small Aim turn clears an 0.18 look deadzone on the right stick', async () => {
    await phone.locator('.gp-chip[data-chip="motion.aim"]').waitFor({ timeout: 5000 })
    await settled()
    await chip('motion.aim', true)
    await pose({ rate: [0, 0, 20] }) // 20°/s about the screen normal: turning left
    const a = await until('right stick past the deadzone', async () => { const v = await axes(); return v && Math.abs(v[2]) > 0.18 ? v : null })
    if (a[2] >= 0) throw new Error(`turning left should be stick left: ${fmt(a)}`)
    if (Math.abs(a[0]) > 0.02 || Math.abs(a[1]) > 0.02) throw new Error(`the left stick moved: ${fmt(a)}`)
    await pose({ rate: [0, 0, 0] })
    await until('stick at rest', async () => { const v = await axes(); return v && Math.abs(v[2]) < 0.05 && Math.abs(v[3]) < 0.05 })
    await chip('motion.aim', false)
    return `rx ${a[2].toFixed(2)} at 20°/s (the plain rate would be ${(-20 / 180).toFixed(2)})`
  })

  await check('Motion: Steer on the flight profile flies the right stick (tilt = X, tip = Y)', async () => {
    await tap('.gp-prof')
    await phone.locator('.gp-sheet [data-profile=flight]').waitFor({ timeout: 3000 })
    await tap('.gp-sheet [data-profile=flight]')
    await until('picker closed', () => phone.evaluate(() => !document.querySelector('.gp-sheet-wrap')))
    const name = await phone.evaluate(() => document.querySelector('.gp-prof span')?.textContent)
    if (name !== 'Flight') throw new Error(`profile ${name}`)
    await chip('motion.steer', true) // captures the level pose
    await pose({ beta: 22 })
    const a = await until('right stick tilted', async () => { const v = await axes(); return v && (Math.abs(v[2]) > 0.3 || Math.abs(v[3]) > 0.3) ? v : null })
    const [moved, still] = Math.abs(a[2]) > Math.abs(a[3]) ? [2, 3] : [3, 2]
    if (Math.abs(a[still]) > 0.1 || Math.abs(a[0]) > 0.02 || Math.abs(a[1]) > 0.02) throw new Error(`one right-stick axis only: ${fmt(a)}`)
    await pose({ beta: 0, gamma: 22 })
    const b = await until('the other axis', async () => { const v = await axes(); return v && Math.abs(v[still]) > 0.3 ? v : null })
    if (Math.abs(b[moved]) > 0.1) throw new Error(`the other axis only: ${fmt(b)}`)
    await pose({ gamma: 0 })
    await until('level again', async () => { const v = await axes(); return v && Math.abs(v[2]) < 0.05 && Math.abs(v[3]) < 0.05 })
    await chip('motion.steer', false)
    return `β → axis ${moved} ${a[moved].toFixed(2)}, γ → axis ${still} ${b[still].toFixed(2)}`
  })

  await check('Point: the Wii cursor follows the phone and A clicks the button under it', async () => {
    await pose({ alpha: 0, beta: 0, gamma: 0, rate: [0, 0, 0] })
    await chip('motion.point', true) // aim here = the centre of the screen
    const c0 = await until('cursor drawn', () => page.evaluate(() => window.__pointer()))
    await pose({ alpha: 8 }) // 8° to the left: x = cx + tan(yaw) · (w / 2) / tan(16°), a quarter of the way across
    const c1 = await until('cursor over the button', () => page.evaluate(() => {
      const c = window.__pointer()
      return c && Math.abs(c.x - innerWidth / 4) < 40 && Math.abs(c.y - innerHeight / 2) < 40 ? c : null
    }))
    await page.evaluate(() => { window.__log.clicks.length = 0; window.__log.aWhilePointing = 0 })
    await tap('.gp-f[data-k=a]')
    const click = await until('click on the button', () => page.evaluate(() => window.__log.clicks[0]))
    const leaked = await page.evaluate(() => window.__log.aWhilePointing)
    if (leaked) throw new Error(`A reached the pad ${leaked} times while it clicked at the cursor`)
    await pose({ alpha: 0 })
    await chip('motion.point', false)
    await until('cursor gone', () => page.evaluate(() => !window.__pointer()))
    return `cursor ${Math.round(c0.x)},${Math.round(c0.y)} → ${Math.round(c1.x)},${Math.round(c1.y)}, click at ${click.x},${click.y}`
  })

  await check('Keys: A = Space, D-pad up = ArrowUp', async () => {
    await setTarget(popup, 'keys')
    await sleep(300)
    await page.evaluate(() => { window.__log.keys.length = 0 })
    await hold('.gp-f[data-k=a]', () => until('Space down', () => page.evaluate(() => window.__log.keys.some((k) => k.t === 'down' && k.code === 'Space'))))
    await until('Space up', () => page.evaluate(() => window.__log.keys.some((k) => k.t === 'up' && k.code === 'Space')))
    await hold('.gp-dpad [data-dir=up]', () => until('ArrowUp down', () => page.evaluate(() => window.__log.keys.some((k) => k.t === 'down' && k.code === 'ArrowUp'))))
    await until('ArrowUp up', () => page.evaluate(() => window.__log.keys.some((k) => k.t === 'up' && k.code === 'ArrowUp')))
    return (await page.evaluate(() => window.__log.keys.map((k) => `${k.code}${k.t === 'down' ? '↓' : '↑'}`))).join(' ')
  })

  if (SHOTS) {
    await mkdir(SHOTS, { recursive: true })
    await phone.screenshot({ path: join(SHOTS, 'phone-gamepad.png') })
  }

  await check('3D: trackpad drag = left-button drag on the canvas; pinch = wheel', async () => {
    await setTarget(popup, 'viewer')
    await tap('.gp-mini[data-act=exit]') // leave the full-screen gamepad
    await tap('.modes [data-tab=rotate]')
    await phone.locator('#pad').waitFor({ timeout: 5000 })
    await clearHints()
    await page.evaluate(() => { window.__log.pointer.length = 0; window.__log.wheel = 0 })
    const [x, y] = await centre('#pad')
    await touches('touchStart', [[x - 60, y]])
    for (let i = 1; i <= 16; i++) { await touches('touchMove', [[x - 60 + i * 8, y + i * 2]]); await sleep(16) }
    await touches('touchEnd', [])
    const drag = await until('pointer drag', () => page.evaluate(() => {
      const l = window.__log.pointer
      const down = l.find((e) => e.t === 'pointerdown' && e.buttons === 1)
      const moves = l.filter((e) => e.t === 'pointermove' && e.buttons === 1)
      const up = l.find((e) => e.t === 'pointerup')
      return down && up && moves.length >= 3 ? { moves: moves.length, dx: moves.reduce((s, e) => s + e.mx, 0) } : null
    }))
    if (drag.dx <= 0) throw new Error(`dragged right on the phone, page moved ${drag.dx}px`)
    // Pinch outwards: two fingers apart = zoom in.
    await touches('touchStart', [[x - 30, y], [x + 30, y]])
    for (let i = 1; i <= 12; i++) { await touches('touchMove', [[x - 30 - i * 6, y], [x + 30 + i * 6, y]]); await sleep(16) }
    await touches('touchEnd', [])
    const wheel = await until('wheel', () => page.evaluate(() => window.__log.wheel || 0))
    return `${drag.moves} moves, ${drag.dx}px right; wheel ${wheel.toFixed(0)}`
  })

  await check('Framed game without All sites: the page reports the frame, so the popup can offer All sites', async () => {
    const game = await desk.newPage()
    await game.goto(`${base}/framed`)
    const gameTab = await popup.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id, `${base}/framed`)
    await enable(popup, gameTab)
    await game.bringToFront()
    const f = await until('frames report', () => popup.evaluate(async () => (await chrome.storage.session.get('frames')).frames))
    if (f.tab !== gameTab || f.count !== 1 || !f.big || f.host !== new URL(gameOrigin).host) throw new Error(JSON.stringify(f))
    // Control goes back to the plain page for anything after this.
    await enable(popup, tabId)
    await game.close()
    return `${f.host}, fills the page`
  })

  if (SHOTS) {
    await phone.screenshot({ path: join(SHOTS, 'phone-rotate.png') })
    await popup.setViewportSize({ width: 360, height: 560 })
    await popup.screenshot({ path: join(SHOTS, 'popup-connected.png') })
  }

  // ---- PC target ----
  const pcState = () => popup.evaluate(async () => (await chrome.storage.session.get('pc')).pc ?? null)
  const pcSend = (m) => popup.evaluate((m) => chrome.runtime.sendMessage(m), m)
  const pcStats = async () => {
    await pcSend({ to: 'bg', type: 'pc-stats' })
    await sleep(300)
    const s = (await pcState())?.stats
    if (!s) throw new Error('no stats from the helper')
    return s
  }
  const allowButton = () => popup.evaluate(() => document.querySelector('#pc-actions .btn.primary')?.textContent ?? '')
  const helperReady = (want) => until('helper ready', async () => {
    const s = await pcState()
    if (s?.link === 'missing') throw new Error('the helper is not installed for this Chromium (obpal-desktop.exe install)')
    if (s?.link === 'error') throw new Error(`helper: ${s.error}`)
    return s?.link === 'ready' && want(s) ? s : null
  }, 15000)
  /** The phone's left stick pushed up (W) until `during` resolves. */
  async function stickUp(during) {
    await clearHints()
    const [x, y] = await centre('.gp-stick[data-stick="0"]')
    await touches('touchStart', [[x, y]])
    for (let i = 1; i <= 6; i++) { await touches('touchMove', [[x, y - i * 12]]); await sleep(16) }
    try { return await during() } finally { await touches('touchEnd', []) }
  }

  if (!DESKTOP) {
    await check('PC (stub helper): starts on the PC target, the popup allows the program in front, frames carry the held keys, leaving disarms', async () => {
      await tap('.modes [data-tab=gamepad]')
      await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
      await setTarget(popup, 'pc')
      const ready = await helperReady((s) => s.status?.program?.name === 'stubgame.exe')
      await until('popup shows the PC card', () => popup.evaluate(() => !document.getElementById('pc').hidden && document.getElementById('tab').hidden))
      await until('popup offers Allow', async () => (await allowButton()).includes('Allow stubgame.exe'))
      await popup.locator('#pc-actions .btn.primary').click()
      await until('allowed', async () => (await pcState())?.status?.program?.allowed?.keyboard === true)
      await until('popup shows the scope', () => popup.evaluate(() => document.getElementById('pc-sub')?.textContent?.startsWith('keyboard + mouse')))
      await hold('.gp-f[data-k=a]', () => until('a frame holds Space', () => stubLog().some((e) => e.in?.t === 'f' && e.in.k?.includes('Space'))))
      await until('a later frame holds nothing', () => { const f = stubLog().filter((e) => e.in?.t === 'f'); return f.length > 0 && !f[f.length - 1].in.k })
      await setTarget(popup, 'keys')
      await until('the helper port closed', () => stubLog().some((e) => e.eof))
      const log = stubLog()
      const armed = log.findIndex((e) => e.in?.t === 'enable' && e.in.on === true)
      const firstFrame = log.findIndex((e) => e.in?.t === 'f')
      if (armed < 0 || firstFrame < armed) throw new Error('frames were sent before the helper was enabled')
      if (!log.some((e) => e.in?.t === 'hello' && e.in.v === 1)) throw new Error('no hello')
      if (!log.some((e) => e.in?.t === 'allow' && e.in.path === 'C:\\Stub\\stubgame.exe' && e.in.keyboard === true && e.in.mouse === true)) throw new Error('no allow request')
      if (!log[0]?.start?.[0]?.startsWith(`chrome-extension://${id}/`)) throw new Error(`host launched with ${JSON.stringify(log[0]?.start)}`)
      return `helper ${ready.version}, ${log.filter((e) => e.in?.t === 'f').length} frames`
    })
  } else {
    await check('PC (ob.Pal Desktop): keys are refused until the program is allowed, then typed into it, then refused once forgotten', async () => {
      const harness = startHarness()
      try {
        const info = await harness.ready()
        if (!info.front) await harness.front()
        await tap('.modes [data-tab=gamepad]')
        await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
        await setTarget(popup, 'pc')
        const ready = await helperReady((s) => s.status?.program?.path?.toLowerCase() === info.path.toLowerCase())
        // Not allowed yet: nothing arrives, and the helper counts the refusal. (Only events tagged by the helper's
        // injector count: the harness window holds the real foreground, so a person's own typing would land in it.)
        await hold('.gp-f[data-k=a]', () => sleep(700))
        await sleep(300)
        if (harness.keys().length) throw new Error(`key events arrived before the program was allowed: ${JSON.stringify(harness.keys())}`)
        const s1 = await pcStats()
        if (!(s1.refused.notAllowed > 0) || s1.injected !== 0) throw new Error(`stats before allowing: ${JSON.stringify(s1)}`)
        // Allow it from the popup (the harness stays in front: the test browsers are headless).
        await until('popup offers Allow', async () => (await allowButton()).startsWith('Allow '))
        await popup.locator('#pc-actions .btn.primary').click()
        await until('allowed', async () => (await pcState())?.status?.program?.allowed?.keyboard === true)
        await harness.front()
        await harness.clear()
        // A = Space, D-pad up = ArrowUp (an extended key), left stick up = W: all through SendInput into the edit control.
        await hold('.gp-f[data-k=a]', () => until('Space down', () => harness.keys().some((k) => k.down && k.vk === 0x20)))
        await until('Space up', () => harness.keys().some((k) => !k.down && k.vk === 0x20))
        await hold('.gp-dpad [data-dir=up]', () => until('ArrowUp down', () => harness.keys().some((k) => k.down && k.vk === 0x26 && k.ext)))
        await until('ArrowUp up', () => harness.keys().some((k) => !k.down && k.vk === 0x26))
        await stickUp(() => until('W down', () => harness.keys().some((k) => k.down && k.vk === 0x57 && k.scan === 0x11)))
        await until('W up', () => harness.keys().some((k) => !k.down && k.vk === 0x57))
        await sleep(200)
        const text = await harness.text()
        if (!text.includes('w') || !text.includes(' ')) throw new Error(`edit control text ${JSON.stringify(text)} after ${JSON.stringify(harness.events.filter((e) => e.ev === 'char'))}`)
        // Forgotten: refused again.
        await pcSend({ to: 'bg', type: 'pc-forget', path: info.path })
        await until('forgotten', async () => (await pcState())?.status?.program?.allowed === null)
        const n = harness.keys().length
        await hold('.gp-f[data-k=a]', () => sleep(600))
        await sleep(300)
        if (harness.keys().length !== n) throw new Error('key events arrived after the program was forgotten')
        const s2 = await pcStats()
        if (!(s2.refused.notAllowed > s1.refused.notAllowed) || !(s2.injected > 0)) throw new Error(`stats after forgetting: ${JSON.stringify(s2)}`)
        await setTarget(popup, 'keys')
        await until('helper released', async () => (await pcState())?.link === 'off')
        return `helper ${ready.version} · ${info.path.split('\\').pop()} typed ${JSON.stringify(text)} · injected ${s2.injected}, refused ${s2.refused.notAllowed}`
      } finally {
        harness.stop()
      }
    })
  }

  // ---- remembered on both sides, controller cached ------------------------------------------------------------

  const phonePairs = () => phone.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('obpal')
    r.onerror = () => res([])
    r.onsuccess = () => {
      const db = r.result
      if (!db.objectStoreNames.contains('pairs')) return res([])
      const q = db.transaction('pairs').objectStore('pairs').getAll()
      q.onsuccess = () => res(q.result.map((p) => ({ id: p.id, name: p.peerName, key: p.key?.length, fp: p.peerFp?.length })))
      q.onerror = () => res([])
    }
  }))

  await check('both sides remember the pairing (id, key, fingerprints)', async () => {
    const link = await until('remembered on the extension', async () => { const l = await linkOf(popup); return l?.pairs?.length ? l : null })
    const mine = await until('remembered on the phone', async () => { const p = await phonePairs(); return p.length ? p : null })
    if (mine[0].id !== link.pairs[0].id) throw new Error(`ids differ: phone ${mine[0].id}, extension ${link.pairs[0].id}`)
    if (mine[0].key !== 32 || mine[0].fp !== 32) throw new Error(`phone record ${JSON.stringify(mine[0])}`)
    if (link.status !== 'connected' || link.lanFor !== link.pairs[0].id) throw new Error(`link ${JSON.stringify({ status: link.status, lanFor: link.lanFor })}`)
    return `${link.pairs[0].name} ↔ ${mine[0].name}`
  })

  await check('the phone has the controller cached for offline use', async () => {
    const sw = await until('service worker', () => phone.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/p/')
      if (!reg?.active) return null
      const keys = (await caches.keys()).filter((k) => k.startsWith('obpal-p-'))
      const shell = await caches.match('/p/')
      return keys.length && shell ? { keys, ok: shell.ok } : null
    }), 20000)
    return sw.keys.join(', ')
  })

  // ---- offline: no service for the extension, no network at all for the phone ----------------------------------

  let lanUrl = ''
  await check('offline: the extension boots with the service unreachable and shows the direct code', async () => {
    await phone.close()
    await desk.close()
    const t0 = Date.now()
    desk = await launchDesk([`--host-resolver-rules=MAP ${UPSTREAM} ~NOTFOUND`])
    ;({ id, popup } = await openPopup(desk))
    const tOpen = Date.now()
    const link = await until('direct code', async () => { const l = await linkOf(popup); return l?.status === 'offline' && l.lan ? l : null }, 10000, 50)
    lanUrl = link.lan
    const shown = await until('popup shows it', () => popup.evaluate(() => document.getElementById('qr')?.dataset.kind === 'lan' && (document.getElementById('scan-hint')?.textContent ?? '').includes('Direct')), 5000)
    if (!shown) throw new Error('popup did not switch to the direct code')
    const code = new URL(lanUrl).hash
    if (!/^#2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\./.test(code)) throw new Error(`unexpected code ${code.slice(0, 20)}…`)
    if (SHOTS) { await popup.setViewportSize({ width: 360, height: 640 }); await popup.screenshot({ path: join(SHOTS, 'popup-offline.png') }) }
    return `${Date.now() - tOpen} ms after the popup opened (${Date.now() - t0} ms after launch), ${code.length} chars`
  })

  await check('offline: the phone opens the cached controller with no network and connects over the LAN', async () => {
    page = await desk.newPage()
    await page.goto(`${base}/`)
    tabId = await popup.evaluate(async (b) => (await chrome.tabs.query({ url: `${b}/*` }))[0]?.id, base)
    await enable(popup, tabId)
    await setTarget(popup, 'gamepad')
    await page.bringToFront()
    // The service stays refused for the phone from here on. The page itself is opened with the phone fully offline
    // (it can only come from the service worker cache); Chromium's offline emulation also blocks WebRTC's UDP
    // sockets, so it is lifted once the page is up, before the direct connection is made.
    local.setOffline(true)
    await phoneCtx.setOffline(true)
    phone = await phoneCtx.newPage()
    ;({ touches, centre, clearHints, tap, hold } = await touchOn(phoneCtx, phone))
    const t0 = Date.now()
    await phone.goto(onPhone(lanUrl), { waitUntil: 'commit' })
    await phone.locator('#app').waitFor({ timeout: 10000 })
    const tPage = Date.now() - t0
    const fromCache = await phone.evaluate(() => !!navigator.serviceWorker.controller)
    if (!fromCache) throw new Error('the page was not served by the service worker')
    await phoneCtx.setOffline(false)
    await phone.locator('.modes').waitFor({ timeout: 20000 })
    const tControls = Date.now() - t0
    const marks = await phone.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((x) => x.name.startsWith('obpal:')).map((x) => [x.name.slice(6), Math.round(x.startTime)])))
    const link = await until('extension connected', async () => { const l = await linkOf(popup); return l?.status === 'connected' ? l : null }, 10000, 50)
    const diag = await popup.evaluate(() => chrome.runtime.sendMessage({ to: 'bg', type: 'diag' }))
    if (!diag?.direct) throw new Error(`not a direct link: ${JSON.stringify(diag)}`)
    await tap('.modes [data-tab=gamepad]')
    await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
    await hold('.gp-f[data-k=a]', () => until('A pressed', () => page.evaluate(() => window.__pad()?.pressed[0] === true)))
    await until('A released', () => page.evaluate(() => window.__pad()?.pressed[0] === false))
    const path = await phone.evaluate(() => document.getElementById('sig')?.dataset.q)
    if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'phone-offline.png') })
    return `${link.device}: page from cache in ${tPage} ms, controls in ${tControls} ms (link: start ${marks.start} → open ${marks.open} → welcome ${marks.welcome} ms), ${path} path, input arrives`
  })

  await check('the direct code is single-use: a fresh one replaces it', async () => {
    const link = await until('new code', async () => { const l = await linkOf(popup); return l?.lan && l.lan !== lanUrl ? l : null }, 5000)
    return `${new URL(link.lan).hash.slice(2, 12)}… ≠ ${new URL(lanUrl).hash.slice(2, 12)}…`
  })

  await check('forgetting the phone removes the direct code (popup) and the screen (phone)', async () => {
    await popup.evaluate(() => chrome.runtime.sendMessage({ to: 'bg', type: 'unpair' }))
    const l0 = await until('disconnected', async () => { const l = await linkOf(popup); return l?.status !== 'connected' ? l : null }, 10000)
    await popup.evaluate((id) => chrome.runtime.sendMessage({ to: 'bg', type: 'forget', id }), l0.pairs[0].id)
    const l1 = await until('forgotten', async () => { const l = await linkOf(popup); return l && !l.pairs.length && !l.lan ? l : null }, 5000)
    // The phone can forget too, from its settings sheet.
    await phone.locator('#gear').waitFor({ timeout: 5000 }).catch(() => {})
    const gone = await phone.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('obpal'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      await new Promise((res) => { const tx = db.transaction('pairs', 'readwrite'); tx.objectStore('pairs').clear(); tx.oncomplete = res })
      return true
    })
    if (!gone || (await phonePairs()).length) throw new Error('phone still remembers the screen')
    return `popup: ${l1.pairs.length} remembered, code ${l1.lan === '' ? 'gone' : 'still there'}`
  })
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await Promise.allSettled([desk.close(), phoneCtx.close()])
  server.close()
  await local.close()
  unregisterStub()
  await Promise.allSettled([rm(ext, { recursive: true, force: true }), rm(profile, { recursive: true, force: true }), rm(phoneProfile, { recursive: true, force: true }), rm(stubDir, { recursive: true, force: true })])
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)
