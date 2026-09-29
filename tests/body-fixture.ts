import type { BodyState, Vec3 } from '@obpal/core'
import type { BodyResult } from '../src/controller/body-signal'

export const bodyState = (extra: Partial<BodyState> = {}): BodyState => ({
  flags: 1, seq: 0x1234, t: 0x12345678, gen: 9,
  landmarks: Array.from({ length: 33 }, (_, i): Vec3 => [Math.sin(i) * .2, Math.cos(i) * .8, i * -.003]),
  visibility: Array(33).fill(.8), presence: Array(33).fill(.9), ...extra,
})
export const bodyResult = (): BodyResult => ({
  worldLandmarks: [Array.from({ length: 33 }, (_, i) => ({ x: (i % 2 ? -1 : 1) * .2, y: (i - 23) * .04, z: -.1, visibility: .95 }))],
  landmarks: [Array.from({ length: 33 }, (_, i) => ({ x: i % 2 ? .4 : .6, y: .1 + i * .025, z: -.1, visibility: .95 }))],
})
