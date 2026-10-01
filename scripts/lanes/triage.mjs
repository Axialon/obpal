/** Advisory classification only. A rerun must really pass; this tool never changes test status. */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, cleanLog, logFiles, readInput, sanitize, triageSchema } from '../lib/decision-model.mjs'

// The isolated re-anchor flake is recorded in docs/HUMANOID.md. Do not add whole suites.
export const KNOWN_FLAKY = ['robot arm, camera: tracked=false holds still, and returning tracking re-anchors without a jump']
const simsSelectors = [
  ['marble-mobile', /marble.*mobile|mobile.*marble/i], ['humanoid-live', /humanoid.*live/i],
  ['graphics-recovery', /graphics.*recover|context.*lost/i], ['graphics-layouts', /graphics.*layout/i],
  ['buttons', /button|control ink/i], ['temporal', /temporal|surfaces:|holds at rest/i], ['warm-up', /warm.?up/i],
  ['smoothness', /smoothness|p95|frame.?time/i], ['panels', /panel|window/i], ['humanoid', /humanoid/i], ['tracking', /tracking|re.?anchor/i],
]

export function rerunCommand(file, line) {
  const suite = file.replace(/\.log$/, '')
  const setup = ['$env:OBPAL_E2E_SIMS_ONLY=$null', '$env:OBPAL_E2E_PAGES_ONLY=$null']
  if (suite === 'sims') {
    const selector = simsSelectors.find(([, pattern]) => pattern.test(line))?.[0]
    if (selector) setup.push(`$env:OBPAL_E2E_SIMS_ONLY='${selector}'`)
  }
  if (suite === 'pages' && /\btry\b/i.test(line)) setup.push("$env:OBPAL_E2E_PAGES_ONLY='try'")
  if (!['code', 'embed', 'home', 'phone', 'sims', 'shared', 'extension', 'catalogue', 'pages'].includes(suite)) return 'Identify the suite, then rerun it once through pnpm run e2e:all with the assigned ports and browser.'
  return `${setup.join('; ')}; pnpm run e2e:all -- ${suite}`
}

export function failureCategory(line, context = '') {
  if (/assert|expected|actual|toEqual|toBe\b|!==|mismatch/i.test(line)) return 'real-regression'
  if (/EADDRINUSE|port.*(?:busy|in use)|browser.*(?:not found|missing|closed)|executable.*(?:exist|missing)|worker.*(?:fail|exit|start)|ECONNREFUSED|ENOTFOUND|Cannot find module|spawn.*(?:EACCES|ENOENT)/i.test(line)) return 'harness-or-environment'
  if (/timeout|timed out|waiting for|waitFor/i.test(line) && /under load|concurrent validation|heavy lanes/i.test(line + context) && KNOWN_FLAKY.some(name => line.toLowerCase().includes(name))) return 'load-or-timing-flake'
  return 'unknown'
}

export function extractTriage(logs) {
  const failures = []
  for (const { file, text, truncated = false } of logs) {
    const lines = cleanLog(text).split('\n')
    const checks = lines.filter(line => /^\s*✗\s/.test(line))
    const errors = lines.filter(line => /^(?:\s*)(?:Error:|AssertionError|TimeoutError|FAIL\b|FAILED\b)|EADDRINUSE|ECONNREFUSED|browserType\.launch.*executable/i.test(line))
    const selected = checks.length ? checks : errors
    for (const line of selected) {
      const category = failureCategory(line, lines.join('\n'))
      failures.push({ file, line, category, cause: line.trim(), rerun: rerunCommand(file, line) })
    }
    if (truncated) failures.push({ file, line: '[log truncated]', category: 'unknown', cause: 'Earlier failing checks may be missing; inspect the original log.', rerun: rerunCommand(file, '') })
  }
  return { failures }
}

export async function triageDirectory(directory, options = {}) {
  directory = resolve(directory)
  const files = logFiles(directory)
  if (!files.length) throw new Error('No recognized e2e logs')
  // Read suite logs only: no directory recursion, attachments, helper logs or arbitrary files.
  const logs = files.map(file => ({ file, ...readInput(join(directory, file), directory, 96_000, true) })).map(log => ({ ...log, text: cleanLog(log.text) }))
  const baseline = extractTriage(logs)
  const result = await classify(baseline, logs.map(({ file, text }) => ({ file, text: text.slice(-8000) })), triageSchema, options, candidate => candidate.failures.length === baseline.failures.length && candidate.failures.every((failure, i) => {
    const original = baseline.failures[i]
    return ['file', 'line', 'category', 'rerun'].every(key => failure[key] === original[key]) && failure.cause.length > 0 && sanitize(failure.cause) === failure.cause && !/\bpass(?:ed|ing)?\b/i.test(failure.cause)
  }))
  return { ...result, advisory: 'Recommendations only; rerun once with the same assigned ports/browser. A real rerun must pass. A second failure needs investigation.' }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  if (args.length !== 1) { console.error('Usage: pnpm run triage -- <e2e log dir>'); process.exitCode = 2 }
  else triageDirectory(args[0]).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('triage: input unavailable or excluded'); process.exitCode = 1 })
}
