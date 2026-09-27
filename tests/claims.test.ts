import { describe, expect, it } from 'vitest'
import { Claims } from '../packages/host/src/claims'

describe('Claims: one participant per node, one node per participant (CATALOGUE §5)', () => {
  it('refuses a node someone else holds, naming who', () => {
    const c = new Claims()
    expect(c.take('j2', 'a').ok).toBe(true)
    expect(c.take('j2', 'b')).toEqual({ ok: false, holder: 'a', blocking: 'j2' })
    expect(c.holder('j2')).toBe('a')
  })

  it('lets go of the old node when taking a new one', () => {
    const c = new Claims()
    c.take('j1', 'a')
    expect(c.take('j2', 'a')).toEqual({ ok: true, released: 'j1', lost: undefined })
    expect(c.holder('j1')).toBeUndefined()
    expect(c.held('a')).toBe('j2')
  })

  it('lets the screen take a node back, and reports who lost it', () => {
    const c = new Claims()
    c.take('grip', 'a')
    expect(c.take('grip', 'host', true)).toEqual({ ok: true, released: undefined, lost: 'a' })
    expect(c.held('a')).toBeUndefined()
    expect(c.snapshot()).toEqual({ grip: 'host' })
  })

  it('frees what a participant held when it leaves, and what a removed node had', () => {
    const c = new Claims()
    c.take('j1', 'a')
    c.take('j3', 'b')
    expect(c.release('a')).toBe('j1')
    expect(c.free('j3')).toBe('b')
    expect(c.snapshot()).toEqual({})
  })

  it('nests nodes: holding an arm holds its joints, and a held joint keeps the arm free for nobody else', () => {
    const c = new Claims()
    c.nest('a1.elbow', 'a1')
    c.nest('a1.wrist', 'a1')
    expect(c.take('a1', 'a').ok).toBe(true)
    expect(c.take('a1.elbow', 'b')).toEqual({ ok: false, holder: 'a', blocking: 'a1' })
    expect(c.controller('a1.wrist')).toBe('a')
    c.release('a')
    expect(c.take('a1.elbow', 'b').ok).toBe(true)
    expect(c.take('a1', 'a')).toEqual({ ok: false, holder: 'b', blocking: 'a1.elbow' })
    // Its own joint doesn't block: taking the arm lets go of it.
    expect(c.take('a1', 'b')).toEqual({ ok: true, released: 'a1.elbow', lost: undefined })
    expect(c.snapshot()).toEqual({ a1: 'b' })
  })

  it('lets the screen take a whole arm back from everyone holding part of it', () => {
    const c = new Claims()
    c.nest('a1.elbow', 'a1')
    c.nest('a1.wrist', 'a1')
    c.take('a1.elbow', 'a')
    c.take('a1.wrist', 'b')
    expect(c.take('a1', 'host', true)).toEqual({ ok: true, released: undefined, lost: undefined, evicted: ['a', 'b'] })
    expect(c.held('a')).toBeUndefined()
    expect(c.held('b')).toBeUndefined()
    expect(() => c.nest('a1', 'a1.elbow')).toThrow()
    c.unnest('a1')
    expect(c.take('a1.elbow', 'a').ok).toBe(true)
  })
})
