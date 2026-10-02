/**
 * The node strip (PROTOCOL §3a, src/controller/strip.ts), for e2e:sims: on an arm and on the excavator, a phone's
 * finger drags on the trackpad while a second finger taps another part on the strip. What was moving holds where it
 * got to, the new part starts from where it was (no jump), and the same finger, never lifted, carries straight on with
 * it. The screen shows the switch on the model too. Joint values are read from the screen every frame.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { e2eBrowserOptions } from './lib/browser.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 15000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(100)
  }
}

/** On the screen: every frame, the arm's joints or the excavator's, until stopped. */
function record(kind) {
  const read = kind === 'arm'
    ? () => Object.fromEntries(window.__arm.arms()[0].joints.map((j) => [j.node, j.angle]))
    : () => { const u = window.__device.logic.units[0]; return { swing: u.swing, boom: u.boom, stick: u.stick, curl: u.curl } }
  window.__rec = []
  window.__recOn = true
  const tick = () => { window.__rec.push(read()); if (window.__recOn) requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
}

/**
 * Drag one finger up the pad in `steps` moves; after `before` of them, a second finger taps the strip's `to` item and
 * lifts, and the first carries on. Returns the screen's frames, split at the tap, and whether the pad stayed held.
 */
async function dragSwitching(p, screen, kind, to, { steps = 40, before = 18, dy = 8 } = {}) {
  const touch = (type, pts) => p.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) })
  const pad = await p.page.locator('#pad').boundingBox()
  const item = await p.page.locator(`.ns-item[data-part="${to}"]`).boundingBox()
  const x = pad.x + pad.width * 0.35
  let y = pad.y + pad.height * 0.78
  await screen.evaluate(record, kind)
  await touch('touchStart', [[x, y, 1]])
  let at = 0
  let held = true
  for (let i = 0; i < steps; i++) {
    if (i === before) {
      at = await screen.evaluate(() => window.__rec.length)
      await touch('touchStart', [[x, y, 1], [item.x + item.width / 2, item.y + item.height / 2, 2]])
      await sleep(30)
      await touch('touchEnd', [[item.x + item.width / 2, item.y + item.height / 2, 2]])
    }
    y -= dy
    await touch('touchMove', [[x, y, 1]])
    await sleep(34)
    held &&= await p.page.evaluate(() => document.getElementById('pad').classList.contains('active'))
  }
  await touch('touchEnd', [])
  await sleep(300)
  const frames = await screen.evaluate(() => { window.__recOn = false; return window.__rec })
  return { frames, at, held }
}

/**
 * Read the two parts' tracks around the switch (the first frame after the tap where `b` moves): `a` moved before it,
 * then eases to a stop without going back; `b` held before it, then starts from where it was with a step no bigger
 * than the drag's own, and goes on the one way the finger does. So nothing jumps, and the finger carried on.
 */
