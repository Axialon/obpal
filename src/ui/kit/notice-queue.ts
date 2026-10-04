/**
 * The rules behind ob.Pal's notices (./notice.ts), kept apart from the page so they can be tested without one.
 *
 * Five tiers share one model. An alert (safety: the screen stopped the arms) and a state (the link is down, waiting to be
 * let in) stay until what they say ends. A ceremony (the pairing card, the phone's trust notice) shows while it is useful
 * and then folds by itself; those two surfaces keep their own code and use SETTLE-style timers. A toast is short feedback:
 * it lasts as long as its words need, waits its turn behind at most three others, and is never shown twice in a row. A
 * coach mark (src/ui/hints.ts) is the lowest tier and gives way to all of them.
 */

/** The tiers this module places: persistent ones (alert, state) and transient ones (toast). */
export type NoticeTier = 'alert' | 'state' | 'toast'
export type NoticeTone = 'info' | 'ok' | 'warn' | 'bad'

/** A toast stays at least this long, at most this long, and an error stays at least ERROR_MIN_MS. */
export const TOAST_MIN_MS = 3000
export const TOAST_MAX_MS = 7000
export const ERROR_MIN_MS = 6000
/** A toast with a button on it stays at least this long: the button must stay reachable. */
export const ACTION_MIN_MS = 9000
/** The same words again within this long of the last showing are the same notice. */
export const DEDUPE_MS = 4000
/** One toast shows; this many more may wait. */
export const MAX_WAITING = 3
/** A drag this far, in any direction, from a toast dismisses it (a phone may be turned, so no direction is special). */
export const SWIPE_PX = 50

const RANK: Record<NoticeTier, number> = { alert: 3, state: 2, toast: 1 }

/**
 * How long a toast of these words stays: 1.8 s and 55 ms for every character, between 3 s and 7 s (an error at least
 * 6 s). A persistent tier has no time: 0.
 */
export function noticeDuration(text: string, tone: NoticeTone = 'info', tier: NoticeTier = 'toast'): number {
  if (tier !== 'toast') return 0
  const ms = 1800 + 55 * [...text.trim()].length
  return Math.min(TOAST_MAX_MS, Math.max(tone === 'bad' ? ERROR_MIN_MS : TOAST_MIN_MS, ms))
}

/** Which of two notices goes first: the higher tier, and within a tier an error before a warning before the rest. */
export function priority(tier: NoticeTier, tone: NoticeTone = 'info'): number {
  return RANK[tier] * 10 + (tone === 'bad' ? 5 : tone === 'warn' ? 2 : 0)
}

/** Did a drag of (dx, dy) pixels throw the notice away? */
export function isSwipe(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= SWIPE_PX
}

// ---- the toast queue ------------------------------------------------------------------------------------------------

export interface Entry {
  id: string
  /** What makes two notices the same one: their tone and words. */
  key: string
  tier: NoticeTier
  tone: NoticeTone
  /** How long it shows, in ms (0: until it is dismissed). */
  ms: number
}

export interface Queue {
  shown: Entry | null
  /** When the shown one started (or last restarted). */
  shownAt: number
  waiting: Entry[]
  /** When each key last finished showing (to refuse an immediate repeat). */
  recent: Record<string, number>
}

export const emptyQueue = (): Queue => ({ shown: null, shownAt: 0, waiting: [], recent: {} })

/** What an offer or a finish asks the page to do. */
export interface Step {
  queue: Queue
  /** An entry to put on screen now (it replaces the shown one). */
  show: Entry | null
  /** The shown entry stays, with its time started again. */
  restart: boolean
  /** The shown entry stepped aside for a more urgent one and waits again. */
  displaced: Entry | null
  /** Entries thrown out (the queue was full, or the same words were already waiting). */
  dropped: Entry[]
}

const none = (queue: Queue): Step => ({ queue, show: null, restart: false, displaced: null, dropped: [] })

