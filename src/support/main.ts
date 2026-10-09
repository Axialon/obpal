import { type Content, setMarkup, joinMarkup, html } from '../ui/markup'
import '../family'
import '../styles/base.css'
import '../styles/site.css'
import '../styles/support.css'
import { logo } from '../ui/icons'
import { applyTheme, initialTheme } from '../ui/themes'
import { mountTopBar } from '../landing/topbar'
import { mountQuick } from '../ui/quick'

/** Optional Ko-fi support and retained settled records from the shared BlackBoxes Stripe ledger. */
applyTheme(initialTheme())
mountTopBar()
mountQuick()
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n % 1 ? 2 : 0 })

document.querySelectorAll<HTMLElement>('.logo').forEach((el) => { setMarkup(el, logo()) })

interface Config { sponsorPortalUrl: string | null; sponsorsUrl: string | null; sponsorsPending: boolean }
async function loadConfig() {
  let config: Config
  try {
    const r = await fetch('/api/payments/config', { cache: 'no-store' })
    config = (await r.json()) as Config
  } catch {
    config = { sponsorPortalUrl: null, sponsorsUrl: null, sponsorsPending: false }
  }
  const links: Content[] = []
  if (config.sponsorPortalUrl) links.push(html`<a href="${config.sponsorPortalUrl}" rel="noopener">Manage a sponsorship</a>`)
  if (config.sponsorsUrl) links.push(html`<a href="${config.sponsorsUrl}" rel="noopener">GitHub Sponsors</a>`)
  else if (config.sponsorsPending) links.push(html`<span>GitHub Sponsors coming soon</span>`)
  setMarkup($('links'), joinMarkup(links, html`<i aria-hidden="true">·</i>`))
}

async function loadLedger() {
  try {
    const r = await fetch('/api/donations/live', { cache: 'no-store' })
    const d = (await r.json()) as { status: string; totalUsd: number | null; backerCount: number | null; recent: { donorName?: string; amountUsd: number; timestamp: string }[] }
    if (d.status !== 'ok' || d.totalUsd == null) throw new Error('unavailable')
    $('raised').textContent = usd(d.totalUsd)
    $('backers').textContent = `${d.backerCount ?? 0} recorded supporter${d.backerCount === 1 ? '' : 's'}`
    setMarkup($('recent'), d.recent.length
      ? d.recent.slice(0, 6).map((x) => html`<li><span>${x.donorName || 'Anonymous'}</span><b>${usd(Number(x.amountUsd))}</b></li>`)
      : html`<li class="empty">No recorded settled contributions.</li>`)
  } catch {
    $('raised').textContent = '—'
    $('raised-label').textContent = 'Ledger unavailable'
    $('recent').replaceChildren()
  }
}

// The documented Tip Panel is created only by this explicit action, once per page.
const open = $<HTMLButtonElement>('payment-options')
open.onclick = () => {
  const panel = $('payment-panel')
  if (!panel.firstElementChild) {
    const frame = document.createElement('iframe')
    frame.id = 'kofiframe'
    frame.title = 'Ko-fi payment options for ob.Pal'
    frame.height = '712'
    frame.style.cssText = 'border:none;width:100%;padding:4px;background:#f9f9f9;'
    frame.src = 'https://ko-fi.com/axialon01/?hidefeed=true&widget=true&embed=true&preview=true'
    panel.append(frame)
  }
  panel.hidden = false
  open.setAttribute('aria-expanded', 'true')
  $('payment-status').textContent = 'Ko-fi payment options are below. If they do not appear, use the hosted link.'
}

// Historical return links remain usable, but a URL cannot confirm a settled payment.
if (new URLSearchParams(location.search).has('checkout')) {
  const banner = $('banner')
  banner.hidden = false
  banner.textContent = 'A return link is not payment confirmation. Check your Ko-fi, PayPal or Stripe receipt.'
  history.replaceState(null, '', location.pathname + location.hash)
}

void loadConfig()
void loadLedger()
