/** F1a one-actor browser proof, using the guarded stand-in only. Full F1b/F1c remain explicitly unimplemented. */
import { build } from 'vite'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markupBuild } from './markup-build.mjs'
import { rawRun } from './lib/distill.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'
const ROOT = fileURLToPath(new URL('../', import.meta.url)), PREFIX = '/__humanoid-physics/'
const FORMS = ['keel-v1', 'morrow-v1', 'cairn-i-v1', 'cairn-ii-v1', 'rill-i-v1', 'rill-ii-v1', 'hush-i-v1', 'hush-ii-v1']
const POSES = ['t', 'squat', 'lunge', 'overhead', 'highKick', 'twist', 'crouchGuard']
const VIEWS = [{ id: 'desktop', width: 1280, height: 800, mobile: false, rate: 1 }, { id: 'narrow-4x', width: 412, height: 915, mobile: true, rate: 4 }]
export async function runHumanoidPhysics(local, check) {
  const report = { schema_version: 1, kind: 'humanoid-f1a-browser', pass: false, node: process.version, platform: process.platform, arch: process.arch,
    browser: null, gpuMode: process.env.OBPAL_E2E_GPU || '0', rows: [], errors: [], sheets: [], stanceSheets: [], evidenceVerified: false,
    acceptanceStatus: 'recorded pending; physical pass is independent of harness success',
    notImplemented: ['F1b balance/gait/two-actor contact/recovery', 'F1c BODY source routing/phone camera/receive-to-visible latency', 'F1c per-part pixel/mesh-crossing and transition release acceptance'] }
  let browser
  let folder
  const evidence = join(process.env.OBPAL_E2E_EVIDENCE_ROOT || join(ROOT, 'artifacts'), 'humanoid-physics')
  const frames = []
  try {
    folder = rawRun(evidence)
    const built = await build({ configFile: false, root: ROOT, publicDir: false, logLevel: 'warn', base: PREFIX, plugins: [markupBuild(ROOT)],
      build: { write: false, assetsInlineLimit: 0, target: 'es2020', sourcemap: false, rolldownOptions: { input: resolve(ROOT, 'src/sim/humanoid/physics/bench-page.ts') } } })
    const output = Array.isArray(built) ? built.flatMap(r => r.output) : built.output
    const assets = new Map(output.map(item => [item.fileName, Buffer.from(item.type === 'chunk' ? item.code : item.source)]))
    const entry = output.find(item => item.type === 'chunk' && item.isEntry)
    if (!entry) throw new Error('Missing humanoid proof entry')
    browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: !process.argv.includes('--headed') }))
    report.browser = browser.version()
    for (const view of VIEWS) for (const profileId of FORMS) for (const mode of (view.id === 'desktop' && profileId === 'keel-v1' ? ['cold', 'slow', 'failed'] : ['cold'])) {
      const row = { view: view.id, profileId, mode, pass: false, browserErrors: [], requests: [], poses: [] }
      const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, isMobile: view.mobile, hasTouch: view.mobile,
        deviceScaleFactor: 1, serviceWorkers: 'block', ignoreHTTPSErrors: true })
      let timer
      try {
        const page = await context.newPage(), cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: view.rate })
        page.on('pageerror', e => row.browserErrors.push(e.message))
        await context.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (url.origin !== local.origin) { row.browserErrors.push(`Blocked nonlocal request: ${url.pathname}`); await route.abort(); return }
          if (/^\/models\/(keel|morrow|(?:cairn|rill|hush)-(?:i|ii))(?:-lod)?\.glb$/.test(url.pathname)) {
            row.requests.push({ path: url.pathname, mode })
            if (mode === 'failed') { await route.fulfill({ status: 503, body: 'intentional F1a model failure' }); return }
            if (mode === 'slow') await new Promise(r => setTimeout(r, 5000))
            // Existing assets only, from the guarded local stand-in. Never a production/CDN fallback.
            await route.continue(); return
          }
          if (!url.pathname.startsWith(PREFIX)) { row.browserErrors.push(`Unexpected local request: ${url.pathname}`); await route.abort(); return }
          const name = url.pathname.slice(PREFIX.length), headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
          if (!name) {
            const styles = [...assets.keys()].filter(n => n.endsWith('.css')).map(n => `<link rel="stylesheet" href="${PREFIX}${n}">`).join('')
            await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/html',
              'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; object-src 'none'" },
              body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>F1a physical pilot proof</title>${styles}<style>body{margin:0;background:#10151d}canvas{display:block}</style><script type="module" src="${PREFIX}${entry.fileName}"></script>` }); return
          }
          const bytes = assets.get(name)
          if (!bytes) { row.browserErrors.push(`Missing proof asset: ${name}`); await route.fulfill({ status: 404, body: 'missing' }); return }
          await route.fulfill({ status: 200, headers: { ...headers, 'content-type': name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.css') ? 'text/css' : 'text/javascript' }, body: bytes })
        })
        const work = (async () => {
          await page.goto(`${local.origin}${PREFIX}`, { waitUntil: 'load', timeout: 60_000 })
          await page.waitForFunction(() => Boolean(window.__humanoidPhysics), undefined, { timeout: 60_000 })
          row.begin = await page.evaluate(id => window.__humanoidPhysics.begin(id), profileId)
          row.loading = await page.evaluate(mode => window.__humanoidPhysics.loading(mode), mode)
          if (!row.loading.pass) throw new Error('Loading evidence failed; inspect timeline')
          row.clockLimits = await page.evaluate(() => window.__humanoidPhysics.clockLimits())
          row.motion = await page.evaluate(() => window.__humanoidPhysics.motion())
          if (view.id === 'desktop' && mode === 'cold') {
            await mkdir(join(folder, profileId))
            const thumbnails = []
            for (let lod = 0; lod < 2; lod++) for (let i = 0; i < POSES.length; i++) {
              const pose = await page.evaluate(({ name, lod }) => window.__humanoidPhysics.pose(name, lod), { name: POSES[i], lod })
              row.poses.push(pose)
              const png = await page.locator('#humanoid-proof').screenshot()
              const path = `${profileId}/${POSES[i]}-lod${lod}.png`
              await writeFile(join(folder, path), png)
              frames.push({ path, timeMs: (lod * POSES.length + i) * 2000,
                note: `${profileId}, ${POSES[i]}, LOD${lod}; zero-gravity physical pose; pixel coverage is not a crossing proof` })
              thumbnails.push({ input: await sharp(png).resize(160, 120, { fit: 'contain', background: '#10151d' }).png().toBuffer(), left: i * 160, top: lod * 120 })
            }
            const png = await sharp({ create: { width: 1120, height: 240, channels: 4, background: '#10151d' } }).composite(thumbnails).png().toBuffer()
            const name = `${profileId}-sheet.png`; await writeFile(join(evidence, name), png)
            // Small contact sheets travel automatically in the log-only result ZIP. Full-size PNGs stay local.
            const pngBase64 = png.toString('base64')
            if (pngBase64.length > 200_000) throw new Error('Contact sheet exceeds 200 kB encoded evidence budget; retained full-size PNGs locally')
            report.sheets.push({ profileId, name, width: 1120, height: 240, columns: POSES, rows: ['LOD0', 'LOD1'], sha256: createHash('sha256').update(png).digest('hex'), pngBase64 })
            if (['keel-v1', 'morrow-v1', 'cairn-i-v1'].includes(profileId)) {
              row.stance = await page.evaluate(() => window.__humanoidPhysics.stance())
              const s = row.stance, samples = [s.trace[0], s.trace.find(x => x.tick === 240), s.witnesses.penetration.sample,
                s.trace.find(x => x.tick === 480), s.witnesses.hover.sample, s.witnesses.slip.sample, s.trace.at(-1)].sort((a, b) => a.tick - b.tick)
              await mkdir(join(folder, profileId, 'stance'))
              const tiles = []
              for (const [i, sample] of samples.entries()) {
                await page.evaluate(sample => window.__humanoidPhysics.stanceFrame(sample), sample)
                const png = await page.locator('#humanoid-proof').screenshot(), path = `${profileId}/stance/${sample.tick}.png`
                await writeFile(join(folder, path), png)
                frames.push({ path, timeMs: sample.timeS * 1000, note: 'Measured 30 s gravity stance including collapse; fixed world camera, floor grid, cyan/yellow lower-face corner guides.' })
                tiles.push({ input: await sharp(png).resize(240, 180).png().toBuffer(), left: i * 240, top: 60 })
                const label = `${sample.timeS.toFixed(4)} s; pelvis ${(sample.rootHeightM * 1000).toFixed(1)} mm`
                const feet = sample.feet.map((f, n) => `<text x="5" y="${32 + n * 16}" fill="white" font-family="sans-serif" font-size="12">${f.id.includes('left') ? 'L' : 'R'} sole corners: ${(f.minSoleY * 1000).toFixed(1)}..${(f.maxSoleY * 1000).toFixed(1)} mm</text>`).join('')
                tiles.push({ input: Buffer.from(`<svg width="240" height="60"><text x="5" y="15" fill="white" font-family="sans-serif" font-size="12">${label}</text>${feet}</svg>`), left: i * 240, top: 0 })
              }
              const png = await sharp({ create: { width: 1680, height: 240, channels: 4, background: '#10151d' } }).composite(tiles).png().toBuffer()
              const name = `${profileId}-stance-strip.png`; await writeFile(join(evidence, name), png)
              report.stanceSheets.push({ profileId, name, width: 1680, height: 240, timesS: samples.map(s => s.timeS),
                sha256: createHash('sha256').update(png).digest('hex'), pngBase64: png.toString('base64') })
            }
          }
          row.legacyReset = await page.evaluate(() => window.__humanoidPhysics.legacyReset())
          row.pass = !!row.motion.pass && !row.browserErrors.length && row.legacyReset.rootRotationErrorRad < 1e-8 && row.legacyReset.pelvisHeightErrorM < 1e-8 &&
            row.poses.every(p => p.prototype === 'blender' && p.pixels.coveredPixels > 0 && p.completedTicks === 480)
          await page.evaluate(() => window.__humanoidPhysics.dispose())
        })()
        await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('F1a browser row exceeded 180 s budget')), 180_000) })])
      } catch (e) { row.pass = false; row.error = String(e?.message ?? e) }
      finally {
        clearTimeout(timer)
        try { await context.close() } catch (e) { row.pass = false; row.browserErrors.push(`Context cleanup: ${String(e?.message ?? e)}`) }
        report.rows.push(row)
        console.log(`F1a ${row.view} ${row.profileId} ${row.mode}: ${row.pass ? 'pass' : 'FAIL'}${row.error ? `; ${row.error}` : row.motion?.failures?.length ? `; ${row.motion.failures.join('; ')}` : ''}`)
      }
    }
    report.pass = report.rows.length === 18 && report.rows.every(r => r.pass) && report.sheets.length === 8
  } catch (e) { report.errors.push(String(e?.stack ?? e)) }
  finally {
    try { await browser?.close() } catch (e) { report.pass = false; report.errors.push(`Browser cleanup: ${String(e?.message ?? e)}`) }
    if (folder) {
      try {
        const payload = JSON.stringify({ ...report, evidenceVerified: true, sheets: report.sheets.map(({ pngBase64, ...sheet }) => sheet),
          stanceSheets: report.stanceSheets.map(({ pngBase64, ...sheet }) => sheet) }, null, 2)
        await writeFile(join(evidence, 'report.json'), payload)
        if (await readFile(join(evidence, 'report.json'), 'utf8') !== payload) throw new Error('F1a JSON round-trip mismatch')
        await writeFile(join(evidence, 'evidence-frames.json'), JSON.stringify({ expectedCount: 133, frames }, null, 2))
        report.evidenceVerified = true
      }
      catch (e) { report.pass = false; report.errors.push(`Evidence write: ${String(e?.message ?? e)}`) }
      console.log(`F1a review evidence: ${evidence}; raw frames in TEMP for automatic distillation`)
    }
    console.log(JSON.stringify(report)) // MUST precede assertion, including blocked/error cases and contact sheets.
  }
  const harness = report.evidenceVerified && !report.errors.length && report.rows.length === 18 && report.sheets.length === 8 && report.stanceSheets.length === 3 && frames.length === 133 &&
    report.rows.every(r => !r.error && !r.browserErrors.length && r.loading?.pass && r.motion?.seconds >= 10 && r.motion.completedTicks > 0 &&
      r.motion.invalidFrames === 0 && r.motion.movementRad > .05 && r.motion.geometryChanges === 0 && r.motion.expectedParts.length === 16 &&
      r.clockLimits.completedTicks === 12 && Math.abs(r.clockLimits.droppedSeconds - .1) < 1e-12 && r.clockLimits.invalidFrames === 0 &&
      r.motion.physicsSeconds >= 10 && r.motion.physicsUpdates.length > 0 &&
      r.motion.physicsUpdates.every((u, i, updates) => Object.values(u).every(Number.isFinite) && u.steps <= 12 &&
        Math.abs(u.intervalMs - (u.timeMs - (i ? updates[i-1].timeMs : r.motion.physicsStartTimeMs))) < 1e-6) &&
      Math.abs(r.motion.physicsEndTimeMs - r.motion.physicsStartTimeMs - r.motion.physicsSeconds * 1000) < 1e-6 &&
      Math.abs(r.motion.physicsUpdates.reduce((sum, u) => sum + u.intervalMs, 0) - r.motion.physicsSeconds * 1000) < 1e-6 &&
      r.motion.completedTicks === Math.floor((r.motion.physicsSeconds - r.motion.droppedSeconds) * 240 + 1e-7) &&
      !r.motion.captureErrors.length && r.motion.coverages.length === Math.floor((r.motion.frames - 1) / 30) + 2 &&
      r.motion.captureFrames.every((frame, i) => frame === (i === r.motion.captureFrames.length - 1 ? r.motion.frames : i * 30)) &&
      r.motion.frameStages.length === r.motion.frames && r.motion.frameStages.every(s => Object.values(s).every(Number.isFinite)) &&
      r.motion.coverages.every(c => [c.queueMs, c.fenceAndCopyMs, c.alphaCountMs, c.hashWaitMs, c.totalLatencyMs].every(Number.isFinite)) &&
      r.motion.coverages.every(c => c.coveredPixels > 0) && new Set(r.motion.coverages.map(c => c.hash)).size > 1 &&
      [r.motion.p95FrameMs, r.motion.p99FrameMs, r.motion.p95TickWallMs, r.motion.p99TickWallMs, r.motion.droppedSeconds].every(Number.isFinite) &&
      r.legacyReset.rootRotationErrorRad < 1e-8 && r.legacyReset.pelvisHeightErrorM < 1e-8 &&
      r.poses.every(p => p.prototype === 'blender' && p.pixels.coveredPixels > 0 && p.completedTicks === 480) &&
      (!r.stance || !r.stance.error && r.stance.completedTicks === 7200 && r.stance.trace.at(-1).tick === 7200))
  await check('F1a recorded measurement harness: 18 rows, 112 poses, three stance strips and verified JSON', () => {
    if (!harness) throw new Error('F1a measurement harness incomplete or failed; inspect humanoid-f1a-browser JSON')
    return 'physical gates remain pending; harness success is not F1a acceptance'
  })
  const pending = async (name, passed, measured) => check(name, () => {
    if (!harness) throw new Error('F1a measurement harness incomplete or failed')
    if (passed) throw new Error('Pending F1a gate unexpectedly passed; convert this check to ordinary acceptance')
    return `expected failure, recorded pending: ${measured}`
  })
  // Every body must submit a skin (16/16); current authored GLBs submit 15/16, with no lumbar skin.
  await pending('F1a pending browser gate: all 16 physics bodies submit authored skins',
    report.rows.every(r => r.motion?.missingSubmissions === 0), 'authored lumbar submissions missing; procedural fallback retains 16 bodies')
  // Promoted after the merged-master GPU run passed the pending gate: exactly 0.000000 s in all 18 rows.
  await check('F1a browser gate: zero dropped clock time in every native/narrow row', () => {
    if (!harness) throw new Error('F1a measurement harness incomplete or failed')
    if (!report.rows.every(r => r.motion.droppedSeconds === 0)) throw new Error('F1a clock lost time; inspect recorded measurements')
    return '18/18 rows: exactly zero dropped seconds'
  })
}
