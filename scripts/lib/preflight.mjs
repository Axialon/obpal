/**
 * The pure parts of the demo preflight (scripts/demo-preflight.mjs): its command line, the sims a presenter shows, what
 * a drawn frame looks like in numbers, the checks on the files /link/ offers, and how the run is summed up. Each check
 * is a row: { part, check, status: 'pass' | 'FAIL' | 'WARN' | 'skip', ms, detail }.
 */
import { newSessionLines } from './e2e.mjs'

export const DEFAULT_ORIGIN = 'https://obpal.blackboxes.net'

/** The parts of a run, in order. `web` is plain requests (the service, /link/, Desktop's page and the files they offer): no browser. */
export const PARTS = ['web', 'home', 'viewer', 'sims']

/** The sims a presenter is likely to open, by the short name the command line takes. Each has a watch link and a pairing code. */
export const SIMS = {
  humanoid: { name: 'Humanoids', path: '/sim/humanoid/' },
  drone: { name: 'Drone', path: '/sim/drone/' },
  arm: { name: 'SO-101 arm', path: '/sim/arm/?kind=so101' },
  dog: { name: 'Dog', path: '/sim/dog/' },
  kart: { name: 'Kart', path: '/sim/kart/' },
  pinball: { name: 'Pinball', path: '/sim/pinball/' },
  lamp: { name: 'Lamp', path: '/sim/lamp/' },
  studio: { name: 'Studio', path: '/sim/studio/' },
}
/** The three flagship sims a run opens unless --sims says otherwise. The watch link and the phone are tried on the first that starts, so the lightest comes first. */
export const DEFAULT_SIMS = ['drone', 'humanoid', 'arm']

/** The most a whole run should take, in seconds: past it the remaining checks are skipped, not run. */
export const DEFAULT_BUDGET_S = 300

/**
 * The command line: --origin <url>, --sims <names or paths>, --only <parts>, --out <dir>, --budget <seconds>,
 * --without-beacon, --help. Throws on an unknown option, part or sim, naming the known ones.
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [env]
 */
export function parseArgs(argv, env = {}) {
  const opts = { origin: (env.OBPAL_LIVE_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, ''), sims: [...DEFAULT_SIMS], only: [...PARTS], out: '', budgetS: DEFAULT_BUDGET_S, withoutBeacon: false, help: false }
  const value = (flag, i) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const take = () => inline ?? value(flag, i++)
    if (a === '--') continue
    else if (flag === '--help' || a === '-h') opts.help = true
    else if (flag === '--without-beacon') opts.withoutBeacon = true
    else if (flag === '--origin') opts.origin = take().replace(/\/+$/, '')
    else if (flag === '--out') opts.out = take()
    else if (flag === '--only') opts.only = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (flag === '--sims') opts.sims = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (flag === '--budget') {
      const n = Number(take())
      if (!(n > 0)) throw new Error('--budget needs a positive number of seconds')
      opts.budgetS = n
    } else throw new Error(`unknown option ${a}`)
  }
  if (!/^https?:\/\/[^/]+$/.test(opts.origin)) throw new Error(`not an origin: ${opts.origin}`)
  const badPart = opts.only.filter((p) => !PARTS.includes(p))
  if (badPart.length) throw new Error(`unknown part ${badPart.join(', ')} (parts: ${PARTS.join(' ')})`)
  const badSim = opts.sims.filter((s) => !SIMS[s] && !/^\/?sim\/[\w/.?=&-]*$/.test(s))
  if (badSim.length) throw new Error(`unknown sim ${badSim.join(', ')} (sims: ${Object.keys(SIMS).join(' ')}, or a path such as sim/kart/)`)
  if (!opts.sims.length) throw new Error('--sims needs at least one sim')
  return opts
}

