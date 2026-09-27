/**
 * The keyboard dock: the phone's own keyboard, typing on the screen. It opens from a `keyboard` tray control, or from
 * the Type prompt that shows while the screen says one of its text fields has the focus (the host value `textField`:
 * 'text', or 'secret' for a password field).
 *
 * A real field sits right above the phone's keyboard (visualViewport), so the OS keyboard shows, and whatever it does
 * (autocorrect, predictions, swiping a word, IME composition) goes through ./typing.ts as text{s, del}: delete `del`
 * characters, then type `s`. A row of keys the phone's keyboard lacks (Esc, Tab, the arrows, and Backspace and Enter
 * for when it is down) sends btn{key-<KeyboardEvent.code>, tap}; the arrows and Backspace repeat while held. For a
 * password field the field is a password input, so the keyboard neither learns nor suggests; the dock draws dots of
 * its own (the input's would show one for the sentinel) and forgets the field as soon as it closes.
 */import { type Content, html, setMarkup } from '../ui/markup'

import type { DeviceMsg } from '@obpal/core'
import { ICONS } from '../ui/icons'
import { SENTINEL, textMessages, TypingDiff } from './typing'

/** What has the focus on the screen: a text field, or a password field. */
export type TextField = 'text' | 'secret'
type Opener = 'tray' | 'prompt'

/** The key row, by KeyboardEvent.code: a word or an icon, and the name a screen reader says. */
const KEYS: { code: string; word?: string; icon?: string; name: string; repeat?: boolean }[] = [
  { code: 'Escape', word: 'esc', name: 'Escape' },
  { code: 'Tab', word: 'tab', name: 'Tab' },
  { code: 'ArrowLeft', icon: 'arrow-left', name: 'Left', repeat: true },
  { code: 'ArrowUp', icon: 'arrow-up', name: 'Up', repeat: true },
  { code: 'ArrowDown', icon: 'arrow-down', name: 'Down', repeat: true },
  { code: 'ArrowRight', icon: 'arrow-right', name: 'Right', repeat: true },
  { code: 'Backspace', icon: 'backspace', name: 'Backspace', repeat: true },
  { code: 'Enter', icon: 'enter', name: 'Enter' },
]
/** Keys a keyboard attached to the phone passes to the screen as they are (its typing goes through the field). */
const PASS = new Set(['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'])
/** A held arrow or Backspace repeats after this long, this often (ms). */
const REPEAT_AFTER = 420
const REPEAT_EVERY = 90
/** Control characters other than tab, newline and return never reach the screen (a paste can carry them). */
const NOT_TYPED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
/** A dock the prompt opened waits this long once the screen's text field loses the focus, in case it comes back (ms). */
const GONE_MS = 450
/** The most dots the password field draws. */
const MAX_DOTS = 32

export interface KeyboardDeps {
  send(m: DeviceMsg): void
  /** A haptic tick, for a key. */
  feel(): void
  /** The dock opened (from a tap) or closed. */
  changed(open: boolean): void
}

export class KeyboardDock {
  private root: HTMLElement | null = null
  private prompt: HTMLElement | null = null
  private text: HTMLTextAreaElement | null = null
  private pass: HTMLInputElement | null = null
  private diff = new TypingDiff()
  /** Who opened the dock; null while it is closed. */
  private by: Opener | null = null
  /** The screen's text field, as it last said. */
  private field: TextField | null = null
  private secret = false
  private goneTimer: ReturnType<typeof setTimeout> | undefined
  private repeatTimer: ReturnType<typeof setTimeout> | undefined
  /** The history entry that lets Back close the dock, as it closes a sheet. */
  private mark: object | null = null
  /** Where the prompt floats: the middle of the controls, and how far above the bottom (px, the UI's frame). */
  private at: { x: number; bottom: number } | null = null
  /** Which icons the dock and the prompt show now ('dock/prompt', text or secret), so typing doesn't redraw them. */
  private icons = ''

  constructor(private readonly deps: KeyboardDeps) {
    addEventListener('popstate', () => {
      if (this.mark && history.state !== this.mark) { this.mark = null; this.close() }
    })
    visualViewport?.addEventListener('resize', this.fit)
    visualViewport?.addEventListener('scroll', this.fit)
    addEventListener('resize', this.fit)
  }

  get open() {
    return this.by !== null && !!this.root?.isConnected
  }

  /** The Type prompt is wanted: a field has the focus on the screen and the dock is closed. */
  get prompting() {
    return !!this.field && !this.open
  }

