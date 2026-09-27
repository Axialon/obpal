/**
 * Keys mode: turn a phone controller into keyboard and mouse input for keyboard/mouse web games, and (DESKTOP_KEYS)
 * into a desktop controller for the whole PC, which types no letters.
 * Pure: the mapper returns key and mouse edges; the MAIN-world page script (or ob.Pal Desktop) carries them out.
 */
import { PadButton } from '@obpal/core'
import { Accum, buttonValue, clamp, hysteresis, stickCurve, type PadInput } from './math'

/** A key as KeyboardEvent reports it. location: 0 standard, 1 left, 2 right, 3 numpad. */
export interface KeyDef {
  key: string
  code: string
  /** Legacy KeyboardEvent.keyCode (and which). */
  keyCode: number
  location: 0 | 1 | 2 | 3
}

const k = (key: string, code: string, keyCode: number, location: KeyDef['location'] = 0): KeyDef => ({ key, code, keyCode, location })

/** Every key a binding can name, keyed by KeyboardEvent.code. Add a row here to make another key bindable. */
export const KEYS = {
  KeyW: k('w', 'KeyW', 87), KeyA: k('a', 'KeyA', 65), KeyS: k('s', 'KeyS', 83), KeyD: k('d', 'KeyD', 68),
  KeyE: k('e', 'KeyE', 69), KeyQ: k('q', 'KeyQ', 81), KeyR: k('r', 'KeyR', 82), KeyF: k('f', 'KeyF', 70),
  KeyC: k('c', 'KeyC', 67), KeyX: k('x', 'KeyX', 88), KeyZ: k('z', 'KeyZ', 90),
  Digit1: k('1', 'Digit1', 49), Digit2: k('2', 'Digit2', 50), Digit3: k('3', 'Digit3', 51), Digit4: k('4', 'Digit4', 52),
  Space: k(' ', 'Space', 32), Enter: k('Enter', 'Enter', 13), Escape: k('Escape', 'Escape', 27),
  Tab: k('Tab', 'Tab', 9), Backspace: k('Backspace', 'Backspace', 8),
  ShiftLeft: k('Shift', 'ShiftLeft', 16, 1), ControlLeft: k('Control', 'ControlLeft', 17, 1), AltLeft: k('Alt', 'AltLeft', 18, 1),
  ArrowUp: k('ArrowUp', 'ArrowUp', 38), ArrowDown: k('ArrowDown', 'ArrowDown', 40),
  ArrowLeft: k('ArrowLeft', 'ArrowLeft', 37), ArrowRight: k('ArrowRight', 'ArrowRight', 39),
} satisfies Record<string, KeyDef>
export type KeyName = keyof typeof KEYS

export type PadButtonName = keyof typeof PadButton
/** MouseEvent.button: 0 left, 1 middle, 2 right. */
export type MouseButton = 0 | 1 | 2

/** Everything Keys mode does, in one editable object. */
export interface KeysConfig {
  /** Left stick (or the phone's tilt stick) to four keys, or none. Pressed at |axis| >= press, released below release. */
  move: { up: KeyName; down: KeyName; left: KeyName; right: KeyName; press: number; release: number } | null
  /** Standard gamepad buttons to a key, or a chord pressed together (the D-pad is Up/Down/Left/Right). */
  buttons: Partial<Record<PadButtonName, KeyName | readonly KeyName[]>>
  mouse: {
    /** The stick that moves the pointer (default right): px/s at full deflection, per-axis deadzone and response exponent. */
    stick?: 'left' | 'right'
    speed: number
    deadzone: number
    expo: number
    /** Screen px per degree of phone aim (Point mode gyro), and per px of phone trackpad travel. */
    aimGain: number
    padGain: number
    /** Gamepad buttons (the triggers are analog) to mouse buttons, with hysteresis. */
    buttons: Partial<Record<PadButtonName, MouseButton>>
    press: number
    release: number
  }
  /** A stick that turns the mouse wheel: wheel units/s at full deflection (120 a notch), deadzone and exponent. */
  scroll?: { stick: 'left' | 'right'; speed: number; deadzone: number; expo: number }
  /** Use the phone's tilt stick as the left stick while the phone is not in gamepad mode. */
  tiltMoves: boolean
}

export const DEFAULT_KEYS: KeysConfig = {
  move: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', press: 0.4, release: 0.3 },
  buttons: {
    A: 'Space', B: 'Escape', X: 'KeyE', Y: 'KeyQ', Menu: 'Enter', LB: 'ShiftLeft', RB: 'ControlLeft',
    Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  },
  mouse: { speed: 1200, deadzone: 0.12, expo: 1.6, aimGain: 14, padGain: 1.5, buttons: { RT: 0, LT: 2 }, press: 0.5, release: 0.35 },
  tiltMoves: true,
}

