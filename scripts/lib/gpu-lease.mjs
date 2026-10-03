/** A cross-worktree FIFO semaphore. State lives beside the legacy system TEMP lease. */
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
/** Windows can briefly deny replacement while a status reader closes its handle. Keep ownership throughout. */
async function sharingRetry(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation() } catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 20) throw error
      await pause(100)
    }
  }
}
const unlink = path => sharingRetry(() => remove(path))
const rename = (from, to) => sharingRetry(() => move(from, to))

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

async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(`Cannot verify GPU state ${path}: ${error.message}`)
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
  await create(prepared, owner)
  try {
    for (;;) {
      signal?.throwIfAborted()
      try { await link(prepared, file); break } catch (error) { if (error.code !== 'EEXIST') throw error }
      const held = await json(file)
      const reason = held && await stale(held, processStart)
      if (reason) {
        // Only one reclaimer per old token may unlink. Retain its tiny claim to prevent an ABA unlink.
        try {
          const claimed = await claimReclaim(`${file}.reclaimed-${held.token}`, owner, processStart)
          if (claimed && (await json(file))?.token === held.token) { await unlink(file); reclaimed({ ...held, reason }) }
        } catch (error) { if (error.code !== 'EEXIST' && error.code !== 'ENOENT') throw error }
      }
      if (Date.now() >= deadline) { const error = new Error('GPU shared wait expired'); error.code = 'GPU_WAIT'; throw error }
      await pause(20, signal)
    }
    try { return await fn() } finally { await unlink(file) }
  } finally { await unlink(prepared) }
}

async function state(dir, processStart, reclaimed) {
  const records = []
  for (const name of await readdir(dir)) {
    if (!/^(slot-\d+|exclusive|queue-\d+)\.json$/.test(name)) continue
    const owner = await json(join(dir, name))
    if (!owner) continue
    const reason = await stale(owner, processStart)
    if (reason) { await unlink(join(dir, name)); reclaimed({ ...owner, reason }); continue }
    records.push({ ...owner, file: name })
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
      owner.order = ++config.order
      const next = join(dir, `config-${owner.token}.tmp`)
      await create(next, config)
      await rename(next, configPath)
      const queueName = `queue-${owner.order}.json`
      await publish(join(dir, queueName), owner)
      queued = queueName
    })
    for (;;) {
      signal?.throwIfAborted()
      const entered = await tx(async () => {
        const s = await state(dir, verify, reclaimed)
        const earlier = s.queue.filter(r => r.order < owner.order)
        if (earlier.length || (mode === 'exclusive' ? s.holders.length : s.holders.some(r => r.mode === 'exclusive'))) return false
        const slot = mode === 'exclusive' ? 'exclusive.json' : Array.from({ length: slots }, (_, i) => `slot-${i}.json`).find(name => !s.holders.some(r => r.file === name))
        if (!slot) return false
        await publish(join(dir, slot), owner)
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

/** Read-only status; acquisition reconciles dead owners. */
export async function gpuStatus({ file = GPU_LEASE_FILE } = {}) {
  const dir = `${file}.d`
  let names
  try { names = await readdir(dir) } catch (error) { if (error.code === 'ENOENT') return { slots: 3, holders: [], queue: [], coordinator: await json(file) }; throw error }
  const records = (await Promise.all(names.filter(name => /^(slot-\d+|exclusive|queue-\d+)\.json$/.test(name)).map(async name => ({ ...await json(join(dir, name)), file: name })))).filter(r => r.token)
  return { slots: (await json(join(dir, 'config.json')))?.slots ?? 3,
    holders: records.filter(r => !r.file.startsWith('queue-')),
    queue: records.filter(r => r.file.startsWith('queue-')).sort((a, b) => a.order - b.order), coordinator: await json(file) }
}
