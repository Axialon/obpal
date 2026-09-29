/**
 * Publish @obpal/core and @obpal/host to npm: the quick, checked way. Read the plan first, then let it publish.
 *
 *   pnpm run publish:npm            dry run: every check and a plan, and nothing is published
 *   pnpm run publish:npm -- --yes   publish what the plan says, then check the registry and an install
 *
 * What it does, in order:
 *   1. checkout  the main checkout, on master, with a clean tree. --yes refuses otherwise; a dry run shows it as a
 *                warning, so a lane can run the rest.
 *   2. registry  what each package has on npm (read without the cache; no account and no npm config involved).
 *   3. checks    scripts/build-packages.mjs, the typecheck, and the vitest files that test the packages.
 *   4. pack      `pnpm pack` each package, in dependency order, into a temp folder; then look inside the tarball:
 *                only package.json, README, LICENSE, CHANGELOG and dist; no source map pointing at a local path; no
 *                key, local path, personal address or private word (scripts/lib/scan.mjs, .open-source-deny).
 *   5. plan      per package: publish, skip (that version is on npm with the same files) or refuse (that version is on
 *                npm with other files, which is a forgotten bump; or older than the latest; or a prerelease). Host's
 *                core dependency must be a version on npm or one this run publishes.
 *   6. rehearse  install the packed tarballs in a temp folder and import every entry point.
 *   7. publish   (--yes) `pnpm --filter <package> publish --access public`, core first. This machine's npm signs in on
 *                the web: npm prints a link the owner approves in a browser, and this prints it as one line,
 *                `APPROVE: <url>`, for whoever is watching. Nothing else about the sign-in is read or kept.
 *   8. verify    (--yes) wait up to 4 minutes for each new version to show on the registry, check that its tarball is
 *                the one inspected, install it in a temp folder and import every entry point.
 *
 * It never reads or prints a token or ~/.npmrc, and never changes npm's config. Lanes never run it with --yes (the
 * checkout rule stops them: a lane is a linked worktree).
 * Exit codes: 0 done (or a dry run with a clean plan), 1 a check, the publish or the verification failed, 2 refused.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVitest } from './lib/merge.mjs'
import { comparePacked, describeChange, integrityOf, packageTests, planRelease, readTarball, scanTarball, streamCommand, waitUntil } from './lib/npm-publish.mjs'
import { formatDuration, formatTable } from './lib/report.mjs'
import { readDenyWords } from './lib/scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const win = process.platform === 'win32'
/** The packages, in dependency order (the same order as scripts/build-packages.mjs). */
const PACKAGES = ['core', 'host']
const REGISTRY = 'https://registry.npmjs.org'
/** The registry took about two minutes to show a new package: wait up to four. */
const WAIT_MS = 4 * 60_000
const POLL_MS = 5_000
/** How long npm may wait for the owner to approve the sign-in link before this gives up on it. */
const PUBLISH_MS = 15 * 60_000

const args = process.argv.slice(2).filter((a) => a !== '--')
if (args.includes('--help') || args.includes('-h')) {
  console.log('pnpm run publish:npm [-- --yes]\n  no flag  a dry run: the checks and a plan, nothing is published\n  --yes    publish the plan (main checkout, on master, clean tree), then verify it')
  process.exit(0)
}
const unknown = args.filter((a) => a !== '--yes')
if (unknown.length) { console.error(`publish-npm: unknown option ${unknown[0]}`); process.exit(2) }
const yes = args.includes('--yes')

const rows = []
let plan = null
let temp = ''

/** Ends the release: thrown from anywhere below, caught at the bottom, where the tables are printed. */
class Done extends Error {
  constructor(code, closing) { super(closing); this.code = code; this.closing = closing }
}
const finish = (code, closing = '') => { throw new Done(code, closing) }
const row = (step, result, detail = '') => rows.push([step, result, detail])
const say = (line) => console.log(`publish-npm: ${line}`)
const refuse = (step, detail) => { row(step, 'REFUSED', detail); finish(2, 'Nothing was published.') }
const fail = (step, detail, output = '') => {
  row(step, 'FAIL', detail)
  const tail = output.trimEnd().split('\n').slice(-25).join('\n').replace(/^\n+/, '')
  if (tail) console.log(`\n${tail}`)
  finish(1, 'Nothing was published.')
}

