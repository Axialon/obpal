import type { ConnectionSeal } from '@obpal/core'
import { DotField, DotLoader, dotClock, type DotPoint } from './dot-field'
import { dotTimeline } from './dot-tokens'
import { destroySeal, sealElement, sealPoints } from './seal'

export interface SealPeer { id: string; name: string; seal: ConnectionSeal }

export const SEAL_SURFACE_STYLE = `
.seal-stage{position:relative;width:100%;height:100%;isolation:isolate;border-radius:16px;background:var(--seal-plate,var(--bb-sheet,var(--sheet,#141415)));color:var(--seal-ink,var(--bb-ink,var(--ink,#fff)));overflow:hidden}
.seal-stage .seal-plane{position:absolute;inset:0;transform-origin:50% 50%;will-change:transform}
.seal-stage .seal-qr{position:absolute;inset:0;display:grid;place-items:center;background:#fff;border-radius:inherit}
.seal-stage .seal-qr>svg{display:block;width:100%;height:100%}
.seal-stage .seal-qr:not([data-code]){background:var(--seal-plate,var(--bb-sheet,var(--sheet,#141415)))}
.seal-stage .seal-qr .dot-loader{color:var(--seal-ink,var(--bb-ink,var(--ink,#fff)))}
.seal-stage .dot-loader{position:absolute;left:50%;top:50%;translate:-50% -50%}
.seal-stage .seal-peers{position:absolute;inset:12px;display:grid;align-content:center;gap:8px;grid-template-columns:1fr}
.seal-stage[data-many] .seal-peers{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 6px;inset:8px}
.seal-stage[data-dense] .seal-peers{gap:4px 6px}.seal-stage[data-dense] .seal-peer>small{font-size:8px;line-height:1;margin-top:1px}
.seal-stage .seal-peer{display:grid;grid-template-columns:minmax(0,1fr);width:100%;justify-items:center;min-width:0;color:inherit;border:0;padding:0;background:none;cursor:pointer;font:500 10px/1.2 var(--font,system-ui)}
.seal-stage .connection-seal{grid-template-columns:minmax(0,1fr);width:100%;min-width:0;padding:0;background:var(--seal-plate,var(--bb-sheet,var(--sheet,#141415)));border-radius:6px}
.seal-stage .connection-seal canvas{width:100%;height:auto;aspect-ratio:35/11}
.seal-stage .seal-names{display:none}.seal-stage .seal-peer>small{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
.seal-stage .seal-flight{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.seal-stage[data-qr]{background:#fff}
.seal-stage[data-qr] .seal-flight{--seal-plate:#fff;--ob-dot-active:#14171c;--ob-dot-light:#14171c;--ob-dot-ink:#14171c;--ob-dot-muted:#14171c;--ob-dot-depth:#14171c}
.seal-action{display:grid;place-items:center;flex:none;width:44px;height:44px;border:0;background:transparent;color:var(--seal-ink,var(--bb-ink,var(--ink,#fff)));border-radius:50%;font:300 24px/1 system-ui;cursor:pointer}
.seal-stage>.seal-action{position:absolute;right:2px;bottom:2px;z-index:2;background:var(--seal-plate,var(--bb-sheet,var(--sheet,#141415)))}
.seal-action:focus-visible,.seal-stage .seal-peer:focus-visible{outline:2px solid currentColor;outline-offset:-3px}
.seal-stage[data-qr] .seal-action{background:#fff;color:#14171c}
.seal-action[hidden],.seal-stage [hidden]{display:none!important}
@media(prefers-reduced-motion:reduce){.seal-stage .seal-plane{transform:none!important;filter:none!important}}
`

/** The QR's footprint is also the resting connection surface. No pairing state removes it. */
export class SealSurface {
  readonly el = document.createElement('div')
  private plane = document.createElement('div')
  private qr = document.createElement('div')
  private peers = document.createElement('div')
  private flight = document.createElement('canvas')
  private action = document.createElement('button')
  private loader = new DotLoader({ size: 64, label: 'Making a pairing QR code' })
  private field: DotField
  private rows = new Map<string, { peer: SealPeer; button: HTMLButtonElement; seal: HTMLElement }>()
  private source: DotPoint[] = []
  private showingQr = true
  private adding = false
  private stop = () => {}
  private busy = false
  private motion = matchMedia('(prefers-reduced-motion: reduce)')
  private lastActivity = -Infinity
  private dead = false

