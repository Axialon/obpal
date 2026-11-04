/** Inspect indexing requests locally; --submit explicitly contacts the selected site and IndexNow. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicOrigin } from './lib/deployment.mjs'
import { indexNowPayload, submitIndexNow } from './lib/indexnow.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

const argv = process.argv.slice(2).filter(arg => arg !== '--')
if (argv.includes('--help')) {
  console.log('OBPAL_PUBLIC_ORIGIN=<your origin> pnpm run indexnow -- --key-file <your-key>.txt [--dry-run | --submit]')
} else try {
  let keyFile = process.env.OBPAL_INDEXNOW_KEY_FILE || ''
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--key-file') keyFile = argv[++i] || ''
    else if (!['--submit', '--dry-run'].includes(argv[i])) throw new Error('Unknown IndexNow option; see --help')
  }
  if (argv.includes('--submit') && argv.includes('--dry-run')) throw new Error('Choose --dry-run or --submit')
  if (!/^[a-f0-9]{32}\.txt$/.test(keyFile)) throw new Error('Select your own verification file with --key-file')
  const origin = publicOrigin(process.env.OBPAL_PUBLIC_ORIGIN, { required: true, https: true })
  const payload = indexNowPayload({ origin, keyFile, key: readFileSync(join(root, 'public', keyFile), 'utf8').trim(),
    sitemap: readFileSync(join(root, 'dist/client/sitemap.xml'), 'utf8') })
  const result = await submitIndexNow(payload, { submit: argv.includes('--submit') })
  console.log(`IndexNow ${result.submitted ? 'accepted' : 'dry run:'} ${result.count} URLs at ${origin}`)
  if (!result.submitted) console.log(payload.urlList.join('\n'))
} catch (error) { console.error(`IndexNow: ${error.message}`); process.exitCode = 1 }
