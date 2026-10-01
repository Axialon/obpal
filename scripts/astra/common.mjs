import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readDenyWords, riskyPath, scanText } from '../lib/scan.mjs'
import { LIMITS, readZip, safePath, writeZip } from './zip.mjs'
import { ensureLayout, prepareRequest, tidyOutbox, uploadMarker } from './layout.mjs'

export const REPOSITORY = 'Axialon/obpal'
export const SUITES = ['code', 'embed', 'home', 'phone', 'sims', 'shared', 'extension', 'catalogue', 'pages']
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`
export const utc = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '')
export const defaultOutbox = () => join(homedir(), 'Downloads', 'obpal-astra', 'outbox')
export function messageBudgetLine(budget = {}) {
  return `Budget: ${budget.stage ?? 12} messages for this stage; 200 for the programme; spent so far: ${budget.spent ?? 'not supplied'}.`
}
export function stageId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,59}$/.test(id)) throw new Error('Stage must be 1-60 lower-case letters, digits or hyphens')
  return id
}
export function git(root, args, input) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, input, maxBuffer: 128 << 20, windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`git ${args[0]} failed (exit ${r.status}): ${(r.stderr ?? '').toString().trim()}`)
  return r.stdout
}
export const masterSha = (root) => git(root, ['rev-parse', 'master']).toString().trim()
export function denyWords(root) {
  const common = resolve(root, git(root, ['rev-parse', '--git-common-dir']).toString().trim())
  return [...new Set([...readDenyWords(root), ...readDenyWords(dirname(common))])]
}
export function scanMembers(members, deny = []) {
  const findings = []
  for (const [path, bytes] of Object.entries(members)) {
    const pathHits = scanText(path, { deny })
    if (pathHits.length) throw new Error(`Private scan refused an archive path: ${pathHits.map((h) => h.rule).join(', ')}`)
    for (const [i, line] of Buffer.from(bytes).toString('utf8').split(/\r?\n/).entries()) {
      for (const hit of scanText(line, { deny })) {
        findings.push(`${path}:${i + 1}: ${hit.rule}`)
        if (findings.length >= 100) throw new Error(`Private scan refused:\n${findings.join('\n')}\nFurther findings omitted; refusal unchanged.`)
      }
    }
  }
  if (findings.length) throw new Error(`Private scan refused:\n${findings.join('\n')}`)
}
/** Guard secrets and machine state. Executable repository content requires the separate local review gate. */
export function guarded(path) {
  safePath(path)
  const p = path.toLowerCase()
  if (riskyPath(path) || riskyPath(p) || /(?:^|\/)claude\.local\.md$/.test(p)
    || /(?:^|\/)(?:keys?|\.obpal-keys|artifacts|node_modules|\.wrangler|\.claude)(?:\/|$)/.test(p)
    || /(?:^|\/)(?:registry|install)(?:\/|$)/.test(p) || /^desktop\/(?:.*\/)?[^/]*(?:install|registry)/.test(p)
    || /\.(?:reg|exe|msi|dll|bat|cmd|ps1)$/.test(p)
    || p === '.gitmodules' || p === '.gitattributes') throw new Error(`Guarded path refused: ${path}`)
  return path
}
export function tree(root, sha) {
  return git(root, ['ls-tree', '-r', '-z', '-l', sha]).toString().split('\0').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t'), [mode, type, blob, size] = meta.trim().split(/\s+/)
    return { path, mode, type, blob, size: Number(size) }
  })
}
export function beneath(root, path) {
  safePath(path)
  const destination = resolve(root, path), rel = relative(realpathSync(root), destination)
  if (rel.startsWith('..') || /^[A-Za-z]:/.test(rel)) throw new Error('Path outside root')
  let at = root
  for (const part of path.split('/')) {
    at = join(at, part)
    if (existsSync(at) && lstatSync(at).isSymbolicLink()) throw new Error(`Symlink refused: ${path}`)
  }
  return destination
}
export function globMatch(path, globs) {
  return globs.some((glob) => {
    if (glob === '**') return true
    let pattern = ''
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i]
      if (c === '*' && glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; pattern += '(?:.*/)?' } else pattern += '.*'
      } else if (c === '*') pattern += '[^/]*'
      else if (c === '?') pattern += '[^/]'
      else pattern += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${pattern}$`).test(path)
  })
}
export function archive(members, metadata) {
  const files = Object.fromEntries(Object.entries(members).map(([path, bytes]) => [path, sha256(bytes)]))
  return writeZip({ ...members, 'MANIFEST.json': json({ schema_version: 1, repository: REPOSITORY,
    integrity_scope: 'Every regular member except MANIFEST.json; the manifest cannot hash itself.', ...metadata, files }) })
}
export function loadArchive(path) {
  if (statSync(path).size > LIMITS.archive) throw new Error('ZIP archive size cap')
  const bytes = readFileSync(path), members = readZip(bytes)
  if (!members['MANIFEST.json']) throw new Error('MANIFEST.json missing')
  const manifest = JSON.parse(members['MANIFEST.json'].toString())
  if (manifest.schema_version !== 1 || manifest.repository !== REPOSITORY || !manifest.files
    || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw new Error('Unsupported manifest')
  const actual = Object.keys(members).filter((p) => p !== 'MANIFEST.json').sort(), declared = Object.keys(manifest.files).sort()
  if (json(actual) !== json(declared)) throw new Error('Manifest member inventory mismatch')
  for (const p of actual) if (sha256(members[p]) !== manifest.files[p]) throw new Error(`Hash mismatch: ${p}`)
  return { bytes, members, manifest }
}
export function saveExchange(outbox, stage, kind, bytes, prompt, { upload = true } = {}) {
  ensureLayout(outbox)
  if (kind === 'Request') prepareRequest(outbox, stage)
  mkdirSync(outbox, { recursive: true })
  const stem = `obpal-${stage}-${kind}-${utc()}`
  let path = join(outbox, `${stem}.zip`)
  writeFileSync(path, bytes, { flag: 'wx' })
  writeFileSync(join(outbox, `${stem}.prompt.txt`), prompt, { flag: 'wx' })
  if (upload) {
    const moved = tidyOutbox(outbox, { currentStage: stage })
    if (!existsSync(path)) path = moved.find(destination => destination.endsWith(`${stem}.zip`)) || path
    uploadMarker(dirname(path), stage, `Upload the current loose ZIP files and paste the prompt below.\n\n${prompt}`)
  }
  return path
}
export function args(argv, allowed, flags = []) {
  const opts = {}, positional = []
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (name === '--') continue
    if (!name.startsWith('--')) { positional.push(name); continue }
    if (flags.includes(name.slice(2)) && !(name.slice(2) in opts)) { opts[name.slice(2)] = true; continue }
    if (!allowed.includes(name.slice(2)) || !argv[i + 1] || argv[i + 1].startsWith('--') || name.slice(2) in opts) throw new Error(`Invalid argument: ${name}`)
    opts[name.slice(2)] = argv[++i]
  }
  return { opts, positional }
}
