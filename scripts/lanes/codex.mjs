/** Coordinator CLI. All machine paths and process records stay in ignored local files. */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, delimiter, relative } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { allocatePorts, STAND_INS, WORKERS, portFree, withLedger, parseEvents, laneState, matchesLane, stopTrees, guardCleanup, removeLaneTree, sleep, codexArgs } from './lib.mjs'
import { formatTable, formatDuration } from '../lib/report.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const local = join(root, '.claude/local')
const ledgerFile = join(local, 'lanes.json')
const base = join(root, '.claude/worktrees')
const win = process.platform === 'win32'
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
const read = file => existsSync(file) ? readFileSync(file, 'utf8') : ''
const help = `pnpm run lane -- <command>
start <name> --prompt <file> [--model gpt-6.1-sol] [--effort high|xhigh] [--ports auto|a/b] [--base master] [--blender] [--search] [--extra-dir <dir>]
resume <name> --prompt <file> [--model <model>] [--effort <effort>]
status [name] [--json] | wait <name> [--timeout <minutes>] | stop <name> [--dry-run]
cleanup <name> [--force] | ports | brief`

function options(argv) {
  const positional = [], opts = { extraDirs: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') continue
    if (!arg.startsWith('--')) { positional.push(arg); continue }
    const key = arg.slice(2)
    if (['json', 'dry-run', 'force', 'blender', 'search', 'help'].includes(key)) { opts[key] = true; continue }
    if (!['prompt', 'model', 'effort', 'ports', 'base', 'extra-dir', 'timeout'].includes(key)) throw new Error(`Unknown option ${arg}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
    if (key === 'extra-dir') opts.extraDirs.push(resolve(value))
    else opts[key] = value
  }
  return { command: positional[0], name: positional[1], opts, positional }
}

function config() {
  mkdirSync(local, { recursive: true })
  const file = join(local, 'lanes.config.json')
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({ chromiumPath: process.env.OBPAL_E2E_CHROMIUM || '', blenderPath: process.env.BLENDER || '', extraWritableDirs: [], scratchDir: process.env.OBPAL_LANES_SCRATCH || tmpdir() }, null, 2) + '\n', { mode: 0o600 })
    console.error(`Created machine settings: ${file}`)
  }
  const cfg = JSON.parse(read(file))
  cfg.chromiumPath = process.env.OBPAL_E2E_CHROMIUM || cfg.chromiumPath
  cfg.blenderPath = process.env.BLENDER || cfg.blenderPath
  cfg.scratchDir = resolve(process.env.OBPAL_LANES_SCRATCH || cfg.scratchDir || tmpdir())
  if (!Array.isArray(cfg.extraWritableDirs || [])) throw new Error('extraWritableDirs must be an array')
  return cfg
}

/** Resolve the native binary, avoiding shell interpolation and npm's Windows cmd shim. */
function executable() {
  if (process.env.OBPAL_CODEX_BIN) return resolve(process.env.OBPAL_CODEX_BIN)
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    const native = join(dir, win ? 'codex.exe' : 'codex')
    if (existsSync(native) && win) return native
    const wrapper = join(dir, win ? 'codex.cmd' : 'codex')
    if (!existsSync(wrapper)) continue
    const packageRoot = win ? join(dir, 'node_modules/@openai/codex') : dirname(dirname(realpathSync(wrapper)))
    const triples = { win32: 'pc-windows-msvc', linux: 'unknown-linux-musl', darwin: 'apple-darwin' }
    const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${triples[process.platform]}`
    let vendor = join(packageRoot, 'vendor')
    try { vendor = join(dirname(createRequire(join(packageRoot, 'package.json')).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)), 'vendor') } catch {}
    const binary = join(vendor, triple, 'bin', win ? 'codex.exe' : 'codex')
    if (existsSync(binary)) return binary
  }
  throw new Error('Cannot find native Codex; set OBPAL_CODEX_BIN to its executable')
}