function judge(frames, at, a, b, unit) {
  const deg = unit === '°'
  const eps = deg ? 0.02 : 0.0005
  const v = (i, k) => frames[i][k]
  let s = Math.max(1, at)
  while (s < frames.length - 1 && Math.abs(v(s + 1, b) - v(s, b)) <= eps) s++
  const steps = (from, to, k) => frames.slice(from + 1, to + 1).map((f, i) => f[k] - frames[from + i][k])
  const aNet = v(at, a) - v(0, a), bBefore = v(s, b) - v(0, b), bNet = v(frames.length - 1, b) - v(s, b)
  const drag = Math.max(0, ...steps(0, at, a).map(Math.abs))
  const first = Math.abs(v(Math.min(s + 1, frames.length - 1), b) - v(s, b))
  const settled = Math.min(frames.length - 1, s + 12)
  const aAfter = Math.abs(v(frames.length - 1, a) - v(settled, a))
  const back = steps(at, frames.length - 1, a).filter((d) => Math.sign(d) === -Math.sign(aNet) && Math.abs(d) > eps)
  const wrong = steps(s, frames.length - 1, b).filter((d) => Math.sign(d) === -Math.sign(bNet) && Math.abs(d) > eps)
  const say = (x) => `${x.toFixed(deg ? 2 : 3)}${unit}`
  const problems = []
  if (Math.abs(aNet) < (deg ? 1 : 0.05)) problems.push(`${a} moved only ${say(Math.abs(aNet))} before the switch`)
  if (Math.abs(bBefore) > (deg ? 0.2 : 0.003)) problems.push(`${b} moved ${say(Math.abs(bBefore))} before it was chosen`)
  if (Math.abs(bNet) < (deg ? 1 : 0.05)) problems.push(`${b} moved only ${say(Math.abs(bNet))} after the switch: the finger didn’t carry on`)
  if (aAfter > (deg ? 0.5 : 0.01)) problems.push(`${a} kept moving ${say(aAfter)} after the switch`)
  if (back.length) problems.push(`${a} went back ${say(Math.max(...back.map(Math.abs)))} after the switch`)
  if (first > drag * 1.5 + eps) problems.push(`${b} jumped ${say(first)} as it was chosen (a drag frame moved ${a} at most ${say(drag)})`)
  if (wrong.length) problems.push(`${b} moved against the finger ${say(Math.max(...wrong.map(Math.abs)))}`)
  return { problems, text: `${a} ${say(Math.abs(aNet))} then held; ${b} started from where it was (first step ${say(first)}, drag steps ≤ ${say(drag)}) and went on ${say(Math.abs(bNet))} with the same finger` }
}

