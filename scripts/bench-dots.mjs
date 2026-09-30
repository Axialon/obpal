/**
 * Measure the shared Canvas 2D field in a fresh Chromium page, without a server, network or built files.
 * The report measures synchronous Canvas command CPU cost, not GPU raster or compositor readback.
 * By default reports go to a temporary folder. --out artifacts/trust/ explicitly captures repository evidence.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { arch, cpus, platform, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { encode } from 'uqr'
import { build } from 'vite'
import { resolveChromium } from './lib/browser.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
let requested = ''
if (args.length) {
  if (args.length === 2 && args[0] === '--out') requested = args[1]
  else if (args.length === 1 && args[0].startsWith('--out=')) requested = args[0].slice(6)
  else throw new Error('Usage: node scripts/bench-dots.mjs [--out artifacts/trust/]')
  if (!requested) throw new Error('--out needs a folder')
}
let folder
if (requested) {
  folder = resolve(root, requested)
  const evidence = resolve(root, 'artifacts/trust')
  if (folder !== evidence && !folder.startsWith(evidence + sep)) throw new Error('--out must stay inside artifacts/trust/')
  await mkdir(folder, { recursive: true })
} else folder = await mkdtemp(join(tmpdir(), 'obpal-dots-'))

const built = await build({
  configFile: false, root, publicDir: false, logLevel: 'silent',
  build: {
    write: false, minify: false, sourcemap: false, emptyOutDir: false, copyPublicDir: false,
    lib: { entry: join(root, 'packages/host/src/dot-field.ts'), name: 'TrustDots', formats: ['iife'] },
  },
})
const bundles = (Array.isArray(built) ? built : [built]).flatMap(output => output.output)
  .filter(output => output.type === 'chunk' && output.isEntry)
assert.equal(bundles.length, 1, 'The self-contained renderer must build as one in-memory entry')

// A real matrix containing a public example address, with no room, credential, account or local data.
const qr = encode('https://example.test/obpal-dot-benchmark', { ecc: 'Q', minVersion: 10, maxVersion: 10, border: 3 })
const source = qr.data.flatMap((row, y) => row.flatMap((on, x) => on ? [{ x: (x + 0.5) / qr.size, y: (y + 0.5) / qr.size }] : []))
assert.ok(source.length >= 1500 && source.length <= 4096, 'The QR fixture must exercise a whole source of about 1,600 modules')

const resolved = await resolveChromium()
const browser = await chromium.launch({ headless: true, executablePath: resolved.path || undefined })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' })
  let requests = 0
  await page.route('**/*', route => { requests++; return route.abort() })
  await page.addScriptTag({ content: bundles[0].code })
  const report = await page.evaluate(async qrSource => {
    const { DotField } = window.TrustDots
    const makeCanvas = (height) => {
      const canvas = document.createElement('canvas')
      canvas.style.cssText = `display:block;width:600px;height:${height}px;--bb-accent:#c6ff34;--bb-accent-text:#c6ff34`
      document.body.append(canvas)
      return canvas
    }
    document.body.style.cssText = 'margin:0;background:#101319'
    const points = Array.from({ length: 300 }, (_, i) => ({ x: ((i % 30) + 0.5) / 30, y: (Math.floor(i / 30) + 0.5) / 10 }))
    const field = new DotField(makeCanvas(200), { points, idle: false, surface: 'transparent' })
    const idle = new DotField(makeCanvas(100), { surface: 'transparent' })
    const settle = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
    try {
      await settle()
      const measure = (source) => {
        field.setSource(source)
        for (let i = 0; i < 120; i++) field.handshake(i / 119)
        const times = []
        for (let i = 0; i < 1200; i++) {
          const start = performance.now()
          field.handshake((i % 120) / 119)
          times.push(performance.now() - start)
        }
        field.handshake(1)
        const sorted = [...times].sort((a, b) => a - b)
        return {
          targetDots: field.dotCount, sourceModules: source.length, warmupFrames: 120, samples: times.length,
          averageMs: times.reduce((sum, time) => sum + time, 0) / times.length,
          p95Ms: sorted[Math.floor(times.length * 0.95)], maximumMs: sorted.at(-1),
        }
      }
      const grid = measure(points)
      const wholeQr = measure(qrSource)
      await settle()
      const before = idle.frames
      await new Promise(done => setTimeout(done, 300))
      return {
        measurement: 'Synchronous Canvas command CPU cost; excludes GPU raster and compositor readback.',
        dpr: devicePixelRatio, maximumBudgetMs: 2, grid, wholeQr,
        idleFrames: idle.frames - before, idleSampleMs: 300,
      }
    } finally {
      field.destroy()
      idle.destroy()
    }
  }, source)
  report.networkRequests = requests
  report.reference = { cpu: cpus()[0]?.model, platform: platform(), architecture: arch(), chromium: browser.version() }
  report.pass = report.dpr === 2 && report.grid.targetDots === 300 && report.wholeQr.targetDots === 300 &&
    report.grid.maximumMs <= 2 && report.wholeQr.maximumMs <= 2 && report.idleFrames === 0 && requests === 0
  await writeFile(join(folder, 'dot-field-budget.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  console.log(`Report: ${join(folder, 'dot-field-budget.json')}`)
  assert.equal(report.dpr, 2, 'Measure at the required display pixel ratio')
  assert.equal(report.grid.targetDots, 300, 'The baseline must draw 300 glyph-grid dots')
  assert.equal(report.wholeQr.targetDots, 300, 'The QR must settle to 300 dots')
  assert.ok(report.grid.maximumMs <= 2, `300-dot maximum CPU cost exceeded 2 ms: ${report.grid.maximumMs}`)
  assert.ok(report.wholeQr.maximumMs <= 2, `Whole-QR maximum CPU cost exceeded 2 ms: ${report.wholeQr.maximumMs}`)
  assert.equal(report.idleFrames, 0, 'The idle compositor breath must cause no redraws')
  assert.equal(requests, 0, 'The benchmark must make no network requests')
} finally {
  await browser.close()
}
