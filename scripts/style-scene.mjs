/** Capture identical rover-yard views before and after the hard-surface pass. */
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'
import { createServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const phase = process.argv[2]
if (!['round3', 'round4'].includes(phase)) throw new Error('Choose round3 or round4')
const out = `artifacts/codex-style/${phase}`
await mkdir(out, { recursive: true })
for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  if (!process.env[key]) throw new Error(`${key} is required`)
  await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(Number(process.env[key]), '127.0.0.1', () => s.close(resolve)) })
}
const local = await startLocal({ dist: resolve(process.env.OBPAL_STYLE_BUILD || 'dist/client') })
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors'] })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  const errors = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto(`${local.origin}/sim/device/?d=rover&quality=native`)
  await page.waitForFunction(() => performance.getEntriesByName('obpal:rover:visible').length > 0)
  await page.evaluate(() => { document.querySelectorAll('body > :not(#stage)').forEach(el => { el.style.display = 'none' }); dispatchEvent(new Event('resize')) })
  for (const [name, eye, target] of [
    ['yard', [13, 15, 19], [0, 0, 0]],
    ['yard-ramp', [-2.8, 2.5, 1.5], [-5.7, .15, -1.8]],
    ['yard-gate', [-.4, 2.5, -1.8], [-3.3, .4, -4.4]],
    ['yard-floor', [2.5, 1.9, 3.4], [1.3, 0, 1.3]],
  ]) {
    await page.evaluate(({ eye, target }) => window.__device.stage.frame({ target, wide: eye, tall: eye, radius: 2, min: .4, max: 38 }), { eye, target })
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${out}/${name}.png` })
  }
  await page.evaluate(() => {
    const stream = document.querySelector('canvas#stage').captureStream(30)
    window.__sceneChunks = []; window.__sceneRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' })
    window.__sceneRecorder.ondataavailable = e => window.__sceneChunks.push(e.data)
    window.__sceneRecorder.start()
    const start = performance.now(), stage = window.__device.stage
    const move = now => { const t = Math.min(1, (now - start) / 5000), a = .65 + .3 * (t*t*(3-2*t)); stage.camera.position.set(Math.sin(a)*25, 15, Math.cos(a)*25); stage.controls.target.set(0,0,0); stage.view.invalidate(); if (t < 1) requestAnimationFrame(move) }
    requestAnimationFrame(move)
  })
  await page.waitForTimeout(5300)
  const bytes = await page.evaluate(() => new Promise(resolve => {
    window.__sceneRecorder.onstop = async () => { resolve(Array.from(new Uint8Array(await new Blob(window.__sceneChunks).arrayBuffer()))); window.__sceneRecorder.stream.getTracks().forEach(t => t.stop()) }
    window.__sceneRecorder.stop()
  }))
  await writeFile(`${out}/yard-motion.webm`, Buffer.from(bytes))
  await writeFile(`${out}/scene-report.json`, JSON.stringify({ phase, errors, graphics: await page.evaluate(() => window.__gfx()) }, null, 2))
  if (errors.length) throw new Error(errors.join('\n'))
} finally { await browser?.close(); await local.close() }
