/**
 * The public sims end to end (CATALOGUE §7), served from this checkout's build by the local stand-in
 * (extension/e2e/local.mjs), with emulated phones joining by invite:
 *   Robot arm: approval before a first claim, a joint moved by dragging on the phone's pad (the deadman), stopping when
 *   the finger lifts, an e-stop from a phone that only the screen resumes. Each kind of arm (?kind=) opens with its own
 *   joints, and its arm 1 picks up a block and lifts it.
 *   Arena: two phones claim slots and roll their pucks.
 * Needs Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>. --headed to watch. OBPAL_SHOTS=<dir> saves screens.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { chromium, devices } from 'playwright'
import { cspCheck } from './csp-watch.mjs'
import { runMusic } from './e2e-music.mjs'
import { runVR } from './e2e-vr.mjs'
import { runAudio } from './e2e-audio.mjs'
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

async function screenAt(path, init) {
  const b = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(b)
  const context = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${local.origin}${path}`)
  const invite = await until('invite link', () => page.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
  return { page, invite, errors }
}
async function phone(invite, { xr = true, way = 'motion' } = {}) {
  const dir = await mkdtemp(joinPath(tmpdir(), 'obpal-sim-'))
  profiles.push(dir)
  const ctx = await chromium.launchPersistentContext(dir, { ...devices['Pixel 7'], executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(ctx)
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const cdp = await ctx.newCDPSession(page)
  // A phone held like a remote, top edge toward the screen: Point needs motion sensors.
  await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
  // Which way its 3D follows (settings): the phone's motion, its camera (WebXR) or a glow for the screen's camera.
  await ctx.addInitScript((w) => { try { localStorage.setItem('obpal.track3d', w) } catch { /* private */ } }, way)
  // WebXR as an Android phone with ARCore has it, reporting whatever pose the test sets (window.__fakePose).
  if (xr) await ctx.addInitScript(() => {
    window.__fakePose = { p: [0, 0, 0], q: [0, 0, 0, 1], tracked: true }
    class FakeSession extends EventTarget {
      constructor() { super(); this.renderState = { baseLayer: null } }
      updateRenderState(r) { this.renderState = { ...this.renderState, ...r } }
      async requestReferenceSpace() { return {} }
      requestAnimationFrame(cb) {
        return setTimeout(() => cb(performance.now(), {
          getViewerPose: () => {
            const f = window.__fakePose
            return { transform: { position: { x: f.p[0], y: f.p[1], z: f.p[2] }, orientation: { x: f.q[0], y: f.q[1], z: f.q[2], w: f.q[3] } }, emulatedPosition: !f.tracked }
          },
        }), 16)
      }
      async end() { this.dispatchEvent(new Event('end')) }
    }
    Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported: async (m) => m === 'immersive-ar', requestSession: async () => new FakeSession() } })
    window.XRWebGLLayer = class { constructor() { this.framebuffer = null } }
  })
  await page.goto(invite)
  await page.locator('.modes').waitFor({ timeout: 25000 })
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
  const claim = async (name, nth = 0) => {
    await clear()
    await page.locator('.scene-btn').click()
    const cell = page.locator('.pick', { hasText: name }).nth(nth)
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
  /** Press and hold an on-screen button with a finger (touch), then let go. */
  const hold = async (selector, ms) => {
    await clear()
    const b = await page.locator(selector).boundingBox()
    const at = [b.x + b.width / 2, b.y + b.height / 2]
    await touches('touchStart', [at])
    await sleep(ms)
    await touches('touchEnd', [])
  }
  return { page, cdp, errors, drag, claim, tapTray, hold }
}

