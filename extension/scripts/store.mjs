/**
 * The Chrome Web Store package of ob.Pal Link, from extension/dist as a release builds it:
 *   extension/release/obpal-link-<version>-store.zip
 * It holds the same files as the GitHub release zip (pack.mjs) with one difference: its manifest has no `key`. The store
 * fixes an item's ID itself and refuses a new item whose manifest carries one. (A developer-mode install keeps the key:
 * that is what gives it the ID ob.Pal Desktop allows.)
 *
 * The item's first upload is the exception: it also carries the extension's private key, as key.pem at the zip's root,
 * so the store gives the item Link's existing ID instead of a new one (ob.Pal Desktop's native messaging manifest allows
 * only that ID). `--with-key <pem>` writes that zip as well, but only next to the key, in <the key's folder>/store/,
 * and never inside the repository or any other git working tree. It is written only when the ID derived from the key is
 * the ID of the manifest's public key and the one ob.Pal Desktop allows (desktop/src/win/install.rs EXTENSION_IDS).
 * Nothing from the key is ever printed.
 *
 * Each zip is read back and checked: every file is of a kind the build makes and is used by the extension (reachable
 * from manifest.json), every file the manifest names is there, the manifest parses and has no `key`, and key.pem is in
 * the first-upload zip only.
 *
 * Usage: pnpm run store:extension [-- --with-key [<path to the private key>]]   (builds first)
 *        node extension/scripts/store.mjs [--with-key [<pem>]]                  (after a build)
 * --with-key with no path takes ~/.obpal-keys/extension-key.pem, where extension/scripts/key.mjs keeps it.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { files, unzip, zip } from './zip.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(root, '..')
const dist = resolve(root, 'dist')
const out = resolve(root, 'release')
const INSTALL_RS = resolve(repo, 'desktop', 'src', 'win', 'install.rs')

/** The kinds of file a build of the extension holds. Anything else (a source map, a test page, a stray file) fails. */
const KINDS = [
  /^manifest\.json$/,
  /^[a-z-]+\.(html|js)$/,
  /^icons\/icon-\d+\.png$/,
  /^assets\/[\w.-]+\.(js|css|woff2|png|svg)$/,
  /^assets\/OFL-[\w-]+\.txt$/,
]
/** Shipped although nothing loads them: the bundled fonts' licences (SIL OFL), which travel with the fonts. */
const UNLOADED = [/^assets\/OFL-[\w-]+\.txt$/]
/** The summary on the store listing is the manifest's description (store limit). */
const MAX_SUMMARY = 132
const KB = (n) => `${(n / 1024).toFixed(1)} KB`

function fail(msg) {
  console.error(`ob.Pal Link store package: ${msg}`)
  process.exit(1)
}

// ---- checks -----------------------------------------------------------------------------------------------------

/** Chrome's extension ID for a public key: SHA-256 of its DER (SubjectPublicKeyInfo), the first 32 hex digits mapped onto a-p. */
const extensionId = (der) => createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)])

/** The extension IDs ob.Pal Desktop registers as allowed origins. */
async function desktopIds() {
  const src = await readFile(INSTALL_RS, 'utf8')
  const ids = /EXTENSION_IDS:\s*&\[&str\]\s*=\s*&\[([^\]]*)\]/.exec(src)?.[1] ?? ''
  return [...ids.matchAll(/"([a-p]{32})"/g)].map((m) => m[1])
}

/** Every file reachable from manifest.json: a file is used once a used manifest, page, script or style names it. */
function reachable(entries) {
  const byName = new Map(entries.map((e) => [e.name, e]))
  const used = new Set(['manifest.json'])
  const queue = ['manifest.json']
  while (queue.length) {
    const text = byName.get(queue.pop()).data.toString('utf8')
    for (const name of byName.keys()) {
      if (used.has(name) || !text.includes(basename(name))) continue
      used.add(name)
      if (/\.(json|html|js|css)$/.test(name)) queue.push(name)
    }
  }
  return used
}

/** Read a zip back and check it; returns its entries. `withKey`: key.pem must be at its root, else nowhere. */
function verify(bytes, withKey) {
  const entries = unzip(bytes)
  const names = entries.map((e) => e.name)
  const problems = []
  if (new Set(names).size !== names.length) problems.push('duplicate entries')
  const m = entries.find((e) => e.name === 'manifest.json')
  let parsed = null
  try { parsed = m && JSON.parse(m.data.toString('utf8')) } catch { problems.push('manifest.json does not parse') }
  if (!parsed) problems.push('no manifest.json at the root')
  else {
    if ('key' in parsed) problems.push('the manifest has a key')
    if (parsed.manifest_version !== 3) problems.push('manifest_version is not 3')
    const named = [
      ...Object.values(parsed.icons ?? {}), ...Object.values(parsed.action?.default_icon ?? {}),
      parsed.action?.default_popup, parsed.background?.service_worker, parsed.options_ui?.page,
    ].filter(Boolean)
    for (const f of named) if (!names.includes(f)) problems.push(`the manifest names ${f}, which is missing`)
    if (!names.includes(parsed.icons?.['128'])) problems.push('no 128 px store icon')
  }
  const pems = names.filter((n) => /\.pem$/i.test(n))
  if (withKey ? pems.length !== 1 || pems[0] !== 'key.pem' : pems.length) problems.push(withKey ? 'key.pem is not (only) at the root' : `a key in the package: ${pems.join(', ')}`)
  const shipped = entries.filter((e) => e.name !== 'key.pem')
  for (const e of shipped) if (!KINDS.some((k) => k.test(e.name))) problems.push(`not a file the build makes: ${e.name}`)
  const used = parsed ? reachable(shipped) : new Set()
  for (const e of shipped) if (parsed && !used.has(e.name) && !UNLOADED.some((k) => k.test(e.name))) problems.push(`not used by the extension: ${e.name}`)
  if (problems.length) fail(`check failed\n  ${problems.join('\n  ')}`)
  return entries
}

