import { describe, expect, it } from 'vitest'
import { readText } from './devtools-node.mjs'

/** Rendering-only DOM stand-ins; execute the production layout handler and Stop wiring without a browser. */
class Element {
  type = ''; className = ''; dataset: Record<string, string> = {}; onclick: (() => void) | null = null
  children: Element[] = []; parent: Element | null = null; private text = ''
  get textContent(): string { return this.text + this.children.map(c => c.textContent).join('') }
  set textContent(value: string) { this.text = value; this.children = [] }
  append(child: Element) { child.parent = this; this.children.push(child) }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null }
  querySelector(selector: string) {
    return this.children.find(c => selector.includes('data-offered-stop') ? 'offeredStop' in c.dataset : c.className.split(' ').includes(selector.slice(1))) ?? null
  }
  click() { this.onclick?.() }
}

const stop = (id: string, label = id) => ({ id, label, type: 'button', tone: 'stop' })
function overlay(kind: string, tray: ReturnType<typeof stop>[] = []) {
  const source = readText('src/controller/main.ts')
  const hostStart = source.indexOf('  function onHost('), hostEnd = source.indexOf('\n  // ---- gyro toggle', hostStart)
  const stopStart = source.indexOf('  function addOfferedStop('), stopEnd = source.indexOf('\n  function showOptions()', stopStart)
  expect(hostStart).toBeGreaterThan(0); expect(hostEnd).toBeGreaterThan(hostStart)
  expect(stopStart).toBeGreaterThan(0); expect(stopEnd).toBeGreaterThan(stopStart)
  const production = (source.slice(hostStart, hostEnd) + source.slice(stopStart, stopEnd))
    .replace('m: HostMsg', 'm').replace('parent: HTMLElement', 'parent').replace(' as unknown as RoomState', '')
    .replace(' as const', '')
    .replace(/<(?:HTMLButtonElement|HTMLElement)>/g, '')
    .replace(/\)!\./g, ').')
  const parent = new Element(), sent: { id: string }[] = []
  const document = { createElement: () => new Element(), querySelectorAll: () => [parent] }
  const build = new Function('document', 'parent', 'sent', 'initial', 'mounted', `
    let layout = { v: 1, tray: initial }, surface = mounted ? {} : null, hostName = 'Screen';
    const permissionReady = true, controllerChoice = { current: () => mounted ? 'face.trackpad' : null };
    const link = { sendCtl: m => sent.push(m) }, gamepad = { setHost() {} }, keyboard = { offered() {} };
    const buttons = { changed() {} }, rated = () => [], tick = () => {}, syncMotion = () => {};
    const showOptions = () => {}, renderTray = () => {}, setMode = () => {};
    ${production}
    addOfferedStop(parent);
    return { update: tray => onHost({ t: 'layout', layout: { v: 1, tray } }), replaceBeforeTap: tray => { layout = { v: 1, tray } } };
  `)
  const actions = build(document, parent, sent, tray, kind === 'Settings') as {
    update(tray: ReturnType<typeof stop>[]): void
    replaceBeforeTap(tray: ReturnType<typeof stop>[]): void
  }
  return { parent, sent, ...actions }
}

describe.each(['Options', 'permission gate', 'Settings', 'controller catalogue'])('offered Stop while %s stays open', kind => {
  it('adds a newly offered Stop through the production layout handler', () => {
    const o = overlay(kind)
    expect(o.parent.children).toHaveLength(0)
    o.update([stop('halt', 'Stop now')])
    expect(o.parent.children).toHaveLength(1)
    expect(o.parent.children[0].textContent).toBe('Stop now')
    o.parent.children[0].click()
    expect(o.sent.map(m => m.id)).toEqual(['halt'])
  })
  it('updates its label and routes a changed Stop id', () => {
    const o = overlay(kind, [stop('old', 'Old stop')])
    o.update([stop('new', 'Current stop')])
    expect(o.parent.children).toHaveLength(1)
    expect(o.parent.children[0].textContent).toBe('Current stop')
    o.parent.children[0].click()
    expect(o.sent.map(m => m.id)).toEqual(['new'])
  })
  it('removes a withdrawn Stop and ignores a queued click on its old node', () => {
    const o = overlay(kind, [stop('old')]), old = o.parent.children[0]
    o.update([])
    expect(o.parent.children).toHaveLength(0)
    old.click()
    expect(o.sent).toHaveLength(0)
  })
  it('resolves the offered id at tap time even before the label refresh', () => {
    const o = overlay(kind, [stop('old')])
    o.replaceBeforeTap([stop('new')]); o.parent.children[0].click()
    expect(o.sent.map(m => m.id)).toEqual(['new'])
  })
})