try {
  console.log('ob.Pal sims e2e')
  // ---- robot arm ----
  // The screen's camera: a picture the test paints, with a phone glowing in it (window.__fakeCam).
  const arm = await screenAt('/sim/arm/', () => {
    window.__fakeCam = { x: 80, y: 60, r: 9, color: '#000000' }
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 240
    const g = c.getContext('2d')
    const draw = () => {
      const f = window.__fakeCam
      g.fillStyle = '#23211f'
      g.fillRect(0, 0, 320, 240)
      g.fillStyle = f.color
      g.beginPath()
      g.arc(f.x * 2, f.y * 2, f.r * 2, 0, Math.PI * 2)
      g.fill()
    }
    setInterval(draw, 30)
    draw()
    navigator.mediaDevices.getUserMedia = async () => c.captureStream(30)
  })
  const angle = (node) => arm.page.evaluate((n) => window.__arm.arms().flatMap((x) => x.joints).find((j) => j.node === n).angle, node)
  let a
  await check('robot arm: a phone must be let in before its first claim', async () => {
    // This one has no WebXR (an iPhone): its 3D glows for the screen's camera.
    a = await phone(arm.invite, { xr: false, way: 'glow' })
    await until('scene list', () => a.page.locator('.scene-btn').count(), 15000)
    const refused = await a.claim('Shoulder')
    if (!/let you in/.test(refused)) throw new Error(`expected a wait, saw "${refused}"`)
    if (await arm.page.evaluate(() => Object.keys(window.__sim.claims.snapshot()).length)) throw new Error('claimed before approval')
    await arm.page.locator('#people .allow').first().click()
    const ok = await a.claim('Shoulder')
    await until('shoulder held', () => arm.page.evaluate(() => !!window.__sim.claims.holder('a1.shoulder')), 5000)
    return `"${refused}", then "${ok}"`
  })
  await check('robot arm: dragging on the pad (the deadman) moves the joint, and it stops when the finger lifts', async () => {
    const before = await angle('a1.shoulder')
    await a.drag(260)
    await sleep(300)
    const moved = await angle('a1.shoulder')
    if (Math.abs(moved - before) < 2) throw new Error(`shoulder ${before.toFixed(1)}° → ${moved.toFixed(1)}°`)
    await sleep(600)
    const rest = await angle('a1.shoulder')
    await sleep(500)
    const still = await angle('a1.shoulder')
    if (Math.abs(still - rest) > 0.5) throw new Error(`kept moving without the deadman: ${rest.toFixed(1)}° → ${still.toFixed(1)}°`)
    return `${before.toFixed(1)}° → ${moved.toFixed(1)}°, then held at ${still.toFixed(1)}°`
  })
  let b
  await check('robot arm: a second phone takes a whole arm, and dragging swings it (a held joint blocks its arm)', async () => {
    b = await phone(arm.invite, { way: 'xr' })
    await until('scene list', () => b.page.locator('.scene-btn').count(), 15000)
    await until('asking', () => arm.page.locator('#people .allow').count(), 5000)
    await arm.page.locator('#people .allow').first().click()
    const refused = await b.claim('Whole arm', 0)
    if (await arm.page.evaluate(() => window.__sim.claims.holder('a1'))) throw new Error('took Arm 1 while its shoulder was held')
    await b.claim('Whole arm', 1)
    await until('arm 2 held', () => arm.page.evaluate(() => !!window.__sim.claims.holder('a2')), 5000)
    const before = await angle('a2.base')
    await b.drag(260)
    await sleep(400)
    const moved = await angle('a2.base')
    if (Math.abs(moved - before) < 5) throw new Error(`Arm 2's base ${before.toFixed(1)}° → ${moved.toFixed(1)}°`)
    await sleep(700)
    const rest = await angle('a2.base')
    await sleep(400)
    if (Math.abs((await angle('a2.base')) - rest) > 0.5) throw new Error('kept moving without the deadman')
    return `"${refused}"; Arm 2 swung ${before.toFixed(1)}° → ${moved.toFixed(1)}°`
  })
  await check('robot arm, Point: holding B sends the whole arm over the spot the phone points at; A picks up like a claw', async () => {
    await b.page.locator('.modes [data-tab=point]').click()
    await until('pointer on the floor', () => arm.page.evaluate(() => { const t = window.__arm.aims?.() ?? []; return t.some((x) => x.hit) }), 8000)
    const tool = () => arm.page.evaluate(() => window.__arm.arms().find((x) => x.id === 'a2').tool)
    const aimAt = () => arm.page.evaluate(() => window.__arm.aims().find((x) => x.hit)?.hit)
    const before = await tool()
    await b.hold('#wii-b', 2500)
    const after = await tool()
    const spot = await aimAt()
    const moved = Math.hypot(after.reach - before.reach, (after.yaw - before.yaw) / 90, after.height - before.height)
    if (moved < 0.05) throw new Error(`the arm didn't go: ${JSON.stringify({ before, after, spot })}`)
    // The gripper hovers at 20 cm, over the spot.
    if (Math.abs(after.height - 0.2) > 0.05) throw new Error(`hovering at ${after.height.toFixed(2)} m`)
    const grip0 = await angle('a2.gripper')
    await b.page.locator('#wii-a').click()
    await until('claw closed', async () => (await angle('a2.gripper')) < 0.1, 8000)
    await until('claw back up', async () => (await tool()).height > 0.15 && !(await arm.page.evaluate(() => window.__arm.arms().find((x) => x.id === 'a2').claw)), 8000)
    return `tool ${before.reach.toFixed(2)} m → ${after.reach.toFixed(2)} m out, ${after.height.toFixed(2)} m up over (${spot.x.toFixed(2)}, ${spot.z.toFixed(2)}); claw closed from ${grip0.toFixed(2)}`
  })
  await check('robot arm, 3D: with a thumb on the pad, the gripper moves as the tracked phone moves', async () => {
    await b.page.locator('.modes [data-tab=track]').click()
    await b.page.locator('#track-start').click()
    await until('tracking', () => b.page.evaluate(() => document.getElementById('surface').classList.contains('tracking')), 5000).catch(async (e) => {
      throw new Error(`${e.message}: the phone said "${await b.page.evaluate(() => document.getElementById('toast')?.textContent)}", errors ${JSON.stringify(b.errors)}`)
    })
    const tool = () => arm.page.evaluate(() => window.__arm.arms().find((x) => x.id === 'a2').tool)
    const before = await tool()
    // Thumb down, then the hand moves 10 cm up over half a second.
    const box = await b.page.locator('#pad').boundingBox()
    await b.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
    await sleep(300)
    for (let i = 1; i <= 10; i++) { await b.page.evaluate((y) => { window.__fakePose.p = [0, y, 0] }, 0.01 * i); await sleep(50) }
    await sleep(900)
    const up = await tool()
    await b.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    // Thumb up: moving the phone further does nothing.
    await b.page.evaluate(() => { window.__fakePose.p = [0, 0.3, 0] })
    await sleep(600)
    const held = await tool()
    const rise = up.height - before.height
    if (Math.abs(rise - 0.15) > 0.02) throw new Error(`gripper rose ${rise.toFixed(3)} m for a 10 cm hand move (×1.5 expected): ${JSON.stringify({ before, up })}`)
    if (Math.abs(held.height - up.height) > 0.01) throw new Error(`moved without the thumb: ${up.height.toFixed(3)} → ${held.height.toFixed(3)}`)
    return `hand +10 cm → gripper +${(rise * 100).toFixed(1)} cm, then held`
  })
  await check('robot arm, 3D from the phone’s own motion (no camera): swinging the phone swings the gripper', async () => {
    // B switches 3D to its own motion in settings.
    await b.page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
    await b.page.locator('#gear').click()
    await b.page.locator('.track3d [data-way=motion]').click()
    await b.page.locator('#done').click()
    await b.page.locator('.modes [data-tab=track]').click()
    if (await b.page.locator('#track-start').isVisible()) throw new Error('motion 3D shouldn’t need a start')
    const tool = () => arm.page.evaluate(() => window.__arm.arms().find((x) => x.id === 'a2').tool)
    const before = await tool()
    const box = await b.page.locator('#pad').boundingBox()
    await b.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
    await sleep(300)
    // Swing the phone 30° to the left (its heading), in steps.
    for (let i = 1; i <= 10; i++) { await b.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10 + 3 * i, beta: 70, gamma: 0 }); await sleep(50) }
    await sleep(900)
    const after = await tool()
    await b.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await b.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 10, beta: 70, gamma: 0 })
    const swung = Math.abs(after.yaw - before.yaw)
    if (swung < 5) {
      const arm2 = await arm.page.evaluate(() => { const x = window.__arm.arms().find((y) => y.id === 'a2'); return { state: x.state, goal: x.goal } })
      const ph = await b.page.evaluate(() => ({ tab: document.querySelector('.modes [aria-selected=true]')?.dataset.tab, mode: document.getElementById('surface')?.dataset.mode, way: localStorage.getItem('obpal.track3d') }))
      throw new Error(`the gripper didn’t follow: yaw ${before.yaw.toFixed(1)} → ${after.yaw.toFixed(1)}; arm ${JSON.stringify(arm2)}; phone ${JSON.stringify(ph)}`)
    }
    await b.page.locator('.modes [data-tab=rotate]').click()
    return `phone swung 30° → arm swung ${swung.toFixed(1)}°`
  })
  await check('robot arm, camera: a phone without WebXR glows, and the screen’s camera moves the gripper as it moves', async () => {
    await a.claim('Whole arm', 0)
    await until('arm 1 held', () => arm.page.evaluate(() => !!window.__sim.claims.holder('a1')), 5000)
    await a.page.locator('.modes [data-tab=track]').click()
    await a.page.locator('#track-start').click()
    await until('glowing', () => a.page.evaluate(() => document.getElementById('surface').classList.contains('glow')), 4000)
    const color = await arm.page.evaluate(() => window.__obpal.participants.find((p) => p.id === window.__sim.claims.holder('a1')).color)
    await arm.page.evaluate((c) => { window.__fakeCam.color = c }, color)
    await arm.page.locator('#glow-cam').click()
    await until('glow seen', () => arm.page.evaluate(() => document.getElementById('glow-cam').getAttribute('aria-pressed') === 'true'), 4000)
    const tool = () => arm.page.evaluate(() => window.__arm.arms().find((x) => x.id === 'a1').tool)
    const before = await tool()
    // Thumb down on the glowing screen, then the phone rises in the picture (the person lifts it).
    const box = await a.page.locator('#pad').boundingBox()
    await a.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] })
    await sleep(300)
    for (let i = 1; i <= 10; i++) { await arm.page.evaluate((y) => { window.__fakeCam.y = y }, 60 - 2 * i); await sleep(60) }
    await sleep(1000)
    const after = await tool()
    await a.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    const rise = after.height - before.height
    if (rise < 0.05) throw new Error(`gripper rose ${rise.toFixed(3)} m: ${JSON.stringify({ before, after })}`)
    if (!(await a.page.locator('#glow-stop').isVisible())) throw new Error('no Stop on the glowing screen')
    await a.page.locator('#glow-end').click()
    return `glow rose 20 px in the picture → gripper +${(rise * 100).toFixed(1)} cm; Stop stays on the glowing screen`
  })
  await check('robot arm: a phone e-stops every joint, and only the screen resumes', async () => {
    // A holds the whole Arm 1 now: back to Rotate, where a drag swings it.
    await a.page.locator('.modes [data-tab=rotate]').click()
    await a.tapTray('Stop')
    await until('stopped', () => arm.page.evaluate(() => !!window.__arm.stopped()), 5000)
    const banner = await arm.page.locator('#stop-by').textContent()
    const before = await angle('a1.base')
    await a.drag(260)
    await sleep(400)
    if (Math.abs((await angle('a1.base')) - before) > 0.5) throw new Error('moved while stopped')
    if (SHOTS) await arm.page.screenshot({ path: joinPath(SHOTS, 'sim-arm-stopped.png') })
    await arm.page.locator('#resume').click()
    await until('resumed', () => arm.page.evaluate(() => !window.__arm.stopped()), 3000)
    await a.drag(-260)
    await sleep(300)
    if (Math.abs((await angle('a1.base')) - before) < 2) throw new Error('did not move after resuming')
    if (SHOTS) await arm.page.screenshot({ path: joinPath(SHOTS, 'sim-arm.png') })
    return banner
  })
  if (arm.errors.length) console.log(`  page errors: ${arm.errors.join(' | ')}`)
  await check('robot arm kinds: each opens with its own joints, and its arm 1 picks up a block and lifts it', async () => {
    const b = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
    closers.push(b)
    const context = await b.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const done = []
    for (const kind of ['arm5', 'so101', 'six', 'scara', 'delta', 'desk']) {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`${local.origin}/sim/arm/?kind=${kind}`)
      await until(`${kind}: the sim`, () => page.evaluate(() => !!window.__arm?.kind), 15000)
      const { id, keys } = await page.evaluate(() => window.__arm.kind())
      const joints = await page.evaluate(() => window.__arm.arms()[0].joints.map((j) => j.node))
      if (id !== kind || joints.length !== keys.length + 1) throw new Error(`${kind}: opened ${id} with ${joints.join(', ')}`)
      // A block in front of arm 1, halfway to the middle; the gripper over it, straight down, closed, up.
      const at = await page.evaluate(() => { const s = window.__arm.stand('a1'); return { x: s.x * 0.5, z: s.z * 0.5 } })
      await page.evaluate(({ x, z }) => window.__arm.placeBlock(0, x, z, 25), at)
      const go = async (h, open, ms) => {
        const pose = await page.evaluate(({ x, z, h }) => window.__arm.solve('a1', x, z, h), { ...at, h })
        if (!pose) throw new Error(`${kind}: can't reach ${h.toFixed(3)} m over (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`)
        await page.evaluate(({ pose, open }) => window.__arm.goTo('a1', pose, open), { pose, open })
        await sleep(ms)
      }
      await go(0.22, 1, 2500)
      for (let h = 0.2; h >= 0.035; h -= 0.015) await go(h, 1, 150)
      await go(0.035, 1, 600)
      await go(0.035, 0, 1500)
      const by = await page.evaluate(() => window.__arm.blocks()[0])
      if (by !== 'a1') throw new Error(`${kind}: the gripper closed without taking the block (${JSON.stringify(await page.evaluate(() => window.__arm.block(0)))})`)
      for (let h = 0.05; h <= 0.25; h += 0.03) await go(h, 0, 120)
      await sleep(1200)
      const y = await page.evaluate(() => window.__arm.block(0).y)
      if (y < 0.15) throw new Error(`${kind}: the block only rose to ${y.toFixed(3)} m`)
      if (errors.length) throw new Error(`${kind}: ${errors.join(' | ')}`)
      if (SHOTS) await page.screenshot({ path: joinPath(SHOTS, `sim-arm-${kind}.png`) })
      done.push(`${kind} ${Math.round(y * 100)} cm`)
      await page.close()
    }
    return done.join(', ')
  })

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

  // ---- the pairing chip beside the panel, on phones ----
  await check('on phones the pairing card fits between the top bar and the panel, a short phone too, and folds while the people list is open', async () => {
    const b = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
    closers.push(b)
    const out = []
    for (const [w, h] of [[412, 915], [390, 844], [360, 640]]) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true })
      const page = await ctx.newPage()
      await page.goto(`${local.origin}/sim/arm/`)
      await until('the chip', () => page.evaluate(() => !!document.querySelector('.obpal-chip')?.shadowRoot?.querySelector('.qr svg')), 20000)
      const open = () => page.evaluate(() => document.querySelector('.obpal-chip').shadowRoot.querySelector('.pill').getAttribute('aria-expanded') === 'true')
      await until('the card open', open, 5000)
      await sleep(400)
      const g = await page.evaluate(() => {
        const r = (el) => el.getBoundingClientRect()
        const root = document.querySelector('.obpal-chip').shadowRoot
        return { card: r(root.querySelector('.card')), pill: r(root.querySelector('.pill')), panel: r(document.querySelector('.sim-panel')), bar: r(document.querySelector('.sim-top')).bottom }
      })
      const at = `${w}×${h}`
      if (g.card.top < g.bar) throw new Error(`${at}: the card reaches ${Math.round(g.card.top)}px, under the top bar (to ${Math.round(g.bar)}px)`)
      if (g.card.bottom > g.pill.top || g.pill.bottom > g.panel.top) throw new Error(`${at}: card to ${Math.round(g.card.bottom)}, chip ${Math.round(g.pill.top)}–${Math.round(g.pill.bottom)}, panel from ${Math.round(g.panel.top)}`)
      await page.evaluate(() => { document.getElementById('people').hidden = false })
      await until(`${at}: the card folded for the people list`, async () => !(await open()), 3000)
      await page.evaluate(() => { document.getElementById('people').hidden = true })
      await until(`${at}: the card back`, open, 3000)
      if (SHOTS) await page.screenshot({ path: joinPath(SHOTS, `sim-arm-chip-${w}x${h}.png`) })
      out.push(`${at}: card ${Math.round(g.card.top)}–${Math.round(g.card.bottom)}, panel from ${Math.round(g.panel.top)}`)
      await ctx.close()
    }
    return out.join('; ')
  })

  // Finished arm and arena sessions must not compete with the studio's eight-phone timing measurement.
  await Promise.all(closers.map(c => c.close()))
  closers.length = 0
  await runMusic(local, check)
  await runVR(local, check)
  await runAudio(local, check)
  await check('no Content Security Policy violations on any page', cspCheck)
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
