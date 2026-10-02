import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearPlacement, dropClearance, nearDropPositions, playerDropBounds, dropCatalogue, DropQueue } from '../src/sim/vr/drops'
import { PropWorld } from '../src/sim/vr/world'
import { deviceDrops } from '../src/sim/vr/device-drops'
import { MarblerunLogic } from '../src/sim/devices/marblerun'
import { ClawLogic } from '../src/sim/devices/claw'
import type { SharedPresence } from '../src/sim/vr/presence'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Sphere, Vector3 } from 'three'
import { batch } from '../src/sim/kit'
import { placementHit } from '../src/sim/vr/placement'
afterEach(() => vi.useRealTimers())
describe('authoritative drops', () => {
  it('keeps a batched cabinet hollow while rejecting drops inside its floor, header or wall', () => {
    const cabinet = new Group(), material = new MeshStandardMaterial()
    for (const [size, at] of [[[2, .6, 2], [0, .3, 0]], [[2, .2, 2], [0, 1.8, 0]], [[.1, 1.8, 2], [-1, .9, 0]]] as const) {
      const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]), material); mesh.position.set(at[0], at[1], at[2]); cabinet.add(mesh)
    }
    batch(cabinet); cabinet.updateMatrixWorld(true)
    const mesh = cabinet.children.find(o => o instanceof Mesh) as Mesh
    expect(placementHit(mesh.geometry, mesh.matrixWorld, new Sphere(new Vector3(0, 1.3, 0), .1))).toBe(false)
    for (const p of [[0, .3, 0], [0, 1.8, 0], [-1, 1.2, 0]]) expect(placementHit(mesh.geometry, mesh.matrixWorld, new Sphere(new Vector3(...p), .1))).toBe(true)
  })
  it('enforces the catalogue, default budget, room queue and per-watcher token bucket', () => {
    vi.useFakeTimers(); vi.setSystemTime(0)
    const q = new DropQueue(dropCatalogue('kart')), d = { object: 'ball', at: null }
    expect(q.request('a', '#38bdf8', { ...d, object: 'hardware-arm' }, Date.now())).toBe(false)
    expect(q.request('a', '#38bdf8', d, Date.now())).toBe(true)
    expect(q.request('a', '#38bdf8', d, Date.now())).toBe(true)
    expect(q.request('a', '#38bdf8', d, Date.now())).toBe(false)
    vi.advanceTimersByTime(4999); expect(q.request('a', '#38bdf8', d, Date.now())).toBe(false)
    vi.advanceTimersByTime(1); expect(q.request('a', '#38bdf8', d, Date.now())).toBe(true)
    for (let n = 0; n < 5; n++) expect(q.request(`w${n}`, '#38bdf8', d, Date.now())).toBe(true)
    expect(q.queued).toBe(8); expect(q.request('last', '#38bdf8', d, Date.now())).toBe(false)
    const roomy = new DropQueue(dropCatalogue('kart'), 20)
    for (let n = 0; n < 8; n++) roomy.request(String(n), '#38bdf8', d, 0)
    expect(roomy.request('ninth', '#38bdf8', d, 0)).toBe(false)
  })
  it('places only on a safe tick, expires at five seconds, credits briefly, undoes and clears', () => {
    const q = new DropQueue(dropCatalogue('kart')), world = new PropWorld()
    q.request('w', '#38bdf8', { object: 'ball', at: [0, 1, 0], name: 'Guest' }, 0)
    q.tick(10, false, () => null); expect(q.queued).toBe(1); expect(world.bodies).toHaveLength(0)
    q.tick(20, false, (o, p) => world.add(o.kind, p!, o.radius)); expect(q.queued).toBe(0); expect(world.bodies).toHaveLength(1)
    expect(q.live.values().next().value?.name).toBe('Guest')
    q.tick(15020, false, () => null); expect(q.live.values().next().value?.name).toBe('')
    q.request('next', '#38bdf8', { object: 'ball', at: null }, 20)
    q.tick(5020, false, () => { throw new Error('Expired drops cannot be placed') }); expect(q.queued).toBe(0)
    q.undo(id => world.remove(id)); expect(world.bodies).toHaveLength(0); expect(q.live.size).toBe(0)
    q.request('a', '#38bdf8', { object: 'ball', at: [1, 1, 0] }, 16000)
    q.tick(16001, false, (o, p) => world.add(o.kind, p!, o.radius))
    q.clear(id => world.remove(id)); expect(world.bodies).toHaveLength(0)
  })
  it('rejects non-finite placement, occupied space and live hardware, and defaults hardware sims off', () => {
    expect(clearPlacement([NaN, 1, 0], .2, [])).toBe(false)
    expect(clearPlacement([0, 0, 0], .2, [])).toBe(false)
    expect(clearPlacement([0, 1, 0], .2, [{ p: [0, 1, 0], r: .3 }])).toBe(false)
    expect(clearPlacement([1, 1, 0], .2, [{ p: [0, 1, 0], r: .3 }])).toBe(true)
    const q = new DropQueue(dropCatalogue('arm'), 8, false)
    expect(q.request('a', '#38bdf8', { object: 'ball', at: null }, 0)).toBe(false)
    q.enabled = true; expect(q.request('a', '#38bdf8', { object: 'ball', at: null }, 0, true)).toBe(false)
    q.request('a', '#38bdf8', { object: 'ball', at: null }, 0)
    q.tick(1, true, () => { throw new Error('Hardware must prevent placement') }); expect(q.queued).toBe(0)
  })
  it('holds a drop clear of an outstretched hand until the player moves away', () => {
    const people = [{ head: { p: [0, 1.7, 0] as [number, number, number] }, hands: [{ p: [1.5, .5, 0] as [number, number, number] }] }]
    const q = new DropQueue(dropCatalogue('kart')), world = new PropWorld()
    q.request('watcher', '#38bdf8', { object: 'ball', at: [1.5, .5, 0] }, 0)
    const place = (object: typeof q.catalogue[number], at: [number, number, number] | null) => at && clearPlacement(at, object.radius, playerDropBounds(people)) ? world.add(object.kind, at, object.radius) : null
    q.tick(1, false, place); expect(world.bodies).toHaveLength(0); expect(q.queued).toBe(1)
    people[0].hands[0].p = [1.5, 1.5, 0]
    q.tick(2, false, place); expect(world.bodies).toHaveLength(1); expect(q.queued).toBe(0)
  })
  it('adds native marbles and claw prizes, releases held prizes on undo and detects sim resets', () => {
    const shared = { world: new PropWorld() } as SharedPresence
    const marble = new MarblerunLogic(), marbles = deviceDrops(marble, () => shared), object = dropCatalogue('marblerun')[0]
    const m = marbles.placeDrop(object, marbles.dropPosition(object, null)!)!
    expect(marble.units[0].marbles).toHaveLength(3); expect(m.bound).toBe(true)
    expect(marbles.dropAlive(m.id)).toBe(true); marble.home(0); expect(marbles.dropAlive(m.id)).toBe(false)
    marbles.removeDrop(m.id)
    const claw = new ClawLogic(), prizes = deviceDrops(claw, () => shared), orb = dropCatalogue('claw')[0]
    const count = claw.prizes[0].length, p = prizes.placeDrop(orb, [-1, 1.4, 0])!
    expect(claw.prizes[0]).toHaveLength(count + 1); expect(p.bound).toBe(true)
    claw.claws[0].held = count; prizes.removeDrop(p.id)
    expect(claw.claws[0].held).toBe(-1); expect(claw.prizes[0]).toHaveLength(count)
  })
  it('offers safe near-player alternatives when the first spot is occupied and follows the selected native unit', () => {
    const spots = nearDropPositions([3, 0, 4], .16), occupied = [{ p: spots[0], r: .16 }]
    expect(spots).toHaveLength(8); expect(clearPlacement(spots[0], .16, occupied)).toBe(false)
    expect(spots.slice(1).some(p => clearPlacement(p, .16, occupied))).toBe(true)
    expect(dropClearance('block', .16)).toBeGreaterThan(Math.sqrt(3) * .16)
    expect(dropClearance('cone', .18)).toBeGreaterThan(Math.sqrt(2) * .18)
    const shared = { world: new PropWorld() } as SharedPresence
    const marble = deviceDrops(new MarblerunLogic(), () => shared), claw = deviceDrops(new ClawLogic(), () => shared)
    expect(marble.dropPosition(dropCatalogue('marblerun')[0], null, [3.8, 1, 0])?.[0]).toBe(3.8)
    expect(claw.dropPosition(dropCatalogue('claw')[0], null, [1, 1, 0])?.[0]).toBe(1)
  })
})
