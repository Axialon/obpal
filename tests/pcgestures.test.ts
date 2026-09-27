import { describe, expect, it } from 'vitest'
import {
  A_DRAG_PX, CLICK_MS, GRAB_PER_PX, HOLD_MS, KEY_TAPS, PcGestures, SCROLL_PER_PX, TEXT_BURST, TEXT_RATE, type GestureOut, type GestureTick,
} from '../extension/src/shared/pcgestures'

/** A tick at `now` ms: linked, no touch, no motion unless given. */
const at = (now: number, over: Partial<GestureTick> = {}): GestureTick => ({ now, connected: true, touching: false, move: [0, 0], pan: [0, 0], pinch: 0, ...over })

/** Run ticks every 16 ms from `from` to `to` (inclusive) and collect what each held. */
function run(g: PcGestures, from: number, to: number, over: (t: number) => Partial<GestureTick> = () => ({})): GestureOut[] {
  const outs: GestureOut[] = []
  for (let t = from; t <= to; t += 16) outs.push(g.tick(at(t, over(t))))
  return outs
}
/** The button edges a run produces, as the helper would diff them: 'b0+', 'b0-', ... */
function edges(outs: GestureOut[]): string[] {
  const out: string[] = []
  let held = new Set<number>()
  for (const o of outs) {
    const now = new Set<number>(o.buttons)
    for (const b of held) if (!now.has(b)) out.push(`b${b}-`)
    for (const b of now) if (!held.has(b)) out.push(`b${b}+`)
    held = now
  }
  return out
}
/** The key edges and typing a run produces, in the order the helper sees them ('Enter+', 'Enter-', 'hi', '-1x'): each frame, then its typing. */
function keyEvents(outs: GestureOut[]): string[] {
  const out: string[] = []
  let held = new Set<string>()
  for (const o of outs) {
    const now = new Set(o.keys)
    for (const k of held) if (!now.has(k)) out.push(`${k}-`)
    for (const k of now) if (!held.has(k)) out.push(`${k}+`)
    held = now
    for (const t of o.text) out.push(`${t.del ? `-${t.del}` : ''}${t.s}`)
  }
  return out
}
/** What typing leaves in a field, Backspace deleting a character (code point) at a time. */
const typeInto = (field: string, texts: { s: string; del: number }[]) =>
  texts.reduce((f, t) => { const cs = Array.from(f); return cs.slice(0, Math.max(0, cs.length - t.del)).join('') + t.s }, field)
const wheelOf = (outs: GestureOut[]) => outs.reduce((w, o) => [w[0] + o.wheel[0], w[1] + o.wheel[1]], [0, 0])
const moveOf = (outs: GestureOut[]) => outs.reduce((w, o) => [w[0] + o.move[0], w[1] + o.move[1]], [0, 0])