/**
 * The whole PC (ob.Pal Desktop's whole-PC mode): a controller for the desktop, the way Gopher360 and Steam's desktop
 * layout work, that types no letters into whatever has focus. Left stick: the pointer. Right stick: scroll. A or RT:
 * click (held, it drags). X or LT: right-click. Left stick press: middle click. B: Esc. Y: Enter. D-pad: arrows.
 * LB / RB: back / forward (Alt+Left / Alt+Right). Menu: the Start menu (Ctrl+Esc). View: the last app (Alt+Tab).
 */
export const DESKTOP_KEYS: KeysConfig = {
  move: null,
  buttons: {
    B: 'Escape', Y: 'Enter', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
    LB: ['AltLeft', 'ArrowLeft'], RB: ['AltLeft', 'ArrowRight'], Menu: ['ControlLeft', 'Escape'], View: ['AltLeft', 'Tab'],
  },
  mouse: { stick: 'left', speed: 1400, deadzone: 0.14, expo: 2, aimGain: 14, padGain: 1.5, buttons: { A: 0, RT: 0, X: 2, LT: 2, L3: 1 }, press: 0.5, release: 0.35 },
  scroll: { stick: 'right', speed: 2400, deadzone: 0.18, expo: 1.8 },
  tiltMoves: false,
}

export interface Mods { shift: boolean; ctrl: boolean; alt: boolean }
/** A key transition, with the modifier state after it (so Shift's own keydown reports shiftKey). */
export interface KeyEdge { key: KeyName; down: boolean; mods: Mods }
export interface MouseEdge { button: MouseButton; down: boolean }
export interface KeysOutput {
  keys: KeyEdge[]
  /** Whole-pixel relative mouse motion (movementX/Y) for this frame. */
  move: [number, number]
  buttons: MouseEdge[]
  /** Whole wheel units for this frame from a scrolling stick (DOM convention: + scrolls down / right). */
  wheel: [number, number]
}

export interface KeysInput {
  pad: PadInput | null
  /** Tilt stick [steer + right, pitch + top toward the user], or null. */
  tilt: readonly [number, number] | null
  /** Phone aim since the last frame, degrees: [yaw + left, pitch + up]. */
  aim: readonly [number, number]
  /** Phone trackpad travel since the last frame, px. */
  pad1: readonly [number, number]
  /** Time since the last frame, for the rate-based right stick. */
  dtMs: number
}

const MOD_OF: Partial<Record<KeyName, keyof Mods>> = { ShiftLeft: 'shift', ControlLeft: 'ctrl', AltLeft: 'alt' }
const isMod = (key: KeyName) => MOD_OF[key] !== undefined
const DIRS = ['up', 'down', 'left', 'right'] as const

/** Stateful pad -> keyboard/mouse mapper. Call update() once per input frame. */
export class KeyMapper {
  private held = new Set<KeyName>()
  private dir: Record<(typeof DIRS)[number], boolean> = { up: false, down: false, left: false, right: false }
  private trig: Partial<Record<PadButtonName, boolean>> = {}
  private mouseHeld = new Set<MouseButton>()
  private acc = new Accum()
  private wheelCarry: [number, number] = [0, 0]

  constructor(public cfg: KeysConfig = DEFAULT_KEYS) {}

  get mods(): Mods {
    const m: Mods = { shift: false, ctrl: false, alt: false }
    for (const key of this.held) {
      const mod = MOD_OF[key]
      if (mod) m[mod] = true
    }
    return m
  }

