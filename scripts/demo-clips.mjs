/**
 * Backup video clips of the show, recorded from the live site. If a step of docs/PRESENTATION.md fails on the day, the
 * presenter plays that step's clip: 30 to 60 seconds of it, in the browser's own full-HD frame, as a visitor would see it.
 *
 *   01-home-marbles        the home page at ?quality=native: the pairing QR and code, a phone joins and flicks marbles
 *   02-viewer              the Viewer with its model, a phone orbits it with the trackpad
 *   03-humanoid-presets    Keel on the humanoid sim: walking, the six presets, a phone's stick
 *   04-octopus-showcase    Cove on its own: finds the ball, wraps it, carries it to the ring (nobody is paired)
 *   05-link-try            /link/try/ with a gamepad on it, as Link gives a tab (see below)
 *   06-watch-link          a guest on a watch link, Watching (and 06-watch-link-share, the screen's Share panel)
 *
 * Each has a .webm and a .jpg poster; a clip with a phone in it has the phone's own screen as <name>-phone.webm.
 *
 *   pnpm run demo:clips [-- <folder>] [--only home,viewer,humanoid,octopus,link,watch] [--seconds <30 to 60>]
 *                       [--origin <url>] [--software] [--no-lease] [--wait-min <n>]
 *
 * The folder is artifacts/demo-clips/ unless one is given. --seconds is how long a clip runs from the moment its page
 * opens (default 40, so a slow load costs the clip its first seconds). It prints a table of the files and their lengths,
 * read from the files, and writes clips.json beside them.
 *
 * Rendering is the machine's hardware GPU (Direct3D 11, 1920 x 1080, scale 1), the way the e2e suites ask for it with
 * OBPAL_E2E_GPU=1; it queues for one of the shared GPU slots first (pnpm run gpu shows them) so a clip is not recorded
 * while an exclusive timing run holds the card. --software records with SwiftShader instead (or OBPAL_E2E_GPU=swiftshader),
 * --no-lease skips the queue. The browser is OBPAL_E2E_CHROMIUM, else Playwright's own Chromium.
 *
 * The room service is the live one: a clip opens ordinary rooms (each lasts until its page closes), pairs emulated
 * phones to them and shares one scene to a guest, then stops sharing. A clip shows a pairing QR and code, or a watch
 * link, that are dead once the run has closed its pages; none is printed or kept in the table.
 *
 * Link. The extension is never loaded here, and ob.Pal Desktop is never reached. The Link clip drives /link/try/ with a
 * synthetic gamepad, which the page reads through the same Gamepad API Link feeds: it shows what the page does when a
 * stick moves, not Link itself. Like the e2e runner, the run reads the helper's log (%APPDATA%\obpal\desktop.log, or
 * OBPAL_DESKTOP_LOG), read only, before and after and says whether it gained a line naming a test browser.
 * Exit codes: 0 clips written, 1 a clip missing, 2 bad arguments or no hardware GPU, 3 the guard tripped.
 */
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { detectE2eGpu, e2eBrowserOptions, resolveChromium, shortPath } from './lib/browser.mjs'
import { drag, hasCode, joinPhone, pushStick, quiet, sleep, startFailure, syntheticGamepad } from './lib/clip-browser.mjs'
import { clipRow, clock, DEFAULT_OUT, parseArgs, SEGMENTS, verdict, webmDuration } from './lib/clips.mjs'
import { acquireGpuLease } from './lib/gpu-lease.mjs'
import { brief, guardLine } from './lib/preflight.mjs'
import { formatTable } from './lib/report.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
let opts
try {
  opts = parseArgs(process.argv.slice(2), process.env)
} catch (e) {
  console.error(`demo:clips: ${e.message}`)
  process.exit(2)
}
if (opts.help) {
  console.log('pnpm run demo:clips [-- <folder>] [--only home,viewer,humanoid,octopus,link,watch] [--seconds <30 to 60>] [--origin <url>] [--software] [--no-lease] [--wait-min <n>]')
  process.exit(0)
}
const ORIGIN = opts.origin
const out = resolve(opts.out || join(root, DEFAULT_OUT))
mkdirSync(out, { recursive: true })
/** Videos land here while a page is open, then move to `out` under their clip's name. Removed at the end. */
const scratch = mkdtempSync(join(out, '.recording-'))
const VIEW = { width: 1920, height: 1080 }
const t0 = Date.now()

