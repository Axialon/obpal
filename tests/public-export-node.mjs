/** Exercise the actual exporter in a synthetic tracked repository; every write stays in TEMP. */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseJsonc } from '../scripts/lib/deployment.mjs'
import { API } from 'typescript/unstable/sync'
import { stripTypeScriptTypes } from 'node:module'
import * as publicExport from '../scripts/lib/public-export.mjs'
import { isLocalOnly } from '../scripts/lib/scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export function trackedPublicInputs() {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', windowsHide: true }).split('\0').filter(Boolean)
}
export function readPublicSource(path) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) throw new Error('Noncanonical fixture source')
  return readFileSync(join(root, path), 'utf8')
}
/** Typecheck a virtual module and construct only the three existing CPU geometries; no renderer or browser. */
export async function inspectCatalog(text) {
  const file = join(root, 'src/viewer/__public-profile.ts').replaceAll('\\', '/')
  const config = join(root, 'src/viewer/__public-profile.json').replaceAll('\\', '/')
  const configText = JSON.stringify({ files: ['__public-profile.ts'], compilerOptions: { strict: true, noEmit: true,
    skipLibCheck: true, types: [], target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler' } })
  const api = new API({ cwd: root, fs: { readFile: path => path === file ? text : path === config ? configText : undefined,
    fileExists: path => path === file || path === config ? true : undefined } })
  let diagnostics
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const program = snapshot.getProject(config).program
      diagnostics = [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)].map(d => d.messageText ?? d.message ?? d.code)
    } finally { snapshot.dispose() }
  } finally { api.close() }
  const stub = 'data:text/javascript,' + encodeURIComponent('export function boxemCore() { throw new Error("Restricted builder executed") }')
  const code = stripTypeScriptTypes(text).replaceAll("'three'", JSON.stringify(import.meta.resolve('three')))
    .replaceAll("'three/addons/geometries/RoundedBoxGeometry.js'", JSON.stringify(import.meta.resolve('three/addons/geometries/RoundedBoxGeometry.js')))
    .replaceAll("'./boxem-core'", JSON.stringify(stub))
  const exports = await import('data:text/javascript,' + encodeURIComponent(code))
  const made = []
  for (const item of exports.CATALOG.filter(row => ['cube', 'knot', 'gem'].includes(row.id))) {
    const group = item.make()
    if (!group.isObject3D || !group.isMesh && !group.children.length) throw new Error('Empty primitive')
    made.push(item.id)
    group.traverse(object => { object.geometry?.dispose(); for (const material of [object.material].flat()) material?.dispose() })
  }
  return { ids: exports.CATALOG.map(row => row.id), categories: exports.CATEGORIES.map(row => row.id), defaultId: exports.DEFAULT_ITEM,
    art: exports.CATEGORY_ART, diagnostics, made }
}
export async function inspectFilmAssets(text, manifestText) {
  const module = 'data:text/javascript,' + encodeURIComponent(`export default ${manifestText}`)
  const code = stripTypeScriptTypes(text).replaceAll("'../public/campaign/films/manifest.json'", JSON.stringify(module))
  const worker = await import('data:text/javascript,' + encodeURIComponent(code))
  let requests = 0
  const answers = []
  for (const method of ['GET', 'HEAD']) answers.push(await worker.filmAsset(new Request('https://example.test/campaign/films/obpal-original-complete-web.mp4', { method }),
    { fetch() { requests++; throw new Error('Omitted film requested') } }, { key: async () => { throw new Error('Omitted film admission requested') }, waitUntil() {} }))
  return { inventory: worker.FILM_ASSETS, requests, answers }
}
const sha = value => createHash('sha256').update(value).digest('hex')
const fixtureGit = (dir, args, input) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
  cwd: dir, input, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
