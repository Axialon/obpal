/** Reclaim merged lane trees and stale test fixtures, preserving dirty work before removal. */
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, unlinkSync, rmdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, toNamespacedPath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { guardCleanup, removeLaneTree, pidAlive, withLedger } from './lanes/lib.mjs'
import { differentDrive, entries, floorExit, freeGb, git, hashFile, lockedFiles, mainCheckout, plainDirectory, refusal, safeRelative, secretPath, settings, treeSize } from './lib/maintenance.mjs'
import { verifyManifest } from './backup.mjs'
import { pruneRuns } from './lib/evidence-archive.mjs'

export function laneRunning(lane) {
  if (!lane || lane.cleanedAt) return false
  const round = lane.rounds?.at(-1)
  if (lane.state === 'running' || lane.status === 'running' || pidAlive(round?.pid) || pidAlive(lane.pid)) return true
  if (round) return !round.stoppedAt && !round.failed && !round.exitCode && !(round.final && existsSync(round.final))
  return false
}
export function reapSelection({ name, merged, lane, keep = [], current = false }) {
  if (current || keep.includes(name) || keep.includes(lane?.name) || laneRunning(lane)) return false
  const final = lane?.state === 'final' || lane?.status === 'final' || Boolean(lane?.rounds?.at(-1)?.final && existsSync(lane.rounds.at(-1).final))
  return merged || Boolean(final && (lane?.mergedAt || lane?.merged))
}
export function reapArgs(argv) {
  const opts = { hours: 12, keep: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--discard-artifacts') opts.discardArtifacts = true
    else if (arg === '--keep') {
      const names = []
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) names.push(...argv[++i].split(','))
      if (!names.length) throw refusal('--keep needs lane names')
      opts.keep.push(...names)
    } else if (arg === '--hours' || arg === '--ensure-free-gb') {
      const value = Number(argv[++i]); if (!Number.isFinite(value) || value < 0) throw refusal(`${arg} needs a nonnegative number`)
      opts[arg === '--hours' ? 'hours' : 'ensureFreeGb'] = value
    } else throw refusal(`Unknown reap option: ${arg}`)
  }
  return opts
}
/** Preserve tracked edits and nonignored untracked entries, then verify the recovery archive. */
export async function saveDirty(root, destination) {
  plainDirectory(destination); mkdirSync(destination, { recursive: true })
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  writeFileSync(join(destination, 'status.txt'), status)
  writeFileSync(join(destination, 'tracked.diff'), git(root, ['diff', 'HEAD', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'], null))
  const skipped = []
  for (const rel of git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    const source = join(root, rel); safeRelative(root, source)
    plainDirectory(dirname(source))
    if (secretPath(rel)) throw refusal('Dirty recovery contains a secret-pattern file; preserve it manually before reaping')
    const target = join(destination, 'untracked', rel)
    if (lstatSync(toNamespacedPath(source)).isSymbolicLink()) {
      // Store the link text only. Recovery never opens or copies its destination.
      skipped.push({ path: rel, link: readlinkSync(toNamespacedPath(source)) }); continue
    }
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(toNamespacedPath(source), toNamespacedPath(target))
    if (await hashFile(source) !== await hashFile(target)) throw new Error('Dirty recovery source changed')
  }
  const files = []
  for (const file of entries(destination)) files.push({ path: relative(destination, file.path).replaceAll('\\', '/'), sha256: await hashFile(file.path) })
  const manifest = { version: 1, verified: true, files, links: skipped }
  await verifyManifest(destination, manifest)
  writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}
export async function verifyDirtySource(root, destination, manifest) {
  if (!git(root, ['diff', 'HEAD', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'], null).equals(readFileSync(join(destination, 'tracked.diff')))) throw new Error('Tracked changes moved during recovery')
  for (const file of manifest.files.filter(file => file.path.startsWith('untracked/'))) {
    const source = join(root, file.path.slice('untracked/'.length)); plainDirectory(dirname(source))
    if (lstatSync(toNamespacedPath(source)).isSymbolicLink() || await hashFile(source) !== file.sha256) throw new Error('Untracked file changed during recovery')
  }
  for (const link of manifest.links) if (readlinkSync(toNamespacedPath(join(root, link.path))) !== link.link) throw new Error('Untracked link changed during recovery')
}
/** The root is checked separately; traversal only unlinks links, including junctions. */
export function removeTempTree(base, target) {
  plainDirectory(base)
  const rel = safeRelative(base, target)
  if (!/^obpal-[^\\/]+$/.test(rel)) throw refusal('Temp target must be a direct obpal-* child')
  const remove = path => {
    const long = toNamespacedPath(path), info = lstatSync(long)
    if (info.isSymbolicLink() || !info.isDirectory()) { unlinkSync(long); return }
    for (const name of readdirSync(long)) remove(join(path, name))
    rmdirSync(long)
  }
  if (existsSync(target)) remove(target)
}
export async function reap(cfg, opts = {}) {
  const { root, backupRoot, tempRoot } = cfg
  opts = { ...opts, keep: [...new Set([...(cfg.keep || []), ...(opts.keep || [])])] }
  mainCheckout(root); plainDirectory(join(root, '.claude/worktrees')); plainDirectory(tempRoot)
  const ledgerFile = join(root, '.claude/local/lanes.json'), base = join(root, '.claude/worktrees')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const log = (item, result) => {
    mkdirSync(dirname(ledgerFile), { recursive: true })
    appendFileSync(join(root, '.claude/local/reap.log'), JSON.stringify({ at: stamp, dryRun: Boolean(opts.dryRun), ...item, result }) + '\n')
  }
  const selected = [], remaining = []
  // Serialize worktree selection and removal with lane start/resume/cleanup. Dry-run reads only.
  const work = async ledger => {
    const registered = git(root, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice(9)))
    if (!existsSync(base)) return
    for (const dir of readdirSync(base, { withFileTypes: true })) {
      const path = join(base, dir.name)
      if (!/^(?:agent|astra|codex)-[a-z][a-z0-9-]*$/.test(dir.name) || !dir.isDirectory()) continue
      guardCleanup(base, path)
      // Registered nested trees have separate Git identities and must never be deleted together.
      if (registered.some(other => other !== path && relative(path, other) && !relative(path, other).startsWith('..') && !relative(path, other).includes(':'))) { remaining.push({ name: dir.name, size: treeSize(path), reason: 'nested worktree' }); continue }
      const lane = ledger.lanes.find(l => resolve(l.worktree || join(base, `codex-${l.name}`)).toLowerCase() === path.toLowerCase())
      let head, merged = false, size
      if (!existsSync(join(path, '.git'))) continue
      try {
        if (resolve(git(path, ['rev-parse', '--show-toplevel']).trim()).toLowerCase() !== path.toLowerCase()) continue
        head = git(path, ['rev-parse', 'HEAD']).trim(); try { git(root, ['merge-base', '--is-ancestor', head, 'master']); merged = true } catch {}
        size = treeSize(path)
      } catch (error) { console.log(`  skipped worktree ${dir.name}: ${error.code || 'unreadable'}`); continue }
      const item = { name: dir.name, size, head }
      if (!reapSelection({ name: dir.name, merged, lane, keep: opts.keep, current: resolve(process.cwd()).toLowerCase() === path.toLowerCase() })) { remaining.push(item); continue }
      const status = git(path, ['status', '--porcelain=v1', '--untracked-files=all'])
      console.log(`${opts.dryRun ? 'would remove' : 'remove'} worktree ${item.name}: ${item.size} bytes, ${head}${status.trim() ? ' (dirty; save first)' : ''}`)
      selected.push(item)
      if (!opts.dryRun) {
        const held = lockedFiles(entries(path).filter(file => !file.link))
        if (held.length) { console.log(`  skipped: ${held.length} held files`); log(item, 'held open'); remaining.push(item); continue }
        // A worker outside the ledger cannot make an unsafe deletion succeed.
        if (status.trim()) {
          differentDrive(root, backupRoot)
          const destination = join(backupRoot, 'worktree-reap', stamp, dir.name)
          const manifest = await saveDirty(path, destination)
          await verifyDirtySource(path, destination, manifest)
        }
        if (git(path, ['status', '--porcelain=v1', '--untracked-files=all']) !== status || git(path, ['rev-parse', 'HEAD']).trim() !== head) throw new Error('Worktree changed during recovery; refusing removal')
        removeLaneTree(base, path, { maintenance: cfg, discardArtifacts: opts.discardArtifacts, laneName: lane?.name })
        if (lane) lane.cleanedAt = new Date().toISOString()
      }
      log(item, opts.dryRun ? 'selected' : 'removed')
    }
    if (!opts.dryRun) git(root, ['worktree', 'prune', '--expire', 'now'])
  }
  if (opts.dryRun) await work(existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : { lanes: [] })
  else await withLedger(ledgerFile, work)
  for (const dir of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!dir.name.startsWith('obpal-') || (!dir.isDirectory() && !dir.isSymbolicLink())) continue
    const path = join(tempRoot, dir.name)
    let info, files
    try { info = lstatSync(toNamespacedPath(path)); files = entries(path) }
    catch (error) {
      const item = { name: dir.name, size: null, head: null, reason: error.code || 'unreadable' }
      console.log(`  skipped temp ${dir.name}: ${item.reason}`); log(item, 'unreadable'); remaining.push(item); continue
    }
    const item = { name: dir.name, size: files.reduce((n, file) => n + file.size, 0), head: null }
    const newest = files.reduce((at, file) => Math.max(at, file.mtime), info.mtimeMs)
    if (Date.now() - newest < (opts.hours ?? 12) * 3600_000) { remaining.push(item); continue }
    console.log(`${opts.dryRun ? 'would remove' : 'remove'} temp ${item.name}: ${item.size} bytes`); selected.push(item)
    const held = lockedFiles(files.filter(file => !file.link))
    if (held.length) { console.log(`  skipped held files: ${held.join(', ')}`); remaining.push(item); log(item, 'held open'); continue }
    if (!opts.dryRun) removeTempTree(tempRoot, path)
    log(item, opts.dryRun ? 'selected' : 'removed')
  }
  if (cfg.runsRoot) { differentDrive(root, cfg.runsRoot); pruneRuns(cfg.runsRoot, { dryRun: opts.dryRun }) }
  const available = freeGb(cfg.freeSpaceRoot), floor = opts.ensureFreeGb ?? cfg.ensureFreeGb
  const code = floorExit(available, floor)
  console.log(`${selected.length} candidates; free space ${available.toFixed(1)} GB; floor ${floor} GB${opts.dryRun ? ' (dry-run, no removals)' : ''}`)
  log({ name: 'run', size: selected.reduce((n, item) => n + item.size, 0), head: git(root, ['rev-parse', 'HEAD']).trim() }, `exit ${code}`)
  if (code) { console.log('Largest remaining worktrees and temp folders:'); for (const item of remaining.sort((a, b) => b.size - a.size).slice(0, 10)) console.log(`  ${item.name}: ${item.size} bytes`) }
  return { code, selected, remaining }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = (await reap(settings(), reapArgs(process.argv.slice(2)))).code }
  catch (error) { console.error(`reap: ${error.message}`); process.exitCode = error.exitCode || 1 }
}
