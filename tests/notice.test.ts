import { describe, expect, it } from 'vitest'
import {
  ACTION_MIN_MS, DEDUPE_MS, ERROR_MIN_MS, MAX_WAITING, SWIPE_PX, TOAST_MAX_MS, TOAST_MIN_MS,
  countdown, emptyQueue, finish, isSwipe, noticeDuration, offer, pause, priority, remaining, resume,
  type Entry, type NoticeTier, type NoticeTone, type Queue,
} from '../src/ui/kit/notice-queue'

const entry = (id: string, text = id, tier: NoticeTier = 'toast', tone: NoticeTone = 'info', ms = 3000): Entry => ({ id, key: `${tone}:${text}`, tier, tone, ms })
const add = (q: Queue, e: Entry, now = 0) => offer(q, e, now)

describe('notice durations', () => {
  it('follow the words: 1.8 s plus 55 ms a character, between 3 s and 7 s', () => {
    expect(noticeDuration('Saved')).toBe(TOAST_MIN_MS)
    expect(noticeDuration('x'.repeat(40))).toBe(1800 + 55 * 40)
    expect(noticeDuration('x'.repeat(200))).toBe(TOAST_MAX_MS)
    const long = '3D tracking didn’t start: it needs Android with Google Play Services for AR'
    expect(noticeDuration(long)).toBeGreaterThanOrEqual(5000)
    expect(noticeDuration(long)).toBeLessThanOrEqual(TOAST_MAX_MS)
  })

  it('keep every duration within the bounds', () => {
    for (let n = 0; n <= 300; n += 7) {
      const ms = noticeDuration('a'.repeat(n))
      expect(ms).toBeGreaterThanOrEqual(TOAST_MIN_MS)
      expect(ms).toBeLessThanOrEqual(TOAST_MAX_MS)
    }
  })

  it('give an error at least six seconds, and never more than seven', () => {
    expect(noticeDuration('Nope', 'bad')).toBeGreaterThanOrEqual(ERROR_MIN_MS)
    expect(noticeDuration('x'.repeat(300), 'bad')).toBe(TOAST_MAX_MS)
    expect(noticeDuration('Nope', 'warn')).toBe(TOAST_MIN_MS)
  })

  it('count characters, not UTF-16 units', () => {
    expect(noticeDuration('😀'.repeat(10))).toBe(Math.max(TOAST_MIN_MS, 1800 + 55 * 10))
  })

  it('leave persistent tiers without a time', () => {
    expect(noticeDuration('Waiting for the screen', 'info', 'state')).toBe(0)
    expect(noticeDuration('Stopped', 'bad', 'alert')).toBe(0)
  })

  it('keep a button reachable longer than a plain toast', () => {
    expect(ACTION_MIN_MS).toBeGreaterThan(TOAST_MAX_MS)
  })
})

describe('notice priority', () => {
  it('puts an alert before a state before a toast, and an error before the rest of a tier', () => {
    expect(priority('alert')).toBeGreaterThan(priority('state', 'bad'))
    expect(priority('state')).toBeGreaterThan(priority('toast', 'bad'))
    expect(priority('toast', 'bad')).toBeGreaterThan(priority('toast', 'warn'))
    expect(priority('toast', 'warn')).toBeGreaterThan(priority('toast', 'info'))
  })
})

