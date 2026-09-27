/**
 * Giving back (the donate page only): the open-source work ob.Pal is built on, how much we rely on each, and a way to
 * give the same again to them, split by that share. Each gift goes straight to the project's own page.
 */
import data from './open-source.json'
import { split } from './share'

interface Upstream { name: string; by: string; what: string; license: string; share: number; url: string; give: string }
const upstream = data.upstream as Upstream[]
const total = upstream.reduce((s, u) => s + u.share, 0)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const usd = (n: number) => `$${n < 100 ? n.toFixed(2).replace(/\.00$/, '') : Math.round(n).toLocaleString('en-US')}`

/** GitHub Sponsors takes whole dollars (from $1); Open Collective takes cents. */
const onGitHub = (u: Upstream) => new URL(u.give).hostname === 'github.com'
const payable = (u: Upstream, amount: number) => (onGitHub(u) ? Math.max(1, Math.round(amount)) : amount)

/** The project's own page, with the amount filled in where the platform takes one. */
function giveUrl(u: Upstream, amount: number) {
  const url = new URL(u.give)
  if (url.hostname === 'opencollective.com') { url.pathname = `${url.pathname.replace(/\/$/, '')}/donate`; url.searchParams.set('amount', String(amount)); url.searchParams.set('interval', 'oneTime') }
  else if (onGitHub(u)) { url.searchParams.set('frequency', 'one-time'); url.searchParams.set('amount', String(payable(u, amount))) }
  return url.toString()
}

const root = $('giveback')
if (root) {
  let amount = 25
  let followed = true
  const input = $<HTMLInputElement>('gb-amount')
  const render = () => {
    const parts = split(amount, upstream.map((u) => u.share))
    $('gb-list').innerHTML = upstream.map((u, i) => `
      <li>
        <span class="gb-bar" style="--w:${((u.share / total) * 100).toFixed(1)}%"></span>
        <div class="gb-row">
          <span class="gb-name"><a href="${esc(u.url)}" rel="noopener">${esc(u.name)}</a><small>${esc(u.what)} · ${esc(u.by)} · ${esc(u.license)}</small></span>
          <span class="gb-share">${Math.round((u.share / total) * 100)}%</span>
          <a class="gb-give" href="${esc(giveUrl(u, parts[i]))}" target="_blank" rel="noopener">Give ${usd(payable(u, parts[i]))}</a>
        </div>
      </li>`).join('')
    $('gb-thanks').innerHTML = (data.thanks as { name: string; by: string; what: string }[]).map((t) => `<li><b>${esc(t.name)}</b> <span>${esc(t.by)}: ${esc(t.what)}</span></li>`).join('')
  }
  const setAmount = (n: number) => {
    if (!(n >= 1 && n <= 10000)) return
    amount = n
    input.value = String(n)
    render()
  }
  input.addEventListener('input', () => { followed = false; const n = Number(input.value); if (n >= 1 && n <= 10000) { amount = n; render() } })
  // An equivalent share: until edited here, the split follows the amount chosen above.
  $('amounts')?.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.amt'); if (b && followed) setAmount(Number(b.dataset.a)) })
  $('custom')?.addEventListener('input', (e) => { const n = Number((e.target as HTMLInputElement).value); if (followed) setAmount(n) })
  setAmount(amount)
}
