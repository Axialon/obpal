/** Rendered control directions, solid clearance and view lifecycle. All evidence goes to a temporary folder. */
import { tempScope } from './lib/temp.mjs'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, devices } from 'playwright'
import { fakeXR } from './e2e-vr.mjs'

const cases = ['rover', 'drone', 'arm-arm5', 'arm-so101', 'ptz', 'airhockey', 'studio', 'dog']
export async function runControlViews(local, check) {
  const temps = tempScope()
  try {
  const out = await temps.make(join(tmpdir(), 'obpal-control-views-')), measurements = []
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--ignore-certificate-errors'] })
  try {
    for (const id of cases) for (const mode of ['overview', 'first-person', 'xr']) {
      await check(`Views: ${id} ${mode} moves screen right, clears solids and keeps the horizon`, async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } })
        await context.addInitScript(fakeXR)
        const page = await context.newPage(), errors = []
        page.on('pageerror', e => errors.push(e.message))
        try {
          const path = id.startsWith('arm-') ? `/sim/arm/?kind=${id.slice(4)}` : `/sim/device/?d=${id}`
          await page.goto(`${local.origin}${path}&test=vr`)
          await page.waitForFunction(() => window.__presence?.experience.rides().length && window.__sim)
          await page.waitForTimeout(300)
          await page.evaluate(async ({ id, mode }) => {
            const e = window.__presence.experience, d = window.__device
            if (id === 'studio') e.ride = 'studio5'
            if (id === 'drone') Object.assign(d.logic.drones[0], { y: 1.2, phase: 'flying' })
            if (mode === 'overview') {
              const cam = e.overview, target = d?.stage.controls.target ?? cam.position.clone().set(0, 0.5, 0)
              const offset = cam.position.clone().sub(target); offset.x *= -1; offset.z *= -1
              cam.position.copy(target).add(offset); cam.lookAt(target)
              d?.stage.controls.update()
              if (window.__arm) window.__arm.view(cam.position.toArray(), target.toArray())
            } else if (mode === 'xr') { await e.enterXR(); e.drive = true; window.__xrSession.setInput() }
            else e.setMode('first-person')
          }, { id, mode })
          await page.waitForTimeout(250)
          if (mode === 'xr') {
            await page.evaluate(() => window.__presence.experience.renderer.xr.getController(0).dispatchEvent({ type: 'selectstart' }))
            await page.waitForTimeout(60)
            assert.equal(await page.evaluate(() => window.__presence.state().people.find(p => p.id === 'host')?.grab), false, 'drive trigger also grabbed a shared prop')
            await page.evaluate(() => window.__presence.experience.renderer.xr.getController(0).dispatchEvent({ type: 'selectend' }))
          }
          await page.evaluate(id => {
            const e = window.__presence.experience, cam = e.activeCamera
            const v = (x = 0, y = 0, z = 0) => cam.position.clone().set(x, y, z)
            const fixed = cam.clone(); fixed.position.copy(cam.getWorldPosition(v())); fixed.quaternion.copy(cam.getWorldQuaternion(cam.quaternion.clone())); fixed.updateMatrixWorld(true)
            window.__viewTest = {
              fixed,
              point() {
                if (window.__arm) return v().fromArray(window.__arm.toolPosition('a1'))
                if (id === 'studio') return e.scene.getObjectByName('instrument-cursor-4').getWorldPosition(v())
                const l = window.__device.logic, u = (l.units || l.drones || l.rovers || l.cams)[0]
                if (id === 'ptz') return v().fromArray(u.at).add(v(-Math.sin(u.pan) * Math.cos(u.tilt), Math.sin(u.tilt), -Math.cos(u.pan) * Math.cos(u.tilt)).multiplyScalar(3))
                // Cockpit movement is measured using a point two metres along the body's nose.
                // The body itself is behind the eye; the fixed pre-input camera avoids cancelling its own travel.
                if (id === 'rover' || id === 'dog' || id === 'drone') {
                  const nose = e.mode === 'overview' ? 0 : 2
                  return v(u.x - Math.sin(u.h ?? u.yaw) * nose, (u.y ?? 0) + (id === 'dog' ? 0.98 : id === 'rover' ? 0.58 : 0.16), u.z - Math.cos(u.h ?? u.yaw) * nose)
                }
                return v(u.x, 1.02, u.z)
              },
            }
            window.__viewTest.before = window.__viewTest.point().project(fixed).toArray()
          }, id)
          const beforeProbe = await page.evaluate(() => window.__presence.probe())
          const axes = id === 'drone' || id === 'ptz' ? [0, 0, 0.55, 0] : id === 'rover' || id === 'dog' ? [0.55, -0.65, 0, 0] : [0.55, 0, 0, 0]
          if (mode === 'xr' && id.startsWith('arm-')) {
            const still = await page.evaluate(axes => { window.__xrSession.setInput(axes); return window.__arm.toolPosition('a1') }, axes)
            await page.waitForTimeout(180)
            const next = await page.evaluate(() => window.__arm.toolPosition('a1'))
            assert(Math.hypot(...next.map((v, n) => v - still[n])) < 0.001, 'XR sticks moved the arm without its deadman')
          }
          await page.evaluate(({ mode, axes, id }) => {
            const e = window.__presence.experience, shared = window.__presence.shared
            const pad = { axes, triggers: id.startsWith('arm-') ? [0.8, 0] : [0, 0], buttons: 0 }
            if (mode === 'xr') window.__xrSession.setInput(pad.axes, pad.triggers)
            else if (mode === 'overview' && window.__device) {
              const d = window.__device, n = id === 'studio' ? 4 : 0
              const input = { face: 'face.gamepad', mode: 5, pad, padPressed: 0, touching: false, drag: [0, 0], pan: [0, 0], pinch: 0, twist: 0, tilt: [0, 0], hold: null, point: null, spot: null, pose: null, held: new Set(), presses: [], wheel: 0, text: '', del: 0, values: [], recentred: false }
              for (let k = 0; k < 40; k++) { const inputs = []; inputs[n] = d.mapInput(input, n); d.logic.step(inputs, 1 / 60) }
            } else {
              const send = () => {
                const s = window.__presence.state(), ride = e.rides().find(r => r.id === e.ride)
                shared.input({ ride: e.ride, active: true, head: { p: mode === 'overview' ? ride.pose().p.toArray() : s.camera.p, q: s.camera.q }, hands: [], grab: false, pad }, performance.now())
              }
              send(); window.__viewInput = setInterval(send, 25)
            }
          }, { mode, axes, id })
          await page.waitForTimeout(mode === 'overview' && !id.startsWith('arm-') ? 100 : 650)
          const result = await page.evaluate(() => {
            clearInterval(window.__viewInput)
            window.__xrSession?.setInput()
            const t = window.__viewTest
            return { before: t.before, after: t.point().project(t.fixed).toArray(), state: window.__arm?.arms() }
          })
          const afterProbe = await page.evaluate(() => window.__presence.probe())
          measurements.push({ id, mode, ...result, beforeProbe, afterProbe })
          await page.screenshot({ path: join(out, `${id}-${mode}.png`) })
          assert(result.after[0] - result.before[0] > 0.0003, `right input projected ${JSON.stringify(result)}`)
          for (const probe of [beforeProbe, afterProbe]) {
            assert.deepEqual(probe.inside, [], `eye inside solid at ${probe.position}`)
            assert(Math.abs(probe.rightY) < 0.001, `horizon roll ${probe.rightY}`)
            assert(probe.clearance > 0.015, `near-plane clearance ${probe.clearance}`)
          }
          if (mode !== 'overview') {
            if (mode === 'xr' && id.startsWith('arm-')) {
              await page.waitForTimeout(250)
              const stopped = await page.evaluate(() => window.__arm.toolPosition('a1'))
              await page.waitForTimeout(150)
              const next = await page.evaluate(() => window.__arm.toolPosition('a1'))
              assert(Math.hypot(...next.map((v, n) => v - stopped[n])) < 0.002, 'arm continued after trigger release')
            }
            await page.evaluate(() => { window.__presence.experience.drive = false })
            if (mode === 'first-person') await page.keyboard.press('v')
            else await page.evaluate(() => { window.__xrSession.inputSources[0].gamepad.buttons[4].pressed = true })
            await page.waitForTimeout(150)
            assert.equal(await page.evaluate(() => window.__presence.state().viewpoint), 1)
            const second = await page.evaluate(() => window.__presence.probe())
            measurements.push({ id, mode, second })
            assert.deepEqual(second.inside, [], 'second viewpoint inside a solid')
            assert(Math.abs(second.rightY) < 0.001, 'second viewpoint rolls')
            if (id.startsWith('arm-')) {
              const tool = await page.evaluate(() => { const c = window.__presence.experience.activeCamera; return c.position.clone().fromArray(window.__arm.toolPosition('a1')).project(c).toArray() })
              assert(Math.abs(tool[0]) < 1 && Math.abs(tool[1]) < 1 && Math.abs(tool[2]) < 1, `wrist view lost its gripper: ${tool}`)
            }
            await page.evaluate(() => { const e = window.__presence.experience; e.snap(1); e.recenter() })
            assert.equal(await page.evaluate(() => window.__presence.experience.look.turn), 0)
            if (mode === 'xr') {
              await page.evaluate(() => { Object.assign(window.__xrHead, { x: 0.2, y: 1.25, z: 0.1, yaw: 0.6 }); window.__presence.experience.recenter() })
              await page.waitForTimeout(100)
              const originError = await page.evaluate(() => {
                const e = window.__presence.experience, r = e.rides().find(r => r.id === e.ride), target = r.views[e.look.viewpoint].pose()
                return e.activeCamera.getWorldPosition(target.p.clone()).distanceTo(target.p)
              })
              assert(originError < 0.1, `XR recenter missed its ride origin by ${originError}`)
            }
            await page.evaluate(() => window.__presence.experience.leave())
            assert.equal(await page.evaluate(() => window.__presence.state().mode), 'overview')
          }
          assert.deepEqual(errors, [])
          return `screen Δx ${(result.after[0] - result.before[0]).toFixed(4)}`
        } finally { await context.close() }
      })
    }
    for (const [mode, phone] of [['first-person', false], ['first-person', true], ['xr', false]]) await check(`Views: excavator ${phone ? 'phone' : 'desktop'} ${mode} keeps the full bucket swing visible`, async () => {
      const context = await browser.newContext({ ...(phone ? devices['Pixel 7'] : { viewport: { width: 1280, height: 800 } }), ignoreHTTPSErrors: true })
      await context.addInitScript(fakeXR)
      try {
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/device/?d=excavator&test=vr`)
        await page.waitForFunction(() => window.__presence?.experience.rides().length && window.__device)
        await page.evaluate(async mode => { const e = window.__presence.experience; if (mode === 'xr') await e.enterXR(); else e.setMode(mode) }, mode)
        await page.waitForTimeout(250)
        const samples = await page.evaluate(async () => {
          const e = window.__presence.experience, u = window.__device.logic.units[0], samples = []
          const stick = e.scene.getObjectByName('stickSkin').parent
          const bucket = stick.children.find(o => o.isGroup && o.position.z < -1)
          for (let n = 0; n < 24; n++) {
            Object.assign(u, { swing: n * Math.PI / 12, boom: 0.65, stick: -0.1 })
            await new Promise(r => setTimeout(r, 40))
            const point = bucket.localToWorld(bucket.position.clone().set(0, -0.25, -0.15)).project(e.activeCamera).toArray()
            if (e.mode === 'first-person') {
              const x = (point[0] + 1) * innerWidth / 2, y = (1 - point[1]) * innerHeight / 2
              const panel = document.querySelector('.presence-controls').getBoundingClientRect()
              if (x > panel.left && x < panel.right && y > panel.top && y < panel.bottom) throw new Error(`Viewpoint panel covers the bucket at ${x}, ${y}`)
            }
            samples.push({ point, probe: await window.__presence.probe() })
          }
          return samples
        })
        measurements.push({ id: 'excavator', mode, phone, samples })
        for (const { point, probe } of samples) {
          assert(point.every(v => Math.abs(v) < 1), `bucket outside the operator view: ${point}`)
          assert.deepEqual(probe.inside, [])
          assert(Math.abs(probe.rightY) < 0.001)
        }
        await page.screenshot({ path: join(out, `excavator-${phone ? 'phone' : 'desktop'}-${mode}-swing.png`) })
        if (mode === 'first-person') {
          await page.getByRole('button', { name: 'Options', exact: true }).click()
          assert(await page.getByLabel('Horizon lock', { exact: true }).isVisible())
          assert(await page.getByLabel('Drive with XR sticks', { exact: true }).isVisible())
          await page.getByRole('button', { name: 'Options', exact: true }).click()
          assert(await page.getByRole('button', { name: 'Recenter', exact: true }).isVisible())
        }
      } finally { await context.close() }
    })
    await check('Views: portrait studio seat includes both edges of the drum kit', async () => {
      const context = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/device/?d=studio&test=vr`)
        await page.waitForFunction(() => window.__presence?.experience.rides().length)
        await page.evaluate(() => window.__presence.experience.setMode('first-person'))
        await page.waitForTimeout(150)
        const edges = await page.evaluate(() => {
          const c = window.__presence.experience.activeCamera
          return [[-1.98, 0.98, -1.4], [0.5, 1.29, -2.08]].map(p => c.position.clone().fromArray(p).project(c).toArray())
        })
        assert(edges.every(p => p.every(v => Math.abs(v) < 1)), `portrait cropped the cymbals: ${JSON.stringify(edges)}`)
        measurements.push({ id: 'studio', mode: 'first-person', phone: true, edges })
        await page.screenshot({ path: join(out, 'studio-portrait-kit.png') })
      } finally { await context.close() }
    })
    await check('Views: orbiting behind a slot car keeps the following overview clear of the gantry', async () => {
      const context = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage()
        await page.goto(`${local.origin}/sim/device/?d=slotcars&test=vr`)
        await page.waitForFunction(() => window.__presence?.experience.rides().length && window.__device)
        await page.waitForTimeout(200)
        await page.evaluate(() => {
          window.__sim.chip.collapse()
          const d = window.__device, c = d.stage.camera, target = d.stage.controls.target
          const offset = c.position.clone().sub(target); offset.x *= -1; offset.z *= -1
          c.position.copy(target).add(offset); c.lookAt(target); d.stage.controls.update()
        })
        const samples = []
        for (const x of [-0.2, 0.1, 0.5, 1]) {
          await page.evaluate(x => { const u = window.__device.logic.units[0]; Object.assign(u, { s: x + 4, x, v: 0 }) }, x)
          await page.waitForTimeout(80)
          const probe = await page.evaluate(() => window.__presence.probe())
          const sightline = await page.evaluate(() => {
            const p = window.__device.stage.camera.position, u = window.__device.logic.units[0]
            const t = -p.z / (u.z - p.z)
            return p.y + (u.y + 0.17 - p.y) * t
          })
          samples.push(probe)
          assert(probe.position[1] > 1.55, `overview followed through the gantry height: ${probe.position}`)
          assert(sightline > 1.55, `gantry obscures the car at sightline height ${sightline}`)
          assert.deepEqual(probe.inside, [])
          assert(probe.clearance > 0.015)
        }
        measurements.push({ id: 'slotcars', mode: 'overview', phone: true, samples })
        await page.screenshot({ path: join(out, 'slotcars-portrait-orbit.png') })
      } finally { await context.close() }
    })
    await check('Views: phone motion control holds look and rebases without a jump', async () => {
      const context = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage()
        await page.addInitScript(() => { Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { value: async () => 'granted' }) })
        await page.goto(`${local.origin}/sim/device/?d=claw&test=vr`)
        await page.waitForFunction(() => window.__presence?.experience.rides().length)
        const controls = page.locator('[data-panel-toggle="controls"]'); await controls.focus(); await controls.click()
        await page.getByRole('button', { name: 'First person', exact: true }).click()
        const sample = await page.evaluate(async () => {
          const e = window.__presence.experience, send = alpha => dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha, beta: 70, gamma: 0 }))
          send(10); await new Promise(r => setTimeout(r, 50)); const a = window.__presence.state().camera.q
          e.motionControl(true); send(65); await new Promise(r => setTimeout(r, 50)); const b = window.__presence.state().camera.q
          await new Promise(r => setTimeout(r, 200)); send(65); await new Promise(r => setTimeout(r, 50)); const c = window.__presence.state().camera.q
          return [a, b, c]
        })
        assert(sample[0].every((v, n) => Math.abs(v - sample[1][n]) < 0.001), 'look fought the active motion controller')
        assert(sample[1].every((v, n) => Math.abs(v - sample[2][n]) < 0.001), 'look jumped on release')
      } finally { await context.close() }
    })
  } finally {
    await writeFile(join(out, 'measurements.json'), JSON.stringify(measurements, null, 2))
    await browser.close(); console.log(`  View evidence: ${out}`)
  }

  } finally { await temps.cleanup() }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { startLocal } = await import('../extension/e2e/local.mjs')
  const local = await startLocal(); let total = 0, failed = 0
  try { await runControlViews(local, async (name, fn) => { total++; try { const detail = await fn(); console.log(`PASS ${name}${detail ? ` (${detail})` : ''}`) } catch (e) { failed++; console.error(`FAIL ${name}: ${e.stack}`) } }) }
  finally { await local.close() }
  console.log(failed ? `FAILED ${failed}/${total}` : `passed ${total}/${total}`); process.exitCode = failed ? 1 : 0
}
