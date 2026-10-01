/** Filesystem guards shared by backup and reap. Machine settings stay in ignored local storage. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, parse, toNamespacedPath, win32 } from 'node:path'

export const git = (root, args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, windowsHide: true, maxBuffer: 256 << 20 })
export const refusal = message => Object.assign(new Error(message), { exitCode: 2 })
export function settings(root = process.env.OBPAL_MAINTENANCE_ROOT || process.cwd()) {
  root = resolve(root)
  plainDirectory(join(root, '.claude/local'))
  const file = join(root, '.claude/local/maintenance.config.json')
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  if (cfg.keep !== undefined && (!Array.isArray(cfg.keep) || cfg.keep.some(name => typeof name !== 'string'))) throw refusal('Maintenance keep must be an array of lane names')
  return { root, backupRoot: resolve(process.env.OBPAL_BACKUP_ROOT || cfg.backupRoot || 'D:\\ObPal-Backups'),
    runsRoot: resolve(process.env.OBPAL_RUNS_ROOT || cfg.runsRoot || 'D:\\ObPal-Runs'), keep: cfg.keep || [],
    backupRepository: process.env.OBPAL_BACKUP_REPOSITORY || cfg.backupRepository,
    tempRoot: resolve(process.env.OBPAL_TEMP_ROOT || cfg.tempRoot || process.env.TEMP || process.env.TMP || '/tmp'),
    freeSpaceRoot: resolve(process.env.OBPAL_FREE_SPACE_ROOT || cfg.freeSpaceRoot || parse(root).root),
    ensureFreeGb: Number(process.env.OBPAL_ENSURE_FREE_GB ?? cfg.ensureFreeGb ?? 150) }
}
export function mainCheckout(root) {
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  if (resolve(common).toLowerCase() !== resolve(root, '.git').toLowerCase()) throw refusal('Run maintenance against the main checkout')
}
export function secretPath(path) {
  return /(^|\/)(?:keys|\.obpal-keys|\.blackboxes-keys)(?:\/|$)|(^|\/)(?:\.env(?:\.[^/]*)?|id_rsa(?:\.[^/]*)?|\.npmrc|credentials\.json)$|\.(pem|p12|pfx)$/i.test(path.replaceAll('\\', '/'))
}
export function differentDrive(repo, backup) {
  const drive = path => /^[a-z]:[\\/]/i.test(path) ? win32.parse(path).root.toLowerCase() : parse(resolve(path)).root
  if (drive(repo) === drive(backup)) throw refusal('Backup root must be on a different drive from the repository')
}
export function plainDirectory(path) {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || realpathSync(path).toLowerCase() !== resolve(path).toLowerCase())) throw refusal('Directory must not traverse a junction or symlink')
  if (!existsSync(path) && dirname(path) !== path) plainDirectory(dirname(path))
}
/** Walk links as entries, never as directories. */
export function entries(root) {
  const found = []
  const walk = path => {
    const info = lstatSync(toNamespacedPath(path))
    if (info.isSymbolicLink()) { found.push({ path, link: true, size: 0, mtime: info.mtimeMs }); return }
    if (info.isDirectory()) { for (const name of readdirSync(toNamespacedPath(path))) walk(join(path, name)); return }
    found.push({ path, size: info.size, mtime: info.mtimeMs })
  }
  if (existsSync(root)) walk(root)
  return found
}
export const treeSize = path => entries(path).reduce((size, file) => size + file.size, 0)
export async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(toNamespacedPath(path))) hash.update(chunk)
  return hash.digest('hex')
}
export function safeRelative(base, path) {
  const rel = relative(base, path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw refusal('File escapes its container')
  return rel
}
export function freeGb(root) {
  const stats = statfsSync(root, { bigint: true })
  return Number(stats.bavail * stats.bsize) / 1024 ** 3
}
export const floorExit = (available, floor) => available < floor ? 3 : 0
/** FileShare.None catches held Windows files before any part of a tree is removed. */
export function lockedFiles(files) {
  if (process.platform !== 'win32' || !files.length) return []
  const script = "$items = ConvertFrom-Json ([Console]::In.ReadToEnd()); foreach ($p in $items) { try { $f = [IO.File]::Open($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); $f.Dispose() } catch { [Console]::WriteLine($p) } }"
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: JSON.stringify(files.map(f => toNamespacedPath(f.path))), encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 })
  if (result.status !== 0 || result.error) throw new Error('Could not check held files')
  return result.stdout.trim().split(/\r?\n/).filter(Boolean)
}
