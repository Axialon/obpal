import { afterEach, describe, expect, it, vi } from 'vitest'
import { phoneCamera } from '../src/ui/camera'

vi.mock('../src/ui/camera-worker', () => ({ cameraWorker: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

describe('the site’s phone action', () => {
  it.each([
    ['iOS upright', true, 390, 844, true],
    ['iOS sideways', true, 844, 390, true],
    ['Android', true, 412, 915, true],
    ['desktop', false, 1280, 800, false],
    ['narrow desktop window', false, 390, 844, false],
    ['tablet screen', true, 1024, 768, false],
  ])('%s uses the appropriate side of pairing', (_, coarse, width, height, scan) => {
    vi.stubGlobal('matchMedia', () => ({ matches: coarse }))
    vi.stubGlobal('screen', { width, height })
    expect(phoneCamera()).toBe(scan)
  })
})
