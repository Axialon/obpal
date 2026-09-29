import { describe, expect, it } from 'vitest'
import {
  authUrls, authWatcher, comparePacked, compareVersions, describeChange, highestRelease, integrityOf, packageTests, parseVersion, planRelease, readTarball,
  satisfies, scanTarball, streamCommand, waitUntil,
} from '../scripts/lib/npm-publish.mjs'
import { bytes, makeTarball, nodePath, readText, runScript } from './devtools-node.mjs'

/** Samples are put together at run time, so this file never holds one whole and passes its own scan. */
const k = (...parts: string[]) => parts.join('')

/** A package's files as `pnpm pack` lays them out, with what a test wants changed. */
function files(over: Record<string, string | null> = {}, manifest: Record<string, unknown> = {}): Record<string, string> {
  const base: Record<string, string | null> = {
    'package.json': JSON.stringify({
      name: '@obpal/core', version: '0.2.0', type: 'module', license: 'MIT', main: './dist/index.js', types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './toss': { types: './dist/toss.d.ts', import: './dist/toss.js' }, './package.json': './package.json' },
      files: ['dist', 'CHANGELOG.md'], ...manifest,
    }),
    'README.md': '# @obpal/core\n\nnpm install @obpal/core\n',
    'CHANGELOG.md': '# Changelog\n\n## 0.2.0\n',
    'dist/LICENSE': 'MIT License\n',
    'dist/index.js': 'export const a = 1\n',
    'dist/index.d.ts': 'export declare const a = 1\n',
    'dist/toss.js': 'export const t = 2\n',
    'dist/toss.d.ts': 'export declare const t = 2\n',
    ...over,
  }
  return Object.fromEntries(Object.entries(base).filter((e): e is [string, string] => e[1] !== null))
}
const pack = (f: Record<string, string>, opts?: { pax?: boolean }) => readTarball(makeTarball(f, opts))
const scan = (f: Record<string, string>, deny: string[] = []) => scanTarball(pack(f), { name: '@obpal/core', version: '0.2.0', deny })
const whats = (f: Record<string, string>, deny?: string[]) => scan(f, deny).map((x) => `${x.path}: ${x.what}`)

describe('versions', () => {
  it('reads and orders them the way semver does', () => {
    expect(parseVersion('0.2.0')).toEqual({ major: 0, minor: 2, patch: 0, pre: '' })
    expect(parseVersion('1.0.0-beta.2')?.pre).toBe('beta.2')
    expect(parseVersion('0.2')).toBeNull()
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('0.2.0', '0.2.0+build')).toBe(0)
    expect(highestRelease(['0.1.0', '0.2.0-beta.1', '0.10.0', '0.9.0'])).toBe('0.10.0')
    expect(highestRelease([])).toBeNull()
  })

  it('says whether a version meets a dependency range, and null for a range it cannot judge', () => {
    expect(satisfies('0.2.0', '0.2.0')).toBe(true)
    expect(satisfies('0.2.1', '0.2.0')).toBe(false)
    expect(satisfies('0.2.5', '^0.2.0')).toBe(true)
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false)
    expect(satisfies('1.4.0', '^1.2.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.2.0')).toBe(false)
    expect(satisfies('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfies('0.0.4', '^0.0.3')).toBe(false)
    expect(satisfies('0.2.9', '~0.2.1')).toBe(true)
    expect(satisfies('0.3.0', '~0.2.1')).toBe(false)
    expect(satisfies('0.4.0', '>=0.2.0')).toBe(true)
    expect(satisfies('0.4.0', '*')).toBe(true)
    expect(satisfies('0.3.0-beta.1', '^0.2.0')).toBe(false)
    expect(satisfies('0.2.0', '0.1 || 0.2')).toBeNull()
    expect(satisfies('0.2.0', 'workspace:*')).toBeNull()
  })
})

