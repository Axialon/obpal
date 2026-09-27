/**
 * After a deploy: is the live site whole? Read only, as a visitor would, and nothing it prints is a credential.
 *   pages    every page at 1440 and 390 wide loads (HTTP 200) without a page error; the Viewer shows a pairing code
 *   api      /api/health answers; /api/code turns away a code it doesn't know (404), a text/plain body (415) and a
 *            cross-site request (403)
 *   turn     /api/ice offers TURN to a room with a live host, and a DataChannel forced through the relay opens and echoes
 *   headers  the shared headers (HSTS, CSP, COOP, Permissions-Policy, nosniff, Referrer-Policy, X-Frame-Options),
 *            /.well-known/security.txt, CORS on /embed.js, no-cache on the controller's service worker
 *
 *   pnpm run check:live [-- --origin <url>] [--only pages,api,turn,headers]
 * The origin: --origin, else OBPAL_LIVE_ORIGIN, else https://obpal.blackboxes.net. The browser: OBPAL_E2E_CHROMIUM,
 * else Playwright's own Chromium (scripts/lib/browser.mjs). Exit code 1 when a check fails (a warning doesn't).
 */
import { resolveChromium, shortPath } from './lib/browser.mjs'
import { PAGES, VIEWPORTS, pageHeaderChecks, securityTxtCheck, shownCode, turnChecks } from './lib/live.mjs'
import { formatDuration, formatTable } from './lib/report.mjs'

const PARTS = ['pages', 'api', 'turn', 'headers']
const argv = process.argv.slice(2).filter((a) => a !== '--')
const arg = (name) => {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (i < 0) return ''
  return argv[i].includes('=') ? argv[i].slice(name.length + 1) : argv[i + 1] ?? ''
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`pnpm run check:live [-- --origin <url>] [--only ${PARTS.join(',')}]`)
  process.exit(0)
}
const ORIGIN = (arg('--origin') || process.env.OBPAL_LIVE_ORIGIN || 'https://obpal.blackboxes.net').replace(/\/+$/, '')
const only = arg('--only') ? arg('--only').split(',').map((s) => s.trim()) : PARTS
const bad = only.filter((p) => !PARTS.includes(p))
if (bad.length || !/^https?:\/\/[^/]+$/.test(ORIGIN)) {
  console.error(`check:live: ${bad.length ? `unknown part ${bad.join(', ')} (parts: ${PARTS.join(' ')})` : `not an origin: ${ORIGIN}`}`)
  process.exit(2)
}

const rows = []
const add = (part, r) => rows.push([part, r.check, r.status, r.detail])
const t0 = Date.now()
console.log(`check:live ${ORIGIN}: ${only.join(', ')}`)

// ---- headers (plain requests) --------------------------------------------------------------------------------------
if (only.includes('headers')) {
  const head = async (path) => fetch(ORIGIN + path, { redirect: 'manual' })
  const home = await head('/')
  for (const r of pageHeaderChecks((n) => home.headers.get(n))) add('headers', r)
  const sec = await head('/.well-known/security.txt')
  add('headers', securityTxtCheck(sec.status, await sec.text(), Date.now()))
  const embed = await head('/embed.js')
  add('headers', { check: '/embed.js CORS', status: embed.status === 200 && embed.headers.get('access-control-allow-origin') === '*' ? 'pass' : 'FAIL', detail: `HTTP ${embed.status}, allow-origin ${embed.headers.get('access-control-allow-origin') ?? 'missing'}` })
  const sw = await head('/p/sw.js')
  add('headers', { check: '/p/sw.js caching', status: sw.status === 200 && /no-cache/.test(sw.headers.get('cache-control') ?? '') ? 'pass' : 'FAIL', detail: `HTTP ${sw.status}, ${sw.headers.get('cache-control') ?? 'no cache-control'}` })
}

