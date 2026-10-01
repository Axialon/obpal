/** Report the whole family; only the migrated pendulum is an enforced gate. Use the existing guarded sims runner. */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareWarmup, measureWarmup, warmupFailure } from './lib/warmup.mjs'
import { prepareSmoothness, measureSmoothnessMotion } from './lib/smoothness-motion.mjs'
import { smoothnessVerdict } from './lib/smoothness-report.mjs'
import { SMOOTHNESS_SIMS } from './lib/smoothness-catalogue.mjs'

export async function runSmoothness(local, check, { ids = null } = {}) {
  const out = await mkdtemp(join(tmpdir(), 'obpal-smoothness-')), results = []
  const phone = process.env.OBPAL_SMOOTHNESS_SIZE === 'phone'
  const size = phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
    : { viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 }
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true,
    args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
  try {
    for (const [id, path] of SMOOTHNESS_SIMS.filter(([id]) => !ids || ids.includes(id))) {
      const row = { id, path, size, enforced: id === 'pendulum', error: null }
      const url = `${local.origin}${path}${path.includes('?') ? '&' : '?'}test=vr`
      let context
      try {
        // Startup uses the landed compositor/captureStream gate unchanged. A fresh context then measures motion.
        context = await browser.newContext({ ...size, ignoreHTTPSErrors: true })
        await prepareWarmup(context)
        let page = await context.newPage()
        const warmup = await measureWarmup(page, url)
        for (const frame of warmup.screens ?? []) delete frame.image
        row.warmup = warmup; row.warmupFailure = warmupFailure(warmup)
        await context.close(); context = null
        context = await browser.newContext({ ...size, ignoreHTTPSErrors: true })
        await prepareSmoothness(context); page = await context.newPage()
        const errors = []; page.on('pageerror', error => errors.push(error.message))
        await page.goto(url, { waitUntil: 'networkidle' })
        await page.waitForFunction(() => window.__presence?.experience, null, { timeout: 30000 })
        row.motion = await measureSmoothnessMotion(page, { pendulum: id === 'pendulum' })
        if (errors.length) row.error = errors.join('; ')
      } catch (error) { row.error = String(error?.message ?? error) }
      finally { await context?.close() }
      row.verdict = smoothnessVerdict(row)
      results.push(row)
      await writeFile(join(out, `${id}.json`), JSON.stringify(row, null, 2))
      // Persist after every scene, including failures. A report-only issue is never counted as a passing assertion.
      await writeFile(join(out, 'report.json'), JSON.stringify({ schema_version: 1, results }, null, 2))
      if (row.enforced) await check(`smoothness: ${id} warm-up, ten-second orbit, rigid parts and physics`, async () => {
        if (row.verdict.status !== 'pass') throw new Error([...row.verdict.failures, ...row.verdict.gaps].join('; '))
        return `p95 ${row.motion.p95.toFixed(2)} ms, ${row.motion.rigidMeshes} rigid parts, rest jitter ${row.motion.physics.restJitter}`
      })
      else console.log(`  report-only: ${id}: ${row.verdict.status}`)
    }
  } finally { await browser.close(); console.log(`  Smoothness measurements: ${out}`) }
  return { out, results }
}
