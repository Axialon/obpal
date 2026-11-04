/** Self-host defaults are built from shared runtime bindings, never from production destinations or payment vars. */
import { parseJsonc } from './deployment.mjs'
import { isLocalOnly, PRIVATE_RULES, SECRET_RULES, riskyPath, scanText } from './scan.mjs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { projectPublicArena, projectPublicCampaign, projectPublicCatalog, projectPublicFilmManifest, projectPublicFilmAssets } from './public-catalog.mjs'
import * as ast from 'typescript/unstable/ast'
import { API } from 'typescript/unstable/sync'
import { createVirtualFileSystem } from 'typescript/unstable/fs'

export function selfHostWrangler(text) {
  const source = parseJsonc(text)
  const config = {}
  for (const key of ['$schema', 'main', 'compatibility_date', 'assets', 'durable_objects', 'migrations', 'observability', 'ratelimits']) {
    if (source[key] !== undefined) config[key] = source[key]
  }
  config.name = 'my-controller'
  config.workers_dev = false
  config.routes = []
  if (config.ratelimits) config.ratelimits = config.ratelimits.map((binding, i) => ({ ...binding, namespace_id: String(i + 1) }))
  config.vars = { STRIPE_SPONSORSHIP_ENABLED: 'false', GITHUB_SPONSORS_PENDING: 'false' }
  // The current address-hashing code needs one existing secret even without a relay. TURN_SECRET alone enables no TURN.
  config.secrets = { required: ['TURN_SECRET'] }
  return '// Self-host template: choose your Worker name, account and custom domain; see docs/SELF-HOSTING.md.\n'
    + '// Payments are disabled. Set your own address-hashing secret before deployment.\n' + JSON.stringify(config, null, 2) + '\n'
}

/** Ownership proof for a search service belongs to the operator that generated it. */
export const isIndexNowProof = path => /^public\/[a-f0-9]{32}\.txt$/.test(path)

/** Return only file paths and rule descriptions, never a token or matched private text. */
export function exportProblems(path, bytes, { deny = [], vendored = false } = {}) {
  const risky = riskyPath(path)
  if (risky) return [`${path}: ${risky}`]
  if (bytes.length > 64 << 20) return [`${path}: larger than 64 MB, too large to scan`]
  const binary = bytes.subarray(0, 8192).includes(0)
  if (binary && vendored) return []
  const text = Buffer.from(bytes).toString(binary ? 'latin1' : 'utf8')
  return scanText(text, { rules: [...SECRET_RULES, ...PRIVATE_RULES], deny })
    .map(finding => `${path}: ${finding.what}${binary ? ' (in binary data)' : ''}`)
}

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))
const keys = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key)) &&
  Reflect.ownKeys(value).every(key => required.includes(key) || optional.includes(key))
const roles = new Set(['code', 'asset', 'notice', 'policy', 'documentation'])
const rights = new Set(['MIT', 'Apache-2.0', 'OFL-1.1', 'CC0-1.0', 'BSD-3-Clause', 'source-notices', 'notice-context', 'project-trademark-policy'])
const transforms = new Set(['wrangler', 'catalog', 'arena', 'campaign', 'film-manifest', 'film-assets', 'policy'])
const coaching = new Set(['attempt', 'adapter', 'evidence', 'client'].flatMap(name =>
  [`src/sim/arm/coach/${name}.ts`, `tests/coach-${name}.test.ts`]))
