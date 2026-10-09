/**
 * Sponsor and donate for ob.Pal: a port of the Blackboxes shared payments contract (BlackBoxes/shared/payments.js).
 * Same routes, validation, Stripe Checkout usage and shared D1 contribution ledger as Box'em / Orbit'em,
 * with ob.Pal product names and project tagging. Only signed, settled Stripe events reach the ledger.
 */
export interface PaymentsEnv {
  DB?: D1Database
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  SPONSORS_WEBHOOK_SECRET?: string
  CHECKOUT_RETURN_ORIGINS?: string
  STRIPE_CONTRIBUTION_ORIGINS?: string
  STRIPE_SPONSOR_PORTAL_URL?: string
  STRIPE_SPONSORSHIP_ENABLED?: string
  GITHUB_SPONSORS_URL?: string
  GITHUB_SPONSORS_PENDING?: string
}

const PROJECT = 'obpal'
const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE })
const error = (message: string, status = 400) => json({ status: 'error', error: message }, status)

class HttpError extends Error { constructor(message: string, public status: number) { super(message) } }

async function rawBody(r: Request | Response, limit = 65536): Promise<string> {
  const text = await r.text()
  if (text.length > limit) throw new HttpError('Request body too large', 413)
  return text
}
function parseObject(raw: string): Record<string, any> {
  const v = JSON.parse(raw || '{}')
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError('Expected a JSON object', 400)
  return v
}

async function verifyHmacSha256(payload: string, signature: string | null, secret: string | undefined) {
  if (!secret || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const sig = Uint8Array.from(signature!.slice(7).match(/../g)!, (b) => parseInt(b, 16))
  return crypto.subtle.verify('HMAC', key, sig, enc.encode(payload))
}
async function verifyStripe(payload: string, header: string | null, secret: string | undefined, now = Date.now()) {
  if (!header || !secret) return false
  const fields = header.split(',').map((s) => s.trim().split('='))
  const timestamp = fields.find(([k]) => k === 't')?.[1]
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false
  for (const [key, sig] of fields) if (key === 'v1' && (await verifyHmacSha256(`${timestamp}.${payload}`, `sha256=${sig}`, secret))) return true
  return false
}
export function amountCents(amount: unknown): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 1 || amount > 10000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    throw new HttpError('Amount must be a number from 1 to 10000 USD with at most two decimal places', 400)
  }
  return Math.round(amount * 100)
}
function safeUrl(value: string | undefined, host: string, path: RegExp) {
  if (!value?.trim()) return null
  try {
    const u = new URL(value)
    if (u.protocol !== 'https:' || u.hostname !== host || u.port || u.username || u.password || u.search || u.hash || !path.test(u.pathname)) return null
    return u.href
  } catch { return null }
}
const sponsorsUrl = (v?: string) => safeUrl(v, 'github.com', /^\/sponsors\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/?$/)
const portalUrl = (v?: string) => safeUrl(v, 'billing.stripe.com', /^\/p\/login\/[a-zA-Z0-9_]+\/?$/)
const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const allowedOrigins = (env: PaymentsEnv) => list(env.CHECKOUT_RETURN_ORIGINS)
const contributionOrigins = (env: PaymentsEnv) => (env.STRIPE_CONTRIBUTION_ORIGINS?.trim() ? list(env.STRIPE_CONTRIBUTION_ORIGINS) : allowedOrigins(env))
// The Stripe key, tolerating common paste slips (surrounding quotes, a leading NAME=, whitespace). Anything that
// still isn't a secret or restricted key (a placeholder, a publishable key) reads as not configured.
export const stripeKey = (env: PaymentsEnv) => {
  let v = (env.STRIPE_SECRET_KEY ?? '').trim().replace(/^STRIPE_SECRET_KEY\s*=\s*/, '').trim()
  const q = v[0]
  if (v.length > 1 && (q === '"' || q === "'" || q === '`') && v.endsWith(q)) v = v.slice(1, -1).trim()
  return /^(sk|rk)_(live|test)_[A-Za-z0-9]+$/.test(v) ? v : ''
}
// New native checkout stays closed; historical signed receipts and the portal remain independent.
const NATIVE_CHECKOUT_ENABLED = false
const checkoutReady = (env: PaymentsEnv, origin: string) => NATIVE_CHECKOUT_ENABLED && !!stripeKey(env) && allowedOrigins(env).includes(origin)
const sponsorshipReady = (env: PaymentsEnv, origin: string) =>
  checkoutReady(env, origin) && !!portalUrl(env.STRIPE_SPONSOR_PORTAL_URL) && (env.STRIPE_SPONSORSHIP_ENABLED === 'true' || !!env.STRIPE_WEBHOOK_SECRET)
const unavailable = () => json({ status: 'unavailable', totalUsd: null, targetUsd: 2500, backerCount: null, recent: [], message: 'Verified donation data is unavailable.' }, 503)