// ---- the helper's log, for the guard -------------------------------------------------------------------------------
const desktopLog = process.env.OBPAL_DESKTOP_LOG || (process.env.APPDATA ? join(process.env.APPDATA, 'obpal', 'desktop.log') : '')
const readLog = () => { try { return readFileSync(desktopLog) } catch { return null } }
const logAtStart = desktopLog ? readLog() : null

// ---- a clip --------------------------------------------------------------------------------------------------------
let browser
const rows = []
const warnings = []

/**
 * Opens a screen on a recorded page: `clip.page`, `clip.left()` (ms until the clip should end) and what to save. Phones and
 * guests added to it are recorded and saved with it.
 */
async function openClip(seg, { suffix = '', lengthS = opts.seconds } = {}) {
  const dir = join(scratch, `${seg.key}${suffix}`)
  const ctx = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, recordVideo: { dir, size: VIEW } })
  const page = await ctx.newPage()
  const started = Date.now()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 100)))
  return { seg, suffix, ctx, page, dir, started, end: started + lengthS * 1000, errors, phones: [], left() { return this.end - Date.now() } }
}

/** A phone on the clip's pairing link, its own screen recorded beside the clip. */
async function addPhone(clip, page = clip.page) {
  const invite = await page.evaluate(() => window.__obpal.pairingUrl)
  const phone = await joinPhone(browser, invite, join(clip.dir, `phone-${clip.phones.length}`))
  clip.phones.push(phone)
  await page.waitForFunction(() => window.__obpal.participants.some((p) => p.capability !== 'watch'), null, { timeout: 20_000 })
  await quiet(phone.page)
  return phone
}

/** The page loads and, for a sim, is not the card a sim shows when it failed to start. */
async function open(clip, path, ready) {
  const res = await clip.page.goto(`${ORIGIN}${path}`, { waitUntil: 'load', timeout: 40_000 })
  if (res?.status() !== 200) throw new Error(`HTTP ${res?.status()}`)
  if (ready) await clip.page.waitForFunction(ready, null, { timeout: 45_000 })
  const failure = await startFailure(clip.page)
  if (failure) throw new Error(`the page shows "${failure.split('.')[0]}"`)
}

/** Waits until `ms` are left of the clip. */
async function until(clip, ms) {
  const wait = clip.left() - ms
  if (wait > 0) await sleep(wait)
}

/** The sim is up, not the card a sim shows when it failed to start (that can appear after the page has loaded). */
async function started(clip) {
  const failure = await startFailure(clip.page)
  if (failure) throw new Error(`the page shows "${failure.split('.')[0]}"`)
}

/** Saves what the clip recorded as <file>.webm (the page) and <file>-phone.webm (its first phone), and its poster. Returns the rows. */
async function saveClip(clip, file, { poster = true } = {}) {
  if (poster) await clip.page.screenshot({ path: join(out, `${file}.jpg`), type: 'jpeg', quality: 86 }).catch(() => {})
  const videos = [[clip.page, `${file}.webm`], ...clip.phones.slice(0, 1).map((p) => [p.page, `${file}-phone.webm`])]
  const made = []
  for (const [page, name] of videos) {
    const video = page.video()
    await page.close()
    await video.saveAs(join(out, name))
    made.push(name)
  }
  await Promise.all([clip.ctx, ...clip.phones.map((p) => p.ctx)].map((c) => c.close().catch(() => {})))
  return made
}

/** Adds a saved file's row: its size and its length, read from the file. */
function record(segment, name, detail, companion) {
  let bytes = 0, ms = null
  try {
    bytes = statSync(join(out, name)).size
    ms = webmDuration(new Uint8Array(readFileSync(join(out, name))))
  } catch { /* a file that was not written is a FAIL row */ }
  rows.push(clipRow({ segment, file: name, ms, bytes, detail, companion }))
}

/** Runs one segment: its clip is saved when it ends, and a segment that throws is a FAIL row (its partial video is dropped). */
async function segment(seg, run) {
  const start = Date.now()
  console.log(`  ${seg.file} …`)
  // An earlier run's files for this segment go first: a clip that fails now must not leave a stale one that looks current.
  for (const name of [`${seg.file}.webm`, `${seg.file}-phone.webm`, `${seg.file}-share.webm`, `${seg.file}.jpg`]) rmSync(join(out, name), { force: true })
  let clip = null
  try {
    clip = await run()
  } catch (e) {
    rows.push({ segment: seg.name, file: `${seg.file}.webm`, status: 'FAIL', ms: null, bytes: 0, detail: brief(e) })
    console.log(`    FAIL ${brief(e)}`)
    return
  }
  const { notes, saved } = clip
  for (const name of saved) {
    const main = name === `${seg.file}.webm`
    record(seg.name, name, main ? notes.join('; ') : name.endsWith('-phone.webm') ? "the phone's own screen" : "the screen's Share panel", !main)
  }
  console.log(`    done in ${((Date.now() - start) / 1000).toFixed(0)} s`)
}

