/**
 * The screen's side of the short code (packages/host remote.ts): what it shows as the room service's answers come in,
 * in whatever order, and where it pairs through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workDone } from '@obpal/core'
import { Remote, serviceOrigin } from '../packages/host/src/remote'

type Msg = Record<string, unknown>
/** A Remote with just its short-code state, and a room socket that records what it sends. */
function screen() {
  const sent: Msg[] = []
  const r = Object.create(Remote.prototype) as Remote & Record<string, unknown>
  Object.assign(r, {
    handlers: new Proxy({}, { get: () => [] }), opts: {}, codeWant: 1, shortCode: null, spentCodes: new Map(), recentCodes: new Map(),
    codeTimer: null, codeWait: null, codeBackoff: 0, codeSolving: false, sig: { open: true, send: (m: Msg) => sent.push(m) },
  })
  const on = (m: Msg) => (r as unknown as { onCode(m: Msg): void }).onCode({ t: 'code', ...m })
  const ask = () => (r as unknown as { askCode(): void }).askCode()
  const state = r as unknown as { spentCodes: Map<string, { secret: string; ticket: string }>; shortCode: { handle: string; secret: string } | null }
  const spent = () => state.spentCodes
  const shown = () => state.shortCode
  return { r, sent, on, ask, spent, shown }
}
const exp = () => Date.now() + 600_000

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the code on the screen', () => {
  it('a notice about a code no longer on show keeps its attempt, and doesn’t bring back a code the service replaced', () => {
    const s = screen()
    s.on({ code: '11111', exp: exp() })
    const first = s.shown()!.secret
    // The renewal's answer comes first; the notice that 11111 was looked up (with a stale replacement) after it.
    s.on({ code: '33333', exp: exp() })
    s.on({ ev: 'used', code: '11111', ticket: 'T1', next: { code: '22222', exp: exp() } })
    expect(s.shown()!.handle).toBe('33333')
    expect(s.spent().get('11111')).toMatchObject({ secret: first, ticket: 'T1' })
  })

  it('a notice about the code on show brings its replacement at once', () => {
    const s = screen()
    s.on({ code: '11111', exp: exp() })
    s.on({ ev: 'used', code: '11111', ticket: 'T1', next: { code: '22222', exp: exp() } })
    expect(s.shown()!.handle).toBe('22222')
    expect(s.spent().has('11111')).toBe(true)
  })

  it('a refusal takes the code off the screen, hands it back, and asks again later, less often each time', () => {
    const s = screen()
    s.on({ code: '44444', exp: exp() })
    s.on({ error: 'busy', retry: 20 })
    expect(s.shown()).toBeNull()
    expect(s.sent).toContainEqual({ t: 'code', op: 'drop' })
    s.sent.length = 0
    vi.advanceTimersByTime(19_000)
    expect(s.sent).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(s.sent).toEqual([{ t: 'code', op: 'claim' }])
  })

  it('no answer at all: it asks again after 15 s, then 30 s, then 60 s', () => {
    const s = screen()
    s.ask()
    const claims = () => s.sent.filter((m) => m.op === 'claim').length
    expect(claims()).toBe(1)
    vi.advanceTimersByTime(15_000 + 15_000)
    expect(claims()).toBe(2)
    vi.advanceTimersByTime(15_000 + 30_000)
    expect(claims()).toBe(3)
    vi.advanceTimersByTime(15_000 + 59_000)
    expect(claims()).toBe(3)
    vi.advanceTimersByTime(1_000)
    expect(claims()).toBe(4)
  })

  it('asked for a proof of work, it finds one and asks again with it', async () => {
    const s = screen()
    s.on({ error: 'work', challenge: 'k.8.nonce.tag', bits: 8 })
    await vi.waitFor(() => expect(s.sent.some((m) => m.op === 'claim')).toBe(true))
    const claim = s.sent.find((m) => m.op === 'claim') as { work: { c: string; x: string } }
    expect(claim.work.c).toBe('k.8.nonce.tag')
    expect(workDone(claim.work.c, claim.work.x, 8)).toBe(true)
  })
})

describe('the service a screen pairs through', () => {
  it('is an https origin, or http on this machine', () => {
    expect(serviceOrigin('https://obpal.blackboxes.net/')).toBe('https://obpal.blackboxes.net')
    expect(serviceOrigin('https://obpal.blackboxes.net/some/path')).toBe('https://obpal.blackboxes.net')
    expect(serviceOrigin('http://localhost:5175')).toBe('http://localhost:5175')
    expect(serviceOrigin('http://127.0.0.1:5179')).toBe('http://127.0.0.1:5179')
  })
  it('refuses anything else, so it can never become a link that runs code', () => {
    for (const s of ['javascript:alert(1)', 'data:text/html,hi', 'http://example.com', 'obpal.blackboxes.net', 'wss://obpal.blackboxes.net', '']) {
      expect(() => serviceOrigin(s)).toThrow(/https/)
    }
  })
})
