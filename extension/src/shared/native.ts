/**
 * PC target: what the extension exchanges with ob.Pal Desktop, the native helper (desktop/), over Chrome
 * Native Messaging, and the state the popup and options page render from it. Pure: unit-tested in node.
 *
 *   offscreen (KeyMapper → desired held state) ──port──▶ service worker ──connectNative──▶ obpal-desktop.exe
 *                                                          │ storage.session.pc ◀── status / config / hello
 *                                                          ▼
 *                                                   popup, options page
 *
 * Frames carry the whole desired state (which keys and buttons are held) plus this frame's motion, never
 * edges: the helper diffs against what it holds, so a lost frame can never leave a key stuck.
 * See spec/PROTOCOL.md § Native messaging frames.
 */
import type { KeyName, KeysOutput, MouseButton } from './keys'

/** Native messaging host name (desktop/src/win/install.rs HOST_NAME). */
export const NATIVE_HOST = 'net.blackboxes.obpal'
export const NATIVE_PROTO = 1
/** runtime.connect() port the offscreen link opens to the service worker for PC frames. */
export const NATIVE_PORT_NAME = 'obpal-link/native'
/** The helper releases everything after 500 ms without frames; idle frames go at least this often. */
export const NATIVE_HEARTBEAT_MS = 250
/** Where to get the helper. */
export const DESKTOP_URL = 'https://github.com/Axialon/obpal-link/tree/main/desktop#readme'

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const bool = (v: unknown): v is boolean => typeof v === 'boolean'

// ---- frames (extension → helper) ---------------------------------------------------------------

/** One action frame. Absent lists mean "nothing held"; absent motion means none. */
export interface NativeFrame {
  t: 'f'
  /** Held keys by KeyboardEvent.code (the helper's key table). */
  k?: string[]
  /** Held mouse buttons: 0 left, 1 middle, 2 right. */
  b?: number[]
  /** Relative mouse motion, whole px, +y down. */
  m?: [number, number]
  /** Wheel in 1/120 notch units, DOM convention: [deltaX, deltaY], +y scrolls down. */
  w?: [number, number]
}

export const MAX_NATIVE_KEYS = 16
const MAX_MOVE = 2000
const MAX_WHEEL = 2400

/** The desired held state, kept up to date from the Keys mapper's edges (KeyMapper.update / releaseAll). */
export class HeldState {
  readonly keys = new Set<KeyName>()
  readonly buttons = new Set<MouseButton>()

  apply(out: KeysOutput) {
    for (const e of out.keys) {
      if (e.down) this.keys.add(e.key)
      else this.keys.delete(e.key)
    }
    for (const b of out.buttons) {
      if (b.down) this.buttons.add(b.button)
      else this.buttons.delete(b.button)
    }
  }

  clear() {
    this.keys.clear()
    this.buttons.clear()
  }

  get empty() {
    return this.keys.size === 0 && this.buttons.size === 0
  }
}

const int = (v: number, max: number) => Math.max(-max, Math.min(max, Math.round(v))) || 0

/** Build a frame from the held state and this frame's motion; empty parts are left out to keep idle frames tiny. */
export function buildNativeFrame(held: HeldState, move: readonly [number, number], wheel: readonly [number, number] = [0, 0]): NativeFrame {
  const f: NativeFrame = { t: 'f' }
  if (held.keys.size) f.k = [...held.keys].slice(0, MAX_NATIVE_KEYS)
  if (held.buttons.size) f.b = [...held.buttons]
  const m: [number, number] = [int(move[0], MAX_MOVE), int(move[1], MAX_MOVE)]
  if (m[0] || m[1]) f.m = m
  const w: [number, number] = [int(wheel[0], MAX_WHEEL), int(wheel[1], MAX_WHEEL)]
  if (w[0] || w[1]) f.w = w
  return f
}

export const isIdleFrame = (f: NativeFrame) => !f.k && !f.b && !f.m && !f.w

