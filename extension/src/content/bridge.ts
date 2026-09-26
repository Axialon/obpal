/**
 * Isolated-world bridge, one per frame of the controlled tab (injected by the service worker).
 *
 * - Asks the service worker whether this tab is controlled; if so, the worker injects the MAIN-world page
 *   script into this frame, and the bridge opens a runtime port to the offscreen link.
 * - Relays input frames from the port to the page script with window.postMessage on CHANNEL, tagged with a
 *   random per-instance session id, and accepts only same-window, same-origin replies (rumble).
 * - Reports this frame's focus and largest 3D canvas, so the link sends keys and drags to the right frame.
 */
import { PORT_NAME } from '../shared/constants'
import { envelope, parseBridgeRequest, parseToPage, readUp, type DownMsg, type FromPage } from '../shared/messages'
import { deepActiveElement, foreignFrames, isFrameElement, largestView } from './dom'

interface BridgeHandle { alive: () => boolean; poke: () => void }

function startBridge(): BridgeHandle {
  const sid = randomSid()
  const targetOrigin = /^https?:$/.test(location.protocol) ? location.origin : '*'
  let active = false
  let dead = false
  let port: chrome.runtime.Port | null = null
  let retryMs = 250
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let reportTimer: ReturnType<typeof setInterval> | undefined
  let rescanTimer: ReturnType<typeof setTimeout> | undefined
  let lastReport = ''
  let lastFrames = ''

  // New iframes (a game's "click to play" frame, say) need a bridge too: ask for a re-scan once they settle.
  const frames = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n instanceof Element && (isFrameElement(n) || n.getElementsByTagName('iframe').length)) return rescan()
      }
    }
  })

  const alive = () => {
    if (dead) return false
    try { return !!chrome.runtime?.id } catch { return false }
  }
  const toMain = (m: DownMsg) => window.postMessage(envelope(sid, 'down', m), targetOrigin)
  const send = (m: FromPage) => {
    try { port?.postMessage(m) } catch { /* port already closed */ }
  }

  function onWindowMessage(e: MessageEvent) {
    if (e.source !== window || e.origin !== location.origin) return
    const msg = readUp(e.data)
    if (!msg) return
    if (!alive()) return teardown()
    if (!active) return
    if (msg.m.t === 'loaded') toMain({ t: 'hello' }) // the page script arrived after our hello: bind it now
    else if (msg.m.t === 'rumble' && msg.sid === sid) send(msg.m)
  }

  function onRuntimeMessage(raw: unknown, sender: chrome.runtime.MessageSender) {
    if (sender.id !== chrome.runtime.id) return
    const req = parseBridgeRequest(raw)
    if (!req) return
    if (req.type === 'deactivate') deactivate()
    else void hello()
  }

  async function hello() {
    if (!alive()) return teardown()
    let res: unknown
    try { res = await chrome.runtime.sendMessage({ to: 'bg', type: 'hello' }) } catch { return }
    if (typeof res === 'object' && res !== null && (res as { active?: unknown }).active === true) activate()
    else deactivate()
  }

  function activate() {
    if (!active) {
      active = true
      addEventListener('focus', report, true)
      addEventListener('blur', report, true)
      addEventListener('resize', report)
      document.addEventListener('focusin', report, true)
      document.addEventListener('visibilitychange', report)
      document.addEventListener('pointerlockchange', report)
      addEventListener('load', onLoadCapture, true)
      frames.observe(document, { childList: true, subtree: true })
      reportTimer = setInterval(report, 700)
    }
    toMain({ t: 'hello' })
    connect()
  }

  function connect() {
    if (port || !active) return
    if (!alive()) return teardown()
    let p: chrome.runtime.Port
    try { p = chrome.runtime.connect({ name: PORT_NAME }) } catch { return retry() }
    port = p
    lastReport = ''
    p.onMessage.addListener((raw: unknown) => {
      retryMs = 250
      const m = parseToPage(raw)
      if (m) toMain(m)
    })
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError // "receiving end does not exist" while the link starts up
      if (port === p) port = null
      toMain({ t: 'rel' })
      retry()
    })
    report()
  }

  function retry() {
    clearTimeout(retryTimer)
    if (!active || !alive()) return
    retryTimer = setTimeout(connect, retryMs)
    retryMs = Math.min(retryMs * 2, 5000)
  }

  function deactivate() {
    if (!active) return
    active = false
    lastFrames = ""
    clearTimeout(retryTimer)
    clearInterval(reportTimer)
    clearTimeout(rescanTimer)
    removeEventListener('focus', report, true)
    removeEventListener('blur', report, true)
    removeEventListener('resize', report)
    document.removeEventListener('focusin', report, true)
    document.removeEventListener('visibilitychange', report)
    document.removeEventListener('pointerlockchange', report)
    removeEventListener('load', onLoadCapture, true)
    frames.disconnect()
    toMain({ t: 'off' })
    const p = port
    port = null
    try { p?.disconnect() } catch { /* already gone */ }
  }

  /** The extension was reloaded or removed: this copy can never reach it again, so let the page go. */
  function teardown() {
    deactivate()
    dead = true
    removeEventListener('message', onWindowMessage, true)
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage) } catch { /* context invalidated */ }
  }

  function report() {
    reportFrames()
    if (!port) return
    const view = largestView()
    const rep: FromPage = { t: 'rep', focus: document.hasFocus() && !isFrameElement(deepActiveElement()), area: Math.round(view?.area ?? 0), lock: !!document.pointerLockElement }
    const key = `${rep.focus}|${Math.round(rep.area / 1000)}|${rep.lock}`
    if (key === lastReport) return
    lastReport = key
    send(rep)
  }

  /**
   * Top frame only: tell the service worker about visible frames from other sites, so the popup can offer
   * "All sites" when the game lives in one. Sent when the picture changes.
   */
  function reportFrames() {
    if (!active || window.top !== window) return
    const f = foreignFrames()
    const view = largestView()
    const big = f.area > 0.15 * innerWidth * innerHeight && f.area > (view?.area ?? 0)
    const key = `${f.count}|${f.host}|${big}`
    if (key === lastFrames) return
    lastFrames = key
    chrome.runtime.sendMessage({ to: 'bg', type: 'frames', count: f.count, host: f.host, big }).catch(() => {})
  }

  function onLoadCapture(e: Event) {
    if (e.target instanceof Element && isFrameElement(e.target)) rescan()
  }

  function rescan() {
    clearTimeout(rescanTimer)
    rescanTimer = setTimeout(() => {
      if (active && alive()) chrome.runtime.sendMessage({ to: 'bg', type: 'rescan' }).catch(() => {})
    }, 400)
  }

  addEventListener('message', onWindowMessage, true)
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  void hello()
  return { alive, poke: () => void hello() }
}

function randomSid(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Re-injection (enable again, tab reload, frame rescan) pokes a live bridge instead of stacking a second one.
const KEY = '__obpalLinkBridge'
const scope = globalThis as unknown as Record<string, BridgeHandle | undefined>
const previous = scope[KEY]
if (previous?.alive()) previous.poke()
else scope[KEY] = startBridge()
