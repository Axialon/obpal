import { fileURLToPath } from 'node:url'
import { changedSuites } from './lib/suites.mjs'
const args = process.argv.slice(2).filter(arg => arg !== '--')
if (args.length !== 1 || args[0].startsWith('-')) { console.error('Usage: pnpm run suites -- <base>'); process.exitCode = 2 }
else console.log(changedSuites(fileURLToPath(new URL('..', import.meta.url)), args[0]).join(' '))