describe('PC gestures: the trackpad', () => {
  it('a tap is a click that spans frames; a second tap makes it a double-click', () => {
    const g = new PcGestures()
    g.button('pad', 'tap', 0)
    const first = run(g, 0, 96)
    expect(edges(first)).toEqual(['b0+', 'b0-'])
    // held for CLICK_MS, not more than a couple of ticks past it
    const down = first.filter((o) => o.buttons.includes(0)).length * 16
    expect(down).toBeGreaterThanOrEqual(CLICK_MS)
    expect(down).toBeLessThanOrEqual(CLICK_MS + 32)
    g.button('pad', 'tap', 200)
    g.button('pad', 'double', 210)
    const both = run(g, 200, 400)
    expect(edges(both)).toEqual(['b0+', 'b0-', 'b0+', 'b0-'])
    // both presses land well inside Windows' 500 ms double-click time
    const downs = both.map((o, i) => (o.buttons.includes(0) && !(both[i - 1]?.buttons.includes(0)) ? 200 + i * 16 : -1)).filter((t) => t >= 0)
    expect(downs[1] - downs[0]).toBeLessThan(200)
    expect(g.busy).toBe(false)
  })

  it('holding, then lifting, is a right-click; holding, then moving, drags from where the hold was', () => {
    const g = new PcGestures()
    g.button('pad', 'long', 0)
    const held = run(g, 0, 48, () => ({ touching: true }))
    expect(edges(held)).toEqual([])
    const lift = run(g, 64, 160)
    expect(edges(lift)).toEqual(['b2+', 'b2-'])

    const d = new PcGestures()
    d.button('pad', 'long', 0)
    // a little travel is held back until it is a drag, then the press comes first and the travel catches up
    const small = d.tick(at(0, { touching: true, move: [2, 1] }))
    expect(small.move).toEqual([0, 0])
    expect(small.buttons).toEqual([])
    const start = d.tick(at(16, { touching: true, move: [5, 3] }))
    expect(start.buttons).toEqual([0])
    expect(start.move).toEqual([7, 4])
    const drag = run(d, 32, 96, () => ({ touching: true, move: [4, 0] }))
    expect(drag.every((o) => o.buttons.includes(0))).toBe(true)
    expect(moveOf(drag)).toEqual([20, 0])
    const end = run(d, 112, 160)
    expect(end.every((o) => o.buttons.length === 0)).toBe(true)
  })

  it('two fingers scroll, the page following them, and a flick carries on and fades', () => {
    const g = new PcGestures()
    // fingers moving down the phone: the page moves down, which is scrolling up (negative DOM deltaY)
    const scroll = run(g, 0, 160, () => ({ touching: true, pan: [0, 6], move: [1, 1] }))
    const [wx, wy] = wheelOf(scroll)
    expect(wx).toBe(0)
    expect(wy).toBeLessThan(0)
    // the first 10 px decide it is a scroll; after that every px scrolls SCROLL_PER_PX units
    expect(Math.abs(wy)).toBeGreaterThan(6 * 9 * SCROLL_PER_PX)
    // no pointer drift while two fingers work
    expect(moveOf(scroll.slice(2))).toEqual([0, 0])
    // lifting mid-flick keeps scrolling the same way, less and less, then stops
    const fling = run(g, 176, 3000)
    const steps = fling.map((o) => o.wheel[1])
    expect(steps[0]).toBeLessThan(0)
    expect(Math.abs(steps[10])).toBeLessThan(Math.abs(steps[0]))
    expect(steps.slice(-20).every((w) => w === 0)).toBe(true)
    // a touch stops a flick at once
    run(g, 3100, 3200, () => ({ touching: true, pan: [0, 8] }))
    expect(run(g, 3216, 3248)[0].wheel[1]).toBeLessThan(0)
    g.tick(at(3264, { touching: true }))
    expect(g.tick(at(3280, { touching: true })).wheel).toEqual([0, 0])
  })

  it('a pinch zooms in whole steps with Ctrl held, and stays a zoom for the rest of the touch', () => {
    const g = new PcGestures()
    // fingers apart: zoom in, which is wheel up with Ctrl
    const zoom = run(g, 0, 160, (t) => ({ touching: true, pinch: 0.05, pan: t > 80 ? [0, 12] : [0, 0] }))
    expect(zoom.slice(2).every((o) => o.ctrl)).toBe(true)
    const wheel = wheelOf(zoom)
    expect(wheel[0]).toBe(0)
    expect(wheel[1] % 120 === 0).toBe(true)
    expect(wheel[1]).toBeLessThanOrEqual(-120)
    // the pan that followed did not turn it into a scroll: every wheel turn is a whole zoom step
    expect(zoom.every((o) => o.wheel[1] % 120 === 0)).toBe(true)
    const after = run(g, 176, 208)
    expect(after.every((o) => !o.ctrl)).toBe(true)
  })
})

