/**
 * The e2e suites one after another, with one table at the end instead of their logs.
 *
 *   pnpm run e2e:all                      every suite (package.json's e2e:<name> scripts)
 *   pnpm run e2e:all -- phone shared      just these, in this order (commas work too, or --suites phone,shared)
 *   Options: --out <dir> for the suites' logs (default: a fresh temp folder), --wait-min <n> for how long a busy port
 *   is waited for (15), --timeout-min <n> per suite (30, or 45 for the full sims suite).
 *
 * Service. Each suite runs against its own fresh local worker (this checkout's, under `wrangler dev`: see
 * extension/e2e/local.mjs), never production, whose per-address limits every run on this machine shares. Production
 * only when asked for: OBPAL_E2E_UPSTREAM=https://obpal.blackboxes.net.
 * Ports. Before each suite the runner waits until the ports that suite binds are free (another run, a lane's or the
 * release's, may hold them), then hands them to it: OBPAL_E2E_PORT, the local stand-in for the site (default 5176),
 * and OBPAL_E2E_WORKER_PORT, the suite's local worker (default 5189). After the suite, a worker still answering on its
 * port (a suite that died without stopping it) is stopped.
 * Browser. OBPAL_E2E_CHROMIUM if set, else Playwright's own full Chromium (npx playwright install chromium), else the
 * newest full one an earlier Playwright left: the headless shell can't load extensions or lock orientation. Only its
 * file is looked at; it is never started to ask its version.
 * ob.Pal Desktop guard. No test browser may ever reach an installed ob.Pal Desktop. After each suite the runner reads
 * the helper's log (%APPDATA%\obpal\desktop.log, or OBPAL_DESKTOP_LOG), read only, and a new line naming a test
 * browser stops the run at once, printing the lines.
 *
 * Exit codes: 0 all passed, 1 a suite failed, timed out or couldn't start, 2 bad arguments, 3 the guard tripped.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveChromium, shortPath } from './lib/browser.mjs'
import { DEFAULT_PORT, DEFAULT_WORKER_PORT, failures, knownSuites, listeningPids, newSessionLines, parseArgs, parseResult, suitePorts, suiteTimeout } from './lib/e2e.mjs'
import { formatDuration, formatTable } from './lib/report.mjs'
import { tempScope } from './lib/temp.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const win = process.platform === 'win32'

const known = knownSuites(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts)
let opts
try {
  opts = parseArgs(process.argv.slice(2), known)
} catch (e) {
  console.error(`e2e:all: ${e.message}`)
  process.exit(2)
}
if (opts.help) {
  console.log(`pnpm run e2e:all [-- <suite> ...] [--out <dir>] [--wait-min <n>] [--timeout-min <n>]\nsuites: ${known.join(' ')}`)
  process.exit(0)
}

// ---- the ports, the logs -------------------------------------------------------------------------------------------
/** Something holds the port: it accepts connections on 127.0.0.1 (where the stand-in and the worker listen), or it can't be bound. */
async function busy(port) {
  const accepts = await new Promise((r) => {
    const s = connect({ port, host: '127.0.0.1' })
    const done = (v) => { s.destroy(); r(v) }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    s.setTimeout(1000, () => done(false))
  })
  if (accepts) return true
  return new Promise((r) => {
    const srv = createServer()
    srv.once('error', () => r(true))
    srv.listen(port, '127.0.0.1', () => srv.close(() => r(false)))
  })
}

/** Wait (polling every 15 s) until none of the ports is held, up to --wait-min. False: still held. */
async function waitFree(ports) {
  const end = Date.now() + opts.waitMin * 60_000
  let told = 0
  for (;;) {
    const held = []
    for (const p of ports) if (await busy(p)) held.push(p)
    if (!held.length) return true
    if (Date.now() > end) return false
    if (Date.now() - told > 60_000) {
      console.log(`  port ${held.join(', ')} in use (another run?); waiting, up to ${opts.waitMin} min in all`)
      told = Date.now()
    }
    await sleep(15_000)
  }
}

