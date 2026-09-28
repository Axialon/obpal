/** Real phone touch events over authenticated WebRTC, plus an eight-seat jam and portable evidence. */
import { chromium, devices } from 'playwright'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startLocal } from '../extension/e2e/local.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const assert = (ok, message) => { if (!ok) throw new Error(message) }
const quantile = (a, q) => { const s = [...a].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))] ?? 0 }
const latencyStats = ms => ({ medianMs: quantile(ms, 0.5), p90Ms: quantile(ms, 0.9), p95Ms: quantile(ms, 0.95), p99Ms: quantile(ms, 0.99) })
async function until(fn, ms = 20000) { const end = Date.now() + ms; while (!await fn()) { if (Date.now() > end) throw new Error('Music state timed out'); await sleep(100) } }

export async function runMusic(local, check) {
  const dir = process.env.OBPAL_EVIDENCE ? resolve('artifacts/codex-music') : await mkdtemp(join(tmpdir(), 'obpal-music-'))
  await mkdir(dir, { recursive: true })
  console.log(`  Music measurements and captures: ${dir}`)
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] })
  const errors = [], phones = [], metrics = []
  let contextId = '', report = {}
  const watch = page => page.on('pageerror', e => errors.push(e.message))
  try {
    const host = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const screen = await host.newPage(); watch(screen)
    const audioCDP = await host.newCDPSession(screen)
    await audioCDP.send('WebAudio.enable')
    audioCDP.on('WebAudio.contextCreated', ({ context }) => { if (context.contextType === 'realtime') contextId = context.contextId })
    await check('studio: its catalogue card has a silent live preview and both music filters', async () => {
      await screen.goto(`${local.origin}/sim/?face=drums`)
      await screen.locator('.dcard[data-id="studio"] .dcard-stage.live').waitFor({ timeout: 20000 })
      assert((await screen.evaluate(() => window.__sims.cards())).join() === 'studio', 'Drums filter')
      await screen.locator('#controller-filter').selectOption('face.keys')
      assert((await screen.evaluate(() => window.__sims.cards())).join() === 'studio', 'Keys filter')
      assert(await screen.locator('.dcard[data-id="studio"] .dcard-go').getAttribute('href') === '/sim/device/?d=studio', 'Studio card route')
      assert(!contextId, 'The preview started audio')
      await screen.screenshot({ path: join(dir, 'catalogue-1280x800.png') })
    })
    await screen.goto(`${local.origin}/sim/device/?d=studio`)
    await until(() => screen.evaluate(() => !!window.__studio && !!window.__obpal?.pairingUrl))
    await check('studio: eight stations and a gesture-gated audio context', async () => {
      const state = await screen.evaluate(() => ({ units: window.__device.units.length, context: window.__studio.sound.context }))
      assert(state.units === 8 && state.context === null, JSON.stringify(state))
      await screen.locator('#studio-start').click()
      await until(() => screen.evaluate(() => window.__studio.sound.running))
      return 'sound starts from the screen button'
    })
    const invite = await screen.evaluate(() => window.__obpal.pairingUrl)
    await check('studio: eight emulated phones claim eight independent instruments', async () => {
      for (let n = 0; n < 8; n++) {
        const ctx = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
        const page = await ctx.newPage(); watch(page)
        const cdp = await ctx.newCDPSession(page)
        await cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 70, gamma: 0 })
        await page.goto(invite)
        try { await page.locator('.drums-face:not([hidden])').waitFor({ timeout: 30000 }) }
        catch (e) { await page.screenshot({ path: join(dir, 'debug-phone.png') }); throw new Error(`${e.message}; ${await page.locator('body').innerText()}; errors: ${errors.join(' | ')}`) }
        await page.evaluate(() => document.querySelectorAll('.hint').forEach(h => h.remove()))
        if (n >= 3 && n <= 6) await page.locator('[data-tab=keys]').click()
        const touch = async (type, points = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1, force: 0.7, radiusX: 5, radiusY: 5 })) })
        const point = async selector => { const r = await page.locator(selector).boundingBox(); assert(r, `Missing ${selector}`); return [r.x + r.width / 2, r.y + r.height / 2] }
        phones.push({ page, ctx, cdp, touch, point })
      }
      const held = await screen.evaluate(() => Object.keys(window.__sim.claims.snapshot()).length)
      assert(held === 8, `${held} claims`)
      return `${held} claims`
    })
    if (phones.length !== 8) return
    await check('studio: drum touch, physical binding and acceleration strike arrive as sound', async () => {
      const p = phones[0], before = await screen.evaluate(() => window.__device.logic.counts[0])
      const xy = await p.point('[data-drum="0"]'); await p.touch('touchStart', [xy]); await p.touch('touchEnd')
      await p.page.keyboard.press('Enter')
      await p.page.locator('.music-toggle', { hasText: 'Strike mode' }).click()
      const arm = await p.point('.strike-pad'); await p.touch('touchStart', [arm])
      for (const a of [0, 9, 24, 8, 0]) { await p.page.evaluate(a => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: 0, y: -a * Math.sin(70 * Math.PI / 180), z: -a * Math.cos(70 * Math.PI / 180) }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 })), a); await sleep(18) }
      await p.touch('touchEnd'); await p.page.locator('.music-toggle', { hasText: 'Strike mode' }).click()
      await until(async () => await screen.evaluate(() => window.__device.logic.counts[0]) >= before + 3)
      return 'pad, Enter and one debounced strike'
    })
    await check('studio: keys sustain on hold, bend, and release on controller switch', async () => {
      const p = phones[3], key = await p.point('[data-degree="0"]'), third = await p.point('[data-degree="2"]'), sustain = await p.point('.sustain')
      await p.touch('touchStart', [sustain]); await p.touch('touchStart', [sustain, key, third]); await sleep(100)
      await p.touch('touchEnd', [sustain]); await sleep(100)
      assert(await screen.evaluate(() => window.__studio.sound.voices.filter(v => v.seat === 3).length === 2), 'Sustain lost its chord')
      await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 70, gamma: 15 })
      // The orientation override is delivered asynchronously; a real phone keeps sampling motion afterwards.
      for (let i = 0; i < 5; i++) { await sleep(40); await p.page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 } }))) }
      const bend = await screen.evaluate(() => window.__studio.sound.voices.filter(v => v.seat === 3).flatMap(v => v.oscillators.map(o => o.detune.value)))
      assert(bend.some(v => Math.abs(v) > 10), `Tilt did not bend the chord: ${JSON.stringify(bend)}`)
      await p.touch('touchEnd')
      await p.page.locator('[data-tab=drums]').click()
      await until(() => screen.evaluate(() => window.__studio.sound.active === 0))
      const pad = await p.point('[data-drum="0"]')
      await p.touch('touchStart', [pad]); await p.touch('touchEnd')
      await until(() => screen.evaluate(() => window.__studio.sound.voices.some(v => v.seat === 3)))
      await until(() => screen.evaluate(() => !window.__studio.sound.voices.some(v => v.seat === 3)), 2000)
      await p.page.locator('[data-tab=keys]').click()
      return 'held pedal, switch cleanup and one-shot pads at a synth'
    })
    await check('studio: the held air voice follows orientation and releases', async () => {
      const p = phones[6], xy = await p.point('.air-pad')
      try {
        await p.touch('touchStart', [xy])
        await until(() => screen.evaluate(() => window.__studio.sound.voices.some(v => v.seat === 6 && v.key === 127)))
        const before = await screen.evaluate(() => window.__studio.sound.voices.find(v => v.seat === 6 && v.key === 127).oscillators[0].frequency.value)
        await p.cdp.send('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta: 35, gamma: 20 })
        for (let i = 0; i < 5; i++) { await sleep(40); await p.page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 0 } }))) }
        await until(() => screen.evaluate(before => {
          const voice = window.__studio.sound.voices.find(v => v.seat === 6 && v.key === 127)
          return !!voice && voice.oscillators[0].frequency.value !== before
        }, before), 2000)
      } finally { await p.touch('touchEnd') }
      await until(() => screen.evaluate(() => !window.__studio.sound.voices.some(v => v.seat === 6)))
    })
    await check('studio: warmed touch-to-schedule median and p90 meet the budget', async () => {
      const warmup = 32, count = 160
      const exercise = async n => {
        for (let i = 0; i < n; i++) {
          const p = phones[i % 2 ? 3 : 0], xy = await p.point(i % 2 ? `[data-degree="${i % 8}"]` : `[data-drum="${i % 3}"]`)
          await p.touch('touchStart', [xy]); await sleep(24); await p.touch('touchEnd'); await sleep(24)
        }
      }
      // Exercise both actual paths before sampling: clock exchange, JIT and voice allocation.
      await sleep(2300)
      await screen.evaluate(() => { window.__studio.samples.length = 0 })
      await exercise(warmup)
      await until(() => screen.evaluate(n => window.__studio.samples.length >= n, warmup))
      await screen.evaluate(() => { window.__studio.samples.length = 0 })
      for (const p of [phones[0], phones[3]]) await p.page.evaluate(() => {
        window.__musicDispatch = []
        document.addEventListener('pointerdown', e => window.__musicDispatch.push(performance.now() - e.timeStamp), { capture: true })
      })
      await exercise(count)
      await until(() => screen.evaluate(n => window.__studio.samples.length >= n, count))
      const data = await screen.evaluate(() => window.__studio.samples)
      const ms = data.map(s => s.ms)
      const perPhone = await Promise.all([phones[0], phones[3]].map(p => p.page.evaluate(() => window.__musicDispatch)))
      const dispatch = perPhone.flat()
      const application = [0, 3].flatMap((seat, p) => data.filter(s => s.seat === seat).map((s, i) => Math.max(0, s.ms - perPhone[p][i])))
      const controllers = [0, 3].map((seat, p) => {
        const own = data.filter(s => s.seat === seat)
        assert(own.length === count / 2 && perPhone[p].length === own.length, `Seat ${seat}: ${own.length} sounds, ${perPhone[p].length} touches`)
        return { seat, samples: own.length, ...latencyStats(own.map(s => s.ms)), browserDispatch: latencyStats(perPhone[p]), handlerToSchedule: latencyStats(own.map((s, i) => Math.max(0, s.ms - perPhone[p][i]))) }
      })
      const budget = { medianMs: 35, p90Ms: 100, handlerMedianMs: 15 }
      report.latency = { warmup, samples: data.length, ...latencyStats(ms), clockUncertaintyP95Ms: quantile(data.map(s => s.uncertainty), 0.95), browserDispatch: latencyStats(dispatch), handlerToSchedule: latencyStats(application), controllers, budget }
      // Keep every tail sample in the report. Gate sustained delay on each face, so one
      // fast controller cannot hide a slow one, and a scheduling offset cannot hide in dispatch.
      assert(data.length === count && ms.every(Number.isFinite) && application.every(Number.isFinite), `${data.length}/${count} finite events measured`)
      assert(controllers.every(c => c.medianMs < budget.medianMs && c.p90Ms < budget.p90Ms && c.handlerToSchedule.medianMs < budget.handlerMedianMs), JSON.stringify(report.latency))
      return JSON.stringify(report.latency)
    })
    await check('studio: eight-player jam stays within audio and render budgets', async () => {
      const points = await Promise.all(phones.map((p, n) => Promise.all((n >= 3 && n <= 6 ? [0, 2, 4, 1] : [0, 2, 1, 5]).map(d => p.point(n >= 3 && n <= 6 ? `[data-degree="${d}"]` : `[data-drum="${d}"]`)))))
      await screen.evaluate(() => {
        const s = window.__studio, stream = document.getElementById('stage').captureStream(30)
        for (const track of s.sound.capture.stream.getAudioTracks()) stream.addTrack(track)
        const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t))
        s.chunks = []; s.recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1800000 })
        s.recorder.ondataavailable = e => { if (e.data.size) s.chunks.push(e.data) }
        s.recorder.start(500); s.frameTimes.length = 0
        s.startPlayback = s.sound.context.playbackStats?.toJSON?.() ?? null
      })
      const before = await screen.evaluate(() => window.__studio.sound.scheduled)
      for (let beat = 0; beat < 32; beat++) {
        await Promise.all(phones.map((p, n) => p.touch('touchStart', [points[n][(beat + n) % 4]])))
        await sleep(70)
        await Promise.all(phones.map(p => p.touch('touchEnd')))
        if (contextId) { try { metrics.push((await audioCDP.send('WebAudio.getRealtimeData', { contextId })).realtimeData) } catch {} }
        await sleep(90)
      }
      await until(() => screen.evaluate(before => window.__studio.sound.scheduled >= before + 256, before), 2000)
      const jam = await screen.evaluate(async () => {
        const s = window.__studio
        await new Promise(r => { s.recorder.onstop = r; s.recorder.stop() })
        const blob = new Blob(s.chunks, { type: 'video/webm' })
        const data = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob) })
        const c = s.sound.context
        return { data, scheduled: s.sound.scheduled, gfx: s.gfx(), frames: s.frameTimes, peak: s.peak(), baseLatency: c.baseLatency, outputLatency: c.outputLatency ?? null, playbackBefore: s.startPlayback, playbackAfter: c.playbackStats?.toJSON?.() ?? null }
      })
      await writeFile(join(dir, 'jam.webm'), Buffer.from(jam.data.split(',')[1], 'base64'))
      report.jam = { events: jam.scheduled - before, triangles: jam.gfx.triangles, calls: jam.gfx.calls, medianFrameMs: quantile(jam.frames, 0.5), p95FrameMs: quantile(jam.frames, 0.95), peak: jam.peak, baseLatencyMs: jam.baseLatency * 1000, outputLatencyMs: jam.outputLatency === null ? null : jam.outputLatency * 1000, audioRenderCapacityMedianPercent: quantile(metrics.map(m => m.renderCapacity * 100), 0.5), audioRenderCapacityP95Percent: quantile(metrics.map(m => m.renderCapacity * 100), 0.95), audioMetricSamples: metrics.length, playbackBefore: jam.playbackBefore, playbackAfter: jam.playbackAfter }
      assert(report.jam.events === 256, `${report.jam.events}/256 sound attacks`)
      assert(jam.peak > 0 && jam.peak < 0.89, `Peak ${jam.peak}`)
      assert(jam.gfx.triangles <= 250000 && jam.gfx.calls <= 150, `${jam.gfx.triangles} triangles, ${jam.gfx.calls} calls`)
      assert(report.jam.p95FrameMs < 50, `Frame p95 ${report.jam.p95FrameMs}`)
      if (jam.playbackAfter && jam.playbackBefore) assert(jam.playbackAfter.underrunDuration === jam.playbackBefore.underrunDuration, 'Audio underrun during jam')
      return JSON.stringify(report.jam)
    })
    await check('studio: controller and room evidence fits desktop, portrait and landscape', async () => {
      for (const [width, height] of [[1280, 800], [390, 844], [844, 390]]) {
        await screen.setViewportSize({ width, height }); await sleep(500)
        await screen.locator('.dev-panel').evaluate(panel => { panel.scrollTop = 0 })
        await screen.screenshot({ path: join(dir, `studio-${width}x${height}.png`) })
        const playDistance = await screen.evaluate(() => { const s = window.__device.stage; return s.camera.position.distanceTo(s.controls.target) })
        await screen.getByRole('button', { name: 'Overview', exact: true }).click()
        await sleep(200)
        const overview = await screen.evaluate(() => {
          const s = window.__device.stage, panel = document.querySelector('.dev-panel').getBoundingClientRect()
          const side = panel.right < innerWidth / 2
          const inside = p => { const q = s.toScreen(s.controls.target.clone().set(...p)); return q && q.x >= (side ? panel.right : 0) && q.x <= innerWidth && q.y >= 64 && q.y <= (side ? innerHeight : panel.top) }
          const corners = [-5.2, 5.2].flatMap(x => [[x, 0, -3.7], [x, 0, 3.7], [x, 2.23, -3.7]])
          return { distance: s.camera.position.distanceTo(s.controls.target), roomFits: corners.every(inside) }
        })
        assert(overview.distance > playDistance * 1.4 && overview.roomFits, `Studio framing ${width}x${height}: ${JSON.stringify({ playDistance, ...overview })}`)
        await screen.screenshot({ path: join(dir, `studio-overview-${width}x${height}.png`) })
        await screen.getByRole('button', { name: 'Reset view', exact: true }).click()
        const resetDistance = await screen.evaluate(() => { const s = window.__device.stage; return s.camera.position.distanceTo(s.controls.target) })
        assert(Math.abs(resetDistance - playDistance) < 0.01, 'Reset view did not restore the closer play framing')
        for (const [p, name] of [[phones[0], 'drums'], [phones[3], 'keys']]) {
          await p.page.setViewportSize({ width, height }); await sleep(200)
          await p.page.evaluate(() => document.querySelectorAll('.hint').forEach(h => h.remove()))
          await p.page.screenshot({ path: join(dir, `${name}-${width}x${height}.png`) })
          const bad = await p.page.locator(`.${name === 'drums' ? 'music-pad' : 'tone-key'}`).evaluateAll(list => list.some(e => { const r = e.getBoundingClientRect(); return r.width < 44 || r.height < 44 || r.bottom > innerHeight || r.right > innerWidth }))
          assert(!bad, `${name} targets outside ${width}×${height}`)
        }
      }
    })
    await check('studio: no page errors', async () => { assert(!errors.length, errors.join(' | ')) })
    await check('studio: losing a claim and disconnecting both silence held notes', async () => {
      const p = phones[3], xy = await p.point('[data-degree="0"]')
      await p.touch('touchStart', [xy])
      await until(() => screen.evaluate(() => window.__studio.sound.voices.some(v => v.seat === 3)))
      await screen.evaluate(() => window.__sim.claims.release(window.__sim.claims.holder('studio4')))
      await until(() => screen.evaluate(() => !window.__studio.sound.voices.some(v => v.seat === 3)))
      await p.touch('touchEnd')
      const q = phones[4], note = await q.point('[data-degree="1"]')
      await q.touch('touchStart', [note]); await until(() => screen.evaluate(() => window.__studio.sound.voices.some(v => v.seat === 4)))
      await q.ctx.close()
      await until(() => screen.evaluate(() => !window.__studio.sound.voices.some(v => v.seat === 4)))
    })
  } finally {
    await browser.close()
    await writeFile(join(dir, 'measurements.json'), JSON.stringify(report, null, 2) + '\n')
    await writeFile(join(dir, 'index.html'), viewer(report))
  }
}

