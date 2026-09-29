/**
 * Runs the deploy with the last builds' hashed files carried along (`pnpm run deploy` calls it):
 *
 *   node scripts/keep-assets.mjs [--store <dir>] <the deploy command, e.g. wrangler deploy>
 *
 *   1. Copies the files of the last two deployed builds that the new build lacks into its assets, so a page opened
 *      before this deploy (or its HTML, still on an edge cache) finds the chunks it asks for.
 *   2. Runs the command.
 *   3. When it succeeds, keeps this build's files as the newest kept build, and drops the oldest.
 *
 * The kept builds live in .kept-assets/ (ignored by git; --store to move it). With none kept yet, a fresh checkout
 * or another machine, a deploy goes as it would without this. The command is the only thing that deploys.
 * Exit code: the command's, or 1 when there is no build to deploy.
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { carryKept, deployedSite, keepBuild, keptBuilds, KEEP_BUILDS, STORE } from './lib/keep-assets.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
let store = resolve(root, STORE)
if (argv[0] === '--store') store = resolve(argv.splice(0, 2)[1] ?? '')
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  console.log('node scripts/keep-assets.mjs [--store <dir>] <the deploy command>')
  process.exit(argv.length ? 0 : 2)
}

let site
let moved
try {
  site = deployedSite(root)
  moved = carryKept({ site, store })
} catch (e) {
  console.error(`keep-assets: ${e.message}`)
  process.exit(1)
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
console.log(`keep-assets: ${plural(moved.carried.length, 'file')} carried from ${plural(moved.from.length, 'earlier build')} into this build's ${plural(moved.fresh.length, 'file')}`)

const run = spawnSync(argv.join(' '), { cwd: root, stdio: 'inherit', shell: true })
if (run.status !== 0) {
  console.error('keep-assets: the command did not succeed, so this build is not kept')
  process.exit(run.status ?? 1)
}
const made = keepBuild({ site, store, fresh: moved.fresh })
console.log(`keep-assets: ${made ? 'kept this build' : 'this build was already kept'}; ${plural(keptBuilds(store).length, 'build')} kept, up to ${KEEP_BUILDS}`)
