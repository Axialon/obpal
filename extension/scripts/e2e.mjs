/**
 * ob.Pal Link end to end: the built extension (extension/dist) in Chromium, a phone emulated in a second browser
 * that opens the real pairing link (production signaling at obpal.blackboxes.net, while the controller's page and
 * assets come from this checkout's site build in dist/client), and a local test page that records what a game or
 * 3D viewer would receive. Checks the three targets:
 *   Controller: the Gamepad API shows "ob.Pal Controller", A held on the phone = button 0 pressed.
 *   Keys:       A = Space, D-pad up = ArrowUp (keydown, then keyup).
 *   3D:         a one-finger trackpad drag = left-button pointer drag on the largest canvas; a pinch = wheel.
 *
 *   Motion:     Aim clears an 0.18 look deadzone with a small turn; Steer on the flight profile flies the right stick.
 *   Point:      the Wii cursor follows where the phone points and A clicks the button under it.
 * The emulated phone has no sensors, so the test dispatches the W3C deviceorientation / devicemotion events itself.
 *
 * Usage: pnpm exec vite build && pnpm run build:extension && node extension/scripts/e2e.mjs [--headed] [--shots=<dir>]
 * Chromium: Playwright's own (npx playwright install chromium), or OBPAL_E2E_CHROMIUM=<path to chrome.exe>.
 * Branded Chrome can't load unpacked extensions from the command line, so this needs Chromium.
 *
 * Automation can't click the toolbar icon, which is what grants activeTab. The test copy of the extension
 * therefore also gets host access to the local test page (http://127.0.0.1/*), and "This tab" is switched on
 * with the same message the popup sends.
 */
import { existsSync, statSync } from 'node:fs'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEADED = process.argv.includes('--headed')
const SHOTS = process.argv.find((a) => a.startsWith('--shots='))?.slice(8)
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
// Two browsers on one machine: real host candidates instead of mDNS names, so WebRTC connects over loopback.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, fn, timeout = 8000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
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
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

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

const profile = await mkdtemp(join(tmpdir(), 'obpal-link-profile-'))
const desk = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: !HEADED,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...RTC_ARGS],
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
})
const phoneBrowser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
const phoneCtx = await phoneBrowser.newContext({ ...devices['Pixel 7 landscape'] })

// The phone opens the real pairing link, but the controller's page and assets are this checkout's site build, so the
// phone under test is the local one. Anything not in the build (the ICE credentials, the signaling socket) goes through.
const site = resolve(root, '..', 'dist', 'client')
if (!existsSync(join(site, 'p', 'index.html'))) throw new Error(`site build missing at ${site}: run \`pnpm exec vite build\` first`)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }
await phoneCtx.route('https://obpal.blackboxes.net/**', async (route) => {
  const path = new URL(route.request().url()).pathname
  const file = join(site, path.endsWith('/') ? `${path}index.html` : extname(path) ? path : `${path}/index.html`)
  if (existsSync(file) && statSync(file).isFile()) return route.fulfill({ path: file, contentType: MIME[extname(file)] ?? 'application/octet-stream' })
  return route.continue()
})

let exitCode = 0
try {
  console.log('ob.Pal Link e2e')
  const worker = desk.serviceWorkers()[0] ?? (await desk.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  console.log(`  extension ${id} · ${manifest.name} ${manifest.version}`)

  const page = desk.pages()[0] ?? (await desk.newPage())
  await page.goto(`${base}/`)
  const popup = await desk.newPage()
  await popup.goto(`chrome-extension://${id}/popup.html`)

  const pairing = await until('pairing link', () => popup.evaluate(async () => (await chrome.storage.session.get('link')).link?.url || ''), 20000)
  const tabId = await popup.evaluate(async (b) => (await chrome.tabs.query({ url: `${b}/*` }))[0]?.id, base)
  await popup.evaluate((t) => chrome.runtime.sendMessage({ to: 'bg', type: 'enable', tabId: t, on: true }), tabId)
  // The controlled tab is the one in front (as when a person clicks the toolbar icon on it): pages in background
  // tabs get no animation frames, and the Gamepad API connection events run on them.
  await page.bringToFront()
  const setTarget = (mode) => popup.evaluate((m) => chrome.runtime.sendMessage({ to: 'bg', type: 'mode', mode: m }), mode)

  // ---- the phone ----
  const phone = await phoneCtx.newPage()
  const cdp = await phoneCtx.newCDPSession(phone)
  const touches = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) })
  const centre = async (sel) => { const b = await phone.locator(sel).first().boundingBox(); if (!b) throw new Error(`no ${sel} on the phone`); return [b.x + b.width / 2, b.y + b.height / 2] }
  const clearHints = () => phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  async function tap(sel) { await clearHints(); const [x, y] = await centre(sel); await touches('touchStart', [[x, y]]); await sleep(60); await touches('touchEnd', []); await sleep(250) }
  async function hold(sel, during) { await clearHints(); const [x, y] = await centre(sel); await touches('touchStart', [[x, y]]); try { return await during() } finally { await touches('touchEnd', []) } }

  await check('pairs by QR link', async () => {
    await phone.goto(pairing)
    await phone.locator('.modes').waitFor({ timeout: 20000 })
    await until('popup shows connected', () => popup.evaluate(() => document.getElementById('status')?.dataset.s === 'connected'), 15000)
    return new URL(pairing).host
  })

  await check('Controller: Gamepad API pad, A = button 0', async () => {
    await setTarget('gamepad')
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
    await setTarget('keys')
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
    await setTarget('viewer')
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
    await popup.evaluate((t) => chrome.runtime.sendMessage({ to: 'bg', type: 'enable', tabId: t, on: true }), gameTab)
    await game.bringToFront()
    const f = await until('frames report', () => popup.evaluate(async () => (await chrome.storage.session.get('frames')).frames))
    if (f.tab !== gameTab || f.count !== 1 || !f.big || f.host !== new URL(gameOrigin).host) throw new Error(JSON.stringify(f))
    // Control goes back to the plain page for anything after this.
    await popup.evaluate((t) => chrome.runtime.sendMessage({ to: 'bg', type: 'enable', tabId: t, on: true }), tabId)
    await game.close()
    return `${f.host}, fills the page`
  })

  if (SHOTS) {
    await phone.screenshot({ path: join(SHOTS, 'phone-rotate.png') })
    await popup.setViewportSize({ width: 360, height: 560 })
    await popup.screenshot({ path: join(SHOTS, 'popup-connected.png') })
  }
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await Promise.allSettled([desk.close(), phoneBrowser.close()])
  server.close()
  await Promise.allSettled([rm(ext, { recursive: true, force: true }), rm(profile, { recursive: true, force: true })])
}

const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)