describe('PC gestures: the Point face', () => {
  it('A clicks where it went down: the pointer holds still while A is down', () => {
    const g = new PcGestures()
    g.button('wii-a', 'down', 0)
    const pressed = run(g, 0, 160, (t) => ({ move: t % 32 ? [3, -2] : [-3, 2] })) // the hand shakes as the thumb presses
    expect(moveOf(pressed)).toEqual([0, 0])
    expect(edges(pressed)).toEqual([])
    g.button('wii-a', 'up', 170)
    g.button('wii-a', 'tap', 175) // the phone's own tap for the same press
    const after = run(g, 176, 400)
    expect(edges(after)).toEqual(['b0+', 'b0-'])
    // an older phone that reports only taps still clicks
    g.button('wii-a', 'tap', 2000)
    expect(edges(run(g, 2000, 2100))).toEqual(['b0+', 'b0-'])
  })

  it('holding A still is a right-click, with a buzz; the pointer is free again for the menu', () => {
    const g = new PcGestures()
    g.button('wii-a', 'down', 0)
    const outs = run(g, 0, HOLD_MS + 200, (t) => ({ move: t > HOLD_MS + 60 ? [3, 3] : [0, 0] }))
    expect(outs.filter((o) => o.buzz).length).toBe(1)
    expect(edges(outs)).toEqual(['b2+', 'b2-'])
    expect(moveOf(outs)[0]).toBeGreaterThan(0)
    g.button('wii-a', 'up', HOLD_MS + 220)
    expect(edges(run(g, HOLD_MS + 224, HOLD_MS + 400))).toEqual([])
  })

  it('pressing A and aiming away drags from where A went down', () => {
    const g = new PcGestures()
    g.button('wii-a', 'down', 0)
    const outs = run(g, 0, 160, () => ({ move: [5, 0] }))
    const start = outs.findIndex((o) => o.buttons.includes(0))
    expect(start).toBeGreaterThan(0)
    // the press comes with the travel held back so far, so the drag starts where A went down
    expect(outs[start].move[0]).toBeGreaterThan(A_DRAG_PX)
    expect(moveOf(outs)).toEqual([5 * outs.length, 0])
    g.button('wii-a', 'up', 170)
    expect(run(g, 176, 208).every((o) => o.buttons.length === 0)).toBe(true)
  })

  it('holding B turns aiming into scrolling, the page following the pointer; + and − zoom a step each', () => {
    const g = new PcGestures()
    g.button('wii-b', 'down', 0)
    const grab = run(g, 0, 48, () => ({ move: [0, 10] }))
    expect(moveOf(grab)).toEqual([0, 0])
    expect(wheelOf(grab)).toEqual([0, -10 * GRAB_PER_PX * grab.length])
    g.button('wii-b', 'up', 60)
    expect(moveOf(run(g, 64, 64, () => ({ move: [0, 10] })))).toEqual([0, 10])
    g.button('wii-plus', 'tap', 100)
    g.button('wii-plus', 'tap', 101)
    g.button('wii-minus', 'tap', 102)
    const zoom = run(g, 112, 176)
    expect(zoom.slice(0, 1).every((o) => o.ctrl && o.wheel[1] === -120)).toBe(true)
    expect(wheelOf(zoom)).toEqual([0, -120])
    expect(zoom[zoom.length - 1].ctrl).toBe(false)
  })

  it('lets go of everything when the phone goes away', () => {
    const g = new PcGestures()
    g.button('wii-b', 'down', 0)
    g.button('pad', 'long', 0)
    g.button('wii-a', 'down', 0)
    run(g, 0, 32, () => ({ touching: true, move: [20, 0] }))
    expect(g.busy).toBe(true)
    const gone = g.tick(at(48, { connected: false, touching: true, move: [9, 9] }))
    expect(gone).toEqual({ buttons: [], ctrl: false, move: [0, 0], wheel: [0, 0], buzz: false, keys: [], text: [] })
    expect(g.busy).toBe(false)
    expect(run(g, 64, 96, () => ({ move: [1, 0] })).every((o) => o.buttons.length === 0)).toBe(true)
  })
})

