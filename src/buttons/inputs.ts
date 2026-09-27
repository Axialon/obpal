/**
 * The buttons diagnostic's pure half (/buttons/): a name for every physical input a phone's browser lets a page see,
 * the short label a controller would badge it with, and the one-line summary the owner pastes back. Unit-tested in
 * node (tests/buttons.test.ts).
 *
 * Inputs are named as a binding stores them (`key:<code>`, `media:<action>`, `pad:b<i>`, `back`: packages/core's
 * buttons.ts, which this re-exports).
 */
import { labelOf, sourceOf, type InputSource } from '@obpal/core'

// The ids and labels are the controller's own (packages/core/src/buttons.ts): what the diagnostic names, a binding stores.
export { keyInput, labelOf, mediaInput, padAxis, padButton, sourceOf, type KeyLike } from '@obpal/core'
export type Source = InputSource

/**
 * A pad's name without the browser's decoration, with its USB ids when there are any: Chromium's
 * "Name (STANDARD GAMEPAD Vendor: 045e Product: 0b13)" and Gecko's "45e-b13-Name" both become "Name 045e:0b13".
 */
export function padName(id: string): string {
  const chromium = /^(.*?)\s*\((?:STANDARD GAMEPAD\s*)?Vendor: ([0-9a-f]{4}) Product: ([0-9a-f]{4})\)\s*$/i.exec(id)
  if (chromium) return `${chromium[1] || 'Pad'} ${chromium[2].toLowerCase()}:${chromium[3].toLowerCase()}`
  const gecko = /^([0-9a-f]{1,4})-([0-9a-f]{1,4})-(.+)$/i.exec(id)
  if (gecko) return `${gecko[3]} ${gecko[1].padStart(4, '0').toLowerCase()}:${gecko[2].padStart(4, '0').toLowerCase()}`
  return id.replace(/\s*\(STANDARD GAMEPAD\)\s*$/i, '').trim() || 'Pad'
}

export interface EnvIn {
  ua: string
  /** navigator.userAgentData, where the browser has it (its high-entropy values once they arrive). */
  brands?: { brand: string; version: string }[]
  platformVersion?: string
  model?: string
  /** More than one touch point: an iPad asking for the desktop site says Macintosh. */
  touch?: boolean
  /** How the page is shown: browser, standalone, fullscreen, minimal-ui, home screen (iOS) or twa. */
  mode: string
}

/** "Android 15 · Pixel 8 · Chrome 141 · browser", from the user agent and, where there are any, its client hints. */
export function describeEnv(env: EnvIn): string {
  const ua = env.ua
  let os = ''
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)
  const ios = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(ua)
  if (android) os = `Android ${env.platformVersion ? env.platformVersion.split('.')[0] : android[1]}`
  else if (ios) os = `${/iPad/.test(ua) ? 'iPadOS' : 'iOS'} ${ios[1]}.${ios[2]}`
  else if (/Macintosh/.test(ua) && env.touch) os = 'iPadOS'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Macintosh/.test(ua)) os = 'macOS'
  else if (/CrOS/.test(ua)) os = 'ChromeOS'
  else if (/Linux/.test(ua)) os = 'Linux'
  const found = ([
    [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
    [/EdgA\/(\d+)/, 'Edge'],
    [/EdgiOS\/(\d+)/, 'Edge'],
    [/Edg\/(\d+)/, 'Edge'],
    [/CriOS\/(\d+)/, 'Chrome'],
    [/FxiOS\/(\d+)/, 'Firefox'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Firefox\/(\d+)/, 'Firefox'],
    [/; wv\).*?Chrome\/(\d+)/, 'WebView'],
    [/Chrome\/(\d+)/, 'Chrome'],
    [/Version\/(\d+(?:\.\d+)?).*Safari/, 'Safari'],
  ] as const).map(([re, name]) => { const m = re.exec(ua); return m && `${name} ${m[1]}` }).find(Boolean)
  // Chrome's reduced user agent freezes its Android version and model ("Android 10; K"): the client hints don't.
  const model = env.model && env.model !== 'K' ? env.model : ''
  return [os, model, found ?? 'Unknown browser', env.mode].filter(Boolean).join(' · ')
}

/** What the page has seen, for the summary. Counts are keyed by input id, in the order they first arrived. */
export interface Tally {
  env: string
  inputs: Record<string, number>
  /** Holding the volume keys (preventDefault), and whether the owner saw the volume move while it was on or off. */
  volume: { hold: boolean; movedHeld?: boolean; movedFree?: boolean }
  headset: 'off' | 'on' | 'failed'
  /** The track the headset test plays (TRACKS). */
  track: Track
  /** A media action arrived while the page was hidden (screen off, or another app in front). */
  hiddenMedia: boolean
  /** Each pad as "Name 045e:0b13 [standard, rumble ok]". */
  pads: string[]
  back: { on: boolean; caught: number; via: string }
  fullscreen: boolean
}

