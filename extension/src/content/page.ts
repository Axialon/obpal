/**
 * MAIN-world page script, injected by the service worker into each bridged frame of the controlled tab.
 * It runs in the page's own JavaScript realm, which is what lets it
 *   (a) patch navigator.getGamepads with the phone's virtual controller (the @obpal/host shim), and
 *   (b, c) dispatch pointer, wheel and keyboard events whose legacy fields (keyCode, which) page code can read.
 * It listens only to its own frame's bridge: same window, same origin, CHANNEL, and the session id it bound to.
 */
import type { PadState } from '@obpal/core'
import { installGamepadShim } from '@obpal/host/gamepad'
import { MIN_VIEW_AREA, PAGE_VERSION, TARGET_MODES, type TargetMode } from '../shared/constants'
import { KeyMapper, keyInit, pressCharCode, type KeyEdge, type KeysOutput, type Mods, type MouseButton } from '../shared/keys'
import { clamp, type PadInput } from '../shared/math'
import { envelope, readDown, type DeltaTuple, type InputFrame, type PadTuple, type UpMsg } from '../shared/messages'
import { DragSynth, viewerMotion, type Deltas, type Rect, type SynthEvent } from '../shared/viewer'
import { deepActiveElement, deepElementFromPoint, largestView } from './dom'

interface PageHandle { version: number; announce: () => void; destroy: () => void }

/** Chrome's real mouse is pointer 1, so page calls like setPointerCapture(e.pointerId) keep working. */
const POINTER_ID = 1
const ZERO: readonly [number, number] = [0, 0]
const NO_MODS: Mods = { shift: false, ctrl: false, alt: false }

const padInput = (p: PadTuple | null): PadInput | null => (p ? { buttons: p[0], axes: [p[1], p[2], p[3], p[4]], triggers: [p[5], p[6]] } : null)
const deltasOf = (d: DeltaTuple | null): Deltas | null => (d ? { aim: [d[0], d[1]], pad1: [d[2], d[3]], pad2: [d[4], d[5]], zoom: d[6] } : null)
/** Chrome only reveals a controller after a button press or a big stick push; the virtual one behaves the same. */
const gesture = (p: PadTuple) => p[0] !== 0 || p.slice(1, 5).some((v) => Math.abs(v) > 0.5) || p[5] > 0.5 || p[6] > 0.5
const hit = (x: number, y: number): Element => deepElementFromPoint(x, y) ?? document.body ?? document.documentElement

