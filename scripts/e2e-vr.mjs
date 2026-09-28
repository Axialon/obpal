/** Presence proof on this checkout's local service. Evidence is always written to a temporary directory. */
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, devices } from 'playwright'

function fakeXR() {
  const matrix = (x = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]
  const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.020002, 0]
  class Session extends EventTarget {
    renderState = { depthNear: 0.01, depthFar: 100, baseLayer: null }
    inputSources = []
    enabledFeatures = []
    environmentBlendMode = 'opaque'
    visibilityState = 'visible'
    supportedFrameRates = new Float32Array([72, 90])
    frameRate = 72
    ended = false
    updateRenderState(state) { Object.assign(this.renderState, state) }
    requestReferenceSpace() { return Promise.resolve({}) }
    updateTargetFrameRate(hz) { this.frameRate = hz; return Promise.resolve() }
    requestAnimationFrame(callback) {
      return requestAnimationFrame(time => { if (!this.ended) callback(time, { session: this, getViewerPose: () => ({ views: [-0.032, 0.032].map(x => ({ eye: x < 0 ? 'left' : 'right', transform: { matrix: matrix(x) }, projectionMatrix: projection })) }), getPose: () => null }) })
    }
    cancelAnimationFrame(id) { cancelAnimationFrame(id) }
    end() { this.ended = true; this.dispatchEvent(new Event('end')); return Promise.resolve() }
  }
  Object.defineProperty(window, 'XRWebGLBinding', { configurable: true, value: undefined })
  Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported: async mode => mode === 'immersive-vr', requestSession: async () => { window.__xrSession = new Session(); return window.__xrSession } } })
  WebGL2RenderingContext.prototype.makeXRCompatible = async () => {}
  window.XRWebGLLayer = class {
    framebuffer = null
    framebufferWidth = 800
    framebufferHeight = 600
    fixedFoveation = 0
    getViewport(view) { return { x: view.eye === 'left' ? 0 : 400, y: 0, width: 400, height: 600 } }
  }
}