export async function simsStrip({ origin, check, executablePath, headed = false, shots = '' }) {
  const args = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: !headed, args }))
  const dirs = []
  const contexts = []
  const errors = []
  /** A screen at `path`, and a phone that joins it (Pixel 7, persistent like a real one). */
  const pair = async (path) => {
    const sc = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    contexts.push(sc)
    const screen = await sc.newPage()
    screen.on('pageerror', (e) => errors.push(`screen: ${e.message}`))
    await screen.goto(`${origin}${path}`)
    const invite = await until('invite', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''), 20000)
    const dir = await mkdtemp(join(tmpdir(), 'obpal-strip-'))
    dirs.push(dir)
    const ctx = await chromium.launchPersistentContext(dir, e2eBrowserOptions({ ...devices['Pixel 7'], executablePath, headless: !headed, args }))
    contexts.push(ctx)
    await ctx.addInitScript(() => { for (const k of ['gyro', 'models', 'more', 'point', 'lock', 'track', 'level', 'hold-part']) try { sessionStorage.setItem(`obpal.hint.${k}`, '1') } catch { /* private */ } })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    page.on('pageerror', (e) => errors.push(`phone: ${e.message}`))
    const cdp = await ctx.newCDPSession(page)
    await page.goto(invite)
    await page.locator('.modes').waitFor({ state: 'attached', timeout: 25000 })
    await page.waitForFunction(() => document.body.classList.contains('live'), null, { timeout: 25000 })
    return { screen, page, cdp }
  }
  /** The phone on its trackpad (from the catalogue when it opened on another controller), its strip up. */
  const trackpad = async (p) => {
    await sleep(600)
    if (!(await p.page.locator('.modes').isVisible())) {
      await p.page.locator('.gp:not([hidden]) [data-act=controllers]').click()
      await p.page.locator('.ctl-card[data-c="face.trackpad"]').click()
    } else if (await p.page.locator('[data-tab="rotate"][aria-selected="false"]').count()) await p.page.locator('[data-tab="rotate"]').click()
    await p.page.locator('#nstrip:not([hidden])').waitFor({ timeout: 8000 })
    await p.page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
  }
  try {
    const arm = await pair('/sim/arm/')
    await check('robot arm, node strip: one icon for the whole arm, its sets and each joint; switching joints mid-drag never jumps, and the same finger carries on', async () => {
      await until('asking to be let in', () => arm.screen.locator('#people .allow').count(), 10000)
      await arm.screen.locator('#people .allow').first().click()
      await arm.page.locator('.scene-btn').click()
      await arm.page.locator('.pick', { hasText: 'Whole arm' }).first().click()
      await until('Arm 1 held', () => arm.screen.evaluate(() => !!window.__sim.claims.holder('a1')))
      await trackpad(arm)
      const items = await arm.page.locator('.ns-item').evaluateAll((l) => l.map((b) => `${b.dataset.kind}:${b.dataset.part}`))
      const want = ['whole:', 'set:reach', 'set:wrist', 'part:a1.base', 'part:a1.shoulder', 'part:a1.elbow', 'part:a1.wrist', 'part:a1.roll', 'part:a1.gripper']
      if (items.join() !== want.join()) throw new Error(`strip ${items.join(' ')}`)
      await arm.page.locator('.ns-item[data-part="a1.shoulder"]').click()
      await until('the shoulder chosen', () => arm.screen.evaluate(() => window.__arm.focus('a1')?.part === 'a1.shoulder'))
      const { frames, at, held } = await dragSwitching(arm, arm.screen, 'arm', 'a1.elbow')
      if (!held) throw new Error('the finger on the pad was lifted by the tap on the strip')
      const now = await arm.screen.evaluate(() => window.__arm.focus('a1'))
      if (now?.part !== 'a1.elbow') throw new Error(`after the tap the arm drives ${now?.part || 'the whole arm'}`)
      const j = judge(frames, at, 'a1.shoulder', 'a1.elbow', '°')
      if (shots) { await arm.page.screenshot({ path: join(shots, 'strip-arm-phone.png') }); await arm.screen.screenshot({ path: join(shots, 'strip-arm-screen.png') }) }
      if (j.problems.length) throw new Error(j.problems.join('; '))
      // A set: Reach drives base, shoulder and elbow; the wrist holds, locked, and says so on the strip.
      await arm.page.locator('.ns-item[data-part="reach"]').click()
      await until('Reach chosen', () => arm.screen.evaluate(() => window.__arm.focus('a1')?.part === 'reach'))
      const f = await arm.screen.evaluate(() => window.__arm.focus('a1'))
      const locked = await arm.page.locator('.ns-item.held').evaluateAll((l) => l.map((b) => b.dataset.part))
      if (f.parts.join() !== 'a1.base,a1.shoulder,a1.elbow' || !locked.includes('a1.wrist')) throw new Error(`Reach: ${JSON.stringify(f)} locked on the strip ${locked}`)
      return `${frames.length} frames: ${j.text}; Reach drives ${f.parts.length} joints, ${locked.length} locked`
    })
    await check('robot arm, node strip: a long press locks a joint (a lock on its icon), and the whole arm’s drive leaves it where it is', async () => {
      const b = await arm.page.locator('.ns-item[data-part="a1.shoulder"]').boundingBox()
      const at = { x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }
      await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] })
      await sleep(650)
      await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await until('the shoulder locked', () => arm.screen.evaluate(() => window.__arm.focus('a1')?.locks.includes('a1.shoulder')))
      if (!(await arm.page.locator('.ns-item[data-part="a1.shoulder"].held .ns-lock').isVisible())) throw new Error('no lock on the shoulder’s icon')
      await arm.page.locator('.ns-item[data-part=""]').click()
      await until('the whole arm chosen', () => arm.screen.evaluate(() => window.__arm.focus('a1')?.part === ''))
      const before = await arm.screen.evaluate(() => window.__arm.arms()[0].joints.map((j) => j.angle))
      const pad = await arm.page.locator('#pad').boundingBox()
      const x = pad.x + pad.width * 0.3, y = pad.y + pad.height * 0.6
      await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      for (let i = 1; i <= 16; i++) { await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 9, y: y - i * 6, id: 1 }] }); await sleep(30) }
      await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(400)
      const after = await arm.screen.evaluate(() => window.__arm.arms()[0].joints.map((j) => j.angle))
      const moved = after.map((v, i) => Math.abs(v - before[i]))
      if (moved[1] > 0.3) throw new Error(`the locked shoulder moved ${moved[1].toFixed(1)}°`)
      if (Math.max(moved[0], moved[2], moved[3]) < 1) throw new Error(`the rest of the arm didn’t move: ${moved.map((m) => m.toFixed(1))}`)
      return `the shoulder held (${moved[1].toFixed(2)}°) while the base, elbow and wrist moved ${[0, 2, 3].map((i) => `${moved[i].toFixed(1)}°`).join(', ')}`
    })
    await check('robot arm, node strip: a drag begun on the strip and run in across the pad picks nothing, and drives the arm', async () => {
      const was = await arm.screen.evaluate(() => ({ part: window.__arm.focus('a1')?.part, angles: window.__arm.arms()[0].joints.map((j) => j.angle) }))
      const b = await arm.page.locator('.ns-item[data-part="a1.elbow"]').boundingBox()
      const x = b.x + b.width / 2, y = b.y + b.height / 2
      await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
      for (let i = 1; i <= 16; i++) { await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * 14, y, id: 1 }] }); await sleep(30) }
      await arm.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await sleep(400)
      const now = await arm.screen.evaluate(() => ({ part: window.__arm.focus('a1')?.part, angles: window.__arm.arms()[0].joints.map((j) => j.angle) }))
      if (now.part !== was.part) throw new Error(`the drag picked ${now.part || 'the whole arm'} on the strip`)
      // A drag the pad let go of part way (the strip's capture ending its hold) moves it barely at all.
      const moved = Math.max(...now.angles.map((v, i) => Math.abs(v - was.angles[i])))
      if (moved < 3) throw new Error(`the arm moved only ${moved.toFixed(2)}°: the drag didn’t carry on across the pad`)
      return `still ${was.part || 'the whole arm'}; a joint moved ${moved.toFixed(1)}°`
    })

    const dig = await pair('/sim/device/?d=excavator')
    await check('excavator, node strip: switching from the boom to the stick mid-drag never jumps, the same finger carries on, and the stick lights on the model', async () => {
      await until('the excavator held', () => dig.screen.evaluate(() => !!window.__sim.claims.holder('excavator1')))
      await trackpad(dig)
      const items = await dig.page.locator('.ns-item').evaluateAll((l) => l.map((b) => `${b.dataset.kind}:${b.dataset.part}`))
      if (items.join() !== 'whole:,set:reach,set:dig,part:swing,part:boom,part:stick,part:bucket') throw new Error(`strip ${items.join(' ')}`)
      await dig.page.locator('.ns-item[data-part="boom"]').click()
      await until('the boom chosen', () => dig.screen.evaluate(() => window.__device.focus(0)?.part === 'boom'))
      const { frames, at, held } = await dragSwitching(dig, dig.screen, 'excavator', 'stick')
      if (!held) throw new Error('the finger on the pad was lifted by the tap on the strip')
      const j = judge(frames, at, 'boom', 'stick', ' rad')
      const halos = await dig.screen.evaluate(() => window.__device.halos())
      if (shots) { await dig.page.screenshot({ path: join(shots, 'strip-excavator-phone.png') }); await dig.screen.screenshot({ path: join(shots, 'strip-excavator-screen.png') }) }
      if (j.problems.length) throw new Error(j.problems.join('; '))
      if (halos.join() !== '0:stick') throw new Error(`the model shows ${halos.join() || 'nothing'} live`)
      if (errors.length) throw new Error(errors.join(' | '))
      return `${frames.length} frames: ${j.text}; ringed on the model: ${halos}`
    })
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()))
    await browser.close()
    await Promise.allSettled(dirs.map((d) => rm(d, { recursive: true, force: true })))
  }
}