// ---- api -----------------------------------------------------------------------------------------------------------
if (only.includes('api')) {
  const health = await fetch(`${ORIGIN}/api/health`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  add('api', { check: '/api/health', status: health.status === 200 && health.body?.service === 'obpal' ? 'pass' : 'FAIL', detail: `HTTP ${health.status}${health.body ? `, proto ${health.body.proto}` : ''}` })
  // A code no screen holds; a body the lookup refuses to parse; another site asking. None of them may find a room.
  const post = (headers, body) => fetch(`${ORIGIN}/api/code`, { method: 'POST', headers, body }).then((r) => r.status)
  const json = JSON.stringify({ code: '1000000001' })
  for (const [check, want, headers] of [
    ['/api/code unknown code', 404, { 'Content-Type': 'application/json' }],
    ['/api/code text/plain', 415, { 'Content-Type': 'text/plain' }],
    ['/api/code cross-site', 403, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site', Origin: 'https://example.com' }],
  ]) {
    const got = await post(headers, json)
    add('api', { check, status: got === want ? 'pass' : 'FAIL', detail: `HTTP ${got} (want ${want})` })
  }
}

// ---- pages and turn (a browser) ------------------------------------------------------------------------------------
if (only.includes('pages') || only.includes('turn')) {
  const { chromium } = await import('playwright')
  const found = await resolveChromium()
  console.log(`  browser: ${found.from} ${shortPath(found.path)}`)
  const browser = await chromium.launch({ executablePath: found.path || undefined, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  try {
    if (only.includes('pages')) await pages(browser)
    if (only.includes('turn')) await turn(browser)
  } finally {
    await browser.close()
  }
}

/** Text in the page, shadow roots included (the pairing chip lives in one). */
function deepText() {
  const out = []
  const walk = (n) => {
    if (n.shadowRoot) walk(n.shadowRoot)
    for (const c of n.childNodes) c.nodeType === 3 ? out.push(c.textContent) : walk(c)
  }
  walk(document.body)
  return out.join(' ')
}

async function pages(browser) {
  const failed = []
  let code = null
  for (const [w, h] of VIEWPORTS) {
    for (const path of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } })
      const page = await ctx.newPage()
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 100)))
      const status = await page.goto(ORIGIN + path, { waitUntil: 'load' }).then((r) => r?.status() ?? 0, (e) => `error ${String(e.message).slice(0, 60)}`)
      await page.waitForTimeout(path === '/view/' ? 6000 : 2000)
      if (path === '/view/' && w === VIEWPORTS[0][0]) code = shownCode(await page.evaluate(deepText))
      if (status !== 200 || errors.length) failed.push(`${w} ${path}: ${status !== 200 ? `HTTP ${status}` : ''}${errors.length ? ` page error: ${errors.join(' | ')}` : ''}`)
      await ctx.close()
    }
  }
  const loads = PAGES.length * VIEWPORTS.length
  add('pages', { check: `${PAGES.length} pages x ${VIEWPORTS.map(([w]) => w).join(', ')}`, status: failed.length ? 'FAIL' : 'pass', detail: failed.length ? `${failed.length} of ${loads} loads: ${failed[0]}` : `${loads} loads, HTTP 200, no page errors` })
  for (const f of failed.slice(1, 6)) add('pages', { check: '', status: 'FAIL', detail: f })
  add('pages', { check: 'Viewer pairing code', status: code ? 'pass' : 'FAIL', detail: code ? `shows ${code}` : 'no code found' })
}

async function turn(browser) {
  const page = await (await browser.newContext()).newPage()
  let room = ''
  const hostTurn = []
  page.on('response', async (r) => {
    const u = new URL(r.url())
    if (u.pathname !== '/api/ice') return
    room = u.searchParams.get('room') ?? room
    try { hostTurn.push(!!(await r.json()).turn) } catch { /* a response without a body */ }
  })
  await page.goto(`${ORIGIN}/view/`, { waitUntil: 'load' })
  for (let i = 0; i < 60 && !room; i++) await page.waitForTimeout(500)
  await page.waitForTimeout(3000)
  // In the page, so the request is same-origin like the host's own. Only whether credentials came is kept, never them.
  const check = room ? await page.evaluate(async (room) => {
    const j = await (await fetch(`/api/ice?room=${room}`)).json()
    return { turn: !!j.turn, urls: j.iceServers.flatMap((s) => [].concat(s.urls)), creds: j.iceServers.some((s) => s.username && s.credential) }
  }, room) : null
  // Two peers in this page, forced through the relay alone: does a DataChannel open and echo?
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
  for (const r of turnChecks({ hostTurn, check, relay })) add('turn', r)
}

// ---- the summary ---------------------------------------------------------------------------------------------------
console.log(`\n${formatTable(['part', 'check', 'result', 'detail'], rows)}`)
const failed = rows.filter((r) => r[2] === 'FAIL').length
const warned = rows.filter((r) => r[2] === 'WARN').length
console.log(`\n${failed ? `${failed} FAILED` : 'all passed'}${warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : ''} (${rows.length} checks, ${formatDuration(Date.now() - t0)})`)
process.exit(failed ? 1 : 0)