// ---- helpers -------------------------------------------------------------------------------------------------------
const git = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
const quote = (a) => (win && /[\s&|<>^"()]/.test(a) ? `"${a}"` : a)
/** A command to completion: pnpm and npm are .cmd shims on Windows, so they go through the shell. */
function run(cmd, cmdArgs, { cwd = root } = {}) {
  const t0 = Date.now()
  const r = spawnSync(cmd, win ? cmdArgs.map(quote) : cmdArgs, {
    cwd, encoding: 'utf8', shell: win, maxBuffer: 256 << 20, windowsHide: true, env: { ...process.env, npm_config_update_notifier: 'false' },
  })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - t0 }
}
const same = (a, b) => (win ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))

/** A registry document read without any cache; null for a 404. Throws on anything else. */
async function fetchDoc(path) {
  const r = await fetch(`${REGISTRY}/${path}?nocache=${Date.now()}`, { headers: { accept: 'application/json', 'cache-control': 'no-cache', pragma: 'no-cache' }, signal: AbortSignal.timeout(30_000) })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`the registry answered ${r.status} for ${path}`)
  return r.json()
}
const packumentPath = (name) => name.replace('/', '%2f')
/** A published tarball, checked against the integrity the registry lists for it. */
async function fetchTarball(version) {
  const r = await fetch(version.dist.tarball, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(60_000) })
  if (!r.ok) throw new Error(`the registry answered ${r.status} for the tarball`)
  const bytes = new Uint8Array(await r.arrayBuffer())
  if (version.dist.integrity && integrityOf(bytes) !== version.dist.integrity) throw new Error('the downloaded tarball does not match the integrity the registry lists')
  return readTarball(bytes)
}

/** The import list: every entry point in a manifest's exports, as a specifier (`@obpal/host/qr`). */
const entryPoints = (manifest) => Object.keys(manifest.exports ?? {}).filter((k) => k !== './package.json').map((k) => `${manifest.name}${k === '.' ? '' : k.slice(1)}`)

/** Install into a fresh temp folder and import each specifier in Node. Returns { ok, detail }. */
function installAndImport(dir, specs, imports) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"obpal-publish-check","private":true,"type":"module"}\n')
  const cache = join(dir, '.cache')
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--prefer-online', '--ignore-scripts', '--cache', cache, ...specs], { cwd: dir })
  if (!install.ok) return { ok: false, detail: `npm install failed: ${install.out.trim().split('\n').filter((l) => /ERR|error|404|ETARGET/i.test(l)).slice(0, 3).join(' | ') || 'no message'}` }
  writeFileSync(join(dir, 'check.mjs'), `const out = []\nfor (const s of ${JSON.stringify(imports)}) {\n  try { const m = await import(s); out.push([s, true, Object.keys(m).length]) } catch (e) { out.push([s, false, String((e && e.message) || e).split('\\n')[0]]) }\n}\nconsole.log(JSON.stringify(out))\n`)
  const r = spawnSync(process.execPath, ['check.mjs'], { cwd: dir, encoding: 'utf8', windowsHide: true })
  let results
  try { results = JSON.parse(r.stdout.trim().split('\n').at(-1)) } catch { return { ok: false, detail: `the import check gave no answer: ${(r.stderr ?? '').trim().split('\n')[0]}` } }
  const bad = results.filter(([, ok]) => !ok)
  if (bad.length) return { ok: false, detail: bad.map(([s, , why]) => `${s}: ${why}`).join(' | ') }
  return { ok: true, detail: `${results.length} imports: ${results.map(([s]) => s.replace('@obpal/', '')).join(', ')}` }
}