  update(input: KeysInput): KeysOutput {
    const { move, buttons, mouse, scroll } = this.cfg
    const pad = input.pad
    const stick: readonly [number, number] = pad
      ? [pad.axes[0], pad.axes[1]]
      : this.cfg.tiltMoves && input.tilt ? input.tilt : [0, 0]

    // Movement keys with hysteresis. Gamepad +Y is down, so up is -Y.
    const want = new Set<KeyName>()
    if (move) {
      this.dir.up = hysteresis(this.dir.up, -stick[1], move.press, move.release)
      this.dir.down = hysteresis(this.dir.down, stick[1], move.press, move.release)
      this.dir.left = hysteresis(this.dir.left, -stick[0], move.press, move.release)
      this.dir.right = hysteresis(this.dir.right, stick[0], move.press, move.release)
      for (const d of DIRS) if (this.dir[d]) want.add(move[d])
    }
    if (pad) {
      for (const [name, key] of Object.entries(buttons) as [PadButtonName, KeyName | readonly KeyName[] | undefined][]) {
        if (!key || buttonValue(pad, PadButton[name]) < 0.5) continue
        for (const one of typeof key === 'string' ? [key] : key) want.add(one)
      }
    }
    const keys = this.diff(want)

    // Buttons (the triggers analog) to mouse buttons.
    const wantBtn = new Set<MouseButton>()
    for (const [name, b] of Object.entries(mouse.buttons) as [PadButtonName, MouseButton | undefined][]) {
      const v = pad ? buttonValue(pad, PadButton[name]) : 0
      this.trig[name] = hysteresis(!!this.trig[name], v, mouse.press, mouse.release)
      if (this.trig[name] && b !== undefined) wantBtn.add(b)
    }
    const btnEdges: MouseEdge[] = []
    for (const b of [...this.mouseHeld]) if (!wantBtn.has(b)) { this.mouseHeld.delete(b); btnEdges.push({ button: b, down: false }) }
    for (const b of wantBtn) if (!this.mouseHeld.has(b)) { this.mouseHeld.add(b); btnEdges.push({ button: b, down: true }) }

    // Relative mouse motion: a stick (rate; the right one unless set), phone aim and trackpad (deltas). Aim is + left/up, so negate.
    const dt = clamp(input.dtMs, 0, 100) / 1000
    let dx = -input.aim[0] * mouse.aimGain + input.pad1[0] * mouse.padGain
    let dy = -input.aim[1] * mouse.aimGain + input.pad1[1] * mouse.padGain
    const axes = (s: 'left' | 'right'): [number, number] => (pad ? (s === 'left' ? [pad.axes[0], pad.axes[1]] : [pad.axes[2], pad.axes[3]]) : [0, 0])
    const aim = axes(mouse.stick ?? 'right')
    dx += stickCurve(aim[0], mouse.deadzone, mouse.expo) * mouse.speed * dt
    dy += stickCurve(aim[1], mouse.deadzone, mouse.expo) * mouse.speed * dt
    // A scrolling stick turns the wheel: pushed down scrolls down, as a wheel rolled toward you does.
    const wheel: [number, number] = [0, 0]
    if (scroll) {
      const s = axes(scroll.stick)
      for (const i of [0, 1] as const) {
        const v = stickCurve(s[i], scroll.deadzone, scroll.expo) * scroll.speed * dt + this.wheelCarry[i]
        wheel[i] = Math.trunc(v) || 0
        this.wheelCarry[i] = v - wheel[i]
      }
    }
    return { keys, move: this.acc.take(dx, dy), buttons: btnEdges, wheel }
  }

  /** Release everything (mode change, lost link, deactivation). */
  releaseAll(): KeysOutput {
    const keys = this.diff(new Set())
    const buttons = [...this.mouseHeld].map((button): MouseEdge => ({ button, down: false }))
    this.mouseHeld.clear()
    this.dir = { up: false, down: false, left: false, right: false }
    this.trig = {}
    this.acc.reset()
    this.wheelCarry = [0, 0]
    return { keys, move: [0, 0], buttons, wheel: [0, 0] }
  }

  /** Edges from the held set to `want`: releases first (modifiers last), then presses (modifiers first). */
  private diff(want: Set<KeyName>): KeyEdge[] {
    const ups = [...this.held].filter((key) => !want.has(key))
    const downs = [...want].filter((key) => !this.held.has(key))
    const order: [KeyName, boolean][] = [
      ...ups.filter((key) => !isMod(key)).map((key): [KeyName, boolean] => [key, false]),
      ...ups.filter(isMod).map((key): [KeyName, boolean] => [key, false]),
      ...downs.filter(isMod).map((key): [KeyName, boolean] => [key, true]),
      ...downs.filter((key) => !isMod(key)).map((key): [KeyName, boolean] => [key, true]),
    ]
    return order.map(([key, down]) => {
      if (down) this.held.add(key)
      else this.held.delete(key)
      return { key, down, mods: this.mods }
    })
  }
}

/** KeyboardEvent init for a key edge. Letters are upper-cased while Shift is held, as a real keyboard reports them. */
export function keyInit(name: KeyName, mods: Mods): KeyboardEventInit & { key: string; keyCode: number; which: number; charCode: number } {
  const d: KeyDef = KEYS[name]
  const key = mods.shift && /^[a-z]$/.test(d.key) ? d.key.toUpperCase() : d.key
  return {
    key, code: d.code, location: d.location, keyCode: d.keyCode, which: d.keyCode, charCode: 0,
    shiftKey: mods.shift, ctrlKey: mods.ctrl, altKey: mods.alt, metaKey: false, repeat: false,
    bubbles: true, cancelable: true, composed: true,
  }
}

/** Legacy keypress char code: printable keys and Enter produce one, everything else none (and no keypress). */
export const pressCharCode = (key: string) => (key.length === 1 ? key.charCodeAt(0) : key === 'Enter' ? 13 : 0)
