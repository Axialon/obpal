/**
 * PC target: the phone as this PC's pointer, the way a laptop touchpad and a Wii remote work. Pure: fed the phone's
 * button events and, every tick, its touch state and this tick's pointer motion, it says which mouse buttons to hold,
 * whether to hold Ctrl (zooming is Ctrl + wheel), how far to turn the wheel, and how far to move the pointer. The
 * offscreen link merges that into the frame for ob.Pal Desktop, which only ever sees held state and motion.
 *
 *   Trackpad  tap: click · tap again: double-click · hold: right-click · hold, then move: drag
 *             two fingers: scroll, the page following them, with a flick carrying on · pinch: zoom
 *   Point     A: click where A went down (the pointer holds still while A is down) · keep holding A: right-click
 *             · press A and aim away: drag · hold B and aim: scroll, the page following the pointer · + / −: zoom
 *   Mouse     (the Point face a PC gets) Left and Right: a press held still where it went down, a click when let go,
 *             a drag when aimed away, held as it is when kept down · the wheel: turned by a finger (mouse-wheel
 *             values), tapped for a middle click, held to scroll by aiming (B) · + / −: zoom
 *   Keyboard  the key row (btn key-<code> taps): Esc, Tab, the arrows, Backspace and Enter, each a tap of that key ·
 *             typing (text{s, del}) in order with them: never ahead of a key tapped before it
 *
 * A click is a press held for CLICK_MS then a release held for CLICK_MS, so it spans frames the helper can diff,
 * and a double-click stays inside Windows' double-click time. A key tap is timed the same way.
 *
 * Typing goes out right after the tick's frame, and only after a frame that holds no modifier and no key from the
 * row: ob.Pal Desktop refuses text while a modifier is down, and doesn't retry. It is paced (TEXT_RATE) under the
 * helper's 40 a second, and what waits merges into one request wherever that types the same.
 */
import { MAX_TEXT } from '@obpal/core'

/** MouseEvent.button: 0 left, 1 middle, 2 right. */
export type PcButton = 0 | 1 | 2

export interface GestureTick {
  now: number
  /** The phone is linked; losing it lets go of everything. */
  connected: boolean
  /** A finger is on the phone's trackpad. */
  touching: boolean
  /** This tick's pointer motion from the Keys mapping (aim, trackpad, right stick), whole px. */
  move: readonly [number, number]
  /** Two-finger pan since the last tick, phone px. */
  pan: readonly [number, number]
  /** Pinch since the last tick, log2 of the scale (+ = fingers apart). */
  pinch: number
  /** The frame this tick also holds a modifier from the Keys mapping (Shift, Ctrl, Alt, Meta): typing waits for it. */
  mods?: boolean
}

export interface GestureOut {
  /** Mouse buttons to hold this tick. */
  buttons: PcButton[]
  /** Hold Ctrl this tick: a pinch or + / − zooms. */
  ctrl: boolean
  /** Pointer motion to send, whole px: held still while A decides and during two-finger gestures, scrolling while B grabs. */
  move: [number, number]
  /** Wheel, DOM convention (+y scrolls down), whole 1/120 notch units. */
  wheel: [number, number]
  /** A hold just became a right-click: buzz the phone so the hand knows. */
  buzz: boolean
  /** Keys to hold this tick (a tap from the keyboard's key row), by KeyboardEvent.code. */
  keys: string[]
  /** Typing to send this tick, in order, right after this tick's frame (which then holds no modifier and no key from the row). */
  text: TypedText[]
}

/** Typing from the phone's keyboard: delete `del` characters, then type `s`. */
export interface TypedText { t: 'text'; s: string; del: number }