const desktopLog = process.env.OBPAL_DESKTOP_LOG || (process.env.APPDATA ? join(process.env.APPDATA, 'obpal', 'desktop.log') : '')
const readLog = () => { try { return readFileSync(desktopLog) } catch { return null } }
const logSize = () => { try { return statSync(desktopLog).size } catch { return 0 } }

const workerAnswers = async (port) => {
  try { return (await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })).json()).service === 'obpal' } catch { return false }
}

/**
 * After a suite, its worker must be gone. One that still answers on the suite's worker port (the runner made sure the
 * port was free before the suite) is that suite's, left behind: stop whatever listens there, with its children.
 * Returns what happened, for the table: '' (nothing left), 'stopped a leftover worker', or a warning.
 */
async function stopLeftoverWorker(port) {
  for (let i = 0; i < 12 && (await workerAnswers(port)); i++) await sleep(250) // close() may still be finishing
  if (!(await workerAnswers(port))) return ''
  const pids = win
    ? listeningPids(spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true }).stdout ?? '', port)
    : (spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout ?? '').split('\n').map(Number).filter((n) => n > 0)
  for (const pid of pids) {
    if (win) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  for (let i = 0; i < 20 && (await workerAnswers(port)); i++) await sleep(250)
  return (await workerAnswers(port)) ? `a worker still holds port ${port}` : 'stopped a leftover worker'
}

/** Stop a suite and everything it started (its stand-in, its worker, its browsers). */
function killTree(child) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve()
  if (win) return new Promise((r) => spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).on('exit', r))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  return Promise.resolve()
}

// ---- the run -------------------------------------------------------------------------------------------------------
const browser = await resolveChromium().catch((e) => { console.error(`e2e:all: ${e.message}`); process.exit(2) })
const out = resolve(opts.out || join(tmpdir(), `obpal-e2e-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`))
mkdirSync(out, { recursive: true })
const env = {
  ...process.env,
  OBPAL_E2E_EVIDENCE_ROOT: process.env.OBPAL_E2E_EVIDENCE_ROOT || out,
  ...(process.argv.includes('--keep-logs') ? { OBPAL_KEEP_TEMP: '1' } : {}),
  OBPAL_E2E_PORT: String(Number(process.env.OBPAL_E2E_PORT) || DEFAULT_PORT),
  OBPAL_E2E_WORKER_PORT: String(Number(process.env.OBPAL_E2E_WORKER_PORT) || DEFAULT_WORKER_PORT),
  ...(browser.path ? { OBPAL_E2E_CHROMIUM: browser.path } : {}),
}
const markers = browser.path && !/ms-playwright/i.test(browser.path) ? [browser.path] : []
const logAtStart = readLog()
const startSize = logAtStart?.length ?? 0

console.log(`e2e:all: ${opts.suites.join(' ')}`)
console.log(`  browser: ${browser.from} ${shortPath(browser.path)}`)
console.log(`  service: ${env.OBPAL_E2E_UPSTREAM ? `${env.OBPAL_E2E_UPSTREAM} (OBPAL_E2E_UPSTREAM)` : 'a fresh local worker per suite'}`)
console.log(`  ports: stand-in ${env.OBPAL_E2E_PORT}, worker ${env.OBPAL_E2E_WORKER_PORT}; logs: ${out}`)
console.log(`  ob.Pal Desktop log: ${logAtStart ? 'watched' : desktopLog ? 'none here (not installed)' : 'none (not Windows)'}`)

let current = null
process.on('SIGINT', async () => {
  if (current) await killTree(current)
  console.error('\ne2e:all: interrupted')
  process.exit(130)
})

