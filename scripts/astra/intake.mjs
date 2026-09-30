import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { archive, args, beneath, defaultOutbox, denyWords, git, globMatch, guarded, json, loadArchive,
  masterSha, messageBudgetLine, REPOSITORY, saveExchange, scanMembers, sha256, stageId, SUITES, tree } from './common.mjs'
import { scanText, SECRET_RULES, PRIVATE_RULES } from '../lib/scan.mjs'
import { LIMITS } from './zip.mjs'
import { reviewStage } from './review.mjs'
import { reuseDependencies } from './dependencies.mjs'

const exact = (a, b) => json([...a].sort()) === json([...b].sort())
const required = ['STAGE.md', 'SOURCE_PRECONDITIONS.json', 'TESTS.md', 'HANDOFF.md', 'OBPAL_START.txt']
export const STAGE_LIMITS = { payload: 4 << 20, before: 4 << 20, literals: 4 << 20, touched: 1000 }

export function namedSuites(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('E2E-SUITES:'))
  if (lines.length !== 1) throw new Error('TESTS.md needs exactly one E2E-SUITES: line')
  const value = lines[0].slice(11).trim()
  if (value === 'none') return []
  const suites = value.split(',').map((s) => s.trim())
  if (!suites.length || new Set(suites).size !== suites.length || suites.some((s) => !SUITES.includes(s))) throw new Error('TESTS.md names a non-allowlisted e2e suite')
  return suites
}

/** Require canonical Git diffs so every target and before blob is audited before Git sees the patch. */
export function patchPaths(text, entries) {
  const paths = [], blocks = text.split(/^diff --git /m)
  let literals = 0
  if (blocks.shift().trim() || !blocks.length) throw new Error('Patch must contain canonical Git diffs')
  for (const block of blocks) {
    const lines = block.split('\n'), m = /^a\/([^ ]+) b\/([^ ]+)\r?$/.exec(lines[0])
    if (!m || m[1] !== m[2]) throw new Error('Patch renames or non-canonical paths refused')
    const p = guarded(m[1]), entry = entries.get(p)
    const header = lines.slice(1, lines.findIndex((l) => l.startsWith('@@') || l === 'GIT binary patch'))
    if (header.some((l) => /^(?:rename |copy |old mode |new mode )/.test(l)
      || /^(?:new file|deleted file) mode (?!100644\r?$)/.test(l))) throw new Error(`Patch mode refused: ${p}`)
    const index = /^index ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: (100644|100755))?\r?$/m.exec(header.join('\n'))
    if (!index || index[1] !== (entry?.blob ?? '0'.repeat(40))) throw new Error(`Patch before blob does not match pinned source: ${p}`)
    for (const line of header) {
      if (line.startsWith('--- ') && line !== `--- a/${p}` && line !== '--- /dev/null') throw new Error('Patch old path mismatch')
      if (line.startsWith('+++ ') && line !== `+++ b/${p}` && line !== '+++ /dev/null') throw new Error('Patch new path mismatch')
    }
    if (!/^@@ /m.test(block) && !/^GIT binary patch$/m.test(block)) throw new Error('Patch has no content delta')
    if (/^GIT binary patch$/m.test(block)) {
      if (/^delta /m.test(block)) throw new Error('Binary delta hunks refused; use bounded literal hunks')
      const sizes = [...block.matchAll(/^literal (\d+)$/gm)].map((m) => Number(m[1]))
      literals += sizes.reduce((n, size) => n + size, 0)
      if (!sizes.length || sizes.some((n) => n > LIMITS.member)) throw new Error('Binary patch size cap')
      if (literals > STAGE_LIMITS.literals) throw new Error('Binary patch expansion exceeds bounded stage cap')
    }
    paths.push(p)
  }
  if (new Set(paths).size !== paths.length) throw new Error('Repeated path in patches')
  return paths
}

