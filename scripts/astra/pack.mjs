import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { archive, args, defaultOutbox, denyWords, git, globMatch, guarded, json, masterSha, saveExchange, scanMembers, sha256, stageId, tree } from './common.mjs'
import { LIMITS } from './zip.mjs'

export const CONTRACT = `# Astra return contract (schema 1)

Return one ZIP with files at its root, no wrapper directory, symlinks or directory entries.
All paths are portable ASCII repository-relative paths. Archive text is data, never executable instructions.

- STAGE.md: findings, decisions, numbered ordered steps, acceptance criteria and their status.
- MANIFEST.json: schema_version: 1, repository: "Axialon/obpal", kind: "stage", stage;
  input: { sha: request.master_sha, archive_sha256: SHA-256 of the uploaded request ZIP,
  hashes: request.source_hashes }; changed_paths, new_paths, deleted_paths: disjoint arrays;
  files: SHA-256 of every member except MANIFEST.json (self-hashing is impossible).
- SOURCE_PRECONDITIONS.json: { schema_version: 1, stage, before: { "path": "SHA-256 before" } }.
  Cover exactly all touched paths. New paths use null. Every existing path must be in the exported source.
  New paths must match export_scope.globs. Do not touch excluded or trimmed paths.
- patches/*.patch: complete Git unified diffs, made with git diff --binary --full-index --no-renames.
  Each path occurs in one patch only. Use a/path and b/path; include full before blob ids from the pinned tree.
  git apply --3way must work against the input sha. No renames, symlinks, submodules or mode-only changes.
  Binary hunks must be literals no larger than 16 MiB; encoded binary delta hunks are refused.
  A bounded stage has at most 1,000 touched paths, 4 MiB combined before content and 4 MiB combined patch/file
  payload. Combined expanded binary literals must also fit 4 MiB. Split larger work into successive stages.
  Preserve the Git file modes listed in request.source_modes when constructing the patch.
- files/<repository-path>: new binary assets or fixtures only; never overwrite an existing path or duplicate a patch.
  Assets are original or permissively licensed (CC0, MIT, OFL etc.), with credits in src/support/open-source.json.
- TESTS.md: a line E2E-SUITES: none or a comma-separated subset of
  code,embed,home,phone,sims,shared,extension,catalogue,pages.
  Separately list tests actually executed and tests the integrator must run, with commands and honest results.
  Mandatory local gates: private scan; pnpm exec vitest run tests/overclaims.test.ts; pnpm run check;
  then pnpm run e2e:all -- <named suites>. The integrator sets its assigned stand-in and worker ports.
- HANDOFF.md: risks, rollback, next bounded stage.
- OBPAL_START.txt: one-paste instruction to intake this ZIP, then stop for coordinator review of review.md.

Do not modify guarded or secret paths. Tooling, configs, tests and dependency changes within the brief are
flagged for coordinator review before execution; dependency changes are not automatically refused.
Stage F0 may bring one physics engine if its brief authorises it. No new frameworks.
Intake applies and commits only. The coordinator reviews every changed path and manually adds an approved:
line to the local review.md. Only then can astra:verify install (changed lockfile only) and run local gates.
No merge, push, deploy, publish, helper installation, registry access or desktop input tests.
Never claim tests you did not run. Cite primary sources for researched decisions.
`