const rows = []
const details = []
let guard = null
let stopped = ''
for (const suite of opts.suites) {
  if (stopped) { rows.push([suite, 'not run', '', '', stopped]); continue }
  const { port, worker } = suitePorts(suite, env)
  const ports = [port, worker].filter((p) => p !== null)
  if (!(await waitFree(ports))) {
    rows.push([suite, 'BUSY', '', '', `port ${ports.join('/')} still in use after ${opts.waitMin} min`])
    stopped = 'a port stayed busy'
    continue
  }
  const temps = tempScope({ keep: env.OBPAL_KEEP_TEMP === '1' })
  const suiteTemp = await temps.make(join(tmpdir(), 'obpal-e2e-suite-'))
  const suiteEnv = { ...env, TEMP: suiteTemp, TMP: suiteTemp, TMPDIR: suiteTemp }
  try {
  const logPath = join(out, `${suite}.log`)
  const fd = openSync(logPath, 'w')
  const sizeBefore = logSize()
  const t0 = Date.now()
  process.stdout.write(`> e2e:${suite} … `)
  let timedOut = false
  const timeoutMin = suiteTimeout(suite, opts, env)
  const code = await new Promise((r) => {
    current = spawn('pnpm', ['run', `e2e:${suite}`], { cwd: root, env: suiteEnv, shell: win, stdio: ['ignore', fd, fd], windowsHide: true, detached: !win })
    const timer = setTimeout(() => { timedOut = true; killTree(current) }, timeoutMin * 60_000)
    current.on('error', () => { clearTimeout(timer); r(-1) })
    current.on('exit', (c) => { clearTimeout(timer); r(c ?? -1) })
  })
  current = null
  closeSync(fd)
  const ms = Date.now() - t0
  const log = readFileSync(logPath, 'utf8')
  const res = parseResult(log)
  const tests = res ? `${res.passed}/${res.total}` : '?'
  const failed = failures(log)
  const ok = code === 0 && !timedOut && (!res || res.failed === 0)
  const result = timedOut ? 'TIMEOUT' : ok ? 'pass' : 'FAIL'
  console.log(`${result} ${tests} in ${formatDuration(ms)}`)
  let note = timedOut ? `stopped after ${timeoutMin} min` : !ok ? failed[0] ?? `exit ${code}; see ${suite}.log` : ''
  if (!ok && failed.length) details.push([suite, failed])
  if (worker !== null) {
    const leftover = await stopLeftoverWorker(worker)
    if (leftover) note = note ? `${note}; ${leftover}` : leftover
  }

  // The guard: this suite's new lines in ob.Pal Desktop's log that name a test browser.
  const now = readLog()
  if (now) {
    const reached = newSessionLines(now, sizeBefore, markers)
    if (reached.length) {
      guard = { suite, reached }
      note = `REACHED ob.Pal Desktop (${reached.length} log line${reached.length > 1 ? 's' : ''})`
      stopped = `stopped: e2e:${suite} reached ob.Pal Desktop`
    }
  }
  rows.push([suite, guard?.suite === suite ? 'GUARD' : result, tests, formatDuration(ms), note])
  } finally {
    if (current) { await killTree(current); current = null }
    if (worker !== null) await stopLeftoverWorker(worker)
    await temps.cleanup()
  }
}

// ---- the summary ---------------------------------------------------------------------------------------------------
console.log(`\n${formatTable(['suite', 'result', 'tests', 'time', 'notes'], rows)}`)
for (const [suite, lines] of details) console.log(`\n${suite} failures:\n  ${lines.join('\n  ')}`)
const logAtEnd = readLog()
if (logAtEnd) {
  const fresh = newSessionLines(logAtEnd, startSize, markers)
  const count = (buf) => newSessionLines(buf, 0, markers).length
  console.log(`\nob.Pal Desktop log: ${count(logAtStart ?? Buffer.alloc(0))} test-browser lines before, ${count(logAtEnd)} after; ${fresh.length ? `${fresh.length} NEW` : 'no new sessions'}`)
}
else console.log('\nob.Pal Desktop guard: no new sessions (no helper log present)')
if (guard) {
  const bar = '!'.repeat(78)
  console.error(`\n${bar}\n  A TEST BROWSER REACHED THE INSTALLED ob.Pal Desktop during e2e:${guard.suite}. The run stopped there.`)
  console.error(`  Its log (read only) gained:\n    ${guard.reached.slice(0, 5).map((l) => l.slice(0, 150)).join('\n    ')}`)
  console.error(`  Find how the suite's browser got the real host before running anything else.\n${bar}`)
  process.exit(3)
}
const bad = rows.filter((r) => r[1] !== 'pass').length
console.log(`\n${bad ? `${bad} of ${rows.length} suites did not pass` : `all ${rows.length} suites passed`}; logs in ${out}`)
process.exit(bad ? 1 : 0)
