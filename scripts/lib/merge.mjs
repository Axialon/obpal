/**
 * The pure parts of the lane merge (scripts/merge-lane.mjs): its arguments, what `git diff --numstat` and vitest
 * say, which co-author trailer the merge carries, and which scan findings the coordinator has accepted.
 */
import { stripAnsi } from './report.mjs'

/** The identity of the public snapshots (scripts/open-source.mjs), which this repo's own history never uses. */
export const PUBLIC_EMAIL = 'axialon@users.noreply.github.com'
/** The trailer a merge carries when the lane's commits name none and OBPAL_CO_AUTHOR is unset. */
export const DEFAULT_CO_AUTHOR = 'Claude Opus 5.5 <noreply@anthropic.com>'

/**
 * `<branch> [-m <message>] [--dry-run] [--allow <path>[:<line>]]... [--help]`. Throws on anything else.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = { branch: '', message: '', dryRun: false, allow: [], help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '-m' || a === '--message') opts.message = argv[++i] ?? ''
    else if (a.startsWith('--message=')) opts.message = a.slice(10)
    else if (a === '--allow') opts.allow.push(argv[++i] ?? '')
    else if (a.startsWith('--allow=')) opts.allow.push(a.slice(8))
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
    else if (!opts.branch) opts.branch = a
    else throw new Error(`one branch at a time (got ${opts.branch} and ${a})`)
  }
  if (!opts.help && !opts.branch) throw new Error('which branch? node scripts/merge-lane.mjs <branch> [-m "Merge …"] [--dry-run]')
  if (opts.allow.some((a) => !a)) throw new Error('--allow needs <path> or <path>:<line>')
  return opts
}

/**
 * `git diff --numstat` in figures: files, lines added and removed, and the files that changed most (binary files
 * count as changed, with no lines).
 * @param {string} numstat
 * @param {number} [top]
 */
export function summarizeNumstat(numstat, top = 12) {
  const files = numstat.split('\n').filter(Boolean).map((l) => {
    const [a, d, ...p] = l.split('\t')
    return { path: p.join('\t'), added: a === '-' ? 0 : Number(a), deleted: d === '-' ? 0 : Number(d), binary: a === '-' }
  })
  const added = files.reduce((s, f) => s + f.added, 0)
  const deleted = files.reduce((s, f) => s + f.deleted, 0)
  const biggest = [...files].sort((x, y) => y.added + y.deleted - (x.added + x.deleted)).slice(0, top)
  return { files: files.length, added, deleted, biggest }
}

/**
 * What vitest reported: its `Test Files` and `Tests` lines (`Tests  2 failed | 505 passed (507)`). null: no summary
 * (it crashed first).
 * @param {string} output
 */
export function parseVitest(output) {
  const text = stripAnsi(output)
  const read = (label) => {
    const m = new RegExp(`^\\s*${label}\\s+(.+?)\\s*\\((\\d+)\\)\\s*$`, 'm').exec(text)
    if (!m) return null
    const n = (word) => Number(new RegExp(`(\\d+) ${word}`).exec(m[1])?.[1] ?? 0)
    return { passed: n('passed'), failed: n('failed'), skipped: n('skipped') + n('todo'), total: Number(m[2]) }
  }
  const tests = read('Tests')
  return tests && { ...tests, files: read('Test Files')?.total ?? 0 }
}

/** The co-author trailer for the merge: the last one the lane's own messages carry, else `fallback`. */
export function pickCoAuthor(messages, fallback = DEFAULT_CO_AUTHOR) {
  let found = ''
  for (const msg of messages) for (const m of msg.matchAll(/^Co-Authored-By:\s*(.+?)\s*$/gim)) found = m[1]
  return found || fallback
}

/**
 * Split scan findings into those still standing and those the coordinator accepted with --allow <path> (every
 * finding in that file) or --allow <path>:<line>.
 * @template {{ path: string, line?: number }} F
 * @param {F[]} findings
 * @param {string[]} allow
 */
export function applyAllow(findings, allow) {
  const accepted = (f) => allow.some((a) => a === f.path || (f.line !== undefined && a === `${f.path}:${f.line}`))
  return { standing: findings.filter((f) => !accepted(f)), allowed: findings.filter(accepted) }
}
