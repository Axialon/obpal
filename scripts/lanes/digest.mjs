/** A hand-back digest is a review aid, never authorization to merge or ship. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { readLedger } from './lib.mjs'
import { classify, cleanLog, DIGEST_LIMIT, digestSchema, readInput, safePath, sanitize } from '../lib/decision-model.mjs'

const plain = text => text.replace(/[*`]/g, '').trim()
const oneLine = text => plain(text).replace(/\s+/g, ' ')

/** Only retain summary events. Command bodies and their output are not classifier input. */
export function summaryEvents(text) {
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn.failed' || event.type === 'error') rows.push({ type: event.type, message: sanitize(event.error?.message || event.message || event.type) })
      else if (event.type === 'turn.completed') rows.push({ type: event.type })
      else if (event.item?.type === 'agent_message') rows.push({ type: 'agent_message', text: sanitize(event.item.text || '').slice(-2000) })
    } catch {}
  }
  return rows.map(row => JSON.stringify(row)).join('\n')
}

function section(text, name) {
  const lines = text.split('\n'), found = lines.findIndex(line => new RegExp(`^(?:#+\\s*)?${name}(?: for maintainer)?\\s*(?::|$)`, 'i').test(plain(line)))
  if (found < 0) return []
  const first = plain(lines[found]).includes(':') ? plain(lines[found]).replace(/^[^:]+:\s*/, '') : ''
  const items = first ? [first] : []
  for (let i = found + 1; i < lines.length; i++) {
    const line = plain(lines[i])
    if (/^(?:\d+\.|-)\s/.test(line)) items.push(line.replace(/^(?:\d+\.|-)\s*/, ''))
    else if (line && items.length) break
    else if (line && !/^(?:\d+\.|-)\s/.test(line)) break
  }
  return items.filter(item => !/^none\b/i.test(item)).map(oneLine)
}

