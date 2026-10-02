import type { Remote } from '@obpal/host'
import { iconAction } from './kit/action'
import { fitControlInk } from './kit/ink'
import { dotLoading, dotState } from './kit/loading'
import '../styles/share.css'

/** One tabbed capability panel. URLs keep their key in the fragment, outside HTTP requests. */
export class SharePanel {
  readonly root = document.createElement('dialog')
  private tab: 'watch' | 'play' = 'watch'
  private qr = document.createElement('div')
  private link = document.createElement('a')
  private dots = document.createElement('div')
  private copy = document.createElement('p')
  private status = document.createElement('p')
  private actions = document.createElement('div')
  private tabs = new Map<string, HTMLButtonElement>()
  private qrRevision = 0
  constructor(private remote: Remote, private url: (capability: 'watch' | 'play') => string) {
    this.root.className = 'share-panel glass'; this.root.setAttribute('aria-label', 'Share this scene')
    const heading = document.createElement('header'), title = document.createElement('strong')
    title.textContent = 'Share'
    heading.append(title, this.button('close', 'Close sharing', () => this.close()))
    const tabs = document.createElement('div'); tabs.className = 'share-tabs'; tabs.setAttribute('role', 'tablist')
    for (const [key, text] of [['watch', 'Watch'], ['play', 'Play']] as const) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('role', 'tab'); b.onclick = () => { this.tab = key; this.render() }; tabs.append(b); this.tabs.set(key, b)
    }
    tabs.onkeydown = e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); this.tab = e.key === 'Home' ? 'watch' : e.key === 'End' ? 'play' : this.tab === 'watch' ? 'play' : 'watch'; this.render(); this.tabs.get(this.tab)?.focus() }
    this.qr.className = 'share-qr'; this.link.className = 'share-link'; this.link.target = '_blank'; this.link.rel = 'noopener'
    this.dots.className = 'share-dots'; this.dots.setAttribute('role', 'status')
    this.status.className = 'share-status'; this.status.setAttribute('role', 'status')
    this.actions.className = 'share-actions'
    this.actions.append(
      this.button('copy', 'Copy link', async () => { try { await navigator.clipboard.writeText(this.url(this.tab)); this.status.textContent = 'Link copied' } catch { this.status.textContent = 'Open the link to copy it' } }),
      this.button('share', 'Share link', async () => { const url = this.url(this.tab); if (navigator.share) { try { await navigator.share({ title: 'ob.Pal', url }) } catch { /* Sheet cancelled. */ } } else { try { await navigator.clipboard.writeText(url); this.status.textContent = 'Link copied' } catch { this.status.textContent = 'Open the link to copy it' } } }),
      this.button('stop', 'Stop sharing', async () => { await remote.stopSharing(this.tab); this.render() }),
      this.button('rotate', 'New link', async () => { await remote.newShareLink(this.tab); this.render() }),
    )
    const local = document.createElement('div'); local.className = 'share-local'
    for (const [label, mode] of [['Play on this phone', 'phone'], ['Play here', 'local']] as const) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => { dispatchEvent(new CustomEvent('obpal:localplay', { detail: mode })); this.close() }; local.append(b)
    }
    local.dataset.sharePlay = ''
    this.root.append(heading, tabs, this.qr, this.link, this.dots, this.actions, this.copy, local, this.status)
    document.body.append(this.root)
    fitControlInk(this.root)
    remote.on('join', () => this.render()); remote.on('leave', () => this.render()); remote.on('invite', () => this.render()); remote.on('role', () => this.render())
    this.root.addEventListener('click', e => { if (e.target === this.root) { const r = this.root.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) this.close() } })
    this.root.addEventListener('cancel', () => this.cancelQr())
    this.root.addEventListener('close', () => { if (!this.root.open) this.cancelQr() })
    this.render()
  }
  private button(glyph: string, label: string, action: () => void) { const b = document.createElement('button'); b.type = 'button'; iconAction(b, glyph, label); b.onclick = action; return b }
  private cancelQr() { ++this.qrRevision; dotLoading(this.qr, false) }
  private close() { this.cancelQr(); this.root.close() }
  open(tab: 'watch' | 'play' = 'watch') { if (document.body.classList.contains('stream-view')) return; this.tab = tab; if (!this.root.open) this.root.showModal(); this.render() }
  private render() {
    const open = this.remote.sharingOpen(this.tab), url = this.url(this.tab)
    for (const [key, b] of this.tabs) { b.setAttribute('aria-selected', String(key === this.tab)); b.tabIndex = key === this.tab ? 0 : -1 }
    const revision = ++this.qrRevision, label = `${this.tab === 'watch' ? 'Watch' : 'Play'} link`
    this.qr.replaceChildren()
    dotLoading(this.qr, this.root.open && open && !!url, 'Making a sharing QR code', 64)
    if (this.root.open && open && url) void import('../../packages/host/src/qr').then(({ brandedQrElement }) => {
      if (revision !== this.qrRevision) return
      dotLoading(this.qr, false); this.qr.replaceChildren(brandedQrElement(url, { label }))
    }).catch(() => { if (revision === this.qrRevision) dotState(this.qr, 'failed', 'Sharing QR unavailable; use the link below') })
    if (open) this.link.href = url; else this.link.removeAttribute('href')
    this.link.textContent = open ? url.replace(/^https?:\/\//, '') : 'Sharing stopped'; this.link.setAttribute('aria-label', open ? `Open ${this.tab} link` : 'Sharing stopped')
    const players = this.remote.participants.filter(p => p.role === 'play'), watchers = this.remote.participants.filter(p => p.role === 'watch')
    this.dots.replaceChildren(...[...players, ...watchers].map(p => { const d = document.createElement('i'); d.className = p.role === 'watch' ? 'watcher' : 'player'; d.style.setProperty('--dot', p.color); d.title = p.role === 'watch' ? 'Watching' : 'Playing'; return d }))
    this.dots.setAttribute('aria-label', `${players.length} players, ${watchers.length} watchers`)
    this.copy.textContent = this.tab === 'watch' ? 'Anyone with this link can watch until you stop sharing, or after an hour with nobody here.' : 'Anyone with this link can control. Share it only with players.'
    this.root.querySelector<HTMLElement>('[data-share-play]')!.hidden = this.tab !== 'play'
    this.actions.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = !open && b.getAttribute('aria-label') !== 'New link' })
  }
}