function processes() {
  if (win) {
    const script = '$ErrorActionPreference="Stop"; $ProgressPreference="SilentlyContinue"; $rows=Get-CimInstance Win32_Process | Select-Object @{n="pid";e={[int]$_.ProcessId}},@{n="parentPid";e={[int]$_.ParentProcessId}},@{n="name";e={$_.Name}},@{n="commandBase64";e={[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))}}; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($rows | ConvertTo-Json -Compress)))'
    let output
    try { output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 32 << 20 }) }
    catch { throw new Error('Cannot inspect Windows process command lines; run the coordinator CLI in a session with CIM access. No processes were stopped.') }
    const parsed = JSON.parse(output.trim() ? Buffer.from(output.replace(/\s/g, ''), 'base64').toString('utf8') : '[]')
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({ ...p, commandLine: Buffer.from(p.commandBase64 || '', 'base64').toString('utf8') }))
  }
  return execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    return m ? { pid: Number(m[1]), parentPid: Number(m[2]), name: m[3].split('/').pop(), commandLine: m[4] } : {}
  })
}

function snapshot(lane, all, inventory) {
  const round = lane.rounds.at(-1)
  const events = parseEvents(read(round.events))
  if (events.threadId) lane.threadId = events.threadId
  const jobPath = `${round.prompt.slice(0, -'-prompt.md'.length)}-job.json`.replaceAll('\\', '/').toLowerCase()
  const alive = inventory.some(p => matchesLane(p, lane, all)) || (!existsSync(round.exit) && inventory.some(p => p.pid === round.pid && /^(?:node|node\.exe)$/.test(p.name) && (p.commandLine || '').replaceAll('\\', '/').toLowerCase().includes(jobPath)))
  const lastEventAt = existsSync(round.events) && statSync(round.events).size ? statSync(round.events).mtimeMs : null
  const final = read(round.final)
  const exit = existsSync(round.exit) ? JSON.parse(read(round.exit)) : null
  const failed = events.failed || (exit && (exit.code !== 0 || exit.error) ? exit.error || `Codex exited ${exit.code}` : null)
  const now = Date.now()
  return { name: lane.name, state: lane.cleanedAt ? 'stopped' : laneState({ final: Boolean(final.trim()), failed, stopped: round.stoppedAt, alive, lastEventAt, startedAt: Date.parse(round.startedAt), now, stallMinutes: Number(process.env.OBPAL_LANE_STALL_MINUTES || 20) }), model: lane.model, age: formatDuration(now - Date.parse(round.startedAt)), lastEventAge: lastEventAt ? formatDuration(now - lastEventAt) : '-', eventCount: events.count, message: events.message.replace(/\s+/g, ' ').slice(-120), alive, ports: lane.cleanedAt ? '-' : `${lane.ports.standIn}/${lane.ports.worker}`, final, failed }
}

const headers = ['lane', 'state', 'model', 'age', 'last event', 'events', 'last message', 'alive', 'ports']
const cells = row => [row.name, row.state, row.model, row.age, row.lastEventAge, row.eventCount, row.message, row.alive ? 'yes' : 'no', row.ports]
async function statuses(name) {
  const inventory = processes()
  return withLedger(ledgerFile, ledger => {
    const selected = name ? [find(ledger, name)] : ledger.lanes
    return selected.map(lane => snapshot(lane, ledger.lanes, inventory))
  })
}
function find(ledger, name) {
  const lane = ledger.lanes.find(l => l.name === name)
  if (!lane) throw new Error(`Unknown lane ${name}`)
  return lane
}

