/** Independent phone states share the native distiller, with one raw sequence per scenario. */
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One owned palette gesture witness. Passive observation only; IDs and colours are bounded, never page text or messages. */
export function paletteTapWitness(spec, env = globalThis) {
  const ids = new Set(['product', 'lime', 'lavender', 'turquoise', 'candy', 'sky', 'rose', 'amber', 'mint'])
  if (!ids.has(spec.target) || !ids.has(spec.neighbor) || !Number.isFinite(spec.point?.x) || !Number.isFinite(spec.point?.y)) throw Error('Invalid palette witness target')
  if (env.__mobilePaletteTapWitness?.active) throw Error('Palette witness already active')
  const doc = env.document, rows = [], removals = [], startedAt = env.performance.now()
  let active = true, total = 0, overflow = 0, timer, observer
  const accent = value => ids.has(value) ? value : 'other'
  const colour = value => /^#[0-9a-f]{6}$/i.test(value ?? '') ? value.toLowerCase() : 'unavailable'
  const idOf = node => { const button = node?.closest?.('.bb-accent'); return button ? accent(button.dataset.accent) : 'non-palette' }
  const target = id => doc.querySelector(`.settings .bb-accent[data-accent="${id}"]`)
  const rect = node => { const r = node?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null }
  const geometry = node => {
    if (!node) return null
    const style = env.getComputedStyle(node), after = env.getComputedStyle(node, '::after')
    return { rect: rect(node), transform: style.transform.slice(0, 128), hover: node.matches(':hover'), active: node.matches(':active'), after: { left: after.left, top: after.top, width: after.width, height: after.height, radius: after.borderRadius, transform: after.transform.slice(0, 128) } }
  }
  const state = () => {
    const sheet = doc.querySelector('.settings'), a = target(spec.target), b = target(spec.neighbor), api = env.BlackboxesFamily
    return { dpr: env.devicePixelRatio, viewport: { width: env.innerWidth, height: env.innerHeight }, reducedMotion: env.matchMedia('(prefers-reduced-motion: reduce)').matches,
      selected: [...doc.querySelectorAll('.settings .bb-accent[aria-checked="true"]')].slice(0, 9).map(el => accent(el.dataset.accent)), apiId: accent(api?.getAccent?.()), apiColor: colour(api?.accentColor?.()), rootColor: colour(env.getComputedStyle(doc.documentElement).getPropertyValue('--bb-accent').trim()), targetColor: colour(a && env.getComputedStyle(a).getPropertyValue('--sw').trim()), neighborColor: colour(b && env.getComputedStyle(b).getPropertyValue('--sw').trim()),
      target: geometry(a), neighbor: geometry(b), sheet: sheet ? { rect: rect(sheet), scrollTop: sheet.scrollTop, scrollLeft: sheet.scrollLeft, header: rect(sheet.querySelector(':scope > .sheet-head')), footer: rect(sheet.querySelector(':scope > .actions')) } : null }
  }
  const snapshot = () => { try { return state() } catch (error) { return { witnessError: error.name === 'TypeError' ? 'TypeError' : 'Error' } } }
  const append = row => { total++; if (rows.length < 160) rows.push(row); else { rows[159] = row; overflow++ } }
  const note = (kind, event) => {
    if (!active) return
    const point = event?.changedTouches?.[0] ?? event
    const x = Number.isFinite(point?.clientX) ? point.clientX : null, y = Number.isFinite(point?.clientY) ? point.clientY : null
    append({ kind, at: env.performance.now(), ...(event ? { trusted: !!event.isTrusted, pointerType: ['touch', 'mouse', 'pen'].includes(event.pointerType) ? event.pointerType : event.type.startsWith('touch') ? 'touch' : 'other', x, y, targetId: idOf(event.target), ownerAtEventPoint: x === null || y === null ? null : idOf(doc.elementFromPoint(x, y)), ownerAtRequestedPoint: idOf(doc.elementFromPoint(spec.point.x, spec.point.y)) } : {}), state: snapshot() })
  }
  const report = { target: spec.target, neighbor: spec.neighbor, point: { x: spec.point.x, y: spec.point.y }, startedAt, maxRows: 160, maxLifetimeMs: 65000, events: rows }
  const stop = reason => {
    if (active) {
      note('stop'); active = false
      for (const remove of removals) remove()
      observer.disconnect(); env.clearTimeout(timer)
      Object.assign(report, { stoppedBy: ['owner-finally', 'lifetime'].includes(reason) ? reason : 'other', stoppedAt: env.performance.now(), cleanup: { listenersRemoved: removals.length, observerDisconnected: true, timerCleared: true } })
    }
    return { ...report, active, totalEvents: total, overflowEvents: overflow, finalState: snapshot() }
  }
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click']) {
    const listener = event => { note(type, event); if (type === 'click') env.queueMicrotask(() => note('after-click', event)) }
    doc.addEventListener(type, listener, { capture: true, passive: true })
    removals.push(() => doc.removeEventListener(type, listener, true))
  }
  observer = new env.MutationObserver(() => note('selection-mutation'))
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-bb-accent'] })
  const palette = doc.querySelector('.settings .accent-row')
  if (palette) observer.observe(palette, { attributes: true, subtree: true, attributeFilter: ['aria-checked'] })
  timer = env.setTimeout(() => stop('lifetime'), 65000)
  env.__mobilePaletteTapWitness = { get active() { return active }, mark: phase => { if (['neighbor-before', 'neighbor-selected', 'target-before', 'target-sent', 'target-selected', 'target-wait-failure'].includes(phase)) note(phase) }, read: () => ({ ...report, active, totalEvents: total, overflowEvents: overflow, finalState: snapshot() }), stop }
  note('install')
  return { active, listeners: removals.length, maxRows: report.maxRows, maxLifetimeMs: report.maxLifetimeMs }
}

