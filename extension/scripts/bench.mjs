/**
 * Connection bench for ob.Pal Link: how fast a phone gets control, and how quickly its input lands on the page.
 * Same setup as e2e.mjs (the built extension in one Chromium, an emulated phone in another, both on this
 * machine), with the phone running this checkout's controller build through the local stand-in service
 * (extension/e2e/local.mjs: static files here, signaling proxied to production). It measures production on purpose,
 * as the extension meets it, so it asks the stand-in for production explicitly.
 *
 *   QR ready        popup opened -> pairing link available (cold: the link document had to be created)
 *   connected       phone opens the link -> the host has verified the phone (popup shows Connected)
 *   surface         phone opens the link -> the phone shows its controls (welcome received)
 *   first input     phone opens the link -> first STATE packet decoded by the host (needs the diag hook)
 *   press latency   touch on the phone's A button -> the page's Gamepad API shows it pressed (rAF poll)
 *   rtt             the phone's own ping/pong over the data channel
 *
 * Usage: pnpm run build && pnpm run build:extension && node extension/scripts/bench.mjs [--runs=5] [--headed]
 * Chromium: OBPAL_E2E_CHROMIUM=<path to chrome.exe> (or Playwright's own).
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'
import { startLocal, UPSTREAM } from '../e2e/local.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HEADED = process.argv.includes('--headed')
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 5)
const PRESSES = 15
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, fn, timeout = 15000, every = 20) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const fmt = (xs) => `median ${q(xs, 0.5).toFixed(0)} ms, p90 ${q(xs, 0.9).toFixed(0)} ms, min ${Math.min(...xs).toFixed(0)}, max ${Math.max(...xs).toFixed(0)} (n=${xs.length})`

const local = await startLocal({ upstream: `https://${UPSTREAM}` })
const ext = await mkdtemp(join(tmpdir(), 'obpal-link-bench-ext-'))
await cp(join(root, 'dist'), ext, { recursive: true })
const manifestPath = join(ext, 'manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.host_permissions = [...manifest.host_permissions, 'http://127.0.0.1/*']
await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
const page0 = await readFile(join(root, 'e2e', 'harness.html'))
const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page0) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const profile = await mkdtemp(join(tmpdir(), 'obpal-link-bench-profile-'))
const desk = await chromium.launchPersistentContext(profile, {
  executablePath, headless: !HEADED, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...RTC_ARGS], viewport: { width: 1280, height: 800 },
})
const phoneBrowser = await chromium.launch({ executablePath, headless: !HEADED, args: [...RTC_ARGS, '--ignore-certificate-errors'] })

const m = { qr: [], connected: [], surface: [], firstInput: [], press: [], rtt: [] }
try {
  console.log(`ob.Pal Link bench · ${RUNS} runs · ${manifest.name} ${manifest.version} · phone via ${local.origin}`)
  const worker = desk.serviceWorkers()[0] ?? (await desk.waitForEvent('serviceworker'))
  const id = new URL(worker.url()).host
  const page = desk.pages()[0] ?? (await desk.newPage())
  await page.goto(`${base}/`)
  const popup = await desk.newPage()
  const tPopup = Date.now()
  await popup.goto(`chrome-extension://${id}/popup.html`)
  const pairing = await until('pairing link', () => popup.evaluate(async () => (await chrome.storage.session.get('link')).link?.url || ''), 20000, 10)
  m.qr.push(Date.now() - tPopup)
  const tabId = await popup.evaluate(async (b) => (await chrome.tabs.query({ url: `${b}/*` }))[0]?.id, base)
  await popup.evaluate((t) => chrome.runtime.sendMessage({ to: 'bg', type: 'enable', tabId: t, on: true }), tabId)
  await page.bringToFront()
  await popup.evaluate(() => chrome.runtime.sendMessage({ to: 'bg', type: 'mode', mode: 'gamepad' }))
  // Popup-side timestamps: storage changes arrive as events, so no polling error.
  await popup.evaluate(() => {
    window.__at = {}
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'session' || !c.link) return
      const s = c.link.newValue?.status
      if (s) window.__at[s] = Date.now()
    })
  })
  const linkUrl = pairing.replace(`https://${UPSTREAM}`, local.origin)
  const diag = () => popup.evaluate(() => chrome.runtime.sendMessage({ to: 'bg', type: 'diag' }).catch(() => null))

  for (let run = 1; run <= RUNS; run++) {
    const ctx = await phoneBrowser.newContext({ ...devices['Pixel 7 landscape'] })
    const phone = await ctx.newPage()
    await phone.addInitScript(() => {
      window.__surfaceAt = 0
      new MutationObserver(() => { if (!window.__surfaceAt && document.querySelector('.modes')) window.__surfaceAt = Date.now() }).observe(document, { childList: true, subtree: true })
    })
    await popup.evaluate(() => { window.__at = {} })
    const t0 = Date.now()
    await phone.goto(linkUrl)
    const connectedAt = await until('connected', () => popup.evaluate(() => window.__at.connected || 0), 20000, 10)
    const surfaceAt = await until('surface', () => phone.evaluate(() => window.__surfaceAt || 0), 20000, 10)
    m.connected.push(connectedAt - t0)
    m.surface.push(surfaceAt - t0)
    // Where the time went on the phone (ms since its navigation started): page ready, then the link's marks.
    const tl = await phone.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const marks = Object.fromEntries(performance.getEntriesByType('mark').filter((x) => x.name.startsWith('obpal:')).map((x) => [x.name.slice(6), Math.round(x.startTime)]))
      return { page: Math.round(nav?.domInteractive ?? 0), ...marks }
    })
    console.log(`    phone timeline: ${Object.entries(tl).map(([k, v]) => `${k} ${v}`).join(' · ')}`)

    // Gamepad mode, then A presses timed against the page's Gamepad API (polled every animation frame).
    const cdp = await ctx.newCDPSession(phone)
    const touches = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) })
    const centre = async (sel) => { const b = await phone.locator(sel).first().boundingBox(); if (!b) throw new Error(`no ${sel}`); return [b.x + b.width / 2, b.y + b.height / 2] }
    await phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    const [tx, ty] = await centre('.modes [data-tab=gamepad]')
    await touches('touchStart', [[tx, ty]]); await sleep(50); await touches('touchEnd', [])
    await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 5000 })
    await sleep(400)
    await phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    const [ax, ay] = await centre('.gp-f[data-k=a]')
    await page.evaluate(() => {
      window.__watch = (want) => new Promise((res) => { const loop = () => { const p = window.__pad(); if (p && p.pressed[0] === want) res(Date.now()); else requestAnimationFrame(loop) }; loop() })
    })
    for (let k = 0; k < PRESSES; k++) {
      const seen = page.evaluate(() => window.__watch(true))
      const t = Date.now()
      await touches('touchStart', [[ax, ay]])
      const at = await seen
      m.press.push(at - t)
      const released = page.evaluate(() => window.__watch(false))
      await touches('touchEnd', [])
      await released
      await sleep(60)
    }
    await sleep(2600) // the phone pings every 2 s; read the RTT badge
    const rtt = await phone.evaluate(() => Number(document.querySelector('#sig b')?.textContent))
    if (Number.isFinite(rtt)) m.rtt.push(rtt)
    // The host's own timeline: when it bound the phone and when the first packet landed (read once both have happened).
    const d = await diag()
    if (d?.firstInputAt) m.firstInput.push(d.firstInputAt - t0)
    console.log(`  run ${run}: connected ${m.connected.at(-1)} ms, surface ${m.surface.at(-1)} ms${d?.firstInputAt ? `, first input ${m.firstInput.at(-1)} ms` : ''}, press ${fmt(m.press.slice(-PRESSES))}, rtt ${rtt} ms`)
    await ctx.close()
    await until('host back to ready', () => popup.evaluate(() => window.__at.ready || 0), 15000, 20)
    await sleep(300)
  }
  console.log('\nsummary')
  console.log(`  QR ready (cold popup):   ${m.qr[0]} ms`)
  console.log(`  time to connected:       ${fmt(m.connected)}`)
  console.log(`  time to surface (phone): ${fmt(m.surface)}`)
  if (m.firstInput.length) console.log(`  time to first input:     ${fmt(m.firstInput)}`)
  console.log(`  press -> page:           ${fmt(m.press)}`)
  if (m.rtt.length) console.log(`  data channel rtt:        ${fmt(m.rtt)}`)
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  await Promise.allSettled([desk.close(), phoneBrowser.close()])
  server.close()
  await local.close()
  await Promise.allSettled([rm(ext, { recursive: true, force: true }), rm(profile, { recursive: true, force: true })])
}
