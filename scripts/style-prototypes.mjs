/** Live regression proof for delayed/failed optional meshes and the narrowly scoped decoder CSP. */
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startLocal } from '../extension/e2e/local.mjs'

for (const key of ['OBPAL_E2E_PORT', 'OBPAL_E2E_WORKER_PORT']) {
  assert(process.env[key], `${key} is required`)
  await new Promise((resolve, reject) => { const s = createServer(); s.once('error', reject); s.listen(Number(process.env[key]), '127.0.0.1', () => s.close(resolve)) })
}
const evidence = await mkdtemp(join(tmpdir(), 'obpal-style-prototypes-'))
const out = pathToFileURL(join(evidence, 'loading') + '/')
await mkdir(out, { recursive: true })
const report = [], budget = [], local = await startLocal()
let browser
try {
  browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM, headless: true, args: ['--ignore-certificate-errors'] })
  for (const name of ['drone', 'so101', 'rover']) for (const failure of [false, true]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    const page = await ctx.newPage(), errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(() => {
      window.__styleViolations = []
      document.addEventListener('securitypolicyviolation', e => window.__styleViolations.push(e.violatedDirective))
    })
    let release
    const gate = new Promise(resolve => { release = resolve })
    await page.route(`**/models/${name}.glb`, async route => {
      if (failure) await route.fulfill({ status: 503, body: 'Optional model unavailable' })
      else { await gate; await route.continue() }
    })
    const path = name === 'so101' ? '/sim/arm/?kind=so101' : `/sim/device/?d=${name}`
    await page.goto(local.origin + path + '&quality=native', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => window.__gfx?.().triangles > 0 && (window.__arm || window.__device))
    const placeholderMs = await page.evaluate(() => performance.now())
    assert.equal(await page.evaluate(name => performance.getEntriesByName(`obpal:${name}:visible`).length, name), 0)
    const initial = await page.evaluate(name => {
      if (name === 'so101') { const angles = window.__arm.arms()[0].joints.map(j => j.angle); window.__arm.goTo('a1', { yaw: 25, shoulder: -20, elbow: 80, wrist: 50, roll: 30 }, .4); return angles }
      const d = window.__device
      if (name === 'drone') { d.logic.drones[0].phase = 'takeoff'; return d.logic.drones[0].y }
      d.logic.rovers[0].v = .8; return d.logic.rovers[0].z
    }, name)
    await page.waitForTimeout(450)
    const current = await page.evaluate(name => name === 'so101' ? window.__arm.arms()[0].joints.map(j => j.angle) : name === 'drone' ? window.__device.logic.drones[0].y : window.__device.logic.rovers[0].z, name)
    assert.notDeepEqual(current, initial, 'The procedural placeholder must keep simulating')
    if (!failure) {
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-placeholder.png`, out)) })
      release()
      await page.waitForFunction(name => performance.getEntriesByName(`obpal:${name}:visible`).length > 0, name)
      await page.waitForTimeout(250)
    }
    const result = await page.evaluate(({ name, failure, placeholderMs }) => ({
      name, failure, placeholderMs,
      visibleMs: performance.getEntriesByName(`obpal:${name}:visible`)[0]?.startTime ?? null,
      violations: window.__styleViolations,
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
      gfx: window.__gfx(),
    }), { name, failure, placeholderMs })
    result.placeholderMotion = { initial, current }
    assert.deepEqual(errors, []); assert.deepEqual(result.violations, [])
    assert.match(result.csp, /require-trusted-types-for 'script'/)
    assert.match(result.csp, /trusted-types obpal-templates/)
    assert.match(result.csp, /script-src 'self' 'wasm-unsafe-eval'/)
    if (failure) assert.equal(result.visibleMs, null)
    else assert(result.visibleMs > placeholderMs + 400)
    report.push(result)
    await ctx.close()
    console.log(`${name}: ${failure ? 'failed download retains working placeholder' : 'working first frame before delayed GLB; clean CSP swap'}`)
  }
  for (const name of ['drone', 'so101', 'rover']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
    await page.goto(local.origin + (name === 'so101' ? '/sim/arm/?kind=so101' : `/sim/device/?d=${name}`) + '&quality=native')
    await page.waitForFunction(name => performance.getEntriesByName(`obpal:${name}:visible`).length > 0, name)
    await page.getByRole('button', { name: 'Overview', exact: true }).click()
    const peak = await page.evaluate(async name => {
      if (name === 'so101') {
        window.__arm.addArm(); window.__arm.addArm()
        for (const a of window.__arm.arms()) window.__arm.goTo(a.id, { yaw: 30, shoulder: -25, elbow: 65, wrist: 50, roll: 35 }, .5)
      } else if (name === 'drone') for (const unit of window.__device.logic.drones) unit.phase = 'takeoff'
      else for (const unit of window.__device.logic.rovers) { unit.v = 1; unit.lights = true; unit.honk = 5 }
      const samples = []
      for (let i = 0; i < 120; i++) { await new Promise(requestAnimationFrame); samples.push(window.__gfx()) }
      return { name, triangles: Math.max(...samples.map(s => s.triangles)), calls: Math.max(...samples.map(s => s.calls)) }
    }, name)
    assert(peak.triangles <= 250_000, `${name}: four-unit triangle budget (${peak.triangles})`)
    assert(peak.calls <= 150, `${name}: four-unit draw budget (${peak.calls})`)
    budget.push(peak); await page.close()
    console.log(`${name}: four active units, ${peak.triangles} triangles, ${peak.calls} draws`)
  }
  // The card catalogue still uses the procedural builders and requires no decoder permission.
  const page = await browser.newPage({ ignoreHTTPSErrors: true })
  await page.goto(local.origin + '/sim/')
  await page.waitForTimeout(1500)
  assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter(r => /\/models\/.*\.glb/.test(r.name)).length), 0)
  await page.close()
  const pages = await readdir(new URL('../dist/client/', import.meta.url), { recursive: true })
  const wasmPages = []
  for (const file of pages.filter(f => f.endsWith('.html'))) {
    const html = await readFile(new URL(`../dist/client/${file.replaceAll('\\', '/')}`, import.meta.url), 'utf8')
    if (html.includes('wasm-unsafe-eval')) wasmPages.push(file.replaceAll('\\', '/'))
  }
  assert.deepEqual(wasmPages.sort(), ['sim/arm/index.html', 'sim/device/index.html', 'sim/humanoid/index.html'])
  await writeFile(new URL('report.json', out), JSON.stringify({ report, budget, wasmPages, catalogueModels: 0 }, null, 2))
  await writeFile(new URL('../stress.json', out), JSON.stringify(budget, null, 2))
  console.log(`Review evidence: ${evidence}`)
} finally { await browser?.close(); await local.close() }
