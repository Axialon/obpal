import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, tmpdir, join } from './lanes-node.mjs'
import { capDigest, digestLane, extractDigest, handbackInput, summaryEvents } from '../scripts/lanes/digest.mjs'
import { extractTriage, failureCategory, triageDirectory, KNOWN_FLAKY } from '../scripts/lanes/triage.mjs'
import { cleanLog, DIGEST_LIMIT, digestSchema, modelResponse, readInput, sanitize, triageSchema, validSchema, type ModelRequest } from '../scripts/lib/decision-model.mjs'

const roots: string[] = []
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'obpal-decision-test-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const handback = `Head: abc1234\nMerged master: def5678\n| Check | Result |\n| Typecheck | 4/4 |\n| Vitest | 2,700 passed; 14 skipped |\n| Pages | 117/117 |\nGuard: no new sessions\nEvidence: artifacts/example/before/a.png and artifacts/example/after/a.png\nDecisions: none\nRemaining: none\nRisk: physical devices unverified.`
const unavailable = async () => { throw new Error('unavailable') }
const runtimeNoise = ['2026-10-01 ERROR rmcp::transport::worker: connection closed', 'ERROR codex_core::tools::router: unknown tool', 'WARN codex_core::transport: timeout', 'ERROR codex_otel::telemetry: export failed', 'ERROR codex_api::endpoint::responses_websocket: connection failed'].join('\n')
const echo = async ({ prompt }: ModelRequest) => ({ output: JSON.stringify(JSON.parse(prompt.slice(prompt.indexOf('{'))).extract), usage: { input_tokens: 123, cached_input_tokens: 20, output_tokens: 50 }, model: 'gpt-6-luna' })
function laneFixture() {
  const root = temp(), prefix = join(root, 'example-r1')
  const round = { number: 1, final: `${prefix}-final.md`, events: `${prefix}-events.jsonl`, err: `${prefix}-err.log` }
  writeFileSync(round.final, handback)
  writeFileSync(round.events, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 400 } }) + '\n')
  writeFileSync(round.err, '')
  const ledger = { version: 1, lanes: [{ name: 'example', ports: { standIn: 5179, worker: 5192 }, rounds: [round] }] }
  writeFileSync(join(root, 'lanes.json'), JSON.stringify(ledger))
  return { root, ledger, round }
}

