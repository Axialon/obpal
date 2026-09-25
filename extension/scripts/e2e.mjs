/**
 * ob.Pal Link end to end: the built extension (extension/dist) in Chromium, a phone emulated in a second browser
 * that opens the real pairing link (production signaling at obpal.blackboxes.net), and a local test page that
 * records what a game or 3D viewer would receive. Checks the three targets:
 *   Controller: the Gamepad API shows "ob.Pal Controller", A held on the phone = button 0 pressed.
 *   Keys:       A = Space, D-pad up = ArrowUp (keydown, then keyup).
 *   3D:         a one-finger trackpad drag = left-button pointer drag on the largest canvas; a pinch = wheel.
 *
 * Usage: pnpm run build:extension && node extension/scripts/e2e.mjs [--headed] [--shots=<dir>]
 * Chromium: Playwright's own (npx playwright install chromium), or OBPAL_E2E_CHROMIUM=<path to chrome.exe>.
 * Branded Chrome can't load unpacked extensions from the command line, so this needs Chromium.
 *
 * Automation can't click the toolbar icon, which is what grants activeTab. The test copy of the extension
 * therefore also gets host access to the local test page (http://127.0.0.1/*), and "This tab" is switched on
 * with the same message the popup sends.
 */
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
