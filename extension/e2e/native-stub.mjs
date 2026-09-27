/**
 * A stand-in for ob.Pal Desktop (desktop/) for the end-to-end test: speaks the native messaging framing and
 * the helper's messages, but injects nothing. It reports a made-up foreground program, accepts the allowlist
 * requests and typing, and appends everything it receives to a log (OBPAL_STUB_LOG, or obpal-stub.log in the temp
 * dir), which the test reads to prove what the extension sends and when.
 *
 * The test steers it through a small JSON file (OBPAL_STUB_CTL): `{ "text": "text" | "secret" | null, "front":
 * "game" | "browser" }` says which field has the focus, in which window, as the real helper's focus watcher would.
 *
 * Chrome launches it as `native-stub.bat chrome-extension://<id>/ --parent-window=N`.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOG = process.env.OBPAL_STUB_LOG || join(tmpdir(), 'obpal-stub.log')
const CTL = process.env.OBPAL_STUB_CTL || ''
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`)

const BROWSER = { name: 'chrome.exe', path: 'C:\\Browsers\\chrome.exe', title: 'ob.Pal Link', pid: 1000, elevated: false, browser: true, allowed: null }
const GAME = { name: 'stubgame.exe', path: 'C:\\Stub\\stubgame.exe', title: 'Stub game', pid: 2000, elevated: false, browser: false, allowed: null }
const config = { paused: false, desktop: null, programs: [] }
let enabled = false
let panic = false
/** What the test says has the focus: a text or password field (or none), and in which window. */
let focus = { text: null, front: 'browser' }

const scopeOf = (path) => {
  const p = config.programs.find((x) => x.path.toLowerCase() === path.toLowerCase())
  return p && (p.keyboard || p.mouse) ? { keyboard: p.keyboard, mouse: p.mouse } : null
}
const info = (p) => ({ ...p, allowed: scopeOf(p.path) })

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([len, body]))
}
const status = () => send({ t: 'status', enabled, panic, held: false, front: info(focus.front === 'game' ? GAME : BROWSER), program: info(GAME), text: focus.text })
const configReply = () => send({ t: 'config', paused: config.paused, desktop: config.desktop, programs: config.programs.map((p) => ({ ...p, gamepad: false })) })

function handle(m) {
  log({ in: m })
  switch (m.t) {
    case 'hello':
      send({ t: 'hello', v: 1, version: 'stub', os: 'stub', hotkey: 'Ctrl+Alt+Backspace', caps: { keyboard: true, mouse: true, gamepad: false, desktop: true, text: true } })
      configReply()
      status()
      break
    case 'enable':
      enabled = m.on
      status()
      break
    case 'f':
      break
    case 'text':
      // Typed nowhere: the log is the proof.
      if (typeof m.s !== 'string' || (m.del !== undefined && !Number.isInteger(m.del))) send({ t: 'error', code: 'bad-text', msg: 'not text' })
      break
    case 'allow':
      if (m.path.toLowerCase() !== GAME.path.toLowerCase()) return send({ t: 'error', code: 'unknown-program', msg: 'not seen' })
      config.programs = config.programs.filter((p) => p.path !== m.path)
      config.programs.push({ path: m.path, name: GAME.name, keyboard: m.keyboard, mouse: m.mouse })
      configReply()
      status()
      break
    case 'scope': {
      const p = config.programs.find((x) => x.path === m.path)
      if (!p) return send({ t: 'error', code: 'unknown-program', msg: 'not allowed' })
      p.keyboard = m.keyboard
      p.mouse = m.mouse
      configReply()
      status()
      break
    }
    case 'forget':
      config.programs = config.programs.filter((p) => p.path !== m.path)
      configReply()
      status()
      break
    case 'desktop':
      config.desktop = m.on ? { keyboard: m.keyboard, mouse: m.mouse, gamepad: false } : null
      configReply()
      status()
      break
    case 'pause':
      config.paused = m.on
      configReply()
      break
    case 'resume':
      panic = false
      status()
      break
    case 'stats':
      send({ t: 'stats', frames: 0, injected: 0, refused: {} })
      break
    default:
      send({ t: 'error', code: 'bad-message', msg: `unknown ${m.t}` })
  }
}

log({ start: process.argv.slice(2) })
// The test moves the focus by rewriting the control file; a change goes out as a status, as the real helper's does.
if (CTL) {
  let seen = ''
  setInterval(() => {
    let raw = ''
    try { raw = readFileSync(CTL, 'utf8') } catch { return }
    if (raw === seen) return
    seen = raw
    try {
      const c = JSON.parse(raw)
      focus = { text: c.text === 'text' || c.text === 'secret' ? c.text : null, front: c.front === 'game' ? 'game' : 'browser' }
      log({ focus })
      status()
    } catch { /* half written: next time */ }
  }, 100).unref()
}
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    if (buf.length < 4) return
    const n = buf.readUInt32LE(0)
    if (buf.length < 4 + n) return
    const body = buf.subarray(4, 4 + n).toString('utf8')
    buf = buf.subarray(4 + n)
    try {
      handle(JSON.parse(body))
    } catch (e) {
      log({ bad: body, error: String(e) })
      send({ t: 'error', code: 'bad-message', msg: String(e) })
    }
  }
})
process.stdin.on('end', () => {
  log({ eof: true })
  process.exit(0)
})
