/**
 * The phone controller, captured for review (artifacts/controller-ui/<label>/, kept out of the repository): every
 * controller at 390×844, 430×932 and 844×390, each on a screen that suits it (the Viewer, the rover, the lamp, the
 * studio), plus the controller catalogue, settings and a short video of switching, where the build has them.
 *
 *   vite build
 *   OBPAL_E2E_PORT=<stand-in> OBPAL_E2E_WORKER_PORT=<worker> node scripts/capture-controller.mjs <label> [--video]
 *     [--theme=<surface>] [--accent=<accent>] [--only=<part of a screen's path>]
 *   OBPAL_E2E_PORT=<stand-in> OBPAL_E2E_WORKER_PORT=<worker> node scripts/capture-controller.mjs <label> --nodes
 *   node scripts/capture-controller.mjs --index
 * --theme and --accent put the phone on another family surface or accent (a shared scene gives each phone a colour of
 * its own, which they override); --only captures just the screens whose path has that in it. --nodes captures only
 * the node strip on an arm: a phone switching joints and sets while its finger keeps moving, beside the arm on the
 * screen (nodes-phone.webm and nodes-screen.webm, and nodes.mp4 side by side where ffmpeg is on the path, or at
 * OBPAL_FFMPEG). --index writes artifacts/controller-ui/index.html, a page that sets each capture in `before` beside
 * the same one in `after`, then the catalogue, settings, the switching video, the node strip's and any other captures
 * there (the notes in notes.json on top, if any).
 *
 * It binds only the two ports it is given (the stand-in and its local worker), drives Playwright's Chromium (or
 * OBPAL_E2E_CHROMIUM) and writes nothing outside artifacts/. Controllers are picked the way a person picks them: from the
 * catalogue sheet when the build has one, else with the old mode tabs.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'

const root = join('artifacts', 'controller-ui')
const indexOnly = process.argv.includes('--index')
const label = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'after'
const video = process.argv.includes('--video')
const nodes = process.argv.includes('--nodes')
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
const look = { theme: flag('theme'), accent: flag('accent') }
const only = flag('only')
const out = join('artifacts', 'controller-ui', label)
const executablePath = (await resolveChromium()).path || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 10000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}

for (const key of indexOnly ? [] : ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  const port = Number(process.env[key])
  if (!port) throw new Error(`${key} is required`)
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', () => reject(new Error(`port ${port} (${key}) is in use`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}

/** The three sizes: two portrait phones and one in landscape. */
export const SIZES = [
  { name: '390x844', width: 390, height: 844, angle: 0 },
  { name: '430x932', width: 430, height: 932, angle: 0 },
  { name: '844x390', width: 844, height: 390, angle: 90 },
]
/** Each screen and the controllers captured on it. */
const SCREENS = [
  { path: '/view/', controllers: ['face.trackpad', 'face.wii', 'face.hand', 'face.gamepad'] },
  { path: '/sim/device/?d=rover', controllers: ['face.wheel'], catalogue: true },
  { path: '/sim/device/?d=lamp', controllers: ['face.mouse', 'face.keyboard'] },
  { path: '/sim/device/?d=studio', controllers: ['face.drums', 'face.keys'] },
]
/** The old mode tab each controller lived on (before the catalogue). */
const OLD_TAB = { 'face.trackpad': 'rotate', 'face.wii': 'point', 'face.mouse': 'point', 'face.hand': 'track', 'face.gamepad': 'gamepad', 'face.wheel': 'gamepad', 'face.drums': 'drums', 'face.keys': 'keys' }

