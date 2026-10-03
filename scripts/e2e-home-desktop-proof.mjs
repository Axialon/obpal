/** Desktop rolling proof, inside the home runner's browser, helper guard and GPU lease. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import sharp from 'sharp'
import { rawRun } from './lib/distill.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function runHomeDesktopProof(browser, local, check) {
  await check('desktop free motion: chase, fast pointer reversals, flick and free rolling stay continuous', async () => {
    const baseline = process.env.OBPAL_DESKTOP_BASELINE === '1'
    const out = join(process.env.OBPAL_E2E_EVIDENCE_ROOT || 'artifacts/home-marbles-scroll-r2/after', 'desktop-free-motion')
    await mkdir(out, { recursive: true })
    const raw = rawRun(out), frames = [], results = [], failures = []
    for (const width of [1920, 1440]) {
      const height = 1080
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, ignoreHTTPSErrors: true })
      const page = await context.newPage(), shots = []
      try {
        await page.goto(local.origin)
        await page.waitForFunction(() => window.__home?.tips().length && window.__home.contacts().rects.length > 20)
        await page.mouse.move(48, 350)
        await sleep(1200)
        const shot = async label => {
          const { tip, timeMs } = await page.evaluate(() => ({ tip: window.__home.tips().find(t => t.id === 'me'), timeMs: performance.now() }))
          const path = `${width}-${shots.length}-${label}.png`
          await page.screenshot({ path: join(raw, path) })
          shots.push({ path, label, tip })
          frames.push({ path, failed: tip.phase !== 'ground' || tip.ring, timeMs })
        }
        const run = async (name, velocity, drive) => {
          await page.evaluate(({ velocity, name }) => {
            window.__home.roll(48, 750, 0, velocity)
            window.__desktopSamples = []
            window.__desktopRecording = name
            function sample(t) {
              if (window.__desktopRecording !== name) return
              setTimeout(() => {
                if (window.__desktopRecording !== name) return
                window.__desktopSamples.push({ t, sim: window.__home.sim().t, tip: window.__home.tips().find(t => t.id === 'me') })
              }, 0)
              requestAnimationFrame(sample)
            }
            requestAnimationFrame(sample)
          }, { velocity, name })
          await drive()
          const samples = await page.evaluate(() => { window.__desktopRecording = ''; return window.__desktopSamples })
          const phases = samples.filter(s => s.tip.phase !== 'ground'), rings = samples.filter(s => s.tip.ring), discontinuities = []
          let travel = 0, maxJump = 0, peakSpeed = 0
          for (let i = 1; i < samples.length; i++) {
            const a = samples[i - 1], b = samples[i], p = a.tip, q = b.tip
            const jump = Math.hypot(q.x - p.x, q.y - p.y)
            const speed = Math.max(Math.hypot(p.vx, p.vy), Math.hypot(q.vx, q.vy))
            // Drawing interpolates between 1/240 s physics steps. Clock quantization and its one-step lag
            // require at most two additional steps; the pixel epsilon covers projection roundoff.
            const envelope = speed * (Math.max(0, b.sim - a.sim) + 2 / 240) + 1
            if (jump > envelope) discontinuities.push({ at: b.t, jump, envelope, before: p, after: q })
            maxJump = Math.max(maxJump, jump); peakSpeed = Math.max(peakSpeed, speed); travel += jump
          }
          const result = { width, height, name, samples: samples.length, travel, maxJump, peakSpeed,
            phases: phases.map(s => ({ at: s.t, phase: s.tip.phase })), rings: rings.length, discontinuities }
          results.push(result)
          if (phases.length || rings.length || discontinuities.length || samples.length < 8 || travel < 50) failures.push(`${width} ${name}: phases ${phases.length}, rings ${rings.length}, discontinuities ${discontinuities.length}, travel ${travel.toFixed(1)}, samples ${samples.length}`)
        }
        await run('cursor chase and fast moves away', 0, async () => {
          await shot('rest')
          await page.mouse.move(48, 200)
          for (const label of ['chase', 'peak-travel', 'approach']) { await sleep(180); await shot(label) }
          await page.mouse.move(48, 850)
          for (const label of ['reversal', 'return', 'settle']) { await sleep(180); await shot(label) }
        })
        await run('pointer flick', 0, async () => {
          await page.mouse.move(48, 750)
          await page.mouse.down()
          await page.mouse.move(48, 200, { steps: 3 })
          await page.mouse.up()
          await sleep(180); await shot('flick')
          await sleep(900)
        })
        await run('fast free rolling', -1800, async () => {
          await sleep(100); await shot('free-roll')
          await sleep(300); await shot('free-roll-contact')
          await sleep(600); await shot('free-roll-settle')
        })
        const tiles = await Promise.all(shots.map(async ({ path, label, tip }) => {
          const left = Math.max(0, Math.min(width - 180, Math.round(tip.x - 90)))
          const top = Math.max(0, Math.min(height - 180, Math.round(tip.y - 90)))
          const image = await sharp(join(raw, path)).extract({ left, top, width: 180, height: 180 }).png().toBuffer()
          const text = `${label} / ${tip.phase}${tip.ring ? ' ring' : ''}`
          return sharp({ create: { width: 220, height: 216, channels: 4, background: '#e9ede8' } }).composite([
            { input: image, top: 32, left: 20 },
            { input: Buffer.from(`<svg width="220" height="28"><text x="4" y="18" font-family="sans-serif" font-size="11">${text}</text></svg>`), top: 0, left: 0 },
          ]).png().toBuffer()
        }))
        await sharp({ create: { width: 220 * 6, height: 216 * Math.ceil(tiles.length / 6), channels: 4, background: '#e9ede8' } }).composite(tiles.map((input, i) => ({ input, left: i % 6 * 220, top: Math.floor(i / 6) * 216 }))).webp({ quality: 92 }).toFile(join(out, `strip-${width}.webp`))
      } finally { await context.close() }
    }
    await writeFile(join(out, 'measurements.json'), JSON.stringify({ source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baseline, dpr: 1, browser: browser.version(), motion: 'no-preference', results, failures }, null, 2))
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: frames.length, fps: 6, frames }, null, 2))
    if (failures.length && !baseline) throw new Error(failures.join('; '))
    return `${results.length} scenarios; ${failures.length} failures${baseline ? ' (recorded baseline)' : ''}`
  })
}
