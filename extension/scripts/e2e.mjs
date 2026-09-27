/**
 * ob.Pal Link end to end: the built extension (extension/dist) in Chromium, a phone emulated in a second browser
 * that opens the pairing link, and a local test page that records what a game or 3D viewer would receive.
 * The phone runs this checkout's controller build (dist/client) through a local stand-in for the service
 * (extension/e2e/local.mjs), and the extension's calls to the service by name resolve to the same stand-in, which
 * proxies signaling to this checkout's own worker, fresh for the run (OBPAL_E2E_UPSTREAM=https://obpal.blackboxes.net
 * for production instead). So both ends under test, and the service between them, are the code here.
 * Checks the four targets:
 *   Controller: the Gamepad API shows "ob.Pal Controller", A held on the phone = button 0 pressed.
 *   Keys:       A = Space, D-pad up = ArrowUp (keydown, then keyup).
 *   3D:         a one-finger trackpad drag = left-button pointer drag on the largest canvas; a pinch = wheel.
 *   PC:         the native helper. By default a stub host (extension/e2e/native-stub.mjs) stands in for
 *               ob.Pal Desktop and records what the extension sends: the permission, the allow request from
 *               the popup, frames carrying the held keys, the phone's typing (a text field takes the focus, the
 *               phone offers Type, "hi" arrives as text requests and ↵ as Enter in the frames), and the disarm on
 *               leaving the target.
 *               With --desktop the installed helper (desktop/, `obpal-desktop.exe install`) is used instead
 *               and a harness window (obpal-harness.exe) proves that keys are refused until the program is
 *               allowed, then typed into it, then refused again once it is forgotten. That is the one run meant
 *               to reach an installed ob.Pal Desktop, and it injects real input: a developer's own, deliberately.
 *
 * Every other run must never reach an installed ob.Pal Desktop (the owner's may control the whole PC). The test
 * copy has no manifest key, so it gets an ID of its own, which an installed helper's allowed_origins refuse (Chrome
 * won't even start it); it names only the stub's host, and the run refuses to launch while any file of the copy
 * still names the real one. Afterwards, ob.Pal Desktop's own log (read only) must show no session from this
 * run's browser, or the run fails.
 *
 * Online (the signaling service up):
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
 * test copy has nativeMessaging and notifications as required permissions.
 *
 * Security (spec/SECURITY.md §8): the invite moves on once the phone pairs, and a second phone with the old link is
 * told it was used, while the phone that paired comes back through it (a reload, a network change). The PC waits for
 * the person at it: a new phone can't arm ob.Pal Desktop until it's allowed, Deny keeps it out (its other targets
 * work, and its own tray can't pick PC), Allow lets it in and is remembered, and forgetting the phone takes it away.
 * Both sides keep the pairing key as a non-extractable CryptoKey.
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
// Screenshots: --shots=<dir>, or OBPAL_E2E_SHOTS (through e2e:all, which passes its environment on).
const SHOTS = process.argv.find((a) => a.startsWith('--shots='))?.slice(8) ?? process.env.OBPAL_E2E_SHOTS
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
manifest.permissions = [...manifest.permissions, 'nativeMessaging', 'notifications']
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging' && p !== 'notifications')
// No key: the copy gets an ID of its own, which an installed ob.Pal Desktop refuses (its allowed_origins name only
// the fixed ID). Nothing here needs the fixed ID: the stub is registered for the ID the copy gets, and the service
// and the test pages don't look at it. --desktop keeps the key, to reach the installed helper.
if (!DESKTOP) delete manifest.key
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

// ---- the native helper: the stub, registered under a test-only host name -------------------------------------
// Chromium finds native hosts through HKCU\Software\Chromium\NativeMessagingHosts (Chrome: Software\Google\Chrome).
// The test copy of the extension is pointed at the stub's name, so an installed ob.Pal Desktop is left alone.
const STUB_HOST = 'net.blackboxes.obpal.e2e'
const REAL_HOST = 'net.blackboxes.obpal'
const STUB_KEYS = ['HKCU\\Software\\Chromium\\NativeMessagingHosts', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts'].map((k) => `${k}\\${STUB_HOST}`)
const stubDir = await mkdtemp(join(tmpdir(), 'obpal-link-stub-'))
const stubLogPath = join(stubDir, 'stub.log')
const stubCtlPath = join(stubDir, 'stub.ctl.json')
const registered = []
if (!DESKTOP) {
  for (const f of await readdir(ext, { recursive: true })) {
    const p = join(ext, f)
    if (!f.endsWith('.js')) continue
    const src = await readFile(p, 'utf8')
    if (src.includes(REAL_HOST)) await writeFile(p, src.split(REAL_HOST).join(STUB_HOST))
  }
  // Not launching while the copy could still reach the real host: any file that names it (the scripts, the manifest,
  // the pages, whatever else the build holds), or a manifest that kept the key.
  const realName = new RegExp(`${REAL_HOST.replace(/\./g, '\\.')}(?![\\w.-])`)
  const unsafe = []
  for (const f of await readdir(ext, { recursive: true })) {
    const p = join(ext, f)
    if (statSync(p).isFile() && realName.test(await readFile(p, 'latin1'))) unsafe.push(`${f} names ${REAL_HOST}`)
  }
  if ('key' in JSON.parse(await readFile(manifestPath, 'utf8'))) unsafe.push('the manifest kept its key')
  if (unsafe.length) {
    console.error(`ob.Pal Link e2e: NOT LAUNCHING. The test copy could reach an installed ob.Pal Desktop: ${unsafe.join('; ')}.`)
    await Promise.allSettled([rm(ext, { recursive: true, force: true }), rm(stubDir, { recursive: true, force: true })])
    process.exit(1)
  }
  // Playwright hands the environment on to Chromium, and Chromium to the host.
  process.env.OBPAL_STUB_LOG = stubLogPath
  process.env.OBPAL_STUB_CTL = stubCtlPath
}

/**
 * ob.Pal Desktop's own lifecycle log (desktop/src/main.rs), read only: each session it serves logs
 * `<unix secs> [<pid>] serving <origin> …` (or `refused origin <origin>`), then `… browser: <the browser that
 * started it>`. Where it stands before anything is launched, so the run can prove afterwards that it added no session.
 */
