/**
 * The phone's own keyboard as typing on the host. The field's value is diffed against what was already sent, so
 * whatever the keyboard does (autocorrect, predictions, IME composition, swiping a word) arrives as "delete n
 * characters, then type s". A sentinel before the text keeps Backspace visible on an empty field: deleting it is
 * one Backspace on the host. Enter types '\n' and starts a fresh line. Characters are code points, as a Backspace
 * deletes them: an emoji is one, and a diff never splits one. Pure: unit-tested in node.
 */
import { MAX_TEXT, type DeviceMsg } from '@obpal/core'

/** Zero-width: invisible in the field, but a character a Backspace can delete. */
export const SENTINEL = '​'
/** Past this many characters the field keeps only its tail (the host already has the rest). */
const KEEP = 120
const TAIL = 24

export interface Typed {
  /** Characters to delete on the host before typing `s`. */
  del: number
  /** Text to type ('\n' is Enter). */
  s: string
  /** What the field should hold now (sentinel restored, a sent line cleared, a long line trimmed). */
  value: string
}

const chars = (s: string) => Array.from(s)

export class TypingDiff {
  private last = SENTINEL

  /** What the field holds after a reset. */
  get value() {
    return this.last
  }

  reset() {
    this.last = SENTINEL
  }

  /**
   * The field's value after an input event. `composing`: the keyboard is still composing a word, so a long line
   * is left as it is until the word settles (rewriting the field under the keyboard would upset it).
   */
  input(value: string, composing = false): Typed {
    const before = chars(this.last.slice(SENTINEL.length))
    const hasSentinel = value.startsWith(SENTINEL)
    const body = chars((hasSentinel ? value.slice(SENTINEL.length) : value).split(SENTINEL).join(''))
    let p = 0
    while (p < before.length && p < body.length && before[p] === body[p]) p++
    let del = before.length - p
    // The sentinel itself went, with nothing else in the field: a Backspace at its start, meant for the host's text.
    // (A selection deleted at once takes the sentinel with it, and means only what was selected.)
    if (!hasSentinel && !body.length && !before.length) del += 1
    const s = body.slice(p).join('').replace(/\r\n?/g, '\n')
    let keep = body.join('')
    const nl = s.lastIndexOf('\n')
    // Enter sends the line; the field starts over after it (anything typed after the newline stays).
    if (nl >= 0) keep = s.slice(nl + 1)
    else if (!composing && body.length > KEEP) keep = body.slice(-TAIL).join('')
    this.last = SENTINEL + keep
    return { del, s, value: this.last }
  }

  /** The host deleted `n` characters before its caret by itself (a Backspace key): the field drops as many from its end. */
  deleted(n = 1): string {
    const body = chars(this.last.slice(SENTINEL.length))
    this.last = SENTINEL + body.slice(0, Math.max(0, body.length - n)).join('')
    return this.last
  }
}

/**
 * The text messages for one diff: at most MAX_TEXT to delete and to type in each, so a long paste goes in pieces,
 * in order, the deleting first, and a piece never ends in half a character.
 */
export function textMessages(del: number, s: string): DeviceMsg[] {
  const out: DeviceMsg[] = []
  const msg = (piece: string, d: number): DeviceMsg => (d ? { t: 'text', s: piece, del: d } : { t: 'text', s: piece })
  for (; del > MAX_TEXT; del -= MAX_TEXT) out.push(msg('', MAX_TEXT))
  let piece = ''
  for (const c of s) {
    if (piece.length + c.length > MAX_TEXT) {
      out.push(msg(piece, del))
      del = 0
      piece = ''
    }
    piece += c
  }
  if (piece || del) out.push(msg(piece, del))
  return out
}
