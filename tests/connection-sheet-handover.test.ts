import { afterEach, describe, expect, it, vi } from 'vitest'
import { readText } from './devtools-node.mjs'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

/** Real sheet history and the production ConnectionSheet.close method; dialogs and the browser task queue are stand-ins. */
async function handover(optionsOnResume: boolean) {
  vi.resetModules(); vi.useFakeTimers()
  const win = new EventTarget(), trace: string[] = [], states: unknown[] = [null]
  let cursor = 0, chooserOpen = false, chooserExit = (_handOver?: boolean) => {}
  const history = {
    get state() { return states[cursor] },
    pushState(state: unknown) { states.splice(cursor + 1); states.push(state); cursor++; trace.push('history:push') },
    replaceState(state: unknown) { states[cursor] = state; trace.push('history:replace') },
    back() { trace.push('history:back-queued'); setTimeout(() => { cursor = Math.max(0, cursor - 1); trace.push('history:pop'); win.dispatchEvent(new Event('popstate')) }) },
  }
  vi.stubGlobal('history', history)
  vi.stubGlobal('addEventListener', win.addEventListener.bind(win))
  vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win))
  vi.stubGlobal('document', { getElementById: () => null, querySelector: () => null })
  class Wrap extends EventTarget {
    style = {}; scrollTop = 0
    querySelector() { return this }
  }
  const { sheetExits } = await import('../src/controller/sheet')
  const source = readText('src/controller/connection-sheet.ts')
  const start = source.indexOf('\n  close() {'), end = source.indexOf('\n  enterCode(', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const method = source.slice(start, end).trim().replace('<HTMLElement>', '')
  const close = new Function(`return function ${method}`)() as (this: object) => void
  const sheet = {
    dialog: { close: () => trace.push('dialog:close'), remove: () => trace.push('dialog:remove') },
    generation: 0, busy: true, joining: {}, background: null, returnFocus: null,
    stopCamera: () => trace.push('camera:stop'),
    exits: (_handOver?: boolean) => {},
    hub: { suspend(on: boolean) {
      trace.push(`suspend:${on}`)
      if (!on && optionsOnResume) {
        chooserOpen = true; trace.push('options:open')
        chooserExit = sheetExits(new Wrap() as unknown as HTMLElement, () => { chooserOpen = false; trace.push('options:close'); chooserExit() })
      }
    } },
  }
  sheet.exits = sheetExits(new Wrap() as unknown as HTMLElement, () => close.call(sheet))
  return { trace, history, close: () => close.call(sheet), chooserOpen: () => chooserOpen, cursor: () => cursor }
}

describe('verified pairing to Options history handover', () => {
  it('keeps synchronously resumed Options open through the queued browser tasks', async () => {
    const h = await handover(true)
    h.close(); await vi.runAllTimersAsync()
    expect(h.chooserOpen(), h.trace.join(' -> ')).toBe(true)
    expect(h.trace).not.toContain('history:back-queued')
    expect(h.cursor()).toBe(1)
  })
  it('uses one Back step for the new Options sheet', async () => {
    const h = await handover(true)
    h.close(); await vi.runAllTimersAsync()
    h.history.back(); await vi.runAllTimersAsync()
    expect(h.chooserOpen()).toBe(false)
    expect(h.cursor()).toBe(0)
    expect(h.trace.filter(s => s === 'options:close')).toHaveLength(1)
  })
  it('removes the unused old step when resume keeps an existing control surface', async () => {
    const h = await handover(false)
    h.close(); await vi.runAllTimersAsync()
    expect(h.cursor()).toBe(0)
    expect(h.trace.filter(s => s === 'history:back-queued')).toHaveLength(1)
  })
})
