/** Diagnostic captures are explicitly requested evidence, separate from the e2e tests' temporary output. */
import { distill, rawRun } from './lib/distill.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { startLocal } from '../extension/e2e/local.mjs'
import { detectE2eGpu, e2eBrowserOptions, resolveChromium } from './lib/browser.mjs'
import { acquireGpuLease } from './lib/gpu-lease.mjs'
import { flickerEvents, measureWarmup, prepareWarmup, WARMUP_SIMS, WARMUP_SIZES } from './lib/warmup.mjs'

const phase = process.argv[2] || 'before'
const only = process.argv[3]
const out = process.env.OBPAL_FLICKER_OUT || join('artifacts', 'flicker', phase)
await mkdir(out, { recursive: true })
const { path: executablePath } = await resolveChromium()
const releaseGpu = process.env.OBPAL_E2E_GPU === '1' ? await acquireGpuLease({ waiting: () => console.log('GPU lease busy; waiting') }) : null
let local, browser
try {
if (releaseGpu) {
  const device = await detectE2eGpu(executablePath).catch(error => ({ hardware: false, reason: error.message }))
  if (!device.hardware) process.env.OBPAL_E2E_GPU = 'swiftshader'
  console.log('Renderer: ' + (device.renderer || device.reason || 'unavailable'))
}
local = await startLocal()
browser = await chromium.launch(e2eBrowserOptions({ executablePath, headless: true, args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] }))
const cpu = () => cpus().map(c => c.times).reduce((a, t) => ({ idle: a.idle + t.idle, total: a.total + Object.values(t).reduce((s, n) => s + n, 0) }), { idle: 0, total: 0 })
const summary = []
const quiet = async () => {
  let previous = cpu(), stable = 0, told = 0
  const deadline = Date.now() + 30000
  while (stable < 2 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    const next = cpu(), busy = 1 - (next.idle - previous.idle) / (next.total - previous.total)
    previous = next
    stable = busy < .3 ? stable + 1 : 0
    if (!stable && Date.now() - told > 10000) { told = Date.now(); console.log(`Waiting for CPU load below 30% (now ${(busy * 100).toFixed(0)}%)`) }
  }
}
  for (const [id, path] of [['home', '/'], ...WARMUP_SIMS].filter(([id]) => !only || id === only)) {
    for (const size of WARMUP_SIZES.filter(s => !process.env.OBPAL_FLICKER_SIZE || s.name === process.env.OBPAL_FLICKER_SIZE)) {
      await quiet()
      const dir = join(out, `${id}-${size.name}`)
      await mkdir(dir, { recursive: true })
      const raw = rawRun(dir)
      await mkdir(join(raw, 'screens')); await mkdir(join(raw, 'canvas'))
      const { name, ...options } = size
      const context = await browser.newContext({ ...options, ignoreHTTPSErrors: true })
      try {
        await prepareWarmup(context, { images: true })
        const page = await context.newPage()
        const before = cpu(), loads = []
        let previous = before
        const sampler = setInterval(() => { const next = cpu(); loads.push({ t: Date.now(), busy: 1 - (next.idle - previous.idle) / (next.total - previous.total) }); previous = next }, 1000)
        let result
        try { result = await measureWarmup(page, local.origin + path) } finally { clearInterval(sampler) }
        result.cpu = loads.filter(l => l.t <= result.timeOrigin + result.end)
        result.flicker = flickerEvents(result)
        if (result.screens.length) {
          const startup = Array.from({ length: 9 }, (_, i) => i * 250).map(t => result.screens.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a))
          const metadata = await sharp(Buffer.from(startup[0].image, 'base64')).metadata()
          const width = 390, height = Math.round(width * metadata.height / metadata.width)
          await sharp({ create: { width: width * startup.length, height, channels: 3, background: '#111' } })
            .composite(await Promise.all(startup.map(async (f, i) => ({ input: await sharp(Buffer.from(f.image, 'base64')).resize(width, height, { fit: 'contain' }).toBuffer(), left: width * i, top: 0 })))).jpeg().toFile(join(dir, 'startup-2s.jpg'))
          await writeFile(join(dir, 'startup-2s.json'), JSON.stringify(startup.map((f, i) => ({ targetMs: i * 250, sampledMs: f.t })), null, 2))
        }
        for (let i = 0; i < result.screens.length; i++) await writeFile(join(raw, 'screens', `${String(i).padStart(4, '0')}.jpg`), Buffer.from(result.screens[i].image, 'base64'))
        for (const event of result.flicker) {
          const source = event.source === 'screen' ? result.screens : result.frames
          const frames = source.slice(Math.max(0, event.index - 2), event.index + 3)
          await sharp({ create: { width: 480 * frames.length, height: 300, channels: 3, background: '#111' } })
            .composite(await Promise.all(frames.map(async (f, i) => ({ input: await sharp(Buffer.from(f.image.includes(',') ? f.image.split(',')[1] : f.image, 'base64')).resize(480, 300, { fit: 'fill' }).toBuffer(), left: 480 * i, top: 0 })))).jpeg().toFile(join(dir, `event-${event.source}-${event.index}.jpg`))
        }
        const frameProof = ['screen', 'canvas'].flatMap(source => (source === 'screen' ? result.screens : result.frames).map((f, i) => ({ path: `${source === 'screen' ? 'screens' : 'canvas'}/${String(i).padStart(4, '0')}.jpg`, timeMs: f.t, diff: Math.abs(f.delta), failed: result.flicker.some(event => event.source === (source === 'screen' ? 'screen' : 'canvas') && event.index === i) })))
        await writeFile(join(dir, 'evidence-frames.json'), JSON.stringify({ expectedCount: frameProof.length, fps: 24, frames: frameProof }, null, 2))
        for (const f of result.screens) delete f.image
        for (let i = 0; i < result.frames.length; i++) {
          const f = result.frames[i]
          await writeFile(join(raw, 'canvas', `${String(i).padStart(4, '0')}.jpg`), Buffer.from(f.image.split(',')[1], 'base64'))
          delete f.image
        }
        const x = t => 50 + t / Math.max(8000, result.frames.at(-1).t) * 1050
        const points = result.screens.filter(f => f.t >= 0).map(f => `${x(f.t)},${260 - Math.min(40, Math.abs(f.delta)) * 5}`).join(' ')
        const markers = result.events.filter(e => ['quality', 'canvas-resize', 'reveal', 'programs', 'mark'].includes(e.kind))
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1150" height="340"><rect width="1150" height="340" fill="#fff"/><text x="50" y="25">${id} ${name}: |luminance delta| (0–255), seconds after navigation</text><path d="M50 40V260H1100" fill="none" stroke="#444"/><polyline points="${points}" fill="none" stroke="#5137dd"/>${markers.map(e => `<path d="M${x(e.t)} 40V260" stroke="${e.kind === 'canvas-resize' ? '#d64' : '#ccc'}"/><text transform="translate(${x(e.t)} 275) rotate(35)" font-size="9">${e.kind}</text>`).join('')}${result.flicker.map(e => `<circle cx="${x(e.t)}" cy="45" r="5" fill="red"/>`).join('')}</svg>`
        await writeFile(join(dir, 'timeline.svg'), svg)
        await writeFile(join(dir, 'timeline.json'), JSON.stringify(result, null, 2))
        const row = { id, size: name, frames: result.frames.length, reveal: result.reveal, events: result.flicker.length,
          cleared: result.flicker.filter(e => e.kind === 'cleared').length, alternations: result.flicker.filter(e => e.kind === 'alternation').length,
          maxDelta: Math.max(...result.frames.filter(f => f.t >= result.reveal).map(f => Math.abs(f.delta))), cpu: result.cpu.map(l => l.busy) }
        summary.push(row); console.log(JSON.stringify(row))
        await writeFile(join(out, only ? `summary-${only}.json` : 'summary.json'), JSON.stringify(summary, null, 2))
      } finally { await context.close(); await distill(dir, { keepRaw: process.argv.includes("--keep-raw") || process.env.OBPAL_KEEP_RAW === "1" }) }
    }
  }

await distill(out, { keepRaw: process.argv.includes("--keep-raw") || process.env.OBPAL_KEEP_RAW === "1" })
} finally {
  try {
    try { await browser?.close() } finally { await local?.close() }
  } finally { await releaseGpu?.() }
}