function list(entries) {
  for (const e of entries) console.log(`    ${e.name.padEnd(56)} ${KB(e.data.length).padStart(9)}`)
}

/** The git working tree `path` is in (the nearest folder at or above it with a .git), or null. */
function workTree(path) {
  for (let d = resolve(path); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d
    if (dirname(d) === d) return null
  }
}
const inside = (path, dir) => {
  const r = relative(dir, path)
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

const idOf = (pem) => extensionId(createPublicKey(pem).export({ type: 'spki', format: 'der' }))

// ---- arguments: with --with-key, the key's place and its ID are checked before anything is written ------------------

/** Where extension/scripts/key.mjs keeps the key, and where --with-key looks when it is given no path. */
const DEFAULT_KEY = join(homedir(), '.obpal-keys', 'extension-key.pem')
const args = process.argv.slice(2).filter((a) => a !== '--')
let keyPath = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--with-key') keyPath = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : DEFAULT_KEY
  else if (a.startsWith('--with-key=')) keyPath = a.slice('--with-key='.length)
  else fail(`unknown argument ${a}`)
}
let keyOut = null
if (keyPath) {
  keyOut = join(dirname(resolve(keyPath)), 'store')
  const tree = workTree(keyOut)
  if (inside(keyOut, repo) || tree) fail(`refusing to write a zip with the private key to ${keyOut}: it is inside ${tree ?? repo}. Keep the key outside the repository.`)
}

// ---- the build ------------------------------------------------------------------------------------------------

if (!existsSync(join(dist, 'manifest.json'))) fail(`no build in ${dist}: run pnpm run store:extension, which builds first`)
const built = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (built.version !== pkg.version) fail(`the build is ${built.version} but extension/package.json says ${pkg.version}: build first`)
if (typeof built.key !== 'string') fail('the built manifest has no key, so the ID it fixes is unknown')

const { key: publicKey, ...manifest } = built
if ([...manifest.description].length > MAX_SUMMARY) fail(`the description (the store summary) is over ${MAX_SUMMARY} characters`)
const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`
const current = extensionId(Buffer.from(publicKey, 'base64'))

// ---- the key: its ID must be Link's, the one the manifest key gives and ob.Pal Desktop allows ----------------------

let pem = null
if (keyPath) {
  let priv
  try {
    priv = createPrivateKey(await readFile(resolve(keyPath), 'utf8'))
  } catch {
    fail(`${resolve(keyPath)} is not a readable private key in PEM form`)
  }
  if (priv.asymmetricKeyType !== 'rsa') fail(`${resolve(keyPath)} is not an RSA key, which the store needs`)
  const match = idOf(priv) === current && (await desktopIds()).includes(current)
  console.log(`extension ID check: ${match ? `match (${current}, which ob.Pal Desktop allows)` : 'mismatch'}`)
  if (!match) fail('the key does not give ob.Pal Link its ID (the manifest key and ob.Pal Desktop both expect it): nothing written')
  // PKCS#8 PEM, the form Chrome itself writes when it packs an extension.
  pem = priv.export({ type: 'pkcs8', format: 'pem' })
}

// ---- the store zip ----------------------------------------------------------------------------------------------

const paths = (await files(dist)).filter((p) => relative(dist, p).replace(/\\/g, '/') !== 'manifest.json')
const bytes = await zip(paths, dist, { 'manifest.json': manifestJson })
const storeZip = join(out, `obpal-link-${manifest.version}-store.zip`)
const entries = verify(bytes, false)
await mkdir(out, { recursive: true })
await writeFile(storeZip, bytes)
verify(await readFile(storeZip), false)
console.log(`ob.Pal Link ${manifest.version} for the Chrome Web Store`)
console.log(`  ${relative(repo, storeZip)} (${KB(bytes.length)}): ${entries.length} files, the manifest without its key`)
list(entries)

// ---- the first upload: with the key, outside the repository ---------------------------------------------------------

if (pem) {
  const withKey = await zip(paths, dist, { 'manifest.json': manifestJson, 'key.pem': pem })
  const first = verify(withKey, true)
  if (idOf(first.find((e) => e.name === 'key.pem').data.toString('utf8')) !== current) fail('key.pem in the zip does not give the ID')
  const keyZip = join(keyOut, `obpal-link-${manifest.version}-store-first-upload.zip`)
  await mkdir(keyOut, { recursive: true })
  await writeFile(keyZip, withKey, { mode: 0o600 })
  verify(await readFile(keyZip), true)
  console.log(`  first upload: ${keyZip} (${KB(withKey.length)}): ${first.length} files, key.pem at the root, the manifest without its key`)
  console.log('    (the files above, plus key.pem)')
  console.log('  Upload it once, to create the item, and delete it once the store has the item. Later uploads use the zip above.')
}
