/** One moving robot and a quiet eight-step rail, using the shared glass controls. */
import { ICONS } from '../../ui/icons'
import { setMarkup } from '../../ui/markup'
import { freshCalibration, RangeWalkthrough, type Calibration } from './calibration'
import type { RigProfile } from './profile'
import { RangeFigure } from './range-figure'

export class WalkthroughView {
  readonly dialog = document.createElement('dialog')
  private figure = new RangeFigure()
  private title = document.createElement('h2')
  private cue = document.createElement('p')
  private status = document.createElement('p')
  private steps = document.createElement('nav')
  private count = document.createElement('span')
  private done: HTMLButtonElement
  private tick = 0
  walk: RangeWalkthrough

  constructor(
    public profile: RigProfile,
    data: Calibration,
    private save: (data: Calibration, reset?: boolean) => void,
  ) {
    this.walk = new RangeWalkthrough(profile, data)
    const d = this.dialog
    d.className = 'hw glass humanoid-calibration'
    d.setAttribute('aria-labelledby', 'range-title')
    this.title.id = 'range-title'
    this.cue.className = 'range-cue'
    this.count.className = 'range-count'
    this.status.className = 'range-status'
    this.status.setAttribute('role', 'status')
    this.steps.className = 'range-steps'
    this.steps.setAttribute('aria-label', 'Range steps; select to redo')
    const header = document.createElement('header')
    header.className = 'range-header'
    const heading = document.createElement('div')
    heading.append(this.count, this.title)
    const actions = document.createElement('div')
    actions.className = 'range-actions'
    const button = (name: string, run: () => void, glyph?: keyof typeof ICONS) => {
      const b = document.createElement('button')
      b.className = glyph ? 'kit-icon-btn' : 'kit-action'
      b.type = 'button'
      b.setAttribute('aria-label', name)
      if (glyph) {
        setMarkup(b, ICONS[glyph])
        b.title = name
      } else b.textContent = name
      b.onclick = run
      return b
    }
    this.done = button('Done', () => {
      if (!this.walk.active) {
        d.close()
        return
      }
      if (this.walk.complete()) {
        this.save(this.walk.data)
        this.refresh()
      }
    })
    this.done.classList.add('kit-primary')
    const skip = button(
      'Skip',
      () => {
        this.walk.skip()
        this.refresh()
      },
      'skip',
    )
    const redo = button(
      'Redo',
      () => {
        this.walk.redo()
        this.save(this.walk.data)
        this.refresh()
      },
      'reset',
    )
    const reset = button('Reset calibration', () => {
      this.walk.data = freshCalibration(this.profile)
      this.walk.done.clear()
      this.walk.skipped.clear()
      this.walk.start()
      this.save(this.walk.data, true)
      this.refresh()
    })
    reset.className = 'range-reset'
    header.append(
      heading,
      button('Close', () => d.close(), 'close'),
    )
    actions.append(redo, skip, this.done)
    d.append(header, this.steps, this.cue, this.figure.el, this.status, actions, reset)
    document.body.append(d)
    d.addEventListener('close', () => {
      this.walk.active = false
      cancelAnimationFrame(this.tick)
    })
    this.refresh()
  }

  open(data: Calibration, profile = this.profile) {
    this.profile = profile
    this.walk = new RangeWalkthrough(profile, data)
    this.walk.start()
    this.dialog.showModal()
    this.figure.show(profile)
    this.refresh()
    this.draw(performance.now())
  }

  private refresh() {
    const { walk } = this
    this.title.textContent = walk.active ? walk.step.name : 'Range saved'
    this.count.textContent = walk.active ? `${String(walk.index + 1).padStart(2, '0')} / 08` : '08 / 08'
    this.cue.textContent = walk.active ? walk.step.cue : 'Ready to move your way'
    this.steps.replaceChildren(
      ...walk.steps.map((step, i) => {
        const b = document.createElement('button')
        b.type = 'button'
        const state = walk.done.has(step.id) ? 'done' : walk.skipped.has(step.id) ? 'skipped' : ''
        b.dataset.state = state
        b.setAttribute('aria-label', `${step.name}${state ? `: ${state}` : ''}`)
        b.setAttribute('aria-current', String(walk.active && i === walk.index))
        b.title = `${step.name}${state ? ` · ${state}` : ''}`
        b.onclick = () => {
          walk.redo(i)
          this.save(walk.data)
          this.refresh()
        }
        return b
      }),
    )
  }

  private draw = (now: number) => {
    if (!this.dialog.open) return
    const style = getComputedStyle(this.dialog)
    const accent = style.getPropertyValue('--bb-accent-text').trim() || '#c6ff34'
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    this.figure.draw(
      this.walk.active ? now : 0,
      this.walk.step,
      this.walk.progress,
      accent,
      reduced || !this.walk.active,
    )
    this.done.disabled = this.walk.active && this.walk.progress < 5 / 45
    const message = this.walk.active
      ? this.walk.progress
        ? `${Math.round(this.walk.progress * 100)}% · keep it comfortable`
        : 'Move comfortably in view'
      : 'Only ranges and lengths are saved on this device.'
    if (this.status.textContent !== message) this.status.textContent = message
    this.tick = requestAnimationFrame(this.draw)
  }
}
