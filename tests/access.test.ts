/**
 * Which phones may control the PC (extension/src/shared/access.ts, spec/SECURITY.md §8 L1): answers kept per phone,
 * asked about only when it matters, and the messages that carry them, from the senders allowed to send them.
 */
import { describe, expect, it } from 'vitest'
import {
  accessOf, askFor, MAX_ANSWERS, noticeFor, parseAnswers, parsePhone, phoneKeyOf, REFUSED, WAITING, withAnswer, withoutAnswer, type Answers,
} from '../extension/src/shared/access'
import { allowedFrom, parseBgRequest, parseOffscreenRequest } from '../extension/src/shared/messages'

const PAIR = 'Pp'.repeat(11) // a pairing id: 22 base64url characters
const FP = 'F'.repeat(43) // a DTLS fingerprint, base64url
const pixel = { key: PAIR, name: 'Pixel 7' }

describe('a phone, as Link knows it', () => {
  it('goes by its pairing id, or by its fingerprint without one', () => {
    expect(phoneKeyOf({ pair: PAIR, fp: FP })).toBe(PAIR)
    expect(phoneKeyOf({ fp: FP })).toBe(`fp:${FP}`)
    expect(phoneKeyOf({})).toBeNull()
    expect(phoneKeyOf({ pair: 'short' })).toBeNull()
  })

  it('is read strictly', () => {
    expect(parsePhone(pixel)).toEqual(pixel)
    expect(parsePhone({ key: `fp:${FP}`, name: 'Browser', extra: 1 })).toEqual({ key: `fp:${FP}`, name: 'Browser' })
    expect(parsePhone({ key: PAIR, name: '' })).toBeNull()
    expect(parsePhone({ key: PAIR, name: 'x'.repeat(61) })).toBeNull()
    expect(parsePhone({ key: '__proto__', name: 'x' })).toBeNull()
    expect(parsePhone(null)).toBeNull()
  })
})

describe('the answers', () => {
  it('a phone nobody answered for is asked about, once the PC is the target and PC control is on', () => {
    expect(accessOf({}, PAIR)).toBe('ask')
    expect(askFor('pc', pixel, {}, true)).toEqual(pixel)
    expect(askFor('keys', pixel, {}, true)).toBeNull()
    expect(askFor('pc', null, {}, true)).toBeNull()
    expect(askFor('pc', pixel, {}, false)).toBeNull()
  })

  it('an answer is kept for that phone: allowed, or refused, and asked about no more', () => {
    const allowed = withAnswer({}, pixel, true, 10)
    expect(accessOf(allowed, PAIR)).toBe('allow')
    expect(askFor('pc', pixel, allowed, true)).toBeNull()
    const refused = withAnswer(allowed, pixel, false, 20)
    expect(accessOf(refused, PAIR)).toBe('deny')
    expect(askFor('pc', pixel, refused, true)).toBeNull()
    // Another phone is its own question.
    expect(accessOf(refused, `fp:${FP}`)).toBe('ask')
  })

  it('forgetting a phone takes its answer away: it is a new phone again', () => {
    const a = withAnswer(withAnswer({}, pixel, true, 10), { key: `fp:${FP}`, name: 'Browser' }, false, 11)
    const b = withoutAnswer(a, PAIR)
    expect(accessOf(b, PAIR)).toBe('ask')
    expect(accessOf(b, `fp:${FP}`)).toBe('deny')
  })

  it('reads kept answers strictly, and keeps the newest MAX_ANSWERS', () => {
    const junk = { [PAIR]: { name: 'Pixel 7', allow: 'yes', at: 1 }, bad: { name: 'x', allow: true, at: 1 }, [`fp:${FP}`]: { name: 'Browser', allow: true, at: 2 } }
    expect(parseAnswers(junk)).toEqual({ [`fp:${FP}`]: { name: 'Browser', allow: true, at: 2 } })
    expect(parseAnswers('nope')).toEqual({})
    const many: Answers = {}
    for (let i = 0; i < MAX_ANSWERS + 5; i++) many[`${String(i).padStart(2, '0')}${'a'.repeat(20)}`] = { name: `P${i}`, allow: true, at: i }
    const kept = parseAnswers(many)
    expect(Object.keys(kept)).toHaveLength(MAX_ANSWERS)
    expect(kept[`00${'a'.repeat(20)}`]).toBeUndefined()
  })

  it('tells the phone what holds it up, only while the PC is the target', () => {
    expect(noticeFor('pc', 'ask')).toBe(WAITING)
    expect(noticeFor('pc', 'deny')).toBe(REFUSED)
    expect(noticeFor('pc', 'allow')).toBe(false)
    expect(noticeFor('pc', null)).toBe(false)
    expect(noticeFor('gamepad', 'ask')).toBe(false)
  })
})

describe('the messages that carry them', () => {
  it('who is connected comes from the link only; the answer, from Link’s own pages only', () => {
    expect(parseBgRequest({ to: 'bg', type: 'phone', phone: pixel })).toEqual({ to: 'bg', type: 'phone', phone: pixel })
    expect(parseBgRequest({ to: 'bg', type: 'phone', phone: null })).toEqual({ to: 'bg', type: 'phone', phone: null })
    expect(parseBgRequest({ to: 'bg', type: 'phone', phone: { key: 'x', name: 'y' } })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'answer', key: PAIR, allow: true })).toEqual({ to: 'bg', type: 'answer', key: PAIR, allow: true })
    expect(parseBgRequest({ to: 'bg', type: 'answer', key: PAIR, allow: 'yes' })).toBeNull()
    expect(parseBgRequest({ to: 'bg', type: 'answer', key: 'constructor', allow: true })).toBeNull()
    expect(allowedFrom('phone', 'offscreen')).toBe(true)
    expect(allowedFrom('phone', 'extension')).toBe(false)
    expect(allowedFrom('phone', 'page')).toBe(false)
    expect(allowedFrom('answer', 'extension')).toBe(true)
    expect(allowedFrom('answer', 'offscreen')).toBe(false)
    expect(allowedFrom('answer', 'page')).toBe(false)
  })

  it('the link hears where its phone stands', () => {
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'access', key: PAIR, access: 'deny' })).toEqual({ to: 'offscreen', type: 'access', key: PAIR, access: 'deny' })
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'access', key: PAIR, access: 'maybe' })).toBeNull()
    expect(parseOffscreenRequest({ to: 'offscreen', type: 'access', key: 'x', access: 'allow' })).toBeNull()
  })
})
