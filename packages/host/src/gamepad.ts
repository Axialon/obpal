import { PAD_BUTTON_COUNT, PadButton, type PadState } from '@obpal/core'

/** A W3C Gamepad-compatible snapshot ("standard" mapping, Xbox-style layout). */
export interface VirtualGamepad {
  id: string
  index: number
  connected: boolean
  mapping: 'standard'
  timestamp: number
  axes: readonly number[]
  buttons: readonly { pressed: boolean; touched: boolean; value: number }[]
  vibrationActuator: {
    type: 'dual-rumble'
    effects: readonly string[]
    playEffect: (type: string, params?: { duration?: number; strongMagnitude?: number; weakMagnitude?: number }) => Promise<'complete'>
    reset: () => Promise<'complete'>
  } | null
  hapticActuators: readonly unknown[]
}

export const GAMEPAD_ID = 'ob.Pal Controller (STANDARD GAMEPAD Vendor: 0b0a Product: 0001)'

/** Build a Gamepad-like object from a PAD state. Triggers map to buttons 6/7 with analog values. */
export function toStandardGamepad(
  pad: PadState | null,
  index: number,
  opts: { timestamp?: number; rumble?: (strong: number, weak: number, ms: number) => void } = {},
): VirtualGamepad {
  const buttons = Array.from({ length: PAD_BUTTON_COUNT }, (_, i) => {
    let value = pad && pad.buttons & (1 << i) ? 1 : 0
    if (pad && i === PadButton.LT) value = Math.max(value, pad.triggers[0])
    if (pad && i === PadButton.RT) value = Math.max(value, pad.triggers[1])
    return { pressed: value > 0.12, touched: value > 0, value }
  })
  const rumble = opts.rumble
  return {
    id: GAMEPAD_ID,
    index,
    connected: !!pad,
    mapping: 'standard',
    timestamp: opts.timestamp ?? performance.now(),
    axes: pad ? [...pad.axes] : [0, 0, 0, 0],
    buttons,
    vibrationActuator: rumble
      ? {
          type: 'dual-rumble',
          effects: ['dual-rumble'],
          playEffect: (_type, p = {}) => {
            rumble(p.strongMagnitude ?? 0, p.weakMagnitude ?? 0, p.duration ?? 200)
            return Promise.resolve('complete' as const)
          },
          reset: () => { rumble(0, 0, 0); return Promise.resolve('complete' as const) },
        }
      : null,
    hapticActuators: [],
  }
}

/**
 * Make a phone-driven controller visible to any page code that uses the Gamepad API:
 * navigator.getGamepads() includes it, and gamepadconnected/disconnected events fire.
 * Real hardware controllers keep their slots; the virtual pad takes the first free index.
 * Returns an uninstall function.
 */
export function installGamepadShim(source: {
  /** Latest PAD state, or null while no phone is in gamepad mode. */
  get: () => PadState | null
  rumble?: (strong: number, weak: number, ms: number) => void
}): () => void {
  const nav = navigator as Navigator & { getGamepads: () => (Gamepad | null)[] }
  const native = nav.getGamepads ? nav.getGamepads.bind(nav) : () => [] as (Gamepad | null)[]
  let index = -1
  let wasConnected = false
  let last: VirtualGamepad | null = null

  const slotFor = (list: (Gamepad | null)[]) => {
    if (index >= 0 && !list[index]) return index
    const free = list.findIndex((g) => !g)
    return free >= 0 ? free : Math.max(list.length, 0)
  }

  const current = (): VirtualGamepad | null => {
    const pad = source.get()
    if (!pad) return null
    const list = Array.from(native())
    index = slotFor(list)
    last = toStandardGamepad(pad, index, { rumble: source.rumble })
    return last
  }

  const patched = () => {
    const list: (Gamepad | VirtualGamepad | null)[] = Array.from(native())
    const pad = current()
    if (pad) {
      while (list.length <= pad.index) list.push(null)
      list[pad.index] = pad
    }
    return list as (Gamepad | null)[]
  }
  Object.defineProperty(nav, 'getGamepads', { configurable: true, writable: true, value: patched })

  // Connection events, polled on animation frames (games usually poll anyway).
  let raf = 0
  const tick = () => {
    const pad = source.get()
    if (!!pad !== wasConnected) {
      wasConnected = !!pad
      const gp = wasConnected ? current() : last
      if (gp) {
        const ev = new Event(wasConnected ? 'gamepadconnected' : 'gamepaddisconnected') as Event & { gamepad?: unknown }
        Object.defineProperty(ev, 'gamepad', { value: { ...gp, connected: wasConnected } })
        window.dispatchEvent(ev)
      }
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)

  return () => {
    cancelAnimationFrame(raf)
    Object.defineProperty(nav, 'getGamepads', { configurable: true, writable: true, value: native })
  }
}