if (indexOnly) {
  await writeIndex()
  process.exit(0)
}
// A whole run starts its folder afresh; --only and --nodes add to it.
if (!only && !nodes) await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const local = await startLocal()
const closers = []
const shots = []
const profiles = []
try {
  const browser = await chromium.launch({ executablePath, headless: true, args: RTC_ARGS })
  closers.push(browser)
  if (nodes) await nodeStrip(browser)
  for (const s of nodes ? [] : SCREENS) {
    if (only && !s.path.includes(only)) continue
    const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const screen = await screenCtx.newPage()
    await screen.goto(`${local.origin}${s.path}`)
    const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 25000)

    const dir = await mkdtemp(join(tmpdir(), 'obpal-capture-'))
    profiles.push(dir)
    const ctx = await chromium.launchPersistentContext(dir, {
      executablePath, headless: true, args: RTC_ARGS, ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    })
    closers.push(ctx)
    // Coach hints come and go on timers: kept out of the captures so every run is comparable.
    await ctx.addInitScript(() => { for (const k of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${k}`, '1') })
    const phone = ctx.pages()[0] ?? (await ctx.newPage())
    const cdp = await ctx.newCDPSession(phone)
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
    await phone.goto(invite)
    await phone.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
    await phone.evaluate(() => document.fonts.ready)
    /** Take away the coach hints and notices, and wear the surface and accent asked for. */
    const clear = () => phone.evaluate((l) => {
      document.querySelectorAll('.hint, .bt-notice').forEach((h) => h.remove())
      if (l.theme) window.BlackboxesFamily.applyTheme(l.theme)
      if (l.accent) window.BlackboxesFamily.applyAccent(l.accent)
    }, look)
    const size = async (z) => {
      await phone.setViewportSize({ width: z.width, height: z.height })
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: z.width, height: z.height, deviceScaleFactor: 2, mobile: true,
        screenOrientation: { type: z.angle ? 'landscapePrimary' : 'portraitPrimary', angle: z.angle },
      })
      await sleep(450)
    }
    const catalogue = async () => (await phone.locator('#ctl-more').count()) > 0

    /** Pick a controller as a person would: the catalogue sheet where there is one, else the old tabs. */
    const use = async (id) => {
      await clear()
      if (await catalogue()) {
        if (id === 'face.keyboard') { await phone.locator('.tray-btn[aria-label="Keyboard"]').click(); return }
        const gp = phone.locator('.gp:not([hidden]) [data-act=controllers]')
        if (await gp.count() && await gp.isVisible()) await gp.click()
        else await phone.locator('#ctl-more').click()
        await phone.locator(`.ctl-card[data-c="${id}"]`).click()
        await sleep(500)
        return
      }
      if (id === 'face.keyboard') { await phone.locator('.tray-btn[aria-label="Keyboard"]').click(); return }
      const exit = phone.locator('.gp:not([hidden]) [data-act=exit]')
      if (OLD_TAB[id] !== 'gamepad' && await exit.count() && await exit.isVisible()) await exit.click()
      const tab = phone.locator(`.modes [data-tab=${OLD_TAB[id]}]`)
      if (await tab.isVisible()) await tab.click()
      await sleep(400)
    }

    if (s.path === '/view/') {
      // The settings sheet, once, as it opens on a phone.
      await size(SIZES[0])
      await clear()
      await phone.locator('#gear').click()
      await phone.locator('.sheet.settings').waitFor()
      await sleep(450)
      await phone.screenshot({ path: join(out, 'settings-390x844.png') })
      shots.push('settings-390x844.png')
      await phone.locator('.sheet.settings').evaluate((el) => { el.scrollTop = el.scrollHeight })
      await sleep(200)
      await phone.screenshot({ path: join(out, 'settings-end-390x844.png') })
      shots.push('settings-end-390x844.png')
      await phone.locator('#set-close').click()
      await sleep(400)
    }

    for (const id of s.controllers) {
      await size(SIZES[0])
      await use(id)
      for (const z of SIZES) {
        await size(z)
        await clear()
        const file = `${id.replace('face.', '')}-${z.name}.png`
        await phone.screenshot({ path: join(out, file) })
        shots.push(file)
      }
      if (id === 'face.keyboard') await phone.locator('.kbd-hide').click().catch(() => {})
    }

    if (s.catalogue && await catalogue()) {
      for (const z of SIZES) {
        await size(z)
        await clear()
        const gp = phone.locator('.gp:not([hidden]) [data-act=controllers]')
        if (await gp.count() && await gp.isVisible()) await gp.click()
        else await phone.locator('#ctl-more').click()
        await phone.locator('.ctl-sheet').waitFor()
        await sleep(450)
        const file = `catalogue-${z.name}.png`
        await phone.screenshot({ path: join(out, file) })
        shots.push(file)
        // A long press on a controller this screen doesn't take says why.
        if (z === SIZES[0]) {
          const card = phone.locator('.ctl-card[aria-disabled="true"]').first()
          if (await card.count()) {
            const b = await card.boundingBox()
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] })
            await sleep(700)
            await phone.screenshot({ path: join(out, 'catalogue-why.png') })
            shots.push('catalogue-why.png')
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await sleep(300)
          }
        }
        await phone.keyboard.press('Escape')
        await sleep(400)
      }
    }
    await ctx.close()
    await screenCtx.close()
  }
  if (video && !only && !nodes) await switching(browser)
  if (!nodes) await writeFile(join(out, 'shots.json'), JSON.stringify({ label, sizes: SIZES.map((z) => z.name), shots }, null, 2))
  console.log(`${shots.length} captures in ${out}`)
} finally {
  await Promise.allSettled(closers.map((c) => c.close()))
  await local.close()
  for (const d of profiles) await rm(d, { recursive: true, force: true }).catch(() => {})
}

/**
 * The switching video (switching.webm): a phone on the Viewer goes through its controllers the ways a person would,
 * a slot on the bar, the catalogue, the gamepad's own button, and back.
 */
async function switching(browser) {
  const screen = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage()
  await screen.goto(`${local.origin}/view/`)
  const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 25000)
  const dir = await mkdtemp(join(tmpdir(), 'obpal-capture-'))
  profiles.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath, headless: true, args: RTC_ARGS, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    recordVideo: { dir: join(out, 'video'), size: { width: 390, height: 844 } },
  })
  closers.push(ctx)
  await ctx.addInitScript(() => { for (const k of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${k}`, '1') })
  const phone = ctx.pages()[0] ?? (await ctx.newPage())
  const cdp = await ctx.newCDPSession(phone)
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  await phone.goto(invite)
  await phone.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
  await phone.evaluate((l) => { if (l.theme) window.BlackboxesFamily.applyTheme(l.theme); if (l.accent) window.BlackboxesFamily.applyAccent(l.accent) }, look)
  await sleep(1200)
  const slot = async (face) => { await phone.locator(`.modes [data-tab=${face}]`).click(); await sleep(1100) }
  const card = async (id) => {
    const gp = phone.locator('.gp:not([hidden]) [data-act=controllers]')
    await (await gp.count() && await gp.isVisible() ? gp : phone.locator('#ctl-more')).click()
    await sleep(1300)
    await phone.locator(`.ctl-card[data-c="${id}"]`).click()
    await sleep(1300)
  }
  await slot('point')
  await slot('track')
  await card('face.mouse')
  await card('face.gamepad')
  await card('face.wheel')
  await phone.locator('.gp [data-act=exit]').click()
  await sleep(1100)
  await slot('rotate')
  // The video is saved as the page closes, before its context goes.
  const v = phone.video()
  const saved = v ? v.saveAs(join(out, 'switching.webm')) : null
  await phone.close()
  await saved
  await ctx.close()
  await rm(join(out, 'video'), { recursive: true, force: true })
  shots.push('switching.webm')
}

