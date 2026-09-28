import { describe, expect, it } from 'vitest'
import { LOCKS_VALUE, PART_VALUE, type SceneNode } from '@obpal/core'
import { NodeStrip, stripItems, stripState } from '../src/controller/strip'

const arm: SceneNode = {
  id: 'a1', name: 'Whole arm', kind: 'arm', icon: 'arm',
  parts: [['base', 'turn'], ['shoulder', 'lift'], ['elbow', 'bend'], ['gripper', 'grip']].map(([k, icon]) => ({ id: `a1.${k}`, name: k, icon })),
  sets: [
    { id: 'reach', name: 'Reach', icon: 'reach', parts: ['a1.base', 'a1.shoulder', 'a1.elbow'], locks: true },
    { id: 'solo', name: 'Solo', parts: ['a1.gripper'] },
    { id: 'odd', name: 'Odd', parts: ['a9.x', 'a1.base'] },
  ],
}

describe('the node strip (./strip.ts)', () => {
  it('lists the whole node, its sets of two or more of its parts, then each part', () => {
    const items = stripItems(arm)
    expect(items.map((i) => `${i.kind}:${i.id}`)).toEqual(['whole:', 'set:reach', 'part:a1.base', 'part:a1.shoulder', 'part:a1.elbow', 'part:a1.gripper'])
    expect(items[0]).toMatchObject({ name: 'Whole arm', icon: 'arm', parts: [] })
    expect(items[1]).toMatchObject({ parts: ['a1.base', 'a1.shoulder', 'a1.elbow'], locks: true })
  })

  it('shows nothing for a node without parts to switch between (an older screen, a single joint)', () => {
    expect(stripItems(null)).toEqual([])
    expect(stripItems({ id: 'r1', name: 'Rover 1', kind: 'rover' })).toEqual([])
    expect(stripItems({ ...arm, parts: arm.parts!.slice(0, 1) })).toEqual([])
    expect(stripItems({ ...arm, parts: 'nope' } as unknown as SceneNode)).toEqual([])
  })

  it('lights what a choice drives, and holds what a set locks and what was locked by hand', () => {
    const items = stripItems(arm)
    const reach = stripState(items, 'reach', ['a1.shoulder'])
    expect([...reach.lit]).toEqual(['a1.base', 'a1.elbow'])
    expect([...reach.held].sort()).toEqual(['a1.gripper', 'a1.shoulder'])
    expect(stripState(items, 'gone', []).item?.kind).toBe('whole')
  })

  it('tells the pad’s legend which gesture moves which part, and follows the screen’s word', () => {
    const sent: [string, string][] = []
    const strip = new NodeStrip({ send: (id, v) => sent.push([id, v]), feel: () => {}, changed: () => {} })
    strip.sync(arm, {}, true)
    expect(strip.legend()).toEqual([])
    strip.sync(arm, { [PART_VALUE]: 'reach', [LOCKS_VALUE]: 'a1.shoulder' }, true)
    expect(strip.legend()).toEqual([{ gesture: 'swipe-x', name: 'base' }, { gesture: 'pan-y', name: 'elbow' }])
    strip.sync(arm, { [PART_VALUE]: 'a1.elbow', [LOCKS_VALUE]: '' }, true)
    expect(strip.legend()).toEqual([{ gesture: 'drag', name: 'elbow' }])
    // Off the trackpad it shows nothing, and says nothing.
    strip.sync(arm, { [PART_VALUE]: 'a1.elbow' }, false)
    expect(strip.current).toBeNull()
    expect(sent).toEqual([])
  })
})