function viewer(report) {
  const images = ['studio', 'studio-overview', 'drums', 'keys'].map(name => `<section><h2>${name}</h2>${['1280x800', '390x844', '844x390'].map(size => `<a href="${name}-${size}.png"><img src="${name}-${size}.png" alt="${name} at ${size}" loading="lazy"></a>`).join('')}</section>`).join('')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Music studio evidence</title><style>body{margin:40px auto;padding:0 24px;max-width:1200px;background:#171b1a;color:#e4e9df;font:16px/1.6 system-ui}h1{font-size:42px}h2{text-transform:capitalize}section{display:flex;flex-wrap:wrap;gap:16px}section h2{width:100%}a{color:#c6ff34;max-width:100%}img{max-width:360px;width:100%;height:230px;object-fit:contain;background:#252b29;border-radius:12px}video{width:100%;max-height:600px}pre{white-space:pre-wrap;font-size:13px}</style><h1>Music studio</h1><p>Eight emulated phones, authenticated WebRTC, generated sound. Screenshots are the actual app; the jam records the stage canvas and its audio bus.</p><p>The close play view, full-room overview and controllers are shown below. <a href="catalogue-1280x800.png">Catalogue preview</a>.</p><video controls src="jam.webm"></video>${images}<h2>Measurements</h2><p>Event-to-schedule figures exclude physical speaker latency. Browser audio render capacity is a share of the render budget, not whole-process CPU. Headless output does not prove physical speaker behaviour.</p><pre>${JSON.stringify(report, null, 2)}</pre></html>`
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const local = await startLocal(); let passed = 0, total = 0
  try { await runMusic(local, async (name, fn) => { total++; try { const detail = await fn(); passed++; console.log(`  ✓ ${name}${detail ? ` (${detail})` : ''}`) } catch (e) { console.error(`  ✗ ${name}: ${e.message}`) } }) }
  finally { await local.close() }
  console.log(`passed ${passed}/${total}`); if (passed !== total) process.exitCode = 1
}
