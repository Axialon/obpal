/**
 * Physical buttons on the controller (CATALOGUE §1 and §3; spec/RESEARCH-BUTTONS.md, "Bindings"):
 *  - what each input presses now, through the layers: the controller's defaults, the smart defaults of the devices the
 *    phone has recognised, the host's suggestion, the profile's, and the person's own, which always win;
 *  - smart use with no setup: the first input from a source this session tells what kind of device it is (a clicker, a
 *    selfie remote, a pad, a headset, a keyboard), its smart defaults for this controller apply at once, and a notice
 *    says what it now does, with Change;
 *  - an unbound input from a device already recognised offers a one-tap bind;
 *  - the Buttons sheet (Settings → Buttons): press a control then a button to bind it, or press a button to find what
 *    it does; every input the phone can hear is listed there too; undo, reset, and one honest line per source;
 *  - badges on bound controls.
 * The person's own changes are kept per profile and controller in `obpal.buttons.<profile id>`, and the smart defaults
 * per kind and controller beside them, in `obpal.buttons.smart`.
 */
import { type Content, html, setMarkup } from '../ui/markup'

import {
  badgeOf, CONTROLLERS, describeBindings, DEVICE_KINDS, hostButtons, INPUT_OPTIONS, inferKind, inputsFor, isInputId,
  isTarget, KEY_TARGETS, offerOf, optionOf, resolveButtons, smartButtons, sourceOf, tapsOnly, targetLabel,
  type ControllerId, type DeviceKind, type InputSource, type Layout,
} from '@obpal/core'
import { phoneProfile, phoneMapping } from './packs'
import { ICONS } from '../ui/icons'
import { groupOf, type PhysicalInputs } from './inputs'
import { sheetExits } from './sheet'

type Group = 'keys' | 'media' | 'pad'
/** controller -> input -> target */
type Nested = Record<string, Record<string, string>>
/** kind -> controller -> input -> target */
type SmartStore = Partial<Record<DeviceKind, Nested>>

const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const MINE = (profile: string) => `obpal.buttons.${profile}`
// Beside the person's own (one key per profile), named so no profile id can take them.
const SMART = 'obpal.buttons-smart'
const BADGES = 'obpal.buttons-badges'
const BACK = 'obpal.buttons-back'

/** Maps of strings, two deep (controller -> input -> target), from what was stored; anything else is left out. */
function nested(o: unknown): Nested {
  const out: Nested = {}
  if (!o || typeof o !== 'object') return out
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue
    out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, t]) => typeof t === 'string')) as Record<string, string>
  }
  return out
}
const parse = (key: string): unknown => { try { return JSON.parse(store.get(key) ?? '{}') } catch { return {} } }
const readNested = (key: string): Nested => nested(parse(key))
function readSmart(): SmartStore {
  const o = parse(SMART) as Record<string, unknown> | null
  const out: SmartStore = {}
  for (const kind of DEVICE_KINDS) if (o && typeof o === 'object' && o[kind]) out[kind] = nested(o[kind])
  return out
}

