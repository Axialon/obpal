/**
 * Publish ob.Pal as open source.
 *
 * Steps:
 * 1. Export the tracked files.
 * 2. Replace deployment-only identifiers with placeholders.
 * 3. Scan the export for anything private and refuse to go on if it finds something.
 * 4. With --publish, commit the export to the public repository as one snapshot.
 *
 * The development history stays private; publishing requires an existing public repository, identity and approved source/tree/baseline pins.
 *
 *   node scripts/open-source.mjs            export and scan, then remove the export
 *   node scripts/open-source.mjs --keep-logs retain the export for inspection
 *   node scripts/open-source.mjs --publish  publish to OBPAL_PUBLIC_REPOSITORY using OBPAL_SNAPSHOT_AUTHOR_*
 *
 * Private words to scan for (names, emails, account ids), one per line, go in `.open-source-deny` next to this
 * repo's root. That file is gitignored, so the scanner itself reveals nothing.
 */
import { tempScope } from './lib/temp.mjs'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDenyWords } from './lib/scan.mjs'
import { publicationTarget, publicOrigin } from './lib/deployment.mjs'
import { materializePublicExport, stagePublicOutput, stagePublicGitModes } from './lib/public-export.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const publish = process.argv.includes('--publish')
const git = (args, cwd = root, env = process.env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 << 20 })

/** A failed lookup, different repository or concurrent main change stops publication. */
function requirePublicBaseline(repository, baseline) {
  const metadata = JSON.parse(execFileSync('gh', ['repo', 'view', repository, '--json', 'nameWithOwner,isPrivate,defaultBranchRef'], { encoding: 'utf8' }))
  if (metadata.nameWithOwner !== repository || metadata.isPrivate !== false || metadata.defaultBranchRef?.name !== 'main') {
    throw new Error('Publication requires the selected existing public repository with main as its default branch')
  }
  const remote = git(['ls-remote', '--exit-code', `https://github.com/${repository}.git`, 'refs/heads/main']).trim()
  if (remote !== `${baseline}\trefs/heads/main`) throw new Error('Public main differs from the approved baseline')
}

const temps = tempScope()
async function main() {
try {
const target = publish ? publicationTarget(process.env) : null
if (publish) publicOrigin(process.env.OBPAL_PUBLIC_ORIGIN, { required: true, https: true })
const source = process.env.OBPAL_PUBLIC_SOURCE, baseline = process.env.OBPAL_PUBLIC_BASELINE, tree = process.env.OBPAL_PUBLIC_TREE
if (publish && ![source, baseline, tree].every(value => /^[a-f0-9]{40}$/.test(value || ''))) {
  throw new Error('Set OBPAL_PUBLIC_SOURCE, OBPAL_PUBLIC_BASELINE and OBPAL_PUBLIC_TREE to approved full Git hashes')
}
// ---- 1–3. select immutable inputs, project, verify every output and scan one authoritative inventory ----------------
const out = temps.makeSync(join(tmpdir(), 'obpal-open-source-'))
const deny = readDenyWords(root)
let materialized
try { materialized = materializePublicExport({ root, out, deny }) }
catch (error) {
  console.error(`Not publishing: problems in the export (${out})\n  ${error.message}`)
  process.exitCode = 1; return
}
console.log(`Export clean: ${materialized.files.length} files, ${deny.length} private words checked -> ${out}`)
if (!publish) return
if (materialized.source.revision !== source) throw new Error('Export source differs from the approved revision')

// ---- 4. publish -------------------------------------------------------------------------------------------------
const work = temps.makeSync(join(tmpdir(), 'obpal-public-'))
const PUBLIC_REPO = target.repository
const AUTHOR = ['-c', `user.name=${target.authorName}`, '-c', `user.email=${target.authorEmail}`]
requirePublicBaseline(PUBLIC_REPO, baseline)
git(['clone', '--quiet', '--single-branch', '--branch', 'main', `https://github.com/${PUBLIC_REPO}.git`, work], tmpdir())
if (git(['rev-parse', 'HEAD'], work).trim() !== baseline) throw new Error('Public main changed while cloning')
for (const e of readdirSync(work)) if (e !== '.git') rmSync(join(work, e), { recursive: true, force: true })
stagePublicOutput({ ...materialized, out, destination: work, root, deny })
git(['add', '-A'], work)
stagePublicGitModes({ destination: work, manifest: materialized.manifest })
if (git(['write-tree'], work).trim() !== tree) throw new Error('Staged snapshot differs from the approved Git tree')
if (!git(['status', '--porcelain'], work).trim()) {
  requirePublicBaseline(PUBLIC_REPO, baseline)
  console.log('Public repository already up to date.'); return
}
const version = JSON.parse(readFileSync(join(out, 'extension/package.json'), 'utf8')).version
git([...AUTHOR, 'commit', '--quiet', '-m', `ob.Pal snapshot (ob.Pal Link ${version})`], work, {
  ...process.env, GIT_AUTHOR_NAME: target.authorName, GIT_AUTHOR_EMAIL: target.authorEmail,
  GIT_COMMITTER_NAME: target.authorName, GIT_COMMITTER_EMAIL: target.authorEmail,
})
const commit = git(['rev-parse', 'HEAD'], work).trim()
if (git(['rev-parse', 'HEAD^{tree}'], work).trim() !== tree || git(['rev-parse', 'HEAD^'], work).trim() !== baseline) {
  throw new Error('Snapshot commit differs from the approved tree or public parent')
}
requirePublicBaseline(PUBLIC_REPO, baseline)
materialized.assertSourceUnchanged()
git(['push', '--quiet', 'origin', 'main:refs/heads/main'], work)
git(['fetch', '--quiet', 'origin', 'refs/heads/main'], work)
if (git(['rev-parse', 'FETCH_HEAD'], work).trim() !== commit || git(['rev-parse', 'FETCH_HEAD^{tree}'], work).trim() !== tree) {
  throw new Error('Public readback differs from the published snapshot')
}
console.log(`Published to https://github.com/${PUBLIC_REPO} at ${commit} with tree ${tree}`)

} finally { await temps.cleanup() }
}
try { await main() } catch { console.error('Public export failed; no private command output is printed.'); process.exitCode = 1 }