describe('PC gestures: the keyboard (the key row, and typing)', () => {
  it('taps a key from the row: down for CLICK_MS, then up; only the row’s own keys', () => {
    const g = new PcGestures()
    g.button('key-Enter', 'tap', 0)
    const outs = run(g, 0, 96)
    expect(keyEvents(outs)).toEqual(['Enter+', 'Enter-'])
    const down = outs.filter((o) => o.keys.includes('Enter')).length * 16
    expect(down).toBeGreaterThanOrEqual(CLICK_MS)
    expect(down).toBeLessThanOrEqual(CLICK_MS + 32)
    // the same key twice: two taps, apart
    g.button('key-ArrowLeft', 'tap', 200)
    g.button('key-ArrowLeft', 'tap', 201)
    expect(keyEvents(run(g, 200, 400))).toEqual(['ArrowLeft+', 'ArrowLeft-', 'ArrowLeft+', 'ArrowLeft-'])
    // every key on the row, and nothing else: no letters, no modifiers, no F-keys, only taps
    for (const code of KEY_TAPS) g.button(`key-${code}`, 'tap', 500)
    for (const id of ['key-KeyA', 'key-MetaLeft', 'key-ControlLeft', 'key-F4', 'key-', 'key-enter']) g.button(id, 'tap', 500)
    g.button('key-Enter', 'down', 500)
    const all = keyEvents(run(g, 500, 1200)).filter((e) => e.endsWith('+')).map((e) => e.slice(0, -1))
    expect(all).toEqual([...KEY_TAPS])
    expect(g.busy).toBe(false)
  })

  it('sends typing in order with the key taps, each right after a frame: never ahead of a key tapped before it', () => {
    const g = new PcGestures()
    g.text('hello', 0)
    g.button('key-Enter', 'tap', 0)
    g.text('x', 0)
    const outs = run(g, 0, 300)
    expect(keyEvents(outs)).toEqual(['hello', 'Enter+', 'Enter-', 'x'])
    // the key goes down in the frame after the typing, never in the frame the typing follows
    const typed = outs.findIndex((o) => o.text.length)
    expect(outs[typed].keys).toEqual([])
    // typing that comes while a key is down waits for it to come up
    g.button('key-ArrowLeft', 'tap', 400)
    const down = g.tick(at(400))
    g.text('a', 0)
    expect(keyEvents([down, ...run(g, 416, 600)])).toEqual(['ArrowLeft+', 'ArrowLeft-', 'a'])
  })

  it('holds typing back while the frame holds a modifier (a zoom’s Ctrl, or the Keys mapping’s Shift), and sends it after one without', () => {
    const g = new PcGestures()
    g.text('hi', 0)
    const held = run(g, 0, 160, () => ({ mods: true }))
    expect(held.every((o) => o.text.length === 0)).toBe(true)
    // more typing while it waits merges with it
    g.text('!', 0)
    const free = run(g, 176, 176)
    expect(free[0].text).toEqual([{ t: 'text', s: 'hi!', del: 0 }])
    // a pinch holds Ctrl for a zoom: typing waits for the zoom to end
    const z = new PcGestures()
    const pinch = () => ({ touching: true, pinch: 0.05 })
    run(z, 0, 32, pinch)
    z.text('a', 0)
    const zoom = run(z, 48, 160, pinch)
    expect(zoom.every((o) => o.ctrl && !o.text.length)).toBe(true)
    const after = run(z, 176, 240)
    expect(after.flatMap((o) => o.text).map((t) => t.s)).toEqual(['a'])
    expect(after.find((o) => o.text.length)?.ctrl).toBe(false)
  })

  it('merges typing that waits wherever it types the same, but never deletes across Enter or Tab', () => {
    const g = new PcGestures()
    const waits = { mods: true }
    g.text('teh', 0)
    g.text('he ', 2) // autocorrect: "teh" → "the "
    g.text('', 1)
    g.text('', 4) // past what was typed: deletes one more
    g.text('ok', 0)
    run(g, 0, 32, () => waits)
    const [merged] = run(g, 48, 48)
    expect(merged.text).toEqual([{ t: 'text', s: 'ok', del: 1 }])
    expect(typeInto('xy', merged.text)).toBe(typeInto('xy', [{ s: 'teh', del: 0 }, { s: 'he ', del: 2 }, { s: '', del: 1 }, { s: '', del: 4 }, { s: 'ok', del: 0 }]))
    // typed and deleted again while waiting: nothing goes at all
    g.text('abc', 0)
    g.text('', 3)
    expect(g.busy).toBe(false)
    // Enter or Tab typed can't be taken back by merging a Backspace into it; typing after it still joins
    g.text('sent\n', 0)
    g.text('', 1)
    g.text('next', 0)
    g.text('\tcell', 0)
    run(g, 64, 96, () => waits)
    const later = run(g, 112, 400).flatMap((o) => o.text)
    expect(later).toEqual([{ t: 'text', s: 'sent\n', del: 0 }, { t: 'text', s: 'next\tcell', del: 1 }])
  })

  it('keeps well under the helper’s 40 requests a second, typing everything, in order', () => {
    const g = new PcGestures()
    // requests that can't merge: a line, then a Backspace into it, over and over
    const sent: { s: string; del: number }[] = []
    for (let i = 0; i < 60; i++) { sent.push({ s: `${i}\n`, del: 0 }, { s: '', del: 1 }) }
    for (const t of sent) g.text(t.s, t.del)
    const outs = run(g, 0, 4000)
    const texts = outs.flatMap((o) => o.text)
    for (let second = 0; second < 4; second++) {
      const n = outs.slice(Math.round((second * 1000) / 16), Math.round(((second + 1) * 1000) / 16)).reduce((c, o) => c + o.text.length, 0)
      expect(n).toBeLessThanOrEqual(TEXT_BURST + TEXT_RATE)
    }
    expect(Math.max(...outs.map((o) => o.text.length))).toBeLessThanOrEqual(TEXT_BURST)
    expect(typeInto('', texts)).toBe(typeInto('', sent))
    expect(g.busy).toBe(false)
  })

  it('merges only what types the same (a random walk of typing, deleting and Enter)', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let trial = 0; trial < 200; trial++) {
      const g = new PcGestures()
      const sent: { s: string; del: number }[] = []
      for (let i = 0; i < 12; i++) {
        const s = ['', 'a', 'bc', 'é', '😀', '\n', 'x\ty'][Math.floor(rnd() * 7)]
        const del = Math.floor(rnd() * 4)
        if (!s && !del) continue
        sent.push({ s, del })
        g.text(s, del)
      }
      run(g, 0, 48, () => ({ mods: true }))
      const texts = run(g, 64, 2000).flatMap((o) => o.text)
      expect(typeInto('start', texts), JSON.stringify(sent)).toBe(typeInto('start', sent))
      expect(texts.every((t) => t.s || t.del)).toBe(true)
    }
  })

  it('lets go of waiting keys and typing when the phone goes away', () => {
    const g = new PcGestures()
    g.button('key-Enter', 'tap', 0)
    g.text('lost', 0)
    g.tick(at(0))
    expect(g.busy).toBe(true)
    expect(g.tick(at(16, { connected: false }))).toMatchObject({ keys: [], text: [] })
    expect(g.busy).toBe(false)
    expect(run(g, 32, 200).every((o) => !o.keys.length && !o.text.length)).toBe(true)
  })
})

