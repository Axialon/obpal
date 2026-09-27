/**
 * Connection bench: how fast a phone gets control of a screen, how quick the link is once it has, and how it rides out
 * trouble. This checkout's build and worker (`wrangler dev` on OBPAL_E2E_WORKER_PORT, default 5179:
 * scripts/local-worker.mjs), the Viewer as the screen in one Chromium, a fresh emulated phone in another for each run,
 * both on this machine (so the network's own delays are left out: what is measured is the link itself):
 *   connected     the phone opens the pairing link -> the screen's welcome arrives (the controls can show), with where
 *                 the time went: page ready, signaling open, offer sent, answer back, channels open, welcome
 *   rtt           the phone's own ping/pong on the control channel, and the selected ICE pair's round trip (getStats)
 *   path          the selected candidate pair's types (host, srflx, prflx, relay) and the DTLS version and cipher
 * and on the last run:
 *   signal cut    the phone's TCP connections (its signaling socket among them) are cut the way a lost network cuts
 *                 them, with no close frame, while its peer connection lives on: the longest gap in its input on the
 *                 screen, whether it flows again, and whether the screen kept the same participant
 *   ICE restart   the phone's browser says it's online again, as when its network changes: how long until a new ICE
 *                 session is up (a phone and screen that restart ICE), the longest gap in input meanwhile, and whether
 *                 the screen kept the same participant
 *   rebuild       the screen closes the phone's peer connection (a link that failed outright): time until input again
 * --relay: the same through a TURN relay only (both sides' peer connections forced to iceTransportPolicy 'relay'), with
 * the room service and its TURN credentials from production through the HTTPS stand-in (extension/e2e/local.mjs on
 * OBPAL_E2E_PORT, default 5176), since a local worker has no TURN keys.
 * --origin=<url>: bench a site already running there (production, say) and start nothing locally (no signal cut).
 * OBPAL_BENCH_SKIP=cut,restart,rebuild leaves checks out; OBPAL_BENCH_WAIT_MS is how long a run may take to connect.
 * Needs a build (pnpm run build, or vite build) and Playwright's Chromium, or OBPAL_E2E_CHROMIUM=<path to chrome.exe>.
 * Usage: node scripts/perf-connect.mjs [--runs=7] [--relay] [--origin=<url>] [--headed] [--json=<file>]
 */
import { writeFile } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { chromium, devices } from 'playwright'
import { startWorker } from './local-worker.mjs'
import { startLocal, UPSTREAM } from '../extension/e2e/local.mjs'

const PORT = Number(process.env.OBPAL_E2E_WORKER_PORT) || 5179
const HEADED = process.argv.includes('--headed')
const RUNS = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 7)
const JSON_OUT = process.argv.find((a) => a.startsWith('--json='))?.slice(7) ?? ''
const RELAY = process.argv.includes('--relay')
const AT = process.argv.find((a) => a.startsWith('--origin='))?.slice(9).replace(/\/$/, '') ?? ''
const SKIP = new Set((process.env.OBPAL_BENCH_SKIP ?? '').split(',').filter(Boolean))
const WAIT_MS = Number(process.env.OBPAL_BENCH_WAIT_MS) || 45000
const executablePath = process.env.OBPAL_E2E_CHROMIUM || undefined
const RTC_ARGS = ['--disable-features=WebRtcHideLocalIpsWithMdns', '--ignore-certificate-errors']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(what, fn, timeout = 20000, every = 20) {
  const end = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(every)
  }
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const fmt = (xs) => {
  if (!xs.length) return 'n/a'
  const r = (v) => (Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0))
  return `median ${r(q(xs, 0.5))} ms, p90 ${r(q(xs, 0.9))}, min ${r(Math.min(...xs))}, max ${r(Math.max(...xs))} (n=${xs.length})`
}

/**
 * Before any of a page's scripts: keep every peer connection, every signaling socket and the round trip of every pong
 * on the control channel, so the bench can read them without hooks in the page. relay: every peer connection may
 * only use relayed candidates.
 */
