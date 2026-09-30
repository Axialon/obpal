import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, tmpdir, join } from './lanes-node.mjs'
import { allocatePorts, RESERVED, STAND_INS, WORKERS, readLedger, writeLedger, withLedger, parseEvents, laneState, matchesLane, stopTrees, guardCleanup, removeLaneTree, codexArgs } from '../scripts/lanes/lib.mjs'
import type { Lane, LaneProcess } from '../scripts/lanes/lib.mjs'

const temps: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'obpal-lanes-test-')); temps.push(dir); return dir }
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const lane = (name = 'alpha'): Lane => ({ name, worktree: join(tmpdir(), `codex-${name}`), threadId: `thread-${name}`, ports: { standIn: 5177, worker: 5190 }, rounds: [] })
const processFixture = (commandLine: string, overrides: Partial<LaneProcess> = {}): LaneProcess => ({ pid: 21, parentPid: 1, name: 'codex.exe', commandLine, ...overrides })
const event = (value: unknown) => JSON.stringify(value) + '\n'

describe('lane port allocation', () => {
  it('uses both pools, skips allocated and busy ports, and never probes reserved ports', async () => {
    const probed: number[] = []
    const ports = await allocatePorts('auto', [lane()], async p => { probed.push(p); return ![5178, 5191].includes(p) })
    expect(ports).toEqual({ standIn: 5179, worker: 5192 })
    expect(probed.some(p => RESERVED.includes(p))).toBe(false)
    expect(STAND_INS).toEqual(Array.from({ length: 12 }, (_, i) => 5177 + i))
    expect(WORKERS).toEqual(Array.from({ length: 10 }, (_, i) => 5190 + i))
  })
  it('checks explicit pairs and rejects busy, reserved and wrong-pool ports', async () => {
    expect(await allocatePorts('5188/5199', [], async () => true)).toEqual({ standIn: 5188, worker: 5199 })
    for (const port of RESERVED) await expect(allocatePorts(`${port}/5190`, [], async () => true)).rejects.toThrow('pools')
    await expect(allocatePorts('5190/5177', [], async () => true)).rejects.toThrow('pools')
    await expect(allocatePorts('5177/5190', [], async p => p !== 5190)).rejects.toThrow('busy')
    await expect(allocatePorts('5177/5190', [lane()], async () => true)).rejects.toThrow('allocated')
    await expect(allocatePorts('auto', [], async () => false)).rejects.toThrow('No free ports')
  })
  it('releases only cleaned lanes', async () => {
    expect(await allocatePorts('auto', [{ ...lane(), cleanedAt: 'done' }], async () => true)).toEqual(lane().ports)
  })
})

describe('local lane ledger', () => {
  it('round-trips records and refuses unsupported, corrupt and duplicate data', () => {
    const file = join(temp(), 'local/lanes.json')
    expect(readLedger(file)).toEqual({ version: 1, lanes: [] })
    const ledger = { version: 1, lanes: [lane()] }
    writeLedger(file, ledger)
    expect(readLedger(file)).toEqual(ledger)
    writeFileSync(file, '{')
    expect(() => readLedger(file)).toThrow()
    writeLedger(file, { version: 2, lanes: [] })
    expect(() => readLedger(file)).toThrow('Unsupported')
    writeLedger(file, { version: 1, lanes: [lane(), lane()] })
    expect(() => readLedger(file)).toThrow('Invalid')
  })
  it('serializes concurrent edits and releases the lock after errors', async () => {
    const file = join(temp(), 'lanes.json')
    await Promise.all(['alpha', 'beta', 'gamma'].map(name => withLedger(file, async ledger => { await new Promise(resolve => setTimeout(resolve, 5)); ledger.lanes.push(lane(name)) })))
    expect(readLedger(file).lanes.map(l => l.name).sort()).toEqual(['alpha', 'beta', 'gamma'])
    await expect(withLedger(file, () => { throw new Error('synthetic failure') })).rejects.toThrow('synthetic')
    await withLedger(file, ledger => { ledger.lanes.push(lane('delta')) })
    expect(readLedger(file).lanes).toHaveLength(4)
  })
})

describe('Codex events and terminal states', () => {
  const started = event({ type: 'thread.started', thread_id: 'thread-alpha' })
  const agent = event({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } })
  it('reads the first thread, agent messages and capacity failures despite a partial tail', () => {
    expect(parseEvents(started + agent + event({ type: 'turn.failed', error: { message: 'Selected model is at capacity' } }) + '{"type":')).toEqual({ count: 3, threadId: 'thread-alpha', failed: 'Selected model is at capacity', message: 'Done.' })
  })
  it.each([
    ['running', { alive: true, lastEventAt: 1_950_000 }],
    ['final', { alive: false, final: true }],
    ['failed', { alive: false, failed: 'Selected model is at capacity' }],
    ['stalled', { alive: true, lastEventAt: 100 }],
    ['stalled', { alive: false }],
    ['stopped', { alive: false, stopped: true }],
  ])('classifies the %s fixture', (expected, overrides) => {
    expect(laneState({ startedAt: 100, now: 2_000_000, ...overrides })).toBe(expected)
  })
  it('prioritizes failure over a stale final and respects a custom stall threshold', () => {
    expect(laneState({ final: true, failed: 'failure', alive: true, startedAt: 0 })).toBe('failed')
    expect(laneState({ alive: true, startedAt: 0, now: 60_001, stallMinutes: 1 })).toBe('stalled')
    expect(laneState({ alive: false, startedAt: 0, stopped: true, failed: 'terminated' })).toBe('stopped')
  })
})

