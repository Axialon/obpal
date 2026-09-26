import { describe, expect, it } from 'vitest'
import { Claims } from '../packages/host/src/claims'

describe('Claims: one participant per node, one node per participant (CATALOGUE §5)', () => {
  it('refuses a node someone else holds, naming who', () => {
    const c = new Claims()
    expect(c.take('j2', 'a').ok).toBe(true)
    expect(c.take('j2', 'b')).toEqual({ ok: false, holder: 'a' })
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
})
