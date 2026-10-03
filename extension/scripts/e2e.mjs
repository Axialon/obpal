/**
 * ob.Pal Link end to end: the built extension (extension/dist) in Chromium, a phone emulated in a second browser
 * that opens the pairing link, and an intercepted test page that records what a game or 3D viewer would receive.
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
 * therefore also gets host access to the local test page (https://127.0.0.1/*), and "This tab" is switched on
 * with the same message the popup sends. Optional permissions can't be granted by automation either, so the
 * test copy has nativeMessaging and notifications as required permissions.
 *
 * Security (spec/SECURITY.md §8): the invite moves on once the phone pairs, and a second phone with the old link is
 * told it was used, while the phone that paired comes back through it (a reload, a network change). The PC waits for
 * the person at it: a new phone can't arm ob.Pal Desktop until it's allowed, Deny keeps it out (its other targets
 * work, and its own tray can't pick PC), Allow lets it in and is remembered, and forgetting the phone takes it away.
 * Both sides keep the pairing key as a non-extractable CryptoKey.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'
import { nativePort } from '../e2e/native-port.mjs'
import { startLocal, UPSTREAM } from '../e2e/local.mjs'
import { visitLinkButtons, assertButtonInk } from '../../scripts/lib/surface-buttons.mjs'
import { e2eBrowserOptions } from '../../scripts/lib/browser.mjs'
import { interactionStates } from '../../scripts/lib/interaction-states.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEADED = process.argv.includes('--headed')
// Screenshots: --shots=<dir>, or OBPAL_E2E_SHOTS (through e2e:all, which passes its environment on).
const SHOTS = process.argv.find((a) => a.startsWith('--shots='))?.slice(8) ?? process.env.OBPAL_E2E_SHOTS
/** Optional journey evidence, after the behavior assertion has passed. */
async function shot(page, name) {
  if (!SHOTS) return
  await mkdir(SHOTS, { recursive: true })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true })
}
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
await cp(process.env.OBPAL_E2E_EXTENSION_DIST || join(root, 'dist'), ext, { recursive: true })
const manifestPath = join(ext, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.host_permissions = [...manifest.host_permissions, 'https://127.0.0.1/*']
manifest.permissions = [...manifest.permissions, 'nativeMessaging', 'notifications']
manifest.optional_permissions = (manifest.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging' && p !== 'notifications')
// No key: the copy gets an ID of its own, which an installed ob.Pal Desktop refuses (its allowed_origins name only
// the fixed ID). Nothing here needs the fixed ID: the stub connects to the test worker's Port API, and the service
// and the test pages don't look at it. --desktop keeps the key, to reach the installed helper.
if (!DESKTOP) delete manifest.key
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

// ---- the inert native helper, connected through the test worker's Port API (no registry writes) ----
const STUB_HOST = 'net.blackboxes.obpal.e2e'
const REAL_HOST = 'net.blackboxes.obpal'
const stubDir = await mkdtemp(join(tmpdir(), 'obpal-link-stub-'))
const stubLogPath = join(stubDir, 'stub.log')
const stubCtlPath = join(stubDir, 'stub.ctl.json')
const stubPorts = []
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
const local = await startLocal({ dist: process.env.OBPAL_E2E_SITE_DIST })
const base = `${local.origin}/__game`
const gameOrigin = local.origin.replace('127.0.0.1', 'localhost')
const framed = `<!doctype html><title>Framed game</title><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe src="${gameOrigin}/__game/" allow="gamepad"></iframe>`
const onPhone = (url) => url.replace(SERVICE, local.origin)

const profile = await mkdtemp(join(tmpdir(), 'obpal-link-profile-'))
const phoneProfile = await mkdtemp(join(tmpdir(), 'obpal-link-phone-'))
/**
 * The extension's browser; the same profile keeps its certificate and remembered phones across relaunches. The
 * extension calls the service by name, so unless production is the upstream, its host resolves to the stand-in
 * (local.serviceArgs), which hands the rooms to this run's own worker, where the phone's go too. A launch with its
 * own host rules (the offline one) keeps just those.
 */
const launchDesk = async (extra = []) => {
  const ctx = await chromium.launchPersistentContext(profile, e2eBrowserOptions({
    executablePath,
    headless: !HEADED,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...RTC_ARGS, ...(extra.some((a) => a.startsWith('--host-resolver-rules')) ? [] : local.serviceArgs), ...extra],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  }))
  await ctx.route('**/__game/**', (route) => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname.endsWith('/framed') ? framed : page0 }))
  return ctx
}
/** The phone: a persistent context too, so its service worker cache and its remembered screens survive. */
const phoneCtx = await chromium.launchPersistentContext(phoneProfile, e2eBrowserOptions({
  ...devices['Pixel 7 landscape'], executablePath, headless: !HEADED, args: [...RTC_ARGS, '--ignore-certificate-errors'],
}))
let desk = await launchDesk()

