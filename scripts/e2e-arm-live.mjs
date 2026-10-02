/**
 * The robot arm's live path in real Chromium, with no hardware: an in-page fake ArmDriver goes in through
 * __arm.connectWith and stands for the arm on the bench. Going live is refused for a joint that is unreported or out
 * of its limits, Stop holds the arm and reaches the driver, every automatic stop says why, and approval can't be
 * switched off while an arm is live. Standalone: OBPAL_E2E_PORT=<port> OBPAL_E2E_WORKER_PORT=<port> node scripts/e2e-arm-live.mjs
 */
import { chromium } from 'playwright'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { e2eBrowserOptions } from './lib/browser.mjs'

const assert = (ok, message) => { if (!ok) throw new Error(message) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const panel = (page, id) => page.locator(`.sim-window[data-panel="${id}"]`)
const near = (a, b, tolerance) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

/**
 * Runs in the page. A driver that behaves like the ob.Pal serial sketch on a bench: it reports where its joints are,
 * follows the last goal it was sent at `rate` degrees a second (0 is an arm that can't move), and on hold() stops where
 * it is, as the sketch's S does. A null in `pos` is a joint that hasn't reported. Every call the page makes on it lands
 * in `events`, in order, so a goal sent after a hold shows.
 */
function installFake(opts) {
  const start = opts.pos ?? [0, 18, 72, 62, 0, 1]
  const f = { pos: [...start], goal: start.map(v => v ?? 0), rate: opts.rate ?? 100, silent: false, reportAt: performance.now(), events: [] }
  const log = (kind, more) => f.events.push({ kind, t: performance.now(), ...more })
  let last = performance.now()
  f.timer = setInterval(() => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000)
    last = now
    f.pos.forEach((v, i) => {
      if (v === null) return
      const step = (i < 5 ? f.rate : f.rate / 50) * dt, e = f.goal[i] - v
      f.pos[i] = Math.abs(e) <= step ? f.goal[i] : v + Math.sign(e) * step
    })
  }, 20)
  /** Stop reporting: what the page reads from now on is as old as this moment. */
  f.setSilent = on => { f.silent = on; f.reportAt = performance.now() }
  f.driver = {
    kind: 'serial',
    label: 'the test arm',
    feedback: 'measured',
    async connect() { log('connect') },
    read: () => ({ raw: [...f.pos], at: f.silent ? f.reportAt : performance.now() }),
    send(raw) { log('send', { raw: [...raw] }); raw.forEach((v, i) => { f.goal[i] = v }) },
    async torque(on) { log('torque', { on }); await new Promise(r => setTimeout(r, 30)) },
    async hold() { log('hold', { pos: [...f.pos] }); f.goal = f.pos.map((v, i) => v ?? f.goal[i]) },
    async close() { log('close'); clearInterval(f.timer) },
  }
  window.__fake = f
}

/** A fresh page on the arm sim with the fake attached to Arm 1, for `run`; page errors fail the run. */
async function withArm(browser, local, opts, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const errors = []
  try {
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(local.origin + '/sim/arm/')
    // The arm cards are drawn once the scene is up and paired; the pairing card folds so it never covers a control.
    await page.waitForFunction(() => !!window.__obpal?.pairingUrl && !!window.__arm && !!document.querySelector('[data-arm="a1"]'), null, { timeout: 25000 })
    const chip = page.locator('.obpal-chip .pill[aria-expanded="true"]')
    if (await chip.count()) await chip.click()
    await settle(page)
    await page.evaluate(installFake, opts)
    assert(await page.evaluate(() => window.__arm.connectWith('a1', window.__fake.driver)), 'the fake driver was not attached to Arm 1')
    const detail = await run(page)
    assert(!errors.length, `page errors: ${errors.join(' | ')}`)
    return detail
  } finally { await context.close() }
}

/** Arm 1's settings, open: its window, then the ⋯ tools. */
async function openTools(page) {
  if (!(await panel(page, 'arm-a1').isVisible())) { const b = page.locator('[data-panel-toggle="arm-a1"]'); await b.focus(); await b.click() }
  const more = page.locator('[data-arm="a1"] .arm-more')
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click()
  await page.locator('[data-arm="a1"] .arm-live').waitFor({ state: 'visible' })
}

