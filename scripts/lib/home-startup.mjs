/** Startup probes record operation names and times only, never arguments, keys or results. */
export function startupProbe() {
  const events = window.__homeStartup = []
  const start = (operation) => {
    const row = { operation, startMs: performance.now(), state: 'pending' }
    if (events.length < 2000) events.push(row)
    return (state) => { row.state = state; row.endMs = performance.now() }
  }
  const probe = (owner, name, operation) => {
    const original = owner?.[name]
    if (typeof original !== 'function') return
    owner[name] = function (...args) {
      const end = start(operation)
      try {
        const promise = Reflect.apply(original, this, args)
        promise.then(() => end('fulfilled'), () => end('rejected'))
        return promise
      } catch (error) { end('threw'); throw error }
    }
  }
  probe(window.RTCPeerConnection, 'generateCertificate', 'generateCertificate')
  for (const name of ['createOffer', 'createAnswer', 'setLocalDescription', 'setRemoteDescription']) probe(window.RTCPeerConnection?.prototype, name, `RTCPeerConnection.${name}`)
  for (const name of ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey']) probe(crypto.subtle, name, `crypto.subtle.${name}`)
  const original = indexedDB.open
  indexedDB.open = function (...args) {
    const end = start('indexedDB.open')
    try {
      const request = Reflect.apply(original, this, args)
      for (const state of ['success', 'error', 'blocked']) request.addEventListener(state, () => end(state))
      return request
    } catch (error) { end('threw'); throw error }
  }
}

/** Only static URL paths survive diagnostics; room ids, fragments and query strings do not. */
export function startupPath(value) {
  try { return new URL(value).pathname.replace(/[A-Za-z0-9_-]{22,}/g, '[redacted]') } catch { return '[invalid URL]' }
}
export function startupText(value) {
  return String(value).replace(/(?:https?|wss?|file):\/\/[^\s"'<>]+/g, startupPath)
    .replace(/#[^\s"'<>]+/g, '#[redacted]').replace(/[A-Za-z0-9_-]{22,}/g, '[redacted]').replace(/\b\d{10}\b/g, '[redacted]')
}
export function watchStartup(page) {
  const events = { console: [], pageErrors: [], failedRequests: [], responses: [], sockets: [] }
  const push = (rows, row) => { if (rows.length < 200) rows.push(row) }
  page.on('console', message => push(events.console, { type: message.type(), text: startupText(message.text()) }))
  page.on('pageerror', error => push(events.pageErrors, startupText(error.message)))
  page.on('requestfailed', request => push(events.failedRequests, { path: startupPath(request.url()), error: startupText(request.failure()?.errorText) }))
  page.on('response', response => { if (response.status() >= 400) push(events.responses, { path: startupPath(response.url()), status: response.status() }) })
  page.on('websocket', socket => {
    const row = { path: startupPath(socket.url()), createdAt: Date.now() }
    push(events.sockets, row)
    socket.on('close', () => { row.closedAt = Date.now() })
    socket.on('socketerror', error => { row.error = startupText(error) })
  })
  return events
}
