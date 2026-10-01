/** Lane bookkeeping and safety rules, shared by the CLI and synthetic tests. */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, lstatSync, readdirSync, unlinkSync, rmdirSync, realpathSync, openSync, closeSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute, toNamespacedPath } from 'node:path'
import { createServer } from 'node:net'
import { preserveLaneEvidence } from '../lib/evidence-archive.mjs'

export const STAND_INS = Array.from({ length: 12 }, (_, i) => 5177 + i)
export const WORKERS = Array.from({ length: 10 }, (_, i) => 5190 + i)
export const RESERVED = [5173, 5174, 5175, 5176, 5189, 3000, 3001, 3002, 3003, 8080]

/** Probe both loopback families; a failed bind is never considered free. */
export async function portFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise(resolve => {
      const server = createServer()
      server.once('error', error => resolve(host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)))
      server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
    })
    if (!free) return false
  }
  return true
}

export async function allocatePorts(request, lanes, free = portFree) {
  const used = new Set(lanes.filter(l => !l.cleanedAt).flatMap(l => Object.values(l.ports)))
  if (request !== 'auto') {
    const match = /^(\d+)\/(\d+)$/.exec(request)
    if (!match) throw new Error('Ports must be auto or <stand-in>/<worker>')
    const [standIn, worker] = match.slice(1).map(Number)
    if (!STAND_INS.includes(standIn) || !WORKERS.includes(worker)) throw new Error('Ports must belong to the lane pools')
    for (const port of [standIn, worker]) if (used.has(port) || !await free(port)) throw new Error(`Port ${port} is allocated or busy`)
    return { standIn, worker }
  }
  const pick = async pool => {
    for (const port of pool) if (!used.has(port) && await free(port)) return port
    throw new Error('No free ports in the lane pool')
  }
  return { standIn: await pick(STAND_INS), worker: await pick(WORKERS) }
}

export function readLedger(file) {
  if (!existsSync(file)) return { version: 1, lanes: [] }
  const ledger = JSON.parse(readFileSync(file, 'utf8'))
  if (ledger.version !== 1 || !Array.isArray(ledger.lanes)) throw new Error('Unsupported lane ledger')
  const names = new Set()
  for (const lane of ledger.lanes) {
    if (!/^[a-z][a-z0-9-]*$/.test(lane.name) || names.has(lane.name) || !lane.ports || !Array.isArray(lane.rounds)) throw new Error('Invalid lane ledger')
    names.add(lane.name)
  }
  return ledger
}

export function writeLedger(file, ledger) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 })
  renameSync(temporary, file)
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** Serialize allocations and ledger edits across CLI processes. A crashed owner releases its lock. */
export async function withLedger(file, action) {
  mkdirSync(dirname(file), { recursive: true })
  const lock = `${file}.lock`
  const deadline = Date.now() + 10_000
  for (;;) {
    try { const fd = openSync(lock, 'wx'); writeFileSync(fd, String(process.pid)); closeSync(fd); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = Number(readFileSync(lock, 'utf8')) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      if (owner && !pidAlive(owner)) { try { unlinkSync(lock) } catch {} }
      if (Date.now() >= deadline) throw new Error('Lane ledger is locked; retry after the other command finishes')
      await sleep(100)
    }
  }
  try {
    const ledger = readLedger(file)
    const result = await action(ledger)
    writeLedger(file, ledger)
    return result
  } finally { unlinkSync(lock) }
}