const s = (d: Content) => html`<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`
/** A glyph per source: keys, volume, a headset, a pad, Back. */
export const SOURCE_GLYPH: Record<InputSource, Content> = {
  keys: ICONS.keyboard,
  volume: ICONS.sound,
  media: s(html`<path d="M4.5 14.5v-2a7.5 7.5 0 0 1 15 0v2"/><rect x="3.5" y="13.5" width="4.2" height="6.5" rx="1.8"/><rect x="16.3" y="13.5" width="4.2" height="6.5" rx="1.8"/>`),
  pad: ICONS.gamepad,
  back: s(html`<path d="M9.5 7.5 5 12l4.5 4.5"/><path d="M5.5 12h8.5a4.5 4.5 0 0 1 0 9h-2"/>`),
}
/** Buttons, in Settings: a remote. */
export const BUTTONS_GLYPH = s(html`<rect x="7.2" y="2.8" width="9.6" height="18.4" rx="3.2"/><circle cx="12" cy="8.2" r="2.1"/><path d="M10.2 13.4h3.6M10.2 16.6h3.6"/>`)
const SOURCE_NAME: Record<InputSource, string> = { keys: 'Keys', volume: 'Volume', media: 'Headset', pad: 'Pad', back: 'Back' }
const KIND_NAME: Record<DeviceKind, string> = { clicker: 'Clicker', selfie: 'Selfie remote', pad: 'Pad', headset: 'Headset', keyboard: 'Keyboard' }
/** The inputs a notice shows for each kind, in order: its main buttons. */
const KIND_SHOWS: Record<DeviceKind, readonly string[]> = {
  clicker: ['key:PageDown', 'key:PageUp', 'key:ArrowRight', 'key:ArrowLeft'],
  selfie: ['key:Enter', 'key:NumpadEnter', 'key:AudioVolumeUp'],
  pad: ['pad:b0', 'pad:b1', 'pad:b15', 'pad:b14'],
  headset: ['media:playpause', 'media:nexttrack', 'media:previoustrack'],
  keyboard: ['key:Enter', 'key:Escape', 'key:ArrowRight', 'key:ArrowLeft'],
}
/** The controls a one-tap bind offers first, per controller. */
const QUICK: Record<ControllerId, readonly string[]> = {
  'face.drums': ['kick', 'snare', 'hat'],
  'face.keys': ['note1', 'note3', 'note5', 'sustain'],
  'face.gamepad': ['a', 'b', 'x', 'y'], 'face.wheel': ['a', 'b', 'x', 'y'], 'face.wii': ['a', 'b', 'minus', 'plus'],
  'face.mouse': ['left', 'right', 'minus', 'plus'], 'face.trackpad': ['grab', 'level'], 'face.hand': ['hold', 'recentre'], 'face.keyboard': ['key-Enter', 'key-Escape'],
}
/** Keys that are for something else: modifiers, and Tab, which moves the focus. They never get a bind offer. */
const NOT_OFFERED = /^key:(Shift|Control|Alt|Meta|OS|CapsLock|Fn|Tab)/

export interface ButtonsDeps {
  inputs: PhysicalInputs
  /** The controller in use (CATALOGUE §9.1). */
  controller(): ControllerId
  /** The profile in effect for it: its bindings, and the person's own changes, are kept under it. */
  profile(): string
  layout(): Layout
  /** Press or let go of a target. tap: the input can't hold (a headset press, Back). */
  press(target: string, down: boolean, tap: boolean): void
  /** More than one controller to switch between (app:next and app:prev mean something). */
  canSwitch(): boolean
  /** The phone is typing (its keyboard dock is open): no notices then. */
  typing(): boolean
  hostName(): string
  feel(): void
  toast(text: string): void
}

export class Buttons {
  /** Inputs from each source this session, in order: what tells the kind of device. */
  private session: Record<Group, string[]> = { keys: [], media: [], pad: [] }
  private recognised = new Map<Group, DeviceKind>()
  private offered = new Set<string>()
  /** What each held input pressed, so letting go releases the same thing whatever changed meanwhile. */
  private held = new Map<string, string>()
  /** Inputs used this session: their badges fade. */
  private used = new Set<string>()
  private sheet: ButtonsSheet | null = null
  private noticeTimer: ReturnType<typeof setTimeout> | undefined
  /** Back as a button: the person's choice (kept), armed only while Back is bound here or being bound. */
  backOn = store.get(BACK) === '1'

  constructor(private readonly deps: ButtonsDeps) {
    deps.inputs.onChange = () => { this.sheet?.refresh(); this.syncBack() }
  }

  // ---- layers ----

  /** The person's own bindings for a controller, under the profile in effect. */
  mine(controller: string): Record<string, string> {
    return readNested(MINE(this.deps.profile()))[controller] ?? {}
  }

  setMine(controller: string, map: Record<string, string>) {
    const key = MINE(this.deps.profile())
    const all = readNested(key)
    if (Object.keys(map).length) all[controller] = map
    else delete all[controller]
    store.set(key, Object.keys(all).length ? JSON.stringify(all) : null)
    this.changed()
  }

