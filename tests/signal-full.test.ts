import { afterEach, expect, it, vi } from 'vitest'
import { SignalClient } from '../packages/core/src/signal'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('reports a full room once and stops reconnecting', () => {
  vi.useFakeTimers()
  let socket: { onopen: () => void; onclose: (e: { code: number }) => void }
  const made = vi.fn()
  vi.stubGlobal('WebSocket', class { constructor() { made(); socket = this as unknown as typeof socket } })
  const signal = new SignalClient('wss://example.org/r/room?role=device')
  signal.onfull = vi.fn()
  signal.connect()
  socket!.onopen()
  socket!.onclose({ code: 4008 })
  expect(signal.onfull).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(30000)
  expect(made).toHaveBeenCalledOnce()
})