export function codexArgs(lane, round, roots, env, resume = false) {
  const args = resume ? ['exec', 'resume', lane.threadId] : ['exec', '-C', lane.worktree, '-s', 'workspace-write']
  args.push('-m', lane.model, '-c', `model_reasoning_effort=${JSON.stringify(lane.effort)}`)
  // Research lanes get Codex's live web search; it runs on the model's side, not through the sandboxed shell.
  if (lane.search) args.push('-c', 'web_search="live"')
  if (resume) args.push('-c', 'sandbox_mode="workspace-write"', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([lane.worktree, ...roots])}`)
  else for (const root of roots) args.push('--add-dir', root)
  for (const [key, value] of Object.entries(env)) if (value) args.push('-c', `shell_environment_policy.set.${key}=${JSON.stringify(value)}`)
  return [...args, '--json', '-o', round.final, '-']
}

/** Ignore an incomplete last line while Codex is still writing it. */
export function parseEvents(text) {
  const result = { count: 0, threadId: null, failed: null, message: '' }
  for (const line of text.split(/\r?\n/)) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    result.count++
    if (event.type === 'thread.started' && !result.threadId) result.threadId = event.thread_id
    if (event.type === 'turn.failed') result.failed = event.error?.message || 'turn.failed'
    if (event.item?.type === 'agent_message') result.message = event.item.text || ''
  }
  return result
}

export function laneState({ final, failed, stopped, alive, lastEventAt, startedAt, now = Date.now(), stallMinutes = 20 }) {
  if (stopped) return 'stopped'
  if (failed) return 'failed'
  if (final) return 'final'
  if (!alive || now - (lastEventAt || startedAt) >= stallMinutes * 60_000) return 'stalled'
  return 'running'
}

const normalized = s => String(s).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
const tokens = command => (command.match(/"[^"]*"|[^\s"]+/g) || []).map(s => normalized(s.replace(/^"|"$/g, '')))
const hasIdentity = (args, lane) => args.includes(normalized(lane.worktree)) || Boolean(lane.threadId && args.includes(normalized(lane.threadId)))

/** Only a Codex exec root with an exact lane identity can be stopped. */
export function matchesLane(process, lane, others = []) {
  const args = tokens(process.commandLine || '')
  return /^codex(?:\.exe)?$/i.test(process.name || '') && args.includes('exec') && !args.includes('app-server') &&
    hasIdentity(args, lane) && !others.some(other => other.name !== lane.name && hasIdentity(args, other))
}

/** Validate the whole tree before killing it, including protected descendants. */
export function stopTrees(processes, lane, others) {
  const roots = processes.filter(p => matchesLane(p, lane, others))
  return roots.map(root => {
    const tree = [root]
    for (let i = 0; i < tree.length; i++) for (const p of processes) if (p.parentPid === tree[i].pid && !tree.some(t => t.pid === p.pid)) tree.push(p)
    if (tree.some(p => tokens(p.commandLine || '').includes('app-server') || others.some(o => o.name !== lane.name && hasIdentity(tokens(p.commandLine || ''), o)))) throw new Error('Refusing a process tree containing app-server or another lane')
    return { root, tree }
  })
}

export function guardCleanup(base, target) {
  const rel = relative(resolve(base), resolve(target))
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/^(?:codex|agent|astra)-[a-z][a-z0-9-]*$/.test(rel)) throw new Error('Cleanup target must be a direct agent, astra or codex lane inside .claude/worktrees')
  if (existsSync(base) && normalized(realpathSync(base)) !== normalized(resolve(base))) throw new Error('Worktree container must not traverse a reparse point')
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Lane root must not be a reparse point')
  return resolve(target)
}

/** Never recurse into symlinks/junctions; namespace paths handle long Windows filenames. */
export function removeLaneTree(base, target, options = {}) {
  const checked = guardCleanup(base, target)
  // Every caller gets this safeguard. --force never implies permission to discard evidence.
  if (existsSync(checked)) (options.preserve || preserveLaneEvidence)(checked, options)
  const remove = path => {
    const long = toNamespacedPath(path)
    const info = lstatSync(long)
    if (info.isSymbolicLink()) { unlinkSync(long); return }
    if (!info.isDirectory()) { unlinkSync(long); return }
    for (const name of readdirSync(long)) remove(resolve(path, name))
    rmdirSync(long)
  }
  if (existsSync(checked)) remove(checked)
}