/** A sim as the run opens it: from a short name, or from a path ("sim/kart/" or "/sim/kart/"; a leading slash is optional). */
export function simTarget(nameOrPath) {
  if (SIMS[nameOrPath]) return { key: nameOrPath, ...SIMS[nameOrPath] }
  const path = `/${nameOrPath.replace(/^\/+/, '')}`
  return { key: path, name: path.replace(/^\/sim\//, '').replace(/[/?].*$/, '') || 'sim', path }
}

/**
 * A drawn frame in numbers, from its pixels (RGB, three bytes each, a downscaled screenshot of the canvases alone): how
 * many distinct colours it holds (each channel in sixteenths) and the spread of its brightness. A canvas that drew
 * nothing is one colour with no spread.
 * @param {Uint8Array} rgb
 * @returns {{ colours: number, mean: number, spread: number }}
 */
export function frameLook(rgb) {
  const seen = new Set()
  let sum = 0, sum2 = 0, n = 0
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    seen.add(((rgb[i] >> 4) << 8) | ((rgb[i + 1] >> 4) << 4) | (rgb[i + 2] >> 4))
    const l = rgb[i] * 0.2126 + rgb[i + 1] * 0.7152 + rgb[i + 2] * 0.0722
    sum += l; sum2 += l * l; n++
  }
  const mean = n ? sum / n : 0
  return { colours: seen.size, mean: Math.round(mean * 10) / 10, spread: Math.round(Math.sqrt(Math.max(0, (n ? sum2 / n : 0) - mean * mean)) * 10) / 10 }
}

/** Whether a frame holds a picture and not a clear colour: enough colours, enough spread. */
export const drawn = (look) => look.colours >= 16 && look.spread >= 4

/** The script Cloudflare's Web Analytics adds to a page it serves. Our pages' policy blocks it. */
export const beaconInjected = (html) => /<script\b[^>]*cloudflareinsights\.com[^>]*>/i.test(html)
/** The page without that script (for --without-beacon). */
export const stripBeacon = (html) => html.replace(/<script\b[^>]*cloudflareinsights\.com[^>]*>\s*<\/script>/gi, '')

/** The first bytes of a zip archive ("PK", then 3 and 4). */
export const isZip = (bytes) => bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04

/** The Windows helper's download link on /link/desktop/, or null. */
export function desktopZipHref(html) {
  return /href="(https:\/\/github\.com\/[^"]+\/releases\/latest\/download\/obpal-desktop-windows-x64\.zip)"/.exec(html)?.[1] ?? null
}

/**
 * An error as one short line for a table cell: the first line of its message, without Playwright's call log, and
 * without the query or fragment of any address in it (a pairing link carries its secret in the fragment).
 * @param {unknown} error
 */
export function brief(error, max = 160) {
  const text = String(error instanceof Error ? error.message : error).split(/\n\s*Call log:/)[0]
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'failed'
  const clean = line.replace(/(https?:\/\/[^\s#?"')]+)[#?][^\s"')]*/g, '$1').replace(/^(?:\w+\.\w+|Error): /, '')
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** 850 ms, 2.4 s, 12 s, 3.5 min: a duration for a table cell. */
export function seconds(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}

/**
 * How a run ends. Failures fail it; warnings and skipped checks don't, but a skipped check is named, since it proved nothing.
 * @param {{ part: string, check: string, status: string }[]} rows
 */
export function verdict(rows) {
  const failed = rows.filter((r) => r.status === 'FAIL')
  const warned = rows.filter((r) => r.status === 'WARN')
  const skipped = rows.filter((r) => r.status === 'skip')
  const ready = !failed.length && !skipped.length
  const tail = [warned.length && `${warned.length} warning${warned.length > 1 ? 's' : ''}`, skipped.length && `${skipped.length} skipped`].filter(Boolean).join(', ')
  return {
    ready, failed: failed.length, warned: warned.length, skipped: skipped.length,
    line: ready
      ? `READY: ${rows.length - warned.length} of ${rows.length} checks passed${tail ? `, ${tail}` : ''}`
      : `NOT READY: ${failed.length ? `${failed.length} failed (${failed.map((r) => r.check).slice(0, 6).join(', ')})` : `${skipped.length} not run`}${failed.length && tail ? `, ${tail}` : ''}`,
  }
}

/**
 * The line that says the run never reached ob.Pal Desktop: the helper's log gained no line naming a test browser while
 * the run was going. Same reading as the e2e runner's (scripts/e2e-all.mjs): `before` and `after` are the log's bytes,
 * null when the helper keeps no log here.
 * @param {Uint8Array | null} before
 * @param {Uint8Array | null} after
 * @param {string[]} [markers] extra needles, such as the path of the browser in use
 */
export function guardLine(before, after, markers = []) {
  if (!after) return { reached: [], line: 'ob.Pal Desktop guard: no new sessions (no helper log present)' }
  const reached = newSessionLines(after, before?.length ?? 0, markers)
  const count = (buf) => newSessionLines(buf, 0, markers).length
  return {
    reached,
    line: `ob.Pal Desktop log: ${count(before ?? new Uint8Array())} test-browser lines before, ${count(after)} after; ${reached.length ? `${reached.length} NEW` : 'no new sessions'}`,
  }
}
