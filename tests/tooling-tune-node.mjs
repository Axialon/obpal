/** Synthetic tooling proof uses only temporary fixtures. */
import assert from 'node:assert/strict'
import { openSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { distill, rawRun, classifyFrames } from '../scripts/lib/distill.mjs'
import { suitesForPaths, suiteGraph } from '../scripts/lib/suites.mjs'
import { archiveEvidence, verifyEvidence, verifyLaneArchive } from '../scripts/lib/evidence-archive.mjs'
import { digestLane } from '../scripts/lanes/digest.mjs'
import { execFileSync } from 'node:child_process'
import { cleanupLane, withLedger, writeLedger, readLedger, waitLane, stopFinalLane, laneState } from '../scripts/lanes/lib.mjs'
import { treeSize } from '../scripts/lib/maintenance.mjs'

const fixture = async action => {
  const root = mkdtempSync(join(tmpdir(), 'obpal-tooling-test-'))
  try { await action(root) } finally { rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }) }
}
const picture = path => sharp({ create: { width: 80, height: 60, channels: 3, background: '#aabbcc' } }).png().toFile(path)
const repo = fileURLToPath(new URL('..', import.meta.url))
export const cases = [
  { name: 'wait keeps polling stalled live lanes through quiet commands and ledger contention', run: async () => {
    let clock = 2_000_000, polls = 0
    const pauses = []
    const result = await waitLane(() => {
      polls++
      if (polls === 2) throw new Error('Lane ledger is locked; retry after the other command finishes')
      const alive = polls < 5, final = polls === 5
      return { alive, state: laneState({ alive, final, startedAt: 0, now: clock }) }
    }, 1, { now: () => clock, pause: async ms => { pauses.push(ms); clock += ms } })
    assert.equal(polls, 5); assert.equal(result.state, 'final')
    assert.deepEqual(pauses, [2000, 5000, 2000, 2000])
    await assert.rejects(waitLane(() => ({ state: 'stalled', alive: true }), 0.01, { now: () => clock, pause: async ms => { clock += ms } }), /timed out.*continues running/)
    assert.equal((await waitLane(() => ({ state: 'stalled', alive: false }), 1)).state, 'stalled')
  } },
  ...['EPERM', 'EACCES', 'EBUSY'].map(code => ({ name: `ledger retries transient ${code} lock creation failures`, run: () => fixture(async root => {
    const file = join(root, 'lanes.json'); let attempts = 0
    await withLedger(file, ledger => { ledger.note = 'retried' }, { open(path, flags) {
      if (++attempts <= 2) throw Object.assign(new Error('synthetic transient lock failure'), { code })
      return openSync(path, flags)
    } })
    assert.equal(attempts, 3); assert.equal(readLedger(file).note, 'retried'); assert.equal(existsSync(`${file}.lock`), false)
  }) })),
  { name: 'final lanes stop only their own fresh process tree and wait for the supervisor', run: async () => {
    const lane = { name: 'alpha', worktree: '/synthetic/codex-alpha', threadId: 'thread-alpha' }
    const other = { name: 'beta', worktree: '/synthetic/codex-beta', threadId: 'thread-beta' }
    const own = { pid: 21, parentPid: 1, name: 'codex.exe', commandLine: 'codex exec resume thread-alpha' }
    const child = { pid: 22, parentPid: 21, name: 'node.exe', commandLine: 'synthetic child' }
    const app = { pid: 30, parentPid: 1, name: 'codex.exe', commandLine: 'codex app-server' }
    const sibling = { pid: 40, parentPid: 1, name: 'codex.exe', commandLine: 'codex exec resume thread-beta' }
    let inventory = [own, child, app, sibling], supervisor = true, pauses = 0
    const killed = [], logs = []
    await stopFinalLane(lane, [lane, other], {
      inventory: () => inventory,
      status: () => ({ state: 'final', alive: supervisor }),
      kill: tree => { killed.push(tree.tree.map(p => p.pid)); inventory = [app, sibling] },
      pause: async () => { pauses++; supervisor = false }, log: text => logs.push(text),
    })
    assert.deepEqual(killed, [[21, 22]]); assert.equal(pauses, 1); assert.equal(inventory.length, 2)
    assert.match(logs[0], /Stopped lingering final.*alpha/)
    for (const state of ['running', 'stalled', 'failed', 'stopped']) await stopFinalLane(lane, [lane, other], {
      inventory: () => [own], status: () => ({ state, alive: true }), kill: () => assert.fail('must not stop unfinished lanes'),
    })
    await assert.rejects(stopFinalLane(lane, [lane, other], {
      inventory: () => [app, sibling], status: () => ({ state: 'final', alive: true }), kill: () => assert.fail('unsafe kill'),
    }), /no safe Codex match/)
    for (const commandLine of ['codex app-server', 'codex exec resume thread-beta']) await assert.rejects(stopFinalLane(lane, [lane, other], {
      inventory: () => [own, { ...child, commandLine }], status: () => ({ state: 'final', alive: true }), kill: () => assert.fail('unsafe descendant'),
    }), /Refusing/)
    let reads = 0
    await stopFinalLane(lane, [lane, other], {
      inventory: () => ++reads < 3 ? [own] : [app],
      status: rows => ({ state: 'final', alive: rows.includes(own) }), kill: () => assert.fail('stale PID must not authorize a kill'), log() {},
    })
  } },

  { name: 'permits other ledger commands during archive and removal, and refuses a changed round', run: () => fixture(async root => {
    const file = join(root, 'lanes.json'), lane = { name: 'example', branch: 'codex/example', worktree: root, ports: {}, rounds: [{ number: 1 }] }
    writeLedger(file, { version: 1, lanes: [lane] })
    const commands = [], options = {
      prepare() {},
      async archive() { await withLedger(file, ledger => { ledger.note = 'archive concurrent'; commands.push('archive') }); return 'verified' },
      async remove() { assert(readLedger(file).lanes[0].cleaningAt); await withLedger(file, ledger => { ledger.note = 'removal concurrent'; commands.push('removal') }) },
    }
    await cleanupLane(file, 'example', options)
    assert.deepEqual(commands, ['archive', 'removal']); assert(readLedger(file).lanes[0].cleanedAt)
    writeLedger(file, { version: 1, lanes: [lane] })
    await assert.rejects(cleanupLane(file, 'example', { ...options, async archive() { await withLedger(file, ledger => ledger.lanes[0].rounds.push({ number: 2 })); return 'verified' }, remove() { assert.fail('must not remove a changed lane') } }), /changed during archive/)
  }) },
  { name: 'distils independent sequences and retains hashes and all metrics before raw deletion', run: () => fixture(async root => {
    for (const folder of ['one-frames', 'two-frames']) {
      mkdirSync(join(root, folder))
      for (let i = 0; i < 5; i++) await picture(join(root, folder, `${i}.png`))
    }
    writeFileSync(join(root, 'metrics.json'), '{"passed":true}')
    writeFileSync(join(root, 'evidence-frames.json'), JSON.stringify({ expectedCount: 10, frames: ['one-frames', 'two-frames'].flatMap(folder => Array.from({ length: 5 }, (_, i) => ({ path: `${folder}/${i}.png`, diff: folder === 'one-frames' && i === 2 ? 3 : 0, threshold: 4, failed: false }))) }))
    const result = await distill(root)
    assert.equal(result.rawCount, 10); assert.equal(result.classification.status, 'pass')
    assert(result.keyframes.includes('one-frames/0.png')); assert(result.keyframes.includes('one-frames/2.png')); assert(result.keyframes.includes('two-frames/4.png'))
    assert.equal(existsSync(join(root, 'one-frames/0.png')), false)
    assert.equal(result.afterBytes, treeSize(root))
    const hashes = JSON.parse(readFileSync(join(root, 'distilled/raw-frames.json')))
    assert.equal(hashes.frames.length, 10); assert.match(hashes.frames[0].sha256, /^[a-f0-9]{64}$/)
    assert(hashes.frames[0].createdAt); verifyEvidence(root, result)
    assert.equal((await distill(root)).rawCount, 10)
  }) },
  { name: 'retains raw on request and on encode failure; missing and threshold samples fail deterministically', run: () => fixture(async root => {
    const raw = rawRun(root)
    try {
      await picture(join(raw, '0.png'))
      const kept = await distill(root, { keepRaw: true }); assert.equal(kept.keepRaw, true); assert(existsSync(join(raw, '0.png')))
      writeFileSync(join(root, 'evidence-frames.json'), JSON.stringify({ frames: [{ path: '0.png', failed: true }] }))
      await assert.rejects(distill(root, { encode() { throw new Error('fixture encoder failed') } }), /encoder failed/)
      assert(existsSync(join(raw, '0.png')))
      assert.equal(classifyFrames([{ path: '0', diff: 5, threshold: 4 }], 2).status, 'fail')
      assert.equal(classifyFrames([{ path: '0' }]).status, 'unclassified')
    } finally { rmSync(raw, { recursive: true, force: true }) }
  }) },
  { name: 'archives summaries first, skips raw conventions, honors full artifacts and reports stale proof', run: () => fixture(async root => {
    const lane = join(root, 'codex-example'), out = join(lane, 'artifacts'), runs = join(root, 'runs')
    mkdirSync(join(out, 'raw'), { recursive: true }); writeFileSync(join(out, 'raw/frame.bin'), 'raw')
    writeFileSync(join(out, 'metrics.json'), '{}')
    const archive = archiveEvidence(lane, runs), manifest = JSON.parse(readFileSync(join(archive, 'manifest.json')))
    assert.deepEqual(manifest.skipped.map(file => file.path), ['raw/frame.bin']); assert.equal(manifest.skipped[0].bytes, 3)
    const full = archiveEvidence(lane, runs, { now: new Date('2026-01-01'), fullArtifacts: true })
    assert(existsSync(join(full, 'artifacts/raw/frame.bin')))
    await picture(join(out, 'raw/0.png')); await distill(out)
    writeFileSync(join(out, 'metrics.json'), 'changed')
    const fresh = archiveEvidence(lane, join(root, 'fresh')), saved = JSON.parse(readFileSync(join(fresh, 'manifest.json')))
    assert(saved.advisory.some(item => item.path === 'metrics.json' && item.reason === 'digest mismatch'))
    verifyLaneArchive(lane, fresh)
    writeFileSync(join(fresh, 'artifacts/metrics.json'), 'corrupt')
    assert.throws(() => verifyEvidence(fresh, saved), /digest mismatch/)
  }) },
  { name: 'archives fresh bytes after nested redistillation, appended logs and newline conversion', run: () => fixture(async root => {
    const lane = join(root, 'codex-example'), out = join(lane, 'artifacts'), child = join(out, 'child')
    mkdirSync(join(child, 'raw'), { recursive: true }); await picture(join(child, 'raw/0.png'))
    writeFileSync(join(child, 'runner.log'), 'first\n'); await distill(child); await distill(out)
    await picture(join(child, 'raw/0.png')); await distill(child)
    writeFileSync(join(child, 'runner.log'), 'first\r\ncompleted\r\n')
    const folder = archiveEvidence(lane, join(root, 'runs')), manifest = JSON.parse(readFileSync(join(folder, 'manifest.json')))
    assert(manifest.advisory.some(item => item.manifest === 'distill-manifest.json' && item.path === 'child/distilled/raw-frames.json'))
    assert(manifest.advisory.some(item => item.manifest === 'child/distill-manifest.json' && item.path === 'child/runner.log'))
    assert.equal(readFileSync(join(folder, 'artifacts/child/runner.log'), 'utf8'), 'first\r\ncompleted\r\n')
    verifyLaneArchive(lane, folder)
  }) },
  { name: 'treats missing and invalid advisory entries as reports and retains listed raw summaries', run: () => fixture(async root => {
    const lane = join(root, 'codex-example'), out = join(lane, 'artifacts')
    mkdirSync(join(out, 'raw'), { recursive: true }); writeFileSync(join(out, 'raw/metrics.json'), '{}')
    writeFileSync(join(out, 'raw/frame.bin'), 'raw')
    writeFileSync(join(out, 'distill-manifest.json'), JSON.stringify({ verified: false, files: [{ path: 'raw/metrics.json', sha256: 'stale' }, { path: 'missing.png' }, { path: '../outside' }] }))
    writeFileSync(join(out, 'raw/distill-manifest.json'), '{invalid')
    const folder = archiveEvidence(lane, join(root, 'runs')), manifest = JSON.parse(readFileSync(join(folder, 'manifest.json')))
    assert.deepEqual(manifest.skipped.map(file => file.path), ['raw/frame.bin'])
    assert.deepEqual(manifest.advisory.map(item => item.reason).sort(), ['digest mismatch', 'invalid file path', 'invalid manifest', 'missing file', 'unverified manifest'])
    assert(existsSync(join(folder, 'artifacts/raw/metrics.json'))); verifyLaneArchive(lane, folder)
  }) },
  { name: 'refuses copy corruption, source mutation and linked archives', run: () => fixture(async root => {
    const lane = join(root, 'codex-example'), out = join(lane, 'artifacts')
    mkdirSync(out, { recursive: true }); writeFileSync(join(out, 'metrics.json'), '{}')
    assert.throws(() => archiveEvidence(lane, join(root, 'corrupt'), { copy(source, target) { copyFileSync(source, target); writeFileSync(target, 'corrupt') } }), /changed during copy/)
    assert.throws(() => archiveEvidence(lane, join(root, 'changing'), { copy(source, target) { copyFileSync(source, target); writeFileSync(source, 'changed') } }), /changed during copy/)
    const other = join(root, 'other'); mkdirSync(other); writeFileSync(join(other, 'sentinel'), 'keep')
    symlinkSync(other, join(out, 'linked'), 'junction')
    assert.throws(() => archiveEvidence(lane, join(root, 'linked')), /symlink or junction/)
    assert.equal(readFileSync(join(other, 'sentinel'), 'utf8'), 'keep')
    assert(existsSync(out))
  }) },
  { name: 'rejects linked raw input and leaves outside sentinels untouched', run: () => fixture(async root => {
    const out = join(root, 'out'), other = join(root, 'other'); mkdirSync(out); mkdirSync(other)
    writeFileSync(join(other, 'sentinel.txt'), 'keep'); symlinkSync(other, join(out, 'raw'), 'junction')
    await assert.rejects(distill(out), /Linked/); assert.equal(readFileSync(join(other, 'sentinel.txt'), 'utf8'), 'keep')
  }) },
  { name: 'maps routes and transitive helpers and makes every e2e entry reachable', run() {
    const graph = suiteGraph(repo)
    const pick = path => suitesForPaths([path], repo, graph)
    for (const suite of ['camera', 'phone']) assert(pick('src/controller/scanner.ts').includes(suite))
    for (const suite of ['sims', 'contact', 'catalogue']) assert(pick('src/sim/devices/marblerun.ts').includes(suite))
    assert.deepEqual(pick('src/sim/audio/voice.ts'), ['sims', 'shared', 'catalogue', 'contact'])
    assert(pick('scripts/e2e-audio.mjs').includes('sims'))
    assert.deepEqual(pick('src/landing/hero.ts'), ['home', 'pages'])
    assert.deepEqual(pick('worker/index.ts'), [...suiteGraph(repo).keys()])
    for (const [suite, scripts] of graph) for (const script of scripts) assert(pick(script).includes(suite), `${suite}: ${script}`)
    assert.deepEqual(pick('docs/example.md'), [])
  } },
  { name: 'resolves formatted short hand-back SHAs only when they belong to the lane branch', run: () => fixture(async root => {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git(['init', '-b', 'master']); writeFileSync(join(root, 'fixture'), 'a'); git(['add', '.'])
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Synthetic fixture'])
    const sha = git(['rev-parse', 'HEAD']); git(['branch', 'codex/example'])
    const round = { number: 1 }
    writeFileSync(join(root, 'lanes.json'), JSON.stringify({ version: 1, lanes: [{ name: 'example', branch: 'codex/example', worktree: root, ports: {}, rounds: [round] }] }))
    writeFileSync(join(root, 'example-r1-final.md'), `head \`${sha.slice(0, 7)}\`\nMerged master **${sha.slice(0, 12)}**\n| Typecheck | 4/4 |\n| Vitest | 5/5 |\n| Phone | 171/172 |\nKnown pre-existing failure explained.\nGuard: no new sessions`)
    writeFileSync(join(root, 'example-r1-events.jsonl'), '{"type":"turn.completed"}')
    const result = await digestLane(root, 'example', { runner: async () => { throw new Error('offline') } })
    assert.equal(result.head, sha); assert.equal(result.master, sha); assert(result.reasons.includes('1 failure (see hand-back)'))
    assert.equal(result.verdict, 'needs-fix')
  }) },
]