  /**
   * The smart defaults of every kind of device recognised on this phone, for a controller: saved per kind and controller
   * the first time they're used there, so they stay as they were whatever a later version suggests.
   */
  private smart(controller: string): Record<string, string> {
    const all = readSmart()
    const out: Record<string, string> = {}
    let grew = false
    for (const kind of DEVICE_KINDS) {
      const saved = all[kind]
      if (!saved) continue
      if (!saved[controller]) { saved[controller] = { ...smartButtons(kind, controller) }; grew = true }
      Object.assign(out, saved[controller])
    }
    if (grew) store.set(SMART, JSON.stringify(all))
    return out
  }

  /** A kind of device is recognised: its smart defaults for this controller are saved and in effect from now on. */
  private remember(kind: DeviceKind, controller: string) {
    const all = readSmart()
    if (all[kind]?.[controller]) return
    all[kind] = { ...(all[kind] ?? {}), [controller]: { ...smartButtons(kind, controller) } }
    store.set(SMART, JSON.stringify(all))
  }

  /** What each input presses on a controller now (default: the one in use). */
  bindings(controller: string = this.deps.controller()): Record<string, string> {
    const layout = this.deps.layout()
    const id = this.deps.profile()
    const p = phoneProfile(id)
    const mapping = phoneMapping(this.deps.hostName())
    const fromProfile = p && (p.controller ?? 'face.gamepad') === controller ? p.buttons : undefined
    return resolveButtons(controller, [this.smart(controller), hostButtons(layout, controller), fromProfile, ...(mapping?.body.controller === controller && mapping.body.buttons ? [mapping.body.buttons] : []), this.mine(controller)], offerOf(layout))
  }

  /** Bindings changed (or the controller or the layout did): Back's arming follows, and the badges. */
  changed() {
    this.syncBack()
    this.paint()
    this.sheet?.refresh()
  }

  /** Arm Back while it is bound here (and the person turned it on), or while the sheet is listening for it. */
  syncBack() {
    const listening = !!this.sheet?.listening
    this.deps.inputs.wantBack((this.backOn && !!this.bindings().back) || listening)
  }

  setBackOn(on: boolean) {
    this.backOn = on
    store.set(BACK, on ? '1' : null)
    this.syncBack()
  }

  // ---- inputs ----

  /** A physical input went down or up; true when it did something. */
  input(id: string, down: boolean): boolean {
    if (this.sheet) return this.sheet.input(id, down)
    if (!down) {
      const t = this.held.get(id)
      if (t === undefined) return false
      this.held.delete(id)
      this.deps.press(t, false, tapsOnly(id))
      return true
    }
    const controller = this.deps.controller()
    const group = groupOf(sourceOf(id))
    let found: DeviceKind | null = null
    let known = false
    if (group !== 'back' && !this.deps.typing()) {
      const seen = this.session[group]
      known = seen.length > 0
      if (!seen.includes(id)) seen.push(id)
      const kind = inferKind(seen)
      if (kind && this.recognised.get(group) !== kind) {
        this.recognised.set(group, kind)
        this.remember(kind, controller)
        found = kind
      }
    }
    const bindings = this.bindings(controller)
    const target = bindings[id]
    if (found) this.found(found, id, bindings)
    if (!target) {
      if (!found && known && !NOT_OFFERED.test(id) && !this.offered.has(id)) { this.offered.add(id); this.offer(id) }
      return false
    }
    this.held.set(id, target)
    if (!this.used.has(id)) { this.used.add(id); this.paint() }
    this.deps.press(target, true, tapsOnly(id))
    return true
  }

  /** Release everything held (the controller changed, or the screen went away). */
  releaseAll() {
    for (const [id, t] of [...this.held]) { this.held.delete(id); this.deps.press(t, false, tapsOnly(id)) }
  }

  // ---- notices: found a device, or an unbound input ----