/** Segments open a clip, drive it to its end, then hand back what to save. A clip that fails is closed without a file. */
async function drive(seg, body, options) {
  const clip = await openClip(seg, options)
  try {
    const notes = (await body(clip)) ?? []
    if (clip.errors.length) warnings.push(`${seg.file}: page error ${clip.errors[0]}`)
    return { notes, saved: await saveClip(clip, seg.file) }
  } catch (e) {
    await Promise.all([clip.ctx, ...clip.phones.map((p) => p.ctx)].map((c) => c.close().catch(() => {})))
    throw e
  }
}

const bySeg = (key) => SEGMENTS.find((s) => s.key === key)

// ---- the segments --------------------------------------------------------------------------------------------------
const SWIPES = [[108, -60], [-124, 36], [64, 92], [-96, -84], [136, 12], [-44, -112]]

/** 1. Home and marbles: the QR and code on the screen, then a phone flicking marbles on its trackpad. */
const home = (seg) => drive(seg, async (clip) => {
  const page = clip.page
  await open(clip, seg.path, () => !!window.__home?.tips)
  // A real code is made on the first sign that someone is here (src/landing/main.ts), so give it one.
  await page.mouse.move(400, 300)
  await page.mouse.move(960, 540, { steps: 8 })
  if (!(await hasCode(page, 25_000))) throw new Error('no pairing link in 25 s')
  await sleep(4000)
  const phone = await addPhone(clip)
  await phone.page.locator('.modes [data-tab="rotate"]').click({ timeout: 5000 }).catch(() => {})
  await sleep(2500)
  const tip = () => page.evaluate(() => window.__home.tips().find((t) => t.id !== 'me') ?? null)
  const before = await tip()
  let moved = 0
  for (let i = 0; clip.left() > 2500; i++) {
    await drag(phone, '#pad', ...SWIPES[i % SWIPES.length], { steps: 8, stepMs: 22 })
    await sleep(1300)
    const now = await tip()
    if (before && now) moved = Math.max(moved, Math.hypot(now.x - before.x, now.y - before.y))
  }
  await until(clip, 0)
  return [moved ? `the phone's marble travelled ${moved.toFixed(0)} px` : 'no marble was read for the phone']
})

/** 2. The Viewer: its model on stage, a phone orbiting it with the trackpad. */
const viewer = (seg) => drive(seg, async (clip) => {
  await open(clip, seg.path, () => window.__viewer?.holder.children.length === 1)
  if (!(await hasCode(clip.page, 30_000))) throw new Error('no pairing link in 30 s')
  await sleep(3000)
  const phone = await addPhone(clip)
  await phone.page.locator('.modes [data-tab="rotate"]').click({ timeout: 5000 }).catch(() => {})
  await sleep(1200)
  const ORBIT = [[220, 0], [-220, 0], [0, -150], [0, 150], [-180, -60], [180, 60]]
  for (let i = 0; clip.left() > 3000; i++) {
    await drag(phone, '#pad', ...ORBIT[i % ORBIT.length], { steps: 18, stepMs: 28 })
    await sleep(900)
  }
  await until(clip, 0)
  return ['a phone orbits the model with its trackpad']
})

/** 3. The kinematic humanoid: Keel walks, the six presets, then a phone's stick. */
const humanoid = (seg) => drive(seg, async (clip) => {
  const page = clip.page
  // The page's test hooks (window.__humanoid) are only there on localhost, so readiness is the preset buttons.
  await open(clip, seg.path, () => !!document.querySelector('[data-move="wave"]'))
  if (!(await hasCode(page, 30_000))) throw new Error('no pairing link in 30 s')
  await started(clip)
  await sleep(2500)
  await page.keyboard.down('w')
  await sleep(2200)
  await page.keyboard.up('w')
  await page.keyboard.down('a')
  await sleep(700)
  await page.keyboard.up('a')
  const presets = ['guard', 'jab', 'cross', 'uppercut', 'block', 'wave']
  let played = 0
  for (const name of presets) {
    if (clip.left() < 14_000) break
    await page.locator(`[data-move="${name}"]`).click()
    played++
    await sleep(2000)
  }
  const phone = await addPhone(clip)
  for (let i = 0; clip.left() > 2500; i++) {
    await pushStick(phone, i % 2 ? -34 : 34, -46, Math.min(2200, Math.max(300, clip.left() - 2000)))
    await sleep(500)
  }
  await until(clip, 0)
  return [`keys walked and turned a seat, ${played} presets played, then a phone pushed its stick (the live page does not report the pose back)`]
})

