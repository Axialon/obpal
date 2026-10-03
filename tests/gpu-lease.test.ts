import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, mkdir, writeFile, tmpdir, join, pid, childGpuPath, startGpuChild } from './gpu-node.mjs'
import { acquireGpuLease, gpuStatus } from '../scripts/lib/gpu-lease.mjs'
import { detectE2eGpu, e2eBrowserOptions } from '../scripts/lib/browser.mjs'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const lock = async () => { const dir = await mkdtemp(join(tmpdir(), 'obpal-gpu-test-')); dirs.push(dir); return join(dir, 'gpu.lock') }
const processStart = async (ownerPid: number) => ownerPid === pid ? 'current-start' : null
const acquire = (file: string, options: Parameters<typeof acquireGpuLease>[0] = {}) => acquireGpuLease({ file, pollMs: 2, processStart, ...options })
const until = async (predicate: () => Promise<boolean>, attempts = 200, delayMs = 5) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  throw new Error('GPU state did not settle')
}
const seed = async (file: string, name: string, fields: Record<string, unknown> = {}) => {
  await mkdir(`${file}.d`, { recursive: true })
  const owner = { pid: pid + 100000, processStartedAt: 'old-start', token: name, mode: 'shared', startedAt: '2026-01-01T00:00:00.000Z', order: 1, ...fields }
  await writeFile(name === 'legacy' ? file : join(`${file}.d`, name), JSON.stringify(owner))
  return owner
}