  private notice(content: Content, ms: number): HTMLElement {
    this.dismiss()
    const n = document.createElement('div')
    n.className = 'bt-notice glass'
    n.setAttribute('role', 'status')
    setMarkup(n, html`${content}<button class="bt-n-x" aria-label="Dismiss">${ICONS.close}</button>`)
    n.querySelector<HTMLButtonElement>('.bt-n-x')!.onclick = () => this.dismiss()
    document.body.appendChild(n)
    this.noticeTimer = setTimeout(() => this.dismiss(), ms)
    return n
  }

  dismiss() {
    clearTimeout(this.noticeTimer)
    document.querySelectorAll<HTMLElement>('.bt-notice:not(.out)').forEach((n) => {
      n.classList.add('out')
      setTimeout(() => n.remove(), 200)
    })
  }

  /** A device recognised: what it is, and what its buttons do now. Change opens the sheet at the input that told. */
  private found(kind: DeviceKind, id: string, bindings: Record<string, string>) {
    const controller = this.deps.controller()
    const pad = kind === 'pad' ? this.deps.inputs.padList()[0]?.name : undefined
    const does = describeBindings(controller, KIND_SHOWS[kind], bindings, this.deps.layout().tray, kind === 'clicker' ? 2 : 3)
    const n = this.notice(html`
      <span class="bt-n-ic" data-src="${sourceOf(id)}">${SOURCE_GLYPH[sourceOf(id)]}</span>
      <span class="bt-n-txt"><b>${pad ?? KIND_NAME[kind]} found</b><span>${does || 'Ready'}</span></span>
      <button class="bt-n-go">Change</button>`, 6500)
    n.querySelector<HTMLButtonElement>('.bt-n-go')!.onclick = () => { this.deps.feel(); this.dismiss(); this.open(id) }
  }

  /** An input nothing uses, from a device already recognised: one tap binds it. */
  private offer(id: string) {
    const controller = this.deps.controller()
    const quick = QUICK[controller].filter((t) => isTarget(controller, t)).slice(0, 4)
    const n = this.notice(html`
      <span class="bt-n-ic" data-src="${sourceOf(id)}">${SOURCE_GLYPH[sourceOf(id)]}</span>
      <span class="bt-n-txt"><b>${badgeOf(id)}</b><span>Use it for</span></span>
      <span class="bt-n-picks">${quick.map((t) => html`<button class="bt-n-pick" data-target="${t}">${targetLabel(controller, t)}</button>`)}<button class="bt-n-go">More</button></span>`, 9000)
    n.querySelectorAll<HTMLButtonElement>('[data-target]').forEach((b) => {
      b.onclick = () => {
        this.deps.feel()
        this.setMine(controller, { ...this.mine(controller), [id]: b.dataset.target! })
        this.dismiss()
        this.deps.toast(`${badgeOf(id)} = ${targetLabel(controller, b.dataset.target!)}`)
      }
    })
    n.querySelector<HTMLButtonElement>('.bt-n-go')!.onclick = () => { this.deps.feel(); this.dismiss(); this.open(id) }
  }

  // ---- the sheet ----

  /** Open the Buttons sheet; `input`: start at this input (the person picks a control for it). */
  open(input?: string) {
    this.dismiss()
    this.sheet?.close()
    this.sheet = new ButtonsSheet(this, this.deps, () => { this.sheet = null; this.deps.inputs.capture = false; this.syncBack(); this.paint() })
    this.deps.inputs.capture = true
    if (input) this.sheet.pick(input)
    this.syncBack()
  }

  get sheetOpen() { return !!this.sheet }

  /** What this phone has recognised this session, per source. */
  kindOf(group: Group): DeviceKind | undefined { return this.recognised.get(group) }

  // ---- badges on the controls ----

  badgesOn() { return store.get(BADGES) !== '0' }
  setBadges(on: boolean) { store.set(BADGES, on ? null : '0'); this.paint() }

