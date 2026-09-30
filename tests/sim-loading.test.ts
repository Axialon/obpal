import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('the loading status and a failed start', () => {
  const classes = new Set<string>()
  const pill = { hidden: true, offsetWidth: 10, classList: { contains: (name: string) => classes.has(name), add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } }
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); classes.clear(); pill.hidden = true
    vi.stubGlobal('document', { getElementById: () => pill })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('keeps a slow held asset busy beyond the initial expectation, without diagnosing graphics', async () => {
    const load = await import('../src/sim/kit/loading')
    load.expectRig(); load.beginLoading()
    vi.advanceTimersByTime(20000)
    expect(load.loadingNow()).toBe(true)
    expect(pill.hidden).toBe(false)
    load.endLoading(); vi.advanceTimersByTime(260)
    expect(pill.hidden).toBe(true)
  })
  it('retires the initial expectation once, even if setup never reaches the first rig', async () => {
    const load = await import('../src/sim/kit/loading')
    load.expectRig(); expect(pill.hidden).toBe(false)
    vi.advanceTimersByTime(15260)
    expect(load.loadingNow()).toBe(false)
    expect(pill.hidden).toBe(true)
  })
  it('replaces busy immediately on a terminal failure; late downloads cannot resurrect it', async () => {
    const load = await import('../src/sim/kit/loading')
    load.expectRig(); load.beginLoading(); load.stopLoading()
    expect(load.loadingNow()).toBe(false)
    expect(pill.hidden).toBe(true)
    load.endLoading(); load.beginLoading(); load.expectRig()
    vi.advanceTimersByTime(20000)
    expect(load.loadingNow()).toBe(false)
    expect(pill.hidden).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
