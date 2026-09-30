/** Worker-backed driver faults, real DOM controls and measured hold timings. Never connects to hardware. */
import { chromium, devices } from 'playwright'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFixture } from './e2e-humanoid.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const assert = (ok, why) => {
  if (!ok) throw new Error(why)
}
async function until(read, why, timeout = 6000) {
  const end = Date.now() + timeout
  do {
    if (await read()) return
    await sleep(40)
  } while (Date.now() < end)
  throw new Error(`Timed out: ${why}`)
}
const state = (page) =>
  page.evaluate(() => ({
    state: __humanoid.drivers.session.state,
    reason: __humanoid.drivers.session.reason,
    checks: __humanoid.drivers.session.checks,
  }))
const snapshot = (page) => page.evaluate(() => __humanoid.drivers.transport.snapshot())
const faults = (page, faults, pose) =>
  page.evaluate(({ faults, pose }) => __humanoid.drivers.transport.faults(faults, pose), { faults, pose })
const goals = (s) => s.events.filter((e) => e.kind === 'goal').length
const region = (page) => page.locator('[data-panel="drivers"]')
async function exposedStop(page) {
  const covered = await region(page)
    .locator('[data-stop]')
    .evaluate((button) => {
      const box = button.getBoundingClientRect()
      return [0.2, 0.5, 0.8].flatMap((x) =>
        [0.2, 0.5, 0.8].flatMap((y) => {
          const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)
          return hit && button.contains(hit) ? [] : [{ x, y, covering: hit?.className ?? 'viewport' }]
        }),
      )
    })
  assert(covered.length === 0, `Stop is covered: ${JSON.stringify(covered)}`)
}