  /**
   * Badges on the bound controls on screen (`Enter` on A): only for inputs that have worked on this phone, fading once
   * used, never on the gamepad (it's dense enough), and not at all if the person turned them off. Called on every
   * render: a badge that would read the same is left alone, so nothing flickers as the screen's state streams in.
   */
  paint() {
    const want = new Map<HTMLElement, HTMLElement>()
    if (this.badgesOn()) {
      const controller = this.deps.controller()
      const at = BADGE_AT[controller]
      const bindings = this.bindings(controller)
      const seen = this.deps.inputs.seen
      const targets = new Set([...Object.keys(at ?? {}), ...Object.values(bindings).filter((t) => t.startsWith('tray:'))])
      for (const t of targets) {
        const el = t.startsWith('tray:')
          ? document.querySelector<HTMLElement>(`#tray [data-id="${CSS.escape(t.slice(5))}"]`)
          : at?.[t] ? document.getElementById(at[t]) : null
        if (!el || el.offsetParent === null) continue
        const ids = inputsFor(bindings, t).filter((id) => seen.has(id))
        if (!ids.length) continue
        const labels = [...new Map(ids.map((id) => [badgeOf(id), id])).entries()]
        const badges = document.createElement('span')
        setMarkup(badges, [labels.slice(0, 2).map(([label, id]) => html`<i data-src="${sourceOf(id)}" class="${this.used.has(id) ? 'used' : ''}">${label}</i>`),
          labels.length > 2 ? html`<i class="more">+${labels.length - 2}</i>` : ''])
        want.set(el, badges)
      }
    }
    document.querySelectorAll<HTMLElement>('.hw-badges').forEach((b) => { if (!want.get(b.parentElement!)?.isEqualNode(b)) b.remove() })
    for (const [el, badges] of want) {
      if (el.querySelector(':scope > .hw-badges')) continue
      const box = document.createElement('span')
      box.className = 'hw-badges'
      box.setAttribute('aria-hidden', 'true')
      box.append(...badges.childNodes)
      el.appendChild(box)
    }
  }
}


/** Where each control of a controller is on screen, for its badge. The gamepad has none: it's dense enough. */
const BADGE_AT: Partial<Record<ControllerId, Record<string, string>>> = {
  'face.wii': { a: 'wii-a', b: 'wii-b', minus: 'wii-minus', home: 'wii-home', plus: 'wii-plus' },
  'face.mouse': { left: 'mouse-left', right: 'mouse-right', wheel: 'mouse-wheel', minus: 'mouse-zoom-out', plus: 'mouse-zoom-in', home: 'mouse-home' },
  'face.trackpad': { grab: 'gyro', level: 'center' },
  'face.hand': { hold: 'pad' },
}

/**
 * The Buttons sheet. A control chosen (tapped) waits for an input: the first one pressed, or picked from the list of
 * everything the phone can hear, binds to it. An input chosen (pressed with no control chosen, or from a notice's
 * Change) waits for a control: tapping one binds it. Undo takes back the last change; Reset the person's own
 * bindings on this controller.
 */
class ButtonsSheet {
  /** The control waiting for an input. */
  private target: string | null = null
  /** The input waiting for a control. */
  private pending: string | null = null
  private undo: Record<string, string> | null = null
  private wrap: HTMLElement
  private exits = () => {}
  private done = false

