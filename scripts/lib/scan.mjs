/**
 * What must never reach a commit or the public snapshot.
 *   SECRET_RULES   credentials and keys: private keys, API keys and tokens, Cloudflare account and zone ids.
 *   PRIVATE_RULES  what makes the open-source export refuse (scripts/open-source.mjs): local paths, personal
 *                  addresses, and the private words listed in the gitignored .open-source-deny.
 * scripts/merge-lane.mjs scans a lane's added lines with both, and its added file names with riskyPath().
 * scripts/open-source.mjs keeps local-only files (isLocalOnly) out of the export.
 *
 * Every rule is written so that its own source doesn't match it, and the tests build their samples at run time, so
 * this file and its tests pass their own scan. A finding never carries the matched text, only a masked hint.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{ id: string, what: string, re: RegExp, check?: (m: RegExpExecArray) => boolean }} Rule */

/** A value that looks generated rather than written: long enough, with both letters and digits. */
const random = (v) => v.length >= 24 && /[A-Za-z]/.test(v) && /\d/.test(v) && !/^(.)\1+$/.test(v)

/** @type {Rule[]} */
export const SECRET_RULES = [
  { id: 'private-key', what: 'a private key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-key', what: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', what: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/ },
  { id: 'stripe-key', what: 'a Stripe secret key', re: /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9+/=]{20,})/ },
  { id: 'slack-token', what: 'a Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-key', what: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'ai-key', what: 'an AI provider API key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{40,}/ },
  { id: 'npm-token', what: 'an npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'jwt', what: 'a JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'url-credentials', what: 'a URL with a password in it', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`]+:[^\s/@'"`]{6,}@[\w.-]+/i, check: (m) => !/:\/\/[^:]+:\$\{|<[^>]+>@/.test(m[0]) },
  { id: 'cf-account', what: 'a Cloudflare account or zone id', re: /(?:account|zone)[_-]?id["']?\s*[:=]\s*["']?[0-9a-f]{32}\b|\/(?:accounts|zones)\/[0-9a-f]{32}\b|dash\.cloudflare\.com\/[0-9a-f]{32}\b/i },
  { id: 'cf-resource', what: 'a Cloudflare resource id (D1, KV)', re: /"(?:database_id|preview_id|id)"\s*:\s*"(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/ },
  // NAME=value (an env file, a shell line) and name: 'value' (code, JSON, YAML) where the name says secret and the
  // value looks generated; ${VAR}, <placeholder> and process.env reads don't match.
  { id: 'secret-env', what: 'a secret in an env line', re: /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*=["']?([^\s"'$<{]{16,})/, check: (m) => random(m[1]) || m[1].length >= 32 },
  { id: 'secret-value', what: 'a secret-looking value', re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|client[_-]?secret|credential|auth[_-]?key)[\w-]*["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_=.-]{24,})["'`]/i, check: (m) => random(m[1]) },
]

/** The patterns scripts/open-source.mjs refuses to publish, besides keys: kept in step with it. @type {Rule[]} */
export const PRIVATE_RULES = [
  { id: 'windows-path', what: 'a local Windows path', re: /[A-Za-z]:[\\/]Users[\\/]/ },
  { id: 'home-path', what: 'a local home path', re: /\/(?:home|Users)\/[a-z][\w.-]+\// },
  { id: 'personal-email', what: 'a personal email address', re: /\b[\w.+-]+@(?:gmail|outlook|hotmail|yahoo|icloud)\.com\b/i },
]

/** Known-fake values in tests and docs (a made-up macOS path the local-folder resolver is tested with). */
export const ALLOW = ['/Users/art/']

/** The private words (names, emails, account ids) in the repo's gitignored .open-source-deny, one per line. */
export function readDenyWords(root) {
  const file = join(root, '.open-source-deny')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

/** A hint at what matched that gives nothing away: its first four characters and its length. */
export function mask(s) {
  return s.length <= 8 ? `${'*'.repeat(s.length)} (${s.length} chars)` : `${s.slice(0, 4)}… (${s.length} chars)`
}

/**
 * The findings in one piece of text (a line): `{ rule, what, hint }` per rule that matches. `deny` words are matched
 * case-insensitively and never echoed.
 * @param {string} text
 * @param {{ rules?: Rule[], deny?: string[] }} [opts]
 */
export function scanText(text, { rules = [...SECRET_RULES, ...PRIVATE_RULES], deny = [] } = {}) {
  const t = ALLOW.reduce((s, a) => s.split(a).join(''), text)
  const found = []
  for (const r of rules) {
    const m = r.re.exec(t)
    if (m && (!r.check || r.check(m))) found.push({ rule: r.id, what: r.what, hint: mask(m[0]) })
  }
  const lower = t.toLowerCase()
  for (const w of deny) if (lower.includes(w.toLowerCase())) { found.push({ rule: 'deny-word', what: 'a private word from .open-source-deny', hint: '' }); break }
  return found
}

/**
 * The added lines of a unified diff (`git diff -U0`), with the file and the line number each has in the new version,
 * and the files git reports as binary (which have no lines to scan).
 * @param {string} diff
 */
export function addedLines(diff) {
  const lines = []
  const binary = []
  let path = null
  let n = 0
  let inHunk = false
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('diff --git ')) { inHunk = false; path = null; continue }
    if (!inHunk) {
      if (line.startsWith('+++ ')) { const p = line.slice(4).replace(/\t.*$/, ''); path = p === '/dev/null' ? null : p.replace(/^"?b\//, '').replace(/"$/, '') }
      else if (line.startsWith('Binary files ')) { const m = / and "?b\/(.+?)"? differ$/.exec(line); if (m) binary.push(m[1]) }
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      inHunk = true
      n = m ? Number(m[1]) : 0
      continue
    }
    if (!inHunk || !path) continue
    if (line.startsWith('+')) lines.push({ path, line: n++, text: line.slice(1) })
    else if (line.startsWith(' ')) n++
  }
  return { lines, binary }
}

/** Files that stay on this machine: never committed, never exported (see .gitignore and .claude/README.md). */
export function isLocalOnly(path) {
  const p = path.split('\\').join('/')
  return /^\.claude\/(?:settings\.local\.json$|local\/|worktrees\/|launch\.json$|skills\/local-[^/]+\/|agents\/local-[^/]+\.md$)/.test(p)
    || /(?:^|\/)CLAUDE\.local\.md$/.test(p)
    || p === '.open-source-deny'
}

/** Why a file name alone should stop a merge (a key, an env file, a local-only file), or null. */
export function riskyPath(path) {
  const p = path.split('\\').join('/')
  const name = p.slice(p.lastIndexOf('/') + 1)
  if (/\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i.test(name)) return 'a key or certificate file'
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)) return 'an SSH private key'
  if (/^\.(?:env|dev\.vars)(?:\..+)?$/.test(name) && !/\.(?:example|sample|template)$/.test(name)) return 'an env file'
  if (/^\.(?:netrc|npmrc|pypirc)$/.test(name)) return 'a credentials file'
  if (isLocalOnly(p)) return 'a local-only file'
  return null
}
