import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import source from '../src/family/family.js?raw'
import type { FamilyApi } from '../src/family'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

/** A stand-in for the browser's range input: the accessors and step methods family.js wraps, and the style it fills. */
class RangeInput {
  type = 'range'
  min = ''
  max = ''
  step = ''
  className = 'bb-range'
  classList = { contains: (c: string) => this.className.split(' ').includes(c) }
  fills: string[] = []
  style = { setProperty: (_: string, v: string) => { this.fills.push(v) } }
  current = '50'
  get value() { return this.current }
  set value(v: string) { this.current = String(v) }
  get valueAsNumber() { return Number(this.current) }
  set valueAsNumber(n: number) { this.current = String(n) }
  stepUp(n = 1) { this.current = String(Number(this.current) + n * (Number(this.step) || 1)) }
  stepDown(n = 1) { this.stepUp(-n) }
  /** The last --fill written. */
  get fill() { return this.fills[this.fills.length - 1] }
}
const asInput = (el: RangeInput) => el as unknown as HTMLInputElement
const rootOf = (...els: RangeInput[]) => ({ querySelectorAll: () => els }) as unknown as ParentNode

type Listener = (e: { target: unknown }) => void
/** family.js (a classic script) run against a bare window: no layout, no mutation observer, the fake input above. */
function family() {
  const listeners: Record<string, Listener> = {}
  const noop = () => {}
  const document = {
    documentElement: { setAttribute: noop, removeAttribute: noop, getAttribute: () => null },
    cookie: '',
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn },
  }
  const window = { document, location: { hostname: 'localhost', protocol: 'http:' }, HTMLInputElement: RangeInput, addEventListener: noop, dispatchEvent: noop }
  new Function('window', source.replace(/^import .*$/gm, ''))(window)
  const api = (window as unknown as { BlackboxesFamily: FamilyApi }).BlackboxesFamily
  api.configure({ reactiveRanges: true })
  return { api, listeners }
}

describe('Sliders: the accent fill up to the knob (family.js)', () => {
  it('fills the share of the range up to the value, clamped; an empty or backwards range is empty', () => {
    const { api } = family()
    expect(api.rangeShare(5, 0, 10)).toBe(0.5)
    expect(api.rangeShare(0, -10, 10)).toBe(0.5)
    expect(api.rangeShare(1, 0.25, 3)).toBeCloseTo(0.75 / 2.75, 10)
    expect(api.rangeShare(0.25, 0.25, 3)).toBe(0)
    expect(api.rangeShare(3, 0.25, 3)).toBe(1)
    expect(api.rangeShare(-1, 0, 10)).toBe(0)
    expect(api.rangeShare(11, 0, 10)).toBe(1)
    expect(api.rangeShare(5, 5, 5)).toBe(0)
    expect(api.rangeShare(5, 10, 0)).toBe(0)
    expect(api.rangeShare(NaN, 0, 10)).toBe(0)
  })

  it('writes --fill from the input’s value and bounds; missing bounds are HTML’s 0 and 100', () => {
    const { api } = family()
    const gain = new RangeInput()
    Object.assign(gain, { min: '0.5', max: '3', value: '1' })
    api.rangeFill(asInput(gain))
    expect(gain.fill).toBe('20.00%')
    const plain = new RangeInput()
    plain.value = '25'
    api.rangeFill(asInput(plain))
    expect(plain.fill).toBe('25.00%')
    const odd = new RangeInput()
    Object.assign(odd, { min: 'x', max: '', value: '100' })
    api.rangeFill(asInput(odd))
    expect(odd.fill).toBe('100.00%')
  })

  it('refills when code sets value or valueAsNumber, or steps it, once the slider has been seen', () => {
    const { api } = family()
    const dead = new RangeInput()
    Object.assign(dead, { min: '0', max: '0.4', step: '0.02', value: '0.2' })
    api.rangeFill(asInput(dead))
    expect(dead.fill).toBe('50.00%')
    dead.value = '0.4'
    expect(dead.fill).toBe('100.00%')
    expect(dead.value).toBe('0.4')
    dead.valueAsNumber = 0.1
    expect(dead.fill).toBe('25.00%')
    expect(dead.valueAsNumber).toBe(0.1)
    dead.stepUp()
    expect(dead.fill).toBe('30.00%')
    dead.stepDown(5)
    expect(dead.fill).toBe('5.00%')
  })

  it('refills on input, a whole panel at once, and a form once it has reset', async () => {
    const { api, listeners } = family()
    const a = new RangeInput(), b = new RangeInput()
    a.value = '10'
    b.value = '90'
    api.syncRanges(rootOf(a, b))
    expect([a.fill, b.fill]).toEqual(['10.00%', '90.00%'])
    // Dragged: the input event, caught for the whole document.
    const c = new RangeInput()
    c.value = '70'
    listeners.input({ target: c })
    expect(c.fill).toBe('70.00%')
    // A reset puts values back with no input event: the form refills just after.
    const form = rootOf(a)
    listeners.reset({ target: form })
    a.current = '40' // the browser's reset, which bypasses the accessors
    await vi.advanceTimersByTimeAsync(0)
    expect(a.fill).toBe('40.00%')
  })

  it('wraps only range inputs, each once', () => {
    const { api } = family()
    const text = new RangeInput()
    text.type = 'text'
    api.rangeFill(asInput(text))
    expect(Object.getOwnPropertyDescriptor(text, 'value')).toBeUndefined()
    const range = new RangeInput()
    api.rangeFill(asInput(range))
    const wrapped = Object.getOwnPropertyDescriptor(range, 'value')?.set
    expect(wrapped).toBeTypeOf('function')
    api.rangeFill(asInput(range))
    expect(Object.getOwnPropertyDescriptor(range, 'value')?.set).toBe(wrapped)
  })
})
