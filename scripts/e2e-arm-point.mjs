/**
 * The robot arm's Point face (the phone's Wii remote) in real Chromium: the mark drawn on the floor is where the arm
 * goes, and where it grabs. A paired emulated phone, held like a remote, holds B and taps A for real. Its calibrated
 * reach (control space: where the phone points, from -1 to 1 each way, fitted to the arm's workspace) is set on the
 * host, since an emulated phone's sensors only carry it part of the way: the middle, each side, the far and near ends
 * of the workspace and its corners. At each, with B held the arm goes over the spot, and then A takes what is under the
 * gripper. A last aim presses A while B is still held and the gripper still on its way, and the claw must come down
 * on the mark, not on the way to it.
 * The mark is read from the drawn dot itself (__arm.aims), the gripper from the tool's world position
 * (__arm.toolPosition), the grab at the moment the claw closes. `pointer` is how far the spot the phone's reach asks for
 * is from the mark: the arm doesn't reach all of its workspace, so the mark is drawn where it does.
 * The kinds are the desk arm (what the arm sim is shown on) and the default five-axis arm.
 *
 * Standalone: OBPAL_E2E_PORT=<port> OBPAL_E2E_WORKER_PORT=<port> node scripts/e2e-arm-point.mjs [--kind desk]
 * The sims suite runs it as the group `arm-point`.
 */
import { chromium, devices } from 'playwright'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { e2eBrowserOptions } from './lib/browser.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 10000, every = 80) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}

/** The phone is held with its back to the screen, 20 degrees below level. */
const HOLD = { alpha: 60, beta: 70 }
/** Where the phone's reach points (control space: across, then forward-back, each from -1 to 1). */
export const AIMS = [
  ['centre', 0, 0],
  ['right', 1, 0],
  ['left', -1, 0],
  ['far', 0, -1],
  ['near', 0, 1],
  ['far right', 1, -1],
  ['far left', -1, -1],
  ['near right', 1, 1],
  ['near left', -1, 1],
]
/** The views: the close-up the sim opens on. The mark of a calibrated reach doesn't depend on the view. */
export const VIEWS = [['close-up', null, AIMS.map(([name]) => name)]]
/** How far the gripper may be from the mark (m): held over it, then closed on a block, then closed with A pressed on the way. */
export const TOLERANCE = { hold: 0.01, grab: 0.02, onTheWay: 0.02 }