export function phoneEvidence(raw, out) {
  const planned = new Map()
  const save = async () => {
    if (!raw) return
    await mkdir(out, { recursive: true })
    await writeFile(join(out, 'evidence-frames.json'), JSON.stringify({ expectedCount: planned.size, frames: [...planned.values()] }, null, 2))
  }
  return {
    async trace(page, name) {
      if (!raw || typeof page.evaluate !== 'function') return
      const trace = await page.evaluate(() => ({ events: window.__mobileTrace ?? [], lastStopIds: window.__mobileLastStopIds ?? null, layoutVersion: window.__mobileLayoutVersion ?? 0, sentModes: window.__mobileSentModes ?? 0, sentFrames: window.__mobileSentFrames ?? 0, permission: window.__mobileMotionPermission ?? null, visibility: document.visibilityState }))
      await mkdir(join(out, 'traces'), { recursive: true })
      await writeFile(join(out, 'traces', `${name}.json`), JSON.stringify(trace, null, 2))
    },
    async expect(names) {
      for (const name of names) {
        if (!/^[a-z0-9-]+$/i.test(name)) throw Error('Invalid evidence scenario')
        if (!planned.has(name)) planned.set(name, { path: `${name}/0.png`, timeMs: 0 })
      }
      await save()
    },
    async capture(page, name, { failed, ...options } = {}) {
      if (!raw) return
      await this.expect([name])
      const dir = join(raw, name), path = join(dir, '0.png')
      await mkdir(dir, { recursive: true })
      try { await access(path); throw Error('Evidence scenario already captured') } catch (error) { if (error.code !== 'ENOENT') throw error }
      await page.screenshot({ path, animations: 'disabled', ...options })
      planned.set(name, { path: `${name}/0.png`, timeMs: 0, ...(typeof failed === 'boolean' ? { failed } : {}) })
      await save()
      await this.trace(page, name)
    },
  }
}

/** Bounded nonsecret ordering evidence. Never retain URLs, invite/code values, SDP or message bodies. */
export function phoneTrace() {
  window.__mobileTrace = []; window.__mobileSentModes = 0; window.__mobileSentFrames = 0; window.__mobileLayoutVersion = 0
  const stateKind = () => history.state?.obpalSheet ? 'sheet' : history.state?.obpalKeyboard ? 'keyboard' : 'page'
  const note = event => {
    const row = { event, at: Math.round(performance.now()), history: stateKind(), chooser: !!document.querySelector('.ctl-wrap:not(.out)'), connections: !!document.querySelector('dialog.connection-wrap[open]'), camera: !!document.querySelector('.obpal-camera[open]'), gate: !!document.getElementById('gate'), surface: !!document.getElementById('surface') }
    window.__mobileTrace.push(row)
    if (window.__mobileTrace.length > 300) window.__mobileTrace.shift()
  }
  for (const name of ['pushState', 'replaceState', 'back']) {
    const original = history[name].bind(history)
    history[name] = (...args) => { const result = original(...args); note(`history:${name}`); return result }
  }
  addEventListener('popstate', () => note('history:popstate'))
  addEventListener('visibilitychange', () => note(`visibility:${document.visibilityState}`))
  addEventListener('DOMContentLoaded', () => {
    let previous = ''
    new MutationObserver(() => {
      const signature = [!!document.querySelector('.ctl-wrap:not(.out)'), !!document.querySelector('dialog.connection-wrap[open]'), !!document.querySelector('.obpal-camera[open]'), !!document.getElementById('gate'), !!document.getElementById('surface')].join(',')
      if (signature !== previous) { previous = signature; note('dom:layers') }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] })
  })
  const descriptor = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage')
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', { ...descriptor, set(fn) {
    const channel = this
    if (typeof fn !== 'function') { descriptor.set.call(channel, fn); return }
    descriptor.set.call(channel, event => {
      let message
      if (typeof event.data === 'string') { try { message = JSON.parse(event.data) } catch {} }
      fn.call(channel, event)
      if (message?.t === 'layout' || message?.t === 'welcome') {
        window.__mobileLayoutVersion++
        window.__mobileLastStopIds = (message.layout?.tray ?? []).filter(c => c.tone === 'stop').map(c => /^mobile-stop/.test(c.id) ? c.id : 'other')
        note(`wire:${message.t}-delivered`)
      }
    })
  } })
  const send = RTCDataChannel.prototype.send
  RTCDataChannel.prototype.send = function (data) {
    if (typeof data === 'string') { try { if (JSON.parse(data).t === 'mode') { window.__mobileSentModes++; note('send:mode') } } catch {} }
    else if (data instanceof ArrayBuffer) window.__mobileSentFrames++
    return send.call(this, data)
  }
}
