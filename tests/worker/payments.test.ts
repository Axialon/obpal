import { describe, expect, it } from 'vitest'
import { stripeKey } from '../../worker/payments'

const key = (v: string | undefined) => stripeKey({ STRIPE_SECRET_KEY: v } as Parameters<typeof stripeKey>[0])

describe('stripeKey', () => {
  it('accepts secret and restricted keys', () => {
    expect(key('rk_live_51AbC123')).toBe('rk_live_51AbC123')
    expect(key('sk_test_51AbC123')).toBe('sk_test_51AbC123')
  })
  it('tolerates paste slips', () => {
    expect(key('  rk_live_51AbC123\r\n')).toBe('rk_live_51AbC123')
    expect(key('"rk_live_51AbC123"')).toBe('rk_live_51AbC123')
    expect(key("'rk_live_51AbC123'")).toBe('rk_live_51AbC123')
    expect(key('STRIPE_SECRET_KEY=rk_live_51AbC123')).toBe('rk_live_51AbC123')
    expect(key('STRIPE_SECRET_KEY="rk_live_51AbC123"')).toBe('rk_live_51AbC123')
  })
  it('rejects placeholders and other key types', () => {
    for (const v of [undefined, '', 'unset', 'pk_live_51AbC123', 'whsec_51AbC123', 'rk_live_', '"rk_live_51AbC123', 'rk_live_51 AbC']) expect(key(v)).toBe('')
  })
})
