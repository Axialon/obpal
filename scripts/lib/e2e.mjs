/**
 * The pure parts of the e2e runner (scripts/e2e-all.mjs): its arguments, the ports each suite binds, what a suite's
 * log says about the result, and which lines of ob.Pal Desktop's log are sessions a test browser opened.
 */
import { stripAnsi } from './report.mjs'

/** The order a full run takes; suites package.json gains later run after these, by name. */
export const ORDER = ['code', 'embed', 'home', 'phone', 'sims', 'shared', 'extension']
/** The stand-in's port (extension/e2e/local.mjs) and the local worker's (scripts/local-worker.mjs) when env sets none. */
export const DEFAULT_PORT = 5176
export const DEFAULT_WORKER_PORT = 5189

/** The suites package.json defines as `e2e:<name>` (the runner's own `e2e:all` aside), in run order. */
export function knownSuites(scripts) {
  const names = Object.keys(scripts ?? {}).map((k) => /^e2e:([\w-]+)$/.exec(k)?.[1]).filter((n) => n && n !== 'all')
  return [...ORDER.filter((n) => names.includes(n)), ...names.filter((n) => !ORDER.includes(n)).sort()]
}

/**
 * The command line: suites space- or comma-separated, bare or after --suites (none, or `all`: every known suite, in
 * run order; otherwise in the order given, once each), --out <dir>, --wait-min <n>, --timeout-min <n>, --help.
 * Throws on an unknown suite or option, naming the known ones.
 * @param {string[]} argv
 * @param {string[]} known
 */
export function parseArgs(argv, known) {
  const opts = { suites: [], out: '', waitMin: 15, timeoutMin: null, help: false }
  const names = []
  const num = (flag, v) => {
    const n = Number(v)
    if (!(n > 0)) throw new Error(`${flag} needs a positive number`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    else if (a === '--keep-logs') continue // temp scopes inherit this through OBPAL_KEEP_TEMP
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--suites') names.push(...(argv[++i] ?? '').split(','))
    else if (a.startsWith('--suites=')) names.push(...a.slice(9).split(','))
    else if (a === '--out') opts.out = argv[++i] ?? ''
    else if (a.startsWith('--out=')) opts.out = a.slice(6)
    else if (a === '--wait-min' || a === '--timeout-min') opts[a === '--wait-min' ? 'waitMin' : 'timeoutMin'] = num(a, argv[++i])
    else if (a.startsWith('--wait-min=')) opts.waitMin = num('--wait-min', a.slice(11))
    else if (a.startsWith('--timeout-min=')) opts.timeoutMin = num('--timeout-min', a.slice(14))
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
    else names.push(...a.split(','))
  }
  const wanted = names.map((n) => n.trim().replace(/^e2e:/, '')).filter(Boolean)
  const unknown = wanted.filter((n) => n !== 'all' && !known.includes(n))
  if (unknown.length) throw new Error(`unknown suite${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} (known: ${known.join(' ')})`)
  opts.suites = !wanted.length || wanted.includes('all') ? [...known] : [...new Set(wanted)]
  return opts
}

/** The full sims suite has a larger budget; explicit overrides and other suites retain theirs. */
export function suiteTimeout(suite, opts, env = {}) {
  return opts.timeoutMin ?? (suite === 'sims' && !env.OBPAL_E2E_SIMS_ONLY ? 45 : 30)
}

/**
 * The ports a suite binds, which must be free before it starts: the stand-in (OBPAL_E2E_PORT, else 5176) and the
 * suite's own local worker (OBPAL_E2E_WORKER_PORT, else 5189), which every suite starts unless OBPAL_E2E_UPSTREAM
 * points the stand-in elsewhere (the short-code suites always start one). The runner hands both ports to every suite,
 * so each binds exactly these. null: the suite doesn't bind that one.
 * @param {string} suite
 * @param {Record<string, string | undefined>} env
 */
export function suitePorts(suite, env = {}) {
  const port = Number(env.OBPAL_E2E_PORT) || DEFAULT_PORT
  const worker = Number(env.OBPAL_E2E_WORKER_PORT) || DEFAULT_WORKER_PORT
  if (suite === 'code') return { port: null, worker }
  if (suite === 'embed') return { port, worker }
  return { port, worker: env.OBPAL_E2E_UPSTREAM ? null : worker }
}

/**
 * The processes `netstat -ano -p TCP` (Windows) shows listening on a local port, by id.
 * @param {string} netstat
 * @param {number} port
 */
export function listeningPids(netstat, port) {
  const pids = netstat.split(/\r?\n/).map((l) => l.trim().split(/\s+/))
    .filter((c) => c[0] === 'TCP' && c[3] === 'LISTENING' && c[1].endsWith(`:${port}`))
    .map((c) => Number(c[4])).filter((n) => n > 0)
  return [...new Set(pids)]
}

/**
 * What a suite's log says it passed. The suites end with one of `passed 6/6`, `FAILED 2/10`, `11/11 passed`,
 * `all 19 passed` or `3 of 19 failed`; the last such line counts. null: none (the suite crashed before its summary).
 * @param {string} log
 */
export function parseResult(log) {
  const text = stripAnsi(log)
  const forms = [
    [/\bpassed (\d+)\/(\d+)/g, (m) => ({ passed: +m[1], total: +m[2] })],
    [/\bFAILED (\d+)\/(\d+)/g, (m) => ({ passed: +m[2] - +m[1], total: +m[2] })],
    [/\b(\d+)\/(\d+) passed\b/g, (m) => ({ passed: +m[1], total: +m[2] })],
    [/\ball (\d+) passed\b/g, (m) => ({ passed: +m[1], total: +m[1] })],
    [/\b(\d+) of (\d+) failed\b/g, (m) => ({ passed: +m[2] - +m[1], total: +m[2] })],
  ]
  let best = null
  for (const [re, read] of forms) for (const m of text.matchAll(re)) if (!best || m.index > best.at) best = { at: m.index, ...read(m) }
  return best && { passed: best.passed, total: best.total, failed: best.total - best.passed }
}

/** The checks a suite's log reports as failed (`  ✗ name: why`), the first `max` of them, each cut to one short line. */
export function failures(log, max = 5) {
  return stripAnsi(log).split(/\r?\n/).filter((l) => /^\s*✗ /.test(l)).slice(0, max).map((l) => l.trim().slice(0, 160))
}

/**
 * The lines of ob.Pal Desktop's log written since it was `before` bytes long that name a test browser: `ms-playwright`
 * (Playwright's browsers live there) or one of `markers` (such as the Chromium path in use), ignoring case and which
 * way the slashes lean. Past 1 MB the helper starts its log afresh, so a log shorter than before is new from its
 * first line.
 * @param {Uint8Array} log
 * @param {number} before
 * @param {string[]} [markers]
 */
export function newSessionLines(log, before, markers = []) {
  const fresh = Buffer.from(log.length >= before ? log.subarray(before) : log).toString('utf8')
  const norm = (s) => s.toLowerCase().split('\\').join('/')
  const needles = ['ms-playwright', ...markers.filter(Boolean).map(norm)]
  return fresh.split(/\r?\n/).filter((l) => needles.some((n) => norm(l).includes(n)))
}

/** All lines of the log that name a test browser: the count the coordinator's checks compare before and after. */
export function countSessionLines(log, markers = []) {
  return newSessionLines(log, 0, markers).length
}