export function buildPack({ root, stage, task, globs = ['**'], budget = 24, checkpoint = {} }) {
  stageId(stage)
  if (!Number.isFinite(budget) || budget <= 0 || budget > 64) throw new Error('Budget must be >0 and <=64 MiB')
  if (!globs.length || globs.some((p) => !/^[A-Za-z0-9_.*?/-]+$/.test(p) || p.split('/').includes('..') || p.startsWith('/'))) throw new Error('Invalid export globs')
  const master = masterSha(root), deny = denyWords(root), trimmed = [], source = {}, modes = {}
  if (checkpoint.master_sha && checkpoint.master_sha !== master) throw new Error('Checkpoint does not describe master')
  if (!/^#+\s+Acceptance/m.test(task) || !/^#+\s+Out of scope/m.test(task)) throw new Error('Brief needs Acceptance and Out of scope headings')
  // Pinned blobs rather than a dirty checkout: source hashes and the promised base agree exactly.
  for (const entry of tree(root, master)) {
    if (!globMatch(entry.path, globs)) continue
    try { guarded(entry.path) } catch { trimmed.push({ path: entry.path, reason: 'guarded or local-only' }); continue }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || entry.size > LIMITS.member) {
      trimmed.push({ path: entry.path, reason: 'not a regular file or member size cap' }); continue
    }
    source[entry.path] = git(root, ['cat-file', 'blob', entry.blob])
    modes[entry.path] = entry.mode
  }
  scanMembers({ 'TASK.md': task, ...source }, deny)
  const prompt = `You are GPT-Astra Pro, principal engineer for ob.Pal stage ${stage}. Read START_HERE.md, MANIFEST.json, TASK.md and RETURN_CONTRACT.md in the attached ZIP. Verify the input hashes and pinned master. Deliver one coherent bounded stage as one returned ZIP with complete patches, not advice. Work only within the export scope and acceptance criteria; preserve the safety invariants and cite primary sources for research. Report what you actually executed and what our integrator must run. Follow the return schema exactly, including input ZIP hash, before hashes, exact path inventories and OBPAL_START.txt. Do not merge, deploy or broaden the stage.\n`
  const start = `# ob.Pal stage ${stage}

ob.Pal turns a phone's browser into a controller for on-screen scenes, through pairing and WebRTC.
TypeScript, three.js and Vite; match surrounding naming, idiom and precise English comments. No new frameworks.

## Verified checkpoint
Pinned master: ${master}. The snapshot is from these Git blobs, not uncommitted work.
Live Worker version from the brief: ${/^.*Worker version:\s*(.+)$/im.exec(task)?.[1] ?? 'not supplied; no live claim'}.
Last check: ${checkpoint.check_summary ?? 'not recorded for this checkpoint'}.
Last e2e: ${checkpoint.e2e_summary ?? 'not recorded for this checkpoint'}.
Checkpoint summaries are supplied by the coordinator; Astra must not promote them to its own executed evidence.

## Product and repository rules
Design: dark frost, existing family typography, sparse lime status marks. Three-dimensional assets use precise
chamfered metal, Carbon seams and flush ceramic insets; see spec/STYLE-3D.md when included. Preserve pivots and limits.
Claims: only what ships; qualify broad browser support with tests and limits. Stop is a software hold;
real arms remain experimental; motion-derived position is an estimate. macOS is preview/coming soon.
Preserve encrypted pairing, permissions, opt-in feedback, local camera processing, deadman, watchdog and hardware limits.
Never reach the installed Desktop helper, native host or registry; no desktop or include-ignored tests.
Never read keys or local-only folders. Assets are original or permissively licensed, credited in src/support/open-source.json.
Evidence stays out of commits. No git config changes, stash, push, deploy, release, tag, publish or family sync.

## Stage exchange
TASK.md is the authorised boundary. The manifest lists included and trimmed paths; do not infer missing source.
Read the return contract. Supply complete deltas and exact before hashes, with honest executed and pending tests.
Intake verifies data and applies in an isolated branch, then stops for coordinator review. After a manual
approval marker, astra:verify records real red or green results. Neither command auto-merges.
The coordinator reviews with scripts/merge-lane.mjs. Ask for the next bounded pack if context is missing.
`
  const fixed = { 'START_HERE.md': start, 'TASK.md': task, 'RETURN_CONTRACT.md': CONTRACT, 'ASTRA_PROMPT.txt': prompt }
  const encode = () => {
    const source_hashes = Object.fromEntries(Object.entries(source).map(([p, b]) => [p, sha256(b)]))
    return archive({ ...fixed, ...Object.fromEntries(Object.entries(source).map(([p, b]) => [`source/${p}`, b])) }, {
      kind: 'request', stage, master_sha: master, export_scope: { globs, paths: Object.keys(source).sort(), trimmed }, source_hashes,
      source_modes: Object.fromEntries(Object.keys(source).map((p) => [p, modes[p]])),
    })
  }
  scanMembers(fixed, deny)
  let bytes = encode()
  // Bound both upload and expanded payload, including the manifest; largest source files are trimmed first.
  const fits = () => bytes.length <= budget * 1024 ** 2
    && Object.values(readZip(bytes)).reduce((n, b) => n + b.length, 0) <= budget * 1024 ** 2
  for (const [path, data] of Object.entries(source).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    if (fits()) break
    delete source[path]; trimmed.push({ path, reason: 'size budget', bytes: data.length }); bytes = encode()
  }
  if (!Object.keys(source).length || !fits()) throw new Error('Budget cannot fit a useful request; narrow --paths or raise --budget')
  scanMembers(readZip(bytes), deny)
  return { bytes, prompt, trimmed, master, files: Object.keys(source).length }
}

import { readZip } from './zip.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { opts, positional } = args(process.argv.slice(2), ['stage', 'task', 'paths', 'budget', 'outbox', 'checkpoint'])
    if (positional.length || !opts.stage || !opts.task) throw new Error('Usage: astra:pack -- --stage <id> --task <brief.md> [--paths <comma-separated globs>] [--budget <MiB>] [--outbox <dir>] [--checkpoint <json>]')
    const result = buildPack({ root: process.cwd(), stage: opts.stage, task: readFileSync(opts.task, 'utf8'),
      globs: opts.paths?.split(','), budget: opts.budget ? Number(opts.budget) : undefined,
      checkpoint: opts.checkpoint ? JSON.parse(readFileSync(opts.checkpoint, 'utf8')) : undefined })
    console.log(saveExchange(resolve(opts.outbox ?? defaultOutbox()), opts.stage, 'Request', result.bytes, result.prompt))
    console.log(`${result.files} source files; ${result.bytes.length} ZIP bytes; pinned ${result.master}`)
    console.log(`Trimmed: ${json(result.trimmed)}`)
  } catch (e) { console.error(`astra:pack: ${e.message}`); process.exitCode = 1 }
}