async function openPopup(ctx) {
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  if (!DESKTOP) stubPorts.push(await nativePort(worker, STUB_HOST, join(root, 'e2e', 'native-stub.mjs')))
  copyIds.add(id)
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  return { id, popup }
}
const linkOf = (popup) => popup.evaluate(async () => (await chrome.storage.session.get('link')).link ?? null)
/** Compare the authenticated seal through each side's persistent UI, then leave the controls clear. */
async function compareSeal(popup, phone) {
  const seal = await until('the extension seal deadline', async () => {
    const link = await linkOf(popup)
    const value = link?.seal
    return Array.isArray(value) && value.length === 3 && value.every(i => Number.isInteger(i) && i >= 0 && i < 64) && Number.isFinite(link.sealAt) ? value.join('-') : null
  }, 10000)
  const pulse = await until('the popup seal pulse starts', () => popup.evaluate(() => {
    const moments = document.querySelectorAll('#qr .seal-flight')
    const moment = moments[0]
    if (!moment?.dataset.started) return null
    const box = moment.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return { count: moments.length, pointer: getComputedStyle(moment).pointerEvents, blocks: !!hit?.closest('.seal-flight'), hidden: moment.getAttribute('aria-hidden') }
  }), 5000, 50)
  if (pulse.count !== 1 || pulse.pointer !== 'none' || pulse.blocks || pulse.hidden !== 'true') throw new Error(`popup pulse catches input or repeats: ${JSON.stringify(pulse)}`)
  const open = popup.getByRole('button', { name: 'Seal', exact: true })
  await open.waitFor({ state: 'visible', timeout: 5000 })
  const panel = popup.locator('#link-seal')
  await popup.locator('#qr .connection-seal').waitFor({ state: 'visible', timeout: 5000 })
  const statusSeal = phone.locator('.link-badge .seal-compact')
  await statusSeal.waitFor({ state: 'visible', timeout: 5000 })
  if (await statusSeal.getAttribute('data-seal') !== seal) throw new Error('phone status shows a different seal')
  await open.click()
  const connection = phone.getByRole('dialog', { name: 'Connection', exact: true })
  try {
    await panel.waitFor({ state: 'visible', timeout: 3000 })
    await phone.locator('.link-badge').click()
    await connection.waitFor({ state: 'visible', timeout: 3000 })
    const phoneSeal = connection.locator('.connection-seal')
    const popupSeal = panel.locator('.connection-seal')
    await Promise.all([phoneSeal.waitFor({ state: 'visible', timeout: 10000 }), popupSeal.waitFor({ state: 'visible', timeout: 10000 })])
    await until('both comparison seals', async () => (await phoneSeal.getAttribute('data-seal')) === seal && (await popupSeal.getAttribute('data-seal')) === seal, 10000)
    const names = await phoneSeal.locator('.seal-names small').allTextContents()
    const hostNames = await popupSeal.locator('.seal-names small').allTextContents()
    if (names.length !== 3 || JSON.stringify(names) !== JSON.stringify(hostNames)) throw new Error(`seal labels differ: ${names.join(', ')} / ${hostNames.join(', ')}`)
    for (const row of [phoneSeal, popupSeal]) {
      await row.locator('canvas').waitFor({ state: 'visible', timeout: 3000 })
      await until('visible seal dots', () => row.locator('canvas').evaluate(canvas => {
        if (!canvas.width || !canvas.height) return false
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
        return pixels.some((value, index) => index % 4 === 3 && value > 0)
      }), 3000)
    }
    return `${names.join(', ')} (popup pulse scheduled; input clear)`
  } finally {
    if (await connection.isVisible()) {
      await connection.getByRole('button', { name: 'Close', exact: true }).click()
      await connection.waitFor({ state: 'detached', timeout: 3000 })
    }
    if (await panel.getAttribute('data-expanded') !== null) await open.click()
    if (!(await popup.locator('#qr .connection-seal').isVisible())) throw new Error('closing comparison removed the persistent seal')
  }
}
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
  await check('popup: keyboard ring, pointer focus and six-surface contrast', () => interactionStates(popup, '.chip[aria-checked="true"]'))
  await check('popup and options: button ink within 0.5px at three sizes, Carbon and Light', async () => {
    const rows = [], opts = await desk.newPage()
    try {
      await opts.goto(`chrome-extension://${id}/options.html`)
      await check('options: keyboard ring, pointer focus and six-surface contrast', () => interactionStates(opts, '.bb-accent[aria-checked="true"]'))
      for (const p of [popup, opts]) {
        // The interaction probes leave the pointer over a chip; ink centring measures its resting icon.
        await p.mouse.move(0, 0)
        await p.evaluate(async () => {
          document.activeElement?.blur()
          getComputedStyle(document.documentElement).color
          await Promise.all(document.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})))
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        await visitLinkButtons(p, (_page, size, state, measured) => rows.push(...measured.map(r => ({ size, state, ...r }))))
      }
      return assertButtonInk(rows)
    } finally { await opts.close(); await popup.setViewportSize({ width: 1280, height: 800 }) }
  })
  console.log(`  extension ${id} · ${manifest.name} ${manifest.version} · phone via ${local.origin}`)

  let page = desk.pages()[0] ?? (await desk.newPage())
  await page.goto(`${base}/`)
  const pairing = await until('pairing link', async () => (await linkOf(popup))?.url || '', 20000)
  await check('popup and options show dot progress during reported startup and stop on completion', async () => {
    const previous = await popup.evaluate(() => chrome.storage.session.get(['link', 'pc']))
    const options = await desk.newPage()
    const before = !!process.env.OBPAL_E2E_EXTENSION_DIST
    try {
      // This reported-state fixture owns PC status. The page's initial helper demand would overwrite it;
      // permission and native-demand behavior use normal ports in the PC checks below.
      await options.addInitScript(() => {
        const connect = chrome.runtime.connect.bind(chrome.runtime)
        chrome.runtime.connect = (...args) => args[0]?.name === 'obpal-link/pc-page'
          ? connect({ name: 'obpal-link/e2e-reported-state' }) : connect(...args)
      })
      await options.goto(`chrome-extension://${id}/options.html`)
      await options.waitForFunction(() => document.documentElement.classList.contains('settled'))
      for (const width of [1280, 390]) {
        await popup.setViewportSize({ width, height: 844 })
        await options.setViewportSize({ width, height: 844 })
        await popup.evaluate(previous => chrome.storage.session.set({ link: { ...previous.link, status: 'connecting' }, pc: { ...previous.pc, link: 'connecting' } }), previous)
        await popup.waitForFunction(() => document.querySelector('#status')?.dataset.s === 'connecting')
        if (!before) {
          await popup.locator('#status .dot-loader').waitFor({ state: 'visible' })
          await options.locator('#note .dot-loader').waitFor({ state: 'visible' })
          const result = await popup.locator('#status .dot-loader').evaluate(el => ({ circles: el.children.length, label: el.getAttribute('aria-label'), rect: el.getBoundingClientRect().width }))
          if (result.circles !== 3 || !result.label || result.rect < 16) throw new Error(JSON.stringify(result))
        }
        await shot(popup, `dot-loaders-popup-${width}`)
        await shot(options, `dot-loaders-options-${width}`)
      }
      await popup.evaluate(previous => chrome.storage.session.set({ pc: { ...previous.pc, link: 'ready' } }), previous)
      if (!before) await options.locator('#note .dot-loader').waitFor({ state: 'hidden' })
      return before ? 'baseline status fixture; guarded copy' : 'reported state fixture; three labelled circles; both widths; guarded copy'
    } finally {
      await popup.evaluate(previous => chrome.storage.session.set(previous), previous)
      await popup.setViewportSize({ width: 1280, height: 800 })
      await options.close()
    }
  })
  let tabId = await popup.evaluate(async (b) => (await chrome.tabs.query({ url: `${b}/*` }))[0]?.id, base)
  await check('This tab acknowledgement shows progress until the guarded reply completes', async () => {
    // An extension tab stands in for the toolbar popup; report the real controlled tab once at startup.
    await popup.addInitScript(base => {
      if (sessionStorage.getItem('dot-tab-fixture')) return
      const query = chrome.tabs.query.bind(chrome.tabs)
      chrome.tabs.query = options => {
        if (!options.active || !options.currentWindow) return query(options)
        chrome.tabs.query = query
        sessionStorage.setItem('dot-tab-fixture', 'done')
        return query({ url: `${base}/*` })
      }
    }, base)
    await popup.reload()
    await popup.locator('#tab').waitFor({ state: 'visible' })
    await until('This tab available', () => popup.locator('#tab').isEnabled())
    await popup.evaluate(() => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime)
      chrome.runtime.sendMessage = (...args) => args[0]?.type === 'enable' ? new Promise(resolve => {
        window.__releaseTab = () => { chrome.runtime.sendMessage = send; return send(...args).then(resolve) }
      }) : send(...args)
    })
    try {
      await popup.locator('#tab').click()
      for (const width of [1280, 390]) {
        await popup.setViewportSize({ width, height: 844 })
        if (!process.env.OBPAL_E2E_EXTENSION_DIST) await popup.locator('#tab .dot-loader').waitFor({ state: 'visible' })
        await shot(popup, `dot-loaders-tab-answer-${width}`)
      }
    } finally {
      await popup.evaluate(() => window.__releaseTab?.())
      await popup.setViewportSize({ width: 1280, height: 800 })
    }
    if (!process.env.OBPAL_E2E_EXTENSION_DIST) await popup.locator('#tab .dot-loader').waitFor({ state: 'hidden' })
    return 'real guarded enable request; both widths; reply releases the busy state'
  })
  await enable(popup, tabId)
  // The controlled tab is the one in front (as when a person clicks the toolbar icon on it): pages in background
  // tabs get no animation frames, and the Gamepad API connection events run on them.
  await page.bringToFront()

  // ---- the phone ----
  let phone = await phoneCtx.newPage()
  let { touches, centre, clearHints, tap, hold } = await touchOn(phoneCtx, phone)

  await check('pairs by QR link', async () => {
    const t0 = Date.now()
    await popup.bringToFront()
    await phone.goto(onPhone(pairing))
    await phone.locator('.modes').waitFor({ timeout: 20000 })
    await until('popup shows connected', () => popup.evaluate(() => document.getElementById('status')?.dataset.s === 'connected'), 15000)
    const controlsMs = Date.now() - t0
    const seal = await compareSeal(popup, phone)
    await page.bringToFront()
    return `${new URL(pairing).host}, controls in ${controlsMs} ms; phone and popup seal ${seal}`
  })

  // ---- the invite moves on once a phone pairs (spec/SECURITY.md §8, L2) ----
  await check('late popup storage delivery shows the settled seal automatically without replaying travel', async () => {
    const original = await linkOf(popup)
    try {
      const lateAt = await popup.evaluate(async () => {
        const { link } = await chrome.storage.session.get('link')
        const sealAt = Date.now() - 1600
        await chrome.storage.session.set({ link: { ...link, sealAt } })
        return sealAt
      })
      await until('late static settlement', () => popup.evaluate(at => {
        const moment = document.querySelector('#qr .seal-flight[data-settled][data-progress="1.000"]')
        const timeline = JSON.parse(moment?.getAttribute('data-timeline') ?? 'null')
        return timeline && Math.abs(timeline.startedAt - at) < 100 && !moment.getAnimations().length
      }, lateAt), 3000)
      if (!(await popup.locator('#qr .connection-seal').isVisible())) throw new Error('late delivery hid the persistent seal')
      return 'the authenticated seal settles immediately; its 1200 ms travel is not replayed'
    } finally {
      await popup.evaluate(link => chrome.storage.session.set({ link }), original)
    }
  })

  await check('the invite moves on once the phone pairs: the popup has a new link', async () => {
    const next = await until('a new pairing link', async () => { const u = (await linkOf(popup))?.url; return u && u !== pairing ? u : null }, 8000)
    return `#${new URL(pairing).hash.slice(1, 10)}… → #${new URL(next).hash.slice(1, 10)}…`
  })

  await check('the old QR link pairs nobody new: a second phone is told it was used, and the first stays connected', async () => {
    stranger = await chromium.launch(e2eBrowserOptions({ executablePath, headless: !HEADED, args: [...RTC_ARGS, '--ignore-certificate-errors'] }))
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

  await check('Try opens the compatible demo without enabling it; phone input arrives only after enable', async () => {
    const created = desk.waitForEvent('page')
    await popup.locator('#try-demo').click()
    const demo = await created
    try {
      await demo.waitForURL(`${SERVICE}/link/try/`)
      await demo.locator('#demo-state').waitFor()
      const still = await popup.evaluate(async () => (await chrome.storage.session.get('tab')).tab)
      if (still !== tabId) throw new Error('Try changed the input target without permission')
      const demoTab = await popup.evaluate(async url => (await chrome.tabs.query({ url }))[0]?.id, `${SERVICE}/link/try/`)
      await enable(popup, demoTab)
      await demo.bringToFront()
      // As with a physical controller, the shim exposes a newly enabled pad on its first deliberate press.
      await hold('.gp-f[data-k=a]', () => until('demo detects controller', () => demo.locator('#demo-state').textContent().then(t => t.includes('Controller detected'))))
      await clearHints()
      const [x, y] = await centre('.gp-stick[data-stick="0"]')
      await touches('touchStart', [[x, y]])
      try {
        await touches('touchMove', [[x + 48, y]])
        await until('demo receives left stick', () => demo.locator('canvas').first().getAttribute('data-pad-input'))
      } finally { await touches('touchEnd', []) }
      await until('held input released on demo', () => demo.evaluate(() => Array.from(navigator.getGamepads()).some(p => p && Math.abs(p.axes[0]) < 0.02)))
      await shot(demo, 'try-demo-controller')
    } finally {
      await enable(popup, tabId); await demo.close(); await page.bringToFront()
      await hold('.gp-f[data-k=a]', () => until('original controller restored', () => page.evaluate(() => window.__pad()?.pressed[0])))
      await until('original button released', () => page.evaluate(() => window.__pad()?.pressed[0] === false))
    }
    return 'explicit tab enable; real phone stick; release observed'
  })

  await check('Desktop companion reports only existing status and opens PC settings on an explicit click', async () => {
    const guide = await desk.newPage()
    const previous = await popup.evaluate(async () => (await chrome.storage.session.get('pc')).pc)
    try {
      await guide.goto(`${SERVICE}/link/desktop/`)
      for (const link of ['off', 'missing', 'ready']) {
        const pc = { link, version: link === 'ready' ? '0.3.0' : null, hotkey: null, error: 'private native detail', desktopCap: false, config: null, status: null, stats: null }
        await popup.evaluate(pc => chrome.storage.session.set({ pc }), pc)
        await guide.waitForFunction(status => document.getElementById('guide-status')?.dataset.helper === status, link)
        const text = await guide.locator('#guide-status').textContent()
        if (text.includes('private native detail')) throw new Error('private native error exposed')
        if (link === 'off' && !text.includes('not been checked')) throw new Error('off was diagnosed as missing')
        await shot(guide, `companion-status-${link}`)
      }
      const opened = desk.waitForEvent('page')
      await guide.locator('#desktop-check').click()
      const settings = await opened
      try { await settings.waitForURL(`chrome-extension://${id}/options.html`) } finally { await settings.close() }
    } finally { await guide.close(); if (previous) await popup.evaluate(pc => chrome.storage.session.set({ pc }), previous); await page.bringToFront() }
    return 'not checked / missing / connected; no native input or permission exposed'
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
        const viewport = phone.viewportSize()
        for (const width of [1280, 390]) {
          await phone.setViewportSize({ width, height: 844 }); await opts.setViewportSize({ width, height: 844 })
          await phone.bringToFront(); await sleep(200); await shot(phone, `dot-loaders-phone-approval-${width}`)
          await opts.bringToFront(); await sleep(200); await shot(opts, `dot-loaders-options-approval-${width}`)
        }
        await phone.setViewportSize(viewport)
        // Hold only this test page's answer message; the background and native stub remain disarmed.
        await opts.evaluate(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime)
          chrome.runtime.sendMessage = (...args) => args[0]?.type === 'answer' ? new Promise(() => {}) : send(...args)
        })
        await opts.locator('#ask button[data-allow="false"]').click()
        for (const width of [1280, 390]) {
          await opts.setViewportSize({ width, height: 844 }); await sleep(200)
          await shot(opts, `dot-loaders-options-answer-${width}`)
          if (!process.env.OBPAL_E2E_EXTENSION_DIST && !await opts.locator('#ask .dot-loader:not([hidden])').isVisible()) throw new Error('answer acknowledgement has no dots')
        }
        await opts.close()
        await page.bringToFront()
      }
      // Deny: kept, the prompt and the notification go, the helper stays disarmed, and the phone, which picked PC
      // itself, is back on the target it had.
      if (SHOTS) {
        await popup.evaluate(() => {
          const send = chrome.runtime.sendMessage.bind(chrome.runtime)
          chrome.runtime.sendMessage = (...args) => args[0]?.type === 'answer' ? new Promise(resolve => { window.__releaseAnswer = () => { chrome.runtime.sendMessage = send; return send(...args).then(resolve) } }) : send(...args)
        })
        await popup.locator('#ask button[data-allow="false"]').click()
        const viewport = popup.viewportSize()
        for (const width of [1280, 390]) {
          await popup.setViewportSize({ width, height: 844 }); await sleep(200)
          await shot(popup, `dot-loaders-popup-answer-${width}`)
          if (!process.env.OBPAL_E2E_EXTENSION_DIST && !await popup.locator('#ask .dot-loader:not([hidden])').isVisible()) throw new Error('answer acknowledgement has no dots')
        }
        await popup.setViewportSize(viewport)
        await popup.evaluate(() => window.__releaseAnswer())
      } else await popup.locator('#ask button[data-allow="false"]').click()
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
          const box = await phone.locator('#pad-wheel').boundingBox()
          if (!box || box.height < 24) throw new Error(`no usable scroll strip: ${JSON.stringify(box)}`)
          const x = box.x + box.width / 2, y = box.y + box.height * 0.2
          const travel = Math.min(80, box.height * 0.6)
          const hit = await phone.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, { x, y })
          if (hit !== 'pad-wheel') throw new Error(`the scroll strip is covered by ${hit}`)
          await touches('touchStart', [[x, y]])
          for (let i = 1; i <= 10; i++) { await touches('touchMove', [[x, y + i * travel / 10]]); await sleep(30) }
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

  if (!DESKTOP) {
    await check('Mac (stub): Accessibility guidance, shortcut setting, panic chord and secret Type prompt', async () => {
      await setTarget(popup, 'pc')
      await helperReady(() => true)
      const opts = await desk.newPage()
      try {
        await opts.goto(`chrome-extension://${id}/options.html`)
        if (SHOTS) await opts.screenshot({ path: join(SHOTS, 'options-windows-before.png'), fullPage: true })
        await stubFocus({ os: 'macos', accessibility: false, text: 'secret', front: 'game' })
        await until('Mac permission instruction', () => popup.evaluate(() => document.getElementById('pc-sub')?.textContent?.includes('Privacy & Security')))
        await until('no Type without Accessibility', () => phone.evaluate(() => document.getElementById('type-prompt')?.hidden))
        await until('Mac panic chord', () => popup.evaluate(() => document.getElementById('pc-panic')?.textContent?.includes('⌥')))
        await opts.locator('#mac-shortcuts:not([hidden])').waitFor()
        if (SHOTS) {
          await popup.screenshot({ path: join(SHOTS, 'popup-mac-accessibility.png'), fullPage: true })
          await opts.screenshot({ path: join(SHOTS, 'options-mac-accessibility.png'), fullPage: true })
        }
        await opts.locator('#mac-shortcuts').click()
        await until('physical Control preference reaches the helper', async () => (await pcState())?.platform?.ctrlToCmd === false)
        await pcSend({ to: 'bg', type: 'pc-desktop', on: true, keyboard: true, mouse: true })
        await stubFocus({ os: 'macos', accessibility: true, text: 'secret', front: 'game' })
        await phone.locator('#type-prompt').waitFor({ state: 'visible', timeout: 8000 })
        await tap('#type-prompt')
        await phone.locator('#kbd').waitFor({ state: 'visible' })
        await phone.locator('#kbd-pass').waitFor({ state: 'visible' })
        if (!await phone.evaluate(() => document.activeElement?.id === 'kbd-pass' && document.activeElement.getAttribute('type') === 'password')) throw new Error('secret focus did not use a focused password field')
        const typedAt = stubLog().length
        await phone.keyboard.type('mac-test')
        await until('Mac typing reaches the inert helper', () => stubLog().slice(typedAt).filter((e) => e.in?.t === 'text').map((e) => e.in.s).join('') === 'mac-test')
        if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'phone-mac-secret.png') })
        await stubFocus({ os: 'macos', accessibility: false, text: 'secret', front: 'game' })
        await until('revoking Accessibility closes Type', () => phone.evaluate(() => document.getElementById('kbd')?.hidden && document.getElementById('type-prompt')?.hidden))
        await stubFocus({ text: null, front: 'browser' })
        await until('Windows state restored', async () => !(await pcState())?.platform)
        return 'permission loss hides Type; Mac setting, chord and password typing reach the stub'
      } finally {
        await opts.close()
        await setTarget(popup, 'keys')
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
    await popup.bringToFront()
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
    const seal = await compareSeal(popup, phone)
    await page.bringToFront()
    await tap('.modes [data-tab=gamepad]')
    await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
    await hold('.gp-f[data-k=a]', () => until('A pressed', () => page.evaluate(() => window.__pad()?.pressed[0] === true)))
    await until('A released', () => page.evaluate(() => window.__pad()?.pressed[0] === false))
    const path = await phone.evaluate(() => document.getElementById('sig')?.dataset.q)
    if (SHOTS) await phone.screenshot({ path: join(SHOTS, 'phone-offline.png') })
    return `${link.device}: page from cache in ${tPage} ms, controls in ${tControls} ms (link: start ${marks.start} → open ${marks.open} → welcome ${marks.welcome} ms), ${path} path, input arrives; phone and popup seal ${seal}`
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
  await local.close()
  for (const close of stubPorts) close()
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
