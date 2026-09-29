/**
 * The pairing chip and the short code end to end (PROTOCOL §2b), on this checkout's build with its own worker running
 * locally (scripts/local-worker.mjs: `wrangler dev` on port 5179, or OBPAL_E2E_WORKER_PORT, fresh each run; the short
 * code needs the worker's Codes object, which the production service may not have yet):
 *   - The Viewer's chip opens with the branded QR code (read back with jsQR and ZXing from the page's own pixels) and a
 *     short code; the keyboard opens and closes it; it follows the page's theme; reduced motion stills it.
 *   - A phone types the code on the start page and joins: the chip closes, the screen shows a new code at once, and the
 *     phone reloads into the same scene with the invite it was handed.
 *   - A screen with a phone connected never reloads itself when a lazy chunk is gone after a deploy (src/ui/recover.ts);
 *     one with no phone does.
 *   - A spent code finds nothing; a wrong secret with a live handle fails the exchange and retires that code.
 *   - Ten lookups that find nothing, and the address is slowed down, live codes included.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch. OBPAL_SHOTS=<dir> saves
 * screenshots of the chip on several looks and on a phone.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, devices } from 'playwright'
import { cspCheck } from './csp-watch.mjs'
import sharp from 'sharp'
import jsQR from 'jsqr'
import zx from '@zxing/library'
import { startWorker } from './local-worker.mjs'

const PORT = Number(process.env.OBPAL_E2E_WORKER_PORT) || 5179
const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OBPAL_SHOTS || ''
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns']
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
const shot = async (page, name, opts) => { if (SHOTS) await page.screenshot({ path: joinPath(SHOTS, `${name}.png`), ...opts }) }

/** Observe the existing candidate envelope and the receiving WebRTC call on both real peers. */
function watchCompletion() {
  window.__iceEnd = { sent: 0, received: 0 }
  const send = WebSocket.prototype.send
  WebSocket.prototype.send = function (data) {
    try { if (JSON.parse(data)?.d?.cand?.candidate === '') window.__iceEnd.sent++ } catch { /* ping */ }
    return send.call(this, data)
  }
  const add = RTCPeerConnection.prototype.addIceCandidate
  RTCPeerConnection.prototype.addIceCandidate = async function (candidate) {
    await add.call(this, candidate)
    if (candidate?.candidate === '') window.__iceEnd.received++
  }
}

/** Both decoders on a screenshot of the QR code as the browser drew it. */
async function readQr(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length)
  const js = jsQR(px, info.width, info.height, { inversionAttempts: 'dontInvert' })?.data ?? null
  const lum = new Uint8ClampedArray(info.width * info.height)
  for (let i = 0; i < lum.length; i++) lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000
  let z = null
  try { z = new zx.QRCodeReader().decode(new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(lum, info.width, info.height)))).getText() } catch { /* unread */ }
  return { js, zx: z }
}

