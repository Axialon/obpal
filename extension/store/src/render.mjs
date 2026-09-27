/**
 * The Chrome Web Store art of ob.Pal Link, rendered with Playwright's Chromium from the HTML in this folder into
 * extension/store/:
 *   tile-440x280.png, marquee-1400x560.png   the promo tiles (tile.html, marquee.html)
 *   icon-128.png                             the store icon: the build's own (extension/dist/icons/icon-128.png)
 *   screenshot-1.png … screenshot-5.png      1280 × 800 (shot.html around real renders)
 *
 * The screenshots are made of real renders: the built extension (extension/dist) in Chromium, its popup laid out as the
 * popup (640 px wide) and its options page, and the phone controller of the site build (dist/client), paired with the
 * extension through the real signaling service the way the extension's e2e test pairs them. What the popup and the
 * options page show is written into chrome.storage the way the service worker writes it, and the popup is shown an
 * ordinary web page in front (example.com addresses).
 *
 * Safety: the extension runs from a temporary copy without its `key` (so its ID isn't the one ob.Pal Desktop allows)
 * and with the native host renamed to one that isn't installed, so no ob.Pal Desktop is ever started. Nothing touches
 * the registry; the only browsers are Playwright's Chromium, in throwaway profiles.
 *
 * Every image is written as a 24-bit PNG without alpha (the store's format), rendered at twice its size and scaled down.
 *
 * Usage: pnpm run store:art                               (builds the site and the extension first)
 *        node extension/store/src/render.mjs [art] [shots] [--only <n,n>] [--out <dir>]
 *        (--only 1: write screenshot-1.png alone; every render is captured all the same)
 * Chromium: OBPAL_E2E_CHROMIUM=<path to chrome.exe> (a full Chromium, which can load an extension), or Playwright's own.
 */
