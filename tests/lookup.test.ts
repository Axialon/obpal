import { afterEach, describe, expect, it, vi } from 'vitest'
import { lookupCode, workDone } from '@obpal/core'

afterEach(() => vi.unstubAllGlobals())

/** The service's answers in turn, and what the phone sent. */
function service(...answers: [number, object][]) {
  const sent: { headers: Record<string, string>; body: { code: string; work?: { c: string; x: string } } }[] = []
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push({ headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) })
    const [status, body] = answers.shift()!
    return Response.json(body, { status })
  })
  return sent
}

describe('the phone looking a code up', () => {
  it('sends JSON, and hands back the room and ticket', async () => {
    const sent = service([200, { room: 'R'.repeat(22), ticket: 'T'.repeat(22) }])
    expect(await lookupCode('https://svc.test', '48219')).toEqual({ room: 'R'.repeat(22), ticket: 'T'.repeat(22) })
    expect(sent[0].headers['Content-Type']).toBe('application/json')
    expect(sent[0].body).toEqual({ code: '48219' })
  })

  it('asked for a proof of work, finds one and asks again with it', async () => {
    const sent = service([429, { error: 'work', challenge: 'k.10.nonce.tag', bits: 10 }], [200, { room: 'R'.repeat(22), ticket: 'T'.repeat(22) }])
    let worked = 0
    expect(await lookupCode('https://svc.test', '48219', { onWork: () => worked++ })).toMatchObject({ room: 'R'.repeat(22) })
    expect(worked).toBe(1)
    const w = sent[1].body.work!
    expect(w.c).toBe('k.10.nonce.tag')
    expect(workDone(w.c, w.x, 10)).toBe(true)
  })

  it('reads no code, slow down and a busy service as such', async () => {
    service([404, { error: 'no-code' }])
    expect(await lookupCode('https://svc.test', '48219')).toEqual({ error: 'no-code' })
    service([429, { error: 'slow-down', retry: 42 }])
    expect(await lookupCode('https://svc.test', '48219')).toEqual({ error: 'slow-down', retry: 42 })
    service([503, { error: 'busy', retry: 5 }])
    expect(await lookupCode('https://svc.test', '48219')).toEqual({ error: 'slow-down', retry: 5 })
    // A proof of work a phone couldn't find in reasonable time is not attempted.
    service([429, { error: 'work', challenge: 'k.30.nonce.tag', bits: 30 }])
    expect(await lookupCode('https://svc.test', '48219')).toMatchObject({ error: 'slow-down' })
  })
})
