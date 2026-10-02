import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, tmpdir, join, pid } from './gpu-node.mjs'
import { acquireGpuLease } from '../scripts/lib/gpu-lease.mjs'
import { detectE2eGpu, e2eBrowserOptions } from '../scripts/lib/browser.mjs'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const lock = async () => { const dir = await mkdtemp(join(tmpdir(), 'obpal-gpu-test-')); dirs.push(dir); return join(dir, 'gpu.lock') }

describe('the cross-lane GPU lease', () => {
  it('queues a competing job until release and releases only once', async () => {
    const file = await lock(), release = await acquireGpuLease({ file })
    let entered = false
    const contender = acquireGpuLease({ file, pollMs: 5 }).then(release => { entered = true; return release })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(entered).toBe(false)
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(pid)
    await Promise.all([release(), release()])
    await (await contender)()
    await expect(readFile(file)).rejects.toThrow()
  })
  it('times out without taking another job’s lock and honours cancellation', async () => {
    const file = await lock(), release = await acquireGpuLease({ file })
    const original = await readFile(file, 'utf8')
    await expect(acquireGpuLease({ file, timeoutMs: 15, pollMs: 5 })).rejects.toThrow('timed out')
    const controller = new AbortController()
    const pending = acquireGpuLease({ file, signal: controller.signal })
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(await readFile(file, 'utf8')).toBe(original)
    await release()
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