  constructor(private readonly b: Buttons, private readonly deps: ButtonsDeps, private readonly onClose: () => void) {
    const wrap = document.createElement('div')
    wrap.className = 'sheet-wrap'
    setMarkup(wrap, html`
      <div class="sheet btns glass" role="dialog" aria-label="Buttons">
        <div class="sheet-head"><div class="grip" aria-hidden="true"></div><button class="icon-btn glass sheet-x" data-act="close" aria-label="Close">${ICONS.close}</button></div>
        <div class="bt-title"><h2>Buttons</h2><span class="bt-ctl"></span></div>
        <div class="bt-grids"></div>
        <p class="bt-line" role="status" aria-live="polite"></p>
        <div class="bt-assign" hidden></div>
        <p class="sheet-k">What reaches this phone</p>
        <div class="bt-srcs"></div>
        <label class="row"><input type="checkbox" data-act="badges"> Show them on the controls</label>
        <a class="support-link" href="/buttons/" target="_blank" rel="noopener">${ICONS.open}<span>Test your buttons</span></a>
        <div class="actions"><button class="btn" data-act="reset">Reset</button><button class="btn primary" data-act="done">Done</button></div>
      </div>`)
    this.wrap = wrap
    document.body.appendChild(wrap)
    const close = () => this.close()
    wrap.querySelector<HTMLButtonElement>('[data-act="close"]')!.onclick = close
    wrap.querySelector<HTMLButtonElement>('[data-act="done"]')!.onclick = close
    const badges = wrap.querySelector<HTMLInputElement>('[data-act="badges"]')!
    badges.checked = b.badgesOn()
    badges.onchange = () => { deps.feel(); b.setBadges(badges.checked) }
    const reset = wrap.querySelector<HTMLButtonElement>('[data-act="reset"]')!
    let armed = 0
    reset.onclick = () => {
      deps.feel()
      if (!armed) {
        reset.classList.add('armed')
        reset.textContent = 'Reset this controller?'
        armed = window.setTimeout(() => { armed = 0; reset.classList.remove('armed'); reset.textContent = 'Reset' }, 3000)
        return
      }
      clearTimeout(armed)
      armed = 0
      reset.classList.remove('armed')
      reset.textContent = 'Reset'
      const c = deps.controller()
      this.undo = b.mine(c)
      b.setMine(c, {})
      this.say('Back to the defaults', true)
    }
    this.exits = sheetExits(wrap, close)
    this.refresh()
  }

  /** Waiting for an input for a control (the Back catcher arms for it too). */
  get listening() { return this.target !== null }

  close() {
    if (this.done) return
    this.done = true
    this.exits()
    this.wrap.classList.add('out')
    setTimeout(() => this.wrap.remove(), 200)
    this.onClose()
  }

  /** Start at an input: the person picks a control for it. */
  pick(input: string) {
    this.target = null
    this.pending = input
    const now = this.b.bindings()[input]
    this.say(now ? `${badgeOf(input)} → ${targetLabel(this.deps.controller(), now, this.deps.layout().tray)} · tap a control to change it` : `${badgeOf(input)} · tap a control for it`)
  }

  /** A physical input while the sheet is open: it binds, or it shows what it does. Nothing is pressed. */
  input(id: string, down: boolean): boolean {
    if (!down) return true
    this.deps.feel()
    if (this.target) { this.bind(id, this.target); return true }
    // Back with nothing to bind it to closes the sheet, as Back does everywhere else.
    if (id === 'back') { this.close(); return true }
    this.pick(id)
    const t = this.b.bindings()[id]
    this.wrap.querySelectorAll('.bt-c.found').forEach((c) => c.classList.remove('found'))
    if (t) this.wrap.querySelector(`.bt-c[data-target="${CSS.escape(t)}"]`)?.classList.add('found')
    return true
  }

  private bind(input: string, target: string) {
    const c = this.deps.controller()
    const was = this.b.bindings(c)[input]
    const mine = this.b.mine(c)
    this.undo = { ...mine }
    this.b.setMine(c, { ...mine, [input]: target })
    const tray = this.deps.layout().tray
    this.target = null
    this.pending = null
    this.say(`${badgeOf(input)} → ${targetLabel(c, target, tray)}${was && was !== target ? ` (was ${targetLabel(c, was, tray)})` : ''}`, true)
    this.b.syncBack()
  }

  private unbind(input: string) {
    const c = this.deps.controller()
    const mine = this.b.mine(c)
    this.undo = { ...mine }
    this.b.setMine(c, { ...mine, [input]: 'none' })
    this.say(`${badgeOf(input)} does nothing now`, true)
  }

  private say(text: string, undo = false) {
    const el = this.wrap.querySelector<HTMLElement>('.bt-line')!
    setMarkup(el, [text, undo && this.undo ? html` <button class="bt-undo">Undo</button>` : ''])
    const u = el.querySelector<HTMLButtonElement>('.bt-undo')
    if (u) u.onclick = () => {
      this.deps.feel()
      if (!this.undo) return
      this.b.setMine(this.deps.controller(), this.undo)
      this.undo = null
      this.say('Undone')
    }
    this.renderGrids()
  }