const closers = []
const profiles = []
let worker = null
let exitCode = 0
try {
  worker = await startWorker({ port: PORT })
  const ORIGIN = worker.origin
  console.log(`ob.Pal pairing chip and short code e2e (${ORIGIN})`)

  const browser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(browser)
  const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  await screenCtx.addInitScript(watchCompletion)
  const screen = await screenCtx.newPage()
  const errors = []
  screen.on('pageerror', (e) => errors.push(e.message))
  await screen.goto(`${ORIGIN}/view/`)
  const chipState = () => screen.evaluate(() => {
    const root = document.querySelector('.obpal-chip')?.shadowRoot
    const w = root?.querySelector('.wrap')
    return {
      open: root?.querySelector('.pill')?.getAttribute('aria-expanded') === 'true',
      code: root?.querySelector('.code')?.textContent ?? '',
      codeShown: !!root && !root.querySelector('.code-box').hidden,
      scheme: w?.dataset.scheme,
      accent: w?.style.getPropertyValue('--a'),
      status: w?.dataset.s,
    }
  })
  const liveCode = () => screen.evaluate(() => window.__obpal?.code || '')

  await check('the Viewer opens its chip with the branded QR code and a short code; both decoders read the QR from the page', async () => {
    const code = await until('a short code', liveCode, 20000)
    const s = await chipState()
    if (!s.open) throw new Error('the chip started closed')
    if (s.code.replace(/\s/g, '') !== code) throw new Error(`the chip shows "${s.code}", the remote has ${code}`)
    const url = await screen.evaluate(() => window.__obpal.pairingUrl)
    const qr = screen.locator('.obpal-chip .qr')
    await until('the QR code drawn', async () => (await qr.innerHTML()).includes('<svg'))
    const read = await readQr(await qr.screenshot())
    if (read.js !== url || read.zx !== url) throw new Error(`read ${JSON.stringify(read)}`)
    await shot(screen, 'chip-viewer-carbon-open')
    return `code ${s.code}, QR read by jsQR and ZXing`
  })

  await check('the keyboard opens and closes it: Enter on the chip, Escape inside it; aria-expanded follows', async () => {
    const pill = screen.locator('.obpal-chip .pill')
    await pill.focus()
    await screen.keyboard.press('Enter')
    if ((await chipState()).open) throw new Error('Enter did not close it')
    await shot(screen, 'chip-viewer-carbon-closed')
    await screen.keyboard.press('Enter')
    if (!(await chipState()).open) throw new Error('Enter did not open it')
    await screen.keyboard.press('Escape')
    const s = await chipState()
    if (s.open) throw new Error('Escape did not close it')
    const focused = await screen.evaluate(() => document.querySelector('.obpal-chip')?.shadowRoot?.activeElement?.className)
    if (focused !== 'pill') throw new Error(`focus went to ${focused}`)
    await screen.keyboard.press('Space')
    if (!(await chipState()).open) throw new Error('Space did not open it')
    return 'Enter, Escape, Space'
  })

  await check('it takes the page’s look: the light surface, then a lavender accent', async () => {
    await screen.evaluate(() => document.documentElement.setAttribute('data-bb-theme', 'light'))
    const light = await until('light glass', async () => { const s = await chipState(); return s.scheme === 'light' ? s : null }, 3000)
    await shot(screen, 'chip-viewer-light-open')
    await screen.evaluate(() => document.documentElement.setAttribute('data-bb-theme', 'violet'))
    await screen.evaluate(() => document.documentElement.style.setProperty('--obpal-accent', '#d2c3f6'))
    const violet = await until('lavender accent', async () => { const s = await chipState(); return s.accent === '#d2c3f6' && s.scheme === 'dark' ? s : null }, 3000)
    await shot(screen, 'chip-viewer-violet-open')
    await screen.evaluate(() => { document.documentElement.setAttribute('data-bb-theme', 'carbon'); document.documentElement.style.removeProperty('--obpal-accent') })
    return `${light.scheme} glass, then ${violet.accent} on ${violet.scheme}`
  })

  await check('another host’s look: a serif font, an orange accent, square corners on a paper page', async () => {
    // The page's own rules win over the Viewer's (:root is more specific than html, so !important).
    await screen.addStyleTag({ content: `html{background:#f3efe6!important;--obpal-accent:#ff5a1f!important;--obpal-radius:6px!important;--obpal-font:Georgia,serif!important;color-scheme:light!important}` })
    const s = await until('the paper look', async () => { const v = await chipState(); return v.accent === '#ff5a1f' && v.scheme === 'light' ? v : null }, 3000)
    const font = await screen.evaluate(() => getComputedStyle(document.querySelector('.obpal-chip').shadowRoot.querySelector('.code')).fontFamily)
    if (!/Georgia/.test(font)) throw new Error(`font ${font}`)
    const shotBox = await screen.locator('.obpal-chip .card').boundingBox()
    await shot(screen, 'chip-paper-open', { clip: { x: shotBox.x - 40, y: shotBox.y - 40, width: shotBox.width + 80, height: shotBox.height + 110 } })
    await screen.evaluate(() => document.head.lastElementChild.remove())
    return `${s.accent}, ${font.split(',')[0]}`
  })

  await check('reduced motion: the card opens without moving, the status dot is still', async () => {
    await screen.emulateMedia({ reducedMotion: 'reduce' })
    const m = await screen.evaluate(() => {
      const r = document.querySelector('.obpal-chip').shadowRoot
      return { card: getComputedStyle(r.querySelector('.card')).transitionDuration, dot: getComputedStyle(r.querySelector('.dot')).animationName }
    })
    await screen.emulateMedia({ reducedMotion: null })
    if (!/^0s(, 0s)*$/.test(m.card) || m.dot !== 'none') throw new Error(JSON.stringify(m))
    return `transition ${m.card}, dot ${m.dot}`
  })

  await check('the lighting panel and the chip never overlap: the card folds while it is open and comes back after, the panel ends above the chip, and a click on the chip opens the card in its place', async () => {
    const rects = () => screen.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, r: b.right, b: b.bottom } }
      const root = document.querySelector('.obpal-chip').shadowRoot
      return { panel: r(document.getElementById('lighting')), pill: r(root.querySelector('.pill')), card: r(root.querySelector('.card')) }
    })
    const meets = (a, b) => Math.min(a.r, b.r) > Math.max(a.x, b.x) && Math.min(a.b, b.b) > Math.max(a.y, b.y)
    if (!(await chipState()).open) throw new Error('the card should be open to start with')
    await screen.mouse.move(640, 300)
    await screen.keyboard.press('l')
    await until('the card folded', async () => !(await chipState()).open, 3000)
    const g = await rects()
    if (meets(g.panel, g.pill)) throw new Error(`the panel (to ${g.panel.b}) reaches the chip (from ${g.pill.y})`)
    // Reset, the panel's last control, is where a click finds it; so is the stage where the card would open.
    const reset = await screen.evaluate(() => { const b = document.getElementById('lt-reset'); b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.id })
    if (reset !== 'lt-reset') throw new Error(`a click on Reset reaches ${reset}`)
    const through = await screen.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.className, { x: g.card.x + 20, y: (g.card.y + g.card.b) / 2 })
    if (through !== 'scene') throw new Error(`where the card would open, a click reaches ${through}`)
    // A mouse resting on the chip doesn't open the card over the panel.
    const pill = screen.locator('.obpal-chip .pill')
    await pill.hover()
    await sleep(600)
    if ((await chipState()).open) throw new Error('hovering opened the card over the panel')
    await shot(screen, 'chip-viewer-lighting')
    await screen.keyboard.press('Escape')
    await until('the card back', async () => (await chipState()).open, 3000)
    // With the panel open again, a click on the chip closes the panel (as any click outside it) and opens the card.
    await screen.mouse.move(640, 300)
    await screen.keyboard.press('l')
    await until('folded again', async () => !(await chipState()).open, 3000)
    await pill.click()
    await sleep(500)
    const after = { open: (await chipState()).open, panel: await screen.evaluate(() => !document.getElementById('lighting').hidden) }
    if (!after.open || after.panel) throw new Error(`after the click: ${JSON.stringify(after)}`)
    return `panel to ${Math.round(g.panel.b)}px, chip from ${Math.round(g.pill.y)}px; Reset and the stage clickable; hover kept it folded; Escape brought it back; a click opened it`
  })

  // ---- a phone types the code ----
  const phoneAt = async (url) => {
    const dir = await mkdtemp(joinPath(tmpdir(), 'obpal-code-'))
    profiles.push(dir)
    const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
    closers.push(ctx)
    await ctx.addInitScript(watchCompletion)
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    await page.goto(url)
    return page
  }
  const phone = await phoneAt(`${ORIGIN}/p/`)
  let joinedWith = ''

  await check('a phone types the code, spaces and all, on the start page and joins; the chip closes and shows a new code at once', async () => {
    const code = await until('a short code', liveCode, 20000)
    await phone.locator('#code-in').waitFor()
    await shot(phone, 'phone-start')
    joinedWith = code
    const typed = `${code.slice(0, 3)} ${code.slice(3, 6)}-${code.slice(6)}`
    // All but the last digit, to see how the field groups them; the tenth digit sends the code at once.
    await phone.locator('#code-in').pressSequentially(typed.slice(0, -1), { delay: 30 })
    const shown = await phone.locator('#code-in').inputValue()
    if (await phone.locator('.modes').count()) throw new Error('it went before the tenth digit')
    await phone.locator('#code-in').pressSequentially(typed.slice(-1))
    await shot(phone, 'phone-start-typed')
    await phone.locator('.modes').waitFor({ timeout: 25000 })
    const people = await until('the phone on the screen', () => screen.evaluate(() => window.__obpal.participants.length), 10000)
    const s = await until('the chip closed', async () => { const v = await chipState(); return !v.open && v.status === 'connected' ? v : null }, 5000)
    await sleep(400)
    await shot(screen, 'chip-viewer-connected')
    // Closed with a phone in, it holds no code; the people chip's + opens it again, with a code nobody has used.
    await screen.locator('#chip-invite').click()
    const next = await until('a fresh code', async () => { const c = await liveCode(); return c && c !== code ? c : null }, 5000)
    if (!(await chipState()).open) throw new Error('+ did not open the chip')
    return `typed "${typed}", field read "${shown}"; ${people} on the screen, the chip closed (${s.status}); + opens it with ${next}`
  })

  await check('both peers signal gathering completion and pass it to addIceCandidate', async () => {
    await until('end of candidates in both directions', async () => {
      const ends = await Promise.all([screen.evaluate(() => window.__iceEnd), phone.evaluate(() => window.__iceEnd)])
      return ends.every((e) => e.sent > 0 && e.received > 0)
    }, 30000)
  })

  await check('the phone kept the verified invite as a key: a reload rejoins without the short code', async () => {
    await until('remembered invite key', () => phone.evaluate(() => new Promise((resolve) => {
      const request = indexedDB.open('obpal')
      request.onsuccess = () => {
        const db = request.result, id = sessionStorage.getItem('obpal.active')
        if (!id) { db.close(); resolve(false); return }
        const read = db.transaction('connections').objectStore('connections').get(id)
        read.onsuccess = () => { resolve(read.result?.invite?.key instanceof CryptoKey && !read.result.invite.key.extractable); db.close() }
        read.onerror = () => { db.close(); resolve(false) }
      }
      request.onerror = () => resolve(false)
    })))
    await phone.reload()
    await phone.locator('.modes').waitFor({ timeout: 25000 })
    await until('still one on the screen', () => screen.evaluate(() => window.__obpal.participants.length === 1), 10000)
    return 'rejoined'
  })

  await check('a screen with a phone connected never reloads itself for a gone chunk (src/ui/recover.ts), and one with no phone does', async () => {
    const chunkGone = (page) => page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError')))
    const guard = (page) => page.evaluate(() => sessionStorage.getItem('obpal:deploy-reload'))
    let loads = 0
    const count = () => { loads++ }
    screen.on('load', count)
    await chunkGone(screen)
    await sleep(2500)
    screen.off('load', count)
    if (loads || await guard(screen)) throw new Error(`the screen with a phone reloaded (${loads} loads) or wrote its guard`)
    const bare = await screenCtx.newPage()
    try {
      await bare.goto(`${ORIGIN}/view/`)
      let bareLoads = 0
      bare.on('load', () => { bareLoads++ })
      await chunkGone(bare)
      await until('the screen with no phone reloaded', async () => { try { return bareLoads === 1 && !!(await guard(bare)) } catch { return false } }, 10000)
    } finally { await bare.close() }
    return 'held with a phone in; reloaded once with none'
  })

  const second = await phoneAt(`${ORIGIN}/p/`)
  await check('the spent code finds nothing', async () => {
    await second.locator('#code-in').fill(joinedWith)
    await second.locator('#code-in').press('Enter')
    const say = await until('an answer', async () => (await second.locator('#code-say').textContent()) || '', 8000)
    if (!/No screen shows that code/.test(say)) throw new Error(say)
    return say
  })

  await check('a wrong secret with a live handle fails the exchange on both sides, and the screen retires that code', async () => {
    if (!(await chipState()).open) await screen.locator('#chip-invite').click()
    const code = await until('a live code', liveCode, 5000)
    const wrong = code.slice(0, -1) + String((Number(code.at(-1)) + 1) % 10)
    await second.locator('#code-in').fill(wrong)
    await second.locator('#code-in').press('Enter')
    await second.locator('text=That code didn’t match').waitFor({ timeout: 25000 })
    const next = await until('a new code on the screen', async () => { const c = await liveCode(); return c && c !== code ? c : null }, 5000)
    const people = await screen.evaluate(() => window.__obpal.participants.length)
    if (people !== 1) throw new Error(`${people} on the screen`)
    await shot(second, 'phone-code-wrong')
    return `${wrong} refused; the screen now shows ${next}`
  })

  await check('ten lookups that find nothing slow the address down, live codes included (no enumeration)', async () => {
    const statuses = await second.evaluate(async () => {
      const out = []
      for (let i = 0; i < 11; i++) out.push((await fetch('/api/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(90000 + i) }) })).status)
      return out
    })
    const live = (await liveCode()).slice(0, -5)
    const liveStatus = await second.evaluate(async (h) => (await fetch('/api/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: h }) })).status, live)
    const misses = statuses.filter((s) => s === 404).length
    if (statuses.at(-1) !== 429 || liveStatus !== 429) throw new Error(`statuses ${statuses.join(',')}, live ${liveStatus}`)
    return `${misses} misses, then 429; the live handle answers 429 too`
  })

  await check('no page errors on the screen', async () => {
    if (errors.length) throw new Error(errors.join(' | '))
  })

  // ---- the chip on a phone-sized screen ----
  if (SHOTS) {
    const small = await browser.newContext({ ...devices['Pixel 7'] })
    const p = await small.newPage()
    await p.goto(`${ORIGIN}/view/`)
    await until('a code on the small screen', () => p.evaluate(() => window.__obpal?.code || ''), 20000)
    await sleep(600)
    await shot(p, 'chip-viewer-phone-open')
    await p.locator('.obpal-chip .pill').click()
    await sleep(400)
    await shot(p, 'chip-viewer-phone-closed')
    await small.close()
  }
  await check('no Content Security Policy violations on any page', cspCheck)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  for (const c of closers.reverse()) await c.close().catch(() => {})
  for (const d of profiles) await rm(d, { recursive: true, force: true }).catch(() => {})
  await worker?.close()
}
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed || exitCode ? 1 : 0)