/** In the phone's page, for the video only: each touch as a soft dot, so the fingers show. */
function touchDots() {
  addEventListener('DOMContentLoaded', () => {
    const layer = document.createElement('div')
    layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999'
    document.body.append(layer)
    const dots = new Map()
    const show = (e) => {
      if (e.pointerType !== 'touch') return
      let d = dots.get(e.pointerId)
      if (!d) {
        d = document.createElement('i')
        d.style.cssText = 'position:absolute;width:40px;height:40px;margin:-20px 0 0 -20px;border-radius:50%;background:rgb(255 255 255 / .26);box-shadow:0 0 0 2px rgb(255 255 255 / .55)'
        layer.append(d)
        dots.set(e.pointerId, d)
      }
      d.style.left = `${e.clientX}px`
      d.style.top = `${e.clientY}px`
    }
    const hide = (e) => { dots.get(e.pointerId)?.remove(); dots.delete(e.pointerId) }
    addEventListener('pointerdown', show, true)
    addEventListener('pointermove', show, true)
    addEventListener('pointerup', hide, true)
    addEventListener('pointercancel', hide, true)
  })
}

/**
 * The node strip on an arm (nodes-phone.webm and nodes-screen.webm, and nodes.mp4 with the two side by side where
 * ffmpeg is): a phone holding Arm 1 drives it from its trackpad and, its finger still moving, switches joints on the
 * strip with a second finger (the shoulder, the elbow, the base); then the Reach and Wrist sets; then it locks the
 * shoulder and drives the whole arm around it, and works the gripper. The screen looks at Arm 1 up close.
 */