  constructor(private readonly options: { add: () => void; compare: (id: string) => void }) {
    this.el.className = 'seal-stage'
    this.plane.className = 'seal-plane'
    this.qr.className = 'seal-qr'
    this.peers.className = 'seal-peers'
    this.flight.className = 'seal-flight'
    this.action.className = 'seal-action'
    this.action.type = 'button'
    this.flight.setAttribute('aria-hidden', 'true')
    this.qr.append(this.loader.el)
    this.plane.append(this.qr, this.peers, this.flight)
    this.el.append(this.plane, this.action)
    this.field = new DotField(this.flight, { points: [], preservePoints: true, scale: 'seal', surface: 'transparent', idle: false })
    this.action.onclick = () => this.adding ? this.cancel() : this.add()
    this.el.addEventListener('pointermove', event => {
      if (this.motion.matches || this.busy || this.showingQr) return
      const rect = this.el.getBoundingClientRect()
      this.plane.style.transform = `translate3d(${((event.clientX - rect.left) / rect.width - 0.5) * 3}px,${((event.clientY - rect.top) / rect.height - 0.5) * 2}px,0)`
    }, { passive: true })
    this.el.addEventListener('pointerleave', () => this.plane.style.removeProperty('transform'))
    this.el.addEventListener('pointerenter', () => this.shimmer())
    this.el.addEventListener('focusin', () => this.shimmer())
    this.motion.addEventListener('change', this.motionChanged)
    this.rest()
  }

  /** Mount beside the QR when the card has a footer, keeping every peer's glyphs unobstructed. */
  get addControl() { return this.action }

  /** An unavailable code is a static symbol, not work that appears to continue forever. */
  setPlaceholder(symbol: HTMLElement) {
    this.loader.finish(); this.source = []; this.qr.removeAttribute('data-code'); this.qr.replaceChildren(symbol)
  }
  /** Reuse the same loader when the service starts making a code again. */
  loading() { this.source = []; this.qr.removeAttribute('data-code'); this.qr.replaceChildren(this.loader.el); this.loader.start() }

  /** A scannable SVG stays still at rest; its own module centres become the moving source. */
  setQr(svg: SVGSVGElement, modules: DotPoint[]) {
    this.source = modules
    this.qr.setAttribute('data-code', '')
    this.loader.finish()
    this.qr.replaceChildren(svg)
    this.field.refresh()
    if (this.busy && this.showingQr) this.field.setSource(modules)
    // Keep QR arrival on its plate. Flights belong to authenticated pairing, not code creation.
  }

  sync(list: readonly SealPeer[]) {
    if (this.dead) return
    const leaving = [...this.rows.keys()].filter(id => !list.some(peer => peer.id === id))
    const old = leaving.length ? leaving.flatMap(id => this.points(id)) : this.points()
    for (const id of leaving) {
      const row = this.rows.get(id)!
      destroySeal(row.seal); row.button.remove(); this.rows.delete(id)
    }
    for (const peer of list) {
      let row = this.rows.get(peer.id)
      if (row?.seal.dataset.seal !== peer.seal.join('-')) {
        if (row) { destroySeal(row.seal); row.button.remove() }
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'seal-peer'; button.dataset.peer = peer.id
        button.setAttribute('aria-label', `${peer.name}. Compare connection seal`)
        const seal = sealElement(peer.seal)
        const name = document.createElement('small'); name.textContent = peer.name
        button.append(seal, name)
        button.onclick = () => this.options.compare(peer.id)
        row = { peer, button, seal }; this.rows.set(peer.id, row); this.peers.append(button)
      }
      row.peer = peer
    }
    this.el.toggleAttribute('data-many', list.length > 1)
    this.el.toggleAttribute('data-dense', list.length > 4)
    if (leaving.length && !list.length) {
      this.adding = false; this.showingQr = true
      this.field.setPoints(old); this.field.setSource(this.source)
      this.animate(performance.now(), true, () => this.rest())
    } else if (leaving.length) {
      const burst = old.filter((_, i) => i % 3 === 0)
      this.field.setPoints(burst); this.field.setSource([{ x: 0.9, y: 0.9 }])
      this.animate(performance.now(), true, () => this.rest(), 480, false)
    } else if (!this.busy) this.rest()
  }

  /** The caller's scheduled clock survives delayed delivery and rendering work. */
  reveal(id: string, delayMs: number) {
    const row = this.rows.get(id)
    if (!row) return
    const started = performance.now() + delayMs
    const timeline = dotTimeline(Date.now() + delayMs)
    const first = this.showingQr
    this.adding = false; this.showingQr = false
    this.field.setPoints(this.points(id))
    this.field.setSource(first ? this.source : Array.from({ length: 60 }, (_, i) => ({ x: 0.88 + Math.cos(i) * 0.035, y: 0.88 + Math.sin(i) * 0.035 })))
    row.button.style.visibility = 'hidden'
    this.flight.dataset.timeline = JSON.stringify(timeline)
    this.flight.dataset.started = String(started)
    this.animate(started, false, () => { row.button.style.removeProperty('visibility'); this.rest() }, 1200, first)
  }

