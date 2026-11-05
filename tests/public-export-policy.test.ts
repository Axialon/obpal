import { describe, expect, it } from 'vitest'
import { selectPublicFiles, verifyPublicOutput, type PublicExportPolicy, type PublicOutputManifest } from '../scripts/lib/public-export.mjs'
import { readPublicSource, trackedPublicInputs } from './public-export-node.mjs'

const digest = (n: string) => n.repeat(64)

describe('internal policy admission boundary', () => {
  const admitted = () => JSON.parse(readPublicSource('public-export.allowlist.json')) as PublicExportPolicy
  it('classifies the current inventory without inferring new public inputs', () => {
    const plan = selectPublicFiles(trackedPublicInputs(), admitted())
    expect(plan.inputs.length).toBeGreaterThan(0)
    expect(() => selectPublicFiles([...trackedPublicInputs(), 'src/unreviewed.ts'], admitted())).toThrow('unclassified tracked path')
  })
  it('retains the reviewed immutable runtime or the explicitly projected public-only policy', () => {
    const p = admitted()
    if (p.payloadRevision === null) {
      expect(p.include.every(row => row.source === 'tooling')).toBe(true)
      expect(p.exclude.map(row => row.path)).toEqual(['public-export.manifest.json'])
      expect(p.blockedSha256).toEqual([])
    } else {
      expect(p.payloadRevision).toBe('a7394a1375c5190f3a53095e0791d32e58e2cf77')
      expect(p.blockedSha256.length).toBeGreaterThanOrEqual(63)
    }
    expect(p.include.filter(row => /coach/.test(row.path))).toEqual([])
    expect(p.include.filter(row => row.role === 'asset' && /^public\/models\/(?:cvc|blackboxes)\//.test(row.path))).toEqual([])
  })
  it('keeps later private coach and native gate paths excluded rather than activating the public projection policy', () => {
    const p = admitted(), excluded = new Set(p.exclude.map(row => row.path)), tracked = new Set(trackedPublicInputs())
    for (const path of ['worker/coach.ts', 'worker/nebius-coach.ts', 'src/sim/arm/coach/panel.ts', 'scripts/lib/merge-report.mjs']) {
      if (tracked.has(path)) expect(excluded.has(path)).toBe(true)
      expect(p.include.some(row => row.path === path)).toBe(false)
    }
    if (p.payloadRevision !== null) expect(p.exclude.length).toBeGreaterThan(1)
  })
})
function policy(): PublicExportPolicy {
  return { schema: 1, profile: 'public-demo-v1', payloadRevision: 'a'.repeat(40),
    include: [
      { path: 'LICENSE', role: 'notice', source: 'payload', rights: 'MIT', inputSha256: digest('1'), noticePaths: [] },
      { path: 'src/main.ts', role: 'code', source: 'payload', rights: 'source-notices', inputSha256: digest('2'), noticePaths: ['LICENSE'] },
      { path: 'assets/build.py', role: 'code', source: 'payload', rights: 'source-notices', inputSha256: digest('3'), noticePaths: ['LICENSE'] },
      { path: 'public/demo.svg', role: 'asset', source: 'payload', rights: 'MIT', inputSha256: digest('4'), noticePaths: ['LICENSE'],
        provenance: { kind: 'original', reference: 'assets/build.py' } },
      { path: 'public-export.allowlist.json', role: 'policy', source: 'tooling', rights: 'source-notices', noticePaths: ['LICENSE'], transform: 'policy' },
    ], exclude: [{ path: 'public/models/cvc/private.glb', reason: 'restricted-brand' }], blockedSha256: [digest('d')],
    catalog: { items: ['cube', 'knot', 'gem'], categories: ['studio', 'local'], defaultId: 'cube' } }
}
const tracked = () => [...policy().include.map(row => row.path), ...policy().exclude.map(row => row.path)]
function manifest(): PublicOutputManifest {
  return { schema: 1, profile: 'public-demo-v1', policySha256: digest('e'), rows: policy().include.map(row => ({
    path: row.path, sourcePath: row.path, sourceSha256: row.inputSha256 ?? digest('e'),
    sha256: row.transform ? digest('f') : row.inputSha256!, bytes: 10, mode: '100644' as const,
    role: row.role, noticePaths: row.noticePaths })) }
}

describe('exact public export policy', () => {
  it('selects only explicit paths and records transformations and omissions separately', () => {
    const plan = selectPublicFiles(tracked(), policy())
    expect(plan.copyPaths).toEqual(['LICENSE', 'src/main.ts', 'assets/build.py', 'public/demo.svg'])
    expect(plan.transforms).toEqual([{ path: 'public-export.allowlist.json', kind: 'policy' }])
    expect(plan.omissions).toEqual(policy().exclude)
    expect(plan.payloadRevision).toBe('a'.repeat(40))
  })
  it.each(['src/new.ts', 'public/new.glb', 'public/renamed.png'])('refuses an unclassified tracked input: %s', path => {
    expect(() => selectPublicFiles([...tracked(), path], policy())).toThrow()
  })
  it.each(['/escape', '../escape', 'src/../escape', 'C:/escape', 'src\\escape', '//share/file', 'src//file', 'src/*', './src/file', 'a\0b'])(
    'refuses a noncanonical or escaping path: %s', path => {
      const p = policy(); p.include[1] = { ...p.include[1], path }
      expect(() => selectPublicFiles(tracked(), p)).toThrow()
    })
  it.each(['.env', '.open-source-deny', '.git/config', '.claude/local/state.json',
    'src/sim/arm/coach/attempt.ts', 'src/sim/arm/coach/adapter.ts', 'src/sim/arm/coach/evidence.ts',
    'src/sim/arm/coach/client.ts', 'tests/coach-attempt.test.ts', 'tests/coach-adapter.test.ts', 'tests/coach-client.test.ts'])(
    'cannot include private or unapproved coaching input by relabelling its role: %s', path => {
      const p = policy(); p.include.push({ ...p.include[1], path })
      expect(() => selectPublicFiles([...tracked(), path], p)).toThrow()
    })
  it('rejects duplicates, case collisions and include/exclude overlap', () => {
    for (const path of ['src/main.ts', 'SRC/MAIN.ts', 'public/models/cvc/private.glb']) {
      const p = policy(); p.include.push({ ...p.include[1], path })
      expect(() => selectPublicFiles([...tracked(), path], p)).toThrow()
    }
  })
  it.each(['public/models/cvc/renamed.glb', 'public/models/blackboxes/shape.glb', 'src/viewer/boxem-core.ts'])(
    'refuses restricted prefixes and procedural branded artwork even with a claimed code licence: %s', path => {
      const p = policy(); p.include.push({ ...p.include[1], path })
      expect(() => selectPublicFiles([...tracked(), path], p)).toThrow()
    })
  it('permits only the exact CVC notice as unchanged context, never a notice role bypass', () => {
    const p = policy(), notice = { ...p.include[0], path: 'public/models/cvc/NOTICE.md', rights: 'notice-context' }
    p.include.push(notice)
    expect(selectPublicFiles([...tracked(), notice.path], p).copyPaths).toContain(notice.path)
    for (const path of ['public/models/cvc/other.md', 'public/models/cvc/private.glb']) {
      const bad = policy(); bad.include.push({ ...notice, path })
      expect(() => selectPublicFiles([...tracked(), path], bad)).toThrow()
    }
  })
  it('requires asset provenance, a pinned digest and included original notices', () => {
    for (const change of [{ inputSha256: undefined }, { provenance: undefined }, { rights: 'unverified' },
      { provenance: { kind: 'unknown', reference: 'somewhere' } }, { noticePaths: ['MISSING'] }, { role: 'code' }]) {
      const p = policy(); Object.assign(p.include[3], change)
      expect(() => selectPublicFiles(tracked(), p)).toThrow()
    }
  })
  it('blocks a restricted digest after renaming or a false MIT/code/notice declaration', () => {
    for (const role of ['asset', 'code', 'notice'] as const) {
      const p = policy(); p.include[1] = { ...p.include[1], role, inputSha256: digest('d') }
      expect(() => selectPublicFiles(tracked(), p)).toThrow()
    }
  })
  it('requires a known schema, fixed public catalogue and explicit source identity', () => {
    for (const change of [{ schema: 2 }, { payloadRevision: 'master' }, { includeGlob: 'src/**' },
      { catalog: { ...policy().catalog, defaultId: 'cvc-insignia' } }]) {
      expect(() => selectPublicFiles(tracked(), { ...policy(), ...change } as PublicExportPolicy)).toThrow()
    }
  })
})

describe('one materialized public output inventory', () => {
  it('accepts every planned row plus the single external-checksum metadata file', () => {
    expect(verifyPublicOutput(selectPublicFiles(tracked(), policy()), manifest(),
      [...policy().include.map(row => row.path), 'public-export.manifest.json'])).toEqual([])
  })
  it('rejects a changed copied file digest even when its claimed source digest remains pinned', () => {
    const output = manifest(), paths = [...policy().include.map(row => row.path), 'public-export.manifest.json']
    output.rows[0].sha256 = digest('f')
    expect(verifyPublicOutput(selectPublicFiles(tracked(), policy()), output, paths))
      .toContain('LICENSE: copied bytes differ from pinned source')
  })
  it('permits a distinct output hash for the explicitly declared policy projection', () => {
    const output = manifest(), paths = [...policy().include.map(row => row.path), 'public-export.manifest.json']
    expect(output.rows[4].sha256).not.toBe(output.rows[4].sourceSha256)
    expect(verifyPublicOutput(selectPublicFiles(tracked(), policy()), output, paths)).toEqual([])
  })
  it('refuses extra, missing, duplicate or escaping output rather than silently staging it', () => {
    const plan = selectPublicFiles(tracked(), policy()), paths = [...policy().include.map(row => row.path), 'public-export.manifest.json']
    for (const actual of [[...paths, 'public/models/cvc/private.glb'], paths.slice(1), [...paths, paths[0]], [...paths, '../escape']]) {
      expect(verifyPublicOutput(plan, manifest(), actual).length).toBeGreaterThan(0)
    }
  })
  it('refuses a manifest with changed source hashes, unknown fields or omitted required notices', () => {
    const plan = selectPublicFiles(tracked(), policy()), paths = [...policy().include.map(row => row.path), 'public-export.manifest.json']
    const changed = manifest(); changed.rows[1].sourceSha256 = digest('a')
    expect(verifyPublicOutput(plan, changed, paths).length).toBeGreaterThan(0)
    expect(verifyPublicOutput(plan, { ...manifest(), omissions: [] } as PublicOutputManifest, paths).length).toBeGreaterThan(0)
    const missing = manifest(); missing.rows = missing.rows.filter(row => row.path !== 'LICENSE')
    expect(verifyPublicOutput(plan, missing, paths).length).toBeGreaterThan(0)
  })
  it('binds output executable modes to the captured immutable source modes', () => {
    const plan = selectPublicFiles(tracked(), policy()), output = manifest()
    plan.inputModes = Object.fromEntries(plan.inputs.map(row => [row.path, '100644' as const]))
    output.rows[0].mode = '100755'
    expect(verifyPublicOutput(plan, output, [...plan.inputs.map(row => row.path), 'public-export.manifest.json']))
      .toContain('LICENSE: output mode differs from immutable source')
  })
})