/** Validate a frame from the offscreen document before it goes to the helper (every hop validates). */
export function parseNativeFrame(x: unknown): NativeFrame | null {
  if (!isObj(x) || x.t !== 'f') return null
  const f: NativeFrame = { t: 'f' }
  if (x.k !== undefined) {
    if (!Array.isArray(x.k) || x.k.length > MAX_NATIVE_KEYS || !x.k.every((k) => typeof k === 'string' && /^[A-Za-z0-9]{1,24}$/.test(k))) return null
    f.k = [...(x.k as string[])]
  }
  if (x.b !== undefined) {
    if (!Array.isArray(x.b) || x.b.length > 5 || !x.b.every((b) => Number.isInteger(b) && b >= 0 && b <= 4)) return null
    f.b = [...(x.b as number[])]
  }
  for (const key of ['m', 'w'] as const) {
    const v = x[key]
    if (v === undefined) continue
    const max = key === 'm' ? MAX_MOVE : MAX_WHEEL
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isInteger(n) && Math.abs(n) <= max)) return null
    f[key] = [v[0], v[1]]
  }
  return f
}

// ---- requests (service worker → helper) --------------------------------------------------------

export type HelperRequest =
  | { t: 'hello'; v: number }
  | { t: 'enable'; on: boolean }
  | NativeFrame
  | { t: 'release' }
  | { t: 'allow'; path: string; keyboard: boolean; mouse: boolean }
  | { t: 'scope'; path: string; keyboard: boolean; mouse: boolean }
  | { t: 'forget'; path: string }
  | { t: 'pause'; on: boolean }
  | { t: 'resume' }
  | { t: 'stats' }

// ---- messages (helper → service worker), validated -----------------------------------------------

export interface PcScope { keyboard: boolean; mouse: boolean }
export interface PcProgramEntry extends PcScope { path: string; name: string }
export interface PcProgram {
  name: string
  path: string
  title: string
  pid: number
  /** Runs elevated: UIPI blocks input from the helper. */
  elevated: boolean
  /** The browser itself. */
  browser: boolean
  allowed: PcScope | null
}
export interface PcConfig { paused: boolean; programs: PcProgramEntry[] }
export interface PcStatus {
  enabled: boolean
  panic: boolean
  held: boolean
  /** The window in front now. */
  front: PcProgram | null
  /** The most recent foreground program other than the browser: what "Allow this program" means. */
  program: PcProgram | null
}
export interface PcStats { frames: number; injected: number; refused: Record<string, number> }

export type HelperMessage =
  | { t: 'hello'; v: number; version: string; os: string; hotkey: string | null; caps: { keyboard: boolean; mouse: boolean; gamepad: boolean } }
  | ({ t: 'config' } & PcConfig)
  | ({ t: 'status' } & PcStatus)
  | ({ t: 'stats' } & PcStats)
  | { t: 'error'; code: string; msg: string }

const MAX_PATH = 1024
const MAX_PROGRAMS = 200

function parseScope(x: unknown): PcScope | null {
  return isObj(x) && bool(x.keyboard) && bool(x.mouse) ? { keyboard: x.keyboard, mouse: x.mouse } : null
}

function parseProgram(x: unknown): PcProgram | null {
  if (!isObj(x) || !str(x.name, 260) || !str(x.path, MAX_PATH) || !str(x.title, 200)) return null
  if (!Number.isInteger(x.pid) || (x.pid as number) < 0 || !bool(x.elevated) || !bool(x.browser)) return null
  const allowed = x.allowed === null ? null : parseScope(x.allowed)
  if (allowed === null && x.allowed !== null) return null
  return { name: x.name, path: x.path, title: x.title, pid: x.pid as number, elevated: x.elevated, browser: x.browser, allowed }
}

export function parsePcConfig(x: unknown): PcConfig | null {
  if (!isObj(x) || !bool(x.paused) || !Array.isArray(x.programs) || x.programs.length > MAX_PROGRAMS) return null
  const programs: PcProgramEntry[] = []
  for (const p of x.programs) {
    if (!isObj(p) || !str(p.path, MAX_PATH) || !str(p.name, 260)) return null
    const s = parseScope(p)
    if (!s) return null
    programs.push({ path: p.path, name: p.name, ...s })
  }
  return { paused: x.paused, programs }
}

