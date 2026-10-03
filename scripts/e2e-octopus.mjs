/**
 * The octopus (/sim/octopus/) end to end, as the sims group OBPAL_E2E_SIMS_ONLY=octopus:
 *   - it loads at 1440 and 390 wide without a page error, within its draw budget, at a pixel ratio of at most 1.5;
 *   - a paired emulated phone holds it and its gamepad face curls, uncurls and stops it;
 *   - scripted gamepad input crawls it on planted arms and its frame and logic timings stay within budget;
 *   - nobody holding it, the showcase grabs the ball and carries it; reduced motion keeps it drawing without errors.
 * Labelled frame strips (./octopus-frames.mjs) go to OBPAL_E2E_EVIDENCE_ROOT, else a kept temporary folder.
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, devices } from 'playwright'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { tempScope } from './lib/temp.mjs'
import { captureOctopus, openOctopus, DRIVEN, SHOWCASE } from './octopus-frames.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0
async function until(what, fn, timeout = 15000) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(80)
  }
}

/** Budgets for this sim (docs/OCTOPUS.md, the coordinator's Stage A): draws for the whole scene, frame and logic work. */
const BUDGET = { calls: 36, framesP95: 25, logicP95: 2, pixelRatio: 1.5 }

export async function runOctopus(local, check) {
  const temps = tempScope({ keep: true })
  const out = await temps.make(join(process.env.OBPAL_E2E_EVIDENCE_ROOT || tmpdir(), 'obpal-octopus-'))
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }))
  const report = {}
  try {
    for (const [width, height, scale] of [[1440, 900, 2], [390, 844, 3]]) {
      await check(`octopus: loads at ${width} wide within ${BUDGET.calls} draws and a pixel ratio of ${BUDGET.pixelRatio}`, async () => {
        const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, ignoreHTTPSErrors: true })
        try {
          const page = await context.newPage(), errors = []
          page.on('pageerror', (e) => errors.push(e.message))
          await openOctopus(page, local.origin, { width, height })
          await page.waitForTimeout(800)
          // The view's own pixel ladder sets the drawing buffer; gfx.pr is the ratio it draws at.
          const gfx = await page.evaluate(() => { window.__device.stage.view.invalidate(); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(window.__gfx())))) })
          report[`load-${width}`] = gfx
          if (errors.length) throw new Error(errors.join('; '))
          if (!(gfx.triangles > 0)) throw new Error('nothing drawn')
          if (gfx.calls > BUDGET.calls) throw new Error(`${gfx.calls} draws`)
          if (gfx.pr > BUDGET.pixelRatio + 1e-6) throw new Error(`pixel ratio ${gfx.pr}`)
          await page.screenshot({ path: join(out, `load-${width}.png`) })
          return `${gfx.calls} draws, ${gfx.triangles} triangles, pixel ratio ${gfx.pr} of ${scale}`
        } finally { await context.close() }
      })
    }

    await check('octopus: a paired phone holds it, and its gamepad face curls, uncurls and stops it', async () => {
      const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
      const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      try {
        const screen = await host.newPage(), page = await phone.newPage(), errors = []
        for (const p of [screen, page]) p.on('pageerror', (e) => errors.push(e.message))
        await phone.addInitScript(() => sessionStorage.setItem('obpal.hint.gyro', '1'))
        await screen.goto(`${local.origin}/sim/octopus/`)
        const invite = await until('invite link', () => screen.evaluate(() => window.__device && window.__obpal?.pairingUrl || ''), 30000)
        await page.goto(invite)
        await until('the phone holds the octopus', () => screen.evaluate(() => {
          const who = window.__obpal?.participants?.[0]?.id
          return !!who && window.__sim?.claims?.holder('octopus1') === who
        }), 30000)
        // The phone opens on the gamepad face, the octopus's first controller: B curls, Y stops.
        const cdp = await phone.newCDPSession(page)
        const press = async (key) => {
          await page.evaluate(() => document.querySelectorAll('.hint').forEach((h) => h.remove()))
          const button = page.locator(`.gp-f[data-k="${key}"]`)
          await button.waitFor({ state: 'visible', timeout: 15000 })
          // A finger held briefly on the button, as the face reads touches rather than clicks.
          const b = await button.boundingBox()
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }] })
          await sleep(120)
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        }
        const state = () => screen.evaluate(() => { const u = window.__device.logic.units[0]; return { mode: u.mode, stopped: u.stopped } })
        await press('b')
        await until('curled from the phone', async () => (await state()).mode === 'curl', 5000)
        await press('b')
        await until('uncurled from the phone', async () => (await state()).mode === 'crawl', 5000)
        await press('y')
        await until('stopped from the phone', async () => (await state()).stopped, 5000)
        await page.screenshot({ path: join(out, 'phone-gamepad.png') })
        if (errors.length) throw new Error(errors.join('; '))
        return 'B curls and uncurls, Y stops'
      } finally { await host.close(); await phone.close() }
    })

    await check(`octopus: crawls on planted arms; frame p95 ≤ ${BUDGET.framesP95} ms and logic p95 < ${BUDGET.logicP95} ms`, async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage(), errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        const frames = await captureOctopus(page, local.origin, out, { scenario: DRIVEN, name: 'driven' })
        const moved = Math.hypot(frames.at(-1).state.x - frames[0].state.x, frames.at(-1).state.z - frames[0].state.z)
        if (moved < 0.5) throw new Error(`moved only ${moved.toFixed(2)} m`)
        if (!frames.some((f) => f.state.mode === 'curl')) throw new Error('never curled')
        const timing = await page.evaluate(async () => {
          const logic = window.__device.logic, step = logic.step.bind(logic), work = [], gaps = []
          window.__octopusScript.axes = [0.5, -1]
          logic.step = (inputs, dt) => { const t = performance.now(); step(inputs, dt); work.push(performance.now() - t) }
          let last = performance.now()
          for (let n = 0; n < 300; n++) {
            window.__device.stage.view.invalidate()
            await new Promise(requestAnimationFrame)
            const now = performance.now()
            if (n > 20) gaps.push(now - last)
            last = now
          }
          return { work, gaps, calls: window.__gfx().calls }
        })
        const framesP95 = quantile(timing.gaps, 0.95), logicP95 = quantile(timing.work, 0.95)
        report.timing = { framesP50: quantile(timing.gaps, 0.5), framesP95, frameMax: Math.max(...timing.gaps), logicP50: quantile(timing.work, 0.5), logicP95, logicMax: Math.max(...timing.work), samples: timing.gaps.length, calls: timing.calls }
        if (errors.length) throw new Error(errors.join('; '))
        // Frame pacing is a hardware measurement; on the software fallback it is reported, not enforced.
        const hardware = process.env.OBPAL_E2E_GPU === '1'
        report.timing.hardware = hardware
        if (hardware && framesP95 > BUDGET.framesP95) throw new Error(`frame p95 ${framesP95.toFixed(1)} ms`)
        if (logicP95 >= BUDGET.logicP95) throw new Error(`logic p95 ${logicP95.toFixed(2)} ms`)
        return `moved ${moved.toFixed(2)} m; frames p95 ${framesP95.toFixed(1)} ms${hardware ? '' : ' (software GL, not enforced)'}, logic p95 ${logicP95.toFixed(2)} ms over ${timing.gaps.length} frames`
      } finally { await context.close() }
    })

    await check('octopus: nobody holding it, the showcase grabs the ball and carries it', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      try {
        const page = await context.newPage(), errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        const frames = await captureOctopus(page, local.origin, out, { scenario: SHOWCASE, name: 'showcase', driven: false })
        if (errors.length) throw new Error(errors.join('; '))
        if (!frames.some((f) => f.state.showing)) throw new Error('never started the showcase')
        if (!frames.some((f) => f.state.held)) throw new Error('never held the ball')
        return `held the ball from ${frames.find((f) => f.state.held).at} s`
      } finally { await context.close() }
    })

    await check('octopus: reduced motion draws without errors and holds the mantle still at rest', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
      try {
        const page = await context.newPage(), errors = []
        page.on('pageerror', (e) => errors.push(e.message))
        await openOctopus(page, local.origin, { width: 390, height: 844 })
        const scales = []
        for (let n = 0; n < 6; n++) {
          await page.waitForTimeout(250)
          scales.push(await page.evaluate(() => window.__device.stage.scene.getObjectByName('mantle')?.scale.x ?? NaN))
        }
        await page.screenshot({ path: join(out, 'reduced-390.png') })
        if (errors.length) throw new Error(errors.join('; '))
        if (scales.some((s) => !Number.isFinite(s)) || Math.max(...scales) - Math.min(...scales) > 1e-6) throw new Error(`mantle scale ${scales.join(', ')}`)
        return 'still mantle'
      } finally { await context.close() }
    })
  } finally {
    await browser.close()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(`  Octopus evidence: ${out}`)
    await temps.cleanup()
  }
}