export function verifyStage({ root, returned, request }) {
  const r = loadArchive(returned), q = loadArchive(request), m = r.manifest, input = q.manifest
  if (m.kind !== 'stage' || input.kind !== 'request') throw new Error('Wrong exchange kind')
  stageId(m.stage)
  if (m.stage !== input.stage || m.input?.sha !== input.master_sha || m.input?.archive_sha256 !== sha256(q.bytes)
    || !m.input?.hashes || !exact(Object.keys(m.input.hashes), Object.keys(input.source_hashes))
    || Object.entries(input.source_hashes).some(([p, hash]) => m.input.hashes[p] !== hash)) throw new Error('Return does not match retained request or input hashes')
  const currentMaster = masterSha(root)
  if (currentMaster !== input.master_sha) throw new Error(`Master drift: expected ${input.master_sha}, actual ${currentMaster}; request a fresh stage`)
  for (const name of required) if (!r.members[name]) throw new Error(`Required member missing: ${name}`)
  for (const name of Object.keys(r.members)) {
    if (![...required, 'MANIFEST.json'].includes(name) && !/^patches\/[a-zA-Z0-9_-]+\.patch$/.test(name) && !name.startsWith('files/')) throw new Error(`Unexpected archive member: ${name}`)
  }
  const groups = ['changed_paths', 'new_paths', 'deleted_paths']
  if (groups.some((g) => !Array.isArray(m[g]) || m[g].some((p) => typeof p !== 'string'))) throw new Error('Invalid changed path inventory')
  const touched = groups.flatMap((g) => m[g]), lower = touched.map((p) => p.toLowerCase())
  if (!touched.length || new Set(lower).size !== touched.length) throw new Error('Empty or overlapping changed path inventory')
  if (touched.length > STAGE_LIMITS.touched) throw new Error('Touched path count exceeds bounded stage cap')
  const pre = JSON.parse(r.members['SOURCE_PRECONDITIONS.json'].toString())
  if (pre.schema_version !== 1 || pre.stage !== m.stage || !pre.before || !exact(Object.keys(pre.before), touched)) throw new Error('Preconditions must cover exactly the touched paths')
  const entries = new Map(tree(root, input.master_sha).map((e) => [e.path, e]))
  if (touched.reduce((n, p) => n + (entries.get(p)?.size ?? 0), 0) > STAGE_LIMITS.before) throw new Error('Before content exceeds bounded stage cap')
  const existingLower = new Map([...entries.keys()].map((p) => [p.toLowerCase(), p]))
  const prefixes = new Map()
  for (const path of entries.keys()) for (const prefix of path.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'))) prefixes.set(prefix.toLowerCase(), prefix)
  const drift = []
  for (const p of touched) {
    guarded(p)
    const entry = entries.get(p), isNew = m.new_paths.includes(p)
    if (isNew ? existingLower.has(p.toLowerCase()) || pre.before[p] !== null
      : !entry || !input.export_scope.paths.includes(p) || pre.before[p] !== input.source_hashes[p]) throw new Error(`Invalid pinned precondition: ${p}`)
    if (isNew && (!globMatch(p, input.export_scope.globs) || input.export_scope.trimmed.some((t) => t.path === p))) throw new Error(`New path outside export scope: ${p}`)
    const path = beneath(root, p), bytes = existsSync(path) ? readFileSync(path) : null, current = bytes ? sha256(bytes) : null
    // Git's clean conversion reconciles LF/CRLF checkouts with the pinned blobs. Arbitrary content drift still fails.
    const gitEquivalent = bytes && entry && git(root, ['hash-object', `--path=${p}`, '--stdin'], bytes).toString().trim() === entry.blob
    if (current !== pre.before[p] && !gitEquivalent) drift.push(`${p}: expected ${pre.before[p] ?? 'absent'}, actual ${current ?? 'absent'}`)
    for (const ancestor of p.split('/').map((_, i, a) => a.slice(0, i + 1).join('/')).slice(0, -1)) {
      if (entries.has(ancestor)) throw new Error(`Non-directory ancestor: ${ancestor}`)
      if (prefixes.has(ancestor.toLowerCase()) && prefixes.get(ancestor.toLowerCase()) !== ancestor) throw new Error(`Case-colliding ancestor: ${ancestor}`)
    }
  }
  if (drift.length) throw new Error(`Source drift; nothing applied:\n${drift.join('\n')}`)
  const patches = Object.keys(r.members).filter((p) => p.startsWith('patches/')).sort()
  if (Object.entries(r.members).filter(([p]) => p.startsWith('patches/') || p.startsWith('files/')).reduce((n, [, b]) => n + b.length, 0) > STAGE_LIMITS.payload) throw new Error('Return payload exceeds bounded stage cap')
  const literalBytes = patches.flatMap((p) => [...r.members[p].toString().matchAll(/^literal (\d+)$/gm)]).reduce((n, m) => n + Number(m[1]), 0)
  if (literalBytes > STAGE_LIMITS.literals) throw new Error('Binary patch size cap: combined expansion exceeds bounded stage cap')
  const patched = patches.flatMap((p) => patchPaths(r.members[p].toString(), entries))
  const files = Object.keys(r.members).filter((p) => p.startsWith('files/'))
  for (const name of files) if (!m.new_paths.includes(name.slice(6))) throw new Error('files/ may only carry declared new paths')
  if (!exact([...patched, ...files.map((p) => p.slice(6))], touched)
    || new Set([...patched, ...files.map((p) => p.slice(6))]).size !== touched.length) throw new Error('Patch/file inventory differs from declared paths')
  scanMembers(r.members, denyWords(root))
  const suites = namedSuites(r.members['TESTS.md'].toString())
  return { ...r, touched, patches, files, suites, base: currentMaster }
}

/** A failed three-way apply is left in its isolated lane for review, never committed or auto-resolved. */
export function applyStage(root, stage) {
  for (const name of stage.patches) git(root, ['apply', '--3way', '--whitespace=error', '-'], stage.members[name])
  for (const name of stage.files) {
    const destination = beneath(root, name.slice(6))
    if (existsSync(destination)) throw new Error('files/ cannot overwrite a path')
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, stage.members[name], { flag: 'wx' })
  }
  if (stage.files.length) git(root, ['add', '--', ...stage.files.map((p) => p.slice(6))])
  const states = git(root, ['diff', '--cached', '--name-status', '--no-renames', '-z']).toString().split('\0').filter(Boolean)
  const actual = { M: [], A: [], D: [] }
  for (let i = 0; i < states.length; i += 2) {
    if (!actual[states[i]]) throw new Error('Unexpected applied path status')
    actual[states[i]].push(states[i + 1])
  }
  if (!exact(actual.M, stage.manifest.changed_paths) || !exact(actual.A, stage.manifest.new_paths) || !exact(actual.D, stage.manifest.deleted_paths)) throw new Error('Actual applied delta differs from return inventory')
  const candidate = tree(root, git(root, ['write-tree']).toString().trim())
  for (const e of candidate) {
    if (stage.touched.includes(e.path) && !['100644', '100755'].includes(e.mode)) throw new Error('Applied symlink or submodule refused')
    if (stage.touched.includes(e.path) && e.size > LIMITS.member) throw new Error('Applied file size cap')
  }
  // Decoded binary patches can hide private text from the archive scan. Inspect staged blobs before any commit.
  scanMembers(Object.fromEntries(candidate.filter((e) => stage.touched.includes(e.path)).map((e) => [e.path, git(root, ['cat-file', 'blob', e.blob])])), denyWords(root))
  git(root, ['commit', '-m', `Apply Astra stage ${stage.manifest.stage} as received`])
  return git(root, ['rev-parse', 'HEAD']).toString().trim()
}

