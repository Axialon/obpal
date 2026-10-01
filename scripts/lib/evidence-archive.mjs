/** Preserve lane evidence before removal. No link destination is read or copied. */
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, toNamespacedPath } from 'node:path'
import { differentDrive, entries, plainDirectory, refusal, safeRelative, settings } from './maintenance.mjs'

const digest = path => {
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = openSync(toNamespacedPath(path), 'r')
  try { let length; while ((length = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)) }
  finally { closeSync(fd) }
  return hash.digest('hex')
}
export function verifyEvidence(folder, manifest) {
  for (const file of manifest.files) {
    const path = join(folder, file.path); safeRelative(folder, path); plainDirectory(dirname(path))
    if (entries(path).some(item => item.link) || digest(path) !== file.sha256) throw new Error('Evidence digest mismatch')
  }
}
/** The caller checks the destination drive; injectable copy is for synthetic failure fixtures. */
export function archiveEvidence(worktree, runsRoot, { now = new Date(), copy = copyFileSync, laneName } = {}) {
  const sourceRoot = join(worktree, 'artifacts'); plainDirectory(sourceRoot)
  const sources = entries(sourceRoot)
  if (!sources.length) return null
  if (sources.some(file => file.link)) throw refusal('Evidence contains a symlink or junction; refusing removal')
  plainDirectory(runsRoot)
  const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(':', '')
  const lane = laneName || basename(worktree).replace(/^(?:agent|astra|codex)-/, '')
  if (!/^[a-z][a-z0-9-]*$/.test(lane)) throw refusal('Invalid evidence lane name')
  const folder = join(runsRoot, lane, stamp)
  plainDirectory(folder); mkdirSync(dirname(folder), { recursive: true }); mkdirSync(folder)
  const files = []
  for (const source of sources) {
    const rel = relative(sourceRoot, source.path), target = join(folder, 'artifacts', rel)
    mkdirSync(toNamespacedPath(dirname(target)), { recursive: true })
    copy(toNamespacedPath(source.path), toNamespacedPath(target))
    const sha256 = digest(target)
    if (sha256 !== digest(source.path)) throw new Error('Evidence source changed during copy; refusing removal')
    files.push({ path: relative(folder, target).replaceAll('\\', '/'), sha256 })
  }
  const manifest = { version: 1, at: now.toISOString(), verified: true, files }
  verifyEvidence(folder, manifest)
  // Recheck the complete source inventory and hashes before authorizing deletion.
  const current = entries(sourceRoot)
  if (current.length !== sources.length || current.some(file => file.link || !sources.some(saved => saved.path === file.path))) throw new Error('Evidence inventory changed during copy')
  for (const file of files) if (digest(join(worktree, file.path)) !== file.sha256) throw new Error('Evidence changed during verification')
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(`Evidence archived: ${folder} (${files.length} SHA-256 verified files)`)
  return folder
}
export function preserveLaneEvidence(worktree, { discardArtifacts = false, maintenance, laneName } = {}) {
  if (discardArtifacts) { console.log('Evidence discarded by --discard-artifacts'); return null }
  const sourceRoot = join(worktree, 'artifacts'); plainDirectory(sourceRoot)
  if (!entries(sourceRoot).length) return null
  const cfg = maintenance || settings(dirname(dirname(dirname(worktree))))
  differentDrive(worktree, cfg.runsRoot)
  return archiveEvidence(worktree, cfg.runsRoot, { laneName })
}
export function pruneRuns(runsRoot, { now = Date.now(), dryRun = false } = {}) {
  plainDirectory(runsRoot)
  const selected = []
  if (!existsSync(runsRoot)) return selected
  for (const lane of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!lane.isDirectory() || !/^[a-z][a-z0-9-]*$/.test(lane.name)) continue
    const laneRoot = join(runsRoot, lane.name); plainDirectory(laneRoot)
    for (const run of readdirSync(laneRoot, { withFileTypes: true })) {
      if (!run.isDirectory() || !/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(run.name)) continue
      const folder = join(laneRoot, run.name); plainDirectory(folder)
      if (existsSync(join(folder, 'keep'))) continue
      let manifest
      try { manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) } catch { continue }
      if (!manifest.verified || !Number.isFinite(Date.parse(manifest.at)) || now - Date.parse(manifest.at) < 60 * 86400_000) continue
      if (entries(folder).some(file => file.link)) throw refusal('Run retention candidate contains a link')
      verifyEvidence(folder, manifest); selected.push(folder)
      console.log(`${dryRun ? 'would prune' : 'prune'} evidence archive ${folder}`)
      if (!dryRun) rmSync(toNamespacedPath(folder), { recursive: true })
    }
  }
  return selected
}