/** Press Go live, and Go live again in the dialog (at a speed cap, if given): what the screen said, and whether the arm went live. */
async function tryLive(page, cap) {
  await openTools(page)
  await page.evaluate(() => { document.getElementById('note').textContent = '' })
  await page.locator('[data-arm="a1"] .arm-live').click()
  await page.locator('#live').waitFor({ state: 'visible' })
  // The speed list is a native select behind a glass one, out of sight: set its value the way the glass one does.
  const speed = page.locator('#live-cap')
  if (cap && (await speed.inputValue()) !== String(cap)) await speed.selectOption(String(cap), { force: true })
  await page.locator('#live-go').click()
  await page.waitForFunction(() => !!document.getElementById('note').textContent || window.__arm.arms()[0].live, null, { timeout: 5000, polling: 50 })
  return page.evaluate(() => ({ note: document.getElementById('note').textContent, live: window.__arm.arms()[0].live, hw: document.querySelector('[data-arm="a1"]').dataset.hw }))
}

async function goLive(page, cap) {
  const r = await tryLive(page, cap)
  assert(r.live && r.hw === 'live', `Arm 1 did not go live: "${r.note}"`)
}

/** Everything the page and the fake arm have done, as plain data. */
const snap = page => page.evaluate(() => {
  const a = window.__arm.arms()[0], f = window.__fake
  return {
    t: performance.now(), angles: a.joints.map(j => j.angle), targets: a.joints.map(j => j.target), live: a.live, hw: document.querySelector('[data-arm="a1"]').dataset.hw,
    stopped: window.__arm.stopped(), banner: document.getElementById('stop-by').textContent, bodyStopped: document.body.classList.contains('stopped'),
    log: document.getElementById('log').textContent, pos: [...f.pos], reportAt: f.reportAt, events: f.events.map(e => ({ ...e })),
  }
})

/** Wait for the arm to stop by itself (`ms` at most), then let any late goal arrive before looking. */
async function untilStopped(page, ms = 15000) {
  await page.waitForFunction(() => !!window.__arm.stopped(), null, { timeout: ms, polling: 50 })
  await sleep(400)
  return snap(page)
}

/** A stop that reached the driver: `holds` holds, and no goal sent after the last of them. */
function assertHeld(s, what, holds = 1) {
  const at = s.events.map(e => e.kind)
  assert(at.filter(k => k === 'hold').length === holds, `${what}: expected ${holds} hold(s) for the driver, saw ${at.filter(k => k === 'hold').length}`)
  assert(!at.slice(at.lastIndexOf('hold') + 1).includes('send'), `${what}: a goal was sent to the driver after its hold`)
}

/** A stop the page called for itself: `why` (a string, or a pattern) is in the stop, on the banner and in the record. Returns the reason as written. */
function assertStoppedFor(s, why, what) {
  const said = s.stopped?.why ?? ''
  assert(typeof why === 'string' ? said === why : why.test(said), `${what}: expected the reason ${why}, saw "${said}"`)
  assert(s.bodyStopped && s.banner === said, `${what}: the banner says "${s.banner}", not "${said}"`)
  assert(s.log.includes(`${said}: every arm halted`), `${what}: the record does not say why`)
  return said
}

/** Send Arm 1's twin to a base angle, its other joints where they are (the call Home makes). */
const moveBase = (page, deg) => page.evaluate(d => {
  const a = window.__arm.arms()[0], keys = window.__arm.kind().keys, pose = {}
  keys.forEach((k, i) => { pose[k] = a.joints[i].angle })
  pose[keys[0]] = d
  window.__arm.goTo('a1', pose)
}, deg)

/** Press Stop on the frame the arm first trails its twin's base by `deg` degrees (a real click's handler, without the race). */
const stopWhenBehind = (page, deg) => page.evaluate(d => new Promise((resolve, reject) => {
  const end = performance.now() + 8000
  const tick = () => {
    const twin = window.__arm.arms()[0].joints[0].angle, arm = window.__fake.pos[0]
    if (Math.abs(twin - arm) >= d) { document.getElementById('estop').click(); resolve({ twin, arm }) }
    else if (performance.now() > end) reject(new Error('the arm never fell behind its twin'))
    else requestAnimationFrame(tick)
  }
  tick()
}), deg)

