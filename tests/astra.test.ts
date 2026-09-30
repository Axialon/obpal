import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, symlinkSync, realpathSync, join, tmpdir, env, bytes, centralOffset } from './astra-node.mjs'
import { archive, git, json, loadArchive, sha256 } from '../scripts/astra/common.mjs'
import { buildPack } from '../scripts/astra/pack.mjs'
import { applyStage, intake, namedSuites, STAGE_LIMITS, verifyStage } from '../scripts/astra/intake.mjs'
import { verify } from '../scripts/astra/verify.mjs'
import { reuseDependencies } from '../scripts/astra/dependencies.mjs'
import { LIMITS, readZip, safePath, writeZip } from '../scripts/astra/zip.mjs'

const TASK = '# Sample\n\nAdd one test.\n\n## Acceptance\nA passing test.\n\n## Out of scope\nEverything else.\n'
function commit(root: string, subject: string) {
  git(root, ['add', '-A'])
  // Fixture identities are synthetic and never change the checkout's Git configuration.
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', subject])
}
function fixture(stage = 'fixture', globs = ['*.txt']) {
  const root = mkdtempSync(join(tmpdir(), 'obpal-astra-test-')), outbox = join(root, 'outbox')
  git(root, ['init', '-b', 'master'])
  writeFileSync(join(root, 'value.txt'), 'before\n')
  commit(root, 'Initial fixture')
  const base = git(root, ['rev-parse', 'HEAD']).toString().trim()
  const pack = buildPack({ root, stage, task: TASK, globs })
  mkdirSync(outbox)
  const request = join(outbox, `obpal-${stage}-Request-fixture.zip`); writeFileSync(request, pack.bytes)
  writeFileSync(join(root, 'value.txt'), 'after\n')
  const patch = git(root, ['diff', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames']).toString()
  git(root, ['restore', 'value.txt'])
  const input = loadArchive(request).manifest
  const members: Record<string, string | Uint8Array> = {
    'STAGE.md': '# Findings\nOne bounded change.\n', 'TESTS.md': 'E2E-SUITES: none\nExecuted: none. Integrator: pnpm run check.\n',
    'HANDOFF.md': 'Rollback the stage commit; next stage is review.\n', 'OBPAL_START.txt': 'Intake the attached ZIP.\n',
    'SOURCE_PRECONDITIONS.json': json({ schema_version: 1, stage, before: { 'value.txt': sha256('before\n') } }),
    'patches/stage.patch': patch,
  }
  const metadata = { kind: 'stage', stage, input: { sha: base, archive_sha256: sha256(pack.bytes), hashes: input.source_hashes },
    changed_paths: ['value.txt'], new_paths: [] as string[], deleted_paths: [] as string[] }
  const returned = join(outbox, 'stage.zip')
  const save = () => writeFileSync(returned, archive(members, metadata))
  save()
  return { root, outbox, base, pack, request, returned, members, metadata, save }
}

async function receive(f: ReturnType<typeof fixture>) {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  const old = keys.map((key) => env[key])
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Fixture'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'fixture@example.test'
  try { return await intake({ ...f, run: () => { throw new Error('Intake must never execute returned code') } }) }
  finally { keys.forEach((key, i) => { if (old[i] === undefined) delete env[key]; else env[key] = old[i] }) }
}

// Real Git fixture operations need headroom when the full suite runs in parallel on Windows.
describe('Astra request packs', { timeout: 30_000 }, () => {
  it('exports pinned tracked blobs with exact member hashes, ignoring dirty and untracked files', () => {
    const f = fixture()
    writeFileSync(join(f.root, 'value.txt'), 'dirty\n')
    writeFileSync(join(f.root, 'untracked.txt'), 'not exported\n')
    const pack = buildPack({ root: f.root, stage: 'pinned', task: TASK })
    const path = join(f.outbox, 'pinned.zip'); writeFileSync(path, pack.bytes)
    const q = loadArchive(path)
    expect(q.members['source/value.txt'].toString()).toBe('before\n')
    expect(q.members['source/untracked.txt']).toBeUndefined()
    expect(q.manifest.master_sha).toBe(f.base)
    for (const [p, digest] of Object.entries(q.manifest.files)) expect(sha256(q.members[p])).toBe(digest)
    expect(q.members['START_HERE.md'].toString()).toContain('not recorded')
  })
  it('refuses private content before any budget trimming, using deny words and scanner rules', () => {
    const f = fixture()
    const secret = 'gh' + 'p_' + 'A'.repeat(36)
    writeFileSync(join(f.root, 'private.txt'), secret)
    commit(f.root, 'Private synthetic fixture')
    expect(() => buildPack({ root: f.root, stage: 'private', task: TASK, budget: 0.01 })).toThrow('github-token')
    git(f.root, ['rm', 'private.txt']); commit(f.root, 'Remove private fixture')
    writeFileSync(join(f.root, '.open-source-deny'), 'synthetic-private-word\n')
    expect(() => buildPack({ root: f.root, stage: 'deny', task: TASK + '\nsynthetic-private-word' })).toThrow('deny-word')
  })
  it('excludes guarded paths and reports largest-file budget trimming including manifest bytes', () => {
    const f = fixture()
    mkdirSync(join(f.root, '.claude', 'local'), { recursive: true })
    writeFileSync(join(f.root, '.claude', 'local', 'note.txt'), 'not for export')
    writeFileSync(join(f.root, 'CLAUDE.local.md'), 'local-only fixture')
    writeFileSync(join(f.root, 'large.txt'), 'X'.repeat(50000))
    commit(f.root, 'Large fixture')
    const pack = buildPack({ root: f.root, stage: 'budget', task: TASK, budget: 0.02 })
    expect(pack.trimmed).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'large.txt', reason: 'size budget' }),
      expect.objectContaining({ path: '.claude/local/note.txt', reason: 'guarded or local-only' }),
      expect.objectContaining({ path: 'CLAUDE.local.md', reason: 'guarded or local-only' }),
    ]))
    expect(Object.values(readZip(pack.bytes)).reduce((n, b) => n + b.length, 0)).toBeLessThanOrEqual(0.02 * 1024 ** 2)
    expect(() => buildPack({ root: f.root, stage: 'tiny', task: TASK, budget: 0.001 })).toThrow('Budget')
  })
})