  /** Redraw everything but the line (the controller, the layout, the sources or a binding changed). */
  refresh() {
    if (this.done) return
    const c = this.deps.controller()
    const spec = CONTROLLERS[c]
    this.wrap.querySelector('.bt-ctl')!.textContent = spec?.name ?? ''
    this.renderGrids()
    this.renderSources()
  }

  private renderGrids() {
    const c = this.deps.controller()
    const layout = this.deps.layout()
    const bindings = this.b.bindings(c)
    const offer = offerOf(layout)
    const chip = (t: string) => {
      const ids = inputsFor(bindings, t)
      const labels = [...new Map(ids.map((id) => [badgeOf(id), id])).entries()]
      const bs = [labels.slice(0, 3).map(([label, id]) => html`<i data-src="${sourceOf(id)}">${label}</i>`), labels.length > 3 ? html`<i class="more">+${labels.length - 3}</i>` : '']
      const on = this.target === t
      const waiting = !!this.pending && bindings[this.pending] === t
      return html`<button class="bt-c${on ? ' on' : ''}${waiting ? ' found' : ''}" data-target="${t}" aria-pressed="${on}"><b>${targetLabel(c, t, layout.tray)}</b><span class="bt-bs">${bs}</span></button>`
    }
    const groups: [string, string[]][] = [
      [CONTROLLERS[c]?.name ?? 'Controls', [...(CONTROLLERS[c]?.controls ?? [])]],
      ['On the screen', [...layout.tray.filter((x) => (x.type ?? 'button') === 'button').map((x) => `tray:${x.id}`), ...(offer.typing && c !== 'face.keyboard' ? KEY_TARGETS : [])]],
      ['On the phone', [...(this.deps.canSwitch() ? ['app:next', 'app:prev'] : []), ...(offer.typing ? ['app:keyboard'] : [])]],
    ]
    const grids = this.wrap.querySelector('.bt-grids')!
    setMarkup(grids, groups.filter(([, ts]) => ts.length).map(([name, ts], i) =>
      html`${i ? html`<p class="sheet-k">${name}</p>` : ''}<div class="bt-grid${i ? ' more' : ''}" role="group" aria-label="${name}">${ts.map(chip)}</div>`))
    grids.querySelectorAll<HTMLButtonElement>('.bt-c').forEach((el) => {
      el.onclick = () => {
        this.deps.feel()
        const t = el.dataset.target!
        if (this.pending) { this.bind(this.pending, t); return }
        this.target = this.target === t ? null : t
        this.say(this.target ? `Press a button on your phone, headset, remote or pad · or pick one below` : '')
        this.b.syncBack()
      }
    })
    this.renderAssign(bindings)
  }

  /** Everything the phone can hear, to pick from for the control waiting (current ones marked; tap one again to clear it). */
  private renderAssign(bindings: Record<string, string>) {
    const box = this.wrap.querySelector<HTMLElement>('.bt-assign')!
    box.hidden = !this.target
    if (!this.target) { box.replaceChildren(); return }
    const t = this.target
    const seen = this.deps.inputs.seen
    setMarkup(box, INPUT_OPTIONS.map(({ source, ids }) => html`
      <div class="bt-og" data-src="${source}">
        <span class="bt-og-ic" title="${SOURCE_NAME[source]}">${SOURCE_GLYPH[source]}</span>
        <div class="bt-og-list">${ids.map((id) => html`<button class="bt-o${seen.has(id) ? ' seen' : ''}" data-input="${id}" aria-pressed="${bindings[id] === t}">${optionOf(id)}</button>`)}</div>
      </div>`))
    box.querySelectorAll<HTMLButtonElement>('.bt-o').forEach((o) => {
      o.onclick = () => {
        this.deps.feel()
        const id = o.dataset.input!
        if (!isInputId(id)) return
        if (bindings[id] === t) this.unbind(id)
        else this.bind(id, t)
      }
    })
  }

