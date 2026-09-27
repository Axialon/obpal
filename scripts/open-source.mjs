/**
 * Publish ob.Pal as open source.
 *
 * Steps:
 * 1. Export the tracked files.
 * 2. Replace deployment-only identifiers with placeholders.
 * 3. Scan the export for anything private and refuse to go on if it finds something.
 * 4. With --publish, commit the export to the public repository as one snapshot.
 *
 * The development history and author identities stay private; public commits use the GitHub noreply address.
 *
 *   node scripts/open-source.mjs            export and scan only (prints where the export is)
 *   node scripts/open-source.mjs --publish  also commit and push it to github.com/Axialon/obpal
 *
 * Private words to scan for (names, emails, account ids), one per line, go in `.open-source-deny` next to this
 * repo's root. That file is gitignored, so the scanner itself reveals nothing.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOW, isLocalOnly, PRIVATE_RULES, readDenyWords } from './lib/scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC_REPO = 'Axialon/obpal'
const AUTHOR = ['-c', 'user.name=Axialon', '-c', 'user.email=axialon@users.noreply.github.com']
const publish = process.argv.includes('--publish')
const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })

// ---- 1. export ----------------------------------------------------------------------------------------------------
// Tracked files only, and never the local-only ones even if one got tracked (.claude/settings.local.json, .claude/local/,
// local-* skills and agents, CLAUDE.local.md: see scripts/lib/scan.mjs).
const files = git(['ls-files', '-z']).split('\0').filter((f) => f && !isLocalOnly(f))
const out = mkdtempSync(join(tmpdir(), 'obpal-open-source-'))
for (const f of files) {
  mkdirSync(dirname(join(out, f)), { recursive: true })
  copyFileSync(join(root, f), join(out, f))
}

// ---- 2. deployment identifiers become placeholders -------------------------------------------------------------------
const SANITIZE = {
  'wrangler.jsonc': (s) => s
    .replace(/"database_id":\s*"[^"]+"/, '"database_id": "<your-d1-database-id>"')
    .replace(/"STRIPE_SPONSOR_PORTAL_URL":\s*"[^"]*"/, '"STRIPE_SPONSOR_PORTAL_URL": ""')
    .replace(/^\{/, '// Deployment settings for obpal.blackboxes.net. For your own deployment, change the route, the D1 database id\n// and the vars, and set the secrets listed at the end.\n{'),
}
for (const [f, fix] of Object.entries(SANITIZE)) {
  const p = join(out, f)
  if (existsSync(p)) writeFileSync(p, fix(readFileSync(p, 'utf8')))
}

// ---- 3. scan ------------------------------------------------------------------------------------------------------
const deny = readDenyWords(root)
// Local paths and personal addresses (shared with the lane merge's scan, scripts/lib/scan.mjs), then keys.
const PATTERNS = [
  ...PRIVATE_RULES.map((r) => [r.re, r.what]),
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(sk|rk)_live_[A-Za-z0-9]{20,}/, 'a live Stripe key'],
  [/\bwhsec_[A-Za-z0-9]{20,}/, 'a Stripe webhook secret'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
  [/"database_id":\s*"[0-9a-f-]{36}"/, 'a D1 database id'],
]
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|jsonc|md|html|css|svg|txt|yml|yaml|toml|webmanifest|gitignore)$|^[^.]+$/
const problems = []
function scan(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '.git') scan(p); continue }
    const rel = relative(out, p).split('\\').join('/')
    if (/\.(pem|key|p12|pfx)$/i.test(rel) || /(^|\/)\.(env|dev\.vars)/.test(rel)) { problems.push(`${rel}: key or env file`); continue }
    if (!TEXT.test(e.name) || statSync(p).size > 4 << 20) continue
    const text = ALLOW.reduce((t, a) => t.split(a).join(''), readFileSync(p, 'utf8'))
    for (const [re, what] of PATTERNS) if (re.test(text)) problems.push(`${rel}: ${what}`)
    for (const word of deny) if (text.toLowerCase().includes(word.toLowerCase())) problems.push(`${rel}: a private word from .open-source-deny`)
  }
}
scan(out)
if (problems.length) {
  console.error(`Not publishing: ${problems.length} problem(s) in the export (${out})\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log(`Export clean: ${files.length} files, ${deny.length} private words checked -> ${out}`)
if (!publish) process.exit(0)

// ---- 4. publish -------------------------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'obpal-public-'))
let exists = true
try { execFileSync('gh', ['repo', 'view', PUBLIC_REPO], { stdio: 'ignore' }) } catch { exists = false }
if (exists) git(['clone', '--quiet', `https://github.com/${PUBLIC_REPO}.git`, work], tmpdir())
else git(['init', '--quiet', '-b', 'main', work], tmpdir())
for (const e of readdirSync(work)) if (e !== '.git') rmSync(join(work, e), { recursive: true, force: true })
for (const f of files) {
  mkdirSync(dirname(join(work, f)), { recursive: true })
  copyFileSync(join(out, f), join(work, f))
}
git(['add', '-A'], work)
if (!git(['status', '--porcelain'], work).trim()) { console.log('Public repository already up to date.'); process.exit(0) }
const version = JSON.parse(readFileSync(join(root, 'extension/package.json'), 'utf8')).version
git([...AUTHOR, 'commit', '--quiet', '-m', `ob.Pal snapshot (ob.Pal Link ${version})`], work)
if (!exists) {
  execFileSync('gh', ['repo', 'create', PUBLIC_REPO, '--public', '--source', work, '--push',
    '--description', 'Your phone as a controller for 3D, games and your PC: no app, pair by QR. WebRTC, open protocol.',
    '--homepage', 'https://obpal.blackboxes.net'], { stdio: 'inherit' })
} else git(['push', '--quiet', 'origin', 'main'], work)
console.log(`Published to https://github.com/${PUBLIC_REPO}`)
