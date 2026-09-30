import { describe, expect, it } from 'vitest'
import { SceneWarmup } from '../src/sim/kit/warmup'

describe('the first scene reveal', () => {
  it('waits for the view and held meshes, even if the empty stage has rendered', () => {
    const warmup = new SceneWarmup()
    for (let i = 0; i < 20; i++) expect(warmup.frame(false, 5, 2)).toBe(false)
    expect(warmup.frame(true, 8, 4)).toBe(false)
    expect(warmup.frame(true, 8, 4)).toBe(false)
    expect(warmup.frame(true, 8, 4)).toBe(true)
  })
  it('starts its three stable renders again when a shader or texture arrives', () => {
    const warmup = new SceneWarmup()
    expect(warmup.frame(true, 5, 2)).toBe(false)
    expect(warmup.frame(true, 5, 2)).toBe(false)
    expect(warmup.frame(true, 6, 2)).toBe(false)
    expect(warmup.frame(true, 6, 3)).toBe(false)
    expect(warmup.frame(true, 6, 3)).toBe(false)
    expect(warmup.frame(true, 6, 3)).toBe(true)
  })
  it('never hides the scene again after the first reveal', () => {
    const warmup = new SceneWarmup()
    for (let i = 0; i < 3; i++) warmup.frame(true, 5, 2)
    expect(warmup.frame(false, 6, 3)).toBe(true)
  })
})