describe('the cross-lane GPU semaphore', () => {
  it('keeps the parent semaphore path when a real child has a different TEMP', async () => {
    const file = await lock(), childTemp = await mkdtemp(join(tmpdir(), 'obpal-gpu-child-'))
    dirs.push(childTemp)
    expect(await childGpuPath(file, childTemp)).toBe(file)
  })

  it('shares three real process holders and drains them before a real exclusive child', async () => {
    const file = await lock(), childTemp = await mkdtemp(join(tmpdir(), 'obpal-gpu-process-'))
    dirs.push(childTemp)
    const holders = Array.from({ length: 3 }, () => startGpuChild(file, childTemp))
    let exclusive: ReturnType<typeof startGpuChild> | undefined
    try {
      const childPids = await Promise.all(holders.map(child => child.acquired))
      expect(new Set(childPids).size).toBe(3)
      const held = await gpuStatus({ file })
      expect(held.holders.map(owner => owner.pid).sort()).toEqual(childPids.sort())
      expect(held.holders.every(owner => owner.processStartedAt)).toBe(true)
      exclusive = startGpuChild(file, childTemp, 'exclusive')
      await Promise.race([
        until(async () => (await gpuStatus({ file })).queue.some(owner => owner.mode === 'exclusive'), 600, 50),
        exclusive.acquired.then(() => { throw new Error('Exclusive child entered before holders drained') }),
      ])
      expect((await gpuStatus({ file })).holders).toHaveLength(3)
      await Promise.all(holders.map(async child => expect((await child.finish()).code).toBe(0)))
      const exclusivePid = await exclusive.acquired
      const drained = await gpuStatus({ file })
      expect(drained.holders.map(owner => [owner.pid, owner.mode])).toEqual([[exclusivePid, 'exclusive']])
      expect((await exclusive.finish()).code).toBe(0)
      expect((await gpuStatus({ file })).holders).toEqual([])
    } finally { await Promise.all([...holders, ...(exclusive ? [exclusive] : [])].map(child => child.stop())) }
  }, 120_000)

  it('admits N concurrent holders and releases idempotently', async () => {
    const file = await lock()
    const holders = await Promise.all(Array.from({ length: 3 }, (_, i) => acquire(file, { suite: `suite-${i}` })))
    const status = await gpuStatus({ file })
    expect(status.slots).toBe(3)
    expect(status.holders).toHaveLength(3)
    expect(new Set(status.holders.map(owner => owner.file)).size).toBe(3)
    expect(status.holders.every(owner => owner.pid === pid && owner.processStartedAt === 'current-start')).toBe(true)
    expect(await acquire(file, { timeoutMs: 0 })).toBeNull()
    await Promise.all(holders.flatMap(release => [release!(), release!()]))
    expect((await gpuStatus({ file })).holders).toEqual([])
    await expect(readFile(file)).rejects.toThrow()
  }, 30_000)

  it('drains shared holders for an exclusive waiter and keeps later shared requests behind it', async () => {
    const file = await lock(), first = await acquire(file), second = await acquire(file)
    const exclusive = acquire(file, { mode: 'exclusive', timeoutMs: 0, suite: 'timing', lane: 'timing-lane' })
    await until(async () => (await gpuStatus({ file })).queue.length === 1)
    const shared = acquire(file, { suite: 'later' })
    await until(async () => (await gpuStatus({ file })).queue.length === 2)
    const queued = await gpuStatus({ file })
    expect(queued.queue.map(owner => owner.suite)).toEqual(['timing', 'later'])
    expect(queued.queue[0].lane).toBe('timing-lane')
    await first!()
    expect((await gpuStatus({ file })).holders).toHaveLength(1)
    await second!()
    const endExclusive = await exclusive
    const exclusiveStatus = await gpuStatus({ file })
    expect(exclusiveStatus.holders.map(owner => owner.mode)).toEqual(['exclusive'])
    expect(exclusiveStatus.queue.map(owner => owner.suite)).toEqual(['later'])
    await endExclusive!()
    await (await shared)!()
    expect((await gpuStatus({ file })).queue).toEqual([])
  })

  it('preserves FIFO when a shared waiter is ahead of an exclusive waiter', async () => {
    const file = await lock(), first = await acquire(file, { slots: 1 })
    const controller = new AbortController()
    const pending: ReturnType<typeof acquire>[] = []
    const enqueue = async (mode: 'shared' | 'exclusive', suite: string) => {
      let queued!: () => void
      const waiting = new Promise<void>(resolve => { queued = resolve })
      const request = acquire(file, { slots: 1, mode, suite, timeoutMs: 60_000, signal: controller.signal, waiting: queued })
      pending.push(request)
      // The notification follows a committed queue entry and a refused admission.
      await Promise.race([waiting, request.then(() => { throw new Error(`${suite} entered before its turn`) })])
      return { request }
    }
    try {
      const shared = await enqueue('shared', 'first-waiter')
      const exclusive = await enqueue('exclusive', 'second-waiter')
      expect((await gpuStatus({ file })).queue.map(owner => owner.suite)).toEqual(['first-waiter', 'second-waiter'])
      await first!()
      const endShared = await shared.request
      const sharedStatus = await gpuStatus({ file })
      expect(sharedStatus.holders.map(owner => [owner.suite, owner.mode])).toEqual([['first-waiter', 'shared']])
      expect(sharedStatus.queue.map(owner => owner.suite)).toEqual(['second-waiter'])
      await endShared!()
      const endExclusive = await exclusive.request
      const exclusiveStatus = await gpuStatus({ file })
      expect(exclusiveStatus.holders.map(owner => [owner.suite, owner.mode])).toEqual([['second-waiter', 'exclusive']])
      expect(exclusiveStatus.queue).toEqual([])
      await endExclusive!()
    } finally {
      controller.abort(new Error('FIFO test finished'))
      await first!()
      const settled = await Promise.allSettled(pending)
      await Promise.all(settled.map(result => result.status === 'fulfilled' && result.value ? result.value() : undefined))
    }
    expect((await gpuStatus({ file })).holders).toEqual([])
  }, 30_000)

  it('does not let a faster polling shared waiter overtake an earlier shared waiter', async () => {
    const file = await lock(), first = await acquire(file, { slots: 1 })
    const older = acquire(file, { slots: 1, pollMs: 100, suite: 'older' })
    await until(async () => (await gpuStatus({ file })).queue.length === 1)
    const newer = acquire(file, { slots: 1, suite: 'newer' })
    await until(async () => (await gpuStatus({ file })).queue.length === 2)
    await first!()
    await until(async () => (await gpuStatus({ file })).holders.length === 1)
    const admitted = (await gpuStatus({ file })).holders[0].suite
    // Always drain both pending jobs, even when the order assertion fails.
    if (admitted === 'older') { await (await older)!(); await (await newer)!() }
    else { await (await newer)!(); await (await older)!() }
    expect(admitted).toBe('older')
  })

  it.each(['dead PID', 'reused PID'])('reclaims a %s slot and queue with a log for each owner', async reason => {
    const file = await lock(), reclaimed: string[] = []
    await seed(file, 'slot-0.json')
    await seed(file, 'queue-1.json', { mode: 'exclusive' })
    const release = await acquire(file, { slots: 1, processStart: async ownerPid => ownerPid === pid ? 'current-start' : reason === 'dead PID' ? null : 'new-start', reclaimed: owner => reclaimed.push(owner.reason!) })
    expect(reclaimed).toEqual([reason, reason])
    expect((await gpuStatus({ file })).queue).toEqual([])
    await release!()
  })

  it('reclaims a dead legacy lock before entering', async () => {
    const file = await lock(), reclaimed: string[] = []
    await seed(file, 'legacy')
    const release = await acquire(file, { reclaimed: owner => reclaimed.push(owner.reason!) })
    expect(reclaimed).toEqual(['dead PID'])
    await release!()
  })

  it('recognises reused legacy PIDs from process birth after lock acquisition', async () => {
    const file = await lock(), reclaimed: string[] = []
    await seed(file, 'legacy', { processStartedAt: undefined })
    // Windows process evidence uses DateTime ticks rather than ISO strings.
    const newBirth = String((BigInt(Date.parse('2026-01-02T00:00:00.000Z')) + 62135596800000n) * 10000n)
    const release = await acquire(file, { processStart: async ownerPid => ownerPid === pid ? 'current-start' : newBirth, reclaimed: owner => reclaimed.push(owner.reason!) })
    expect(reclaimed).toEqual(['reused PID'])
    await release!()
  })

  it('recovers a legacy lock when its first reclaimer was killed', async () => {
    const file = await lock(), reclaimed: string[] = []
    const deadOwner = await seed(file, 'legacy')
    await writeFile(`${file}.reclaimed-${deadOwner.token}`, JSON.stringify({ ...deadOwner, token: 'dead-reclaimer' }))
    const release = await acquire(file, { reclaimed: owner => reclaimed.push(owner.reason!) })
    expect(reclaimed).toEqual(['dead PID'])
    await release!()
    await expect(readFile(file)).rejects.toThrow()
  })

  it.each(['live', 'unverifiable'])('falls back without stealing a %s legacy lock and cancels promptly', async kind => {
    const file = await lock()
    await seed(file, 'legacy')
    const original = await readFile(file, 'utf8')
    const verify = async (ownerPid: number) => ownerPid === pid ? 'current-start' : kind === 'live' ? 'old-start' : undefined
    expect(await acquire(file, { timeoutMs: 15, processStart: verify })).toBeNull()
    const controller = new AbortController()
    const pending = acquire(file, { mode: 'exclusive', timeoutMs: 0, processStart: verify, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled legacy wait')
    await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error('cancelled legacy wait'))
    await rejected
    expect(await readFile(file, 'utf8')).toBe(original)
    expect((await gpuStatus({ file })).queue).toEqual([])
  })

  it.each(['live', 'unverifiable'])('never steals a %s owner', async kind => {
    const file = await lock()
    await seed(file, 'slot-0.json')
    const original = await readFile(join(`${file}.d`, 'slot-0.json'), 'utf8')
    const release = await acquire(file, { slots: 1, timeoutMs: 0, processStart: async ownerPid => ownerPid === pid ? 'current-start' : kind === 'live' ? 'old-start' : undefined, reclaimed: () => { throw new Error('must not reclaim') } })
    expect(release).toBeNull()
    expect(await readFile(join(`${file}.d`, 'slot-0.json'), 'utf8')).toBe(original)
  })

  it('releases after a failed job and after handled interruption', async () => {
    const file = await lock()
    for (const failure of [new Error('failed job'), new Error('interrupted')]) {
      const release = await acquire(file)
      await expect((async () => { try { throw failure } finally { await release!() } })()).rejects.toThrow(failure.message)
      expect((await gpuStatus({ file })).holders).toEqual([])
    }
  })

  it('cancels a waiting request without removing its live holder', async () => {
    const file = await lock(), release = await acquire(file, { slots: 1 })
    const original = (await gpuStatus({ file })).holders[0].token
    const controller = new AbortController()
    const pending = acquire(file, { slots: 1, signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await until(async () => (await gpuStatus({ file })).queue.length === 1)
    controller.abort(new Error('cancelled'))
    await rejected
    const status = await gpuStatus({ file })
    expect(status.queue).toEqual([])
    expect(status.holders[0].token).toBe(original)
    await release!()
  })

  it('returns software fallback after the shared wait deadline and leaves no waiter', async () => {
    const file = await lock(), release = await acquire(file, { slots: 1 })
    expect(await acquire(file, { slots: 1, timeoutMs: 15 })).toBeNull()
    expect((await gpuStatus({ file })).queue).toEqual([])
    await release!()
  })

  it('rejects invalid configuration and capacity changes while occupied', async () => {
    const file = await lock()
    for (const slots of [0, -1, 1.5, NaN]) await expect(acquire(file, { slots })).rejects.toThrow('OBPAL_E2E_GPU_SLOTS')
    await expect(acquire(file, { timeoutMs: -1 })).rejects.toThrow('OBPAL_E2E_GPU_WAIT_MIN')
    await expect(acquire(file, { processStart: async () => undefined })).rejects.toThrow('Cannot verify')
    const release = await acquire(file)
    await expect(acquire(file, { slots: 2 })).rejects.toThrow('configured slots')
    expect((await gpuStatus({ file })).holders).toHaveLength(1)
    await release!()
    await (await acquire(file, { slots: 2 }))!()
    expect((await gpuStatus({ file })).slots).toBe(2)
  })
})

describe('GPU selection', () => {
  it('preserves manual defaults and replaces conflicting software flags for GPU or fallback', () => {
    const options = { args: ['--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }
    expect(e2eBrowserOptions(options, {})).toBe(options)
    expect(e2eBrowserOptions(options, { OBPAL_E2E_GPU: '1' }, 'win32').args).toEqual(['--ignore-certificate-errors', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'])
    expect(e2eBrowserOptions({ args: ['--use-angle=d3d11', '--enable-gpu'] }, { OBPAL_E2E_GPU: 'swiftshader' }).args).toEqual(['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
  })
  it('detects software devices and closes every probe, including failed evaluation', async () => {
    for (const renderer of ['ANGLE (NVIDIA, D3D11)', 'ANGLE (SwiftShader Device)', '']) {
      let closed = false
      const launch = async () => ({ newPage: async () => ({ evaluate: async () => renderer }), close: async () => { closed = true } })
      expect((await detectE2eGpu('', { launch, platform: 'win32' })).hardware).toBe(renderer.includes('NVIDIA'))
      expect(closed).toBe(true)
    }
    expect((await detectE2eGpu('', { platform: 'linux' })).hardware).toBe(false)
    let closed = false
    await expect(detectE2eGpu('', { platform: 'win32', launch: async () => ({ newPage: async () => { throw new Error('probe failed') }, close: async () => { closed = true } }) })).rejects.toThrow('probe failed')
    expect(closed).toBe(true)
  })
})
