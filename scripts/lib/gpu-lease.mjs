/** A cross-worktree FIFO semaphore, admitting waiters strictly in ticket order. State lives beside the legacy system TEMP lease. */
import { open, readFile, unlink as remove, mkdir, readdir, link, rename as move } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const GPU_LEASE_FILE = process.env.OBPAL_E2E_GPU_LEASE_FILE || join(tmpdir(), 'obpal-e2e-gpu.lock')
const pause = (ms, signal) => new Promise((resolve, reject) => {
  const done = () => { signal?.removeEventListener('abort', abort); resolve() }
  const timer = setTimeout(done, ms)
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
})
/** A sharing denial: Windows refuses to open or replace a name that is mid-delete or mid-replace, and allows it a moment later. */
const sharing = error => ['EPERM', 'EBUSY'].includes(error?.code)
/** Windows can briefly deny replacement while a status reader closes its handle. Keep ownership throughout. */
async function sharingRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      if (process.platform !== 'win32' || !sharing(error) || attempt >= 20) throw error
      await pause(100)
    }
  }
}
const unlink = path => sharingRetry(() => remove(path))
const rename = (from, to) => sharingRetry(() => move(from, to))
/** Tolerates repeated sharing denials for a while, then surfaces them: a permanent denial must not hang a lane. */
function patience(limitMs = 15_000) {
  let since = 0
  return { ok: () => { since = 0 }, wait: error => { since ||= Date.now(); if (Date.now() - since > limitMs) throw error } }
}

