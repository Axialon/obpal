import { afterEach, describe, expect, it, vi } from 'vitest'
import { Connections } from '../src/controller/connections'
import { readText } from './devtools-node.mjs'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

/** Production activation, close and target-switch methods with real sheet history; rendering and the browser queue are stand-ins. */
async function activatingWelcome() {
  vi.resetModules(); vi.useFakeTimers()
  const win = new EventTarget(), trace: string[] = [], states: unknown[] = [null]
  let cursor = 0
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
  vi.stubGlobal('sessionStorage', { removeItem() {}, setItem() {} })
  class Wrap extends EventTarget {
    style = {}; scrollTop = 0; classList = { add() {} }
    querySelector() { return this }
    remove() {}
  }
  const { sheetExits } = await import('../src/controller/sheet')
  const switcherText = readText('src/controller/switcher.ts')
  const closeStart = switcherText.indexOf('\n  close('), closeEnd = switcherText.indexOf('\n  /** The cards', closeStart)
  expect(closeStart).toBeGreaterThan(0); expect(closeEnd).toBeGreaterThan(closeStart)
  const closeSwitcher = new Function(`return function ${switcherText.slice(closeStart, closeEnd).trim()}`)() as (this: object, handOver?: boolean) => void
  const switcher = {
    sheet: null as Wrap | null, tipTimer: undefined, exits: (_handOver?: boolean) => {},
    deps: { closed: () => trace.push('options:close') },
    close(handOver?: boolean) { closeSwitcher.call(this, handOver) },
    open() {
      if (this.sheet) return
      this.sheet = new Wrap(); trace.push('options:open')
      this.exits = sheetExits(this.sheet as unknown as HTMLElement, () => this.close())
    },
  }
  const main = readText('src/controller/main.ts'), start = main.indexOf('  function switchSurface('), end = main.indexOf('\n  const permission =', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const productionSwitch = main.slice(start, end).replace('next: Connection | null', 'next')
  const onHost = (message: { t: string }) => { if (message.t === 'welcome') switcher.open() }
  const switchSurface = new Function('switcher', 'onHost', `
    const controllerChoice = { connect() {}, current() { return null } }, choiceFor = () => null, rated = () => [];
    let surface, hungUp, pad, hostNotice, linkLine, seatColor, scene, chipKey, heldShown, chipTimer, hostName;
    let pendingKeyboard, sentController, pointFace, ratedFrom, faceShown, tab, lastTab, mode, layout;
    const values = {}, Mode = { hold: 0 }, musicWire = { resetClock() {} }, control = { defer() {} };
    const gamepad = { setControlReach() {}, setWheel() {} }, strip = { reset() {} }, linkBadge = { down() {} }, keyboard = { setField() {} };
    const closeSettings = () => {}, syncMotion = () => {}, startPage = () => {}, tick = () => {}, toast = () => {}, SCENE_TOAST = 'scene';
    const startControls = () => switcher.open();
    ${productionSwitch}
    return switchSurface;
  `)(switcher, onHost) as (next: object | null) => void
  const next = { row: { id: 'viewer', name: 'Viewer', at: 0 }, welcome: { t: 'welcome' }, values: {}, presented: false, link: { ready: true, sendCtl() {} } }
  const hub = {
    active: null as typeof next | null, live: new Map([['viewer', next]]), wanted: 'viewer', suspended: true,
    deps: { beforeSwitch() {}, switched: switchSurface, message: onHost, attempt() {} },
    save() { trace.push('activate:save'); closeConnection.call(sheet) }, trim() {}, changed() {},
    suspend(on: boolean) { Connections.prototype.suspend.call(this as unknown as Connections, on) },
  }
  const connectionText = readText('src/controller/connection-sheet.ts'), connectionStart = connectionText.indexOf('\n  close() {'), connectionEnd = connectionText.indexOf('\n  enterCode(', connectionStart)
  const closeConnection = new Function(`return function ${connectionText.slice(connectionStart, connectionEnd).trim().replace('<HTMLElement>', '')}`)() as (this: object) => void
  const sheet = {
    dialog: { close() {}, remove() {} }, generation: 0, busy: true, joining: {}, background: null, returnFocus: null, stopCamera() {}, hub,
    exits: sheetExits(new Wrap() as unknown as HTMLElement, () => closeConnection.call(sheet)),
  }
  return { trace, history, cursor: () => cursor, chooserOpen: () => !!switcher.sheet, activate: () => Connections.prototype.activate.call(hub as unknown as Connections, 'viewer', true) }
}

describe('Options resumed while its verified welcome is still activating', () => {
  it('hands the resumed chooser history step to the replacement opened by switchSurface', async () => {
    const h = await activatingWelcome()
    h.activate(); await vi.runAllTimersAsync()
    expect(h.chooserOpen(), h.trace.join(' -> ')).toBe(true)
    expect(h.trace.filter(event => event === 'options:open')).toHaveLength(2)
    expect(h.trace).toContain('history:replace')
    expect(h.trace).not.toContain('history:back-queued')
    expect(h.cursor()).toBe(1)
  })
  it('leaves one Back step that closes the replacement chooser once', async () => {
    const h = await activatingWelcome()
    h.activate(); await vi.runAllTimersAsync()
    expect(h.chooserOpen(), h.trace.join(' -> ')).toBe(true)
    const closed = h.trace.filter(event => event === 'options:close').length
    h.history.back(); await vi.runAllTimersAsync()
    expect(h.chooserOpen()).toBe(false)
    expect(h.cursor()).toBe(0)
    expect(h.trace.filter(event => event === 'options:close')).toHaveLength(closed + 1)
  })
})