const assetPath = path => /\.(?:glb|gltf|svg|png|jpe?g|webp|gif|mp4|webm|mp3|wav|ogg|wasm|task|woff2?|otf|ttf|blend|pdf|zip)$/i.test(path)
const fail = message => { throw new Error(`Public export policy: ${message}`) }
function pathKey(path) {
  if (typeof path !== 'string' || !path || path !== path.trim() || path.normalize('NFC') !== path ||
    /[\x00-\x1f\\:*?"<>|]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) fail('noncanonical path')
  return path.toLowerCase()
}
function restricted(path) {
  const lower = path.toLowerCase()
  return /^public\/models\/(?:cvc|blackboxes)\//.test(lower) || lower === 'src/viewer/boxem-core.ts'
}

/** Classification is an explicitly reviewed input, not an inference that an asset inherits the code licence. */
export function selectPublicFiles(trackedPaths, policy) {
  if (!keys(policy, ['schema', 'profile', 'payloadRevision', 'include', 'exclude', 'blockedSha256', 'catalog']) ||
    policy.schema !== 1 || policy.profile !== 'public-demo-v1' ||
    policy.payloadRevision !== null && (typeof policy.payloadRevision !== 'string' || !/^[a-f0-9]{40}$/.test(policy.payloadRevision)) ||
    !Array.isArray(policy.include) || !Array.isArray(policy.exclude) || !Array.isArray(policy.blockedSha256) ||
    !policy.blockedSha256.every(hash)) fail('unknown schema or source identity')
  const c = policy.catalog
  if (!keys(c, ['items', 'categories', 'defaultId']) || JSON.stringify(c.items) !== '["cube","knot","gem"]' ||
    JSON.stringify(c.categories) !== '["studio","local"]' || c.defaultId !== 'cube') fail('unknown public catalogue')
  const classified = new Map(), included = new Map(), blocked = new Set(policy.blockedSha256)
  for (const row of policy.include) {
    if (!keys(row, ['path', 'role', 'source', 'rights', 'noticePaths'], ['inputSha256', 'provenance', 'transform'])) fail('unknown inclusion fields')
    const key = pathKey(row.path)
    if (classified.has(key)) fail('duplicate or case-colliding path')
    classified.set(key, row)
    if (!roles.has(row.role) || !['payload', 'tooling'].includes(row.source) || !rights.has(row.rights) ||
      !Array.isArray(row.noticePaths) || row.noticePaths.some(path => typeof path !== 'string')) fail('unverified rights or role')
    row.noticePaths.forEach(pathKey)
    const context = row.path === 'public/models/cvc/NOTICE.md' && row.role === 'notice' && row.rights === 'notice-context'
    if (isLocalOnly(row.path) || riskyPath(row.path) || key === '.git' || key.startsWith('.git/') ||
      coaching.has(key) || restricted(row.path) && !context || isIndexNowProof(row.path)) fail('private, restricted or unapproved input')
    const self = row.path === 'public-export.allowlist.json' && row.role === 'policy' && row.transform === 'policy'
    if ((!self || row.inputSha256 !== undefined) && !hash(row.inputSha256)) fail('missing pinned input digest')
    if (blocked.has(row.inputSha256)) fail('restricted digest under a renamed or relabelled path')
    if (row.transform !== undefined && !transforms.has(row.transform)) fail('unknown projection')
    if (assetPath(row.path) && row.role !== 'asset') fail('asset cannot inherit a code or notice role')
    if (row.role === 'asset') {
      if (!hash(row.inputSha256) || !keys(row.provenance, ['kind', 'reference']) ||
        !['original', 'vendor', 'brand'].includes(row.provenance.kind) || typeof row.provenance.reference !== 'string' ||
        !row.provenance.reference || row.provenance.reference.length > 512 ||
        ['source-notices', 'notice-context'].includes(row.rights) || !row.noticePaths.length) fail('asset lacks reviewed provenance or rights')
    }
    included.set(row.path, row)
  }
  const exclusions = new Map()
  for (const row of policy.exclude) {
    if (!keys(row, ['path', 'reason'], ['inputSha256']) || typeof row.reason !== 'string' || !row.reason || row.reason.length > 120 ||
      row.inputSha256 !== undefined && !hash(row.inputSha256)) fail('unknown exclusion classification')
    const key = pathKey(row.path)
    if (classified.has(key)) fail('duplicate, case collision or inclusion/exclusion overlap')
    classified.set(key, row); exclusions.set(row.path, row)
  }
  for (const row of included.values()) for (const notice of row.noticePaths) {
    if (included.get(notice)?.role !== 'notice') fail('missing original notice')
  }
  const present = new Set(), selected = [], omissions = []
  for (const path of trackedPaths) {
    const key = pathKey(path)
    if (present.has(key)) fail('duplicate tracked path')
    present.add(key)
    const row = classified.get(key)
    if (!row || row.path !== path) fail(`unclassified tracked path: ${path}`)
    if (included.has(path)) selected.push(row)
    else omissions.push({ ...exclusions.get(path) })
  }
  // A policy may anticipate exclusions, but never silently omit a required runtime or original notice.
  for (const path of included.keys()) if (!present.has(pathKey(path))) fail(`missing required input: ${path}`)
  return { payloadRevision: policy.payloadRevision, catalog: structuredClone(c), inputs: selected.map(row => structuredClone(row)),
    copyPaths: selected.filter(row => !row.transform).map(row => row.path),
    transforms: selected.filter(row => row.transform).map(row => ({ path: row.path, kind: row.transform })), omissions }
}

/** Check the one output inventory; filesystem byte/link verification is performed before materialization/staging. */
export function verifyPublicOutput(plan, manifest, actualPaths) {
  const problems = [], expected = new Map(plan.inputs.map(row => [row.path, row]))
  if (!keys(manifest, ['schema', 'profile', 'policySha256', 'rows']) || manifest.schema !== 1 ||
    manifest.profile !== 'public-demo-v1' || !hash(manifest.policySha256) || !Array.isArray(manifest.rows)) return ['manifest: unknown schema or fields']
  const rows = new Map(), actual = new Set()
  for (const path of actualPaths) {
    try { const key = pathKey(path); if (actual.has(key)) problems.push('output: duplicate or case-colliding path'); actual.add(key) }
    catch { problems.push('output: noncanonical path') }
  }
  for (const row of manifest.rows) {
    if (!keys(row, ['path', 'sha256', 'bytes', 'mode', 'role', 'noticePaths'], ['sourcePath', 'sourceSha256'])) { problems.push('manifest: unknown row fields'); continue }
    try { pathKey(row.path) } catch { problems.push('manifest: noncanonical path'); continue }
    const input = expected.get(row.path)
    if (!input || rows.has(row.path.toLowerCase())) { problems.push(`${row.path}: unexpected or duplicate row`); continue }
    rows.set(row.path.toLowerCase(), row)
    if (!hash(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > 64 << 20 ||
      row.role !== input.role || JSON.stringify(row.noticePaths) !== JSON.stringify(input.noticePaths) || row.sourcePath !== input.path ||
      row.sourceSha256 !== (input.inputSha256 ?? manifest.policySha256)) problems.push(`${row.path}: output/source binding differs`)
    if (!input.transform && row.sha256 !== input.inputSha256) problems.push(`${row.path}: copied bytes differ from pinned source`)
    if (!['100644', '100755'].includes(row.mode) || plan.inputModes && row.mode !== plan.inputModes[row.path]) problems.push(`${row.path}: output mode differs from immutable source`)
  }
  for (const path of expected.keys()) {
    if (!rows.has(path.toLowerCase()) || !actual.has(path.toLowerCase())) problems.push(`${path}: missing planned output`)
  }
  for (const path of actualPaths) if (path !== 'public-export.manifest.json' && !expected.has(path)) problems.push(`${path}: unplanned output`)
  if (!actual.has('public-export.manifest.json')) problems.push('manifest: missing metadata file')
  return problems
}

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const git = (root, args, input) => execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
  cwd: root, input, maxBuffer: 512 << 20, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
const gitText = (root, args) => git(root, args).toString('utf8').trim()

/** Reject links and reparse-point parents before reading any bytes, including excluded tracked inputs. */
function regularPath(root, path) {
  pathKey(path)
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) fail(`${path}: unexpected link`)
    if (current !== join(root, path) && !stat.isDirectory()) fail(`${path}: invalid parent`)
  }
  const actual = realpathSync(current), base = realpathSync(root)
  if (!actual.toLowerCase().startsWith((base + sep).toLowerCase()) || !lstatSync(current).isFile()) fail(`${path}: source escaped root or is not a regular file`)
  return current
}
function checkedRoot(root) {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) fail('unexpected root link or mode')
}
function sourceFreeze(root) {
  checkedRoot(root)
  const revision = gitText(root, ['rev-parse', '--verify', 'HEAD'])
  const indexPath = resolve(root, gitText(root, ['rev-parse', '--git-path', 'index']))
  const entries = git(root, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean).map(row => {
    const [header, path] = row.split('\t'), [mode, object, stage] = header.split(' ')
    if (!['100644', '100755'].includes(mode) || stage !== '0') fail('source index has an unexpected link, mode or conflict')
    pathKey(path)
    return { path, mode, object }
  })
  const policyBytes = git(root, ['show', `${revision}:public-export.allowlist.json`])
  let policy
  try { policy = JSON.parse(policyBytes) } catch { fail('malformed committed policy') }
  const plan = selectPublicFiles(entries.map(row => row.path), policy)
  // Verify the worktree against the admitted commit before capturing raw bytes (CRLF worktrees remain valid).
  try { git(root, ['diff', '--quiet']); git(root, ['diff', '--cached', '--quiet', revision]) }
  catch { fail('source or index differs from the committed tooling revision') }
  const raw = entries.map(row => ({ path: row.path, sha256: digest(readFileSync(regularPath(root, row.path))) }))
  const indexSha256 = digest(readFileSync(indexPath))
  const assertSourceUnchanged = () => {
    if (gitText(root, ['rev-parse', '--verify', 'HEAD']) !== revision) fail('source revision changed during export')
    if (digest(readFileSync(indexPath)) !== indexSha256) fail('index changed during export')
    for (const row of raw) if (digest(readFileSync(regularPath(root, row.path))) !== row.sha256) fail(`${row.path}: source changed during export`)
  }
  return { revision, policy, policyBytes, plan, assertSourceUnchanged, source: { revision, indexSha256, raw } }
}

