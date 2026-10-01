import { afterEach, describe, expect, it, vi } from 'vitest'

const pointer = vi.hoisted(() => vi.fn())
vi.mock('../src/link/constellation', () => ({ mountConstellation: () => ({ pointer }) }))

async function demo(reduced = false, flat = false) {
  vi.resetModules(); pointer.mockClear()
  let writes = 0, text = '', now = 0, seq = 0
  const status = { dataset: {}, get textContent() { return text }, set textContent(value: string) { text = value; writes++ } }
  const guidance = { textContent: '' }
  const canvas = { hidden: flat, dataset: {} as Record<string, string> }
  const reset = new EventTarget()
  const doc = Object.assign(new EventTarget(), {
    hidden: false,
    querySelector: (selector: string) => ({ '#demo-state': status, '#demo-guidance': guidance, '#link-space': canvas, '#demo-reset': reset })[selector],
  })
  const win = new EventTarget()
  const media = { matches: reduced }
  let pad: { connected: boolean; axes: number[] } | null = null
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('document', doc); vi.stubGlobal('window', win)
  vi.stubGlobal('navigator', { getGamepads: () => [pad] })
  vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++seq, cb); return seq })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  await import('../src/link/try')
  return {
    status, guidance, canvas, media, frames,
    writes: () => writes,
    pad(value: typeof pad) { pad = value },
    step() { now += 16; const pending = [...frames.values()]; frames.clear(); pending.forEach(cb => cb(now)) },
    reset() { reset.dispatchEvent(new Event('click')) },
    hidden(value: boolean) { doc.hidden = value; doc.dispatchEvent(new Event('visibilitychange')) },
    lifecycle(type: string) { win.dispatchEvent(new Event(type)) },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('Try controller feedback', () => {
  it.each([[false, false, 'motion'], [true, false, 'reduced'], [false, true, 'unavailable']])('reports input, release and disconnect in feedback mode %s/%s', async (reduced, flat, mode) => {
    const page = await demo(reduced as boolean, flat as boolean)
    expect(page.status.textContent).toContain('enable This tab')
    page.pad({ connected: true, axes: [0, 0] }); page.step()
    expect(page.status.textContent).toContain('Left stick is neutral')
    page.pad({ connected: true, axes: [0.7, 0] }); page.step()
    expect(page.status.textContent).toContain('Left stick input detected')
    expect(page.status.dataset).toMatchObject({ feedbackMode: mode })
    if (mode !== 'motion') expect(pointer).not.toHaveBeenCalled()
    else expect(pointer).toHaveBeenCalled()
    const writes = page.writes()
    page.pad({ connected: true, axes: [-0.9, 0.6] })
    for (let i = 0; i < 100; i++) page.step()
    expect(page.writes()).toBe(writes)
    page.pad({ connected: true, axes: [0, 0] }); page.step()
    expect(page.status.textContent).toContain('Left stick released. Input is neutral')
    expect(page.canvas.dataset.padInput).toBe('false')
    page.pad(null); page.step()
    expect(page.status.textContent).toContain('Controller disconnected')
    page.step(); page.reset()
    expect(page.status.textContent).toContain('Controller disconnected')
  })

  it('updates the guidance when graphics are lost or motion preferences change', async () => {
    const page = await demo()
    page.pad({ connected: true, axes: [0.6, 0] }); page.step()
    pointer.mockClear(); page.canvas.hidden = true; page.step()
    expect(page.guidance.textContent).toContain('motion is unavailable')
    expect(page.status.textContent).toContain('input detected')
    expect(pointer).not.toHaveBeenCalled()
    page.media.matches = true; page.step()
    expect(page.guidance.textContent).toContain('stays still with reduced motion')
  })

  it('keeps held input truthful on reset and reads a neutral reset immediately', async () => {
    const page = await demo()
    page.pad({ connected: true, axes: [0.5, 0] }); page.step(); page.reset()
    expect(page.status.textContent).toContain('input detected')
    expect(pointer).toHaveBeenCalledWith(0, 0)
    expect(page.frames.size).toBe(1)
    page.pad({ connected: true, axes: [0, 0] }); page.reset()
    expect(page.status.textContent).toContain('released')
    expect(page.frames.size).toBe(1)
  })

  it('pauses while hidden and resamples after repeated history returns without duplicate polling', async () => {
    const page = await demo(true)
    page.pad({ connected: true, axes: [0.5, 0] }); page.step()
    page.hidden(true)
    expect(page.status.textContent).toContain('paused')
    expect(page.frames.size).toBe(0)
    page.pad(null); page.hidden(false)
    expect(page.status.textContent).toContain('disconnected')
    for (let i = 0; i < 3; i++) {
      page.lifecycle('pagehide'); expect(page.frames.size).toBe(0)
      page.pad({ connected: true, axes: [0, 0] }); page.lifecycle('pageshow'); page.lifecycle('pageshow')
      expect(page.status.textContent).toContain('Left stick is neutral')
      expect(page.frames.size).toBe(1)
    }
  })

  it('ignores dead-zone jitter, missing and non-finite axes, and disconnected pads', async () => {
    const page = await demo()
    for (const axes of [[0.12, -0.1], [], [NaN, Infinity]]) {
      page.pad({ connected: true, axes }); page.step()
      expect(page.status.textContent).toContain('is neutral')
    }
    expect(pointer).not.toHaveBeenCalled()
    page.pad({ connected: false, axes: [1, 1] }); page.step()
    expect(page.status.textContent).toContain('disconnected')
  })
})