async function nodeStrip(browser) {
  const started = {}
  const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 720 }, ignoreHTTPSErrors: true, recordVideo: { dir: join(out, 'video'), size: { width: 1280, height: 720 } } })
  closers.push(screenCtx)
  const screen = await screenCtx.newPage()
  started.screen = Date.now()
  await screen.goto(`${local.origin}/sim/arm/`)
  const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 25000)
  const dir = await mkdtemp(join(tmpdir(), 'obpal-capture-'))
  profiles.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, {
    executablePath, headless: true, args: RTC_ARGS, ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    recordVideo: { dir: join(out, 'video'), size: { width: 390, height: 844 } },
  })
  closers.push(ctx)
  await ctx.addInitScript(() => { for (const k of ['gyro', 'models', 'point', 'level', 'track', 'lock', 'hold-part', 'parts-phone', 'more']) sessionStorage.setItem(`obpal.hint.${k}`, '1') })
  await ctx.addInitScript(touchDots)
  const phone = ctx.pages()[0] ?? (await ctx.newPage())
  started.phone = Date.now()
  const cdp = await ctx.newCDPSession(phone)
  await phone.goto(invite)
  await phone.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
  await until('asking to be let in', () => screen.locator('#people .allow').count(), 15000)
  await screen.locator('#people .allow').first().click()
  await phone.locator('.scene-btn').click()
  await phone.locator('.pick', { hasText: 'Whole arm' }).first().click()
  await until('Arm 1 held', () => screen.evaluate(() => !!window.__sim.claims.holder('a1')))
  await phone.locator('#nstrip:not([hidden])').waitFor({ timeout: 8000 })
  await phone.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  // Arm 1 up close, from between it and the middle it faces, a little to one side.
  await screen.evaluate(() => {
    const s = window.__arm.stand('a1')
    const len = Math.hypot(s.x, s.z) || 1
    const inward = [-s.x / len, -s.z / len], side = [-inward[1], inward[0]]
    window.__arm.view([s.x + inward[0] * 2.4 + side[0] * 1.3, 1.55, s.z + inward[1] * 2.4 + side[1] * 1.3], [s.x, 0.68, s.z])
  })
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) })
  const at = async (id) => { const b = await phone.locator(`.ns-item[data-part="${id}"]`).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
  let finger = null
  const down = async (x, y) => { finger = [x, y]; await touch('touchStart', [[x, y, 1]]) }
  const move = async (dx, dy, ms) => {
    const n = Math.max(1, Math.round(ms / 33))
    for (let i = 0; i < n; i++) { finger = [finger[0] + dx / n, finger[1] + dy / n]; await touch('touchMove', [[finger[0], finger[1], 1]]); await sleep(33) }
  }
  const up = async () => { await touch('touchEnd', []); finger = null }
  /** A tap on the strip: a second finger while the first keeps its place on the pad, or the only one. */
  const pick = async (id) => {
    const [x, y] = await at(id)
    await touch('touchStart', finger ? [[finger[0], finger[1], 1], [x, y, 2]] : [[x, y, 2]])
    await sleep(110)
    await touch('touchEnd', [[x, y, 2]])
    await sleep(140)
  }
  const lock = async (id) => { const [x, y] = await at(id); await touch('touchStart', [[x, y, 2]]); await sleep(700); await touch('touchEnd', [[x, y, 2]]); await sleep(300) }
  const pad = await phone.locator('#pad').boundingBox()
  const cx = pad.x + pad.width * 0.38, cy = pad.y + pad.height * 0.66
  await sleep(1400)
  // One finger, three joints: it never lifts.
  await pick('a1.shoulder'); await sleep(600)
  await down(cx, cy)
  await move(0, -110, 1700)
  await pick('a1.elbow')
  await move(0, -90, 1500)
  await pick('a1.base')
  await move(120, 20, 1700)
  await up(); await sleep(700)
  // Sets: Reach moves base, shoulder and elbow; Wrist its roll and bend.
  await pick('reach'); await sleep(600)
  await down(cx - 50, cy + 30)
  await move(90, -90, 1900)
  await up(); await sleep(600)
  await pick('wrist'); await sleep(600)
  await down(cx - 30, cy)
  await move(80, -70, 1700)
  await up(); await sleep(600)
  // A long press locks the shoulder; the whole arm then drives around it.
  await lock('a1.shoulder'); await sleep(600)
  await pick(''); await sleep(600)
  await down(cx + 40, cy)
  await move(-110, -40, 1900)
  await up(); await sleep(600)
  await pick('a1.gripper'); await sleep(500)
  await down(cx, cy); await move(100, 0, 900); await move(-100, 0, 900); await up()
  await sleep(1500)
  // The videos are saved as the pages close, before their contexts go.
  const pv = phone.video(), sv = screen.video()
  const phoneFile = join(out, 'nodes-phone.webm'), screenFile = join(out, 'nodes-screen.webm')
  const saved = [pv?.saveAs(phoneFile), sv?.saveAs(screenFile)]
  await phone.close()
  await screen.close()
  await Promise.all(saved)
  await ctx.close()
  await screenCtx.close()
  await rm(join(out, 'video'), { recursive: true, force: true })
  // Side by side from the phone's first frame: the screen's video began a little earlier.
  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync(process.env.OBPAL_FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-i', phoneFile, '-ss', String(Math.max(0, (started.phone - started.screen) / 1000)), '-i', screenFile,
      '-filter_complex', '[1:v]scale=-2:844[s];[0:v][s]hstack=inputs=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', '-an', join(out, 'nodes.mp4')])
    console.log(`the node strip side by side: ${join(out, 'nodes.mp4')}`)
  } catch (e) { console.log(`no side-by-side video (${String(e.message).split('\n')[0]}); the two .webm files are there`) }
}

