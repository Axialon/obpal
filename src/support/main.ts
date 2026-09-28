import { type Content, setMarkup, joinMarkup, html } from '../ui/markup'
import '../family'
import '../styles/base.css'
import '../styles/site.css'
import '../styles/support.css'
import { logo } from '../ui/icons'
import { applyTheme, initialTheme } from '../ui/themes'
import { mountTopBar } from '../landing/topbar'
import { mountQuick } from '../ui/quick'

/** Sponsor / donate for ob.Pal, on the shared Blackboxes contribution ledger (same API as the other engines). */
applyTheme(initialTheme())
mountTopBar()
mountQuick()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const page = document.body.dataset.page === 'donate' ? 'donate' : 'sponsor'
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 })

document.querySelectorAll<HTMLElement>('.logo').forEach((el) => { setMarkup(el, logo()) })

interface Config { checkoutReady: boolean; sponsorshipReady: boolean; sponsorPortalUrl: string | null; sponsorsUrl: string | null; sponsorsPending: boolean }
let config: Config | null = null
let mode: 'subscription' | 'payment' = page === 'donate' ? 'payment' : 'subscription'
let amount = page === 'donate' ? 25 : 10

const AMOUNTS = [5, 10, 25, 50, 100]
function renderAmounts() {
  const box = $('amounts')
  setMarkup(box, AMOUNTS.map((a) => html`<button class="amt" data-a="${a}" aria-pressed="${a === amount}">${usd(a)}</button>`))
  box.querySelectorAll<HTMLButtonElement>('.amt').forEach((b) => {
    b.onclick = () => { amount = Number(b.dataset.a); $<HTMLInputElement>('custom').value = ''; renderAmounts(); renderAction() }
  })
}

function renderMode() {
  document.querySelectorAll<HTMLButtonElement>('.mode-switch button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)))
  $('mode-note').textContent = mode === 'subscription' ? 'Billed monthly until cancelled.' : 'One payment, any amount from $1 to $10,000.'
  renderAction()
}

function renderAction() {
  const btn = $<HTMLButtonElement>('go')
  const monthly = mode === 'subscription'
  const ready = !!config && (monthly ? config.sponsorshipReady : config.checkoutReady)
  btn.disabled = !ready || !(amount >= 1 && amount <= 10000)
  btn.textContent = ready ? `${monthly ? 'Sponsor' : 'Donate'} ${usd(amount)}${monthly ? ' / month' : ''}` : config ? (monthly ? 'Monthly sponsorship unavailable' : 'Checkout unavailable') : 'Checking availability…'
  $('secure').textContent = monthly ? 'Secure checkout with Stripe · Cancel anytime' : 'Secure checkout with Stripe'
}

async function loadConfig() {
  try {
    const r = await fetch('/api/payments/config', { cache: 'no-store' })
    config = (await r.json()) as Config
  } catch {
    config = { checkoutReady: false, sponsorshipReady: false, sponsorPortalUrl: null, sponsorsUrl: null, sponsorsPending: false }
  }
  const links: Content[] = []
  if (config.sponsorPortalUrl) links.push(html`<a href="${config.sponsorPortalUrl}" rel="noopener">Manage a sponsorship</a>`)
  if (config.sponsorsUrl) links.push(html`<a href="${config.sponsorsUrl}" rel="noopener">GitHub Sponsors</a>`)
  else if (config.sponsorsPending) links.push(html`<span>GitHub Sponsors coming soon</span>`)
  setMarkup($('links'), joinMarkup(links, html`<i aria-hidden="true">·</i>`))
  renderAction()
}

async function loadLedger() {
  try {
    const r = await fetch('/api/donations/live', { cache: 'no-store' })
    const d = (await r.json()) as { status: string; totalUsd: number | null; backerCount: number | null; recent: { donorName?: string; amountUsd: number; timestamp: string }[] }
    if (d.status !== 'ok' || d.totalUsd == null) throw new Error('unavailable')
    $('raised').textContent = usd(d.totalUsd)
    $('backers').textContent = `${d.backerCount ?? 0} supporter${d.backerCount === 1 ? '' : 's'}`
    setMarkup($('recent'), d.recent.length
      ? d.recent.slice(0, 6).map((x) => html`<li><span>${x.donorName || 'Anonymous'}</span><b>${usd(Number(x.amountUsd))}</b></li>`)
      : html`<li class="empty">Be the first supporter.</li>`)
  } catch {
    $('raised').textContent = '—'
    $('raised-label').textContent = 'Ledger unavailable'
    $('recent').replaceChildren()
  }
}

async function checkout() {
  const btn = $<HTMLButtonElement>('go')
  btn.disabled = true
  btn.textContent = 'Opening Stripe…'
  $('status').textContent = ''
  const name = $<HTMLInputElement>('name').value.trim().slice(0, 60)
  const here = `${location.origin}${location.pathname}`
  try {
    const r = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, mode, donorName: name || undefined, publicName: $<HTMLInputElement>('public').checked, successUrl: `${here}?checkout=returned`, cancelUrl: `${here}?checkout=cancelled` }),
    })
    const d = await r.json()
    if (!r.ok || typeof d.checkoutUrl !== 'string') throw new Error(d.error || 'Checkout is currently unavailable.')
    location.href = d.checkoutUrl
  } catch (e) {
    $('status').textContent = (e as Error).message
    renderAction()
  }
}

// returning from Stripe
const back = new URLSearchParams(location.search).get('checkout')
if (back) {
  const banner = $('banner')
  banner.hidden = false
  banner.textContent = back === 'returned' ? 'Thank you. Check your Stripe receipt for confirmation.' : 'Checkout cancelled. Nothing was charged.'
  banner.dataset.kind = back
  history.replaceState(null, '', location.pathname)
}

document.querySelectorAll<HTMLButtonElement>('.mode-switch button').forEach((b) => {
  b.onclick = () => { mode = b.dataset.mode as typeof mode; renderMode() }
})
$<HTMLInputElement>('custom').oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value)
  if (v) { amount = Math.round(v * 100) / 100; renderAmounts(); renderAction() }
}
$('go').onclick = () => void checkout()
renderAmounts()
renderMode()
void loadConfig()
void loadLedger()
