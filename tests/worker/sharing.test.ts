import { afterEach, describe, expect, it, vi } from 'vitest'
import { admission, expiredWatch, ownerVerifier, WATCH_IDLE_MS, type Sharing } from '../../worker/sharing'
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))
import { Room } from '../../worker/index'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function mailbox(sharing: Sharing, players = 0, watchers = 0) {
  const sockets: { ws: any; tags: string[] }[] = []
  for (const [tag, count] of [['player', players], ['watcher', watchers]] as const) for (let n = 0; n < count; n++) sockets.push({ ws: { close: vi.fn() }, tags: ['device', tag] })
  const server = { accept: vi.fn(), close: vi.fn(), send: vi.fn(), serializeAttachment: vi.fn() }, client = {}
  vi.stubGlobal('WebSocketPair', class { 0 = client; 1 = server })
  vi.stubGlobal('Response', class { constructor(readonly body: unknown, readonly init: unknown) {} })
  const storage = { get: vi.fn(async (key: string) => key === 'sharing' ? sharing : undefined), put: vi.fn(), deleteAlarm: vi.fn() }
  const room = Object.create(Room.prototype) as Room
  Object.assign(room, { env: {}, ctx: { storage, getWebSockets: (tag?: string) => sockets.filter(s => !tag || s.tags.includes(tag)).map(s => s.ws), acceptWebSocket: (ws: any, tags: string[]) => sockets.push({ ws, tags }) } })
  return { room, storage, server, sockets }
}
describe('idle watch admission', () => {
  it('expires after an hour empty, never while a connection remains, and revokes immediately', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const room: Sharing = { owner: 'owner', play: 'play', watch: 'watch', emptyAt: 0 }
    vi.advanceTimersByTime(WATCH_IDLE_MS - 1); expect(admission(room, 'watch', Date.now())).toBe('watcher')
    vi.advanceTimersByTime(1); expect(admission(room, 'watch', Date.now())).toBeNull()
    expect(admission(room, 'play', Date.now())).toBe('player')
    room.emptyAt = null; vi.advanceTimersByTime(WATCH_IDLE_MS * 10); expect(expiredWatch(room, Date.now())).toBe(false)
    expect(admission(room, 'watch', Date.now())).toBe('watcher')
    room.watch = null; expect(admission(room, 'watch', Date.now())).toBeNull()
  })
  it('cannot choose a pool by a client flag or unknown verifier', () => {
    const room: Sharing = { owner: 'owner', play: 'play', watch: 'watch', emptyAt: null }
    expect(admission(room, 'watch', 0)).toBe('watcher'); expect(admission(room, 'play', 0)).toBe('player')
    expect(admission(room, 'player', 0)).toBeNull(); expect(admission(room, null, 0)).toBeNull()
  })
  it('admits 24 watchers alongside 8 players and rejects only the full pool', async () => {
    const { room, sockets, server } = mailbox({ owner: 'owner', play: 'play', watch: 'watch', emptyAt: null }, 8, 23)
    await room.fetch(new Request('https://example.org/r/room?key=watch&role=hostile&player=1'))
    expect(sockets.filter(s => s.tags.includes('watcher'))).toHaveLength(24)
    await room.fetch(new Request('https://example.org/r/room?key=watch'))
    expect(server.close).toHaveBeenLastCalledWith(4008, 'full')
    await room.fetch(new Request('https://example.org/r/room?key=play'))
    expect(server.close).toHaveBeenLastCalledWith(4008, 'full')
  })
  it('rejects owner impersonation and ignores watcher revocation or stale host mutations', async () => {
    const sharing: Sharing = { owner: await ownerVerifier('owner'), play: 'p'.repeat(43), watch: 'w'.repeat(43), emptyAt: null, revision: 2 }
    const { room, server, sockets, storage } = mailbox(sharing, 1, 1)
    await room.fetch(new Request('https://example.org/r/room?role=host&owner=watch'))
    expect(server.close).toHaveBeenCalledWith(4009, 'removed')
    const watcher = { deserializeAttachment: () => ({ role: 'device' }) }
    await room.webSocketMessage(watcher as unknown as WebSocket, JSON.stringify({ t: 'sharing', watch: null, revision: 3 }))
    expect(sharing.watch).not.toBeNull()
    const host = { deserializeAttachment: () => ({ role: 'host' }), send: vi.fn() }
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ t: 'sharing', watch: null, revision: 1 }))
    expect(sharing.watch).not.toBeNull()
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ t: 'sharing', watch: null, revision: 3 }))
    expect(sharing.watch).toBeNull(); expect(storage.put).toHaveBeenCalled()
    expect(sockets[1].ws.close).toHaveBeenCalledWith(4009, 'removed'); expect(sockets[0].ws.close).not.toHaveBeenCalled()
  })
  it('retires an idle Watch verifier so pending host metadata cannot revive it', async () => {
    const watch = 'w'.repeat(43), sharing: Sharing = { owner: 'owner', play: 'p'.repeat(43), watch, emptyAt: 0 }
    const { room } = mailbox(sharing)
    vi.useFakeTimers(); vi.setSystemTime(WATCH_IDLE_MS)
    await room.alarm()
    expect(sharing.watch).toBeNull(); expect(await room.shareTarget('watch')).toBeNull()
    sharing.emptyAt = null // The owner reconnects before sending its queued changes.
    const host = { deserializeAttachment: () => ({ role: 'host' }), send: vi.fn() }
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ t: 'sharing', watch, revision: 1 }))
    expect(sharing.watch).toBeNull()
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ t: 'sharing', watch: 'n'.repeat(43), revision: 2, links: { watch: 'c'.repeat(80) } }))
    expect(await room.shareTarget('watch')).toBe('c'.repeat(80))
  })
  it('clears short-code admission tickets atomically with Play rotation; Watch rotation leaves them alone', async () => {
    const sharing: Sharing = { owner: 'owner', play: 'p'.repeat(43), watch: 'w'.repeat(43), emptyAt: null }
    const { room, storage } = mailbox(sharing)
    const host = { deserializeAttachment: () => ({ role: 'host' }), send: vi.fn() }
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ t: 'sharing', watch: 'n'.repeat(43), revision: 1 }))
    expect(storage.put).toHaveBeenLastCalledWith('sharing', sharing)
    await room.webSocketMessage(host as unknown as WebSocket, JSON.stringify({ t: 'sharing', play: 'q'.repeat(43), revision: 2 }))
    expect(storage.put).toHaveBeenLastCalledWith({ sharing, tickets: {} })
  })
})