describe('reading a tarball', () => {
  it('lists its files without the package folder, and reads a long name from a pax header', () => {
    const long = `dist/${'deep/'.repeat(30)}file.js`
    const f = { 'package.json': '{}', 'dist/index.js': 'x', [long]: 'y' }
    for (const pax of [false, true]) {
      const got = pack(pax ? f : { 'package.json': '{}', 'dist/index.js': 'x' }, { pax })
      expect([...got.keys()].sort()).toEqual(pax ? ['dist/index.js', long, 'package.json'].sort() : ['dist/index.js', 'package.json'])
    }
    expect(new TextDecoder().decode(pack(f, { pax: true }).get(long))).toBe('y')
  })

  it('refuses a path that leaves the package, a file outside the package folder, and a link', () => {
    expect(() => pack({ '../escape.js': 'x' })).toThrow(/outside the package/)
    expect(() => readTarball(makeTarball({ 'x.js': 'x' }, { folder: '' }))).toThrow(/outside the package/)
    expect(() => readTarball(makeTarball({ 'dist/a.js': 'x' }, { links: ['dist/link'] }))).toThrow(/link/)
  })

  it('gives a tarball\'s digest the way npm lists it', () => {
    expect(integrityOf(bytes('abc'))).toBe('sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==')
  })
})

describe('comparing two packs of one version', () => {
  const a = pack(files())

  it('finds the same package the same, whatever the line endings or the manifest\'s key order', () => {
    const crlf = pack(files({ 'README.md': '# @obpal/core\r\n\r\nnpm install @obpal/core\r\n', 'dist/LICENSE': 'MIT License\r\n' }))
    expect(comparePacked(a, crlf)).toEqual({ same: true, added: [], removed: [], changed: [] })
    const manifest = JSON.parse(readText('packages/core/package.json'))
    const reordered = pack(files({ 'package.json': JSON.stringify({ version: '0.2.0', name: '@obpal/core', scripts: { build: 'x' }, exports: manifest.exports, main: './dist/index.js', types: './dist/index.d.ts', type: 'module', license: 'MIT', files: ['dist', 'CHANGELOG.md'] }) }))
    const flat = pack(files({ 'package.json': JSON.stringify({ ...JSON.parse(files()['package.json']), exports: manifest.exports }) }))
    expect(comparePacked(reordered, flat).same).toBe(true)
  })

  it('finds what a forgotten bump leaves: code that changed, a file added or removed', () => {
    const other = pack(files({ 'dist/index.js': 'export const a = 2\n', 'dist/extra.js': 'x', 'CHANGELOG.md': null }))
    const cmp = comparePacked(a, other)
    expect(cmp).toEqual({ same: false, added: ['dist/extra.js'], removed: ['CHANGELOG.md'], changed: ['dist/index.js'] })
    expect(describeChange(cmp)).toBe('dist changed index.js, added extra.js; removed CHANGELOG.md')
  })

  it('can leave manifest fields out, to ask what else moved between two releases', () => {
    const next = pack(files({ 'package.json': JSON.stringify({ ...JSON.parse(files()['package.json']), version: '0.3.0' }) }))
    expect(comparePacked(a, next).changed).toEqual(['package.json'])
    const cmp = comparePacked(a, next, { ignoreManifest: ['version'] })
    expect(cmp.same).toBe(true)
    expect(describeChange(cmp)).toBe('dist unchanged')
  })

  it('says what changed in a line: the code first, the other files after, and how many more', () => {
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`dist/m${i}.js`, 'x']))
    expect(describeChange(comparePacked(a, pack(files({ ...many, 'README.md': 'new\n' }))))).toBe('dist added m0.js, m1.js, m2.js, m3.js, +2 more; changed README.md')
  })
})

