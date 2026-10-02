/** Eight seconds of presented startup frames at the standard desktop and phone sizes. */
import { distill } from './lib/distill.mjs'
import { tempScope } from './lib/temp.mjs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { e2eBrowserOptions } from './lib/browser.mjs'
import { measureWarmup, prepareWarmup, warmupFailure, WARMUP_SIMS, WARMUP_SIZES } from './lib/warmup.mjs'
import { startupProof } from './lib/startup-proof.mjs'

export async function runWarmup(local, check, { home = false } = {}) {
  const temps = tempScope()
  try {
  const out = process.env.OBPAL_E2E_EVIDENCE_ROOT ? join(process.env.OBPAL_E2E_EVIDENCE_ROOT, 'warmup') : await temps.make(join(tmpdir(), 'obpal-warmup-'))
  await mkdir(out, { recursive: true })
  const browser = await chromium.launch(e2eBrowserOptions({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true,
    args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] }))
  try {
    for (const [id, path] of home ? [['home', '/']] : WARMUP_SIMS) for (const { name, ...size } of WARMUP_SIZES) {
      if (process.env.OBPAL_E2E_WARMUP_ONLY && !new RegExp(process.env.OBPAL_E2E_WARMUP_ONLY).test(`${id} at ${name}`)) continue
      await check(`warm-up stability: ${id} at ${name}`, async () => {
        const context = await browser.newContext({ ...size, ignoreHTTPSErrors: true })
        try {
          await prepareWarmup(context)
          const page = await context.newPage()
          const result = await measureWarmup(page, local.origin + path)
          await startupProof(join(out, `${id}-${name}`), result)
          for (const f of result.screens) delete f.image
          const failure = warmupFailure(result)
          await writeFile(join(out, `${id}-${name}.json`), JSON.stringify({ failure, ...result }))
          if (failure) throw new Error(failure)
          return `${result.frames.length} canvas and ${result.screens.length} compositor frames; no clears, setup pops or broad alternations`
        } finally { await context.close() }
      })
    }
  } finally { await browser.close() }
  await distill(out)
  console.log(`  Warm-up measurements: ${out}`)

  } finally { await temps.cleanup() }
}
