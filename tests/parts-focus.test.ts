import { describe, expect, it } from 'vitest'
import { LOCKS_VALUE, PART_VALUE, type SceneNode } from '@obpal/core'
import { focusOf, PartFocus, readLocks } from '../packages/host/src/parts'
import type { Participant } from '../packages/host/src/remote'

/** An arm as the arm sim offers it: its joints as parts, Reach and Wrist as sets that hold the rest. */
const arm: SceneNode = {
  id: 'a1', name: 'Whole arm', kind: 'arm', icon: 'arm',
  parts: ['base', 'shoulder', 'elbow', 'wrist', 'roll', 'gripper'].map((k) => ({ id: `a1.${k}`, name: k })),
  sets: [
    { id: 'reach', name: 'Reach', parts: ['a1.base', 'a1.shoulder', 'a1.elbow'], locks: true },
    { id: 'wrist', name: 'Wrist', parts: ['a1.roll', 'a1.wrist'], locks: true },
  ],
}

describe('what a choice on the node strip means (PROTOCOL §3a)', () => {
  it('drives the whole node when nothing, or something it doesn’t offer, is chosen', () => {
    expect(focusOf(arm, '', [])).toEqual({ part: '', parts: [], locks: new Set() })
    expect(focusOf(arm, 'a2.base', []).part).toBe('')
    expect(focusOf(undefined, 'a1.base', []).parts).toEqual([])
  })

  it('drives one part alone, and a set’s parts in its order, holding the others', () => {
    expect(focusOf(arm, 'a1.elbow', [])).toEqual({ part: 'a1.elbow', parts: ['a1.elbow'], locks: new Set() })
    const reach = focusOf(arm, 'reach', [])
    expect(reach.parts).toEqual(['a1.base', 'a1.shoulder', 'a1.elbow'])
    expect([...reach.locks].sort()).toEqual(['a1.gripper', 'a1.roll', 'a1.wrist'])
  })

  it('keeps the locks it’s given, of the node’s own parts only', () => {
    expect([...focusOf(arm, '', ['a1.shoulder', 'b.nope']).locks]).toEqual(['a1.shoulder'])
    expect(readLocks('a1.base, a1.base ,,a1.elbow')).toEqual(['a1.base', 'a1.elbow'])
    expect(readLocks(7)).toEqual([])
    expect(readLocks('x'.repeat(65))).toEqual([])
  })
})

describe('the host’s record of each participant’s choice', () => {
  function wire() {
    const handlers: Record<string, ((...a: unknown[]) => void)[]> = { value: [], leave: [] }
    const sent: { values: Record<string, unknown>; who?: string }[] = []
    return {
      on: (ev: string, fn: (...a: unknown[]) => void) => { handlers[ev].push(fn) },
      setValues: (values: Record<string, unknown>, who?: string) => { sent.push({ values, who }) },
      emit: (ev: string, ...a: unknown[]) => handlers[ev].forEach((f) => f(...a)),
      sent,
    }
  }
  const phone = { id: 'p1' } as Participant

  it('takes a part or set the held node offers, confirms it to that phone, and bumps its serial', () => {
    const w = wire()
    let held: SceneNode | undefined = arm
    const changed: string[] = []
    const f = new PartFocus(w as never, () => held, (who) => changed.push(who))
    w.emit('value', { id: PART_VALUE, v: 'reach' }, phone)
    const a = f.of('p1')
    expect(a.part).toBe('reach')
    expect(w.sent.at(-1)).toEqual({ values: { [PART_VALUE]: 'reach', [LOCKS_VALUE]: '' }, who: 'p1' })
    w.emit('value', { id: LOCKS_VALUE, v: 'a1.gripper' }, phone)
    expect(f.of('p1').serial).toBeGreaterThan(a.serial)
    expect(changed).toEqual(['p1', 'p1'])
    // Something the node doesn't offer is the whole node, confirmed as such.
    w.emit('value', { id: PART_VALUE, v: 'a9.base' }, phone)
    expect(f.of('p1').part).toBe('')
    expect(w.sent.at(-1)!.values[PART_VALUE]).toBe('')
    // Holding another node, the choice no longer applies; a reset tells the phone.
    held = { ...arm, id: 'a2' }
    expect(f.of('p1')).toMatchObject({ node: 'a2', part: '', parts: [] })
    held = arm
    w.emit('value', { id: PART_VALUE, v: 'a1.elbow' }, phone)
    f.reset('p1')
    expect(f.of('p1').part).toBe('')
    expect(w.sent.at(-1)).toEqual({ values: { [PART_VALUE]: '', [LOCKS_VALUE]: '' }, who: 'p1' })
  })

  it('ignores choices from a participant holding nothing, and forgets one that leaves', () => {
    const w = wire()
    let held: SceneNode | undefined
    const f = new PartFocus(w as never, () => held)
    w.emit('value', { id: PART_VALUE, v: 'reach' }, phone)
    expect(w.sent).toEqual([])
    held = arm
    w.emit('value', { id: PART_VALUE, v: 'reach' }, phone)
    w.emit('leave', phone)
    expect(f.of('p1').part).toBe('')
  })
})
