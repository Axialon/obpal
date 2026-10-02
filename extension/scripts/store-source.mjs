/** Content receipts use repository-relative names and include uncommitted build inputs. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const git = (root, args, encoding = 'utf8') => execFileSync('git', args, { cwd: root, encoding, maxBuffer: 64 << 20, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
export const sourcePath = path => /^(extension\/(src\/|[^/]+\.(html|json)|vite\.config\.ts|scripts\/icons\.mjs)|packages\/(core|host)\/(src\/|package\.json)|src\/(shared|ui|family|styles)\/|public\/(logo-mark\.svg|brand\/)|scripts\/markup[^/]*\.mjs$|pnpm-lock\.yaml$)/.test(path)
export const artPath = path => sourcePath(path) || /^(extension\/store\/src\/|src\/controller\/|src\/styles\.css$)/.test(path)
const content = (path, bytes) => /\.(ts|js|mjs|json|html|css|svg|yaml|txt)$/.test(path) ? bytes.toString('utf8').replace(/\r\n/g, '\n') : bytes

export function inputHash(root, select = sourcePath, commit) {
  const paths = (commit ? git(root, ['ls-tree', '-r', '--name-only', '-z', commit]) : git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0').filter(select)
  const sorted = [...new Set(paths)].filter(path => commit || existsSync(join(root, path))).sort()
  const blobs = commit ? commitFiles(root, commit, sorted) : null
  const hashes = sorted.map(path => [path, sha256(content(path, blobs ? blobs[path] : readFileSync(join(root, path))))])
  return sha256(JSON.stringify(hashes))
}

/** Read a historical input set in one git process, including binary art. */
export function commitFiles(root, commit, paths) {
  const data = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: paths.map(path => `${commit}:${path}\n`).join(''), maxBuffer: 64 << 20, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let offset = 0
  return Object.fromEntries(paths.map(path => {
    const end = data.indexOf(10, offset), header = data.toString('utf8', offset, end)
    const match = /^[a-f0-9]+ blob (\d+)$/.exec(header)
    if (!match) throw new Error(`Missing historical file ${path}`)
    const size = Number(match[1]), bytes = data.subarray(end + 1, end + 1 + size)
    offset = end + 2 + size
    return [path, bytes]
  }))
}

export function directoryHashes(dir) {
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)])
  return Object.fromEntries(walk(dir).sort().map(path => [relative(dir, path).replaceAll('\\', '/'), sha256(readFileSync(path))]))
}

export function validateBuild(root) {
  const path = join(root, 'extension/release/build-source.json')
  if (!existsSync(path)) throw new Error('Build has no source receipt; run pnpm run store:extension')
  const receipt = JSON.parse(readFileSync(path, 'utf8'))
  if (!existsSync(join(root, 'extension/dist')) || receipt.sourceSha256 !== inputHash(root) || JSON.stringify(receipt.files) !== JSON.stringify(directoryHashes(join(root, 'extension/dist')))) throw new Error('Build is stale or changed; run pnpm run store:extension')
  return receipt
}
