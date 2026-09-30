import { describe, expect, it } from 'vitest'
import { retryableSetup } from './humanoid-live-harness-node.mjs'

const attempt = { state: 'arming', timeOrigin: 1000, at: 20, armedAt: 20 }
const current = { reason: 'Guardian arm acknowledgement timed out' }
const snapshot = {
  held: true,
  timeOrigin: 1010,
  events: [
    { kind: 'arm', at: 12 },
    { kind: 'hold', at: 65, reason: 'Guardian arm acknowledgement timed out' },
  ],
  pageTimeline: [{ action: 'receive:/status', kind: 'live', at: 100 }],
}

describe('humanoid-live test preparation', () => {
  it('admits a demonstrably late acknowledgement only after a hold', () => {
    expect(retryableSetup(attempt, current, snapshot)).toBe(true)
    expect(retryableSetup(attempt, current, { ...snapshot, held: false })).toBe(false)
  })
  it('never hides a lost or mishandled on-time acknowledgement', () => {
    expect(retryableSetup(attempt, current, { ...snapshot, pageTimeline: [] })).toBe(false)
    for (const at of [25, 70])
      expect(retryableSetup(attempt, current, {
        ...snapshot, pageTimeline: [{ action: 'receive:/status', kind: 'live', at }],
      })).toBe(false)
  })
  it('refuses retries if any motion follows hold', () => {
    expect(retryableSetup(attempt, current, {
      ...snapshot, events: [...snapshot.events, { kind: 'goal', at: 66 }],
    })).toBe(false)
  })
  it('admits a stale observe-only refusal with no arm, but never an unrelated fault', () => {
    const refused = { ...attempt, state: 'observe', reason: 'Guardian status is stale' }
    expect(retryableSetup(refused, current, { ...snapshot, events: [] })).toBe(true)
    expect(retryableSetup(refused, current, snapshot)).toBe(false)
    expect(retryableSetup(attempt, { reason: 'Bad joint map' }, snapshot)).toBe(false)
  })
  it('requires independent lease expiry when the page missed renewal', () => {
    const missed = { reason: 'Page missed its deadman renewal' },
      expired = { ...snapshot, events: [snapshot.events[0],
        { kind: 'hold', at: 115, deadline: 110, reason: 'Deadman lease expired' }] }
    expect(retryableSetup(attempt, missed, expired)).toBe(true)
    expect(retryableSetup(attempt, missed, snapshot)).toBe(false)
    expect(retryableSetup(attempt, missed, { ...expired, events: [expired.events[0],
      { kind: 'hold', at: 105, deadline: 110, reason: 'Deadman lease expired' }] })).toBe(false)
  })
})
