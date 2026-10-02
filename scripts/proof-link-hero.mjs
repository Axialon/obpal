/** Comparable finite journey previews, captured on the local guarded site only. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startLocal } from '../extension/e2e/local.mjs'
import { resolveChromium } from './lib/browser.mjs'
import { rawRun } from './lib/distill.mjs'

const revision = process.argv[2] || 'after'
const out = process.env.OBPAL_HERO_PROOF_OUT || join('artifacts/dot-loaders/link-hero', revision)
mkdirSync(out, { recursive: true })
const raw = rawRun(out)
const local = await startLocal({ dist: revision === 'before' ? resolve('artifacts/dot-loaders/link-hero/before/site/client') : undefined })
const resolved = await resolveChromium()
const browser = await chromium.launch({ executablePath: resolved.path || undefined, args: ['--ignore-certificate-errors'] })
const frames = [], rows = [], metrics = []
const source = revision === 'before' ? 'acd8501c6dad631d994f749eaec06d41ad480573' : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const workingDiff = revision === 'after' ? execFileSync('git', ['diff', '--stat'], { encoding: 'utf8' }) : ''
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
try {
  for (const width of [1280, 390]) for (const state of ['idle', 'pairing', 'connected', 'pc', 'dropped']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference', ignoreHTTPSErrors: true })
    const page = await context.newPage()
    try {
      await page.goto(local.origin + '/link/')
      await page.evaluate(() => document.fonts.ready)
      const figure = page.locator('.constellation')
      await figure.scrollIntoViewIfNeeded()
      const supported = await page.locator('[data-link-hero]').count() > 0
      const trigger = async () => {
        if (!supported) return
        if (state === 'idle') { await page.reload(); await page.evaluate(() => document.fonts.ready); await figure.scrollIntoViewIfNeeded(); return }
        if (state === 'dropped') await page.locator('#hero-reset').click()
        else {
          await page.locator(`[data-link-step="${state === 'pairing' ? 'pair' : 'enable'}"]`).click()
          if (state === 'pc') await page.locator('#hero-pc').click()
        }
      }
      await trigger()
      const start = performance.now()
      const cells = []
      for (const timeMs of [0, 950, 1350, 9800]) {
        await page.waitForTimeout(Math.max(0, timeMs - (performance.now() - start)))
        const folder = `${state}-${width}`
        mkdirSync(join(raw, folder), { recursive: true })
        const path = `${folder}/${timeMs}.png`
        const image = await figure.screenshot({ path: join(raw, path) })
        frames.push({ path, timeMs: performance.now() - start })
        const cell = await sharp(image).resize(480, 410, { fit: 'contain', background: '#101319' }).png().toBuffer()
        cells.push(cell)
      }
      const labels = Buffer.from(`<svg width="1920" height="30"><rect width="100%" height="100%" fill="#101319"/>${[0, 950, 1350, 9800].map((time, i) => `<text x="${i * 480 + 8}" y="20" fill="white" font-size="14">${revision} ${state} ${width}px +${time}ms${!supported && state !== 'idle' ? ' (baseline has no state)' : ''}</text>`).join('')}</svg>`)
      rows.push(await sharp({ create: { width: 1920, height: 440, channels: 3, background: '#101319' } }).composite([{ input: labels, top: 0, left: 0 }, ...cells.map((input, i) => ({ input, top: 30, left: i * 480 }))]).png().toBuffer())
      for (const throttle of [1, 4]) {
        const session = await context.newCDPSession(page)
        await session.send('Emulation.setCPUThrottlingRate', { rate: throttle })
        if (state === 'dropped') { await page.waitForTimeout(700); await trigger() }
        else { await trigger(); await page.waitForTimeout(700) }
        const startFrames = Number(await page.locator('#link-space').getAttribute('data-dot-frames'))
        const initialPart = await page.locator('#link-space').getAttribute('data-dot-part')
        const sample = await page.evaluate(() => new Promise(resolve => {
          const intervals = [], tasks = []
          const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))))
          observer.observe({ type: 'longtask' })
          let previous = 0, first = 0
          function tick(now) {
            if (!first) first = now
            if (previous) intervals.push(now - previous)
            previous = now
            if (now - first < 2000) requestAnimationFrame(tick)
            else { observer.disconnect(); resolve({ intervals, tasks }) }
          }
          requestAnimationFrame(tick)
        }))
        metrics.push({ state, width, throttle, supported, draws: Number(await page.locator('#link-space').getAttribute('data-dot-frames')) - startFrames, initialPart, finalPart: await page.locator('#link-space').getAttribute('data-dot-part'), ...sample, count: sample.intervals.length, median: percentile(sample.intervals, 0.5), p95: percentile(sample.intervals, 0.95), maximum: Math.max(...sample.intervals) })
        await session.detach()
      }
      console.log(`${revision} ${state} ${width}: captured`)
    } finally { await context.close() }
  }
  await sharp({ create: { width: 1920, height: rows.length * 440, channels: 3, background: '#101319' } }).composite(rows.map((input, i) => ({ input, top: i * 440, left: 0 }))).png().toFile(join(out, 'frame-strip.png'))
  writeFileSync(join(out, 'metrics.json'), JSON.stringify({ source, workingDiff, browser: browser.version(), playwright: '1.63.0', dpr: 1, motion: 'no-preference', device: 'desktop Chromium with viewport emulation', warmupMs: 700, durationMs: 2000, timing: 'rAF timestamps; CPU submission and GPU unmeasured', metrics }, null, 2))
  writeFileSync(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: 40, frames }, null, 2))
} finally { await browser.close(); await local.close() }