const xz = (p) => ({ x: p[0], z: p[2] })
const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/** One kind of arm, one phone: the gap between the mark and the gripper at each aim. */
export async function measureKind(browser, local, kind, views = VIEWS) {
  const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const phone = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
  const errors = []
  try {
    const screen = await host.newPage()
    const page = await phone.newPage()
    screen.on('pageerror', (e) => errors.push(e.message))
    page.on('pageerror', (e) => errors.push(e.message))
    await phone.addInitScript(() => sessionStorage.setItem('obpal.hint.gyro', '1'))
    await screen.goto(`${local.origin}/sim/arm/?kind=${kind}`)
    const invite = await until('invite link', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 25000)
    await until('the arm sim', () => screen.evaluate(() => !!window.__arm?.arms().length), 25000)
    const cdp = await phone.newCDPSession(page)
    // The phone is held like a remote, so it has motion sensors and is in Point; the host keeps its reach where the test puts it, as a phone's samples would.
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: HOLD.alpha, beta: HOLD.beta, gamma: 0 })
    const point = (x, y) => screen.evaluate(([x, y]) => { window.__ctlAim = [x, y] }, [x, y])
    await page.goto(invite)
    await page.locator('.modes').waitFor({ timeout: 25000 })
    const clear = () => page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    await page.locator('.scene-btn').waitFor({ timeout: 15000 })
    await until('asking', () => screen.locator('#people .allow').count(), 8000)
    await screen.locator('#people .allow').first().click()
    await clear()
    await page.locator('.scene-btn').click()
    const cell = page.locator('.pick', { hasText: 'Whole arm' }).first()
    await cell.waitFor({ timeout: 8000 })
    await cell.click()
    await until('the arm held', () => screen.evaluate(() => !!window.__sim.claims.holder('a1')), 8000)
    await clear()
    await page.locator('.modes [data-tab=point]').click()
    await until('the mark', () => screen.evaluate(() => window.__arm.aims().some((a) => a.dot?.visible)), 10000)
    // The phone's calibrated reach, where the test puts it (the host reads it as it would a phone's samples).
    await screen.evaluate(() => { window.__ctlAim = [0, 0]; window.__sim.control.aim = () => ({ aim: window.__ctlAim, tilt: [0, 0], active: true }) })

    const touches = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], i) => ({ x, y, id: i + 1 })) })
    // A coach hint can come up over a button: take it away before a touch, as the other sims checks do.
    const centre = async (selector) => { await clear(); const b = await page.locator(selector).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2] }
    /** The drawn mark, and the spot the phone points at. */
    const mark = () => screen.evaluate(() => { const m = window.__arm.aims().find((a) => a.dot?.visible); return m ? { x: m.dot.x, z: m.dot.z, want: m.want } : null })
    const tool = () => screen.evaluate(() => window.__arm.toolPosition('a1'))
    const arm = () => screen.evaluate(() => { const a = window.__arm.arms().find((x) => x.id === 'a1'); return { claw: a.claw, edge: a.edge, state: a.state } })
    /** Wait for a reading to stop changing (within 1 mm for 400 ms). */
    const quiet = async (read, timeout) => {
      let was = await read(), since = Date.now()
      const end = Date.now() + timeout
      for (;;) {
        await sleep(80)
        const now = await read()
        if (now && was && gap(now, was) < 0.001) { if (Date.now() - since > 400) return now } else since = Date.now()
        was = now
        if (Date.now() > end) return now
      }
    }
    const clearFloor = () => screen.evaluate(() => window.__arm.blocks().forEach((_, i) => window.__arm.placeBlock(i, 3 + i * 0.3, 3)))
    const home = async () => { await screen.evaluate(() => document.getElementById('home-all')?.click()); await sleep(1500) }
    /** The tool's spot when the claw first closes (or has): where it came down. */
    const closing = () => screen.waitForFunction(() => {
      const a = window.__arm.arms().find((x) => x.id === 'a1')
      return a.claw === 'grip' || a.claw === 'up' ? window.__arm.toolPosition('a1') : null
    }, null, { timeout: 15000, polling: 'raf' }).then((h) => h.jsonValue()).catch(() => null)
    const settledMark = async (name) => {
      const m = await quiet(async () => { const v = await mark(); return v && { x: v.x, z: v.z } }, 6000)
      if (!m) throw new Error(`${name}: no mark on the floor`)
      return { ...(await mark()) }
    }

    const rows = []
    for (const [view, , names] of views) {
      for (const [name, x, y] of AIMS.filter(([n]) => names.includes(n))) {
        await clearFloor()
        await point(x, y)
        await clear()
        const first = await settledMark(name)
        // A block under the mark, to take.
        await screen.evaluate(({ x, z }) => window.__arm.placeBlock(0, x, z), first)
        const placed = await settledMark(name)
        const target = { x: placed.x, z: placed.z }
        // B held: the arm goes over the mark.
        await touches('touchStart', [await centre('#wii-b')])
        const there = await quiet(async () => xz(await tool()), 15000)
        const state = await arm()
        await touches('touchEnd', [])
        await sleep(200)
        // A: the claw goes down where the gripper is, and closes.
        await clear()
        await page.locator('#wii-a').click()
        const grab = await closing()
        await until('the claw done', async () => !(await arm()).claw, 12000).catch(() => {})
        const took = await screen.evaluate(() => window.__arm.blocks()[0])
        rows.push({
          name: `${view} ${name}`, mark: target, pointer: placed.want ? gap(placed.want, target) : 0, edge: state.edge,
          hold: gap(there, target), grab: grab ? gap(xz(grab), target) : null, took: took === 'a1',
        })
        await clearFloor()
        await home()
      }
    }

    // A pressed while B is held and the gripper is still on its way: the claw comes down on the mark.
    await clearFloor()
    await home()
    await point(-1, -1)
    await clear()
    const far = await settledMark('on the way')
    await screen.evaluate(({ x, z }) => window.__arm.placeBlock(0, x, z), far)
    const aimed = await settledMark('on the way')
    const target = { x: aimed.x, z: aimed.z }
    await touches('touchStart', [await centre('#wii-b')])
    await sleep(150)
    const farOff = gap(xz(await tool()), target)
    // The mouse presses A (a second finger on the phone's glass doesn't make a tap) while the touch holds B.
    await page.locator('#wii-a').click()
    const grab = await closing()
    await touches('touchEnd', [])
    await until('the claw done', async () => !(await arm()).claw, 15000).catch(() => {})
    const took = await screen.evaluate(() => window.__arm.blocks()[0])
    const onTheWay = { name: 'A pressed on the way', mark: target, away: farOff, grab: grab ? gap(xz(grab), target) : null, took: took === 'a1' }

    if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`)
    return { rows, onTheWay }
  } finally { await host.close(); await phone.close() }
}

const mm = (m) => `${(m * 1000).toFixed(0)} mm`
/** One line per aim, for a check's detail or a failure. */
export const describe = ({ rows, onTheWay }) => [
  ...rows.map((r) => `${r.name} (${r.mark.x.toFixed(2)}, ${r.mark.z.toFixed(2)}): pointer ${mm(r.pointer)} past the mark, ${mm(r.hold)} held${r.grab === null ? ', no grab' : `, ${mm(r.grab)} grabbed`}${r.took ? ', block taken' : ''}`),
  `${onTheWay.name}: gripper ${mm(onTheWay.away)} from the mark when A went down, ${onTheWay.grab === null ? 'no grab' : `${mm(onTheWay.grab)} grabbed`}${onTheWay.took ? ', block taken' : ''}`,
].join('; ')

export async function runArmPoint(local, check, kinds = ['desk', 'arm5']) {
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors'] }))
  try {
    for (const kind of kinds) {
      await check(`robot arm, Point (${kind}): the gripper goes to, and grabs at, the mark drawn on the floor`, async () => {
        const result = await measureKind(browser, local, kind)
        const { rows, onTheWay } = result
        // The aims must move the mark, or every gap is trivially nothing.
        const centre = rows[0].mark
        const spread = Math.max(...rows.map((r) => gap(r.mark, centre)))
        if (spread < 0.3) throw new Error(`the phone's aims barely moved the mark (${(spread * 100).toFixed(0)} cm at most): ${describe(result)}`)
        const held = Math.max(...rows.map((r) => r.hold))
        const grabbed = Math.max(...rows.map((r) => r.grab ?? Infinity))
        const way = onTheWay.grab ?? Infinity
        if (held > TOLERANCE.hold || grabbed > TOLERANCE.grab || way > TOLERANCE.onTheWay) {
          throw new Error(`the gripper strayed from the mark (limits ${mm(TOLERANCE.hold)} held, ${mm(TOLERANCE.grab)} grabbed, ${mm(TOLERANCE.onTheWay)} grabbed on the way): ${describe(result)}`)
        }
        const pulled = rows.filter((r) => r.pointer > 0.01).length
        return `marks spread ${(spread * 100).toFixed(0)} cm; within ${mm(held)} held and ${mm(grabbed)} grabbed at ${rows.length} aims (${pulled} of them past the reach, the mark drawn at its edge), ${mm(way)} grabbed with A pressed ${mm(onTheWay.away)} out; ${describe(result)}`
      })
    }
  } finally { await browser.close() }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  for (const k of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) if (!process.env[k]) throw new Error(`Set ${k}: this run must use its own ports`)
  const { startLocal } = await import('../extension/e2e/local.mjs')
  const local = await startLocal(); let failed = 0, total = 0
  const kinds = process.argv.flatMap((arg, i) => arg === '--kind' && process.argv[i + 1] ? [process.argv[i + 1]] : [])
  try {
    await runArmPoint(local, async (name, fn) => {
      total++
      try { const detail = await fn(); console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`) } catch (e) { failed++; console.log(`  ✗ ${name}: ${e?.message ?? e}`) }
    }, kinds.length ? kinds : undefined)
  } finally { await local.close() }
  console.log(failed ? `FAILED ${failed}/${total}` : `passed ${total}/${total}`); process.exitCode = failed ? 1 : 0
}