/** The review page: before beside after, per controller and size, then everything the after run caught besides. */
async function writeIndex() {
  const { readdir, readFile } = await import('node:fs/promises')
  const list = async (d) => { try { return (await readdir(join(root, d))).filter((f) => /\.(png|webm)$/.test(f)) } catch { return [] } }
  const before = await list('before')
  const after = await list('after')
  let notes = null
  try { notes = JSON.parse(await readFile(join(root, 'notes.json'), 'utf8')) } catch { /* none */ }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const names = { trackpad: 'Trackpad', wii: 'Wii remote', hand: '3D hand', gamepad: 'Gamepad', wheel: 'Steering wheel', mouse: 'Air mouse', keyboard: 'Keyboard', drums: 'Drums', keys: 'Tone keys' }
  const img = (d, f) => `<figure><img src="${d}/${f}" loading="lazy" alt="${esc(`${d} ${f}`)}"><figcaption>${d}</figcaption></figure>`
  const pair = (f) => `<div class="pair${f.includes('844x390') ? ' wide' : ''}">${before.includes(f) ? img('before', f) : '<figure class="none"><figcaption>before: not there</figcaption></figure>'}${after.includes(f) ? img('after', f) : ''}</div>`
  const sections = Object.entries(names).map(([k, n], i) => {
    const files = SIZES.map((z) => `${k}-${z.name}.png`).filter((f) => before.includes(f) || after.includes(f))
    return files.length ? `<section id="${k}"><h2><b>${String(i + 1).padStart(2, '0')}</b>${n}</h2>${files.map(pair).join('')}</section>` : ''
  }).join('')
  const rest = after.filter((f) => f.endsWith('.png') && !Object.keys(names).some((k) => f.startsWith(`${k}-`)))
  const extras = []
  const extraNames = []
  for (const d of (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && !['before', 'after', 'scratch'].includes(e.name) && !/^iter/.test(e.name))) {
    extraNames.push(d.name)
    const all = await readdir(join(root, d.name))
    const files = all.filter((f) => f.endsWith('.png'))
    // The node strip's video (--nodes): side by side where ffmpeg made one, else the phone's beside the screen's.
    const film = all.includes('nodes.mp4') ? `<video class="wide" src="${d.name}/nodes.mp4" controls loop muted autoplay playsinline></video>`
      : all.includes('nodes-phone.webm') ? `<div class="grid"><video src="${d.name}/nodes-phone.webm" controls loop muted autoplay playsinline></video><video class="wide" src="${d.name}/nodes-screen.webm" controls loop muted autoplay playsinline></video></div>` : ''
    // Notes a run left beside its captures (a check's output before and after a fix), as they were written.
    const texts = []
    for (const f of all.filter((f) => f.endsWith('.txt'))) texts.push(`<figure class="text"><figcaption>${esc(f)}</figcaption><pre>${esc(await readFile(join(root, d.name, f), 'utf8'))}</pre></figure>`)
    if (files.length || film || texts.length) extras.push(`<section id="${esc(d.name)}"><h2><b>+</b>${esc(d.name)}</h2>${film ? `<p class="lede">The node strip on an arm: one finger keeps moving while another switches joints (shoulder, elbow, base), then the Reach and Wrist sets, a locked shoulder under the whole arm's drive, and the gripper.</p>${film}` : ''}${texts.join('')}<div class="grid">${files.map((f) => img(d.name, f)).join('')}</div></section>`)
  }
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Controller UI review</title><style>
:root { color-scheme: dark; --lime: #c6ff34; --ink: #f4f4f5; --ink2: #b9b9bf; --line: rgb(255 255 255 / .1); }
body { margin: 0; background: #0b0b0c; color: var(--ink); font: 15px/1.55 Inter, system-ui, sans-serif; }
main { max-width: 1320px; margin: 0 auto; padding: 32px 20px 80px; }
h1 { font: 800 30px/1.15 'Plus Jakarta Sans', Inter, sans-serif; letter-spacing: -.03em; margin: 0 0 6px; }
h1 i { color: var(--lime); font-style: normal; }
.lede { color: var(--ink2); margin: 0 0 24px; max-width: 70ch; }
nav { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 28px; }
nav a { padding: 7px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--ink2); text-decoration: none; font-size: 13px; }
nav a:hover { border-color: var(--lime); color: var(--ink); }
h2 { display: flex; align-items: center; gap: 12px; margin: 40px 0 14px; font: 750 12px/1 Inter, sans-serif; letter-spacing: .13em; text-transform: uppercase; color: var(--ink2); }
h2 b { font: 600 12px/1 ui-monospace, monospace; color: var(--lime); letter-spacing: 0; }
h2::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.pair { display: inline-flex; gap: 12px; margin: 0 18px 18px 0; vertical-align: top; }
figure { margin: 0; display: grid; gap: 6px; }
figure img { width: 240px; border-radius: 18px; border: 1px solid var(--line); background: #000; }
.pair.wide figure img { width: 460px; border-radius: 14px; }
figcaption { font: 600 11px/1 ui-monospace, monospace; color: var(--ink2); letter-spacing: .06em; text-transform: uppercase; }
figure.none { width: 240px; place-content: center; border: 1px dashed var(--line); border-radius: 18px; }
.grid { display: flex; flex-wrap: wrap; gap: 14px; }
video { width: 300px; border-radius: 22px; border: 1px solid var(--line); }
video.wide { width: min(100%, 1100px); border-radius: 14px; margin: 0 0 18px; }
figure.text { margin: 0 0 18px; }
figure.text pre { margin: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: rgb(255 255 255 / .03); color: var(--ink2); font: 12.5px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
.notes { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin: 0 0 12px; padding: 0; list-style: none; }
.notes li { padding: 12px 14px; border: 1px solid var(--line); border-radius: 14px; background: rgb(255 255 255 / .03); font-size: 13.5px; }
.notes li b { display: block; margin-bottom: 4px; color: var(--lime); font: 600 11px/1 ui-monospace, monospace; letter-spacing: .06em; text-transform: uppercase; }
.notes li span { color: var(--ink2); }
</style></head><body><main>
<h1>ob.Pal controller<i>.</i> before and after</h1>
<p class="lede">Each controller at 390×844, 430×932 and 844×390: before on the left, after on the right. Then the controller catalogue, settings, the switching video and the other captures.</p>
<nav>${Object.entries(names).map(([k, n]) => `<a href="#${k}">${n}</a>`).join('')}<a href="#catalogue">Catalogue</a><a href="#switching">Switching</a>${notes ? '<a href="#audit">Audit</a>' : ''}${extraNames.map((n) => `<a href="#${esc(n)}">${esc(n)}</a>`).join('')}</nav>
${notes ? `<section id="audit"><h2><b>00</b>Audit and what changed</h2><ul class="notes">${notes.map((n) => `<li><b>${esc(n.area)}</b>${esc(n.before)}<br><span>→ ${esc(n.after)}</span></li>`).join('')}</ul></section>` : ''}
${sections}
<section id="catalogue"><h2><b>10</b>Catalogue and settings</h2><div class="grid">${rest.map((f) => img('after', f)).join('')}</div></section>
<section id="switching"><h2><b>11</b>Switching</h2>${after.includes('switching.webm') ? '<video src="after/switching.webm" controls loop muted autoplay playsinline></video>' : '<p class="lede">No video in this run.</p>'}</section>
${extras.join('')}
</main></body></html>`
  await writeFile(join(root, 'index.html'), page)
  console.log(`wrote ${join(root, 'index.html')}`)
}

