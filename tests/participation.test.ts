import { describe, expect, it, vi } from 'vitest'
import { Audience, aggregateVotes, Handover, presenceStrip } from '../src/sim/participation'
import { validSimMessage } from '@obpal/core'

describe('presence and handover', () => {
  it('keeps players and their seats while collapsing a long watching audience', () => {
    const model = presenceStrip([{ id: 'p', name: 'Phone', color: '#fff', role: 'play', seat: 'Rover 1' }, ...Array.from({ length: 12 }, (_, n) => ({ id: `w${n}`, name: 'Guest', color: '#fff', role: 'watch' as const }))])
    expect(model.players[0].seat).toBe('Rover 1'); expect(model.watchers).toHaveLength(8); expect(model.watcherCount).toBe(12); expect(model.collapsed).toBe(4)
  })
  it('accepts only connected watchers into free seats, and transfers a scoped grant', () => {
    const h = new Handover(), watchers = new Set(['a', 'b'])
    expect(h.ask('unknown', watchers)).toBe(false); expect(h.ask('a', watchers)).toBe(true)
    expect(h.accept('a', 'rover1', watchers, new Set(['rover1']))).toBe(false)
    expect(h.accept('a', undefined, watchers, new Set())).toBe(false)
    expect(h.accept('a', 'rover2', watchers, new Set())).toBe(true)
    expect(h.requests.size).toBe(0); expect(h.grants.get('a')).toBe('rover2')
    expect(h.give('a', 'b', 'rover2', watchers)).toBe(true); expect(h.grants.has('a')).toBe(false); expect(h.grants.get('b')).toBe('rover2')
    h.leave('b'); expect(h.grants.size).toBe(0)
    h.ask('a', watchers); h.decline('a'); expect(h.requests.size).toBe(0)
  })
})

