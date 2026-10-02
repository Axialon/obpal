import { afterEach, describe, expect, it, vi } from 'vitest'
import { startupPath, startupProbe, startupText } from './home-startup-node.mjs'

describe('home startup diagnostics', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('removes invite fragments, admission queries and dynamic room paths', () => {
    const room = 'a'.repeat(22), secret = 'b'.repeat(43)
    const url = `https://example.test/p/?key=${secret}#1.${room}.${secret}`
    expect(startupPath(url)).toBe('/p/')
    expect(startupText(`Navigation failed: ${url}`)).toBe('Navigation failed: /p/')
    expect(startupPath(`wss://example.test/r/${room}?key=${secret}`)).toBe('/r/[redacted]')
    expect(startupText(`secret ${secret}, fragment #1.${room}.${secret}`)).toBe('secret [redacted], fragment #[redacted]')
    expect(startupText('code ' + '12345'.repeat(2))).toBe('code [redacted]')
  })

  it('returns the original promises and IDB request without changing their receivers or arguments', async () => {
    const args: unknown[][] = [], receivers: unknown[] = []
    const certificate = Promise.resolve({}), digest = Promise.resolve(new ArrayBuffer(0))
    const request = new EventTarget()
    const rtc = { generateCertificate(...values: unknown[]) { args.push(values); receivers.push(this); return certificate } }
    const subtle = { digest(...values: unknown[]) { args.push(values); receivers.push(this); return digest } }
    const idb = { open(...values: unknown[]) { args.push(values); receivers.push(this); return request } }
    const window: { RTCPeerConnection: typeof rtc; __homeStartup?: { operation: string; state: string; endMs?: number }[] } = { RTCPeerConnection: rtc }
    vi.stubGlobal('window', window)
    vi.stubGlobal('crypto', { subtle })
    vi.stubGlobal('indexedDB', idb)
    startupProbe()
    expect(rtc.generateCertificate('algorithm')).toBe(certificate)
    expect(subtle.digest('algorithm', 'bytes')).toBe(digest)
    expect(idb.open('db', 2)).toBe(request)
    expect(args).toEqual([['algorithm'], ['algorithm', 'bytes'], ['db', 2]])
    expect(receivers).toEqual([rtc, subtle, idb])
    request.dispatchEvent(new Event('success'))
    await Promise.all([certificate, digest])
    expect(window.__homeStartup?.map(row => row.state)).toEqual(['fulfilled', 'fulfilled', 'success'])
    expect(window.__homeStartup?.every(row => typeof row.endMs === 'number')).toBe(true)
  })

  it('keeps pending, rejected and thrown operations distinguishable without recording errors or results', async () => {
    const failure = new Error('private operation detail'), pending = new Promise(() => {})
    const rejected = Promise.reject(failure)
    const rtc = { generateCertificate() { return pending } }
    const subtle = { digest() { return rejected }, importKey() { throw failure } }
    const window: { RTCPeerConnection: typeof rtc; __homeStartup?: { state: string }[] } = { RTCPeerConnection: rtc }
    vi.stubGlobal('window', window)
    vi.stubGlobal('crypto', { subtle })
    vi.stubGlobal('indexedDB', { open() {} })
    startupProbe()
    expect(rtc.generateCertificate()).toBe(pending)
    expect(subtle.digest()).toBe(rejected)
    expect(() => subtle.importKey()).toThrow(failure)
    await rejected.catch(() => {})
    expect(window.__homeStartup?.map(row => row.state)).toEqual(['pending', 'rejected', 'threw'])
    expect(JSON.stringify(window.__homeStartup)).not.toContain(failure.message)
  })
})
