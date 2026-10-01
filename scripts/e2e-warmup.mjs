/** Eight seconds of presented startup frames at the standard desktop and phone sizes. */
import { tempScope } from './lib/temp.mjs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { measureWarmup, prepareWarmup, warmupFailure, WARMUP_SIMS, WARMUP_SIZES } from './lib/warmup.mjs'

export async function runWarmup(local, check, { home = false } = {}) {
  const temps = tempScope()
  try {
  const out = await temps.make(join(tmpdir(), 'obpal-warmup-'))
  const browser = await chromium.launch({ executablePath: process.env.OBPAL_E2E_CHROMIUM || undefined, headless: true,
    args: ['--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required'] })
  try {
    for (const [id, path] of home ? [['home', '/']] : WARMUP_SIMS) for (const { name, ...size } of WARMUP_SIZES) {
      await check(`warm-up stability: ${id} at ${name}`, async () => {
        const context = await browser.newContext({ ...size, ignoreHTTPSErrors: true })
        try {
          await prepareWarmup(context)
          const page = await context.newPage()
          const result = await measureWarmup(page, local.origin + path)
          for (const f of result.screens) delete f.image
          await writeFile(join(out, `${id}-${name}.json`), JSON.stringify(result))
          const failure = warmupFailure(result)
          if (failure) throw new Error(failure)
          return `${result.frames.length} canvas and ${result.screens.length} compositor frames; no clears, setup pops or broad alternations`
        } finally { await context.close() }
      })
    }
  } finally { await browser.close() }
  console.log(`  Warm-up measurements: ${out}`)

  } finally { await temps.cleanup() }
}
