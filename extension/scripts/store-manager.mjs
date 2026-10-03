/** Local dashboard preparation and submission records. Never uploads or consults private keys. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { parseListing, compareFields, fieldKey } from './store-fields.mjs'
import { unzip } from './zip.mjs'
import { artPath, commitFiles, git, inputHash, sha256 } from './store-source.mjs'

export const artwork = [
  ['icon-128.png', 128, 128],
  ...[1, 2, 3, 4, 5].map(n => [`screenshot-${n}.png`, 1280, 800]),
  ['tile-440x280.png', 440, 280], ['marquee-1400x560.png', 1400, 560],
]
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const storeFile = (root, name) => join(root, 'extension/store', name)
const versionOf = root => readJson(join(root, 'extension/package.json')).version
export const lastSubmitted = ledger => ledger.entries.findLast(entry => entry.submittedAt)
/** Whether the plain x.y.z `version` is newer than `other`; false when either is anything else. */
export function versionNewer(version, other) {
  const [a, b] = [version, other].map(v => /^\d+\.\d+\.\d+$/.test(v ?? '') ? v.split('.').map(Number) : null)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}
/**
 * In development: a version newer than the last submission that isn't marked prepared. Its listing, art and zip may lag
 * its code, so `store check` leaves their receipts alone until `store -- kit` validates them and marks it prepared. A
 * version that was submitted, or is prepared, is held to them; so is a rejected one, which is fixed in place.
 */
export const inDevelopment = (ledger, status, version) => {
  const latest = lastSubmitted(ledger)
  return status.prepared !== version && (!latest || versionNewer(version, latest.version))
}
const atCommit = (root, commit, name) => git(root, ['show', `${commit}:extension/store/${name}`], null)
const listingHashes = tabs => Object.fromEntries(tabs.flatMap(tab => tab.fields.map(field => [fieldKey(tab, field), sha256(field.text)])))
const sameHashes = (a, b) => b && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, hash]) => b[key] === hash)

export function snapshot(root, commit) {
  const blobs = commit ? commitFiles(root, commit, ['listing.md', ...artwork.map(([name]) => name)].map(name => `extension/store/${name}`)) : null
  const read = name => blobs ? blobs[`extension/store/${name}`] : readFileSync(storeFile(root, name))
  const tabs = parseListing(read('listing.md').toString('utf8'))
  return { fields: listingHashes(tabs), images: Object.fromEntries(artwork.map(([name]) => [name, sha256(read(name))])) }
}

export async function validateImages(root) {
  return Promise.all(artwork.map(async ([file, width, height]) => {
    const path = storeFile(root, file)
    if (!existsSync(path)) throw new Error(`Missing ${file}; run pnpm run store:art`)
    const bytes = readFileSync(path), info = await sharp(bytes).metadata()
    if (info.format !== 'png' || info.width !== width || info.height !== height || info.pages > 1) throw new Error(`${file} must be a single PNG at ${width} x ${height}`)
    // Decode pixels too, so a truncated file with an intact header cannot pass.
    await sharp(bytes).raw().toBuffer()
    return { file, path, bytes: bytes.length, sha256: sha256(bytes), width, height }
  }))
}

export function validatePackage(root) {
  const version = versionOf(root), file = `obpal-link-${version}-store.zip`, path = join(root, 'extension/release', file)
  const rebuild = 'run pnpm run store:extension'
  if (!existsSync(path)) throw new Error(`Missing ${file}; ${rebuild}`)
  const bytes = readFileSync(path), entries = unzip(bytes)
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error('Store zip has duplicate entries')
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json')?.data.toString('utf8') ?? 'null')
  if (!manifest || manifest.version !== version) throw new Error(`Store zip manifest version must equal ${version}; ${rebuild}`)
  if ('key' in manifest || entries.some(entry => /\.pem$/i.test(entry.name))) throw new Error(`Store zip contains a key; ${rebuild}`)
  const receiptPath = join(root, 'extension/release/store-package.json')
  if (!existsSync(receiptPath)) throw new Error(`Store zip has no source receipt and may be stale; ${rebuild}`)
  const receipt = readJson(receiptPath), hash = sha256(bytes)
  if (receipt.sourceSha256 !== inputHash(root) || receipt.zipSha256 !== hash || receipt.version !== version) throw new Error(`Store zip is stale or changed since its build; ${rebuild}`)
  return { file, path, bytes: bytes.length, sha256: hash, sourceSha256: receipt.sourceSha256, manifest }
}

