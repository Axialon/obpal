import { describe, expect, it } from 'vitest'
import { checkProfile, PROFILES } from '../packages/core/src/catalogue'

const good = { id: 'my-crane', name: 'Crane', for: 'Lifting with a steady yoke', on: ['motion.point'], aim: { ...PROFILES.flight.aim }, steer: { ...PROFILES.flight.steer }, point: { ...PROFILES.flight.point } }

describe('checking a profile someone wrote (the catalogue builder, the SDK, an agent)', () => {
  it('takes a complete profile', () => {
    const r = checkProfile(good)
    expect(r.errors).toEqual([])
    expect(r.profile?.id).toBe('my-crane')
  })

  it('says what is wrong: a built-in id, a route the utility cannot take, a number out of range', () => {
    const r = checkProfile({ ...good, id: 'flight', steer: { ...good.steer, route: 'mouse' }, aim: { ...good.aim, gain: 9 } })
    expect(r.profile).toBeNull()
    expect(r.errors.join('\n')).toMatch(/built-in/)
    expect(r.errors.join('\n')).toMatch(/steer\.route/)
    expect(r.errors.join('\n')).toMatch(/aim\.gain/)
    expect(checkProfile(null).errors.length).toBeGreaterThan(3)
  })
})
