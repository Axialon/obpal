import { afterEach, expect, it, vi } from 'vitest'
import { Governor, ladder } from '../src/landing/governor'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('uses one shared frame and cancels it entirely in a hidden tab', async () => {
  let hidden = false
  let visibility = () => {}
  const pending = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('document', { get hidden() { return hidden }, addEventListener: (_: string, fn: () => void) => { visibility = fn } })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { pending.set(++id, fn); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => pending.delete(id))
  const { addActor, wake } = await import('../src/landing/ticker')
  const actor = vi.fn(() => true)
  addActor(actor); addActor(() => false); wake()
  expect(pending.size).toBe(1)
  hidden = true; visibility()
  expect(pending.size).toBe(0)
  expect(actor).not.toHaveBeenCalled()
  wake()
  expect(pending.size).toBe(0)
  hidden = false; visibility()
  const next = pending.entries().next().value!
  pending.delete(next[0]); next[1](100)
  expect(actor).toHaveBeenCalledTimes(1)
  expect(pending.size).toBe(1)
  actor.mockReturnValue(false)
  const final = pending.entries().next().value!
  pending.delete(final[0]); final[1](117)
  expect(pending.size).toBe(0)
})

it('steps quality down when CPU work consumes headroom before a refresh is missed', () => {
  const governor = new Governor(ladder(1, false))
  expect(governor.work(7)).toBe(0)
  expect(governor.work(7)).toBe(0)
  expect(governor.work(7)).toBe(1)
  expect(governor.work(2)).toBe(1)
  expect(governor.work(NaN)).toBe(1)
})