/**
 * Checks tracked truth without requiring an ignored release zip to exist on a fresh checkout. A version in development
 * (inDevelopment) passes without its art receipt and listing, and the result says `development`; `strict` holds it to
 * them anyway, as the kit and recording a submission do.
 */
export async function checkStore(root, { preparing = false, validateCurrent = true, strict = false } = {}) {
  const ledger = readJson(storeFile(root, 'submissions.json')), status = readJson(storeFile(root, 'status.json'))
  if (ledger.schema !== 1 || status.schema !== 1 || !Array.isArray(ledger.entries)) throw new Error('Invalid store ledger or status schema')
  let previousDate = ''
  for (const entry of ledger.entries) {
    if (!/^\d+\.\d+\.\d+$/.test(entry.version) || !/^[a-f0-9]{40}$/.test(entry.commit) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.submittedAt) || entry.submittedAt < previousDate) throw new Error('Invalid ledger entry or submission order')
    previousDate = entry.submittedAt
    if (JSON.parse(git(root, ['show', `${entry.commit}:extension/package.json`])).version !== entry.version) throw new Error('Submission version contradicts its commit')
    if (!['submitted', 'published', 'rejected'].includes(entry.state)) throw new Error('Invalid ledger outcome')
    if (entry.state !== 'submitted' && (!/^\d{4}-\d{2}-\d{2}$/.test(entry.outcomeAt) || (entry.state === 'rejected' && !safeReason(entry.reason)))) throw new Error('Invalid ledger outcome date or reason')
    const expected = snapshot(root, entry.commit)
    if (!sameHashes(expected.fields, entry.fields) || !sameHashes(expected.images, entry.images)) throw new Error(`Ledger hashes contradict files at ${entry.commit.slice(0, 7)}`)
    if (entry.sourceSha256 !== inputHash(root, undefined, entry.commit)) throw new Error('Ledger source hash contradicts its commit')
    if (!/^[a-f0-9]{64}$/.test(entry.zipSha256 ?? '') && !(entry.historical && entry.zipSha256 === null && entry.zipNote === 'Original submitted archive unavailable')) throw new Error('Missing submission zip hash')
  }
  if (ledger.entries.filter(entry => entry.state === 'submitted').length > 1) throw new Error('Multiple pending submissions')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(status.updated)) throw new Error('Invalid status date')
  for (const [name, state] of [['published', 'published'], ['pending', 'submitted']]) {
    const expected = ledger.entries.findLast(entry => entry.state === state)?.version ?? null
    if (status[name] !== expected) throw new Error(`Store status ${name} contradicts ledger`)
  }
  if (preparing) {
    const latest = lastSubmitted(ledger)
    status.prepared = latest?.version === versionOf(root) && latest.state !== 'rejected' ? null : versionOf(root)
  } else if (validateCurrent && status.prepared !== null && status.prepared !== versionOf(root)) throw new Error('Prepared version contradicts extension/package.json; run pnpm run store -- kit')
  if (!validateCurrent) {
    const images = artwork.map(([file]) => {
      const path = storeFile(root, file)
      if (!existsSync(path)) return { file, path, bytes: 0, sha256: null, missing: true }
      const bytes = readFileSync(path)
      return { file, path, bytes: bytes.length, sha256: sha256(bytes) }
    })
    return { ledger, status, images }
  }
  const images = await validateImages(root)
  if (!strict && inDevelopment(ledger, status, versionOf(root))) return { ledger, status, images, development: true }
  const current = snapshot(root)
  const art = readJson(storeFile(root, 'art.json'))
  if (art.sourceSha256 !== inputHash(root, artPath) || !sameHashes(current.images, art.images)) throw new Error('Store art receipt is stale or changed without rebuilt art; run pnpm run store:art')
  const config = readFileSync(join(root, 'extension/vite.config.ts'), 'utf8')
  const fields = parseListing(readFileSync(storeFile(root, 'listing.md'), 'utf8')).flatMap(tab => tab.fields)
  for (const name of ['Name', 'Summary']) {
    const field = fields.find(field => field.name === name)
    const property = name === 'Name' ? 'name' : 'description'
    const match = new RegExp(`\\n  ${property}: '([^']*)'`).exec(config)
    if (!field || field.text !== match?.[1]) throw new Error(`Listing ${name} contradicts extension manifest`)
  }
  return { ledger, status, images, development: false }
}

export const storeLags = (published, release) => {
  const a = (published ?? '0.0.0').split('.').map(Number), b = (release ?? '').replace(/^v/, '').split('.').map(Number)
  if (b.length !== 3 || b.some(n => !Number.isInteger(n))) return false
  for (let i = 0; i < 3; i++) if (b[i] !== a[i]) return b[i] > a[i]
  return false
}
export const pendingWarning = (root, release) => storeLags(readJson(storeFile(root, 'status.json')).published, release) ? 'store update pending: run pnpm run store -- kit' : ''

