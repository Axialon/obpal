import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { args, json } from './common.mjs'
import { verification } from './intake.mjs'

export const verify = verification

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { opts, positional } = args(process.argv.slice(2), ['outbox', 'port', 'worker-port'])
    if (positional.length !== 1) throw new Error('Usage: astra:verify -- <stage> --port <stand-in> --worker-port <worker> [--outbox <dir>]')
    const report = await verify({ root: process.cwd(), stage: positional[0], outbox: opts.outbox ? resolve(opts.outbox) : undefined,
      port: opts.port, workerPort: opts['worker-port'] })
    console.log(json(report)); process.exitCode = report.result === 'verified' ? 0 : 1
  } catch (e) { console.error(`astra:verify: ${e.message}`); process.exitCode = 1 }
}
