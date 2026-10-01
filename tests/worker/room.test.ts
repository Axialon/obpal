import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
import { Room } from '../../worker/index'

afterEach(() => vi.unstubAllGlobals())

describe('room capacity', () => {
  it('rejects the ninth device with a readable full close code without occupying a seat', async () => {
    const server = { accept: vi.fn(), close: vi.fn() }, client = {}
    vi.stubGlobal('WebSocketPair', class { 0 = client; 1 = server })
    vi.stubGlobal('Response', class { constructor(readonly body: unknown, readonly init: unknown) {} })
    const acceptWebSocket = vi.fn()
    const room = Object.create(Room.prototype)
    Object.assign(room, { ctx: { getWebSockets: () => Array(8).fill({}), acceptWebSocket } })
    const response = await room.fetch(new Request('https://example.org/r/room?role=device'))
    expect(response.init).toEqual({ status: 101, webSocket: client })
    expect(server.accept).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledWith(4008, 'full')
    expect(acceptWebSocket).not.toHaveBeenCalled()
  })
})