  /** One row per source, each with one honest line (and the headset's and Back's switches). */
  private renderSources() {
    const inputs = this.deps.inputs
    const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const seenFrom = (src: InputSource) => [...inputs.seen].some((id) => sourceOf(id) === src)
    const kind = this.b.kindOf('keys')
    const pads = inputs.padList()
    const headsetLine = { off: 'Plays silence · pauses your music', on: 'On · press once, twice or three times', paused: 'Paused by the phone · tap to turn on', failed: 'No headset buttons in this browser' }[inputs.headset]
    const backLine = ios ? 'Back is Android’s' : !inputs.backAvailable ? 'Not in this browser' : 'Back after a touch stays here · twice in a row leaves'
    const rows: { src: InputSource; line: string; on?: boolean; lit: boolean; sw?: 'headset' | 'back'; off?: boolean }[] = [
      { src: 'keys', line: kind ? `${KIND_NAME[kind]} found` : 'Keyboards, clickers and remotes over Bluetooth', lit: seenFrom('keys') },
      // Said plainly, always: no browser on a phone gets them (a keyboard's own volume keys may).
      { src: 'volume', line: 'A phone’s volume and side keys can’t reach any browser page', lit: seenFrom('volume'), off: !seenFrom('volume') },
      { src: 'media', line: headsetLine, lit: inputs.headset === 'on', sw: 'headset', on: inputs.headset === 'on', off: inputs.headset === 'failed' },
      { src: 'pad', line: pads.length ? pads.map((p) => p.name).join(' · ') : 'Connect a pad over Bluetooth or USB', lit: pads.length > 0 },
      { src: 'back', line: backLine, lit: this.b.backOn && inputs.backAvailable && !ios, sw: inputs.backAvailable && !ios ? 'back' : undefined, on: this.b.backOn, off: ios || !inputs.backAvailable },
    ]
    const box = this.wrap.querySelector('.bt-srcs')!
    setMarkup(box, rows.map((r) => html`
      <div class="bt-src${r.lit ? ' lit' : ''}${r.off ? ' off' : ''}${r.src === 'media' && inputs.headset === 'paused' ? ' paused' : ''}" data-src="${r.src}">
        <span class="bt-src-ic">${SOURCE_GLYPH[r.src]}</span>
        <span class="bt-src-t"><b>${SOURCE_NAME[r.src]}</b><small>${r.line}</small></span>
        ${r.sw ? html`<input type="checkbox" data-sw="${r.sw}" aria-label="${r.sw === 'headset' ? 'Headset buttons' : 'Use Back as a button'}" checked="${!!r.on}" disabled="${!!r.off}">` : ''}
      </div>`))
    box.querySelector<HTMLInputElement>('[data-sw="headset"]')?.addEventListener('change', async (e) => {
      const el = e.currentTarget as HTMLInputElement
      this.deps.feel()
      if (el.checked) {
        if (!(await inputs.enableHeadset(this.deps.hostName()))) this.deps.toast('Headset buttons aren’t available in this browser')
      } else inputs.disableHeadset()
      this.renderSources()
    })
    box.querySelector<HTMLInputElement>('[data-sw="back"]')?.addEventListener('change', (e) => {
      const el = e.currentTarget as HTMLInputElement
      this.deps.feel()
      this.b.setBackOn(el.checked)
      // Nothing to press yet: pick a control for it.
      if (el.checked && !this.b.bindings().back) this.pick('back')
      this.renderSources()
    })
  }
}

/** For the Settings row: the glyphs of the sources that have worked on this phone. */
export function sourceStack(inputs: PhysicalInputs): Content {
  const srcs = new Set([...inputs.seen].map((id) => sourceOf(id)))
  if (inputs.headset === 'on') srcs.add('media')
  if (inputs.padList().length) srcs.add('pad')
  return (['keys', 'media', 'pad', 'back'] as InputSource[]).filter((x) => srcs.has(x)).map((x) => html`<i data-src="${x}">${SOURCE_GLYPH[x]}</i>`)
}
