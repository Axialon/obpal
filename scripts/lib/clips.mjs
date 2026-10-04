/**
 * The pure parts of the demo clips (scripts/demo-clips.mjs): the segments of the show it records, its command line, the
 * length of a recorded clip read from the file itself, and the table that sums a run up. Each clip is a row:
 * { segment, file, status: 'pass' | 'WARN' | 'FAIL', ms, bytes, detail }.
 */
import { DEFAULT_ORIGIN } from './preflight.mjs'

/** The length a backup clip should have, in seconds (a presenter cuts to it for half a minute, not for minutes). */
export const CLIP_SECONDS = { min: 30, default: 40, max: 60 }

/**
 * The segments of the show (docs/PRESENTATION.md), in its order. `file` is the clip's name without its extension; `phone`
 * says a second clip is made of the paired phone's own screen (`<file>-phone`), `guest` that the main clip is a watcher's.
 */
export const SEGMENTS = [
  { key: 'home', file: '01-home-marbles', name: 'Home and marbles', path: '/?quality=native', phone: true },
  { key: 'viewer', file: '02-viewer', name: 'Viewer', path: '/view/', phone: true },
  { key: 'humanoid', file: '03-humanoid-presets', name: 'Humanoid, kinematic presets', path: '/sim/humanoid/', phone: true },
  { key: 'octopus', file: '04-octopus-showcase', name: 'Octopus showcase (autoplay)', path: '/sim/octopus/', phone: false },
  { key: 'link', file: '05-link-try', name: 'Link try page', path: '/link/try/', phone: false },
  { key: 'watch', file: '06-watch-link', name: 'Watch link', path: '/sim/octopus/', phone: false, guest: true },
]

/** Where clips go unless the command line names a folder, relative to the checkout (git ignores artifacts/). */
export const DEFAULT_OUT = 'artifacts/demo-clips'

/**
 * The command line: an optional folder, --origin <url>, --only <segments>, --seconds <n>, --software, --no-lease, --wait-min <n>,
 * --help. Throws on an unknown option, segment or length, naming what is known.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseArgs(argv, env = {}) {
  const opts = {
    out: '', origin: (env.OBPAL_LIVE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, ''), only: SEGMENTS.map((s) => s.key),
    seconds: CLIP_SECONDS.default, software: env.OBPAL_E2E_GPU === 'swiftshader', noLease: false, waitMin: null, help: false,
  }
  const folders = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const take = () => {
      const v = inline ?? argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
      return v
    }
    if (a === '--') continue
    else if (flag === '--help' || a === '-h') opts.help = true
    else if (flag === '--software') opts.software = true
    else if (flag === '--no-lease') opts.noLease = true
    else if (flag === '--origin') opts.origin = take().replace(/\/+$/, '')
    else if (flag === '--only') opts.only = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (flag === '--seconds') opts.seconds = Number(take())
    else if (flag === '--wait-min') {
      opts.waitMin = Number(take())
      if (!(opts.waitMin >= 0)) throw new Error('--wait-min needs a number of minutes')
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`)
    else folders.push(a)
  }
  if (folders.length > 1) throw new Error(`one folder at most (got ${folders.length})`)
  opts.out = folders[0] ?? ''
  if (!/^https?:\/\/[^/]+$/.test(opts.origin)) throw new Error(`not an origin: ${opts.origin}`)
  const keys = SEGMENTS.map((s) => s.key)
  const bad = opts.only.filter((k) => !keys.includes(k))
  if (bad.length) throw new Error(`unknown segment ${bad.join(', ')} (segments: ${keys.join(' ')})`)
  if (!opts.only.length) throw new Error('--only needs at least one segment')
  if (!(opts.seconds >= CLIP_SECONDS.min && opts.seconds <= CLIP_SECONDS.max)) throw new Error(`--seconds is ${CLIP_SECONDS.min} to ${CLIP_SECONDS.max}`)
  return opts
}

// ---- reading a clip's length ---------------------------------------------------------------------------------------

/** One EBML variable-length integer at `at`: its value, and its length in bytes. `id`: keep the length marker (an element's id). Null: not one. */
function vint(b, at, id = false) {
  const first = b[at]
  if (!first) return null
  const len = Math.clz32(first) - 23
  if (len < 1 || len > 8 || at + len > b.length) return null
  const room = (0x80 >> (len - 1)) - 1
  let v = id ? first : first & room
  let ones = (first & room) === room
  for (let i = 1; i < len; i++) { v = v * 256 + b[at + i]; if (b[at + i] !== 0xff) ones = false }
  return { v: !id && ones ? -1 : v, len }
}

const ID = { segment: 0x18538067, info: 0x1549a966, scale: 0x2ad7b1, duration: 0x4489, cluster: 0x1f43b675, time: 0xe7, simpleBlock: 0xa3, group: 0xa0, block: 0xa1 }

