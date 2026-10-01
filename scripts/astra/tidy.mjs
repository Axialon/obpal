/** Idempotent Astra exchange housekeeping; no exchange file is ever deleted. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { args, defaultOutbox } from './common.mjs'
import { tidyExchange } from './layout.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { opts, positional } = args(process.argv.slice(2), ['outbox'], ['dry-run'])
    if (positional.length) throw new Error('Usage: astra:tidy -- [--dry-run] [--outbox <dir>]')
    const moves = tidyExchange(resolve(opts.outbox || defaultOutbox()), { root: process.cwd(), dryRun: Boolean(opts['dry-run']) })
    console.log(`Astra tidy: ${moves.length} ${opts['dry-run'] ? 'proposed moves' : 'moves'}`)
  } catch (error) { console.error(`astra:tidy: ${error.message}`); process.exitCode = 1 }
}