export function parsePcStatus(x: unknown): PcStatus | null {
  if (!isObj(x) || !bool(x.enabled) || !bool(x.panic) || !bool(x.held)) return null
  const front = x.front === null ? null : parseProgram(x.front)
  const program = x.program === null ? null : parseProgram(x.program)
  if ((front === null && x.front !== null) || (program === null && x.program !== null)) return null
  return { enabled: x.enabled, panic: x.panic, held: x.held, front, program }
}

export function parseHelperMessage(x: unknown): HelperMessage | null {
  if (!isObj(x)) return null
  switch (x.t) {
    case 'hello': {
      if (!Number.isInteger(x.v) || !str(x.version, 32) || !str(x.os, 16) || !isObj(x.caps)) return null
      if (x.hotkey !== null && !str(x.hotkey, 40)) return null
      const c = x.caps
      if (!bool(c.keyboard) || !bool(c.mouse) || !bool(c.gamepad)) return null
      return { t: 'hello', v: x.v as number, version: x.version, os: x.os, hotkey: x.hotkey, caps: { keyboard: c.keyboard, mouse: c.mouse, gamepad: c.gamepad } }
    }
    case 'config': {
      const c = parsePcConfig(x)
      return c ? { t: 'config', ...c } : null
    }
    case 'status': {
      const s = parsePcStatus(x)
      return s ? { t: 'status', ...s } : null
    }
    case 'stats': {
      const s = parsePcStats(x)
      return s ? { t: 'stats', ...s } : null
    }
    case 'error':
      return str(x.code, 40) && str(x.msg, 300) ? { t: 'error', code: x.code, msg: x.msg } : null
  }
  return null
}

// ---- the PC state the popup and options page render (storage.session "pc") ------------------------

/**
 * off: PC target not selected and nobody asked for the helper. permission: nativeMessaging not granted.
 * connecting: helper starting. missing: not installed. error: refused or crashed. ready: talking.
 */
export type PcLink = 'off' | 'permission' | 'connecting' | 'missing' | 'error' | 'ready'
const PC_LINKS: readonly PcLink[] = ['off', 'permission', 'connecting', 'missing', 'error', 'ready']

export interface PcState {
  link: PcLink
  version: string | null
  hotkey: string | null
  error: string | null
  config: PcConfig | null
  status: PcStatus | null
  /** Counters, on request (pc-stats). */
  stats: PcStats | null
}

export const EMPTY_PC: PcState = { link: 'off', version: null, hotkey: null, error: null, config: null, status: null, stats: null }

export function parsePcStats(x: unknown): PcStats | null {
  if (!isObj(x) || !fin(x.frames) || !fin(x.injected) || !isObj(x.refused)) return null
  const refused: Record<string, number> = {}
  for (const [k, v] of Object.entries(x.refused)) if (/^[a-zA-Z]{1,24}$/.test(k) && fin(v)) refused[k] = v
  return { frames: x.frames, injected: x.injected, refused }
}

export function parsePcState(x: unknown): PcState | null {
  if (!isObj(x) || !PC_LINKS.includes(x.link as PcLink)) return null
  if ((x.version !== null && !str(x.version, 32)) || (x.hotkey !== null && !str(x.hotkey, 40)) || (x.error !== null && !str(x.error, 300))) return null
  const config = x.config === null ? null : parsePcConfig(x.config)
  const status = x.status === null ? null : parsePcStatus(x.status)
  const stats = x.stats === null || x.stats === undefined ? null : parsePcStats(x.stats)
  if ((config === null && x.config !== null) || (status === null && x.status !== null)) return null
  return { link: x.link as PcLink, version: x.version as string | null, hotkey: x.hotkey as string | null, error: x.error as string | null, config, status, stats }
}

