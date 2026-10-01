/** Humanoid practice, BODY and personal range calibration in Chromium. Evidence is always temporary. */
import { tempScope } from './lib/temp.mjs'
import { chromium, devices } from 'playwright'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cspCheck } from './csp-watch.mjs'
import { modelProof } from './humanoid-model-proof.mjs'
import { tendonProof } from './humanoid-tendon-proof.mjs'
import { softProof } from './humanoid-soft-proof.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const assert = (ok, message) => {
  if (!ok) throw new Error(message)
}
const panel = (page) => page.locator('.sim-window[data-panel="controls"]')
async function controls(page) {
  if (!(await panel(page).isVisible())) {
    const toggle = page.locator('[data-panel-toggle="controls"]')
    await toggle.focus()
    await toggle.click()
  }
}
async function until(read, ms = 10000, label = 'humanoid state') {
  const end = Date.now() + ms
  do {
    const v = await read()
    if (v) return v
    await sleep(60)
  } while (Date.now() < end)
  throw new Error(`Timed out waiting for ${label}`)
}

/** An independent synthetic landmark producer. No robot angle setter bypasses the capture/retarget path. */
export function installFixture() {
  const h = window.__humanoid,
    p = h.actors[0].rig.profile,
    root = h.actors[0].rig.root
  const V = root.position.constructor,
    Q = root.quaternion.constructor
  window.fixture = { angles: {}, loss: [], gen: 1, enabled: true, two: false, animate: false, seq: 0 }
  window.fixtureBody = () => {
    const f = window.fixture,
      q = { ...f.angles },
      fk = new Map()
    if (f.animate) {
      const t = performance.now() / 1000
      q['left.arm.pitch'] = 0.7 + 0.35 * Math.sin(t)
      q['left.arm.elbow'] = 0.8 + 0.4 * Math.sin(t * 1.5)
      q['right.leg.pitch'] = 0.4 + 0.2 * Math.sin(t)
      q['right.leg.knee'] = 0.5 + 0.2 * Math.sin(t)
    }
    for (const j of p.joints) {
      const parent = fk.get(j.parent),
        r = parent?.q.clone() ?? new Q(),
        point = new V(...j.offset).applyQuaternion(r).add(parent?.p ?? new V())
      r.multiply(new Q().setFromAxisAngle(new V(...j.axis), q[j.id] ?? 0))
      fk.set(j.id, { p: point, q: r })
    }
    const hip = fk.get(p.root).p,
      landmarks = Array.from({ length: 33 }, () => [0, 0, 0])
    const at = (id, offset = [0, 0, 0]) =>
      new V(...offset).applyQuaternion(fk.get(id).q).add(fk.get(id).p).sub(hip).toArray()
    for (const c of p.chains) {
      landmarks[c.points[0]] = at(c.joints[0])
      landmarks[c.points[1]] = at(c.joints[3])
      landmarks[c.points[2]] = at(c.end)
      if (c.group === 'arms') {
        landmarks[c.tips[0]] = at(c.end, [-0.025, -0.1, 0])
        landmarks[c.tips[1]] = at(c.end, [0.025, -0.1, 0])
      } else {
        landmarks[c.tips[0]] = at(c.end, [0, -0.05, 0.09])
        landmarks[c.tips[1]] = at(c.end, [0, -0.05, -0.18])
      }
    }
    landmarks[0] = at(p.frame.head[1], [0, 0.08, -0.12])
    landmarks[7] = at(p.frame.head[1], [-0.08, 0.08, 0])
    landmarks[8] = at(p.frame.head[1], [0.08, 0.08, 0])
    return {
      flags: f.loss.includes(23) ? 0 : 1,
      seq: ++f.seq & 65535,
      t: Math.round(performance.now() * 1000) >>> 0,
      gen: f.gen,
      landmarks,
      visibility: landmarks.map((_, i) => (f.loss.includes(i) ? 0 : 1)),
      presence: landmarks.map((_, i) => (f.loss.includes(i) ? 0 : 1)),
    }
  }
  window.fixtureTimer = setInterval(() => {
    if (window.fixture.enabled) {
      const b = window.fixtureBody()
      h.inject(0, b)
      if (window.fixture.two) h.inject(1, b)
    }
  }, 33)
}