export async function runArmLive(local, check) {
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM, args: ['--ignore-certificate-errors'] }))
  try {
    await check('robot arm, live: going live is refused while a joint is unreported', () => withArm(browser, local, { pos: [0, 18, null, 62, 0, 1] }, async page => {
      const r = await tryLive(page)
      assert(/hasn.t reported every joint yet/.test(r.note), `expected the unreported-joint refusal, saw "${r.note}"`)
      await sleep(300)
      const s = await snap(page)
      assert(!s.live && s.hw === 'twin', `Arm 1 went live with a joint unreported (${s.hw})`)
      assert(!s.events.some(e => e.kind === 'torque' || e.kind === 'send'), 'the arm was given torque or a goal while a joint was unreported')
      return `"${r.note}"`
    }))
    await check('robot arm, live: going live is refused while a joint is outside its limits', () => withArm(browser, local, { pos: [200, 18, 72, 62, 0, 1] }, async page => {
      const r = await tryLive(page)
      assert(/Arm 1.s base reads outside its limits: calibrate it first/.test(r.note), `expected the out-of-limits refusal, saw "${r.note}"`)
      await sleep(300)
      const s = await snap(page)
      assert(!s.live && s.hw === 'twin', `Arm 1 went live with the base at 200 degrees (${s.hw})`)
      assert(!s.events.some(e => e.kind === 'torque' || e.kind === 'send'), 'the arm was given torque or a goal while a joint was out of its limits')
      return `"${r.note}"`
    }))
    // The gripper reads 0 (closed) to 1 (open): 1.5 is far out of it, yet within the 3 a turning joint is given.
    await check('robot arm, live: going live is refused while the gripper reads outside 0 to 1, and allowed a hair past it', async () => {
      const said = await withArm(browser, local, { pos: [0, 18, 72, 62, 0, 1.5] }, async page => {
        const r = await tryLive(page)
        assert(/Arm 1.s gripper reads outside its limits: calibrate it first/.test(r.note), `expected the out-of-limits refusal for the gripper, saw "${r.note}"`)
        await sleep(300)
        const s = await snap(page)
        assert(!s.live && s.hw === 'twin', `Arm 1 went live with the gripper at 1.5 (${s.hw})`)
        assert(!s.events.some(e => e.kind === 'torque' || e.kind === 'send'), 'the arm was given torque or a goal while the gripper was out of its limits')
        return r.note
      })
      // A reading a little past the open end is calibration slop, not a fault.
      await withArm(browser, local, { pos: [0, 18, 72, 62, 0, 1.03] }, page => goLive(page, 0.25))
      return `"${said}"`
    })
    await check('robot arm, live: going live is also refused on a stale report, while stopped, and while everyone is let in without asking', () => withArm(browser, local, {}, async page => {
      await page.evaluate(() => window.__fake.setSilent(true))
      await sleep(1400)
      let r = await tryLive(page)
      assert(/isn.t reporting where it is right now/.test(r.note), `expected the stale-report refusal, saw "${r.note}"`)
      await page.evaluate(() => window.__fake.setSilent(false))
      await page.locator('#estop').click()
      r = await tryLive(page)
      assert(/can.t go live while everything is stopped: resume first/.test(r.note), `expected the stopped refusal, saw "${r.note}"`)
      await page.locator('#resume').click()
      // The box is in the people list, folded away by default: open it to check the box, then out of the way of the arm's window.
      await page.evaluate(() => { document.getElementById('people').hidden = false })
      await page.locator('#auto-allow').check()
      await page.evaluate(() => { document.getElementById('people').hidden = true })
      r = await tryLive(page)
      assert(/can.t go live while everyone is let in without asking: switch that off first/.test(r.note), `expected the waived-approval refusal, saw "${r.note}"`)
      const s = await snap(page)
      assert(!s.live && !s.events.some(e => ['torque', 'send', 'hold'].includes(e.kind)), 'the driver was called while going live was refused, or a Stop with nothing live sent it a hold')
      await page.evaluate(() => { document.getElementById('people').hidden = false })
      await page.locator('#auto-allow').uncheck()
      await page.evaluate(() => { document.getElementById('people').hidden = true })
      await goLive(page, 0.25)
      return 'stale, stopped and waived, then live once they were cleared'
    }))
    await check('robot arm, live: taking it off live and disconnecting it each hold the arm', () => withArm(browser, local, {}, async page => {
      await goLive(page, 0.25)
      await page.waitForFunction(() => window.__fake.events.filter(e => e.kind === 'send').length >= 3, null, { timeout: 5000, polling: 50 })
      let s = await snap(page)
      const torques = s.events.filter(e => e.kind === 'torque'), kinds = s.events.map(e => e.kind)
      assert(torques.length === 1 && torques[0].on === true, `expected one request for torque, saw ${JSON.stringify(torques)}`)
      assert(kinds.indexOf('torque') < kinds.indexOf('send'), 'a goal was sent before the arm had torque')
      const first = s.events.find(e => e.kind === 'send')
      assert(near(first.raw.slice(0, 5), [0, 18, 72, 62, 0], 1), `going live jumped the arm: its first goal was ${JSON.stringify(first.raw)}`)
      assert((await page.locator('[data-arm="a1"] .arm-badge').textContent()) === 'Live', 'the arm card does not say Live')
      // Off live: one hold, and no goal after it.
      await page.locator('[data-arm="a1"] .arm-live').click()
      await page.waitForFunction(() => !window.__arm.arms()[0].live, null, { timeout: 3000, polling: 50 })
      await sleep(400)
      s = await snap(page)
      assertHeld(s, 'taking the arm off live')
      assert(s.hw === 'twin' && !s.stopped, `after Take off live the card says ${s.hw}${s.stopped ? ' and everything is stopped' : ''}`)
      // Live again, then disconnected through the hardware dialog while live: a hold, then the link closes.
      await goLive(page, 0.25)
      await page.waitForFunction(() => { const k = window.__fake.events.map(e => e.kind); return k.slice(k.lastIndexOf('hold') + 1).includes('send') }, null, { timeout: 5000, polling: 50 })
      await page.locator('[data-arm="a1"] .arm-hw').click()
      await page.locator('#hw-disconnect').click()
      await page.waitForFunction(() => window.__fake.events.some(e => e.kind === 'close'), null, { timeout: 3000, polling: 50 })
      await sleep(400)
      s = await snap(page)
      assertHeld(s, 'disconnecting while live', 2)
      const tail = s.events.slice(-2).map(e => e.kind)
      assert(tail[0] === 'hold' && tail[1] === 'close', `expected the hold before the link closed, saw ${tail.join(', ')}`)
      assert(s.hw === 'sim', `after Disconnect the card says ${s.hw}`)
    }))
    await check('robot arm, live: after Stop the pose holds for over a second, the driver gets its hold, and only Resume clears it', () => withArm(browser, local, { rate: 3 }, async page => {
      await goLive(page, 0.25)
      // The arm crawls (3 degrees a second) after a twin that isn't slow: press Stop once it is several degrees behind, so that
      // a goal sent after the hold would carry it on to the twin's pose, and a Resume that didn't start from the arm would lurch it.
      await moveBase(page, 40)
      await stopWhenBehind(page, 6)
      await page.waitForFunction(() => window.__fake.events.some(e => e.kind === 'hold'), null, { timeout: 3000, polling: 50 })
      const hold = (await snap(page)).events.find(e => e.kind === 'hold')
      await page.waitForFunction(t => performance.now() - t >= 400, hold.t, { timeout: 5000, polling: 50 })
      const braked = await snap(page)
      assert(Math.abs(braked.angles[0] - hold.pos[0]) >= 2, `the arm was not behind its twin when it stopped (twin ${braked.angles[0].toFixed(1)}, arm ${hold.pos[0].toFixed(1)}), so this run proves nothing`)
      await page.waitForFunction(t => performance.now() - t >= 1500, hold.t, { timeout: 5000, polling: 50 })
      const later = await snap(page)
      assert(later.t - hold.t >= 1400, 'the second look came too soon')
      assert(later.stopped && later.bodyStopped && /^Stopped by/.test(later.banner), `expected the stop banner, saw "${later.banner}"`)
      assert(near(later.angles, braked.angles, 0.5), `the twin moved after Stop: ${JSON.stringify(braked.angles.map(Math.round))} to ${JSON.stringify(later.angles.map(Math.round))}`)
      assert(near(later.pos, hold.pos, 0.5), `the arm moved after its hold: ${JSON.stringify(hold.pos.map(Math.round))} to ${JSON.stringify(later.pos.map(Math.round))}`)
      assertHeld(later, 'Stop')
      // Nothing but Resume clears it: not Home, not a new pose.
      await page.locator('#home-all').click()
      await moveBase(page, -50)
      await sleep(500)
      const still = await snap(page)
      assert(still.stopped && near(still.angles, braked.angles, 0.5) && still.targets.every(t => t === null), 'Home or a new pose moved the arm, or cleared the stop, while stopped')
      assertHeld(still, 'Home while stopped')
      // Resume starts again from the arm, never jumping it.
      await page.locator('#resume').click()
      await page.waitForFunction(() => !window.__arm.stopped(), null, { timeout: 3000, polling: 50 })
      await page.waitForFunction(() => { const k = window.__fake.events.map(e => e.kind); return k.slice(k.lastIndexOf('hold') + 1).includes('send') }, null, { timeout: 5000, polling: 50 })
      await sleep(600)
      const resumed = await snap(page)
      assert(!resumed.stopped && !resumed.bodyStopped, 'Resume did not clear the stop')
      assert(near(resumed.pos, hold.pos, 1), `Resume moved the arm: ${JSON.stringify(hold.pos.map(Math.round))} to ${JSON.stringify(resumed.pos.map(Math.round))}`)
      assert(near(resumed.angles.slice(0, 5), resumed.pos.slice(0, 5), 1.5), `after Resume the twin is not where the arm is: ${JSON.stringify(resumed.angles.map(Math.round))} and ${JSON.stringify(resumed.pos.map(Math.round))}`)
      // Stop again, with a real click this time: one more hold.
      await page.locator('#estop').click()
      await page.waitForFunction(() => !!window.__arm.stopped(), null, { timeout: 3000, polling: 50 })
      await sleep(400)
      assertHeld(await snap(page), 'a second Stop', 2)
      await page.locator('#resume').click()
      await page.waitForFunction(() => !window.__arm.stopped(), null, { timeout: 3000, polling: 50 })
      return `held ${(later.t - hold.t).toFixed(0)} ms, ${Math.abs(braked.angles[0] - hold.pos[0]).toFixed(1)}° between the twin and the arm`
    }))
    await check('robot arm, live: a driver that goes silent stops the arm, and it says why', () => withArm(browser, local, {}, async page => {
      await goLive(page, 0.25)
      const silentAt = await page.evaluate(() => { window.__fake.setSilent(true); return window.__fake.reportAt })
      const s = await untilStopped(page)
      const said = assertStoppedFor(s, 'Arm 1 stopped reporting where it is', 'a silent driver')
      assertHeld(s, 'a silent driver')
      const heldAt = s.events.find(e => e.kind === 'hold').t - silentAt
      assert(heldAt >= 1100, `the arm was stopped after only ${heldAt.toFixed(0)} ms of silence`)
      return said
    }))
    await check('robot arm, live: an arm that falls 12° behind its twin stops, and it says why', () => withArm(browser, local, { rate: 0 }, async page => {
      await goLive(page, 1)
      // An arm that can't move, 10° short of its twin: within the 12° it is allowed, for as long as it likes.
      await moveBase(page, 10)
      await page.waitForFunction(() => Math.abs(window.__arm.arms()[0].joints[0].angle - 10) < 1, null, { timeout: 8000, polling: 50 })
      await sleep(1200)
      let s = await snap(page)
      assert(!s.stopped, `the arm was stopped at 10° off: "${s.stopped?.why}"`)
      // 14° short: too far, for long enough.
      await moveBase(page, 14)
      s = await untilStopped(page)
      const said = assertStoppedFor(s, /^Arm 1 isn.t keeping up \((\d+)° off\): check for something in its way$/, 'an arm that could not keep up')
      const off = Number(/\((\d+)°/.exec(said)[1])
      assert(off >= 12 && off <= 14, `the reason says ${off}° off, and the twin was 14° from the arm`)
      assertHeld(s, 'an arm that could not keep up')
      return said
    }))
    await check('robot arm, live: a lost connection stops the arm, and it says why', () => withArm(browser, local, {}, async page => {
      await goLive(page, 0.25)
      await page.evaluate(() => window.__fake.driver.onLost('cable pulled'))
      const s = await untilStopped(page, 5000)
      const said = assertStoppedFor(s, 'Arm 1 lost its connection: cable pulled', 'a lost connection')
      assert(s.log.includes('Arm 1 lost its hardware: cable pulled'), 'the record does not say the hardware was lost')
      assertHeld(s, 'a lost connection')
      assert(!s.live && s.hw === 'sim', `after the loss the card says ${s.hw}`)
      return said
    }))
    await check('robot arm, live: a page that goes to the background stops the arm, and it says why', () => withArm(browser, local, {}, async page => {
      await goLive(page, 0.25)
      // Headless Chromium keeps its tab visible: report it hidden the way the browser does.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const s = await untilStopped(page, 5000)
      const said = assertStoppedFor(s, 'The screen went to the background', 'a hidden page')
      assertHeld(s, 'a hidden page')
      // Coming back does not resume it.
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await sleep(400)
      assert(!!(await snap(page)).stopped, 'the arm resumed by itself when the page came back')
      return said
    }))
    await check('robot arm, live: approval can’t be switched off while an arm is live', () => withArm(browser, local, {}, async page => {
      await goLive(page, 0.25)
      await page.evaluate(() => { document.getElementById('people').hidden = false })
      const box = page.locator('#auto-allow')
      assert((await box.isDisabled()) && !(await box.isChecked()), 'the box that lets everyone in without asking can be switched on while an arm is live')
      // Past the disabled box (a script, a stale tab): switching it on is undone, and a stranger is still asked.
      await page.evaluate(() => { const c = document.getElementById('auto-allow'); c.checked = true; c.dispatchEvent(new Event('change')) })
      assert(!(await box.isChecked()), 'forcing the box on left approval waived while an arm was live')
      assert(!(await page.evaluate(() => window.__sim.allowed('a-stranger'))), 'a stranger was let in unasked while an arm was live')
      // Off live, it is theirs again.
      await page.evaluate(() => { document.getElementById('people').hidden = true })
      await page.locator('[data-arm="a1"] .arm-live').click()
      await page.waitForFunction(() => !window.__arm.arms()[0].live, null, { timeout: 3000, polling: 50 })
      await page.evaluate(() => { document.getElementById('people').hidden = false })
      assert(await box.isEnabled(), 'the box stayed locked after the arm came off live')
    }))
  } finally { await browser.close() }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  // Never fall back to the shared stand-in's ports (startLocal's defaults).
  for (const k of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) if (!process.env[k]) throw new Error(`Set ${k}: this run must use its own ports`)
  const { startLocal } = await import('../extension/e2e/local.mjs')
  const local = await startLocal(); let failed = 0, total = 0
  // --filter <text>, as often as needed: only the checks whose names contain one of them.
  const filters = process.argv.flatMap((arg, i) => arg === '--filter' && process.argv[i + 1] ? [process.argv[i + 1]] : [])
  try {
    await runArmLive(local, async (name, fn) => {
      if (filters.length && !filters.some(f => name.includes(f))) return
      total++
      try { const detail = await fn(); console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`) } catch (e) { failed++; console.log(`  ✗ ${name}: ${e?.message ?? e}`) }
    })
  } finally { await local.close() }
  console.log(failed ? `FAILED ${failed}/${total}` : `passed ${total}/${total}`); process.exitCode = failed ? 1 : 0
}
