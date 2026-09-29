/**
 * The parts of the npm release (scripts/publish-npm.mjs) that can be tested without publishing anything
 * (tests/publish-npm.test.ts): versions and ranges, reading and comparing the tarball `pnpm pack` makes, the scan a
 * tarball must pass, the plan (what to publish, skip or refuse), npm's sign-in link in a stream of output, a command run
 * with that link called out, and a poll that gives up. None of it reads the network, the registry's credentials or the
 * disk; the one thing that runs anything is `streamCommand`, and it runs only what it is given.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { PRIVATE_RULES, scanText, SECRET_RULES } from './scan.mjs'

// ---- versions ------------------------------------------------------------------------------------------------------

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** `1.2.3` or `1.2.3-beta.1` as parts, or null when it isn't a version. */
export function parseVersion(v) {
  const m = SEMVER.exec(String(v).trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' } : null
}

/** Negative, zero or positive as `a` is before, equal to or after `b` (semver order: a prerelease is before its release). */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  const p = x.pre.split('.')
  const q = y.pre.split('.')
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1
    if (q[i] === undefined) return 1
    const nx = /^\d+$/.test(p[i])
    const ny = /^\d+$/.test(q[i])
    if (nx && ny && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i])
    if (nx !== ny) return nx ? -1 : 1
    if (!nx && !ny && p[i] !== q[i]) return p[i] < q[i] ? -1 : 1
  }
  return 0
}

/** The highest release (no prerelease) among `versions`, or null. */
export function highestRelease(versions) {
  const releases = versions.filter((v) => parseVersion(v) && !parseVersion(v).pre)
  return releases.length ? releases.sort(compareVersions).at(-1) : null
}

/**
 * Whether `version` meets a dependency `range`: an exact version, `^`, `~`, `>=`, or `*`. null when the range is
 * something else, which the plan treats as "can't tell" and refuses. A prerelease meets only its exact version.
 */
export function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v) return null
  const r = String(range).trim()
  if (r === '*' || r === 'x' || r === '') return !v.pre
  const m = /^(\^|~|>=)?\s*(\d+\.\d+\.\d+)$/.exec(r)
  if (!m) return null
  const base = parseVersion(m[2])
  if (!m[1]) return compareVersions(version, m[2]) === 0
  if (v.pre) return false
  const atLeast = compareVersions(version, m[2]) >= 0
  if (m[1] === '>=') return atLeast
  if (m[1] === '~') return atLeast && v.major === base.major && v.minor === base.minor
  // ^: the leftmost non-zero part is the one that may not change.
  if (base.major > 0) return atLeast && v.major === base.major
  if (base.minor > 0) return atLeast && v.major === 0 && v.minor === base.minor
  return atLeast && v.major === 0 && v.minor === 0 && v.patch === base.patch
}

// ---- tarballs ------------------------------------------------------------------------------------------------------

const decoder = new TextDecoder()
/** The NUL-terminated text in a tar header field. */
const field = (buf, from, len) => {
  const part = buf.subarray(from, from + len)
  const end = part.indexOf(0)
  return decoder.decode(end < 0 ? part : part.subarray(0, end))
}

/** The `key=value` records of a pax extended header (`<length> key=value\n`, repeated). */
function paxRecords(body) {
  const out = {}
  let at = 0
  while (at < body.length) {
    const sp = body.indexOf(0x20, at)
    const len = Number(decoder.decode(body.subarray(at, sp)))
    if (!(len > 0)) break
    const record = decoder.decode(body.subarray(sp + 1, at + len - 1))
    const eq = record.indexOf('=')
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1)
    at += len
  }
  return out
}

/**
 * The files in an npm tarball (gzipped tar), by path with the leading `package/` folder removed: path → bytes. Only
 * regular files are kept. Throws on a path that leaves the package (`..`, absolute) and on a link, which npm strips
 * and a package has no business carrying.
 * @param {Uint8Array} data
 * @returns {Map<string, Uint8Array>}
 */