/** What the popup's PC card shows. */
export type PcView =
  | { kind: 'permission' }
  | { kind: 'connecting' }
  | { kind: 'missing' }
  | { kind: 'error'; error: string }
  | { kind: 'paused' }
  | { kind: 'panic'; hotkey: string | null }
  /** No program other than the browser has been in front yet. */
  | { kind: 'idle' }
  | { kind: 'allow'; program: PcProgram }
  | { kind: 'elevated'; program: PcProgram }
  | { kind: 'active'; program: PcProgram; scope: PcScope; inFront: boolean }

export function pcView(s: PcState): PcView {
  switch (s.link) {
    case 'off':
    case 'connecting':
      return { kind: 'connecting' }
    case 'permission':
      return { kind: 'permission' }
    case 'missing':
      return { kind: 'missing' }
    case 'error':
      return { kind: 'error', error: s.error ?? 'The helper stopped.' }
  }
  if (s.config?.paused) return { kind: 'paused' }
  if (s.status?.panic) return { kind: 'panic', hotkey: s.hotkey }
  const st = s.status
  // The popup itself puts the browser in front: what matters is the program the person will switch back to.
  const program = st?.front && !st.front.browser ? st.front : st?.program ?? null
  if (!program) return { kind: 'idle' }
  if (program.elevated) return { kind: 'elevated', program }
  if (!program.allowed) return { kind: 'allow', program }
  return { kind: 'active', program, scope: program.allowed, inFront: st?.front?.pid === program.pid && !st?.front?.browser }
}

/** "keyboard + mouse", "keyboard", "mouse", or "nothing". */
export function scopeLabel(s: PcScope): string {
  const parts = [s.keyboard && 'keyboard', s.mouse && 'mouse'].filter((x): x is string => !!x)
  return parts.length ? parts.join(' + ') : 'nothing'
}

// ---- requests from extension pages to the service worker ----------------------------------------

export type PcRequest =
  | { to: 'bg'; type: 'pc-connect' }
  | { to: 'bg'; type: 'pc-allow'; path: string; keyboard: boolean; mouse: boolean }
  | { to: 'bg'; type: 'pc-scope'; path: string; keyboard: boolean; mouse: boolean }
  | { to: 'bg'; type: 'pc-forget'; path: string }
  | { to: 'bg'; type: 'pc-pause'; on: boolean }
  | { to: 'bg'; type: 'pc-resume' }
  | { to: 'bg'; type: 'pc-stats' }
export type PcRequestType = PcRequest['type']
export const PC_REQUEST_TYPES: readonly PcRequestType[] = ['pc-connect', 'pc-allow', 'pc-scope', 'pc-forget', 'pc-pause', 'pc-resume', 'pc-stats']

export function parsePcRequest(x: unknown): PcRequest | null {
  if (!isObj(x) || x.to !== 'bg') return null
  switch (x.type) {
    case 'pc-connect':
    case 'pc-resume':
    case 'pc-stats':
      return { to: 'bg', type: x.type }
    case 'pc-allow':
    case 'pc-scope':
      return str(x.path, MAX_PATH) && x.path !== '' && bool(x.keyboard) && bool(x.mouse) ? { to: 'bg', type: x.type, path: x.path, keyboard: x.keyboard, mouse: x.mouse } : null
    case 'pc-forget':
      return str(x.path, MAX_PATH) && x.path !== '' ? { to: 'bg', type: 'pc-forget', path: x.path } : null
    case 'pc-pause':
      return bool(x.on) ? { to: 'bg', type: 'pc-pause', on: x.on } : null
  }
  return null
}

/** The helper request a page request turns into. */
export function toHelperRequest(r: PcRequest): HelperRequest | null {
  switch (r.type) {
    case 'pc-allow':
      return { t: 'allow', path: r.path, keyboard: r.keyboard, mouse: r.mouse }
    case 'pc-scope':
      return { t: 'scope', path: r.path, keyboard: r.keyboard, mouse: r.mouse }
    case 'pc-forget':
      return { t: 'forget', path: r.path }
    case 'pc-pause':
      return { t: 'pause', on: r.on }
    case 'pc-resume':
      return { t: 'resume' }
    case 'pc-stats':
      return { t: 'stats' }
    case 'pc-connect':
      return null
  }
}
