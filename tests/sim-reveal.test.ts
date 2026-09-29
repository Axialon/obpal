import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ARM_KINDS } from '../src/sim/arm/kinds'
import { DEVICES } from '../src/sim/devices/registry'
import { ARM_MODELS, DEVICE_MODELS, pageModels, prototypeUrl } from '../src/sim/kit/models'
import { holdRig, isHeld, LOAD_BUDGET_MS } from '../src/sim/kit/reveal'

const stage = vi.hoisted(() => vi.fn((): string | null => null))
vi.mock('../src/sim/kit/models', async original => ({ ...await original<typeof import('../src/sim/kit/models')>(), downloadStage: stage }))

/** Every device view's source, and the names of the meshes shipped (the files themselves are never loaded). */
const views = import.meta.glob('../src/sim/devices/*.view.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const shipped = new Set(Object.keys(import.meta.glob('../public/models/*.glb')).map(path => path.split('/').pop()!.replace(/\.glb$/, '')))

describe('which meshes a page needs', () => {
  it('names the arm kind\'s own mesh, the five-axis arm for none or an unknown kind', () => {
    expect(ARM_MODELS).toEqual(ARM_KINDS.map(k => k.id))
    expect(pageModels('/sim/arm/', '?kind=so101')).toEqual(['so101'])
    expect(pageModels('/sim/arm/', '?kind=desk&quality=native')).toEqual(['desk'])
    expect(pageModels('/sim/arm/', '')).toEqual(['arm5'])
    expect(pageModels('/sim/arm/', '?kind=toString')).toEqual(['arm5'])
  })
  it('reads a device from ?d= or from a built page\'s path, and names none for a page without a mesh', () => {
    expect(pageModels('/sim/device/', '?d=drone')).toEqual(['drone'])
    expect(pageModels('/sim/rover/', '')).toEqual(['rover'])
    expect(pageModels('/sim/slider/', '')).toEqual(['film-camera'])
    expect(pageModels('/sim/device/', '?d=jib&test=load')).toEqual(['film-camera'])
    for (const path of ['/sim/pinball/', '/sim/device/', '/sim/', '/sim/arena/', '/', '/view/']) expect(pageModels(path, '')).toEqual([])
    expect(pageModels('/sim/device/', '?d=constructor')).toEqual([])
  })
  it('lists, for every device, the meshes its view loads (and only real devices, and real files)', () => {
    expect(Object.keys(views).length).toBeGreaterThan(30)
    expect(shipped.size).toBeGreaterThanOrEqual(24)
    const ids = new Set(DEVICES.map(d => d.spec.id))
    for (const [id, names] of Object.entries(DEVICE_MODELS)) {
      expect(ids.has(id), `${id} is a device`).toBe(true)
      for (const name of names) expect(shipped.has(name), `${prototypeUrl(name)} is shipped`).toBe(true)
    }
    for (const [path, source] of Object.entries(views)) {
      const id = path.split('/').pop()!.replace(/\.view\.ts$/, '')
      const names = new Set([...source.matchAll(/(?:loadPrototype|upgradeSkins)\('([a-z0-9-]+)'/g)].map(m => m[1]))
      // The slider and the jib crane share one camera, built in filming.view.ts.
      if (/\bfilmCamera\(/.test(source) && id !== 'filming') names.add('film-camera')
      if (id === 'filming') { expect([...names]).toEqual(['film-camera']); continue }
      expect([...names], `${id} loads`).toEqual([...(DEVICE_MODELS[id] ?? [])])
    }
  })
})

describe('holding a rig until its mesh is in', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); stage.mockReset(); stage.mockReturnValue(null) })
  const rig = () => {
    const scene = new THREE.Scene(), root = new THREE.Group(), shadow = new THREE.Mesh(), other = new THREE.Group()
    scene.add(root, shadow, other)
    return { scene, root, shadow, other }
  }

  it('keeps the rig and what goes with it out of view, and shows the mesh\'s rig once the swap is done', () => {
    const { root, shadow, other } = rig()
    const hold = holdRig('drone', [root], { also: [shadow] })
    expect([root.visible, shadow.visible, other.visible]).toEqual([false, false, true])
    expect(root.userData.prototype).toBe('procedural')
    expect(isHeld(root)).toBe(true)
    const swap = vi.fn(() => { expect(root.visible).toBe(false); root.userData.swapped = true })
    hold.install(swap)
    expect(swap).toHaveBeenCalledOnce()
    expect([root.visible, shadow.visible]).toEqual([true, true])
    expect(root.userData.prototype).toBe('blender')
    expect(isHeld(root)).toBe(false)
  })

  it('takes later companions in, and shows the procedural rig once when the mesh cannot come', () => {
    const { root, shadow } = rig()
    const shown = vi.fn()
    const hold = holdRig('rover', [root], { shown })
    hold.alongside(shadow)
    expect(shadow.visible).toBe(false)
    hold.fallback(); hold.fallback()
    expect([root.visible, shadow.visible]).toEqual([true, true])
    expect(root.userData.prototype).toBe('procedural')
    expect(shown).toHaveBeenCalledOnce()
  })

  it('shows the procedural rig when the wait passes its budget, and still takes the mesh if it comes late', () => {
    const { root } = rig()
    const hold = holdRig('kart', [root])
    vi.advanceTimersByTime(LOAD_BUDGET_MS - 1)
    expect(root.visible).toBe(false)
    vi.advanceTimersByTime(1)
    expect(root.visible).toBe(true)
    expect(root.userData.prototype).toBe('procedural')
    const swap = vi.fn()
    hold.install(swap)
    expect(swap).toHaveBeenCalledOnce()
    expect(root.userData.prototype).toBe('blender')
    expect(root.visible).toBe(true)
  })

  it('waits on, once, for a mesh whose bytes are in and only its decoding is left', () => {
    stage.mockReturnValue('decoding')
    const { root } = rig()
    const hold = holdRig('helicopter', [root])
    vi.advanceTimersByTime(LOAD_BUDGET_MS)
    expect(root.visible).toBe(false)
    vi.advanceTimersByTime(2999)
    expect(root.visible).toBe(false)
    const swap = vi.fn()
    hold.install(swap)
    expect(swap).toHaveBeenCalledOnce()
    expect(root.userData.prototype).toBe('blender')
    const { root: slow } = rig()
    holdRig('helicopter', [slow])
    vi.advanceTimersByTime(LOAD_BUDGET_MS + 3000)
    expect(slow.visible).toBe(true)
    expect(slow.userData.prototype).toBe('procedural')
  })

  it('shows the procedural rig when the swap fails, and does nothing for a rig that has gone', () => {
    const a = rig(), b = rig(), shown = vi.fn()
    holdRig('plane', [a.root], { shown }).install(() => { throw new Error('missing pivot') })
    expect(a.root.visible).toBe(true)
    expect(shown).toHaveBeenCalledOnce()
    const gone = holdRig('tank', [b.root])
    gone.cancel()
    const swap = vi.fn()
    gone.install(swap)
    vi.advanceTimersByTime(LOAD_BUDGET_MS * 2)
    expect(swap).not.toHaveBeenCalled()
    expect(b.root.visible).toBe(false)
  })

  it('eases the rig in from a little smaller, and leaves its scale exactly as it was', () => {
    const frames: ((now: number) => void)[] = []
    let now = 1000
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    vi.stubGlobal('requestAnimationFrame', (f: (now: number) => void) => frames.push(f))
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const { root } = rig()
    root.scale.setScalar(0.5)
    holdRig('drone', [root]).install(() => {})
    expect(root.scale.x).toBeGreaterThan(0.4); expect(root.scale.x).toBeLessThan(0.5)
    now += 160; frames.shift()!(now)
    const half = root.scale.x
    expect(half).toBeGreaterThan(0.4); expect(half).toBeLessThan(0.5)
    now += 400; frames.shift()!(now)
    expect(root.scale.toArray()).toEqual([0.5, 0.5, 0.5])
    expect(frames).toHaveLength(0)
  })

  it('does not move at all for a visitor who asked for less motion', () => {
    vi.stubGlobal('location', { search: '' })
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    vi.stubGlobal('requestAnimationFrame', () => { throw new Error('no frames wanted') })
    const { root } = rig()
    holdRig('drone', [root]).install(() => {})
    expect(root.visible).toBe(true)
    expect(root.scale.toArray()).toEqual([1, 1, 1])
  })
})
