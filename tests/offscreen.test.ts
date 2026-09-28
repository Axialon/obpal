import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPad, emptyState, encodePad, encodeState, Flag, Mode } from '@obpal/core'
import type { Remote } from '@obpal/host'
import { NATIVE_PORT_NAME, type NativeFrame } from '../extension/src/shared/native'

class Channel {
  readyState = 'open'
  bufferedAmount = 0
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  send() {}
  receive(data: unknown) { if (this.readyState === 'open') this.onmessage?.({ data }) }
  close() { this.readyState = 'closed'; this.onclose?.() }
}

let remote: Remote | undefined
afterEach(() => {
  remote?.destroy()
  remote = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Run the real offscreen mapper and Remote channels against an inert native host; no Chrome or native APIs exist. */
async function link() {
  vi.resetModules()
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  const { Remote } = await import('@obpal/host')
  // Construct without init: signaling and authentication are covered in invite.test.ts.
  const r = remote = Reflect.construct(Remote, [{ appName: 'Test', latency: 'direct' }]) as Remote
  const channels: Record<string, Channel> = {}
  const connection = {
    connectionState: 'connected',
    createDataChannel: (name: string) => (channels[name] = new Channel()),
    close: () => { for (const c of Object.values(channels)) c.close() },
  }
  const peer = (r as unknown as { addPeer(id: string, pc: unknown, fp: Uint8Array): { bound: boolean } }).addPeer('phone', connection, new Uint8Array(32))
  peer.bound = true
  Object.assign(r, { active: peer, status: 'connected' })
  vi.spyOn(Remote, 'create').mockResolvedValue(r)

  const frames: { at: number; frame: NativeFrame }[] = []
  const host = { held: { t: 'f' } as NativeFrame, watchdogs: 0 }
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const connect = vi.fn(({ name }: { name: string }) => {
    expect(name).toBe(NATIVE_PORT_NAME)
    let closed = false
    return {
      onDisconnect: { addListener() {} },
      postMessage(frame: NativeFrame) {
        if (closed) throw new Error('closed mock port')
        frames.push({ at: performance.now(), frame })
        host.held = frame
        clearTimeout(watchdog)
        watchdog = setTimeout(() => { host.held = { t: 'f' }; host.watchdogs++ }, 500)
      },
      disconnect() { closed = true },
    }
  })
  vi.stubGlobal('chrome', { runtime: {
    id: 'test-extension',
    onMessage: { addListener() {} }, onConnect: { addListener() {} }, connect,
    sendMessage: async (m: { type: string }) => m.type === 'offscreen-ready'
      ? { tabId: null, mode: 'pc', desktop: false }
      : m.type === 'phone' ? { access: 'allow' } : undefined,
  } })
  vi.stubGlobal('Worker', class { constructor() { throw new Error('use the fake interval clock') } })
  // Offscreen has its own TypeScript config, including the browser's Chrome declarations.
  const module = '../extension/src/offscreen.ts'
  await import(module)
  await vi.advanceTimersByTimeAsync(0)
  let seq = 0
  const pad = () => channels.st.receive(encodePad({ ...emptyPad(), seq: ++seq, buttons: 1, triggers: [0, 1] }))
  const state = () => channels.st.receive(encodeState({ ...emptyState(), seq: ++seq, mode: Mode.tilt, flags: Flag.touching, tilt: [0, -1] }))
  const button = (id: string, ev: string) => channels.ctl.receive(JSON.stringify({ t: 'btn', id, ev }))
  return { r, channels, frames, host, connect, pad, state, button }
}

describe('Link releases a dropped phone at the mock native host', () => {
  it.each([
    ['silent', 'PAD'], ['closed', 'PAD'], ['silent', 'gesture'], ['closed', 'gesture'],
  ])('%s channel releases held %s keys and buttons within 500 ms and stops resending', async (drop, source) => {
    const l = await link()
    if (source === 'PAD') l.pad()
    else {
      l.state()
      l.button('mouse-left', 'down')
      // Keep the phone live until the mouse face's hold becomes a held button.
      for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(100); l.state() }
    }
    expect(l.host.held.k?.length).toBeGreaterThan(0)
    expect(l.host.held.b).toContain(0)
    const droppedAt = performance.now()
    if (drop === 'closed') { l.channels.st.close(); l.channels.ctl.close() }
    await vi.advanceTimersByTimeAsync(500)
    expect.soft(l.host.held).toEqual({ t: 'f' })
    const release = l.frames.find((x) => x.at > droppedAt && !x.frame.k && !x.frame.b && !x.frame.m && !x.frame.w)
    expect.soft(release?.at).toBeLessThanOrEqual(droppedAt + 500)
    const count = l.frames.length
    const ports = l.connect.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect.soft(l.frames).toHaveLength(count)
    expect.soft(l.connect).toHaveBeenCalledTimes(ports)
    expect.soft(l.host.watchdogs).toBeGreaterThan(0)
    if (drop === 'silent') {
      l.pad()
      expect(l.host.held).toMatchObject({ k: ['Space'], b: [0] })
      expect(l.frames.length).toBeGreaterThan(count)
    }
  })

  it('keeps current input live, releases on disconnect, and sends nothing before the first packet', async () => {
    const l = await link()
    await vi.advanceTimersByTimeAsync(600)
    expect.soft(l.frames).toEqual([])
    for (let i = 0; i < 10; i++) { l.pad(); await vi.advanceTimersByTimeAsync(100) }
    expect(l.host.held).toMatchObject({ k: ['Space'], b: [0] })
    expect(l.host.watchdogs).toBe(0)
    l.r.disconnect()
    await vi.advanceTimersByTimeAsync(500)
    expect(l.host.held).toEqual({ t: 'f' })
    const count = l.frames.length
    await vi.advanceTimersByTimeAsync(600)
    expect(l.frames).toHaveLength(count)
  })
})
