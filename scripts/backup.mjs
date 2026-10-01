/** Verified off-drive backups. Only the configured private remote may receive development history. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, toNamespacedPath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { differentDrive, entries, git, hashFile, lockedFiles, mainCheckout, plainDirectory, refusal, safeRelative, secretPath, settings } from './lib/maintenance.mjs'

const DAY = 86400_000
// These exact blobs are the throwaway self-signed TLS certificate and key (CN "ob.Pal e2e local")
// added by 94c46c1 and removed by 44c6b08 on 2026-09-26, when the stand-in began generating its own.
// They have no security value, occur only in private history, and were never in the squashed public snapshot.
export const HISTORICAL_TEST_TLS = {
  'extension/e2e/tls/cert.pem': 'f4aeeca173f1eaa3dd0f5affbb2995bc0e82a4fa',
  'extension/e2e/tls/key.pem': '53fe387eef1dc2b751a73316862c33054115d51d',
}
export const allowedHistoricalFile = (path, blob) => HISTORICAL_TEST_TLS[path] === blob
export function retentionSelection(backups, now = Date.now()) {
  const weeks = new Set()
  return [...backups].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).filter(item => {
    if (!item.verified || item.keep) return false
    const age = now - Date.parse(item.at)
    if (!Number.isFinite(age) || age < 7 * DAY) return false
    const week = Math.floor((age - 7 * DAY) / (7 * DAY))
    if (week < 8 && !weeks.has(week)) { weeks.add(week); return false }
    return true
  })
}
export function remoteIdentity(url) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]?.toLowerCase()
}
export function guardRemote(root, configured) {
  if (!configured || !/^[\w.-]+\/[\w.-]+$/.test(configured)) throw refusal('Configure backupRepository before pushing')
  let urls
  try {
    urls = [...git(root, ['remote', 'get-url', '--all', 'backup']).trim().split(/\r?\n/), ...git(root, ['remote', 'get-url', '--push', '--all', 'backup']).trim().split(/\r?\n/)]
  } catch { throw refusal('The backup remote is missing') }
  if (urls.some(url => remoteIdentity(url) !== configured.toLowerCase())) throw refusal('The backup remote does not match the configured private repository')
}
/** Check every reachable tracked blob, including branches and older commits being pushed. */
export function guardTracked(root) {
  for (const name of git(root, ['ls-files', '-z']).split('\0').filter(Boolean)) {
    if (secretPath(name)) throw refusal('Tracked files contain a secret-pattern file')
    const path = join(root, name)
    if (existsSync(path) && lstatSync(path).size > 90 * 1024 ** 2) throw refusal('Tracked files contain a file over 90 MB')
  }
  const objects = git(root, ['rev-list', '--objects', '--all']).trim().split('\n')
  // Raw history retains every path/blob pairing, including deletions and reused blobs with new filenames.
  const changes = git(root, ['log', '--all', '--format=', '--raw', '--diff-merges=first-parent', '--no-abbrev', '--no-renames', '-z']).split('\0')
  for (let i = 0; i < changes.length; i++) {
    const match = /^:(\d+) (\d+) ([a-f0-9]{40}) ([a-f0-9]{40}) [A-Z]/.exec(changes[i].replace(/^\n+/, ''))
    if (!match) continue
    const path = changes[++i]
    if (secretPath(path) && match.slice(3, 5).some(blob => !/^0+$/.test(blob) && !allowedHistoricalFile(path, blob))) throw refusal('Tracked history contains a secret-pattern file')
  }
  // cat-file accepts object IDs through stdin without shell interpolation.
  const ids = objects.map(line => line.split(' ')[0])
  const { stdout } = runGitInput(root, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], ids.join('\n') + '\n')
  if (stdout.split('\n').some(line => /^blob /.test(line) && Number(line.split(' ')[1]) > 90 * 1024 ** 2)) throw refusal('Tracked history contains a file over 90 MB')
}
function runGitInput(root, args, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 256 << 20, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('Git object inspection failed')
  return result
}
export async function verifyManifest(folder, manifest) {
  for (const file of manifest.files) {
    const path = join(folder, file.path); safeRelative(folder, path); plainDirectory(dirname(path))
    if (entries(path).some(entry => entry.link)) throw refusal('Manifest file must not be a link')
    if (secretPath(file.path)) throw refusal('Manifest contains a secret-pattern file')
    if (await hashFile(path) !== file.sha256) throw new Error(`Manifest mismatch: ${file.path}`)
  }
  return manifest.files.length
}
function backupsAt(root) {
  const found = []
  if (!existsSync(root)) return found
  for (const day of readdirSync(root, { withFileTypes: true })) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue
    const dateRoot = join(root, day.name); plainDirectory(dateRoot)
    for (const dir of readdirSync(dateRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const folder = join(dateRoot, dir.name); plainDirectory(folder)
      try { const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')); found.push({ ...manifest, folder }) } catch { /* incomplete backups are never pruned */ }
    }
  }
  return found
}
export async function backup(cfg, opts = {}) {
  const { root, backupRoot } = cfg
  mainCheckout(root); differentDrive(root, backupRoot); plainDirectory(backupRoot)
  const label = opts.label || 'manual'
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(label)) throw refusal('Label must contain lowercase letters, digits and hyphens')
  plainDirectory(join(root, '.claude/local'))
  const sources = [join(root, '.claude/local'), join(root, '.open-source-deny')].flatMap(entries)
  if (sources.some(file => secretPath(relative(root, file.path)) || file.link)) throw refusal('Local state contains a secret-pattern file or link')
  if (!opts.noPush) { guardRemote(root, cfg.backupRepository); guardTracked(root) }
  const prune = opts.keep ? [] : retentionSelection(backupsAt(backupRoot))
  console.log(`backup: ${opts.dryRun ? 'would back up' : 'backing up'} all refs and ${sources.length} local files; ${prune.length} verified backups to prune`)
  if (opts.dryRun) { for (const item of prune) console.log(`  prune ${item.folder}`); return }
  if (!opts.noPush) {
    git(root, ['push', 'backup', '--all']); git(root, ['push', 'backup', '--tags'])
    const remote = git(root, ['ls-remote', 'backup', 'refs/heads/master']).trim().split(/\s+/)[0]
    if (remote !== git(root, ['rev-parse', 'master']).trim()) throw new Error('Remote master does not match local master')
  }
  const now = new Date(), stamp = now.toISOString(), day = stamp.slice(0, 10), time = stamp.slice(11, 16).replace(':', '')
  const folder = join(backupRoot, day, `${label}-${time}`)
  mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder) // never overwrite an earlier backup
  const skipped = [], files = []
  const add = async path => files.push({ path: relative(folder, path).replaceAll('\\', '/'), sha256: await hashFile(path) })
  const bundle = join(folder, 'repo.bundle')
  git(root, ['bundle', 'create', bundle, '--all']); git(root, ['bundle', 'verify', bundle])
  writeFileSync(join(folder, 'HEAD.txt'), git(root, ['rev-parse', 'HEAD']))
  writeFileSync(join(folder, 'commit-count.txt'), git(root, ['rev-list', '--all', '--count']))
  for (const name of ['repo.bundle', 'HEAD.txt', 'commit-count.txt']) await add(join(folder, name))
  const held = new Set(lockedFiles(sources))
  for (const source of sources) {
    const rel = relative(root, source.path), dest = join(folder, rel)
    if (held.has(toNamespacedPath(source.path))) { skipped.push({ path: rel, reason: 'held open' }); continue }
    mkdirSync(dirname(dest), { recursive: true })
    try {
      copyFileSync(toNamespacedPath(source.path), toNamespacedPath(dest))
      const hash = await hashFile(dest)
      if (hash !== await hashFile(source.path)) throw new Error('Source changed during copy')
      files.push({ path: rel.replaceAll('\\', '/'), sha256: hash })
    } catch (error) { if (existsSync(dest)) unlinkSync(dest); skipped.push({ path: rel, reason: error.code || 'source changed' }) }
  }
  const manifest = { version: 1, at: stamp, verified: true, keep: Boolean(opts.keep), head: git(root, ['rev-parse', 'HEAD']).trim(), files, skipped }
  await verifyManifest(folder, manifest)
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  for (const item of prune) {
    // Recheck provenance and every digest before deleting a retention candidate; no links are traversed.
    if (entries(item.folder).some(file => file.link)) throw refusal('Retention candidate contains a link')
    await verifyManifest(item.folder, item)
    rmSync(item.folder, { recursive: true })
  }
  console.log(`Verified: ${files.length} SHA-256 files, ${skipped.length} skipped; ${folder}`)
  for (const item of skipped) console.log(`  skipped ${item.path}: ${item.reason}`)
  return { folder, manifest }
}
export function selfTest() {
  const temp = mkdtempSync(join(tmpdir(), 'obpal-backup-self-test-'))
  try {
    const repo = join(temp, 'repo'); mkdirSync(repo)
    git(repo, ['init', '-b', 'master']); writeFileSync(join(repo, 'sample.txt'), 'round trip\n'); git(repo, ['add', '.'])
    git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic backup fixture'])
    const bundle = join(temp, 'round-trip.bundle'); git(repo, ['bundle', 'create', bundle, '--all']); git(repo, ['bundle', 'verify', bundle])
    git(temp, ['clone', bundle, join(temp, 'clone')])
    if (git(repo, ['rev-parse', 'HEAD']) !== git(join(temp, 'clone'), ['rev-parse', 'HEAD'])) throw new Error('Bundle round trip changed HEAD')
    console.log('Bundle round trip: same HEAD'); return true
  } finally { rmSync(temp, { recursive: true, force: true }) }
}
export function backupArgs(argv) {
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (['--dry-run', '--no-push', '--keep', '--self-test'].includes(arg)) opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true
    else if (arg === '--label') opts.label = argv[++i]
    else throw refusal(`Unknown backup option: ${arg}`)
  }
  if (argv.includes('--label') && !opts.label) throw refusal('Missing label')
  return opts
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const opts = backupArgs(process.argv.slice(2)); if (opts.selfTest) selfTest(); else await backup(settings(), opts) }
  catch (error) { console.error(`backup: ${error.message}`); process.exitCode = error.exitCode || 1 }
}