describe('decision schemas and extraction', () => {
  it('filters runtime noise while retaining real check errors and failed table rows', () => {
    expect(cleanLog(runtimeNoise + '\nError: expected 3, actual 4')).toBe('Error: expected 3, actual 4')
    const result = extractDigest({ final: handback, err: runtimeNoise })
    expect(result.failures).toEqual([])
    expect(result.verdict).toBe('ready-to-merge')
    expect(extractDigest({ final: handback, err: runtimeNoise + '\nError: expected 3, actual 4' }).failures).toEqual(['Error: expected 3, actual 4'])
    expect(extractDigest({ final: handback.replace('117/117', '116/117') }).failures).toEqual(['Pages: 1 failed'])
    expect(extractDigest({ final: handback.replace('117/117', 'Failed') }).verdict).toBe('needs-fix')
  })
  it('uses the final all-green table and retains risks after a resolved initial failure', () => {
    const result = extractDigest({ final: handback + '\nThe initial pages run was 116/117; corrected harness passed on rerun.\nCheckout is clean; ports are free.', err: runtimeNoise })
    expect(result.verdict).toBe('ready-to-merge')
    expect(result.failures).toEqual([])
    expect(result.risks).toEqual(['physical devices unverified.'])
    expect(extractDigest({ final: handback + '\nWorking tree is dirty.' }).verdict).toBe('needs-fix')
  })
  it('prioritizes essentials over large explanatory prose and flags only essential overflow', () => {
    const text = 'Explanatory prose. '.repeat(4000) + '\n' + handback
    const input = handbackInput(text, 1200)
    expect(input.truncated).toBe(false)
    expect(input.text.length).toBeLessThanOrEqual(1200)
    expect(input.text).toContain('| Pages | 117/117 |')
    expect(input.text).toContain('Risk: physical devices unverified.')
    expect(input.text).toContain('Decisions: none')
    expect(input.text).toContain('Evidence: artifacts/example/before/a.png')
    expect(handbackInput(text, 50).truncated).toBe(true)
  })
  it('keeps essentials complete when only ancillary runner diagnostics exceed the cap', () => {
    const value = { ...extractDigest({ final: handback }), note: 'diagnostic '.repeat(200) }
    const result = capDigest(value)
    expect(result.verdict).toBe('ready-to-merge')
    expect(result.tests).toEqual(value.tests)
    expect(result.evidence).toEqual(value.evidence)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(DIGEST_LIMIT)
  })
  it('extracts identities, numeric tables, skipped counts, risks and evidence', () => {
    const result = extractDigest({ final: handback })
    expect(result.head).toBe('abc1234')
    expect(result.master).toBe('def5678')
    expect(result.tests[1]).toEqual({ check: 'Vitest', passed: 2700, total: 2714, skipped: 14 })
    expect(result.verdict).toBe('ready-to-merge')
    expect(result.risks).toEqual(['physical devices unverified.'])
    expect(result.evidence).toHaveLength(2)
    expect(validSchema(result, digestSchema)).toBe(true)
    for (const invalid of [{ ...result, passed: true }, { ...result, tests: [{ check: 'bad', passed: -1, total: 3, skipped: 0 }] }, { ...result, tests: [{ check: 'bad', passed: 1.5, total: 3, skipped: 0 }] }, { ...result, verdict: 'pass' }, { ...result, head: 42 }]) expect(validSchema(invalid, digestSchema)).toBe(false)
  })
  it('blocks missing final, stale final with a failed turn, and incomplete sources', () => {
    expect(extractDigest({ final: '' }).verdict).toBe('blocked')
    expect(extractDigest({ final: handback, events: '{"type":"turn.failed","error":{"message":"capacity"}}' }).status).toBe('failed')
    expect(extractDigest({ final: handback, incomplete: true }).verdict).toBe('needs-fix')
    expect(extractDigest({ final: handback.replace('117/117', '116/117') }).verdict).toBe('needs-fix')
  })
  it('keeps valid JSON under the cap and flags every lossy reduction', () => {
    const result = capDigest({ ...extractDigest({ final: handback }), risks: Array(100).fill('large risk '.repeat(100)), decisions: Array(50).fill('large decision '.repeat(50)), tests: Array(100).fill({ check: 'huge', passed: 1, total: 1, skipped: 0 }) })
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(DIGEST_LIMIT)
    expect(validSchema(result, digestSchema)).toBe(true)
    expect(result.verdict).toBe('needs-fix')
    expect(result.reasons).toEqual(['Digest truncated; inspect originals'])
  })
})