/** Batch immutable Git blobs; no output is copied from a mutable worktree. */
function inputBlobs(root, revision, plan) {
  const inputModes = {}
  for (const ref of new Set([revision, plan.payloadRevision].filter(Boolean))) {
    const modes = new Map(git(root, ['ls-tree', '-r', '-z', ref]).toString('utf8').split('\0').filter(Boolean).map(row => {
      const [header, path] = row.split('\t'); return [path, header.split(' ')[0]]
    }))
    for (const row of plan.inputs.filter(row => (row.source === 'payload' ? plan.payloadRevision ?? revision : revision) === ref)) {
      if (!['100644', '100755'].includes(modes.get(row.path))) fail(`${row.path}: immutable source has an unexpected link or mode`)
      inputModes[row.path] = modes.get(row.path)
    }
  }
  const queries = plan.inputs.map(row => `${row.source === 'payload' ? plan.payloadRevision ?? revision : revision}:${row.path}`)
  const buffer = git(root, ['cat-file', '--batch'], queries.join('\n') + '\n'), blobs = new Map()
  let offset = 0
  for (const row of plan.inputs) {
    const end = buffer.indexOf(10, offset), header = buffer.subarray(offset, end).toString('utf8').split(' ')
    if (end < 0 || header[1] !== 'blob' || !/^\d+$/.test(header[2])) fail(`${row.path}: missing immutable input blob`)
    const length = Number(header[2]); offset = end + 1
    if (length > 64 << 20 || offset + length >= buffer.length) fail(`${row.path}: input is too large or truncated`)
    const bytes = buffer.subarray(offset, offset + length); offset += length + 1
    if (row.inputSha256 && digest(bytes) !== row.inputSha256) fail(`${row.path}: input digest differs from the reviewed policy`)
    blobs.set(row.path, bytes)
  }
  return { blobs, inputModes }
}

