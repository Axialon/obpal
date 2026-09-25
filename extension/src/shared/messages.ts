/**
 * Every message ob.Pal Link passes between contexts, with validators. Each receiver parses what it gets
 * and drops anything malformed, so a compromised or confused page can do no more than send nothing.
 *
 *   popup ──runtime──▶ service worker ──runtime──▶ offscreen (Remote, phone link)
 *                         │  ▲                        │
 *              executeScript  hello                runtime port (60 Hz frames ▼, reports/rumble ▲)
 *                         ▼  │                        │
 *                   bridge (isolated world) ◀─────────┘
 *                         │  ▲  window.postMessage on CHANNEL (same window, origin-checked)
 *                         ▼  │
 *                   page script (MAIN world): gamepad shim, 3D drags, keys
 *
 * Pure: no chrome.* or DOM use, so it is unit-tested in node.
 */
import { PAD_BUTTON_COUNT } from '@obpal/core'
import type { HostStatus } from '@obpal/host'
import { CHANNEL, isTargetMode, SERVICE, type TargetMode } from './constants'
import { clamp } from './math'

// ---- input frames (offscreen -> page) --------------------------------------------------------

/** Controller snapshot: buttons bitmask (standard layout), sticks (+Y down) and triggers. */
export type PadTuple = [buttons: number, lx: number, ly: number, rx: number, ry: number, lt: number, rt: number]
/** Deltas since the previous frame: phone aim (deg, + left/up), trackpad and two-finger pan (px), pinch (log2). */
export type DeltaTuple = [aimYaw: number, aimPitch: number, pad1x: number, pad1y: number, pad2x: number, pad2y: number, zoom: number]
/** Target mode on the wire: index into TARGET_MODES. */
export type ModeIndex = 0 | 1 | 2

/** One sample for a page frame, about 60 Hz while there is input and 4 Hz as a heartbeat otherwise. */
export interface InputFrame {
  t: 'in'
  m: ModeIndex
  /** ms since the previous frame sent to this port, for rate-based inputs (sticks, tilt, triggers). */
  dt: number
  p: PadTuple | null
  d: DeltaTuple | null
  /** Tilt stick [steer + right, pitch + top toward the user] while the phone is in Tilt mode. */
  tl: [number, number] | null
}

/** Offscreen -> page. rel: release anything held but stay bound. off: release and restore native APIs. */
export type ToPage = InputFrame | { t: 'rel' } | { t: 'off' }

/** Page bridge -> offscreen, over the port. rep: this frame's focus and largest visible 3D canvas (px²). */
export type FromPage =
  | { t: 'rep'; focus: boolean; area: number }
  | Rumble

export interface Rumble { t: 'rumble'; s: number; w: number; ms: number }

const MAX_DELTA = 1e5
export const RUMBLE_MAX_MS = 5000
const BUTTON_MASK = 2 ** PAD_BUTTON_COUNT - 1

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const within = (v: unknown, lo: number, hi: number): v is number => fin(v) && v >= lo && v <= hi
const tuple = (x: unknown, n: number): x is unknown[] => Array.isArray(x) && x.length === n

export function isPadTuple(x: unknown): x is PadTuple {
  return tuple(x, 7) && Number.isInteger(x[0]) && within(x[0], 0, BUTTON_MASK) &&
    within(x[1], -1, 1) && within(x[2], -1, 1) && within(x[3], -1, 1) && within(x[4], -1, 1) &&
    within(x[5], 0, 1) && within(x[6], 0, 1)
}

export const isDeltaTuple = (x: unknown): x is DeltaTuple => tuple(x, 7) && x.every((v) => within(v, -MAX_DELTA, MAX_DELTA))
const isTilt = (x: unknown): x is [number, number] => tuple(x, 2) && within(x[0], -1, 1) && within(x[1], -1, 1)

/** Validate an input frame and return a clean copy (unknown fields dropped), or null. */
export function parseInputFrame(x: unknown): InputFrame | null {
  if (!isObj(x) || x.t !== 'in') return null
  const { m, dt, p, d, tl } = x
  if ((m !== 0 && m !== 1 && m !== 2) || !within(dt, 0, 1000)) return null
  if (p !== null && !isPadTuple(p)) return null
  if (d !== null && !isDeltaTuple(d)) return null
  if (tl !== null && !isTilt(tl)) return null
  return {
    t: 'in', m, dt,
    p: p ? [...p] : null,
    d: d ? [...d] : null,
    tl: tl ? [tl[0], tl[1]] : null,
  }
}

