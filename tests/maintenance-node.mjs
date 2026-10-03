/** Synthetic maintenance fixtures; no real worktrees, remotes or backups are modified. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync, openSync, closeSync, ftruncateSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, toNamespacedPath } from 'node:path'
import { tmpdir } from 'node:os'
import { allowedHistoricalFile, HISTORICAL_TEST_TLS, guardRemote, guardTracked, retentionSelection, selfTest, verifyManifest } from '../scripts/backup.mjs'
import { archiveEvidence, pruneRuns, verifyEvidence } from '../scripts/lib/evidence-archive.mjs'
import { differentDrive, floorExit, git, hashFile, lockedFiles, entries, secretPath } from '../scripts/lib/maintenance.mjs'
import { reap, reapSelection, removeTempTree, saveDirty, verifyDirtySource } from '../scripts/reap.mjs'
import { removeLaneTree } from '../scripts/lanes/lib.mjs'
import { tempScope } from '../scripts/lib/temp.mjs'

const withFixture = async action => {
  const root = mkdtempSync(join(tmpdir(), 'obpal-maintenance-test-'))
  try { return await action(root) } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
}
const init = root => {
  mkdirSync(root, { recursive: true }); git(root, ['init', '-b', 'master'])
  writeFileSync(join(root, 'file.txt'), 'before\n'); commit(root)
}
const commit = root => {
  git(root, ['add', '-A'])
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic fixture'])
}
export const cases = [
  { name: 'retains seven days and the newest in eight weekly bands, protecting keep and unverified backups', run() {
    const now = Date.parse('2026-10-01T12:00:00Z'), day = 86400_000
    const item = (id, age, extras = {}) => ({ id, at: new Date(now - age * day).toISOString(), verified: true, ...extras })
    const candidates = [item('today', 0), item('day6', 6), item('week0', 7), item('week0older', 8), item('week1', 14), item('week7', 56), item('expired', 63), item('keep', 99, { keep: true }), item('unverified', 99, { verified: false })]
    assert.deepEqual(retentionSelection(candidates, now).map(i => i.id).sort(), ['expired', 'week0older'])
  } },
  { name: 'refuses every secret filename pattern and the same drive', run() {
    for (const path of ['.env', 'a/.env.production', 'x.PEM', 'x.p12', 'x.pfx', 'id_rsa', '.npmrc', 'credentials.json', 'folder/keys/x', '.obpal-keys/x', '.blackboxes-keys/x']) assert.equal(secretPath(path), true, path)
    assert.equal(secretPath('keyframes/example.txt'), false)
    const drive = (letter, name) => [letter + ':', name].join('\\')
    assert.throws(() => differentDrive(drive('C', 'repo'), drive('c', 'backup')), { exitCode: 2 })
    differentDrive(drive('C', 'repo'), drive('D', 'backup'))
  } },
  { name: 'refuses absent, mismatched and additional push remotes; accepts configured SSH and HTTPS', run: () => withFixture(root => {
    init(root)
    assert.throws(() => guardRemote(root, 'fixture/private'), { exitCode: 2 })
    git(root, ['remote', 'add', 'backup', 'https://github.com/fixture/private.git']); guardRemote(root, 'fixture/private')
    git(root, ['remote', 'set-url', '--push', 'backup', 'git@github.com:fixture/public.git'])
    assert.throws(() => guardRemote(root, 'fixture/private'), { exitCode: 2 })
    git(root, ['remote', 'set-url', '--push', 'backup', 'git@github.com:fixture/private.git']); guardRemote(root, 'fixture/private')
    git(root, ['remote', 'set-url', '--add', '--push', 'backup', 'https://github.com/fixture/public'])
    assert.throws(() => guardRemote(root, 'fixture/private'), { exitCode: 2 })
  }) },
  { name: 'refuses an absent backup remote without git printing an error to the console', run: () => withFixture(root => {
    init(root)
    // Git writes straight to the process's own stderr, so a child shows what a `pnpm run ship` log would.
    const module = new URL('../scripts/backup.mjs', import.meta.url).href
    const script = `import { guardRemote } from ${JSON.stringify(module)}\ntry { guardRemote(${JSON.stringify(root)}, 'fixture/private') } catch (error) { console.log(error.exitCode, error.message) }`
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })
    assert.equal(run.stdout.trim(), '2 The backup remote is missing')
    assert.equal(run.stderr, '')
  }) },
  { name: 'checks historical secret files even after they are deleted', run: () => withFixture(root => {
    init(root); guardTracked(root)
    writeFileSync(join(root, '.env'), readFileSync(join(root, 'file.txt'))); commit(root)
    rmSync(join(root, '.env')); commit(root)
    assert.throws(() => guardTracked(root), { exitCode: 2 })
  }) },
  { name: 'refuses reachable tracked blobs over 90 MB', run: () => withFixture(root => {
    init(root); const fd = openSync(join(root, 'large.bin'), 'w')
    try { ftruncateSync(fd, 91 * 1024 ** 2) } finally { closeSync(fd) }
    commit(root); assert.throws(() => guardTracked(root), { exitCode: 2 })
  }) },
  { name: 'allows only the two exact historical TLS path and blob pairs', run: () => withFixture(root => {
    for (const [path, blob] of Object.entries(HISTORICAL_TEST_TLS)) {
      assert.equal(allowedHistoricalFile(path, blob), true)
      assert.equal(allowedHistoricalFile('different/' + path, blob), false)
      assert.equal(allowedHistoricalFile(path, 'a'.repeat(40)), false)
    }
    init(root); mkdirSync(join(root, 'extension/e2e/tls'), { recursive: true })
    const file = join(root, 'extension/e2e/tls/key.pem'); writeFileSync(file, 'different synthetic blob'); commit(root)
    rmSync(file); commit(root); assert.throws(() => guardTracked(root), { exitCode: 2 })
  }) },
  { name: 'archives and verifies evidence before removing the worktree', run: () => withFixture(root => {
    const base = join(root, 'worktrees'), lane = join(base, 'codex-proof'), runs = join(root, 'synthetic-runs')
    mkdirSync(join(lane, 'artifacts/before'), { recursive: true }); writeFileSync(join(lane, 'artifacts/before/audio.bin'), Buffer.from([0, 1, 2]))
    let archived
    removeLaneTree(base, lane, { preserve(worktree) {
      assert.equal(existsSync(worktree), true)
      archived = archiveEvidence(worktree, runs)
      verifyEvidence(archived, JSON.parse(readFileSync(join(archived, 'manifest.json'), 'utf8')))
      assert.equal(existsSync(worktree), true)
    } })
    assert.equal(existsSync(lane), false)
    assert.deepEqual(readFileSync(join(archived, 'artifacts/before/audio.bin')), Buffer.from([0, 1, 2]))
  }) },
  { name: 'copy failure and corrupted copies both block worktree removal', run: () => withFixture(root => {
    const base = join(root, 'worktrees'), lane = join(base, 'astra-proof')
    mkdirSync(join(lane, 'artifacts'), { recursive: true }); writeFileSync(join(lane, 'artifacts/proof.txt'), 'preserve')
    assert.throws(() => removeLaneTree(base, lane, { preserve: worktree => archiveEvidence(worktree, join(root, 'failed'), { copy() { throw new Error('synthetic copy failure') } }) }), /copy failure/)
    assert.equal(existsSync(join(lane, 'artifacts/proof.txt')), true)
    assert.throws(() => removeLaneTree(base, lane, { preserve: worktree => archiveEvidence(worktree, join(root, 'corrupt'), { copy(_source, destination) { writeFileSync(destination, 'corrupt') } }) }), /changed during copy/)
    assert.equal(existsSync(lane), true)
  }) },
  { name: 'explicit discard skips archiving, and empty evidence removes without an archive drive', run: () => withFixture(root => {
    const base = join(root, 'worktrees'), lane = join(base, 'codex-discard'), empty = join(base, 'codex-empty')
    mkdirSync(join(lane, 'artifacts'), { recursive: true }); writeFileSync(join(lane, 'artifacts/proof.txt'), 'discard')
    removeLaneTree(base, lane, { discardArtifacts: true, maintenance: { runsRoot: root } }); assert.equal(existsSync(lane), false)
    mkdirSync(join(empty, 'artifacts'), { recursive: true }); removeLaneTree(base, empty, { maintenance: { runsRoot: root } }); assert.equal(existsSync(empty), false)
  }) },
  { name: 'evidence retention keeps sixty days, permanent keep markers and incomplete archives', run: () => withFixture(root => {
    const lane = join(root, 'codex-retention'), runs = join(root, 'runs'), now = Date.parse('2026-10-01T12:00:00Z')
    mkdirSync(join(lane, 'artifacts'), { recursive: true }); writeFileSync(join(lane, 'artifacts/proof.txt'), 'retain')
    const archive = age => archiveEvidence(lane, runs, { now: new Date(now - age * 86400_000) })
    const fresh = archive(59), old = archive(61), kept = archive(62); writeFileSync(join(kept, 'keep'), '')
    const incomplete = join(runs, 'retention', '2026-01-01-0000'); mkdirSync(incomplete)
    assert.deepEqual(pruneRuns(runs, { now, dryRun: true }), [old]); assert.equal(existsSync(old), true)
    pruneRuns(runs, { now }); assert.equal(existsSync(old), false)
    for (const folder of [fresh, kept, incomplete]) assert.equal(existsSync(folder), true)
  }) },
  { name: 'merges configured and command-line keep lists without dropping branches', run: () => withFixture(async root => {
    const repo = join(root, 'repo'), base = join(repo, '.claude/worktrees'), temp = join(root, 'temp'); init(repo); mkdirSync(temp)
    for (const name of ['configured', 'cli', 'remove']) git(repo, ['worktree', 'add', '-b', `codex/${name}`, join(base, `codex-${name}`), 'master'])
    const result = await reap({ root: repo, backupRoot: join(root, 'backup'), tempRoot: temp, freeSpaceRoot: root, ensureFreeGb: 0, keep: ['codex-configured'] }, { keep: ['codex-cli'] })
    assert.deepEqual(result.selected.map(item => item.name), ['codex-remove'])
    assert.equal(existsSync(join(base, 'codex-configured')), true); assert.equal(existsSync(join(base, 'codex-cli')), true)
    assert.match(git(repo, ['branch', '--list', 'codex/remove']), /codex\/remove/)
  }) },
  { name: 'verifies manifest bytes and detects corruption and escaped paths', run: () => withFixture(async root => {
    const file = join(root, 'saved.txt'); writeFileSync(file, 'saved')
    const manifest = { files: [{ path: 'saved.txt', sha256: await hashFile(file) }] }
    assert.equal(await verifyManifest(root, manifest), 1)
    writeFileSync(file, 'corrupt'); await assert.rejects(verifyManifest(root, manifest), /Manifest mismatch/)
    await assert.rejects(verifyManifest(root, { files: [{ path: '../outside', sha256: '' }] }), /container/)
  }) },
  { name: 'clones a verified bundle with identical HEAD', run: () => assert.equal(selfTest(), true) },
  { name: 'selects merged and final-merged lanes, but never running, kept or current lanes', run() {
    assert.equal(reapSelection({ name: 'codex-clean', merged: true }), true)
    assert.equal(reapSelection({ name: 'codex-dirty', merged: true }), true)
    assert.equal(reapSelection({ name: 'astra-final', lane: { state: 'final', mergedAt: 'now' } }), true)
    assert.equal(reapSelection({ name: 'codex-running', merged: true, lane: { state: 'running' } }), false)
    assert.equal(reapSelection({ name: 'codex-kept', merged: true, keep: ['codex-kept'] }), false)
    assert.equal(reapSelection({ name: 'codex-current', merged: true, current: true }), false)
    assert.equal(reapSelection({ name: 'codex-open', merged: false }), false)
  } },
  { name: 'archives staged and unstaged binary changes and nonignored untracked files', run: () => withFixture(async root => {
    const repo = join(root, 'repo'), saved = join(root, 'recovery'); init(repo)
    writeFileSync(join(repo, 'file.txt'), 'staged\n'); git(repo, ['add', 'file.txt'])
    writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2])); commit(repo)
    writeFileSync(join(repo, 'file.txt'), 'unstaged\n'); writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 3, 4]))
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n'); git(repo, ['add', '.gitignore'])
    mkdirSync(join(repo, 'ignored')); writeFileSync(join(repo, 'ignored/rebuild.txt'), 'discard')
    writeFileSync(join(repo, 'new.txt'), 'preserve')
    const manifest = await saveDirty(repo, saved)
    assert.match(readFileSync(join(saved, 'tracked.diff'), 'utf8'), /GIT binary patch/)
    assert.match(readFileSync(join(saved, 'tracked.diff'), 'utf8'), /unstaged/)
    assert.equal(readFileSync(join(saved, 'untracked/new.txt'), 'utf8'), 'preserve')
    assert.equal(existsSync(join(saved, 'untracked/ignored')), false)
    await verifyManifest(saved, manifest)
    await verifyDirtySource(repo, saved, manifest)
    writeFileSync(join(repo, 'file.txt'), 'another dirty edit\n')
    await assert.rejects(verifyDirtySource(repo, saved, manifest), /Tracked changes moved/)
  }) },
  { name: 'unlinks junctions without touching outside sentinels and handles long paths', run: () => withFixture(root => {
    const base = join(root, 'worktrees'), lane = join(base, 'agent-synthetic'), sentinel = join(root, 'sentinel'); mkdirSync(lane, { recursive: true }); mkdirSync(sentinel)
    writeFileSync(join(sentinel, 'keep.txt'), 'survive'); symlinkSync(sentinel, join(lane, 'junction'), 'junction')
    const long = join(lane, ...Array.from({ length: 12 }, (_, i) => `long-segment-${i}-abcdefghijklmnop`)); mkdirSync(toNamespacedPath(long), { recursive: true }); writeFileSync(toNamespacedPath(join(long, 'file.txt')), 'long')
    removeLaneTree(base, lane)
    assert.equal(existsSync(lane), false); assert.equal(readFileSync(join(sentinel, 'keep.txt'), 'utf8'), 'survive')
    const temp = join(root, 'obpal-link'); symlinkSync(sentinel, temp, 'junction'); removeTempTree(root, temp)
    assert.equal(readFileSync(join(sentinel, 'keep.txt'), 'utf8'), 'survive')
    assert.throws(() => removeLaneTree(base, sentinel))
  }) },
  { name: 'reaps only old synthetic temp folders and reports the free-space floor with exit 3', run: () => withFixture(async root => {
    const repo = join(root, 'repo'), temp = join(root, 'temp'); init(repo); mkdirSync(temp)
    const old = join(temp, 'obpal-old'), young = join(temp, 'obpal-young'); mkdirSync(old); mkdirSync(young)
    writeFileSync(join(old, 'fixture.txt'), 'old'); const at = new Date(Date.now() - 24 * 3600_000); utimesSync(join(old, 'fixture.txt'), at, at); utimesSync(old, at, at)
    const cfg = { root: repo, backupRoot: join(root, 'backup'), tempRoot: temp, freeSpaceRoot: root, ensureFreeGb: 1e9 }
    assert.equal((await reap(cfg, { dryRun: true })).code, 3); assert.equal(existsSync(old), true)
    const result = await reap(cfg, { hours: 12 }); assert.equal(result.code, 3)
    assert.equal(existsSync(old), false); assert.equal(existsSync(young), true)
    assert.equal(floorExit(200, 150), 0); assert.equal(floorExit(149, 150), 3)
  }) },
  { name: 'temp ownership cleans failed operations and honours retained evidence', run: () => withFixture(async root => {
    const scope = tempScope(); let path
    try { path = await scope.make(join(root, 'obpal-failure-')); throw new Error('fixture failure') } catch {} finally { await scope.cleanup() }
    assert.equal(existsSync(path), false)
    const kept = tempScope({ keep: true }); const evidence = await kept.make(join(root, 'obpal-evidence-')); await kept.cleanup(); assert.equal(existsSync(evidence), true)
  }) },
  { name: 'detects held Windows files before deleting any part of a folder', run: () => withFixture(async root => {
    if (process.platform !== 'win32') return
    const file = join(root, 'held.txt'); writeFileSync(file, 'fixture')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$f = [IO.File]::Open($env:OBPAL_TEST_LOCK_FILE, 'Open', 'Read', 'None'); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $f.Dispose()"], { env: { ...process.env, OBPAL_TEST_LOCK_FILE: file }, windowsHide: true })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Lock fixture did not start')), 10_000)
        child.stdout.once('data', () => { clearTimeout(timer); resolve() }); child.once('error', reject)
      })
      assert.equal(lockedFiles(entries(root)).length, 1); assert.equal(existsSync(file), true)
    } finally {
      child.stdin.end('\n'); await new Promise(resolve => child.once('exit', resolve))
    }
    assert.equal(lockedFiles(entries(root)).length, 0)
  }) },
]