function createPage(): PageHandle {
  const origin = location.origin
  const targetOrigin = /^https?:$/.test(location.protocol) ? origin : '*'
  let sid: string | null = null
  let mode: TargetMode | null = null
  let lastFrameAt = 0
  let watchdog: ReturnType<typeof setInterval> | undefined
  let mods: Mods = NO_MODS

  const post = (m: UpMsg, s = sid ?? '') => window.postMessage(envelope(s, 'up', m), targetOrigin)

  // ---- (a) Controller: navigator.getGamepads shim ------------------------------------------------

  let pad: PadState | null = null
  let exposed = false
  let seq = 0
  let shim: { uninstall: () => void; timer: ReturnType<typeof setTimeout> | undefined } | null = null
  const source = {
    get: () => (exposed ? pad : null),
    // vibrationActuator.playEffect() in the page lands here and goes back to the phone.
    rumble: (s: number, w: number, ms: number) => { if (sid) post({ t: 'rumble', s, w, ms }) },
  }

  function setPad(p: PadTuple | null) {
    if (!shim) shim = { uninstall: installGamepadShim(source), timer: undefined }
    clearTimeout(shim.timer)
    shim.timer = undefined
    if (!p) {
      pad = null
      exposed = false
      return
    }
    seq = (seq + 1) & 0xffff
    pad = { flags: 0, seq, t: Math.round(performance.now() * 1000) >>> 0, buttons: p[0], axes: [p[1], p[2], p[3], p[4]], triggers: [p[5], p[6]] }
    // Games that wait for gamepadconnected must have registered their listener: expose after load, on a press.
    if (!exposed && document.readyState !== 'loading' && gesture(p)) exposed = true
  }

  /** Unplug the virtual pad: the shim's frame loop fires gamepaddisconnected, then the native API comes back. */
  function dropPad() {
    pad = null
    exposed = false
    const s = shim
    if (!s || s.timer !== undefined) return
    s.timer = setTimeout(() => {
      s.uninstall()
      if (shim === s) shim = null
    }, 250)
  }

  // ---- shared pointer dispatch -------------------------------------------------------------------

  let compatBlocked = false

  function pointer(ptype: string, mtype: string, target: EventTarget, x: number, y: number, dx: number, dy: number, button: number, buttons: number, shift = false) {
    const init: PointerEventInit = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y,
      screenX: window.screenX + x, screenY: window.screenY + Math.max(0, window.outerHeight - window.innerHeight) + y,
      movementX: dx, movementY: dy, button, buttons,
      shiftKey: shift || mods.shift, ctrlKey: mods.ctrl, altKey: mods.alt, metaKey: false,
      pointerId: POINTER_ID, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
    }
    const ok = target.dispatchEvent(new PointerEvent(ptype, init))
    if (ptype === 'pointerdown') compatBlocked = !ok
    // Browsers follow pointer events with compatibility mouse events unless the page cancelled pointerdown.
    if (!compatBlocked) target.dispatchEvent(new MouseEvent(mtype, { ...init, button: Math.max(0, button) }))
    if (ptype === 'pointerup') compatBlocked = false
    return init
  }

  function wheel(target: EventTarget, x: number, y: number, deltaY: number) {
    target.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y,
      screenX: window.screenX + x, screenY: window.screenY + Math.max(0, window.outerHeight - window.innerHeight) + y,
      deltaX: 0, deltaY, deltaZ: 0, deltaMode: 0, shiftKey: mods.shift, ctrlKey: mods.ctrl, altKey: mods.alt,
    }))
  }

  // ---- (b) 3D viewer: drag to rotate, right-drag to pan, wheel to zoom --------------------------

  const synth = new DragSynth()
  let area: Rect | null = null
  let areaAt = 0
  let downTarget: Element | null = null
  let synthTimer: ReturnType<typeof setInterval> | undefined

  /** The largest visible canvas / model-viewer, else the viewport (so the element under its centre). */
  function viewArea(now: number): Rect {
    if (!area || now - areaAt > 500) {
      const v = largestView()
      area = v && v.area >= MIN_VIEW_AREA ? v.rect : { left: 0, top: 0, width: innerWidth, height: innerHeight }
      areaAt = now
    }
    return area
  }

  function runViewer(f: InputFrame, now: number) {
    const motion = viewerMotion({ pad: padInput(f.p), deltas: deltasOf(f.d), tilt: f.tl, dtMs: f.dt })
    fire(synth.step(now, motion, viewArea(now)))
    if (synth.busy && synthTimer === undefined) {
      // Frames stop when input stops, so a timer lifts the button after the idle delay.
      synthTimer = setInterval(() => {
        fire(synth.tick(performance.now()))
        if (!synth.busy) {
          clearInterval(synthTimer)
          synthTimer = undefined
        }
      }, 30)
    }
  }

  function fire(events: SynthEvent[]) {
    for (const e of events) {
      if (e.type === 'wheel') {
        wheel(hit(e.x, e.y), e.x, e.y, e.deltaY)
        continue
      }
      // Like the hit test of a real mouse (overlays included), then every move and the release go to that target.
      if (e.type === 'down') downTarget = hit(e.x, e.y)
      const t = downTarget?.isConnected ? downTarget : hit(e.x, e.y)
      if (e.type === 'down') pointer('pointerdown', 'mousedown', t, e.x, e.y, 0, 0, e.button, e.buttons, e.shift)
      else if (e.type === 'move') pointer('pointermove', 'mousemove', t, e.x, e.y, e.dx, e.dy, -1, e.buttons, e.shift)
      else {
        pointer('pointerup', 'mouseup', t, e.x, e.y, 0, 0, e.button, 0, e.shift)
        downTarget = null
      }
    }
  }

  // ---- (c) Keys: keyboard, plus a relative mouse on the right stick / triggers -------------------

  const mapper = new KeyMapper()
  const cursor = { x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) }
  let mouseButtons = 0
  let mouseDown: Element | null = null
  let dot: HTMLElement | null = null
  let dotTimer: ReturnType<typeof setTimeout> | undefined

  function runKeys(f: InputFrame) {
    const d = f.d
    applyKeys(mapper.update({ pad: padInput(f.p), tilt: f.tl, aim: d ? [d[0], d[1]] : ZERO, pad1: d ? [d[2], d[3]] : ZERO, dtMs: f.dt }))
  }

  function applyKeys(out: KeysOutput) {
    for (const e of out.keys) key(e)
    if (out.move[0] || out.move[1]) mouseMove(out.move[0], out.move[1])
    for (const b of out.buttons) mouseButton(b.button, b.down)
  }

  /** A real keyboard's target: the focused element (else body); the event bubbles on to document and window. */
  function key(e: KeyEdge) {
    mods = e.mods
    const init = keyInit(e.key, e.mods)
    const a = deepActiveElement()
    const target: EventTarget = a?.isConnected ? a : document.body ?? window
    fireKey(target, e.down ? 'keydown' : 'keyup', init)
    const cc = e.down ? pressCharCode(init.key) : 0
    if (cc) fireKey(target, 'keypress', { ...init, keyCode: cc, which: cc, charCode: cc })
  }

  function fireKey(target: EventTarget, type: string, init: ReturnType<typeof keyInit>) {
    const ev = new KeyboardEvent(type, init)
    // Chromium ignores the legacy fields in KeyboardEventInit, so pin them on the event for page code to read.
    for (const f of ['keyCode', 'which', 'charCode'] as const) {
      const v = init[f]
      if (ev[f] !== v) Object.defineProperty(ev, f, { get: () => v })
    }
    target.dispatchEvent(ev)
  }

  function mouseTarget(): Element {
    return document.pointerLockElement ?? (mouseButtons && mouseDown?.isConnected ? mouseDown : hit(cursor.x, cursor.y))
  }

  function mouseMove(dx: number, dy: number) {
    // Under pointer lock only movementX/Y matter; otherwise a virtual cursor moves over the page.
    if (!document.pointerLockElement) {
      cursor.x = clamp(cursor.x + dx, 0, innerWidth - 1)
      cursor.y = clamp(cursor.y + dy, 0, innerHeight - 1)
      showCursor()
    }
    pointer('pointermove', 'mousemove', mouseTarget(), cursor.x, cursor.y, dx, dy, -1, mouseButtons)
  }

  function mouseButton(b: MouseButton, down: boolean) {
    const bit = b === 0 ? 1 : b === 2 ? 2 : 4
    const before = mouseButtons
    mouseButtons = down ? before | bit : before & ~bit
    if (down && !before) mouseDown = document.pointerLockElement ?? hit(cursor.x, cursor.y)
    const t = mouseDown?.isConnected ? mouseDown : mouseTarget()
    // Pointer Events: first button down / last button up are pointerdown / pointerup; chorded changes are pointermove.
    const edge = down ? before === 0 : mouseButtons === 0
    const ptype = edge ? (down ? 'pointerdown' : 'pointerup') : 'pointermove'
    const init = pointer(ptype, down ? 'mousedown' : 'mouseup', t, cursor.x, cursor.y, 0, 0, b, mouseButtons)
    if (!down && b === 0 && (document.pointerLockElement || t.contains(hit(cursor.x, cursor.y)))) {
      t.dispatchEvent(new MouseEvent('click', { ...init, button: 0, buttons: mouseButtons, detail: 1 }))
    }
    if (!mouseButtons) mouseDown = null
  }

  /** A small lime dot shows where the virtual mouse is (not under pointer lock); it fades when the mouse rests. */
  function showCursor() {
    if (!(document.documentElement instanceof HTMLElement)) return // SVG or XML documents: no overlay
    if (!dot) {
      dot = document.createElement('obpal-link-cursor')
      const css: Record<string, string> = {
        position: 'fixed', left: '0', top: '0', width: '14px', height: '14px', margin: '-7px 0 0 -7px', display: 'block',
        'border-radius': '50%', background: '#c6ff34', 'box-shadow': '0 0 0 2px rgba(10,10,10,.85), 0 0 14px rgba(198,255,52,.75)',
        'pointer-events': 'none', 'z-index': '2147483647', transition: 'opacity .25s',
      }
      for (const [k, v] of Object.entries(css)) dot.style.setProperty(k, v, 'important')
      document.documentElement.appendChild(dot)
    }
    dot.style.setProperty('transform', `translate(${cursor.x}px, ${cursor.y}px)`, 'important')
    dot.style.setProperty('opacity', '1', 'important')
    clearTimeout(dotTimer)
    dotTimer = setTimeout(() => dot?.style.setProperty('opacity', '0', 'important'), 1500)
  }

  function hideCursor() {
    clearTimeout(dotTimer)
    dot?.remove()
    dot = null
  }

  // ---- frames, release, lifecycle ------------------------------------------------------------------

  function onFrame(f: InputFrame) {
    const now = performance.now()
    lastFrameAt = now
    const next = TARGET_MODES[f.m]
    if (next !== mode) {
      release()
      mode = next
    }
    if (mode === 'gamepad') setPad(f.p)
    else if (mode === 'viewer') runViewer(f, now)
    else runKeys(f)
    if (watchdog === undefined) watchdog = setInterval(checkStale, 250)
  }

  /** Frames only stop when the link is gone, so release held input rather than leave keys or buttons stuck. */
  function checkStale() {
    if (performance.now() - lastFrameAt < (mode === 'gamepad' ? 1500 : 600)) return
    release()
    clearInterval(watchdog)
    watchdog = undefined
  }

  /** Let go of everything held in any mode: keys, mouse buttons, a drag, the virtual pad. */
  function release() {
    fire(synth.reset())
    applyKeys(mapper.releaseAll())
    mods = NO_MODS
    if (pad || shim) dropPad()
    hideCursor()
  }

  function onMessage(e: MessageEvent) {
    if (e.source !== window || e.origin !== origin) return
    const msg = readDown(e.data)
    if (!msg) return
    const m = msg.m
    if (m.t === 'hello') {
      // A new bridge (extension reloaded, frame re-bridged) takes over; drop what the old one was driving.
      if (msg.sid !== sid) {
        release()
        sid = msg.sid
      }
      post({ t: 'ready', v: PAGE_VERSION })
      return
    }
    if (msg.sid !== sid) return
    if (m.t === 'in') onFrame(m)
    else if (m.t === 'rel') release()
    else {
      release()
      mode = null
      sid = null
    }
  }

  addEventListener('message', onMessage, true)
  post({ t: 'loaded', v: PAGE_VERSION }, '')

  return {
    version: PAGE_VERSION,
    announce: () => post({ t: 'loaded', v: PAGE_VERSION }, ''),
    destroy: () => {
      release()
      removeEventListener('message', onMessage, true)
      clearInterval(watchdog)
      clearInterval(synthTimer)
      sid = null
    },
  }
}

// One instance per frame. A re-injection re-announces the live instance; a newer build replaces an older one.
const HANDLE = Symbol.for('obpal-link.page')
const slot = window as unknown as Record<symbol, PageHandle | undefined>
const existing = slot[HANDLE]
if (existing?.version === PAGE_VERSION) existing.announce()
else {
  existing?.destroy?.()
  slot[HANDLE] = createPage()
}