const transformPaths = { wrangler: 'wrangler.jsonc', catalog: 'src/viewer/catalog.ts', arena: 'src/sim/arena.ts',
  campaign: 'campaign/index.html', 'film-manifest': 'public/campaign/films/manifest.json', 'film-assets': 'worker/film-assets.ts', policy: 'public-export.allowlist.json' }
function project(row, bytes, policy, blobs) {
  if (!row.transform) return bytes
  if (transformPaths[row.transform] !== row.path) fail(`${row.path}: projection assigned to an unapproved consumer`)
  const fix = { wrangler: selfHostWrangler, catalog: text => projectPublicCatalog(text, policy), arena: projectPublicArena,
    campaign: projectPublicCampaign, 'film-manifest': projectPublicFilmManifest,
    'film-assets': text => projectPublicFilmAssets(text, blobs.get('public/campaign/films/manifest.json').toString('utf8')) }[row.transform]
  if (!fix) fail('unknown materialized projection')
  return Buffer.from(fix(bytes.toString('utf8')))
}

function actualFiles(root, manifest, allowGit = false) {
  checkedRoot(root)
  const files = [], directories = new Set()
  for (const path of [...manifest.rows.map(row => row.path), 'public-export.manifest.json']) {
    const parts = path.split('/'); parts.pop()
    while (parts.length) { directories.add(parts.join('/')); parts.pop() }
  }
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name), rel = relative(root, file).replaceAll('\\', '/')
      const stat = lstatSync(file)
      if (stat.isSymbolicLink()) fail(`${rel}: unexpected output link`)
      if (allowGit && dir === root && rel === '.git' && stat.isDirectory()) continue
      pathKey(rel)
      if (stat.isDirectory()) {
        if (!directories.has(rel)) fail(`${rel}: unplanned output directory`)
        walk(file)
      } else if (stat.isFile()) files.push(rel)
      else fail(`${rel}: unexpected output mode`)
    }
  }
  walk(root)
  return files.sort()
}
const vendoredFiles = {
  'public/models/vision_wasm_internal.wasm': 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm',
  'public/models/vision_wasm_nosimd_internal.wasm': 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm',
}
/** Validate every actual byte and scan the entire inventory, including generated policy and manifest metadata. */
export function verifyPublicDirectory({ out, plan, manifest, root, deny = [], allowGit = false }) {
  const actual = actualFiles(out, manifest, allowGit), problems = verifyPublicOutput(plan, manifest, actual)
  if (problems.length) fail(problems.join('; '))
  let saved
  try { saved = JSON.parse(readFileSync(regularPath(out, 'public-export.manifest.json'), 'utf8')) } catch { fail('output metadata is malformed') }
  if (JSON.stringify(saved) !== JSON.stringify(manifest)) fail('output metadata differs from the authoritative manifest')
  const rows = new Map(manifest.rows.map(row => [row.path, row]))
  const blocked = new Set(plan.omissions.map(row => row.inputSha256).filter(Boolean))
  for (const path of actual) {
    const bytes = readFileSync(regularPath(out, path)), row = rows.get(path)
    if (row && (bytes.length !== row.bytes || digest(bytes) !== row.sha256)) fail(`${path}: output bytes differ from the authoritative manifest`)
    if (row && process.platform !== 'win32' && !!(lstatSync(join(out, path)).mode & 0o111) !== (row.mode === '100755')) fail(`${path}: filesystem executable mode differs from the manifest`)
    if (blocked.has(digest(bytes))) fail(`${path}: excluded bytes in output`)
    const vendor = vendoredFiles[path]
    const vendored = !!vendor && !!root && existsSync(join(root, vendor)) && readFileSync(join(root, vendor)).equals(bytes)
    problems.push(...exportProblems(path, bytes, { deny, vendored }))
  }
  if (problems.length) fail(problems.join('; '))
  const closure = publicClosureProblems({ out, manifest })
  if (closure.length) fail(closure.join('; '))
  return { files: actual, manifestSha256: digest(readFileSync(join(out, 'public-export.manifest.json'))) }
}