  add() {
    if (!this.rows.size || this.adding) return
    this.options.add()
    this.adding = true; this.showingQr = true
    this.field.setPoints(this.points()); this.field.setSource(this.source)
    this.animate(performance.now(), true, () => this.rest())
  }
  cancel() {
    this.adding = false; this.showingQr = false
    this.field.setPoints(this.points()); this.field.setSource(this.source)
    this.animate(performance.now(), false, () => this.rest())
  }
  /** Opening an already connected surface shows its seal without replaying the handshake. */
  settle() { this.stop(); this.busy = false; this.showingQr = !this.rows.size; this.adding = false; this.rest() }
  /** Activity is a finite breath, not an idle claim that a silent link is sending input. */
  activity() {
    const now = performance.now()
    if (now - this.lastActivity < 700 || this.busy || this.showingQr || this.motion.matches) return
    this.lastActivity = now
    this.stop()
    this.plane.style.removeProperty('filter')
    this.stop = dotClock(t => {
      const p = Math.min(1, (t - now) / 640)
      this.plane.style.transform = `translate3d(0,${-Math.sin(p * Math.PI)}px,0)`
      if (p === 1) this.plane.style.removeProperty('transform')
      return p < 1
    })
  }
  private shimmer() {
    if (this.motion.matches || this.busy || this.showingQr) return
    const started = performance.now()
    this.stop()
    this.plane.style.removeProperty('transform')
    this.stop = dotClock(now => {
      const p = Math.min(1, (now - started) / 700)
      this.plane.style.filter = `brightness(${1 + Math.sin(p * Math.PI) * 0.12})`
      if (p === 1) this.plane.style.removeProperty('filter')
      return p < 1
    })
  }
  private points(id?: string): DotPoint[] {
    const rect = this.el.getBoundingClientRect()
    if (!rect.width || !rect.height) return []
    const hidden = this.peers.hidden
    this.peers.hidden = false
    const points = [...this.rows.values()].filter(row => !id || row.peer.id === id).flatMap(row => {
      const canvas = row.seal.querySelector('canvas')!.getBoundingClientRect()
      return sealPoints(row.peer.seal).map(point => ({ x: (canvas.left - rect.left + point.x * canvas.width) / rect.width, y: (canvas.top - rect.top + point.y * canvas.height) / rect.height }))
    })
    this.peers.hidden = hidden
    return points
  }
  private animate(started: number, reverse: boolean, done: () => void, duration = 1200, hidePeers = true) {
    this.stop(); this.busy = true
    this.plane.style.removeProperty('filter'); this.plane.style.removeProperty('transform')
    this.flight.hidden = false
    // Paint the source phase before hiding the QR; observers must not briefly draw the finished modules.
    this.field.handshake(reverse ? 1 : 0, true)
    this.qr.hidden = true; this.peers.hidden = hidePeers
    this.action.hidden = true
    const finish = () => { this.busy = false; this.flight.hidden = true; done() }
    delete this.flight.dataset.settled
    if (this.motion.matches || performance.now() - started >= duration) {
      this.flight.dataset.progress = '1.000'; this.flight.dataset.settled = ''
      this.field.handshake(reverse ? 0 : 1); finish(); return
    }
    this.stop = dotClock(now => {
      if (this.motion.matches || now - started >= duration) { this.flight.dataset.progress = '1.000'; this.flight.dataset.settled = ''; this.field.handshake(reverse ? 0 : 1); finish(); return false }
      const p = Math.max(0, Math.min(1, (now - started) / duration))
      this.flight.dataset.progress = p.toFixed(3)
      this.field.handshake(reverse ? 1 - p : p)
      return true
    })
  }
  private rest() {
    this.rows.forEach(row => row.button.style.removeProperty('visibility'))
    this.el.toggleAttribute('data-qr', this.showingQr)
    this.field.refresh()
    this.qr.hidden = !this.showingQr; this.peers.hidden = this.showingQr
    this.flight.hidden = true
    this.action.hidden = !this.rows.size
    this.action.textContent = this.adding ? '×' : '+'
    this.action.setAttribute('aria-label', this.adding ? 'Cancel adding a phone' : 'Add a phone')
  }
  private motionChanged = () => { this.plane.style.removeProperty('transform'); this.plane.style.removeProperty('filter') }
  destroy() { this.dead = true; this.stop(); this.loader.destroy(); this.field.destroy(); this.rows.forEach(row => destroySeal(row.seal)); this.motion.removeEventListener('change', this.motionChanged) }
}