describe('scanning a tarball', () => {
  it('passes the package as it should be', () => {
    expect(scan(files())).toEqual([])
  })

  it('finds a file that has no place in the package', () => {
    const found = whats(files({ 'src/index.ts': 'x', '.npmrc': 'x', 'node_modules/x/index.js': 'x', 'tsconfig.json': '{}' }))
    expect(found).toEqual([
      'src/index.ts: not expected in the package (only package.json, README, LICENSE, CHANGELOG and dist)',
      '.npmrc: not expected in the package (only package.json, README, LICENSE, CHANGELOG and dist)',
      'node_modules/x/index.js: not expected in the package (only package.json, README, LICENSE, CHANGELOG and dist)',
      'tsconfig.json: not expected in the package (only package.json, README, LICENSE, CHANGELOG and dist)',
    ])
  })

  it('finds a package that was not built, or has no README', () => {
    expect(whats(files({ 'dist/index.js': null, 'dist/toss.js': null }))).toContain('dist: holds no JavaScript: was the package built?')
    expect(whats(files({ 'README.md': null }))).toContain('README.md: missing')
  })

  it('finds a source map that points at a local path, and one that leaves the package', () => {
    const local = k('C:', '\\', 'Users', '\\', 'someone', '\\', 'src', '\\', 'index.ts')
    expect(whats(files({ 'dist/index.js.map': JSON.stringify({ version: 3, sources: [local] }) })).some((w) => w.includes('source map pointing at a local path'))).toBe(true)
    expect(whats(files({ 'dist/index.js.map': JSON.stringify({ version: 3, sources: ['../src/index.ts'] }) })).some((w) => w.includes('source map pointing at a local path'))).toBe(true)
    expect(whats(files({ 'dist/index.js.map': JSON.stringify({ version: 3, sources: ['/tmp/x.ts'] }) })).some((w) => w.includes('source map pointing at a local path'))).toBe(true)
    expect(whats(files({ 'dist/index.js.map': JSON.stringify({ version: 3, sources: ['src/index.ts'] }) }))).toEqual([])
    expect(whats(files({ 'dist/index.js.map': 'not json' }))).toEqual(["dist/index.js.map: a source map that isn't JSON"])
    expect(whats(files({ 'dist/index.js': `export const a = 1\n//# sourceMappingURL=${k('file:', '///tmp/a.js.map')}\n` }))).toEqual(['dist/index.js: a sourceMappingURL pointing at a local path'])
    expect(whats(files({ 'dist/index.js': 'export const a = 1\n//# sourceMappingURL=index.js.map\n' }))).toEqual([])
    const inline = btoa(JSON.stringify({ version: 3, sources: [k('/hom', 'e/x/y.ts')] }))
    expect(whats(files({ 'dist/index.js': `export const a = 1\n//# sourceMappingURL=data:application/json;base64,${inline}\n` }))).toEqual(['dist/index.js: an inline source map pointing at a local path'])
  })

  it('finds a local path, a personal address, a key and a private word, with the line and never the text', () => {
    const path = k('C:', '\\', 'Users', '\\', 'someone', '\\', 'ob-pal')
    const mail = k('someone', '@', 'gmail.com')
    const token = k('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0a1B2c3D4e5F6g7H8')
    const found = scan(files({ 'dist/index.js': `export const a = 1\n// built in ${path}\n// ${mail}\n// ${token}\n// a Zanzibar mention\n` }), ['zanzibar'])
    expect(found.map((f) => [f.line, f.what])).toEqual([
      [2, 'a local Windows path'], [3, 'a personal email address'], [3, 'an email address'], [4, 'a GitHub token'], [5, 'a private word from .open-source-deny'],
    ])
    expect(JSON.stringify(found)).not.toContain(token)
    expect(JSON.stringify(found)).not.toContain(mail)
    expect(JSON.stringify(found)).not.toContain('Zanzibar')
  })

  it('finds any email address in a package, but not a placeholder or a version', () => {
    expect(whats(files({ 'README.md': `Write to ${k('hello', '@', 'somewhere.dev')}.\n` }))).toEqual(['README.md: an email address'])
    expect(whats(files({ 'README.md': `${k('noreply', '@', 'example.com')}, ${k('a', '@', 'users.noreply.github.com')}, npm install @obpal/host@0.2.0, uqr@^0.1.3\n` }))).toEqual([])
    expect(whats(files({ 'README.md': `Write to ${k('someone', '@', 'blackboxes.net')}.\n` }))).toEqual(['README.md: an email address'])
  })

  it('finds a manifest that is not the package it should be', () => {
    expect(whats(files({}, { name: '@obpal/other' }))).toEqual(['package.json: names @obpal/other, not @obpal/core'])
    expect(whats(files({}, { version: '0.1.0' }))).toEqual(['package.json: says version 0.1.0, not 0.2.0'])
    expect(whats(files({}, { private: true }))).toEqual(['package.json: is private: npm would refuse it'])
    expect(whats(files({}, { dependencies: { '@obpal/core': 'workspace:*' } }))).toEqual(['package.json: dependencies.@obpal/core is "workspace:*": pnpm should have replaced it with a version'])
    expect(whats(files({}, { scripts: { postinstall: 'node x.js', build: 'x' } }))).toEqual(["package.json: runs a postinstall script on the reader's machine"])
    expect(whats(files({}, { main: './src/index.ts' }))).toEqual(["package.json: points at ./src/index.ts, source that isn't in the package"])
    expect(whats(files({ 'dist/toss.js': null }))).toEqual(['package.json: points at ./dist/toss.js, which the package lacks'])
    expect(whats(files({ 'package.json': null }))).toEqual(['package.json: missing'])
    expect(whats(files({ 'package.json': '{' }))).toEqual(["package.json: isn't JSON"])
  })

  it('passes the manifests this repository publishes, with pnpm\'s changes made (main, types and exports from publishConfig)', () => {
    for (const name of ['core', 'host']) {
      const m = JSON.parse(readText(`packages/${name}/package.json`))
      const packed = { ...m, ...m.publishConfig, dependencies: Object.fromEntries(Object.entries(m.dependencies ?? {}).map(([d, v]) => [d, v === 'workspace:*' ? m.version : v])) }
      const entries = [packed.main, packed.types, ...Object.values(packed.exports).flatMap((e) => (typeof e === 'string' ? [e] : Object.values(e as Record<string, string>)))]
      const dist = Object.fromEntries(entries.filter((e) => e.startsWith('./dist/')).map((e) => [e.slice(2), 'x']))
      const found = scanTarball(pack({ 'package.json': JSON.stringify(packed), 'README.md': '# x\n', ...dist }), { name: m.name, version: m.version })
      expect(found).toEqual([])
    }
  })
})