export function readTarball(data) {
  const buf = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data
  const files = new Map()
  let off = 0
  let longName = null
  let pax = null
  while (off + 512 <= buf.length) {
    const head = buf.subarray(off, off + 512)
    if (head.every((b) => b === 0)) break
    const size = parseInt(field(head, 124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) throw new Error('the tarball has a header that is not a tar header')
    const type = head[156] ? String.fromCharCode(head[156]) : '0'
    const prefix = field(head, 257, 6).startsWith('ustar') ? field(head, 345, 155) : ''
    const name = field(head, 0, 100)
    off += 512
    const body = buf.subarray(off, off + size)
    off += Math.ceil(size / 512) * 512
    if (type === 'x') { pax = paxRecords(body); continue }
    if (type === 'g') continue
    if (type === 'L') { longName = field(body, 0, body.length); continue }
    const path = (pax?.path ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/\\/g, '/')
    pax = null
    longName = null
    if (type === '1' || type === '2') throw new Error(`the tarball has a link (${path})`)
    if (type !== '0' && type !== '7') continue
    const parts = path.split('/').filter((p) => p && p !== '.')
    if (path.startsWith('/') || parts.includes('..') || /^[A-Za-z]:/.test(path) || parts.length < 2) throw new Error(`the tarball has a path outside the package folder (${path})`)
    files.set(parts.slice(1).join('/'), body)
  }
  return files
}

/** Whether a package file is text: compared and scanned as lines, whatever line endings the checkout gave it. */
export const isTextFile = (path) => /\.(?:[cm]?js|[cm]?ts|json|md|txt|map|css|html|svg)$/i.test(path) || /^(?:README|LICENSE|LICENCE|CHANGELOG)[^/]*$/i.test(path.slice(path.lastIndexOf('/') + 1))

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
/** A file's identity for comparing: text ignores CRLF against LF (a Windows checkout turns one into the other). */
const identity = (path, bytes) => (isTextFile(path) ? sha(decoder.decode(bytes).replace(/\r\n/g, '\n')) : sha(bytes))

/** JSON with every object's keys in order, so two manifests that say the same thing compare equal. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
  return value
}

/** A manifest as it counts for comparing: without `scripts` and npm's own `_` fields, and without the keys named. */
function manifestIdentity(bytes, ignore) {
  const m = JSON.parse(decoder.decode(bytes))
  for (const k of Object.keys(m)) if (k === 'scripts' || k.startsWith('_') || ignore.includes(k)) delete m[k]
  return JSON.stringify(canonical(m))
}

/**
 * How two packed versions of a package differ: the paths only in `b`, only in `a`, and in both with other content.
 * `ignoreManifest` names manifest fields to leave out (`version`, to ask what else moved between two releases).
 * @param {Map<string, Uint8Array>} a
 * @param {Map<string, Uint8Array>} b
 * @param {{ ignoreManifest?: string[] }} [opts]
 */
export function comparePacked(a, b, { ignoreManifest = [] } = {}) {
  const added = [...b.keys()].filter((p) => !a.has(p)).sort()
  const removed = [...a.keys()].filter((p) => !b.has(p)).sort()
  const changed = []
  for (const [path, bytes] of a) {
    if (!b.has(path)) continue
    const same = path === 'package.json'
      ? manifestIdentity(bytes, ignoreManifest) === manifestIdentity(b.get(path), ignoreManifest)
      : identity(path, bytes) === identity(path, b.get(path))
    if (!same) changed.push(path)
  }
  changed.sort()
  return { same: !added.length && !removed.length && !changed.length, added, removed, changed }
}

/**
 * One line on what moved between two packed versions: the code (dist) first, then the other files, without package.json
 * (a bump changes it) and the licence copy. "dist unchanged; added CHANGELOG.md, changed README.md".
 */
export function describeChange({ added, removed, changed }) {
  const cut = (paths) => `${paths.slice(0, 4).map((p) => p.replace(/^dist\//, '')).join(', ')}${paths.length > 4 ? `, +${paths.length - 4} more` : ''}`
  const kinds = (keep) => [['changed', changed], ['added', added], ['removed', removed]]
    .map(([word, paths]) => [word, paths.filter(keep)])
    .filter(([, paths]) => paths.length)
    .map(([word, paths]) => `${word} ${cut(paths)}`)
    .join(', ')
  const dist = kinds((p) => p.startsWith('dist/') && p !== 'dist/LICENSE')
  const other = kinds((p) => !p.startsWith('dist/') && p !== 'package.json')
  return `${dist ? `dist ${dist}` : 'dist unchanged'}${other ? `; ${other}` : ''}`
}

/** A tarball's SHA-512 as npm writes it in `dist.integrity`, for checking a download. */
export const integrityOf = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

// ---- the scan ------------------------------------------------------------------------------------------------------

/** What a package may hold: the manifest, the README, the licence, the changelog and dist. */
const EXPECTED = /^(?:package\.json|README(?:\.[\w]+)?|LICEN[CS]E(?:\.[\w]+)?|CHANGELOG(?:\.[\w]+)?|dist\/.+)$/i
/** An email address, except the placeholder kinds that name nobody. */
const EMAIL = /\b[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g
const NOBODY = /^noreply@|@(?:users\.noreply\.github\.com|example\.(?:com|org|net)|[\w-]+\.test)$/i
/** A source path that names this machine or leaves the package: absolute, a file: URL, a drive, or `..`. */
const LOCAL_SOURCE = /^(?:file:|[A-Za-z]:|[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/

/** The `sources` of a source map's JSON, plus its root and file. */
function mapPaths(json) {
  try {
    const m = JSON.parse(json)
    return [...(Array.isArray(m.sources) ? m.sources : []), m.sourceRoot, m.file].filter((s) => typeof s === 'string' && s)
  } catch { return null }
}

/** The manifest's `main`, `types` and every path under `exports`, as written (`./dist/index.js`). */
function entryPaths(manifest) {
  const out = []
  const walk = (v) => {
    if (typeof v === 'string') out.push(v)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  for (const k of ['main', 'types', 'module']) walk(manifest[k])
  walk(manifest.exports)
  return out.filter((p) => p.startsWith('./') || !p.startsWith('.'))
}

/**
 * What is wrong with a packed package, one finding `{ path, line?, what, hint? }` each; an empty list is a pass:
 *   - a file that isn't the manifest, README, licence, changelog or in dist;
 *   - a source map (or a `sourceMappingURL`) that points at a local path;
 *   - a key, a token, a local path, a personal address or a private word (scripts/lib/scan.mjs), in any text file;
 *   - a manifest that names another package or version than `name` and `version`, still carries a `workspace:`
 *     dependency, runs a script on install, or points `main`, `types` or `exports` at a file the package lacks.
 * A finding never carries the text it matched, only a masked hint.
 * @param {Map<string, Uint8Array>} files
 * @param {{ name: string, version: string, deny?: string[] }} expect
 */
export function scanTarball(files, { name, version, deny = [] }) {
  const found = []
  const add = (path, what, extra = {}) => found.push({ path, what, ...extra })
  for (const path of files.keys()) if (!EXPECTED.test(path)) add(path, 'not expected in the package (only package.json, README, LICENSE, CHANGELOG and dist)')
  if (![...files.keys()].some((p) => /^README/i.test(p))) add('README.md', 'missing')
  if (![...files.keys()].some((p) => p.startsWith('dist/') && p.endsWith('.js'))) add('dist', 'holds no JavaScript: was the package built?')

  for (const [path, bytes] of files) {
    if (!isTextFile(path)) continue
    const text = decoder.decode(bytes)
    if (path.endsWith('.map')) {
      const paths = mapPaths(text)
      if (!paths) add(path, 'a source map that isn\'t JSON')
      else if (paths.some((s) => LOCAL_SOURCE.test(s))) add(path, 'a source map pointing at a local path')
    }
    const url = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(text)?.[1]
    if (url?.startsWith('data:')) {
      const paths = mapPaths(Buffer.from(url.slice(url.indexOf(',') + 1), url.includes(';base64') ? 'base64' : 'utf8').toString('utf8'))
      if (!paths || paths.some((s) => LOCAL_SOURCE.test(s))) add(path, 'an inline source map pointing at a local path')
    } else if (url && LOCAL_SOURCE.test(url)) add(path, 'a sourceMappingURL pointing at a local path')
    text.split('\n').forEach((line, i) => {
      for (const f of scanText(line, { rules: [...SECRET_RULES, ...PRIVATE_RULES], deny })) add(path, f.what, { line: i + 1, hint: f.hint })
      for (const m of line.matchAll(EMAIL)) if (!NOBODY.test(m[0])) add(path, 'an email address', { line: i + 1 })
    })
  }

  const raw = files.get('package.json')
  if (!raw) { add('package.json', 'missing'); return found }
  let manifest
  try { manifest = JSON.parse(decoder.decode(raw)) } catch { add('package.json', 'isn\'t JSON'); return found }
  if (manifest.name !== name) add('package.json', `names ${manifest.name}, not ${name}`)
  if (manifest.version !== version) add('package.json', `says version ${manifest.version}, not ${version}`)
  if (manifest.private === true) add('package.json', 'is private: npm would refuse it')
  for (const kind of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [dep, spec] of Object.entries(manifest[kind] ?? {})) {
      if (/^(?:workspace|file|link|portal):/.test(spec)) add('package.json', `${kind}.${dep} is "${spec}": pnpm should have replaced it with a version`)
    }
  }
  for (const s of ['preinstall', 'install', 'postinstall']) if (manifest.scripts?.[s]) add('package.json', `runs a ${s} script on the reader's machine`)
  for (const p of entryPaths(manifest)) {
    const rel = p.replace(/^\.\//, '')
    if (rel === 'package.json') continue
    if (rel.startsWith('src/')) add('package.json', `points at ${p}, source that isn't in the package`)
    else if (!files.has(rel)) add('package.json', `points at ${p}, which the package lacks`)
  }
  return found
}

// ---- the plan ------------------------------------------------------------------------------------------------------

/**
 * What to do with each package, in the order given (dependencies first), from what the registry holds.
 * `packages`: `{ name, version, dependencies }`, the manifest as packed (`workspace:` already a version).
 * `registry[name]`: `{ versions, same }`, the versions on npm and, when the local version is one of them, whether the
 * packed files match the registry's copy of it (null when not compared).
 * Each step is `publish`, `skip` (already there, the same files) or `refuse` (a forgotten bump, an older version, a
 * prerelease). `links` are the dependencies between the packages; `problems` are every refusal and every dependency
 * that would not resolve, in words. The release goes ahead only when there are none.
 * @param {{ name: string, version: string, dependencies?: Record<string, string> }[]} packages
 * @param {Record<string, { versions: string[], same?: boolean | null }>} registry
 */
export function planRelease(packages, registry) {
  const problems = []
  const steps = packages.map((p) => {
    const reg = registry[p.name] ?? { versions: [], same: null }
    const step = { name: p.name, version: p.version, latest: highestRelease(reg.versions), action: 'publish', why: '' }
    const refuse = (why) => { step.action = 'refuse'; step.why = why; problems.push(`${p.name}@${p.version}: ${why}`) }
    const v = parseVersion(p.version)
    if (!v) refuse(`"${p.version}" isn't a version`)
    else if (v.pre) refuse('a prerelease: npm would move the latest tag to it, and this script publishes releases')
    else if (reg.versions.includes(p.version)) {
      if (reg.same === true) { step.action = 'skip'; step.why = 'already on npm, the same files' }
      else if (reg.same === false) refuse('already on npm with other files: bump the version')
      else refuse('already on npm, and the files could not be compared')
    } else if (step.latest && compareVersions(p.version, step.latest) < 0) refuse(`older than ${step.latest}, which is on npm: the latest tag would move back`)
    else step.why = step.latest ? `new, after ${step.latest}` : 'first release'
    return step
  })

  const links = []
  const at = (name) => packages.findIndex((p) => p.name === name)
  packages.forEach((p, i) => {
    for (const [dep, range] of Object.entries(p.dependencies ?? {})) {
      const j = at(dep)
      if (j < 0) continue
      const onNpm = (registry[dep]?.versions ?? []).filter((v) => satisfies(v, range))
      const inRun = steps[j].action === 'publish' && satisfies(steps[j].version, range) ? [steps[j].version] : []
      const link = { name: p.name, dep, range, resolves: '', ok: true }
      if (satisfies(steps[j].version, range) === null) { link.ok = false; problems.push(`${p.name} needs ${dep} ${range}, a range this script can't judge`) }
      else if (j > i) { link.ok = false; problems.push(`${p.name} needs ${dep}, which is published after it: the order is wrong`) }
      else if (!onNpm.length && !inRun.length) { link.ok = false; problems.push(`${p.name} needs ${dep} ${range}, which is not on npm and not in this run`) }
      else if (inRun.length) link.resolves = `${dep}@${inRun[0]} (published in this run)`
      else link.resolves = `${dep}@${onNpm.sort(compareVersions).at(-1)} (on npm)`
      links.push(link)
    }
  })
  return { steps, links, problems }
}

// ---- output and waiting --------------------------------------------------------------------------------------------

/** npm's sign-in link: what it prints when the account signs in on the web and the owner has to approve. */
const AUTH_URL = /https:\/\/(?:www\.)?npmjs\.com\/auth\/cli\/[A-Za-z0-9-]+/g

/** The sign-in links in a piece of output, each once, in order. */
export const authUrls = (text) => [...new Set(text.match(AUTH_URL) ?? [])]

/**
 * Finds the sign-in links in output that arrives in pieces. `feed(chunk)` returns the links newly complete: one is not
 * given until something follows it (npm ends the line), so a link split across two chunks is never given cut short;
 * `end()` gives one that ends the output. A link is given once, however often npm prints it.
 */
export function authWatcher() {
  let buffer = ''
  const seen = new Set()
  const take = (final) => {
    const out = []
    // What stays for the next chunk: a tail long enough to hold a link's start, or from a link that may not be complete.
    let keepFrom = Math.max(0, buffer.length - 200)
    for (const m of buffer.matchAll(AUTH_URL)) {
      if (m.index + m[0].length >= buffer.length && !final) { keepFrom = Math.min(keepFrom, m.index); break }
      if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]) }
    }
    buffer = final ? '' : buffer.slice(keepFrom)
    return out
  }
  return {
    feed(chunk) { buffer += chunk; return take(false) },
    end() { return take(true) },
  }
}

/**
 * Runs a command with its output passed on as it arrives (`write(stream, text)`) and npm's sign-in links in it given to
 * `onApprove(url)`, each once. Stdin is closed, so npm doesn't stop at a prompt. After `timeoutMs` the command and what it
 * started are killed. `keepStdinOpen` lets the npm TTY shim wait silently for web approval.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, shell?: boolean, keepStdinOpen?: boolean, timeoutMs?: number, write?: (stream: 'stdout' | 'stderr', text: string) => void, onApprove?: (url: string) => void }} [opts]
 * @returns {Promise<{ ok: boolean, code: number | null, ms: number, timedOut: boolean, tail: string }>}
 */
export function streamCommand(cmd, args, { cwd, shell = false, keepStdinOpen = false, timeoutMs = 0, write = () => {}, onApprove = () => {} } = {}) {
  return new Promise((done) => {
    const t0 = Date.now()
    // One watcher per stream, because a link split across chunks is split within its own stream.
    const watchers = { stdout: authWatcher(), stderr: authWatcher() }
    const called = new Set()
    const approve = (urls) => { for (const url of urls) if (!called.has(url)) { called.add(url); onApprove(url) } }
    let tail = ''
    let timedOut = false
    let child
    try {
      child = spawn(cmd, args, { cwd, shell, stdio: [keepStdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) { done({ ok: false, code: null, ms: 0, timedOut: false, tail: String(e.message) }); return }
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && shell) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGKILL')
    }, timeoutMs) : null
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        const text = chunk.toString()
        write(stream, text)
        tail = `${tail}${text}`.slice(-4000)
        approve(watchers[stream].feed(text))
      })
    }
    child.on('error', (e) => { if (timer) clearTimeout(timer); done({ ok: false, code: null, ms: Date.now() - t0, timedOut, tail: String(e.message) }) })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      for (const w of Object.values(watchers)) approve(w.end())
      done({ ok: code === 0 && !timedOut, code, ms: Date.now() - t0, timedOut, tail })
    })
  })
}