describe('Astra return intake', { timeout: 30_000 }, () => {
  it('reuses trusted third-party dependencies without installing and points workspace packages into the lane', () => {
    const f = fixture('dependency-links')
    mkdirSync(join(f.root, 'packages', 'core'), { recursive: true })
    writeFileSync(join(f.root, 'package.json'), json({ name: 'fixture', dependencies: { 'third-party-fixture': '1.0.0', '@fixture/core': 'workspace:*' } }))
    writeFileSync(join(f.root, 'packages', 'core', 'package.json'), json({ name: '@fixture/core' }))
    writeFileSync(join(f.root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    writeFileSync(join(f.root, '.gitignore'), 'node_modules/\n')
    commit(f.root, 'Synthetic installed dependency checkpoint')
    const base = git(f.root, ['rev-parse', 'master']).toString().trim()
    mkdirSync(join(f.root, 'node_modules', 'third-party-fixture'), { recursive: true })
    writeFileSync(join(f.root, 'node_modules', 'third-party-fixture', 'package.json'), json({ name: 'third-party-fixture' }))
    mkdirSync(join(f.root, 'node_modules', '@fixture'), { recursive: true })
    symlinkSync(join(f.root, 'packages', 'core'), join(f.root, 'node_modules', '@fixture', 'core'), 'junction')
    const lane = join(f.root, 'dependency-lane')
    git(f.root, ['worktree', 'add', '-b', 'dependency-lane', lane, 'master'])
    reuseDependencies(f.root, lane, base, base)
    expect(realpathSync(join(lane, 'node_modules', '@fixture', 'core'))).toBe(realpathSync(join(lane, 'packages', 'core')))
    expect(realpathSync(join(lane, 'node_modules', 'third-party-fixture'))).toBe(realpathSync(join(f.root, 'node_modules', 'third-party-fixture')))
    expect(git(lane, ['status', '--porcelain']).toString()).toBe('')
    writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'changed coordinator lock\n')
    const other = join(f.root, 'dependency-refused')
    git(f.root, ['worktree', 'add', '-b', 'dependency-refused', other, 'master'])
    expect(() => reuseDependencies(f.root, other, base, base)).toThrow('coordinator lockfile differs')
    expect(existsSync(join(other, 'node_modules'))).toBe(false)
  })
  it('groups every changed path by risk and flags dependency metadata before an approved frozen installation', async () => {
    const f = fixture('f0', ['**'])
    const files: Record<string, string> = {
      'package.json': json({ name: 'fixture', scripts: { check: 'fixture-check', postinstall: 'fixture-hook' }, dependencies: { 'physics-fixture': '1.2.3' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  physics-fixture@1.2.3:\n    resolution: {integrity: sha512-YWJj, tarball: https://registry.npmjs.org/physics-fixture/-/physics-fixture-1.2.3.tgz}\n    license: MIT\nsnapshots:\n",
      'scripts/fixture.mjs': '// Synthetic executable fixture; never executed.\n',
      'vite.config.ts': '// Synthetic build config.\n', 'worker/wrangler.jsonc': '{}\n',
      '.github/workflows/fixture.yml': 'name: synthetic\n',
      'tests/fixture.test.ts': '// Synthetic test fixture.\n', 'src/fixture.ts': '// Synthetic product fixture.\n',
      'public/fixture.svg': '<svg/>\n',
      'src/support/open-source.json': json({ thanks: [{ name: 'Synthetic fixture', license: 'MIT', what: 'Original public/fixture.svg' }] }),
    }
    f.metadata.new_paths = Object.keys(files)
    for (const [p, content] of Object.entries(files)) f.members[`files/${p}`] = content
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'f0', before: { 'value.txt': sha256('before\n'), ...Object.fromEntries(Object.keys(files).map((p) => [p, null])) } })
    f.save()
    const report = await receive(f)
    expect(report.result).toBe('review-required')
    const review = readFileSync(report.path, 'utf8')
    for (const p of ['value.txt', ...Object.keys(files)]) expect(review).toContain(`\`${p}\``)
    for (const group of ['Scripts and tooling', 'Dependencies', 'Tests and build/test execution', 'Product source', 'Assets']) expect(review).toContain(`## ${group}`)
    expect(review).toContain('physics-fixture@1.2.3')
    expect(review).toContain('registry.npmjs.org')
    expect(review).toContain('sha512-YWJj')
    expect(review).toContain('license: MIT')
    expect(review).toContain('postinstall')
    expect(review).toContain('after 7 bytes')
    expect(review).toContain('Original public/fixture.svg')
    const calls: string[][] = []
    await verify({ root: f.root, stage: 'f0', run: (_root, argv) => { calls.push(argv); return { exit_code: 0, log: 'Synthetic execution only.\n' } } })
    expect(calls).toEqual([])
    writeFileSync(report.path, (review + 'approved: synthetic coordinator\n').replace(/\n/g, '\r\n'))
    const verified = await verify({ root: f.root, stage: 'f0', run: (_root, argv) => { calls.push(argv); return { exit_code: 0, log: 'Synthetic execution only.\n' } } })
    expect(verified.result).toBe('verified')
    expect(calls[0].slice(0, 3)).toEqual(['install', '--frozen-lockfile', '--ignore-scripts'])
    expect(calls.slice(1)).toEqual([['exec', 'vitest', 'run', 'tests/overclaims.test.ts'], ['run', 'check']])
  })
  it('refuses approval reuse after either the reviewed lane or the review report drifts', async () => {
    const f = fixture('approval-drift'), report = await receive(f)
    const review = readFileSync(report.path, 'utf8')
    writeFileSync(report.path, review + 'approved: fixture coordinator\n')
    const lane = join(f.root, '.claude', 'worktrees', 'astra-approval-drift')
    const run = () => { throw new Error('A stale approval must not execute code') }
    writeFileSync(join(lane, 'value.txt'), 'changed after approval\n')
    const refused = await verify({ root: f.root, stage: 'approval-drift', run })
    expect(refused.deviations.join('\n')).toContain('Approved lane drift')
    git(lane, ['restore', 'value.txt'])
    writeFileSync(report.path, review.replace('Product source', 'Hidden source') + 'approved: fixture coordinator\n')
    const altered = await verify({ root: f.root, stage: 'approval-drift', run })
    expect(altered.deviations.join('\n')).toContain('Review report changed')
    writeFileSync(report.path, review + 'approved: fixture coordinator\n')
    writeFileSync(join(lane, 'value.txt'), 'changed commit\n'); commit(lane, 'Synthetic post-review change')
    const committed = await verify({ root: f.root, stage: 'approval-drift', run })
    expect(committed.deviations.join('\n')).toContain('Approved lane drift')
  })
  it('verifies and commits a round trip in a separate worktree and preserves actual failed gates', async () => {
    const f = fixture('round-trip'), calls: string[][] = []
    // Only the synthetic fixture repo receives a synthetic commit identity through the test process environment.
    const oldName = env.GIT_AUTHOR_NAME, oldEmail = env.GIT_AUTHOR_EMAIL
    const oldCommitter = env.GIT_COMMITTER_NAME, oldCommitterEmail = env.GIT_COMMITTER_EMAIL
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'Fixture'
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'fixture@example.test'
    try {
      const received = await intake({ ...f, request: undefined, run: () => { throw new Error('Intake must execute no returned code') } })
      expect(received.result).toBe('review-required')
      expect(calls).toEqual([])
      const review = readFileSync(received.path, 'utf8')
      expect(review).toContain('No install, build or tests executed')
      expect(review).not.toMatch(/^approved:/m)
      const refused = await verify({ root: f.root, stage: 'round-trip', run: () => { throw new Error('Unapproved verification must execute nothing') } })
      expect(refused.result).toBe('failed')
      expect(refused.deviations.join('\n')).toContain('Coordinator approval required')
      // Simulate the coordinator's manual edit in this temporary fixture only.
      writeFileSync(received.path, review + 'approved: fixture coordinator\n')
      const report = await verify({ root: f.root, stage: 'round-trip', run: (_root, argv) => { calls.push(argv); return { exit_code: argv[1] === 'check' ? 7 : 0,
        log: `synthetic gate output\n${['C:', 'Users', 'fixture', 'private.log'].join('/')}\n` } } })
      expect(report.result).toBe('failed')
      expect(report.head).not.toBeNull()
      expect(calls).toEqual([['exec', 'vitest', 'run', 'tests/overclaims.test.ts'], ['run', 'check']])
      expect(readFileSync(join(f.root, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('before\n')
      const lane = join(f.root, '.claude', 'worktrees', 'astra-round-trip')
      expect(readFileSync(join(lane, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('after\n')
      expect(git(lane, ['status', '--porcelain']).toString()).toBe('')
      const result = loadArchive(report.path)
      expect(result.members['acceptance/check.json'].toString()).toContain('7')
      expect(result.members['RESULT.md'].toString()).toContain('failed (exit 7)')
      expect(result.members['INTEGRATION.md'].toString()).toContain('Merged: never')
      expect(result.members['REDACTIONS.json'].toString()).toContain('windows-path')
      expect(result.members['acceptance/check.log'].toString()).toContain('synthetic gate output')
      expect(result.members['acceptance/check.log'].toString()).not.toContain('private.log')
      expect(result.members['actual.patch'].toString()).toBe(f.members['patches/stage.patch'])
      expect(git(f.root, ['rev-parse', 'master']).toString().trim()).toBe(f.base)
    } finally {
      for (const [key, value] of Object.entries({ GIT_AUTHOR_NAME: oldName, GIT_AUTHOR_EMAIL: oldEmail, GIT_COMMITTER_NAME: oldCommitter, GIT_COMMITTER_EMAIL: oldCommitterEmail })) {
        if (value === undefined) delete env[key]; else env[key] = value
      }
    }
  })
  it('refuses a member hash mismatch', () => {
    const f = fixture(), zip = readZip(readFileSync(f.returned))
    zip['STAGE.md'] = bytes('tampered')
    writeFileSync(f.returned, writeZip(zip))
    expect(() => verifyStage(f)).toThrow('Hash mismatch: STAGE.md')
  })
  it('refuses a forged input digest and missing or extra preconditions', () => {
    const f = fixture()
    f.metadata.input.archive_sha256 = '0'.repeat(64); f.save()
    expect(() => verifyStage(f)).toThrow('retained request')
    f.metadata.input.archive_sha256 = sha256(f.pack.bytes)
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'fixture', before: {} }); f.save()
    expect(() => verifyStage(f)).toThrow('exactly')
  })
  it('reports exact source drift before creating a lane or running any gate', async () => {
    const f = fixture('drift')
    writeFileSync(join(f.root, 'value.txt'), 'drift\n')
    const run = () => { throw new Error('Gate must not run') }
    const report = await intake({ ...f, run })
    expect(report.head).toBeNull()
    expect(report.deviations[0]).toContain(`expected ${sha256('before\n')}, actual ${sha256('drift\n')}`)
    expect(existsSync(join(f.root, '.claude', 'worktrees', 'astra-drift'))).toBe(false)
    expect(loadArchive(report.path).members['RESULT.md'].toString()).toContain('preflight: failed')
  })
  it('refuses master drift even when the touched files still match', () => {
    const f = fixture()
    writeFileSync(join(f.root, 'other.txt'), 'new checkpoint\n'); commit(f.root, 'Advance master')
    expect(() => verifyStage(f)).toThrow('Master drift')
  })
  it('accepts an absent new fixture with null before hash and refuses files/ overwrites', () => {
    const f = fixture()
    f.members['files/fixture.txt'] = 'synthetic fixture\n'
    f.metadata.new_paths = ['fixture.txt']
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'fixture', before: { 'value.txt': sha256('before\n'), 'fixture.txt': null } })
    f.save()
    expect(verifyStage(f).files).toEqual(['files/fixture.txt'])
    f.members['files/value.txt'] = 'overwrite'; f.save()
    expect(() => verifyStage(f)).toThrow('files/ may only')
  })
  it('refuses an oversized stage payload before creating a lane', () => {
    const f = fixture()
    f.members['files/fixture.txt'] = 'X'.repeat(STAGE_LIMITS.payload + 1)
    f.metadata.new_paths = ['fixture.txt']
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'fixture', before: { 'value.txt': sha256('before\n'), 'fixture.txt': null } })
    f.save(); expect(() => verifyStage(f)).toThrow('Return payload exceeds bounded stage cap')
  })
  it('scans decoded binary patches before committing and withholds a refused delta', async () => {
    const f = fixture('binary-private')
    const pack = buildPack({ root: f.root, stage: 'binary-private', task: TASK })
    writeFileSync(f.request, pack.bytes); f.metadata.input.archive_sha256 = sha256(pack.bytes)
    const path = join(f.root, 'fixture.bin'), privateBytes = bytes('\0' + 'gh' + 'p_' + 'A'.repeat(36))
    writeFileSync(path, privateBytes); git(f.root, ['add', 'fixture.bin'])
    f.members['patches/binary.patch'] = git(f.root, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv']).toString()
    expect(String(f.members['patches/binary.patch'])).toContain('GIT binary patch')
    git(f.root, ['restore', '--staged', 'fixture.bin']); unlinkSync(path)
    f.metadata.new_paths = ['fixture.bin']
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'binary-private', before: { 'value.txt': sha256('before\n'), 'fixture.bin': null } })
    f.save(); verifyStage(f)
    const report = await intake({ ...f, run: () => { throw new Error('No gate may run after private refusal') } })
    expect(report.head).toBeNull()
    expect(report.result).toBe('failed')
    expect(report.deviations.join('\n')).toContain('withheld')
    expect(loadArchive(report.path).members['actual.patch'].toString()).toBe('')
    expect(git(join(f.root, '.claude', 'worktrees', 'astra-binary-private'), ['rev-parse', 'HEAD']).toString().trim()).toBe(f.base)
  })
  it('refuses binary patch expansion and case aliases of existing ancestors', () => {
    const f = fixture()
    const original = String(f.members['patches/stage.patch'])
    f.members['patches/stage.patch'] = original.slice(0, original.indexOf('@@')) + `GIT binary patch\nliteral ${LIMITS.member + 1}\n`
    f.save(); expect(() => verifyStage(f)).toThrow('Binary patch size cap')
    f.members['patches/stage.patch'] = original.slice(0, original.indexOf('@@')) + 'GIT binary patch\ndelta 12\n'
    f.save(); expect(() => verifyStage(f)).toThrow('Binary delta hunks')
    const pack = buildPack({ root: f.root, stage: 'fixture', task: TASK })
    writeFileSync(f.request, pack.bytes); f.metadata.input.archive_sha256 = sha256(pack.bytes)
    f.metadata.changed_paths = []; f.metadata.new_paths = ['Value.txt/fixture.txt']
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'fixture', before: { 'Value.txt/fixture.txt': null } })
    f.save(); expect(() => verifyStage(f)).toThrow('Case-colliding ancestor')
  })
  it('refuses guarded patches before applying, preserving the secret and machine-state boundary', () => {
    const f = fixture()
    for (const p of ['.claude/local/note.txt', 'keys/id.txt', 'desktop/install.rs', 'registry/change.reg', '.gitattributes', '.gitmodules']) {
      f.metadata.changed_paths = []; f.metadata.new_paths = [p]
      f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'fixture', before: { [p]: null } })
      f.save()
      expect(() => verifyStage(f)).toThrow(/Guarded/)
    }
  })
  it('keeps ordinary product files named registry or install exportable, outside the desktop helper', async () => {
    const { guarded } = await import('../scripts/astra/common.mjs')
    for (const p of ['src/sim/devices/registry.ts', 'src/install.ts', 'docs/install.md']) expect(guarded(p)).toBe(p)
    for (const p of ['desktop/install.rs', 'desktop/src/win/install.rs', 'desktop/src/win/registry.rs', 'registry/change.reg', 'install/setup.txt']) expect(() => guarded(p)).toThrow(/Guarded/)
  })
  it('refuses undeclared patch paths, symlink modes and new paths outside the export scope', () => {
    const f = fixture()
    f.members['patches/stage.patch'] = String(f.members['patches/stage.patch']).replaceAll('value.txt', 'other.txt'); f.save()
    expect(() => verifyStage(f)).toThrow(/before blob|inventory/)
    f.members['patches/stage.patch'] = String(f.members['patches/stage.patch']).replaceAll('other.txt', 'value.txt').replace(/index (.*) 100644/, 'new mode 120000\nindex $1 100644'); f.save()
    expect(() => verifyStage(f)).toThrow('mode refused')
    f.metadata.changed_paths = []; f.metadata.new_paths = ['outside.md']
    f.members['SOURCE_PRECONDITIONS.json'] = json({ schema_version: 1, stage: 'fixture', before: { 'outside.md': null } }); f.save()
    expect(() => verifyStage(f)).toThrow('outside export scope')
  })
  it('leaves a real three-way conflict isolated, without an as-received commit', () => {
    const f = fixture()
    const stage = verifyStage(f)
    const lane = join(f.root, '.claude', 'worktrees', 'conflict')
    git(f.root, ['worktree', 'add', '-b', 'conflict', lane, 'master'])
    writeFileSync(join(lane, 'value.txt'), 'ours\n'); commit(lane, 'Synthetic intervening edit')
    const before = git(lane, ['rev-parse', 'HEAD']).toString()
    expect(() => applyStage(lane, stage)).toThrow('git apply failed')
    expect(git(lane, ['ls-files', '-u']).toString()).toContain('value.txt')
    expect(readFileSync(join(f.root, 'value.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('before\n')
    expect(git(lane, ['rev-parse', 'HEAD']).toString()).toBe(before)
  })
  it('treats TESTS.md commands as data and only accepts a closed suite list', () => {
    expect(namedSuites('E2E-SUITES: code,home\nRun: arbitrary shell text')).toEqual(['code', 'home'])
    for (const text of ['E2E-SUITES: home;echo x', 'E2E-SUITES: extension --desktop', 'E2E-SUITES: home,home', 'none', 'E2E-SUITES: none\nE2E-SUITES: code']) expect(() => namedSuites(text)).toThrow()
  })
})

describe('Untrusted ZIP envelopes', () => {
  it('refuses traversal and Windows aliases before extraction', () => {
    for (const path of ['../outside.txt', '/outside.txt', 'a/../outside', 'a\\outside', 'a:b', 'a//b', 'a/.git/config', 'a/NUL.txt', 'a/name.', 'a/./b']) expect(() => safePath(path)).toThrow()
    const b = writeZip({ 'good.txt': 'fixture' })
    // Forge both local and central names without using our guarded writer.
    const forged = bytes(b.toString('latin1').replaceAll('good.txt', '../x.txt'), 'latin1')
    expect(() => readZip(forged)).toThrow('traversing')
  })
  it('refuses corrupt CRCs, duplicate names, symlinks, truncated archives and expansion bombs', () => {
    expect(() => writeZip({ 'A.txt': 'a', 'a.txt': 'b' })).toThrow('duplicate')
    const valid = writeZip({ 'a.txt': 'fixture' }), crc = bytes(valid)
    crc.writeUInt32LE(0, 14)
    expect(() => readZip(crc)).toThrow('mismatch')
    const mode = bytes(valid), central = centralOffset(mode)
    mode.writeUInt32LE((0o120777 << 16) >>> 0, central + 38)
    expect(() => readZip(mode)).toThrow('unsupported')
    expect(() => readZip(valid.subarray(0, valid.length - 5))).toThrow()
    const bomb = bytes(valid); bomb.writeUInt32LE(LIMITS.member + 1, central + 24)
    expect(() => readZip(bomb)).toThrow('cap')
  })
})