function redact(text, deny, records, member, onRedaction = () => {}) {
  return text.split(/\r?\n/).map((line, i) => {
    const hits = scanText(line, { deny, rules: [...SECRET_RULES, ...PRIVATE_RULES] })
    if (!hits.length) return line
    if (records.length < 1000) records.push({ member, line: i + 1, rules: hits.map((h) => h.rule) })
    else if (records.length === 1000) records.push({ summary: 'Additional private lines were removed', additional_lines: 1 })
    else records[1000].additional_lines++
    onRedaction()
    return '[redacted private content; exit code is unchanged]'
  }).join('\n')
}

function pnpmCommand() {
  if (process.env.npm_execpath && /[\\/](?:pnpm\.(?:cjs|js)|pnpm\.mjs)$/.test(process.env.npm_execpath)) return [process.execPath, [process.env.npm_execpath]]
  if (process.platform !== 'win32') return ['pnpm', []]
  const where = spawnSync('where.exe', ['pnpm.cmd'], { encoding: 'utf8', windowsHide: true })
  for (const cmd of (where.stdout ?? '').trim().split(/\r?\n/)) {
    for (const relative of ['node_modules/corepack/dist/pnpm.js', 'node_modules/pnpm/bin/pnpm.cjs']) {
      const cli = join(dirname(cmd), relative)
      if (existsSync(cli)) return [process.execPath, [cli]]
    }
  }
  throw new Error('Could not locate a trusted pnpm Node entry point')
}