describe('model runner contract', () => {
  it('accepts schema-valid grounded answers after harmless tool events for digest and triage', async () => {
    const { root } = laneFixture()
    const runner = async (request: ModelRequest) => modelResponse({ output: (await echo(request)).output, code: 0, events: [
      { type: 'item.completed', item: { type: 'command_execution', command: 'read schema.json', exit_code: 0 } },
      { type: 'turn.completed', usage: { input_tokens: 123, output_tokens: 50 } },
    ].map(row => JSON.stringify(row)).join('\n') })
    expect((await digestLane(root, 'example', { runner })).mode).toBe('model')
    writeFileSync(join(root, 'pages.log'), '✗ Try page: Timeout waiting')
    expect((await triageDirectory(root, { runner })).mode).toBe('model')
    expect(modelResponse({ events: '{"type":"turn.failed"}', output: '{}', code: 0 }).failed).toBe('model unavailable')
  })
  it('cleans stderr before model input and does not flag omitted ancillary prose', async () => {
    const { root, round } = laneFixture()
    writeFileSync(round.err, runtimeNoise)
    writeFileSync(round.final, 'Explanatory prose. '.repeat(4000) + '\n' + handback)
    const result = await digestLane(root, 'example', { runner: async request => {
      expect(request.prompt).not.toContain('rmcp::')
      expect(request.prompt).not.toContain('tools::router')
      expect(request.prompt).toContain('| Pages | 117/117 |')
      return echo(request)
    } })
    expect(result.mode).toBe('model')
    expect(result.verdict).toBe('ready-to-merge')
  })
  it('accepts grounded JSON and records reported model/tokens', async () => {
    const { root } = laneFixture()
    const result = await digestLane(root, 'example', { runner: echo })
    expect(result.mode).toBe('model')
    expect(result.tokens).toEqual({ in: 123, cached: 20, out: 50 })
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(DIGEST_LIMIT)
  })
  it('falls back for unavailable, malformed, extra-key and fabricated results', async () => {
    const { root } = laneFixture()
    const baseline = extractDigest({ final: handback })
    for (const runner of [unavailable, async () => ({ output: 'bad' }), async () => ({ output: JSON.stringify({ ...baseline, unknown: true }) }), async () => ({ output: JSON.stringify({ ...baseline, head: 'invented' }) }), async () => ({ output: '', failed: 'timeout' })]) {
      const result = await digestLane(root, 'example', { runner })
      expect(result.mode).toBe('extractive')
      expect(result.head).toBe('abc1234')
      expect(result.note).toBeDefined()
    }
  })
  it('passes a short timeout to the injected runner', async () => {
    const { root } = laneFixture()
    await digestLane(root, 'example', { timeoutMs: 30, runner: async request => { expect(request.timeoutMs).toBe(30); return echo(request) } })
  })
  it('records partial usage without inventing unreported cached tokens', async () => {
    const { root } = laneFixture()
    const result = await digestLane(root, 'example', { runner: async request => ({ ...await echo(request), usage: { input_tokens: 12, output_tokens: 4 } }) })
    expect(result.tokens).toEqual({ in: 12, cached: null, out: 4 })
  })
})

describe('secret and link exclusions', () => {
  it('does not open secret paths or malicious ledger references', async () => {
    const { root, ledger } = laneFixture(), secret = join(root, '.' + 'obpal-keys')
    mkdirSync(secret)
    writeFileSync(join(secret, 'final.md'), 'must not be read')
    expect(() => readInput(join(secret, 'final.md'), root)).toThrow('Secret')
    expect(() => readInput(join(root, '..', 'outside.log'), root)).toThrow('scope')
    ledger.lanes[0].rounds[0].final = join(secret, 'final.md')
    writeFileSync(join(root, 'lanes.json'), JSON.stringify(ledger))
    let called = false
    await expect(digestLane(root, 'example', { runner: async request => { called = true; return echo(request) } })).rejects.toThrow('Secret')
    expect(called).toBe(false)
  })
  it('rejects junction ancestors and ignores non-suite files without reading them', async () => {
    const root = temp(), other = temp(), linked = join(root, 'linked')
    symlinkSync(other, linked, 'junction')
    expect(() => readInput(join(linked, 'pages.log'), root)).toThrow('Linked')
    writeFileSync(join(root, '.env'), 'private input')
    writeFileSync(join(root, 'desktop.log'), 'installed helper input')
    writeFileSync(join(root, 'pages.log'), '✗ Try page: timeout waiting for rail')
    const result = await triageDirectory(root, { runner: async request => { expect(request.prompt).not.toContain('private input'); expect(request.prompt).not.toContain('installed helper'); return echo(request) } })
    expect(result.failures).toHaveLength(1)
  })
  it('removes secret-bearing lines before a model sees them and keeps artifact suffixes', async () => {
    const { root, round } = laneFixture()
    const token = 'gh' + 'p_' + 'a'.repeat(40)
    writeFileSync(round.final, handback + '\ncredential ' + token + '\nNever open ~/.' + 'obpal-keys/key\n')
    await digestLane(root, 'example', { runner: async request => { expect(request.prompt).not.toContain(token); expect(request.prompt).not.toContain('.' + 'obpal-keys'); return echo(request) } })
    const path = ['C:', 'Users', 'synthetic', 'lane', 'artifacts', 'a.png'].join('\\')
    expect(sanitize(path)).toBe('artifacts/a.png')
  })
  it('reads bounded tails and reports truncation', () => {
    const root = temp(), file = join(root, 'pages.log')
    writeFileSync(file, 'a'.repeat(100) + 'tail')
    expect(readInput(file, root, 4, true)).toEqual({ text: 'tail', bytes: 104, truncated: true })
  })
  it('excludes command bodies and decoded secret content from the event tail', () => {
    const token = 'gh' + 'p_' + 'a'.repeat(40)
    const events = [
      { type: 'item.completed', item: { type: 'command_execution', command: 'private command body', aggregated_output: token } },
      { type: 'turn.failed', error: { message: 'credential ' + token } },
      { type: 'turn.completed' },
    ].map(event => JSON.stringify(event)).join('\n')
    const summary = summaryEvents(events)
    expect(summary).not.toContain(token)
    expect(summary).not.toContain('private command body')
    expect(summary).toContain('secret line excluded')
    expect(extractDigest({ final: handback, events: summary }).status).toBe('failed')
  })
})

