import { describe, expect, it } from 'vitest'
import { heroFrame, heroPhases, heroPoints } from '../src/link/hero-points'

describe('Link hero composition', () => {
  it('keeps a bounded, deduplicated square grid and straight, evenly spaced routes', () => {
    const points = heroPoints()
    expect(points.length).toBeLessThan(300)
    expect(new Set(points.map(dot => `${dot.x},${dot.y}`)).size).toBe(points.length)
    expect(points.every(dot => dot.x % 12 === 0 && dot.y % 12 === 0)).toBe(true)
    for (const part of ['link', 'pc-link']) {
      const route = points.filter(dot => dot.part === part)
      expect(route.every(dot => dot.y === 108)).toBe(true)
      expect(route.slice(1).every((dot, i) => dot.x - route[i].x === 12)).toBe(true)
    }
  })
  it('never streams an unchosen PC branch and settles every finite phase', () => {
    const points = heroPoints()
    for (const state of ['idle', 'pairing', 'connected', 'dropped'] as const) {
      expect(heroPhases(state, false).some(phase => phase.part === 'pc-link')).toBe(false)
      for (const dot of points.filter(dot => dot.part === 'pc-link')) expect(heroFrame(dot, 'pc-link', 0.5, state, false).opacity).toBe(0)
      for (const phase of heroPhases(state, true)) {
        for (const dot of points) {
          const rest = heroFrame(dot, null, 1, state, true)
          expect(heroFrame(dot, phase.part, 1, state, true, 1, 1)).toEqual(rest)
          if (dot.part !== phase.part) expect(heroFrame(dot, phase.part, 0.5, state, true, 1, 1)).toEqual(rest)
        }
      }
    }
  })
  it('keeps dropped links in three resting samples and has distinct device effects', () => {
    const points = heroPoints()
    expect(points.filter(dot => dot.part === 'link' && heroFrame(dot, null, 1, 'dropped', false).opacity).length).toBe(3)
    for (const part of ['phone', 'browser', 'pc'] as const) {
      const samples = points.filter(dot => dot.part === part && dot.screen)
      expect(samples.some(dot => JSON.stringify(heroFrame(dot, part, 0.5, 'connected', true, 1, 0)) !== JSON.stringify(heroFrame(dot, null, 1, 'connected', true)))).toBe(true)
    }
  })
  it('caps phone tilt at three degrees and keeps its parallax inside six units', () => {
    const points = heroPoints().filter(dot => dot.part === 'phone')
    for (const phase of [.001, .999]) for (const dot of points) {
      const frame = heroFrame(dot, 'phone', phase, 'connected', true, 1, 1)
      expect(Math.hypot(frame.x - dot.x, frame.y - dot.y)).toBeLessThan(.001)
    }
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const phase of [0, .25, .5, .75, 1]) {
      const moved = points.map(dot => heroFrame(dot, 'phone', phase, 'connected', true, x, y))
      const mean = (axis: 'x' | 'y') => moved.reduce((sum, dot, i) => sum + dot[axis] - points[i][axis], 0) / points.length
      expect(Math.abs(mean('x'))).toBeLessThanOrEqual(6)
      expect(Math.abs(mean('y'))).toBeLessThanOrEqual(6)
      const angle = Math.atan2(moved[1].y - moved[0].y, moved[1].x - moved[0].x) - Math.atan2(points[1].y - points[0].y, points[1].x - points[0].x)
      expect(Math.abs(angle * 180 / Math.PI)).toBeLessThanOrEqual(3.00001)
    }
  })
})
