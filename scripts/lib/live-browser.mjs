/**
 * The browser-side parts of the live checks, shared by scripts/check-live.mjs and scripts/demo-preflight.mjs: the text a
 * page shows (shadow roots included), what the Viewer's /api/ice calls answered, and the TURN relay test. Nothing here
 * prints or keeps a credential: only whether the room was offered TURN, and how the relay-only DataChannel behaved.
 */

/** Text in the page, or in the part of it `selector` names, shadow roots included (the pairing chip lives in one). Runs in the page: take no closures. */
export function deepText(selector = 'body') {
  const out = []
  const walk = (n) => {
    if (n.shadowRoot) walk(n.shadowRoot)
    for (const c of n.childNodes) c.nodeType === 3 ? out.push(c.textContent) : walk(c)
  }
  walk(document.querySelector(selector) ?? document.body)
  return out.join(' ')
}

/**
 * Starts watching a page's /api/ice answers (a host asks for them with its room). The result fills in as they come:
 * `room` is the room the page asked about, `hostTurn` has one entry per answer, true when it offered TURN.
 * @param {import('playwright').Page} page
 * @returns {{ room: string, hostTurn: boolean[] }}
 */
export function watchIce(page) {
  const seen = { room: '', hostTurn: [] }
  page.on('response', async (r) => {
    const u = new URL(r.url())
    if (u.pathname !== '/api/ice') return
    seen.room = u.searchParams.get('room') ?? seen.room
    try { seen.hostTurn.push(!!(await r.json()).turn) } catch { /* a response without a body */ }
  })
  return seen
}

/**
 * Asks /api/ice for `room` from inside the page, so the request is same-origin like the host's own, then forces two
 * peers in that page through the relay alone: does a DataChannel open and echo? Without a room (the page never asked),
 * both are null.
 * @param {import('playwright').Page} page
 * @param {string} room
 */
export async function probeRelay(page, room) {
  const check = room ? await page.evaluate(async (room) => {
    const j = await (await fetch(`/api/ice?room=${room}`)).json()
    return { turn: !!j.turn, urls: j.iceServers.flatMap((s) => [].concat(s.urls)), creds: j.iceServers.some((s) => s.username && s.credential) }
  }, room) : null
  const relay = check?.turn ? await page.evaluate(async (room) => {
    const { iceServers } = await (await fetch(`/api/ice?room=${room}`)).json()
    const cfg = { iceServers, iceTransportPolicy: 'relay' }
    const a = new RTCPeerConnection(cfg), b = new RTCPeerConnection(cfg)
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate)
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate)
    const t0 = performance.now()
    const ch = a.createDataChannel('check')
    b.ondatachannel = (e) => { e.channel.onmessage = (m) => e.channel.send(m.data) }
    await a.setLocalDescription(); await b.setRemoteDescription(a.localDescription)
    await b.setLocalDescription(); await a.setRemoteDescription(b.localDescription)
    const opened = await Promise.race([new Promise((r) => (ch.onopen = () => r(true))), new Promise((r) => setTimeout(() => r(false), 15000))])
    if (!opened) { a.close(); b.close(); return { opened } }
    const openMs = Math.round(performance.now() - t0)
    const echoMs = await new Promise((r) => { const s = performance.now(); ch.onmessage = () => r(Math.round(performance.now() - s)); ch.send('ping') })
    const stats = [...(await a.getStats()).values()]
    const pair = stats.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')
    const local = pair && stats.find((s) => s.id === pair.localCandidateId)
    a.close(); b.close()
    return { opened, openMs, echoMs, localType: local?.candidateType, relayProtocol: local?.relayProtocol ?? local?.protocol }
  }, room) : null
  return { check, relay }
}
