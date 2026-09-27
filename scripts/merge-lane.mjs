/**
 * Merge a lane's branch into the checked-out branch of the main checkout, the coordinator's way, with one summary:
 *   1. review  the commits (target..branch), what they change, who wrote them, whether the lane merged the target;
 *   2. scan    every added line, file name and commit message, for keys and credentials and for what the open-source
 *              snapshot refuses (local paths, personal addresses, the private words in .open-source-deny); any finding
 *              stops here, masked (scripts/lib/scan.mjs);
 *   3. merge   --no-ff, as this repo's identity, with the lane's co-author trailer;
 *   4. checks  pnpm install --frozen-lockfile when the lockfile changed, then typecheck and vitest.
 * It never pushes, deploys or publishes anything.
 *
 *   node scripts/merge-lane.mjs <branch> [-m "Merge …: what it brings"] [--dry-run] [--allow <path>[:<line>]]...
 *   --dry-run  review and scan only.
 *   --allow    a finding you have read and accept (a test's made-up credential): its file, or file:line.
 *
 * Refuses (exit 2): a linked worktree (run it from the main checkout), tracked changes, a merge in progress, a detached
 * HEAD, an unknown branch, and the public snapshots' identity. The identity: OBPAL_GIT_NAME and OBPAL_GIT_EMAIL, else
 * this checkout's git config (set it once there with `git config user.name …` and `git config user.email …`).
 * The trailer: the lane's own Co-Authored-By, else OBPAL_CO_AUTHOR, else Claude's.
 * Exit codes: 0 merged and green (or nothing to merge), 1 typecheck or vitest failed after the merge (the merge
 * stays; look before you go on), 2 refused, 3 conflicts (the merge is left in progress for you to resolve).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyAllow, DEFAULT_CO_AUTHOR, parseArgs, parseVitest, pickCoAuthor, PUBLIC_EMAIL, summarizeNumstat } from './lib/merge.mjs'
import { formatDuration, formatTable } from './lib/report.mjs'
import { addedLines, PRIVATE_RULES, readDenyWords, riskyPath, scanText, SECRET_RULES } from './lib/scan.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const win = process.platform === 'win32'
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 })
const gitStatus = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20 })
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function refuse(why) {
  console.error(`merge-lane: not merging. ${why}`)
  process.exit(2)
}

let opts
try {
  opts = parseArgs(process.argv.slice(2))
} catch (e) {
  refuse(e.message)
}
if (opts.help) {
  console.log('node scripts/merge-lane.mjs <branch> [-m "Merge …"] [--dry-run] [--allow <path>[:<line>]]...')
  process.exit(0)
}
const { branch } = opts

// ---- where we are --------------------------------------------------------------------------------------------------
const same = (a, b) => (win ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b))
const gitDir = git(['rev-parse', '--path-format=absolute', '--git-dir']).trim()
const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
if (!same(gitDir, commonDir)) refuse('This is a linked worktree (a lane\'s). Merging is the coordinator\'s job: run it from the main checkout.')
const target = gitStatus(['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim()
if (!target) refuse('HEAD is detached; check out the branch to merge into.')
if (gitStatus(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0) refuse('A merge is already in progress here; finish or abort it first.')
if (gitStatus(['rev-parse', '-q', '--verify', `${branch}^{commit}`]).status !== 0) refuse(`There is no branch or commit "${branch}".`)
const dirty = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean)
if (dirty.length) refuse(`The tree has tracked changes (commit or set them aside first):\n  ${dirty.slice(0, 10).join('\n  ')}${dirty.length > 10 ? `\n  … ${dirty.length - 10} more` : ''}`)

// ---- 1. review -----------------------------------------------------------------------------------------------------
const range = `${target}..${branch}`
const commits = git(['log', '--format=%h%x09%ae%x09%s', range]).split('\n').filter(Boolean).map((l) => {
  const [sha, email, ...s] = l.split('\t')
  return { sha, email, subject: s.join('\t') }
})
if (!commits.length) {
  console.log(`merge-lane: ${branch} has nothing ${target} lacks; nothing to merge.`)
  process.exit(0)
}
const stat = summarizeNumstat(git(['diff', '--numstat', '-M', `${target}...${branch}`]))
const behind = Number(git(['rev-list', '--count', `${branch}..${target}`]).trim())
const lockChanged = gitStatus(['diff', '--quiet', `${target}...${branch}`, '--', 'pnpm-lock.yaml']).status === 1

// ---- 2. scan -------------------------------------------------------------------------------------------------------
const deny = readDenyWords(root)
const found = []
const { lines, binary } = addedLines(git(['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff', '-M', `${target}...${branch}`]))
for (const l of lines) for (const f of scanText(l.text, { deny })) found.push({ path: l.path, line: l.line, ...f })
const names = git(['-c', 'core.quotePath=false', 'diff', '--name-only', '--diff-filter=ACR', '-M', '-z', `${target}...${branch}`]).split('\0').filter(Boolean)
for (const p of names) {
  const why = riskyPath(p)
  if (why) found.push({ path: p, rule: 'path', what: why, hint: '' })
  for (const f of scanText(p, { rules: PRIVATE_RULES, deny })) found.push({ path: p, ...f, what: `${f.what} in the file name` })
}
// Commit messages stay in this repo's history (the snapshot leaves them out), so only credentials count there.
const messages = git(['log', '--format=%h%x00%B%x1e', range]).split('\x1e').map((e) => e.replace(/^\s+/, '')).filter(Boolean)
for (const entry of messages) {
  const [sha, body = ''] = entry.split('\0')
  body.split('\n').forEach((t, i) => { for (const f of scanText(t, { rules: SECRET_RULES })) found.push({ path: `commit ${sha}`, line: i + 1, ...f }) })
}
const { standing, allowed } = applyAllow(found, opts.allow)
const where = (f) => `${f.path}${f.line !== undefined ? `:${f.line}` : ''}`
if (standing.length) {
  console.error(`merge-lane: not merging ${branch}. The scan found ${standing.length} thing${standing.length > 1 ? 's' : ''} that must not be committed:`)
  for (const f of standing.slice(0, 30)) console.error(`  ${where(f)}  ${f.what}${f.hint ? `  ${f.hint}` : ''}`)
  if (standing.length > 30) console.error(`  … ${standing.length - 30} more`)
  console.error('Have the lane remove them (and rewrite its commits if a real secret got in). A finding you have read and accept: --allow <path>[:<line>].')
  process.exit(2)
}

// ---- identity and trailer ------------------------------------------------------------------------------------------
const config = (k) => gitStatus(['config', k]).stdout.trim()
const name = process.env.OBPAL_GIT_NAME || config('user.name')
const email = process.env.OBPAL_GIT_EMAIL || config('user.email')
if (!name || !email) refuse('No identity: set OBPAL_GIT_NAME and OBPAL_GIT_EMAIL, or git config user.name / user.email in this checkout.')
if (email.toLowerCase() === PUBLIC_EMAIL) refuse(`The identity is the public snapshots' (${PUBLIC_EMAIL}), which this repo's history never uses. Set this checkout's own once (git config user.name …; git config user.email …) or OBPAL_GIT_NAME / OBPAL_GIT_EMAIL.`)
const coAuthor = pickCoAuthor(messages, process.env.OBPAL_CO_AUTHOR || DEFAULT_CO_AUTHOR)
const publicCommits = commits.filter((c) => c.email.toLowerCase() === PUBLIC_EMAIL).length

const rows = []
rows.push(['review', 'ok', `${commits.length} commit${commits.length > 1 ? 's' : ''}, ${stat.files} files, +${stat.added} -${stat.deleted}${lockChanged ? ', lockfile changed' : ''}`])
if (behind) rows.push(['', 'WARN', `${branch} is ${behind} commit${behind > 1 ? 's' : ''} behind ${target} (the lane didn't merge it before handing back)`])
if (publicCommits) rows.push(['', 'WARN', `${publicCommits} commit${publicCommits > 1 ? 's' : ''} by the public identity ${PUBLIC_EMAIL}`])
rows.push(['scan', 'clean', `${lines.length} added lines, ${names.length} new files, ${messages.length} messages${binary.length ? `; ${binary.length} binary files unscanned` : ''}${deny.length ? '' : '; no .open-source-deny here'}`])
for (const f of allowed) rows.push(['', 'allowed', `${where(f)} ${f.what} (--allow)`])

function summary(code) {
  console.log(`\nmerge-lane: ${branch} into ${target}\n${formatTable(['step', 'result', 'detail'], rows)}`)
  console.log(`\ncommits:\n  ${commits.slice(0, 15).map((c) => `${c.sha} ${cut(c.subject, 110)}`).join('\n  ')}${commits.length > 15 ? `\n  … ${commits.length - 15} more` : ''}`)
  console.log(`\nlargest changes: ${stat.biggest.slice(0, 8).map((f) => `${f.path} (${f.binary ? 'binary' : `+${f.added} -${f.deleted}`})`).join(', ')}`)
  console.log('Nothing was pushed or deployed.')
  process.exit(code)
}

if (opts.dryRun) {
  rows.push(['merge', 'skipped', `dry run; would merge --no-ff as ${name} <${email}>, trailer Co-Authored-By: ${coAuthor}`])
  summary(0)
}

// ---- 3. merge ------------------------------------------------------------------------------------------------------
const before = git(['rev-parse', 'HEAD']).trim()
const subject = opts.message || `Merge ${branch}`
const message = /^Co-Authored-By:/im.test(subject) ? subject : `${subject}\n\nCo-Authored-By: ${coAuthor}`
const merged = gitStatus(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'merge', '--no-ff', '--no-edit', '-m', message, branch])
if (merged.status !== 0) {
  const conflicts = git(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean)
  if (!conflicts.length) refuse(`git merge failed:\n  ${`${merged.stdout}${merged.stderr}`.trim().split('\n').slice(-8).join('\n  ')}`)
  rows.push(['merge', 'CONFLICT', `${conflicts.length} file${conflicts.length > 1 ? 's' : ''}: ${conflicts.slice(0, 8).join(', ')}${conflicts.length > 8 ? ', …' : ''}`])
  rows.push(['next', '', `resolve, git add, then git -c user.name="${name}" -c user.email=… commit --no-edit (keeps the message); ${lockChanged ? 'pnpm install --frozen-lockfile; ' : ''}pnpm run check`])
  summary(3)
}
const sha = git(['rev-parse', '--short', 'HEAD']).trim()
rows.push(['merge', 'ok', `${sha} (--no-ff, as ${name})`])

// ---- 4. checks -----------------------------------------------------------------------------------------------------
const run = (cmd, args) => {
  const t0 = Date.now()
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', shell: win, maxBuffer: 256 << 20, windowsHide: true })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, ms: Date.now() - t0 }
}
const lockfileMoved = gitStatus(['diff', '--quiet', before, 'HEAD', '--', 'pnpm-lock.yaml']).status === 1
let failedOutput = ''
if (lockfileMoved) {
  const install = run('pnpm', ['install', '--frozen-lockfile'])
  rows.push(['install', install.ok ? 'ok' : 'FAIL', `pnpm install --frozen-lockfile, ${formatDuration(install.ms)}`])
  if (!install.ok) failedOutput += install.out.trim().split('\n').slice(-10).join('\n')
} else rows.push(['install', 'skipped', 'lockfile unchanged'])
const tc = run('pnpm', ['run', 'typecheck'])
const tsErrors = tc.out.split('\n').filter((l) => /error TS\d+/.test(l))
rows.push(['typecheck', tc.ok ? 'ok' : 'FAIL', tc.ok ? formatDuration(tc.ms) : `${tsErrors.length} errors`])
if (!tc.ok) failedOutput += `\n${(tsErrors.length ? tsErrors : tc.out.trim().split('\n').slice(-10)).slice(0, 15).join('\n')}`
const vt = run('npx', ['vitest', 'run'])
const v = parseVitest(vt.out)
rows.push(['vitest', vt.ok ? 'ok' : 'FAIL', v ? `${v.passed}/${v.total}${v.failed ? ` (${v.failed} failed)` : ''}${v.skipped ? `, ${v.skipped} skipped` : ''}, ${v.files} files, ${formatDuration(vt.ms)}` : `no summary; exit ${vt.ok ? 0 : 'non-zero'}`])
if (!vt.ok) failedOutput += `\n${vt.out.split('\n').filter((l) => /FAIL|×|✗|Error:/.test(l)).slice(0, 15).join('\n')}`
if (failedOutput.trim()) console.log(`\n${failedOutput.trim()}`)
if (!tc.ok || !vt.ok || rows.some((r) => r[0] === 'install' && r[1] === 'FAIL')) {
  rows.push(['after', '', `the merge ${sha} stays; fix forward, or undo it with git reset --hard ${before.slice(0, 7)} (it discards the merge)`])
  summary(1)
}
summary(0)
