import { afterEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { SceneDotLoader } from '../src/ui/kit/scene-loading'
import { dotLoaderClock } from '../src/ui/kit/dot-field'

vi.mock('../src/ui/kit/dot-field', async importOriginal => ({ ...await importOriginal<typeof import('../src/ui/kit/dot-field')>(), resolveDotTokens: () => ({ colors: { ink: '#ffffff' } }) }))

function environment(reduced = false) {
  const frames = new Map<number, FrameRequestCallback>(), doc = Object.assign(new EventTarget(), { hidden: false })
  const media = Object.assign(new EventTarget(), { matches: reduced })
  let id = 0, intersect = (_visible: boolean) => {}, disconnected = 0
  Object.assign(doc, { hidden: false, documentElement: {}, defaultView: {
    requestAnimationFrame: (frame: FrameRequestCallback) => { frames.set(++id, frame); return id },
    cancelAnimationFrame: (key: number) => frames.delete(key),
  } })
  vi.stubGlobal('document', doc); vi.stubGlobal('matchMedia', () => media)
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { intersect = visible => callback([{ isIntersecting: visible }]) }
    observe() {} disconnect() { disconnected++ }
  })
  for (const name of ['ResizeObserver', 'MutationObserver']) vi.stubGlobal(name, class { observe() {} disconnect() { disconnected++ } })
  return { frames, media, doc, intersect: (visible: boolean) => intersect(visible), disconnected: () => disconnected,
    step(now: number) { const pending = [...frames.values()]; frames.clear(); pending.forEach(frame => frame(now)) } }
}

afterEach(() => vi.unstubAllGlobals())

it('hands off its three instanced beads once and releases offscreen, settled and disposed work', () => {
  const e = environment(), scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(75)
  const loader = new SceneDotLoader({ clientHeight: 844 } as HTMLCanvasElement, scene, camera)
  expect(e.frames.size).toBe(0)
  loader.loading = true; loader.loading = true
  expect(loader.beads.count).toBe(3); expect(e.frames.size).toBe(1)
  e.step(1000)
  const frame = loader.beads.instanceMatrix.array.slice()
  e.intersect(false); expect(e.frames.size).toBe(0)
  e.intersect(true); e.step(1000)
  expect(loader.beads.instanceMatrix.array).toEqual(frame)
  const waiting = dotLoaderClock(() => true)
  loader.finish(); e.step(performance.now() + 121)
  expect(loader.beads.visible).toBe(false); expect(e.frames.size).toBe(1)
  waiting(); expect(e.frames.size).toBe(0)
  const geometry = vi.spyOn(loader.beads.geometry, 'dispose'), material = vi.spyOn(loader.beads.material as THREE.Material, 'dispose')
  loader.destroy()
  expect(scene.children).toEqual([]); expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce(); expect(e.disconnected()).toBe(3)
})

it('uses a static reduced frame and an immediate reduced-motion handoff', () => {
  const e = environment(true), scene = new THREE.Scene()
  const loader = new SceneDotLoader({ clientHeight: 844 } as HTMLCanvasElement, scene, new THREE.PerspectiveCamera(75))
  loader.loading = true
  expect(e.frames.size).toBe(0); expect(loader.beads.visible).toBe(true)
  loader.finish(); expect(loader.beads.visible).toBe(false); expect(e.frames.size).toBe(0)
  loader.destroy()
})

it.each(['reduced', 'offscreen', 'hidden'])('settles an outgoing handoff immediately when it becomes %s', state => {
  const e = environment(), loader = new SceneDotLoader({ clientHeight: 844 } as HTMLCanvasElement, new THREE.Scene(), new THREE.PerspectiveCamera(75))
  loader.loading = true; loader.finish()
  if (state === 'reduced') { e.media.matches = true; e.media.dispatchEvent(new Event('change')) }
  else if (state === 'offscreen') e.intersect(false)
  else { e.doc.hidden = true; e.doc.dispatchEvent(new Event('visibilitychange')) }
  expect(loader.beads.visible).toBe(false); expect(e.frames.size).toBe(0)
  loader.destroy()
})