export async function runVR(local, check) {
  const out = await mkdtemp(join(tmpdir(), 'obpal-vr-'))
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors'] })
  const errors = []
  const makePage = async (options = {}) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, ...options })
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); return page
  }
  const ready = page => page.waitForFunction(() => window.__presence && window.__presence.experience.rides().length, { timeout: 20000 })
  const state = page => page.evaluate(() => window.__presence.state())
  try {
    const host = await makePage()
    await host.goto(`${local.origin}/sim/device/?d=drone&test=vr`)
    await ready(host)
    await host.waitForFunction(() => window.__obpal?.pairingUrl)
    await check('VR: desktop first person follows the drone and returns to overview', async () => {
      await host.screenshot({ path: join(out, 'drone-before.png') })
      const before = await host.evaluate(() => window.__device.stage.camera.position.toArray())
      await host.getByRole('button', { name: 'First person', exact: true }).click()
      assert.equal((await state(host)).mode, 'first-person')
      await host.waitForFunction(() => {
        const listener = window.__simAudio?.context?.listener, p = window.__presence.state().camera.p
        return listener && Math.hypot(listener.positionX.value - p[0], listener.positionY.value - p[1], listener.positionZ.value - p[2]) < 0.03
      })
      assert(await host.locator('.presence-controls #sim-sound').isVisible(), 'sound remains accessible in first person')
      const q = (await state(host)).camera.q
      await host.mouse.move(550, 500); await host.mouse.down(); await host.mouse.move(680, 500); await host.mouse.up()
      assert.notDeepEqual((await state(host)).camera.q, q)
      await host.getByRole('button', { name: 'Overview', exact: true }).filter({ visible: true }).last().click()
      assert.equal((await state(host)).mode, 'overview')
      assert.deepEqual(await host.evaluate(() => window.__device.stage.camera.position.toArray()), before)
    })
    const guest = await makePage()
    const invite = await host.evaluate(() => window.__presence.shared.shareUrl())
    const url = new URL(invite); url.searchParams.set('test', 'vr')
    await guest.goto(url.href); await ready(guest)
    await check('VR: two authenticated participants share a drone-cone collision', async () => {
      await guest.waitForFunction(() => window.__presence.state().status === 'Shared scene', { timeout: 20000 })
      const visitor = await guest.evaluate(() => window.__presence.shared.id)
      assert.equal(await host.evaluate(id => window.__sim.claims.held(id), visitor), undefined, 'watching does not take a device claim')
      await guest.getByRole('button', { name: 'First person', exact: true }).click()
      // Start a real simulated flight toward the existing shared cone. Only the host changes its simulation.
      await host.evaluate(() => {
        const d = window.__device.logic.drones[0], cone = window.__presence.shared.world.bodies[0]
        Object.assign(d, { x: cone.p[0], y: 0.28, z: cone.p[2] + 0.4, vz: -1, phase: 'flying' })
      })
      await host.waitForFunction(() => Math.abs(window.__presence.shared.world.bodies[0].v[2]) > 0.01)
      await guest.waitForFunction(() => Math.abs(window.__presence.shared.world.bodies[0].v[2]) > 0.01)
      const a = await state(host), b = await state(guest)
      assert(Math.abs(a.bodies[0].p[2] - b.bodies[0].p[2]) < 0.4)
      assert.equal(b.mode, 'first-person')
      await host.screenshot({ path: join(out, 'shared-host.png') }); await guest.screenshot({ path: join(out, 'shared-guest.png') })
    })
    await check('VR: a remote grab and throw is authoritative on both screens', async () => {
      await host.evaluate(() => {
        const d = window.__device.logic.drones[0]; Object.assign(d, { vx: 0, vy: 0, vz: 0, phase: 'landed' })
        const b = window.__presence.shared.world.bodies[1]
        b.p = [d.x, 0.16, d.z - 0.8]; b.v = [0, 0, 0]
      })
      await guest.waitForTimeout(150)
      await guest.getByRole('button', { name: 'Grab / release', exact: true }).click()
      await host.waitForFunction(() => window.__presence.shared.world.bodies.some(b => b.owner && b.owner !== 'host'))
      await guest.waitForFunction(() => window.__presence.shared.world.bodies.some(b => b.owner))
      await guest.mouse.move(560, 450); await guest.mouse.down(); await guest.mouse.move(620, 420, { steps: 12 }); await guest.mouse.up()
      await guest.getByRole('button', { name: 'Grab / release', exact: true }).click()
      await host.waitForFunction(() => window.__presence.shared.world.bodies.every(b => !b.owner))
      await guest.waitForFunction(() => window.__presence.shared.world.bodies.every(b => !b.owner))
    })
    await check('VR: a second scene visitor has its own coloured presence', async () => {
      const other = await makePage(); await other.goto(url.href); await ready(other)
      await other.getByRole('button', { name: 'First person', exact: true }).click()
      await guest.waitForFunction(() => window.__presence.state().people.filter(p => p.id !== 'host' && p.active).length === 2)
      const p = (await state(guest)).people.filter(p => p.id !== 'host')
      assert.equal(new Set(p.map(p => p.color)).size, 2)
      await guest.screenshot({ path: join(out, 'two-participants.png') }); await other.context().close()
    })
    await check('VR: shared wrist rigs retain their identity when an arm is removed and re-added', async () => {
      const screen = await makePage(); await screen.goto(`${local.origin}/sim/arm/?test=vr`); await ready(screen)
      await screen.waitForFunction(() => window.__obpal?.pairingUrl)
      const invite = new URL(await screen.evaluate(() => window.__presence.shared.shareUrl())); invite.searchParams.set('test', 'vr')
      const peer = await makePage(); await peer.goto(invite.href); await ready(peer)
      await peer.waitForFunction(() => window.__presence.state().status === 'Shared scene')
      await peer.getByRole('button', { name: 'First person', exact: true }).click()
      await screen.evaluate(() => window.__arm.removeArm('a1'))
      await peer.waitForFunction(() => window.__presence.experience.rides().map(r => r.id).join() === 'a2')
      const hostPose = await screen.evaluate(() => window.__presence.experience.rides()[0].pose().p.toArray())
      const peerPose = await peer.evaluate(() => window.__presence.experience.rides()[0].pose().p.toArray())
      assert(hostPose.every((v, i) => Math.abs(v - peerPose[i]) < 0.01))
      await screen.evaluate(() => window.__arm.addArm())
      await peer.waitForFunction(() => window.__presence.experience.rides().map(r => r.id).join() === 'a1,a2')
      await peer.getByRole('button', { name: 'Stop arms', exact: true }).click()
      await screen.waitForFunction(() => !!window.__arm.stopped())
      await peer.context().close(); await screen.context().close()
    })
    await check('VR: an emulated immersive session enters, renders both eyes and exits', async () => {
      const page = await makePage(); await page.context().addInitScript(fakeXR)
      await page.goto(`${local.origin}/sim/device/?d=rover&test=vr`); await ready(page)
      await page.getByRole('button', { name: 'Enter VR', exact: true }).click()
      await page.waitForFunction(() => window.__presence.experience.renderer.xr.isPresenting)
      await page.waitForFunction(() => window.__presence.experience.renderer.xr.getCamera().cameras.length === 2)
      await page.waitForFunction(() => window.__presence.state().fps > 0)
      const measurement = await page.evaluate(() => ({ requestedHz: window.__xrSession.frameRate, observedHz: window.__presence.state().fps, foveation: window.__presence.experience.renderer.xr.getFoveation() }))
      await writeFile(join(out, 'xr-cadence.json'), JSON.stringify(measurement, null, 2))
      await page.getByRole('button', { name: 'Overview', exact: true }).filter({ visible: true }).last().click()
      await page.waitForFunction(() => !window.__presence.experience.renderer.xr.isPresenting && window.__presence.state().mode === 'overview')
      await page.context().close()
      return `requested ${measurement.requestedHz} Hz; software cadence ${measurement.observedHz.toFixed(1)} Hz, not headset performance`
    })
    await check('VR: phone gyro changes only the first-person look; Overview remains one tap away', async () => {
      const page = await makePage(devices['Pixel 7'])
      await page.context().addInitScript(() => { Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: async () => 'granted' }) })
      await page.goto(`${local.origin}/sim/device/?d=kart&test=vr`); await ready(page)
      await page.getByRole('button', { name: 'First person', exact: true }).click()
      await page.evaluate(() => dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 10, beta: 70, gamma: 0 })))
      const before = (await state(page)).camera.q
      await page.evaluate(() => dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 45, beta: 70, gamma: 0 })))
      await page.waitForTimeout(80); assert.notDeepEqual((await state(page)).camera.q, before)
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(out, 'phone-first-person.png') })
      await page.getByRole('button', { name: 'Overview', exact: true }).filter({ visible: true }).last().click()
      assert.equal((await state(page)).mode, 'overview'); await page.context().close()
    })
    await guest.context().close(); await host.context().close()
    const captures = [['drone', '/sim/device/?d=drone'], ['rover', '/sim/device/?d=rover'], ['arm-wrist', '/sim/arm/?kind=arm5'], ['kart', '/sim/device/?d=kart'], ['submarine', '/sim/device/?d=submarine'], ['helicopter', '/sim/device/?d=helicopter']]
    await check('VR: six first-person captures have live rigs and an overview exit', async () => {
      for (const [name, path] of captures) {
        const page = await makePage(); await page.goto(`${local.origin}${path}&test=vr`); await ready(page)
        await page.screenshot({ path: join(out, `${name}-before.png`) })
        await page.getByRole('button', { name: 'First person', exact: true }).click(); await page.waitForTimeout(200)
        assert.equal((await state(page)).mode, 'first-person')
        await page.screenshot({ path: join(out, `${name}-after.png`) }); await page.context().close()
      }
    })
    await writeFile(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Shared sims · presence evidence</title><style>body{font:16px system-ui;background:#141923;color:#eee;margin:32px}section{margin:36px 0}img{width:48%;vertical-align:top}a{color:#c7baff}</style><h1>Shared sims · first person and VR</h1><p>Software browser evidence; hardware comfort and headset frame rate are not measured.</p>${captures.map(([name]) => `<section><h2>${name}</h2><img src="${name}-before.png" alt="${name} overview"><img src="${name}-after.png" alt="${name} first person"></section>`).join('')}<section><h2>Two participants</h2><img src="shared-host.png"><img src="shared-guest.png"><img src="two-participants.png"><img src="phone-first-person.png"></section><a href="xr-cadence.json">Emulated XR cadence</a>`)
    await check('VR: no browser errors', () => assert.deepEqual(errors, []))
  } finally { await browser.close(); console.log(`  VR evidence: ${out}`) }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { startLocal } = await import('../extension/e2e/local.mjs')
  const local = await startLocal()
  let total = 0, failed = 0
  try { await runVR(local, async (name, fn) => { total++; try { const detail = await fn(); console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`) } catch (e) { failed++; console.error(`  ✗ ${name}: ${e.stack}`) } }) }
  finally { await local.close() }
  console.log(failed ? `FAILED ${failed}/${total}` : `passed ${total}/${total}`); process.exitCode = failed ? 1 : 0
}
