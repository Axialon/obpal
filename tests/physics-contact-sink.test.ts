/** Pinned Rapier 0.21 contact compliance at 240 Hz. Values are regression measurements, not acceptance gates. */
import { beforeAll, describe, expect, it } from 'vitest'
import R from '@dimforge/rapier3d-compat'
import { CONTACT_FEET, measureContactSink, predictedCornerMm, type ContactSinkOptions } from './physics-contact-sink-fixture'

beforeAll(async () => { await R.init() })

type Golden = readonly [mass: number, inertiaScale: number, offset: number, peakMm: number, endMm: number | 'topples']
const golden: Record<keyof typeof CONTACT_FEET, readonly Golden[]> = {
  keel: [
    [1.3, 1, 0, 4.680, 4.633], [1.3, 1, .5, 8.312, 7.309], [1.3, 1, .8, 9.337, 'topples'],
    [1.3, 2, 0, 2.749, 2.716], [1.3, 2, .5, 4.486, 4.161], [1.3, 2, .8, 5.421, 5.005],
    [1.3, 3, 0, 2.158, 2.071], [1.3, 3, .5, 3.334, 3.153], [1.3, 3, .8, 4.146, 3.801],
    [2.6, 1, 0, 2.360, 2.321], [2.6, 1, .5, 3.716, 3.508], [2.6, 1, .8, 4.674, 4.226],
    [2.6, 2, 0, 1.362, 1.354], [2.6, 2, .5, 2.069, 2.030], [2.6, 2, .8, 2.528, 2.435],
    [2.6, 3, 0, 1.037, 1.035], [2.6, 3, .5, 1.560, 1.546], [2.6, 3, .8, 1.888, 1.852],
  ],
  morrow: [
    [1.3, 1, 0, 4.830, 4.727], [1.3, 1, .5, 8.513, 7.494], [1.3, 1, .8, 9.319, 'topples'],
    [1.3, 2, 0, 2.753, 2.716], [1.3, 2, .5, 4.569, 4.183], [1.3, 2, .8, 5.414, 5.383],
    [1.3, 3, 0, 2.177, 2.072], [1.3, 3, .5, 3.388, 3.170], [1.3, 3, .8, 4.155, 3.824],
    [2.6, 1, 0, 2.370, 2.330], [2.6, 1, .5, 3.820, 3.537], [2.6, 1, .8, 4.682, 4.242],
    [2.6, 2, 0, 1.370, 1.355], [2.6, 2, .5, 2.100, 2.036], [2.6, 2, .8, 2.581, 2.446],
    [2.6, 3, 0, 1.040, 1.035], [2.6, 3, .5, 1.574, 1.549], [2.6, 3, .8, 1.906, 1.857],
  ],
}

for (const form of ['keel', 'morrow'] as const) describe(`${form} sole under a 0.8 m payload`, () => {
  for (const [mass, inertiaScale, offset, peakMm, endMm] of golden[form])
    it(`${mass} kg, inertia ×${inertiaScale}, COP ${offset}a: ${endMm === 'topples' ? 'topples' : `${endMm} mm settled sink`}`, () => {
      const options = { half: CONTACT_FEET[form], mass, inertiaScale, offset }, row = measureContactSink(options)
      expect(row.topples).toBe(endMm === 'topples')
      expect(Math.abs(row.peakMm - peakMm)).toBeLessThanOrEqual(.25)
      if (endMm !== 'topples') {
        expect(Math.abs(row.endMm - endMm)).toBeLessThanOrEqual(.25)
        if (inertiaScale === 3) expect(Math.abs(row.endMm - predictedCornerMm(options))).toBeLessThanOrEqual(.25)
      }
    })
})

describe('Rapier 0.21 integration setters', () => {
  const options: ContactSinkOptions = { half: CONTACT_FEET.keel, mass: 1.3, inertiaScale: 1, offset: 0 }
  const settings: NonNullable<ContactSinkOptions['settings']>[] = [
    { allowed: .00001 }, { allowed: .004 }, { prediction: .02 },
    { length: 10 }, { frequency: 2 },
  ]
  let baseline: ReturnType<typeof measureContactSink>
  beforeAll(() => { baseline = measureContactSink(options) })
  it('repeats every pose bit for bit with an identical fixed-tick trajectory', () => {
    expect(measureContactSink(options).trajectory.every((value, index) => value === baseline.trajectory[index])).toBe(true)
  })
  for (const setting of settings) it(`${JSON.stringify(setting)} leaves every sampled body pose unchanged`, () => {
    expect(measureContactSink({ ...options, settings: setting }).trajectory.every((value, index) => value === baseline.trajectory[index])).toBe(true)
  })
  for (const setting of [{ prediction: .0001 }, { length: .1 }]) it(`${JSON.stringify(setting)} changes contact activation, not contact stiffness`, () => {
    const row = measureContactSink({ ...options, settings: setting })
    expect(row.trajectory.some((value, index) => value !== baseline.trajectory[index])).toBe(true)
    expect(Math.abs(row.peakMm - 4.820)).toBeLessThanOrEqual(.25)
    expect(Math.abs(row.endMm - 4.693)).toBeLessThanOrEqual(.25)
  })
  it('a 2000 Hz contact frequency has only numerical-scale effects on this fixed-floor fixture', () => {
    const row = measureContactSink({ ...options, settings: { frequency: 2000 } })
    expect(Math.max(...row.trajectory.map((value, index) => Math.abs(value - baseline.trajectory[index])))).toBeLessThan(1e-6)
    expect(Math.abs(row.peakMm - baseline.peakMm)).toBeLessThan(.001)
  })
})
