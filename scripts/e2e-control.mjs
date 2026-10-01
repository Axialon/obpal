/** Calibrated spaces driven by real phone UI and synthetic W3C sensor events over WebRTC. */
import { tempScope } from './lib/temp.mjs'
import { chromium, devices } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startLocal } from '../extension/e2e/local.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0
const stats = values => ({ medianMs: quantile(values, 0.5), p90Ms: quantile(values, 0.9), p95Ms: quantile(values, 0.95), p99Ms: quantile(values, 0.99) })
async function until(fn, label, ms = 15000) {
  const end = Date.now() + ms
  while (!await fn()) { if (Date.now() > end) throw new Error(`Control space timed out: ${label}`); await sleep(40) }
}

export async function runControl(local, check) {
  const temps = tempScope()
  try {
  const dir = await temps.make(join(tmpdir(), 'obpal-control-'))
  console.log(`  Control space measurements and captures: ${dir}`)
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  const errors = [], open = new Set(), report = {}
  async function pair(id) {
    const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
    open.add(host); open.add(phone)
    const screen = await host.newPage(), page = await phone.newPage(), cdp = await phone.newCDPSession(page)
    for (const p of [screen, page]) p.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(() => {
      // Observe capture, dispatch and emission independently. This does not send any input.
      window.__strikeTiming = []
      let peak = null
      addEventListener('devicemotion', e => {
        const a = e.acceleration, strength = a ? Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0) : 0
        if (strength >= 7 && (!peak || strength > peak.strength)) peak = { strength, at: e.timeStamp, dispatch: performance.now() - e.timeStamp }
        if (strength < 3) peak = null
      }, true)
      const send = RTCDataChannel.prototype.send
      RTCDataChannel.prototype.send = function(data) {
        if (typeof data === 'string') try {
          const m = JSON.parse(data)
          if (m.t === 'value' && m.id === 'music.event') {
            const e = JSON.parse(m.v)
            if (e.op === 'hit' && e.aim && peak) {
              window.__strikeTiming.push({ seq: e.seq, dispatch: peak.dispatch, detection: performance.now() - peak.at - peak.dispatch, lag: performance.now() - peak.at })
              peak = null
            }
          }
        } catch { /* Binary state and other ctl values are unrelated. */ }
        return send.call(this, data)
      }
    })
    await screen.goto(`${local.origin}/sim/device/?d=${id}`)
    await until(() => screen.evaluate(() => !!window.__device && !!window.__obpal?.pairingUrl), `${id} screen`)
    await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 70, gamma: 0 })
    await page.goto(await screen.evaluate(() => window.__obpal.pairingUrl))
    await page.locator('[data-id="control.position"]').waitFor({ timeout: 30000 })
    await page.evaluate(() => document.querySelectorAll('.hint').forEach(h => h.remove()))
    const who = await screen.evaluate(() => window.__obpal.participants[0].id)
    let pose = { alpha: 0, beta: 70, gamma: 0 }, armed = false
    const motion = async (a = 0) => page.evaluate(({ a, beta }) => {
      const angle = beta * Math.PI / 180
      dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: -a * Math.sin(angle), z: -a * Math.cos(angle) }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }))
    }, { a, beta: pose.beta })
    const orient = async next => {
      pose = next
      await cdp.send('DeviceOrientation.setDeviceOrientationOverride', pose)
      for (let n = 0; n < 4; n++) { await sleep(20); await motion() }
    }
    const aim = async (x, y, reach = [35, 25]) => {
      await orient({ alpha: (360 - x * reach[0]) % 360, beta: 70 + y * reach[1], gamma: 0 })
      await until(async () => {
        await motion()
        return screen.evaluate(({ who, x, y }) => {
          const s = window.__sim.control.aim(who)
          return s && Math.hypot(s.aim[0] - x, s.aim[1] - y) < 0.025
        }, { who, x, y })
      }, `aim ${x}, ${y}`).catch(async e => {
        const state = await screen.evaluate(who => ({ aim: window.__sim.control.aim(who), person: window.__obpal.participants.find(p => p.id === who)?.controller, seen: window.__device.seen[who] }), who)
        throw new Error(`${e.message}: ${JSON.stringify(state)}`)
      })
    }
    const touch = async (on, selector = '.strike-pad') => {
      const r = on ? await page.locator(selector).boundingBox() : null
      if (on) assert(r, `${selector} bounds`)
      await cdp.send('Input.dispatchTouchEvent', { type: on ? 'touchStart' : 'touchEnd', touchPoints: on ? [{ x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1, force: 0.7 }] : [] })
      armed = on
    }
    const flick = async () => {
      if (!armed) await touch(true)
      for (const a of [0, 9, 24, 8, 0]) { await motion(a); await sleep(16) }
      await sleep(60)
    }
    const scope = async value => {
      if (armed) await touch(false)
      const current = await screen.evaluate(who => window.__sim.control.scope(who), who)
      if (current !== value) await page.locator('[data-id="control.scope"]').click()
      await until(() => screen.evaluate(({ who, value }) => window.__sim.control.scope(who) === value, { who, value }), value)
    }
    const position = async () => {
      if (armed) await touch(false)
      await page.locator('[data-id="control.position"]').click()
      await motion(); await sleep(60)
    }
    const record = async () => screen.evaluate(() => {
      const stream = document.getElementById('stage').captureStream(30)
      for (const t of window.__studio?.sound.capture?.stream.getAudioTracks() ?? []) stream.addTrack(t)
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1600000 }), chunks = []
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      window.__controlCapture = { recorder, chunks }; recorder.start(250)
    })
    const capture = async () => {
      await screen.screenshot({ path: join(dir, `${id}.png`) })
      await page.screenshot({ path: join(dir, `${id}-phone.png`) })
      const data = await screen.evaluate(async () => {
        const { recorder, chunks } = window.__controlCapture
        await new Promise(r => { recorder.onstop = r; recorder.stop() })
        const blob = new Blob(chunks, { type: 'video/webm' })
        return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob) })
      })
      await writeFile(join(dir, `${id}.webm`), Buffer.from(data.split(',')[1], 'base64'))
    }
    const close = async () => { await phone.close(); await host.close(); open.delete(phone); open.delete(host) }
    await orient(pose)
    return { screen, page, who, motion, orient, aim, touch, flick, scope, position, record, capture, close }
  }
  try {
    const p = await pair('studio')
    await p.screen.locator('#studio-start').click()
    await p.page.getByText('Strike mode', { exact: true }).click()
    await p.position(); await p.record()
    await check('control space: an emulated air stick hits kick, snare and ride in object scope', async () => {
      for (const [x, y, surface] of [[0, -0.72, 0], [-0.42, -0.38, 1], [0.7, 0.74, 8]]) {
        await p.aim(x, y); await p.flick()
        await until(() => p.screen.evaluate(surface => {
          const t = window.__device.logic.strikes.at(-1)
          return t?.seat === 0 && t.surface === surface
        }, surface), `drum ${surface}`)
      }
      const strikes = await p.screen.evaluate(() => window.__device.logic.strikes.map(s => s.surface))
      assert(strikes.join() === '0,1,8', JSON.stringify(strikes))
      assert(await p.page.locator('.strike-map circle').count() === 9, 'Kit map has every surface')
      return 'Kick → snare → ride from phone orientation and downward acceleration'
    })
    await check('control space: scene scope reaches the far percussion station without changing the held instrument', async () => {
      await p.scope('scene'); await p.aim(0.9, -0.85); await p.flick()
      await until(() => p.screen.evaluate(() => {
        const t = window.__device.logic.strikes.at(-1)
        return t?.seat === 7 && t.surface === 12
      }), 'far djembe')
      assert(await p.page.locator('.strike-map circle').count() === 75, 'Studio map has every surface')
      assert((await p.page.locator('.scene-btn').getAttribute('aria-label')).includes('Drum kit'), 'Scene strikes preserve claim')
      await p.touch(false)
    })
    await check('control space: object scope spreads all marimba bars across the comfortable reach', async () => {
      await p.scope('object')
      await p.orient({ alpha: 0, beta: 70, gamma: 0 })
      await p.page.locator('.scene-btn').click()
      await p.page.locator('.pick').filter({ has: p.page.getByText('Marimba', { exact: true }) }).click()
      await until(() => p.page.locator('.scene-btn').getAttribute('aria-label').then(t => t.includes('Marimba')), 'marimba claim')
      await p.position()
      for (const [x, surface] of [[-0.82, 0], [0.0546667, 8], [0.82, 15]]) {
        await p.aim(x, 0); await p.flick()
        await until(() => p.screen.evaluate(surface => {
          const t = window.__device.logic.strikes.at(-1)
          return t?.seat === 5 && t.surface === surface
        }, surface), `bar ${surface}`)
      }
      await p.touch(false); await p.capture()
    })
    await check('control space: air-stick timing meets the per-controller music gates', async () => {
      await p.orient({ alpha: 0, beta: 70, gamma: 0 })
      await p.page.locator('.scene-btn').click()
      await p.page.locator('.pick').filter({ has: p.page.getByText('Drum kit', { exact: true }) }).click()
      await p.position(); await p.aim(-0.42, -0.38)
      await sleep(2200)
      for (let n = 0; n < 16; n++) await p.flick()
      await until(() => p.screen.evaluate(() => window.__studio.samples.length >= 16), 'warm strikes')
      await p.screen.evaluate(() => { window.__studio.samples.length = 0 })
      await p.page.evaluate(() => { window.__strikeTiming.length = 0 })
      for (let n = 0; n < 80; n++) await p.flick()
      await until(() => p.screen.evaluate(() => window.__studio.samples.length >= 80), '80 strikes').catch(async e => {
        throw new Error(`${e.message}: ${JSON.stringify(await p.screen.evaluate(() => ({ samples: window.__studio.samples.length, strikes: window.__device.logic.strikes.slice(-5), counts: window.__device.logic.counts })))}, ${JSON.stringify(await p.page.evaluate(() => ({ timing: window.__strikeTiming.length, held: document.querySelector('.strike-pad').className, hint: document.querySelector('.music-hint').textContent })))}`)
      })
      const samples = await p.screen.evaluate(() => window.__studio.samples), observed = await p.page.evaluate(() => window.__strikeTiming)
      assert(samples.length === 80 && observed.length === 80, `${samples.length} attacks, ${observed.length} detected strikes`)
      const bySeq = new Map(observed.map(t => [t.seq, t]))
      const handler = samples.map(s => s.ms - bySeq.get(s.seq).lag)
      assert(samples.every(s => Number.isFinite(s.ms)) && handler.every(Number.isFinite), 'Finite timings')
      report.airStick = { samples: samples.length, ...stats(samples.map(s => s.ms)), browserDispatch: stats(observed.map(t => t.dispatch)), detection: stats(observed.map(t => t.detection)), handlerToSchedule: stats(handler.map(t => Math.max(0, t))), clockUncertaintyP95Ms: quantile(samples.map(s => s.uncertainty), 0.95) }
      assert(report.airStick.medianMs < 35 && report.airStick.p90Ms < 100 && report.airStick.handlerToSchedule.medianMs < 15, JSON.stringify(report.airStick))
      await p.touch(false)
      return JSON.stringify(report.airStick)
    })
    await p.close()

    const claw = await pair('claw')
    await claw.position(); await claw.record()
    await check('control space: the claw covers its pit and recentres from the phone and sim panel', async () => {
      await claw.aim(0.9, 0.8)
      await until(() => claw.screen.evaluate(() => {
        const d = window.__device, c = d.stage.view.presence.activeCamera, u = d.logic.claws[0]
        const centre = c.position.clone().set(-1, 1.3, 0).project(c), tip = c.position.clone().set(u.x - 1, 1.3, u.z).project(c)
        return tip.x > centre.x + 0.02 && tip.y > centre.y + 0.02
      }), 'far pit corner in the view frame')
      await claw.position()
      await until(() => claw.screen.evaluate(() => Math.hypot(window.__device.logic.claws[0].x, window.__device.logic.claws[0].z) < 0.03), 'new neutral')
      await claw.orient({ alpha: 0, beta: 70, gamma: 0 })
      await claw.screen.locator('.control-scopes button').filter({ hasText: 'Set position' }).click()
      await claw.motion(); await sleep(100)
      await claw.aim(-0.9, -0.8)
      await until(() => claw.screen.evaluate(() => {
        const d = window.__device, c = d.stage.view.presence.activeCamera, u = d.logic.claws[0]
        const centre = c.position.clone().set(-1, 1.3, 0).project(c), tip = c.position.clone().set(u.x - 1, 1.3, u.z).project(c)
        return tip.x < centre.x - 0.02 && tip.y < centre.y - 0.02
      }), 'near pit corner in the view frame')
      await claw.capture()
    })
    await check('control space: a paired phone aims screen right after orbiting behind and entering first person', async () => {
      for (const mode of ['overview', 'first-person']) {
        await claw.screen.evaluate(mode => {
          const s = window.__device.stage, e = s.view.presence
          if (mode === 'overview') { const d = s.camera.position.clone().sub(s.controls.target); d.x *= -1; d.z *= -1; s.camera.position.copy(s.controls.target).add(d); s.controls.update() }
          else e.setMode(mode)
        }, mode)
        await claw.aim(0, 0); await sleep(300)
        const before = await claw.screen.evaluate(() => {
          const d = window.__device, c = d.stage.view.presence.activeCamera, u = d.logic.claws[0]
          return c.position.clone().set(u.x - 1, 1.3, u.z).project(c).x
        })
        await claw.aim(0.65, 0); await sleep(300)
        const after = await claw.screen.evaluate(() => {
          const d = window.__device, c = d.stage.view.presence.activeCamera, u = d.logic.claws[0]
          return c.position.clone().set(u.x - 1, 1.3, u.z).project(c).x
        })
        assert(after - before > 0.04, `${mode}: calibrated right projected ${after - before}`)
      }
      await claw.screen.evaluate(() => window.__device.stage.view.presence.setMode('overview'))
    })
    await check('control space: scene selection has its own reach and returns to object control', async () => {
      await claw.scope('scene'); await claw.aim(0.72, 0)
      await claw.page.locator('[data-id="control.take"]').click()
      await until(() => claw.screen.evaluate(who => window.__sim.claims.held(who) === window.__device.units[1].id && window.__sim.control.scope(who) === 'object', claw.who), 'second cabinet')
    })
    await claw.close()

    const maze = await pair('maze')
    await maze.page.locator('#gyro').click(); await maze.position(); await maze.record()
    await check('control space: tilt neutral has a dead zone and Set position levels without restarting the maze', async () => {
      await maze.orient({ alpha: 0, beta: 55, gamma: 12 })
      await until(() => maze.screen.evaluate(() => Math.abs(window.__device.logic.boards[0].tx) + Math.abs(window.__device.logic.boards[0].tz) > 0.1), 'tilted board').catch(async e => {
        throw new Error(`${e.message}: ${JSON.stringify(await maze.screen.evaluate(who => ({ aim: window.__sim.control.aim(who), board: window.__device.logic.boards[0], seen: window.__device.seen[who] }), maze.who))}`)
      })
      const before = await maze.screen.evaluate(() => window.__device.logic.boards[0].time)
      await maze.position()
      for (let n = 0; n < 8; n++) { await maze.motion(); await sleep(20) }
      const state = await maze.screen.evaluate(() => window.__device.logic.boards[0])
      assert(Math.abs(state.tx) + Math.abs(state.tz) < 0.02, JSON.stringify(state))
      assert(state.time >= before, `Recenter restarted the run: ${before} → ${state.time}`)
      await maze.orient({ alpha: 0, beta: 56, gamma: 13 })
      const neutral = await maze.screen.evaluate(who => window.__sim.control.aim(who).tilt, maze.who)
      assert(neutral.every(n => Math.abs(n) < 0.005), JSON.stringify(neutral))
      await maze.orient({ alpha: 0, beta: 67, gamma: -1 }); await sleep(500); await maze.capture()
    })
    await maze.close()

    const hockey = await pair('airhockey')
    await hockey.page.locator('[data-tab="point"]').click(); await hockey.position(); await hockey.record()
    await check('control space: hockey reach stays on its own half in either scope', async () => {
      for (const scope of ['object', 'scene']) {
        await hockey.scope(scope)
        for (const [x, y] of [[-0.95, 0.95], [0.95, -0.95]]) {
          await hockey.aim(x, y, [30, 25]); await sleep(450)
          const result = await hockey.screen.evaluate(() => {
            const d = window.__device, u = d.logic.units[0], c = d.stage.view.presence.activeCamera
            const centre = c.position.clone().set(0, 1.02, 0.8).project(c), mallet = c.position.clone().set(u.x, 1.02, u.z).project(c)
            return { ...u, dx: mallet.x - centre.x, dy: mallet.y - centre.y }
          })
          assert(result.dx * x > 0.01 && result.dy * y > 0.01 && Math.abs(result.x) <= 0.86 && result.z >= 0.14 && result.z <= 1.46, JSON.stringify(result))
        }
      }
      await hockey.capture()
    })
    await hockey.close()
    await check('control space: no phone or screen JavaScript errors', () => { assert(!errors.length, errors.join('\n')) })
  } finally {
    await writeFile(join(dir, 'measurements.json'), JSON.stringify(report, null, 2))
    await Promise.allSettled([...open].map(c => c.close()))
    await browser.close()
  }
  return dir

  } finally { await temps.cleanup() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const local = await startLocal(), results = []
  try {
    await runControl(local, async (name, fn) => {
      try { const detail = await fn(); results.push(true); console.log(`✓ ${name}${detail ? ` (${detail})` : ''}`) }
      catch (e) { results.push(false); console.error(`✗ ${name}: ${e.message}`) }
    })
  } catch (e) { results.push(false); console.error(e) }
  finally { await local.close() }
  console.log(`${results.every(Boolean) ? 'passed' : 'FAILED'} ${results.filter(Boolean).length}/${results.length}`)
  process.exitCode = results.every(Boolean) ? 0 : 1
}