export async function latestGithubRelease() {
  const response = await fetch('https://api.github.com/repos/Axialon/obpal-link/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'obpal-store' }, signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`GitHub release unavailable (HTTP ${response.status})`)
  return (await response.json()).tag_name
}

export async function storeStatus(root, release, options) {
  const { ledger, status, images } = await checkStore(root, { validateCurrent: false, ...options }), baseline = lastSubmitted(ledger)
  const before = baseline ? parseListing(atCommit(root, baseline.commit, 'listing.md').toString('utf8')) : []
  const tabs = compareFields(parseListing(readFileSync(storeFile(root, 'listing.md'), 'utf8')), before)
  let packageInfo, packageError
  try { packageInfo = validatePackage(root) } catch (error) { packageError = error.message }
  return { version: versionOf(root), development: inDevelopment(ledger, status, versionOf(root)), ledger, status, baseline, tabs, images: images.map(image => ({ ...image, changed: baseline?.images[image.file] !== image.sha256 })), packageInfo, packageError, release }
}

export function formatStatus(info) {
  const { status, baseline } = info
  return [`Link ${info.version}${info.development ? ' (in development)' : ''}: published ${status.published ?? 'none'}; pending review ${status.pending ?? 'none'}; prepared ${status.prepared ?? 'none'}`,
    `Baseline: last submission ${baseline?.version ?? 'none'} (${baseline?.commit.slice(0, 7) ?? 'none'})`,
    ...(info.development ? ['In development: newer than the last submission, so store check leaves its art and zip receipts alone; pnpm run store -- kit validates them and marks it prepared, and they are enforced from then on'] : []),
    ...info.tabs.flatMap(tab => tab.fields.map(field => `${field.changed ? 'CHANGED' : 'unchanged'} field: ${fieldKey(tab, field)}`)),
    ...info.images.map(image => `${image.changed ? 'CHANGED' : 'unchanged'} image: ${image.file}${image.missing ? ' (missing; run pnpm run store:art)' : ''}`),
    `Store zip: ${info.packageError ?? 'matches current extension source'}`,
    info.release ? `GitHub ${info.release}: ${storeLags(status.published, info.release) ? 'ahead of store' : 'store is current'}` : 'GitHub release: unavailable',
  ].join('\n')
}

const safeReason = reason => typeof reason === 'string' && /^[A-Za-z0-9 .,;:!?()'\-]{1,500}$/.test(reason) && !/@|https?:|[\\/]|\b(email|owner|account|publisher|name)\b/i.test(reason)
export async function recordSubmission(root, command, version, reason, now = new Date()) {
  // A submission is held to its art and listing even when the version was never prepared; an outcome is not, so
  // recording one needs nothing of a newer version in development.
  const { ledger, status } = await checkStore(root, { strict: command === 'submitted' }), date = now.toISOString().slice(0, 10)
  if (command === 'submitted') {
    if (version !== versionOf(root)) throw new Error('Submit the current extension version')
    if (status.pending || ledger.entries.some(entry => entry.version === version && entry.state !== 'rejected')) throw new Error('A submission is pending or this version is already recorded')
    if (git(root, ['status', '--porcelain', '--untracked-files=no']).trim()) throw new Error('Commit tracked changes before recording submission')
    const pack = validatePackage(root), commit = git(root, ['rev-parse', 'HEAD']).trim()
    if (pack.sourceSha256 !== inputHash(root, undefined, commit)) throw new Error('Commit all extension build inputs before recording submission')
    ledger.entries.push({ version, submittedAt: date, commit, state: 'submitted', zipSha256: pack.sha256, sourceSha256: pack.sourceSha256, ...snapshot(root) })
    status.pending = version; status.prepared = null
  } else {
    const entry = ledger.entries.findLast(entry => entry.version === version && entry.state === 'submitted')
    if (!entry || status.pending !== version) throw new Error('No pending submission for this version')
    if (command === 'rejected' && !safeReason(reason)) throw new Error('Use a short generic rejection reason without names, emails, links or paths')
    if (!['published', 'rejected'].includes(command)) throw new Error('Unknown outcome')
    entry.state = command; entry.outcomeAt = date
    if (command === 'rejected') entry.reason = reason
    if (command === 'published') status.published = version
    status.pending = null
  }
  status.updated = date
  writeJson(storeFile(root, 'submissions.json'), ledger)
  writeJson(storeFile(root, 'status.json'), status)
}