/** Static source, HTML/CSS, original model and notice closure complements (and does not replace) the fresh build. */
export function publicClosureProblems({ out, manifest }) {
  const files = new Set(manifest.rows.map(row => row.path)), problems = [], virtual = {}
  const extensions = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '.json', '.css', '.d.ts', '/index.ts', '/index.mjs', '/index.js']
  const normalized = path => relative(out, resolve(out, path)).replaceAll('\\', '/')
  const resolveImport = (owner, spec) => {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return
    const clean = spec.split(/[?#]/)[0], path = normalized(join(dirname(owner), clean))
    // These entry URLs are generated by the checked-in build definitions, rather than copied source files.
    const generated = { 'embed/index.html:/embed.js': ['packages/host/src/embed.ts', 'vite.config.ts'],
      'extension/options.html:/first-paint.js': ['extension/src/ui/first-paint.ts', 'extension/vite.config.ts'] }[`${owner}:${clean}`]
    if (generated?.every(path => files.has(path))) return
    // Browser probes install these exact routes from the existing helper; they are never site imports.
    const route = { 'scripts/lib/smoothness-motion.mjs:/__smoothness_three.js': 'scripts/lib/smoothness-motion.mjs',
      'scripts/humanoid-soft-proof.mjs:/__smoothness_three.js': 'scripts/lib/smoothness-motion.mjs',
      'scripts/lib/temporal.mjs:/__temporal_three.js': 'scripts/lib/temporal.mjs' }[`${owner}:${clean}`]
    if (route && files.has(route) && readFileSync(join(out, route), 'utf8').includes(`route('**/${clean.slice(1)}'`)) return
    const scope = owner.startsWith('extension/') ? 'extension/' : ''
    const candidates = clean.startsWith('/') ? [`${scope}${clean.slice(1)}`, `${scope}public/${clean.slice(1)}`] : [path]
    if (!candidates.some(base => extensions.some(ext => files.has(base + ext) || ext === '' && base.endsWith('.js') && files.has(base.slice(0, -3) + '.ts')))) {
      problems.push(`${owner}: unresolved import ${clean}`)
    }
  }
  const asset = (owner, spec, publicPath = false) => {
    const clean = spec.split(/[?#]/)[0]
    if (!clean || /^(?:[a-z]+:|\/\/)/i.test(clean)) return
    const path = clean.startsWith('/') ? `public/${clean.slice(1)}` : normalized(join(dirname(owner), clean))
    if (!files.has(path) && !(publicPath && clean.startsWith('/') && files.has(clean.slice(1)))) problems.push(`${owner}: missing asset ${clean}`)
  }
  for (const path of files) {
    for (const notice of manifest.rows.find(row => row.path === path).noticePaths) if (!files.has(notice)) problems.push(`${path}: missing original notice`)
    if (/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(path)) virtual[resolve(out, path).replaceAll('\\', '/')] = readFileSync(join(out, path), 'utf8')
    // Capture templates are served by their harness, not the site's or extension's page roots.
    if (/\.html$/.test(path) && !path.startsWith('scripts/') && !path.startsWith('extension/store/')) {
      const text = readFileSync(join(out, path), 'utf8')
      for (const match of text.matchAll(/<(script|link|img|video|source)\b[^>]*>/gi)) {
        for (const attr of match[0].matchAll(/\b(src|href|poster)\s*=\s*["']([^"']+)["']/gi)) {
          const spec = attr[2]
          if (match[1].toLowerCase() === 'script' && /\.(?:[cm]?[jt]s)(?:[?#]|$)/.test(spec)) resolveImport(path, spec)
          else if (/\.(?:css|svg|png|jpe?g|woff2?|webm|mp4|webmanifest)(?:[?#]|$)/.test(spec)) asset(path, spec, true)
        }
      }
    }
    if (/\.css$/.test(path)) for (const match of readFileSync(join(out, path), 'utf8').matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) asset(path, match[1], true)
    if (/\.glb$/.test(path)) {
      const bytes = readFileSync(join(out, path))
      try {
        if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(16) !== 0x4e4f534a) throw new Error('header')
        const model = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'))
        for (const row of [...model.buffers ?? [], ...model.images ?? []]) if (row.uri) asset(path, row.uri)
      } catch { problems.push(`${path}: model resource closure cannot be read`) }
    }
  }
  const config = resolve(out, '__public_closure__.json').replaceAll('\\', '/')
  virtual[config] = JSON.stringify({ files: Object.keys(virtual), compilerOptions: { allowJs: true, noLib: true, noResolve: true, types: [], target: 'ES2020' } })
  const api = new API({ fs: createVirtualFileSystem(virtual) })
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] })
    try {
      const program = snapshot.getProject(config).program
      for (const file of Object.keys(virtual).filter(file => file !== config)) {
        const source = program.getSourceFile(file), owner = normalized(file)
        if (!source || program.getSyntacticDiagnostics(file).length) { problems.push(`${owner}: source closure cannot be parsed`); continue }
        const visit = node => {
          if ((ast.isImportDeclaration(node) || ast.isExportDeclaration(node)) && node.moduleSpecifier && ast.isStringLiteral(node.moduleSpecifier)) resolveImport(owner, node.moduleSpecifier.text)
          if (ast.isImportTypeNode(node) && ast.isLiteralTypeNode(node.argument) && ast.isStringLiteral(node.argument.literal)) resolveImport(owner, node.argument.literal.text)
          if (ast.isCallExpression(node) && (node.expression.kind === ast.SyntaxKind.ImportKeyword || ast.isIdentifier(node.expression) && node.expression.text === 'require') &&
            node.arguments[0] && ast.isStringLiteral(node.arguments[0])) resolveImport(owner, node.arguments[0].text)
          if (/^(?:src|worker|packages|extension\/src)\//.test(owner) && ast.isNewExpression(node) && ast.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.length === 2 &&
            ast.isStringLiteral(node.arguments[0]) && node.arguments[1].getText() === 'import.meta.url' && /\.[a-z0-9]+$/i.test(node.arguments[0].text)) asset(owner, node.arguments[0].text)
          if ((owner.startsWith('src/') || owner.startsWith('worker/')) && ast.isStringLiteral(node) &&
            /^\/(?:models|fonts)\/.+\.(?:glb|svg|js|wasm|task|woff2?)$/.test(node.text)) asset(owner, node.text)
          if (owner === 'src/sim/kit/models.ts' && ast.isTypeAliasDeclaration(node) && node.name.text === 'Prototype') {
            if (!ast.isUnionTypeNode(node.type) || node.type.types.some(type => !ast.isLiteralTypeNode(type) || !ast.isStringLiteral(type.literal))) problems.push(`${owner}: unknown dynamic model inventory`)
            else for (const type of node.type.types) asset(owner, `/models/${type.literal.text}.glb`)
          }
          if (owner === 'worker/film-assets.ts' && ast.isVariableDeclaration(node) && ast.isIdentifier(node.name) && node.name.text === 'FILM_ASSETS') {
            if (!ast.isPropertyAccessExpression(node.initializer) || node.initializer.getText() !== 'filmManifest.films' ||
              !files.has('public/campaign/films/manifest.json') || JSON.parse(readFileSync(join(out, 'public/campaign/films/manifest.json'), 'utf8')).films.length) {
              problems.push(`${owner}: runtime film inventory does not match the empty public manifest`)
            }
          }
          node.forEachChild(visit)
        }
        visit(source)
      }
    } finally { snapshot.dispose() }
  } finally { api.close() }
  return [...new Set(problems)].sort()
}

/** One plan produces one inventory; the public policy describes only included, already-projected source. */
export function materializePublicExport({ root, out, deny = [] }) {
  checkedRoot(out)
  if (readdirSync(out).length) fail('output directory must be empty')
  const frozen = sourceFreeze(root), { policy, policyBytes, plan, revision, assertSourceUnchanged } = frozen
  const { blobs, inputModes } = inputBlobs(root, revision, plan), output = new Map()
  plan.inputModes = inputModes
  for (const row of plan.inputs) if (row.transform !== 'policy') output.set(row.path, project(row, blobs.get(row.path), policy, blobs))
  const projectedPolicy = { ...policy, payloadRevision: null, include: plan.inputs.map(row => ({ ...row, source: 'tooling',
    ...(row.transform === 'policy' ? {} : { inputSha256: digest(output.get(row.path)) }) })),
    exclude: [{ path: 'public-export.manifest.json', reason: 'Generated output inventory; regenerated from the verified policy' }], blockedSha256: [] }
  // The policy's own hash is external; it cannot recursively pin itself.
  const self = projectedPolicy.include.find(row => row.transform === 'policy')
  if (!self) fail('missing generated policy row')
  delete self.inputSha256
  output.set(self.path, jsonBytes(projectedPolicy))
  const manifest = { schema: 1, profile: 'public-demo-v1', policySha256: digest(policyBytes), rows: plan.inputs.map(row => ({
    path: row.path, sourcePath: row.path, sourceSha256: row.inputSha256 ?? digest(policyBytes), sha256: digest(output.get(row.path)),
    bytes: output.get(row.path).length, mode: inputModes[row.path], role: row.role, noticePaths: [...row.noticePaths],
  })).sort((a, b) => a.path.localeCompare(b.path, 'en')) }
  for (const row of manifest.rows) {
    mkdirSync(dirname(join(out, row.path)), { recursive: true }); writeFileSync(join(out, row.path), output.get(row.path))
    chmodSync(join(out, row.path), row.mode === '100755' ? 0o755 : 0o644)
  }
  writeFileSync(join(out, 'public-export.manifest.json'), jsonBytes(manifest))
  const verification = verifyPublicDirectory({ out, plan, manifest, root, deny })
  assertSourceUnchanged()
  return { plan, manifest, source: frozen.source, ...verification, assertSourceUnchanged }
}

/** Both offline publication fixtures and the publisher use this inventory; no source file list is consulted again. */
export function stagePublicOutput({ out, destination, plan, manifest, root, deny = [], assertSourceUnchanged = () => {} }) {
  assertSourceUnchanged()
  const verified = verifyPublicDirectory({ out, plan, manifest, root, deny })
  checkedRoot(destination)
  if (readdirSync(destination).some(path => path !== '.git')) fail('staging directory must be empty apart from Git metadata')
  for (const path of verified.files) {
    mkdirSync(dirname(join(destination, path)), { recursive: true })
    writeFileSync(join(destination, path), readFileSync(regularPath(out, path)))
    const mode = manifest.rows.find(row => row.path === path)?.mode ?? '100644'
    chmodSync(join(destination, path), mode === '100755' ? 0o755 : 0o644)
  }
  const staged = verifyPublicDirectory({ out: destination, plan, manifest, root, deny, allowGit: true })
  assertSourceUnchanged()
  return staged
}

/** Git's index is authoritative on Windows too; chmod alone cannot preserve executable files in a snapshot. */
export function stagePublicGitModes({ destination, manifest }) {
  checkedRoot(destination)
  const expected = new Map([...manifest.rows.map(row => [row.path, row]),
    ['public-export.manifest.json', { mode: '100644', sha256: digest(jsonBytes(manifest)) }]])
  const index = git(destination, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean)
  const algorithm = gitText(destination, ['rev-parse', '--show-object-format'])
  if (!['sha1', 'sha256'].includes(algorithm) || index.length !== expected.size) fail('staged Git inventory differs from manifest')
  const records = [], seen = new Set()
  for (const line of index) {
    const [header, path] = line.split('\t'), [mode, object, stage] = header.split(' '), row = expected.get(path)
    pathKey(path)
    if (!row || seen.has(path) || stage !== '0' || !['100644', '100755'].includes(mode) || !['100644', '100755'].includes(row.mode)) fail('unexpected staged Git path, mode or conflict')
    seen.add(path)
    const bytes = readFileSync(regularPath(destination, path))
    const blob = createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    if (digest(bytes) !== row.sha256 || blob !== object) fail(`${path}: staged Git bytes differ from manifest`)
    records.push(`${row.mode} ${object}\t${path}\0`)
  }
  git(destination, ['update-index', '-z', '--index-info'], records.join(''))
  const actual = git(destination, ['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean)
  for (const line of actual) {
    const [header, path] = line.split('\t')
    if (header.split(' ')[0] !== expected.get(path)?.mode) fail(`${path}: staged Git executable mode differs from manifest`)
  }
  return { executables: manifest.rows.filter(row => row.mode === '100755').map(row => row.path), indexSha256: digest(Buffer.from(actual.join('\0'))) }
}