export const PAYMENT_ROUTES = ['/api/payments/config', '/api/donations/live', '/api/checkout', '/api/donate', '/api/webhooks/stripe', '/api/webhooks/sponsors']

export async function handlePayment(request: Request, env: PaymentsEnv): Promise<Response | null> {
  const url = new URL(request.url)
  const route = url.pathname
  const origin = url.origin
  try {
    if (route === '/api/payments/config') {
      if (request.method !== 'GET') return error('Method not allowed', 405)
      const ready = checkoutReady(env, origin)
      const sponsors = sponsorsUrl(env.GITHUB_SPONSORS_URL)
      return json({
        status: ready ? 'ready' : 'unavailable', checkoutReady: ready, sponsorshipReady: sponsorshipReady(env, origin),
        currency: 'USD', minimumAmount: 1, maximumAmount: 10000, sponsorsUrl: sponsors,
        sponsorsPending: !sponsors && env.GITHUB_SPONSORS_PENDING === 'true', sponsorPortalUrl: portalUrl(env.STRIPE_SPONSOR_PORTAL_URL),
      })
    }
    if (route === '/api/donations/live') {
      if (request.method !== 'GET') return error('Method not allowed', 405)
      if (!env.DB) return unavailable()
      try {
        const rows = await env.DB.prepare('SELECT d.id, s.donor_name AS donorName, d.amount_usd AS amountUsd, d.event_timestamp AS timestamp FROM donation_events d LEFT JOIN supporters s ON s.id = d.supporter_id ORDER BY d.event_timestamp DESC LIMIT 15').all()
        const sum = await env.DB.prepare('SELECT COALESCE(SUM(amount_usd), 0) AS total, COUNT(DISTINCT supporter_id) AS count FROM donation_events').first<{ total: number; count: number }>()
        if (!sum || !Number.isFinite(Number(sum.total)) || !Number.isInteger(Number(sum.count))) return unavailable()
        return json({ status: 'ok', totalUsd: Number(sum.total), targetUsd: 2500, backerCount: Number(sum.count), recent: rows.results || [] })
      } catch { return unavailable() }
    }
    if (!PAYMENT_ROUTES.includes(route)) return null
    if (request.method !== 'POST') return error('Method not allowed', 405)
    if (route === '/api/donate') return error('Direct donation claims are not accepted. Use a configured checkout provider.', 503)
    const raw = await rawBody(request)

    if (route === '/api/checkout') {
      const data = parseObject(raw)
      const cents = amountCents(data.amount)
      const mode = data.mode === undefined ? 'payment' : data.mode
      if (!['payment', 'subscription'].includes(mode)) return error('Invalid checkout mode')
      if (data.donorName !== undefined && (typeof data.donorName !== 'string' || data.donorName.length > 60)) return error('Invalid donor name')
      if (data.publicName !== undefined && typeof data.publicName !== 'boolean') return error('Invalid public name consent')
      for (const value of [data.successUrl, data.cancelUrl].filter((v) => v !== undefined)) {
        if (typeof value !== 'string') return error('Invalid return URL')
        const u = new URL(value)
        if (u.origin !== origin || u.username || u.password) return error('Return URLs must use this application origin')
      }
      if (!checkoutReady(env, origin)) return error('Native checkout is unavailable. Open the support page for payment options.', 503)
      const recurring = mode === 'subscription'
      if (recurring && !sponsorshipReady(env, origin)) return error('Sponsorship is unavailable until Stripe webhooks and the cancellation portal are configured.', 503)
      const name: string = data.donorName || 'Anonymous'
      const publicName = data.publicName === true
      const ledgerName = data.publicName === false ? 'Anonymous' : name
      const p = new URLSearchParams({
        mode,
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(cents),
        'line_items[0][price_data][product_data][name]': recurring ? 'ob.Pal monthly sponsorship' : 'ob.Pal voluntary contribution',
        'line_items[0][quantity]': '1',
        success_url: data.successUrl || `${origin}/sponsor/?checkout=returned`,
        cancel_url: data.cancelUrl || `${origin}/sponsor/?checkout=cancelled`,
        'metadata[donor_name]': ledgerName,
        'metadata[blackboxes_contribution]': '1',
        'metadata[blackboxes_project]': PROJECT,
        'metadata[source_origin]': origin,
      })
      if (recurring) p.set('line_items[0][price_data][recurring][interval]', 'month')
      if (data.publicName !== undefined) p.set('metadata[public_name_consent]', publicName ? '1' : '0')
      if (recurring) {
        p.set('metadata[blackboxes_sponsorship]', '1')
        p.set('subscription_data[metadata][blackboxes_contribution]', '1')
        p.set('subscription_data[metadata][blackboxes_sponsorship]', '1')
        p.set('subscription_data[metadata][blackboxes_project]', PROJECT)
        p.set('subscription_data[metadata][source_origin]', origin)
        p.set('subscription_data[metadata][donor_name]', publicName ? name : 'Anonymous')
        p.set('subscription_data[metadata][public_name_consent]', publicName ? '1' : '0')
      }
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${stripeKey(env)}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: p,
        signal: AbortSignal.timeout(10000),
      })
      const session = parseObject(await rawBody(res))
      if (!res.ok || typeof session.id !== 'string' || typeof session.url !== 'string' || !/^https:\/\/checkout\.stripe\.com\//.test(session.url)) {
        return error('Payment provider did not create a valid checkout session', 502)
      }
      return json({ status: 'checkout_created', checkoutUrl: session.url, sessionId: session.id })
    }

    const stripe = route.endsWith('/stripe')
    const secret = stripe ? env.STRIPE_WEBHOOK_SECRET : env.SPONSORS_WEBHOOK_SECRET
    if (!secret) return error('Webhook is not configured', 503)
    const valid = stripe ? await verifyStripe(raw, request.headers.get('stripe-signature'), secret) : await verifyHmacSha256(raw, request.headers.get('x-hub-signature-256'), secret)
    if (!valid) return error('Invalid webhook signature', 401)
    const event = parseObject(raw)
    if (!stripe) return json({ status: 'ignored', reason: 'Sponsorship lifecycle events are not payment receipts.' })

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data?.object
      const details = invoice?.parent?.type === 'subscription_details' ? invoice.parent.subscription_details : null
      const md = details?.metadata
      if (!invoice || invoice.status !== 'paid' || md?.blackboxes_contribution !== '1' || md?.blackboxes_sponsorship !== '1') return json({ status: 'ignored', reason: 'No settled sponsorship invoice' })
      if (!/^evt_\w+$/.test(event.id || '') || !/^in_\w+$/.test(invoice.id || '') || !/^cus_\w+$/.test(invoice.customer || '') || !/^sub_\w+$/.test(details.subscription || '') || !Number.isSafeInteger(event.created)) return error('Invalid sponsorship invoice')
      if (invoice.currency !== 'usd' || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < 100 || invoice.amount_paid > 1000000 || !contributionOrigins(env).includes(md.source_origin)) {
        return json({ status: 'ignored', reason: 'Sponsorship invoice is outside this project' })
      }
      if (!env.DB) return error('Payment storage unavailable', 503)
      const supporter = `stripe:${invoice.customer}`
      const name = md.public_name_consent === '1' && typeof md.donor_name === 'string' ? md.donor_name.slice(0, 60) : 'Anonymous'
      try {
        await env.DB.batch([
          env.DB.prepare('INSERT OR IGNORE INTO supporters (id, donor_name) VALUES (?, ?)').bind(supporter, name),
          env.DB.prepare("INSERT OR IGNORE INTO donation_events (id, supporter_id, platform, amount_usd, event_timestamp, unlocked_theme) VALUES (?, ?, 'stripe_subscription', ?, ?, NULL)").bind(`stripe:${invoice.id}`, supporter, invoice.amount_paid / 100, new Date(event.created * 1000).toISOString()),
        ])
      } catch { return error('Payment storage unavailable; retry delivery', 503) }
      return json({ status: 'recorded', eventId: event.id })
    }

    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) return json({ status: 'ignored' })
    const session = event.data?.object
    if (!session || session.payment_status !== 'paid' || session.mode !== 'payment') return json({ status: 'ignored', reason: 'No settled one-time payment' })
    if (session.metadata?.blackboxes_contribution !== '1') return json({ status: 'ignored', reason: 'Not a contribution' })
    if (!contributionOrigins(env).includes(session.metadata?.source_origin)) return json({ status: 'ignored', reason: 'Contribution belongs to another project' })
    if (!/^evt_\w+$/.test(event.id || '') || !/^cs_\w+$/.test(session.id || '') || session.currency !== 'usd' || !Number.isSafeInteger(session.amount_total) || session.amount_total < 100 || session.amount_total > 1000000 || !Number.isSafeInteger(event.created)) {
      return error('Invalid payment event')
    }
    if (!env.DB) return error('Payment storage unavailable', 503)
    const supporter = typeof session.customer === 'string' ? `stripe:${session.customer}` : `stripe:${session.id}`
    const name = session.metadata?.public_name_consent === '0' ? 'Anonymous' : typeof session.metadata?.donor_name === 'string' ? session.metadata.donor_name.slice(0, 60) : 'Anonymous'
    try {
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO supporters (id, donor_name) VALUES (?, ?)').bind(supporter, name),
        env.DB.prepare("INSERT OR IGNORE INTO donation_events (id, supporter_id, platform, amount_usd, event_timestamp, unlocked_theme) VALUES (?, ?, 'stripe', ?, ?, NULL)").bind(`stripe:${session.id}`, supporter, session.amount_total / 100, new Date(event.created * 1000).toISOString()),
      ])
    } catch { return error('Payment storage unavailable; retry delivery', 503) }
    return json({ status: 'recorded', eventId: event.id })
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 400
    return error(status === 413 ? (err as Error).message : err instanceof HttpError ? err.message : 'Invalid request or unavailable provider', status)
  }
}