/** Spend the inline input budget on the hand-back facts before explanatory prose. */
export function handbackInput(text, limit = 48_000) {
  const lines = sanitize(text).split('\n'), essential = [], other = []
  let inSection = false
  for (const line of lines) {
    if (/^(?:#+\s*)?(?:Decisions?(?: for maintainer)?|Risks?|Evidence|Remaining(?: work)?)\s*(?::|$)/i.test(plain(line))) inSection = true
    else if (line.trim() && !/^(?:\d+\.|-)\s/.test(plain(line))) inSection = false
    const important = inSection || /\||\b(?:Head|Merged master)\s*:|artifacts\/|no new sessions|(?:working tree|checkout|tree).*(?:clean|dirty)|^(?:Error:|AssertionError|TimeoutError|FAIL\b|FAILED\b|\s*✗\s)/i.test(line)
    if (important) essential.push(line)
    else other.push(line)
  }
  const facts = essential.join('\n')
  return { text: facts.length > limit ? facts.slice(0, limit) : [facts, other.join('\n').slice(0, Math.max(0, limit - facts.length - 1))].join('\n'), truncated: facts.length > limit }
}

export function extractDigest({ final, events = '', err = '', stopped = false, incomplete = false }) {
  final = sanitize(final); events = sanitize(events); err = cleanLog(err)
  const head = /\bHead\s*:?\s*([a-f0-9]{7,40})\b/i.exec(plain(final))?.[1] || null
  const master = /\bMerged master\s*:?\s*([a-f0-9]{7,40})\b/i.exec(plain(final))?.[1] || null
  const tests = []
  const failures = []
  for (const line of final.split('\n')) {
    const cells = line.split('|').map(plain).filter(Boolean)
    if (cells.length < 2) continue
    const pair = /([\d,]+)\s*\/\s*([\d,]+)/.exec(cells[1])
    const passed = /([\d,]+)\s+passed/.exec(cells[1]), skipped = /([\d,]+)\s+skipped/.exec(cells[1])
    const number = value => Number(value.replaceAll(',', ''))
    if (/^(?:failed|failure|blocked|error)\b|\b[1-9][\d,]*\s+failed\b/i.test(cells[1])) failures.push(oneLine(line))
    if (pair) tests.push({ check: cells[0], passed: number(pair[1]), total: number(pair[2]), skipped: skipped ? number(skipped[1]) : 0 })
    else if (passed) tests.push({ check: cells[0], passed: number(passed[1]), total: number(passed[1]) + (skipped ? number(skipped[1]) : 0), skipped: skipped ? number(skipped[1]) : 0 })
  }
  let turnFailure = false
  for (const line of events.split('\n')) {
    try {
      const event = JSON.parse(line)
      if (event.type === 'turn.failed' || event.type === 'error') turnFailure = true
    } catch {}
  }
  for (const line of [...err.split('\n'), ...final.split('\n')]) if (/^\s*(?:Error:|AssertionError|TimeoutError|FAIL\b|FAILED\b|✗\s)|\b(?:EADDRINUSE|ECONNREFUSED)\b/i.test(line)) failures.push(oneLine(line))
  for (const test of tests) if (test.passed + test.skipped < test.total) failures.push(`${test.check}: ${test.total - test.passed - test.skipped} failed`)
  const evidence = [...new Set([...final.matchAll(/artifacts\/[\w./-]+/g)].map(match => match[0].replace(/[.,]+$/, '')))]
  const risks = section(final, 'Risks?'), decisions = section(final, 'Decisions')
  const reasons = []
  const status = stopped ? 'stopped' : turnFailure ? 'failed' : final.trim() ? 'final' : 'incomplete'
  if (status !== 'final') reasons.push(`Lane ${status}`)
  if (!head || !master) reasons.push('Missing head or merged master')
  if (!tests.length) reasons.push('No numeric test table')
  if (!tests.some(test => /typecheck|typescript/i.test(test.check)) || !tests.some(test => /vitest/i.test(test.check))) reasons.push('Missing required typecheck or Vitest')
  const failedCount = tests.reduce((n, test) => n + Math.max(0, test.total - test.passed - test.skipped), 0)
  if (failedCount) reasons.push(`${failedCount} failure${failedCount === 1 ? '' : 's'} (see hand-back)`)
  if (!/no new sessions/i.test(final)) reasons.push('Helper guard unverified')
  if (failures.length) reasons.push('Review failure history and retained reruns')
  if (incomplete) reasons.push('Source truncated or missing; inspect originals')
  if (/\b(?:working tree|checkout|tree)\s+(?:is\s+)?(?:dirty|unclean)|\buncommitted (?:work|changes)\b/i.test(final) && !/\bno uncommitted (?:work|changes)\b/i.test(final)) reasons.push('Working tree requires cleanup')
  if (/\bRemaining(?: work)?\s*:\s*(?!none\b)\S/i.test(plain(final))) reasons.push('Remaining work requires review')
  return { status, head, master, tests, failures: [...new Set(failures)], decisions, evidence, risks, verdict: status !== 'final' ? 'blocked' : reasons.length ? 'needs-fix' : 'ready-to-merge', reasons: reasons.length ? reasons : ['Reported checks complete; review diff and evidence'] }
}

/** Shrink only presentation; losing facts always downgrades the verdict and says to read originals. */
export function capDigest(value) {
  const result = structuredClone(value)
  if (JSON.stringify(result).length <= DIGEST_LIMIT) return result
  // Runner diagnostics are ancillary; never sacrifice hand-back facts to retain them.
  delete result.note
  if (JSON.stringify(result).length <= DIGEST_LIMIT) return result
  result.verdict = result.status === 'final' ? 'needs-fix' : 'blocked'
  result.reasons = ['Digest truncated; inspect originals']
  for (const length of [160, 100, 60, 30]) {
    for (const key of ['failures', 'decisions', 'evidence', 'risks']) result[key] = result[key].map(text => text.length > length ? text.slice(0, length - 1) + '…' : text)
    result.tests = result.tests.map(test => ({ ...test, check: test.check.slice(0, length) }))
    if (JSON.stringify(result).length <= DIGEST_LIMIT) return result
  }
  while (JSON.stringify(result).length > DIGEST_LIMIT) {
    const key = ['failures', 'decisions', 'evidence', 'risks', 'tests'].sort((a, b) => JSON.stringify(result[b]).length - JSON.stringify(result[a]).length)[0]
    if (!result[key].length) break
    result[key].pop()
  }
  return result
}

export async function digestLane(local, name, options = {}) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name || '')) throw new Error('Invalid lane name')
  safePath(join(local, 'lanes.json'), local)
  const lane = readLedger(join(local, 'lanes.json')).lanes.find(lane => lane.name === name)
  if (!lane) throw new Error('Unknown lane')
  const round = lane.rounds.at(-1)
  if (!round || !Number.isSafeInteger(round.number) || round.number < 1) throw new Error('Lane has no valid round')
  const expected = kind => join(local, `${name}-r${round.number}-${kind}`)
  // Ledger paths are untrusted. Read only the expected round filenames in this local directory.
  for (const [key, suffix] of [['final', 'final.md'], ['events', 'events.jsonl'], ['err', 'err.log']]) {
    if (round[key]) safePath(round[key], local)
    if (round[key] && join(round[key]) !== join(expected(suffix))) throw new Error('Unexpected round input path')
  }
  const final = readInput(expected('final.md'), local, 256_000), events = readInput(expected('events.jsonl'), local, 16_000, true), err = readInput(expected('err.log'), local, 4000, true)
  const handback = handbackInput(final.text)
  const source = { final: handback.text, events: summaryEvents(events.text), err: cleanLog(err.text), stopped: Boolean(round.stoppedAt), incomplete: final.truncated || handback.truncated || !final.bytes || !events.bytes }
  const baseline = extractDigest({ ...source, final: final.text })
  if (lane.branch && lane.worktree) for (const key of ['head', 'master']) {
    if (!baseline[key]) continue
    try {
      const sha = execFileSync('git', ['rev-parse', '--verify', `${baseline[key]}^{commit}`], { cwd: lane.worktree, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      execFileSync('git', ['merge-base', '--is-ancestor', sha, lane.branch], { cwd: lane.worktree, windowsHide: true, stdio: 'pipe' })
      baseline[key] = sha
    } catch {
      baseline[key] = null; baseline.verdict = 'needs-fix'; baseline.reasons.push(`Unresolved ${key} on lane branch`)
    }
  }
  const result = await classify(baseline, source, digestSchema, options, candidate => {
    // Prose may be compressed; identity, measurements and the conservative verdict may not change.
    return ['status', 'head', 'master', 'tests', 'evidence', 'verdict'].every(key => JSON.stringify(candidate[key]) === JSON.stringify(baseline[key])) && ['failures', 'decisions', 'risks', 'reasons'].every(key => candidate[key].length === baseline[key].length && candidate[key].every(text => text.length > 0 && sanitize(text) === text))
  })
  return capDigest(result)
}
