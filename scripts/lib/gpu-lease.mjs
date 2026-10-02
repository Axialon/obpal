/** One browser job per GPU across worktrees. A crashed owner leaves a visible lock, never an unsafe takeover. */
import { open, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function acquireGpuLease({ file = join(tmpdir(), 'obpal-e2e-gpu.lock'), timeoutMs = 180 * 60_000,
  pollMs = 1000, signal, waiting = () => {} } = {}) {
  const token = randomUUID(), end = Date.now() + timeoutMs
  let told = 0
  for (;;) {
    signal?.throwIfAborted()
    let handle
    try { handle = await open(file, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      signal?.throwIfAborted()
      if (Date.now() >= end) throw new Error('GPU lease timed out; inspect the TEMP obpal-e2e-gpu.lock owner before removing a stale lock')
      if (Date.now() - told >= 60_000) { waiting(); told = Date.now() }
      await new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', aborted); resolve() }
        const timer = setTimeout(done, Math.min(pollMs, Math.max(1, end - Date.now())))
        const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason) }
        signal?.addEventListener('abort', aborted, { once: true })
      })
      continue
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() }) + '\n') }
    catch (error) { await handle.close(); await unlink(file); throw error }
    await handle.close()
    let releasing
    const release = () => releasing ??= (async () => {
      const owner = JSON.parse(await readFile(file, 'utf8'))
      if (owner.token !== token) throw new Error('GPU lease ownership changed')
      await unlink(file)
    })()
    if (signal?.aborted) { await release(); signal.throwIfAborted() }
    return release
  }
}
