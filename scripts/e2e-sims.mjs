/**
 * The public sims end to end (CATALOGUE §7), served from this checkout's build by the local stand-in
 * (extension/e2e/local.mjs), with emulated phones joining by invite:
 *   Robot arm: approval before a first claim, a joint moved by dragging on the phone's pad (the deadman), stopping when
 *   the finger lifts, an e-stop from a phone that only the screen resumes.
 *   Arena: two phones claim slots and roll their pucks.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch. OBPAL_SHOTS=<dir> saves screens.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, devices } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

const HEADED = process.argv.includes('--headed')
const SHOTS = process.env.OBPAL_SHOTS || ''
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
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

const local = await startLocal()
const closers = []
const profiles = []
let exitCode = 0

async function screenAt(path) {
  const b = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(b)
  const page = await (await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${local.origin}${path}`)
  const invite = await until('invite link', () => page.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
  return { page, invite, errors }
}
async function phone(invite) {
  const dir = await mkdtemp(joinPath(tmpdir(), 'obpal-sim-'))
  profiles.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(ctx)
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(invite)
  await page.locator('.modes').waitFor({ timeout: 25000 })
  const cdp = await ctx.newCDPSession(page)
  const touches = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) })
  const clear = () => page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  /** Hold a finger on the trackpad and drag it right by `dx` px over `steps` moves. */
  const drag = async (dx, steps = 20) => {
    await clear()
    const b = await page.locator('#pad').boundingBox()
    const x = b.x + b.width / 2 - dx / 2
    const y = b.y + b.height / 2
    await touches('touchStart', [[x, y]])
    for (let i = 1; i <= steps; i++) { await touches('touchMove', [[x + (dx * i) / steps, y]]); await sleep(20) }
    await touches('touchEnd', [])
  }
  const claim = async (name) => {
    await clear()
    await page.locator('.scene-btn').click()
    const cell = page.locator('.pick', { hasText: name }).first()
    await cell.waitFor({ timeout: 6000 })
    await cell.click()
    await sleep(500)
    return page.evaluate(() => document.getElementById('toast')?.textContent ?? '')
  }
  const tapTray = async (label) => {
    await clear()
    const b = page.locator(`.tray-btn[aria-label="${label}"]`)
    if (!(await b.count())) throw new Error(`no "${label}" in the tray: ${JSON.stringify(await page.locator('.tray-btn').evaluateAll((l) => l.map((x) => x.getAttribute('aria-label'))))}`)
    await b.click({ timeout: 5000 })
  }
  return { page, drag, claim, tapTray }
}

try {
  console.log('ob.Pal sims e2e')
  // ---- robot arm ----
  const arm = await screenAt('/sim/arm/')
  const angle = (id) => arm.page.evaluate((j) => window.__arm.joints.find((x) => x.id === j).angle, id)
  let a
  await check('robot arm: a phone must be let in before its first claim', async () => {
    a = await phone(arm.invite)
    await until('scene list', () => a.page.locator('.scene-btn').count(), 15000)
    const refused = await a.claim('Shoulder')
    if (!/let you in/.test(refused)) throw new Error(`expected a wait, saw "${refused}"`)
    if (await arm.page.evaluate(() => Object.keys(window.__sim.claims.snapshot()).length)) throw new Error('claimed before approval')
    await arm.page.locator('#people .allow').first().click()
    const ok = await a.claim('Shoulder')
    await until('shoulder held', () => arm.page.evaluate(() => !!window.__sim.claims.holder('shoulder')), 5000)
    return `"${refused}", then "${ok}"`
  })
  await check('robot arm: dragging on the pad (the deadman) moves the joint, and it stops when the finger lifts', async () => {
    const before = await angle('shoulder')
    await a.drag(260)
    await sleep(300)
    const moved = await angle('shoulder')
    if (Math.abs(moved - before) < 2) throw new Error(`shoulder ${before.toFixed(1)}° → ${moved.toFixed(1)}°`)
    await sleep(600)
    const rest = await angle('shoulder')
    await sleep(500)
    const still = await angle('shoulder')
    if (Math.abs(still - rest) > 0.5) throw new Error(`kept moving without the deadman: ${rest.toFixed(1)}° → ${still.toFixed(1)}°`)
    return `${before.toFixed(1)}° → ${moved.toFixed(1)}°, then held at ${still.toFixed(1)}°`
  })
  await check('robot arm: a phone e-stops every joint, and only the screen resumes', async () => {
    await a.tapTray('Stop')
    await until('stopped', () => arm.page.evaluate(() => !!window.__arm.stopped()), 5000)
    const banner = await arm.page.locator('#stop-by').textContent()
    const before = await angle('shoulder')
    await a.drag(260)
    await sleep(400)
    if (Math.abs((await angle('shoulder')) - before) > 0.5) throw new Error('moved while stopped')
    if (SHOTS) await arm.page.screenshot({ path: joinPath(SHOTS, 'sim-arm-stopped.png') })
    await arm.page.locator('#resume').click()
    await until('resumed', () => arm.page.evaluate(() => !window.__arm.stopped()), 3000)
    await a.drag(-260)
    await sleep(300)
    if (Math.abs((await angle('shoulder')) - before) < 2) throw new Error('did not move after resuming')
    if (SHOTS) await arm.page.screenshot({ path: joinPath(SHOTS, 'sim-arm.png') })
    return banner
  })
  if (arm.errors.length) console.log(`  page errors: ${arm.errors.join(' | ')}`)

  // ---- arena ----
  const arena = await screenAt('/sim/arena/')
  await check('arena: two phones take a slot each and roll their pucks', async () => {
    const p1 = await phone(arena.invite)
    const p2 = await phone(arena.invite)
    await until('scene lists', async () => (await p1.page.locator('.scene-btn').count()) && (await p2.page.locator('.scene-btn').count()), 15000)
    await p1.claim('Player 1')
    await p2.claim('Player 2')
    const refused = await p2.claim('Player 1')
    const held = await arena.page.evaluate(() => window.__sim.claims.snapshot())
    if (Object.keys(held).length !== 2) throw new Error(`held ${JSON.stringify(held)}`)
    const pos = () => arena.page.evaluate(() => { const s = window.__arena.slots[0]; return [s.pos.x, s.pos.y] })
    const before = await pos()
    await p1.drag(240)
    await sleep(500)
    const after = await pos()
    const moved = Math.hypot(after[0] - before[0], after[1] - before[1])
    if (moved < 0.05) throw new Error(`puck moved ${moved.toFixed(3)}`)
    if (SHOTS) await arena.page.screenshot({ path: joinPath(SHOTS, 'sim-arena.png') })
    return `P2 was told "${refused}"; P1 rolled ${moved.toFixed(2)} m`
  })
  if (arena.errors.length) console.log(`  page errors: ${arena.errors.join(' | ')}`)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await Promise.allSettled(closers.map((c) => c.close()))
  await local.close()
  await Promise.allSettled(profiles.map((d) => rm(d, { recursive: true, force: true })))
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `FAILED ${failed.length}/${results.length}` : `passed ${results.length}/${results.length}`)
process.exit(failed.length || exitCode ? 1 : 0)