describe('the toast queue', () => {
  it('shows the first at once and keeps the next ones waiting in turn', () => {
    let q = emptyQueue()
    let s = add(q, entry('a')); q = s.queue
    expect(s.show?.id).toBe('a')
    s = add(q, entry('b')); q = s.queue
    expect(s.show).toBeNull()
    s = add(q, entry('c')); q = s.queue
    expect(q.shown?.id).toBe('a')
    expect(q.waiting.map((e) => e.id)).toEqual(['b', 'c'])
    s = finish(q, 'a', 100); q = s.queue
    expect(s.show?.id).toBe('b')
    s = finish(q, 'b', 200); q = s.queue
    expect(s.show?.id).toBe('c')
    s = finish(q, 'c', 300); q = s.queue
    expect(s.show).toBeNull()
    expect(q.shown).toBeNull()
  })

  it('shows two messages sent together, one after the other, not only the second', () => {
    let q = add(emptyQueue(), entry('first', 'First message')).queue
    q = add(q, entry('second', 'Second message')).queue
    expect(q.shown?.key).toContain('First message')
    expect(finish(q, 'first', 3000).show?.key).toContain('Second message')
  })

  it('holds one showing and three waiting, and drops the oldest of the least urgent beyond that', () => {
    let q = emptyQueue()
    for (const id of ['a', 'b', 'c', 'd']) q = add(q, entry(id)).queue
    expect(q.waiting).toHaveLength(MAX_WAITING)
    const s = add(q, entry('e'))
    expect(s.dropped.map((e) => e.id)).toEqual(['b'])
    expect(s.queue.waiting.map((e) => e.id)).toEqual(['c', 'd', 'e'])
    expect(s.queue.shown?.id).toBe('a')
  })

  it('treats the same words as one notice and starts its time again', () => {
    let q = add(emptyQueue(), entry('a', 'Position set'), 0).queue
    const s = add(q, entry('b', 'Position set'), 1500)
    expect(s.show).toBeNull()
    expect(s.restart).toBe(true)
    expect(s.queue.shownAt).toBe(1500)
    expect(s.queue.waiting).toHaveLength(0)
  })

  it('does not queue the same words twice while one waits', () => {
    let q = add(emptyQueue(), entry('a')).queue
    q = add(q, entry('b', 'Same')).queue
    const s = add(q, entry('c', 'Same'))
    expect(s.queue.waiting).toHaveLength(1)
    expect(s.show).toBeNull()
  })

  it('refuses a repeat of words that finished less than four seconds ago, and allows it after', () => {
    let q = add(emptyQueue(), entry('a', 'Saved'), 0).queue
    q = finish(q, 'a', 3000).queue
    expect(add(q, entry('b', 'Saved'), 3000 + DEDUPE_MS - 1).show).toBeNull()
    const later = add(q, entry('c', 'Saved'), 3000 + DEDUPE_MS)
    expect(later.show?.id).toBe('c')
  })

  it('does not take different tones of the same words for each other', () => {
    const q = add(emptyQueue(), entry('a', 'Hold', 'toast', 'info')).queue
    const s = add(q, entry('b', 'Hold', 'toast', 'bad'))
    // Not the same notice: the error takes over, and the plain one waits.
    expect(s.show?.id).toBe('b')
    expect(s.queue.waiting.map((e) => e.id)).toEqual(['a'])
  })

  it('replaces a notice that has the same id, shown or waiting', () => {
    let q = add(emptyQueue(), entry('x', 'one')).queue
    q = add(q, entry('y', 'two')).queue
    let s = add(q, entry('x', 'new words'))
    expect(s.show?.key).toContain('new words')
    expect(s.restart).toBe(true)
    s = add(s.queue, entry('y', 'changed'))
    expect(s.queue.waiting[0].key).toContain('changed')
    expect(s.queue.waiting).toHaveLength(1)
  })

  it('lets a more urgent notice take over and puts the one it displaced back at the head of its rank', () => {
    let q = add(emptyQueue(), entry('a')).queue
    q = add(q, entry('b')).queue
    const s = add(q, entry('err', 'Failed', 'toast', 'bad'))
    expect(s.show?.id).toBe('err')
    expect(s.displaced?.id).toBe('a')
    expect(s.queue.waiting.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('lets a notice that answers what the person just did take the place of a toast, which waits at the head', () => {
    let q = add(emptyQueue(), entry('a')).queue
    q = add(q, entry('b')).queue
    const s = add(q, entry('found', 'Clicker found', 'state'))
    expect(s.show?.id).toBe('found')
    expect(s.displaced?.id).toBe('a')
    expect(s.queue.waiting.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('orders waiting notices by urgency, then arrival', () => {
    let q = add(emptyQueue(), entry('first', 'Failed', 'toast', 'bad')).queue
    q = add(q, entry('b')).queue
    q = add(q, entry('w', 'Careful', 'toast', 'warn')).queue
    q = add(q, entry('c')).queue
    expect(q.shown?.id).toBe('first')
    expect(q.waiting.map((e) => e.id)).toEqual(['w', 'b', 'c'])
  })

  it('never throws away a more urgent notice to keep a less urgent one', () => {
    let q = add(emptyQueue(), entry('a')).queue
    for (const id of ['b', 'c', 'd']) q = add(q, entry(id)).queue
    const s = add(q, entry('err', 'Failed', 'toast', 'bad'))
    expect(s.show?.id).toBe('err')
    expect(s.queue.waiting.map((e) => e.id)).not.toContain('a')
    expect(s.dropped.map((e) => e.id)).toEqual(['a'])
  })

  it('removes a waiting notice that is dismissed before its turn', () => {
    let q = add(emptyQueue(), entry('a')).queue
    q = add(q, entry('b')).queue
    q = add(q, entry('c')).queue
    const s = finish(q, 'b', 10)
    expect(s.queue.waiting.map((e) => e.id)).toEqual(['c'])
    expect(s.queue.shown?.id).toBe('a')
  })
})

describe('notice countdowns', () => {
  it('count down while running', () => {
    const c = countdown(5000, 1000)
    expect(remaining(c, 1000)).toBe(5000)
    expect(remaining(c, 3500)).toBe(2500)
    expect(remaining(c, 9000)).toBe(0)
  })

  it('hold what is left while paused, and run from there on resume', () => {
    let c = countdown(5000, 0)
    c = pause(c, 2000)
    expect(remaining(c, 2000)).toBe(3000)
    expect(remaining(c, 60000)).toBe(3000)
    c = resume(c, 60000)
    expect(remaining(c, 61000)).toBe(2000)
    expect(remaining(c, 70000)).toBe(0)
  })

  it('treat a second pause or resume as the first', () => {
    const c = countdown(4000, 0)
    expect(pause(pause(c, 1000), 3000)).toEqual({ left: 3000, since: null })
    expect(resume(c, 500)).toBe(c)
  })
})

describe('notice swipes', () => {
  it('dismiss on a drag of 50 px in any direction, and not on a shorter one', () => {
    expect(isSwipe(SWIPE_PX, 0)).toBe(true)
    expect(isSwipe(-SWIPE_PX, 3)).toBe(true)
    expect(isSwipe(0, -SWIPE_PX)).toBe(true)
    expect(isSwipe(0, SWIPE_PX)).toBe(true)
    expect(isSwipe(SWIPE_PX - 1, 0)).toBe(false)
    expect(isSwipe(30, 30)).toBe(false)
    expect(isSwipe(36, 36)).toBe(true)
  })
})
