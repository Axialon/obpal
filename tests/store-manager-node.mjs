/** Store command proof uses temporary repositories and never records real submissions. */
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { artwork, checkStore, formatStatus, lastSubmitted, pendingWarning, readJson, recordSubmission, snapshot, storeLags, storeStatus, validateImages, validatePackage, writeJson } from '../extension/scripts/store-manager.mjs'
import { artPath, directoryHashes, git, inputHash, sha256, validateBuild } from '../extension/scripts/store-source.mjs'
import { renderStoreKit, writeStoreKit } from '../extension/scripts/store-kit.mjs'
import { checkStoreCopy } from '../extension/scripts/store-copy.mjs'
import { validateLiveLinks } from '../extension/scripts/store-links.mjs'
import { kitHandler } from '../extension/scripts/store-cli.mjs'
import { zip } from '../extension/scripts/zip.mjs'

const fixtureOptions = { checkLinks: async () => [{ label: 'Fixture', url: 'https://example.test/', status: 200 }], checkCopy: () => [] }
const repo = fileURLToPath(new URL('..', import.meta.url))
const store = (root, file) => join(root, 'extension/store', file)
const commit = root => {
  git(root, ['add', '.'])
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic fixture'])
  return git(root, ['rev-parse', 'HEAD']).trim()
}
const artReceipt = root => writeJson(store(root, 'art.json'), { sourceSha256: inputHash(root, artPath), images: snapshot(root).images })
const pack = async (root, manifest = { version: '1.8.0', manifest_version: 3 }) => {
  const bytes = await zip([], root, { 'manifest.json': JSON.stringify(manifest), 'popup.html': '<p>Fixture</p>' })
  writeFileSync(join(root, 'extension/release/obpal-link-1.8.0-store.zip'), bytes)
  writeJson(join(root, 'extension/release/store-package.json'), { version: '1.8.0', sourceSha256: inputHash(root), zipSha256: sha256(bytes) })
}
const fixture = async action => {
  const root = mkdtempSync(join(tmpdir(), 'obpal-store-test-'))
  try {
    mkdirSync(store(root, 'src'), { recursive: true }); mkdirSync(join(root, 'extension/release')); mkdirSync(join(root, 'extension/src'))
    writeFileSync(join(root, '.gitignore'), 'extension/release/\nextension/dist/\n')
    writeFileSync(join(root, 'extension/src/popup.ts'), 'export const value = 1\n')
    writeJson(join(root, 'extension/package.json'), { version: '1.6.2' })
    writeFileSync(join(root, 'extension/vite.config.ts'), "\n  name: 'ob.Pal Link',\n  description: 'Fixture summary',\n")
    writeFileSync(store(root, 'src/look.css'), 'body{color:white}')
    writeFileSync(store(root, 'listing.md'), '## Store listing tab\n- Name: `ob.Pal Link`\n- Summary: `Fixture summary`\n**Description:**\n```text\nBefore\n```\n')
    for (const [file] of artwork) copyFileSync(store(repo, file), store(root, file))
    git(root, ['init', '-b', 'master']); const before = commit(root)
    writeJson(store(root, 'submissions.json'), { schema: 1, entries: [{ version: '1.6.2', submittedAt: '2026-10-01', commit: before, state: 'published', outcomeAt: '2026-10-02', historical: true, zipSha256: null, zipNote: 'Original submitted archive unavailable', sourceSha256: inputHash(root, undefined, before), ...snapshot(root, before) }] })
    writeJson(join(root, 'extension/package.json'), { version: '1.8.0' })
    writeFileSync(store(root, 'listing.md'), readFileSync(store(root, 'listing.md'), 'utf8').replace('Before', 'After'))
    writeJson(store(root, 'status.json'), { schema: 1, published: '1.6.2', pending: null, prepared: '1.8.0', updated: '2026-10-02' })
    artReceipt(root); commit(root); await pack(root)
    await action(root)
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
}

export const cases = [
  { name: 'live links reject non-200 results and unavailable destinations', async run() {
    assert.equal((await validateLiveLinks([['Fixture', 'https://example.test/']], async () => ({ status: 200 })))[0].status, 200)
    await assert.rejects(validateLiveLinks([['Fixture', 'https://example.test/']], async () => ({ status: 404 })), /HTTP 404/)
    await assert.rejects(validateLiveLinks([['Fixture', 'https://example.test/']], async () => { throw new Error('offline') }), /unavailable/)
  } },
  { name: 'store copy checks browser claims, modes, Windows PC and every permission', run() {
    assert.match(checkStoreCopy(repo).join('\n'), /8\/8/)
    const root = mkdtempSync(join(tmpdir(), 'obpal-copy-test-'))
    try {
      for (const file of ['extension/package.json', 'extension/vite.config.ts', 'extension/store/listing.md', 'extension/store/src/scenes.mjs', 'link/index.html']) {
        mkdirSync(join(root, file, '..'), { recursive: true }); copyFileSync(join(repo, file), join(root, file))
      }
      const path = join(root, 'extension/vite.config.ts'), source = readFileSync(path, 'utf8')
      writeFileSync(path, source.replace("'scripting']", "'scripting', 'tabs']"))
      assert.throws(() => checkStoreCopy(root), /Permission without justification: tabs/)
      writeFileSync(path, source)
      writeFileSync(join(root, 'link/index.html'), readFileSync(join(root, 'link/index.html'), 'utf8').replace('Chromium 120 or later', 'Chromium 90 or later'))
      assert.throws(() => checkStoreCopy(root), /Browser minimum/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  } },
  { name: 'tracked store truth agrees on a checkout with no generated zip', run: () => checkStore(repo) },
  { name: 'baseline selects the last submitted record including rejected updates', run() {
    const a = { version: '1.6.2', submittedAt: '2026-10-01', state: 'published' }, b = { version: '1.8.0', submittedAt: '2026-10-02', state: 'rejected' }
    assert.equal(lastSubmitted({ entries: [a, b, { version: '1.9.0', state: 'prepared' }] }), b)
    assert.equal(lastSubmitted({ entries: [] }), undefined)
  } },
  { name: 'kit shows absolute copy paths, sizes and hashes with portable previews', run: () => fixture(async root => {
    const { html, changedFields, changedImages } = await renderStoreKit(root, fixtureOptions)
    assert.equal(changedFields, 1); assert.equal(changedImages, 0)
    assert(html.includes(root)); assert.match(html, /Copy path/); assert.match(html, /1280 x 800 px/); assert.match(html, /SHA-256/)
    assert.match(html, /Item ID:.*jnnpcnoilofjaffabnhecfokjjknlemg/)
    assert.match(html, /Generated and links checked at/)
    assert.equal([...html.matchAll(/<a download /g)].length, 9)
    const images = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(match => match[1])
    assert.equal(images.length, 8); images.forEach(path => assert.match(path, /^\.\.\/store\/[^/]+\.png$/))
    assert(!existsSync(join(root, 'extension/release/store-kit.html')))
    assert.match(formatStatus(await storeStatus(root, 'v1.8.0')), /GitHub v1.8.0: ahead of store/)
  }) },
  { name: 'zip detects same-version source changes and archive replacements', run: () => fixture(async root => {
    validatePackage(root)
    writeFileSync(join(root, 'extension/src/popup.ts'), 'export const value = 2\n')
    assert.throws(() => validatePackage(root), /stale.*store:extension/)
    rmSync(join(root, 'extension/src/popup.ts'))
    assert.throws(() => validatePackage(root), /stale.*store:extension/)
    await pack(root); validatePackage(root)
    writeFileSync(join(root, 'extension/release/obpal-link-1.8.0-store.zip'), await zip([], root, { 'manifest.json': '{"version":"1.8.0"}' }))
    assert.throws(() => validatePackage(root), /stale/)
  }) },
  { name: 'build receipt refuses stale dist before it can be repackaged', run: () => fixture(async root => {
    mkdirSync(join(root, 'extension/dist')); writeFileSync(join(root, 'extension/dist/manifest.json'), '{}')
    assert.throws(() => validateBuild(root), /no source receipt/)
    writeJson(join(root, 'extension/release/build-source.json'), { sourceSha256: inputHash(root), files: directoryHashes(join(root, 'extension/dist')) })
    validateBuild(root)
    writeFileSync(join(root, 'extension/dist/manifest.json'), '{"changed":true}')
    assert.throws(() => validateBuild(root), /stale or changed/)
  }) },
  { name: 'zip validation refuses wrong versions, keys, missing receipts and missing files', run: () => fixture(async root => {
    await pack(root, { version: '1.7.0' }); assert.throws(() => validatePackage(root), /manifest version/)
    await pack(root, { version: '1.8.0', key: 'fixture' }); assert.throws(() => validatePackage(root), /contains a key/)
    await pack(root); rmSync(join(root, 'extension/release/store-package.json')); assert.throws(() => validatePackage(root), /no source receipt/)
    rmSync(join(root, 'extension/release/obpal-link-1.8.0-store.zip')); assert.throws(() => validatePackage(root), /Missing/)
  }) },
  { name: 'image validation refuses wrong dimensions, formats and missing files', run: () => fixture(async root => {
    await sharp({ create: { width: 127, height: 128, channels: 3, background: '#fff' } }).png().toFile(store(root, 'icon-128.png'))
    await assert.rejects(validateImages(root), /128 x 128/)
    await sharp({ create: { width: 128, height: 128, channels: 3, background: '#fff' } }).jpeg().toFile(store(root, 'icon-128.png'))
    await assert.rejects(validateImages(root), /PNG/)
    rmSync(store(root, 'icon-128.png')); await assert.rejects(validateImages(root), /Missing/)
    const status = await storeStatus(root)
    assert.equal(status.images[0].changed, true); assert.equal(status.images[0].missing, true)
    assert.match(formatStatus(status), /CHANGED image: icon-128.png \(missing/)
    await assert.rejects(renderStoreKit(root, fixtureOptions), /Missing/)
  }) },
  { name: 'check refuses ledger tampering, contradictory status, listing drift and unrebuilt art', run: () => fixture(async root => {
    const ledger = readJson(store(root, 'submissions.json')), status = readJson(store(root, 'status.json'))
    ledger.entries[0].images['icon-128.png'] = 'bad'; writeJson(store(root, 'submissions.json'), ledger)
    await assert.rejects(checkStore(root), /Ledger hashes/)
    ledger.entries[0].images = Object.fromEntries(Object.entries(snapshot(root, ledger.entries[0].commit).images).reverse()); writeJson(store(root, 'submissions.json'), ledger)
    await checkStore(root)
    writeJson(store(root, 'status.json'), { ...status, pending: '1.8.0' }); await assert.rejects(checkStore(root), /contradicts ledger/)
    writeJson(store(root, 'status.json'), status)
    writeFileSync(store(root, 'src/look.css'), 'body{color:red}'); await assert.rejects(checkStore(root), /art receipt is stale/)
    artReceipt(root)
    writeFileSync(store(root, 'listing.md'), readFileSync(store(root, 'listing.md'), 'utf8').replace('Fixture summary', 'Different summary'))
    await assert.rejects(checkStore(root), /Summary contradicts/)
  }) },
  { name: 'submission records exact hashes, advances baseline, and publication updates structured status', run: () => fixture(async root => {
    const hash = validatePackage(root).sha256, head = git(root, ['rev-parse', 'HEAD']).trim()
    await recordSubmission(root, 'submitted', '1.8.0')
    const info = await storeStatus(root, 'v1.8.0')
    assert.equal(info.baseline.version, '1.8.0'); assert.equal(info.baseline.commit, head); assert.equal(info.baseline.zipSha256, hash)
    assert(info.tabs.flatMap(tab => tab.fields).every(field => !field.changed))
    assert.equal(info.status.pending, '1.8.0'); assert.equal(info.status.prepared, null)
    const pendingKit = await renderStoreKit(root, fixtureOptions)
    assert.match(pendingKit.html, /Compared with last submission 1.8.0/)
    assert.match(pendingKit.html, /1.8.0 since published 1.6.2/)
    await assert.rejects(recordSubmission(root, 'submitted', '1.8.0'), /pending/)
    await recordSubmission(root, 'published', '1.8.0'); await checkStore(root)
    assert.equal(readJson(store(root, 'status.json')).published, '1.8.0')
    assert.equal(pendingWarning(root, 'v1.8.0'), '')
  }) },
  { name: 'rejection records generic reason and preserves last submission as baseline', run: () => fixture(async root => {
    await assert.rejects(recordSubmission(root, 'published', '1.8.0'), /No pending/)
    await recordSubmission(root, 'submitted', '1.8.0')
    await assert.rejects(recordSubmission(root, 'rejected', '1.8.0', 'contact@' + 'example.test'), /generic rejection reason/)
    await recordSubmission(root, 'rejected', '1.8.0', 'Permission justification needs clarification')
    const info = await storeStatus(root)
    assert.equal(info.status.pending, null); assert.equal(info.status.published, '1.6.2'); assert.equal(info.baseline.state, 'rejected')
    commit(root); await recordSubmission(root, 'submitted', '1.8.0'); await checkStore(root)
    assert.equal(readJson(store(root, 'submissions.json')).entries.length, 3)
  }) },
  { name: 'dirty submissions fail without changing tracked ledger', run: () => fixture(async root => {
    const before = readFileSync(store(root, 'submissions.json'), 'utf8')
    writeFileSync(store(root, 'listing.md'), readFileSync(store(root, 'listing.md'), 'utf8') + '\nChanged prose\n')
    await assert.rejects(recordSubmission(root, 'submitted', '1.8.0'), /Commit tracked changes/)
    assert.equal(readFileSync(store(root, 'submissions.json'), 'utf8'), before)
  }) },
  { name: 'untracked build inputs cannot be attributed to an earlier commit', run: () => fixture(async root => {
    const before = readFileSync(store(root, 'submissions.json'), 'utf8')
    writeFileSync(join(root, 'extension/src/new.ts'), 'export const input = 1\n')
    artReceipt(root); commit(root)
    writeFileSync(join(root, 'extension/src/untracked.ts'), 'export const extra = 1\n')
    // Art inputs remain certified, but the submitted source must also exist at HEAD.
    artReceipt(root)
    // Commit only the receipt, leaving the new input untracked.
    git(root, ['add', 'extension/store/art.json'])
    git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic receipt'])
    await pack(root)
    await assert.rejects(recordSubmission(root, 'submitted', '1.8.0'), /Commit all extension build inputs/)
    assert.equal(readFileSync(store(root, 'submissions.json'), 'utf8'), before)
  }) },
  { name: 'kit prepares the next version only after validation succeeds', run: () => fixture(async root => {
    const status = readJson(store(root, 'status.json'))
    writeJson(store(root, 'status.json'), { ...status, prepared: '1.7.0' })
    await assert.rejects(checkStore(root), /Prepared version contradicts/)
    await writeStoreKit(root, fixtureOptions)
    assert.equal(readJson(store(root, 'status.json')).prepared, '1.8.0')
    await checkStore(root)
  }) },
  { name: 'failed regeneration removes an old kit and serves useful errors instead of stale HTML', run: () => fixture(async root => {
    await writeStoreKit(root, fixtureOptions)
    const handle = kitHandler(root, fixtureOptions)
    const request = async (url, method = 'GET') => {
      const result = { headers: {}, status: 0, body: undefined }
      await handle({ url, method }, { setHeader: (name, value) => { result.headers[name] = value }, writeHead: (status, headers) => { result.status = status; Object.assign(result.headers, headers) }, end: body => { result.body = body } })
      return result
    }
    const path = '/extension/release/store-kit.html'
    const first = await request(path); assert.equal(first.status, 200); assert.equal(first.headers['Cache-Control'], 'no-store')
    assert.equal((await request('/')).status, 302)
    assert.equal((await request(path, 'POST')).status, 405)
    assert.equal((await request(path, 'HEAD')).body, undefined)
    assert.equal((await request('/extension/store/icon-128.png')).status, 200)
    const zipResponse = await request('/extension/release/obpal-link-1.8.0-store.zip')
    assert.equal(zipResponse.status, 200); assert.equal(zipResponse.headers['Content-Type'], 'application/zip')
    assert.equal(sha256(zipResponse.body), validatePackage(root).sha256)
    assert.equal((await request('/extension/release/store-package.json')).status, 404)
    assert.equal((await request('/extension/store/status.json')).status, 404)
    writeFileSync(store(root, 'listing.md'), readFileSync(store(root, 'listing.md'), 'utf8').replace('After', 'Fresh request'))
    assert((await request(path)).body.includes('Fresh request'))
    writeFileSync(join(root, 'extension/src/popup.ts'), 'export const value = 4\n'); artReceipt(root)
    const bad = await request(path); assert.equal(bad.status, 409); assert.match(bad.body, /stale.*store:extension/)
    await assert.rejects(writeStoreKit(root, fixtureOptions), /stale/)
    assert.equal(existsSync(join(root, 'extension/release/store-kit.html')), false)
  }) },
  { name: 'release warning compares numeric versions and never fails for unavailable release data', run() {
    assert(storeLags('1.8.0', 'v1.10.0')); assert(!storeLags('1.10.0', 'v1.8.0')); assert(!storeLags('1.8.0', null))
    assert.equal(pendingWarning(repo, 'v1.8.0'), 'store update pending: run pnpm run store -- kit')
  } },
]