function prune(recent: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, at] of Object.entries(recent)) if (now - at < DEDUPE_MS) out[k] = at
  return out
}

/** Put `e` into `list`, which is in showing order: higher priority first, and first come first served within a rank (`front`: ahead of its own rank). */
function insert(list: Entry[], e: Entry, front = false): Entry[] {
  const p = priority(e.tier, e.tone)
  const at = list.findIndex((x) => (front ? priority(x.tier, x.tone) <= p : priority(x.tier, x.tone) < p))
  return at < 0 ? [...list, e] : [...list.slice(0, at), e, ...list.slice(at)]
}

/** The entry that goes when the queue is over its limit: of the least urgent, the oldest. */
function weakest(list: Entry[]): Entry {
  const low = Math.min(...list.map((e) => priority(e.tier, e.tone)))
  return list.find((e) => priority(e.tier, e.tone) === low)!
}

/** Trim `list` to the waiting limit, saying which entries went. */
function trim(list: Entry[]): { waiting: Entry[]; dropped: Entry[] } {
  let waiting = list
  const dropped: Entry[] = []
  while (waiting.length > MAX_WAITING) { const w = weakest(waiting); dropped.push(w); waiting = waiting.filter((x) => x !== w) }
  return { waiting, dropped }
}

/** A notice arrives. */
export function offer(q: Queue, e: Entry, now: number): Step {
  const recent = prune(q.recent, now)
  const base: Queue = { ...q, recent }
  // The same notice again (by id: new words for it; by words: nothing new).
  if (q.shown?.id === e.id) return { ...none({ ...base, shown: e, shownAt: now }), show: e, restart: true }
  const at = q.waiting.findIndex((x) => x.id === e.id)
  if (at >= 0) return none({ ...base, waiting: q.waiting.map((x, i) => (i === at ? e : x)) })
  if (q.shown?.key === e.key) return { ...none({ ...base, shownAt: now }), restart: true }
  if (q.waiting.some((x) => x.key === e.key)) return none(base)
  if (recent[e.key] !== undefined) return none(base)
  // Nothing is showing.
  if (!q.shown) return { ...none({ ...base, shown: e, shownAt: now }), show: e }
  // A more urgent notice takes the place, and the one it displaces waits at the head of its own rank.
  if (priority(e.tier, e.tone) > priority(q.shown.tier, q.shown.tone)) {
    const { waiting, dropped } = trim(insert(q.waiting, q.shown, true))
    return { queue: { ...base, shown: e, shownAt: now, waiting }, show: e, restart: false, displaced: q.shown, dropped }
  }
  const { waiting, dropped } = trim(insert(q.waiting, e))
  return { ...none({ ...base, waiting }), dropped }
}

/** A notice is over (its time ran out, or it was dismissed): the next one goes up. */
export function finish(q: Queue, id: string, now: number): Step {
  const recent = prune(q.recent, now)
  if (q.shown?.id === id) {
    const next = q.waiting[0] ?? null
    const queue: Queue = { shown: next, shownAt: now, waiting: q.waiting.slice(1), recent: { ...recent, [q.shown.key]: now } }
    return { ...none(queue), show: next }
  }
  return none({ ...q, recent, waiting: q.waiting.filter((x) => x.id !== id) })
}

// ---- time that stops when the person is using the notice -------------------------------------------------------------

/** How much of a notice's time is left, and since when it has been running (null: held). */
export interface Countdown { left: number; since: number | null }

export const countdown = (ms: number, now: number): Countdown => ({ left: ms, since: now })
export const remaining = (c: Countdown, now: number): number => (c.since === null ? c.left : Math.max(0, c.left - (now - c.since)))
/** Hold the time where it is (a pointer is on the notice, focus is in it, the page is hidden). */
export const pause = (c: Countdown, now: number): Countdown => (c.since === null ? c : { left: remaining(c, now), since: null })
/** Let it run again from what is left. */
export const resume = (c: Countdown, now: number): Countdown => (c.since === null ? { left: c.left, since: now } : c)