/** Null means dead, undefined means unverifiable: an unverifiable live process is never reclaimed. */
export async function gpuProcessStart(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try { process.kill(pid, 0) } catch (error) { return error.code === 'ESRCH' ? null : undefined }
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`], { windowsHide: true })
      return stdout.trim() || undefined
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return `${(await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`
    }
    return (await exec('ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim() || undefined
  } catch {
    try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return null }
    return undefined
  }
}

/**
 * Null means the file is gone. A sharing denial is retried briefly, since the name is usually mid-delete and
 * resolves to gone; if it persists the error keeps its `code`, so callers can tell "unreadable now" from "corrupt".
 */
async function json(path) {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if (error.code === 'ENOENT') return null
      if (sharing(error) && attempt < 10) { await pause(10); continue }
      throw Object.assign(new Error(`Cannot verify GPU state ${path}: ${error.message}`), { code: error.code })
    }
  }
}
async function create(path, owner) {
  const handle = await open(path, 'wx')
  try { await handle.writeFile(JSON.stringify(owner) + '\n') } finally { await handle.close() }
}
async function publish(path, owner) {
  const prepared = `${path}.${randomUUID()}.tmp`
  await create(prepared, owner)
  try { await link(prepared, path) } finally { await unlink(prepared) }
}
async function stale(owner, processStart) {
  const start = await processStart(owner.pid)
  if (start === null) return 'dead PID'
  if (start === undefined) return null
  if (owner.processStartedAt) return start !== owner.processStartedAt ? 'reused PID' : null
  // Legacy leases recorded acquisition time. A Windows process born later proves PID reuse.
  const born = /^\d+$/.test(start) ? Number(BigInt(start) / 10_000n - 62_135_596_800_000n) : Date.parse(start)
  return born > Date.parse(owner.startedAt) ? 'reused PID' : null
}
async function claimReclaim(path, owner, processStart) {
  const base = path.split('.reclaimed-')[0]
  for (;;) {
    try { await publish(path, owner); return true } catch (error) { if (error.code !== 'EEXIST') throw error }
    const claimant = await json(path)
    if (claimant.token === owner.token) return true
    if (!(await stale(claimant, processStart))) return false
    // A killed reclaimer cannot strand the old lock. Its successor claims another unique token.
    path = `${base}.reclaimed-${claimant.token}`
  }
}

/** Publish a complete mutex atomically; killed writers cannot leave an empty coordinator lock. */
async function transaction(file, owner, processStart, reclaimed, fn, signal, deadline = Infinity) {
  const prepared = `${file}.${randomUUID()}.tmp`
  const linking = patience(), reading = patience()
  await create(prepared, owner)
  try {
    for (;;) {
      signal?.throwIfAborted()
      try { await link(prepared, file); break } catch (error) {
        // A name that is mid-delete refuses the link without being free yet; it is taken or free on the next try.
        if (error.code === 'EEXIST') linking.ok()
        else if (sharing(error)) linking.wait(error)
        else throw error
      }
      let held
      try { held = await json(file); reading.ok() } catch (error) {
        // An unreadable mutex is held by someone we cannot identify, so it is neither entered nor reclaimed.
        if (!sharing(error)) throw error
        reading.wait(error)
      }
      const reason = held && await stale(held, processStart)
      if (reason) {
        // Only one reclaimer per old token may unlink. Retain its tiny claim to prevent an ABA unlink.
        try {
          const claimed = await claimReclaim(`${file}.reclaimed-${held.token}`, owner, processStart)
          if (claimed && (await json(file))?.token === held.token) { await unlink(file); reclaimed({ ...held, reason }) }
        } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOENT' && !sharing(error)) throw error }
      }
      if (Date.now() >= deadline) { const error = new Error('GPU shared wait expired'); error.code = 'GPU_WAIT'; throw error }
      await pause(20, signal)
    }
    try { return await fn() } finally { await unlink(file) }
  } finally { await unlink(prepared) }
}

const RECORD = /^(slot-\d+|exclusive|queue-\d+)\.json$/
/**
 * A waiter's place is the ticket in its `queue-<ticket>.json` name. The file is published whole by a link and never
 * rewritten, so the name is the one source of order, whether or not the contents can be read.
 */
const ticket = name => name.startsWith('queue-') ? { order: Number(name.slice(6, -5)) } : {}
/** A holder's mode is also in its name: `exclusive.json` is exclusive and every slot is shared. */
const heldMode = name => name.startsWith('queue-') ? {} : { mode: name === 'exclusive.json' ? 'exclusive' : 'shared' }

/**
 * Every entry the directory lists. An entry that cannot be read right now is not gone: it keeps its place, from its
 * name alone, until it reads again and the stale-owner rules can judge it.
 */
async function state(dir, processStart, reclaimed) {
  const records = []
  for (const name of await readdir(dir)) {
    if (!RECORD.test(name)) continue
    let owner
    try { owner = await json(join(dir, name)) } catch (error) {
      if (!sharing(error)) throw error
      records.push({ ...heldMode(name), ...ticket(name), file: name, unreadable: true })
      continue
    }
    if (!owner) continue
    const reason = await stale(owner, processStart)
    if (reason) { await unlink(join(dir, name)); reclaimed({ ...owner, reason }); continue }
    records.push({ ...owner, ...ticket(name), file: name })
  }
  return { holders: records.filter(r => !r.file.startsWith('queue-')),
    queue: records.filter(r => r.file.startsWith('queue-')).sort((a, b) => a.order - b.order) }
}

function positive(value, name, allowZero = false) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < (allowZero ? 0 : 1) || (!allowZero && !Number.isInteger(n))) throw new Error(`${name} is invalid`)
  return n
}

export async function acquireGpuLease({ file = GPU_LEASE_FILE, mode = 'shared',
  slots = process.env.OBPAL_E2E_GPU_SLOTS ?? 3,
  timeoutMs = Number(process.env.OBPAL_E2E_GPU_WAIT_MIN ?? 20) * 60_000,
  pollMs = 1000, signal, waiting = () => {},
  reclaimed = owner => console.log(`  GPU reclaimed ${owner.mode || 'legacy'} owner pid ${owner.pid}: ${owner.reason}`),
  suite = '', lane = process.env.OBPAL_LANE || '', processStart = gpuProcessStart } = {}) {
  slots = positive(slots, 'OBPAL_E2E_GPU_SLOTS')
  timeoutMs = positive(timeoutMs, 'OBPAL_E2E_GPU_WAIT_MIN', true)
  if (!['shared', 'exclusive'].includes(mode)) throw new Error('Unknown GPU lease mode')
  signal?.throwIfAborted()
  const processStartedAt = await processStart(process.pid)
  if (!processStartedAt) throw new Error('Cannot verify GPU owner process start time')
  const owner = { pid: process.pid, processStartedAt, token: randomUUID(), startedAt: new Date().toISOString(), mode, suite, lane }
  const dir = `${file}.d`, end = Date.now() + timeoutMs
  await mkdir(dir, { recursive: true })
  const verify = pid => pid === process.pid ? Promise.resolve(processStartedAt) : processStart(pid)
  const tx = (fn, abort = signal) => transaction(file, owner, verify, reclaimed, fn, abort, abort === null || mode === 'exclusive' ? Infinity : end)
  let queued, held, told = 0
  const removeOwn = async (name) => {
    if (!name) return
    if ((await json(join(dir, name)))?.token !== owner.token) throw new Error('GPU lease ownership changed')
    await unlink(join(dir, name))
  }
  try {
    await tx(async () => {
      const s = await state(dir, verify, reclaimed)
      const configPath = join(dir, 'config.json')
      const config = await json(configPath) || { order: 0, slots }
      if ((s.holders.length || s.queue.length) && config.slots !== slots) throw new Error(`GPU has ${config.slots} configured slots; wait until idle before changing capacity`)
      config.slots = slots
      // The ticket passes every waiter listed, so a lost or stale counter can never put a newcomer ahead of one.
      owner.order = config.order = Math.max(config.order || 0, ...s.queue.map(r => r.order)) + 1
      const next = join(dir, `config-${owner.token}.tmp`)
      await create(next, config)
      await rename(next, configPath)
      const queueName = `queue-${owner.order}.json`
      await publish(join(dir, queueName), owner)
      queued = queueName
    })
    const entering = patience()
    for (;;) {
      signal?.throwIfAborted()
      const entered = await tx(async () => {
        const s = await state(dir, verify, reclaimed)
        // Strict FIFO by ticket: any earlier entry blocks, including one that is unreadable at this moment.
        const earlier = s.queue.filter(r => r.order < owner.order)
        const blocked = earlier.length || (mode === 'exclusive' ? s.holders.length : s.holders.some(r => r.mode === 'exclusive'))
        const slot = !blocked && (mode === 'exclusive' ? 'exclusive.json' : Array.from({ length: slots }, (_, i) => `slot-${i}.json`).find(name => !s.holders.some(r => r.file === name)))
        if (!slot) { entering.ok(); return false }
        try { await publish(join(dir, slot), owner) } catch (error) {
          // A listing that missed a holder, or a name still mid-delete, means the slot is not ours yet: ask again next poll.
          if (error.code === 'EEXIST') return false
          if (!sharing(error)) throw error
          entering.wait(error)
          return false
        }
        entering.ok()
        held = slot
        await removeOwn(queued); queued = null
        return true
      })
      if (entered) break
      if (mode === 'shared' && Date.now() >= end) { await tx(() => removeOwn(queued), null); queued = null; return null }
      if (Date.now() - told >= 60_000) { waiting({ mode, suite }); told = Date.now() }
      await pause(mode === 'exclusive' ? pollMs : Math.min(pollMs, Math.max(1, end - Date.now())), signal)
    }
    let releasing
    const release = () => releasing ??= tx(() => removeOwn(held), null)
    if (signal?.aborted) { await release(); signal.throwIfAborted() }
    return release
  } catch (error) {
    if (held || queued) await tx(async () => { await removeOwn(held); await removeOwn(queued) }, null)
    if (mode === 'shared' && error.code === 'GPU_WAIT') return null
    throw error
  }
}

/**
 * Read-only status; acquisition reconciles dead owners. A file still refused after the retries is mid-delete or
 * mid-replace, and a report may leave it out.
 */
export async function gpuStatus({ file = GPU_LEASE_FILE } = {}) {
  const dir = `${file}.d`
  const read = async path => { try { return await json(path) } catch (error) { if (sharing(error)) return null; throw error } }
  let names
  try { names = await readdir(dir) } catch (error) { if (error.code === 'ENOENT') return { slots: 3, holders: [], queue: [], coordinator: await read(file) }; throw error }
  const records = (await Promise.all(names.filter(name => RECORD.test(name)).map(async name => ({ ...await read(join(dir, name)), ...ticket(name), file: name })))).filter(r => r.token)
  return { slots: (await read(join(dir, 'config.json')))?.slots ?? 3,
    holders: records.filter(r => !r.file.startsWith('queue-')),
    queue: records.filter(r => r.file.startsWith('queue-')).sort((a, b) => a.order - b.order), coordinator: await read(file) }
}