function watchPage({ relay }) {
  const rtc = { pcs: [], sockets: [], pongs: [] }
  window.__rtc = rtc
  const PC = window.RTCPeerConnection
  window.RTCPeerConnection = class extends PC {
    constructor(cfg, ...a) { super(relay ? { ...(cfg ?? {}), iceTransportPolicy: 'relay' } : cfg, ...a); rtc.pcs.push(this) }
  }
  const make = PC.prototype.createDataChannel
  PC.prototype.createDataChannel = function (label, opts) {
    const ch = make.call(this, label, opts)
    if (label === 'ctl') {
      ch.addEventListener('message', (e) => {
        try { const m = JSON.parse(e.data); if (m.t === 'pong' && typeof m.t0 === 'number') rtc.pongs.push(performance.now() - m.t0) } catch { /* not ours */ }
      })
    }
    return ch
  }
  const WS = window.WebSocket
  window.WebSocket = class extends WS { constructor(...a) { super(...a); rtc.sockets.push(this) } }
}

/** The selected candidate pair and the DTLS transport of the live peer connection, from getStats. */
function linkStats(page) {
  return page.evaluate(async () => {
    const pc = [...(window.__rtc?.pcs ?? [])].reverse().find((p) => p.connectionState === 'connected')
    if (!pc) return null
    const stats = await pc.getStats()
    let transport = null
    stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) transport = s })
    const pair = transport ? stats.get(transport.selectedCandidatePairId) : null
    const local = pair ? stats.get(pair.localCandidateId) : null
    const remote = pair ? stats.get(pair.remoteCandidateId) : null
    return {
      rtt: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      path: `${local?.candidateType ?? '?'}/${remote?.candidateType ?? '?'}${local?.relayProtocol ? ` (${local.relayProtocol})` : ''}`,
      dtls: transport?.tlsVersion ?? null,
      cipher: transport?.dtlsCipher ?? null,
    }
  })
}

/**
 * A TCP relay in front of the site, for the phone alone: cut() drops every connection through it at once, with no
 * close frame, the way a lost network does (the room service then sees the phone's socket as lost, not closed).
 */