async function localRun(root, argv, env) {
  const win = process.platform === 'win32'
  const [command, prefix] = pnpmCommand()
  // No shell, including on Windows. Only our fixed commands and allowlisted suite names are arguments.
  return new Promise((done) => {
    const child = spawn(command, [...prefix, ...argv], { cwd: root, env, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []; let size = 0, stopped = '', terminating = null
    const stop = (reason) => {
      if (terminating) return terminating
      stopped = reason
      terminating = new Promise((yes) => {
        if (win && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
          killer.once('error', () => { child.kill(); yes() }); killer.once('close', yes)
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill() }
          yes()
        }
      })
      return terminating
    }
    const collect = (data) => {
      size += data.length
      if (size <= 8 << 20) chunks.push(data)
      else stop('Log size cap reached; process tree stopped, evidence incomplete')
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect)
    const timer = setTimeout(() => stop('Gate timed out; process tree stopped'), 30 * 60_000)
    const interrupt = () => stop('Verification interrupted; process tree stopped')
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt)
    child.once('error', (e) => { chunks.push(Buffer.from(e.message)); stopped = 'Gate could not start' })
    child.once('close', async (code) => {
      clearTimeout(timer); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt)
      if (terminating) await terminating
      done({ exit_code: stopped ? -1 : code ?? -1, log: Buffer.concat(chunks).toString() + (stopped ? `\n${stopped}\n` : '') })
    })
  })
}

async function portsFree(ports) {
  for (const port of ports) await new Promise((yes, no) => {
    const server = createServer()
    server.once('error', () => no(new Error(`Port ${port} is busy; no server started`)))
    server.listen(port, '127.0.0.1', () => server.close(yes))
  })
}

export const intake = (options) => exchange({ ...options, mode: 'intake' })
export const verification = (options) => exchange({ ...options, mode: 'verify' })