async function launch(ledger, lane, opts, cfg, resume) {
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(lane.effort)) throw new Error('Invalid reasoning effort')
  if (lane.blender && !cfg.blenderPath) throw new Error('--blender needs BLENDER or blenderPath in local config')
  const binary = executable()
  const prompt = readFileSync(resolve(opts.prompt), 'utf8')
  const roots = [...new Set([git(['rev-parse', '--path-format=absolute', '--git-common-dir']), cfg.scratchDir, ...cfg.extraWritableDirs || [], ...lane.extraDirs].map(p => resolve(p)))]
  for (const path of roots) if (!existsSync(path)) throw new Error(`Writable directory does not exist: ${path}`)
  const number = lane.rounds.length + 1
  const prefix = join(local, `${lane.name}-r${number}`)
  const round = { number, prompt: `${prefix}-prompt.md`, events: `${prefix}-events.jsonl`, final: `${prefix}-final.md`, err: `${prefix}-err.log`, exit: `${prefix}-exit.json`, startedAt: new Date().toISOString() }
  const header = `Worktree: ${lane.worktree}\nBranch: ${lane.branch}. Follow AGENTS.md and $obpal-develop.\nPorts: stand-in ${lane.ports.standIn}, worker ${lane.ports.worker}.\nInstall: pnpm install --frozen-lockfile --store-dir "$TEMP/pnpm-store-obpal" (PowerShell: "$env:TEMP/pnpm-store-obpal").\n\n`
  writeFileSync(round.prompt, header + prompt)
  writeFileSync(round.events, '')
  writeFileSync(round.err, '')
  const env = { OBPAL_E2E_CHROMIUM: cfg.chromiumPath, BLENDER: lane.blender ? cfg.blenderPath : '', OBPAL_E2E_PORT: String(lane.ports.standIn), OBPAL_E2E_WORKER_PORT: String(lane.ports.worker) }
  const job = { ...round, executable: binary, args: codexArgs(lane, round, roots, env, resume), worktree: lane.worktree, ledgerFile, name: lane.name }
  const jobFile = `${prefix}-job.json`
  writeFileSync(jobFile, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 })
  if (!resume) git(['worktree', 'add', '-b', lane.branch, lane.worktree, opts.base || 'master'])
  const runner = spawn(process.execPath, [fileURLToPath(new URL('./runner.mjs', import.meta.url)), jobFile], { cwd: lane.worktree, detached: true, stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { runner.once('spawn', resolve); runner.once('error', reject) })
  round.pid = runner.pid
  runner.unref()
  lane.rounds.push(round)
  Object.assign(lane, { prompt: round.prompt, events: round.events, final: round.final, err: round.err, updatedAt: round.startedAt })
  if (!resume) ledger.lanes.push(lane)
  console.log(`Started ${lane.name} r${number} on ${lane.branch}; ports ${lane.ports.standIn}/${lane.ports.worker}`)
}