async function tcpRelay(port) {
  const conns = new Set()
  const server = createServer((c) => {
    const up = connect(port, '127.0.0.1')
    const end = () => { c.destroy(); up.destroy(); conns.delete(c); conns.delete(up) }
    for (const s of [c, up]) { conns.add(s); s.on('error', end); s.on('close', end) }
    c.pipe(up).pipe(c)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    cut() { for (const s of conns) s.resetAndDestroy?.() ?? s.destroy() },
    close: () => new Promise((r) => { for (const s of conns) s.destroy(); server.close(() => r()) }),
  }
}

/** The longest gap (ms) between input packets on the screen since `since`. */
const inputGap = (screen, since) => screen.evaluate((t) => {
  const xs = window.__inputs.filter((x) => x >= t - 200)
  let g = 0
  for (let i = 1; i < xs.length; i++) g = Math.max(g, xs[i] - xs[i - 1])
  return g
}, since)
const flowing = (screen) => screen.evaluate(() => window.__inputs.at(-1) > Date.now() - 300)

const closers = []
let worker = null
let exitCode = 0
const out = { relay: RELAY, origin: AT || 'local', runs: [], failed: 0 }
try {
  let origin = AT
  if (!AT && RELAY) {
    // The relay needs production's TURN keys, which a local worker has none of: production, asked for by --relay.
    const local = await startLocal({ upstream: `https://${UPSTREAM}` })
    closers.push(local)
    origin = local.origin
  } else if (!AT) {
    worker = await startWorker({ port: PORT })
    origin = worker.origin
  }
  const relay = AT ? null : await tcpRelay(Number(new URL(origin).port))
  if (relay) closers.push(relay)
  console.log(`ob.Pal connection bench (${origin}${RELAY ? `, relay only${AT ? '' : ', production room service and TURN'}` : ''}, ${RUNS} runs)`)
  const browser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(browser)
  const screenCtx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true })
  await screenCtx.addInitScript(watchPage, { relay: RELAY })
  const screen = await screenCtx.newPage()
  const screenErrors = []
  screen.on('pageerror', (e) => screenErrors.push(e.message))
  await screen.goto(`${origin}/view/`)
  const pairing = await until('the pairing link', () => screen.evaluate(() => window.__obpal?.pairingUrl || ''))
  // The phone reaches the site through the relay, so its connections can be cut.
  const invite = relay ? pairing.replace(/^https?:\/\/[^/]+/, `${new URL(origin).protocol}//127.0.0.1:${relay.port}`) : pairing
  // Every input packet the screen takes, by wall clock (both browsers share this machine's clock).
  await screen.evaluate(() => { window.__inputs = []; window.__obpal.on('input', () => window.__inputs.push(Date.now())) })
  const people = () => screen.evaluate(() => window.__obpal.participants.map((p) => p.id).join('+'))

  const phoneBrowser = await chromium.launch({ executablePath, headless: !HEADED, args: RTC_ARGS })
  closers.push(phoneBrowser)
  for (let run = 0; run < RUNS; run++) {
    const ctx = await phoneBrowser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true })
    try {
      await ctx.addInitScript(watchPage, { relay: RELAY })
      const phone = await ctx.newPage()
      const errors = []
      phone.on('pageerror', (e) => errors.push(e.message))
      await phone.goto(invite)
      const readMarks = () => phone.evaluate(() => {
        const m = Object.fromEntries(performance.getEntriesByType('mark').filter((x) => x.name.startsWith('obpal:')).map((x) => [x.name.slice(6), x.startTime]))
        return { page: performance.getEntriesByType('navigation')[0]?.domInteractive ?? 0, ...m }
      })
      const marks = await until('the welcome', async () => { const m = await readMarks(); return m.welcome ? m : null }, WAIT_MS).catch(async () => {
        const m = await readMarks()
        const pcs = await phone.evaluate(() => window.__rtc.pcs.map((p) => `${p.connectionState}/${p.iceGatheringState}`).join(','))
        console.log(`  run ${run + 1}: no welcome in ${WAIT_MS / 1000} s; marks ${JSON.stringify(Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)])))}; peer connections ${pcs}`)
        return null
      })
      if (!marks) { out.failed++; continue }
      await until('the screen has the phone', async () => (await people()) !== '')
      // Round trips: the phone pings every 2 s; wait for a few pongs.
      await until('three pongs', () => phone.evaluate(() => window.__rtc.pongs.length >= 3), 12000)
      const s = await linkStats(phone)
      const pongs = await phone.evaluate(() => window.__rtc.pongs.slice())
      const r = { connected: marks.welcome, marks, pong: q(pongs, 0.5), iceRtt: s?.rtt ?? null, path: s?.path, dtls: s?.dtls, cipher: s?.cipher }
      out.runs.push(r)
      console.log(`  run ${run + 1}: connected ${marks.welcome.toFixed(0)} ms (page ${marks.page.toFixed(0)}, signal ${marks.signal?.toFixed(0)}, ice ${marks.ice?.toFixed(0)}, sent ${marks.sent?.toFixed(0)}, answer ${marks.answer?.toFixed(0)}, open ${marks.open?.toFixed(0)}), pong ${r.pong.toFixed(1)} ms, ICE rtt ${r.iceRtt?.toFixed(1) ?? '?'} ms, ${r.path}, ${r.dtls ?? '?'} ${r.cipher ?? ''}`)
      if (errors.length) console.log(`  phone errors: ${errors.slice(0, 3).join(' | ')}`)
      if (run < RUNS - 1) continue

      if (relay && !SKIP.has('cut')) {
        await until('input flowing', () => flowing(screen), 20000).catch(() => {})
        const before = await people()
        const t = Date.now()
        relay.cut()
        await sleep(1500)
        const again = await until('input after the cut', () => flowing(screen), 30000).then(() => true, () => false)
        const after = await people()
        out.cut = { gap: await inputGap(screen, t), kept: after === before, flowing: again }
        console.log(`  signal cut: longest input gap ${out.cut.gap} ms; input flowing again: ${again}; same participant: ${out.cut.kept}${out.cut.kept ? '' : ` (${before} -> ${after})`}`)
      }

      if (!SKIP.has('restart')) {
        await until('input flowing', () => flowing(screen), 20000).catch(() => {})
        const before = await people()
        // The host's ICE credentials in the live connection's remote description: new ones mean a new ICE session.
        const session = () => phone.evaluate(() => {
          const pc = [...window.__rtc.pcs].reverse().find((p) => p.connectionState === 'connected')
          return pc && ['connected', 'completed'].includes(pc.iceConnectionState) ? /a=ice-ufrag:(\S+)/.exec(pc.remoteDescription?.sdp ?? '')?.[1] ?? '' : ''
        })
        const s0 = await session()
        const t = Date.now()
        // What a phone sees when its network changes: the browser says it's online (again).
        await phone.evaluate(() => dispatchEvent(new Event('online')))
        const done = await until('a new ICE session', async () => { const s = await session(); return s && s !== s0 ? Date.now() : 0 }, 8000).catch(() => 0)
        await sleep(800)
        out.restart = { ms: done ? done - t : null, gap: await inputGap(screen, t), kept: (await people()) === before }
        console.log(`  ICE restart on a network change: ${done ? `new ICE session up in ${done - t} ms` : 'not taken up'}; longest input gap ${out.restart.gap} ms; same participant: ${out.restart.kept}`)
      }

      if (!SKIP.has('rebuild')) {
        await until('input flowing', () => flowing(screen), 20000).catch(() => {})
        const t = Date.now()
        await screen.evaluate(() => { for (const p of window.__obpal.peers.values()) if (p.bound) p.pc.close() })
        const again = await until('input after the rebuild', () => screen.evaluate((since) => window.__inputs.find((x) => x > since + 50) ?? 0, t), 30000).catch(() => 0)
        out.rebuild = { ms: again ? again - t : null }
        console.log(`  rebuild after the screen closed the link: input again after ${again ? `${again - t} ms` : 'never (30 s)'}`)
      }
    } finally {
      await ctx.close()
    }
    await sleep(600)
  }

  const col = (k) => out.runs.map((r) => r[k]).filter((v) => typeof v === 'number')
  const phase = (a, b) => out.runs.map((r) => r.marks[b] - r.marks[a]).filter((v) => Number.isFinite(v))
  console.log('\nSummary')
  console.log(`  connected (navigation -> welcome)  ${fmt(col('connected'))}${out.failed ? `; ${out.failed} of ${RUNS} never connected` : ''}`)
  console.log(`    page ready                       ${fmt(out.runs.map((r) => r.marks.page))}`)
  console.log(`    page -> offer sent               ${fmt(phase('page', 'sent'))}`)
  console.log(`    offer sent -> answer             ${fmt(phase('sent', 'answer'))}`)
  console.log(`    answer -> channels open          ${fmt(phase('answer', 'open'))}`)
  console.log(`    channels open -> welcome         ${fmt(phase('open', 'welcome'))}`)
  console.log(`  rtt, control channel ping/pong     ${fmt(col('pong'))}`)
  console.log(`  rtt, ICE pair (getStats)           ${fmt(col('iceRtt'))}`)
  console.log(`  paths                              ${[...new Set(out.runs.map((r) => `${r.path} ${r.dtls ?? ''} ${r.cipher ?? ''}`))].join('; ')}`)
  if (screenErrors.length) console.log(`  screen errors: ${screenErrors.slice(0, 3).join(' | ')}`)
  if (JSON_OUT) await writeFile(JSON_OUT, JSON.stringify(out, null, 1))
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  for (const c of closers.reverse()) await c.close().catch(() => {})
  await worker?.close()
}
process.exit(exitCode)
