/** Preserve lane evidence before removal. No link destination is read or copied. */
import { copyFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rawFolder } from './distill.mjs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, toNamespacedPath } from 'node:path'
import { differentDrive, entries, plainDirectory, refusal, safeRelative, settings } from './maintenance.mjs'

const summary = file => /\.(md|json|log|txt)$/i.test(file.path) || (/\.(png|jpg|jpeg|webp|avif)$/i.test(file.path) && file.size < 5 * 1024 ** 2) ? 0 : 1

export const digest = path => {
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
export function archiveEvidence(worktree, runsRoot, { now = new Date(), copy = copyFileSync, laneName, fullArtifacts = false } = {}) {
  const sourceRoot = join(worktree, 'artifacts'); plainDirectory(sourceRoot)
  const inventory = entries(sourceRoot)
  if (inventory.some(file => file.link)) throw refusal('Evidence contains a symlink or junction; refusing removal')
  const retained = new Set(), advisory = []
  const byPath = new Map(inventory.map(file => [file.path, file]))
  for (const file of inventory.filter(file => basename(file.path) === 'distill-manifest.json')) {
    retained.add(file.path)
    const path = relative(sourceRoot, file.path).replaceAll('\\', '/')
    let manifest
    try {
      manifest = JSON.parse(readFileSync(file.path, 'utf8'))
      if (!Array.isArray(manifest.files)) throw new Error('Invalid file inventory')
    } catch {
      advisory.push({ manifest: path, reason: 'invalid manifest' }); continue
    }
    if (!manifest.verified) advisory.push({ manifest: path, reason: 'unverified manifest' })
    // Lane manifests can predate later captures or appended logs. They only advise retention.
    for (const item of manifest.files) {
      let source
      try {
        source = join(dirname(file.path), item.path)
        safeRelative(dirname(file.path), source)
      } catch {
        advisory.push({ manifest: path, reason: 'invalid file path' }); continue
      }
      const listed = relative(sourceRoot, source).replaceAll('\\', '/')
      if (!byPath.has(source)) { advisory.push({ manifest: path, path: listed, reason: 'missing file' }); continue }
      retained.add(source)
      if (digest(source) !== item.sha256) advisory.push({ manifest: path, path: listed, reason: 'digest mismatch' })
    }
  }
  if (advisory.length) console.warn(`Advisory: ${advisory.length} distillation manifest differences; archiving fresh file digests`)
  const skipped = []
  const sources = inventory.filter(file => {
    const path = relative(sourceRoot, file.path).replaceAll("\\", "/")
    if (!fullArtifacts && !retained.has(file.path) && path.split("/").slice(0, -1).some(rawFolder)) { skipped.push({ path, bytes: file.size }); return false }
    return true
  }).sort((a, b) => summary(a) - summary(b))
  const bytes = inventory.reduce((n, file) => n + (file.link ? 0 : file.size), 0)
  if (bytes > 2 * 1024 ** 3) console.warn(`Warning: artifacts exceed 2 GB (${(bytes / 1024 ** 3).toFixed(2)} GB)`)
  const skippedFolders = new Map()
  for (const file of skipped) {
    const parts = file.path.split('/'), end = parts.findIndex(rawFolder), folder = parts.slice(0, end + 1).join('/')
    skippedFolders.set(folder, (skippedFolders.get(folder) || 0) + file.bytes)
  }
  for (const [folder, bytes] of skippedFolders) console.log(`Skipped ${folder}/: ${bytes} bytes`)
  if (!inventory.length) return null
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
  const manifest = { version: 2, at: now.toISOString(), verified: true, files, skipped, advisory, sourceBytes: bytes, inventory: inventory.map(file => ({ path: relative(sourceRoot, file.path).replaceAll('\\', '/'), bytes: file.size, mtime: file.mtime })) }
  verifyEvidence(folder, manifest)
  // Recheck the complete source inventory and hashes before authorizing deletion.
  const current = entries(sourceRoot)
  const sourcePaths = new Set(inventory.map(file => file.path))
  if (current.length !== inventory.length || current.some(file => file.link || !sourcePaths.has(file.path))) throw new Error('Evidence inventory changed during copy')
  for (const file of files) if (digest(join(worktree, file.path)) !== file.sha256) throw new Error('Evidence changed during verification')
  writeFileSync(join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(`Evidence archived: ${folder} (${files.length} SHA-256 verified files)`)
  return folder
}
/** Recheck archived bytes and the source inventory outside the ledger lock, immediately before removal. */
export function verifyLaneArchive(worktree, folder) {
  if (!folder) return
  const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'))
  verifyEvidence(folder, manifest)
  const current = entries(join(worktree, 'artifacts'))
  const savedFiles = new Map(manifest.inventory.map(file => [file.path, file]))
  if (current.length !== savedFiles.size || current.some(file => { const saved = savedFiles.get(relative(join(worktree, 'artifacts'), file.path).replaceAll('\\', '/')); return file.link || !saved || saved.bytes !== file.size || saved.mtime !== file.mtime })) throw new Error('Evidence inventory changed after archive')
  verifyEvidence(worktree, manifest)
}
export function preserveLaneEvidence(worktree, { discardArtifacts = false, maintenance, laneName, fullArtifacts = false } = {}) {
  if (discardArtifacts) { console.log('Evidence discarded by --discard-artifacts'); return null }
  const sourceRoot = join(worktree, 'artifacts'); plainDirectory(sourceRoot)
  if (!entries(sourceRoot).length) return null
  const cfg = maintenance || settings(dirname(dirname(dirname(worktree))))
  differentDrive(worktree, cfg.runsRoot)
  return archiveEvidence(worktree, cfg.runsRoot, { laneName, fullArtifacts })
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