/** The elements between `from` and `to`, each as { id, at (its payload), end }. A size of -1 (unknown) runs to the end of the parent. */
function* elements(b, from, to) {
  for (let at = from; at < to;) {
    const id = vint(b, at, true)
    const size = id && vint(b, at + id.len)
    if (!id || !size) return
    const start = at + id.len + size.len
    const end = size.v < 0 ? to : Math.min(to, start + size.v)
    yield { id: id.v, at: start, end }
    at = end
  }
}

/**
 * The length of a WebM (Matroska) file in milliseconds, read from its bytes, or null when they are no WebM or give none:
 * the Duration of its Info, or else the newest block of its last cluster. Playwright's recorder writes the first; the
 * second covers a file that was cut off before its header was finished.
 * @param {Uint8Array} bytes
 */
export function webmDuration(bytes) {
  const segment = [...elements(bytes, 0, bytes.length)].find((e) => e.id === ID.segment)
  if (!segment) return null
  let scale = 1_000_000, duration = null, last = null
  for (const top of elements(bytes, segment.at, segment.end)) {
    if (top.id === ID.info) {
      for (const e of elements(bytes, top.at, top.end)) {
        if (e.id === ID.scale) scale = readUint(bytes, e.at, e.end)
        if (e.id === ID.duration) duration = readFloat(bytes, e.at, e.end)
      }
    } else if (top.id === ID.cluster) {
      let base = 0
      // A block: its track number (a vint), then a signed 16-bit time from the cluster's.
      const seen = (e) => {
        const track = vint(bytes, e.at)
        if (!track || e.at + track.len + 2 > e.end) return
        const rel = (bytes[e.at + track.len] << 8) | bytes[e.at + track.len + 1]
        last = Math.max(last ?? 0, base + (rel > 0x7fff ? rel - 0x10000 : rel))
      }
      for (const e of elements(bytes, top.at, top.end)) {
        if (e.id === ID.time) { base = readUint(bytes, e.at, e.end); last = Math.max(last ?? 0, base) }
        else if (e.id === ID.simpleBlock) seen(e)
        else if (e.id === ID.group) for (const inner of elements(bytes, e.at, e.end)) if (inner.id === ID.block) seen(inner)
      }
    }
  }
  const ticks = duration ?? last
  return ticks === null || !Number.isFinite(ticks) ? null : Math.round((ticks * scale) / 1e6)
}

function readUint(b, from, to) {
  let v = 0
  for (let i = from; i < to; i++) v = v * 256 + b[i]
  return v
}

function readFloat(b, from, to) {
  const view = new DataView(b.buffer, b.byteOffset + from, to - from)
  return to - from === 4 ? view.getFloat32(0) : to - from === 8 ? view.getFloat64(0) : null
}

// ---- the report ----------------------------------------------------------------------------------------------------

/** 41.3 s, 1:02: a clip's length for a table cell. */
export function clock(ms) {
  if (ms === null || ms === undefined) return 'unknown'
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`
}

/** Whether a clip's length is inside what a backup clip should be (a second either way for the encoder's rounding). */
export const inRange = (ms) => ms !== null && ms >= (CLIP_SECONDS.min - 1) * 1000 && ms <= (CLIP_SECONDS.max + 3) * 1000

/**
 * One clip's row: a file that is missing or has no length is a FAIL, one outside 30 to 60 seconds a WARN. A `companion`
 * is a phone's own screen or a second view of the same scene: it starts when its page does, so any length will do.
 * @param {{ segment: string, file: string, ms: number | null, bytes: number, detail?: string, companion?: boolean }} clip
 */
export function clipRow({ companion = false, ...clip }) {
  const status = !clip.bytes || clip.ms === null ? 'FAIL' : companion || inRange(clip.ms) ? 'pass' : 'WARN'
  return { ...clip, status, detail: clip.detail ?? (status === 'WARN' ? `outside ${CLIP_SECONDS.min} to ${CLIP_SECONDS.max} s` : '') }
}

/**
 * How a run ends: every clip written and in range is a pass, a clip out of range or a note a warning, a missing clip a failure.
 * @param {{ segment: string, file: string, status: string }[]} rows
 */
export function verdict(rows) {
  const failed = rows.filter((r) => r.status === 'FAIL')
  const warned = rows.filter((r) => r.status === 'WARN')
  const ok = !failed.length && rows.length > 0
  return {
    ok, failed: failed.length, warned: warned.length,
    line: ok ? `${rows.length} clip${rows.length === 1 ? '' : 's'} written${warned.length ? `, ${warned.length} to look at` : ''}` : `${failed.length} clip${failed.length === 1 ? '' : 's'} not written (${failed.map((r) => r.file).slice(0, 6).join(', ')})`,
  }
}