import { existsSync, statSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'
import sharp from 'sharp'
import { renderSVG } from 'uqr'

const here = dirname(fileURLToPath(import.meta.url))
const store = resolve(here, '..')
const extension = resolve(store, '..')
const repo = resolve(extension, '..')
const dist = join(extension, 'dist')
const site = join(repo, 'dist', 'client')
/** The origin the art pages are served at (the repository, and the captured renders under /captures/). */
const ORIGIN = 'https://store.obpal.test'
const SERVICE = 'https://obpal.blackboxes.net'
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
// Two browsers on one machine: real host candidates instead of mDNS names, so WebRTC connects over loopback.
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns']
const PAGE = '#0b0b0c'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.glb': 'model/gltf-binary',
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const inside = (path, dir) => { const r = relative(dir, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

async function until(what, fn, timeout = 10000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}

const argv = process.argv.slice(2).filter((a) => a !== '--')
/** The value after an option (`--out <dir>`, `--only <n,n>`), or null. */
const option = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? null : null }
const out = option('--out') ? resolve(option('--out')) : store
/** Write only these screenshots (1-based); the renders are all captured still. */
const only = option('--only') ? new Set(option('--only').split(',').map(Number)) : null
const values = new Set(['--out', '--only'].map((o) => argv.indexOf(o)).filter((i) => i >= 0).map((i) => i + 1))
const parts = argv.filter((a, i) => !a.startsWith('--') && !values.has(i))
const doArt = !parts.length || parts.includes('art')
const doShots = !parts.length || parts.includes('shots')

// ---- rendering the HTML --------------------------------------------------------------------------------------------

/** Serve the repository at ORIGIN, and `captures` (the real renders) under /captures/. */
function serve(page, captures) {
  return page.route(`${ORIGIN}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    const [base, rel] = captures && path.startsWith('/captures/') ? [captures, path.slice('/captures/'.length)] : [repo, path.slice(1)]
    const file = resolve(base, rel)
    if (!inside(file, base) || !existsSync(file) || !statSync(file).isFile()) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ path: file, contentType: MIME[extname(file)] ?? 'application/octet-stream' })
  })
}

/** Render `url` at twice [w, h] and write it at [w, h] as a 24-bit PNG. */
async function render(browser, url, [w, h], file, captures) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
  await serve(page, captures)
  await page.goto(url)
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode().catch(() => {})))
  })
  await sleep(200)
  const png = await page.screenshot()
  await page.close()
  await sharp(png).resize(w, h, { kernel: 'lanczos3' }).flatten({ background: PAGE }).removeAlpha().png({ compressionLevel: 9 }).toFile(file)
  const m = await sharp(file).metadata()
  if (m.width !== w || m.height !== h || m.channels !== 3) throw new Error(`${file}: ${m.width}x${m.height}, ${m.channels} channels`)
  console.log(`  ${relative(repo, file)}  ${w}x${h}`)
}

// ---- the promo tiles and the icon ------------------------------------------------------------------------------------

async function art(browser) {
  await render(browser, `${ORIGIN}/extension/store/src/tile.html`, [440, 280], join(out, 'tile-440x280.png'))
  await render(browser, `${ORIGIN}/extension/store/src/marquee.html`, [1400, 560], join(out, 'marquee-1400x560.png'))
  await copyFile(join(dist, 'icons', 'icon-128.png'), join(out, 'icon-128.png'))
  console.log(`  ${relative(repo, join(out, 'icon-128.png'))}  128x128 (the build's icon)`)
}

// ---- the real renders -----------------------------------------------------------------------------------------------

const REAL_HOST = 'net.blackboxes.obpal'
const NO_HOST = 'net.blackboxes.obpal.store_art_none'

/** A copy of the build that can't reach an installed ob.Pal Desktop: no key (another ID), and a native host that doesn't exist. */
async function safeCopy() {
  const ext = await mkdtemp(join(tmpdir(), 'obpal-store-ext-'))
  await cp(dist, ext, { recursive: true })
  const file = join(ext, 'manifest.json')
  const m = JSON.parse(await readFile(file, 'utf8'))
  delete m.key
  // The PC states show only with the permission, and automation can't grant an optional one: required in this copy.
  m.permissions = [...m.permissions, 'nativeMessaging']
  m.optional_permissions = (m.optional_permissions ?? []).filter((p) => p !== 'nativeMessaging')
  await writeFile(file, JSON.stringify(m, null, 2))
  let renamed = 0
  for (const f of await readdir(ext, { recursive: true })) {
    if (!f.endsWith('.js')) continue
    const p = join(ext, f)
    const src = await readFile(p, 'utf8')
    const next = src.replace(/(["'`])net\.blackboxes\.obpal\1/g, `$1${NO_HOST}$1`)
    if (next !== src) { renamed++; await writeFile(p, next) }
  }
  for (const f of await readdir(ext, { recursive: true })) {
    if (/\.(js|json|html)$/.test(f) && new RegExp(`${REAL_HOST.replace(/\./g, '\\.')}(?![.\\w])`).test(await readFile(join(ext, f), 'utf8'))) {
      throw new Error(`${f} still names ${REAL_HOST}: not safe to load`)
    }
  }
  if (!renamed) throw new Error(`no file names ${REAL_HOST}: the build changed, check the rename before loading it`)
  return ext
}

/** In extension pages opened with ?tab=<url>, the active tab is an ordinary web page at that address. */
function fakeTab() {
  if (location.protocol !== 'chrome-extension:') return
  const url = new URLSearchParams(location.search).get('tab')
  if (!url) return
  const patch = () => {
    if (!globalThis.chrome?.tabs) return false
    const query = chrome.tabs.query.bind(chrome.tabs)
    chrome.tabs.query = async (info) => (info?.active ? [{ id: 4242, url, title: '', active: true, index: 0, windowId: 1 }] : query(info))
    return true
  }
  if (!patch()) queueMicrotask(patch)
}

/** The phone's name in the popup: what the controller calls an Android phone that doesn't give its model. */
const DEVICE = 'Android phone'
/** ob.Pal Desktop as the service worker mirrors it into storage.session "pc" (shared/native.ts PcState). */
const app = (name, path, title) => ({ name, path, title, pid: 4120, elevated: false, browser: false, allowed: null })
const STUDIO = app('studio3d.exe', 'C:\\Program Files\\Studio 3D\\studio3d.exe', 'Studio 3D')
const PROGRAMS = [
  { path: STUDIO.path, name: STUDIO.name, keyboard: true, mouse: true },
  { path: 'C:\\Games\\Racer\\racer.exe', name: 'racer.exe', keyboard: true, mouse: false },
  { path: 'C:\\Program Files\\Player\\player.exe', name: 'player.exe', keyboard: false, mouse: true },
]
/** Whole PC on, with a few programs allowed from before: the popup and the options page show the same helper. */
const PC = {
  link: 'ready', version: '0.3.0', desktopCap: true, hotkey: 'Ctrl+Alt+Backspace', error: null, stats: null,
  config: { paused: false, desktop: { keyboard: true, mouse: true }, programs: PROGRAMS },
  status: { enabled: true, panic: false, held: false, front: STUDIO, program: STUDIO, text: null },
}

async function capture(captures) {
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error('no extension build: pnpm run build:extension')
  if (!existsSync(join(site, 'p', 'index.html'))) throw new Error('no site build: pnpm exec vite build')
  const ext = await safeCopy()
  const profile = await mkdtemp(join(tmpdir(), 'obpal-store-profile-'))
  const desk = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, ...RTC_ARGS],
  })
  const phones = await chromium.launch({ executablePath, headless: true, args: RTC_ARGS })
  try {
    await desk.addInitScript(fakeTab)
    const worker = desk.serviceWorkers()[0] ?? (await desk.waitForEvent('serviceworker'))
    const base = `chrome-extension://${new URL(worker.url()).host}`
    const ctl = await desk.newPage()
    await ctl.goto(`${base}/options.html`)
    const read = (area, key) => ctl.evaluate(async ([a, k]) => (await chrome.storage[a].get(k))[k] ?? null, [area, key])
    const session = (s) => ctl.evaluate((s) => chrome.storage.session.set(s), s)
    const send = (m) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), m)
    const shot = (name) => join(captures, `${name}.png`)

    /**
     * Show `pc` as ob.Pal Desktop's state. A page that opens asks the worker to reach the helper, which isn't there
     * (it reports 'missing'): write the state once that has settled, and again should a late attempt overwrite it.
     */
    async function showPc(pc) {
      let stable = 0
      for (let i = 0; i < 30 && stable < 3; i++) {
        await sleep(250)
        const link = (await read('session', 'pc'))?.link
        if (link === 'ready') stable++
        else {
          stable = 0
          if (link !== 'connecting') await session({ pc })
        }
      }
      if (stable < 3) throw new Error('the helper state did not settle')
    }

    /**
     * The popup as Chrome shows it: 640 px wide and as tall as its content. `qr`: the address its code shows instead of
     * the pairing link, drawn as the popup draws its code.
     */
    async function popup(name, { tab, pc, qr } = {}) {
      const page = await desk.newPage()
      await page.setViewportSize({ width: 640, height: 600 })
      await page.goto(`${base}/popup.html${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`)
      await page.evaluate(() => document.fonts.ready)
      if (pc) await showPc(pc)
      await sleep(900)
      if (qr) {
        const svg = renderSVG(qr, { ecc: 'M', border: 1, blackColor: '#0a0a0a', whiteColor: '#ffffff' })
        await page.evaluate((svg) => { document.getElementById('qr').innerHTML = svg }, svg)
      }
      await page.evaluate(() => document.documentElement.classList.remove('in-tab'))
      const box = await page.evaluate(() => { const r = document.querySelector('.pop').getBoundingClientRect(); return { w: Math.ceil(r.width), h: Math.ceil(r.height) } })
      await page.setViewportSize({ width: Math.min(800, box.w), height: Math.min(600, box.h) })
      await sleep(300)
      await page.screenshot({ path: shot(name) })
      await page.close()
      console.log(`  captured ${name} (${box.w}x${box.h})`)
    }

    /** The options page in a 1280 × 800 window. */
    async function options(name, pc) {
      const page = await desk.newPage()
      await page.setViewportSize({ width: 1280, height: 800 })
      await page.goto(`${base}/options.html`)
      await page.evaluate(() => document.fonts.ready)
      await showPc(pc)
      await sleep(900)
      await page.screenshot({ path: shot(name) })
      await page.close()
      console.log(`  captured ${name}`)
    }

    // Ready to pair. A pairing link in a store picture would lead a scanning visitor to a room nobody hosts, so the
    // code shown there holds the site's address instead.
    const ready = await until('a pairing code', async () => { const l = await read('session', 'link'); return l?.status === 'ready' && l.url ? l : null }, 30000)
    await send({ to: 'bg', type: 'mode', mode: 'gamepad' })
    await session({ tab: 4242 })
    await popup('popup-pair', { tab: 'https://play.example.com/', qr: `${SERVICE}/` })

    // The phone: this checkout's controller (dist/client) at the service's address; signaling goes to the real service.
    const phoneCtx = await phones.newContext({ ...devices['Pixel 7 landscape'], serviceWorkers: 'block' })
    await phoneCtx.route(`${SERVICE}/**`, (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname)
      if (path.startsWith('/r/') || path.startsWith('/api/')) return route.continue()
      let file = resolve(site, `.${path}`)
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
      if (!inside(file, site) || !existsSync(file)) return route.fulfill({ status: 404, body: '' })
      return route.fulfill({ path: file, contentType: MIME[extname(file)] ?? 'application/octet-stream' })
    })
    const phone = await phoneCtx.newPage()
    const cdp = await phoneCtx.newCDPSession(phone)
    // A phone has motion sensors; the emulated one gets a steady pose, so its gyro and Point work as on a real one.
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
    const touches = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) })
    // Hints and passing notices (a toast) are moments, not the screen: they stay out of the pictures.
    const clean = () => phone.evaluate(() => {
      document.querySelectorAll('.hint').forEach((h) => h.remove())
      document.getElementById('toast')?.classList.remove('show')
    })
    const tap = async (sel) => {
      await clean()
      const b = await phone.locator(sel).first().boundingBox()
      if (!b) throw new Error(`no ${sel} on the phone`)
      await touches('touchStart', [[b.x + b.width / 2, b.y + b.height / 2]])
      await sleep(60)
      await touches('touchEnd', [])
      await sleep(300)
    }
    const phoneShot = async (name) => { await sleep(700); await clean(); await sleep(400); await phone.screenshot({ path: shot(name) }); console.log(`  captured ${name}`) }

    await phone.goto(ready.url)
    await phone.locator('.modes').waitFor({ timeout: 30000 })
    const live = await until('the phone connected', async () => { const l = await read('session', 'link'); return l?.status === 'connected' ? l : null }, 20000)
    const connected = { ...live, device: DEVICE }

    // Controller: the gamepad face, and the popup in Controller mode.
    await tap('.modes [data-tab=gamepad]')
    await phone.locator('.gp-f[data-k=a]').waitFor({ timeout: 8000 })
    await phoneShot('phone-gamepad')
    await phone.setViewportSize({ width: 412, height: 839 })
    await phoneShot('phone-gamepad-portrait')
    await phone.setViewportSize({ width: 863, height: 360 })
    await session({ link: connected, tab: 4242 })
    await popup('popup-gamepad', { tab: 'https://play.example.com/' })

    // 3D: the trackpad, and the popup in 3D mode.
    await send({ to: 'bg', type: 'mode', mode: 'viewer' })
    await tap('.gp-mini[data-act=exit]')
    await tap('.modes [data-tab=rotate]')
    await phone.locator('#pad').waitFor({ timeout: 8000 })
    await phoneShot('phone-rotate')
    await session({ link: connected, tab: 4242 })
    await popup('popup-viewer', { tab: 'https://3d.example.com/' })

    // PC: the mouse face (Point), the popup controlling the whole PC, and the options page with allowed programs.
    await send({ to: 'bg', type: 'mode', mode: 'pc' })
    await until('the helper check', async () => (await read('session', 'pc'))?.link === 'missing')
    await tap('.modes [data-tab=point]')
    await phone.locator('#mouse').waitFor({ state: 'visible', timeout: 8000 })
    await phoneShot('phone-mouse')
    await session({ link: connected, tab: 4242 })
    await popup('popup-pc', { tab: 'https://play.example.com/', pc: PC })
    await options('options', PC)

    // Typing: a text field has the focus on the PC, so the phone offers Type; one tap opens its keyboard dock.
    await phone.setViewportSize({ width: 412, height: 839 })
    await tap('.modes [data-tab=rotate]')
    // What the service worker tells the link when ob.Pal Desktop reports a focused text field. The link takes it only
    // from a context without a tab, so it goes from the worker.
    const sw = desk.serviceWorkers()[0] ?? (await desk.waitForEvent('serviceworker'))
    await sw.evaluate(() => chrome.runtime.sendMessage({ to: 'offscreen', type: 'text-field', field: 'text' }).catch(() => undefined))
    await phone.locator('#type-prompt').waitFor({ state: 'visible', timeout: 8000 })
    await tap('#type-prompt')
    await phone.locator('#kbd').waitFor({ state: 'visible', timeout: 8000 })
    // Nothing on this computer types (no ob.Pal Desktop here), so the phone would say so: that notice stays out of the picture.
    await phone.addStyleTag({ content: '#toast { display: none !important; }' })
    await phone.keyboard.type('See you at 7, bring the snacks')
    // The phone's own keyboard, which a screenshot can't show: a plain stand-in, with the dock riding on it as it does.
    await phone.evaluate(() => {
      const kb = document.createElement('div')
      kb.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:290px;z-index:100;background:#1c1c1f;border-top:1px solid #2c2c30;display:grid;grid-template-rows:repeat(4,1fr);gap:9px;padding:12px 5px 26px'
      for (const r of ['qwertyuiop', 'asdfghjkl', '⇧zxcvbnm⌫', '?123 , space . ↵']) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;gap:5px;justify-content:center'
        for (const k of r.includes(' ') ? r.split(' ') : [...r]) {
          const key = document.createElement('span')
          const [flex, max] = k === 'space' ? [5, 190] : k.length > 1 ? [1.6, 58] : [1, 37]
          key.textContent = k
          key.style.cssText = `flex:${flex};max-width:${max}px;border-radius:7px;background:#38383d;color:#eee;display:grid;place-items:center;white-space:nowrap;font:500 ${k.length > 1 && k !== 'space' ? 15 : 19}px Inter,system-ui`
          row.appendChild(key)
        }
        kb.appendChild(row)
      }
      document.body.appendChild(kb)
      const dock = document.getElementById('kbd')
      dock.style.setProperty('--kb', '290px')
      dock.classList.add('up')
    })
    await phoneShot('phone-typing')
    await phoneCtx.close()
  } finally {
    await desk.close()
    await phones.close()
    await rm(ext, { recursive: true, force: true }).catch(() => {})
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

// ---- the screenshots: a caption and the renders, laid out on shot.html ---------------------------------------------------

const cap = { x: 64, y: 58, w: 560 }
const SHOTS = [
  {
    title: 'Your phone controls *any website*',
    sub: 'Scan the code: the controller opens in your phone’s browser. No app to install.',
    cap,
    glow: [{ x: 60, y: 360, w: 700, h: 360, a: 0.14 }, { x: 800, y: 80, w: 420, h: 600, a: 0.16 }],
    items: [
      { src: 'popup-pair', kind: 'popup', x: 64, y: 340, w: 660 },
      { src: 'phone-gamepad-portrait', kind: 'phone', x: 860, y: 96, w: 300, z: 2 },
    ],
  },
  {
    title: 'A *gamepad* for browser games',
    sub: 'For any game that uses the Gamepad API. Rumble reaches your phone.',
    cap,
    glow: [{ x: 60, y: 420, w: 820, h: 340, a: 0.16 }, { x: 760, y: 40, w: 460, h: 300, a: 0.12 }],
    items: [
      { src: 'popup-gamepad', kind: 'popup', x: 700, y: 64, w: 520, z: 2 },
      { src: 'phone-gamepad', kind: 'phone', land: true, x: 64, y: 372, w: 860 },
    ],
  },
  {
    title: 'Rotate, pan and zoom in *3D*',
    sub: 'Drag to rotate, two fingers to pan, pinch to zoom, on any 3D viewer in the page.',
    cap,
    glow: [{ x: 360, y: 420, w: 820, h: 340, a: 0.16 }, { x: 40, y: 40, w: 460, h: 300, a: 0.08 }],
    items: [
      { src: 'popup-viewer', kind: 'popup', x: 700, y: 64, w: 520, z: 2 },
      { src: 'phone-rotate', kind: 'phone', land: true, x: 356, y: 372, w: 860 },
    ],
  },
  {
    title: 'Your *whole PC*, with ob.Pal Desktop',
    sub: 'Every window, or only the programs you allow. Ctrl + Alt + Backspace stops it all.',
    cap: { x: 64, y: 58, w: 600 },
    glow: [{ x: 660, y: 40, w: 580, h: 440, a: 0.16 }, { x: 40, y: 420, w: 760, h: 340, a: 0.12 }],
    items: [
      { src: 'popup-pc', kind: 'popup', x: 708, y: 56, w: 512, z: 2 },
      { src: 'options', kind: 'page', x: 64, y: 336, w: 704 },
    ],
  },
  {
    title: 'Your PC’s *mouse and keyboard*',
    sub: 'Point, tap and scroll, and type with your phone’s own keyboard. When a text field has the focus, your phone offers it.',
    cap: { x: 64, y: 58, w: 620 },
    glow: [{ x: 40, y: 420, w: 820, h: 340, a: 0.14 }, { x: 900, y: 100, w: 340, h: 600, a: 0.16 }],
    items: [
      { src: 'phone-mouse', kind: 'phone', land: true, x: 64, y: 408, w: 800 },
      { src: 'phone-typing', kind: 'phone', x: 926, y: 116, w: 290, z: 2 },
    ],
  },
]

async function screenshots(browser, captures) {
  for (const [i, s] of SHOTS.entries()) {
    if (only && !only.has(i + 1)) continue
    const spec = { ...s, items: s.items.map((it) => ({ ...it, src: `/captures/${it.src}.png` })) }
    await render(browser, `${ORIGIN}/extension/store/src/shot.html#${encodeURIComponent(JSON.stringify(spec))}`, [1280, 800], join(out, `screenshot-${i + 1}.png`), captures)
  }
}

// ---- run --------------------------------------------------------------------------------------------------------------

await mkdir(out, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true })
const captures = await mkdtemp(join(tmpdir(), 'obpal-store-captures-'))
try {
  console.log(`ob.Pal Link store art -> ${out}`)
  if (doArt) await art(browser)
  if (doShots) {
    await capture(captures)
    await screenshots(browser, captures)
  }
} finally {
  await browser.close()
  if (process.env.OBPAL_STORE_KEEP_CAPTURES) console.log(`  renders kept in ${captures}`)
  else await rm(captures, { recursive: true, force: true }).catch(() => {})
}
