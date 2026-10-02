import { distill } from './lib/distill.mjs'
const args = process.argv.slice(2).filter(arg => arg !== '--')
const directory = args.find(arg => !arg.startsWith('--'))
if (!directory || (args.includes('--model') && args.includes('--vision')) || args.some(arg => arg.startsWith('--') && !['--keep-raw', '--model', '--vision'].includes(arg))) {
  console.error('Usage: pnpm run distill -- <artifacts dir> [--keep-raw] [--model | --vision]'); process.exitCode = 2
} else await distill(directory, { keepRaw: args.includes('--keep-raw'), model: args.includes('--model'), provider: args.includes('--vision') ? 'vision' : undefined }).catch(error => { console.error(`distill: ${error.message}`); process.exitCode = 1 })