export function parseToPage(x: unknown): ToPage | null {
  if (isObj(x) && (x.t === 'rel' || x.t === 'off')) return { t: x.t }
  return parseInputFrame(x)
}

/** Clamp a rumble request to sane ranges: magnitudes 0..1, at most RUMBLE_MAX_MS. Non-numbers are rejected. */
export function sanitizeRumble(s: unknown, w: unknown, ms: unknown): Rumble | null {
  if (!fin(s) || !fin(w) || !fin(ms)) return null
  return { t: 'rumble', s: clamp(s, 0, 1), w: clamp(w, 0, 1), ms: Math.round(clamp(ms, 0, RUMBLE_MAX_MS)) }
}

export function parseFromPage(x: unknown): FromPage | null {
  if (!isObj(x)) return null
  if (x.t === 'rep' && typeof x.focus === 'boolean' && within(x.area, 0, 1e9)) return { t: 'rep', focus: x.focus, area: Math.round(x.area) }
  if (x.t === 'rumble') return sanitizeRumble(x.s, x.w, x.ms)
  return null
}

// ---- bridge <-> page script (window.postMessage) ------------------------------------------------

/** Bridge -> page script. hello binds the page script to this bridge's session id. */
export type DownMsg = ToPage | { t: 'hello' }
/** Page script -> bridge. loaded: announces itself (any session); ready: bound to the hello's session. */
export type UpMsg = { t: 'loaded'; v: number } | { t: 'ready'; v: number } | Rumble

export interface Envelope<M> { ch: typeof CHANNEL; sid: string; dir: 'down' | 'up'; m: M }

/** Session ids are 128-bit random hex, minted per bridge instance. */
export const SID_RE = /^[0-9a-f]{32}$/

export const envelope = <M>(sid: string, dir: 'down' | 'up', m: M): Envelope<M> => ({ ch: CHANNEL, sid, dir, m })

/** Read a bridge -> page envelope (the page script calls this on window 'message' events). */
export function readDown(data: unknown): { sid: string; m: DownMsg } | null {
  if (!isObj(data) || data.ch !== CHANNEL || data.dir !== 'down' || typeof data.sid !== 'string' || !SID_RE.test(data.sid)) return null
  if (isObj(data.m) && data.m.t === 'hello') return { sid: data.sid, m: { t: 'hello' } }
  const m = parseToPage(data.m)
  return m ? { sid: data.sid, m } : null
}

/** Read a page -> bridge envelope. 'loaded' may carry any sid; the bridge checks the sid of everything else. */
export function readUp(data: unknown): { sid: string; m: UpMsg } | null {
  if (!isObj(data) || data.ch !== CHANNEL || data.dir !== 'up' || typeof data.sid !== 'string' || data.sid.length > 64 || !isObj(data.m)) return null
  const m = data.m
  if ((m.t === 'loaded' || m.t === 'ready') && Number.isInteger(m.v)) return { sid: data.sid, m: { t: m.t, v: m.v as number } }
  if (m.t === 'rumble') {
    const r = sanitizeRumble(m.s, m.w, m.ms)
    return r ? { sid: data.sid, m: r } : null
  }
  return null
}

// ---- runtime messages -------------------------------------------------------------------------

export type LinkStatus = HostStatus
const STATUSES: readonly LinkStatus[] = ['starting', 'ready', 'connecting', 'connected', 'offline']

/** The phone link as the popup shows it. url is the pairing URL (QR payload). */
export interface LinkState { status: LinkStatus; url: string; device: string | null }

export function parseLink(x: unknown): LinkState | null {
  if (!isObj(x) || !STATUSES.includes(x.status as LinkStatus) || typeof x.url !== 'string') return null
  if (x.url !== '' && (!x.url.startsWith(`${SERVICE}/p/#`) || x.url.length > 512)) return null
  if (x.device !== null && (typeof x.device !== 'string' || x.device.length > 60)) return null
  return { status: x.status as LinkStatus, url: x.url, device: x.device }
}