/** 4. The octopus alone: nobody is paired, so after a few seconds it shows itself (src/sim/devices/octopus.ts SHOWCASE_AFTER). */
const octopus = (seg) => drive(seg, async (clip) => {
  await open(clip, seg.path)
  if (!(await hasCode(clip.page, 30_000))) throw new Error('no pairing link in 30 s')
  await started(clip)
  await until(clip, 0)
  return ['autoplay: nobody paired, nothing touched']
})

/** 5. The Link try page with a synthetic gamepad on it: neutral, then the left stick circling. */
const link = (seg) => drive(seg, async (clip) => {
  await clip.ctx.addInitScript(syntheticGamepad)
  await clip.page.goto(`${ORIGIN}${seg.path}`, { waitUntil: 'load', timeout: 40_000 })
  await clip.page.waitForSelector('#link-space', { timeout: 20_000 })
  // Five seconds as a visitor with Link not yet on sees it, then the pad appears and its stick turns, back and forth.
  await clip.page.evaluate(() => window.__synthPad.drive({ after: 5000, radius: 1, turn: 5000 }))
  await until(clip, 0)
  const state = await clip.page.locator('#demo-state').textContent()
  return [`a synthetic gamepad stands in for Link; the page ends on "${(state ?? '').trim().slice(0, 48)}"`]
})

/** 6. The watch link: the screen's Share panel with its QR, and a guest who opens the link and sees Watching. */
const watch = async (seg) => {
  let guest = null
  const host = await openClip(seg, { suffix: '-share', lengthS: opts.seconds + 20 })
  /** Stops sharing, so the record the service keeps holds no link that opens (the room itself ends with its page). */
  const stopSharing = async () => {
    await host.page.evaluate(() => Promise.all(['watch', 'play'].map((k) => window.__obpal.stopSharing(k)))).catch(() => {})
    await sleep(800)
  }
  try {
    await open(host, seg.path)
    if (!(await hasCode(host.page, 30_000))) throw new Error('no pairing link in 30 s')
    await started(host)
    await sleep(2500)
    await host.page.locator('.participant-share').first().click({ timeout: 8000 })
    await host.page.waitForSelector('dialog.share-panel[open] .share-qr svg, dialog.share-panel[open] .share-qr canvas, dialog.share-panel[open] .share-qr img', { timeout: 15_000 })
    await sleep(3500)
    const url = await host.page.evaluate(() => window.__obpal.shortShareUrl('watch'))
    if (!url) throw new Error('the scene offers no watch link')
    guest = await openClip(seg)
    await guest.page.goto(url, { waitUntil: 'load', timeout: 40_000 })
    await guest.page.getByRole('status').filter({ hasText: /Watching/ }).first().waitFor({ timeout: 45_000 })
    await host.page.waitForFunction(() => window.__obpal.participants.some((p) => p.capability === 'watch'), null, { timeout: 30_000 })
    // The panel stays up for a moment with the guest in, then closes; the screen's own count shows while the guest looks on.
    await sleep(2500)
    await host.page.keyboard.press('Escape')
    host.end = guest.end + 1500
    await until(guest, 0)
    await guest.page.screenshot({ path: join(out, `${seg.file}.jpg`), type: 'jpeg', quality: 86 }).catch(() => {})
    const watching = /(\d+) watching/.exec(await host.page.locator('body').innerText().catch(() => ''))?.[1]
    await until(host, 0)
    await stopSharing()
    const saved = [...(await saveClip(guest, seg.file, { poster: false })), ...(await saveClip(host, `${seg.file}-share`, { poster: false }))]
    return { notes: [`a guest on the watch link sees Watching${watching ? `; the screen counts ${watching} watching` : ''}; sharing stopped after`], saved }
  } catch (e) {
    await stopSharing()
    await guest?.ctx.close().catch(() => {})
    await host.ctx.close().catch(() => {})
    throw e
  }
}