export async function runHumanoid(local, check) {
  const temps = tempScope()
  try {
  const directory = await temps.make(join(tmpdir(), 'obpal-humanoid-'))
  const report = {
    environment: 'PC Chromium; phone viewports are emulated, not physical phones',
    results: [],
    measurements: [],
  }
  const browser = await chromium.launch({
    executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined,
    headless: !process.argv.includes('--headed'),
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--ignore-certificate-errors',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  })
  const contexts = [],
    pageErrors = []
  const run = async (name, fn) =>
    check(`humanoid: ${name}`, async () => {
      try {
        const detail = await fn()
        report.results.push({ name, ok: true, detail })
        return detail
      } catch (e) {
        report.results.push({ name, ok: false, error: e.message })
        throw e
      }
    })
  const open = async (mobile = false, preview = false) => {
    const ctx = await browser.newContext({
      ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 900 } }),
      ignoreHTTPSErrors: true,
    })
    contexts.push(ctx)
    const page = await ctx.newPage(),
      errors = pageErrors
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${local.origin}/sim/humanoid/?test=humanoid${preview ? '&preview=soft' : ''}`)
    await page.waitForFunction(() => window.__humanoid && window.__obpal?.pairingUrl, { timeout: 20000 })
    await page.waitForFunction(() => window.__humanoid.actors.every((a) => a.rig.root.userData.prototype === 'blender'))
    await controls(page)
    return { page, ctx, errors }
  }
  try {
    await run('authored model views in the live renderer', () => modelProof(browser, local.origin, directory))
    await run('soft roster forms and face signatures in the live renderer', () => softProof(browser, local.origin, directory))
    if (process.env.OBPAL_HUMANOID_MODEL_PROOF_ONLY === '1') return
    await run('sim tendon curl and jab yield and settle', () => tendonProof(browser, local.origin, directory))
    if (process.env.OBPAL_HUMANOID_TENDON_PROOF_ONLY === '1') return
    await run('cold, warm, failed and late model loads reveal cleanly at the current pose', async () => {
      for (const mode of ['cold', 'warm', 'failed', 'late']) {
        const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } })
        contexts.push(context)
        if (mode !== 'warm')
          await context.route(/\/models\/(keel|morrow|humanoid-arena)\.glb$/, async (route) => {
            if (mode === 'failed') return route.abort()
            await sleep(mode === 'late' ? 6500 : 1300)
            await route.continue().catch(() => {})
          })
        const p = await context.newPage()
        p.on('pageerror', (e) => pageErrors.push(e.message))
        await p.goto(`${local.origin}/sim/humanoid/?test=load`)
        await p.waitForFunction(() => window.__humanoid && window.__rigs)
        if (mode === 'late') {
          await p.waitForFunction(() =>
            window.__humanoid.actors.every((a) => a.rig.root.visible && a.rig.root.userData.prototype === 'procedural'),
          )
          await p.evaluate(() => window.__humanoid.actors[0].control.play('guard'))
        }
        const wanted = mode === 'failed' ? 'procedural' : 'blender'
        await p.waitForFunction(
          (wanted) =>
            window.__humanoid.actors.every((a) => a.rig.root.visible && a.rig.root.userData.prototype === wanted),
          wanted,
          { timeout: 15000 },
        )
        if (mode === 'cold')
          assert(
            await p.evaluate(() => !window.__loadFrames.some((f) => f.standIn > 0)),
            'Cold load flashed a stand-in',
          )
        if (mode === 'warm') {
          await p.reload()
          await p.waitForFunction(() =>
            window.__humanoid?.actors.every((a) => a.rig.root.userData.prototype === 'blender'),
          )
          assert(
            await p.evaluate(() => !window.__loadFrames.some((f) => f.standIn > 0)),
            'Warm load flashed a stand-in',
          )
        }
        if (mode !== 'failed') {
          await p.waitForFunction(() => window.__humanoid.actors.every((a) => a.rig.root.userData.lods === 2))
          const detail = await p.evaluate(() => {
            const h = window.__humanoid,
              a = h.actors[0],
              V = a.rig.root.position.constructor
            const pose = JSON.stringify(a.control.q)
            a.rig.detail(new V(0, 0, -20))
            const low = a.rig.root.userData.lod
            a.rig.detail(a.rig.root.position.clone())
            const high = a.rig.root.userData.lod
            return { low, high, pose: pose === JSON.stringify(a.control.q) }
          })
          assert(detail.low === 1 && detail.high === 0 && detail.pose, 'LOD altered pose or did not switch')
        }
        await p.screenshot({ path: join(directory, `load-${mode}.png`) })
        await context.close()
      }
      return 'Cold/warm clean reveal; failed fallback; late pose-preserving swap; both LODs'
    })
    const { page, ctx, errors } = await open()
    await run('classical locomotion, six presets, blending and latched Stop need no camera', async () => {
      await page.screenshot({ path: join(directory, 'desktop-before.png') })
      const before = await page.evaluate(() => window.__humanoid.snapshot().actors[0].position)
      await page.keyboard.down('w')
      await sleep(350)
      await page.keyboard.up('w')
      const after = await page.evaluate(() => window.__humanoid.snapshot().actors[0].position)
      assert(
        before.some((n, i) => Math.abs(n - after[i]) > 0.05),
        'Keyboard did not move the root',
      )
      for (const name of ['guard', 'jab', 'cross', 'uppercut', 'block', 'wave']) {
        await page.locator(`[data-move="${name}"]`).click()
        await until(() => page.evaluate((n) => window.__humanoid.snapshot().actors[0].preset === n, name))
      }
      await page.keyboard.down('a')
      await sleep(100)
      await page.keyboard.up('a')
      assert(
        await page.evaluate(() => window.__humanoid.snapshot().actors[0].preset === null),
        'Manual input did not cancel preset',
      )
      await page.locator('[data-move="jab"]').click()
      await page.locator('#estop').click()
      const stopped = await page.evaluate(() => window.__humanoid.snapshot().actors[0])
      await page.locator('[data-move="wave"]').click()
      await sleep(250)
      assert(
        await page.evaluate(
          (q) => JSON.stringify(window.__humanoid.snapshot().actors[0].q) === JSON.stringify(q),
          stopped.q,
        ),
        'Stop moved joints',
      )
      await page.locator('#resume').click()
      assert(!(await page.locator('.obpal-camera').count()), 'Classical play started a camera')
      return 'WASD, all six presets, manual cancellation, Stop and Resume'
    })
    await run('a real preset produces contact feedback and scoring can be disabled', async () => {
      await page.evaluate(() => {
        const h = window.__humanoid
        h.contacts.reset()
        h.actors.forEach((a, i) => {
          a.control.position.set(i ? 0.32 : -0.32, 0, 0)
          a.control.yaw = i ? Math.PI / 2 : -Math.PI / 2
          a.control.preset = null
          for (const id of Object.keys(a.control.q)) a.control.q[id] = 0
        })
      })
      await sleep(500)
      await page.locator('[data-move="jab"]').click()
      await until(() => page.evaluate(() => window.__humanoid.contacts.scores['robot-1'] === 1))
      assert(await page.evaluate(() => window.__simAudio.contacts > 0), 'Contact did not reach the audio/feedback bus')
      await sleep(1100)
      await page.locator('#reset-score').click()
      await page.locator('#scoring').uncheck()
      await page.locator('[data-move="jab"]').click()
      await sleep(900)
      assert(await page.evaluate(() => !window.__humanoid.contacts.scores['robot-1']), 'Free mode scored a hit')
      await page.locator('#scoring').check()
      return 'Swept preset contact, feedback bus and free mode'
    })
    await page.evaluate(installFixture)
    await run('BODY drives arms and legs, mirror resets, occlusion rests and reacquisition works', async () => {
      await page.evaluate(
        () =>
          (window.fixture.angles = {
            'left.arm.pitch': 0.7,
            'left.arm.elbow': 1,
            'left.leg.pitch': 0.6,
            'left.leg.knee': 0.9,
          }),
      )
      await until(() => page.evaluate(() => window.__humanoid.snapshot().actors[0].tracked))
      await sleep(400)
      let state = await page.evaluate(() => window.__humanoid.snapshot().actors[0])
      assert(
        state.q['right.arm.elbow'] > 0.5 && state.q['right.leg.knee'] > 0.4,
        'Default mirror or full-body leg follow failed',
      )
      await page.locator('#mirror').uncheck()
      await sleep(400)
      state = await page.evaluate(() => window.__humanoid.snapshot().actors[0])
      assert(state.q['left.arm.elbow'] > 0.5 && state.q['left.leg.knee'] > 0.4, 'Unmirrored body failed')
      await page.evaluate(() => (window.fixture.loss = [23]))
      await sleep(700)
      assert(!(await page.evaluate(() => window.__humanoid.snapshot().actors[0].tracked)), 'Torso loss stayed tracked')
      await page.evaluate(() => {
        window.fixture.loss = []
        window.fixture.gen++
      })
      await until(() => page.evaluate(() => window.__humanoid.snapshot().actors[0].tracked))
      assert(
        await page.evaluate(() => {
          const a = window.__humanoid.actors[0],
            V = a.control.position.constructor,
            offset = new V(0.2, 0, 0),
            base = new V(1, 0, 2)
          a.rig.pose(a.control.q, base, 0, offset)
          const first = a.rig.point(a.rig.profile.root).sub(base)
          a.rig.pose(a.control.q, base, Math.PI / 2, offset)
          const turned = a.rig.point(a.rig.profile.root).sub(base)
          return turned.distanceTo(first.applyAxisAngle(new V(0, 1, 0), Math.PI / 2)) < 1e-6
        }),
        'Turning the actor did not rotate its local balance offset',
      )
      await sleep(100)
      await page.screenshot({ path: join(directory, 'desktop-following.png') })
      return 'Both legs, mirror, confidence loss, generation reset'
    })
    async function sweep(page) {
      // Each chain's movements pass through forward-generated landmarks, BODY decoding and analytic retargeting.
      for (const fraction of [0.2, 0.8, 0.25, 0.75]) {
        await page.evaluate((f) => {
          const h = window.__humanoid,
            w = h.walkthrough.walk,
            q = {}
          for (const j of h.actors[0].rig.profile.joints) q[j.id] = 0
          for (const id of w.step.joints) {
            const j = h.actors[0].rig.profile.joints.find((j) => j.id === id)
            q[id] = j.limits[0] + (j.limits[1] - j.limits[0]) * f
          }
          window.fixture.angles = q
        }, fraction)
        await sleep(180)
      }
      await until(() => page.getByRole('button', { name: 'Done', exact: true }).isEnabled())
    }
    for (const mobile of [false, true]) {
      const screen = mobile ? await open(true) : { page, ctx, errors },
        p = screen.page,
        label = mobile ? 'phone' : 'desktop'
      if (mobile) await p.evaluate(installFixture)
      await run(`${label} walkthrough completes all eight chains and fits the viewport`, async () => {
        await p.locator('#range-calibrate').click()
        const names = ['shoulders', 'elbows', 'wrists', 'spine', 'hips', 'knees', 'ankles', 'head']
        for (const name of names) {
          assert(await p.evaluate((n) => window.__humanoid.snapshot().step === n, name), `Wrong step: ${name}`)
          await sweep(p)
          await p.screenshot({ path: join(directory, `${label}-range-${name}.png`) })
          const fits = await p.locator('.humanoid-calibration').evaluate((d) => {
            const r = d.getBoundingClientRect()
            return (
              r.left >= 0 &&
              r.top >= 0 &&
              r.right <= innerWidth + 1 &&
              r.bottom <= innerHeight + 1 &&
              d.scrollWidth <= d.clientWidth
            )
          })
          assert(fits, `${name} does not fit`)
          await p.getByRole('button', { name: 'Done', exact: true }).click()
        }
        assert(await p.evaluate(() => window.__humanoid.snapshot().done.length === 8), 'Not every chain completed')
        const data = await p.evaluate(() => window.__humanoid.snapshot().saved)
        assert(Object.keys(data.ranges).length >= 8, 'Ranges did not persist')
        assert(Object.keys(data).sort().join(',') === 'lengths,profile,ranges,v', 'Unexpected calibration payload')
        await p.getByRole('button', { name: 'Close', exact: true }).click()
        if (mobile) {
          await sleep(300)
          assert(
            await p.evaluate(() => {
              const panel = document.querySelector('.sim-window[data-panel="controls"]').getBoundingClientRect()
              return window.__humanoid
                .screenBounds()
                .flat()
                .every((p) => p && p.x >= 0 && p.x <= innerWidth && p.y >= 120 && p.y <= panel.top)
            }),
            'Open phone controls hide a robot',
          )
          await p.screenshot({ path: join(directory, 'phone-following.png') })
          const toggle = p.locator('[data-panel-toggle="controls"]')
          await toggle.focus()
          await toggle.click()
          await sleep(300)
          await p.screenshot({ path: join(directory, 'phone-stage.png') })
          await screen.ctx.close()
        }
        return 'Eight step screenshots; derived ranges only'
      })
    }
    await run('calibration skip, redo, persistence and reset use the real controls', async () => {
      await page.locator('#range-calibrate').click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      assert(await page.evaluate(() => window.__humanoid.walkthrough.walk.skipped.has('shoulders')), 'Skip lost')
      await page.getByRole('button', { name: 'Shoulders: skipped', exact: true }).click()
      await sweep(page)
      await page.getByRole('button', { name: 'Done', exact: true }).click()
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      const saved = await page.evaluate(() =>
        JSON.stringify(
          Object.entries(window.__humanoid.snapshot().saved.ranges).sort(([a], [b]) => a.localeCompare(b)),
        ),
      )
      await page.reload()
      await page.waitForFunction(() => window.__humanoid && window.__obpal)
      await controls(page)
      await page.locator('#range-calibrate').click()
      assert(
        await page.evaluate(
          (s) =>
            JSON.stringify(
              Object.entries(window.__humanoid.snapshot().saved.ranges).sort(([a], [b]) => a.localeCompare(b)),
            ) === s,
          saved,
        ),
        'Reload lost derived ranges',
      )
      await page.getByRole('button', { name: 'Reset calibration', exact: true }).click()
      assert(
        await page.evaluate(
          () =>
            Object.keys(window.__humanoid.snapshot().saved.ranges).length === 0 &&
            Object.keys(window.__humanoid.snapshot().saved.lengths).length === 0,
        ),
        'Reset retained measurements',
      )
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      return 'Skip, targeted redo, reload persistence, reset'
    })
    await run('selected Morrow silhouette, icon labels and reduced motion stay clear', async () => {
      await page.locator('[data-seat="1"]').click()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.locator('#range-calibrate').click()
      await sleep(500)
      for (const name of ['Close', 'Skip', 'Redo']) {
        const button = page.getByRole('button', { name, exact: true })
        assert((await button.getAttribute('title')) === name, `${name} lacks its tooltip`)
        assert((await button.innerText()).trim() === '', `${name} retained a word label`)
      }
      assert((await page.locator('.range-steps button').count()) === 8, 'Rail lacks a step')
      const figure = page.locator('.range-figure'),
        first = await figure.screenshot()
      await sleep(350)
      assert(first.equals(await figure.screenshot()), 'Reduced-motion figure moved')
      await page.screenshot({ path: join(directory, 'desktop-morrow-reduced-motion.png') })
      await page.getByRole('button', { name: 'Close', exact: true }).click()
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.locator('[data-seat="0"]').click()
      return 'Selected authored Morrow; three labelled icon actions; stable reduced-motion pixels'
    })
    await run('local webcam opt-in reserves one seat and closing releases its tracks and claim', async () => {
      assert(!(await page.locator('.obpal-camera').count()), 'Camera enabled before tap')
      await page.locator('#local-body').click()
      await until(
        () =>
          page.evaluate(() => {
            const v = document.querySelector('.obpal-camera video')
            return v?.srcObject?.getVideoTracks().some((t) => t.readyState === 'live')
          }),
        15000,
        'local webcam track',
      )
      assert(
        await page.evaluate(() => window.__sim.claims.holder('robot-1') === 'host'),
        'Local webcam did not reserve its seat',
      )
      await page.keyboard.down('w')
      await sleep(170)
      await page.keyboard.up('w')
      assert(
        await page.evaluate(() => window.__humanoid.snapshot().localSource === 'body'),
        'Locomotion deselected the local body camera',
      )
      await page.evaluate(
        () => (window.fixtureTracks = document.querySelector('.obpal-camera video').srcObject.getTracks()),
      )
      await page.getByRole('button', { name: 'Close camera', exact: true }).first().click()
      assert(
        await page.evaluate(
          () => window.fixtureTracks.every((t) => t.readyState === 'ended') && !window.__sim.claims.holder('robot-1'),
        ),
        'Webcam close retained tracks or claim',
      )
      return 'Explicit opt-in, exclusive local seat, complete release'
    })
    await ctx.close()
    await run('two real paired phones claim separate existing seats; a spectator cannot take one', async () => {
      const host = await open(),
        phones = []
      try {
        for (let i = 0; i < 3; i++) {
          const c = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
          contexts.push(c)
          await c.addInitScript(() => {
            sessionStorage.setItem('obpal.hint.gyro', '1')
          })
          const p = await c.newPage(),
            invite = await host.page.evaluate(() => window.__obpal.pairingUrl)
          await p.goto(invite.replace('/p/', '/p/?camera-test=1'))
          await p.locator('.gp:not([hidden]), .modes:visible').first().waitFor({ timeout: 25000 })
          phones.push({ c, p })
        }
        const owners = await until(
          () =>
            host.page.evaluate(() => {
              const a = window.__humanoid.snapshot().actors
              return a.every((x) => x.owner) && a.map((x) => x.owner)
            }),
          10000,
          'two claimed seats',
        )
        assert(new Set(owners).size === 2, 'Both actors have the same owner')
        const third = await host.page.evaluate(() => window.__obpal.participants[2].id)
        assert(!owners.includes(third), 'Spectator owns an actor')
        const gamepad = phones[0].p.locator('.gp:not([hidden]) [data-act="exit"]')
        if (await gamepad.isVisible()) await gamepad.click()
        assert(
          await phones[0].p.locator('[data-tab="camera-hand"]').count(),
          'Authored hands lack the optional capture capability',
        )
        await phones[0].p.locator('[data-tab="camera-body"]').click()
        const download = phones[0].p.locator('[data-camera-download]')
        await until(
          async () =>
            (await download.isVisible()) ||
            (await phones[0].p.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraBody?.stats()?.delegate))),
          15000,
          'download consent or cached model',
        )
        if (await download.isVisible()) await download.click()
        await until(
          () => phones[0].p.evaluate(() => ['GPU', 'CPU'].includes(window.__cameraBody?.stats()?.delegate)),
          60000,
          'phone Pose Lite ready',
        )
        await host.page.evaluate(installFixture)
        const state = await host.page.evaluate(() => {
          window.fixture.enabled = false
          window.fixture.angles = { 'left.arm.elbow': 1, 'left.leg.knee': 0.7 }
          return window.fixtureBody()
        })
        await phones[0].p.evaluate(
          (b) =>
            window.__cameraBody.inject({
              worldLandmarks: [b.landmarks.map(([x, y, z]) => ({ x, y: -y, z: -z, visibility: 1 }))],
              landmarks: [b.landmarks.map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))],
            }),
          state,
        )
        await until(
          () => host.page.evaluate(() => window.__humanoid.snapshot().actors[0].tracked),
          15000,
          'paired BODY at actor',
        )
        const bodyOwner = await host.page.evaluate(() => window.__humanoid.snapshot().actors[0].owner)
        assert(bodyOwner === owners[0], 'BODY crossed seats')
        assert(!(await phones[0].p.locator('[data-camera-fingers]').isChecked()), 'Fingers started enabled')
        assert(
          await phones[0].p.evaluate(() => window.__cameraBody.stats().handPackets === 0),
          'HAND sent before opt-in',
        )
        await phones[0].p.evaluate((b) => {
          const points = Array.from({ length: 21 }, () => [0, 0, 0])
          for (const [n, base] of [5, 9, 13, 17].entries()) {
            const x = 0.03 - n * 0.022,
              y = 0.025 + (n === 1 ? 0.01 : 0)
            points[base] = [x, y, 0]
            points[base + 1] = [x, y + 0.03, 0]
            points[base + 2] = [x, y + 0.03, 0.025]
            points[base + 3] = [x, y + 0.01, 0.025]
          }
          points[1] = [0.035, 0.008, 0]
          points[2] = [0.05, 0.016, 0]
          points[3] = [0.06, 0.03, 0]
          points[4] = [0.07, 0.04, 0]
          window.__cameraBody.inject(
            {
              worldLandmarks: [b.landmarks.map(([x, y, z]) => ({ x, y: -y, z: -z, visibility: 1 }))],
              landmarks: [b.landmarks.map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }))],
            },
            {
              worldLandmarks: [points.map(([x, y, z]) => ({ x, y: -y, z: -z }))],
              landmarks: [points.map(([x, y, z]) => ({ x: 0.5 + x, y: 0.5 - y, z: -z }))],
              handedness: [[{ categoryName: 'Left', displayName: 'Left', score: 0.99, index: 0 }]],
            },
          )
        }, state)
        await phones[0].p.locator('[data-camera-fingers]').check()
        await until(async () => await download.isVisible() || await phones[0].p.evaluate(() => window.__cameraBody.stats().handPackets > 0), 15000, 'hand download consent or cached hand model')
        if (await download.isVisible()) await download.click()
        await until(
          () =>
            host.page.evaluate(
              () => window.__humanoid.actors[0].rig.root.getObjectByName('right_arm_fingers').rotation.x > 0.5,
            ),
          15000,
          'mirrored HAND curls at BODY wrist',
        )
        assert(
          await host.page.evaluate(
            () => window.__humanoid.actors[1].rig.root.getObjectByName('right_arm_fingers').rotation.x === 0,
          ),
          'HAND crossed seats',
        )
        await phones[0].p.locator('[data-camera-fingers]').uncheck()
        await until(
          () =>
            host.page.evaluate(
              () => window.__humanoid.actors[0].rig.root.getObjectByName('right_arm_fingers').rotation.x === 0,
            ),
          5000,
          'finger relaxation',
        )
        await phones[0].c.close()
        await until(
          () => host.page.evaluate(() => !window.__humanoid.snapshot().actors[0].owner),
          15000,
          'disconnected seat release',
        )
        assert(
          await host.page.evaluate(() => window.__humanoid.snapshot().actors[0].stopped),
          'Disconnect did not hold actor',
        )
        return 'Two exclusive claims, spectator, real WebRTC BODY/HAND, opt-in finger fusion and loss, disconnect hold'
      } catch (e) {
        report.phoneDebug = {
          host: await host.page.evaluate(() => ({
            actors: window.__humanoid.snapshot().actors,
            people: window.__obpal.participants.map((p) => ({ id: p.id, controller: p.controller, paused: p.paused })),
          })),
          phones: await Promise.all(
            phones.map(({ p }) =>
              p
                .evaluate(() => ({ text: document.body.innerText.slice(-1500), stats: window.__cameraBody?.stats() }))
                .catch(() => null),
            ),
          ),
        }
        if (phones[0])
          await phones[0].p.screenshot({ path: join(directory, 'phone-pairing-debug.png') }).catch(() => {})
        throw e
      } finally {
        await host.ctx.close()
        for (const { c } of phones) await c.close().catch(() => {})
      }
    })
    await run('two authored actors stay within the measured PC frame and draw budgets', async () => {
      const perf = await open(false, true)
      await perf.page.evaluate(() => { window.__humanoid.changeRobot(0, 'cairn', 1); window.__humanoid.changeRobot(1, 'rill', 1) })
      await perf.page.waitForFunction(() => window.__humanoid.actors.every(a => a.rig.root.userData.lods === 2))
      await perf.page.evaluate(installFixture)
      await perf.page.evaluate(() => {
        window.fixture.two = true
        window.fixture.animate = true
        window.__humanoid.camera.position.set(2, 2, -4.2)
      })
      await sleep(2000)
      await perf.page.evaluate(() => window.__humanoid.resetMetrics())
      const duration = Number(process.env.OBPAL_HUMANOID_PERF_MS ?? 300000)
      const begin = Date.now()
      while (Date.now() - begin < duration) await sleep(Math.min(10000, duration - (Date.now() - begin)))
      const m = await perf.page.evaluate(() => {
        const gl = document.querySelector('#stage').getContext('webgl2'),
          info = gl.getExtension('WEBGL_debug_renderer_info')
        return {
          ...window.__humanoid.metrics(),
          renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'Unavailable',
        }
      })
      const p95 = (a) => [...a].sort((a, b) => a - b)[Math.floor(a.length * 0.95)] ?? null
      assert(
        await perf.page.evaluate(() =>
          window.__humanoid.actors.every(
            (a) => a.rig.root.userData.prototype === 'blender' && (a.rig.root.userData.lod ?? 0) === 0,
          ),
        ),
        'Performance run did not use two hero meshes',
      )
      const measurement = {
        durationMs: Date.now() - begin,
        frames: m.frameTimes.length,
        frameP95: p95(m.frameTimes),
        logicP95: p95(m.logicTimes),
        renderSubmitP95: p95(m.renderTimes),
        gpuP95: p95(m.gpuTimes),
        drawCalls: m.gfx.calls,
        triangles: m.gfx.triangles,
        dpr: m.gfx.pr,
        renderer: m.renderer,
        warning: 'PC synthetic landmark motion, two hero meshes; not phone hardware or camera contention',
      }
      report.measurements.push(measurement)
      await writeFile(
        join(directory, 'frame-times.json'),
        JSON.stringify({
          renderer: m.renderer,
          frameTimes: m.frameTimes,
          logicTimes: m.logicTimes,
          renderTimes: m.renderTimes,
          gpuTimes: m.gpuTimes,
        }),
      )
      assert(measurement.logicP95 < 2, `Logic p95 ${measurement.logicP95} ms`)
      assert(measurement.drawCalls <= 120 && measurement.dpr <= 1.5, 'Draw/DPR budget exceeded')
      assert(measurement.triangles <= 65000, 'Scene triangle budget exceeded')
      if (measurement.gpuP95 !== null)
        assert(
          measurement.gpuP95 + measurement.renderSubmitP95 + measurement.logicP95 <= 16.7,
          'PC submission + GPU budget exceeded',
        )
      await perf.page.screenshot({ path: join(directory, 'desktop-frame-budget.png') })
      await perf.ctx.close()
      return JSON.stringify(measurement)
    })
    await run('no page errors or CSP violations', async () => {
      assert(!errors.length, errors.join('; '))
      return cspCheck()
    })
  } finally {
    await Promise.allSettled(contexts.map((c) => c.close()))
    await browser.close()
    await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2))
    console.log(`Humanoid evidence: ${directory}`)
  }

  } finally { await temps.cleanup() }
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  for (const k of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) if (!process.env[k]) throw new Error(`Set ${k}`)
  const { startLocal } = await import('../extension/e2e/local.mjs'),
    local = await startLocal()
  let failed = 0,
    total = 0
  try {
    await runHumanoid(local, async (name, fn) => {
      total++
      try {
        console.log(`PASS ${name}: ${(await fn()) ?? ''}`)
      } catch (e) {
        failed++
        console.error(`FAIL ${name}: ${e.message}`)
      }
    })
  } finally {
    await local.close()
  }
  console.log(failed ? `FAILED ${failed}/${total}` : `passed ${total}/${total}`)
  process.exitCode = failed ? 1 : 0
}