describe('audience authority and timing', () => {
  it('rotates timed turns on the host clock and discards the old holder input', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    try {
      const a = new Audience(), watchers = new Set(['a', 'b'])
      a.configure('queue', 'rover1'); a.join('a', watchers, Date.now()); a.join('b', watchers, Date.now())
      expect(a.input('b', 1, 1, 0, Date.now(), watchers)).toBe(false)
      expect(a.input('a', 1, 1, 0, Date.now(), watchers)).toBe(true)
      expect(a.snapshot(Date.now(), watchers).direction).toEqual([1, 0])
      vi.advanceTimersByTime(59_999); expect(a.snapshot(Date.now(), watchers).turn).toBe('a')
      vi.advanceTimersByTime(1); const state = a.snapshot(Date.now(), watchers)
      expect(state.turn).toBe('b'); expect(state.remaining).toBe(60); expect(state.direction).toEqual([0, 0])
      expect(a.input('a', 2, 1, 0, Date.now(), watchers)).toBe(false)
      a.leave('b'); expect(a.snapshot(Date.now(), watchers).turn).toBeNull()
    } finally { vi.useRealTimers() }
  })
  it('expires, rate-limits and rejects stale, non-finite or oversized directions', () => {
    const a = new Audience(), watchers = new Set(['a'])
    expect(a.input('a', 1, 1, 0, 0, watchers)).toBe(false)
    a.configure('crowd', 'rover1')
    expect(a.input('player', 1, 1, 0, 0, watchers)).toBe(false)
    expect(a.input('a', 1, Infinity, 0, 0, watchers)).toBe(false)
    expect(a.input('a', 1, 1.01, 0, 0, watchers)).toBe(false)
    expect(a.input('a', 1, 1, 1, 0, watchers)).toBe(true)
    expect(Math.hypot(...a.snapshot(0, watchers).direction)).toBeCloseTo(1)
    expect(a.input('a', 2, 1, 0, 10, watchers)).toBe(false)
    expect(a.input('a', 2, 0, 0, 10, watchers)).toBe(true)
    expect(a.input('a', 2, 1, 0, 60, watchers)).toBe(false)
    expect(a.input('a', 3, 1, 0, 60, watchers)).toBe(true)
    expect(a.snapshot(310, watchers).direction).toEqual([0, 0])
    a.configure('off', ''); expect(a.input('a', 4, 1, 0, 400, watchers)).toBe(false)
  })
  it('allows one place per watcher and removes disconnected or promoted watchers', () => {
    const a = new Audience(), watchers = new Set(['a', 'b'])
    a.configure('queue', 'unit', 5); expect(a.join('a', watchers, 0)).toBe(true); expect(a.join('a', watchers, 1)).toBe(false); a.join('b', watchers, 1)
    watchers.delete('a'); expect(a.snapshot(10, watchers).turn).toBe('b')
    a.configure('crowd', 'unit'); a.input('b', 1, 1, 0, 10, watchers); watchers.delete('b'); expect(a.snapshot(20, watchers).direction).toEqual([0, 0])
  })
  it('aggregates deterministically, caps work and excludes an isolated opposing vote', () => {
    const votes = [{ id: 'a', x: .9, y: .1 }, { id: 'b', x: .8, y: .2 }, { id: 'c', x: -1, y: -1 }]
    const aggregate = aggregateVotes(votes)
    expect(aggregate).toEqual(aggregateVotes([...votes].reverse()))
    expect(aggregate.votes.find(v => v.id === 'c')?.accepted).toBe(false)
    expect(aggregate.direction[0]).toBeCloseTo(.85); expect(aggregate.direction[1]).toBeCloseTo(.15)
    expect(aggregateVotes(Array.from({ length: 100 }, (_, n) => ({ id: String(n), x: 1, y: 1 }))).votes).toHaveLength(24)
  })
  it('bounds dedicated wire messages and rejects extra authority fields', () => {
    const packet = (kind: 'audience' | 'seat' | 'handover', data: unknown) => ({ t: 'sim', v: 1, kind, seq: 1, data })
    expect(validSimMessage(packet('audience', { x: 1, y: 0 }))).toBe(true)
    expect(validSimMessage(packet('audience', { op: 'join' }))).toBe(true)
    expect(validSimMessage(packet('audience', { x: 1, y: 0, hardware: true }))).toBe(false)
    expect(validSimMessage(packet('audience', { x: 1, y: 0, action: 'arm' }))).toBe(false)
    expect(validSimMessage(packet('audience', { x: 1, y: 0, rx: 1 }))).toBe(false)
    expect(validSimMessage(packet('audience', { op: ['join'] }))).toBe(false)
    expect(validSimMessage(packet('audience', { x: NaN, y: 0 }))).toBe(false)
    expect(validSimMessage(packet('seat', { x: 0, y: 0, action: 'home' }))).toBe(true)
    expect(validSimMessage(packet('handover', { op: 'give', to: 'x'.repeat(65) }))).toBe(false)
    expect(validSimMessage(packet('handover', { op: 'accept', key: 'play' }))).toBe(false)
    expect(validSimMessage(packet('handover', { op: ['accept'] }))).toBe(false)
  })
  it('bounds crowd and queue work even when demoted Play phones join the audience pool', () => {
    const a = new Audience(), watchers = new Set(Array.from({ length: 32 }, (_, n) => String(n)))
    a.configure('crowd', 'unit', NaN); expect(a.seconds).toBe(60)
    for (const id of watchers) a.input(id, 1, 1, 0, 0, watchers)
    expect(a.snapshot(0, watchers).votes).toHaveLength(24)
    a.configure('queue', 'unit'); for (const id of watchers) a.join(id, watchers, 0)
    expect(a.snapshot(0, watchers).next).toHaveLength(23)
    expect(a.command('31', 2, 'leave', 10, watchers)).toBe(true); expect(a.command('31', 2, 'join', 1000, watchers)).toBe(false)
  })
})