describe('PC gestures: the mouse face (Point on a PC)', () => {
  it('Left and Right click where they went down: the pointer holds still while they are pressed', () => {
    const g = new PcGestures()
    g.button('mouse-left', 'down', 0)
    const pressed = run(g, 0, 160, () => ({ move: [1, 0] }))
    expect(moveOf(pressed)).toEqual([0, 0])
    g.button('mouse-left', 'up', 170)
    expect(edges(run(g, 176, 272))).toEqual(['b0+', 'b0-'])
    g.button('mouse-right', 'down', 300)
    g.button('mouse-right', 'up', 360)
    expect(edges(run(g, 300, 460))).toEqual(['b2+', 'b2-'])
    expect(g.busy).toBe(false)
  })
  it('Left pressed and aimed away drags from where it went down; let go, it lets go', () => {
    const g = new PcGestures()
    g.button('mouse-left', 'down', 0)
    const outs = run(g, 0, 160, () => ({ move: [4, 0] }))
    expect(edges(outs)).toEqual(['b0+'])
    // the press comes first, then all the travel so far catches up
    const first = outs.findIndex((o) => o.buttons.includes(0))
    expect(outs[first].move[0]).toBeGreaterThan(A_DRAG_PX)
    expect(moveOf(outs)[0]).toBe(4 * outs.length)
    g.button('mouse-left', 'up', 170)
    expect(run(g, 176, 208).every((o) => o.buttons.length === 0)).toBe(true)
  })
  it('Left kept down without aiming is simply held (a long press where the pointer is)', () => {
    const g = new PcGestures()
    g.button('mouse-left', 'down', 0)
    const outs = run(g, 0, HOLD_MS + 64)
    expect(edges(outs)).toEqual(['b0+'])
    g.button('mouse-left', 'up', HOLD_MS + 80)
    expect(run(g, HOLD_MS + 96, HOLD_MS + 128).every((o) => o.buttons.length === 0)).toBe(true)
    expect(g.busy).toBe(false)
  })
  it('the wheel scrolls as it turns, taps middle-click, and holding it (B) scrolls by aiming', () => {
    const g = new PcGestures()
    g.wheel(240)
    g.wheel(-60)
    expect(wheelOf(run(g, 0, 32))).toEqual([0, 180])
    g.button('mouse-middle', 'tap', 100)
    expect(edges(run(g, 100, 200))).toEqual(['b1+', 'b1-'])
    g.button('wii-b', 'down', 300)
    const aim = run(g, 300, 332, () => ({ move: [0, 10] }))
    expect(wheelOf(aim)[1]).toBe(-10 * GRAB_PER_PX * aim.length)
    expect(moveOf(aim)).toEqual([0, 0])
  })
})
