/**
 * Which phones may control this PC (spec/SECURITY.md §8, L1). A phone gets PC control (the PC target, whole PC or one
 * program) only once the person at the PC has said yes to it, in Link's own pages: the popup, the options page, and a
 * notification while the popup is closed. Until then ob.Pal Desktop stays disarmed and the phone is told it's waiting.
 * The answer, Allow or Deny, is kept per phone until someone changes it or the phone is forgotten. The page targets
 * (Controller, 3D, Keys) need none.
 *
 * A phone is known by the key its answer is kept under: the id of the pairing Link remembers it by, or, for a phone
 * without one, its DTLS certificate's fingerprint. Both are what the phone proved when it connected, never what it says.
 * Pure: unit-tested in node.
 */
import type { TargetMode } from './constants'

/** A phone connected to Link: the key its answer is kept under, and its name. */
export interface Phone { key: string; name: string }

/** The answer for one phone: its name when it was given, whether it may control the PC, and when (epoch ms). */
export interface Answer { name: string; allow: boolean; at: number }
export type Answers = Record<string, Answer>

/** Where a phone stands on this PC: allowed, refused, or not asked yet. */
export type PcAccess = 'allow' | 'deny' | 'ask'
export const isPcAccess = (x: unknown): x is PcAccess => x === 'allow' || x === 'deny' || x === 'ask'

/** A pairing id (16 bytes, base64url), or "fp:" and a DTLS fingerprint (32 bytes, base64url). */
export const PHONE_KEY_RE = /^(?:[A-Za-z0-9_-]{22}|fp:[A-Za-z0-9_-]{43})$/
/** At most this many answers are kept, newest first: a phone past them is asked again. */
export const MAX_ANSWERS = 64
const MAX_NAME = 60

/** What the phone shows while the person at the PC hasn't answered yet, and once they've said no. */
export const WAITING = 'Waiting for approval on the PC'
export const REFUSED = 'Not allowed on this PC: choose another target'

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isKey = (x: unknown): x is string => typeof x === 'string' && PHONE_KEY_RE.test(x)
const isName = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= MAX_NAME

/** A device as @obpal/host names it (Participant.pair, .fp): its key, or null if it has neither. */
export function phoneKeyOf(p: { pair?: string; fp?: string }): string | null {
  const key = p.pair ?? (p.fp ? `fp:${p.fp}` : null)
  return isKey(key) ? key : null
}

export function parsePhone(x: unknown): Phone | null {
  return isObj(x) && isKey(x.key) && isName(x.name) ? { key: x.key, name: x.name } : null
}

/** The kept answers, with anything malformed left out, and at most MAX_ANSWERS of them (the newest). */
export function parseAnswers(x: unknown): Answers {
  if (!isObj(x)) return {}
  const ok = Object.entries(x).filter((e): e is [string, Answer] => {
    const [k, a] = e
    return isKey(k) && isObj(a) && isName(a.name) && typeof a.allow === 'boolean' && typeof a.at === 'number' && Number.isFinite(a.at)
  })
  ok.sort((a, b) => b[1].at - a[1].at)
  return Object.fromEntries(ok.slice(0, MAX_ANSWERS).map(([k, a]) => [k, { name: a.name, allow: a.allow, at: a.at }]))
}

export function accessOf(answers: Answers, key: string): PcAccess {
  const a = Object.hasOwn(answers, key) ? answers[key] : undefined
  return a ? (a.allow ? 'allow' : 'deny') : 'ask'
}

/**
 * The phone the person at the PC is asked about now: the one connected, while the PC is the target, if nobody has
 * answered for it yet. `pcReady`: PC control is on at all (the native messaging permission), so the helper could run.
 */
export function askFor(mode: TargetMode, phone: Phone | null, answers: Answers, pcReady: boolean): Phone | null {
  return mode === 'pc' && pcReady && phone && accessOf(answers, phone.key) === 'ask' ? phone : null
}

/** The answers with this one given (it replaces an earlier one for the same phone). */
export function withAnswer(answers: Answers, phone: Phone, allow: boolean, now: number): Answers {
  return parseAnswers({ ...answers, [phone.key]: { name: phone.name, allow, at: now } })
}

/** The answers without this phone's: it is asked again, as a new phone. */
export function withoutAnswer(answers: Answers, key: string): Answers {
  return Object.fromEntries(Object.entries(answers).filter(([k]) => k !== key))
}

/**
 * The line the phone shows (the host value `notice`, PROTOCOL §3): while the PC is the target, what holds its input
 * up on this PC, if anything. False: nothing to say.
 */
export function noticeFor(mode: TargetMode, access: PcAccess | null): string | false {
  if (mode !== 'pc' || !access || access === 'allow') return false
  return access === 'ask' ? WAITING : REFUSED
}