// ---- the run -------------------------------------------------------------------------------------------------------
const CLIPS = { home, viewer, humanoid, octopus, link, watch }
console.log(`demo:clips ${ORIGIN}: ${opts.only.join(', ')}, ${opts.seconds} s each`)
const found = await resolveChromium().catch((e) => { console.error(`demo:clips: ${e.message}`); process.exit(2) })
console.log(`  browser: ${found.from} ${shortPath(found.path)}`)
console.log(`  folder: ${out}`)
console.log(`  ob.Pal Desktop log: ${logAtStart ? 'watched' : desktopLog ? 'none here (not installed)' : 'none (not Windows)'}`)

/** The renderer the clips are made with: hardware unless --software; no hardware and no --software is an error, not a quiet fallback. */
let gpu = { hardware: false, renderer: 'SwiftShader (software)', reason: 'asked for' }
let release = null
if (!opts.software) {
  if (!opts.noLease) {
    release = await acquireGpuLease({ mode: 'shared', suite: 'demo-clips', ...(opts.waitMin === null ? {} : { timeoutMs: opts.waitMin * 60_000 }), waiting: () => console.log('  GPU: queued for a shared slot (pnpm run gpu shows the holders)') })
    if (!release) { console.error('demo:clips: the GPU stayed busy past the wait; try again, or --no-lease'); rmSync(scratch, { recursive: true, force: true }); process.exit(2) }
  }
  gpu = await detectE2eGpu(found.path).catch((e) => ({ hardware: false, renderer: '', reason: e.message }))
  if (!gpu.hardware) {
    await release?.()
    rmSync(scratch, { recursive: true, force: true })
    console.error(`demo:clips: no hardware GPU for the browser (${gpu.reason}); --software records with SwiftShader`)
    process.exit(2)
  }
}
console.log(`  renderer: ${gpu.renderer}${opts.noLease || opts.software ? '' : ' (shared GPU slot held)'}\n`)

process.on('SIGINT', () => { void Promise.resolve(browser?.close()).finally(async () => { await release?.(); process.exit(130) }) })
try {
  // WebRtcHideLocalIpsWithMdns off: the emulated phone and the screen share this machine, so they meet on loopback.
  const base = { executablePath: found.path || undefined, headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] }
  browser = await chromium.launch(opts.software
    ? e2eBrowserOptions(base, { OBPAL_E2E_GPU: 'swiftshader' })
    : e2eBrowserOptions(base, { OBPAL_E2E_GPU: '1' }))
  for (const key of opts.only) await segment(bySeg(key), () => CLIPS[key](bySeg(key)))
} catch (e) {
  rows.push({ segment: 'run', file: '', status: 'FAIL', ms: null, bytes: 0, detail: brief(e) })
} finally {
  await browser?.close().catch(() => {})
  await release?.()
  rmSync(scratch, { recursive: true, force: true })
}

// ---- the summary ---------------------------------------------------------------------------------------------------
const markers = found.path && !/ms-playwright/i.test(found.path) ? [found.path] : []
const guard = desktopLog ? guardLine(logAtStart, readLog(), markers) : { reached: [], line: 'ob.Pal Desktop guard: no new sessions (not Windows)' }
const end = verdict(rows)
const size = (n) => (n ? `${(n / 1e6).toFixed(1)} MB` : '')
const table = formatTable(['clip', 'result', 'length', 'size', 'detail'], rows.map((r) => [r.file || r.segment, r.status, clock(r.ms), size(r.bytes), r.detail]))
const report = `${table}\n\n${end.line} in ${((Date.now() - t0) / 1000).toFixed(0)} s${warnings.length ? `\n${warnings.map((w) => `warning: ${w}`).join('\n')}` : ''}\n${guard.line}\n`
console.log(`\n${report}folder: ${out}`)
writeFileSync(join(out, 'clips.json'), JSON.stringify({
  origin: ORIGIN, startedAt: new Date(t0).toISOString(), elapsedMs: Date.now() - t0, seconds: opts.seconds, size: VIEW,
  renderer: gpu.renderer, hardware: gpu.hardware, browser: found.from, verdict: end, guard: guard.reached.length ? guard : 'no new sessions', warnings,
  clips: rows.map(({ file, status, ms, bytes, detail }) => ({ file, status, ms, bytes, detail })),
}, null, 2) + '\n')
if (guard.reached.length) {
  console.error(`\nA TEST BROWSER REACHED THE INSTALLED ob.Pal Desktop. Its log (read only) gained:\n  ${guard.reached.slice(0, 5).map((l) => l.slice(0, 150)).join('\n  ')}`)
  process.exit(3)
}
process.exit(end.ok ? 0 : 1)