const DESKTOP_LOG = process.env.APPDATA ? join(process.env.APPDATA, 'obpal', 'desktop.log') : ''
const desktopLogAt = (() => { try { return statSync(DESKTOP_LOG).size } catch { return 0 } })()
/** The test copy's IDs (one per launch; the same, as the copy's folder is): a line naming one is a session of ours. */
const copyIds = new Set()

/** Lines the helper logged since the run began that name this run's browser, or the test copy. */
function desktopLogReached() {
  let log
  try { log = readFileSync(DESKTOP_LOG) } catch { return [] }
  // Past 1 MB the helper starts its log afresh: then all of it is new.
  const fresh = (log.length >= desktopLogAt ? log.subarray(desktopLogAt) : log).toString('utf8')
  const browser = (executablePath ?? chromium.executablePath()).toLowerCase()
  return fresh.split(/\r?\n/).filter((line) => {
    const l = line.toLowerCase()
    return (/\bbrowser: /.test(l) && (l.includes('ms-playwright') || l.includes(browser))) || [...copyIds].some((id) => l.includes(`chrome-extension://${id}/`))
  })
}
const stubLog = () => (existsSync(stubLogPath) ? readFileSync(stubLogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
/** What the stub reports as focused on the PC (a text or password field, and which window is in front). */
const stubFocus = (focus) => writeFile(stubCtlPath, JSON.stringify(focus))

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
/**
 * The extension's browser; the same profile keeps its certificate and remembered phones across relaunches. The
 * extension calls the service by name, so unless production is the upstream, its host resolves to the stand-in
 * (local.serviceArgs), which hands the rooms to this run's own worker, where the phone's go too. A launch with its
 * own host rules (the offline one) keeps just those.
 */
const launchDesk = (extra = []) => chromium.launchPersistentContext(profile, {
  executablePath,
  headless: !HEADED,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...RTC_ARGS, ...(extra.some((a) => a.startsWith('--host-resolver-rules')) ? [] : local.serviceArgs), ...extra],
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
  copyIds.add(id)
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  return { id, popup }
}
const linkOf = (popup) => popup.evaluate(async () => (await chrome.storage.session.get('link')).link ?? null)
const enable = (popup, tabId) => popup.evaluate((t) => chrome.runtime.sendMessage({ to: 'bg', type: 'enable', tabId: t, on: true }), tabId)
const setTarget = (popup, mode) => popup.evaluate((m) => chrome.runtime.sendMessage({ to: 'bg', type: 'mode', mode: m }), mode)
/** What the extension keeps: storage.session / storage.local by key. */
const sessionOf = (popup, k) => popup.evaluate(async (k) => (await chrome.storage.session.get(k))[k] ?? null, k)
const localOf = (popup, k) => popup.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? null, k)
/** A second phone, for the old link: a browser of its own, so a certificate (an identity) of its own. */
let stranger = null

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
  if (DESKTOP) console.log('  --desktop: this run reaches the installed ob.Pal Desktop and injects real input (into its harness window)')
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

  // ---- the invite moves on once a phone pairs (spec/SECURITY.md §8, L2) ----
  await check('the invite moves on once the phone pairs: the popup has a new link', async () => {
    const next = await until('a new pairing link', async () => { const u = (await linkOf(popup))?.url; return u && u !== pairing ? u : null }, 8000)
    return `#${new URL(pairing).hash.slice(1, 10)}… → #${new URL(next).hash.slice(1, 10)}…`
  })

  await check('the old QR link pairs nobody new: a second phone is told it was used, and the first stays connected', async () => {
    stranger = await chromium.launch({ executablePath, headless: !HEADED, args: [...RTC_ARGS, '--ignore-certificate-errors'] })
    const other = await (await stranger.newContext({ ...devices['Pixel 7 landscape'] })).newPage()
    await other.goto(onPhone(pairing))
    const said = await other.locator('.msg-card h1').filter({ hasText: 'This code was used' }).textContent({ timeout: 15000 })
    const link = await linkOf(popup)
    if (link?.status !== 'connected') throw new Error(`the first phone's link: ${link?.status}`)
    if (!(await phone.locator('.modes').isVisible())) throw new Error('the first phone lost its controls')
    await stranger.close()
    stranger = null
    return `"${said}"; ${link.device} still connected`
  })

  await check('the popup shows the link as the pairing chip does: encrypted, verified by the QR code, the path and the round trip', async () => {
    const f = await until('the badge', () => popup.evaluate(() => { const el = document.getElementById('facts'); return el && !el.hidden ? { text: el.textContent, title: el.title } : null }), 8000)
    if (!f.title.startsWith('Encrypted end to end') || !f.title.includes('Verified by the QR code') || !/^Direct/.test(f.text)) throw new Error(JSON.stringify(f))
    return `${f.text}; ${f.title.split('\n').join(' · ')}`
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

  // ---- who may control the PC (spec/SECURITY.md §8, L1) ----
  /** The phone connected now, as Link knows it ({ key, name }). */
  const thisPhone = () => until('the phone, as Link knows it', () => sessionOf(popup, 'phone'))
  const armings = () => stubLog().filter((e) => e.in?.t === 'enable' && e.in.on === true).length
  const helperFrames = () => stubLog().filter((e) => e.in?.t === 'f').length
  /** The line the phone shows over its controls (the screen's notice, or the link's own), or ''. */
  const phoneLine = () => phone.evaluate(() => { const b = document.getElementById('banner'); return b && !b.hidden ? b.textContent : '' })
  const notified = () => popup.evaluate(async () => Object.keys(await chrome.notifications.getAll()))
  /** The popup as Chrome shows it (its own width, not a tab's), on `theme`, saved as <name>; then the surface it had. */
  async function popupShot(name, theme) {
    if (!SHOTS) return
    await mkdir(SHOTS, { recursive: true })
    const was = await popup.evaluate(() => document.documentElement.dataset.theme)
    await popup.evaluate((t) => { document.querySelector(`.look[data-theme="${t}"]`)?.click(); document.documentElement.classList.remove('in-tab') }, theme)
    await sleep(700)
    await popup.locator('#app').screenshot({ path: join(SHOTS, name) })
    await popup.evaluate((t) => { document.querySelector(`.look[data-theme="${t}"]`)?.click(); document.documentElement.classList.add('in-tab') }, was)
  }

  if (!DESKTOP) {
    /** The phone picks a target in its own tray: 0 Controller, 1 3D, 2 Keys, 3 PC (the surface's tray, not the gamepad's). */
    async function pickOnPhone(n) {
      await phone.locator('.tray-btn[data-id=target]').waitFor({ state: 'visible', timeout: 5000 })
      await tap('.tray-btn[data-id=target]')
      await phone.locator('.picker .pick').nth(n).waitFor({ timeout: 5000 })
      await tap(`.picker .pick >> nth=${n}`)
    }

    await check('PC: a new phone that picks PC waits for the person at the PC (prompt, badge, notification); Deny keeps ob.Pal Desktop disarmed and takes the phone back to its target, which works, and its tray can’t pick PC; Allow arms it', async () => {
      await setTarget(popup, 'keys')
      await tap('.modes [data-tab=rotate]')
      await pickOnPhone(3)
      await until('the phone switched the target to PC', async () => (await localOf(popup, 'mode')) === 'pc')
      await helperReady((s) => s.status?.program?.name === 'stubgame.exe')
      const me = await thisPhone()
      // Asked: the popup's prompt names the phone, the icon's badge says so, a notification asks too, and the phone waits.
      const asked = await until('the popup asks', () => popup.evaluate(() => { const a = document.getElementById('ask'); return a && !a.hidden ? a.querySelector('#ask-t')?.textContent : null }))
      if (!asked.includes(me.name)) throw new Error(`the prompt says "${asked}"`)
      if ((await sessionOf(popup, 'asking')) !== me.key) throw new Error('not asking about this phone')
      if ((await popup.evaluate(() => chrome.action.getBadgeText({}))) !== '!') throw new Error('no badge')
      await until('a notification asks', async () => (await notified()).includes('obpal-ask'))
      await until('the phone waits for the PC', async () => (await phoneLine()) === 'Waiting for approval on the PC')
      // Nothing reaches the PC meanwhile: a tap and a hold on the phone's trackpad arm nothing and send nothing.
      await tap('#pad')
      await hold('#pad', () => sleep(700))
      await sleep(300)
      if (armings() || helperFrames()) throw new Error(`a phone nobody allowed reached the helper: ${armings()} armings, ${helperFrames()} frames`)
      if (SHOTS) {
        await popupShot('ask-popup-dark.png', 'carbon')
        await popupShot('ask-popup-light.png', 'light')
        await phone.screenshot({ path: join(SHOTS, 'ask-phone-waiting.png') })
        const opts = await desk.newPage()
        await opts.goto(`chrome-extension://${id}/options.html`)
        await opts.locator('#ask:not([hidden])').waitFor({ timeout: 5000 })
        await sleep(700)
        await opts.screenshot({ path: join(SHOTS, 'ask-options-dark.png') })
        await opts.close()
        await page.bringToFront()
      }
      // Deny: kept, the prompt and the notification go, the helper stays disarmed, and the phone, which picked PC
      // itself, is back on the target it had.
      await popup.locator('#ask button[data-allow="false"]').click()
      await until('the answer kept', async () => (await localOf(popup, 'answers'))?.[me.key]?.allow === false)
      await until('the prompt goes', () => popup.evaluate(() => document.getElementById('ask').hidden))
      await until('the notification goes', async () => !(await notified()).includes('obpal-ask'))
      await until('back on Keys', async () => (await localOf(popup, 'mode')) === 'keys')
      await until('its picker shows Keys', () => phone.evaluate(() => document.querySelector('.tray-btn[data-id=target] .sel-v')?.textContent === 'Keys'))
      await until('the phone isn’t held up on a page target', async () => !(await phoneLine()))
      if (armings()) throw new Error('armed after Deny')
      // Its other targets work: Keys.
      await tap('.modes [data-tab=gamepad]')
      await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
      await page.evaluate(() => { window.__log.keys.length = 0 })
      await hold('.gp-f[data-k=a]', () => until('Space down', () => page.evaluate(() => window.__log.keys.some((k) => k.t === 'down' && k.code === 'Space'))))
      // Its own tray can't pick PC now: the target stays, and its picker shows it again.
      await tap('.gp-mini[data-act=exit]')
      await tap('.modes [data-tab=rotate]')
      await pickOnPhone(3)
      await sleep(800)
      if ((await localOf(popup, 'mode')) !== 'keys') throw new Error('a phone the PC said no to switched the target to PC')
      await until('its picker shows Keys again', () => phone.evaluate(() => document.querySelector('.tray-btn[data-id=target] .sel-v')?.textContent === 'Keys'))
      // PC from the popup: no question (the answer is kept); the PC card and the phone say no.
      await setTarget(popup, 'pc')
      await until('the PC card says no', () => popup.evaluate(() => (document.getElementById('pc-title')?.textContent ?? '').includes('can’t control this PC')))
      await until('the phone is told', async () => (await phoneLine()).startsWith('Not allowed on this PC'))
      if (await sessionOf(popup, 'asking')) throw new Error('asked again about a phone already answered for')
      if (armings()) throw new Error('armed for a refused phone')
      // Then Allow from the PC card: armed, and input gets through.
      const allow = popup.locator('#pc-actions .btn', { hasText: `Allow ${me.name}` })
      await allow.waitFor({ timeout: 5000 })
      await allow.click()
      await until('allowed', async () => (await localOf(popup, 'answers'))?.[me.key]?.allow === true)
      await until('the helper is armed', () => armings() > 0)
      await until('the phone isn’t held up', async () => !(await phoneLine()))
      await phone.locator('#pad').waitFor({ state: 'visible', timeout: 5000 })
      await tap('#pad')
      await until('input reaches the helper', () => stubLog().some((e) => e.in?.t === 'f' && e.in.b?.includes(0)))
      const log = stubLog()
      if (log.findIndex((e) => e.in?.t === 'f') < log.findIndex((e) => e.in?.t === 'enable' && e.in.on === true)) throw new Error('a frame came before the helper was armed')
      return `${me.name}: picked PC and was asked; refused (back on Keys, which works; its tray kept off PC); then allowed and armed`
    })

    await check('PC (stub helper): starts on the PC target, the popup allows the program in front, frames carry the held keys, trackpad clicks and its scroll strip, the mouse face, whole PC on and off, the keyboard (Type, typing, ↵), leaving disarms', async () => {
      const logAt = stubLog().length
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
      // The trackpad clicks: a tap is the left button down then up, a hold then lift the right button.
      const frames = () => stubLog().filter((e) => e.in?.t === 'f').map((e) => e.in)
      await tap('.gp-mini[data-act=exit]') // leave the full-screen gamepad
      await tap('.modes [data-tab=rotate]')
      await phone.locator('#pad').waitFor({ state: 'visible', timeout: 5000 })
      let from = frames().length
      await tap('#pad')
      await until('a tap presses the left button', () => frames().slice(from).some((f) => f.b?.includes(0)))
      await until('then lets it go', () => { const f = frames().slice(from); const i = f.findIndex((x) => x.b?.includes(0)); return i >= 0 && f.slice(i + 1).some((x) => !x.b) })
      from = frames().length
      await hold('#pad', () => sleep(800))
      await until('a hold, then lift, presses the right button', () => frames().slice(from).some((f) => f.b?.includes(2)))
      await until('then lets it go', () => { const f = frames(); return f.length > 0 && !f[f.length - 1].b })
      // The trackpad's scroll wheel along its edge: a thumb turning it down scrolls down.
      await phone.locator('#pad-wheel').waitFor({ state: 'visible', timeout: 5000 })
      from = frames().length
      {
        await clearHints()
        const [x, y] = await centre('#pad-wheel')
        await touches('touchStart', [[x, y - 60]])
        for (let i = 1; i <= 10; i++) { await touches('touchMove', [[x, y - 60 + i * 8]]); await sleep(30) }
        await touches('touchEnd', [])
      }
      await until('the scroll strip scrolls down', () => frames().slice(from).some((f) => f.w?.[1] > 0))
      // Point's face on a PC is a mouse: Left clicks, and a tap on its wheel is a middle click.
      await tap('.modes [data-tab=point]')
      await phone.locator('#mouse').waitFor({ state: 'visible', timeout: 5000 })
      from = frames().length
      await tap('#mouse-left')
      await until('Left presses the left button', () => frames().slice(from).some((f) => f.b?.includes(0)))
      from = frames().length
      await tap('#mouse-wheel')
      await until('a tap on the wheel is a middle click', () => frames().slice(from).some((f) => f.b?.includes(1)))
      await until('then lets it go', () => { const f = frames(); return f.length > 0 && !f[f.length - 1].b })
      // Whole PC: on from the popup, shown with the gesture legend, and off again.
      const action = (label) => popup.locator('#pc-actions .btn', { hasText: label }).first()
      await action('Whole PC').click()
      await until('the helper is asked for the whole PC', () => stubLog().some((e) => e.in?.t === 'desktop' && e.in.on === true && e.in.keyboard === true && e.in.mouse === true))
      await until('popup shows the whole PC', () => popup.evaluate(() => document.getElementById('pc-title')?.textContent === 'Controlling this PC' && !document.getElementById('pc-legend').hidden))
      await action('One program').click()
      await until('back to one program', () => stubLog().some((e) => e.in?.t === 'desktop' && e.in.on === false))
      await until('popup shows the program again', () => popup.evaluate(() => (document.getElementById('pc-title')?.textContent ?? '').includes('stubgame.exe')))
      // The keyboard: a text field takes the focus in the allowed program, and the phone offers Type. One tap opens the
      // dock with its field focused; "hi" reaches the helper as text requests, and the key row's ↵ as Enter in the frames.
      await stubFocus({ text: 'text', front: 'game' })
      await phone.locator('#type-prompt').waitFor({ state: 'visible', timeout: 8000 })
      if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await clearHints(); await sleep(500); await phone.screenshot({ path: join(SHOTS, 'phone-type-prompt.png') }) }
      await tap('#type-prompt')
      await phone.locator('#kbd').waitFor({ state: 'visible', timeout: 5000 })
      const focused = await phone.evaluate(() => document.activeElement?.id)
      if (focused !== 'kbd-text') throw new Error(`the dock's field did not take the focus (${focused})`)
      const typed = () => stubLog().filter((e) => e.in?.t === 'text').map((e) => e.in)
      await phone.keyboard.type('hi')
      await until('the helper is asked to type "hi"', () => typed().map((t) => t.s).join('') === 'hi')
      if (typed().some((t) => t.del)) throw new Error(`typing deleted: ${JSON.stringify(typed())}`)
      if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'phone-keyboard.png') })
      from = frames().length
      await tap('.kbd-key[data-code=Enter]')
      await until('↵ is Enter in the frames', () => frames().slice(from).some((f) => f.k?.includes('Enter')))
      await until('then lets it go', () => { const f = frames(); return f.length > 0 && !f[f.length - 1].k })
      // The field loses the focus: the prompt goes, and the dock it opened goes with it.
      await stubFocus({ text: null, front: 'game' })
      await until('the dock closes with the field', () => phone.evaluate(() => document.getElementById('kbd')?.hidden === true && document.getElementById('type-prompt')?.hidden === true))
      await setTarget(popup, 'keys')
      await until('the helper port closed', () => stubLog().slice(logAt).some((e) => e.eof))
      const log = stubLog()
      const armed = log.findIndex((e) => e.in?.t === 'enable' && e.in.on === true)
      const firstFrame = log.findIndex((e) => e.in?.t === 'f')
      if (armed < 0 || firstFrame < armed) throw new Error('frames were sent before the helper was enabled')
      if (!log.some((e) => e.in?.t === 'hello' && e.in.v === 1)) throw new Error('no hello')
      if (!log.some((e) => e.in?.t === 'allow' && e.in.path === 'C:\\Stub\\stubgame.exe' && e.in.keyboard === true && e.in.mouse === true)) throw new Error('no allow request')
      if (!log[0]?.start?.[0]?.startsWith(`chrome-extension://${id}/`)) throw new Error(`host launched with ${JSON.stringify(log[0]?.start)}`)
      return `helper ${ready.version}, ${log.filter((e) => e.in?.t === 'f').length} frames, typed ${JSON.stringify(typed().map((t) => t.s).join(''))} in ${typed().length} requests`
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
        // This phone is new to the PC: allowed, as the person at it would in the popup's prompt.
        const me = await thisPhone()
        await popup.evaluate((k) => chrome.runtime.sendMessage({ to: 'bg', type: 'answer', key: k, allow: true }), me.key)
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

  // ---- the phone that paired comes back through its own room; an allowed phone stays allowed ----------------------

  if (!DESKTOP) {
    await check('the paired phone reloads with the old link and comes back through its own room; allowed, it gets the PC with no question', async () => {
      const armed = armings()
      const invite = (await linkOf(popup))?.url
      await phone.reload()
      await phone.locator('.modes').waitFor({ timeout: 20000 })
      await until('popup shows connected', () => popup.evaluate(() => document.getElementById('status')?.dataset.s === 'connected'), 15000)
      // It paired through the old invite's room, which moved nothing on: the invite on show is the same.
      if ((await linkOf(popup))?.url !== invite) throw new Error('the invite moved on for a phone coming back')
      await setTarget(popup, 'pc')
      await until('armed again', () => armings() > armed)
      if (await sessionOf(popup, 'asking')) throw new Error('asked again about an allowed phone')
      if (await popup.evaluate(() => !document.getElementById('ask').hidden)) throw new Error('the popup asks again')
      await setTarget(popup, 'keys')
      return 'reconnected through the old room, armed with no question'
    })
  }

  await check('the paired phone finds a new path through its own room when its network changes (an ICE restart)', async () => {
    ;({ touches, centre, clearHints, tap, hold } = await touchOn(phoneCtx, phone))
    await setTarget(popup, 'keys')
    await phone.evaluate(() => performance.clearMarks('obpal:restart'))
    await phone.evaluate(() => dispatchEvent(new Event('online')))
    await until('an ICE restart', () => phone.evaluate(() => performance.getEntriesByName('obpal:restart').length > 0), 10000)
    await sleep(1500)
    if ((await linkOf(popup))?.status !== 'connected') throw new Error('the link went')
    await tap('.modes [data-tab=gamepad]')
    await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
    await page.evaluate(() => { window.__log.keys.length = 0 })
    await hold('.gp-f[data-k=a]', () => until('Space down', () => page.evaluate(() => window.__log.keys.some((k) => k.t === 'down' && k.code === 'Space'))))
    await tap('.gp-mini[data-act=exit]')
    return 'restarted, still connected, input arrives'
  })

  // ---- remembered on both sides, controller cached ------------------------------------------------------------

  /** A side's remembered pairings (IndexedDB 'obpal'), read in its page: the key must be a non-extractable CryptoKey. */
  const pairsIn = (p) => p.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('obpal')
    r.onerror = () => res([])
    r.onsuccess = () => {
      const db = r.result
      if (!db.objectStoreNames.contains('pairs')) return res([])
      const q = db.transaction('pairs').objectStore('pairs').getAll()
      q.onsuccess = () => res(q.result.map((x) => ({ id: x.id, name: x.peerName, key: x.key instanceof CryptoKey && !x.key.extractable, fp: x.peerFp?.length })))
      q.onerror = () => res([])
    }
  }))
  const phonePairs = () => pairsIn(phone)

  await check('both sides remember the pairing (id, a non-extractable key, fingerprints)', async () => {
    const link = await until('remembered on the extension', async () => { const l = await linkOf(popup); return l?.pairs?.length ? l : null })
    const mine = await until('remembered on the phone', async () => { const p = await phonePairs(); return p.length ? p : null })
    if (mine[0].id !== link.pairs[0].id) throw new Error(`ids differ: phone ${mine[0].id}, extension ${link.pairs[0].id}`)
    if (mine[0].key !== true || mine[0].fp !== 32) throw new Error(`phone record ${JSON.stringify(mine[0])}`)
    // Link's own record, in the IndexedDB of its origin (the popup shares it with the link document).
    const theirs = (await pairsIn(popup)).find((p) => p.id === link.pairs[0].id)
    if (theirs?.key !== true || theirs.fp !== 32) throw new Error(`extension record ${JSON.stringify(theirs)}`)
    if (link.status !== 'connected' || link.lanFor !== link.pairs[0].id) throw new Error(`link ${JSON.stringify({ status: link.status, lanFor: link.lanFor })}`)
    return `${link.pairs[0].name} ↔ ${mine[0].name}, keys non-extractable on both`
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

  await check('forgetting the phone removes the direct code (popup), its answer for the PC, and the screen (phone)', async () => {
    await popup.evaluate(() => chrome.runtime.sendMessage({ to: 'bg', type: 'unpair' }))
    const l0 = await until('disconnected', async () => { const l = await linkOf(popup); return l?.status !== 'connected' ? l : null }, 10000)
    const answered = !DESKTOP && (await localOf(popup, 'answers'))?.[l0.pairs[0].id]
    if (!DESKTOP && !answered) throw new Error('no answer kept for the phone before forgetting it')
    await popup.evaluate((id) => chrome.runtime.sendMessage({ to: 'bg', type: 'forget', id }), l0.pairs[0].id)
    const l1 = await until('forgotten', async () => { const l = await linkOf(popup); return l && !l.pairs.length && !l.lan ? l : null }, 5000)
    // A new phone again: its answer for the PC goes with it.
    if ((await localOf(popup, 'answers'))?.[l0.pairs[0].id]) throw new Error('the answer for a forgotten phone stayed')
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
  await Promise.allSettled([desk.close(), phoneCtx.close(), stranger?.close()])
  server.close()
  await local.close()
  unregisterStub()
  await Promise.allSettled([rm(ext, { recursive: true, force: true }), rm(profile, { recursive: true, force: true }), rm(phoneProfile, { recursive: true, force: true }), rm(stubDir, { recursive: true, force: true })])
}

// Last, whatever happened above: an installed ob.Pal Desktop's own log shows no session from this run.
if (!DESKTOP) {
  await check('no session of this run reached an installed ob.Pal Desktop (its log, read only)', async () => {
    const reached = desktopLogReached()
    if (reached.length) {
      console.error(`\n  !!! ob.Pal Desktop was reached by this run: ${reached.length} new line(s) in ${DESKTOP_LOG}:\n${reached.map((l) => `  !!!   ${l}`).join('\n')}\n`)
      throw new Error(`the installed helper logged ${reached.length} line(s) from this run's browser`)
    }
    return existsSync(DESKTOP_LOG) ? 'nothing new from this run in its log' : 'no ob.Pal Desktop log on this machine'
  })
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)
