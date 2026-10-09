import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handlePayment, stripeKey, type PaymentsEnv } from '../../worker/payments'

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

const origin = 'https://obpal.example'
const webhookSecret = 'synthetic-test-webhook-secret'
const portal = 'https://billing.stripe.com/p/login/testPortal'
const configured = (): PaymentsEnv => ({
  STRIPE_SECRET_KEY: 'sk_test_syntheticKey', STRIPE_WEBHOOK_SECRET: webhookSecret,
  CHECKOUT_RETURN_ORIGINS: origin, STRIPE_CONTRIBUTION_ORIGINS: 'https://legacy.example',
  STRIPE_SPONSORSHIP_ENABLED: 'true', STRIPE_SPONSOR_PORTAL_URL: portal,
})

/** Record D1 reads and bound batches without a live database. */
function ledger() {
  const prepared: { sql: string; values: unknown[] }[] = [], batches: typeof prepared[] = []
  const recent = [{ donorName: '<img src=x onerror=alert(1)>', amountUsd: 12.5, timestamp: '2026-10-01T00:00:00.000Z' }]
  const db = {
    prepare(sql: string) {
      const statement = {
        sql, values: [] as unknown[],
        bind(...values: unknown[]) { statement.values = values; return statement },
        async first() { return { total: 42.75, count: 2 } },
        async all() { return { results: recent } },
      }
      prepared.push(statement); return statement
    },
    async batch(statements: typeof prepared) { batches.push(statements); return [] },
  }
  return { db: db as unknown as PaymentsEnv['DB'], prepared, batches, recent }
}

/** Sign the exact raw JSON bytes with native Web Crypto, as historical Stripe delivery does. */
async function receipt(event: unknown, timestamp = Math.floor(Date.now() / 1000), secret = webhookSecret) {
  const raw = JSON.stringify(event), enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${raw}`)))].map(b => b.toString(16).padStart(2, '0')).join('')
  return new Request(origin + '/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` }, body: raw })
}

const paymentEvent = (type: string, source = 'https://legacy.example') => ({
  id: 'evt_historical', type, created: Math.floor(Date.now() / 1000),
  data: { object: { id: 'cs_historical', customer: 'cus_example', mode: 'payment', payment_status: 'paid', currency: 'usd', amount_total: 1250,
    metadata: { blackboxes_contribution: '1', source_origin: source, donor_name: 'Example supporter', public_name_consent: '1' } } },
})
const invoiceEvent = (source: string) => ({
  id: 'evt_invoice', type: 'invoice.payment_succeeded', created: Math.floor(Date.now() / 1000),
  data: { object: { id: 'in_historical', customer: 'cus_example', status: 'paid', currency: 'usd', amount_paid: 725,
    parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_historical', metadata: {
      blackboxes_contribution: '1', blackboxes_sponsorship: '1', source_origin: source, donor_name: 'Private example', public_name_consent: '0',
    } } } } },
})

describe('closed native checkout and historical settled records', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T00:00:00Z'))
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected provider call') }))
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('keeps both readiness flags false with a fully configured environment and preserves cancellation', async () => {
    const response = await handlePayment(new Request(origin + '/api/payments/config'), configured())
    expect(response?.status).toBe(200)
    expect(await response!.json()).toMatchObject({ status: 'unavailable', checkoutReady: false, sponsorshipReady: false, sponsorPortalUrl: portal })
    expect(fetch).not.toHaveBeenCalled()
  })
  for (const mode of ['payment', 'subscription']) it(`rejects valid ${mode} checkout before any provider call`, async () => {
    const response = await handlePayment(new Request(origin + '/api/checkout', { method: 'POST', body: JSON.stringify({ amount: 12.5, mode, donorName: 'Example', publicName: true, successUrl: origin + '/donate/?checkout=returned', cancelUrl: origin + '/donate/?checkout=cancelled' }) }), configured())
    expect(response?.status).toBe(503)
    expect(await response!.json()).toMatchObject({ status: 'error', error: 'Native checkout is unavailable. Open the support page for payment options.' })
    expect(fetch).not.toHaveBeenCalled()
  })
  for (const type of ['checkout.session.completed', 'checkout.session.async_payment_succeeded']) it(`retains a signed historical ${type} receipt`, async () => {
    const store = ledger(), event = paymentEvent(type)
    const response = await handlePayment(await receipt(event), { ...configured(), DB: store.db })
    expect(await response!.json()).toEqual({ status: 'recorded', eventId: event.id })
    expect(store.batches).toHaveLength(1)
    expect(store.batches[0].map(s => s.values)).toEqual([
      ['stripe:cus_example', 'Example supporter'], ['stripe:cs_historical', 'stripe:cus_example', 12.5, '2026-10-09T00:00:00.000Z'],
    ])
    expect(store.batches[0][1].sql).toContain("'stripe'")
    expect(store.batches[0].every(s => s.sql.startsWith('INSERT OR IGNORE'))).toBe(true)
  })
  for (const explicit of [true, false]) it(`accepts paid parent.subscription_details metadata with ${explicit ? 'explicit contribution' : 'return-origin fallback'} origins`, async () => {
    const store = ledger(), env = { ...configured(), DB: store.db, STRIPE_CONTRIBUTION_ORIGINS: explicit ? 'https://legacy.example' : undefined }
    const event = invoiceEvent(explicit ? 'https://legacy.example' : origin)
    const response = await handlePayment(await receipt(event), env)
    expect(await response!.json()).toEqual({ status: 'recorded', eventId: event.id })
    expect(store.batches[0].map(s => s.values)).toEqual([
      ['stripe:cus_example', 'Anonymous'], ['stripe:in_historical', 'stripe:cus_example', 7.25, '2026-10-09T00:00:00.000Z'],
    ])
    expect(store.batches[0][1].sql).toContain("'stripe_subscription'")
  })
  it('writes nothing for invalid raw signatures, expired signatures or foreign origins', async () => {
    const store = ledger(), env = { ...configured(), DB: store.db }, event = paymentEvent('checkout.session.completed')
    for (const request of [await receipt(event, undefined, 'wrong-secret'), await receipt(event, Math.floor(Date.now() / 1000) - 301), await receipt(paymentEvent('checkout.session.completed', 'https://foreign.example')), await receipt(invoiceEvent('https://foreign.example'))]) {
      const response = await handlePayment(request, env)
      expect([200, 401]).toContain(response?.status)
      expect((await response!.json() as { status: string }).status).not.toBe('recorded')
    }
    expect(store.prepared).toHaveLength(0); expect(store.batches).toHaveLength(0)
  })
  it('still returns the recorded total and recent settled rows', async () => {
    const store = ledger(), response = await handlePayment(new Request(origin + '/api/donations/live'), { ...configured(), DB: store.db })
    expect(await response!.json()).toEqual({ status: 'ok', totalUsd: 42.75, targetUsd: 2500, backerCount: 2, recent: store.recent })
    expect(store.prepared[0].sql).toContain('ORDER BY d.event_timestamp DESC LIMIT 15')
    expect(store.prepared[1].sql).toContain('COUNT(DISTINCT supporter_id)')
    expect(store.batches).toHaveLength(0)
  })
})