/** To the service worker. */
export type BgRequest =
  | { to: 'bg'; type: 'ensure' }
  | { to: 'bg'; type: 'enable'; tabId: number; on: boolean }
  | { to: 'bg'; type: 'mode'; mode: TargetMode }
  | { to: 'bg'; type: 'unpair' }
  | { to: 'bg'; type: 'link'; link: LinkState }
  | { to: 'bg'; type: 'offscreen-ready' }
  | { to: 'bg'; type: 'hello' }
  | { to: 'bg'; type: 'rescan' }
  /** The controlled tab's top frame: visible frames from other sites (the largest one's host, and whether it dominates the page). */
  | { to: 'bg'; type: 'frames'; count: number; host: string; big: boolean }
export type BgRequestType = BgRequest['type']

export function parseBgRequest(x: unknown): BgRequest | null {
  if (!isObj(x) || x.to !== 'bg') return null
  switch (x.type) {
    case 'ensure': case 'unpair': case 'offscreen-ready': case 'hello': case 'rescan':
      return { to: 'bg', type: x.type }
    case 'enable':
      return Number.isInteger(x.tabId) && within(x.tabId, 0, 2 ** 31) && typeof x.on === 'boolean'
        ? { to: 'bg', type: 'enable', tabId: x.tabId, on: x.on } : null
    case 'mode':
      return isTargetMode(x.mode) ? { to: 'bg', type: 'mode', mode: x.mode } : null
    case 'frames':
      return Number.isInteger(x.count) && within(x.count, 0, 1000) && typeof x.host === 'string' && x.host.length <= 253 &&
        /^[A-Za-z0-9.:[\]-]*$/.test(x.host) && typeof x.big === 'boolean'
        ? { to: 'bg', type: 'frames', count: x.count, host: x.host, big: x.big } : null
    case 'link': {
      const link = parseLink(x.link)
      return link ? { to: 'bg', type: 'link', link } : null
    }
  }
  return null
}

/** Service worker -> offscreen. */
export type OffscreenRequest =
  | { to: 'offscreen'; type: 'config'; tabId: number | null; mode: TargetMode }
  | { to: 'offscreen'; type: 'unpair' }

export function parseOffscreenRequest(x: unknown): OffscreenRequest | null {
  if (!isObj(x) || x.to !== 'offscreen') return null
  if (x.type === 'unpair') return { to: 'offscreen', type: 'unpair' }
  const cfg = parseConfig(x)
  return x.type === 'config' && cfg ? { to: 'offscreen', type: 'config', ...cfg } : null
}

/** The routing config the offscreen link needs: which tab is controlled and in which mode. */
export function parseConfig(x: unknown): { tabId: number | null; mode: TargetMode } | null {
  if (!isObj(x) || !isTargetMode(x.mode)) return null
  if (x.tabId !== null && !(Number.isInteger(x.tabId) && within(x.tabId, 0, 2 ** 31))) return null
  return { tabId: x.tabId, mode: x.mode }
}

/** Service worker -> the bridges of a tab (chrome.tabs.sendMessage). */
export type BridgeRequest = { to: 'bridge'; type: 'activate' | 'deactivate' | 'reconnect' }

export function parseBridgeRequest(x: unknown): BridgeRequest | null {
  return isObj(x) && x.to === 'bridge' && (x.type === 'activate' || x.type === 'deactivate' || x.type === 'reconnect')
    ? { to: 'bridge', type: x.type } : null
}

// ---- sender checks ----------------------------------------------------------------------------

/** Who sent a runtime message: a content script in a web page, the offscreen link, or another extension page. */
export type SenderKind = 'page' | 'offscreen' | 'extension' | 'unknown'

export function senderKind(s: { id?: string; url?: string; tabId?: number }, self: { id: string; origin: string }): SenderKind {
  if (s.id !== self.id) return 'unknown'
  if (s.url?.startsWith(`${self.origin}/`)) {
    return s.url.slice(self.origin.length).replace(/[?#].*$/, '') === '/offscreen.html' ? 'offscreen' : 'extension'
  }
  return s.tabId !== undefined ? 'page' : 'unknown'
}

/** Which senders may make each request. Pages can only ask about their own tab; only extension UI changes state. */
export const ALLOWED_SENDERS: Record<BgRequestType, readonly SenderKind[]> = {
  ensure: ['extension'],
  enable: ['extension'],
  mode: ['extension', 'offscreen'],
  unpair: ['extension'],
  link: ['offscreen'],
  'offscreen-ready': ['offscreen'],
  hello: ['page'],
  rescan: ['page'],
  frames: ['page'],
}

export const allowedFrom = (type: BgRequestType, kind: SenderKind) => ALLOWED_SENDERS[type].includes(kind)
