/** Real browser engines, in a bench-only in-memory build. Uses the caller's guarded local origin and no extra ports.
 * No deployment config, production route, install, CDN, driver or persistent browser profile is changed. */
import { build } from 'vite'
import { chromium } from 'playwright'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { e2eBrowserOptions } from './lib/browser.mjs'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PREFIX = '/__physics-bench/'
const IDS = ['custom', 'rapier', 'physx']
const PROFILES = [{ id: 'chromium-native', rate: 1 }, { id: 'chromium-4x-throttle', rate: 4 }]
const blocked = (id, environment, error) => ({ id, environment, status: 'blocked', blocker: String(error), factoryLoadMs: null, coldInitMs: null,
  transfer: null, browserHeapBytes: null, fixtures: [], lifecycle: [] })
export async function runPhysicsBench(local, check) {
  const report = { schema_version: 1, kind: 'browser', rows: [], decisions: [], integrationDecision: null, errors: [],
    platform: process.platform, node: process.version, browser: null,
    profiles: PROFILES, note: '4x CPU throttle is a reproducible stress proxy, not a measured phone. Routing bypasses HTTP: exact fulfilled engine bytes and gzip-9 sizes are recorded separately from nullable Resource Timing.' }
  let browser
  try {
    const built = await build({ configFile: false, root: ROOT, publicDir: false, logLevel: 'warn', base: PREFIX,
      build: { write: false, assetsInlineLimit: 0, target: 'es2020', sourcemap: false,
        rolldownOptions: { input: resolve(ROOT, 'src/sim/physics/bench-page.ts') } } })
    const outputs = Array.isArray(built) ? built.flatMap(b => b.output) : built.output
    if (!Array.isArray(outputs)) throw new Error('Vite bench build returned no output inventory')
    const assets = new Map(outputs.map(item => {
      const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source)
      const modules = item.type === 'chunk' ? Object.keys(item.modules ?? {}) : [item.fileName, ...(item.originalFileNames ?? [])]
      const engines = IDS.filter(id => modules.some(path => id === 'rapier' ? /rapier3d-compat|\/backends\/rapier\.ts/.test(path) :
        id === 'physx' ? /physx-js-webidl|\/backends\/physx\.ts/.test(path) : /\/backends\/custom\.ts/.test(path)))
      return [item.fileName, { bytes, rawBytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length,
        sha256: createHash('sha256').update(bytes).digest('hex'), engines }]
    }))
    const entry = outputs.find(item => item.type === 'chunk' && item.isEntry)
    if (!entry) throw new Error('Vite bench entry is missing')
    browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: !process.argv.includes('--headed') }))
    report.browser = browser.version()
    for (const profile of PROFILES) for (const id of IDS) {
      const environment = `browser:${profile.id}`, context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
      const requests = new Set(), errors = [], seen = new Set()
      try {
        // Disallow accidental outbound network requests from the bench; only this emitted inventory is served.
        await context.route('**/*', async route => {
          const url = new URL(route.request().url())
          if (url.origin !== local.origin || !url.pathname.startsWith(PREFIX)) { errors.push(`Unexpected bench request: ${url.pathname}`); await route.abort(); return }
          const name = url.pathname.slice(PREFIX.length)
          const headers = { 'cache-control': 'no-store', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp',
            'cross-origin-resource-policy': 'same-origin', 'x-content-type-options': 'nosniff' }
          if (!name || name === 'index.html') {
            await route.fulfill({ status: 200, headers: { ...headers, 'content-type': 'text/html',
              'content-security-policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; object-src 'none'" },
              body: `<!doctype html><meta charset="utf-8"><title>ob.Pal physics benchmark</title><script type="module" src="${PREFIX}${entry.fileName}"></script>` })
            return
          }
          const asset = assets.get(name)
          if (!asset) { errors.push(`Missing emitted asset: ${name}`); await route.fulfill({ status: 404, body: 'missing bench asset' }); return }
          requests.add(name); for (const engine of asset.engines) seen.add(engine)
          await route.fulfill({ status: 200, headers: { ...headers, 'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }, body: asset.bytes })
        })
        const page = await context.newPage(), cdp = await context.newCDPSession(page)
        page.on('pageerror', error => errors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.rate })
        await page.goto(`${local.origin}${PREFIX}`, { waitUntil: 'load', timeout: 60_000 })
        await page.waitForFunction(() => Boolean(window.__physicsBench), undefined, { timeout: 60_000 })
        if (seen.size) throw new Error(`Engine downloaded before opt-in: ${[...seen].join(',')}`)
        // Bound the complete candidate even if a native simulation hangs the renderer. Closing the context
        // interrupts the page; the rejection handler remains attached (no abandoned rejection).
        let timer
        const row = await Promise.race([
          page.evaluate(({ id, environment }) => window.__physicsBench.run(id, environment), { id, environment }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Candidate exceeded 240 s execution budget')), 240_000) }),
        ]).finally(() => clearTimeout(timer))
        const delivered = [...requests].map(name => ({ name, ...assets.get(name) }))
        const engineAssets = delivered.filter(a => a.engines.includes(id))
        row.transfer = { rawBytes: engineAssets.reduce((n, a) => n + a.rawBytes, 0), gzipBytes: engineAssets.reduce((n, a) => n + a.gzipBytes, 0), files: engineAssets.length }
        row.assets = engineAssets.map(({ name, rawBytes, gzipBytes, sha256 }) => ({ name, rawBytes, gzipBytes, sha256 }))
        row.benchDelivery = { rawBytes: delivered.reduce((n, a) => n + a.rawBytes, 0), files: delivered.length }
        const runtime = await page.evaluate(() => {
          const resources = performance.getEntriesByType('resource'), memory = performance.memory
          const encoded = resources.reduce((n, r) => n + (r.encodedBodySize || 0), 0)
          return { browserHeapBytes: memory?.usedJSHeapSize ?? null, resourceTimingEncodedBytes: encoded || null, crossOriginIsolated: window.crossOriginIsolated }
        })
        Object.assign(row, runtime)
        if (!seen.has(id)) errors.push('No candidate engine artifact was actually requested')
        if ([...seen].some(engine => engine !== id)) errors.push(`Nonselected engines downloaded: ${[...seen].filter(engine => engine !== id).join(',')}`)
        row.browserErrors = errors; report.rows.push(row)
      } catch (error) { report.rows.push({ ...blocked(id, environment, error), browserErrors: errors }) }
      finally { await context.close() }
    }
    // Run the exact typed decision and validation modules inside the bench, not a separately reimplemented rule.
    // The bench entry exposes these pure functions, with no further engine import.
    const context = await browser.newContext({ serviceWorkers: 'block' })
    try {
      await context.route('**/*', async route => {
        const url = new URL(route.request().url()), name = url.pathname.slice(PREFIX.length)
        if (url.origin !== local.origin || !url.pathname.startsWith(PREFIX)) return route.abort()
        if (!name) return route.fulfill({ contentType: 'text/html', body: `<script type="module" src="${PREFIX}${entry.fileName}"></script>` })
        const asset = assets.get(name)
        return asset ? route.fulfill({ contentType: 'text/javascript', body: asset.bytes }) : route.abort()
      })
      const page = await context.newPage(); await page.goto(`${local.origin}${PREFIX}`); await page.waitForFunction(() => Boolean(window.__physicsBench))
      for (const row of report.rows) row.validationFailures = await page.evaluate(row => window.__physicsBench.failures(row), row)
      for (const profile of PROFILES) report.decisions.push({ profile: profile.id,
        ...await page.evaluate(rows => window.__physicsBench.choose(rows), report.rows.filter(r => r.environment === `browser:${profile.id}`)) })
      report.integrationDecision = await page.evaluate(rows => window.__physicsBench.chooseAcrossProfiles(rows), report.rows)
    } finally { await context.close() }
  } catch (error) {
    report.errors.push(String(error))
    for (const profile of PROFILES) for (const id of IDS) if (!report.rows.some(r => r.id === id && r.environment === `browser:${profile.id}`))
      report.rows.push(blocked(id, `browser:${profile.id}`, error))
  } finally { if (browser) try { await browser.close() } catch (error) { report.errors.push(`Browser cleanup failed: ${String(error)}`) } }
  // Always print the complete table before assertions. The verifier captures this stdout even on a red gate.
  console.log(`OBPAL_PHYSICS_BENCH ${JSON.stringify(report)}`)
  await check('physics bench infrastructure', () => { if (report.errors.length) throw new Error(report.errors.join('; ')) })
  for (const row of report.rows) await check(`physics bench ${row.environment} ${row.id}`, () => {
    const failures = [...(row.validationFailures ?? ['validation did not execute']), ...(row.browserErrors ?? [])]
    if (row.status !== 'measured' || failures.length) throw new Error(`${row.blocker ?? ''} ${failures.join('; ')}`)
    return `${row.fixtures.length} real fixtures + replay; ${row.transfer.rawBytes} raw engine bytes`
  })
  await check('physics integration selection', () => {
    if (report.integrationDecision?.status !== 'selected') throw new Error(report.integrationDecision?.reason ?? 'Both-profile selection did not execute')
    return `${report.integrationDecision.selected}; ${report.integrationDecision.reason}`
  })
  for (const decision of report.decisions) await check(`physics measured selection ${decision.profile}`, () => {
    if (decision.status !== 'selected') throw new Error(decision.reason)
    return `${decision.selected}; ${decision.reason}`
  })
}
