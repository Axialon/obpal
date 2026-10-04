/** Scroll choreography proof, using the home runner's browser, service and GPU lease. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { rawRun } from './lib/distill.mjs'
import { prepareHomeSmoothness, measureHomeSmoothness } from './lib/smoothness-home.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
/**
 * This proof is the whole-page field's scroll choreography (ride, lift, land, dock). A phone plays only in the hero for
 * now (src/landing/scope.ts), so a phone-width page asks for the page scope; computers have it always.
 */
const homeUrl = (local, width) => width < 600 ? `${local.origin}/?fieldscope=page` : local.origin

async function measurePacing(browser, local, width, height) {
  const native = await browser.browserType().launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--ignore-certificate-errors'] })
  try {
    const context = await native.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600, ignoreHTTPSErrors: true })
    await prepareHomeSmoothness(context)
    const page = await context.newPage()
    await page.goto(homeUrl(local, width))
    await page.waitForFunction(() => window.__home?.tips().length)
    await page.evaluate(() => {
      const tips = window.__home.tips
      window.__scrollTipWork = []
      window.__home.tips = (...args) => {
        const start = performance.now(), result = tips(...args)
        window.__scrollTipWork.push(performance.now() - start)
        return result
      }
    })
    const route = async () => {
      await page.evaluate(() => { window.__scrollTipWork = [] })
      const result = await measureHomeSmoothness(page, 10)
      result.tipProbeMs = await page.evaluate(() => window.__scrollTipWork)
      return result
    }
    await page.mouse.move(3, 300)
    await sleep(6000)
    const coldTraversal = await route()
    await sleep(2000)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    const pacing = await route()
    await page.locator('[data-field-toggle]').click()
    if (await page.locator('[data-field-toggle]').getAttribute('aria-pressed') !== 'false') await page.locator('[data-field-toggle]').click()
    await sleep(1000)
    const disabled = await route()
    await page.locator('[data-field-toggle]').click()
    await sleep(1000)
    const onAgain = await route()
    await page.locator('[data-field-toggle]').click()
    if (await page.locator('[data-field-toggle]').getAttribute('aria-pressed') !== 'false') await page.locator('[data-field-toggle]').click()
    await sleep(1000)
    const idle = await page.evaluate(async () => {
      const intervals = []
      let begin = 0, previous = 0
      await new Promise(resolve => {
        function frame(t) {
          if (!begin) begin = t
          if (previous) intervals.push(t - previous)
          previous = t
          if (t - begin < 3000) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
      const sorted = [...intervals].sort((a, b) => a - b)
      return { samples: intervals.length, p95: sorted[Math.floor(sorted.length * .95)], median: sorted[Math.floor(sorted.length * .5)], max: sorted.at(-1), intervals }
    })
    return { ...pacing, coldTraversal, disabled, onAgain, idle }
  } finally { await native.close() }
}

export async function runHomeScrollProof(browser, local, check) {
  const only = process.env.OBPAL_E2E_HOME_ONLY || ''
  // Reuse the exclusive native selector only by explicit opt-in; its usual meaning stays intact.
  if (only && (only !== 'viewport field: native GPU pacing under 4x CPU throttle' || process.env.OBPAL_SCROLL_PROOF_ONLY !== '1')) return
  await check('viewport field: native GPU pacing under 4x CPU throttle: scroll choreography evidence', async () => {
    const before = process.env.OBPAL_SCROLL_BASELINE === '1'
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'scroll-choreography')
    await mkdir(out, { recursive: true })
    if (process.env.OBPAL_SCROLL_PACING_CONTROL_ONLY === '1') {
      const pacing = await measurePacing(browser, local, 390, 844)
      await writeFile(join(out, 'pacing-control.json'), JSON.stringify(pacing, null, 2))
      return `diagnostic only: CPU4 on ${pacing.p95.toFixed(1)}ms, off ${pacing.disabled.p95.toFixed(1)}ms, on again ${pacing.onAgain.p95.toFixed(1)}ms, idle ${pacing.idle.p95.toFixed(1)}ms`
    }
    const raw = rawRun(out), frames = [], results = [], failures = []
    for (const [width, height] of [[390, 844], [360, 740], [1280, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600, ignoreHTTPSErrors: true })
      await prepareHomeSmoothness(context)
      const page = await context.newPage(), cdp = await context.newCDPSession(page)
      const shots = [], touchGestures = []
      try {
        await page.goto(homeUrl(local, width))
        await page.waitForFunction(() => window.__home?.tips().length && window.__home.contacts().rects.length > 20)
        await page.mouse.move(3, 300)
        await sleep(5000)
        await page.evaluate(() => {
          const samples = window.__scrollSamples = []
          window.__scrollRecording = true
          function sample(t) {
            if (!window.__scrollRecording) return
            // Read after all application rAF callbacks have drawn this frame, not midway through their queue.
            setTimeout(() => {
              if (!window.__scrollRecording) return
              const tips = window.__home.tips(), contacts = window.__home.contacts()
              if (!window.__scrollDropStart && tips.some(tip => tip.drop)) window.__scrollDropStart = t
              const interiors = []
              for (const tip of tips.filter(tip => !tip.phase || tip.phase === 'ground')) {
                for (const { owner, rect: r } of contacts.rects.filter(b => /scene|build-card/.test(b.owner))) {
                  const x = Math.abs(tip.x - r.x - r.w / 2) - r.w / 2 + r.r
                  const y = Math.abs(tip.y - r.y + (r.fixed ? 0 : scrollY) - r.h / 2) - r.h / 2 + r.r
                  if (Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0) < r.r) interiors.push({ id: tip.id, owner })
                }
              }
              samples.push({ t, sim: window.__home.sim().t, scroll: scrollY, enabled: window.__home.activity().enabled, tips, interiors,
                outlines: tips.map(tip => ({ id: tip.id, ...window.__home.outline(tip.id) })), contacts: contacts.marbles })
            }, 0)
            requestAnimationFrame(sample)
          }
          requestAnimationFrame(sample)
        })
        const shot = async label => {
          const state = await page.evaluate(() => ({ scroll: scrollY, tips: window.__home.tips(), t: performance.now() }))
          const path = `${width}-${String(shots.length).padStart(2, '0')}-${label}.png`
          await page.screenshot({ path: join(raw, path) })
          frames.push({ path, timeMs: state.t, failed: false })
          shots.push({ path, label, ...state })
        }
        await shot('rest')
        // Real touch input leaves Chromium in charge of drag scrolling and fling inertia.
        if (width < 600) {
          for (const [distance, duration] of [[180, 900], [height * .65, 140]]) {
            const start = await page.evaluate(() => scrollY)
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: width * .48, y: height * .8 }] })
            for (let i = 1; i <= 12; i++) {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: width * .48, y: height * .8 - distance * i / 12 }] })
              await sleep(duration / 12)
            }
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await sleep(250)
            const end = await page.evaluate(() => scrollY)
            touchGestures.push({ distance, duration, start, end })
            if (end - start < 30) throw new Error(`${width}px native touch scroll was blocked`)
          }
        }
        await page.evaluate(() => {
          const start = scrollY, target = Math.min(document.documentElement.scrollHeight - innerHeight, start + innerHeight * 1.5)
          const begin = performance.now()
          function scroll(t) { const p = Math.min(1, (t - begin) / 1000); scrollTo(0, start + (target - start) * p); if (p < 1) requestAnimationFrame(scroll) }
          requestAnimationFrame(scroll)
        })
        for (const label of ['carry', 'lift', 'travel', 'settle', 'land', 'rest-after']) { await sleep(180); await shot(label) }
        const sections = await page.evaluate(() => [...document.querySelectorAll('main > section, .site-foot')].map(el => el.getBoundingClientRect().y + scrollY))
        // Visit every section and reverse; the browser supplies actual per-frame scroll offsets.
        for (const y of [...sections, ...sections.toReversed()]) {
          await page.evaluate(y => scrollTo({ top: y, behavior: 'smooth' }), y)
          await sleep(650)
        }
        await page.evaluate(() => scrollTo(0, 0))
        await page.waitForFunction(() => window.__home.tips().some(tip => tip.id === 'me' && (!tip.phase || tip.phase === 'ground') && tip.on === -1 && tip.h < .05), null, { timeout: 5000 })
        const rollTarget = await page.evaluate(() => { const tip = window.__home.tips().find(tip => tip.id === 'me'); return { x: tip.x, y: tip.y + (tip.y < innerHeight / 2 ? 60 : -60) } })
        await page.mouse.move(rollTarget.x, rollTarget.y)
        await page.waitForFunction(() => {
          const tip = window.__home.tips().find(tip => tip.id === 'me'), previous = window.__scrollRollPrevious
          window.__scrollRollPrevious = tip
          return tip && previous && (!tip.phase || tip.phase === 'ground') && tip.on === -1 && tip.h < .05 && Math.abs(tip.h - previous.h) < .01 &&
            Math.hypot(tip.x - previous.x, tip.y - previous.y) > .2 && window.__home.contacts().marbles.some(m => m.id === 'me' && m.speed > .1)
        }, null, { timeout: 5000 })
        const rollingStart = await page.evaluate(() => ({ scroll: scrollY, tips: window.__home.tips(), contacts: window.__home.contacts().marbles }))
        await page.evaluate(() => scrollTo({ top: innerHeight, behavior: 'smooth' }))
        await sleep(1200)
        // Deliberately tight layout: a fixed solid card leaves no landing spot in view.
        await page.evaluate(() => {
          const panel = document.createElement('div')
          panel.className = 'build-card'; panel.id = 'scroll-proof-tight'
          panel.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border-radius:0;pointer-events:none;background:rgba(210,220,214,.18);z-index:0'
          document.querySelector('main').append(panel)
          dispatchEvent(new Event('resize'))
          scrollBy(0, 30)
        })
        if (!before) await page.waitForFunction(() => window.__home.tips().some(tip => tip.phase === 'lift'), null, { timeout: 3000 })
        else await sleep(100)
        await shot('tight-lift')
        for (const label of ['dock-travel', 'dock-held']) { await sleep(330); await shot(label) }
        await sleep(1200)
        await shot('dock-settled')
        await page.locator('[data-field-toggle]').click()
        await shot('dock-tapped')
        if (before) await page.locator('[data-field-toggle]').click()
        // Screencast frames preserve the short impact and bounce without screenshot calls stretching the cadence.
        const cast = []
        const receive = event => { cast.push({ png: event.data, timestamp: event.metadata.timestamp * 1000 }); void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}) }
        cdp.on('Page.screencastFrame', receive)
        await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: width, maxHeight: height })
        await page.evaluate(() => { window.__scrollDropStart = 0; document.getElementById('scroll-proof-tight').remove(); dispatchEvent(new Event('resize')) })
        // A settled field stops submitting screencast frames. Capture the final state at its requested time,
        // keeping the measured capture interval instead of assigning 800 ms to an older compositor frame.
        const finalLandingCapture = before ? Promise.resolve(null) : (async () => {
          await page.waitForFunction(() => window.__scrollDropStart > 0, null, { timeout: 5000 })
          await page.evaluate(() => new Promise(resolve => setTimeout(resolve, Math.max(0, window.__scrollDropStart + 800 - performance.now()))))
          const captureStartedMs = await page.evaluate(() => performance.now() - window.__scrollDropStart)
          const screenshot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, captureBeyondViewport: false })
          const actualMs = await page.evaluate(() => performance.now() - window.__scrollDropStart)
          const path = `${width}-drop-800.jpg`
          await writeFile(join(raw, path), Buffer.from(screenshot.data, 'base64'))
          return { path, nominalMs: 800, captureStartedMs, actualMs, errorMs: actualMs - 800, timestampSource: 'capture completion; start bounds the capture interval' }
        })().catch(error => ({ error }))
        for (const label of ['release', 'landing', 'landed']) { await sleep(300); await shot(label) }
        await sleep(1300)
        await shot('settled')
        const finalLanding = await finalLandingCapture
        if (finalLanding?.error) throw finalLanding.error
        await cdp.send('Page.stopScreencast')
        cdp.off('Page.screencastFrame', receive)
        const clock = await page.evaluate(() => ({ origin: performance.timeOrigin, drop: window.__scrollDropStart }))
        const landingFrames = []
        if (clock.drop && cast.length) {
          for (const nominalMs of [0, 120, 234, 300, 480, 800]) {
            if (nominalMs === 800 && finalLanding) {
              landingFrames.push(finalLanding)
              frames.push({ path: finalLanding.path, timeMs: finalLanding.actualMs,
                failed: Math.max(Math.abs(finalLanding.captureStartedMs - 800), Math.abs(finalLanding.actualMs - 800)) > 80 })
              continue
            }
            const target = clock.origin + clock.drop + nominalMs
            const frame = cast.reduce((a, b) => Math.abs(a.timestamp - target) <= Math.abs(b.timestamp - target) ? a : b)
            const path = `${width}-drop-${nominalMs}.png`
            await writeFile(join(raw, path), Buffer.from(frame.png, 'base64'))
            const actualMs = frame.timestamp - clock.origin - clock.drop
            landingFrames.push({ path, nominalMs, actualMs, errorMs: actualMs - nominalMs })
            frames.push({ path, timeMs: actualMs, failed: Math.abs(actualMs - nominalMs) > 80 })
          }
        }
        const samples = await page.evaluate(() => { window.__scrollRecording = false; return window.__scrollSamples })
        const teleports = [], groundJumps = [], badLandings = [], missing = [], hidden = [], interiors = [], stuck = [], slips = []
        let rideSamples = 0
        let quietSince = samples[0]?.t || 0
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1], b = samples[i]
          if (!b.tips.length || b.enabled === false) missing.push(b.t)
          if (Math.abs(b.scroll - a.scroll) > .5) quietSince = b.t
          for (const outline of b.outlines || []) {
            if (outline.left < -1 || outline.right > width + 1 || outline.top < outline.area.top - 1 || outline.bottom > outline.area.bottom + 1) hidden.push({ t: b.t, outline })
          }
          if (b.interiors?.length) interiors.push({ t: b.t, interiors: b.interiors })
          for (const tip of b.tips) {
            const prev = a.tips.find(p => p.id === tip.id)
            if (!prev) continue
            const jump = Math.hypot(tip.x - prev.x, tip.y - prev.y)
            const scrollDelta = b.scroll - a.scroll
            if (width < 600 && prev.phase === 'ground' && tip.phase === 'ground' && Math.abs(scrollDelta) > .1 && Math.abs(scrollDelta) < 6 &&
              a.contacts.find(m => m.id === tip.id)?.speed < .1 && b.contacts.find(m => m.id === tip.id)?.speed < .1) {
              rideSamples++
              const slip = Math.abs(tip.y + b.scroll - prev.y - a.scroll)
              if (slip > 1.5) slips.push({ t: b.t, slip, scrollDelta })
            }
            // The correction budget excludes integrated travel, including desktop cursor chases. Two fixed
            // steps cover clock quantization and drawing interpolation; a stationary marble still gets only 18 px.
            if (jump > 18 && (!tip.phase || tip.phase === 'ground') && (!prev.phase || prev.phase === 'ground') && !tip.airborne && !prev.airborne) {
              const speed = Math.max(Math.hypot(prev.vx ?? 0, prev.vy ?? 0), Math.hypot(tip.vx ?? 0, tip.vy ?? 0))
              const physicalEnvelope = speed * (Math.max(0, b.sim - a.sim) + 2 / 240)
              // Projection roundoff can put a capped carry a few trillionths above its 18px limit.
              const measured = { t: b.t, jump, physicalEnvelope, correctionBudget: 18, projectionTolerance: 1e-6, prev, tip }
              groundJumps.push(measured)
              if (jump > physicalEnvelope + 18 + measured.projectionTolerance) teleports.push(measured)
            }
            if (tip.phase === 'ground' && prev.phase === 'land' && (tip.free === false || jump > 18)) badLandings.push({ t: b.t, jump, prev, tip })
            if (['lift', 'land', 'dock'].includes(tip.phase) && tip.age > 3 && b.t - quietSince > 3000) stuck.push({ t: b.t, tip })
          }
        }
        // Close the capture renderer so its demos cannot compete with isolated native timing.
        await context.close()
        const pacing = await measurePacing(browser, local, width, height)
        const phases = [...new Set(samples.flatMap(s => s.tips.map(tip => tip.phase)))]
        results.push({ viewport: [width, height], dpr: 1, baseline: before, motion: 'no-preference', cpuRate: 4, seconds: 10, sampleCount: samples.length, touchGestures, rollingStart, rideSamples, slips, phases, teleports, groundJumps, badLandings, missing, hidden, interiors, stuck, shots, landingFrames, samples, pacing })
        const cellWidth = width < 600 ? 240 : 320
        const cellHeight = width < 600 ? 520 : Math.round(cellWidth * height / width)
        const cells = await Promise.all(shots.map(async s => {
          const image = await sharp(join(raw, s.path)).resize(cellWidth, cellHeight, { fit: 'contain', background: '#e9ede8' }).toBuffer()
          const label = `${width} ${s.label} / ${s.tips[0]?.phase || 'legacy'}`
          return sharp({ create: { width: cellWidth, height: cellHeight + 28, channels: 4, background: '#e9ede8' } }).composite([{ input: image, top: 28, left: 0 }, { input: Buffer.from(`<svg width="${cellWidth}" height="28"><text x="6" y="19" font-size="12" font-family="sans-serif">${label}</text></svg>`), top: 0, left: 0 }]).png().toBuffer()
        }))
        await sharp({ create: { width: cellWidth * 5, height: (cellHeight + 28) * Math.ceil(cells.length / 5), channels: 4, background: '#e9ede8' } }).composite(cells.map((input, i) => ({ input, left: (i % 5) * cellWidth, top: Math.floor(i / 5) * (cellHeight + 28) }))).webp({ quality: 90 }).toFile(join(out, `strip-${width}.webp`))
        const closeups = await Promise.all(shots.map(async s => {
          const tip = s.tips[0] || { x: width - 35, y: height - 70 }
          return sharp(join(raw, s.path)).extract({ left: Math.max(0, Math.min(width - 100, Math.round(tip.x - 50))), top: Math.max(0, Math.min(height - 100, Math.round(tip.y - 50))), width: 100, height: 100 }).resize(200, 200).png().toBuffer()
        }))
        await sharp({ create: { width: 200 * 8, height: 200 * Math.ceil(closeups.length / 8), channels: 4, background: '#e9ede8' } }).composite(closeups.map((input, i) => ({ input, left: i % 8 * 200, top: Math.floor(i / 8) * 200 }))).webp({ quality: 90 }).toFile(join(out, `detail-${width}.webp`))
        if (landingFrames.length) {
          const tip = samples.find(s => s.t >= clock.drop)?.tips[0]
          const tiles = await Promise.all(landingFrames.map(async frame => {
            const crop = await sharp(join(raw, frame.path)).extract({ left: Math.max(0, Math.min(width - 120, Math.round(tip.x - 60))), top: Math.max(0, Math.min(height - 120, Math.round(tip.y - 60))), width: 120, height: 120 }).resize(240, 240).toBuffer()
            const label = `drop ${frame.nominalMs}ms (actual ${Math.round(frame.actualMs)})`
            return sharp({ create: { width: 240, height: 268, channels: 4, background: '#e9ede8' } }).composite([{ input: crop, top: 28, left: 0 }, { input: Buffer.from(`<svg width="240" height="28"><text x="6" y="19" font-size="12" font-family="sans-serif">${label}</text></svg>`), top: 0, left: 0 }]).png().toBuffer()
          }))
          await sharp({ create: { width: tiles.length * 240, height: 268, channels: 4, background: '#e9ede8' } }).composite(tiles.map((input, i) => ({ input, top: 0, left: i * 240 }))).webp({ quality: 92 }).toFile(join(out, `landing-${width}.webp`))
        }
        if (!before && (teleports.length || badLandings.length || missing.length || hidden.length || interiors.length || stuck.length)) failures.push(`${width}px: ${teleports.length} teleports, ${badLandings.length} bad landings, ${missing.length} missing, ${hidden.length} clipped, ${interiors.length} interiors, ${stuck.length} stuck`)
        if (!before && !['lift', 'land', 'dock', 'docked'].every(phase => phases.includes(phase))) failures.push(`${width}px missing a choreography phase`)
        if (!before && width < 600 && (!rideSamples || slips.length)) failures.push(`${width}px: ${rideSamples} slow tray frames, ${slips.length} page-space slips`)
        if (!before && pacing.p95 - 16.9 > 1e-6) failures.push(`${width}px 4x CPU p95 ${pacing.p95.toFixed(1)}ms`)
        const renderWork = pacing.frames.map(frame => frame.activity.renderMs).filter(Number.isFinite).sort((a, b) => a - b)
        const render95 = renderWork[Math.floor(renderWork.length * .95)]
        console.log(`    scroll ${width}px: ${teleports.length} jumps, ${hidden.length} clipped, ${interiors.length} interiors, ${stuck.length} stuck; CPU4 p95 on/off/on ${pacing.p95.toFixed(1)}/${pacing.disabled.p95.toFixed(1)}/${pacing.onAgain.p95.toFixed(1)}ms; render p95 ${render95?.toFixed(2) ?? 'unmeasured'}ms`)
      } finally { await context.close() }
    }
    const reducedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, reducedMotion: 'reduce', ignoreHTTPSErrors: true })
    let reduced
    try {
      const page = await reducedContext.newPage()
      await page.goto(homeUrl(local, 390))
      await page.waitForFunction(() => window.__home?.tips().length)
      await sleep(4000)
      reduced = await page.evaluate(async () => {
        const samples = [], max = document.documentElement.scrollHeight - innerHeight
        let begin = 0
        await new Promise(resolve => {
          function frame(t) {
            if (!begin) begin = t
            const elapsed = t - begin
            if (elapsed < 3000) scrollTo(0, max * (1 - Math.abs(1 - elapsed / 1500)))
            samples.push({ elapsed, tips: window.__home.tips() })
            if (elapsed < 5500) requestAnimationFrame(frame)
            else resolve()
          }
          requestAnimationFrame(frame)
        })
        return { motion: matchMedia('(prefers-reduced-motion: reduce)').matches, samples }
      })
      if (!before && reduced.samples.some(s => s.tips.some(tip => tip.phase !== 'ground' && Math.abs(tip.h) > .05))) failures.push('reduced motion used an elevated lift or bounce')
      if (!before && reduced.samples.at(-1).tips.some(tip => !['ground', 'docked'].includes(tip.phase))) failures.push('reduced motion did not settle')
    } finally { await reducedContext.close() }
    await writeFile(join(out, 'measurements.json'), JSON.stringify({ before, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), browser: browser.version(), device: 'Chromium emulation; physical-phone performance unmeasured', failures, results, reduced }, null, 2))
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 5, frames }, null, 2))
    if (failures.length) throw new Error(failures.join('; '))
    return results.map(r => `${r.viewport[0]}px: ${r.teleports.length} teleports, 4x p95 ${r.pacing.p95.toFixed(1)}ms`).join('; ')
  })
}
