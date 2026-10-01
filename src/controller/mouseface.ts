/**
 * Point's face for a PC (Layout.point 'mouse'): the top of a mouse, held like a remote. Left and Right are its two
 * halves, with a wheel in the seam between them (./wheel.ts): turn it to scroll, tap it for a middle click, hold it
 * still and aim the phone to scroll, like a mouse's autoscroll (B). Above: zoom out, centre, zoom in.
 *
 * On the wire: btn mouse-left / mouse-right down and up; value{mouse-wheel: units} (120 a notch, + scrolls down) as
 * the wheel turns; btn mouse-middle tap; wii-b down and up for the hold; wii-minus / wii-plus taps to zoom.
 */import { type Content, html } from '../ui/markup'

import type { DeviceMsg } from '@obpal/core'
import { ICONS } from '../ui/icons'
import { ScrollWheel } from './wheel'
import { bindPress, PressOwners } from './press'
import { toUi, uiRect } from './uiframe'

export interface MouseFaceDeps {
  send(m: DeviceMsg): void
  /** Feel it: a button pressed or let go, or a notch of the wheel. */
  feel(kind: 'press' | 'release' | 'notch'): void
  recenter(): void
}

export class MouseFace {
  private root: HTMLElement | null = null
  private wheel: ScrollWheel | null = null
  private down = new Set<'left' | 'right'>()
  private holding = false
  private presses = {
    left: new PressOwners(down => this.changeButton('left', down)),
    right: new PressOwners(down => this.changeButton('right', down)),
  }

  constructor(private readonly deps: MouseFaceDeps) {
    window.addEventListener('blur', () => this.reset())
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset() })
  }

  html(): Content {
    return html`
      <div class="mouse-top">
        <button class="mouse-round" id="mouse-zoom-out" aria-label="Zoom out">${ICONS['zoom-out']}</button>
        <button class="mouse-round home" id="mouse-home" aria-label="Centre the pointer">${ICONS.center}</button>
        <button class="mouse-round" id="mouse-zoom-in" aria-label="Zoom in">${ICONS['zoom-in']}</button>
        <button class="thumb-settings" aria-label="Settings" hidden>${ICONS.settings}</button>
      </div>
      <div class="mouse-shell">
        <button class="mouse-btn left" id="mouse-left" aria-label="Left click · hold and aim to drag">${ICONS['mouse-left']}</button>
        <div class="mouse-seam">
          <div class="mouse-wheel" id="mouse-wheel" role="button" aria-label="Scroll wheel · turn it to scroll, tap to middle-click, hold and aim to scroll"></div>
        </div>
        <button class="mouse-btn right" id="mouse-right" aria-label="Right click">${ICONS['mouse-right']}</button>
        <div class="mouse-auto" aria-hidden="true">${ICONS.autoscroll}<span>Aim to scroll</span></div>
      </div>`
  }

  bind(root: HTMLElement) {
    this.reset()
    this.wheel?.destroy()
    this.root = root
    const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!
    const tap = (id: string, send: string) => $(id).addEventListener('click', () => { this.deps.feel('press'); this.deps.send({ t: 'btn', id: send, ev: 'tap' }) })
    tap('mouse-zoom-out', 'wii-minus')
    tap('mouse-zoom-in', 'wii-plus')
    $('mouse-home').addEventListener('click', () => { this.deps.feel('press'); this.deps.recenter() })
    for (const side of ['left', 'right'] as const) {
      const el = $(`mouse-${side}`)
      bindPress(el, this.presses[side])
    }
    // The groove is decoration except for the wheel: its empty area belongs to the nearest half.
    const seam = root.querySelector<HTMLElement>('.mouse-seam')!
    const seamSide = new Map<number, 'left' | 'right'>()
    seam.addEventListener('pointerdown', e => {
      if ((e.target as Element).closest('#mouse-wheel')) return
      e.preventDefault()
      const r = uiRect(seam)
      const side = toUi(e.clientX, e.clientY).x < r.left + r.width / 2 ? 'left' : 'right'
      seamSide.set(e.pointerId, side)
      try { seam.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
      this.presses[side].set(e.pointerId, true)
    })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) seam.addEventListener(type, e => {
      const side = seamSide.get(e.pointerId)
      if (side) { this.presses[side].set(e.pointerId, false); seamSide.delete(e.pointerId) }
    })
    this.wheel = new ScrollWheel($('mouse-wheel'), {
      turn: (v) => this.deps.send({ t: 'value', id: 'mouse-wheel', v }),
      notch: () => this.deps.feel('notch'),
      tap: () => { this.deps.feel('press'); this.deps.send({ t: 'btn', id: 'mouse-middle', ev: 'tap' }) },
      hold: (down) => this.hold(down),
    })
  }

  /** Left or Right, pressed or let go (also from a hardware button). */
  button(side: 'left' | 'right', down: boolean) {
    this.presses[side].set('hardware', down)
  }

  private changeButton(side: 'left' | 'right', down: boolean) {
    if (down === this.down.has(side)) return
    if (down) this.down.add(side)
    else this.down.delete(side)
    this.root?.querySelector(`#mouse-${side}`)?.classList.toggle('down', down)
    this.deps.feel(down ? 'press' : 'release')
    this.deps.send({ t: 'btn', id: `mouse-${side}`, ev: down ? 'down' : 'up' })
  }

  /** Holding the wheel: aiming scrolls (also from a hardware button). */
  hold(down: boolean) {
    if (down === this.holding) return
    this.holding = down
    this.root?.querySelector('#mouse-wheel')?.classList.toggle('grab', down)
    this.root?.classList.toggle('autoscroll', down)
    this.deps.feel(down ? 'press' : 'release')
    this.deps.send({ t: 'btn', id: 'wii-b', ev: down ? 'down' : 'up' })
  }

  /** Let go of everything (the face was hidden, or the screen went away). */
  reset() {
    this.presses.left.reset()
    this.presses.right.reset()
    this.wheel?.reset()
    if (this.holding) this.hold(false)
  }
}