/** The keys the keyboard's key row taps (btn key-<code>), by KeyboardEvent.code. Nothing else is ever pressed from there. */
export const KEY_TAPS: readonly string[] = ['Escape', 'Tab', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight', 'Backspace', 'Enter']

const MODIFIERS = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'])
/** A held key (KeyboardEvent.code) that is a modifier: while one is down, the helper refuses typing. */
export const isModifier = (code: string) => MODIFIERS.has(code)

/**
 * Two typings as one request, where that types the same: A's text less what B deletes of it, then B's (B deleting
 * past A's text deletes that much more first). It may come to nothing (typing deleted again). Never when B deletes
 * into a newline or tab A typed, which Backspace can't take back (Enter may have sent a message, Tab moved the
 * focus), and never past MAX_TEXT. Null: keep them apart.
 */
export function mergeText(a: TypedText, b: TypedText): TypedText | null {
  if (b.del && /[\n\t]/.test(a.s)) return null
  const typed = Array.from(a.s)
  const s = typed.slice(0, Math.max(0, typed.length - b.del)).join('') + b.s
  const del = a.del + Math.max(0, b.del - typed.length)
  return del <= MAX_TEXT && s.length <= MAX_TEXT ? { t: 'text', s, del } : null
}

/** How long a click's press, and the pause before the next click, last (ms). */
export const CLICK_MS = 30
/** Holding A this long without aiming away is a right-click (ms). */
export const HOLD_MS = 450
/** Pointer travel that turns a held A into a drag, px (the hand shakes a little while pressing). */
export const A_DRAG_PX = 12
/** Pointer travel that turns a trackpad hold into a drag, px. */
export const HOLD_DRAG_PX = 6
/** A 'tap' this soon after A's own press ended is that press, not another click (ms). */
const TAP_ECHO_MS = 600
/** Which two-finger gesture it is: this much pan (px) or pinch (log2) first. */
const PAN_LOCK = 10
const PINCH_LOCK = 0.08
/** Wheel units per px of two-finger pan (120 units scroll about 100 px, so the page moves about twice the fingers). */
export const SCROLL_PER_PX = 2.4
/** Wheel units per px of pointer motion while B grabs. */
export const GRAB_PER_PX = 2
/** Pinch (log2) per zoom step: a pinch to double the finger spread zooms three steps. */
const PINCH_PER_NOTCH = 1 / 3
const NOTCH = 120
/** The most the wheel may turn between two ticks (units): a stalled link catching up doesn't fling the page. */
const WHEEL_MAX = 40 * NOTCH
/** A flick keeps scrolling after the fingers lift when faster than this (units/ms), fading with this time constant (ms). */
const FLING_MIN = 0.6
const FLING_TAU = 330
const FLING_STOP = 0.04
const FLING_MAX_MS = 2500
/**
 * Text requests go out at most this many a second, after a burst of this many: well under the 40 a second ob.Pal
 * Desktop takes (it drops the rest). A keystroke is one, a swiped word one, a long paste one per 256 characters, and
 * whatever has to wait merges.
 */
export const TEXT_RATE = 20
export const TEXT_BURST = 5

type TwoMode = 'none' | 'scroll' | 'zoom'

export class PcGestures {
  private queue: PcButton[] = []
  private click: { button: PcButton; downAt: number; upAt: number } | null = null
  /** Point's A while it is down: where it went down is held until it is a click, a right-click or a drag. */
  private a: { at: number; dx: number; dy: number; decided: boolean; drag: boolean } | null = null
  private aEndedAt = -Infinity
  /** A trackpad hold ('long'), until the finger lifts. */
  private hold: { dx: number; dy: number; drag: boolean } | null = null
  /** Point's B held: aiming scrolls. */
  private grab = false
  /** The mouse face's Left (0) and Right (2) while down: held still where they went down until they mean something. */
  private press: { [B in 0 | 2]?: { at: number; dx: number; dy: number; drag: boolean; held: boolean } } = {}
  /** Wheel units the mouse face's wheel turned since the last tick (+ scrolls down). */
  private turn = 0
  /** The two-finger gesture while fingers are down. */
  private two: { mode: TwoMode; pan: number; pinch: number } | null = null
  private pinchAcc = 0
  /** Zoom steps asked for with + / −: negative zooms in (wheel up). */
  private steps = 0
  private vel: [number, number] = [0, 0]
  private fling: { vx: number; vy: number; at: number } | null = null
  /** Sub-unit wheel left over from earlier ticks. */
  private carry: [number, number] = [0, 0]
  private last = 0
  /** The key row's taps and the typing, in the order they came. */
  private typing: ({ key: string } | TypedText)[] = []
  /** The key tap under way: down for CLICK_MS, then up for CLICK_MS. */
  private key: { code: string; downAt: number; upAt: number } | null = null
  /** Text requests that may go now (refilled at TEXT_RATE a second, up to TEXT_BURST). */
  private textTokens = TEXT_BURST

  /** A button event from the phone (Remote 'button'): the trackpad's taps, the Point face's A, B, + and −, and the key row. */
  button(id: string, ev: string, now: number) {
    if (id.startsWith('key-')) {
      const code = id.slice(4)
      if (ev === 'tap' && KEY_TAPS.includes(code)) this.typing.push({ key: code })
      return
    }
    this.fling = null
    switch (id) {
      case 'pad':
        if (ev === 'tap' || ev === 'double') this.queue.push(0)
        else if (ev === 'long') this.hold = { dx: 0, dy: 0, drag: false }
        return
      case 'wii-a':
        if (ev === 'down') {
          if (!this.a) this.a = { at: now, dx: 0, dy: 0, decided: false, drag: false }
        } else if (ev === 'up') {
          if (this.a && !this.a.decided) this.queue.push(0)
          if (this.a) this.aEndedAt = now
          this.a = null
        } else if (ev === 'tap' && !this.a && now - this.aEndedAt > TAP_ECHO_MS) {
          this.queue.push(0) // a phone that only reports taps
        }
        return
      case 'wii-b':
        if (ev === 'down') this.grab = true
        else if (ev === 'up') this.grab = false
        return
      case 'mouse-left':
      case 'mouse-right': {
        const b = id === 'mouse-left' ? 0 : 2
        if (ev === 'down') this.press[b] ??= { at: now, dx: 0, dy: 0, drag: false, held: false }
        else if (ev === 'up') {
          const p = this.press[b]
          if (p && !p.drag && !p.held) this.queue.push(b)
          delete this.press[b]
        }
        return
      }
      case 'mouse-middle':
        if (ev === 'tap') this.queue.push(1)
        return
      case 'wii-plus':
        if (ev === 'tap') this.steps -= 1
        return
      case 'wii-minus':
        if (ev === 'tap') this.steps += 1
        return
    }
  }

  /** Typing from the phone's keyboard (validated already): it goes out after any key tap that came before it. */
  text(s: string, del: number) {
    const t: TypedText = { t: 'text', s, del }
    const last = this.typing[this.typing.length - 1]
    const merged = last && !('key' in last) ? mergeText(last, t) : null
    if (!merged) this.typing.push(t)
    else if (merged.s || merged.del) this.typing[this.typing.length - 1] = merged
    else this.typing.pop()
  }

  /** The mouse face's wheel turned: wheel units, 120 a notch, + scrolls down. */
  wheel(units: number) {
    if (!Number.isFinite(units)) return
    this.fling = null
    this.turn = Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, this.turn + units))
  }

  tick(t: GestureTick): GestureOut {
    const dt = this.last ? Math.min(100, Math.max(1, t.now - this.last)) : 16
    this.last = t.now
    const out: GestureOut = { buttons: [], ctrl: false, move: [t.move[0], t.move[1]], wheel: [0, 0], buzz: false, keys: [], text: [] }
    if (!t.connected) {
      this.reset()
      out.move = [0, 0]
      return out
    }
    const held = new Set<PcButton>()
    const wheel: [number, number] = [0, 0]

    // Point's A: the pointer holds still where A went down until the press means something.
    const a = this.a
    if (a) {
      if (!a.decided) {
        a.dx += out.move[0]
        a.dy += out.move[1]
        out.move = [0, 0]
        if (Math.hypot(a.dx, a.dy) > A_DRAG_PX) {
          // aimed away: press where A went down, then catch up, in the same frame (the helper presses before it moves)
          a.decided = true
          a.drag = true
          out.move = [a.dx, a.dy]
        } else if (t.now - a.at >= HOLD_MS) {
          a.decided = true
          this.queue.push(2)
          out.buzz = true
        }
      }
      if (a.drag) held.add(0)
    }

    // The mouse face's buttons: like A, held still where they went down; aimed away they drag from there, and kept
    // down without aiming they are simply held (a long press where the pointer is).
    for (const b of [0, 2] as const) {
      const p = this.press[b]
      if (!p) continue
      if (!p.drag && !p.held) {
        p.dx += out.move[0]
        p.dy += out.move[1]
        out.move = [0, 0]
        if (Math.hypot(p.dx, p.dy) > A_DRAG_PX) {
          p.drag = true
          out.move = [p.dx, p.dy]
        } else if (t.now - p.at >= HOLD_MS) p.held = true
      }
      if (p.drag || p.held) held.add(b)
    }

    // A trackpad hold: lifting is a right-click, moving is a drag that starts where the hold was.
    const h = this.hold
    if (h) {
      if (!t.touching) {
        if (!h.drag) this.queue.push(2)
        this.hold = null
      } else {
        if (!h.drag) {
          h.dx += out.move[0]
          h.dy += out.move[1]
          out.move = [0, 0]
          if (Math.hypot(h.dx, h.dy) > HOLD_DRAG_PX) {
            h.drag = true
            out.move = [h.dx, h.dy]
          }
        }
        if (h.drag) held.add(0)
      }
    }

    // Two fingers: scroll or zoom, whichever shows first, for the rest of the touch.
    if (t.touching) {
      this.fling = null
      const pan = Math.hypot(t.pan[0], t.pan[1])
      if (pan || t.pinch) this.two ??= { mode: 'none', pan: 0, pinch: 0 }
      const g = this.two
      if (g) {
        if (g.mode === 'none') {
          g.pan += pan
          g.pinch += Math.abs(t.pinch)
          if (g.pinch > PINCH_LOCK) g.mode = 'zoom'
          else if (g.pan > PAN_LOCK) g.mode = 'scroll'
        }
        if (g.mode === 'scroll') {
          // the page follows the fingers: fingers down scroll up
          const wx = -t.pan[0] * SCROLL_PER_PX
          const wy = -t.pan[1] * SCROLL_PER_PX
          wheel[0] += wx
          wheel[1] += wy
          this.vel = [this.vel[0] * 0.6 + (wx / dt) * 0.4, this.vel[1] * 0.6 + (wy / dt) * 0.4]
        } else if (g.mode === 'zoom') {
          out.ctrl = true
          this.pinchAcc += t.pinch
        }
        if (g.mode !== 'none') out.move = [0, 0] // no pointer drift while two fingers work, or as they lift
      }
    } else {
      if (this.two?.mode === 'scroll' && Math.hypot(this.vel[0], this.vel[1]) > FLING_MIN) {
        this.fling = { vx: this.vel[0], vy: this.vel[1], at: t.now }
      }
      this.two = null
      this.pinchAcc = 0
      this.vel = [0, 0]
    }

    // A flick carries on, fading.
    const f = this.fling
    if (f) {
      const k = Math.exp(-dt / FLING_TAU)
      f.vx *= k
      f.vy *= k
      wheel[0] += f.vx * dt
      wheel[1] += f.vy * dt
      if (Math.hypot(f.vx, f.vy) < FLING_STOP || t.now - f.at > FLING_MAX_MS) this.fling = null
    }

    // Zoom: whole steps, with Ctrl held (a pinch out, or +, zooms in: wheel up).
    while (this.pinchAcc >= PINCH_PER_NOTCH) { wheel[1] -= NOTCH; this.pinchAcc -= PINCH_PER_NOTCH }
    while (this.pinchAcc <= -PINCH_PER_NOTCH) { wheel[1] += NOTCH; this.pinchAcc += PINCH_PER_NOTCH }
    if (this.steps) {
      out.ctrl = true
      wheel[1] += Math.sign(this.steps) * NOTCH
      this.steps -= Math.sign(this.steps)
    }

    // The mouse face's wheel, as turned.
    wheel[1] += this.turn
    this.turn = 0

    // Point's B: aiming scrolls, the page following the pointer, which stays put.
    if (this.grab) {
      wheel[0] -= out.move[0] * GRAB_PER_PX
      wheel[1] -= out.move[1] * GRAB_PER_PX
      out.move = [0, 0]
    }

    // Queued clicks, one at a time: down for CLICK_MS, then up for CLICK_MS.
    if (!this.click && this.queue.length) this.click = { button: this.queue.shift()!, downAt: t.now, upAt: 0 }
    const c = this.click
    if (c) {
      if (!c.upAt && t.now - c.downAt >= CLICK_MS) c.upAt = t.now
      if (!c.upAt) held.add(c.button)
      else if (t.now - c.upAt >= CLICK_MS) this.click = null
    }

    // Whole wheel units now, the rest later.
    for (const i of [0, 1] as const) {
      const v = wheel[i] + this.carry[i]
      out.wheel[i] = Math.trunc(v) || 0
      this.carry[i] = v - out.wheel[i]
    }
    out.buttons = [...held].sort()

    // The key row's taps and the typing, in the order they came: a key down for CLICK_MS, then up for CLICK_MS. Text
    // goes after this tick's frame, so only while it holds no modifier (a zoom's Ctrl, or the Keys mapping's), and
    // no faster than TEXT_RATE; a key after it goes down in the next frame.
    this.textTokens = Math.min(TEXT_BURST, this.textTokens + (dt * TEXT_RATE) / 1000)
    for (;;) {
      const k = this.key
      if (k) {
        if (!k.upAt && t.now - k.downAt >= CLICK_MS) k.upAt = t.now
        if (!k.upAt) { out.keys.push(k.code); break }
        if (t.now - k.upAt < CLICK_MS) break
        this.key = null
      }
      const next = this.typing[0]
      if (!next) break
      if ('key' in next) {
        if (out.text.length) break
        this.typing.shift()
        this.key = { code: next.key, downAt: t.now, upAt: 0 }
        continue
      }
      if (out.ctrl || t.mods || this.textTokens < 1) break
      this.textTokens -= 1
      this.typing.shift()
      out.text.push(next)
    }
    return out
  }

  /** Something is going on that needs frames even without phone input: a click, a drag, a flick, a zoom step, a key tap. */
  get busy() {
    return !!(this.click || this.queue.length || this.a?.drag || this.hold?.drag || this.grab || this.fling || this.steps || this.a || this.press[0] || this.press[2] || this.turn || this.key || this.typing.length)
  }

  /** Let go of everything: the phone went away, or the PC target was left. */
  reset() {
    this.queue = []
    this.click = null
    this.a = null
    this.hold = null
    this.grab = false
    this.press = {}
    this.turn = 0
    this.two = null
    this.pinchAcc = 0
    this.steps = 0
    this.vel = [0, 0]
    this.fling = null
    this.carry = [0, 0]
    this.typing = []
    this.key = null
    this.textTokens = TEXT_BURST
  }
}