export async function runHumanoidLive(local, check) {
  const directory = await mkdtemp(join(tmpdir(), 'obpal-humanoid-live-'))
  const report = {
    environment: 'Desktop Chromium; phone viewport emulation. Worker guardian and modeled robot watchdog, no hardware.',
    results: [],
    timings: [],
  }
  const browser = await chromium.launch({
    executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined,
    headless: !process.argv.includes('--headed'),
    args: ['--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
  })
  const errors = [],
    contexts = []
  const run = (name, work) =>
    check(`humanoid live: ${name}`, async () => {
      try {
        const detail = await work()
        report.results.push({ name, ok: true, detail })
        return detail
      } catch (error) {
        await Promise.allSettled(
          contexts.flatMap((context) =>
            context.pages().flatMap((page) => [page.keyboard.up('Shift'), page.mouse.up()]),
          ),
        )
        report.results.push({ name, ok: false, error: error.message })
        throw error
      }
    })
  const open = async (mobile = false) => {
    const context = await browser.newContext({
      ...(mobile ? devices['Pixel 7'] : { viewport: { width: 1440, height: 1000 } }),
      ignoreHTTPSErrors: true,
    })
    contexts.push(context)
    const page = await context.newPage()
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`${local.origin}/sim/humanoid/?test=humanoid-live`)
    await page.waitForFunction(() => window.__humanoid && window.__obpal?.pairingUrl)
    await page.waitForFunction(() => __humanoid.actors.every((a) => a.rig.root.userData.prototype === 'blender'))
    const toggle = page.locator('[data-panel-toggle="drivers"]')
    await toggle.focus()
    await toggle.click()
    return page
  }
  const select = async (page, name, value) => {
    await region(page).getByRole('combobox', { name, exact: true }).click()
    await page.getByRole('option', { name: value, exact: true }).click()
  }
  const connect = async (page, kind = 'ros') => {
    if ((await state(page)).state !== 'disconnected')
      await region(page).getByRole('button', { name: 'Disconnect driver', exact: true }).click()
    await until(async () => (await state(page)).state === 'disconnected', 'disconnect')
    if (kind !== 'ros')
      await select(page, 'Simulated driver', kind === 'g1' ? 'Unitree G1 · arm7' : 'Unitree H1 · arm4')
    else await select(page, 'Simulated driver', 'ROS 2 reference')
    await region(page).getByRole('button', { name: 'Connect simulated driver', exact: true }).click()
    await until(
      async () => (await state(page)).state === 'observe',
      `observe-only: ${JSON.stringify(await state(page))}`,
    )
    await until(async () => (await state(page)).checks.find((c) => c.id === 'controller')?.ok, 'stable guardian')
  }
  const arm = async (page) => {
    await page.keyboard.up('Shift')
    await region(page).getByLabel('Joint map verified', { exact: true }).check()
    await region(page).getByLabel('Workspace clear; emergency stop reachable', { exact: true }).check()
    await page.keyboard.down('Shift')
    const live = region(page).getByRole('button', { name: 'Go live', exact: true })
    await until(() => live.isEnabled(), `ready checklist: ${JSON.stringify(await state(page))}`)
    await live.click()
    await until(async () => (await state(page)).state === 'live', `live: ${JSON.stringify(await state(page))}`)
  }
  const jog = async (page) => {
    const input = region(page).locator('[data-input]')
    if (!(await input.evaluate((el) => el.open))) await input.locator(':scope > summary').click()
    await region(page).getByRole('slider', { name: 'Jog left.arm.elbow', exact: true }).press('End')
  }
  try {
    const page = await open()
    await run('observe is the default; the twin follows measurements without sending goals', async () => {
      await page.screenshot({ path: join(directory, 'desktop-disconnected.png') })
      await connect(page)
      await faults(page, {}, { 'left.arm.elbow': 0.25 })
      await until(
        () => page.evaluate(() => Math.abs(__humanoid.drivers.session.twin['left.arm.elbow'] - 0.25) < 0.01),
        'measured twin',
      )
      assert(goals(await snapshot(page)) === 0, 'Observe sent motion')
      assert(
        await region(page).getByText('Tested against simulated drivers only.', { exact: true }).isVisible(),
        'Missing simulation label',
      )
      assert(
        !(await region(page).getByRole('button', { name: 'Go live', exact: true }).isEnabled()),
        'Unconfirmed go-live enabled',
      )
      await page.screenshot({ path: join(directory, 'desktop-observe.png') })
    })
    for (const kind of ['ros', 'g1', 'h1'])
      await run(`${kind}: fresh rearm, capped jog, driver-specific Stop and passive legs`, async () => {
        await connect(page, kind)
        await arm(page)
        await jog(page)
        await sleep(550)
        const moving = await snapshot(page)
        assert(goals(moving) >= 8, `No sustained goals: ${JSON.stringify(await state(page))}`)
        assert(
          moving.events
            .filter((e) => e.kind === 'goal')
            .every((e) =>
              Object.entries(e.positions)
                .filter(([id]) => id.includes('.leg.'))
                .every(([, q]) => q === 0),
            ),
          'A driver goal moved legs',
        )
        await exposedStop(page)
        if (kind === 'ros') await page.screenshot({ path: join(directory, 'desktop-live-held.png') })
        await region(page).getByRole('button', { name: 'Stop', exact: true }).click()
        await until(async () => (await snapshot(page)).held, 'Stop hold')
        const stopped = await snapshot(page),
          count = goals(stopped)
        await sleep(180)
        assert(goals(await snapshot(page)) === count, 'Stop allowed another goal')
        assert(
          stopped.events.at(-1).strategy === (kind === 'h1' ? 'controlled-damp' : 'measured-hold'),
          'Wrong hold strategy',
        )
        assert(
          !(await region(page).getByRole('button', { name: 'Go live', exact: true }).isEnabled()),
          'Held deadman rearmed without release',
        )
        await page.keyboard.up('Shift')
        if (kind === 'ros') await page.screenshot({ path: join(directory, 'desktop-stopped.png') })
        await arm(page)
        await page.keyboard.up('Shift')
        await until(async () => (await snapshot(page)).held, 'release hold')
        report.timings.push({
          source: `${kind}:release`,
          ...(await snapshot(page)).events.filter((e) => e.kind === 'hold').at(-1),
        })
      })
    for (const [name, fault] of [
      ['stale joint', { staleJoint: 'left.arm.elbow' }],
      ['unreported joint', { unknownJoint: 'left.arm.elbow' }],
      ['non-finite joint', { nanJoint: 'left.arm.elbow' }],
      ['out of limits', { outOfLimits: 'left.arm.elbow' }],
      ['competing writer', { competingWriter: true }],
      ['guardian unhealthy', { guardianUnhealthy: true }],
      ['missing robot watchdog', { robotWatchdogMissing: true }],
      ['swapped map', { swappedMapping: true }],
      ['controller fault', { controllerFault: true }],
      ['frozen feedback', { frozenFeedback: true }],
    ])
      await run(`${name} holds and refuses rearm`, async () => {
        await connect(page)
        await arm(page)
        await jog(page)
        await faults(page, fault)
        await until(
          async () => !(await page.evaluate(() => __humanoid.drivers.session.active)) && (await snapshot(page)).held,
          name,
        )
        const count = goals(await snapshot(page))
        await sleep(150)
        assert(goals(await snapshot(page)) === count, 'Fault allowed another goal')
        await page.keyboard.up('Shift')
        await page.keyboard.down('Shift')
        assert(!(await region(page).getByRole('button', { name: 'Go live', exact: true }).isEnabled()), 'Fault rearmed')
        await page.keyboard.up('Shift')
        if (name === 'stale joint') await page.screenshot({ path: join(directory, 'desktop-stale-joint.png') })
      })
    await run(
      'Worker lease expires during a blocked page; socket and bridge loss use independent watchdogs',
      async () => {
        for (const kind of ['ros', 'g1', 'h1'])
          for (const fault of ['page-freeze', 'socketLost', 'bridgeDead'])
            for (let repeat = 0; repeat < 4; repeat++) {
              await connect(page, kind)
              await arm(page)
              await jog(page)
              await sleep(100)
              if (fault !== 'page-freeze') await faults(page, { [fault]: true })
              // Blocking the main thread cannot run the page's stop code or renew the lease.
              await page.evaluate(() => {
                const end = performance.now() + 260
                while (performance.now() < end) {
                  /* Deliberate fault. */
                }
              })
              const s = await snapshot(page),
                hold = s.events.findLast((e) => /lease expired|bridge lost/.test(e.reason ?? ''))
              assert(s.held && hold, `${kind}/${fault} missed watchdog: ${JSON.stringify(s.events.slice(-3))}`)
              report.timings.push({ source: `${kind}:${fault}`, ...hold })
              assert(hold.delay <= 110, `${kind}/${fault}: hold ${hold.delay.toFixed(2)} ms exceeds 110 ms`)
              const count = goals(s)
              await sleep(80)
              assert(goals(await snapshot(page)) === count, 'Queued traffic revived expired motion')
              await page.keyboard.up('Shift')
            }
        return `${report.timings.filter((t) => t.source.includes(':page-freeze') || t.source.includes(':socketLost') || t.source.includes(':bridgeDead')).length} independent watchdog samples`
      },
    )
    await run('missing hold acknowledgement blocks a fresh deadman', async () => {
      await connect(page)
      await arm(page)
      await faults(page, { dropHoldAck: true })
      await region(page).getByRole('button', { name: 'Stop', exact: true }).click()
      await until(
        async () => (await state(page)).reason.includes('acknowledgement missing'),
        'hold acknowledgement deadline',
      )
      assert((await snapshot(page)).held, 'Stop did not reach simulated driver')
      await page.keyboard.up('Shift')
      await page.keyboard.down('Shift')
      assert(
        !(await region(page).getByRole('button', { name: 'Go live', exact: true }).isEnabled()),
        'Unacknowledged Stop rearmed',
      )
      await page.keyboard.up('Shift')
    })
    await run('blur, hidden page, panel close and pointer cancellation all hold', async () => {
      for (const event of ['blur', 'hidden', 'close', 'pointercancel', 'lostpointercapture']) {
        if (!(await region(page).isVisible())) {
          const toggle = page.locator('[data-panel-toggle="drivers"]')
          await toggle.focus()
          await toggle.click()
        }
        await connect(page)
        await arm(page)
        if (event === 'close')
          await region(page).getByRole('button', { name: 'Close Simulated drivers', exact: true }).click()
        else if (event.startsWith('pointer') || event === 'lostpointercapture') {
          await page.keyboard.up('Shift')
          await region(page).getByLabel('Joint map verified', { exact: true }).check()
          await region(page).getByLabel('Workspace clear; emergency stop reachable', { exact: true }).check()
          const button = region(page).locator('[data-deadman]'),
            box = await button.boundingBox()
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
          await page.mouse.down()
          const live = region(page).getByRole('button', { name: 'Go live', exact: true })
          await until(() => live.isEnabled(), 'pointer rearm checklist')
          await live.press('Enter')
          await until(async () => (await state(page)).state === 'live', 'pointer rearm')
          await button.dispatchEvent(event, { pointerId: 1 })
          await page.mouse.up()
        } else
          await page.evaluate((event) => {
            if (event === 'hidden') {
              Object.defineProperty(document, 'hidden', { configurable: true, value: true })
              document.dispatchEvent(new Event('visibilitychange'))
              delete document.hidden
            } else dispatchEvent(new Event('blur'))
          }, event)
        await until(async () => (await snapshot(page)).held, `${event} hold`)
        await page.keyboard.up('Shift')
      }
    })
    await run('local BODY source uses capture age, requires tracked chains and stops on camera loss', async () => {
      if (!(await region(page).isVisible())) {
        const toggle = page.locator('[data-panel-toggle="drivers"]')
        await toggle.focus()
        await toggle.click()
      }
      await connect(page)
      await page.evaluate(installFixture)
      await page.evaluate(() => {
        fixture.enabled = false
        fixture.angles = { 'left.arm.roll': 0.3, 'right.arm.roll': 0.3 }
        window.localFixtureTimer = setInterval(() => {
          const body = fixtureBody()
          body.t = Math.round((performance.now() - __humanoid.localCaptureOrigin) * 1000) >>> 0
          __humanoid.injectLocal(body)
        }, 33)
      })
      const input = region(page).locator('[data-input]')
      if (!(await input.evaluate((el) => el.open))) await input.locator(':scope > summary').click()
      await select(page, 'Driver motion input', 'Local body camera')
      await until(
        async () => (await state(page)).checks.find((c) => c.id === 'input')?.ok,
        'local body auto-calibrated',
        12000,
      )
      await arm(page)
      await page.evaluate(() => clearInterval(window.localFixtureTimer))
      await until(async () => (await snapshot(page)).held, 'stale camera hold')
      assert(/stale|tracked/.test((await state(page)).reason), `Unexpected camera stop: ${(await state(page)).reason}`)
      await page.keyboard.up('Shift')
      await page.evaluate(() => clearInterval(fixtureTimer))
    })
    await run('driver leg refusal leaves practice BODY legs and classical presets available', async () => {
      await connect(page)
      await region(page).getByRole('button', { name: 'Explain driver leg lock', exact: true }).click()
      assert(
        (await region(page).locator('[data-leg-reason]').textContent()).includes('no commissioned'),
        'Missing leg refusal',
      )
      await page.evaluate(installFixture)
      await sleep(1600)
      await page.evaluate(() => {
        fixture.angles = { 'left.leg.pitch': 0.6, 'left.leg.knee': 0.9 }
        fixture.two = true
      })
      await until(
        () =>
          page.evaluate(() =>
            __humanoid.actors.some((a) => a.control.q['right.leg.knee'] > 0.35 || a.control.q['left.leg.knee'] > 0.35),
          ),
        'practice BODY legs',
      )
      assert(goals(await snapshot(page)) === 0, 'Practice BODY reached driver')
      await page.evaluate(() => {
        clearInterval(fixtureTimer)
        __humanoid.clear(0)
        __humanoid.clear(1)
        __humanoid.actors[0].control.play('jab')
      })
      assert(
        await page.evaluate(() => __humanoid.actors[0].control.preset === 'jab'),
        'Practice preset gated by hardware lock',
      )
      await page.screenshot({ path: join(directory, 'desktop-legs-refused-practice-free.png') })
    })
    await run(
      'phone controls: readable held state, touch release, full-size Stop and no horizontal overflow',
      async () => {
        const phone = await open(true)
        await phone.screenshot({ path: join(directory, 'phone-disconnected.png') })
        await connect(phone)
        await phone.evaluate(() => {
          __humanoid.drivers.panel.body.scrollTop = 0
        })
        await phone.screenshot({ path: join(directory, 'phone-observe.png') })
        await arm(phone)
        const workspace = region(phone).getByLabel('Workspace clear; emergency stop reachable', { exact: true })
        await workspace.evaluate((input) => input.closest('label').scrollIntoView({ block: 'center' }))
        const confirmation = await workspace.evaluate((input) => {
          const label = input.closest('label'),
            box = label.getBoundingClientRect(),
            footer = label.closest('.humanoid-driver').querySelector('.driver-footer').getBoundingClientRect(),
            body = label.closest('.panel-body').getBoundingClientRect()
          return {
            visible: box.top >= body.top && box.bottom <= footer.top - 4,
            exposed: [0.2, 0.5, 0.8].every((x) =>
              [0.2, 0.5, 0.8].every((y) =>
                label.contains(document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)),
              ),
            ),
          }
        })
        assert(confirmation.visible && confirmation.exposed, 'Workspace confirmation is covered by the driver footer')
        await phone.screenshot({ path: join(directory, 'phone-checklist.png') })
        await phone.evaluate(() => {
          __humanoid.drivers.panel.body.scrollTop = 0
        })
        await exposedStop(phone)
        await phone.screenshot({ path: join(directory, 'phone-live-held.png') })
        await phone.keyboard.up('Shift')
        await until(async () => (await snapshot(phone)).held, 'phone release')
        await phone.screenshot({ path: join(directory, 'phone-stopped.png') })
        const layout = await region(phone).evaluate((el) => {
          const stop = el.querySelector('[data-stop]').getBoundingClientRect()
          const held = el.querySelector('[data-deadman]').getBoundingClientRect()
          const content = el.querySelector('.humanoid-driver')
          return {
            stop: { w: stop.width, h: stop.height },
            held: { w: held.width, h: held.height },
            overflow: content.scrollWidth > content.clientWidth + 2,
          }
        })
        assert(
          layout.stop.w >= 100 && layout.stop.h >= 44 && layout.held.h >= 44 && !layout.overflow,
          JSON.stringify(layout),
        )
        const button = region(phone).locator('[data-deadman]'),
          box = await button.boundingBox()
        const cdp = await phone.context().newCDPSession(phone)
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
        })
        assert(await phone.evaluate(() => __humanoid.drivers.session.held), 'Touch did not hold')
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        assert(!(await phone.evaluate(() => __humanoid.drivers.session.held)), 'Cancelled touch stayed held')
        await arm(phone)
        await faults(phone, { staleJoint: 'left.arm.elbow' })
        await until(async () => (await snapshot(phone)).held, 'phone fault hold')
        await phone.keyboard.up('Shift')
        await phone.evaluate(() => {
          __humanoid.drivers.panel.body.scrollTop = 0
        })
        await phone.screenshot({ path: join(directory, 'phone-stale-joint.png') })
        await phone.context().close()
      },
    )
    await run('no page errors or real driver transports', async () => {
      assert(errors.length === 0, errors.join('; '))
      const result = await page.evaluate(() => ({
        worker: performance.getEntriesByType('resource').filter((e) => /fake-guardian/.test(e.name)).length,
        network: performance
          .getEntriesByType('resource')
          .filter((e) => /rosbridge|unitree|joint_states/.test(e.name))
          .map((e) => e.name),
      }))
      assert(result.worker > 0 && result.network.length === 0, JSON.stringify(result))
      return 'Driver traffic stayed in the Worker transport'
    })
  } finally {
    await Promise.allSettled(contexts.map((context) => context.close()))
    await browser.close()
    const samples = report.timings
      .map((t) => t.delay)
      .filter(Number.isFinite)
      .sort((a, b) => a - b)
    report.summary = {
      n: samples.length,
      minMs: samples[0] ?? null,
      p50Ms: samples[Math.floor(samples.length * 0.5)] ?? null,
      p95Ms: samples[Math.floor(samples.length * 0.95)] ?? null,
      maxMs: samples.at(-1) ?? null,
      boundMs: 110,
      unverified: 'Real process/robot watchdogs, stopping distance, network latency and physical phones',
    }
    const buckets = Array.from({ length: 12 }, (_, i) => samples.filter((n) => n >= i * 10 && n < (i + 1) * 10).length)
    const max = Math.max(1, ...buckets)
    const bars = buckets
      .map(
        (n, i) =>
          `<rect x="${60 + i * 48}" y="${235 - (n / max) * 160}" width="36" height="${(n / max) * 160}" fill="#c6ff34"/><text x="${78 + i * 48}" y="255" text-anchor="middle">${i * 10}</text><text x="${78 + i * 48}" y="${225 - (n / max) * 160}" text-anchor="middle">${n}</text>`,
      )
      .join('')
    await writeFile(
      join(directory, 'hold-histogram.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="310" viewBox="0 0 720 310"><rect width="720" height="310" fill="#101419"/><g fill="#e8eeee" font-family="sans-serif" font-size="12"><text x="32" y="30" font-size="20">Simulated hold issuance · ${samples.length} samples</text><text x="32" y="53">Worker timing in desktop Chromium. No hardware stopping claim.</text>${bars}<text x="60" y="286">Delay (ms) · 10 ms bins · target ≤110 ms</text></g></svg>`,
    )
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`  Humanoid live evidence: ${directory}`)
  }
}
