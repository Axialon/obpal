/** Humanoid physics browser measurements, using the guarded stand-in only. */
import { build } from 'vite'
import { chromium, devices } from 'playwright'
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { markupBuild } from './markup-build.mjs'
import { rawRun } from './lib/distill.mjs'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { installFixture } from './e2e-humanoid.mjs'
const ROOT = fileURLToPath(new URL('../', import.meta.url)), PREFIX = '/__humanoid-physics/'
const FORMS = ['keel-v1', 'morrow-v1', 'cairn-i-v1', 'cairn-ii-v1', 'rill-i-v1', 'rill-ii-v1', 'hush-i-v1', 'hush-ii-v1']
const POSES = ['t', 'squat', 'lunge', 'overhead', 'highKick', 'twist', 'crouchGuard']
const VIEWS = [{ id: 'desktop', width: 1280, height: 800, mobile: false, rate: 1 }, { id: 'narrow-4x', width: 412, height: 915, mobile: true, rate: 4 }]
export async function runHumanoidPilotProof(local, check) {
  const report = { schema_version: 1, kind: 'humanoid-f1a-browser', pass: false, node: process.version, platform: process.platform, arch: process.arch,
    browser: null, gpuMode: process.env.OBPAL_E2E_GPU || '0', rows: [], errors: [], sheets: [], stanceSheets: [], evidenceVerified: false,
    acceptanceStatus: 'F1a2 candidate; ordinary 30 s/5 mm stance gate, authored lumbar and F1b/F1c still pending',
    notImplemented: ['F1b shared-world two-actor balance/gait/contact/recovery (stance target candidate only)', 'F1c BODY source routing/phone camera/receive-to-visible latency', 'F1c per-part pixel/mesh-crossing and transition release acceptance'] }
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
                frames.push({ path, timeMs: sample.timeS * 1000, note: 'Measured 30 s gravity stance, including any collapse; fixed world camera, floor grid, cyan/yellow lower-face corner guides.' })
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
          row.candidateStancePass = row.stance ? row.stance.pass === true : null
          row.pass = (!row.stance || row.stance.pass === true) && !!row.motion.pass && !row.browserErrors.length && row.legacyReset.rootRotationErrorRad < 1e-8 && row.legacyReset.pelvisHeightErrorM < 1e-8 &&
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
    return 'harness only; ordinary stance gates and deferred authored/interactive gates are separate'
  })
  await check('F1a2 candidate: three browser stance rows pass unchanged 30 s / 5 mm / support gates', () => {
    const rows=report.rows.filter(r=>r.stance)
    if(!harness||rows.length!==3||rows.some(r=>r.stance.pass!==true)) throw new Error('F1a2 browser stance incomplete or failed; inspect measured JSON, not harness status')
    return 'three measured 7200-tick stance rows passed their unchanged physical gates'
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

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null
}
const timingSummary = values => ({ samples: values.length, medianMs: percentile(values, .5), p95Ms: percentile(values, .95),
  p99Ms: percentile(values, .99), maximumMs: values.length ? Math.max(...values) : null })
const requireMeasurement = (condition, message) => { if (!condition) throw new Error(message) }
const standing = actor => Number.isFinite(actor.upY) && actor.upY >= .98 &&
  Number.isFinite(actor.pelvisHeight) && actor.pelvisHeight >= .9 * actor.nominalPelvisHeight &&
  Number.isFinite(actor.effortRatio) && actor.effortRatio <= 1 + 1e-6
const actorSummary = actor => ({ actorId: actor.actorId, generation: actor.generation, upY: actor.upY,
  pelvisHeight: actor.pelvisHeight, nominalPelvisHeight: actor.nominalPelvisHeight, support: actor.support,
  effortRatio: actor.effortRatio, bodyWeight: actor.bodyWeight, upperBodyMovementRad: actor.upperBodyMovementRad,
  mode: actor.mode, source: actor.source, gaitState: actor.gaitState, fallen: actor.fallen,
  peakFootPenetrationM: actor.peakFootPenetrationM, position: actor.position, headingRad: actor.headingRad, walkingMode: actor.walkingMode })

/** Actual experimental page. The older, full F1a proof remains separately callable. */
export async function runHumanoidPhysics(local, check) {
  if (process.env.OBPAL_E2E_HUMANOID_PILOT_PROOF === '1') await runHumanoidPilotProof(local, check)
  const baseline = process.env.OBPAL_E2E_HUMANOID_WALK_BASELINE === '1'
  const walkOnly = process.env.OBPAL_E2E_HUMANOID_WALK_ONLY === '1' && !baseline
  const expectedScenarios = baseline ? 2 : walkOnly ? 3 : 10, expectedFrames = baseline ? 6 : walkOnly ? 18 : 36
  const evidence = join(process.env.OBPAL_E2E_EVIDENCE_ROOT || join(ROOT, 'artifacts'), 'humanoid-control')
  const report = { schema_version: 1, kind: 'humanoid-control-browser', pass: false,
    environment: { node: process.version, platform: process.platform, gpuMode: process.env.OBPAL_E2E_GPU || '0',
      viewport: { width: 1280, height: 800 }, dpr: 1, browser: null, renderer: null,
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      workingTreeModified: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      camera: 'unchanged page default; fixed during each strip', device: 'desktop browser; phone layout is viewport emulation',
      motionPreference: 'no-preference', walkBaselineOnly: baseline, walkDebugOnly: walkOnly },
    acceptanceStatus: 'Walk (experimental), opt in, limited to step-and-turn-in-place; forward walking is not claimed; native penetration gates remain unchanged',
    overrides: ['Actual demo group replaces optional older F1a browser proof for this scoped run',
      'Authorised fallback: per-pilot 10 s forward intent and 20 s turn in place, then release and 6 s settle; Keel must stay upright and within 0.30 m; Morrow instability and Reset recovery are recorded',
      'Default actor: 60 s warm-up / 120 s sample; optional two-actor attempt: 15 s warm-up / 30 s sample; five-minute and full two-actor acceptance are deferred'],
    bodyProof: 'Synthetic landmarks through BodyInput and Retargeter; this does not measure a physical phone camera',
    results: [], errors: [], consoleMessages: [], requestFailures: [], strips: [], measurements: [], frameBudget: null, walking: [] }
  const frames = [], contexts = []
  let browser, raw, page
  const record = async (name, work) => {
    try { report.results.push({ name, pass: true, detail: await work() }) }
    catch (error) {
      const row = { name, pass: false, error: String(error?.message ?? error) }
      if (page && !page.isClosed()) {
        try { row.failureState = await page.evaluate(() => ({ status: document.getElementById('physics-status')?.textContent ?? '',
          budget: document.getElementById('physics-budget')?.textContent ?? '', snapshot: window.__humanoidControl?.snapshot() ?? null })) }
        catch (diagnosticError) { row.diagnosticError = String(diagnosticError?.message ?? diagnosticError) }
      }
      report.results.push(row)
    }
  }
  try {
    raw = rawRun(evidence)
    browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined,
      headless: !process.argv.includes('--headed'), args: ['--ignore-certificate-errors', '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] }))
    report.environment.browser = browser.version()
    const context = await browser.newContext({ viewport: report.environment.viewport, deviceScaleFactor: 1,
      ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    contexts.push(context)
    page = await context.newPage()
    page.on('pageerror', error => report.errors.push(error.message))
    page.on('console', message => {
      if (['error', 'warning'].includes(message.type()) && report.consoleMessages.length < 40)
        report.consoleMessages.push({ type: message.type(), text: message.text().slice(0, 2000) })
    })
    page.on('requestfailed', request => {
      if (report.requestFailures.length < 40) report.requestFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? '' })
    })
    await page.goto(`${local.origin}/sim/humanoid/physics/?test=humanoid-physics`, { waitUntil: 'load', timeout: 60_000 })
    await page.waitForFunction(() => window.__humanoidControl?.snapshot().ready, undefined, { timeout: 60_000 })
    await page.waitForFunction(() => window.__humanoidControl.actors[0].rig.root.userData.prototype === 'blender', undefined, { timeout: 60_000 })
    const controls = page.locator('.sim-window[data-panel="controls"]')
    if (await controls.count() && !await controls.isVisible()) await page.locator('[data-panel-toggle="controls"]').click()
    const read = () => page.evaluate(() => window.__humanoidControl.snapshot())
    const reset = () => page.evaluate(() => window.__humanoidControl.reset())
    const capture = async (scenario, times) => {
      await mkdir(join(raw, scenario), { recursive: true })
      const tiles = [], states = [], begin = Date.now()
      for (const [index, at] of times.entries()) {
        const delay = at - (Date.now() - begin)
        if (delay > 0) await page.waitForTimeout(delay)
        const state = await read(), png = await page.screenshot(), path = `${scenario}/${index}.png`
        const actualMs = Date.now() - begin
        await writeFile(join(raw, path), png)
        states.push({ requestedMs: at, actualMs, state })
        frames.push({ path, timeMs: actualMs, failed: !state.ready || state.actors.some(actor => actor.fallen),
          note: `${scenario}; fixed desktop camera, experimental physics page` })
        tiles.push({ input: await sharp(png).resize(400, 250, { fit: 'contain', background: '#10151d' }).png().toBuffer(), left: index * 400, top: 34 })
        const actor = state.actors[0], phase = actor?.gaitState ?? 'standing'
        const penetration = Number.isFinite(actor?.peakFootPenetrationM) ? `; peak ${(actor.peakFootPenetrationM * 1000).toFixed(1)} mm` : ''
        const label = `${scenario}: ${(actualMs / 1000).toFixed(2)} s; ${phase}${penetration}`
        tiles.push({ input: Buffer.from(`<svg width="400" height="34"><text x="8" y="22" fill="white" font-family="sans-serif" font-size="12">${label}</text></svg>`), left: index * 400, top: 0 })
      }
      const png = await sharp({ create: { width: times.length * 400, height: 284, channels: 4, background: '#10151d' } }).composite(tiles).png().toBuffer()
      const name = `${scenario}-strip.png`
      await writeFile(join(evidence, name), png)
      report.strips.push({ name, scenario, count: states.length, requestedTimesMs: times,
        actualTimesMs: states.map(sample => sample.actualMs), sha256: createHash('sha256').update(png).digest('hex') })
      report.measurements.push({ scenario, samples: states })
      return states
    }
    await record('one actor by default, explicit experimental label and practice link', async () => {
      const state = await read()
      requireMeasurement(state.actors.length === 1, 'Page did not start with exactly one actor')
      requireMeasurement(await page.getByText('Experimental physics', { exact: true }).count() > 0, 'Experimental label missing')
      if (!baseline) {
        requireMeasurement(await page.getByText('Walk (experimental)', { exact: true }).count() > 0, 'Walk experimental label missing')
        requireMeasurement(!await page.locator('#physics-walk').isChecked(), 'Walk must start off by default')
      }
      requireMeasurement(await page.locator('a[href="/sim/humanoid/"]').count() > 0, 'Kinematic practice link missing')
      const renderer = await page.evaluate(() => {
        const canvas = document.querySelector('canvas'), gl = canvas?.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info')
        return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null
      })
      report.environment.renderer = renderer
      return { actorCount: state.actors.length, host: state.host, renderer }
    })
    if (baseline) {
      await record('before walking: comparable desktop and phone-width standing captures', async () => {
        const states = await capture('standing', [0, 500, 1000, 2000, 4000])
        requireMeasurement(states.every(sample => standing(sample.state.actors[0])), 'Baseline standing left the stance envelope')
        await page.setViewportSize({ width: 412, height: 915 })
        await page.waitForTimeout(500)
        if (!await controls.isVisible()) await page.locator('[data-panel-toggle="controls"]').click()
        await page.locator('[data-physics-push]').scrollIntoViewIfNeeded()
        await capture('phone-width-standing', [0])
        await writeFile(join(evidence, 'phone-width.png'), await page.screenshot())
        return { desktopSamples: states.length, phoneWidth: 412, baselineOnly: true }
      })
      await check('humanoid physics: before walking baseline captures', () => {
        requireMeasurement(report.results.length === 2 && report.results.every(row => row.pass) && frames.length === 6,
          report.results.filter(row => !row.pass).map(row => row.error).join('; ') || 'Incomplete baseline capture')
        return 'desktop standing strip and phone-width standing capture; no walking claim'
      })
      return
    }
    if (!walkOnly) {
    await record('standing strip holds the sampled stance envelope', async () => {
      const states = await capture('standing', [0, 500, 1000, 2000, 4000])
      requireMeasurement(states.every(sample => standing(sample.state.actors[0])), 'Standing left the sampled stance envelope')
      return { samples: states.length, last: actorSummary(states.at(-1).state.actors[0]) }
    })
    await record('class A push and recovery through the page Push button', async () => {
      await reset()
      await page.waitForTimeout(1500)
      const before = await read()
      await page.locator('[data-physics-push]').click()
      const states = await capture('push-recovery', [0, 100, 300, 600, 1000, 2000, 4000])
      const final = states.at(-1).state
      requireMeasurement(states.every(sample => standing(sample.state.actors[0])), 'Class A push left the sampled stance envelope')
      requireMeasurement(final.actors[0].support !== 'none', 'Push did not recover support')
      requireMeasurement((final.disturbances ?? final.pushes ?? 0) > (before.disturbances ?? before.pushes ?? 0), 'Push disturbance was not journalled')
      return { samples: states.length, last: actorSummary(final.actors[0]), journalled: true }
    })
    await record('BODY arms follow synthetic landmarks while the legs balance', async () => {
      await reset()
      await page.evaluate(() => { window.__humanoid = { actors: window.__humanoidControl.actors, inject: (index, body) => window.__humanoidControl.inject(index, body) } })
      await page.evaluate(installFixture)
      await page.waitForTimeout(1000)
      await page.evaluate(() => { window.fixture.angles = { 'left.arm.pitch': .65, 'left.arm.elbow': .55, 'right.arm.pitch': .35, 'right.arm.elbow': .35 } })
      const states = await capture('body-arms', [0, 150, 400, 800, 1500, 3000])
      requireMeasurement(states.every(sample => standing(sample.state.actors[0])), 'BODY left the sampled stance envelope')
      requireMeasurement(states.some(sample => sample.state.actors[0].bodyWeight >= .5), 'BODY acquisition did not reach weight 0.5')
      const body = states.at(-1).state.actors[0]
      requireMeasurement(Number.isFinite(body.upperBodyMovementRad) && body.upperBodyMovementRad > .15,
        'BODY did not move the measured upper body by 0.15 rad')
      await page.evaluate(() => { window.fixture.enabled = false; window.__humanoidControl.clear(0) })
      await page.waitForTimeout(300)
      const lost = await read()
      requireMeasurement(lost.actors[0].bodyWeight <= 1e-6, 'BODY weight did not release to zero after 300 ms')
      return { acquired: actorSummary(body), released: actorSummary(lost.actors[0]), inputPath: 'landmarks -> BodyInput -> Retargeter -> upper-body -> ActuationGate' }
    })
    await record('class D fall shows Reset and rebuilding restores double support', async () => {
      await page.evaluate(() => { if (window.fixture) window.fixture.enabled = false; window.__humanoidControl.clear(0) })
      await reset()
      await page.waitForTimeout(1500)
      const before = await read()
      await page.evaluate(() => window.__humanoidControl.push('seat1', 'D', 'toe'))
      await page.waitForFunction(() => window.__humanoidControl.snapshot().actors[0]?.fallen === true,
        undefined, { timeout: 8000 })
      const fallen = await read()
      requireMeasurement(fallen.actors[0].fallen === true && [fallen.actors[0].upY, fallen.actors[0].pelvisHeight,
        fallen.actors[0].effortRatio].every(Number.isFinite), 'Class D did not produce a finite measured fall')
      const hint = page.locator('#physics-fall')
      await hint.waitFor({ state: 'visible', timeout: 2000 })
      requireMeasurement(/down.*reset/i.test(await hint.textContent() ?? ''), 'Fallen actor has no visible Down / Reset hint')
      const paused = await page.evaluate(async () => {
        try { await window.__humanoidControl.rejectAdvance() } catch { /* Deliberate invalid elapsed time tests recoverable worker failure. */ }
        return window.__humanoidControl.snapshot()
      })
      requireMeasurement(!paused.ready && paused.resettable && /elapsed time/i.test(paused.failureMessage), 'Worker rejection did not leave a recoverable Reset path')
      await page.keyboard.press('Space')
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      })
      const cancelled = await read()
      requireMeasurement(!cancelled.ready && cancelled.resettable && cancelled.failureMessage === paused.failureMessage,
        'Background cancellation or Stance destroyed the recoverable worker fault')
      requireMeasurement(await page.locator('[data-physics-reset]').isEnabled(), 'Recoverable worker rejection disabled Reset')
      await page.locator('[data-physics-reset]').click()
      await page.waitForFunction(generation => {
        const state = window.__humanoidControl.snapshot(), actor = state.actors[0]
        return state.ready && actor?.generation > generation && actor.upY >= .98 &&
          actor.pelvisHeight >= .9 * actor.nominalPelvisHeight && actor.support === 'double' && actor.effortRatio <= 1 + 1e-6
      }, before.actors[0].generation, { timeout: 8000 })
      const restored = await read()
      requireMeasurement(standing(restored.actors[0]) && restored.actors[0].support === 'double', 'Reset did not restore the measured stance envelope')
      report.measurements.push({ scenario: 'fall-reset', samples: [{ phase: 'before', state: before }, { phase: 'fallen', state: fallen },
        { phase: 'reset', state: restored }] })
      return { disturbance: 'class D toe-ward, 150 N s over 0.1 s', before: actorSummary(before.actors[0]),
        fallen: actorSummary(fallen.actors[0]), restored: actorSummary(restored.actors[0]), recoverableWorkerReset: true, fallback: 'explicit arena rebuild; no get-up claim' }
    })
    await record('phone Push, Stance, Reset and left stick reach the claimed actor', async () => {
      await reset()
      const invite = await page.evaluate(() => window.__obpal?.pairingUrl)
      requireMeasurement(typeof invite === 'string' && invite.length > 0, 'Phone pairing URL missing')
      const phoneContext = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true, serviceWorkers: 'block' })
      contexts.push(phoneContext)
      try {
        await phoneContext.addInitScript(() => sessionStorage.setItem('obpal.hint.gyro', '1'))
        const phone = await phoneContext.newPage()
        phone.on('pageerror', error => report.errors.push(`phone: ${error.message}`))
        await phone.goto(invite, { timeout: 30_000 })
        await phone.locator('.gp:not([hidden]), .modes:visible').first().waitFor({ timeout: 25_000 })
        await page.waitForFunction(() => !!window.__humanoidControl.snapshot().actors[0]?.owner, undefined, { timeout: 15_000 })
        const initial = await read()
        if (await phone.locator('.gp').isVisible()) await phone.locator('.gp [data-act="exit"]').click()
        const tray = label => phone.locator(`.tray-btn[aria-label="${label}"]`)
        await tray('Push').click()
        await page.waitForFunction(before => {
          const s = window.__humanoidControl.snapshot()
          return (s.disturbances ?? s.pushes ?? 0) > before
        }, initial.disturbances ?? initial.pushes ?? 0, { timeout: 8000 })
        await tray('Stance').click()
        await tray('Reset').click()
        await page.waitForFunction(gen => window.__humanoidControl.snapshot().actors[0].generation > gen,
          initial.actors[0].generation, { timeout: 8000 })
        const final = await read()
        await phone.locator('.ctl-tab[data-c="face.gamepad"]').click()
        await page.locator('#physics-walk').check()
        const stick = phone.locator('.gp-stick[data-stick="0"]')
        await stick.waitFor({ state: 'visible' })
        // Synthetic touch events traverse the controller's actual Stick and pairing transport.
        // This proves the emulated phone input path, not physical touch latency.
        await stick.evaluate(zone => {
          const box = zone.getBoundingClientRect(), radius = zone.querySelector('.gp-base').offsetWidth / 2
          const x = box.left + box.width / 2, y = box.top + box.height / 2
          window.__humanoidStick = { x, y, travel: Math.max(20, radius - 8) }
          zone.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 51, pointerType: 'touch', clientX: x, clientY: y }))
          zone.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 51, pointerType: 'touch', clientX: x, clientY: y - window.__humanoidStick.travel }))
        })
        let phoneWalk
        try {
          await page.waitForFunction(() => ['stepping', 'walking'].includes(window.__humanoidControl.snapshot().actors[0]?.gaitState),
            undefined, { timeout: 8000 })
          phoneWalk = await read()
          await stick.evaluate(zone => {
            const { x, y, travel } = window.__humanoidStick
            zone.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 51, pointerType: 'touch', clientX: x + travel, clientY: y }))
          })
          await page.waitForTimeout(750)
        } finally {
          await stick.evaluate(zone => {
            const { x, y } = window.__humanoidStick
            zone.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 51, pointerType: 'touch', clientX: x, clientY: y }))
          })
        }
        await page.waitForFunction(() => window.__humanoidControl.snapshot().actors[0]?.gaitState === 'standing',
          undefined, { timeout: 8000 })
        const released = await read()
        requireMeasurement(!released.actors[0].fallen, 'Emulated phone stick release did not return safely to standing')
        await page.locator('#physics-walk').uncheck()
        return { beforeGeneration: initial.actors[0].generation, afterGeneration: final.actors[0].generation,
          actorCount: final.actors.length, walking: actorSummary(phoneWalk.actors[0]), released: actorSummary(released.actors[0]),
          inputPath: 'phone left Stick touch events -> paired PadState -> intent.ts -> gait',
          physicalPhoneClaimed: false, phoneViewportEmulation: true }
      } finally {
        try { await phoneContext.close() }
        catch (error) { report.errors.push(`Phone context cleanup: ${error.message}`) }
        await page.bringToFront()
      }
    })
    }
    for (const profileId of ['keel-v1', 'morrow-v1']) await record(`${profileId}: scripted stick stepping, turn, release and work budget`, async () => {
      let observed
      try {
        await page.evaluate(async profileId => {
          if (window.fixture) window.fixture.enabled = false
          clearInterval(window.fixtureTimer)
          window.__humanoidControl.clear(0)
          await window.__humanoidControl.profile(profileId)
        }, profileId)
        await page.waitForFunction(() => window.__humanoidControl.snapshot().ready, undefined, { timeout: 30_000 })
        await page.waitForTimeout(1500)
        const inPlace = (await read()).actors[0]?.walkingMode === 'in-place', releaseMs = inPlace ? 30000 : 12000
        await page.evaluate(async releaseMs => {
          await window.__humanoidControl.setWalk(0, true)
          window.__humanoidControl.startMeasure()
          window.__humanoidWalkTrace = []
          window.__humanoidWalkStart = performance.now()
          window.__humanoidWalkTimer = setInterval(() => window.__humanoidWalkTrace.push({
            timeMs: performance.now() - window.__humanoidWalkStart,
            state: window.__humanoidControl.snapshot() }), 50)
          window.__humanoidControl.stick(0, -.65)
          window.__humanoidTurnTimer = setTimeout(() => window.__humanoidControl.stick(.65, 0), 10_000)
          window.__humanoidStopTimer = setTimeout(() => window.__humanoidControl.stick(0, 0), releaseMs)
        }, releaseMs)
        await capture(`${profileId}-walk-stop`, inPlace ? [0, 1000, 5000, 7500, 10000, 13500, 25500, 32000, 36000]
          : [0, 250, 1000, 5000, 9750, 11000, 12250, 14000, 18000])
        observed = await page.evaluate(() => {
          clearInterval(window.__humanoidWalkTimer)
          return { metrics: window.__humanoidControl.endMeasure(), trace: window.__humanoidWalkTrace,
            final: window.__humanoidControl.snapshot(), sampleMs: performance.now() - window.__humanoidWalkStart }
        })
        const work = timingSummary(observed.metrics.workTimesMs ?? []), ticks = timingSummary(observed.metrics.tickTimesMs ?? [])
        const actors = observed.trace.map(sample => sample.state.actors[0]), final = observed.final.actors[0]
        const minPelvisHeightFraction = Math.min(...actors.map(actor => actor.pelvisHeight / actor.nominalPelvisHeight)),
          minUpY = Math.min(...actors.map(actor => actor.upY)),
          fallen = actors.some(actor => actor?.fallen || actor?.gaitState === 'fallen') || final.fallen || minPelvisHeightFraction < .8 || minUpY < .8
        const peakFootPenetrationM = Math.max(...actors.map(actor => actor.peakFootPenetrationM))
        const startActor = actors[0], forwardActor = observed.trace.find(sample => sample.timeMs >= 9750)?.state.actors[0],
          forwardTravelM = forwardActor ? Math.hypot(forwardActor.position.x - startActor.position.x, forwardActor.position.z - startActor.position.z) : null,
          maxTranslationM = Math.max(...actors.map(actor => Math.hypot(actor.position.x - startActor.position.x, actor.position.z - startActor.position.z))),
          turnTrace = observed.trace.filter(sample => sample.timeMs >= 10000 && sample.timeMs <= releaseMs),
          turnRad = turnTrace.slice(1).reduce((sum, sample, i) => {
            const delta = sample.state.actors[0].headingRad - turnTrace[i].state.actors[0].headingRad
            return sum + Math.atan2(Math.sin(delta), Math.cos(delta))
          }, 0)
        const summary = { profileId, walkingMode: inPlace ? 'in-place' : 'walk',
          claim: inPlace ? 'Step-and-turn-in-place only; no forward walking claim' : 'Experimental forward walking',
          command: { forwardIntentMs: 10000, turnMs: releaseMs - 10000, activeMs: releaseMs, settleMs: 6000, forwardStick: -.65, turnStick: .65 },
          warmupMs: 1500, sampleMs: observed.sampleMs, work, ticks, discardedSeconds: observed.metrics.droppedSeconds,
          workerUtilisation: observed.metrics.workerUtilisation, traceSamples: observed.trace.length,
          states: [...new Set(actors.map(actor => actor.gaitState))], fallen, minPelvisHeightFraction, minUpY, final: actorSummary(final), peakFootPenetrationM,
          forwardTravelM, maxTranslationM, turnRad, simulatedSeconds: (observed.final.tick - observed.trace[0].state.tick) / 240,
          queuedSeconds: observed.final.queuedSeconds,
          nativePenetrationGate: peakFootPenetrationM <= .005 ? 'passed 5 mm observed gate only' : 'red: exceeds 5 mm; official gait gates remain unchanged',
          status: fallen ? 'fell; Reset required' : final.gaitState === 'standing' ? 'returned to standing' : 'did not settle to standing',
          noFallRequired: profileId === 'keel-v1', failureMessage: observed.final.failureMessage,
          timingScope: observed.final.failureMessage ? 'Work and discarded-time measurements end at the worker fault; no complete Morrow frame-budget claim' : 'Complete gait and stop sample',
          bodyDuringWalk: 'No synthetic BODY in this gait sample',
          inputPath: 'test bridge left-stick mapping shared with phone PadState -> intent.ts -> gait' }
        report.walking.push(summary)
        report.measurements.push({ scenario: `${profileId}-walk-trace`, samples: observed.trace })
        await writeFile(join(evidence, `${profileId}-walk-work.json`), JSON.stringify({ ...summary, metrics: observed.metrics, trace: observed.trace }, null, 2))
        const fault = observed.trace.find(sample => !sample.state.ready || sample.state.failureMessage)
        if (profileId === 'keel-v1') requireMeasurement(!fault && observed.final.ready && !observed.final.failureMessage,
          `Gait worker fault: ${fault?.state.failureMessage || observed.final.failureMessage || 'not ready during sample'}`)
        requireMeasurement(observed.trace.length >= 200 && actors.every(actor => actor &&
          [actor.upY, actor.pelvisHeight, actor.peakFootPenetrationM, actor.position?.x, actor.position?.z].every(Number.isFinite)),
        'Walking trace is incomplete or contains nonfinite state/penetration/position')
        requireMeasurement(actors.every(actor => ['standing', 'stepping', 'walking', 'stopping', 'fallen'].includes(actor.gaitState)), 'Unknown live gait state')
        requireMeasurement(summary.states.some(state => state === 'walking' || state === 'stepping'), 'Stick never activated gait')
        requireMeasurement(actors.every(actor => Math.abs(actor.position.x) <= 3.6 && Math.abs(actor.position.z) <= 3.6), 'Actor left the soft-wall arena')
        requireMeasurement(work.samples >= 250 && Number.isFinite(work.p95Ms) && work.p95Ms <= 16.7,
          `Walking frame budget exceeded or missing: p95 ${work.p95Ms} ms; ${work.samples} samples`)
        requireMeasurement(observed.metrics.droppedSeconds === 0, `Walking worker discarded ${observed.metrics.droppedSeconds} s`)
        requireMeasurement(Number.isFinite(observed.metrics.workerUtilisation) && observed.metrics.workerUtilisation <= .8,
          `Walking worker utilisation exceeded 80% or missing: ${observed.metrics.workerUtilisation}`)
        if (!fault) requireMeasurement(summary.simulatedSeconds >= observed.sampleMs / 1000 * .9 && summary.queuedSeconds <= .1,
          `Walking simulation fell behind: ${summary.simulatedSeconds} s simulated; ${summary.queuedSeconds} s queued`)
        if (profileId === 'keel-v1') {
          requireMeasurement(!fallen, `${profileId} fell during scripted gait/turn/stop`)
          if (inPlace) {
            requireMeasurement(maxTranslationM <= .30, `${profileId} in-place gait travelled ${maxTranslationM} m; exceeds 0.30 m`)
            requireMeasurement(Number.isFinite(turnRad) && turnRad > .05, `${profileId} did not turn in place: ${turnRad} rad`)
          } else requireMeasurement(forwardTravelM >= .2, `Keel stick did not translate: ${forwardTravelM} m`)
          requireMeasurement(final.gaitState === 'standing' && !final.fallen && final.support !== 'none', `${profileId} release did not return safely into balance`)
        }
        if (profileId === 'morrow-v1' && (fallen || fault)) {
          if (fault) requireMeasurement(observed.final.resettable, 'Morrow worker fault disabled Reset')
          await reset()
          await page.waitForFunction(() => {
            const state = window.__humanoidControl.snapshot()
            return state.ready && !state.failureMessage && state.actors[0]?.gaitState === 'standing' && !state.actors[0]?.fallen
          }, undefined, { timeout: 30_000 })
          await page.waitForTimeout(1000)
          const recovered = await read()
          requireMeasurement(recovered.ready && !recovered.failureMessage && recovered.actors[0].gaitState === 'standing' &&
            !recovered.actors[0].fallen, 'Morrow Reset did not restore standing')
          summary.recovery = actorSummary(recovered.actors[0])
          summary.status = 'fell; Reset restored standing'
          await writeFile(join(evidence, `${profileId}-walk-work.json`), JSON.stringify({ ...summary, metrics: observed.metrics, trace: observed.trace }, null, 2))
        }
        return summary
      } finally {
        await page.evaluate(async () => {
          clearInterval(window.__humanoidWalkTimer)
          clearTimeout(window.__humanoidTurnTimer)
          clearTimeout(window.__humanoidStopTimer)
          window.__humanoidControl.stick(0, 0)
          await window.__humanoidControl.setWalk(0, false)
          await window.__humanoidControl.reset()
        })
      }
    })
    if (!walkOnly) {
    await page.evaluate(() => window.__humanoidControl.profile('keel-v1'))
    await record('default one-actor work budget and honest two-actor attempt or fallback', async () => {
      await page.bringToFront()
      await page.evaluate(() => { clearInterval(window.fixtureTimer); delete window.__humanoid })
      await page.evaluate(() => window.__humanoidControl.actorCount(1))
      await page.waitForFunction(() => window.__humanoidControl.snapshot().actors.length === 1, undefined, { timeout: 30_000 })
      await page.evaluate(() => { window.__humanoid = { actors: window.__humanoidControl.actors, inject: (index, body) => window.__humanoidControl.inject(index, body) } })
      await page.evaluate(installFixture)
      await page.evaluate(() => { window.fixture.animate = true })
      const warmStart = Date.now()
      await page.waitForTimeout(60_000)
      await page.evaluate(() => window.__humanoidControl.startMeasure())
      const sampleStart = Date.now()
      await page.waitForTimeout(120_000)
      const metrics = await page.evaluate(() => window.__humanoidControl.endMeasure())
      const final = await read(), durationMs = Date.now() - sampleStart
      requireMeasurement(Array.isArray(metrics.workTimesMs) && metrics.workTimesMs.length > 0, 'Per-frame work samples missing')
      requireMeasurement(metrics.workTimesMs.every(value => Number.isFinite(value) && value >= 0), 'Invalid work sample')
      const work = timingSummary(metrics.workTimesMs), ticks = timingSummary(metrics.tickTimesMs ?? [])
      report.frameBudget = { warmupMs: sampleStart - warmStart, sampleMs: durationMs, work, ticks,
        droppedSeconds: metrics.droppedSeconds, workerUtilisation: metrics.workerUtilisation, host: final.host,
        gfx: metrics.gfx, requestedActors: 1, actualActors: final.actors.length,
        scenario: 'default one standing actor; synthetic BODY seat1; no gait claim' }
      await writeFile(join(evidence, 'frame-work.json'), JSON.stringify(metrics, null, 2))
      requireMeasurement(work.samples >= 3000, 'Fewer than 3000 rendered samples in 120 s')
      requireMeasurement(work.p95Ms <= 16.7 && work.p99Ms <= 25, `Work budget exceeded: p95 ${work.p95Ms}; p99 ${work.p99Ms} ms`)
      requireMeasurement(metrics.droppedSeconds === 0, `Clock dropped ${metrics.droppedSeconds} s`)
      requireMeasurement(final.actors.length === 1 && final.actors.every(standing), 'Default actor sample ended outside the stance envelope')
      if (final.host === 'worker') requireMeasurement(Number.isFinite(metrics.workerUtilisation) && metrics.workerUtilisation <= .8,
        `Worker utilisation exceeded 80% or missing: ${metrics.workerUtilisation}`)
      await page.evaluate(() => { clearInterval(window.fixtureTimer); window.__humanoidControl.clear(0) })
      await page.evaluate(() => window.__humanoidControl.actorCount(2))
      await page.waitForFunction(() => window.__humanoidControl.snapshot().actors.length === 2, undefined, { timeout: 30_000 })
      await page.evaluate(installFixture)
      await page.evaluate(() => { window.fixture.animate = true })
      const twoWarmStart = Date.now()
      await page.waitForTimeout(15_000)
      await page.evaluate(() => {
        window.__humanoidControl.startMeasure()
        window.__humanoidActorCounts = [window.__humanoidControl.snapshot().actors.length]
        window.__humanoidCountTimer = setInterval(() => window.__humanoidActorCounts.push(window.__humanoidControl.snapshot().actors.length), 200)
      })
      const twoStart = Date.now()
      await page.waitForTimeout(30_000)
      const attempted = await page.evaluate(() => {
        clearInterval(window.__humanoidCountTimer)
        return { metrics: window.__humanoidControl.endMeasure(), actorCounts: window.__humanoidActorCounts,
          state: window.__humanoidControl.snapshot(), notice: document.getElementById('physics-budget')?.textContent ?? '' }
      })
      const twoWork = timingSummary(attempted.metrics.workTimesMs ?? [])
      const actualTwo = attempted.actorCounts.every(count => count === 2) && attempted.state.actors.length === 2
      const shortBudgetPass = actualTwo && twoWork.samples >= 750 && twoWork.p95Ms <= 16.7 && twoWork.p99Ms <= 25 &&
        attempted.metrics.droppedSeconds === 0 && attempted.metrics.workerUtilisation <= .8 && attempted.state.actors.every(standing)
      report.twoActorAttempt = { requestedActors: 2, actualActors: attempted.state.actors.length, observedActorCounts: [...new Set(attempted.actorCounts)],
        observationIntervalMs: 200, warmupMs: twoStart - twoWarmStart, sampleMs: Date.now() - twoStart,
        work: twoWork, ticks: timingSummary(attempted.metrics.tickTimesMs ?? []), workerUtilisation: attempted.metrics.workerUtilisation,
        droppedSeconds: attempted.metrics.droppedSeconds, degraded: attempted.state.degraded, notice: attempted.notice,
        shortBudgetPass, fullAcceptance: 'deferred: short standing/BODY attempt only; full two-actor walking acceptance is unmeasured',
        status: shortBudgetPass ? 'short attempt passed' : 'two-actor budget red/deferred' }
      await writeFile(join(evidence, 'two-actor-work.json'), JSON.stringify(attempted, null, 2))
      if (!shortBudgetPass) requireMeasurement(attempted.state.actors.length === 1 && attempted.state.degraded &&
        /two-actor preview disabled|restarted with one actor/i.test(attempted.notice),
        'Two-actor attempt exceeded budget without the visible one-actor fallback')
      return { default: report.frameBudget, twoActorAttempt: report.twoActorAttempt }
    })
    await record('phone-width layout keeps controls and status visible', async () => {
      await page.evaluate(() => { clearInterval(window.fixtureTimer); window.__humanoidControl.clear(0) })
      await page.evaluate(() => window.__humanoidControl.actorCount(1))
      await page.setViewportSize({ width: 412, height: 915 })
      await page.waitForTimeout(500)
      if (!await controls.isVisible()) await page.locator('[data-panel-toggle="controls"]').click()
      await controls.waitFor({ state: 'visible' })
      await page.locator('[data-physics-push]').scrollIntoViewIfNeeded()
      await page.waitForTimeout(250)
      const state = await read()
      await writeFile(join(evidence, 'phone-width.png'), await page.screenshot())
      const bounds = {}
      for (const selector of ['#physics-walk', '[data-physics-push]', '[data-physics-reset]', '[data-physics-stance]', '[data-physics-status]']) {
        const box = await page.locator(selector).boundingBox()
        bounds[selector] = box
        requireMeasurement(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.x + box.width <= 413 && box.y >= 0 && box.y + box.height <= 916,
          `Control outside phone viewport: ${selector}`)
      }
      return { viewport: { width: 412, height: 915 }, actorCount: state.actors.length, controlsOpen: true, bounds, emulationOnly: true }
    })
    }
  } catch (error) {
    report.errors.push(String(error?.stack ?? error))
    if (page && !page.isClosed()) {
      try {
        report.failureState = await page.evaluate(() => ({ title: document.title,
          status: document.getElementById('physics-status')?.textContent ?? null,
          budget: document.getElementById('physics-budget')?.textContent ?? null,
          note: document.getElementById('note')?.textContent ?? null,
          bridgePresent: !!window.__humanoidControl, snapshot: window.__humanoidControl?.snapshot() ?? null }))
        if (raw) {
          await mkdir(join(raw, 'startup-failure'), { recursive: true })
          const path = 'startup-failure/0.png'
          await writeFile(join(raw, path), await page.screenshot())
          frames.push({ path, timeMs: 0, note: 'Page startup or readiness failure; not a standing proof', failed: true })
        }
      } catch (captureError) { report.errors.push(`Failure diagnostics: ${captureError.message}`) }
    }
  }
  finally {
    for (const context of contexts) { try { await context.close() } catch (error) { report.errors.push(`Context cleanup: ${error.message}`) } }
    try { await browser?.close() } catch (error) { report.errors.push(`Browser cleanup: ${error.message}`) }
    report.pass = report.results.length === expectedScenarios && report.results.every(row => row.pass) && report.errors.length === 0
    if (raw) {
      try {
        await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
        await writeFile(join(evidence, 'evidence-frames.json'), JSON.stringify({ expectedCount: expectedFrames, frames }, null, 2))
      } catch (error) { report.pass = false; report.errors.push(`Evidence write: ${error.message}`) }
    }
    console.log(`Humanoid control review evidence: ${evidence}; raw frames in TEMP for automatic distillation`)
    console.log(JSON.stringify({ ...report,
      measurements: report.measurements.map(({ scenario, samples }) => ({ scenario, capturedSamples: samples.length })) }))
  }
  for (const row of report.results) await check(`humanoid physics: ${row.name}`, () => {
    if (!row.pass) throw new Error(row.error)
    return JSON.stringify(row.detail)
  })
  await check(`humanoid physics: complete ${walkOnly ? 'walking debug' : 'ten-scenario'} harness, no browser errors`, () => {
    requireMeasurement(report.results.length === expectedScenarios && report.errors.length === 0 && frames.length === expectedFrames,
      report.errors.join('; ') || 'Incomplete scenario harness or missing captured frames')
    return `${report.results.filter(row => row.pass).length}/${expectedScenarios} scenarios; ${frames.length}/${expectedFrames} captured frames${walkOnly ? '; walking debug only; full page acceptance unmeasured' : ''}`
  })
}
