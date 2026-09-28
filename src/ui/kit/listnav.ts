/**
 * Moving through a list whose items may be disabled, and finding an item by typing its name: what the glass select,
 * the segmented control and the tiles share. Pure, so the rules are tested without a page.
 */

export interface Navigable { disabled?: boolean }

/** The first (or last) enabled index; -1 when none is. */
export function edge(items: readonly Navigable[], which: 'first' | 'last'): number {
  if (which === 'first') { for (let i = 0; i < items.length; i++) if (!items[i].disabled) return i }
  else for (let i = items.length - 1; i >= 0; i--) if (!items[i].disabled) return i
  return -1
}

/**
 * The enabled index `count` steps from `from` toward `dir`. It stops at the ends, or goes round with `wrap` (one step
 * at a time); a disabled item where it lands gives way to the next enabled one on, or failing that the nearest one
 * back. From nowhere (-1) it starts at the end it moves away from. `from` itself when no other item is enabled.
 */
export function step(items: readonly Navigable[], from: number, dir: 1 | -1, { count = 1, wrap = false } = {}): number {
  const n = items.length
  if (!n) return -1
  if (from < 0 || from >= n) return edge(items, dir > 0 ? 'first' : 'last')
  const enabled = (i: number) => !items[i].disabled
  if (wrap) {
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n
      if (enabled(i)) return i
    }
    return from
  }
  const target = Math.max(0, Math.min(n - 1, from + dir * Math.max(1, count)))
  if (target === from) return from
  for (let i = target; i >= 0 && i < n; i += dir) if (enabled(i)) return i
  for (let i = target - dir; i !== from; i -= dir) if (enabled(i)) return i
  return from
}

/** A label folded for matching: accents dropped, case ignored, spaces collapsed. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The index whose label starts with `query` (accents and case ignored), or -1. One letter, or the same letter typed
 * again and again, steps through the labels that start with it after `from`, going round; a longer query keeps the
 * current item while it still matches, so typing "gam" stays on Gamepad. Disabled items are passed over.
 */
export function typeahead(labels: readonly string[], query: string, from: number, disabled: readonly boolean[] = []): number {
  const q = fold(query)
  if (!q || !labels.length) return -1
  const repeated = [...q].every((c) => c === q[0])
  const needle = repeated ? q[0] : q
  const n = labels.length
  const start = repeated ? from + 1 : Math.max(0, from)
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    if (!disabled[i] && fold(labels[i]).startsWith(needle)) return i
  }
  return -1
}

/** The letters typed within `wait` ms of each other, as one query. */
export class Typeahead {
  private query = ''
  private at = -Infinity
  constructor(private wait = 500) {}
  /** Add a key typed at `now` (ms); returns the query so far. */
  push(key: string, now: number): string {
    if (now - this.at > this.wait) this.query = ''
    this.at = now
    this.query += key
    return this.query
  }
  /** Whether a query is being typed, so Space adds to it rather than choosing. */
  typing(now: number): boolean { return !!this.query && now - this.at <= this.wait }
  reset() { this.query = ''; this.at = -Infinity }
}

/** A key that types a character (no Ctrl, Alt or Meta held). */
export const printable = (e: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }) =>
  e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