async function main() {
  const { command, name, opts, positional } = options(process.argv.slice(2))
  if (!command || opts.help) { console.log(help); return }
  if (!['start', 'resume', 'status', 'wait', 'stop', 'cleanup', 'ports', 'brief'].includes(command)) throw new Error(`Unknown command ${command}`)
  if (positional.length > 2 || (['ports', 'brief'].includes(command) && name)) throw new Error('Unexpected argument')
  if (!['status', 'ports', 'brief'].includes(command) && !/^[a-z][a-z0-9-]{0,47}$/.test(name || '')) throw new Error('Lane name must be lowercase letters, digits and hyphens, starting with a letter')
  const cfg = config()
  if (['start', 'resume'].includes(command)) {
    if (!opts.prompt) throw new Error('--prompt is required')
    await withLedger(ledgerFile, async ledger => {
      if (command === 'start') {
        if (ledger.lanes.some(l => l.name === name)) throw new Error('Lane name already recorded; choose another name')
        const ports = await allocatePorts(opts.ports || 'auto', ledger.lanes)
        const worktree = guardCleanup(base, join(base, `codex-${name}`))
        if (existsSync(worktree)) throw new Error('Worktree already exists')
        await launch(ledger, { name, worktree, branch: `codex/${name}`, ports, model: opts.model || 'gpt-6.1-sol', effort: opts.effort || 'high', blender: Boolean(opts.blender), search: Boolean(opts.search), extraDirs: opts.extraDirs, rounds: [], createdAt: new Date().toISOString(), threadId: null }, opts, cfg, false)
      } else {
        const lane = find(ledger, name)
        const state = snapshot(lane, ledger.lanes, processes())
        if (lane.cleanedAt || state.alive) throw new Error('Cannot resume a cleaned or live lane; stop it first')
        if (!lane.threadId) throw new Error('No thread.started event was recorded')
        guardCleanup(base, lane.worktree)
        lane.model = opts.model || lane.model
        lane.effort = opts.effort || lane.effort
        await launch(ledger, lane, opts, cfg, true)
      }
    })
    return
  }
  if (command === 'status' || command === 'brief') {
    const rows = await statuses(name)
    if (command === 'status') console.log(opts.json ? JSON.stringify(rows.map(({ final, ...row }) => row), null, 2) : formatTable(headers, rows.map(cells)))
    else {
      const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
      const markdown = ['# Codex lanes', '', `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(row => `| ${cells(row).map(escape).join(' | ')} |`)].join('\n') + '\n'
      writeFileSync(join(local, 'lanes.md'), markdown)
      console.log(markdown)
    }
  } else if (command === 'wait') {
    const minutes = Number(opts.timeout || 60)
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Timeout must be positive minutes')
    const deadline = Date.now() + minutes * 60_000
    for (;;) {
      const [row] = await statuses(name)
      if (row.state !== 'running') {
        console.log(formatTable(headers, [cells(row)]))
        if (row.failed) console.log(row.failed)
        if (row.final) console.log('\n' + row.final)
        if (row.state !== 'final') process.exitCode = 1
        return
      }
      if (Date.now() >= deadline) throw new Error(`Wait timed out after ${minutes} minutes; lane continues running`)
      await sleep(2000)
    }
  } else if (command === 'ports') {
    await withLedger(ledgerFile, async ledger => {
      console.log(formatTable(['lane', 'stand-in', 'worker'], ledger.lanes.filter(l => !l.cleanedAt).map(l => [l.name, l.ports.standIn, l.ports.worker])))
      const used = new Set(ledger.lanes.filter(l => !l.cleanedAt).flatMap(l => Object.values(l.ports)))
      for (const [label, pool] of [['stand-in', STAND_INS], ['worker', WORKERS]]) {
        const free = [], busy = []
        for (const port of pool) (used.has(port) || !await portFree(port) ? busy : free).push(port)
        console.log(`${label}: free ${free.join(', ') || 'none'}; allocated/busy ${busy.join(', ') || 'none'}`)
      }
    })
  } else await withLedger(ledgerFile, async ledger => {
    const lane = find(ledger, name)
    const inventory = processes()
    const row = snapshot(lane, ledger.lanes, inventory)
    if (command === 'stop') {
      const trees = stopTrees(inventory, lane, ledger.lanes)
      for (const { root: target, tree } of trees) {
        console.log(`${opts['dry-run'] ? 'Would stop' : 'Stopping'} ${name}: Codex PID ${target.pid}, tree ${tree.map(p => p.pid).join(', ')}`)
        if (!opts['dry-run']) {
          // Re-read immediately before killing: stale PIDs never authorize a stop.
          const fresh = stopTrees(processes(), lane, ledger.lanes).find(t => t.root.pid === target.pid)
          if (!fresh) continue
          if (win) execFileSync('taskkill.exe', ['/PID', String(target.pid), '/T', '/F'], { stdio: 'pipe', windowsHide: true })
          else for (const p of [...fresh.tree].reverse()) process.kill(p.pid, 'SIGTERM')
        }
      }
      if (!trees.length) console.log(`No matching Codex exec process for ${name}`)
      if (!opts['dry-run']) {
        if (!trees.length && row.alive) throw new Error('Supervisor is live but no safe Codex match yet; retry shortly')
        lane.rounds.at(-1).stoppedAt = new Date().toISOString()
      }
    } else {
      if (row.alive) throw new Error('Stop the lane before cleanup')
      const target = guardCleanup(base, lane.worktree)
      if (lane.branch !== `codex/${lane.name}` || target !== join(base, `codex-${lane.name}`)) throw new Error('Ledger branch/path does not match lane identity')
      if (lane.cleanedAt) { console.log(`${name} already cleaned`); return }
      if (!opts.force) {
        try { git(['merge-base', '--is-ancestor', lane.branch, 'master']) } catch { throw new Error('Branch is not merged into master; use --force only to discard it') }
        if (existsSync(target) && execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8', windowsHide: true }).trim()) throw new Error('Worktree is dirty; commit it or explicitly discard with --force')
      }
      const nested = git(['worktree', 'list', '--porcelain']).split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9)).filter(p => p !== target && relative(target, p) && !relative(target, p).startsWith('..') && !relative(target, p).includes(':'))
      if (nested.length) throw new Error('Clean up registered nested worktrees individually first')
      removeLaneTree(base, target)
      git(['worktree', 'prune', '--expire', 'now'])
      git(['branch', '-D', lane.branch])
      lane.cleanedAt = new Date().toISOString()
      console.log(`Cleaned ${name}; ports released`)
    }
  })
}

main().catch(error => { console.error(`lane: ${error.message}`); process.exitCode = 1 })