export function emptyTally(env = ''): Tally {
  return { env, inputs: {}, volume: { hold: true }, headset: 'off', track: '10s', hiddenMedia: false, pads: [], back: { on: false, caught: 0, via: '' }, fullscreen: false }
}

/** At most this many inputs per source in the summary; the rest are counted. */
const PER_SOURCE = 10

/**
 * The one line to paste back, for example:
 * "ob.Pal buttons 1 · Android 15 · Chrome 141 · browser | keys Enter×2 → | volume Vol+×3 Vol−, held, stayed |
 *  headset on 10s: Play×2 Next | pad Xbox 045e:0b13 [standard, rumble ok]: A B | back 2 (closewatcher) | fullscreen"
 */
export function summarize(t: Tally): string {
  const bySource = (s: Source) => {
    const ids = Object.keys(t.inputs).filter((id) => sourceOf(id) === s)
    const shown = ids.slice(0, PER_SOURCE).map((id) => `${labelOf(id)}${t.inputs[id] > 1 ? `×${t.inputs[id]}` : ''}`)
    if (ids.length > PER_SOURCE) shown.push(`+${ids.length - PER_SOURCE}`)
    return shown.join(' ')
  }
  const parts = [`ob.Pal buttons 1 · ${t.env || 'unknown'}`]
  parts.push(`keys ${bySource('keys') || 'none'}`)
  const vol = bySource('volume')
  const seen = [t.volume.movedHeld === undefined ? '' : `held ${t.volume.movedHeld ? 'moved' : 'stayed'}`, t.volume.movedFree === undefined ? '' : `free ${t.volume.movedFree ? 'moved' : 'stayed'}`].filter(Boolean)
  parts.push(`volume ${vol || 'none'}${vol ? `, ${t.volume.hold ? 'holding' : 'not holding'}` : ''}${seen.length ? `, ${seen.join(', ')}` : ''}`)
  const media = bySource('media')
  parts.push(t.headset === 'off' ? 'headset off' : t.headset === 'failed' ? 'headset failed' : `headset on ${TRACKS[t.track]?.name ?? t.track}: ${media || 'none'}${t.hiddenMedia ? ' (while hidden too)' : ''}`)
  const pad = bySource('pad')
  parts.push(t.pads.length ? `pad ${t.pads.join('; ')}${pad ? `: ${pad}` : ''}` : 'pad none')
  parts.push(t.back.on || t.back.caught ? `back ${t.back.caught}${t.back.via ? ` (${t.back.via})` : ''}` : 'back off')
  if (t.fullscreen) parts.push('fullscreen')
  return parts.join(' | ')
}

/**
 * The tracks the headset test can play, looped. Chromium treats media of 5 s or less as transient (no media session,
 * so no headset buttons, on Android), and Chrome and Firefox count a page below -72 dBFS as silent (Chrome freezes a
 * silent hidden page after a minute; Firefox gives silent media no controls). So: 1 s as the controller played it,
 * 10 s of silence, and 10 s "faint", a level just over that line and far below hearing.
 */
export const TRACKS = {
  '1s': { seconds: 1, faint: false, name: '1s' },
  '10s': { seconds: 10, faint: false, name: '10s' },
  faint: { seconds: 10, faint: true, name: '10s faint' },
} as const
export type Track = keyof typeof TRACKS
export const isTrack = (x: unknown): x is Track => typeof x === 'string' && Object.prototype.hasOwnProperty.call(TRACKS, x)

/** The faint track's level: 16 of 32768, 20·log10(16/32768) ≈ -66 dBFS, over the -72 dBFS browsers call silence. */
export const FAINT = 16

/**
 * A mono WAV at 8 kHz: silence (8-bit, every sample on the zero line, 128), or `faint`: 16-bit, every sample 16 steps
 * off zero, about -66 dBFS. A constant level has no tone, so there's nothing to hear, but a level meter reads it.
 */
export function trackWav(seconds: number, faint = false, rate = 8000): Uint8Array {
  const n = Math.max(1, Math.round(seconds * rate))
  const bytes = faint ? 2 : 1
  const b = new Uint8Array(44 + n * bytes)
  const v = new DataView(b.buffer)
  const s = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i) }
  s(0, 'RIFF'); v.setUint32(4, 36 + n * bytes, true); s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true)
  v.setUint32(28, rate * bytes, true); v.setUint16(32, bytes, true); v.setUint16(34, bytes * 8, true)
  s(36, 'data'); v.setUint32(40, n * bytes, true)
  // 8-bit PCM is unsigned (128 is zero); 16-bit is signed.
  if (!faint) b.fill(128, 44)
  else for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, FAINT, true)
  return b
}
