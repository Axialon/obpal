import { describe, expect, it } from 'vitest'
import { MAX_TEXT } from '@obpal/core'
import { SENTINEL, textMessages, TypingDiff } from '../src/controller/typing'

/** The field's whole value after an input event: the sentinel, then what the keyboard left there. */
const field = (s: string) => SENTINEL + s

describe('Typing: the phone keyboard as delete n, then type s', () => {
  it('sends plain typing as it comes, and Backspace as deleting', () => {
    const d = new TypingDiff()
    expect(d.input(field('h'))).toEqual({ del: 0, s: 'h', value: field('h') })
    expect(d.input(field('hi'))).toEqual({ del: 0, s: 'i', value: field('hi') })
    expect(d.input(field('hi!'))).toEqual({ del: 0, s: '!', value: field('hi!') })
    expect(d.input(field('hi'))).toEqual({ del: 1, s: '', value: field('hi') })
  })

  it('turns Backspace on an empty field into Backspace on the host, through the sentinel, and gets ready for the next', () => {
    const d = new TypingDiff()
    // the field held only the sentinel; Backspace took it
    expect(d.input('')).toEqual({ del: 1, s: '', value: SENTINEL })
    expect(d.input('')).toEqual({ del: 1, s: '', value: SENTINEL })
    // held down past what was typed here: the text first, then the host's own
    d.input(field('ab'))
    expect(d.input(field('a')).del).toBe(1)
    expect(d.input(field('')).del).toBe(1)
    expect(d.input('')).toEqual({ del: 1, s: '', value: SENTINEL })
    // a selection deleted at once takes the sentinel with it, and means only what was selected
    d.input(field('abc'))
    expect(d.input('')).toEqual({ del: 3, s: '', value: SENTINEL })
    // the sentinel alone taken from before the text: nothing to do, and it is put back
    d.input(field('ok'))
    expect(d.input('ok')).toEqual({ del: 0, s: '', value: field('ok') })
  })

  it('replaces a word the keyboard autocorrected, and takes a swiped word whole', () => {
    const d = new TypingDiff()
    d.input(field('I saw teh'))
    // "teh" became "the " as the space went in: back to the first difference, then the rest
    expect(d.input(field('I saw the '))).toEqual({ del: 2, s: 'he ', value: field('I saw the ') })
    // a swiped word arrives at once, with the space the keyboard adds
    expect(d.input(field('I saw the quick '))).toEqual({ del: 0, s: 'quick ', value: field('I saw the quick ') })
    // a word picked from the suggestions replaces the one being typed
    d.input(field('I saw the quick bro'))
    expect(d.input(field('I saw the quick brown '))).toEqual({ del: 0, s: 'wn ', value: field('I saw the quick brown ') })
    expect(d.input(field('I saw the quick brawn'))).toEqual({ del: 4, s: 'awn', value: field('I saw the quick brawn') })
  })

  it('sends Enter as a newline and starts a fresh line, keeping what came after it', () => {
    const d = new TypingDiff()
    d.input(field('ls'))
    expect(d.input(field('ls\n'))).toEqual({ del: 0, s: '\n', value: SENTINEL })
    expect(d.input(field('c'))).toEqual({ del: 0, s: 'c', value: field('c') })
    // a newline and more in one event (a paste): the line goes, the rest stays in the field
    expect(d.input(field('cd ..\r\npwd'))).toEqual({ del: 0, s: 'd ..\npwd', value: field('pwd') })
  })

  it('trims a long line to its tail, but not while a word is still being composed', () => {
    const d = new TypingDiff()
    const long = 'x'.repeat(120)
    expect(d.input(field(long)).value).toBe(field(long))
    // one more: the field keeps its last 24 characters (the host has them all)
    const t = d.input(field(`${long}y`), true)
    expect(t).toEqual({ del: 0, s: 'y', value: field(`${long}y`) })
    const settled = d.input(field(`${long}y`))
    expect(settled).toEqual({ del: 0, s: '', value: field(`${'x'.repeat(23)}y`) })
    // typing on from the trimmed field
    expect(d.input(field(`${'x'.repeat(23)}yz`))).toEqual({ del: 0, s: 'z', value: field(`${'x'.repeat(23)}yz`) })
  })

  it('counts characters as code points: an emoji is one Backspace, and a diff never splits one', () => {
    const d = new TypingDiff()
    d.input(field('ok 😀'))
    expect(d.input(field('ok ')).del).toBe(1)
    // 😀 (U+1F600) and 😁 (U+1F601) share their first UTF-16 unit: still a whole character out and a whole one in
    d.input(field('ok 😀'))
    expect(d.input(field('ok 😁'))).toEqual({ del: 1, s: '😁', value: field('ok 😁') })
    // a long line trimmed through emoji keeps whole characters
    const t = d.input(field('😀'.repeat(130)))
    expect(Array.from(t.value.slice(1))).toEqual(Array(24).fill('😀'))
  })

  it('drops the field’s last character when the host deleted one by itself (the key row’s Backspace)', () => {
    const d = new TypingDiff()
    d.input(field('abc'))
    expect(d.deleted()).toBe(field('ab'))
    expect(d.input(field('abd'))).toEqual({ del: 0, s: 'd', value: field('abd') })
    d.reset()
    expect(d.deleted()).toBe(SENTINEL)
    expect(d.value).toBe(SENTINEL)
  })
})

describe('Typing: the text messages', () => {
  it('sends one message for a keystroke, leaving out a zero delete', () => {
    expect(textMessages(0, 'a')).toEqual([{ t: 'text', s: 'a' }])
    expect(textMessages(2, 'he ')).toEqual([{ t: 'text', s: 'he ', del: 2 }])
    expect(textMessages(1, '')).toEqual([{ t: 'text', s: '', del: 1 }])
    expect(textMessages(0, '')).toEqual([])
  })

  it('sends a long paste in pieces of at most MAX_TEXT, deleting first and never splitting a character', () => {
    const s = `${'a'.repeat(MAX_TEXT - 1)}😀${'b'.repeat(10)}`
    const out = textMessages(3, s) as { t: 'text'; s: string; del?: number }[]
    expect(out.map((m) => m.del ?? 0)).toEqual([3, 0])
    expect(out.every((m) => m.s.length <= MAX_TEXT)).toBe(true)
    expect(out[0].s).toBe('a'.repeat(MAX_TEXT - 1))
    expect(out.map((m) => m.s).join('')).toBe(s)
    const many = textMessages(MAX_TEXT * 2 + 5, 'x') as { s: string; del?: number }[]
    expect(many).toEqual([{ t: 'text', s: '', del: MAX_TEXT }, { t: 'text', s: '', del: MAX_TEXT }, { t: 'text', s: 'x', del: 5 }])
  })
})