describe('advisory e2e triage', () => {
  it('filters runtime diagnostics before extraction and model input', async () => {
    const root = temp()
    writeFileSync(join(root, 'pages.log'), runtimeNoise + '\nError: EADDRINUSE')
    expect(extractTriage([{ file: 'pages.log', text: runtimeNoise }]).failures).toEqual([])
    const result = await triageDirectory(root, { runner: async request => {
      expect(request.prompt).not.toContain('rmcp::')
      expect(request.prompt).not.toContain('telemetry')
      return echo(request)
    } })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].line).toBe('Error: EADDRINUSE')
  })
  it('requires a known name and a wait, gives assertions precedence, and isolates selectors', () => {
    expect(failureCategory(`✗ ${KNOWN_FLAKY[0]}: Timeout waiting under load`)).toBe('load-or-timing-flake')
    expect(failureCategory(`✗ ${KNOWN_FLAKY[0]}: Timeout waiting`)).toBe('unknown')
    expect(failureCategory('✗ unknown: Timeout waiting')).toBe('unknown')
    expect(failureCategory('✗ smoothness: expected p95 30, actual 80')).toBe('real-regression')
    expect(failureCategory('Error: EADDRINUSE port busy')).toBe('harness-or-environment')
    const result = extractTriage([{ file: 'pages.log', text: '  ✗ Try page: Timeout waiting under load\nFAILED 1/117' }, { file: 'sims.log', text: '✗ humanoid live: Timeout waiting\n✗ smoothness: expected p95 30, actual 80' }])
    expect(result.failures).toHaveLength(3)
    expect(result.failures[0].line).toBe('  ✗ Try page: Timeout waiting under load')
    expect(result.failures[0].rerun).toContain("OBPAL_E2E_PAGES_ONLY='try'")
    expect(result.failures[1].rerun).toContain("OBPAL_E2E_SIMS_ONLY='humanoid-live'")
    expect(result.failures[2].rerun).toContain("OBPAL_E2E_SIMS_ONLY='smoothness'")
    expect(validSchema(result, triageSchema)).toBe(true)
  })
  it('never accepts passing, omitted failures, changed exact lines, or promoted flakes', async () => {
    const root = temp()
    writeFileSync(join(root, 'pages.log'), '✗ Try page: Timeout waiting')
    const baseline = extractTriage([{ file: 'pages.log', text: '✗ Try page: Timeout waiting' }])
    for (const output of [{ failures: [], passing: true }, { failures: [] }, { failures: [{ ...baseline.failures[0], line: 'invented' }] }, { failures: [{ ...baseline.failures[0], cause: 'passing' }] }, { failures: [{ ...baseline.failures[0], category: 'real-regression' }] }]) {
      const result = await triageDirectory(root, { runner: async () => ({ output: JSON.stringify(output) }) })
      expect(result.mode).toBe('extractive')
      expect(result.failures[0].line).toBe('✗ Try page: Timeout waiting')
      expect(result.advisory).toContain('must pass')
    }
  })
  it('falls back to exact lines when the model is unavailable and handles empty failure sets', async () => {
    const root = temp()
    writeFileSync(join(root, 'shared.log'), 'Error: EADDRINUSE')
    expect((await triageDirectory(root, { runner: unavailable })).failures[0].category).toBe('harness-or-environment')
    writeFileSync(join(root, 'shared.log'), 'passed 7/7')
    expect((await triageDirectory(root, { runner: echo })).failures).toEqual([])
  })
})
