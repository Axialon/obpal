/** Script physical phone turns through CDP, then check the actual projected model and camera axes. Writes only to temp. */
import { tempScope } from './lib/temp.mjs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { Quaternion } from 'three'
import { startLocal } from '../extension/e2e/local.mjs'
import { holds, reading, orient, delta, projection, trackingPose, cameraPoseFixture, D } from './lib/orientation.mjs'
import { trayCamera } from './lib/sim-ui.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'

const temps = tempScope()
try {

const out = await temps.make(join(tmpdir(), 'obpal-orientation-'))
const local = await startLocal()
const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: !process.argv.includes('--headed'), args: ['--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }))
const rows = [], results = [], errors = []
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7) || process.env.OBPAL_E2E_ORIENTATION_ONLY
const wait = ms => new Promise(r => setTimeout(r, ms))
async function until(what, fn) {
  const end = Date.now() + 25000
  while (Date.now() < end) { const v = await fn(); if (v) return v; await wait(60) }
  throw new Error(`timed out: ${what}`)
}
async function check(name, fn) {
  try { await fn(); results.push(true); console.log(`  ✓ ${name}`) }
  catch (e) { results.push(false); console.log(`  ✗ ${name}: ${e.message}`) }
}
function watch(page) { page.on('pageerror', e => errors.push(e.message)) }
const turn = page => page.evaluate(() => window.__turn())
const errorDegrees = (a, b) => new Quaternion(...a).normalize().angleTo(b) / D
async function phone(hold, url = local.origin, permission = false, xr = false, neutral = false) {
  const context = await browser.newContext({ ...devices[hold.screen ? 'Pixel 7 landscape' : 'Pixel 7'], ignoreHTTPSErrors: true, reducedMotion: hold.name === 'upright' ? 'reduce' : 'no-preference' })
  if (xr) await context.addInitScript(cameraPoseFixture)
  await context.addInitScript(({ screenAngle, permission, neutral }) => {
    window.__screenAngle = screenAngle
    Object.defineProperty(screen.orientation, 'angle', { configurable: true, get: () => window.__screenAngle })
    screen.orientation.lock = () => Promise.reject(new DOMException('virtual lock fixture', 'NotSupportedError'))
    localStorage.setItem('obpal.style', 'match'); localStorage.setItem('obpal.lockgyro', '0')
    localStorage.setItem('obpal.gain', '2.3'); localStorage.setItem('obpal.smooth', '1')
    if (neutral) {
      // Observe the application's first sensor reading without starting the sensor before it subscribes.
      window.__firstOrientation = null
      const listen = window.addEventListener
      window.addEventListener = function (type, listener, options) {
        listen.call(this, type, listener, options)
        if (type === 'deviceorientation') {
          window.addEventListener = listen
          listen.call(this, type, e => { window.__firstOrientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma } }, { once: true })
        }
      }
    }
    if (permission) {
      window.__permissions = []
      for (const kind of [DeviceOrientationEvent, DeviceMotionEvent]) kind.requestPermission = () => {
        window.__permissions.push(navigator.userActivation.isActive)
        return Promise.resolve('granted')
      }
    }
  }, { screenAngle: hold.screen, permission, neutral })
  const page = await context.newPage(), cdp = await context.newCDPSession(page)
  watch(page)
  await orient(cdp, reading(hold)); await page.goto(url)
  return { context, page, cdp, xr }
}
async function move(p, hold, axis, deg) {
  // Distinct readings also exercise Chromium's sensor change threshold.
  await orient(p.cdp, reading(hold, axis, deg + 0.2))
  await wait(65)
  await orient(p.cdp, reading(hold, axis, deg))
  if (p.xr) await p.page.evaluate(q => { window.__fakePose.q = q }, trackingPose(hold, axis, deg))
  await wait(140)
}
async function neutral(p, hold) {
  const sample = reading(hold)
  await p.page.evaluate(sample => {
    window.__neutralOrientation = null
    const observed = e => {
      if (!['alpha', 'beta', 'gamma'].every(key => typeof e[key] === 'number' && Math.abs(e[key] - sample[key]) < 0.0001)) return
      window.__neutralOrientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma }
      removeEventListener('deviceorientation', observed)
    }
    addEventListener('deviceorientation', observed)
  }, sample)
  // The reference uses its first reading. Reapply the declared hold after enabling
  // tilt so that Chromium delivers neutral before move() exercises its threshold.
  await p.cdp.send('DeviceOrientation.clearDeviceOrientationOverride')
  await orient(p.cdp, sample)
  const observed = await until('neutral orientation delivered', () => p.page.evaluate(() => window.__neutralOrientation))
  rows.push({ name: `${hold.name}: neutral orientation`, expected: sample, observed })
}
async function projected(page, expected) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const actual = await turn(page)
  const error = errorDegrees(actual, expected)
  if (error > 0.12) throw new Error(`rotation error ${error.toFixed(3)} degrees`)
  // Check visible polygon vertices, not just a debug quaternion: this detects SVG handedness and projection errors.
  const polys = await page.locator('[data-scene=turn] polygon').evaluateAll(ps => ps.map(p => p.getAttribute('points')))
  let pixelError = 0, renderedPoseError = 0
  for (let i = 0; i < polys.length; i++) {
    const vertices = projection(expected, i < 3 ? [0.5, 1, 0.08] : [1, 1, 1], i < 3 ? 34 : 50).vertices
    const rendered = projection(new Quaternion(...actual), i < 3 ? [0.5, 1, 0.08] : [1, 1, 1], i < 3 ? 34 : 50).vertices
    for (const p of polys[i].split(' ').filter(Boolean)) {
      const [x, y] = p.split(',').map(Number)
      pixelError = Math.max(pixelError, Math.min(...vertices.map(v => Math.hypot(x - v[0], y - v[1]))))
      renderedPoseError = Math.max(renderedPoseError, Math.min(...rendered.map(v => Math.hypot(x - v[0], y - v[1]))))
    }
  }
  if (pixelError > 0.18) {
    rows.push({ name: 'projection failure', error, pixelError, renderedPoseError, expected: expected.toArray(), actual, polys })
    throw new Error(`projected vertex error ${pixelError.toFixed(3)} px`)
  }
  // Both direction and angle of all projected axes, including the short axis near an edge-on pose.
  const expectedAxes = projection(expected).lines, actualAxes = projection(new Quaternion(...actual)).lines
  const angles = actualAxes.map((v, i) => Math.atan2(v[1], v[0]) - Math.atan2(expectedAxes[i][1], expectedAxes[i][0]))
  if (angles.some(a => Math.abs(Math.atan2(Math.sin(a), Math.cos(a))) > 0.004)) throw new Error('projected axis direction differs')
  return { error, pixelError, expected: expected.toArray(), actual, expectedAxes, actualAxes }
}
async function capture(page, name, data) {
  await page.locator('[data-scene=turn]').screenshot({ path: join(out, `${name}.png`) })
  rows.push({ name, ...data })
}
async function axesOnCard(page, p, hold, prefix, q0) {
  for (const axis of ['yaw', 'pitch', 'roll']) for (const deg of [-30, 30]) {
    const name = `${prefix}${hold.name}-${axis}-${deg}`
    await check(name, async () => {
      await move(p, hold, axis, deg)
      const expected = delta(axis, deg).multiply(new Quaternion(...q0))
      await until('model follows phone', async () => errorDegrees(await turn(page), expected) < 0.12).catch(async e => {
        rows.push({ name: `${name}: rotation failure`, expected: expected.toArray(), actual: await turn(page) })
        throw e
      })
      const measured = await projected(page, expected)
      await capture(page, name, { hold, axis, deg, reading: reading(hold, axis, deg), ...measured })
    })
  }
}
async function clear(page) { await page.evaluate(() => document.querySelectorAll('.hint, .bt-notice').forEach(h => h.remove())) }
async function held(p, on) {
  if (on) await p.page.locator('#pad').click({ trial: true })
  const b = await p.page.locator('#pad').boundingBox()
  await p.cdp.send('Input.dispatchTouchEvent', { type: on ? 'touchStart' : 'touchEnd', touchPoints: on ? [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] : [] })
  await wait(180)
}
async function trackedGrab(page, p, hold) {
  const pose = () => page.evaluate(() => {
    const remote = window.__obpal, lead = remote.participants.find(p => p.lead)
    return lead ? remote.consumeOf(lead.id, performance.now()).pose : null
  })
  const neutral = new Quaternion(...trackingPose(hold))
  const ready = async () => { const next = await pose(); return next?.tracked && next.touching && errorDegrees(next.q, neutral) < .01 }
  // Start the measured grab after a neutral pose and its release have reached the host, including fullscreen setup.
  if (await p.page.evaluate(() => document.fullscreenEnabled && !document.fullscreenElement)) {
    await p.page.locator('#pad').tap()
    await p.page.waitForFunction(() => !!document.fullscreenElement)
  }
  await held(p, true)
  await until('neutral tracked pose received', ready)
  await held(p, false)
  await until('tracked pose released', async () => !(await pose())?.touching)
  await held(p, true)
  await until('neutral tracked grab received', ready)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
try {
  if (!only || only === 'local') for (const hold of holds) {
    const p = await phone(hold, local.origin, hold.name === 'portrait', false, true)
    try {
      await p.page.locator('[data-hint]').click()
      // The first 0.2-degree movement must not become the neutral camera frame.
      await p.page.waitForFunction(expected => {
        const first = window.__firstOrientation
        return first && Object.keys(expected).every(key => typeof first[key] === 'number' && Math.abs(first[key] - expected[key]) < .001)
      }, reading(hold))
      await p.page.locator('[data-scene=turn]').scrollIntoViewIfNeeded()
      await neutral(p, hold)
      await move(p, hold, 'yaw', 0)
      const q0 = await turn(p.page)
      if (hold.name === 'portrait') await check('both iOS permission requests start in the tap', async () => {
        const calls = await p.page.evaluate(() => window.__permissions)
        if (calls.length !== 2 || calls.some(v => !v)) throw new Error(JSON.stringify(calls))
      })
      await axesOnCard(p.page, p, hold, '', q0)
      await check(`${hold.name}: a stationary phone holds its model past the old timeout`, async () => {
        const q = await turn(p.page); await wait(3300)
        await projected(p.page, new Quaternion(...q))
      })
      await check(`${hold.name}: rotating the screen creates no physical turn`, async () => {
        const q = await turn(p.page)
        await p.page.evaluate(() => { window.__screenAngle = (window.__screenAngle + 90) % 360; screen.orientation.dispatchEvent(new Event('change')) })
        // The device orientation is unchanged: only the browser's viewport changed.
        await move(p, hold, 'roll', 30)
        await projected(p.page, new Quaternion(...q))
      })
    } finally { await p.context.close() }
  }

  if (!only || only === 'paired') {
  const host = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
  const page = await host.newPage(); watch(page)
  await page.goto(local.origin); await page.mouse.move(10, 10)
  await until('pairing URL', () => page.evaluate(() => window.__obpal?.pairingUrl))
  await page.locator('[data-scene=turn]').scrollIntoViewIfNeeded(); await page.mouse.move(1, 1)
  const invite = await page.evaluate(() => window.__obpal.pairingUrl)
  for (const hold of holds) {
    const p = await phone(hold, invite)
    try {
      await p.page.waitForFunction(() => document.body.classList.contains('live'))
      await clear(p.page); await move(p, hold, 'yaw', 0)
      await p.page.locator('#gyro').click(); await wait(250)
      const q0 = await turn(page)
      await axesOnCard(page, p, hold, 'paired-', q0)
      await check(`${hold.name}: paired recenter holds the current model`, async () => {
        const q = await turn(page); await p.page.locator('#center').click(); await wait(200)
        await projected(page, new Quaternion(...q))
      })
      await p.page.locator('.modes [data-tab=track]').click(); await clear(p.page)
      await neutral(p, hold)
      await move(p, hold, 'yaw', 0); await trackedGrab(page, p, hold)
      const hand0 = await turn(page)
      await axesOnCard(page, p, hold, 'hand-', hand0)
      await held(p, false)
    } finally { await p.context.close(); await wait(300) }
  }
  await host.close()
  }

  if (!only || only === 'camera') {
    const host = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true })
    const page = await host.newPage(); watch(page); await page.goto(local.origin); await page.mouse.move(10, 10)
    const invite = await until('camera pose invite', () => page.evaluate(() => window.__obpal?.pairingUrl))
    await page.locator('[data-scene=turn]').scrollIntoViewIfNeeded(); await page.mouse.move(1, 1)
    const hold = holds[0], p = await phone(hold, invite, false, true)
    try {
      await p.page.waitForFunction(() => document.body.classList.contains('live'))
      await p.page.locator('.modes [data-tab=track]').click(); await clear(p.page)
      await p.page.locator('#track-start').click(); await move(p, hold, 'yaw', 0); await trackedGrab(page, p, hold)
      const q0 = await turn(page)
      for (const axis of ['yaw', 'pitch', 'roll']) for (const deg of [-30, 30]) await check(`camera pose: ${axis} ${deg}`, async () => {
        await move(p, hold, axis, deg)
        const expected = delta(axis, deg).multiply(new Quaternion(...q0))
        await until('tracked pose rotation', async () => errorDegrees(await turn(page), expected) < 0.12)
        await projected(page, expected)
      })
      await check('camera pose: recenter starts a new origin and preserves the displayed turn', async () => {
        const generation = () => page.evaluate(() => {
          const r = window.__obpal, p = r.participants.find(p => p.lead)
          return p && r.consumeOf(p.id, performance.now()).pose?.gen
        })
        const gen = await generation(), before = await turn(page)
        if (typeof gen !== 'number') throw new Error('No tracked camera pose at recenter')
        await p.page.locator('#center').click()
        await until('new camera pose origin', async () => { const next = await generation(); return typeof next === 'number' && next !== gen })
        await projected(page, new Quaternion(...before))
      })
      await page.screenshot({ path: join(out, 'camera-pose.png') }); await held(p, false)
    } finally { await p.context.close(); await host.close() }
  }

  // The viewer is deliberately oblique: a heading-only alignment fails pitch and roll here.
  if (!only || only === 'viewer') {
  const vc = await browser.newContext({ viewport: { width: 1200, height: 800 }, ignoreHTTPSErrors: true })
  const vp = await vc.newPage(); watch(vp); await vp.goto(`${local.origin}/view/`)
  const vi = await until('viewer invite', () => vp.evaluate(() => window.__obpal?.pairingUrl))
  const hold = holds[0], p = await phone(hold, vi)
  try {
    await p.page.waitForFunction(() => document.body.classList.contains('live'))
    await clear(p.page); await move(p, hold, 'yaw', 0)
    await vp.evaluate(() => { window.__viewer.view.spin = false })
    const state = () => vp.evaluate(() => ({ q: window.__viewer.holder.quaternion.toArray(), camera: window.__viewer.camera.quaternion.toArray(), tracks: [...window.__viewer.seats.values()].map(s => ({ track: s.track && { gen: s.track.gen, q0: s.track.q0, at: s.track.quat0.toArray() }, selected: s.hand.selected?.key })) }))
    for (const mode of ['rotate', 'track']) {
      await p.page.locator(`.modes [data-tab=${mode}]`).click(); await clear(p.page)
      await move(p, hold, 'yaw', 0)
      if (mode === 'rotate') await p.page.locator('#gyro').click()
      else await held(p, true)
      if (mode === 'track') await until('viewer hand anchored', async () => (await state()).tracks.some(s => s.track))
      await wait(250); const initial = await state()
      for (const axis of ['yaw', 'pitch', 'roll']) for (const deg of [-30, 30]) await check(`viewer ${mode}: ${axis} ${deg}`, async () => {
        await move(p, hold, axis, deg)
        const camera = new Quaternion(...initial.camera)
        const expected = camera.clone().multiply(delta(axis, deg)).multiply(camera.clone().invert()).multiply(new Quaternion(...initial.q))
        await until('viewer rotation', async () => errorDegrees((await state()).q, expected) < 0.15).catch(async e => {
          throw new Error(`${e.message}; initial ${JSON.stringify(initial)}; actual ${JSON.stringify(await state())}; expected ${JSON.stringify(expected.toArray())}`)
        })
      })
      if (mode === 'track') await held(p, false)
    }
    await vp.screenshot({ path: join(out, 'viewer.png') })
  } finally { await p.context.close(); await vc.close() }
  }

  if (!only || only === 'sim') for (const hold of holds) {
    const p = await phone(hold, `${local.origin}/sim/device/?d=gimbal&test=vr`)
    try {
      await p.page.waitForFunction(() => window.__presence?.experience.rides().length)
      await move(p, hold, 'yaw', 0)
      // Into first person as a person holding the phone gets there: the quick-actions tray's camera (the Controls
      // window with its own First person button starts docked on a phone).
      await trayCamera(p.page, (page) => page.evaluate(() => window.__presence.state().mode === 'first-person'), { touch: true })
      const q0 = await p.page.evaluate(() => window.__presence.experience.camera.quaternion.toArray())
      for (const axis of ['yaw', 'pitch', 'roll']) await check(`sim first person ${hold.name}: ${axis}`, async () => {
        await move(p, hold, axis, 30)
        const expected = delta(axis, 30).multiply(new Quaternion(...q0))
        await until('camera axes follow phone axes', async () => errorDegrees(await p.page.evaluate(() => window.__presence.experience.camera.quaternion.toArray()), expected) < 0.15)
        await p.page.screenshot({ path: join(out, `sim-${hold.name}-${axis}.png`) })
      })
      await check(`sim first person ${hold.name}: recenter uses the stationary reading`, async () => {
        await move(p, hold, 'roll', 0)
        await p.page.getByRole('button', { name: 'Recenter', exact: true }).click()
        await move(p, hold, 'roll', 30)
        await until('recentered camera', async () => errorDegrees(await p.page.evaluate(() => window.__presence.experience.camera.quaternion.toArray()), delta('roll', 30)) < 0.15)
      })
    } catch (e) {
      rows.push({ name: `sim first person ${hold.name}: setup failure`, error: e.message, layout: await p.page.evaluate(() => {
        const rect = el => { const b = el?.getBoundingClientRect(); return b && { x: b.x, y: b.y, width: b.width, height: b.height } }
        const camera = document.querySelector('[data-quick="camera"]'), b = camera?.getBoundingClientRect()
        const chip = document.querySelector('.obpal-chip')?.shadowRoot
        const panel = document.querySelector('.quick-panel')
        return { camera: rect(camera), tray: rect(panel), shown: panel?.dataset.shown, seal: rect(chip?.querySelector('.pill')), card: rect(chip?.querySelector('.card')), open: chip?.querySelector('.wrap')?.hasAttribute('data-open'), hit: b && document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.outerHTML }
      }).catch(() => null) })
      await p.page.screenshot({ path: join(out, `sim-${hold.name}-setup-failure.png`) }).catch(() => {})
      throw e
    } finally { await p.context.close() }
  }
  await check('no browser exceptions', () => { if (errors.length) throw new Error(errors.join(' | ')) })
} finally {
  await writeFile(join(out, 'measurements.json'), JSON.stringify(rows, null, 2))
  await browser.close(); await local.close()
}
console.log(`Evidence: ${out}`)
console.log(`passed ${results.filter(Boolean).length}/${results.length}`)
process.exitCode = results.every(Boolean) ? 0 : 1

} finally { await temps.cleanup() }
