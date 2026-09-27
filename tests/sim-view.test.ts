import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { BUDGET, Governor, pickPixels, pixelLadder } from '../src/landing/governor'
import { changed, halton, jitterOf, signature, STILL_FRAMES } from '../src/sim/view'

describe("the sims' ladder: the screen's own pixels, or exactly twice them", () => {
  it('at 1x: twice the pixels each way, then the screen\'s own (no 1.5, which the browser would average unevenly)', () => {
    expect(pixelLadder(1, false).map((s) => s.pr)).toEqual([2, 1])
    expect(pixelLadder(1, false, { w: 1920, h: 1080 }).map((s) => s.pr)).toEqual([2, 1])
  })
  it('at 125% and 150%: twice the device pixels (2.5 and 3 CSS), where they fit the budget', () => {
    expect(pixelLadder(1.25, false, { w: 1536, h: 864 }).map((s) => s.pr)).toEqual([2.5, 1.25, 1])
    expect(pixelLadder(1.5, false, { w: 1280, h: 720 }).map((s) => s.pr)).toEqual([3, 1.5, 1.13, 1])
    // A big window at 150% has no room for twice: its own pixels at best.
    expect(pixelLadder(1.5, false, { w: 2560, h: 1400 }).map((s) => s.pr)).toEqual([1.5, 1.13, 1])
  })
  it('never draws more than BUDGET pixels, nor twice on a phone; never under the screen\'s own but for the last steps', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (const [w, h] of [[800, 600], [1280, 720], [1440, 900], [1920, 1080], [2560, 1440], [3840, 2160]]) {
        const l = pixelLadder(dpr, false, { w, h })
        const native = Math.min(dpr, 3)
        for (const s of l) if (s.pr > native) expect(w * h * s.pr ** 2).toBeLessThanOrEqual(BUDGET)
        expect(l.every((s, i) => i === 0 || s.pr < l[i - 1].pr)).toBe(true)
        expect(l.at(-1)!.pr).toBe(1)
      }
    }
    expect(pixelLadder(3, true, { w: 390, h: 844 }).map((s) => s.pr)).toEqual([2, 1.5, 1])
    expect(pixelLadder(2, true, { w: 390, h: 844 })[0].pr).toBe(2)
  })
  it('names its steps for ?quality=: super, native, low (or a number)', () => {
    const l = pixelLadder(1, false)
    expect(['super', 'native', 'low', '7', 'sharpest'].map((n) => pickPixels(l, n, 1, false))).toEqual([0, 1, 1, 1, -1])
    const d = pixelLadder(2, false, { w: 1440, h: 900 })
    expect(['super', 'native', 'low'].map((n) => pickPixels(d, n, 2, false))).toEqual([0, 0, 2])
  })
  it("started at the screen's own pixels, a fast GPU climbs to twice them; a slow one stays", () => {
    const l = pixelLadder(1, false, { w: 1920, h: 1080 })
    const fast = new Governor(l, { level: 1 })
    for (let i = 0; i < 200; i++) fast.frame(1 / 60, { ms: 0.8 * l[fast.level].pr ** 2, level: fast.level })
    expect(l[fast.level].pr).toBe(2)
    const slow = new Governor(l, { level: 1 })
    for (let i = 0; i < 200; i++) slow.frame(1 / 60, { ms: 3 * l[slow.level].pr ** 2, level: slow.level })
    expect(l[slow.level].pr).toBe(1)
  })
})

describe('the still picture', () => {
  it('averages frames shifted over the whole pixel evenly, the first one not shifted at all', () => {
    expect(jitterOf(0)).toEqual([0, 0])
    const js = Array.from({ length: STILL_FRAMES }, (_, k) => jitterOf(k))
    for (const [x, y] of js) { expect(Math.abs(x)).toBeLessThan(0.5); expect(Math.abs(y)).toBeLessThan(0.5) }
    // Centred on the pixel (no drift of the picture), and spread over it: every quarter of the pixel gets its share.
    const mean = js.reduce((m, [x, y]) => [m[0] + x / js.length, m[1] + y / js.length], [0, 0])
    expect(Math.abs(mean[0])).toBeLessThan(0.03)
    expect(Math.abs(mean[1])).toBeLessThan(0.03)
    for (const [sx, sy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const n = js.filter(([x, y]) => Math.sign(x || 1) === sx && Math.sign(y || 1) === sy).length
      expect(n).toBeGreaterThanOrEqual(STILL_FRAMES / 4 - 2)
    }
    expect(halton(1, 2)).toBe(0.5)
    expect(halton(3, 3)).toBeCloseTo(1 / 9, 12)
  })

  it('knows still from moving: the camera, an object moved or turned, shown or hidden, or its colour, but not a hair\'s change', () => {
    const scene = new THREE.Scene()
    scene.background = new THREE.Color('#07090d')
    const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: '#c9d1dc' }))
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.1), new THREE.MeshStandardMaterial({ emissive: '#5b6472', emissiveIntensity: 0.25 }))
    scene.add(box, ring)
    const camera = new THREE.PerspectiveCamera(42, 1.6, 0.05, 60)
    camera.position.set(2, 2, 3)
    camera.lookAt(0, 0, 0)
    const at = () => [...signature(scene, camera)]
    const a = at()
    expect(changed(at(), a, 1e-5)).toBe(false)
    const tries: [string, () => void, () => void][] = [
      ['the camera', () => camera.position.x += 0.01, () => camera.position.x -= 0.01],
      ['a move', () => box.position.y += 0.01, () => box.position.y -= 0.01],
      ['a turn', () => box.rotation.y += 0.01, () => box.rotation.y -= 0.01],
      ['hidden', () => ring.visible = false, () => ring.visible = true],
      ['a glow', () => (ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.4, () => (ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.25],
      ['a colour', () => (box.material as THREE.MeshStandardMaterial).color.set('#ff0000'), () => (box.material as THREE.MeshStandardMaterial).color.set('#c9d1dc')],
      ['the view', () => camera.setViewOffset(160, 100, 3, 0, 160, 100), () => { camera.clearViewOffset(); camera.aspect = 1.6; camera.updateProjectionMatrix() }],
    ]
    for (const [what, go, back] of tries) {
      go()
      expect(changed(at(), a, 1e-5), what).toBe(true)
      back()
      expect(changed(at(), a, 1e-5), `${what} undone`).toBe(false)
    }
    // A camera still settling (a millionth of a metre a frame) is still.
    camera.position.x += 1e-6
    expect(changed(at(), a, 1e-5)).toBe(false)
  })
})
