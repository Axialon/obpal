/** A real pinned sample, a synthetic Astra delta, review gating and isolated checkout drift. */
import { tempScope } from '../lib/temp.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { archive, args, defaultOutbox, git, json, loadArchive, saveExchange, sha256, stageId, tree } from './common.mjs'
import { buildPack } from './pack.mjs'
import { intake } from './intake.mjs'
import { verify } from './verify.mjs'

export async function dryRun({ root, stage, outbox, port, workerPort, checkpoint }) {
  const temps = tempScope()
  try {
  stageId(stage)
  const evidence = join(root, 'artifacts', 'astra', stage)
  mkdirSync(evidence, { recursive: true }); mkdirSync(outbox, { recursive: true })
  const task = `# Sample: add a unit test for non-string code handles

Add one case to tests/code.test.ts proving that isCodeHandle refuses non-string input without coercion.
Use the existing runtime implementation in packages/core/src/code.ts. The returned delta is synthetic dry-run evidence.

## Acceptance
- Exercise numeric, null, undefined, object and array inputs; keep a valid string control.
- Run the private scan, overclaims, pnpm run check, and the code e2e suite locally.

## Out of scope
- Runtime, dependencies, UI, Desktop, deployment and all other files.
`
  writeFileSync(join(evidence, 'TASK.md'), task)
  const request = buildPack({ root, stage, task, globs: ['tests/code.test.ts', 'packages/core/src/code.ts'], budget: 1, checkpoint })
  const requestPath = saveExchange(outbox, stage, 'Request', request.bytes, request.prompt)
  const input = loadArchive(requestPath), path = 'tests/code.test.ts', before = input.members[`source/${path}`].toString()
  const lines = before.trimEnd().split('\n'), anchor = "describe('reading a typed code', () => {", position = lines.indexOf(anchor) + 1
  if (!position) throw new Error('Sample anchor moved; update the bounded dry-run fixture')
  const added = ["  it('refuses non-string code handles without coercion', () => {",
    "    for (const value of [48219, null, undefined, {}, ['48219']]) expect(isCodeHandle(value)).toBe(false)",
    "    expect(isCodeHandle('48219')).toBe(true)", '  })']
  const after = [...lines.slice(0, position), ...added, ...lines.slice(position)].join('\n') + '\n'
  const entry = tree(root, request.master).find((e) => e.path === path)
  const afterBlob = git(root, ['hash-object', '--stdin'], after).toString().trim()
  const patch = `diff --git a/${path} b/${path}\nindex ${entry.blob}..${afterBlob} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines.length} +1,${lines.length + added.length} @@\n`
    + [...lines.slice(0, position).map((l) => ` ${l}`), ...added.map((l) => `+${l}`), ...lines.slice(position).map((l) => ` ${l}`)].join('\n') + '\n'
  const members = {
    'STAGE.md': '# Synthetic stage\n\nFinding: non-string handle inputs lack a direct case.\nDecision: keep runtime unchanged.\n1. Add the case.\n2. Integrator runs the real gates.\nAcceptance is pending those gates.\n',
    'SOURCE_PRECONDITIONS.json': json({ schema_version: 1, stage, before: { [path]: sha256(before) } }),
    'patches/stage.patch': patch,
    'TESTS.md': 'E2E-SUITES: code\n\nActually executed by this synthetic author: none.\nIntegrator must run: private scan; pnpm exec vitest run tests/overclaims.test.ts; pnpm run check; pnpm run e2e:all -- code.\n',
    'HANDOFF.md': 'Risk: test-only change. Rollback: revert the as-received commit. Next bounded stage: coordinator review.\n',
    'OBPAL_START.txt': 'Run astra:intake on this synthetic stage ZIP using the retained request, then stop for coordinator review.\n',
  }
  const returnedPath = join(evidence, 'synthetic-stage.zip')
  writeFileSync(returnedPath, archive(members, { kind: 'stage', stage,
    input: { sha: request.master, archive_sha256: sha256(request.bytes), hashes: input.manifest.source_hashes },
    changed_paths: [path], new_paths: [], deleted_paths: [] }))
  const report = await intake({ root, returned: returnedPath, request: requestPath, outbox })
  writeFileSync(join(evidence, 'intake-report.json'), json(report))
  // This tool never approves its own output, even for a synthetic stage.
  const unapproved = await verify({ root, stage, outbox, port, workerPort })
  writeFileSync(join(evidence, 'approval-refusal.json'), json(unapproved))
  // The deliberate drift lives only in a temporary clone, never in the owner's working files.
  const clone = temps.makeSync(join(tmpdir(), 'obpal-astra-drift-'))
  git(root, ['clone', '--shared', '--no-checkout', '--quiet', '--branch', 'master', root, clone])
  git(clone, ['restore', '--source', 'master', '--worktree', '--', path])
  writeFileSync(join(clone, path), before + '\n// Synthetic checkout drift for refusal proof.\n')
  const driftInput = join(evidence, 'synthetic-drift-stage.zip')
  writeFileSync(driftInput, readFileSync(report.receivedPath || returnedPath))
  const drift = await intake({ root: clone, returned: driftInput, request: requestPath, outbox })
  writeFileSync(join(evidence, 'drift-report.json'), json(drift))
  const requestTree = Object.entries(input.members).map(([p, b]) => `${String(b.length).padStart(8)}  ${p}`).sort().join('\n')
  const summary = `Request: ${requestPath}\nZIP bytes: ${request.bytes.length}\nExpanded bytes: ${Object.values(input.members).reduce((n, b) => n + b.length, 0)}\n\n${requestTree}\n\nOne-paste prompt:\n${request.prompt}\nHappy intake: ${report.result}; ${report.branch}; ${report.head}\nReview: ${report.path}\nUnapproved verify: ${unapproved.result}; ${unapproved.deviations.join('\n')}\nRefusal ZIP: ${unapproved.path}\nDrift refusal: ${drift.result}; head ${drift.head}; ${drift.deviations.join('\n')}\nResult ZIP: ${drift.path}\n`
  writeFileSync(join(evidence, 'dry-run.txt'), summary)
  const proved = report.result === 'review-required' && unapproved.head === null && unapproved.deviations.some((d) => d.includes('Coordinator approval required'))
    && drift.result === 'failed' && drift.head === null && drift.deviations.some((d) => d.includes('Source drift'))
  return { proved, summary, evidence, report, drift, requestPath }
  } finally { await temps.cleanup() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { opts, positional } = args(process.argv.slice(2), ['stage', 'outbox', 'port', 'worker-port', 'checkpoint'])
    if (positional.length || !opts.stage || !opts.port || !opts['worker-port']) throw new Error('Usage: node scripts/astra/dry-run.mjs --stage <fresh-id> --port <stand-in> --worker-port <worker> [--outbox <dir>] [--checkpoint <json>]')
    const result = await dryRun({ root: process.cwd(), stage: opts.stage, outbox: resolve(opts.outbox ?? defaultOutbox()), port: opts.port,
      workerPort: opts['worker-port'], checkpoint: opts.checkpoint ? JSON.parse(readFileSync(opts.checkpoint, 'utf8')) : undefined })
    console.log(result.summary); process.exitCode = result.proved ? 0 : 1
  } catch (e) { console.error(`astra dry run: ${e.message}`); process.exitCode = 1 }
}