  html(): Content {
    const keys = KEYS.map((k) => html`<button class="kbd-key${k.code === 'Enter' ? ' enter' : ''}" data-code="${k.code}" aria-label="${k.name}">${k.icon ? ICONS[k.icon] : html`<span>${k.word}</span>`}</button>`)
    return html`
      <div class="kbd glass" id="kbd" role="group" aria-label="Keyboard" hidden>
        <div class="kbd-in" id="kbd-in">
          <span class="kbd-ic" aria-hidden="true"></span>
          <textarea class="kbd-field" id="kbd-text" rows="1" wrap="off" autocapitalize="off" spellcheck="false" enterkeyhint="enter" aria-label="Type on the screen"></textarea>
          <input class="kbd-field" id="kbd-pass" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="enter" aria-label="Type a password on the screen" hidden>
          <span class="kbd-ph" aria-hidden="true"></span>
          <span class="kbd-dots" aria-hidden="true"></span>
        </div>
        <div class="kbd-keys">${keys}</div>
        <button class="kbd-hide" id="kbd-hide" aria-label="Hide the keyboard">${ICONS['kb-hide']}</button>
      </div>
      <button class="type-prompt" id="type-prompt" hidden><span class="tp-ic" aria-hidden="true"></span><b>Type</b><small>password</small></button>`
  }

  /** Wire a freshly built dock and prompt (the controller builds them with its surface; an old dock went with the old one). */
  bind(root: HTMLElement) {
    this.by = null
    this.mark = null
    this.secret = false
    this.icons = ''
    const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!
    this.root = $('kbd')
    this.prompt = $('type-prompt')
    this.text = $<HTMLTextAreaElement>('kbd-text')
    this.pass = $<HTMLInputElement>('kbd-pass')
    for (const el of [this.text, this.pass]) {
      el.addEventListener('input', (e) => this.typed((e as InputEvent).isComposing === true))
      el.addEventListener('compositionend', () => this.typed(false))
      el.addEventListener('keydown', (e) => this.key(e as KeyboardEvent))
    }
    // A tap anywhere on the field (its icon, its dots) is a tap on the input: the keyboard comes back.
    $('kbd-in').addEventListener('click', () => this.active()?.focus({ preventScroll: true }))
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.kbd-key')) this.bindKey(b)
    const hide = $('kbd-hide')
    hide.addEventListener('mousedown', (e) => e.preventDefault())
    hide.addEventListener('click', () => { this.deps.feel(); this.close() })
    this.prompt.addEventListener('click', () => { this.deps.feel(); this.show('prompt') })
    this.render()
  }

  /** The screen's `textField` value: a text or password field has the focus there (anything else: none). */
  setField(v: unknown) {
    const next: TextField | null = v === 'text' || v === 'secret' ? v : null
    if (next) clearTimeout(this.goneTimer)
    if (next === this.field) return
    const was = this.field
    this.field = next
    if (next) {
      // A field that just took the focus: the prompt comes in with a pulse.
      if (!was) this.prompt?.classList.remove('again')
      // Into a password field (or out of one) with the dock open: the field follows.
      if (this.open) this.mode(next === 'secret')
    } else if (was && this.by === 'prompt') {
      // The field lost the focus: a dock the prompt opened goes with it, unless the focus comes straight back.
      this.goneTimer = setTimeout(() => { if (!this.field && this.by === 'prompt') this.close() }, GONE_MS)
    } else if (this.open && this.secret) this.mode(false)
    this.render()
  }

  /** The host no longer offers typing (no keyboard control, no text field): the dock closes. */
  offered(on: boolean) {
    if (!on && this.open && !this.field) this.close()
  }

  /** Where the prompt floats, in the UI's frame: centred at `x`, `bottom` px above the bottom edge. */
  place(at: { x: number; bottom: number } | null) {
    const was = this.at
    this.at = at
    const p = this.prompt
    if (p && at) {
      p.style.setProperty('--tp-x', `${Math.round(at.x)}px`)
      p.style.setProperty('--tp-bottom', `${Math.round(at.bottom)}px`)
    }
    if (!was !== !at) this.render()
  }

  /** Open the dock and focus its field. Call it from a tap: the phone's keyboard shows only for a focus inside one. */
  show(by: Opener) {
    const root = this.root
    if (!root) return
    const opening = !this.by
    if (opening || by === 'tray') this.by = by
    if (opening) {
      this.mode(this.field === 'secret', false)
      this.clear()
      root.hidden = false
      if (!this.mark) {
        this.mark = { obpalKeyboard: Math.random() }
        history.pushState(this.mark, '')
      }
    }
    this.active()?.focus({ preventScroll: true })
    this.render()
    this.fit()
    if (opening) this.deps.changed(true)
  }

  /** Close the dock: the phone's keyboard goes, and the field forgets what it held. */
  close() {
    clearTimeout(this.goneTimer)
    this.stopRepeat()
    if (!this.by) return
    this.by = null
    this.active()?.blur()
    this.clear()
    if (this.pass) this.pass.value = ''
    if (this.root) this.root.hidden = true
    // Still focused on the screen: the prompt comes back, quietly.
    this.prompt?.classList.add('again')
    if (this.mark && history.state === this.mark) history.back()
    this.mark = null
    this.render()
    this.fit()
    this.deps.changed(false)
  }

  private active(): HTMLTextAreaElement | HTMLInputElement | null {
    return this.secret ? this.pass : this.text
  }

  /** Text or password: the other field takes over (and the focus, if the dock had it), both starting empty. */
  private mode(secret: boolean, keepFocus = true) {
    if (secret === this.secret) return
    const focused = keepFocus && !!this.active() && document.activeElement === this.active()
    this.secret = secret
    if (this.text) this.text.hidden = secret
    if (this.pass) { this.pass.hidden = !secret; this.pass.value = '' }
    this.clear()
    if (focused) this.active()?.focus({ preventScroll: true })
  }