describe('the plan', () => {
  const core = { name: '@obpal/core', version: '0.2.0' }
  const host = { name: '@obpal/host', version: '0.2.0', dependencies: { '@obpal/core': '0.2.0', uqr: '^0.1.3' } }
  const actions = (p: ReturnType<typeof planRelease>) => p.steps.map((s) => `${s.name} ${s.action}`)

  it('publishes both, core first, when neither is on npm at that version', () => {
    const plan = planRelease([core, host], { '@obpal/core': { versions: ['0.1.0'] }, '@obpal/host': { versions: ['0.1.0'] } })
    expect(actions(plan)).toEqual(['@obpal/core publish', '@obpal/host publish'])
    expect(plan.steps[0]).toMatchObject({ latest: '0.1.0', why: 'new, after 0.1.0' })
    expect(plan.links).toEqual([{ name: '@obpal/host', dep: '@obpal/core', range: '0.2.0', resolves: '@obpal/core@0.2.0 (published in this run)', ok: true }])
    expect(plan.problems).toEqual([])
  })

  it('calls a first release a first release', () => {
    expect(planRelease([{ ...core, version: '0.1.0' }], {}).steps[0]).toMatchObject({ action: 'publish', latest: null, why: 'first release' })
  })

  it('skips a version that is on npm with the same files', () => {
    const plan = planRelease([core, host], { '@obpal/core': { versions: ['0.1.0', '0.2.0'], same: true }, '@obpal/host': { versions: ['0.1.0'] } })
    expect(actions(plan)).toEqual(['@obpal/core skip', '@obpal/host publish'])
    expect(plan.links[0].resolves).toBe('@obpal/core@0.2.0 (on npm)')
    expect(plan.problems).toEqual([])
  })

  it('refuses a forgotten bump: the version is on npm, and the files differ or could not be compared', () => {
    const differ = planRelease([core, host], { '@obpal/core': { versions: ['0.2.0'], same: false }, '@obpal/host': { versions: [] } })
    expect(actions(differ)).toEqual(['@obpal/core refuse', '@obpal/host publish'])
    expect(differ.problems).toEqual(['@obpal/core@0.2.0: already on npm with other files: bump the version'])
    expect(planRelease([core], { '@obpal/core': { versions: ['0.2.0'], same: null } }).problems).toEqual(['@obpal/core@0.2.0: already on npm, and the files could not be compared'])
  })

  it('refuses a version older than the latest, and a prerelease', () => {
    expect(planRelease([{ ...core, version: '0.1.5' }], { '@obpal/core': { versions: ['0.1.0', '0.2.0'] } }).problems).toEqual(['@obpal/core@0.1.5: older than 0.2.0, which is on npm: the latest tag would move back'])
    expect(planRelease([{ ...core, version: '0.3.0-beta.1' }], {}).problems[0]).toMatch(/prerelease/)
    expect(planRelease([{ ...core, version: 'next' }], {}).problems[0]).toMatch(/isn't a version/)
  })

  it('checks that host\'s core dependency is on npm or in this run', () => {
    const missing = planRelease([core, { ...host, dependencies: { '@obpal/core': '0.3.0' } }], { '@obpal/core': { versions: ['0.1.0'] } })
    expect(missing.problems).toEqual(['@obpal/host needs @obpal/core 0.3.0, which is not on npm and not in this run'])
    // Core skipped (already on npm) is as good as published, and host may name an older core that is on npm.
    expect(planRelease([core, host], { '@obpal/core': { versions: ['0.2.0'], same: true } }).problems).toEqual([])
    const older = planRelease([core, { ...host, dependencies: { '@obpal/core': '0.1.0' } }], { '@obpal/core': { versions: ['0.1.0'] } })
    expect(older.problems).toEqual([])
    expect(older.links[0].resolves).toBe('@obpal/core@0.1.0 (on npm)')
    // A package outside the run is npm's to resolve: not this plan's business.
    expect(planRelease([host], { '@obpal/core': { versions: ['0.2.0'] } }).links).toEqual([])
  })

  it('reads a caret range, and stops at one it cannot judge or a dependency published after its dependent', () => {
    expect(planRelease([core, { ...host, dependencies: { '@obpal/core': '^0.2.0' } }], {}).problems).toEqual([])
    expect(planRelease([core, { ...host, dependencies: { '@obpal/core': '0.2 || 0.3' } }], {}).problems).toEqual(["@obpal/host needs @obpal/core 0.2 || 0.3, a range this script can't judge"])
    expect(planRelease([host, core], {}).problems).toEqual(['@obpal/host needs @obpal/core, which is published after it: the order is wrong'])
  })
})

describe('npm\'s sign-in link', () => {
  const url = 'https://www.npmjs.com/auth/cli/9f3c2b1a-7d4e-4c8b-a1f0-2e5d6c7b8a90'

  it('finds the link in npm\'s output, once, and not other npmjs.com addresses', () => {
    const out = `npm notice Publishing to https://registry.npmjs.org/ with tag latest\nAuthenticate your account at:\n${url}\nPress ENTER to open in the browser...\nsee https://www.npmjs.com/package/@obpal/host and ${url}\n`
    expect(authUrls(out)).toEqual([url])
    expect(authUrls('nothing here, https://www.npmjs.com/login')).toEqual([])
  })

  it('finds a link that arrives in pieces, whole and once', () => {
    const w = authWatcher()
    expect(w.feed('Authenticate your account at:\nhttps://www.npm')).toEqual([])
    expect(w.feed('js.com/auth/cli/9f3c2b1a-7d4e')).toEqual([])
    expect(w.feed('-4c8b-a1f0-2e5d6c7b8a90')).toEqual([])
    expect(w.feed('\nPress ENTER\n')).toEqual([url])
    expect(w.feed(`${url}\n`)).toEqual([])
    expect(w.end()).toEqual([])
  })

  it('gives a link that ends the output when the output ends, and a second link when npm asks again', () => {
    const w = authWatcher()
    expect(w.feed(`Authenticate your account at: ${url}`)).toEqual([])
    expect(w.end()).toEqual([url])
    const again = authWatcher()
    const second = url.replace('9f3c', '0000')
    expect(again.feed(`${url}\nlater\n${second}\n`)).toEqual([url, second])
  })
})

describe('running npm with its sign-in link called out', () => {
  const url = 'https://www.npmjs.com/auth/cli/9f3c2b1a-7d4e-4c8b-a1f0-2e5d6c7b8a90'
  /** Runs a small script of Node's, standing in for npm, and collects what came through. */
  async function run(code: string, timeoutMs = 0) {
    const out: string[] = []
    const approved: string[] = []
    const r = await streamCommand(nodePath, ['-e', code], { timeoutMs, write: (stream, text) => out.push(`${stream}:${text}`), onApprove: (u) => approved.push(u) })
    return { r, out: out.join(''), approved }
  }

  it('passes the output on as it comes and gives the link once, whole, though it is printed in pieces and twice', async () => {
    const { r, out, approved } = await run(`
      process.stdout.write('Authenticate your account at:\\n${url.slice(0, 40)}')
      setTimeout(() => { process.stdout.write('${url.slice(40)}\\nPress ENTER to open in the browser...\\n'); process.stderr.write('${url}\\n') }, 100)
    `)
    expect(approved).toEqual([url])
    expect(out).toContain('stdout:Authenticate your account at:')
    expect(out).toContain(`stderr:${url}`)
    expect(r).toMatchObject({ ok: true, code: 0, timedOut: false })
    expect(r.tail).toContain('Press ENTER')
  })

  it('reports a command that fails, and one that is not there', async () => {
    const failed = await run("console.log('npm error 403'); process.exit(3)")
    expect(failed.r).toMatchObject({ ok: false, code: 3, timedOut: false })
    expect(failed.r.tail).toContain('npm error 403')
    const missing = await streamCommand('obpal-no-such-command', [])
    expect(missing).toMatchObject({ ok: false, code: null })
  })

  it('closes stdin, so npm never waits at a prompt, and stops a command nobody approves', async () => {
    expect((await run("process.stdin.on('end', () => console.log('stdin closed')); process.stdin.resume()")).out).toContain('stdin closed')
    const stuck = await run('setTimeout(() => {}, 60000)', 300)
    expect(stuck.r).toMatchObject({ ok: false, timedOut: true })
    expect(stuck.r.ms).toBeLessThan(30000)
  })
})

describe('waiting for the registry', () => {
  /** A clock that moves only when the wait sleeps. */
  const clock = () => {
    let t = 0
    return { now: () => t, sleep: async (ms: number) => { t += ms }, at: () => t }
  }

  it('returns as soon as the check holds', async () => {
    const c = clock()
    const r = await waitUntil(async () => c.at() >= 15 && 'there', { timeoutMs: 60, intervalMs: 10, sleep: c.sleep, now: c.now })
    expect(r).toEqual({ ok: true, value: 'there', tries: 3, ms: 20 })
  })

  it('tries once more at the deadline and then gives up', async () => {
    const c = clock()
    const waits: number[] = []
    const r = await waitUntil(async () => false, { timeoutMs: 25, intervalMs: 10, sleep: c.sleep, now: c.now, onWait: (ms) => waits.push(ms) })
    expect(r).toEqual({ ok: false, value: null, tries: 4, ms: 25 })
    expect(waits).toEqual([10, 20, 25])
  })

  it('tries once when there is no time left', async () => {
    const c = clock()
    expect((await waitUntil(async () => false, { timeoutMs: 0, intervalMs: 10, sleep: c.sleep, now: c.now })).tries).toBe(1)
  })
})

describe('which tests test the packages', () => {
  it('picks those that import them, except the sims\' tests', () => {
    const picked = packageTests({
      'tests/a.test.ts': "import { x } from '@obpal/core'",
      'tests/b.test.ts': "import { y } from '../packages/host/src/stream'",
      'tests/c.test.ts': "import type { Frame } from '@obpal/host/gamepad'",
      'tests/sim-d.test.ts': "import { x } from '@obpal/core'",
      'tests/e.test.ts': "import { z } from 'three'",
      'tests/f.mjs': "import '@obpal/core'",
    })
    expect(picked).toEqual(['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'])
  })

  it('finds this repository\'s: the stream and the embed attributes are tested, a sim is not counted', () => {
    const names = ['stream', 'embed', 'sim-rover']
    const sources = Object.fromEntries(names.map((n) => [`tests/${n}.test.ts`, readText(`tests/${n}.test.ts`)]))
    expect(packageTests(sources)).toEqual(['tests/embed.test.ts', 'tests/stream.test.ts'])
  })
})

describe('the release is wired up', () => {
  const core = JSON.parse(readText('packages/core/package.json'))
  const host = JSON.parse(readText('packages/host/package.json'))

  it('is a script, and knows only --yes and --help before it touches anything', () => {
    expect(JSON.parse(readText('package.json')).scripts['publish:npm']).toBe('node scripts/publish-npm.mjs')
    const bad = runScript('scripts/publish-npm.mjs', ['--publish'])
    expect(bad.status).toBe(2)
    expect(bad.out).toContain('unknown option --publish')
    const help = runScript('scripts/publish-npm.mjs', ['--help'])
    expect(help.status).toBe(0)
    expect(help.out).toContain('dry run')
  })

  it('has a changelog for each package that names its version first, and packs it', () => {
    for (const [dir, m] of [['core', core], ['host', host]] as const) {
      const log = readText(`packages/${dir}/CHANGELOG.md`)
      expect(log.match(/^## (\S+)/m)?.[1]).toBe(m.version)
      expect(log).toMatch(/^## 0\.1\.0/m)
      expect(m.files).toEqual(['dist', 'CHANGELOG.md'])
    }
  })

  it('has host take core\'s version from the workspace, so a packed host names the core that is published with it', () => {
    expect(host.dependencies['@obpal/core']).toBe('workspace:*')
    expect(host.publishConfig.access).toBe('public')
    expect(core.publishConfig.access).toBe('public')
  })
})