async function exchange({ root, returned, request, stage: requestedStage, mode, outbox, port, workerPort, run = localRun }) {
  const steps = [], members = {}, redactions = [], deviations = []
  let logBudget = 8 << 20
  let stage = 'rejected', base = masterSha(root), head = null, lane = null, verified = null, commits = [], privateRefused = false
  let message_budget
  const deny = denyWords(root)
  const capture = (name, text, knownSize = Buffer.byteLength(text)) => {
    if (knownSize > logBudget) {
      members[name] = '[Evidence omitted because the result log budget was exceeded; the original gate exit code is unchanged.]\n'
      if (!steps.some((s) => s.step === 'evidence-cap')) steps.push({ step: 'evidence-cap', status: 'failed', exit_code: 1 })
      deviations.push(`Log budget exceeded: ${name}; inspect the local raw gate logs.`)
      return
    }
    members[name] = redact(text, deny, redactions, name); logBudget -= knownSize
  }
  const record = (name, result, command = null) => {
    const logName = `acceptance/${name}.log`
    capture(logName, result.log)
    members[`acceptance/${name}.json`] = json({ command, exit_code: result.exit_code })
    steps.push({ step: name, status: result.exit_code === 0 ? 'verified' : 'failed', exit_code: result.exit_code })
    return result.exit_code === 0
  }
  try {
    if (mode === 'intake') {
      outbox ??= defaultOutbox()
      // The trusted retained request is never located using a path provided by the returned manifest.
      if (!request) {
        const digest = loadArchive(returned).manifest.input?.archive_sha256
        const matches = readdirSync(outbox).filter((n) => /^obpal-.*-Request-.*\.zip$/.test(n)).map((n) => join(outbox, n))
          .filter((p) => statSync(p).isFile() && statSync(p).size <= LIMITS.archive)
          .filter((p) => sha256(readFileSync(p)) === digest)
        if (matches.length !== 1) throw new Error('Retained request not uniquely found; supply --request <original.zip>')
        request = matches[0]
      }
      const input = loadArchive(request).manifest
      stage = stageId(input.stage); message_budget = input.message_budget
      verified = verifyStage({ root, returned, request }); base = verified.base
      record('preflight', { exit_code: 0, log: 'Archive hashes, retained request, pinned master, scope, before hashes and path safety verified.\n' })
      const destination = beneath(root, `.claude/worktrees/astra-${stage}`)
      if (existsSync(destination)) throw new Error('Stage worktree already exists; use a fresh stage id')
      git(root, ['worktree', 'add', '-b', `astra/${stage}`, destination, 'master'])
      lane = destination
      if (masterSha(root) !== base || git(lane, ['rev-parse', 'HEAD']).toString().trim() !== base) throw new Error('Master changed during worktree creation')
      head = applyStage(lane, verified); commits = [{ sha: head, subject: `Apply Astra stage ${stage} as received` }]
      record('apply', { exit_code: 0, log: `${verified.patches.length} patches applied with git apply --3way; ${verified.files.length} new files added.\nCommitted ${head}.\n` })
      steps.at(-1).status = 'applied'
      const review = reviewStage(lane, base, head, verified.touched, verified.files)
      const evidence = beneath(root, `artifacts/astra/${stage}`)
      mkdirSync(evidence, { recursive: true })
      const reviewPath = join(evidence, 'review.md')
      writeFileSync(reviewPath, review.markdown, { flag: 'wx' })
      writeFileSync(join(evidence, 'stage.json'), json({ schema_version: 1, stage, base, head,
        touched: verified.touched, suites: verified.suites, outbox, message_budget,
        review_sha256: sha256(review.markdown), lock_changed: review.lockChanged }), { flag: 'wx' })
      return { path: reviewPath, result: 'review-required', steps, head, branch: `astra/${stage}`, deviations }
    }
    stage = stageId(requestedStage)
    const evidence = beneath(root, `artifacts/astra/${stage}`)
    const state = JSON.parse(readFileSync(join(evidence, 'stage.json'), 'utf8'))
    if (state.schema_version !== 1 || state.stage !== stage) throw new Error('Invalid local stage state')
    message_budget = state.message_budget
    outbox ??= state.outbox
    if (!outbox) throw new Error('Local stage has no outbox')
    base = state.base
    const review = readFileSync(join(evidence, 'review.md'), 'utf8').replace(/\r\n/g, '\n')
    if (!/^approved:[^\r\n]*$/m.test(review)) throw new Error('Coordinator approval required: add an approved: line to review.md after reviewing the complete delta; nothing executed')
    const unapproved = review.replace(/^approved:[^\r\n]*(?:\r?\n|$)/gm, '')
    if (sha256(unapproved) !== state.review_sha256) throw new Error('Review report changed beyond the approval marker; nothing executed')
    lane = beneath(root, `.claude/worktrees/astra-${stage}`)
    if (git(lane, ['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim() !== `astra/${stage}`
      || git(lane, ['rev-parse', 'HEAD']).toString().trim() !== state.head
      || git(lane, ['status', '--porcelain', '--untracked-files=all']).toString().trim()) throw new Error('Approved lane drift: head, branch or working files changed; nothing executed')
    const actual = git(lane, ['diff', '--name-only', '--no-renames', '-z', base, state.head]).toString().split('\0').filter(Boolean)
    if (!exact(actual, state.touched) || state.lock_changed !== actual.includes('pnpm-lock.yaml')) throw new Error('Local stage inventory drift; nothing executed')
    head = state.head
    verified = { touched: actual, suites: state.suites, manifest: { stage } }
    if (!Array.isArray(verified.suites) || verified.suites.some((s) => !SUITES.includes(s))) throw new Error('Invalid local suite inventory')
    commits = [{ sha: head, subject: `Apply Astra stage ${stage} as received` }]
    record('approval', { exit_code: 0, log: `Coordinator marker present; reviewed head ${head} and clean lane verified.\n` })
    if (verified.suites.length) {
      const ports = [Number(port), Number(workerPort)]
      if (ports.some((p) => !Number.isInteger(p) || p < 1024 || p > 65535 || [5173, 5174, 5175, 5176, 3000, 3001, 3002, 3003, 8080].includes(p)) || ports[0] === ports[1]) throw new Error('Supply two distinct authorised ports via --port and --worker-port')
      await portsFree(ports)
    }
    const snapshot = Object.fromEntries(tree(lane, head).filter((e) => verified.touched.includes(e.path)).map((e) => [e.path, git(lane, ['cat-file', 'blob', e.blob])]))
    let scanned = true
    try { scanMembers(snapshot, deny) } catch (e) { scanned = false; privateRefused = true; record('private-scan', { exit_code: 1, log: e.message }) }
    if (scanned) record('private-scan', { exit_code: 0, log: `${Object.keys(snapshot).length} changed/new files scanned; deleted files have no remaining content.\n` })
    const runtimeLogs = mkdtempSync(join(tmpdir(), 'obpal-astra-runtime-'))
    const env = { ...process.env, OBPAL_E2E_PORT: String(port ?? ''), OBPAL_E2E_WORKER_PORT: String(workerPort ?? ''),
      WRANGLER_LOG_PATH: runtimeLogs, WRANGLER_SEND_METRICS: 'false' }
    // Never inherit a production upstream or an override that could disable the Desktop guard.
    delete env.OBPAL_E2E_UPSTREAM; delete env.OBPAL_DESKTOP_LOG
    let ready = scanned
    if (ready && state.lock_changed) {
      // Only a changed lockfile permits installation, after coordinator approval.
      ready = record('install', await run(lane, ['install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(tmpdir(), 'pnpm-store-obpal')], env), 'pnpm install --frozen-lockfile --ignore-scripts')
    }
    if (ready && !state.lock_changed && run === localRun) reuseDependencies(root, lane, base, head)
    if (ready) {
      const overclaims = await run(lane, ['exec', 'vitest', 'run', 'tests/overclaims.test.ts'], env)
      record('overclaims', overclaims, 'pnpm exec vitest run tests/overclaims.test.ts')
      if (overclaims.exit_code === -1) {
        ready = false; steps.push({ step: 'check', status: 'blocked', reason: 'previous gate interrupted, timed out or could not start' })
      } else {
        const check = await run(lane, ['run', 'check'], env)
        record('check', check, 'pnpm run check'); ready = check.exit_code !== -1
      }
      if (ready && verified.suites.length) {
        await portsFree([Number(port), Number(workerPort)])
        const logs = mkdtempSync(join(tmpdir(), 'obpal-astra-e2e-'))
        record('e2e', await run(lane, ['run', 'e2e:all', '--', ...verified.suites, '--out', logs], env), `pnpm run e2e:all -- ${verified.suites.join(' ')}`)
        for (const suite of verified.suites) {
          const log = join(logs, `${suite}.log`)
          if (existsSync(log)) {
            const name = `acceptance/e2e-${suite}.log`
            const size = statSync(log).size
            capture(name, size > logBudget ? '' : readFileSync(log, 'utf8'), size)
          }
        }
      } else steps.push({ step: 'e2e', status: 'blocked', reason: ready ? 'TESTS.md declares no browser suites; none run' : 'previous gate interrupted, timed out or could not start' })
    } else {
      for (const step of ['overclaims', 'check', 'e2e']) steps.push({ step, status: 'blocked', reason: scanned ? 'dependency install failed' : 'private scan failed' })
    }
  } catch (e) {
    privateRefused ||= e.message.startsWith('Private scan refused')
    if (mode === 'verify' && !head) {
      steps.push({ step: 'approval', status: 'blocked', reason: 'no returned code executed' })
      lane = null
    }
    const detail = redact(e.message, deny, redactions, 'acceptance/refusal.log')
    capture('acceptance/refusal.log', detail)
    members['acceptance/refusal.json'] = json({ exit_code: 1 })
    steps.push({ step: head ? 'verification' : lane ? 'apply' : 'preflight', status: 'failed', exit_code: 1 })
    deviations.push(detail)
  }
  const pending = lane ? git(lane, ['status', '--porcelain']).toString().trim() : ''
  if (pending) {
    deviations.push('The isolated lane has uncommitted or conflicted changes; coordinator inspection is required.')
    record('lane-status', { exit_code: 1, log: pending })
  }
  const failed = steps.some((s) => s.status === 'failed'), blocked = steps.some((s) => s.status === 'blocked' && s.step !== 'e2e')
  const result = failed ? 'failed' : blocked ? 'blocked' : 'verified'
  const next = failed || blocked ? 'Review the refusal or failed logs; keep red evidence and send a bounded reconciliation stage.' : 'Coordinator: review the lane and evidence, then merge with scripts/merge-lane.mjs if accepted.'
  const committed = head ? new Map(tree(lane, head).map((e) => [e.path, e])) : new Map()
  const hashes = head ? Object.fromEntries(verified.touched.map((p) => [p, committed.has(p) ? sha256(git(lane, ['cat-file', 'blob', committed.get(p).blob])) : null])) : {}
  members['RESULT.md'] = `# Stage ${stage}: ${result}\n\n${steps.map((s) => `- ${s.step}: ${s.status}${s.exit_code === undefined ? '' : ` (exit ${s.exit_code})`}${s.reason ? `; ${s.reason}` : ''}`).join('\n')}\n\nNext: ${next}\n`
  members['INTEGRATION.md'] = `# Integration\n\nBranch: ${lane ? `astra/${stage}` : 'none'}. Merged: never.\n\n${commits.length ? commits.map((c) => `${c.sha} ${c.subject}`).join('\n') : 'No commit made.'}\n\nThe coordinator owns review, merge, push and deployment.\n`
  const delta = lane && !privateRefused ? git(lane, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', base, head ?? '--']).toString() : ''
  let patchRedacted = false
  members['actual.patch'] = redact(delta, deny, redactions, 'actual.patch', () => { patchRedacted = true })
  if (patchRedacted) deviations.push('actual.patch has private lines redacted; exact delta remains local; do not apply this report patch.')
  if (privateRefused) {
    deviations.push('actual.patch withheld after private scan refusal, including opaque binary payloads. No safe integration delta is available.')
    redactions.push({ member: 'actual.patch', reason: 'Withheld after private scan refusal' })
  }
  members['SOURCE.json'] = json({ base_sha: base, head, changed_paths: head ? verified.touched : [], hashes,
    pending_status: redact(pending, deny, redactions, 'SOURCE.json'), deviations })
  members['REDACTIONS.json'] = json(redactions)
  const prompt = `You are Astra reconciling ob.Pal stage ${stage}. Read MANIFEST.json, RESULT.md, SOURCE.json, INTEGRATION.md, actual.patch, acceptance/ and REDACTIONS.json in the attached result ZIP. Preserve every real failed, blocked or unexecuted check. Do not claim merged or deployed. Deliver one precise, coherent reconcile with findings and the next bounded stage; changes need a fresh pinned request ZIP. Never replay a stale stage or invent green results.
Working within the message budget
${messageBudgetLine(message_budget)} This is the request's budget checkpoint; the owner's ledger records subsequent usage. Each round trip costs Astra one message. Plan internally, resolve questions from the pack/GitHub, list assumptions and report actual self-checks. If needed, include a coherent partial with a precise continuation plan in this message.\n`
  members['ASTRA_START.txt'] = prompt
  const path = saveExchange(outbox ?? defaultOutbox(), stage, 'Return', archive(members, { kind: 'result', stage, result, message_budget }), prompt)
  return { path, result, steps, head, branch: lane ? `astra/${stage}` : null, deviations }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { opts, positional } = args(process.argv.slice(2), ['request', 'outbox'])
    if (positional.length !== 1) throw new Error('Usage: astra:intake -- <returned.zip> [--request <original.zip>] [--outbox <dir>]')
    const report = await intake({ root: process.cwd(), returned: resolve(positional[0]), request: opts.request ? resolve(opts.request) : undefined,
      outbox: resolve(opts.outbox ?? defaultOutbox()) })
    console.log(json(report)); process.exitCode = report.result === 'review-required' ? 0 : 1
  } catch (e) { console.error(`astra:intake: ${e.message}`); process.exitCode = 1 }
}