  /** The field starts over (what was typed stays typed on the screen). */
  private clear() {
    this.diff.reset()
    const f = this.active()
    if (f) f.value = SENTINEL
    this.render()
  }

  /** An input event (or a word settling): what changed goes to the screen, and the field takes what the diff keeps. */
  private typed(composing: boolean) {
    const f = this.active()
    if (!f || !this.by) return
    const raw = f.value
    const clean = raw.replace(NOT_TYPED, '')
    const t = this.diff.input(clean, composing)
    for (const m of textMessages(t.del, t.s)) this.deps.send(m)
    if (f.value !== t.value) {
      f.value = t.value
      f.scrollLeft = f.scrollWidth
    }
    this.render()
  }

  /** Keys typed into the field: Enter from a password field, and the keys a keyboard attached to the phone passes on. */
  private key(e: KeyboardEvent) {
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && this.secret) {
      // A password field has no newline of its own: Enter goes as one, and the field starts over.
      e.preventDefault()
      const f = this.pass!
      const t = this.diff.input(`${f.value}\n`)
      for (const m of textMessages(t.del, t.s)) this.deps.send(m)
      f.value = t.value
      this.render()
    } else if (PASS.has(e.code) && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      this.press(e.code)
    }
  }

  private bindKey(b: HTMLButtonElement) {
    const code = b.dataset.code!
    const repeats = KEYS.find((k) => k.code === code)?.repeat === true
    // The field keeps the focus (and the phone its keyboard) while the keys are tapped.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('contextmenu', (e) => e.preventDefault())
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      try { b.setPointerCapture(e.pointerId) } catch { /* not a live pointer */ }
      b.classList.add('down')
      this.deps.feel()
      this.press(code)
      this.stopRepeat()
      if (!repeats) return
      const again = () => { this.press(code); this.repeatTimer = setTimeout(again, REPEAT_EVERY) }
      this.repeatTimer = setTimeout(again, REPEAT_AFTER)
    })
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      b.addEventListener(ev, () => { b.classList.remove('down'); this.stopRepeat() })
    }
    // A keyboard's own activation (Enter or Space on a focused key, a screen reader's double tap) has no pointer.
    b.addEventListener('click', (e) => { if (e.detail === 0) { this.deps.feel(); this.press(code) } })
  }

  private stopRepeat() {
    clearTimeout(this.repeatTimer)
    this.repeatTimer = undefined
  }

  /**
   * A key from the row goes to the screen as a tap. The field keeps up: Backspace drops its last character too;
   * any other key moves the screen's caret or ends the line, so the field starts over.
   */
  private press(code: string) {
    this.deps.send({ t: 'btn', id: `key-${code}`, ev: 'tap' })
    const f = this.active()
    if (!f) return
    if (code === 'Backspace') f.value = this.diff.deleted()
    else this.clear()
    this.render()
  }

  /** Follow the phone's keyboard: the dock sits on it, and toasts rise above the dock. */
  private fit = () => {
    const root = this.root
    if (!root) return
    const vv = visualViewport
    const kb = vv && this.open ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0
    root.style.setProperty('--kb', `${kb}px`)
    root.classList.toggle('up', kb > 40)
    // Measured without the lift's transform, which may still be easing.
    const lift = this.open ? innerHeight - root.offsetTop + kb + 10 : 0
    document.documentElement.style.setProperty('--kbd-lift', `${Math.max(0, Math.round(lift))}px`)
  }

  private render() {
    const secret = this.secret
    const root = this.root
    const p = this.prompt
    const icons = `${secret ? 'secret' : 'text'}/${this.field ?? 'none'}`
    const redraw = icons !== this.icons
    this.icons = icons
    if (root) {
      root.classList.toggle('secret', secret)
      const f = this.active()
      const typed = f ? Array.from(f.value.split(SENTINEL).join('')).length : 0
      root.querySelector('#kbd-in')!.classList.toggle('empty', typed === 0)
      root.querySelector('.kbd-dots')!.textContent = secret ? '•'.repeat(Math.min(typed, MAX_DOTS)) : ''
      if (redraw) {
        setMarkup(root.querySelector('.kbd-ic')!, secret ? ICONS.lock : ICONS.keyboard)
        root.querySelector('.kbd-ph')!.textContent = secret ? 'Password' : 'Type'
      }
    }
    // The page steps back around them (controller.css): the pad's legend under the prompt, the controls under the dock.
    const prompt = this.prompting && !!this.at && !!p
    document.documentElement.classList.toggle('typing', this.open)
    document.documentElement.classList.toggle('typing-prompt', prompt)
    if (p) {
      p.hidden = !prompt
      if (redraw) {
        p.classList.toggle('secret', this.field === 'secret')
        p.setAttribute('aria-label', this.field === 'secret' ? 'Type a password on the screen' : 'Type on the screen')
        setMarkup(p.querySelector('.tp-ic')!, this.field === 'secret' ? ICONS.lock : ICONS.keyboard)
      }
    }
  }
}