function fixtureCommit(dir) {
  const tree = fixtureGit(dir, ['write-tree'])
  // A deterministic synthetic commit needs no user identity or Git configuration change.
  const commit = fixtureGit(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nSynthetic public export fixture\n`)
  fixtureGit(dir, ['update-ref', 'HEAD', commit])
  return commit
}
function fixturePolicy(dir, paths) {
  const include = [], exclude = []
  const transform = { 'wrangler.jsonc': 'wrangler', 'src/viewer/catalog.ts': 'catalog',
    'worker/film-assets.ts': 'film-assets', 'public/campaign/films/manifest.json': 'film-manifest' }
  for (const path of paths) {
    const bytes = execFileSync('git', ['show', `:${path}`], { cwd: dir, windowsHide: true })
    if (isLocalOnly(path) || publicExport.isIndexNowProof(path) || path.startsWith('public/models/cvc/')) {
      exclude.push({ path, reason: 'Synthetic omitted input', inputSha256: sha(bytes) }); continue
    }
    include.push({ path, source: 'tooling', role: path === 'LICENSE' ? 'notice' : 'code', rights: 'MIT', noticePaths: ['LICENSE'],
      inputSha256: sha(bytes), ...(transform[path] ? { transform: transform[path] } : {}) })
  }
  include.push({ path: 'public-export.allowlist.json', source: 'tooling', role: 'policy', rights: 'MIT', noticePaths: ['LICENSE'], transform: 'policy' })
  return { schema: 1, profile: 'public-demo-v1', payloadRevision: null, include,
    exclude: [...exclude, { path: 'public-export.manifest.json', reason: 'Generated output inventory' }],
    blockedSha256: exclude.filter(row => row.path.startsWith('public/models/cvc/')).map(row => row.inputSha256),
    catalog: { items: ['cube', 'knot', 'gem'], categories: ['studio', 'local'], defaultId: 'cube' } }
}
function prepareFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'obpal-export-fixture-'))
  for (const file of ['scripts/open-source.mjs', ...['temp', 'scan', 'deployment', 'public-export', 'public-catalog'].map(name => `scripts/lib/${name}.mjs`)]) {
    mkdirSync(dirname(join(dir, file)), { recursive: true }); copyFileSync(join(root, file), join(dir, file))
  }
  for (const [path, bytes] of Object.entries({ LICENSE: 'Synthetic fixture notice\n', '.gitignore': 'node_modules/\n', ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), bytes)
  }
  fixtureGit(dir, ['init', '--quiet'])
  // Explicit file paths avoid adding the dependency junction, even with force-add.
  const paths = readdirSync(dir, { recursive: true, withFileTypes: true }).filter(e => e.isFile() &&
    !resolve(e.parentPath).startsWith(resolve(join(dir, '.git')))).map(e => join(e.parentPath, e.name).slice(dir.length + 1).replaceAll('\\', '/'))
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction')
  fixtureGit(dir, ['add', '-f', '--', ...paths])
  const policy = fixturePolicy(dir, paths)
  writeFileSync(join(dir, 'public-export.allowlist.json'), JSON.stringify(policy, null, 2) + '\n')
  // Stage only the finite fixture inventory; never recurse through node_modules.
  fixtureGit(dir, ['add', '-f', '--', ...paths, 'public-export.allowlist.json'])
  const tree = fixtureGit(dir, ['write-tree'])
  const commit = fixtureGit(dir, ['hash-object', '-t', 'commit', '-w', '--stdin'],
    `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nSynthetic public export fixture\n`)
  fixtureGit(dir, ['update-ref', 'HEAD', commit])
  return { dir, policy }
}
/** Exercise immutable inputs and the same manifest stager used by publication, without calling a publication flag. */
export function materializationFixture(mode) {
  const { dir, policy } = prepareFixture({ 'src/viewer/catalog.ts': readPublicSource('src/viewer/catalog.ts'),
    'wrangler.jsonc': readPublicSource('wrangler.jsonc'), 'public/models/cvc/private.glb': 'restricted-geometry\0',
    'worker/film-assets.ts': readPublicSource('worker/film-assets.ts'), 'worker/limits.ts': readPublicSource('worker/limits.ts'),
    'public/campaign/films/manifest.json': readPublicSource('public/campaign/films/manifest.json'),
    ...(mode === 'modes' ? { 'desktop/package/install.command': '#!/bin/sh\nexit 0\n' } : {}),
    ...(mode === 'closure' ? { 'src/consumer.ts': "import './missing-module'\n" } : {}),
    ...(mode === 'asset-closure' ? { 'src/consumer.ts': "export const model = '/models/missing.glb'\n" } : {}) })
  const out = mkdtempSync(join(tmpdir(), 'obpal-export-output-')), staged = mkdtempSync(join(tmpdir(), 'obpal-export-stage-'))
  const extraTemps = []
  try {
    if (mode === 'modes') {
      fixtureGit(dir, ['update-index', '--chmod=+x', 'desktop/package/install.command'])
      policy.payloadRevision = fixtureCommit(dir)
      policy.include.find(row => row.path === 'desktop/package/install.command').source = 'payload'
      writeFileSync(join(dir, 'public-export.allowlist.json'), JSON.stringify(policy))
      fixtureGit(dir, ['add', 'public-export.allowlist.json'])
      fixtureGit(dir, ['update-index', '--chmod=-x', 'desktop/package/install.command'])
      fixtureCommit(dir)
    }
    if (mode === 'input-hash') {
      policy.include.find(row => row.path === 'LICENSE').inputSha256 = '0'.repeat(64)
      writeFileSync(join(dir, 'public-export.allowlist.json'), JSON.stringify(policy))
      fixtureGit(dir, ['add', 'public-export.allowlist.json']); fixtureCommit(dir)
    }
    if (mode === 'link-mode') {
      const blob = fixtureGit(dir, ['hash-object', '-w', '--stdin'], '../outside')
      fixtureGit(dir, ['update-index', '--cacheinfo', `120000,${blob},LICENSE`])
    }
    if (mode === 'source-link') {
      renameSync(join(dir, 'src'), join(dir, 'saved-src')); symlinkSync(join(dir, 'saved-src'), join(dir, 'src'), 'junction')
    }
    const result = publicExport.materializePublicExport({ root: dir, out })
    if (mode === 'extra') writeFileSync(join(out, 'unexpected.txt'), 'unplanned output')
    if (mode === 'missing') rmSync(join(out, 'LICENSE'))
    if (mode === 'corrupt') writeFileSync(join(out, 'LICENSE'), 'mutated output')
    if (mode === 'manifest') writeFileSync(join(out, 'public-export.manifest.json'), '{}')
    if (mode === 'source') writeFileSync(join(dir, 'LICENSE'), 'raw source changed\r\n')
    if (mode === 'index') { writeFileSync(join(dir, 'unknown.md'), 'unclassified'); fixtureGit(dir, ['add', 'unknown.md']) }
    if (mode === 'output-link') symlinkSync(staged, join(out, 'escape'), 'junction')
    result.assertSourceUnchanged()
    publicExport.stagePublicOutput({ ...result, out, destination: staged, root: dir })
    let reproduced, stagedGitMode, reexportMode, toolingMode
    if (mode === 'reexport' || mode === 'modes') {
      fixtureGit(staged, ['init', '--quiet'])
      fixtureGit(staged, ['add', '-f', '--', ...result.files])
      if (typeof publicExport.stagePublicGitModes === 'function') publicExport.stagePublicGitModes({ destination: staged, manifest: result.manifest })
      if (mode === 'modes') {
        stagedGitMode = fixtureGit(staged, ['ls-files', '--stage', 'desktop/package/install.command']).slice(0, 6)
        toolingMode = fixtureGit(dir, ['ls-files', '--stage', 'desktop/package/install.command']).slice(0, 6)
      }
      fixtureCommit(staged)
      const again = mkdtempSync(join(tmpdir(), 'obpal-export-reproduce-')); extraTemps.push(again)
      const repeated = publicExport.materializePublicExport({ root: staged, out: again })
      reproduced = repeated.manifest.rows.every(row => readFileSync(join(again, row.path)).equals(readFileSync(join(out, row.path))) &&
        row.mode === result.manifest.rows.find(original => original.path === row.path).mode)
      reexportMode = repeated.manifest.rows.find(row => row.path === 'desktop/package/install.command')?.mode
    }
    return { error: null, paths: result.manifest.rows.map(row => row.path), stagedPaths: readdirSync(staged, { recursive: true, withFileTypes: true })
      .filter(e => e.isFile() && !resolve(e.parentPath).startsWith(resolve(join(staged, '.git')))).map(e => join(e.parentPath, e.name).slice(staged.length + 1).replaceAll('\\', '/')),
      manifest: result.manifest, catalog: readFileSync(join(staged, 'src/viewer/catalog.ts'), 'utf8'),
      config: parseJsonc(readFileSync(join(staged, 'wrangler.jsonc'), 'utf8')), publicPolicy: JSON.parse(readFileSync(join(staged, 'public-export.allowlist.json'), 'utf8')),
      reproduced, stagedGitMode, reexportMode, toolingMode }
  } catch (error) { return { error: error.message } }
  finally {
    for (const owned of [dir, out, staged, ...extraTemps]) {
      if (resolve(dirname(owned)) !== resolve(tmpdir()) || !basename(owned).startsWith('obpal-export-')) throw new Error('Unexpected fixture cleanup path')
      rmSync(owned, { recursive: true, force: true })
    }
  }
}
export function liveWithoutTarget() {
  const env = { ...process.env }
  delete env.OBPAL_PUBLIC_ORIGIN
  delete env.OBPAL_LIVE_ORIGIN
  // Even a regression to the upstream default cannot send a request from this negative fixture.
  const guard = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = () => { throw new Error("UNEXPECTED_REQUEST") }')
  const result = spawnSync(process.execPath, ['--import', guard, 'scripts/check-live.mjs'], { cwd: root, env, encoding: 'utf8', windowsHide: true })
  return { status: result.status, output: result.stdout + result.stderr }
}
/** Run the native publisher against a TEMP bare repository. The preload refuses every external command or destination. */
export function publicationFixture(mode) {
  const { dir } = prepareFixture({ 'extension/package.json': '{"version":"0.0.0-fixture"}\n' })
  const owned = mkdtempSync(join(tmpdir(), 'obpal-export-publish-'))
  const seed = join(owned, 'seed'), remote = join(owned, 'remote.git'), out = join(owned, 'out'), stage = join(owned, 'stage')
  const calls = join(owned, 'calls.jsonl'), preload = join(owned, 'preload.mjs')
  try {
    for (const path of [seed, out, stage]) mkdirSync(path)
    fixtureGit(seed, ['init', '--quiet', '-b', 'main'])
    writeFileSync(join(seed, 'README.md'), 'Existing public snapshot\n')
    fixtureGit(seed, ['add', 'README.md'])
    let baseline = fixtureCommit(seed)
    const source = fixtureGit(dir, ['rev-parse', 'HEAD'])
    fixtureGit(owned, ['clone', '--quiet', '--bare', seed, remote])
    const result = publicExport.materializePublicExport({ root: dir, out })
    publicExport.stagePublicOutput({ ...result, out, destination: stage, root: dir })
    fixtureGit(stage, ['init', '--quiet', '-b', 'main'])
    fixtureGit(stage, ['add', '-A'])
    publicExport.stagePublicGitModes({ destination: stage, manifest: result.manifest })
    const tree = fixtureGit(stage, ['write-tree'])
    if (mode === 'noop' || mode === 'noop-source') {
      fixtureGit(stage, ['fetch', '--quiet', remote, 'refs/heads/main'])
      const matching = fixtureGit(stage, ['hash-object', '-t', 'commit', '-w', '--stdin'],
        `tree ${tree}\nparent ${baseline}\nauthor Fixture <fixture@example.invalid> 2 +0000\ncommitter Fixture <fixture@example.invalid> 2 +0000\n\nExisting matching fixture snapshot\n`)
      fixtureGit(stage, ['push', '--quiet', remote, `${matching}:refs/heads/main`])
      fixtureGit(seed, ['fetch', '--quiet', remote, 'refs/heads/main'])
      baseline = matching
    }
    writeFileSync(join(seed, 'README.md'), 'A concurrent public change\n')
    fixtureGit(seed, ['add', 'README.md'])
    const driftTree = fixtureGit(seed, ['write-tree'])
    const drift = fixtureGit(seed, ['hash-object', '-t', 'commit', '-w', '--stdin'],
      `tree ${driftTree}\nparent ${baseline}\nauthor Fixture <fixture@example.invalid> 2 +0000\ncommitter Fixture <fixture@example.invalid> 2 +0000\n\nConcurrent fixture change\n`)
    fixtureGit(seed, ['update-ref', 'HEAD', drift])
    // Copy the synthetic drift object without advancing the remote until the selected race.
    fixtureGit(seed, ['push', '--quiet', remote, `${drift}:refs/fixture/drift`])
    const settings = { mode, remote, calls, dir, drift, repository: 'example-owner/controller' }
    writeFileSync(preload, `import cp from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const settings = ${JSON.stringify(settings)}
const run = cp.execFileSync
const url = 'https://github.com/' + settings.repository + '.git'
let lookups = 0
cp.execFileSync = (command, args, options = {}) => {
  if (command === 'gh') {
    appendFileSync(settings.calls, JSON.stringify({ command, args }) + '\\n')
    if (args[0] !== 'repo' || args[1] !== 'view') throw new Error('Unexpected external command')
    if (settings.mode === 'lookup') throw new Error('Synthetic repository lookup failure')
    const meta = { nameWithOwner: settings.repository, isPrivate: settings.mode === 'private', defaultBranchRef: { name: 'main' } }
    if (settings.mode === 'repository') meta.nameWithOwner = 'other-owner/controller'
    if (settings.mode === 'branch') meta.defaultBranchRef.name = 'other'
    return JSON.stringify(meta)
  }
  if (command !== 'git') throw new Error('Unexpected external command')
  if (args.includes('commit') && settings.mode === 'identity') options = { ...options, env: { ...options.env,
    GIT_AUTHOR_NAME: 'Unexpected fixture identity', GIT_AUTHOR_EMAIL: 'unexpected@example.invalid',
    GIT_COMMITTER_NAME: 'Unexpected fixture identity', GIT_COMMITTER_EMAIL: 'unexpected@example.invalid' } }
  if (args.includes('commit') && settings.mode === 'parent') args = [...args, '--amend']
  const operation = args.find(value => ['clone', 'ls-remote', 'fetch', 'push'].includes(value))
  if (operation) {
    appendFileSync(settings.calls, JSON.stringify({ command, args }) + '\\n')
    if (operation === 'ls-remote' || operation === 'clone') {
      if (!args.includes(url)) throw new Error('Unexpected repository destination')
      if (operation === 'ls-remote') lookups++
      if (settings.mode === 'drift' && lookups === 2 || settings.mode === 'clone-race' && operation === 'clone') {
        run('git', ['--git-dir', settings.remote, 'update-ref', 'refs/heads/main', settings.drift])
      }
      if (settings.mode === 'source' && lookups === 1) writeFileSync(join(settings.dir, 'LICENSE'), 'Changed source\\n')
      if (settings.mode === 'noop-source' && lookups === 2) writeFileSync(join(settings.dir, 'LICENSE'), 'Changed source after staging\\n')
      return run(command, args.map(value => value === url ? settings.remote : value), options)
    }
    const actual = run('git', ['remote', 'get-url', 'origin'], { cwd: options.cwd, encoding: 'utf8' }).trim()
    if (actual !== settings.remote) throw new Error('Unexpected transport destination')
    if (settings.mode === 'push' && operation === 'push') throw new Error('Synthetic push rejection')
    if (settings.mode === 'readback' && operation === 'fetch') throw new Error('Synthetic readback failure')
  }
  const result = run(command, args, options)
  if (args.includes('commit') && settings.mode === 'extra-parent') {
    run('git', ['fetch', '--quiet', settings.remote, 'refs/fixture/drift'], options)
    const parent = run('git', ['rev-parse', 'HEAD^'], options).trim()
    const raw = run('git', ['cat-file', 'commit', 'HEAD'], options)
    const changed = raw.replace('parent ' + parent + '\\n', 'parent ' + parent + '\\nparent ' + settings.drift + '\\n')
    if (changed === raw) throw new Error('Synthetic parent mutation did not apply')
    const commit = run('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { ...options, input: changed }).trim()
    run('git', ['update-ref', 'HEAD', commit], options)
    const parents = run('git', ['show', '-s', '--format=%P', commit], options).trim().split(' ')
    appendFileSync(settings.calls, JSON.stringify({ command: 'fixture', args: ['extra-parent', ...parents] }) + '\\n')
  }
  return result
}
syncBuiltinESMExports()
`)
    const env = { ...process.env, OBPAL_PUBLIC_REPOSITORY: settings.repository, OBPAL_PUBLIC_ORIGIN: 'https://controller.example.org',
      OBPAL_SNAPSHOT_AUTHOR_NAME: 'Example contributor', OBPAL_SNAPSHOT_AUTHOR_EMAIL: 'contributor@users.noreply.github.com',
      OBPAL_PUBLIC_SOURCE: mode === 'source-pin' ? '0'.repeat(40) : source,
      OBPAL_PUBLIC_BASELINE: mode === 'baseline' ? '0'.repeat(40) : baseline,
      OBPAL_PUBLIC_TREE: mode === 'tree' ? '0'.repeat(40) : tree }
    // An inherited Git author cannot override the explicitly selected public identity.
    env.GIT_AUTHOR_NAME = 'Inherited fixture identity'; env.GIT_AUTHOR_EMAIL = 'inherited@example.invalid'
    env.GIT_COMMITTER_NAME = 'Inherited fixture identity'; env.GIT_COMMITTER_EMAIL = 'inherited@example.invalid'
    if (mode === 'pins') delete env.OBPAL_PUBLIC_TREE
    const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, 'scripts/open-source.mjs', '--publish'],
      { cwd: dir, env, encoding: 'utf8', windowsHide: true })
    const head = fixtureGit(owned, ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])
    return { status: child.status, output: child.stdout + child.stderr, baseline, source, tree, head,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [],
      publicTree: fixtureGit(owned, ['--git-dir', remote, 'rev-parse', `${head}^{tree}`]),
      parent: fixtureGit(owned, ['--git-dir', remote, 'show', '-s', '--format=%P', head]),
      identity: fixtureGit(owned, ['--git-dir', remote, 'show', '-s', '--format=%an%n%ae%n%cn%n%ce', head]).split('\n') }
  } finally {
    for (const path of [dir, owned]) {
      if (resolve(dirname(path)) !== resolve(tmpdir()) || !basename(path).startsWith('obpal-export-')) throw new Error('Unexpected fixture cleanup path')
      rmSync(path, { recursive: true, force: true })
    }
  }
}
export function exportFixture(files) {
  const { dir: fixture } = prepareFixture(files)
  let out
  try {
    const result = spawnSync(process.execPath, ['scripts/open-source.mjs', '--keep-logs'], { cwd: fixture, encoding: 'utf8', windowsHide: true })
    const output = result.stdout + result.stderr
    out = /(?:-> |in the export \()([^\r\n)]+)/.exec(output)?.[1]
    if (out && (resolve(dirname(out)) !== resolve(tmpdir()) || !basename(out).startsWith('obpal-open-source-'))) throw new Error('Unexpected fixture export path')
    return { status: result.status, output,
      config: out && existsSync(join(out, 'wrangler.jsonc')) ? parseJsonc(readFileSync(join(out, 'wrangler.jsonc'), 'utf8')) : null,
      files: out ? readdirSync(out, { recursive: true }).map(path => path.replaceAll('\\', '/')) : [],
      readme: out && existsSync(join(out, 'README.md')) ? readFileSync(join(out, 'README.md'), 'utf8') : '',
    }
  } finally {
    if (out && resolve(dirname(out)) === resolve(tmpdir()) && basename(out).startsWith('obpal-open-source-')) rmSync(out, { recursive: true, force: true })
    rmSync(fixture, { recursive: true, force: true })
  }
}