describe('stop process safety', () => {
  const alpha = lane(), beta = lane('beta')
  it('matches only Codex exec with an exact worktree or thread argument', () => {
    expect(matchesLane(processFixture(`codex.exe exec -C "${alpha.worktree}" -`), alpha, [beta])).toBe(true)
    expect(matchesLane(processFixture(`codex.exe exec resume ${alpha.threadId} -`), alpha, [beta])).toBe(true)
    for (const cmd of [`codex.exe app-server ${alpha.threadId}`, `codex.exe exec -C "${alpha.worktree}-other"`, `codex.exe exec resume ${beta.threadId}`, `codex.exe exec --prompt "mention ${alpha.threadId}"`, `codex.exe exec ${alpha.threadId} ${beta.threadId}`, `codex.exe exec app-server ${alpha.threadId}`]) expect(matchesLane(processFixture(cmd), alpha, [beta])).toBe(false)
    expect(matchesLane(processFixture(`exec ${alpha.threadId}`, { name: 'node.exe' }), alpha)).toBe(false)
  })
  it('includes children and refuses trees containing the desktop or another lane', () => {
    const root = processFixture(`codex.exe exec ${alpha.threadId}`)
    const child = processFixture('synthetic worker', { pid: 22, parentPid: 21, name: 'node.exe' })
    expect(stopTrees([root, child], alpha, [beta])[0].tree.map(p => p.pid)).toEqual([21, 22])
    for (const commandLine of ['codex.exe app-server', `codex.exe exec ${beta.threadId}`]) expect(() => stopTrees([root, { ...child, commandLine }], alpha, [beta])).toThrow('Refusing')
  })
})

describe('cleanup path safety', () => {
  it('allows only a direct codex lane and refuses the container, traversal and siblings', () => {
    const base = join(temp(), '.claude/worktrees')
    expect(guardCleanup(base, join(base, 'codex-alpha'))).toBe(join(base, 'codex-alpha'))
    for (const path of [base, join(base, '..'), join(base, 'other'), join(base, 'codex-alpha/nested'), join(base, '../worktrees-other/codex-alpha')]) expect(() => guardCleanup(base, path)).toThrow('Cleanup target')
  })
  it('unlinks nested junctions, preserves their targets, and removes long paths', () => {
    const root = temp(), base = join(root, '.claude/worktrees'), target = join(base, 'codex-alpha'), outside = join(root, 'outside')
    mkdirSync(target, { recursive: true }); mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'preserve')
    symlinkSync(outside, join(target, 'dependencies'), 'junction')
    const deep = join(target, ...Array.from({ length: 12 }, (_, i) => `${i}-${'x'.repeat(24)}`))
    mkdirSync(deep, { recursive: true }); writeFileSync(join(deep, 'sample.txt'), 'sample')
    removeLaneTree(base, target)
    expect(existsSync(target)).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('preserve')
  })
  it('refuses a linked lane root or linked container', () => {
    const root = temp(), base = join(root, 'worktrees'), outside = join(root, 'outside')
    mkdirSync(base); mkdirSync(outside)
    symlinkSync(outside, join(base, 'codex-alpha'), 'junction')
    expect(() => guardCleanup(base, join(base, 'codex-alpha'))).toThrow('reparse')
    const linked = join(root, 'linked')
    symlinkSync(base, linked, 'junction')
    expect(() => guardCleanup(linked, join(linked, 'codex-beta'))).toThrow('reparse')
  })
})

it('builds start and resume arguments without unsupported resume flags or shell expansion', () => {
  const alpha = { ...lane(), model: 'gpt-6.1-sol', effort: 'high' }, round = { final: join(tmpdir(), 'final.md') }, roots = [join(tmpdir(), 'extra dir')]
  const env = { BLENDER: join(tmpdir(), 'blender.exe') }
  const start = codexArgs(alpha, round, roots, env)
  expect(start).toContain('--add-dir'); expect(start).toContain('-s')
  const resume = codexArgs(alpha, round, roots, env, true)
  expect(resume.slice(0, 3)).toEqual(['exec', 'resume', 'thread-alpha'])
  for (const flag of ['-s', '--add-dir', '-p', '-C']) expect(resume).not.toContain(flag)
  expect(resume).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([alpha.worktree, ...roots])}`)
  expect(resume).toContain(`shell_environment_policy.set.BLENDER=${JSON.stringify(env.BLENDER)}`)
})