/**
 * Calls `check` until it returns something truthy or `timeoutMs` has passed (a first call at once, then every
 * `intervalMs`). `sleep` and `now` are there for the tests. `onWait(ms)` is told how long it has waited between tries.
 * @template T
 * @param {() => Promise<T | false | null | undefined>} check
 * @param {{ timeoutMs: number, intervalMs: number, sleep?: (ms: number) => Promise<void>, now?: () => number, onWait?: (ms: number) => void }} opts
 * @returns {Promise<{ ok: boolean, value: T | null, tries: number, ms: number }>}
 */
export async function waitUntil(check, { timeoutMs, intervalMs, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, onWait }) {
  const t0 = now()
  let tries = 0
  for (;;) {
    tries++
    const value = await check()
    if (value) return { ok: true, value, tries, ms: now() - t0 }
    const left = timeoutMs - (now() - t0)
    if (left <= 0) return { ok: false, value: null, tries, ms: now() - t0 }
    await sleep(Math.min(intervalMs, left))
    onWait?.(now() - t0)
  }
}

// ---- which tests ---------------------------------------------------------------------------------------------------

/**
 * The tests that exercise the packages themselves: those that import `@obpal/core`, `@obpal/host` or their folders,
 * except the sims' tests (`sim-*`), which use the packages and are `pnpm run check`'s to run.
 * @param {Record<string, string>} sources test file name (`tests/x.test.ts`) → its text
 */
export function packageTests(sources) {
  const IMPORTS = /\bfrom\s+['"](?:@obpal\/(?:core|host)(?:\/[\w-]+)?|(?:\.\.\/)+packages\/(?:core|host)\/[\w/.-]+)['"]/
  return Object.keys(sources).filter((f) => /\.test\.ts$/.test(f) && !/(?:^|\/)sim-/.test(f) && IMPORTS.test(sources[f])).sort()
}