// ---- the release ---------------------------------------------------------------------------------------------------
async function release() {
  // ---- 1. the checkout
  say(`${yes ? 'publishing' : 'dry run'}: checking the checkout`)
  const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir']).trim()
  const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  const branch = spawnSync('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean)
  const blockers = []
  if (!same(gitDir, commonDir)) blockers.push('this is a linked worktree (a lane\'s), not the main checkout')
  if (branch !== 'master') blockers.push(`the branch is ${branch || 'a detached HEAD'}, not master`)
  if (dirty.length) blockers.push(`the tree is not clean (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}${dirty.length > 3 ? `, +${dirty.length - 3} more` : ''})`)
  if (blockers.length && yes) refuse('checkout', `${blockers.join('; ')}. Publish from the main checkout, on master, with everything committed.`)
  row('checkout', blockers.length ? 'WARN' : 'ok', blockers.length ? `--yes would refuse: ${blockers.join('; ')}` : `main checkout, master, clean tree at ${git(['rev-parse', '--short', 'HEAD']).trim()}`)

  // The private words live in the main checkout's gitignored file, which a lane's worktree doesn't have.
  const denyRoot = existsSync(join(root, '.open-source-deny')) ? root : dirname(commonDir)
  const deny = readDenyWords(denyRoot)
  if (!deny.length && yes) refuse('scan', 'There is no .open-source-deny to scan for personal names against (scripts/open-source.mjs describes it). Publishing without it would leave that check blind.')

  // ---- 2. the registry
  say('reading the registry')
  const local = {}
  for (const dir of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
    local[manifest.name] = { dir, name: manifest.name, version: manifest.version }
  }
  const names = Object.keys(local)
  const registry = {}
  for (const name of names) {
    try {
      const doc = await fetchDoc(packumentPath(name))
      registry[name] = { doc, versions: doc ? Object.keys(doc.versions ?? {}) : [], same: null }
    } catch (e) { fail('registry', `${name}: ${e.message}`) }
  }
  row('registry', 'ok', names.map((n) => `${n} ${registry[n].versions.length ? registry[n].versions.join(', ') : 'not published'}`).join('; '))

  // ---- 3. build, typecheck, tests
  say('building the packages')
  const build = run('node', [join(root, 'scripts', 'build-packages.mjs')])
  if (!build.ok) fail('build', 'scripts/build-packages.mjs failed', build.out)
  row('build', 'ok', formatDuration(build.ms))

  say('typechecking')
  const tc = run('pnpm', ['run', 'typecheck'])
  const tsErrors = tc.out.split('\n').filter((l) => /error TS\d+/.test(l))
  if (!tc.ok) fail('typecheck', `${tsErrors.length} errors`, tsErrors.slice(0, 15).join('\n') || tc.out)
  row('typecheck', 'ok', formatDuration(tc.ms))

  const testsDir = join(root, 'tests')
  const sources = Object.fromEntries(readdirSync(testsDir).filter((f) => f.endsWith('.test.ts')).map((f) => [`tests/${f}`, readFileSync(join(testsDir, f), 'utf8')]))
  const tests = packageTests(sources)
  say(`running ${tests.length} vitest files that test the packages`)
  const vt = run('pnpm', ['exec', 'vitest', 'run', ...tests])
  const v = parseVitest(vt.out)
  if (!vt.ok) fail('vitest', v ? `${v.failed} failed of ${v.total}` : 'no summary', vt.out.split('\n').filter((l) => /FAIL|×|✗|Error:/.test(l)).slice(0, 15).join('\n') || vt.out)
  row('vitest', 'ok', `${v ? `${v.passed}/${v.total}` : 'passed'} in ${tests.length} files that test the packages, ${formatDuration(vt.ms)}`)

  // ---- 4. pack and inspect
  temp = mkdtempSync(join(tmpdir(), 'obpal-publish-'))
  const packed = {}
  const findings = []
  for (const name of names) {
    const p = local[name]
    say(`packing ${name}`)
    const out = join(temp, `pack-${p.dir}`)
    mkdirSync(out)
    const pack = run('pnpm', ['--filter', name, 'pack', '--pack-destination', out])
    const tgz = readdirSync(out).find((f) => f.endsWith('.tgz'))
    if (!pack.ok || !tgz) fail('pack', `pnpm pack failed for ${name}`, pack.out)
    let files
    try { files = readTarball(new Uint8Array(readFileSync(join(out, tgz)))) } catch (e) { fail('pack', `${name}: ${e.message}`) }
    const manifest = JSON.parse(new TextDecoder().decode(files.get('package.json') ?? new Uint8Array()) || '{}')
    packed[name] = { ...p, tgz: join(out, tgz), files, manifest }
    for (const f of scanTarball(files, { name, version: p.version, deny })) findings.push({ pkg: name, ...f })
  }
  if (findings.length) {
    const list = findings.slice(0, 20).map((f) => `  ${f.pkg}: ${f.path}${f.line ? `:${f.line}` : ''}  ${f.what}${f.hint ? `  ${f.hint}` : ''}`).join('\n')
    fail('pack', `${findings.length} thing${findings.length > 1 ? 's' : ''} that must not be published`, `${list}${findings.length > 20 ? `\n  … ${findings.length - 20} more` : ''}`)
  }
  row('pack', 'ok', `${names.map((n) => `${n.replace('@obpal/', '')} ${packed[n].files.size} files`).join(', ')}; only package.json, README, LICENSE, CHANGELOG and dist${deny.length ? '' : ' (no .open-source-deny found: private words not scanned)'}`)

  // ---- 5. the plan
  const notes = {}
  for (const name of names) {
    const p = packed[name]
    const reg = registry[name]
    try {
      if (reg.versions.includes(p.version)) {
        reg.same = comparePacked(p.files, await fetchTarball(reg.doc.versions[p.version])).same
      } else if (reg.versions.length) {
        const latest = reg.doc['dist-tags']?.latest ?? reg.versions.at(-1)
        notes[name] = `since ${latest}: ${describeChange(comparePacked(await fetchTarball(reg.doc.versions[latest]), p.files, { ignoreManifest: ['version', 'dependencies'] }))}`
      }
    } catch (e) { notes[name] = `not compared with npm (${e.message})` }
  }
  plan = planRelease(names.map((n) => ({ name: n, version: packed[n].version, dependencies: packed[n].manifest.dependencies })), registry)
  for (const s of plan.steps) if (s.action === 'publish' && notes[s.name]) s.why = `${s.why}; ${notes[s.name]}`
  if (plan.problems.length) { row('plan', 'REFUSED', plan.problems.join('; ')); finish(2, 'Nothing was published. Fix what the plan names, commit, and run it again.') }
  const toPublish = plan.steps.filter((s) => s.action === 'publish')
  const skipped = plan.steps.filter((s) => s.action === 'skip')
  row('plan', 'ok', toPublish.length ? `publish ${toPublish.map((s) => `${s.name}@${s.version}`).join(', then ')}${skipped.length ? `; skip ${skipped.map((s) => `${s.name}@${s.version}`).join(', ')}` : ''}` : 'nothing to publish: every version is on npm with the same files')
  if (!toPublish.length) finish(0, 'Nothing to do.')

  /** What importing `list` covers: each package's entry points and those of the packages of ours it depends on. */
  const importsFor = (list) => {
    const seen = new Set()
    const visit = (n) => { if (!seen.has(n) && packed[n]) { seen.add(n); Object.keys(packed[n].manifest.dependencies ?? {}).forEach(visit) } }
    list.forEach(visit)
    return names.filter((n) => seen.has(n)).flatMap((n) => entryPoints(packed[n].manifest))
  }

  // ---- 6. rehearse the install
  say('installing the packed tarballs in a temp folder')
  const rehearsal = installAndImport(join(temp, 'rehearse'), toPublish.map((s) => packed[s.name].tgz), importsFor(toPublish.map((s) => s.name)))
  if (!rehearsal.ok) fail('install (packed)', rehearsal.detail)
  row('install (packed)', 'ok', rehearsal.detail)

  if (!yes) {
    row('publish', 'skipped', 'dry run')
    finish(0, 'Dry run: nothing was published. To publish, run this from the main checkout, on master, with a clean tree:\n  pnpm run publish:npm -- --yes\nnpm will print a link to approve in the browser; it comes through as "APPROVE: <url>".')
  }

  // ---- 7. publish
  /** `pnpm --filter <name> publish --access public`, its output streamed as it comes, npm's sign-in link called out as one line. */
  const publish = (name) => streamCommand('pnpm', ['--filter', name, 'publish', '--access', 'public'], {
    cwd: root, shell: win, timeoutMs: PUBLISH_MS,
    write: (stream, text) => process[stream].write(text),
    onApprove: (url) => console.log(`\nAPPROVE: ${url}`),
  })
  const published = []
  for (const s of toPublish) {
    say(`publishing ${s.name}@${s.version}: approve npm's sign-in link when it appears`)
    const r = await publish(s.name)
    if (!r.ok) {
      row(`publish ${s.name}`, 'FAIL', `${formatDuration(r.ms)}${r.timedOut ? `; no approval within ${formatDuration(PUBLISH_MS)}, so npm was stopped` : ''}${/E403|previously published|cannot publish over/i.test(r.tail) ? '; npm says that version already exists' : ''}`)
      finish(1, `${published.length ? `Published before it stopped: ${published.map((p) => `${p.name}@${p.version}`).join(', ')}. ` : 'Nothing was published. '}Run it again once it's fixed: what is on npm is skipped.`)
    }
    published.push(s)
    row(`publish ${s.name}`, 'ok', `${s.version}, ${formatDuration(r.ms)}`)
  }

  // ---- 8. verify
  say(`waiting up to ${formatDuration(WAIT_MS)} for the registry to show ${published.map((p) => `${p.name}@${p.version}`).join(', ')}`)
  const deadline = Date.now() + WAIT_MS
  let failed = false
  for (const s of published) {
    let lastSaid = 0
    const found = await waitUntil(async () => {
      try {
        const doc = await fetchDoc(`${packumentPath(s.name)}/${s.version}`)
        if (!doc) return false
        return { doc, files: await fetchTarball(doc) }
      } catch { return false }
    }, { timeoutMs: Math.max(0, deadline - Date.now()), intervalMs: POLL_MS, onWait: (ms) => { if (ms - lastSaid >= 30_000) { lastSaid = ms; say(`still waiting for ${s.name}@${s.version} (${formatDuration(ms)})`) } } })
    if (!found.ok) { row(`registry ${s.name}`, 'FAIL', `${s.version} did not show within ${formatDuration(WAIT_MS)}; it may still appear: check https://www.npmjs.com/package/${s.name}`); failed = true; continue }
    const cmp = comparePacked(packed[s.name].files, found.value.files)
    row(`registry ${s.name}`, cmp.same ? 'ok' : 'FAIL', cmp.same ? `${s.version} is there after ${formatDuration(found.ms)}, the files inspected` : `${s.version} is there, but its files differ from the ones inspected: ${describeChange(cmp)}`)
    if (!cmp.same) failed = true
  }
  if (!failed) {
    // Install the last package published (host, which brings core), as a reader would, and import what comes with it.
    const top = published.at(-1)
    let result = { ok: false, detail: '' }
    for (let attempt = 1; attempt <= 4 && !result.ok; attempt++) {
      say(`installing ${top.name}@${top.version} in a temp folder${attempt > 1 ? ` (try ${attempt})` : ''}`)
      result = installAndImport(join(temp, `verify-${attempt}`), [`${top.name}@${top.version}`], importsFor([top.name]))
      if (!result.ok && attempt < 4 && Date.now() < deadline + 60_000) await new Promise((r) => setTimeout(r, 15_000))
    }
    row('install (npm)', result.ok ? 'ok' : 'FAIL', result.detail)
    if (!result.ok) failed = true
  }
  finish(failed ? 1 : 0, failed ? 'Published, but a check after it failed: look at the rows above before anything else.' : `Published and verified: ${published.map((p) => `${p.name}@${p.version}`).join(', ')}.`)
}

let code = 0
let closing = ''
try {
  await release()
} catch (e) {
  if (e instanceof Done) { code = e.code; closing = e.closing } else { row('error', 'FAIL', String(e?.message ?? e)); code = 1; closing = e?.stack ?? '' }
}
if (plan) {
  console.log(`\nplan:\n${formatTable(['package', 'version', 'on npm', 'action', 'why'], plan.steps.map((s) => [s.name, s.version, s.latest ?? '-', s.action.toUpperCase(), s.why]))}`)
  for (const l of plan.links) console.log(`  ${l.name} needs ${l.dep} ${l.range}: ${l.ok ? l.resolves : 'NOT AVAILABLE'}`)
}
console.log(`\npublish-npm (${yes ? '--yes' : 'dry run'}):\n${formatTable(['step', 'result', 'detail'], rows)}`)
if (closing) console.log(`\n${closing}`)
if (temp && dirname(temp) === tmpdir() && basename(temp).startsWith('obpal-publish-')) rmSync(temp, { recursive: true, force: true })
// Leave once what was printed has gone out: a pipe on Windows may still hold it.
process.stdout.write('', () => process.exit(code))
